#!/usr/bin/env bun
/**
 * Offline retirement of stored event JSON presentation. Preview is read-only.
 *   bun packages/server/scripts/convert-event-presentation.ts --org <id> --ids <id,id> --out <manifest.json>
 *   bun packages/server/scripts/convert-event-presentation.ts --org <id> --apply <manifest.json>
 * Apply accepts only an unchanged preview, appends versions through insertEvent,
 * and never invokes afterPersist or edits delivered chat messages.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkTemplate } from '@lobu/core/json-template';
import { type DbClient, getDb } from '../src/db/client';
import { type EventKindDefinition, resolveEventKindData, resolveEventKindDefinition } from '../src/utils/event-kind-validation';
import { insertEvent, type InsertEventParams, stableJson } from '../src/utils/insert-event';
import { exceedsValidationLimits } from '../src/utils/metadata-limits';

const MARKER = '_lobu_presentation_conversion';
const MAX_BATCH = 100;
const MAX_OUTPUT = 262_144;

type StoredEvent = Record<string, unknown> & {
  id: number; organization_id: string; entity_ids: number[] | null;
  origin_id: string | null; semantic_type: string; payload_type: string;
  payload_text: string | null; payload_template: Record<string, unknown> | null;
  payload_data: Record<string, unknown>; metadata: Record<string, unknown>;
  superseded_by: number | null; interaction_type: string;
};
interface Entry {
  sourceEventId: number;
  status: 'ready' | 'blocked' | 'historical' | 'unchanged';
  fingerprint: string;
  markdown?: string;
  reason?: string;
}
interface Manifest {
  version: 1;
  organizationId: string;
  entries: Entry[];
}

function plain(value: unknown): string {
  return value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function literal(value: unknown): string {
  return plain(value).replaceAll('&', '&amp;').replace(/[\\`*_[\]{}()#+.!|<>~-]/g, '\\$&');
}
function cell(value: unknown): string {
  return literal(value).replace(/\r?\n/g, '<br>');
}
function table(rows: unknown, columns: Array<{ key: string; label: string }>): string {
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
    throw new Error('Table/chart data must be an array of records');
  }
  return [
    '| ' + columns.map((c) => cell(c.label)).join(' | ') + ' |',
    '| ' + columns.map(() => '---').join(' | ') + ' |',
    ...rows.map((r) => '| ' + columns.map((c) => cell((r as Record<string, unknown>)[c.key])).join(' | ') + ' |'),
  ].join('\n');
}

/** The shared walker owns binding, conditions, loops and formatting. */
export function snapshotTemplate(template: Record<string, unknown>, data: Record<string, unknown>): string {
  if (exceedsValidationLimits({ template, data })) throw new Error('Template exceeds conversion limits');
  if (template.interactions && Object.keys(template.interactions).length) throw new Error('Custom interactions require review');
  const root = template.root;
  const pending = [{ node: root, inLoop: false }];
  // Validate every branch, including hidden controls; nested loops are held for
  // explicit review rather than allowing multiplicative expansion offline.
  while (pending.length) {
    const { node, inLoop } = pending.pop()!;
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Malformed template node');
    const n = node as Record<string, unknown>;
    const props = (n.props ?? {}) as Record<string, unknown>;
    if ([...Object.keys(n), ...Object.keys(props)].some((k) => /^on[A-Z]/.test(k))
      || ['button', 'select', 'input', 'form'].includes(String(n.type))) {
      throw new Error('Interactive template requires review');
    }
    if (n.type === 'text' && typeof n.content !== 'string') throw new Error('Malformed text node');
    if (n.type === 'data' && typeof n.path !== 'string') throw new Error('Malformed data node');
    if (n.type === 'each') {
      if (inLoop || typeof n.items !== 'string' || typeof n.as !== 'string') throw new Error('Unsupported loop');
      if (typeof n.render !== 'string') pending.push({ node: n.render, inLoop: true });
    } else if (n.type === 'if') {
      if (typeof n.condition !== 'string') throw new Error('Malformed condition');
      pending.push({ node: n.then, inLoop });
      if (n.else !== undefined) pending.push({ node: n.else, inLoop });
    } else if (n.children !== undefined) {
      if (!Array.isArray(n.children)) throw new Error('Malformed children');
      pending.push(...n.children.map((child) => ({ node: child, inLoop })));
    }
  }
  let bytes = 0;
  let visits = 0;
  const emit = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (++visits > 10_000 || bytes > MAX_OUTPUT) throw new Error('Rendered snapshot exceeds conversion limits');
    return [text];
  };
  const unsupported = new Set<string>();
  const parts = walkTemplate<string>(root, data, {
    text: (value) => emit(literal(value)),
    value: (value) => emit(literal(value)),
    component: (type, props, children) => {
      const content = children.join('');
      switch (type) {
        case 'card': case 'card-header': case 'card-content': case 'context':
        case 'div': case 'layout': case 'columns': case 'fields':
          return emit('\n\n' + content + '\n\n');
        case 'card-title': case 'h1': case 'h2': case 'h3':
          return emit('\n\n### ' + content + '\n\n');
        case 'card-description': case 'p': return emit('\n\n' + content + '\n\n');
        case 'span': case 'badge': return emit(content || literal(props.label ?? props.value));
        case 'markdown': return emit(plain(props.content));
        case 'metric': case 'field': return emit('\n\n' + literal(props.label) + ': ' + (content || literal(props.value)) + '\n\n');
        case 'progress': return emit('\n\n' + literal(props.label) + ': ' + literal(props.value) + '/' + literal(props.max ?? 100) + '\n\n');
        case 'separator': return emit('\n\n---\n\n');
        case 'table': {
          if (!Array.isArray(props.columns) || !props.columns.every((c) => typeof c === 'string')) {
            throw new Error('Unsupported table columns');
          }
          return emit('\n\n' + (props.title ? literal(props.title) + '\n\n' : '') +
            table(props.data, props.columns.map((key) => ({ key, label: key }))) + '\n\n');
        }
        case 'bar-chart': case 'line-chart': case 'area-chart': case 'pie-chart':
          return emit('\n\n' + table(props.data, [
            { key: plain(props.labelField ?? props.nameField ?? (type === 'pie-chart' ? 'name' : 'label')), label: plain(props.xLabel ?? 'Label') },
            { key: plain(props.valueField ?? 'value'), label: plain(props.yLabel ?? 'Value') },
          ]) + '\n\n');
        default: unsupported.add(type || '(missing type)'); return null;
      }
    },
  }, unsupported);
  if (unsupported.size) throw new Error('Unsupported template components: ' + [...unsupported].join(', '));
  const result = parts.join('').replace(/\n{3,}/g, '\n\n').trim();
  if (!result) throw new Error('Template produced no readable snapshot');
  return result;
}

