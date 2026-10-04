/**
 * Event Semantic Type Validation
 *
 * Validates event semantic types and metadata against the producer's event_kinds schema.
 * Two entry points:
 *  - validateSaveContentSemanticType: for user/automation content (resolves $member.event_kinds)
 *  - validateConnectorEventSemanticType: for connector content (resolves feeds_schema eventKinds)
 *
 * Returns human-readable errors with valid kinds, expected schema, and fuzzy suggestions.
 */

import { parseEntityRef } from '@lobu/core/contracts/entity-ref';
import { getDb } from '../db/client';
import { formatAjvError, getAjv } from './ajv-singleton';
import { exceedsValidationLimits, isEmptyObject } from './metadata-limits';
import { resolvePlatformNotificationKind } from './platform-notification-kinds';
import { TtlCache } from './ttl-cache';
import type { TemplateInteractionRegistry } from '@lobu/core/json-template';

// ============================================
// Types
// ============================================

interface KindValidationResult {
  valid: boolean;
  errors: string[];
  validKinds: string[];
  expectedSchema: Record<string, unknown> | null;
  suggestion: string | null;
}

export interface EventKindDefinition {
  description?: string;
  metadataSchema?: Record<string, unknown>;
  /**
   * Optional authored render template (render-DSL root node) for events of this
   * kind. When absent, rendering falls back to a default synthesized from
   * `metadataSchema` — mirroring the entity resolution tail.
   */
  jsonTemplate?: Record<string, unknown>;
  /** Template action name -> append-only event kind. */
  interactions?: TemplateInteractionRegistry;
}

// ============================================
// Fuzzy Match
// ============================================

/** Levenshtein distance for fuzzy kind matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Find the closest kind from a list, returns null if none are close enough. */
function findClosestKind(kind: string, validKinds: string[]): string | null {
  if (validKinds.length === 0) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const vk of validKinds) {
    const dist = levenshtein(kind.toLowerCase(), vk.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = vk;
    }
  }
  // Only suggest if within ~40% of the shorter string's length
  const threshold = Math.max(2, Math.ceil(Math.min(kind.length, (best ?? '').length) * 0.4));
  return bestDist <= threshold ? best : null;
}

// ============================================
// Event Kinds Cache (TTL-based)
// ============================================

const CACHE_TTL_MS = 60_000; // 60 seconds

// Per-pod cache. A cached `null` means "no event_kinds defined, accept any kind"
// and is a real value, distinct from a cache miss.
const eventKindsCache = new TtlCache<Record<string, EventKindDefinition> | null>(CACHE_TTL_MS);

// ============================================
// Event Kinds Resolution
// ============================================

/**
 * Overwrite this pod's cached $member event_kinds for an org with a
 * DB-authoritative value. ensureMemberEntityType calls this on EVERY invocation
 * with the event_kinds it just read/wrote, so a later validation in the same
 * request (and the 60s TTL window after) resolves against current DB truth — not
 * a stale copy. This closes a cross-replica gap: if another replica performed the
 * `guidance` backfill, this pod would otherwise take ensureMemberEntityType's
 * no-op path and keep serving a pre-guidance cache, rejecting guidance saves for
 * up to the TTL. `null` means "no $member registry" (accept-any), matching the
 * loader's own null semantics.
 */
export function primeMemberEventKinds(
  orgId: string,
  kinds: Record<string, EventKindDefinition> | null
): void {
  eventKindsCache.set(`${orgId}:$member`, kinds);
}

async function loadMemberEventKinds(
  orgId: string
): Promise<Record<string, EventKindDefinition> | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT event_kinds
    FROM entity_types
    WHERE slug = '$member'
      AND organization_id = ${orgId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (rows.length > 0) {
    const eventKinds = rows[0].event_kinds;
    if (eventKinds && typeof eventKinds === 'object') {
      return eventKinds as Record<string, EventKindDefinition>;
    }
  }
  return null;
}

/**
 * Fetch event_kinds for the $member entity type in a given org.
 * Returns null if no $member type or no event_kinds defined (accept any kind).
 */
async function getMemberEventKinds(
  orgId: string
): Promise<Record<string, EventKindDefinition> | null> {
  return eventKindsCache.getOrSet(`${orgId}:$member`, () => loadMemberEventKinds(orgId));
}

/**
 * Re-read an org's $member event_kinds from the DB and overwrite this pod's
 * cached copy. For writes that must validate against committed registry state
 * (a kind registered on another replica, or seconds ago on this one) rather
 * than a copy up to the TTL old.
 */
