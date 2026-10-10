/**
 * NER-Lite Auto-Linker
 *
 * Scans event content for entity name mentions and creates
 * `mentions` relationships automatically. Fire-and-forget pattern.
 */

import { getDb } from '../db/client';
import { ensureRelationshipType, upsertEdges } from './edge-writes';
import logger from './logger';
import { MANUAL_RELATIONSHIP_CLAIM_KEY } from './relationship-claims';

interface AutoLinkParams {
  eventId: number;
  entityIds: number[];
  content: string;
  title?: string | null;
  organizationId: string;
}

interface EntityCandidate {
  id: number;
  name: string;
  entity_type: string;
}

// Per-process cache (60s TTL); concurrent events in the same org share a fetch.
// This only reduces duplicate reads; correctness does not require a shared cache.
const entityCache = new Map<string, { entities: EntityCandidate[]; ts: number }>();
const inflightFetches = new Map<string, Promise<EntityCandidate[]>>();
const CACHE_TTL_MS = 60_000;
const MAX_CONTENT_LENGTH = 5_000;
const MAX_AUTO_LINKS = 20;
const MIN_NAME_LENGTH = 3;

async function getOrgEntities(organizationId: string): Promise<EntityCandidate[]> {
  const cached = entityCache.get(organizationId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.entities;
  const inflight = inflightFetches.get(organizationId);
  if (inflight) return inflight;

  const sql = getDb();
  const fetch = (async () => {
    try {
      const rows = await sql`
        SELECT e.id, e.name, length(e.name) AS name_length, et.slug AS entity_type
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.organization_id = ${organizationId}
          AND e.deleted_at IS NULL
          AND length(e.name) >= ${MIN_NAME_LENGTH}
      `;

      // Sort once per refresh using PostgreSQL's character count, not UTF-16 units.
      rows.sort((a, b) => Number(b.name_length) - Number(a.name_length) || Number(a.id) - Number(b.id));
      const entities = rows.map((r) => ({
        id: Number(r.id),
        name: r.name as string,
        entity_type: r.entity_type as string,
      }));

      entityCache.set(organizationId, { entities, ts: Date.now() });
      return entities;
    } finally {
      inflightFetches.delete(organizationId);
    }
  })();
  inflightFetches.set(organizationId, fetch);
  return fetch;
}

function ensureMentionsType(organizationId: string): Promise<number> {
  return ensureRelationshipType({
    organizationId,
    slug: 'mentions',
    name: 'Mentions',
    description: 'Auto-discovered content reference',
  });
}

/**
 * Scan content for entity name mentions and create relationships.
 */
export async function autoLinkEvent(params: AutoLinkParams): Promise<void> {
  const { entityIds, content, title, organizationId } = params;
  if (!content && !title) return;

  const allEntities = await getOrgEntities(organizationId);
  const sourceSet = new Set(entityIds);

  // Combine title + content, cap length
  const searchText = [title, content].filter(Boolean).join(' ').slice(0, MAX_CONTENT_LENGTH);

  const matched = new Set<number>();
  const candidates: { fromId: number; toId: number }[] = [];

  for (const entity of allEntities) {
    if (sourceSet.has(entity.id) || matched.has(entity.id)) continue;

    const escaped = entity.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');

    if (regex.test(searchText)) {
      matched.add(entity.id);
      for (const sourceId of entityIds) {
        if (sourceId === entity.id) continue;
        candidates.push({ fromId: sourceId, toId: entity.id });
        if (candidates.length >= MAX_AUTO_LINKS) break;
      }
      if (candidates.length >= MAX_AUTO_LINKS) break;
    }
  }

  if (candidates.length === 0) return;

  const typeId = await ensureMentionsType(organizationId);

  // `mentions` is directional, so an existing edge only blocks the same
  // direction — which is exactly what the live-triple unique index keys on.
  const createdIds = await upsertEdges({
    db: getDb(),
    organizationId,
    relationshipTypeId: typeId,
    pairs: candidates.map(({ fromId, toId }) => ({
      fromEntityId: fromId,
      toEntityId: toId,
    })),
    source: 'feed',
    confidence: 0.4,
    // Inferred from event text, not asserted by a durable source item, so there
    // is nothing to reconcile against on a resync. The manual claim is what
    // keeps a wrong guess user-correctable through `manage_entity` unlink.
    claimKey: MANUAL_RELATIONSHIP_CLAIM_KEY,
    onConflict: 'ignore',
  });
  const created = createdIds.length;

  if (created > 0) {
    logger.debug(
      { created, eventId: params.eventId, matched: matched.size },
      '[auto-linker] Links created'
    );
  }
}