function validateScope(org: string, ids: number[]) {
  if (!org || !ids.length || ids.length > MAX_BATCH ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new Error('An explicit organization and 1–100 unique positive event IDs are required');
  }
}
async function readEvent(sql: DbClient, org: string, id: number): Promise<StoredEvent> {
  const [row] = await sql`
    SELECT to_jsonb(e) - 'search_tsv' AS event FROM events e
    WHERE id = ${id} AND organization_id = ${org}
  `;
  if (!row) throw new Error('Event not found in the selected organization: ' + id);
  return row.event;
}
async function previewOne(sql: DbClient, org: string, id: number): Promise<Entry> {
  const event = await readEvent(sql, org, id);
  // Bypass the serving cache: a migration must compare current DB definitions.
  const kind = await resolveEventKindDefinition(event.semantic_type, org, event.entity_ids ?? [], sql);
  const [delivery] = await sql`
    WITH RECURSIVE ancestry AS (
      SELECT id, supersedes_event_id, metadata, 0 AS depth FROM events
      WHERE id = ${id} AND organization_id = ${org}
      UNION ALL
      SELECT e.id, e.supersedes_event_id, e.metadata, a.depth + 1
      FROM events e JOIN ancestry a ON e.id = a.supersedes_event_id
      WHERE e.organization_id = ${org} AND a.depth < 100
    )
    SELECT EXISTS (
      SELECT 1 FROM ancestry a WHERE a.metadata ? 'delivery' OR a.metadata ? 'card'
        OR (a.depth = 100 AND a.supersedes_event_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM notification_targets t WHERE t.event_id = a.id)
    ) AS requires_review
  `;
  return buildEventPresentationEntry(event, kind, delivery.requires_review);
}
function buildEventPresentationEntry(event: StoredEvent, kind: EventKindDefinition | null, hasDelivery: boolean): Entry {
  const id = event.id;
  const fingerprint = createHash('sha256').update(stableJson({ event: { ...event, superseded_by: null }, kind })).digest('hex');
  const entry = { sourceEventId: id, fingerprint };
  if (event.superseded_by != null) return { ...entry, status: 'historical', reason: 'Convert the current version; retain this audit row' };
  if (event.payload_type !== 'json_template' && !event.payload_template &&
    (event.payload_type !== 'empty' || !kind?.jsonTemplate)) {
    return { ...entry, status: 'unchanged' };
  }
  if (event.interaction_type !== 'none' || event.interaction_status != null ||
    event.metadata.notification_type || kind?.interactions && Object.keys(kind.interactions).length) {
    return { ...entry, status: 'blocked', reason: 'Native or custom interaction requires separate review' };
  }
  if (hasDelivery || Object.hasOwn(event.metadata, 'delivery') || Object.hasOwn(event.metadata, 'card')) return { ...entry, status: 'blocked', reason: 'Delivered message requires an exact delivery manifest' };
  if (!event.origin_id || !event.occurred_at || event.metadata[MARKER]) {
    return { ...entry, status: 'blocked', reason: 'Missing source identity/time or existing conversion marker' };
  }
  try {
    const template = event.payload_template ?? (kind?.jsonTemplate ? { root: kind.jsonTemplate } : null);
    const data = event.payload_template ? event.payload_data : resolveEventKindData(event.payload_data, event.metadata);
    const snapshot = template ? snapshotTemplate(template, data) : '```json\n' + JSON.stringify(data, null, 2) + '\n```';
    const markdown = [event.payload_text, snapshot].filter(Boolean).join('\n\n');
    if (Buffer.byteLength(markdown) > MAX_OUTPUT) throw new Error('Snapshot exceeds conversion limits');
    return { ...entry, status: 'ready', markdown };
  } catch (error) {
    return { ...entry, status: 'blocked', reason: error instanceof Error ? error.message : String(error) };
  }
}
export async function previewEventPresentation(sql: DbClient, organizationId: string, ids: number[]): Promise<Manifest> {
  validateScope(organizationId, ids);
  const entries: Entry[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) entries.push(await previewOne(sql, organizationId, id));
  return { version: 1, organizationId, entries };
}

