import { ToolError, BrowserInterruptionError, browserPageInterruption, createLogger, getErrorMessage } from '@lobu/core';
import {
  canRetainSourceBrowser,
  claimSourceBrowser,
  finishSourceBrowser,
  sourceBrowserLease,
  SOURCE_BROWSER_RETENTION_MS,
  type SourceBrowserCleanup,
} from './browser-recovery';
import { resolveActingPrincipal } from '../authz/entity-policy';
import type { AuthzScope } from '../authz/scope';
import { getDb } from '../db/client';
import { createConnectorOperationRun } from '../runs/queue-service';
import { dispatchChromeActionToExtension } from '../worker-api/dispatch-chrome-action';
import { DEVICE_FEED_READ_ACTION_KEY, SOURCE_FEED_READ_METADATA_KEY, SOURCE_FEED_SUBSCRIPTION_METADATA_KEY, SOURCE_FEED_SCOPE_METADATA_KEY } from './device-feed-read-protocol';
import { scrubSourceReadRun } from './source-read-run';

const logger = createLogger('source-read-bridge');

export function sourceReadDeadlineError(feedId: number): Error & { exitReason: 'timeout' } {
  return Object.assign(new Error(`source read for feed '${feedId}' timed out`), {
    exitReason: 'timeout' as const,
  });
}

interface SourceBrowserFeed {
  id: number;
  connection_id: number;
  connector_key: string;
  feed_key: string;
  pinned_version: string | null;
  definition_version: string | null;
  selected_artifact_hash: string | null;
}

interface SourceReadBridgeOptions {
  scope: AuthzScope;
  automationId?: number | null;
  feedId: number;
  deadlineAt: number;
  flowId?: string;
  onBrowserLease?: () => void;
  recoveryId?: string;
  requestHash: string;
  sourceSubscriptionScopeKey?: string;
}

