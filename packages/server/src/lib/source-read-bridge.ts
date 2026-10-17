import { ToolError, BrowserInterruptionError, browserPageInterruption } from '@lobu/core';
import {
  claimSourceBrowser,
  finishSourceBrowser,
  sourceBrowserLease,
  sourceRecoveryHash,
  type SourceBrowserCleanup,
} from './browser-recovery';
import { resolveActingPrincipal } from '../authz/entity-policy';
import type { AuthzScope } from '../authz/scope';
import { getDb } from '../db/client';
import { createConnectorOperationRun } from '../runs/queue-service';
import { dispatchChromeActionToExtension } from '../worker-api/dispatch-chrome-action';
import { DEVICE_FEED_READ_ACTION_KEY, SOURCE_FEED_READ_METADATA_KEY, SOURCE_FEED_SUBSCRIPTION_METADATA_KEY, SOURCE_FEED_SCOPE_METADATA_KEY } from './device-feed-read-protocol';
import { scrubSourceReadRun } from './source-read-run';

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
  sourceRevision?: string;
  query?: string;
  cursor?: string;
  limit?: number;
  offset?: number;
  sort?: unknown;
  window?: unknown;
  match?: unknown;
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
  let settled = false;
  let tabClosed = false;
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
      await tx`UPDATE runs SET feed_id = ${feed.id}, expires_at = ${new Date(params.deadlineAt)},
        connector_version = ${feed.pinned_version ?? feed.definition_version},
        connector_artifact_hash = ${feed.selected_artifact_hash}
        WHERE id = ${run.runId} AND organization_id = ${params.scope.organizationId}`;
      if (retainOnInterruption || params.recoveryId)
        leased = await claimSourceBrowser(
          {
            runId: run.runId,
            connectionId: Number(feed.connection_id),
            version: feed.pinned_version ?? feed.definition_version,
            scope: params.scope,
            automationId: params.automationId,
            deadlineAt: params.deadlineAt,
            flowId: params.flowId,
            recoveryId: params.recoveryId,
            requestHash: sourceRecoveryHash({
              feedId: feed.id,
              revision: params.sourceRevision,
              query: params.query,
              cursor: params.cursor,
              limit: params.limit,
              offset: params.offset,
              sort: params.sort,
              window: params.window,
              match: params.match,
            }),
          },
          tx,
        );
      if (leased) params.onBrowserLease?.();
      return run.runId;
    });
  };
  return {
    async prepare() {
      if (params.recoveryId) await (parent ??= createParent());
    },
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
        // A leased tab is closed or retained by settle(); an unleased scratch tab
        // still closes through the connector's own cleanup.
        if (interruption && actionKey === 'close_tab' && leased)
          return { closed: false, cleanup_pending: true };
        if (interruption && !cleanup) throw interruption;
        const result = await dispatchChromeActionToExtension({
          organizationId: params.scope.organizationId,
          actionKey,
          actionInput: Object.fromEntries(
            Object.entries(actionInput).filter(([key]) => key !== 'retain_on_interruption'),
          ),
          parentRunId,
          visibilityUserId: params.scope.principal,
          abortSignal: dispatchSignal,
          skipAccountProbe: !!interruption && cleanup,
          verifySourceAccount: actionKey === 'close_tab',
        });
        const marker = result.interruption ?? browserPageInterruption(result.output?.value);
        if (marker) {
          interruption = new BrowserInterruptionError(marker.reason, marker.message);
          throw interruption;
        }
        if (result.status !== 'completed')
          throw new Error(result.error_message ?? `Browser source step ${result.status}`);
        if (actionKey === 'close_tab') tabClosed = true;
        return result.output ?? {};
      })().catch((error) => {
        if (error instanceof BrowserInterruptionError) interruption = error;
        throw error;
      });
      dispatches.add(pending);
      pending.finally(() => dispatches.delete(pending)).catch(() => {});
      return pending;
    },
    get leased() {
      return leased;
    },
    get interruption() {
      return interruption;
    },
    async settle(status: 'completed' | 'failed' | 'timeout'): Promise<void> {
      if (settled) return;
      settled = true;
      // A crashed isolate can leave an unawaited dispatch. Cancel ordinary work
      // before joining it, while keeping capture/tab cleanup within its budget.
      workController.abort();
      await Promise.allSettled(dispatches);
      if (!parent) return;
      const runId = await parent.catch(() => undefined);
      if (runId === undefined) return;
      let cleanupFailed = false;
      try {
        const lease = await sourceBrowserLease(params.scope.organizationId, runId);
        let outcome: SourceBrowserCleanup = tabClosed ? 'closed' : 'unacknowledged';
        if (lease?.tab && !tabClosed && !signal.aborted) {
          const eligible =
            interruption?.reason === 'challenge_required' &&
            !!lease.owner.flow_id &&
            !lease.resumed;
          const cleanup = await dispatchChromeActionToExtension({
            organizationId: params.scope.organizationId,
            actionKey: 'close_tab',
            actionInput: { tab_id: lease.tab.tab_id },
            parentRunId: runId,
            visibilityUserId: params.scope.principal,
            skipAccountProbe: status !== 'completed',
            verifySourceAccount: status === 'completed',
            retainSourceTab: eligible,
            abortSignal: signal,
          });
          if (cleanup.interruption) {
            interruption = new BrowserInterruptionError(
              cleanup.interruption.reason,
              cleanup.interruption.message,
            );
          } else if (status === 'completed' && cleanup.status !== 'completed') {
            interruption = new BrowserInterruptionError(
              'recovery_unavailable',
              cleanup.error_message ??
                'Final browser account verification or cleanup was not acknowledged.',
            );
          }
          if (cleanup.status === 'completed') {
            if (eligible && cleanup.output?.cleanup_ack === true) outcome = 'retained';
            else if (!eligible && !cleanup.interruption) outcome = 'closed';
          }
        }
        const recovery = await finishSourceBrowser(params.scope.organizationId, runId, outcome);
        if (interruption && recovery) {
          interruption = new BrowserInterruptionError(
            interruption.reason,
            interruption.message,
            recovery,
          );
        }
      } catch (error) {
        cleanupFailed = true;
        throw error;
      } finally {
        if (signal.aborted && leased) {
          // Cancellation may arrive after the source returned rows or after
          // retention was acknowledged. Neither grants a recovery handoff.
          interruption = new BrowserInterruptionError(
            interruption?.reason ?? 'timeout',
            interruption?.message ?? 'Browser source read timed out or was cancelled before completion.',
          );
        }
        // Both typed interruptions and thrown cleanup failures reject the read.
        await scrubSourceReadRun(runId, params.scope.organizationId, feed.feed_key,
          signal.aborted ? 'timeout'
            : status === 'completed' && (interruption || cleanupFailed) ? 'failed' : status);
      }
    },
  };
}
