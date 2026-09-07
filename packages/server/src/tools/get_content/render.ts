/**
 * Tool: read_knowledge — turning raw query rows into the canonical
 * ContentItem shape (excerpt highlighting, client/parent-context resolution,
 * row mapping).
 */

import type { ContentItem } from '@lobu/connector-sdk';
import { parseJsonObject } from '@lobu/core';
import { type DbClient, parsePgNumberArray, pgBigintArray, pgTextArray } from '../../db/client';
import {
  type ArtifactStore,
  eventArtifactBinding,
} from '../../gateway/files/artifact-store';
import { resolveEntityRender } from '../../utils/default-entity-template';
import { resolveEventKindDefinition } from '../../utils/event-kind-validation';
import logger from '../../utils/logger';
import { buildResourcePermalink } from '../../utils/url-builder';
import { AUDIT_SEMANTIC_TYPE } from '../constants';
import type { ContentRow } from './types';
import { parseRecordArray, toNumberOrUndefined } from './types';

/**
 * True when `url` is this deployment's own download link for `artifactId`.
 * Path-suffix match, so it holds across the gateway's base-path mounts
 * (`/lobu/api/v1/files/...`) without depending on the configured origin.
 */
function isOwnArtifactUrl(url: string, artifactId: string): boolean {
  try {
    return new URL(url).pathname.endsWith(
      `/api/v1/files/${encodeURIComponent(artifactId)}`
    );
  } catch {
    return false;
  }
}

/**
 * Persisted attachment `download_url`s carry an expiring token, so a row read
 * back after the TTL hands out a dead link. Re-mint each one against the
 * event's own binding.
 *
 * Deliberately no filesystem access: `buildDownloadUrl` only encrypts
 * `{artifactId, exp, binding}` with the app key, and the download route
 * verifies the binding against stored metadata when the bytes are actually
 * requested. Verifying here instead would put an lstat + metadata read + JSON
 * parse on every attachment of every listing page — per-row I/O on a
 * user-facing read path, for an answer the download route has to recompute
 * anyway.
 */
export function refreshEventArtifactDownloadUrls(opts: {
  items: ContentItem[];
  organizationId: string;
  publicGatewayUrl: string;
  artifactStore: Pick<ArtifactStore, 'buildDownloadUrl'>;
}): void {
  for (const item of opts.items) {
    if (!Array.isArray(item.attachments) || !item.origin_id) continue;
    const binding = eventArtifactBinding({
      organizationId: opts.organizationId,
      connectionId: item.connection_id,
      feedId: item.feed_id,
      originId: item.origin_id,
    });
    item.attachments = item.attachments.map((attachment) => {
      const artifactId = attachment.artifact_id;
      // Only re-sign a URL this gateway minted for this exact artifact.
      // `attachments` is free-form on the save_content path, so an agent can
      // put anything here; a connector-supplied external link must survive
      // untouched rather than be replaced by a Lobu URL.
      if (
        typeof artifactId !== 'string' ||
        typeof attachment.download_url !== 'string' ||
        !isOwnArtifactUrl(attachment.download_url, artifactId)
      ) {
        return attachment;
      }
      return {
        ...attachment,
        download_url: opts.artifactStore.buildDownloadUrl(
          opts.publicGatewayUrl,
          artifactId,
          undefined,
          binding
        ),
      };
    });
  }
}

/**
 * Gated payload keys: the request itself and its size. `request_status` is
 * deliberately NOT here — it names a retention outcome
 * (`complete`/`too_large`/`unavailable`) rather than any part of the call, and
 * a list row must keep it so the UI can tell that a body exists to open. With
 * it stripped, the only affordance for reading a request was a hand-written
 * URL: nothing in the app could know which rows had one.
 */
const AUDIT_REQUEST_KEYS = ['request', 'request_bytes'] as const;

/**
 * A tool-invocation audit row retains the caller's VERBATIM request (see
 * `recordToolInvocationAudit`), which only its author may read. Content rows
 * arrive with those keys still on `payload_data`, so this strips them from
 * EVERY audit item first — list/search results never inline them, and any
 * caller other than the author leaves them stripped.
 * Explicit event-id reads put them back only on rows whose `created_by` clears
 * the gate. Authorship is the one thing the content row does not carry, so it
 * is the only thing re-read here; a failed re-read rejects rather than serving
 * a half-gated page.
 *
 * The strip index maps an id to a LIST of entries, not one. Exact reads normally
 * collapse an explicitly linked supersede lineage to one copy of each row, but
 * hydration is a security boundary and must restore every parsed copy if a
 * caller supplies duplicates. Keying one entry per id would restore only the
 * last copy and leave the rest stripped.
 */
