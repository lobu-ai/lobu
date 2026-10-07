/**
 * Relationship Validation Helpers
 *
 * Validates entity relationship constraints: self-reference, confidence bounds,
 * source enums, symmetric canonicalization, scope enforcement, and type-pair
 * rules.
 */

import { type DbClient, getDb } from '../db/client';
import { ToolUserError } from './errors';
import type { Env } from '../index';
import type { ToolContext } from '../tools/registry';

/** Sources accepted from the manage_entity link/update_link surface. */
const CALLER_SETTABLE_SOURCES = ['ui', 'llm', 'feed', 'api'] as const;

export const EDGE_SOURCE_CONFIG = 'config';
export const EDGE_SOURCE_MANUAL = 'manual';

/**
 * Explicit classification of what a relationship type is for.
 *
 * `authorization` marks a type for the purpose-based ACL-read cutover. It is
 * deliberately not caller-settable: the whole point is that the platform, not
 * a caller or connector manifest, decides which vocabulary grants access.
 * Owners may declare `identity`, which governs associations and grants no access.
 */
export type RelationshipTypePurpose = 'authorization' | 'identity';
export const PURPOSE_AUTHORIZATION: RelationshipTypePurpose = 'authorization';

/**
 * Relationship slugs whose EDGES the ACL engine owns. A config can declare the
 * `member_of` type before its first ACL sync classifies it; caller-created edges
 * on it are never allowed.
 *
 * `purpose` is the durable enforcement boundary. Until ACL reads switch fully
 * to it, the mutation guard also checks the slug so a newly declared,
 * not-yet-classified row cannot be used to mint access.
 */
export function isAclManagedRelationshipSlug(slug: string): boolean {
  return slug === ACL_MANAGED_SLUG;
}

const ACL_MANAGED_SLUG = 'member_of';

/**
 * The same test as {@link isAclManagedRelationshipSlug}, in SQL, for statements
 * that classify by relationship type — selecting edges, or listing the types
 * themselves. Expects the type table aliased `rt`. Static text with no
 * interpolation, so it is safe through `sql.unsafe`.
 *
 * `IS NOT DISTINCT FROM` rather than `=` so the negation is sound: `purpose` is
 * NULL on every unclassified type, and `NOT (NULL = 'authorization' OR …)`
 * evaluates to NULL, which would silently drop every ordinary edge from a
 * NOT-qualified query instead of keeping it.
 */
export const ACL_MANAGED_TYPE_SQL =
  `(rt.purpose IS NOT DISTINCT FROM '${PURPOSE_AUTHORIZATION}'` +
  ` OR rt.slug IS NOT DISTINCT FROM '${ACL_MANAGED_SLUG}')`;

/**
 * Run `fn` with the transaction-local flag the ACL edge trigger requires for a
 * classified relationship type.
 *
 * Enforcement of "only the ACL syncs write authorization edges" lives in a
 * database trigger, not in call-site checks, because `entity_relationships` has
 * several write paths and guarding a subset only ever means the next writer is
 * the bypass. `source` cannot carry the boundary either: the syncs write
 * `source='feed'`, which is also caller-settable, so a caller-minted edge is
 * byte-identical to a sync-minted one.
 *
 * `set_config(..., true)` is transaction-LOCAL. On a pooled connection a session
 * GUC would leak the privilege to whatever ran next; this cannot.
 *
 * This opens a top-level transaction. A writer that is already inside a
 * transaction uses `withAclPrivilege` instead. The privilege is released
 * explicitly so the grant is bounded by `fn`, not by the rest of the caller's
 * transaction.
 */
export async function withAclEdgeWrite<T>(
  db: DbClient,
  fn: (tx: DbClient) => Promise<T>
): Promise<T> {
  return db.begin((tx: DbClient) => withAclPrivilege(tx, () => fn(tx))) as Promise<T>;
}

/**
 * Grant the ACL-write privilege for exactly `fn`, inside a transaction the
 * caller already owns.
 *
 * `withAclEdgeWrite` opens its own transaction; this is for a writer that is
 * already mid-transaction and must drop the privilege again before its
 * remaining statements run. Merge is the motivating case: it tombstones
 * authorization edges early and then repoints ordinary ones, and if the flag
 * stayed set for the rest of that transaction the trigger could no longer
 * refuse a repoint of any authorization edge the first statement missed.
 *
 * The reset is best-effort: if `fn` failed with a database error the
 * transaction is already aborted and every later statement — including this
 * one — will fail, so swallowing keeps the caller's original error rather than
 * masking it with `current transaction is aborted`. Nothing leaks in that case
 * because the whole transaction rolls back.
 */
