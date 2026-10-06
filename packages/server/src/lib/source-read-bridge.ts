import { ToolError } from '@lobu/core';
import { resolveActingPrincipal } from '../authz/entity-policy';
import type { AuthzScope } from '../authz/scope';
import { getDb } from '../db/client';
import { createConnectorOperationRun } from '../runs/queue-service';
import { dispatchChromeActionToExtension } from '../worker-api/dispatch-chrome-action';
import { DEVICE_FEED_READ_ACTION_KEY, SOURCE_FEED_READ_METADATA_KEY, SOURCE_FEED_SUBSCRIPTION_METADATA_KEY } from './device-feed-read-protocol';
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
  p: { scope: AuthzScope; automationId?: number | null; feedId: number; deadlineAt: number; sourceSubscription?: boolean },
  signal: AbortSignal,
) {
  const sql = getDb();
  let parent: Promise<number> | undefined;
  const dispatches = new Set<Promise<unknown>>();
  const createParent = async (): Promise<number> => {
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
          ...(p.sourceSubscription ? { [SOURCE_FEED_SUBSCRIPTION_METADATA_KEY]: true } : {}) }, db: tx,
      });
      await tx`UPDATE runs SET feed_id = ${feed.id}, expires_at = ${new Date(p.deadlineAt)},
        connector_version = ${feed.pinned_version ?? feed.definition_version},
        connector_artifact_hash = ${feed.selected_artifact_hash}
        WHERE id = ${run.runId} AND organization_id = ${p.scope.organizationId}`;
      return run.runId;
    });
  };
  return {
    onChromeDispatch(actionKey: string, actionInput: Record<string, unknown>) {
      const pending = (async () => {
        if (signal.aborted) throw sourceReadDeadlineError(p.feedId);
        const parentRunId = await (parent ??= createParent());
        if (signal.aborted) throw sourceReadDeadlineError(p.feedId);
        const result = await dispatchChromeActionToExtension({
          organizationId: p.scope.organizationId, actionKey, actionInput, parentRunId,
          parentConnectionId: Number(feed.connection_id), visibilityUserId: p.scope.principal,
          abortSignal: signal,
        });
        if (result.status !== 'completed') throw new Error(result.error_message ?? `Browser source step ${result.status}`);
        return result.output ?? {};
      })();
      dispatches.add(pending);
      pending.finally(() => dispatches.delete(pending)).catch(() => {});
      return pending;
    },
    async settle(status: 'completed' | 'failed' | 'timeout'): Promise<void> {
      await Promise.allSettled(dispatches);
      if (parent) {
        const runId = await parent.catch(() => undefined);
        if (runId !== undefined) await scrubSourceReadRun(runId, p.scope.organizationId, feed.feed_key, status);
      }
    },
  };
}