export async function hydrateToolInvocationRequests(opts: {
  sql: DbClient;
  items: ContentItem[];
  userId: string | null;
  restoreRequests: boolean;
}): Promise<void> {
  const { sql, items, userId, restoreRequests } = opts;
  const stripped = new Map<
    number,
    Array<{ payload: Record<string, unknown>; fields: Record<string, unknown> }>
  >();

  for (const item of items) {
    if (item.semantic_type !== AUDIT_SEMANTIC_TYPE || item.origin_type !== 'tool_invocation')
      continue;
    const payload = item.payload_data as Record<string, unknown> | null | undefined;
    if (!payload) continue;
    const fields: Record<string, unknown> = {};
    for (const key of AUDIT_REQUEST_KEYS) {
      if (payload[key] === undefined) continue;
      fields[key] = payload[key];
      delete payload[key];
    }
    if (Object.keys(fields).length === 0) continue;
    const id = Number(item.id);
    const entries = stripped.get(id) ?? [];
    entries.push({ payload, fields });
    stripped.set(id, entries);
  }

  if (!restoreRequests || stripped.size === 0 || userId == null) return;

  const rows = await sql<{ id: number }>`
    SELECT id
    FROM events
    WHERE created_by = ${userId}
      AND id = ANY(${pgBigintArray([...stripped.keys()])}::bigint[])
      AND semantic_type = ${AUDIT_SEMANTIC_TYPE}
      AND origin_type = 'tool_invocation'
  `;

  for (const row of rows) {
    const entries = stripped.get(Number(row.id));
    if (!entries) continue;
    for (const entry of entries) Object.assign(entry.payload, entry.fields);
  }
}

/**
 * Fetch excerpts for evidence highlighting when filtering by a single
 * classification value.
 */
export async function fetchClassificationExcerpts(
  sql: DbClient,
  classificationFilters: Array<{ classifier_slug: string; value: string }> | undefined,
  rawContent: ContentRow[]
): Promise<Map<number, string>> {
  const excerptsMap = new Map<number, string>();
  if (classificationFilters?.length === 1 && rawContent.length > 0) {
    const { classifier_slug: classifierSlug, value: filterValue } = classificationFilters[0];
    const contentIds = rawContent.map((f) => f.id);
    const contentIdPlaceholders = contentIds.map((_, i) => `$${i + 3}`).join(',');
    const excerptsResult = await sql.unsafe(
      `
      SELECT
        cc.event_id,
        cc.excerpts::jsonb->>$1 as excerpt
      FROM event_classifications cc
      JOIN classify_facet cl ON cc.classifier_id = cl.id
      WHERE cc.event_id IN (${contentIdPlaceholders})
        AND cl.slug = $2
        AND $1 = ANY(cc."values")
        AND cc.excerpts::jsonb ? $1
    `,
      [filterValue, classifierSlug, ...contentIds]
    );

    for (const row of excerptsResult as unknown as Array<{
      event_id: number;
      excerpt: string;
    }>) {
      if (row.excerpt) {
        excerptsMap.set(Number(row.event_id), row.excerpt);
      }
    }

    logger.debug(
      { classifierSlug, filterValue, excerptCount: excerptsMap.size },
      '[get_content] Fetched excerpts for evidence highlighting'
    );
  }
  return excerptsMap;
}

/**
 * Map raw query rows to the canonical content item shape used across the app,
 * batch-resolving client_name and parent_context first.
 */