export async function refreshMemberEventKinds(orgId: string): Promise<void> {
  primeMemberEventKinds(orgId, await loadMemberEventKinds(orgId));
}

/**
 * Fetch event_kinds for the entity type of a given entity.
 * Returns null if entity not found or entity type has no custom event_kinds.
 */
async function getEntityTypeEventKinds(
  orgId: string,
  entityId: number
): Promise<Record<string, EventKindDefinition> | null> {
  return eventKindsCache.getOrSet(`${orgId}:entity:${entityId}`, async () => {
    const sql = getDb();
    const rows = await sql`
      SELECT et.event_kinds
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${entityId}
        AND e.organization_id = ${orgId}
        AND e.deleted_at IS NULL
        AND et.deleted_at IS NULL
      LIMIT 1
    `;
    if (rows.length > 0) {
      const eventKinds = rows[0].event_kinds;
      if (eventKinds && typeof eventKinds === 'object') {
        return eventKinds as Record<string, EventKindDefinition>;
      }
    }
    return null;
  });
}

/** Distinct entity-type slugs named by `<type>:<key>` refs, in order. */
export function refTypeSlugs(entityRefs: readonly string[] | null | undefined): string[] {
  const slugs = new Set<string>();
  for (const ref of entityRefs ?? []) {
    const parsed = parseEntityRef(ref);
    if (parsed) slugs.add(parsed.type);
  }
  return [...slugs];
}