const PRESERVED_FIELDS = {
  title: 'title', attachments: 'attachments', authorName: 'author_name', sourceUrl: 'source_url',
  occurredAt: 'occurred_at', originType: 'origin_type', score: 'score',
  connectorKey: 'connector_key', connectionId: 'connection_id', feedKey: 'feed_key', feedId: 'feed_id',
  runId: 'run_id', automationId: 'automation_id', automationVersionId: 'automation_version_id',
  parentOriginId: 'origin_parent_id', createdBy: 'created_by', clientId: 'client_id',
  interactionType: 'interaction_type', interactionStatus: 'interaction_status',
  interactionInputSchema: 'interaction_input_schema', interactionInput: 'interaction_input',
  interactionOutput: 'interaction_output', interactionError: 'interaction_error',
};
const CHANGED_FIELDS = new Set(['id', 'supersedes_event_id', 'superseded_by',
  'payload_type', 'payload_text', 'payload_template', 'content_length', 'metadata']);

export async function applyEventPresentation(sql: DbClient, manifest: Manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error('Unsupported manifest');
  validateScope(manifest.organizationId, manifest.entries.map((e) => e.sourceEventId));
  if (manifest.entries.some((e) => e.status === 'blocked')) throw new Error('Manifest contains blocked events');
  return sql.begin(async (tx) => {
    const results: Array<{ sourceEventId: number; eventId: number; status: 'converted' | 'already_converted' }> = [];
    for (const entry of [...manifest.entries].sort((a, b) => a.sourceEventId - b.sourceEventId)) {
      if (entry.status !== 'ready') continue;
      const id = entry.sourceEventId;
      // One row lock, shared with concurrent superseding writers through their
      // predecessor update; the unique successor constraint remains authoritative.
      await tx`SELECT id FROM events WHERE id = ${id} AND organization_id = ${manifest.organizationId} FOR UPDATE`;
      const source = await readEvent(tx, manifest.organizationId, id);
      if (source.superseded_by != null) {
        const next = await readEvent(tx, manifest.organizationId, source.superseded_by);
        const marker = next.metadata[MARKER] as Record<string, unknown> | undefined;
        if (marker?.source_event_id === id && marker?.fingerprint === entry.fingerprint &&
          next.payload_type === 'markdown' && next.payload_text === entry.markdown && !next.payload_template) {
          results.push({ sourceEventId: id, eventId: next.id, status: 'already_converted' });
          continue;
        }
        throw new Error('Source event was superseded after preview: ' + id);
      }
      const current = await previewOne(tx, manifest.organizationId, id);
      if (stableJson(current) !== stableJson(entry)) throw new Error('Event or definition changed; preview does not match: ' + id);
      const metadata: Record<string, unknown> = { ...source.metadata, [MARKER]: { version: 1, source_event_id: id, fingerprint: entry.fingerprint, converted_at: new Date().toISOString() } };
      // The key uniquely identifies the original write across ALL versions.
      // Keep it on the immutable original; copying it violates that constraint.
      delete metadata._lobu_idempotency_key;
      const preserved = Object.fromEntries(Object.entries(PRESERVED_FIELDS).map(([param, column]) => [param, source[column]]));
      const inserted = await insertEvent({
        ...preserved,
        organizationId: manifest.organizationId, entityIds: source.entity_ids ?? [],
        originId: source.origin_id!, semanticType: source.semantic_type,
        payloadType: 'markdown', content: entry.markdown, payloadData: source.payload_data,
        payloadTemplate: null, metadata, supersedesEventId: id,
      } as InsertEventParams, { sql: tx, trustedIdentityScopeProjections: true, notifyContentChange: false });
      // This uncommitted version changes presentation, not business arrival.
      // Preserve the original arrival axis before commit so scheduled windows
      // cannot rediscover old data. The marker records the actual conversion time.
      // Copy in SQL: JS timestamp serialization loses Postgres microseconds.
      await tx`UPDATE events SET (created_at, occurred_at) = (
          SELECT created_at, occurred_at FROM events
          WHERE id = ${id} AND organization_id = ${manifest.organizationId}
        )
        WHERE id = ${inserted.id} AND organization_id = ${manifest.organizationId}
          AND supersedes_event_id = ${id}`;
      const successor = await readEvent(tx, manifest.organizationId, Number(inserted.id));
      if (successor.payload_type !== 'markdown' || successor.payload_text !== entry.markdown || successor.payload_template) {
        throw new Error('Conversion would change reviewed presentation');
      }
      // Fail closed if the normal write funnel sanitizes or enriches content, or
      // a newly added field is not copied. Never bypass ingestion protections.
      for (const key of Object.keys(source)) {
        // Empty legacy projections used NULL; the write funnel emits [].
        // Compare this access set by membership, while every other field stays exact.
        const value = (row: StoredEvent) => key === 'linked_org_ids'
          ? [...((row[key] as string[] | null) ?? [])].sort() : row[key];
        if (!CHANGED_FIELDS.has(key) && stableJson(value(source)) !== stableJson(value(successor))) {
          throw new Error('Conversion would change preserved field: ' + key);
        }
      }
      if (stableJson(successor.metadata) !== stableJson(metadata)) throw new Error('Conversion would change preserved metadata');
      results.push({ sourceEventId: id, eventId: successor.id, status: 'converted' });
    }
    return results;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    org: { type: 'string' }, ids: { type: 'string' }, out: { type: 'string' }, apply: { type: 'string' },
  } });
  const sql = getDb();
  try {
    if (!values.org) throw new Error('--org is required');
    if (values.apply) {
      if (values.ids || values.out) throw new Error('--apply cannot be combined with --ids or --out');
      const manifest = JSON.parse(await readFile(values.apply, 'utf8')) as Manifest;
      if (manifest.organizationId !== values.org) throw new Error('Manifest organization does not match --org');
      console.log(JSON.stringify(await applyEventPresentation(sql, manifest), null, 2));
    } else {
      if (!values.ids || !values.out) throw new Error('Preview requires --ids and --out');
      const manifest = await previewEventPresentation(sql, values.org, values.ids.split(',').map(Number));
      await writeFile(values.out, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify(manifest.entries.map(({ sourceEventId, status, reason }) => ({ sourceEventId, status, reason })), null, 2));
    }
  } finally { await sql.end?.(); }
}
