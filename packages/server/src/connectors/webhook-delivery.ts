/**
 * Dispatch a verified provider data delivery to the feeds it updates.
 *
 * The connector declares everything: its webhook schema names where a delivery
 * carries its event type (`eventType`), and each feed names the events that
 * update it (`webhook.events`), which instances a delivery belongs to
 * (`webhook.match`), and whether the payload is complete enough to record
 * (`kind: 'record'` + the runtime `normalize`). Callers have already verified
 * the signature and resolved the tenant scope (an app installation or one
 * registered connection); nothing here names a provider.
 *
 *  - invalidate (default): mark every matching feed due through
 *    `requestFeedSync`, which keeps failure backoff and wakes workers.
 *  - record: commit the verified payload as a `connector-record` queue job
 *    before the caller acks. The job maps it through the connector's
 *    `normalize` with no credentials, network, browser or operations, then
 *    stores the envelope through the same ingest as a sync page. Redeliveries
 *    and the later poll dedupe on the envelope's origin_id.
 */

import type { ConnectorWebhookSchema, FeedWebhookDeclaration } from '@lobu/connector-sdk';
import type { SyncExecutor } from '@lobu/connector-worker/executor/interface';
import { envelopeToContentItem, executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import { type DbClient, getDb, parsePgNumberArray, pgBigintArray } from '../db/client';
import type { IMessageQueue } from '../gateway/infrastructure/queue/types';
import { requestFeedSync } from '../runs/feed-notifications';
import { resolveConnectorCodeForKey } from '../utils/ensure-connector-installed';
import { ingestConnectorItems } from '../worker-api/run-lifecycle';
import { feedDefinitionSelection } from './feed-definition-selection';
import { feedWebhookDrivenSql } from './feed-health-semantics';

const CONNECTOR_RECORD_QUEUE = 'internal:connector-record';

/** A record normalization is a pure mapping; it never needs the sync budget. */
const RECORD_NORMALIZE_TIMEOUT_MS = 30_000;

/** Follow a dotted path (`a.b.c`) into a parsed body and return the leaf. */
export function readDeliveryPath(body: unknown, path: string): unknown {
  let node: unknown = body;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** A non-empty scalar as text; anything else (missing, empty, object, array) is null. */
export function deliveryScalar(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Whether a feed instance belongs to a delivery under its declared
 * `webhook.match`. No selector reaches every feed; a malformed selector (or a
 * missing, empty or non-scalar value on either side) never matches.
 */
function webhookMatchesFeed(
  match: unknown,
  feedConfig: Record<string, unknown> | null,
  payload: unknown
): boolean {
  if (match === undefined || match === null) return true;
  if (typeof match !== 'object') return false;
  const { fields, caseInsensitive } = match as { fields?: unknown; caseInsensitive?: unknown };
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length === 0) return false;
  const fold = (value: string) => (caseInsensitive === true ? value.toLowerCase() : value);
  return entries.every(([configKey, path]) => {
    if (typeof path !== 'string' || path.length === 0) return false;
    const expected = deliveryScalar(feedConfig?.[configKey]);
    const actual = deliveryScalar(readDeliveryPath(payload, path));
    return expected !== null && actual !== null && fold(expected) === fold(actual);
  });
}

/** The durable `connector-record` job a `record` feed's delivery becomes before the ack. */
export interface ConnectorRecordJob {
  organizationId: string;
  connectionId: number;
  feedId: number;
  eventType: string;
  payload: unknown;
  receivedAt: string;
}

/** An app installation's bound connections, or one registered connection. */
type WebhookDeliveryScope = { installationRef: string } | { connectionId: number };

/**
 * Dispatch one verified delivery. Returns whether any feed was marked due or
 * recorded; callers ack either way (an unconfigured feed is not an error).
 */
export async function deliverConnectorWebhook(params: {
  sql: DbClient;
  rawBody: Uint8Array;
  headers: Headers;
  eventType: NonNullable<ConnectorWebhookSchema['eventType']>;
  organizationId: string;
  connectorKey: string;
  scope: WebhookDeliveryScope;
  enqueueRecord: (job: ConnectorRecordJob) => Promise<unknown>;
}): Promise<{ triggered: boolean }> {
  const { sql, scope } = params;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(params.rawBody));
  } catch {
    return { triggered: false };
  }
  const eventType =
    'header' in params.eventType
      ? deliveryScalar(params.headers.get(params.eventType.header))
      : deliveryScalar(readDeliveryPath(payload, params.eventType.path));
  if (!eventType) return { triggered: false };

  // Installation-bound (or the one registered) active connections, sync-capable
  // feeds whose selected definition (pinned version first) declares the event.
  const rows = await sql<{ id: number; connection_id: number; config: Record<string, unknown> | null; webhook: { kind?: unknown; match?: unknown } | null }>`
    SELECT f.id, f.connection_id, f.config, d.feeds_schema -> f.feed_key -> 'webhook' AS webhook
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
    JOIN LATERAL (${feedDefinitionSelection(sql)}) d ON true
    WHERE c.organization_id = ${params.organizationId}
      AND c.connector_key = ${params.connectorKey}
      AND c.status = 'active' AND c.deleted_at IS NULL
      AND f.status = 'active' AND f.deleted_at IS NULL
      ${'installationRef' in scope
        ? sql`AND c.config ->> 'installation_ref' = ${scope.installationRef}`
        : sql`AND c.id = ${scope.connectionId}`}
      AND (${sql.unsafe(feedWebhookDrivenSql('d', 'f'))})
      AND d.feeds_schema -> f.feed_key -> 'operations' @> '["sync"]'::jsonb
      AND d.feeds_schema -> f.feed_key -> 'webhook' -> 'events' ? ${eventType}
    ORDER BY f.id
  `;
  const matched = rows.filter((row) => webhookMatchesFeed(row.webhook?.match, row.config, payload));
  const invalidate = matched.filter((row) => row.webhook?.kind !== 'record').map((row) => Number(row.id));
  const record = matched.filter((row) => row.webhook?.kind === 'record');

  const invalidated =
    invalidate.length > 0
      ? await requestFeedSync(sql, sql`SELECT unnest(${pgBigintArray(invalidate)}::bigint[])`)
      : [];
  const receivedAt = new Date().toISOString();
  for (const row of record) {
    await params.enqueueRecord({
      organizationId: params.organizationId,
      connectionId: Number(row.connection_id),
      feedId: Number(row.id),
      eventType,
      payload,
      receivedAt,
    });
  }
  return { triggered: invalidated.length + record.length > 0 };
}