export async function withAclPrivilege<T>(tx: DbClient, fn: () => Promise<T>): Promise<T> {
  await tx`SELECT set_config('lobu.acl_write', 'on', true)`;
  try {
    return await fn();
  } finally {
    await tx`SELECT set_config('lobu.acl_write', 'off', true)`.catch(() => {});
  }
}

/** Shared SQL generator also used by the DB guard; acquire before any row lock. */
export async function lockIdentityOrganization(tx: DbClient, organizationId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(lobu_identity_lock_key(${organizationId}))`;
}

export async function withIdentityPrivilege<T>(tx: DbClient, fn: () => Promise<T>): Promise<T> {
  await tx`SELECT set_config('lobu.identity_write', 'on', true)`;
  try { return await fn(); }
  finally { await tx`SELECT set_config('lobu.identity_write', 'off', true)`.catch(() => {}); }
}

/**
 * Refuse a caller-driven mutation of an authorization-bearing relationship type.
 *
 * Without this, classifying `member_of` would make the ACL gates depend on rows
 * any caller holding the generic entity-link surface could create or soft-delete
 * — classification alone would hand out a way to mint or revoke access.
 */
export function assertNotAuthorizationType(
  type: { slug?: string | null; purpose?: string | null },
  action: string
): void {
  refuseAclManaged(type, action, false);
}

/**
 * Stricter variant for the EDGE surfaces: also refuses the ACL-managed slug, not
 * just a classified type.
 *
 * ACL reads still trust the slug during the staged cutover. A config can create
 * a new unclassified `member_of` row after the one-time backfill and before its
 * first ACL sync; a purpose-only guard would leave callers free to mint or
 * revoke grants on that row.
 *
 * Deliberately NOT used on the relationship-TYPE surfaces: configs legitimately
 * declare `member_of` (`examples/personal-agent/lobu.config.ts`), and refusing
 * the declaration would break every such apply. Declaring a type grants nobody
 * access; creating an edge on it does — which is why the connector install
 * preflight uses this variant even though it only reads type rows: a connector
 * that declares a relationship is declaring the edges it will write.
 */
export function assertNotAclManagedEdge(
  type: { slug?: string | null; purpose?: string | null },
  action: string
): void {
  refuseAclManaged(type, action, true);
}

function refuseAclManaged(
  type: { slug?: string | null; purpose?: string | null },
  action: string,
  includeSlug: boolean
): void {
  const managed =
    type.purpose === PURPOSE_AUTHORIZATION ||
    (includeSlug && isAclManagedRelationshipSlug(type.slug ?? ''));
  if (!managed) return;
  throw new ToolUserError(
    `Relationship type '${type.slug ?? 'unknown'}' is authorization-bearing and cannot be modified via ${action}. ` +
      'Access-granting edges are maintained by the connector ACL syncs.',
    403
  );
}


/** Source values used to select edges during reconciliation. */
const RECONCILED_SOURCES = [EDGE_SOURCE_CONFIG, EDGE_SOURCE_MANUAL] as const;

type CallerSettableSource = (typeof CALLER_SETTABLE_SOURCES)[number];

/**
 * Validate that a relationship does not reference itself.
 */
export function validateNoSelfReference(fromId: number, toId: number): void {
  if (fromId === toId) {
    throw new ToolUserError('Self-referencing relationships are not allowed', 400);
  }
}

/**
 * Validate confidence is in [0, 1] range.
 */
export function validateConfidence(confidence: number | undefined | null): void {
  if (confidence === undefined || confidence === null) return;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new ToolUserError('Confidence must be a number between 0 and 1', 400);
  }
}

/**
 * Validate a caller-supplied source.
 *
 * Reconciled sources are internal: callers may neither create edges in a
 * reconciler's scope nor move existing edges into it.
 */
export function validateSource(source: string | undefined | null): void {
  if (source === undefined || source === null) return;
  if (!CALLER_SETTABLE_SOURCES.includes(source as CallerSettableSource)) {
    throw new ToolUserError(
      `Invalid source "${source}". Must be one of: ${CALLER_SETTABLE_SOURCES.join(', ')}`,
      400
    );
  }
}

/**
 * Refuse to change the source or metadata that identify a reconciled edge.
 */
export function validateReconciledEdgeUpdate(
  current: string | null | undefined,
  next: string | undefined | null,
  metadataChanged: boolean
): void {
  if (!RECONCILED_SOURCES.includes(current as (typeof RECONCILED_SOURCES)[number])) {
    return;
  }
  if ((next === undefined || next === null) && !metadataChanged) return;
  throw new ToolUserError(
    `Cannot change source or metadata of a "${current}"-owned relationship. It is reconciled by the subsystem that created it; edit that configuration instead.`,
    400
  );
}

/**
 * Canonicalize a symmetric edge so from_entity_id < to_entity_id.
 */
export function canonicalizeSymmetricEdge(
  fromId: number,
  toId: number
): { from: number; to: number } {
  return fromId <= toId ? { from: fromId, to: toId } : { from: toId, to: fromId };
}

/**
 * Validate scope rule for a relationship.
 *
 * The from_entity must belong to the caller's organization (relationships are
 * always authored from the source's org). The to_entity may be either in the
 * same org or in a public-catalog org (`organization.visibility='public'`),
 * which lets a tenant's relationship reference canonical world entities like
 * HMRC or Barclays without copying them locally.
 *
 * Public → tenant references are forbidden — public catalogs never reach into
 * private orgs. The relationship row's organization_id always matches the
 * source's org (the caller's), keeping the assertion under the caller's
 * delete/visibility control.
 */
export async function validateScopeRule(
  fromEntityId: number,
  toEntityId: number,
  _env: Env,
  ctx: ToolContext
): Promise<void> {
  const sql = getDb();

  const rows = await sql`
    SELECT e.id, e.organization_id, o.visibility
    FROM entities e
    LEFT JOIN organization o ON o.id = e.organization_id
    WHERE e.id IN (${fromEntityId}, ${toEntityId})
  `;

  if (rows.length < 2) {
    const foundIds = rows.map((r) => r.id);
    const missingId = [fromEntityId, toEntityId].find((id) => !foundIds.includes(id));
    throw new ToolUserError(`Entity ${missingId} not found`, 404);
  }

  const fromEntity = rows.find((r) => Number(r.id) === fromEntityId)!;
  const toEntity = rows.find((r) => Number(r.id) === toEntityId)!;

  // Source must always be in the caller's org — you can't author relationships
  // *from* someone else's entity.
  if (String(fromEntity.organization_id) !== ctx.organizationId) {
    throw new ToolUserError(`Entity ${fromEntityId} does not belong to your organization`, 403);
  }

  // Target may be same-org OR a public-catalog entity. Anything else (a
  // private org you don't control) is rejected.
  const toOrgId = String(toEntity.organization_id);
  const toVisibility = String(toEntity.visibility ?? 'private');
  if (toOrgId !== ctx.organizationId && toVisibility !== 'public') {
    throw new ToolUserError(
      `Entity ${toEntityId} is in a private organization that does not belong to you. Cross-org references are only allowed to entities in public catalogs.`,
      403
    );
  }
}

/**
 * Validate that the relationship type allows the given entity type pair.
 * For symmetric types, checks both directions.
 */
export async function validateTypeRule(
  relationshipTypeId: number,
  fromEntityId: number,
  toEntityId: number,
  sql: DbClient
): Promise<void> {
  // Get the relationship type to check if it's symmetric
  const typeRows = await sql`
    SELECT is_symmetric
    FROM entity_relationship_types
    WHERE id = ${relationshipTypeId}
      AND deleted_at IS NULL
  `;
  if (typeRows.length === 0) {
    throw new ToolUserError(`Relationship type ${relationshipTypeId} not found`, 404);
  }
  const isSymmetric = Boolean(typeRows[0].is_symmetric);

  // Get entity types for both entities
  const entityRows = await sql`
    SELECT e.id, et.slug AS entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id IN (${fromEntityId}, ${toEntityId})
  `;
  const fromEntityType = String(entityRows.find((r) => Number(r.id) === fromEntityId)?.entity_type);
  const toEntityType = String(entityRows.find((r) => Number(r.id) === toEntityId)?.entity_type);

  // Check if there are any rules for this relationship type
  const ruleRows = await sql`
    SELECT source_entity_type_slug, target_entity_type_slug
    FROM entity_relationship_type_rules
    WHERE relationship_type_id = ${relationshipTypeId}
      AND deleted_at IS NULL
  `;

  // No rules = any pair is allowed
  if (ruleRows.length === 0) return;

  // Check if the pair matches any rule (check both directions for symmetric types)
  const matches = ruleRows.some((rule) => {
    const srcSlug = String(rule.source_entity_type_slug);
    const tgtSlug = String(rule.target_entity_type_slug);

    if (srcSlug === fromEntityType && tgtSlug === toEntityType) return true;
    if (isSymmetric && srcSlug === toEntityType && tgtSlug === fromEntityType) return true;
    return false;
  });

  if (!matches) {
    throw new ToolUserError(
      `Relationship type ${relationshipTypeId} does not allow ${fromEntityType} → ${toEntityType}`,
      400
    );
  }
}
