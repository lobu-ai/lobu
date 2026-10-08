import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import { getDb, pgTextArray, pgBigintArray, type DbClient } from '../db/client';
import { createSourceReadBridge } from '../lib/source-read-bridge';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';
import { SOURCE_FEED_LISTENER_TASK } from '../scheduled/task-definitions';
import { dbEgressConfig } from '../utils/cloud-mode';
import { resolveConnectorCodeForKey } from '../utils/ensure-connector-installed';
import { mergeExecutionConfig, resolveExecutionAuth } from '../utils/execution-context';
import { feedBackoff } from '../connectors/feed-backoff';
import { connectionBrowserGrant } from '../connectors/browser-resource';
import { feedDefinitionSelection } from '../connectors/feed-definition-selection';
import { feedTriggerEligibilitySql } from '../connectors/feed-health-semantics';
import { sourceFeedScopeKey, sourceFeedSubscriptions } from './source-feed-subscriptions';

const LISTENER_SETUP_TIMEOUT_MS = 150_000;

export interface SourceFeedListenerTask {
  organizationId: string;
  feedId: number;
}

/** Setup errors and rejected source pages share the existing feed retry clock. */
export async function recordSourceFeedFailure(
  sql: DbClient,
  task: SourceFeedListenerTask,
  config: unknown,
  message: string,
): Promise<void> {
  await sql`UPDATE feeds SET consecutive_failures = consecutive_failures + 1,
    last_error = ${message},
    next_run_at = now() + (LEAST(${feedBackoff.maxMs}::bigint,
      ${feedBackoff.baseMs}::bigint * (2 ^ LEAST(consecutive_failures, 30))::bigint) || ' milliseconds')::interval
    WHERE id = ${task.feedId} AND organization_id = ${task.organizationId}
      AND status = 'active' AND deleted_at IS NULL
      ${config === undefined ? sql`` : sql`AND COALESCE(config, '{}'::jsonb) = ${sql.json(config)}::jsonb`}`;
}

/** Both notification delivery and reconnect reconciliation use the same queue identity. */
function listenerTaskKey(organizationId: string, feedId: number): string {
  return `source-feed-listener:${organizationId}:${feedId}`;
}

export async function enqueueSourceFeedListener(
  sql: DbClient,
  organizationId: string,
  feedId: number,
): Promise<void> {
  const [ready] = await sql`SELECT id FROM feeds WHERE id = ${feedId} AND organization_id = ${organizationId}
    AND status = 'active' AND deleted_at IS NULL AND (next_run_at IS NULL OR next_run_at <= now())`;
  if (!ready) return;
  await enqueueTasksInTransaction(sql, [{
    name: SOURCE_FEED_LISTENER_TASK,
    payload: { organizationId, feedId },
    opts: {
      idempotencyKey: listenerTaskKey(organizationId, feedId),
      organizationId,
      maxAttempts: 1,
    },
  }]);
}

/**
 * Only missing bindings or due retries need setup; deliveries go directly through notifications.
 * The browser caps listeners at 64 bindings and reports every binding on each poll.
 */
export async function reconcileSourceFeedListeners(
  sql: DbClient,
  deviceId: string,
  orgIds: string[],
  boundFeedIds: number[],
): Promise<void> {
  const feeds = await sql`
    SELECT f.id, f.organization_id FROM feeds f
    JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
    JOIN LATERAL (${feedDefinitionSelection(sql)}) d ON true
    WHERE c.device_worker_id = ${deviceId}::uuid AND c.organization_id = ANY(${pgTextArray(orgIds)}::text[])
      AND c.status = 'active' AND c.deleted_at IS NULL AND f.status = 'active' AND f.deleted_at IS NULL
      AND (f.next_run_at IS NULL OR f.next_run_at <= now())
      AND (${sql.unsafe(feedTriggerEligibilitySql('d', 'f', 'source-only'))})
      AND (NOT (f.id = ANY(${pgBigintArray(boundFeedIds)}::bigint[])) OR f.next_run_at <= now())
      -- Cheap candidate filter; event matching, visibility and policy resolve once below.
      AND EXISTS (SELECT 1 FROM automations a
        WHERE a.organization_id = f.organization_id AND a.status = 'active'
          AND a.triggers @> jsonb_build_array(jsonb_build_object('kind', 'event', 'connector_key', c.connector_key)))
  `;
  for (const feed of feeds) {
    const task = { organizationId: feed.organization_id, feedId: Number(feed.id) };
    try {
      // An active task owns this feed; the partial active-task index avoids
      // repeating its owner/visibility scans while it waits for the browser.
      const [pending] = await sql`SELECT id FROM runs
        WHERE idempotency_key = ${listenerTaskKey(task.organizationId, task.feedId)}
          AND status IN ('pending', 'claimed', 'running')`;
      if (pending) continue;
      if (!(await sourceFeedSubscriptions(sql, task.organizationId, task.feedId)).length) continue;
      await sql.begin(tx => enqueueSourceFeedListener(tx, task.organizationId, task.feedId));
    } catch (error) {
      await recordSourceFeedFailure(sql, task, undefined, 'Source listener reconciliation failed; retrying.');
      throw error;
    }
  }
}

