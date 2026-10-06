import { createHash } from 'node:crypto';
import { assertFeedObservation, type ConnectorAutomationEvent, type FeedObserveResult } from '@lobu/connector-sdk';
import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import { findMatchingAutomationActivations, queueAutomationActivations } from '../automations/activation';
import { getDb, pgTextArray, type DbClient } from '../db/client';
import { createSourceReadBridge } from '../lib/source-read-bridge';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';
import { SOURCE_FEED_OBSERVATION_TASK } from '../scheduled/task-definitions';
import { dbEgressConfig } from '../utils/cloud-mode';
import { resolveConnectorCodeForKey } from '../utils/ensure-connector-installed';
import { mergeExecutionConfig, resolveExecutionAuth } from '../utils/execution-context';
import { feedBackoff } from '../connectors/feed-backoff';
import { feedDefinitionSelection } from '../connectors/feed-definition-selection';
import { sourceFeedSubscriptions } from './source-feed-subscriptions';

export interface SourceFeedObservationTask { organizationId: string; feedId: number }

/** Both notification delivery and reconnect reconciliation use the same queue identity. */
function observationTaskKey(organizationId: string, feedId: number): string {
  return `source-feed-observation:${organizationId}:${feedId}`;
}

export async function enqueueSourceFeedObservation(sql: DbClient, organizationId: string, feedId: number): Promise<void> {
  const [ready] = await sql`SELECT id FROM feeds WHERE id = ${feedId} AND organization_id = ${organizationId}
    AND status = 'active' AND deleted_at IS NULL AND (next_run_at IS NULL OR next_run_at <= now())`;
  if (!ready) return;
  await enqueueTasksInTransaction(sql, [{
    name: SOURCE_FEED_OBSERVATION_TASK, payload: { organizationId, feedId },
    opts: { idempotencyKey: observationTaskKey(organizationId, feedId), organizationId, maxAttempts: 1 },
  }]);
}

/** The device poll supplies liveness only. Source data is never polled without a subscriber. */
export async function reconcileSourceFeedObservations(sql: DbClient, deviceId: string, orgIds: string[], boundFeedIds: number[]): Promise<void> {
  const feeds = await sql`
    SELECT f.id, f.organization_id, f.next_run_at <= now() AS retry_due FROM feeds f
    JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
    JOIN LATERAL (${feedDefinitionSelection(sql)}) d ON true
    WHERE c.device_worker_id = ${deviceId}::uuid AND c.organization_id = ANY(${pgTextArray(orgIds)}::text[])
      AND c.status = 'active' AND c.deleted_at IS NULL AND f.status = 'active' AND f.deleted_at IS NULL
      AND d.feeds_schema->f.feed_key->'operations' ? 'observe'
  `;
  for (const feed of feeds) {
    if (boundFeedIds.includes(Number(feed.id)) && !feed.retry_due) continue;
    if (!(await sourceFeedSubscriptions(sql, feed.organization_id, Number(feed.id))).length) continue;
    await sql.begin(tx => enqueueSourceFeedObservation(tx, feed.organization_id, Number(feed.id)));
  }
}

/** Queue reference signals and advance the checkpoint in one transaction. */
export async function commitSourceFeedObservation(
  sql: DbClient, task: SourceFeedObservationTask, previous: Record<string, unknown> | null,
  result: FeedObserveResult,
): Promise<boolean> {
  assertFeedObservation(result);
  return sql.begin(async tx => {
    const [feed] = await tx`
      SELECT f.checkpoint, f.feed_key, f.connection_id, c.connector_key, d.automation_events
      FROM feeds f JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
      JOIN LATERAL (${feedDefinitionSelection(tx)}) d ON true
      WHERE f.id = ${task.feedId} AND f.organization_id = ${task.organizationId}
        AND f.checkpoint IS NOT DISTINCT FROM ${previous === null ? null : tx.json(previous)}::jsonb
      FOR UPDATE OF f, c
    `;
    if (!feed) return false; // A recovered worker already committed this checkpoint.
    const subscriptions = await sourceFeedSubscriptions(tx, task.organizationId, task.feedId);
    if (!subscriptions.length) return false;
    const allowed = new Set(subscriptions.map(subscription => subscription.automationId));
    const eventKeys = new Set((feed.automation_events as ConnectorAutomationEvent[] | null ?? []).map(event => event.key));
    for (const change of result.changes) {
      if (!eventKeys.has(change.event_type)) throw new Error('Source observation returned an undeclared Automation event');
      const deliveryId = createHash('sha256').update(JSON.stringify([task.organizationId, Number(feed.connection_id), change.event_type, change.delivery_id])).digest('hex');
      const signal = {
        ...change, connector_key: String(feed.connector_key), connection_id: Number(feed.connection_id),
        delivery_id: `source:${deliveryId}`, label: `Source ${change.event_type}`,
        input_text: `Source change ${change.event_type}. Read feed ${task.feedId} for source reference ${JSON.stringify(change.resource_ref)}.`,
        attributes: { feed_id: task.feedId, feed_key: String(feed.feed_key) },
      };
      const matches = await findMatchingAutomationActivations(task.organizationId, signal, tx);
      await queueAutomationActivations({ matches: matches.filter(match => allowed.has(match.automationId)), signal, db: tx });
    }
    await tx`UPDATE feeds SET checkpoint = ${result.checkpoint === null ? null : tx.json(result.checkpoint)},
      consecutive_failures = 0, last_error = NULL, next_run_at = ${result.hasMore ? tx`now()` : null}
      WHERE id = ${task.feedId} AND organization_id = ${task.organizationId}`;
    return true;
  });
}