export function createSourceReadBridge(
  feed: SourceBrowserFeed,
  params: SourceReadBridgeOptions,
  signal: AbortSignal,
) {
  const sql = getDb();
  let parent: Promise<number> | undefined;
  let interruption: BrowserInterruptionError | undefined;
  let leased = false;
  const workController = new AbortController();
  const workSignal = AbortSignal.any([signal, workController.signal]);
  const dispatches = new Set<Promise<unknown>>();
  const createParent = async (retainOnInterruption = false): Promise<number> => {
    const actor = await resolveActingPrincipal(sql, {
      organizationId: params.scope.organizationId, userId: params.scope.principal,
      agentId: params.scope.agentId, sessionAutomationId: params.automationId,
    });
    if (!actor.ownerResolved) throw new ToolError('PERMISSION', 'Source reader has no valid requesting principal.');
    return sql.begin(async (tx) => {
      const run = await createConnectorOperationRun({
        organizationId: params.scope.organizationId, connectionId: Number(feed.connection_id),
        connectorKey: feed.connector_key, operationKey: DEVICE_FEED_READ_ACTION_KEY,
        operationInput: { feed_key: feed.feed_key }, approvalMode: 'inline',
        policyPrincipalKind: actor.kind, policyPrincipalId: actor.id,
        createdByUserId: params.scope.principal, automationId: params.automationId,
        runMetadata: { [SOURCE_FEED_READ_METADATA_KEY]: true,
          ...(params.sourceSubscriptionScopeKey ? { [SOURCE_FEED_SUBSCRIPTION_METADATA_KEY]: true,
            [SOURCE_FEED_SCOPE_METADATA_KEY]: params.sourceSubscriptionScopeKey } : {}) }, db: tx,
      });
      await tx`UPDATE runs SET feed_id = ${feed.id},
        expires_at = clock_timestamp() + ${Math.max(0, params.deadlineAt - Date.now())}::double precision * interval '1 millisecond',
        connector_version = ${feed.pinned_version ?? feed.definition_version},
        connector_artifact_hash = ${feed.selected_artifact_hash}
        WHERE id = ${run.runId} AND organization_id = ${params.scope.organizationId}`;
      if (retainOnInterruption || params.recoveryId)
        leased = await claimSourceBrowser(
          {
            runId: run.runId,
            scope: params.scope,
            automationId: params.automationId,
            deadlineAt: params.deadlineAt,
            flowId: params.flowId,
            recoveryId: params.recoveryId,
            requestHash: params.requestHash,
          },
          tx,
        );
      if (leased) params.onBrowserLease?.();
      return run.runId;
    });
  };
  // Close (or retain for recovery) the exact source tab, then release or hand
  // off its profile ownership. Folds any cleanup interruption into `interruption`.
  const finalizeBrowser = async (runId: number, workOk: boolean): Promise<void> => {
    const lease = await sourceBrowserLease(params.scope.organizationId, runId);
    if (leased && workOk && !interruption && !lease?.tab) {
      interruption = new BrowserInterruptionError('recovery_unavailable', 'The source read did not confirm an exact owned browser tab.');
    }
    let outcome: SourceBrowserCleanup = { kind: 'unacknowledged' };
    if (lease?.tab && !signal.aborted) {
      const retainUntil = interruption?.reason === 'challenge_required' && canRetainSourceBrowser(lease)
        ? new Date(lease.run.observed_at.getTime() + SOURCE_BROWSER_RETENTION_MS).toISOString() : undefined;
      const cleanup = await dispatchChromeActionToExtension({
        organizationId: params.scope.organizationId,
        actionKey: 'close_tab',
        actionInput: { tab_id: lease.tab.tab_id },
        parentRunId: runId,
        visibilityUserId: params.scope.principal,
        skipAccountProbe: !workOk || !!interruption,
        retainUntil,
        abortSignal: signal,
      });
      if (cleanup.interruption) {
        // Never bypass a failed final verification with another close.
        // Exact-target expiry handles cleanup with uncertain authority.
        interruption = new BrowserInterruptionError(cleanup.interruption.reason, cleanup.interruption.message);
      } else if (cleanup.status !== 'completed') {
        if (workOk) interruption = new BrowserInterruptionError('recovery_unavailable',
          cleanup.error_message ?? 'Final browser account verification or cleanup was not acknowledged.');
      } else if (!retainUntil) {
        outcome = { kind: 'closed' };
      } else if (cleanup.output?.cleanup_ack === true) {
        outcome = { kind: 'retained', expiresAt: retainUntil };
      }
    }
    const recovery = await finishSourceBrowser(params.scope.organizationId, runId, outcome, signal);
    if (interruption && recovery) {
      interruption = new BrowserInterruptionError(interruption.reason, interruption.message, recovery);
    }
  };
  return {
    onChromeDispatch(actionKey: string, actionInput: Record<string, unknown>) {
      const cleanup = actionKey === 'network_intercept_stop' || actionKey === 'close_tab';
      const dispatchSignal = cleanup ? signal : workSignal;
      const pending = (async () => {
        if (dispatchSignal.aborted) throw sourceReadDeadlineError(params.feedId);
        const parentRunId = await (parent ??= createParent(
          actionKey === 'navigate' &&
            actionInput.new_tab === true &&
            actionInput.retain_on_interruption === true,
        ));
        if (dispatchSignal.aborted) throw sourceReadDeadlineError(params.feedId);
        // The host is the sole finalizer of leased tabs. Unleased adapters keep
        // their own cleanup, including on older extensions.
        if (actionKey === 'close_tab' && leased)
          return { closed: false, cleanup_pending: true };
        if (interruption && !cleanup) throw interruption;
        const result = await dispatchChromeActionToExtension({
          organizationId: params.scope.organizationId,
          actionKey,
          actionInput,
          parentRunId,
          visibilityUserId: params.scope.principal,
          abortSignal: dispatchSignal,
          skipAccountProbe: !!interruption && cleanup,
        });
        const marker = result.interruption ?? browserPageInterruption(result.output?.value);
        if (marker) throw new BrowserInterruptionError(marker.reason, marker.message);
        if (result.status !== 'completed')
          throw new Error(result.error_message ?? `Browser source step ${result.status}`);
        return result.output ?? {};
      })().catch((error) => {
        if (error instanceof BrowserInterruptionError) interruption = error;
        throw error;
      });
      dispatches.add(pending);
      pending.finally(() => dispatches.delete(pending)).catch(() => {});
      return pending;
    },
    async run<T>(work: () => Promise<T>): Promise<T> {
      let result: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        if (params.recoveryId) await (parent ??= createParent());
        result = { ok: true, value: await work() };
      } catch (error) {
        result = { ok: false, error };
      }
      // A crashed isolate can leave an unawaited dispatch. Cancel ordinary work
      // before joining it, while keeping capture/tab cleanup within its budget.
      workController.abort();
      await Promise.allSettled(dispatches);
      const runId = await parent?.catch(() => undefined);
      let cleanupError: { error: unknown } | undefined;
      try {
        if (runId !== undefined) await finalizeBrowser(runId, result.ok);
      } catch (error) {
        cleanupError = { error };
        if (!result.ok) logger.warn({ feedId: params.feedId, error: getErrorMessage(error) }, 'Browser cleanup failed after source work failed');
      }
      let status: 'completed' | 'failed' | 'timeout' = signal.aborted ? 'timeout' : 'failed';
      try {
        // Decide the result once. Cancellation never carries recovery authority,
        // and cleanup failure rejects successful work without hiding a read error.
        if (signal.aborted && leased) throw new BrowserInterruptionError('timeout', 'Browser source read timed out or was cancelled; no recovery handoff was issued.');
        if (interruption) throw interruption;
        if (cleanupError && result.ok) throw cleanupError.error;
        if (signal.aborted) throw sourceReadDeadlineError(params.feedId);
        if (!result.ok) throw result.error;
        status = 'completed';
        return result.value;
      } finally {
        if (runId !== undefined) await scrubSourceReadRun(runId, params.scope.organizationId, feed.feed_key, status);
      }
    },
  };
}