export async function buildContentItems(opts: {
  sql: DbClient;
  rawContent: ContentRow[];
  /** NULL only for actor-owned audit rows; never hydrate workspace references. */
  organizationId: string | null;
  ownerSlug: string | null;
  baseUrl: string | undefined;
  excerptsMap: Map<number, string>;
  includePrivateAttribution: boolean;
}): Promise<ContentItem[]> {
  const {
    sql,
    rawContent,
    organizationId,
    ownerSlug,
    baseUrl,
    excerptsMap,
    includePrivateAttribution,
  } = opts;

  // Score and text-search paths intentionally return slimmer rows than exact
  // reads. Hydrate the attribution contract in one bounded query so all three
  // paths render identically. The mapper below strips private identity fields
  // for anonymous reads.
  const idsNeedingAttribution = rawContent
    .filter(
      (f) =>
        !f.client_name ||
        (includePrivateAttribution &&
          (!f.connection_name ||
            !f.agent_id ||
            !f.device_worker_id ||
            !f.client_id))
    )
    .map((f) => f.id);
  const parentExternalIds = rawContent
    .filter(
      (f) => f.origin_parent_id && !rawContent.some((r) => r.origin_id === f.origin_parent_id)
    )
    .map((f) => f.origin_parent_id as string);
  const uniqueParentIds = [...new Set(parentExternalIds)];

  const [attributionRows, parentRows] = await Promise.all([
    organizationId !== null && idsNeedingAttribution.length > 0
      ? sql`
        SELECT
          e.id,
          e.client_id,
          oc.client_name,
          COALESCE(direct_connection.display_name, metadata_connection.display_name)
            AS connection_name,
          COALESCE(
            NULLIF(e.metadata->>'agent_id', ''),
            NULLIF(source_run.approved_input->>'agent_id', '')
          ) AS agent_id,
          ag.name AS agent_name,
          COALESCE(
            NULLIF(e.metadata->>'device_worker_id', ''),
            NULLIF(source_run.approved_input->>'device_worker_id', '')
          ) AS device_worker_id,
          dw.label AS device_label,
          dw.platform AS device_platform
        FROM events e
        LEFT JOIN oauth_clients oc ON oc.id = e.client_id
        LEFT JOIN connections direct_connection
          ON direct_connection.id = e.connection_id
         AND direct_connection.organization_id = e.organization_id
        LEFT JOIN connections metadata_connection
          ON metadata_connection.id = CASE
            WHEN (e.metadata->>'source_connection_id') ~ '^[0-9]{1,18}$'
            THEN (e.metadata->>'source_connection_id')::bigint
          END
         AND metadata_connection.organization_id = e.organization_id
        LEFT JOIN runs source_run
          ON source_run.id = e.run_id
         AND source_run.organization_id = e.organization_id
        LEFT JOIN agents ag
          ON ag.id = COALESCE(
            NULLIF(e.metadata->>'agent_id', ''),
            NULLIF(source_run.approved_input->>'agent_id', '')
          )
         AND ag.organization_id = e.organization_id
        LEFT JOIN device_workers dw
          ON dw.id::text = COALESCE(
            NULLIF(e.metadata->>'device_worker_id', ''),
            NULLIF(source_run.approved_input->>'device_worker_id', '')
          )
         AND dw.organization_id = e.organization_id
        WHERE e.organization_id = ${organizationId}
          AND e.id = ANY(${pgBigintArray(idsNeedingAttribution)}::bigint[])
      `
      : Promise.resolve([] as Array<Record<string, unknown>>),
    organizationId !== null && uniqueParentIds.length > 0
      ? sql`
        SELECT origin_id, author_name, title, payload_text, occurred_at, source_url, score
        FROM current_event_records
        WHERE origin_id = ANY(${pgTextArray(uniqueParentIds)}::text[])
          AND organization_id = ${organizationId}
        LIMIT ${uniqueParentIds.length}
      `
      : Promise.resolve([] as Array<Record<string, unknown>>),
  ]);

  const attributionMap = new Map<number, ContentRow>();
  for (const row of attributionRows) {
    attributionMap.set(Number(row.id), row as unknown as ContentRow);
  }

  const parentContextMap = new Map<string, ContentItem['parent_context']>();
  for (const row of parentRows) {
    const text = String(row.payload_text ?? '');
    parentContextMap.set(String(row.origin_id), {
      author_name: String(row.author_name ?? ''),
      title: row.title ? String(row.title) : null,
      text_content: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      occurred_at: String(row.occurred_at ?? ''),
      source_url: String(row.source_url ?? ''),
      score: Number(row.score) || 0,
    });
  }

  // Map to the canonical content item shape used across the app.
  const contentItems: ContentItem[] = rawContent.map((f) => {
    const metadata = parseJsonObject(f.metadata);
    const classifications = parseJsonObject(f.classifications);
    const attribution = attributionMap.get(Number(f.id));

    return {
      id: f.id,
      entity_ids: parsePgNumberArray(f.entity_ids),
      platform: f.platform,
      origin_id: f.origin_id ?? '',
      semantic_type: f.semantic_type ?? 'content',
      origin_type: f.origin_type ?? null,
      payload_type: f.payload_type ?? 'text',
      payload_text: f.payload_text ?? '',
      payload_truncated: f.payload_truncated === true ? true : undefined,
      content_length:
        f.content_length == null ? undefined : Number(f.content_length),
      payload_data: parseJsonObject(f.payload_data),
      payload_template: f.payload_template ? parseJsonObject(f.payload_template) : null,
      attachments: parseRecordArray(f.attachments),
      attachments_truncated: f.attachments_truncated === true ? true : undefined,
      attachments_bytes:
        f.attachments_bytes == null ? undefined : Number(f.attachments_bytes),
      author_name: f.author_name ?? null,
      client_id: includePrivateAttribution
        ? (f.client_id ?? attribution?.client_id ?? null)
        : null,
      client_name: f.client_name ?? attribution?.client_name ?? null,
      connection_id: f.connection_id == null ? null : Number(f.connection_id),
      connection_name: includePrivateAttribution
        ? (f.connection_name ?? attribution?.connection_name ?? null)
        : null,
      feed_id: f.feed_id == null ? null : Number(f.feed_id),
      feed_key: f.feed_key ?? null,
      feed_name: f.feed_name ?? null,
      automation_id: f.automation_id == null ? null : Number(f.automation_id),
      automation_name: f.automation_name ?? null,
      agent_id: includePrivateAttribution
        ? (f.agent_id ?? attribution?.agent_id ?? null)
        : null,
      agent_name: includePrivateAttribution
        ? (f.agent_name ?? attribution?.agent_name ?? null)
        : null,
      device_worker_id: includePrivateAttribution
        ? (f.device_worker_id ?? attribution?.device_worker_id ?? null)
        : null,
      device_label: includePrivateAttribution
        ? (f.device_label ?? attribution?.device_label ?? null)
        : null,
      device_platform: includePrivateAttribution
        ? (f.device_platform ?? attribution?.device_platform ?? null)
        : null,
      title: f.title,
      text_content: f.payload_text ?? '',
      rating: (metadata.rating as string) || null,
      source_url: f.source_url ?? null,
      score: Number(f.score) || 0,
      metadata,
      classifications,
      created_at: f.created_at,
      occurred_at: f.occurred_at || f.created_at,
      content_date: f.occurred_at || f.created_at,
      excerpt: excerptsMap.get(f.id),
      similarity: toNumberOrUndefined(f.similarity),
      text_rank: toNumberOrUndefined(f.text_rank),
      combined_score: toNumberOrUndefined(f.combined_score),
      score_breakdown: f.score_breakdown as ContentItem['score_breakdown'],
      origin_parent_id: f.origin_parent_id || null,
      root_origin_id: f.root_origin_id || f.origin_id || String(f.id),
      depth: f.depth ?? 0,
      interaction_type: f.interaction_type ?? undefined,
      interaction_status: f.interaction_status ?? undefined,
      interaction_input_schema: f.interaction_input_schema
        ? parseJsonObject(f.interaction_input_schema)
        : undefined,
      interaction_input: f.interaction_input ? parseJsonObject(f.interaction_input) : undefined,
      interaction_output: f.interaction_output
        ? parseJsonObject(f.interaction_output)
        : undefined,
      interaction_error: f.interaction_error ?? undefined,
      supersedes_event_id: f.supersedes_event_id == null ? null : Number(f.supersedes_event_id),
      // `superseded_by` is the denormalized forward edge (the newer row that
      // replaced this one). Its presence is exactly what makes a row the
      // tombstone/stale side of a supersede chain, so `is_superseded` lets a
      // caller reading the full chain (content_ids resolution) tell the live
      // head from the superseded history without re-deriving it.
      superseded_by: f.superseded_by == null ? null : Number(f.superseded_by),
      is_superseded: f.superseded_by != null,
      run_id: f.run_id == null ? null : Number(f.run_id),
      parent_context:
        parentContextMap.get(f.origin_parent_id as string) ??
        (f.parent_context as ContentItem['parent_context']) ??
        null,
      root_context: f.root_context as ContentItem['root_context'],
      permalink: buildResourcePermalink(ownerSlug, { kind: 'event', eventId: f.id }, baseUrl) ?? null,
    };
  });

  // Event rendering resolution tail: a metadata-only event ('empty') with no
  // authored payload_template falls back to a default render synthesized from
  // its event kind — the kind's authored jsonTemplate, else a field card built
  // from the kind's metadataSchema (same generator as entity auto-default). An
  // event with real body content (text/markdown/media) or an explicit template
  // is left untouched. Resolution rides the cached event_kinds registry, so the
  // per-event lookups are cheap and bounded to the metadata-only minority. Kind
  // notifications keep routing metadata separate and bind their payload_data.
  await Promise.all(
    contentItems.map(async (item) => {
      if (organizationId === null || item.payload_template || item.payload_type !== 'empty') return;
      const isNotification = typeof item.metadata?.notification_type === 'string';
      const renderData = isNotification ? (item.payload_data ?? {}) : item.metadata;
      if (!isNotification && (!renderData || Object.keys(renderData).length === 0)) return;
      const kind = await resolveEventKindDefinition(
        item.semantic_type,
        organizationId,
        item.entity_ids
      );
      if (!kind) return;
      const root = resolveEntityRender(kind.jsonTemplate, kind.metadataSchema);
      if (!root) return;
      item.payload_template = {
        root,
        ...(kind.interactions ? { interactions: kind.interactions } : {}),
      };
      item.payload_type = 'json_template';
      item.payload_data = renderData;
    })
  );

  return contentItems;
}
