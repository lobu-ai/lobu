import { ToolError, BrowserInterruptionError, browserPageInterruption } from '@lobu/core';
import { claimSourceBrowser, finishSourceBrowser, sourceBrowserLease, sourceRecoveryHash } from './browser-recovery';
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

export function createSourceReadBridge(
  feed: {
    id: number;
    connection_id: number;
    connector_key: string;
    feed_key: string;
    pinned_version: string | null;
    definition_version: string | null;
    selected_artifact_hash: string | null;
  },
  p: { scope: AuthzScope; automationId?: number | null; feedId: number; deadlineAt: number; flowId?: string; onBrowserLease?: () => void; recoveryId?: string; sourceRevision?: string; query?: string; cursor?: string; limit?: number; offset?: number; sort?: unknown; window?: unknown; match?: unknown; sourceSubscriptionScopeKey?: string },
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
      organizationId: p.scope.organizationId, userId: p.scope.principal,
      agentId: p.scope.agentId, sessionAutomationId: p.automationId,
    });
    if (!actor.ownerResolved) throw new ToolError('PERMISSION', 'Source reader has no valid requesting principal.');
    return sql.begin(async (tx) => {
      const run = await createConnectorOperationRun({
        organizationId: p.scope.organizationId, connectionId: Number(feed.connection_id),
        connectorKey: feed.connector_key, operationKey: DEVICE_FEED_READ_ACTION_KEY,
        operationInput: { feed_key: feed.feed_key }, approvalMode: 'inline',
        policyPrincipalKind: actor.kind, policyPrincipalId: actor.id,
        createdByUserId: p.scope.principal, automationId: p.automationId,
        runMetadata: { [SOURCE_FEED_READ_METADATA_KEY]: true,
          ...(p.sourceSubscriptionScopeKey ? { [SOURCE_FEED_SUBSCRIPTION_METADATA_KEY]: true,
            [SOURCE_FEED_SCOPE_METADATA_KEY]: p.sourceSubscriptionScopeKey } : {}) }, db: tx,
      });
      await tx`UPDATE runs SET feed_id = ${feed.id}, expires_at = ${new Date(p.deadlineAt)},
        connector_version = ${feed.pinned_version ?? feed.definition_version},
        connector_artifact_hash = ${feed.selected_artifact_hash}
        WHERE id = ${run.runId} AND organization_id = ${p.scope.organizationId}`;
      if (retainOnInterruption || p.recoveryId) leased = !!await claimSourceBrowser({ runId: run.runId, connectionId: Number(feed.connection_id),
        version: feed.pinned_version ?? feed.definition_version, scope: p.scope, automationId: p.automationId,
        deadlineAt: p.deadlineAt, flowId: p.flowId, recoveryId: p.recoveryId,
        requestHash: sourceRecoveryHash({ feedId: feed.id, revision: p.sourceRevision, query: p.query,
          cursor: p.cursor, limit: p.limit, offset: p.offset, sort: p.sort, window: p.window, match: p.match }),
      }, tx);
      if (leased) p.onBrowserLease?.();
      return run.runId;
    });
  };
  return {
    async prepare() {
      if (p.recoveryId) await (parent ??= createParent());
    },
    onChromeDispatch(actionKey: string, actionInput: Record<string, unknown>) {
      const cleanup = actionKey === 'network_intercept_stop' || actionKey === 'close_tab';
      const dispatchSignal = cleanup ? signal : workSignal;
      const pending = (async () => {
        if (dispatchSignal.aborted) throw sourceReadDeadlineError(p.feedId);
        const parentRunId = await (parent ??= createParent(actionKey === 'navigate' && actionInput.new_tab === true && actionInput.retain_on_interruption === true));
        if (dispatchSignal.aborted) throw sourceReadDeadlineError(p.feedId);
        // A leased tab is closed or retained by settle(); an unleased scratch tab
        // still closes through the connector's own cleanup.
        if (interruption && actionKey === 'close_tab' && leased) return { closed: false, cleanup_pending: true };
        if (interruption && !cleanup) throw interruption;
        const result = await dispatchChromeActionToExtension({
          organizationId: p.scope.organizationId, actionKey, actionInput: Object.fromEntries(Object.entries(actionInput).filter(([key]) => key !== 'retain_on_interruption')), parentRunId,
          visibilityUserId: p.scope.principal,
          abortSignal: dispatchSignal,
          skipAccountProbe: !!interruption && cleanup,
          verifySourceAccount: actionKey === 'close_tab',
        });
        const marker = result.interruption ?? browserPageInterruption(result.output?.value);
        if (marker) {
          interruption = new BrowserInterruptionError(marker.reason, marker.message);
          throw interruption;
        }
        if (result.status !== 'completed') throw new Error(result.error_message ?? `Browser source step ${result.status}`);
        if (actionKey === 'close_tab') tabClosed = true;
        return result.output ?? {};
      })().catch(error => {
        if (error instanceof BrowserInterruptionError) interruption = error;
        throw error;
      });
      dispatches.add(pending);
      pending.finally(() => dispatches.delete(pending)).catch(() => {});
      return pending;
    },
    get leased() { return leased; },
    get interruption() { return interruption; },
    async settle(status: 'completed' | 'failed' | 'timeout'): Promise<void> {
      if (settled) return;
      settled = true;
      // A crashed isolate can leave an unawaited dispatch. Cancel ordinary work
      // before joining it, while keeping capture/tab cleanup within its budget.
      workController.abort();
      await Promise.allSettled(dispatches);
      if (parent) {
        const runId = await parent.catch(() => undefined);
        if (runId !== undefined) {
          try {
            const lease = await sourceBrowserLease(p.scope.organizationId, runId);
            let retained = false;
            let cleanupAcknowledged = tabClosed;
            if (lease?.tab && !tabClosed && !signal.aborted) {
              const eligible = interruption?.reason === 'challenge_required' && !!lease.owner.flow_id && !lease.resumed;
              const cleanup = await dispatchChromeActionToExtension({ organizationId: p.scope.organizationId,
                actionKey: 'close_tab', actionInput: { tab_id: lease.tab.tab_id }, parentRunId: runId,
                visibilityUserId: p.scope.principal, skipAccountProbe: status !== 'completed', verifySourceAccount: status === 'completed', retainSourceTab: eligible, abortSignal: signal });
              if (cleanup.interruption) interruption = new BrowserInterruptionError(cleanup.interruption.reason, cleanup.interruption.message);
              else if (status === 'completed' && cleanup.status !== 'completed') interruption = new BrowserInterruptionError('recovery_unavailable', cleanup.error_message ?? 'Final browser account verification or cleanup was not acknowledged.');
              retained = eligible && cleanup.status === 'completed' && cleanup.output?.cleanup_ack === true;
              cleanupAcknowledged = cleanup.status === 'completed' && (eligible ? retained : !cleanup.interruption);
            }
            const recovery = await finishSourceBrowser(p.scope.organizationId, runId, retained, cleanupAcknowledged);
            if (interruption && recovery) interruption = new BrowserInterruptionError(interruption.reason, interruption.message, recovery);
          } finally { await scrubSourceReadRun(runId, p.scope.organizationId, feed.feed_key, status); }
        }
      }
    },
  };
}