export async function runSourceFeedObservation(task: SourceFeedObservationTask): Promise<void> {
  const sql = getDb();
  const [subscription] = await sourceFeedSubscriptions(sql, task.organizationId, task.feedId);
  if (!subscription) return;
  const [feed] = await sql`
    SELECT f.id, f.connection_id, f.feed_key, f.config, f.checkpoint, f.pinned_version,
      c.connector_key, c.config AS connection_config, c.auth_profile_id, c.app_auth_profile_id,
      d.version AS definition_version,
      (SELECT cv.compiled_code_hash FROM connector_versions cv
       WHERE cv.connector_key = c.connector_key AND cv.version = COALESCE(f.pinned_version, d.version)
         AND (cv.organization_id = c.organization_id OR cv.organization_id IS NULL)
       ORDER BY cv.organization_id NULLS LAST LIMIT 1) AS selected_artifact_hash
    FROM feeds f JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
    JOIN LATERAL (${feedDefinitionSelection(sql)}) d ON true
    WHERE f.id = ${task.feedId} AND f.organization_id = ${task.organizationId}
  `;
  if (!feed) return;
  const timeoutMs = 150_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const browser = createSourceReadBridge({
    id: Number(feed.id), connection_id: Number(feed.connection_id), feed_key: String(feed.feed_key),
    connector_key: String(feed.connector_key), pinned_version: feed.pinned_version,
    definition_version: feed.definition_version, selected_artifact_hash: feed.selected_artifact_hash,
  }, {
    scope: { organizationId: task.organizationId, principal: subscription.principal, agentId: subscription.agentId },
    automationId: subscription.automationId, feedId: task.feedId, deadlineAt: Date.now() + timeoutMs,
    observation: true,
  }, controller.signal);
  let status: 'completed' | 'failed' | 'timeout' = 'failed';
  try {
    const compiledCode = await resolveConnectorCodeForKey(feed.connector_key, task.organizationId, feed.pinned_version ?? feed.definition_version);
    const auth = await resolveExecutionAuth({
      organizationId: task.organizationId, connectionId: Number(feed.connection_id),
      authProfileId: Number(feed.auth_profile_id) || null, appAuthProfileId: Number(feed.app_auth_profile_id) || null,
      credentialDb: sql, logContext: { feedId: String(task.feedId) }, logMessage: 'Failed to resolve source observation credentials',
    });
    let checkpoint = feed.checkpoint as Record<string, unknown> | null;
    // Bound each task; unacknowledged browser records request the next drain.
    for (let page = 0; page < 10; page++) {
      const result = await executeCompiledConnector({
        compiledCode, job: {
          mode: 'observe', feedId: task.feedId, feedKey: feed.feed_key, checkpoint,
          config: { ...mergeExecutionConfig(feed.connection_config, auth.connectionCredentials, feed.config ?? {}), ...dbEgressConfig() },
          credentials: auth.credentials, sessionState: auth.sessionState, httpAuth: auth.httpAuth, env: dbEgressConfig(),
        }, hooks: { onHttpFetch: auth.onHttpFetch, onChromeDispatch: browser.onChromeDispatch, signal: controller.signal }, timeoutMs,
      });
      if (result.mode !== 'observe') throw new Error('Expected source observation result');
      if (!(await commitSourceFeedObservation(sql, task, checkpoint, result))) break;
      checkpoint = result.checkpoint;
      if (!result.hasMore) break;
    }
    status = 'completed';
  } catch (error) {
    // Reuse the feed retry clock. This is failure recovery, never a collection cadence.
    await sql`UPDATE feeds SET consecutive_failures = consecutive_failures + 1,
      last_error = 'Source observation failed; inspect the observation run and paired source.',
      next_run_at = now() + (LEAST(${feedBackoff.maxMs}::bigint,
        ${feedBackoff.baseMs}::bigint * (2 ^ LEAST(consecutive_failures, 30))::bigint) || ' milliseconds')::interval
      WHERE id = ${task.feedId} AND organization_id = ${task.organizationId}`;
    throw error;
  } finally {
    if (controller.signal.aborted) status = 'timeout';
    controller.abort(); clearTimeout(timer);
    await browser.settle(status);
  }
}