/** Commit a record job on the internal lane; awaited before the delivery is acked. */
export function connectorRecordEnqueuer(queue: IMessageQueue) {
  return (job: ConnectorRecordJob) => queue.send(CONNECTOR_RECORD_QUEUE, job, { retryLimit: 5 });
}

/** Consume record jobs on this replica; any replica may claim any job. */
export async function startConnectorRecordWorker(queue: IMessageQueue): Promise<void> {
  await queue.createQueue(CONNECTOR_RECORD_QUEUE);
  await queue.work<ConnectorRecordJob>(CONNECTOR_RECORD_QUEUE, async (job) => {
    await processConnectorRecord(job.data);
  });
}

/**
 * Normalize one recorded delivery inside the connector and ingest the envelope
 * as a live record of its feed. A feed paused, deleted or redeclared since the
 * delivery records nothing. Never touches the feed's checkpoint or poll history.
 */
export async function processConnectorRecord(
  job: ConnectorRecordJob,
  options: { executor?: SyncExecutor } = {}
): Promise<'recorded' | 'ignored'> {
  const sql = getDb();
  const [feed] = await sql<{ id: number; feed_key: string; config: Record<string, unknown> | null; entity_ids: unknown; connection_id: number; connector_key: string; version: string; webhook: FeedWebhookDeclaration | null }>`
    SELECT f.id, f.feed_key, f.config, f.entity_ids, c.id AS connection_id, c.connector_key, d.version,
           d.feeds_schema -> f.feed_key -> 'webhook' AS webhook
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
    JOIN LATERAL (${feedDefinitionSelection(sql)}) d ON true
    WHERE f.id = ${job.feedId} AND f.organization_id = ${job.organizationId}
      AND c.id = ${job.connectionId}
      AND c.status = 'active' AND c.deleted_at IS NULL
      AND f.status = 'active' AND f.deleted_at IS NULL
  `;
  if (
    !feed || feed.webhook?.kind !== 'record' ||
    !Array.isArray(feed.webhook.events) || !feed.webhook.events.includes(job.eventType) ||
    !webhookMatchesFeed(feed.webhook.match, feed.config, job.payload)
  ) return 'ignored';

  const result = await executeCompiledConnector({
    compiledCode: await resolveConnectorCodeForKey(feed.connector_key, job.organizationId, feed.version),
    job: {
      mode: 'webhook_record',
      feedKey: feed.feed_key,
      eventType: job.eventType,
      payload: job.payload,
      receivedAt: job.receivedAt,
      config: feed.config ?? {},
      env: {},
    },
    executor: options.executor,
    timeoutMs: RECORD_NORMALIZE_TIMEOUT_MS,
    allowedDomains: [],
  });
  if (result.mode !== 'webhook_record') {
    throw new Error(`Expected webhook_record result, got mode=${result.mode}`);
  }
  if (!result.event) return 'ignored';

  const outcome = await ingestConnectorItems(
    sql,
    {
      runId: null,
      workerId: null,
      organizationId: job.organizationId,
      connectionId: Number(feed.connection_id),
      connectorKey: feed.connector_key,
      feedId: Number(feed.id),
      feedKey: feed.feed_key,
      entityIds: parsePgNumberArray(feed.entity_ids),
      dryRun: false,
      liveRecord: { feedKey: feed.feed_key, config: feed.config },
    },
    [envelopeToContentItem(result.event)],
    null
  );
  if (outcome.status === 'rejected') {
    throw new Error(`Recorded delivery rejected: ${outcome.rejectedItems.flatMap((item) => item.errors).join('; ')}`);
  }
  return outcome.status === 'committed' ? 'recorded' : 'ignored';
}
