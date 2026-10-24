import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { compileConnectionFkVisibility } from '../../authz/connection-visibility';
import { compileResourceVisibility } from '../../authz/resource-visibility';
import { authzScopeFromToolContext } from '../../authz/scope';
import { entityReadRestrictions } from '../../authz/entity-read-policy';
import { matchingAutomationTriggers, referenceCaptureTriggers } from '../../automations/event-trigger';
import type { DbClient } from '../../db/client';
import type { Env } from '../../index';
import type { ToolContext } from '../registry';
import { ToolUserError } from '../../utils/errors';
import { readArrivalHorizon } from '../../utils/window-utils';
import { getJwtSecret } from '../../utils/jwt';
import type { GetContentArgs } from './schema';
import type { GetContentResult } from './types';

const PURPOSE = 'lobu:source-change-read:v1';
interface Cursor {
  fingerprint: string;
  start: string;
  end: string | null;
  after: { at: string; id: number } | null;
}

// Encrypt as well as authenticate: a scan cursor can cross hidden rows and
// must not disclose their IDs/timestamps. It is never a completion capability.
function cursorKey(env: Env): Buffer {
  return createHash('sha256').update(PURPOSE).update(getJwtSecret(env)).digest();
}
function encodeCursor(cursor: Cursor, env: Env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorKey(env), iv);
  cipher.setAAD(Buffer.from(PURPOSE));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(cursor), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function decodeCursor(value: string, env: Env): Cursor {
  try {
    const bytes = Buffer.from(value, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', cursorKey(env), bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(PURPOSE));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const cursor = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
    if (typeof cursor.fingerprint !== 'string' || typeof cursor.start !== 'string'
      || !Number.isFinite(Date.parse(cursor.start))
      || (cursor.end !== null && (typeof cursor.end !== 'string' || !Number.isFinite(Date.parse(cursor.end))))
      || (cursor.after !== null && (typeof cursor.after?.at !== 'string'
        || !Number.isFinite(Date.parse(cursor.after.at)) || !Number.isSafeInteger(cursor.after.id)))) throw new Error('Invalid cursor');
    return cursor;
  } catch {
    throw new ToolUserError('Invalid change-read cursor. Restart the read without cursor.', 400);
  }
}

/** Every accepted source observation, bounded on arrival time, independent of execution progress. */
export async function readAutomationChanges(sql: DbClient, args: GetContentArgs, env: Env,
  ctx: ToolContext): Promise<GetContentResult> {
  if (Object.keys(args).some(key => !['automation_id', 'view', 'cursor', 'limit'].includes(key))) {
    throw new ToolUserError('view=changes accepts automation_id, cursor and limit only.', 400);
  }
  if (!args.automation_id || !Number.isSafeInteger(args.automation_id) || args.automation_id < 1) {
    throw new ToolUserError('view=changes accepts automation_id, cursor and limit only.', 400);
  }
  const [automation] = await sql`SELECT id, current_version_id, triggers, status FROM automations
    WHERE id = ${args.automation_id} AND organization_id = ${ctx.organizationId}`;
  if (!automation) throw new ToolUserError('Automation not found.', 404);
  if (automation.status === 'archived') throw new ToolUserError('This source subscription was deleted.', 410);
  const triggers = referenceCaptureTriggers(automation.triggers ?? []);
  if (!triggers.length) throw new ToolUserError('This Automation has no reference-capture subscriptions.', 422);
  const scope = authzScopeFromToolContext(ctx);
  const restrictions = ctx.agentId || ctx.actingAutomationId ? await entityReadRestrictions(sql, ctx) : [];
  // Captured references have no resource/entity attribution. They remain
  // unreadable on ACL-graphed sources; never infer source access from a ref.
  const denyUnlinked = restrictions.some(rule => rule.entity_id === null
    && (rule.entity_type_slug === null || rule.entity_type_slug === '$member'));
  const selectors = triggers.flatMap(trigger => trigger.event_types.map(eventType => ({
    connector_key: trigger.connector_key, connection_id: trigger.connection_id ?? null, event_type: eventType,
  })));
  const scopeParams: unknown[] = [ctx.organizationId, JSON.stringify(selectors)];
  const connection = compileConnectionFkVisibility(scope, scopeParams.length + 1, 'v');
  scopeParams.push(...connection.params);
  const resource = compileResourceVisibility(scope, scopeParams.length + 1, 'v');
  scopeParams.push(...resource.params);
  const sourceQuery = `SELECT DISTINCT c.id, selector.event_type
      FROM jsonb_to_recordset($2::text::jsonb) AS selector(connector_key text, connection_id bigint, event_type text)
      JOIN connections c ON c.organization_id = $1 AND c.connector_key = selector.connector_key
        AND (selector.connection_id IS NULL OR c.id = selector.connection_id)
      CROSS JOIN LATERAL (SELECT c.id AS connection_id, '{}'::bigint[] AS entity_ids,
        'none'::text AS interaction_type) v
      WHERE c.deleted_at IS NULL ${connection.sql} ${resource.sql}`;
  const sources = denyUnlinked ? [] : await sql.unsafe(sourceQuery + ' ORDER BY c.id, selector.event_type', scopeParams);
  const fingerprint = createHash('sha256').update(JSON.stringify([
    ctx.organizationId, args.automation_id, automation.current_version_id, triggers,
    ctx.userId, scope.principal, ctx.actingAutomationId ?? null, ctx.agentId ?? null, ctx.clientId ?? null,
    sources.map(row => [Number(row.id), row.event_type]),
  ])).digest('hex');
  const previous = args.cursor ? decodeCursor(args.cursor, env) : null;
  if (previous && previous.fingerprint !== fingerprint) {
    throw new ToolUserError('Change-read scope or Automation configuration changed. Restart without cursor.', 409);
  }
  const start = previous?.start ?? '1970-01-01T00:00:00.000Z';
  // The execution helper rounds UP; change readers close only a settled past
  // boundary so new transactions cannot arrive behind their resume cursor.
  const horizon = new Date((await readArrivalHorizon(sql)).getTime() - 1).toISOString();
  const end = previous?.end ?? (horizon < start ? start : horizon);
  const after = previous?.end ? previous.after : null;
  const limit = Math.max(1, Math.min(200, Math.trunc(args.limit ?? 50)));
  const params: unknown[] = [...scopeParams, start, end, limit + 1, JSON.stringify(sources)];
  const startParam = scopeParams.length + 1;
  const endParam = startParam + 1;
  const limitParam = endParam + 1;
  const sourcesParam = limitParam + 1;
  let afterSql = '';
  if (after) {
    params.push(after.at, after.id);
    // Force text parameter inference: the driver's timestamptz serializer
    // otherwise converts this lossless string through a millisecond JS Date.
    afterSql = `AND (created_at, id) > ($${params.length - 1}::text::timestamptz, $${params.length}::bigint)`;
  }
  // Enumerate only bounded configuration, then use one bounded arrival-index
  // scan per authorized connection/event type. Private or ACL-graphed source
  // arrivals never influence page counts. Resource-ref matching can still yield
  // sparse pages within a source the caller may read in full.
  const candidates = !sources.length ? [] : await sql.unsafe(`WITH sources AS MATERIALIZED (
      ${sourceQuery}
      AND (c.id, selector.event_type) IN (SELECT granted.id, granted.event_type
        FROM jsonb_to_recordset($${sourcesParam}::text::jsonb) AS granted(id bigint, event_type text))
    ) SELECT candidate.* FROM sources s CROSS JOIN LATERAL (
      SELECT id, created_at::text AS position, origin_id, semantic_type, connector_key,
        connection_id, feed_id, feed_key,
        jsonb_build_object('observation_id', metadata->'observation_id', 'resource_ref', metadata->'resource_ref',
          'resource_type', metadata->'resource_type', 'source_occurred_at', metadata->'source_occurred_at',
          'source_scope', metadata->'source_scope') AS metadata, created_at, occurred_at, title
      FROM events WHERE organization_id = $1 AND origin_type = 'source_reference'
        AND payload_type = 'empty' AND cardinality(COALESCE(entity_ids, '{}'::bigint[])) = 0
        AND connection_id = s.id AND semantic_type = s.event_type
        AND created_at >= $${startParam}::timestamptz AND created_at < $${endParam}::timestamptz
        ${afterSql} ORDER BY created_at, id LIMIT $${limitParam}
    ) candidate ORDER BY candidate.created_at, candidate.id LIMIT $${limitParam}`, params);
  const hasMore = candidates.length > limit;
  const scanned = candidates.slice(0, limit);
  const content = scanned.filter(row => matchingAutomationTriggers(triggers, {
    connector_key: row.connector_key, connection_id: Number(row.connection_id),
    event_type: row.semantic_type, resource_ref: row.metadata?.resource_ref,
    resource_type: row.metadata?.resource_type ?? undefined, delivery_id: row.origin_id,
    label: row.title ?? '', input_text: '',
  }).length > 0).map(({ position: _position, ...row }) => ({ ...row, id: Number(row.id), connection_id: Number(row.connection_id), feed_id: Number(row.feed_id) }));
  const last = scanned.at(-1);
  return {
    content, total: null, page: { limit, offset: 0, has_more: hasMore },
    ...(hasMore && last ? { next_cursor: encodeCursor({ fingerprint, start, end,
      // Lossless PG text, not JS Date: several arrivals can share a millisecond.
      after: { at: last.position, id: Number(last.id) } }, env) } : {
      resume_cursor: encodeCursor({ fingerprint, start: end, end: null, after: null }, env),
    }),
  };
}
