/**
 * Declarative entity-link resolver at event ingestion.
 *
 * A connector declares `eventKinds[kind].attributions[]` rules. Each attribution
 * maps event identifier fields (phone, email, wa_jid, ...) to a target entity.
 * The ingestion pipeline:
 *   1) Extracts + normalizes identifiers from each event.
 *   2) Looks them up in the normalized `entity_identities` table
 *      (UNIQUE per (org, namespace, identifier, COALESCE(scope_key, ''))
 *       — see EntityIdentitySpec.scope).
 *   3) Links to the matched entity, creates on miss (when autoCreate=true),
 *      logs a merge candidate when one event's identifiers resolve to
 *      multiple distinct entities.
 *   4) Merges declared `traits` onto entities.metadata per merge strategy.
 *
 * Returns entity ids for the new event version; existing events stay immutable.
 * Identity metadata also supports historical read-time attribution.
 */

import { validateEntityRowInsert, validateEntityRowPatch } from '../authz/entity-row-validation';
import { randomBytes } from 'node:crypto';
import {
  ACL_RESOURCE_TYPE_SLUG,
  type EntityIdentitySpec,
  type EntityLinkPredicate,
  type EntityTraitSpec,
  type EventAttributionRule,
} from '@lobu/connector-sdk';
import { normalizeIdentifier } from '@lobu/connector-sdk/identity-normalize';
import { ensureResourceEntityType } from '../authz/acl-resource-type';
import { type DbClient, getDb, pgBigintArray, pgTextArray } from '../db/client';
import { normalizeConnectorIdentityValue } from '../identity/connector-identity-modules';
import {
  IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY,
  ORGANIZATION_SCOPE_PROJECTION,
} from '../identity/scope-projection';
import {
  hardDeleteEntityRows,
  patchEntityRows,
  tryInsertEntityRow,
  withEntityWriteTransaction,
} from './entity-management';
import logger from './logger';
import { getValueAtPath } from './object-path';
import type { ConnectorRelationshipDeclaration } from './relationship-claims';
import { TtlCache } from './ttl-cache';

interface BatchItem {
  origin_type?: string;
  metadata?: Record<string, unknown>;
  title?: string | null;
}

type ResolvedEventAttributionRule = {
  name?: string;
  role: EventAttributionRule['role'];
  entityType: string;
  autoCreate?: boolean;
  createWhen?: EntityLinkPredicate;
  titlePath?: string;
  identities: EntityIdentitySpec[];
  traits?: Record<string, EntityTraitSpec>;
};

interface RuleMap {
  [kind: string]: ResolvedEventAttributionRule[];
}

function ownValue<T>(record: Record<string, unknown>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? (record[key] as T) : undefined;
}

function ownRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = ownValue<unknown>(record, key);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Define hostile-but-valid identity keys such as `__proto__` as data. */
function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Connector payloads may not author the server's tenant-scope projections. */
function scrubIdentityScopeProjections(items: BatchItem[]): void {
  for (const item of items) {
    if (!item.metadata) continue;
    delete item.metadata[IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY];
  }
}

type EventKindAttributionDefinition = {
  attributions?: EventAttributionRule[];
  relationships?: ConnectorRelationshipDeclaration[];
};

interface EventAttributionPlan {
  rulesByKind: RuleMap;
  relationshipsByKind: Record<string, ConnectorRelationshipDeclaration[]>;
}

interface AttributionResolution {
  entityIdsByItem: Map<number, number[]>;
  /** Entity id per attribution `name`, keyed by the caller's item index. */
  namedEntityIdsByItem: Map<number, Map<string, number>>;
  /** Named rules that were applicable but did not resolve for this item. */
  unresolvedNamedAttributionsByItem: Map<number, Set<string>>;
  relationshipsByKind: Record<string, ConnectorRelationshipDeclaration[]>;
}

/**
 * Named rules the item supplied at least one raw identifier for, yet which
 * produced no entity — invalid normalization, an ambiguous merge candidate, an
 * entity that vanished between lookup and lock, or a `createWhen`/`autoCreate`
 * miss. An endpoint the source item never mentioned is a withdrawal instead.
 */
function collectUnresolvedNamedAttributions(
  suppliedNamesByItem: ReadonlyMap<number, ReadonlySet<string>>,
  namedEntityIdsByItem: Map<number, Map<string, number>>
): Map<number, Set<string>> {
  const unresolved = new Map<number, Set<string>>();
  for (const [index, suppliedNames] of suppliedNamesByItem) {
    for (const name of suppliedNames) {
      if (namedEntityIdsByItem.get(index)?.has(name)) continue;
      let unresolvedNames = unresolved.get(index);
      if (!unresolvedNames) {
        unresolvedNames = new Set();
        unresolved.set(index, unresolvedNames);
      }
      unresolvedNames.add(name);
    }
  }
  return unresolved;
}

function resolveEventAttributions(
  def: EventKindAttributionDefinition | undefined
): ResolvedEventAttributionRule[] {
  return (def?.attributions ?? []).flatMap((rule) => {
    const identities = rule.target.identities;
    if (!rule.target.entityType || !Array.isArray(identities) || identities.length === 0) {
      return [];
    }
    return [
      {
        name: rule.name,
        role: rule.role,
        entityType: rule.target.entityType,
        autoCreate: rule.autoCreate,
        createWhen: rule.target.createWhen,
        titlePath: rule.target.titlePath,
        identities: identities.map((identity) => ({
          ...identity,
          namespace: identity.namespace.trim(),
          ...(identity.scopeKeyPath === undefined
            ? {}
            : { scopeKeyPath: identity.scopeKeyPath.trim() }),
        })),
        traits: rule.traits,
      },
    ];
  });
}

const RULES_CACHE_TTL_MS = 60_000;
// Per-pod caches — no cross-replica sharing.
const plansCache = new TtlCache<EventAttributionPlan>(RULES_CACHE_TTL_MS);
const rulesByTypeCache = new TtlCache<RuleMap>(RULES_CACHE_TTL_MS);
const creatorCache = new TtlCache<string | null>(RULES_CACHE_TTL_MS);

/**
 * Takes the caller's handle rather than reaching for `getDb()`, because both
 * call sites run INSIDE `withEntityWriteTransaction`. A pooled query there asks
 * for a second connection while still holding the transaction's own, so
 * `DB_POOL_MAX` concurrent writers deadlock the pool permanently — #2818.
 *
 * A cache hit performs no query at all; racing misses each query through their
 * own caller-owned handle.
 */