export async function runSourceFeedListener(task: SourceFeedListenerTask): Promise<void> {
  const sql = getDb();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LISTENER_SETUP_TIMEOUT_MS);
  let browser: ReturnType<typeof createSourceReadBridge> | undefined;
  let status: 'completed' | 'failed' | 'timeout' = 'failed';
  let config: Record<string, unknown> | undefined;

  try {
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

    browser = createSourceReadBridge(
      {
        id: Number(feed.id),
        connection_id: Number(feed.connection_id),
        feed_key: String(feed.feed_key),
        connector_key: String(feed.connector_key),
        pinned_version: feed.pinned_version,
        definition_version: feed.definition_version,
        selected_artifact_hash: feed.selected_artifact_hash,
      },
      {
        scope: {
          organizationId: task.organizationId,
          principal: subscription.principal,
          agentId: subscription.agentId,
        },
        automationId: subscription.automationId,
        feedId: task.feedId,
        deadlineAt: Date.now() + LISTENER_SETUP_TIMEOUT_MS,
        sourceSubscriptionScopeKey: sourceFeedScopeKey(feed.config, feed.pinned_version ?? feed.definition_version),
      },
      controller.signal,
    );
    const checkpoint = feed.checkpoint?.cursor as Record<string, unknown> | null ?? null;
    config = feed.config ?? {};
    // Keep setup due until it completes. A gateway crash after binding the page
    // must still be recoverable when the abandoned task is reaped.
    const [started] = await sql`UPDATE feeds SET next_run_at = now()
      WHERE id = ${task.feedId} AND organization_id = ${task.organizationId}
        AND COALESCE(config, '{}'::jsonb) = ${sql.json(config)}::jsonb
      RETURNING consecutive_failures`;
    if (!started) return;
    const compiledCode = await resolveConnectorCodeForKey(
      feed.connector_key,
      task.organizationId,
      feed.pinned_version ?? feed.definition_version,
    );
    const auth = await resolveExecutionAuth({
      organizationId: task.organizationId,
      connectionId: Number(feed.connection_id),
      authProfileId: Number(feed.auth_profile_id) || null,
      appAuthProfileId: Number(feed.app_auth_profile_id) || null,
      credentialDb: sql,
      logContext: { feedId: String(task.feedId) },
      logMessage: 'Failed to resolve source listener credentials',
    });
    await executeCompiledConnector({
      compiledCode,
      job: {
        mode: 'observe',
        browser: await connectionBrowserGrant(task.organizationId, Number(feed.connection_id), feed.pinned_version ?? feed.definition_version),
        feedId: task.feedId,
        feedKey: feed.feed_key,
        checkpoint,
        config: {
          ...mergeExecutionConfig(feed.connection_config, auth.connectionCredentials, config),
          ...dbEgressConfig(),
        },
        credentials: auth.credentials,
        sessionState: auth.sessionState,
        httpAuth: auth.httpAuth,
        env: dbEgressConfig(),
      },
      hooks: {
        onHttpFetch: auth.onHttpFetch,
        onChromeDispatch: browser.onChromeDispatch,
        signal: controller.signal,
      },
      timeoutMs: LISTENER_SETUP_TIMEOUT_MS,
    });

    // Only a valid browser delivery confirms recovery. Keep the failure count
    // through setup, and do not erase a rejected page received during setup.
    await sql`UPDATE feeds SET last_error = NULL,
      next_run_at = now() + (${feedBackoff.baseMs}::bigint || ' milliseconds')::interval
      WHERE id = ${task.feedId} AND organization_id = ${task.organizationId}
        AND COALESCE(config, '{}'::jsonb) = ${sql.json(config)}::jsonb
        AND consecutive_failures = ${started.consecutive_failures}`;
    status = 'completed';
  } catch (error) {
    await recordSourceFeedFailure(sql, task, config, 'Source listener setup failed; check the paired browser.');
    throw error;
  } finally {
    if (controller.signal.aborted) status = 'timeout';
    controller.abort();
    clearTimeout(timer);
    await browser?.settle(status);
  }
}