/** event_kinds of an org-owned entity type by slug (a remote record's type). */
async function getEntityTypeSlugEventKinds(
  orgId: string,
  typeSlug: string
): Promise<Record<string, EventKindDefinition> | null> {
  return eventKindsCache.getOrSet(`${orgId}:type:${typeSlug}`, async () => {
    const sql = getDb();
    const rows = await sql`
      SELECT event_kinds
      FROM entity_types
      WHERE organization_id = ${orgId}
        AND slug = ${typeSlug}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    const eventKinds = rows[0]?.event_kinds;
    return eventKinds && typeof eventKinds === 'object'
      ? (eventKinds as Record<string, EventKindDefinition>)
      : null;
  });
}

/**
 * Fetch event_kinds from connector_definitions for a specific feed.
 * Returns null if connector or feed not found, or eventKinds not defined.
 */
async function getConnectorEventKinds(
  connectorKey: string,
  feedKey: string,
  orgId: string
): Promise<Record<string, EventKindDefinition> | null> {
  return eventKindsCache.getOrSet(`${orgId}:${connectorKey}:${feedKey}`, async () => {
    const sql = getDb();
    const rows = await sql`
      SELECT feeds_schema
      FROM connector_definitions
      WHERE key = ${connectorKey}
        AND organization_id = ${orgId}
      LIMIT 1
    `;
    if (rows.length > 0) {
      const feedsSchema = rows[0].feeds_schema as Record<string, any> | null;
      if (feedsSchema) {
        const feedDef = feedsSchema[feedKey];
        if (feedDef?.eventKinds) {
          return feedDef.eventKinds as Record<string, EventKindDefinition>;
        }
      }
    }
    return null;
  });
}

// ============================================
// Validation Functions
// ============================================

function validateKindAgainstDefinitions(
  kind: string,
  metadata: Record<string, unknown> | undefined | null,
  eventKinds: Record<string, EventKindDefinition> | null
): KindValidationResult {
  // If no event_kinds defined, accept any kind (permissive mode)
  if (!eventKinds) {
    return { valid: true, errors: [], validKinds: [], expectedSchema: null, suggestion: null };
  }

  const validKinds = Object.keys(eventKinds);
  const kindDef = eventKinds[kind];

  // Kind not found
  if (!kindDef) {
    const suggestion = findClosestKind(kind, validKinds);
    const errors = [
      `Invalid kind '${kind}'. Valid kinds: ${validKinds.join(', ')}.`,
      ...(suggestion ? [`Did you mean '${suggestion}'?`] : []),
    ];
    return { valid: false, errors, validKinds, expectedSchema: null, suggestion };
  }

  // Kind found — validate metadata against its schema if defined. Allocation-
  // free emptiness check so a huge untrusted object isn't materialized via
  // Object.keys before the size guard below runs.
  const metadataSchema = kindDef.metadataSchema;
  if (!metadataSchema || !metadata || isEmptyObject(metadata)) {
    return {
      valid: true,
      errors: [],
      validKinds,
      expectedSchema: metadataSchema ?? null,
      suggestion: null,
    };
  }

  // Bound untrusted input before handing it to AJV. Pathologically deep/large
  // metadata is a DoS vector regardless of AJV config, so reject it as a
  // normal validation failure rather than spending CPU/memory validating it.
  if (exceedsValidationLimits(metadata)) {
    return {
      valid: false,
      errors: [
        `Metadata validation failed for kind '${kind}': metadata exceeds size/nesting limits`,
      ],
      validKinds,
      expectedSchema: metadataSchema,
      suggestion: null,
    };
  }

  const ajv = getAjv();
  const validate = ajv.compile(metadataSchema);
  const isValid = validate(metadata);

  if (isValid) {
    return {
      valid: true,
      errors: [],
      validKinds,
      expectedSchema: metadataSchema,
      suggestion: null,
    };
  }

  const errors = [
    `Metadata validation failed for kind '${kind}':`,
    ...(validate.errors ?? []).map((e) => `  - ${formatAjvError(e)}`),
    `Expected: ${JSON.stringify(metadataSchema)}`,
  ];
  return { valid: false, errors, validKinds, expectedSchema: metadataSchema, suggestion: null };
}

/**
 * Validate kind + metadata for user/automation content.
 * Resolves against the org's $member.event_kinds and every linked entity
 * type's event_kinds when entityIds are provided.
 */
export async function validateSaveContentSemanticType(
  semanticType: string,
  metadata: Record<string, unknown> | undefined | null,
  orgId: string,
  entityIds?: number[],
  /** Types of the remote records the event points at by ref. */
  refTypeSlugs?: string[]
): Promise<KindValidationResult> {
  const memberKinds = await getMemberEventKinds(orgId);

  for (const typeSlug of refTypeSlugs ?? []) {
    const typeKinds = await getEntityTypeSlugEventKinds(orgId, typeSlug);
    if (!typeKinds) continue;
    const result = validateKindAgainstDefinitions(semanticType, metadata, typeKinds);
    if (result.valid) return result;
  }

  // An event can be linked to several entity types. Accept a custom kind when
  // any linked type declares it; array order must not change authorability.
  if (entityIds && entityIds.length > 0) {
    for (const entityId of entityIds) {
      const entityTypeKinds = await getEntityTypeEventKinds(orgId, entityId);
      if (!entityTypeKinds) continue;
      // Try entity type kinds first (more specific)
      const entityResult = validateKindAgainstDefinitions(semanticType, metadata, entityTypeKinds);
      if (entityResult.valid) return entityResult;
    }
  }

  return validateKindAgainstDefinitions(semanticType, metadata, memberKinds);
}

/**
 * Resolve the single event-kind definition that governs an event, for
 * rendering. Resolution order mirrors validateSaveContentSemanticType:
 * linked entity-type event_kinds (most specific) first, then the org-wide $member
 * event_kinds. Returns null when no definition declares this kind (the caller
 * then has no schema to render from). Reuses the same per-pod TTL cache.
 */
export async function resolveEventKindDefinition(
  semanticType: string,
  orgId: string,
  entityIds?: number[],
  /** `events.entity_refs`: kinds declared by the remote records' types. */
  entityRefs?: readonly string[] | null
): Promise<EventKindDefinition | null> {
  if (entityIds && entityIds.length > 0) {
    for (const entityId of entityIds) {
      const entityTypeKinds = await getEntityTypeEventKinds(orgId, entityId);
      const entityDef = entityTypeKinds?.[semanticType];
      if (entityDef) return entityDef;
    }
  }
  for (const typeSlug of refTypeSlugs(entityRefs)) {
    const typeDef = (await getEntityTypeSlugEventKinds(orgId, typeSlug))?.[semanticType];
    if (typeDef) return typeDef;
  }
  const memberKinds = await getMemberEventKinds(orgId);
  // Platform kinds are the LAST resort, so an org that declares the same slug
  // keeps ownership of how it renders.
  return memberKinds?.[semanticType] ?? resolvePlatformNotificationKind(semanticType);
}

/**
 * Validate kind + metadata for connector-sourced content.
 * Resolves against connector_definitions.feeds_schema[feedKey].eventKinds.
 */
export async function validateConnectorEventSemanticType(
  semanticType: string,
  metadata: Record<string, unknown> | undefined | null,
  connectorKey: string,
  feedKey: string,
  orgId: string
): Promise<KindValidationResult> {
  const eventKinds = await getConnectorEventKinds(connectorKey, feedKey, orgId);
  return validateKindAgainstDefinitions(semanticType, metadata, eventKinds);
}