async function resolveOrgCreator(sql: DbClient, orgId: string): Promise<string | null> {
  return creatorCache.getOrSet(orgId, async () => {
    const rows = await sql<{ userId: string }>`
      SELECT "userId"
      FROM "member"
      WHERE "organizationId" = ${orgId}
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               "createdAt" ASC
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0].userId : null;
  });
}

function randomSlug(entityType: string): string {
  const prefix =
    entityType
      .replace(/^\$/, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .toLowerCase() || 'entity';
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}

async function loadEventAttributionPlan(
  sql: DbClient,
  params: {
    connectorKey: string;
    feedKey: string;
    orgId: string;
  }
): Promise<EventAttributionPlan> {
  const cacheKey = `${params.orgId}:${params.connectorKey}:${params.feedKey}`;
  return plansCache.getOrSet(cacheKey, async () => {
    const rows = await sql`
      SELECT feeds_schema
      FROM connector_definitions
      WHERE key = ${params.connectorKey}
        AND organization_id = ${params.orgId}
        AND status = 'active'
      LIMIT 1
    `;
    const rulesByKind: RuleMap = {};
    const relationshipsByKind: Record<string, ConnectorRelationshipDeclaration[]> = {};
    const feedsSchema = rows[0]?.feeds_schema as Record<string, any> | null | undefined;
    const feedDef = feedsSchema?.[params.feedKey];
    const eventKinds = feedDef?.eventKinds as
      | Record<string, EventKindAttributionDefinition>
      | undefined;
    if (eventKinds) {
      for (const [kind, def] of Object.entries(eventKinds)) {
        const resolved = resolveEventAttributions(def);
        if (resolved.length > 0) rulesByKind[kind] = resolved;
        if (Array.isArray(def.relationships) && def.relationships.length > 0) {
          relationshipsByKind[kind] = def.relationships;
        }
      }
    }
    return { rulesByKind, relationshipsByKind };
  });
}

/**
 * Load the FIRST attribution rule matching `entityType` (and `role`, when given)
 * declared anywhere in the connector's feeds_schema. The live app-webhook path
 * resolves an actor without a feed context (a delivery names an event, not a
 * feed), and a connector's person attribution is identical across its feeds — so
 * any feed's rule serves.
 *
 * `role` disambiguates when one entity type is targeted by several roles on the
 * same kind (e.g. an X DM attributes `person` both `authored_by` and `about`):
 * pass the role the caller actually wants ('authored_by' for a webhook actor)
 * rather than relying on declaration order.
 */
export async function loadAttributionRuleByType(
  sql: DbClient,
  params: {
    connectorKey: string;
    orgId: string;
    entityType: string;
    role?: EventAttributionRule['role'];
  }
): Promise<ResolvedEventAttributionRule | null> {
  const roleKey = params.role ?? '__any__';
  const cacheKey = `${params.orgId}:${params.connectorKey}:__bytype__:${params.entityType}:${roleKey}`;
  const map = await rulesByTypeCache.getOrSet(cacheKey, async () => {
    const rows = await sql`
      SELECT feeds_schema
      FROM connector_definitions
      WHERE key = ${params.connectorKey}
        AND organization_id = ${params.orgId}
        AND status = 'active'
      LIMIT 1
    `;
    const result: RuleMap = {};
    const feedsSchema = rows[0]?.feeds_schema as Record<string, any> | null | undefined;
    if (feedsSchema) {
      for (const feed of Object.values(feedsSchema)) {
        const eventKinds = (
          feed as {
            eventKinds?: Record<string, EventKindAttributionDefinition>;
          }
        )?.eventKinds;
        if (!eventKinds) continue;
        for (const def of Object.values(eventKinds)) {
          const match = resolveEventAttributions(def).find(
            (r) =>
              r.entityType === params.entityType &&
              (params.role === undefined || r.role === params.role)
          );
          if (match) {
            result[params.entityType] = [match];
            return result;
          }
        }
      }
    }
    return result;
  });
  return map[params.entityType]?.[0] ?? null;
}

export function clearEntityLinkRulesCache(): void {
  plansCache.clear();
  rulesByTypeCache.clear();
  creatorCache.clear();
}

/**
 * A single already-normalized identity ready for lookup/create — the resolved
 * counterpart of the declarative {@link EntityIdentitySpec} (which carries an
 * `eventPath` to extract FROM an event). The store-only sender path hands these
 * in directly, having normalized upstream.
 */
export type ResolvedIdentity = {
  namespace: string;
  identifier: string;
  matchOnly: boolean;
  primary: boolean;
  /**
   * Uniqueness scope, resolved once at extraction from the spec's `scope` and
   * the connector-declared tenant key path. `null` = org-wide.
   *
   * Carried on the identity rather than read from params at each use site so
   * matching and insertion cannot disagree: `lookupMatches` and
   * `insertIdentities` both key on this value, and a rule that scopes one of
   * its namespaces but not another produces a mixed array here.
   *
   * OPTIONAL, and `undefined` is treated exactly as `null`. Callers outside the
   * attribution path (`resolveSenderIdentity`, tests) hand-build identities and
   * legitimately mean org scope; requiring the field would break them without
   * the compiler noticing, because the server tsconfig excludes `__tests__`.
   * Omission is safe in the only direction that matters: it can never
   * accidentally CLAIM a tenant scope, only decline one.
   */
  scopeKey?: string | null;
};

/**
 * The sentinel the unique index COALESCEs a NULL scope to. Tenant keys are
 * required to be non-empty, so the empty string cannot collide with one.
 *
 * Every `ON CONFLICT` below writes this sentinel as a LITERAL `''`, never as a
 * bound parameter: conflict inference matches the target expression against the
 * index's, and a Param node never equals the index's Const node — a
 * parameterized `COALESCE(scope_key, $n)` fails with "there is no
 * unique or exclusion constraint matching the ON CONFLICT specification". If
 * this value ever changes, the SQL literals must be updated by hand.
 */
const ORG_SCOPE_SENTINEL = '';

/** Index-shaped scope value: mirrors `COALESCE(scope_key, '')`. */
function scopeKeyOf(identity: { scopeKey?: string | null }): string {
  return identity.scopeKey ?? ORG_SCOPE_SENTINEL;
}

/**
 * Match key for an identity. Includes the scope so a tenant-scoped
 * `erp_customer:CARI-001` never resolves to another tenant's row — the
 * whole point of the scope column.
 */
function identityKey(identity: {
  namespace: string;
  identifier: string;
  scopeKey?: string | null;
}): string {
  // NUL separator, as the pre-scope key used: a namespace or identifier may
  // contain any printable character, so only a byte that cannot appear in
  // either is a safe delimiter.
  return `${identity.namespace}\u0000${identity.identifier}\u0000${scopeKeyOf(identity)}`;
}

/**
 * An identity row that actually landed on the entity. Structurally a
 * `ResolvedIdentity` minus the extraction-time tier flags, and it carries the
 * scope so `identityKey` can be rebuilt from it.
 */
type AttachedIdentity = {
  namespace: string;
  identifier: string;
  scopeKey: string | null;
};

function appendIdentityIfMissing(identities: AttachedIdentity[], identity: AttachedIdentity): void {
  if (!identities.some((candidate) => identityKey(candidate) === identityKey(identity))) {
    identities.push(identity);
  }
}

type ExtractedLink = {
  identities: ResolvedIdentity[];
  traits: Map<string, unknown>;
  title: string;
};

/**
 * Evaluate a rule's `createWhen` gate against the event item. Returns true (mint
 * allowed) when the predicate is absent or every declared condition holds; all
 * conditions AND together. Only gates the CREATE-on-miss branch — matching an
 * existing entity is never affected.
 */
function passesCreateWhen(predicate: EntityLinkPredicate | undefined, item: BatchItem): boolean {
  if (!predicate) return true;
  const value = getValueAtPath(item, predicate.path);
  if (predicate.equals !== undefined && value !== predicate.equals) return false;
  if (predicate.notEquals !== undefined && value === predicate.notEquals) return false;
  if (predicate.exists !== undefined) {
    const present = value !== undefined && value !== null && value !== '';
    if (present !== predicate.exists) return false;
  }
  return true;
}

/**
 * Ensure each organization-scoped attached identity is present in the legacy
 * flat alias surface. Tenant-scoped metric resolution reads entity_identities
 * directly and must never enter this scope-blind array.
 *
 * Lock before merging so concurrent connector transactions cannot clobber one
 * another's aliases or traits. Passing the entity's full identifier set (not
 * just freshly-inserted ones) also repairs a legacy entity whose
 * `entity_identities` predate aliases-on-create.
 */
async function ensureAliases(
  sql: DbClient,
  params: { orgId: string; entityId: number; identities: AttachedIdentity[] }
): Promise<void> {
  if (params.identities.length === 0) return;
  const organizationIdentifiers = params.identities
    .filter((identity) => identity.scopeKey === null)
    .map((identity) => identity.identifier);
  if (organizationIdentifiers.length === 0) return;

  const rows = await sql<{ metadata: Record<string, unknown> | null }>`
    SELECT metadata
    FROM entities
    WHERE id = ${params.entityId}
      AND organization_id = ${params.orgId}
      AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (rows.length === 0) return;

  const current = rows[0].metadata ?? {};
  const aliases = Array.isArray(current.aliases)
    ? current.aliases.filter((value): value is string => typeof value === 'string')
    : [];
  const nextAliases = [...new Set([...aliases, ...organizationIdentifiers])].sort();
  if (organizationIdentifiers.every((identifier) => aliases.includes(identifier))) {
    return;
  }

  await patchEntityRows({
    tx: sql,
    ids: [params.entityId],
    patch: await validateEntityRowPatch({
      tx: sql,
      ids: [params.entityId],
      patch: {
        metadata: {
          ...current,
          aliases: nextAliases,
        },
      },
    }),
  });
}

/**
 * Connector-owned namespaces are normalized by their own connector module
 * (assembled in identity/connector-identity-modules.ts); generic namespaces
 * fall back to the SDK's normalizer.
 */
function normalizeIdentityValue(namespace: string, raw: string): string | null {
  const connector = normalizeConnectorIdentityValue(namespace, raw);
  if (connector !== undefined) return connector;
  return normalizeIdentifier(namespace, raw);
}

/**
 * Extraction is the one place scope is decided. Everything downstream —
 * matching, creation, insertion — reads `scopeKey` off the identity
 * rather than consulting the spec again, so there is no way for the lookup and
 * the write to disagree about which row they mean.
 *
 * Tenant scope never depends on Lobu's connection row. Missing or empty tenant
 * keys fail hard rather than silently widening the identity to organization
 * scope.
 */
function extractLink(item: BatchItem, rule: ResolvedEventAttributionRule): ExtractedLink | null {
  const identities: ExtractedLink['identities'] = [];
  for (const spec of rule.identities) {
    const raw = getValueAtPath(item, spec.eventPath);
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const normalized = normalizeIdentityValue(spec.namespace, raw);
    if (!normalized) continue;
    let scopeKey: string | null = null;
    if (spec.scope === 'tenant') {
      const scopeKeyPath = spec.scopeKeyPath?.trim();
      if (!scopeKeyPath) {
        throw new Error(
          `Identity namespace '${spec.namespace}' has tenant scope and requires a non-empty scopeKeyPath.`
        );
      }
      const rawScopeKey = getValueAtPath(item, scopeKeyPath);
      if (
        rawScopeKey !== null &&
        rawScopeKey !== undefined &&
        typeof rawScopeKey !== 'string' &&
        typeof rawScopeKey !== 'number' &&
        typeof rawScopeKey !== 'boolean'
      ) {
        throw new Error(
          `Identity namespace '${spec.namespace}' at '${scopeKeyPath}' requires a string, number, or boolean tenant scope key.`
        );
      }
      scopeKey =
        rawScopeKey === null || rawScopeKey === undefined ? '' : String(rawScopeKey).trim();
      if (!scopeKey || scopeKey.includes('\u0000')) {
        throw new Error(
          `Identity namespace '${spec.namespace}' at '${scopeKeyPath}' requires a non-empty tenant scope key.`
        );
      }
    } else if (spec.scopeKeyPath !== undefined) {
      throw new Error(
        `Identity namespace '${spec.namespace}' is organization-scoped, so scopeKeyPath must be omitted.`
      );
    }
    identities.push({
      namespace: spec.namespace,
      identifier: normalized,
      matchOnly: spec.matchOnly === true,
      primary: spec.primary === true,
      scopeKey,
    });
  }
  if (identities.length === 0) return null;

  const traits = new Map<string, unknown>();
  if (rule.traits) {
    for (const [key, spec] of Object.entries(rule.traits)) {
      const value = getValueAtPath(item, spec.eventPath);
      if (value !== undefined) traits.set(key, value);
    }
  }

  const rawTitle = rule.titlePath ? getValueAtPath(item, rule.titlePath) : undefined;
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : '';

  return { identities, traits, title };
}

/**
 * Resolve identity keys to their owning entity — TYPE-AGNOSTIC.
 *
 * An identity value belongs to at most ONE entity within its declared scope.
 * The live-key index enforces that claim. Org-scoped identities carry a NULL
 * scope and therefore still resolve org-wide, which is every identity a
 * connector has not declared `scope: 'tenant'`. We deliberately do NOT
 * filter by the rule's target `entityType`: a `slack_user_id` owned by a
 * signed-in `$member` must resolve to that `$member` even when a `person`-typed
 * rule looks it up, so attribution and ACL converge on one entity instead of
 * minting a duplicate `person` (the #1646 cross-source collapse, now automatic).
 * Mirrors `access-graph.resolveMembers`, which is already identity-first +
 * type-agnostic. The target `entityType` still governs CREATE-on-miss.
 */
async function lookupMatches(
  sql: DbClient,
  params: {
    orgId: string;
    identities: ExtractedLink['identities'][];
  }
): Promise<Map<string, number>> {
  // Deduplicated by the SCOPED key, so the same (namespace, identifier) under
  // two different scopes stays two lookups instead of collapsing back into the
  // collision this exists to prevent.
  const wanted = new Map<string, ResolvedIdentity>();
  for (const arr of params.identities) {
    for (const id of arr) wanted.set(identityKey(id), id);
  }
  if (wanted.size === 0) return new Map();

  const namespaces: string[] = [];
  const identifiers: string[] = [];
  const scopes: string[] = [];
  for (const id of wanted.values()) {
    namespaces.push(id.namespace);
    identifiers.push(id.identifier);
    scopes.push(scopeKeyOf(id));
  }

  const rows = await sql<{
    entity_id: number | string;
    namespace: string;
    identifier: string;
    scope_key: string;
  }>`
    SELECT ei.entity_id, ei.namespace, ei.identifier,
           COALESCE(ei.scope_key, '') AS scope_key
    FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id
    WHERE ei.organization_id = ${params.orgId}
      AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL
      AND (ei.namespace, ei.identifier, COALESCE(ei.scope_key, '')) IN (
        SELECT ns, ident, scope
        FROM unnest(
          ${pgTextArray(namespaces)}::text[],
          ${pgTextArray(identifiers)}::text[],
          ${pgTextArray(scopes)}::text[]
        ) AS u(ns, ident, scope)
      )
  `;

  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(
      identityKey({
        namespace: row.namespace,
        identifier: row.identifier,
        // COALESCE already collapsed NULL to the sentinel; map it back so the
        // key built from a DB row matches the key built from an extracted
        // identity, whose org scope is null.
        scopeKey: row.scope_key || null,
      }),
      Number(row.entity_id)
    );
  }
  return out;
}

/**
 * Resolve a link's identities onto at most one entity, honouring identity tiers.
 *
 * A present `primary` identity (immutable, e.g. `github_user_id`) is
 * authoritative: it governs even when it matches nothing (a new account), so a
 * stale non-primary like a reused `github_login` can't merge a fresh account
 * into the old person. Without a primary, identities match equal-weight (the
 * cross-channel WhatsApp/email matching relies on this).
 *
 * This is the single definition of that rule. It is deliberately shared by both
 * resolution sites: the ordinary lookup AND the orphan-recovery re-resolution
 * after a lost auto-create race. Those two used to carry separate copies and the
 * recovery copy was tier-blind, which mis-resolved whenever a primary's owner
 * was soft-deleted while a live entity held a recycled secondary claim — the
 * link landed on the recycled-claim holder. `member_of` is a read ACL, so that
 * handed one person another person's channel access.
 *
 * Returns the entity id when exactly one candidate survives, `null` when
 * nothing matched at the governing tier, and `'ambiguous'` when several
 * entities tied there — callers must fail closed on `'ambiguous'` and never
 * pick one.
 */
function resolveIdentityTier(
  identities: ResolvedIdentity[],
  matches: Map<string, number>
): number | null | 'ambiguous' {
  const primaries = identities.filter((i) => i.primary);
  // A present primary governs alone; otherwise every identity votes equally.
  const governing = primaries.length > 0 ? primaries : identities;
  const hits = new Set<number>();
  for (const id of governing) {
    const h = matches.get(identityKey(id));
    if (h !== undefined) hits.add(h);
  }
  if (hits.size > 1) return 'ambiguous';
  if (hits.size === 1) return [...hits][0];
  return null;
}

function firstIdentityHit(
  identities: ResolvedIdentity[],
  matches: Map<string, number>
): number | null {
  for (const id of identities) {
    const hit = matches.get(identityKey(id));
    if (hit !== undefined) return hit;
  }
  return null;
}

async function createEntityWithIdentities(
  sql: DbClient,
  params: {
    orgId: string;
    connectorKey: string;
    connectionId?: number | null;
    entityType: string;
    title: string;
    identities: ExtractedLink['identities'];
    traits: Map<string, unknown>;
    creatorUserId: string;
  }
): Promise<{ entityId: number; attached: AttachedIdentity[] } | null> {
  const persisted = params.identities.filter((i) => !i.matchOnly);
  if (persisted.length === 0) return null;

  const name = params.title || persisted[0].identifier;
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of params.traits) metadata[key] = value;

  // Resolve entity_type slug → entity_types(id). Same schema search path as
  // createEntity: try the entity's own org first, then any visibility='public'
  // catalog. First match wins. See createEntity for the slug-poisoning caveat.
  let typeRow = await sql<{ id: number; backing_sql: string | null; backing_identity: string | null }>`
    SELECT et.id, et.backing_sql, et.backing_identity
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    WHERE et.slug = ${params.entityType}
      AND et.deleted_at IS NULL
      AND (
        et.organization_id = ${params.orgId}
        OR o.visibility = 'public'
      )
    ORDER BY (et.organization_id = ${params.orgId}) DESC, et.id ASC
    LIMIT 1
  `;
  if (typeRow.length === 0) {
    // Platform ACL type is ensured on the fly so event attribution can race
    // ahead of the first ACL sync without failing closed on a missing type.
    if (params.entityType === ACL_RESOURCE_TYPE_SLUG) {
      await ensureResourceEntityType(sql, params.orgId);
      typeRow = await sql<{ id: number; backing_sql: string | null; backing_identity: string | null }>`
        SELECT et.id, et.backing_sql, et.backing_identity
        FROM entity_types et
        WHERE et.slug = ${params.entityType}
          AND et.deleted_at IS NULL
          AND et.organization_id = ${params.orgId}
        LIMIT 1
      `;
      if (typeRow.length === 0) {
        logger.warn(
          { entityType: params.entityType, orgId: params.orgId },
          'entity create failed: $resource type ensure did not materialize'
        );
        return null;
      }
    } else {
      logger.warn(
        { entityType: params.entityType, orgId: params.orgId },
        'entity create failed: unknown entity type'
      );
      return null;
    }
  }
  // A pure view (derived, no identity) has no stored rows — skip auto-create.
  // A source-backed type with a declared identity stores only an identity row:
  // its slug IS the source key carried in that namespace, and its attributes
  // stay live in the source, so traits are not copied.
  const backingIdentity = typeRow[0].backing_identity;
  if (typeRow[0].backing_sql && !backingIdentity) {
    logger.warn(
      { entityType: params.entityType, orgId: params.orgId },
      'entity auto-create skipped: entity type is derived (a SQL view)'
    );
    return null;
  }
  const sourceIdentity = backingIdentity
    ? persisted.find((identity) => identity.namespace === backingIdentity)
    : undefined;
  const sourceKey = sourceIdentity?.identifier;
  if (backingIdentity && !sourceKey) {
    logger.warn(
      { entityType: params.entityType, orgId: params.orgId, namespace: backingIdentity },
      'entity auto-create skipped: event carries no source key for a source-backed type'
    );
    return null;
  }
  const entityTypeId = typeRow[0].id;

  // Try a few slug variants to defuse improbable random collisions.
  let entityId: number | null = null;
  for (let attempt = 0; attempt < (sourceKey ? 1 : 3) && entityId === null; attempt++) {
    const slug = sourceKey ?? randomSlug(params.entityType);
    // Auto-created from a connector link, but a tenant row on a tenant type all
    // the same — so it is subject to the type's rules. Validating inside the
    // retry loop costs one extra evaluation per slug collision, which the
    // comment above already calls improbable.
    const inserted = await tryInsertEntityRow({
      tx: sql,
      row: await validateEntityRowInsert({
        tx: sql,
        row: {
          organizationId: params.orgId,
          entityTypeId,
          name,
          slug,
          metadata: sourceKey ? {} : metadata,
          createdBy: params.creatorUserId,
        },
      }),
    });
    if (inserted) entityId = Number(inserted.id);
  }
  const alreadyAttached: AttachedIdentity[] = [];
  if (entityId === null && sourceIdentity) {
    // A slug collision is reusable only when the full scoped source identity
    // belongs to that row. Equal source keys in different tenants aren't a match.
    const existing = await sql<{ id: number }>`
      SELECT id FROM entities
      WHERE organization_id = ${params.orgId}
        AND entity_type_id = ${entityTypeId}
        AND slug = ${sourceKey}
        AND parent_id IS NULL
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (existing.length > 0) {
      const existingId = Number(existing[0].id);
      const matches = await lookupMatches(sql, {
        orgId: params.orgId,
        identities: [persisted],
      });
      if (matches.get(identityKey(sourceIdentity)) !== existingId) return null;
      entityId = existingId;
      for (const identity of persisted) {
        if (matches.get(identityKey(identity)) === entityId) {
          alreadyAttached.push({
            namespace: identity.namespace,
            identifier: identity.identifier,
            scopeKey: identity.scopeKey ?? null,
          });
        }
      }
    }
  }
  if (entityId === null) return null;

  const attached = await insertIdentities(sql, {
    orgId: params.orgId,
    entityId,
    connectorKey: params.connectorKey,
    connectionId: params.connectionId,
    identities: persisted,
  });
  // ON CONFLICT returns no row for an unchanged identity. Preserve verified
  // ownership so a racing observer neither drops attribution nor deletes it.
  for (const identity of alreadyAttached) appendIdentityIfMissing(attached, identity);
  // Only organization-scoped identities enter the legacy flat alias surface.
  await ensureAliases(sql, {
    orgId: params.orgId,
    entityId,
    identities: attached,
  });
  return { entityId, attached };
}

/**
 * Insert identities for `entityId`, RETURNING the rows attached to that entity.
 * Re-observing a legacy row fills missing connection provenance; a row owned by
 * another entity is not returned, so the caller will not mis-claim it.
 *
 * The scope is RETURNED, not just written, because callers key the in-memory
 * claim map on it. Returning `(namespace, identifier)` alone would let a
 * tenant-scoped identity be re-keyed as org-scoped on the way back, and the
 * rest of the batch would then resolve it to the wrong entity.
 */
async function insertIdentities(
  sql: DbClient,
  params: {
    orgId: string;
    entityId: number;
    connectorKey: string;
    connectionId?: number | null;
    identities: ExtractedLink['identities'];
  }
): Promise<AttachedIdentity[]> {
  if (params.identities.length === 0) return [];
  const namespaces = params.identities.map((i) => i.namespace);
  const identifiers = params.identities.map((i) => i.identifier);
  // NULL, not the sentinel: the sentinel exists only inside the index
  // expression. `?? null` collapses hand-built identity omissions to org scope
  // before serialization.
  const scopes = params.identities.map((i) => i.scopeKey ?? null);
  const attached = await sql<{
    namespace: string;
    identifier: string;
    scope_key: string | null;
  }>`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector, connection_id,
      scope_key
    )
    SELECT ${params.orgId}, ${params.entityId}, v.ns, v.ident,
           ${`connector:${params.connectorKey}`}, ${params.connectionId ?? null},
           v.scope
    FROM unnest(
      ${pgTextArray(namespaces)}::text[],
      ${pgTextArray(identifiers)}::text[],
      ${pgTextArray(scopes)}::text[]
    ) AS v(ns, ident, scope)
    ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, ''))
      WHERE deleted_at IS NULL
    DO UPDATE SET connection_id = EXCLUDED.connection_id
    WHERE entity_identities.entity_id = EXCLUDED.entity_id
      AND entity_identities.connection_id IS NULL
      AND EXCLUDED.connection_id IS NOT NULL
    RETURNING namespace, identifier, scope_key
  `;
  return attached.map((r) => ({
    namespace: r.namespace,
    identifier: r.identifier,
    scopeKey: r.scope_key,
  }));
}

async function applyTraits(
  sql: DbClient,
  params: {
    orgId: string;
    entityId: number;
    rule: ResolvedEventAttributionRule;
    traits: Map<string, unknown>;
    isCreate: boolean;
  }
): Promise<void> {
  if (!params.rule.traits || params.traits.size === 0) return;

  // init_only traits were written to metadata at create time; nothing to do now.
  const overwrite: Record<string, unknown> = {};
  const preferNonEmpty: Record<string, unknown> = {};
  for (const [key, value] of params.traits) {
    const spec = params.rule.traits[key];
    if (!spec || spec.mergeStrategy === 'init_only') continue;
    if (value === undefined) continue;
    if (spec.mergeStrategy === 'overwrite') {
      overwrite[key] = value;
    } else if (spec.mergeStrategy === 'prefer_non_empty') {
      const empty = value === null || value === '';
      if (!empty) preferNonEmpty[key] = value;
    }
  }
  if (Object.keys(overwrite).length === 0 && Object.keys(preferNonEmpty).length === 0) return;

  // Serialize the metadata read-modify-write with aliases and traits
  // from concurrent connector transactions.
  const rows = await sql<{ metadata: Record<string, unknown> | null; backing_sql: string | null }>`
    SELECT e.metadata, et.backing_sql
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ${params.entityId}
      AND e.organization_id = ${params.orgId}
      AND e.deleted_at IS NULL
    FOR UPDATE OF e
  `;
  // This also covers matches on existing identities, which skip the create guard.
  if (rows.length === 0 || rows[0].backing_sql) return;
  const current = rows[0].metadata ?? {};

  const next: Record<string, unknown> = { ...current, ...overwrite };
  for (const [key, value] of Object.entries(preferNonEmpty)) {
    const existing = current[key];
    if (existing === undefined || existing === null || existing === '') {
      next[key] = value;
    }
  }

  await patchEntityRows({
    tx: sql,
    ids: [params.entityId],
    patch: await validateEntityRowPatch({
      tx: sql,
      ids: [params.entityId],
      patch: { metadata: next },
    }),
  });
}

/**
 * Per-batch ingestion hook. Looks up or creates target entities for each
 * item using the normalized entity_identities index, then merges declared
 * traits onto the resolved entity. Poll/sync loads rules from its feed;
 * webhooks and access graphs supply rules directly. Both receive resolved
 * ids and named endpoints; feed plans also return relationship declarations.
 *
 * Connector attribution is one logical entity write: match/create, identity
 * claim, aliases, traits, and provisional cleanup commit together. A rejected
 * entity or identity write therefore rolls the batch back and propagates; the
 * sync aborts instead of persisting events whose attribution half-landed.
 */
export async function applyEventAttributions(
  params: {
    connectorKey: string;
    connectionId?: number | null;
    orgId: string;
    items: BatchItem[];
  } & ({ feedKey: string | null } | { rules: RuleMap }),
  // Join a supplied transaction or open one for a pool/omitted handle. Sync
  // dry runs pass their rolled-back tx; webhooks share their event transaction.
  sql?: DbClient
): Promise<AttributionResolution> {
  scrubIdentityScopeProjections(params.items);
  const empty: AttributionResolution = {
    entityIdsByItem: new Map(),
    namedEntityIdsByItem: new Map(),
    unresolvedNamedAttributionsByItem: new Map(),
    relationshipsByKind: {},
  };
  if (params.items.length === 0) return empty;

  // Resolved BEFORE the rule load: the sync dry-run path supplies its
  // rolled-back transaction, and reading rules on the pool while that is open is
  // the starvation this file exists to avoid (#2818).
  const db = sql ?? getDb();

  const plan = 'rules' in params
    ? { rulesByKind: params.rules, relationshipsByKind: {} }
    : params.feedKey
      ? await loadEventAttributionPlan(db, { ...params, feedKey: params.feedKey })
      : { rulesByKind: {}, relationshipsByKind: {} };
  if (Object.keys(plan.rulesByKind).length === 0) {
    return { ...empty, relationshipsByKind: plan.relationshipsByKind };
  }
  const resolved = await withEntityWriteTransaction(db, (tx) =>
    resolveLinksByKind(
      {
        ...params,
        rulesByKind: plan.rulesByKind,
      },
      tx
    )
  );
  return {
    ...resolved,
    relationshipsByKind: plan.relationshipsByKind,
  };
}

/**
 * Resolve or auto-create targets from rules grouped by event kind, stamp
 * canonical identifier metadata for read-time JOINs, and merge declared traits.
 */
async function resolveLinksByKind(
  params: {
    connectorKey: string;
    connectionId?: number | null;
    orgId: string;
    items: BatchItem[];
    rulesByKind: RuleMap;
  },
  // applyEventAttributions supplies a transaction for every entity write.
  sql: DbClient
): Promise<Omit<AttributionResolution, 'relationshipsByKind'>> {
  const resolvedByItem = new Map<number, number[]>();
  const namedEntityIdsByItem = new Map<number, Map<string, number>>();

  // entities.created_by is NOT NULL; resolve an org owner/admin once per batch
  // so auto-created entities attribute to a real member rather than a seed user.
  const creatorUserId = await resolveOrgCreator(sql, params.orgId);

  // rule -> per-item extracted link, carrying the source item + index (the
  // caller recovers the resolved entity per item; metadata is stamped onto the
  // item post-resolution).
  const suppliedNamesByItem = new Map<number, Set<string>>();
  const byRule = new Map<
    ResolvedEventAttributionRule,
    Array<{ index: number; item: BatchItem; link: ExtractedLink }>
  >();
  params.items.forEach((item, index) => {
    const kind = item.origin_type;
    if (!kind) return;
    const rules = params.rulesByKind[kind];
    if (!rules) return;
    for (const rule of rules) {
      if (
        rule.name &&
        rule.identities.some((identity) => {
          const raw = getValueAtPath(item, identity.eventPath);
          return raw !== undefined && raw !== null && raw !== '';
        })
      ) {
        let names = suppliedNamesByItem.get(index);
        if (!names) {
          names = new Set();
          suppliedNamesByItem.set(index, names);
        }
        names.add(rule.name);
      }
      const link = extractLink(item, rule);
      if (!link) continue;
      // Metadata stamping is deferred to post-resolution (below) — only
      // attached identifiers are stamped, so a stale one (e.g. a vacated
      // github_login) can't make read-time JOINs attribute to the wrong person.
      let bucket = byRule.get(rule);
      if (!bucket) {
        bucket = [];
        byRule.set(rule, bucket);
      }
      bucket.push({ index, item, link });
    }
  });
  // The reserved projections were scrubbed before extraction and are rebuilt
  // below only from identities that actually attach to an entity.
  if (byRule.size === 0) {
    return {
      entityIdsByItem: resolvedByItem,
      namedEntityIdsByItem,
      unresolvedNamedAttributionsByItem: collectUnresolvedNamedAttributions(
        suppliedNamesByItem,
        namedEntityIdsByItem
      ),
    };
  }

  // Resolve first, then lock every existing entity in one ascending-id pass.
  // Without a global lock order, two connector batches containing the same
  // entities in opposite item order could deadlock after each locked its first
  // row. Rows that disappeared between lookup and lock are removed from the
  // match maps so they cannot be returned as live resolutions.
  const matchesByRule = new Map<ResolvedEventAttributionRule, Map<string, number>>();
  const matchedEntityIds = new Set<number>();
  for (const [rule, entries] of byRule) {
    const matches = await lookupMatches(sql, {
      orgId: params.orgId,
      identities: entries.map((entry) => entry.link.identities),
    });
    matchesByRule.set(rule, matches);
    for (const entityId of matches.values()) matchedEntityIds.add(entityId);
  }
  if (matchedEntityIds.size > 0) {
    const ids = [...matchedEntityIds].sort((a, b) => a - b);
    const lockedRows = await sql<{ id: number | string }>`
      SELECT id
      FROM entities
      WHERE organization_id = ${params.orgId}
        AND id = ANY(${pgBigintArray(ids)}::bigint[])
        AND deleted_at IS NULL
      ORDER BY id
      FOR UPDATE
    `;
    const lockedIds = new Set(lockedRows.map((row) => Number(row.id)));
    for (const matches of matchesByRule.values()) {
      for (const [key, entityId] of matches) {
        if (!lockedIds.has(entityId)) matches.delete(key);
      }
    }
  }

  const recordResolved = (
    index: number,
    entityId: number,
    rule: ResolvedEventAttributionRule
  ): void => {
    const existing = resolvedByItem.get(index);
    if (existing) {
      if (!existing.includes(entityId)) existing.push(entityId);
    } else {
      resolvedByItem.set(index, [entityId]);
    }
    if (!rule.name) return;
    let named = namedEntityIdsByItem.get(index);
    if (!named) {
      named = new Map();
      namedEntityIdsByItem.set(index, named);
    }
    const previous = named.get(rule.name);
    if (previous !== undefined && previous !== entityId) {
      throw new Error(
        `Attribution name '${rule.name}' resolved to more than one entity for item ${index}`
      );
    }
    named.set(rule.name, entityId);
  };

  for (const [rule, entries] of byRule) {
    const matches = matchesByRule.get(rule)!;

    for (const { index, item, link } of entries) {
      // Tier semantics are defined once in `resolveIdentityTier` and shared
      // with the orphan-recovery re-resolution below. A present primary that
      // matched nothing resolves to null here on purpose: the create path then
      // mints a new entity keyed on it instead of absorbing a stale
      // secondary's owner.
      const tier = resolveIdentityTier(link.identities, matches);
      const ambiguous = tier === 'ambiguous';
      let entityId: number | null = ambiguous ? null : tier;
      let isCreate = false;

      if (ambiguous) {
        logger.warn(
          {
            orgId: params.orgId,
            connectorKey: params.connectorKey,
            entityType: rule.entityType,
            identifiers: link.identities.map((i) => `${i.namespace}:${i.identifier}`),
          },
          'entityLink merge candidate — multiple entities matched at the same identity tier'
        );
        continue;
      }

      // Identities that ACTUALLY attached to the resolved/created entity. We
      // only ever claim THESE in the in-memory matches map below — an identifier
      // that ON CONFLICT-skipped because another entity already owns it stays
      // with that entity, so the map must not mis-claim it for this one.
      let attached: AttachedIdentity[] = [];
      // matchOnly tuples may prove which entity owns this event without being
      // persisted as an entity identity or alias. Keep that recall surface
      // separate from the durable attachment set.
      const eventOnlyIdentities: AttachedIdentity[] = [];
      if (entityId !== null) {
        // Matched an existing entity: accrete the non-matchOnly identities; the
        // identifier(s) we matched on already belong to this entity.
        const fresh = await insertIdentities(sql, {
          orgId: params.orgId,
          entityId,
          connectorKey: params.connectorKey,
          connectionId: params.connectionId,
          identities: link.identities.filter((i) => !i.matchOnly),
        });
        attached = [...fresh];
        // Matched, persistent identifiers are this entity's even if a re-insert
        // was a no-op (they were how we found it), so claim them too. A
        // matchOnly identifier stays out of entity identity/alias projections;
        // if it matched, event projection is handled separately below.
        for (const id of link.identities) {
          if (!id.matchOnly && matches.get(identityKey(id)) === entityId) {
            const matched = {
              namespace: id.namespace,
              identifier: id.identifier,
              scopeKey: id.scopeKey ?? null,
            };
            appendIdentityIfMissing(attached, matched);
          } else if (id.matchOnly && matches.get(identityKey(id)) === entityId) {
            appendIdentityIfMissing(eventOnlyIdentities, {
              namespace: id.namespace,
              identifier: id.identifier,
              scopeKey: id.scopeKey ?? null,
            });
          }
        }
        // Project only tuples that the resolved entity actually owns. A
        // non-governing secondary may already belong to another entity; its
        // ON CONFLICT no-op must never become an alias on this one. Including
        // the matched rows still repairs legacy owners that predate projections.
        await ensureAliases(sql, {
          orgId: params.orgId,
          entityId,
          identities: attached,
        });
      } else if (rule.autoCreate && passesCreateWhen(rule.createWhen, item)) {
        if (!creatorUserId) {
          logger.warn(
            { orgId: params.orgId, entityType: rule.entityType },
            'autoCreate skipped: org has no member to attribute as creator'
          );
          continue;
        }
        const created = await createEntityWithIdentities(sql, {
          orgId: params.orgId,
          connectorKey: params.connectorKey,
          connectionId: params.connectionId,
          entityType: rule.entityType,
          title: link.title,
          identities: link.identities,
          traits: link.traits,
          creatorUserId,
        });
        if (created !== null && created.attached.length > 0) {
          entityId = created.entityId;
          attached = created.attached;
          isCreate = true;
        } else if (created !== null) {
          // Concurrent auto-create lost the identity race: every identifier went
          // to the winner via ON CONFLICT, so the row we just inserted is an
          // identity-less orphan. Hard-delete it (no events reference a row born
          // this turn) and re-resolve to the winning entity.
          await hardDeleteEntityRows({ tx: sql, ids: [created.entityId] });
          const winner = await lookupMatches(sql, {
            orgId: params.orgId,
            identities: [link.identities],
          });
          // Re-resolve through the SAME tier rule as the ordinary lookup. A
          // tier-blind union here mis-resolved when the primary's owner was
          // soft-deleted (so the primary matched nothing) while a live entity
          // still held a recycled secondary claim: the union saw exactly one
          // hit and adopted the recycled-claim holder. `member_of` is a read
          // ACL, so that granted one person another person's channel access.
          // Unmatched-primary and ambiguous both leave entityId null → skip,
          // which fails closed (no edge) rather than guessing an owner.
          const winnerTier = resolveIdentityTier(link.identities, winner);
          if (typeof winnerTier === 'number') {
            entityId = winnerTier;
            for (const id of link.identities) {
              if (winner.get(identityKey(id)) === entityId) {
                const matched = {
                  namespace: id.namespace,
                  identifier: id.identifier,
                  scopeKey: id.scopeKey ?? null,
                };
                appendIdentityIfMissing(id.matchOnly ? eventOnlyIdentities : attached, matched);
              }
            }
          }
        }
      }

      if (entityId === null) continue;

      await applyTraits(sql, {
        orgId: params.orgId,
        entityId,
        rule,
        traits: link.traits,
        isCreate,
      });

      recordResolved(index, entityId, rule);

      // Cache the mapping for the rest of the batch — only for attached
      // identifiers, so an identifier that stayed on another entity (ON CONFLICT
      // no-op) keeps its existing owner and isn't mis-claimed. EVERY rule's map
      // is updated, not just this one: all maps are resolved up front for the
      // prelock, so a later rule can no longer re-read this create from the DB
      // and would otherwise miss an entity the batch just minted. Sharing the
      // claim is exactly what that re-read returned — `lookupMatches` is
      // type-agnostic and an identity belongs to at most one entity org-wide.
      for (const id of attached) {
        const key = identityKey(id);
        for (const ruleMatches of matchesByRule.values()) ruleMatches.set(key, entityId);
      }

      // Stamp metadata slots and their scope projections for identities that
      // actually resolved this event. This includes a matched matchOnly tuple:
      // it remains absent from entity_identities and entity aliases, but the
      // pre-existing claim still needs the event tuple for read-time recall.
      // Read-time recall compares the full
      // (namespace, identifier, scope key) tuple; metrics compare the same
      // complete tuple. A stale identifier or tenant key would
      // mis-attribute an append-only event.
      //
      // A namespace slot holds ONE value, but an event can carry multiple
      // attribution rules that resolve the SAME namespace to DIFFERENT entities
      // (e.g. an X DM stamps x_user_id for both the `authored_by` sender and the
      // `about` counterparty). Read-time recall can only match one of them via
      // this slot, so first-writer-wins: the earliest-declared rule (the primary
      // author) keeps the slot, and we log the collision so the case that needs a
      // richer, role-aware read model is observable rather than silently dropped.
      // Making role queryable at read time is deliberately a separate change (it
      // touches the shared recall SQL + every call site) — until then this is the
      // honest boundary, not a workaround.
      const md = item.metadata ?? {};
      item.metadata = md;
      let byNamespace = ownRecord(md, IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY) as
        | Record<string, string>
        | undefined;
      if (!byNamespace) {
        byNamespace = {};
        setOwn(md, IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY, byNamespace);
      }
      for (const id of [...attached, ...eventOnlyIdentities]) {
        const existing = ownValue<unknown>(md, id.namespace);
        const projectedScope = id.scopeKey ?? ORGANIZATION_SCOPE_PROJECTION;
        const existingScope = ownValue<string>(byNamespace, id.namespace);
        if (
          existing !== undefined &&
          (existing !== id.identifier ||
            (existingScope !== undefined && existingScope !== projectedScope))
        ) {
          logger.warn(
            {
              orgId: params.orgId,
              connectorKey: params.connectorKey,
              namespace: id.namespace,
              kept: existing,
              dropped: id.identifier,
              keptScope: existingScope,
              droppedScope: projectedScope,
              role: rule.role,
            },
            'attribution metadata slot collision — a later rule resolved the same namespace to a different identity scope; keeping the first-stamped tuple (read-time recall matches only one)'
          );
          continue;
        }
        setOwn(md, id.namespace, id.identifier);
        setOwn(byNamespace, id.namespace, projectedScope);
      }
    }
  }

  return {
    entityIdsByItem: resolvedByItem,
    namedEntityIdsByItem,
    unresolvedNamedAttributionsByItem: collectUnresolvedNamedAttributions(
      suppliedNamesByItem,
      namedEntityIdsByItem
    ),
  };
}

interface SenderIdentityParams {
  orgId: string;
  connectorKey: string;
  mintEntityType: string;
  identities: ResolvedIdentity[];
  title?: string | null;
}

/**
 * Resolve the SENDER of a captured chat message to an entity id — STORE-ONLY
 * attribution for `channel_messages.author_entity_id`. Connector-AGNOSTIC: the
 * caller hands over an already-normalized identity spec (it owns the platform's
 * namespace + normalizer) and the entity type to mint on a miss; this function
 * names no connector.
 *
 * Unlike {@link applyEventAttributions}, this writes NO event row, stamps no
 * `events.metadata`, and never enters the embed pipeline: it only reads the
 * normalized identity index and, on a miss, mints the given type (gated).
 * Transcript is high-volume operational data, so the caller fire-and-forgets
 * this — a resolution failure must never block capture or a webhook ack.
 *
 * Resolution (type-agnostic, driven by the #1646 cross-source collapse — a
 * signed-in human is a `$member` carrying the same team-scoped chat identity):
 *   1. the existing entity of ANY type owning this identity (a signed-in
 *      `$member`, an already-attributed `person`, …) — return it. A single
 *      {@link lookupMatches} covers all types because an identity value is
 *      globally unique to one entity; no `$member`-before-`person` ordering.
 *      Never mint a `$member` here (membership provisioning owns that, so
 *      attribution and ACL converge on the SAME entity).
 *   2. else mint `mintEntityType`, gated on a well-formed identity + a real org
 *      member to attribute the create to. Callers drop bots and malformed ids
 *      BEFORE calling (an empty `identities` list → null).
 */
export async function resolveSenderIdentity(
  sql: DbClient,
  params: SenderIdentityParams
): Promise<number | null> {
  if (params.identities.length === 0) return null;
  // Every captured message calls this, and the overwhelming majority resolve a
  // sender that already exists — answer those from a plain read rather than
  // opening a write transaction per message. Only a miss (which may mint) needs
  // one, and the in-transaction path re-runs this lookup because a concurrent
  // mint can land between the two.
  const existing = firstIdentityHit(
    params.identities,
    await lookupMatches(sql, {
      orgId: params.orgId,
      identities: [params.identities],
    })
  );
  if (existing !== null) return existing;
  return withEntityWriteTransaction(sql, (tx) => resolveSenderIdentityInTransaction(tx, params));
}

async function resolveSenderIdentityInTransaction(
  sql: DbClient,
  params: SenderIdentityParams
): Promise<number | null> {
  // 1) Any existing entity owning this identity — $member (signed-in human,
  // #1646) or person, resolved by one type-agnostic lookup. No create.
  const hit = firstIdentityHit(
    params.identities,
    await lookupMatches(sql, {
      orgId: params.orgId,
      identities: [params.identities],
    })
  );
  if (hit !== null) return hit;

  // 2) Mint. The only remaining gate is a real org member to attribute to.
  const creatorUserId = await resolveOrgCreator(sql, params.orgId);
  if (!creatorUserId) return null;

  const created = await createEntityWithIdentities(sql, {
    orgId: params.orgId,
    connectorKey: params.connectorKey,
    entityType: params.mintEntityType,
    title: params.title?.trim() || '',
    identities: params.identities,
    traits: new Map(),
    creatorUserId,
  });
  if (created !== null && created.attached.length > 0) {
    return created.entityId;
  }
  // Lost the identity create-race (a concurrent ingest minted it first): drop
  // the identity-less orphan and resolve to the winner instead.
  if (created !== null) {
    await hardDeleteEntityRows({ tx: sql, ids: [created.entityId] });
    return firstIdentityHit(
      params.identities,
      await lookupMatches(sql, {
        orgId: params.orgId,
        identities: [params.identities],
      })
    );
  }
  return null;
}
