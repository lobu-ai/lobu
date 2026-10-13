/**
 * Entity Management Utility
 *
 * Minimal CRUD operations for entities table.
 * All validation handled by database constraints and triggers.
 * Organization scoping ensures data isolation.
 */

import { deriveToolActorSource } from './apply-context';
import type { EntityIdentity } from '@lobu/core/contracts/tools/manage-entity';
import { attachEntityIdentities, identityMemberIdsSql, identityRootSql } from './entity-identity';
import { type EntityReadRestrictions, entityReadPolicySql, entityReadRestrictions, filterEntityReadRows } from '../authz/entity-read-policy';
import type { EntityMetrics } from "@lobu/connector-sdk";
import { classifyToolError, getErrorMessage, slugify } from "@lobu/core";
import { VIEW_PATH_MARKER } from "@lobu/core/contracts/tools/view-path";
import type { AttributeFilter } from "@lobu/core/contracts/tools/collection-selection";
import { attributeFilterSql, validateAttributeFilters } from "./attribute-filters";
import { feedLinkedToBusinessEntitySql } from "../authz/channel-about";
import type {
	ValidatedEntityRowInsert,
	ValidatedEntityRowPatch,
} from "../authz/entity-row-validation";
import {
	EntityRowValidationError,
	validateEntityRowInsertGrantingApprovedFields,
	validateEntityRowPatch,
	validateEntityRowPatchGrantingApprovedFields,
} from "../authz/entity-row-validation";
import {
	deferEntityFieldChange,
	type DeferredMutation,
	type MutationAttribution,
	type MutationPrincipalKind,
	runMutationGate,
} from "../authz/entity-mutation-gate";
import {
	mutationPrincipalId,
	automationIdFromPrincipalId,
} from "../authz/entity-policy";
import { type DbClient, getDb, pgBigintArray, pgTextArray } from "../db/client";
import type { Env } from "../index";
import { entitySegmentPredicate } from "../metrics/compiler";
import { isAdminOrOwnerRole, isInProcessSystemCall } from "../tools/access-control";
import { querySqlImpl } from "../tools/admin/query_sql";
import type { ToolContext } from "../tools/registry";
import {
	buildEntityLinkBranches,
	entityLinkMatchSql,
	STANDARD_IDENTITY_NAMESPACES,
	type EntityIdentityScope,
} from "./content-search";
import { buildConnectionVisibilityClause } from "./content-search/visibility";
import {
	computeFieldMerge,
	type FieldControl,
	type FieldMergeResult,
	type FieldWriteSource,
} from "./entity-field-merge";
import {
	type EntityHookContext,
	type EntityTransactionHookContext,
	getEntityHooks,
} from "./entity-hooks";
import { ToolUserError, toolErrorHttpStatus } from "./errors";
import { EntityPolicyDenialError } from "./entity-write-denial-audit";
import { validateAndScopeQuery } from "./execute-data-sources";
import logger from "./logger";
import { requireWriteAccess } from "./organization-access";
import { RESERVED_ENTITY_TYPE_SLUGS } from "./reserved";
import {
	invalidateOrgAcl,
	lockOrgForAclInvalidation,
} from "../authz/acl-generation";
import { withAclPrivilege } from "./relationship-validation";

/** Minimal type shape needed to count stored vs derived entity rows. */
export type EntityTypeCountInput = {
	id: number;
	slug: string;
	backing_sql?: string | null;
	backing_source?: string | null;
};

/**
 * Count stored rows in `entities` for a type. Used where only physical rows
 * matter (e.g. blocking conversion of a populated type to a derived view).
 * Prefer {@link countEntitiesOfType} for display counts — that path also
 * counts derived views via the same executor as list/detail.
 */
export async function countStoredEntitiesOfType(
	typeId: number,
	organizationId: string,
	db: DbClient = getDb(),
): Promise<number> {
	const sql = db;
	const rows = await sql`
    SELECT COUNT(*)::int as count
    FROM entities e
    WHERE e.entity_type_id = ${typeId}
      AND e.organization_id = ${organizationId}
      AND e.deleted_at IS NULL
  `;
	return Number(rows[0]?.count || 0);
}

/**
 * Run a derived entity type's `backing_sql` through the shared `querySqlImpl`
 * executor (org-scoped internal tables or connection pushdown). List, detail
 * resolve, and type-level counts all go through this so pagination/total_count
 * stay consistent.
 */
export async function queryDerivedEntityView(
	backingSql: string,
	backingSource: string | undefined,
	page: { limit: number; offset: number; search?: string; filters?: AttributeFilter[]; sort_by?: string; sort_order?: "asc" | "desc" },
	ctx: ToolContext,
	options?: { preservePageRows?: boolean; exactSlug?: string },
): Promise<Awaited<ReturnType<typeof querySqlImpl>>> {
	// External sources receive typed selection and own dialect-safe pushdown.
	return querySqlImpl(
		{
			sql: backingSql,
			connection: backingSource,
			limit: page.limit,
			offset: page.offset,
			// The entity table defaults to created_at, which derived rows synthesize
			// on read. Preserve backing order instead of requiring that source column.
			sort_by: page.sort_by === "created_at" ? undefined : page.sort_by,
			sort_order: page.sort_order ?? "desc",
		},
		undefined,
		ctx,
		{
			// An empty selection still identifies a collection read: capable
			// sources can return its total without counting ordinary event reads.
			// Record lookups remain bounded and carry no collection selection.
			...(options?.exactSlug === undefined || page.search || page.filters?.length ? {
				selection: { filters: page.filters, search: page.search },
				stableIdentityColumns: [...DERIVED_SLUG_COLUMNS],
			} : {}),
			...(options?.preservePageRows
				? { maxSerializedResultBytes: Number.POSITIVE_INFINITY }
				: {}),
			...(options?.exactSlug !== undefined
				? { exactMatch: { columns: [...DERIVED_SLUG_COLUMNS], value: options.exactSlug } }
				: {}),
		},
	);
}

/**
 * Display count for one entity type: canonical stored roots, or the derived
 * view's `total_count` from {@link queryDerivedEntityView} (same path as list).
 * A failed derived query returns 0 so a broken view cannot poison type lists.
 */
export async function countEntitiesOfType(
	type: EntityTypeCountInput,
	ctx: ToolContext,
  readRestrictions?: EntityReadRestrictions,
): Promise<number> {
  const restrictions = readRestrictions ?? await entityReadRestrictions(getDb(), ctx);
  if (restrictions.some(rule => rule.entity_id === null && (rule.entity_type_slug === null || rule.entity_type_slug === type.slug))) return 0;
	if (type.backing_sql) {
		try {
			const result = await queryDerivedEntityView(
				type.backing_sql,
				type.backing_source ?? undefined,
				{ limit: 1, offset: 0 },
				ctx,
			);
			if (!result.error) return Number(result.total_count) || 0;
			logger.warn(
				{ err: result.error, entityType: type.slug },
				"Failed to count derived entity type rows",
			);
		} catch (err) {
			logger.warn(
				{ err, entityType: type.slug },
				"Failed to count derived entity type rows",
			);
		}
		return 0;
	}
	const params: unknown[] = [ctx.organizationId, type.id];
	const readPredicate = entityReadPolicySql(restrictions, 'e', params);
	const rows = await getDb().unsafe<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM entities e
    WHERE e.organization_id = $1 AND e.entity_type_id = $2 AND e.deleted_at IS NULL
      AND ${identityRootSql('e')} AND ${readPredicate}
  `, params);
  return Number(rows[0]?.count || 0);
}

/**
 * Batch display counts for entity-type list / bootstrap. One GROUP BY for all
 * stored roots, plus parallel derived view counts via
 * {@link countEntitiesOfType}.
 */
export async function getEntityCountsByTypes(
	types: EntityTypeCountInput[],
	ctx: ToolContext,
): Promise<Map<number, number>> {
	const counts = new Map<number, number>();
	if (types.length === 0) return counts;

	const restrictions = await entityReadRestrictions(getDb(), ctx);
	const stored = types.filter((t) => !t.backing_sql);
	const derived = types.filter((t) => !!t.backing_sql);

	if (stored.length > 0) {
		const sql = getDb();
		const params: unknown[] = [ctx.organizationId];
		const readPredicate = entityReadPolicySql(restrictions, 'e', params);
		const rows = await sql.unsafe<{ entity_type_id: number; entity_count: number }>(`
      SELECT e.entity_type_id AS entity_type_id, COUNT(*)::int as entity_count
      FROM entities e
      WHERE e.organization_id = $1
        AND e.deleted_at IS NULL
        AND ${identityRootSql('e')} AND ${readPredicate}
      GROUP BY e.entity_type_id
    `, params);
		for (const row of rows) {
			counts.set(Number(row.entity_type_id), Number(row.entity_count));
		}
	}

	if (derived.length > 0) {
		await Promise.all(
			derived.map(async (t) => {
				counts.set(t.id, await countEntitiesOfType(t, ctx, restrictions));
			}),
		);
	}

	return counts;
}

interface EntityCreateOptions {
	skipHooks?: boolean;
	hookContext?: EntityHookContext;
	/** Join an existing semantic mutation transaction when supplied. */
	sql?: DbClient;
	/**
	 * Fields a human already approved on a create card. Absent means none, so an
	 * escalate throws and the caller routes the create into an approval.
	 *
	 * See `validateEntityRowInsertGrantingApprovedFields`'s `approvedFields`.
	 */
	approvedFields?: readonly string[];
}

interface EntityUpdateOptions {
	/** Join an existing semantic mutation transaction when supplied. */
	sql?: DbClient;
	/** Keep an automatically derived label current until its name is customized. */
	derivedName?: {
		fields: readonly string[];
		compute: (metadata: Readonly<Record<string, unknown>>) => string;
	};
	/** Keyed identities keep their existing URL when their display label changes. */
	preserveSlug?: boolean;
	/**
	 * Semantic caller hook executed after the row write but before commit. Low-level
	 * projection writers omit it; manage_entity uses it for canonical entity.updated.
	 */
	afterPersist?: (
		before: {
			name: string | null;
			slug: string | null;
			parent_id: number | null;
			metadata: Record<string, unknown> | null;
			content: string | null;
		},
		after: CreatedEntity,
		tx: DbClient,
	) => Promise<void>;
	policyPrincipalKind?: MutationPrincipalKind;
	/** Attribution for a deferred approval of blocked fields. Defaults to 'agent'. */
	attribution?: MutationAttribution;
	/** Causal parent for a deferred approval run. */
	parentRunId?: number | null;
	/**
	 * The resolved acting-principal id (`automation:<id>` / agent id / null), from the
	 * shared {@link resolveActingPrincipal} seam. Used directly for per-principal
	 * policy matching — the caller owns identity resolution, not this function.
	 */
	principalId?: string | null;
	/**
	 * The automation's owning agent, folded into the gate so the agent's envelope
	 * binds an automation's direct update (a reaction script) — see the gate's
	 * `ownerAgentId`. Null for agent/user writes.
	 */
	ownerAgentId?: string | null;
	/**
	 * False iff an automation whose owning agent couldn't be resolved — the gate fails
	 * closed (deny). See the gate's `ownerResolved`. Defaults true.
	 */
	ownerResolved?: boolean;
}

// ============================================
// Shared Helpers
// ============================================

/**
 * Convert a numeric embedding array to a PostgreSQL vector literal.
 */
export function toVectorLiteral(
	embedding: number[] | null | undefined,
): string | null {
	if (!embedding || embedding.length === 0) return null;
	return `[${embedding.join(",")}]`;
}

// ============================================
// Type Definitions
// ============================================

export interface EntityData {
  entity_type: string;
  name: string;
  slug?: string; // Auto-generated from name if not provided
  parent_id?: number | null;

  // Organization scoping
  organization_id?: string;

  // Attribution: entities.created_by is NOT NULL and FK → user. Set explicitly by
  // the approval-apply path to the approving human (an automation/agent proposer isn't
  // a user row). Falls back to "system" — which is only valid where a matching
  // user exists — when omitted.
  created_by?: string | null;

  // Content & embeddings (used by memory entities and any content-bearing entity)
  content?: string | null;
  embedding?: number[] | null;
  content_hash?: string | null;

  // Metadata - contains all type-specific fields
  metadata?: Record<string, any>;

  // Optional human-correction note: on a human update it is stored on the
  // field_controls marker for every field this edit claims, so the automation (and
  // the UI) can show WHY the value was set. Ignored for agent/system writes.
  field_note?: string | null;

  // Approve/affirm: field names whose CURRENT value the human endorses as-is.
  // No value change, but ownership is claimed so an automation can't later overwrite
  // them without an approval. This is the "approve" half of the recap feedback
  // loop; "correct" is a normal metadata update. Ignored for agent/system writes.
  affirm_fields?: string[] | null;
}

export interface CreatedEntity {
  id: number;
  identity?: EntityIdentity;
  /** Internal ownership projection used to avoid cross-org audit anchors. */
  organization_id?: string;
  entity_type: string;
  name: string;
  slug: string;
  parent_id: number | null;
  parent_name?: string | null;
  parent_slug?: string | null;
  parent_entity_type?: string | null;
  metadata?: Record<string, any> | null;
  created_at: Date;
  total_content?: number | null;
  active_connections?: number | null;
  automations_count?: number | null;
  children_count?: number | null;
  warnings?: string[];
}

/**
 * Outcome of the ownership-aware merge in `updateEntity`, threaded out so the
 * caller can queue an approval for blocked (human-owned) fields. Kept off the
 * shared `CreatedEntity` interface — only `updateEntity`'s return carries it.
 */
export interface FieldMergeInfo {
  applied: string[];
  blocked: Record<string, { current: unknown; proposed: unknown }>;
}

// ============================================
// Transaction-bound row writes
// ============================================

/**
 * Join a caller-owned transaction or open one when the caller only has the
 * pool. The physical row helpers below deliberately never decide transaction
 * ownership themselves; entry points use this boundary before check-then-write
 * projections so every helper receives a real transaction handle.
 */
export function withEntityWriteTransaction<T>(
	db: DbClient,
	write: (tx: DbClient) => Promise<T>,
): Promise<T> {
	return typeof db.savepoint === "function" ? write(db) : db.begin(write);
}

/**
 * Physical entity-row values accepted by the internal write kernel.
 *
 * This is deliberately below the semantic CRUD layer: it performs no access,
 * policy, hook, schema, or hierarchy checks and never opens a transaction. A
 * caller must pass the pool/transaction handle that already owns those
 * decisions. Keeping the handle explicit lets projection writers join their
 * surrounding transaction without issuing entity SQL outside this module.
 */
export interface EntityRowInsert {
	organizationId: string;
	entityTypeId: number;
	name: string;
	slug: string;
	parentId?: number | null;
	metadata?: Record<string, unknown>;
	createdBy: string;
	content?: string | null;
	embedding?: number[] | null;
	contentHash?: string | null;
}

/** Columns the physical kernel may change without making selectors dynamic. */
export interface EntityRowPatch {
	name?: string;
	slug?: string;
	parentId?: number | null;
	metadata?: Record<string, unknown> | null;
	fieldControls?: Record<string, unknown>;
	content?: string | null;
	embedding?: number[] | null;
	/** true stamps deleted_at. This path never clears an existing tombstone. */
	softDelete?: boolean;
}

export interface InsertedEntityRow {
	id: number;
	name: string;
	slug: string;
	parent_id: number | null;
	metadata: Record<string, unknown> | null;
	created_at: Date;
}

async function insertEntityRowWithConflictMode(
	params: {
		tx: DbClient;
		row: EntityRowInsert;
	},
	onConflictDoNothing: boolean,
): Promise<InsertedEntityRow | null> {
	const { tx, row } = params;
	const embeddingLiteral = toVectorLiteral(row.embedding);
	const conflictClause = onConflictDoNothing ? tx`ON CONFLICT DO NOTHING` : tx``;
	const rows = await tx<InsertedEntityRow>`
    INSERT INTO entities (
      organization_id, entity_type_id, name, slug, parent_id, metadata,
      created_by, content, embedding, content_hash,
      created_at, updated_at
    ) VALUES (
      ${row.organizationId}, ${row.entityTypeId}, ${row.name}, ${row.slug},
      ${row.parentId ?? null}, ${tx.json(row.metadata ?? {})},
      ${row.createdBy}, ${row.content ?? null}, ${embeddingLiteral}::vector,
      ${row.contentHash ?? null}, current_timestamp, current_timestamp
    )
    ${conflictClause}
    RETURNING id, name, slug, parent_id, metadata, created_at
  `;
	return rows[0] ?? null;
}

/**
 * Insert one physical entity row using exactly the caller's DB handle.
 *
 * Takes only a validated row — mint one with `validateEntityRowInsert`, or
 * `unvalidatedEntityRowInsert` for platform bookkeeping outside tenant rules.
 * Same brand as {@link patchEntityRows}, for the same reason: skipping the
 * check has to be a compile error, not a thing a caller can simply forget.
 */
export async function insertEntityRow(params: {
	tx: DbClient;
	row: ValidatedEntityRowInsert;
}): Promise<InsertedEntityRow> {
	const inserted = await insertEntityRowWithConflictMode(params, false);
	if (!inserted) throw new Error("Failed to create entity");
	return inserted;
}

/**
 * Try one physical entity insert and return null on any uniqueness conflict.
 * This deliberately mirrors PostgreSQL's untargeted `ON CONFLICT DO NOTHING`;
 * callers own the domain-specific lookup that resolves the winning row.
 *
 * Validated-only, exactly like {@link insertEntityRow} — a create that routes
 * through the conflict-tolerant writer is still a create.
 */
export function tryInsertEntityRow(params: {
	tx: DbClient;
	row: ValidatedEntityRowInsert;
}): Promise<InsertedEntityRow | null> {
	return insertEntityRowWithConflictMode(params, true);
}

/**
 * Patch an explicit, bounded set of entity ids using the caller's DB handle.
 * Omitted fields remain unchanged; nullable fields distinguish null from
 * omission. Only live rows are patched — a tombstoned row is skipped, so this
 * path can never resurrect one. Every call touches updated_at, including a
 * fully blocked update whose patch ends up empty.
 *
 * Returns the ids actually written, ascending.
 */
export async function patchEntityRows(params: {
	tx: DbClient;
	ids: number[];
	/**
	 * Only a validated patch may be written. Mint one with
	 * `validateEntityRowPatch` (state rules run against the effective patch), or
	 * `unvalidatedEntityRowPatch` for platform bookkeeping outside tenant rules.
	 * The brand has no public constructor, so a caller that skips validation
	 * fails to compile rather than silently bypassing it.
	 */
	patch: ValidatedEntityRowPatch;
}): Promise<number[]> {
	if (params.ids.length === 0) return [];
	const { tx, patch } = params;
	const hasName = patch.name !== undefined;
	const hasSlug = patch.slug !== undefined;
	const hasParent = patch.parentId !== undefined;
	const hasMetadata = patch.metadata !== undefined;
	const hasFieldControls = patch.fieldControls !== undefined;
	const hasContent = patch.content !== undefined;
	const hasEmbedding = patch.embedding !== undefined;

	const idsLiteral = pgBigintArray(params.ids);
	const embeddingLiteral = toVectorLiteral(patch.embedding);
	const rows = await tx<{ id: number }>`
    UPDATE entities SET
      name = CASE WHEN ${hasName} THEN ${patch.name ?? null} ELSE name END,
      slug = CASE WHEN ${hasSlug} THEN ${patch.slug ?? null} ELSE slug END,
      parent_id = CASE WHEN ${hasParent} THEN ${patch.parentId ?? null}::bigint ELSE parent_id END,
      metadata = CASE WHEN ${hasMetadata} THEN ${patch.metadata == null ? null : tx.json(patch.metadata)} ELSE metadata END,
      field_controls = CASE WHEN ${hasFieldControls} THEN ${tx.json(patch.fieldControls ?? {})} ELSE field_controls END,
      content = CASE WHEN ${hasContent} THEN ${patch.content ?? null} ELSE content END,
      embedding = CASE WHEN ${hasEmbedding} THEN ${embeddingLiteral}::vector ELSE embedding END,
      deleted_at = CASE WHEN ${patch.softDelete === true} THEN current_timestamp ELSE deleted_at END,
      updated_at = current_timestamp
    WHERE id = ANY(${idsLiteral}::bigint[])
      AND deleted_at IS NULL
    RETURNING id
  `;
	return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}

/** Hard-delete an explicit, bounded set of entity ids on the caller's handle. */
export async function hardDeleteEntityRows(params: {
	tx: DbClient;
	ids: number[];
}): Promise<number[]> {
	if (params.ids.length === 0) return [];
	const idsLiteral = pgBigintArray(params.ids);
	const rows = await params.tx<{ id: number }>`
    DELETE FROM entities
    WHERE id = ANY(${idsLiteral}::bigint[])
    RETURNING id
  `;
	return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
}

/**
 * Lock one live entity in the caller's transaction, apply the pure ownership
 * merge, and persist the resulting metadata and controls through the physical
 * row kernel. Callers remain responsible for audit events or approval delivery.
 */
export async function mergeEntityFields(params: {
	tx: DbClient;
	entityId: number;
	fields: Record<string, unknown>;
	/** Governed top-level attributes from an approved composite proposal. */
	attributes?: Partial<Record<'$name' | '$parent_id' | '$content', unknown>>;
	source: FieldWriteSource;
	/** User id for a human edit; null/system otherwise. */
	actorId: string | null;
	note?: string | null;
	/** Snapshot the proposal was built on (deferred-apply staleness guard). */
	expectedCurrent?: Record<string, unknown> | null;
	/** Fields (human source) whose current value is approved as-is, claiming
	 * ownership without a value change. */
	affirm?: string[];
	/** Additional fields a non-human policy decision requires approval for. */
	requireApproval?: string[] | Set<string>;
	/**
	 * Set when this merge IS the application of a human-approved proposal, so a
	 * rule that escalates does not escalate the very write its escalation asked
	 * for. See `validateEntityRowPatchGrantingApprovedFields`'s `approvedFields`.
	 */
	approvedFields?: readonly string[];
	/** Assert caller-owned invariants on the full merge before validation or writes. */
	beforePersist?: (merge: FieldMergeResult) => void;
}): Promise<FieldMergeResult> {
	const { tx, entityId, fields, source, actorId } = params;
	const rows = await tx<{
		metadata: unknown; field_controls: unknown;
		name: string | null; parent_id: number | null; content: string | null;
	}>`
    SELECT metadata, field_controls, name, parent_id, content FROM entities
    WHERE id = ${entityId} AND deleted_at IS NULL
    FOR UPDATE
  `;
	if (rows.length === 0) {
		throw new Error(`Entity ${entityId} not found`);
	}

	const metadata = parseEntityJsonObject(rows[0].metadata);
	const controls = parseEntityJsonObject(rows[0].field_controls) as Record<
		string,
		FieldControl
	>;
	const merge = computeFieldMerge({
		metadata,
		controls,
		fields,
		source,
		actorId,
		note: params.note ?? null,
		nowIso: new Date().toISOString(),
		expectedCurrent: params.expectedCurrent ?? null,
		affirm: params.affirm,
		requireApproval: params.requireApproval,
	});
	const attributePatch: EntityRowPatch = {};
	const liveAttributes: Record<string, unknown> = {
		$name: rows[0].name ?? null,
		$parent_id: rows[0].parent_id == null ? null : Number(rows[0].parent_id),
		$content: rows[0].content ?? null,
	};
	for (const [field, proposed] of Object.entries(params.attributes ?? {})) {
		const live = liveAttributes[field];
		if (params.expectedCurrent && Object.hasOwn(params.expectedCurrent, field) &&
			JSON.stringify(live) !== JSON.stringify(params.expectedCurrent[field] ?? null)) {
			merge.stale[field] = { expected: params.expectedCurrent[field] ?? null, live };
			continue;
		}
		if (JSON.stringify(live) === JSON.stringify(proposed ?? null)) continue;
		if (source !== 'human' && new Set(params.requireApproval ?? []).has(field)) {
			merge.blocked[field] = { current: live, proposed };
			continue;
		}
		if (field === '$name') attributePatch.name = String(proposed ?? '');
		if (field === '$parent_id') attributePatch.parentId = proposed as number | null;
		if (field === '$content') attributePatch.content = proposed as string | null;
		merge.applied[field] = { old: live, new: proposed };
		merge.changed = true;
	}
	params.beforePersist?.(merge);

	if (merge.changed) {
		await patchEntityRows({
			tx,
			ids: [entityId],
			patch: await validateEntityRowPatchGrantingApprovedFields({
				tx,
				ids: [entityId],
				patch: {
					...attributePatch,
					metadata: merge.nextMetadata,
					fieldControls: merge.nextControls,
				},
				approvedFields: params.approvedFields ?? [],
			}),
		});
	}
	return merge;
}

function parseEntityJsonObject(value: unknown): Record<string, unknown> {
	if (value == null) return {};
	if (typeof value === "string") {
		try {
			return JSON.parse(value) as Record<string, unknown>;
		} catch {
			return {};
		}
	}
	return value as Record<string, unknown>;
}

// ============================================
// Validation Helpers
// ============================================

/**
 * What the rule says about the write the caller ACTUALLY proposed — `null` if it
 * is outright legal.
 *
 * A hold can split a legal write into an illegal fragment, and rescuing that is
 * the whole point of deferring. But the rescue only makes sense measured against
 * the FULL proposal, because that is what a card replays:
 *
 *  - deny → the caller's own proposal is illegal. Deferring would mint a card no
 *    approval could clear, so the denial stands. Returning it (rather than a
 *    boolean) lets the caller fail in the proposer's own terms; throwing the
 *    RESIDUAL's error would describe a write nobody made.
 *  - escalate → the card is right, and `fields` is what it must record. The
 *    caught residual verdict cannot supply that: the residual may have DENIED
 *    while the full proposal escalates, and a card recording no escalated fields
 *    is stuck the moment it is approved.
 *
 * A rule that crashes or times out reads as a deny, so a broken rule surfaces as
 * an error rather than an unanswerable approval.
 */
async function fullProposalVerdict(params: {
	tx: DbClient;
	entityId: number;
	patch: EntityRowPatch;
}): Promise<EntityRowValidationError | null> {
	try {
		await validateEntityRowPatch({
			tx: params.tx,
			ids: [params.entityId],
			patch: params.patch,
		});
		return null;
	} catch (err) {
		if (!(err instanceof EntityRowValidationError)) throw err;
		return err;
	}
}

/**
 * Check for circular parent references in entity hierarchy.
 * Replaces the PostgreSQL `prevent_entity_cycles()` trigger.
 *
 * Walks up the ancestor chain from the proposed parent_id.
 * If we encounter `entityId` as an ancestor, that would create a cycle.
 */
async function preventEntityCycles(
	entityId: number | null,
	parentId: number | null,
	db: DbClient = getDb(),
): Promise<void> {
  if (parentId === null) return;

  const sql = db;
  const MAX_DEPTH = 10;
  let currentId: number | null = parentId;
  let depth = 0;

  while (currentId !== null) {
    if ((entityId !== null && currentId === entityId) || ++depth >= MAX_DEPTH) {
      throw new Error('Circular reference detected or hierarchy too deep (max 10 levels)');
    }

    const rows: Array<Record<string, unknown>> = await sql`
      SELECT parent_id FROM entities WHERE id = ${currentId}
    `;
    currentId = rows.length > 0 ? (rows[0].parent_id as number | null) : null;
  }
}

/** Collect the entity and its parent hierarchy descendants for a force delete. */
async function loadEntityTreeIds(sql: DbClient, entityId: number): Promise<number[]> {
  const rows = await sql<{ id: number }>`
    WITH RECURSIVE entity_tree AS (
      SELECT id
      FROM entities
      WHERE id = ${entityId}
      UNION
      SELECT e.id
      FROM entities e
      JOIN entity_tree et ON e.parent_id = et.id
    )
    SELECT id
    FROM entity_tree
  `;

  return rows.map((row) => Number(row.id));
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Create new entity
 * Entity is created in the user's organization
 */
/** `-` marks where a host path ends and a view begins (`/<type>/<slug>/-/views/<key>`),
 *  so a record stored under it would have an unreachable page. */
function assertSlugIsNotViewMarker(slug: string | null | undefined): void {
	if (slug === VIEW_PATH_MARKER) {
		throw new ToolUserError(
			`Slug '${VIEW_PATH_MARKER}' is reserved: it marks a view in page URLs`,
			400,
		);
	}
}

export async function createEntity(
	data: EntityData,
	opts?: EntityCreateOptions,
): Promise<CreatedEntity> {
	// Input validation
	if (!data.name || data.name.trim().length === 0) {
		throw new Error("Entity name is required");
	}

	if (!data.entity_type || data.entity_type.trim().length === 0) {
		throw new Error("Entity type is required");
	}

	// Illegal type *names* that are not knowledge types (routes / product words).
	// System types ($member, $resource) are valid entity instance types.
	if (
		(RESERVED_ENTITY_TYPE_SLUGS as readonly string[]).includes(
			data.entity_type.toLowerCase(),
		)
	) {
		throw new Error(
			`Cannot create entity with reserved type '${data.entity_type}'. Reserved: ${RESERVED_ENTITY_TYPE_SLUGS.join(", ")}`,
		);
	}

	if (!data.organization_id) {
		throw new Error("Organization ID is required");
	}

	assertSlugIsNotViewMarker(data.slug);
	const sql = opts?.sql ?? getDb();

	try {
		const created = await withEntityWriteTransaction(sql, async (tx) => {
			let createData = data;
			if (!opts?.skipHooks && opts?.hookContext) {
				const hooks = getEntityHooks(createData.entity_type);
				if (hooks?.beforeCreate) {
					createData = await hooks.beforeCreate(createData, {
						...opts.hookContext,
						sql: tx,
					});
				}
			}

			// Resolve entity_type slug → entity_types(id) via the schema search path:
			// tenant-local types win, then public catalog types.
			const typeRow = await tx<{ id: number; backing_sql: string | null }>`
        SELECT et.id, et.backing_sql
        FROM entity_types et
        LEFT JOIN organization o ON o.id = et.organization_id
        WHERE et.slug = ${createData.entity_type}
          AND et.deleted_at IS NULL
          AND (
            et.organization_id = ${createData.organization_id}
            OR o.visibility = 'public'
          )
        ORDER BY (et.organization_id = ${createData.organization_id}) DESC, et.id ASC
        LIMIT 1
      `;
			if (typeRow.length === 0) {
				throw new ToolUserError(
					`Unknown entity type '${createData.entity_type}'. Use client.entitySchema.listTypes() to list available types or client.entitySchema.createType(...) to create a custom type first.`,
					400,
				);
			}
			if (typeRow[0].backing_sql) {
				throw new ToolUserError(
					`Entity type '${createData.entity_type}' is derived (a SQL view) and has no stored rows. Edit its backing view instead of creating entities.`,
					400,
				);
			}

			if (createData.parent_id) {
				await preventEntityCycles(null, createData.parent_id, tx);
			}

			const inserted = await insertEntityRow({
				tx,
				// THE create path. Everything a tenant, an agent or the API creates
				// arrives here, so this is where a rule has to be able to reject a row
				// born in a state no transition would have reached.
				row: await validateEntityRowInsertGrantingApprovedFields({
					tx,
					row: {
						organizationId: createData.organization_id as string,
						entityTypeId: typeRow[0].id,
						name: createData.name.trim(),
						slug: createData.slug || slugify(createData.name),
						parentId: createData.parent_id || null,
						metadata: { ...createData.metadata },
						createdBy: createData.created_by || "system",
						content: createData.content?.trim() || null,
						embedding: createData.embedding,
						contentHash: createData.content_hash || null,
					},
					approvedFields: opts?.approvedFields ?? [],
				}),
			});
			return { ...inserted, entity_type: createData.entity_type };
		});

		// Run afterCreate hook
		if (!opts?.skipHooks && opts?.hookContext) {
			const hooks = getEntityHooks(created.entity_type);
			if (hooks?.afterCreate) {
				await hooks.afterCreate(created, opts.hookContext);
			}
		}

		return created;
	} catch (error: any) {
		const msg = error.message ?? "";

		// Handle database constraint violations
		if (msg.includes("duplicate key") || msg.includes("unique constraint")) {
			throw new Error("Entity already exists with this name or unique field");
		}
		if (msg.includes("foreign key")) {
			if (data.parent_id) {
				throw new Error(`Parent entity ${data.parent_id} does not exist`);
			}
			throw new Error(`Foreign key violation: ${msg}`);
		}
		if (msg.includes("check constraint")) {
			throw new Error(`Invalid entity data: ${msg}`);
		}
		if (msg.includes("Circular reference")) {
			throw new Error("Cannot create circular entity hierarchy");
		}
		throw error;
	}
}

/**
 * Update existing entity
 * Database handles validation
 * Requires write access (entity must belong to user's organization)
 */
export async function updateEntity(
	entityId: number,
	data: Partial<EntityData>,
	_env: Env,
	ctx: ToolContext,
	opts?: EntityUpdateOptions,
): Promise<
	CreatedEntity & { fieldMerge?: FieldMergeInfo; deferred?: DeferredMutation }
> {
	const sql = opts?.sql ?? getDb();
	if (opts?.derivedName && data.name !== undefined) {
		throw new Error("An explicit name cannot also be derived from metadata");
	}

	// Validate write access (uses PG for auth tables)
	await requireWriteAccess(sql, entityId, ctx);

	// Validate parent hierarchy (replaces prevent_entity_cycles trigger)
	if (data.parent_id !== undefined && data.parent_id !== null) {
		await preventEntityCycles(entityId, data.parent_id, sql);
	}

	assertSlugIsNotViewMarker(data.slug);

	// Generate new slug if provided or name is being updated
	const newSlug = data.slug ?? (data.name ? slugify(data.name) : null);

	const metadataUpdates = { ...data.metadata };
	const hasMetadataUpdates = Object.keys(metadataUpdates).length > 0;
	const affirmFields = Array.isArray(data.affirm_fields)
		? data.affirm_fields
		: [];

	// A genuine human edit (a real user, not an agent run) claims per-field
	// ownership so an automation can't later overwrite it without an approval. Every
	// non-human write (chat agent or automation reaction via manage_entity) is an
	// ownership-aware automation-source merge: unowned fields write, owned fields
	// are blocked and surfaced to the caller for an approval. There is no
	// plain-merge branch — the only caller is agent-attributed.
	const isHumanEdit = !!ctx.userId && !ctx.agentId;
	// affirm_fields claims ownership, which only a human may do. An agent must
	// never silently claim a field — reject before touching the transaction.
	if (!isHumanEdit && affirmFields.length > 0) {
		throw new Error("affirm_fields is only allowed for human edits");
	}

	const hasContent = data.content !== undefined;
	const contentValue = data.content?.trim() || null;
	const hasEmbedding = data.embedding !== undefined;

	// An affirm-only edit (approve a value as-is) has no metadata delta but still
	// must run the merge so it can claim field ownership.
	const hasAffirm = isHumanEdit && affirmFields.length > 0;

	// Outcome of the ownership-aware merge, threaded out so the caller can queue
	// an approval for blocked (human-owned) fields AFTER the tx commits.
	let fieldMerge: FieldMergeInfo | undefined;

	// Lock the entity row, merge metadata, and write in ONE transaction: concurrent
	// updates to the same entity serialize on the row lock, fixing the pre-existing
	// non-transactional read-modify-write race on entities.metadata.
	const result = await withEntityWriteTransaction(sql, async (tx) => {
		// Resolve the type before any lock: `beforeUpdate` exists so a hook can
		// claim a coarser lock (e.g. the organization row) ahead of the entity
		// row, which the `current` SELECT below takes.
		const [type] = await tx`
			SELECT et.slug FROM entities e
			JOIN entity_types et ON et.id = e.entity_type_id
			WHERE e.id = ${entityId}
			  AND e.organization_id = ${ctx.organizationId}
			  AND e.deleted_at IS NULL
		`;
		const hooks = type ? getEntityHooks(type.slug as string) : undefined;
		const hookContext: EntityTransactionHookContext = {
			organizationId: ctx.organizationId,
			userId: ctx.userId,
			env: _env,
			sql: tx,
			scopes: ctx.scopes,
			actorSource: deriveToolActorSource(ctx),
		};
		await hooks?.beforeUpdate?.(metadataUpdates, hookContext);
		// Canonical change events take an organization FK lock before commit. Claim
		// it before the entity row so organization deletion cannot hold the parent
		// while waiting on this row in the opposite order.
		await tx`
			SELECT 1 FROM organization
			WHERE id = ${ctx.organizationId}
			FOR KEY SHARE
		`;
		const current = await tx`
      SELECT e.metadata, e.field_controls, e.organization_id, et.slug AS entity_type,
             e.name, e.slug, e.parent_id, e.content
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${entityId} AND e.deleted_at IS NULL
      FOR UPDATE
    `;
		if (current.length === 0) {
			throw new Error(`Entity ${entityId} not found`);
		}

		const existing = (
			typeof current[0].metadata === "string"
				? JSON.parse(current[0].metadata as string)
				: (current[0].metadata ?? {})
		) as Record<string, unknown>;
		const existingControls = (
			typeof current[0].field_controls === "string"
				? JSON.parse(current[0].field_controls as string)
				: (current[0].field_controls ?? {})
		) as Record<string, FieldControl>;
		// There is no ownership marker for top-level names. Only keep deriving a
		// label that still matches its prior projection; a custom or already
		// divergent label is preserved. This comparison stays under the row lock.
		const derivedName = opts?.derivedName &&
			current[0].name === opts.derivedName.compute(existing)
			? opts.derivedName : undefined;
		const proposedName = data.name ?? derivedName?.compute({ ...existing, ...metadataUpdates });
		let effectiveName = proposedName;
		const namingFieldsProposed = derivedName?.fields.some((field) =>
			Object.hasOwn(metadataUpdates, field) &&
			JSON.stringify(existing[field] ?? null) !== JSON.stringify(metadataUpdates[field] ?? null)
		) ?? false;

		// Non-human edits run ONE policy pass over metadata fields AND the
		// top-level attributes (name/content/parent_id as reserved $-paths, so a
		// field-scoped policy can target them too). A gated attribute is stripped
		// from this write and queued as a blocked change like any owned field —
		// otherwise "updates need approval" would gate metadata while an agent
		// could still rename or re-parent the entity.
		const requireApproval: string[] = [];
		const blockedAttributes: Record<
			string,
			{ current: unknown; proposed: unknown }
		> = {};
		let applyName = proposedName !== undefined;
		let applyParent = data.parent_id !== undefined;
		let applyContent = hasContent;
		// Computed for EVERY caller, not just the gated ones: when a write defers
		// as a whole, the card has to name every field the caller PROPOSED, and a
		// rule can escalate a human edit just as readily as an agent's.
		const attributeProposals: Record<
			string,
			{ current: unknown; proposed: unknown }
		> = {};
		if (applyName && (namingFieldsProposed || (proposedName ?? null) !== (current[0].name ?? null))) {
			attributeProposals.$name = {
				current: current[0].name ?? null,
				proposed: proposedName ?? null,
			};
		}
		const currentParentId =
			current[0].parent_id == null ? null : Number(current[0].parent_id);
		if (applyParent && (data.parent_id ?? null) !== currentParentId) {
			attributeProposals.$parent_id = {
				current: currentParentId,
				proposed: data.parent_id ?? null,
			};
		}
		if (
			applyContent &&
			contentValue !== ((current[0].content as string | null) ?? null)
		) {
			attributeProposals.$content = {
				current: current[0].content ?? null,
				proposed: contentValue,
			};
		}
		if (!isHumanEdit) {
			const principalKind: MutationPrincipalKind =
				opts?.policyPrincipalKind ?? "agent";
			const fieldOwners = {
				...(Object.fromEntries(
					Object.keys(metadataUpdates).map((field) => [
						field,
						Object.hasOwn(existingControls, field) ? "human" : "none",
					]),
				) as Record<string, "human" | "none">),
				...(Object.fromEntries(
					Object.keys(attributeProposals).map((attr) => [attr, "none"]),
				) as Record<string, "none">),
			};
			if (Object.keys(fieldOwners).length > 0) {
				const decision = await runMutationGate({
					action: "update",
					organizationId: ctx.organizationId,
					principalKind,
					sql: tx,
					attribution: opts?.attribution ?? "agent",
					parentRunId: opts?.parentRunId ?? null,
					principalId:
						opts?.principalId ??
						mutationPrincipalId({ agentId: ctx.agentId }),
					ownerAgentId: opts?.ownerAgentId ?? null,
					ownerResolved: opts?.ownerResolved ?? true,
					entityTypeSlug: String(current[0].entity_type),
					entityId,
					entityOrgId: String(current[0].organization_id),
					fields: fieldOwners,
				});
				if (decision.outcome === "deny") {
					throw new EntityPolicyDenialError({
						operation: "update",
						reason: decision.reason,
						deniedFields: Object.keys(fieldOwners),
						entityId,
						entityType: String(current[0].entity_type),
						entityOrganizationId: String(current[0].organization_id),
					});
				}
				for (const field of decision.requireApproval) {
					if (attributeProposals[field]) {
						blockedAttributes[field] = attributeProposals[field];
						if (field === "$name") applyName = false;
						if (field === "$parent_id") applyParent = false;
						if (field === "$content") applyContent = false;
					} else {
						requireApproval.push(field);
					}
				}
			}
		}

		// Holding the derived label must also hold its changing inputs. Otherwise
		// this write itself creates a name/metadata mismatch that the next
		// promotion mistakes for a custom label, permanently losing tracking.
		if (derivedName && blockedAttributes.$name) {
			for (const field of derivedName.fields) {
				if (Object.hasOwn(metadataUpdates, field) &&
					JSON.stringify(existing[field] ?? null) !== JSON.stringify(metadataUpdates[field] ?? null) &&
					!requireApproval.includes(field)) {
					requireApproval.push(field);
				}
			}
		}

		let mergedMetadata: Record<string, unknown> | null = null;
		let mergedControls: Record<string, unknown> | null = null;
		if (hasMetadataUpdates || hasAffirm) {
			const merge = computeFieldMerge({
				metadata: existing,
				controls: existingControls,
				fields: metadataUpdates,
				source: isHumanEdit ? "human" : "automation",
				actorId: isHumanEdit
					? ctx.userId
					: (ctx.agentId ?? ctx.clientId ?? null),
				note: isHumanEdit ? (data.field_note ?? null) : null,
				nowIso: new Date().toISOString(),
				affirm: isHumanEdit ? affirmFields : undefined,
				requireApproval,
			});
			mergedMetadata = merge.nextMetadata;
			// A human edit claims ownership of the fields it sets; an automation-source
			// merge never claims ownership, so leave field_controls untouched.
			mergedControls = isHumanEdit && merge.changed ? merge.nextControls : null;
			fieldMerge = {
				applied: Object.keys(merge.applied),
				blocked: Object.fromEntries(
					Object.entries(merge.blocked).map(([p, v]) => [
						p,
						{ current: v.current, proposed: v.proposed },
					]),
				),
			};
		}
		if (derivedName && mergedMetadata) {
			// A held metadata value must never leak into the visible title. The
			// full proposal still retains its corresponding name for approval.
			effectiveName = derivedName.compute(mergedMetadata);
			if (effectiveName !== proposedName) {
				blockedAttributes.$name = {
					current: applyName ? effectiveName : current[0].name ?? null,
					proposed: proposedName ?? null,
				};
			}
		}
		if (Object.keys(blockedAttributes).length > 0) {
			fieldMerge = {
				applied: fieldMerge?.applied ?? [],
				blocked: { ...(fieldMerge?.blocked ?? {}), ...blockedAttributes },
			};
		}

		const rowPatch: EntityRowPatch = {};
		if (applyName && effectiveName !== undefined && effectiveName !== current[0].name) {
			rowPatch.name = effectiveName;
		}
		const slugPatch = opts?.preserveSlug ? null : data.slug ?? (applyName ? newSlug : null);
		if (slugPatch !== null) rowPatch.slug = slugPatch;
		if (applyParent) rowPatch.parentId = data.parent_id ?? null;
		if (hasMetadataUpdates && fieldMerge?.applied.length) rowPatch.metadata = mergedMetadata;
		if (mergedControls !== null) rowPatch.fieldControls = mergedControls;
		if (applyContent) rowPatch.content = contentValue;
		if (hasEmbedding && (applyContent || !hasContent)) {
			rowPatch.embedding = data.embedding ?? null;
		}
		// Validate the EFFECTIVE patch, not the caller's proposal: approval-held
		// fields were stripped above and the ownership merge rewrote the rest, so
		// this is the first point where what-will-commit is known.
		//
		// That also means a hold can hand the rule a write nobody proposed. An
		// agent proposing a legal `issued -> posted` plus the field that move
		// unlocks gets `status` stripped (human-owned), leaving a naked field edit
		// in a frozen state — illegal. The proposal was legal; the SPLIT was not.
		//
		// So an approval hold may not manufacture an illegal state: when the
		// residual fails and fields were held, nothing commits and the ENTIRE
		// proposal defers as one approval unit.
		let deferWholeWrite: string | null = null;
		// What the rule named when it escalated — carried onto the card so applying
		// it waives exactly these and nothing else.
		let deferEscalatedFields: string[] = [];
		let validated: ValidatedEntityRowPatch | null = null;
		try {
			// A replay with no inline changes must not become a new rule verdict
			// or refresh updated_at. Ownership-held fields still queue below.
			if (Object.keys(rowPatch).length > 0) {
				validated = await validateEntityRowPatch({
					tx,
					ids: [entityId],
					patch: rowPatch,
				});
			}
		} catch (err) {
			if (!(err instanceof EntityRowValidationError)) throw err;
			const heldFields = Object.keys(fieldMerge?.blocked ?? {});

			// Whatever the verdict, the card replays the FULL proposal — so the full
			// proposal is what has to be legal. Only a SPLIT write may be rescued: if
			// the caller's own proposal is illegal too, deferring would mint a card no
			// approval could clear, because applying re-runs validation and a deny
			// throws in approved mode.
			//
			// Checked for BOTH outcomes, not just deny. A rule can escalate the
			// residual while denying the full proposal — approving then skips the
			// escalate and hits the deny, which is the same dead end by a longer road.
			//
			// Skipped when nothing was held: the residual IS the full proposal then,
			// so the rule has already answered this exact question.
			const fullVerdict =
				heldFields.length > 0
					? await fullProposalVerdict({
							tx,
							entityId,
							patch: {
								...rowPatch,
								metadata: {
									...(mergedMetadata ?? existing),
									...metadataUpdates,
								},
								...(attributeProposals.$name
									? { name: attributeProposals.$name.proposed as string }
									: {}),
								...(attributeProposals.$parent_id
									? {
											parentId: attributeProposals.$parent_id.proposed as
												| number
												| null,
										}
									: {}),
								...(attributeProposals.$content
									? {
											content: attributeProposals.$content.proposed as
												| string
												| null,
										}
									: {}),
							},
						})
					: null;
			// Stated in the terms the caller proposed, not the residual's.
			if (fullVerdict?.verdict.outcome === "deny") throw fullVerdict;

			// Prefer the FULL proposal's escalation: that is the write the card
			// replays, so its fields are what the approver is consenting to. The
			// residual's verdict only stands in when nothing was held.
			const escalation =
				fullVerdict?.verdict.outcome === "escalate"
					? fullVerdict.verdict
					: heldFields.length === 0 && err.verdict.outcome === "escalate"
						? err.verdict
						: null;

			if (escalation) {
				// `escalate(fields, reason)` documents those fields as what the
				// approver reads; the card itself carries the whole proposal.
				deferEscalatedFields = escalation.fields;
				deferWholeWrite =
					escalation.fields.length > 0
						? `${escalation.reason} (${escalation.fields.join(", ")})`
						: escalation.reason;
			} else if (heldFields.length > 0) {
				deferWholeWrite =
					`${err.verdict.reason} — the write is legal as proposed but ` +
					`${heldFields.join(", ")} awaits approval, so it applies as one unit`;
			} else {
				throw err;
			}
		}

		// The full proposal, for a deferral that must carry what the caller asked
		// for rather than the mutilated remainder.
		const proposedFields: Record<string, unknown> = {
			...metadataUpdates,
			...Object.fromEntries(
				Object.entries(attributeProposals).map(([k, v]) => [k, v.proposed]),
			),
		};
		const proposedCurrent: Record<string, unknown> = {
			...Object.fromEntries(
				Object.keys(metadataUpdates).map((k) => [k, existing[k] ?? null]),
			),
			...Object.fromEntries(
				Object.entries(attributeProposals).map(([k, v]) => [k, v.current]),
			),
		};

		if (validated) {
			await patchEntityRows({ tx, ids: [entityId], patch: validated });
			if (rowPatch.name !== undefined && rowPatch.name !== current[0].name) {
				fieldMerge = {
					applied: [...(fieldMerge?.applied ?? []), "$name"],
					blocked: fieldMerge?.blocked ?? {},
				};
			}
		} else if (deferWholeWrite) {
			// Nothing applied, so report every proposed field as blocked rather than
			// letting `fieldMerge.applied` claim a write that did not happen.
			fieldMerge = {
				applied: [],
				blocked: Object.fromEntries(
					Object.keys(proposedFields).map((k) => [
						k,
						{ current: proposedCurrent[k] ?? null, proposed: proposedFields[k] },
					]),
				),
			};
		}

    const sel = await tx<CreatedEntity>`
      SELECT e.id, et.slug AS entity_type, e.name, e.slug, e.parent_id, e.metadata, e.created_at
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${entityId}
      LIMIT 1
    `;
		if (sel.length === 0) {
			throw new Error(`Entity ${entityId} not found`);
		}
		const updated = {
			...sel[0],
			fieldMerge,
			deferWholeWrite,
			deferEscalatedFields,
			proposedFields,
			proposedCurrent,
		} as CreatedEntity & {
			fieldMerge?: FieldMergeInfo;
			deferWholeWrite: string | null;
			deferEscalatedFields: string[];
			proposedFields: Record<string, unknown>;
			proposedCurrent: Record<string, unknown>;
		};
		if (validated) {
			await hooks?.afterUpdate?.(
				{ id: entityId, metadata: existing },
				updated,
				hookContext,
			);
		}
		await opts?.afterPersist?.(
			{
				name: (current[0].name as string | null) ?? null,
				slug: (current[0].slug as string | null) ?? null,
				parent_id:
					current[0].parent_id == null ? null : Number(current[0].parent_id),
				metadata:
					(current[0].metadata as Record<string, unknown> | null) ?? null,
				content: (current[0].content as string | null) ?? null,
			},
			updated,
			tx,
		);
		return updated;
	});

	// Split the deferral inputs off the returned row: they are this function's
	// own bookkeeping, and every caller downstream reads `entity` as an entity.
	const {
		deferWholeWrite,
		deferEscalatedFields,
		proposedFields,
		proposedCurrent,
		...entity
	} = result;

	// Post-commit: package any blocked (human-owned or policy-gated) fields as a
	// single deferred approval. The caller queues it AFTER its own tx + change
	// event so the approval never rides — nor rolls back with — the edit.
	// A write held back in full: the card carries the entire proposal, so approving
	// it re-runs the whole thing as one legal transition instead of the fragment
	// that could not stand on its own.
	if (deferWholeWrite) {
		return {
			...entity,
			deferred: deferEntityFieldChange({
				entityId,
				fields: proposedFields,
				current: proposedCurrent,
				reason: deferWholeWrite,
				escalatedFields: deferEscalatedFields,
				attribution: opts?.attribution ?? "agent",
				automationId: automationIdFromPrincipalId(opts?.principalId ?? null),
				parentRunId: opts?.parentRunId ?? null,
			}),
		};
	}

	const blockedPaths = Object.keys(entity.fieldMerge?.blocked ?? {});
	if (blockedPaths.length > 0) {
		const blocked = entity.fieldMerge?.blocked ?? {};
		return {
			...entity,
			deferred: deferEntityFieldChange({
				entityId,
				fields: Object.fromEntries(
					blockedPaths.map((p) => [p, blocked[p].proposed]),
				),
				current: Object.fromEntries(
					blockedPaths.map((p) => [p, blocked[p].current]),
				),
				attribution: opts?.attribution ?? "agent",
				// The approval card groups by the acting automation; recover its numeric
				// id from the resolved principalId (`automation:<id>`), null otherwise.
				automationId: automationIdFromPrincipalId(opts?.principalId ?? null),
				parentRunId: opts?.parentRunId ?? null,
			}),
		};
	}

	return entity;
}

/**
 * Get entity by ID
 * Only returns entity if user has read access (own org or public)
 */
export async function getEntity(
	entityId: number,
	_env: Env,
	ctx: ToolContext,
	opts?: { includeDeleted?: boolean; readRestrictions?: EntityReadRestrictions },
): Promise<CreatedEntity | null> {
  const sql = getDb();
  if (!ctx.organizationId) return null;
  const includeDeleted = opts?.includeDeleted ?? false;

  // Operational counts always scope to the caller's org. When `e` is a
  // public-catalog entity, totals reflect the caller's events/feeds/automations/
  // children that reference it — never cross-tenant activity around the
  // public row.
  //
  // Visibility branches checked here:
  //   1. caller's own org (always readable)
  //   2. public-catalog entity (anyone reads, except `$member`)
  const visibility = buildConnectionVisibilityClause({
    organizationId: ctx.organizationId, userId: ctx.userId, baseParamIndex: 3,
  }, 'ev');
  const params: unknown[] = [ctx.organizationId, entityId, ...visibility.params];
  const restrictions = opts?.readRestrictions ?? [];
  const readPredicate = entityReadPolicySql(restrictions, 'e', params);
  const parentReadPredicate = entityReadPolicySql(restrictions, 'pe', params);
  const childReadPredicate = entityReadPolicySql(restrictions, 'c', params);
  const result = await sql.unsafe<CreatedEntity>(`
    SELECT
      e.id, e.organization_id, et.slug AS entity_type, e.name, e.slug, pe.id AS parent_id, e.metadata, e.created_at,
      pe.name as parent_name, pe.slug as parent_slug, pet.slug as parent_entity_type,
      (
        SELECT COUNT(*) FROM current_event_records ev
        WHERE ${entityLinkMatchSql('e.id::bigint', 'ev')}
          AND ev.organization_id = $1 ${visibility.sql}
      ) as total_content,
      (
        SELECT COUNT(DISTINCT c.connector_key)
        FROM feeds f
        JOIN connections c ON c.id = f.connection_id
        WHERE f.organization_id = $1
          AND f.deleted_at IS NULL
          AND c.deleted_at IS NULL
          AND ${feedLinkedToBusinessEntitySql('e.id', 'f', 'c', 'e.organization_id')}
      ) as active_connections,
      (
        SELECT COUNT(*) FROM automations i
        WHERE e.id = ANY(i.entity_ids)
          AND i.organization_id = $1
      ) as automations_count,
      (
        SELECT COUNT(*) FROM entities c
        WHERE c.parent_id = e.id
          AND c.organization_id = $1
          AND c.deleted_at IS NULL AND ${childReadPredicate}
      ) as children_count
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities pe ON e.parent_id = pe.id AND ${parentReadPredicate}
    LEFT JOIN entity_types pet ON pet.id = pe.entity_type_id
    LEFT JOIN organization eo ON eo.id = e.organization_id
    WHERE e.id = $2
      AND (
        e.organization_id = $1
        OR (eo.visibility = 'public' AND et.slug <> '$member')
      )
      ${includeDeleted ? '' : 'AND e.deleted_at IS NULL'}
      AND ${readPredicate}
  `, params);

  return (await filterEntityReadRows(sql, await attachEntityIdentities(sql, result), restrictions))[0] ?? null;
}

/**
 * Force-delete dependency report: what a hard delete of the tree removes or
 * detaches. Computed up front so `dry_run` can return it without mutating; a
 * real delete refreshes `events_detached` from the rows its transaction
 * actually changed. Event rows are append-only and are only ever detached,
 * never deleted.
 */
export interface ForceDeleteTreeReport {
  entities: number;
  relationships: number;
  automations_deleted: number;
  automations_detached: number;
  feeds_deleted: number;
  feeds_detached: number;
  events_detached: number;
}

/**
 * Delete entity
 * Soft delete by default (sets deleted_at), hard delete with force=true.
 * A hard delete removes the tree + its relationships, deletes/detaches
 * dependent automations and feeds, and detaches (never deletes) event rows that
 * reference the tree. `dryRun` returns the dependency report without mutating.
 * Requires write access (entity must belong to user's organization)
 */
export async function deleteEntity(
	entityId: number,
	force: boolean = false,
	_env: Env,
	ctx: ToolContext,
	opts?: {
		skipHooks?: boolean;
		dryRun?: boolean;
		/** Join an existing semantic mutation transaction when supplied. */
		sql?: DbClient;
		/**
		 * Set only when this call IS the application of a delete a human already
		 * approved, so a rule that escalates on the delete does not escalate the
		 * very delete its escalation asked for — the dead end
		 * `validateEntityRowPatchGrantingApprovedFields` exists to prevent for
		 * field edits. An ordinary caller passes nothing and an escalate stops it.
		 */
		approvedFields?: readonly string[];
	},
): Promise<{
  message: string;
  deleted: number;
  dry_run?: boolean;
  tree?: ForceDeleteTreeReport;
  /**
   * Dry run only: a write rule refuses this delete. Structured rather than left
   * for the caller to sniff out of `message`, because a caller that pattern-
   * matched the prose would silently start lying the day the wording changed.
   */
  refused?: true;
}> {
	const sql = opts?.sql ?? getDb();

  // Validate write access (uses PG for auth tables)
	await requireWriteAccess(sql, entityId, ctx);

  // Resolve and run the hook only after the row rule has accepted the delete.
  // Reloading the row inside the write transaction keeps hook cleanup aligned
  // with the metadata version that is actually deleted.
  const runBeforeDeleteHook =
    !opts?.skipHooks && !opts?.dryRun
      ? async (tx: DbClient): Promise<void> => {
          const [entityRow] = await tx<{
            entity_type: string;
            metadata: Record<string, unknown> | null;
          }>`
            SELECT et.slug AS entity_type, e.metadata
            FROM entities e
            JOIN entity_types et ON et.id = e.entity_type_id
            WHERE e.id = ${entityId} AND e.deleted_at IS NULL
          `;
          if (!entityRow) return;
          const beforeDelete = getEntityHooks(entityRow.entity_type)?.beforeDelete;
          if (!beforeDelete) return;
          await beforeDelete(
            { id: entityId, ...entityRow },
            { organizationId: ctx.organizationId, userId: ctx.userId, sql: tx, actorSource: deriveToolActorSource(ctx) }
          );
        }
      : null;

  // Check if entity has children
  if (!force) {
    const children = await sql`
      SELECT COUNT(*) as count
      FROM entities
      WHERE parent_id = ${entityId}
        AND deleted_at IS NULL
    `;

    const childCount = Number(children[0]?.count || 0);
    if (childCount > 0) {
      throw new Error(
        `Cannot delete entity: it has ${childCount} child entities. Use force_delete_tree=true to delete the entire hierarchy.`
      );
    }
  }

  if (force) {
    const entityTreeIds = await loadEntityTreeIds(sql, entityId);
    const entityTreeIdsLiteral = pgBigintArray(entityTreeIds);

    // Preflight dependency report: what this delete removes vs. detaches.
    // An automation/feed whose entities all live inside the tree is deleted with
    // it; one that also spans outside entities is detached (tree ids pruned
    // from its entity_ids). Event rows are append-only history — they are
    // counted here and DETACHED below, never deleted.
    const preflight = await sql<Record<string, number>>`
      SELECT
        (SELECT COUNT(*) FROM entity_relationships r
          WHERE r.from_entity_id = ANY(${entityTreeIdsLiteral}::bigint[])
             OR r.to_entity_id = ANY(${entityTreeIdsLiteral}::bigint[]))::int AS relationships,
        (SELECT COUNT(*) FROM automations w
          WHERE w.entity_ids && ${entityTreeIdsLiteral}::bigint[]
            AND w.entity_ids <@ ${entityTreeIdsLiteral}::bigint[])::int AS automations_deleted,
        (SELECT COUNT(*) FROM automations w
          WHERE w.entity_ids && ${entityTreeIdsLiteral}::bigint[]
            AND NOT (w.entity_ids <@ ${entityTreeIdsLiteral}::bigint[]))::int AS automations_detached,
        (SELECT COUNT(*) FROM feeds f
          WHERE f.entity_ids && ${entityTreeIdsLiteral}::bigint[]
            AND f.entity_ids <@ ${entityTreeIdsLiteral}::bigint[])::int AS feeds_deleted,
        (SELECT COUNT(*) FROM feeds f
          WHERE f.entity_ids && ${entityTreeIdsLiteral}::bigint[]
            AND NOT (f.entity_ids <@ ${entityTreeIdsLiteral}::bigint[]))::int AS feeds_detached,
        (SELECT COUNT(*) FROM events e
          WHERE e.entity_ids && ${entityTreeIdsLiteral}::bigint[])::int AS events_detached
    `;
    const report: ForceDeleteTreeReport = {
      entities: entityTreeIds.length,
      relationships: Number(preflight[0]?.relationships || 0),
      automations_deleted: Number(preflight[0]?.automations_deleted || 0),
      automations_detached: Number(preflight[0]?.automations_detached || 0),
      feeds_deleted: Number(preflight[0]?.feeds_deleted || 0),
      feeds_detached: Number(preflight[0]?.feeds_detached || 0),
      events_detached: Number(preflight[0]?.events_detached || 0),
    };

    if (opts?.dryRun) {
      // Preview the RULE too, or the preview lies — the same reasoning the soft
      // path below spells out. A pool read is right here because a dry run
      // enforces nothing: the verdict is advisory by construction, and the real
      // delete re-asks it under lock.
      try {
        await validateEntityRowPatchGrantingApprovedFields({
          tx: sql,
          ids: entityTreeIds,
          patch: { softDelete: true },
          operation: "delete",
          approvedFields: opts?.approvedFields ?? [],
        });
      } catch (err) {
        if (!(err instanceof EntityRowValidationError)) throw err;
        return {
          message: `Dry run: force delete would NOT run — ${err.verdict.reason}`,
          deleted: 0,
          dry_run: true,
          refused: true,
          tree: report,
        };
      }
      return {
        message: `Dry run: force delete would remove ${report.entities} entities and detach ${report.events_detached} event rows`,
        deleted: 0,
        dry_run: true,
        tree: report,
      };
    }

    // Deletion predicate for automations/feeds: only rows whose entity set is
    // non-empty AND fully inside the tree. Requiring the overlap (&&) first is
    // load-bearing — a bare `entity_ids <@ tree` (or a COALESCE to '{}') also
    // matches every empty/NULL-linked row IN EVERY ORG (empty set ⊂ anything),
    // and lets the GIN index on entity_ids drive the scan instead of a
    // full-table pass.
		await withEntityWriteTransaction(sql, async (tx) => {
      // Parent row first: this locks the entity tree below and then bumps the
      // org generation, the reverse of organization deletion's parent-then-
      // cascade order unless the org is claimed up front.
      await lockOrgForAclInvalidation(tx, ctx.organizationId);
      // A force delete answers to the same `$deleted` name a soft delete does.
      // Hard deletion is not a lesser destruction than a tombstone, so giving
      // `force` its own reserved name would turn every "this row cannot be
      // deleted" rule into "cannot be deleted without passing
      // force_delete_tree=true" — a control with a documented bypass.
      //
      // Every id in the tree is judged, not just the root: a descendant carries
      // its own type's rules, and deleting a parent must not be a way to destroy
      // a frozen child.
      //
      // Locked first for the reason the soft path locks — the verdict has to
      // describe the rows this transaction actually removes.
      await tx`
        SELECT id FROM entities
        WHERE id = ANY(${entityTreeIdsLiteral}::bigint[])
        ORDER BY id
        FOR UPDATE
      `;
      await validateEntityRowPatchGrantingApprovedFields({
        tx,
        ids: entityTreeIds,
        patch: { softDelete: true },
        operation: "delete",
        approvedFields: opts?.approvedFields ?? [],
      });
      if (runBeforeDeleteHook) await runBeforeDeleteHook(tx);
      // Force-delete removes ACL edges along with everything else. That is
      // correct — the entity is gone, so its membership projection must go too —
      // but the `entity_relationships` trigger refuses authorization-bearing
      // writes from outside a sync, so the intent is declared explicitly here
      // rather than the delete failing. The next sync re-derives membership for
      // whatever entities remain.
      // Scoped to this statement: the rest of the delete cascade must not run
      // with the ACL-write privilege still granted.
      await withAclPrivilege(tx, async () => {
        await tx`
          DELETE FROM entity_relationships r
          WHERE (from_entity_id = ANY(${entityTreeIdsLiteral}::bigint[])
             OR to_entity_id = ANY(${entityTreeIdsLiteral}::bigint[]))
            -- Retired identity decisions survive until their endpoint is
            -- actually deleted; the existing FK cascade then removes them.
            AND NOT (r.deleted_at IS NOT NULL AND EXISTS (
              SELECT 1 FROM entity_relationship_types rt
              WHERE rt.id = r.relationship_type_id AND rt.purpose = 'identity'
            ))
        `;
      });
      // Fail closed until a sync based on the post-delete graph completes. The
      // generation also fences an older sync that has resolved, but not yet
      // written, a grant involving one of the deleted entities.
      await invalidateOrgAcl(tx, ctx.organizationId);

      // Key cleanup on the denormalized automation_id so all result links for
      // the deleted Automation are removed together.
      await tx`
        DELETE FROM automation_run_events
        WHERE automation_id IN (
          SELECT id
          FROM automations
          WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
            AND entity_ids <@ ${entityTreeIdsLiteral}::bigint[]
        )
      `;
      // Before hard-deleting automations: if any of those rows are group roots
      // (id = automation_group_id) with surviving siblings, transfer ownership
      // of the shared automation_versions chain to a sibling so the upcoming
      // ON DELETE CASCADE doesn't wipe out the version row that the rest
      // of the group still depends on.
      await tx`
        UPDATE automation_versions wv
        SET automation_id = s.new_root
        FROM (
          SELECT r.old_root, MIN(s.id) AS new_root
          FROM (
            SELECT w.id AS old_root
            FROM automations w
            WHERE w.id = w.automation_group_id
              AND w.entity_ids && ${entityTreeIdsLiteral}::bigint[]
              AND w.entity_ids <@ ${entityTreeIdsLiteral}::bigint[]
          ) r
          JOIN automations s
            ON s.automation_group_id = r.old_root
           AND s.id <> r.old_root
           AND NOT (
             COALESCE(s.entity_ids, '{}'::bigint[]) && ${entityTreeIdsLiteral}::bigint[]
             AND COALESCE(s.entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[]
           )
           AND NOT EXISTS (
             SELECT 1 FROM automation_versions vv WHERE vv.automation_id = s.id
           )
          GROUP BY r.old_root
        ) s
        WHERE wv.automation_id = s.old_root
      `;
      await tx`
        UPDATE automations w
        SET automation_group_id = s.new_root,
            source_automation_id = CASE WHEN w.source_automation_id = s.old_root THEN s.new_root ELSE w.source_automation_id END
        FROM (
          SELECT r.old_root, MIN(s.id) AS new_root
          FROM (
            SELECT w.id AS old_root
            FROM automations w
            WHERE w.id = w.automation_group_id
              AND w.entity_ids && ${entityTreeIdsLiteral}::bigint[]
              AND w.entity_ids <@ ${entityTreeIdsLiteral}::bigint[]
          ) r
          JOIN automations s
            ON s.automation_group_id = r.old_root
           AND s.id <> r.old_root
           AND NOT (
             COALESCE(s.entity_ids, '{}'::bigint[]) && ${entityTreeIdsLiteral}::bigint[]
             AND COALESCE(s.entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[]
           )
           AND NOT EXISTS (
             SELECT 1 FROM automation_versions vv WHERE vv.automation_id = s.id
           )
          GROUP BY r.old_root
        ) s
        WHERE w.automation_group_id = s.old_root
      `;
      await tx`
        DELETE FROM automations
        WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
          AND entity_ids <@ ${entityTreeIdsLiteral}::bigint[]
      `;
      // Detach survivors: prune tree ids from automations that also span entities
      // outside the tree. Fully-contained rows were deleted above, so pruning
      // can never leave an empty entity set behind — no orphan sweep needed.
      await tx`
        UPDATE automations
        SET entity_ids = ARRAY(
          SELECT linked_id
          FROM unnest(entity_ids) AS linked_id
          WHERE NOT (linked_id = ANY(${entityTreeIdsLiteral}::bigint[]))
        )
        WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
      `;

      await tx`
        DELETE FROM feeds
        WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
          AND entity_ids <@ ${entityTreeIdsLiteral}::bigint[]
      `;

      await tx`
        UPDATE feeds
        SET entity_ids = ARRAY(
          SELECT linked_id
          FROM unnest(entity_ids) AS linked_id
          WHERE NOT (linked_id = ANY(${entityTreeIdsLiteral}::bigint[]))
        )
        WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
      `;

      // Detach event references instead of blocking on them: `events` is
      // append-only (never DELETE), but the platform's own lifecycle events
      // (change audits etc.) reference fresh entities immediately, so a hard
      // delete must prune the tree ids out of events.entity_ids — the rows
      // survive as history, they just stop pointing at deleted entities.
      // Batched so a large history can't push one UPDATE past
      // statement_timeout; still atomic (all batches share this transaction).
      const EVENT_DETACH_BATCH = 5000;
      let eventsDetached = 0;
      for (;;) {
        const detached = await tx<{ id: number }>`
          UPDATE events e
          SET entity_ids = ARRAY(
            SELECT linked_id
            FROM unnest(e.entity_ids) AS linked_id
            WHERE NOT (linked_id = ANY(${entityTreeIdsLiteral}::bigint[]))
          )
          WHERE e.id IN (
            SELECT id FROM events
            WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
            LIMIT ${EVENT_DETACH_BATCH}
          )
          RETURNING e.id
        `;
        eventsDetached += detached.length;
        if (detached.length < EVENT_DETACH_BATCH) break;
      }
      // The preflight count is a useful preview, but an edge audit holding the
      // org/entity locks this transaction waited on can commit in between.
      // Report what this transaction actually detached, not the earlier snapshot.
      report.events_detached = eventsDetached;

      await hardDeleteEntityRows({ tx, ids: entityTreeIds });
    });

    return {
      message:
        report.events_detached > 0
          ? `Entity and all descendants deleted; ${report.events_detached} event rows kept as history and detached`
          : 'Entity and all descendants deleted successfully',
      deleted: entityTreeIds.length,
      tree: report,
    };
  }

  if (opts?.dryRun) {
    // Preview the RULE too, or the preview lies. Soft delete is rule-governed
    // now, so reporting "would be soft-deleted" for a row a rule refuses is
    // exactly backwards for the one caller who asked before committing.
    //
    // A pool read is right HERE, and only here: a dry run enforces nothing, so
    // there is no check for a concurrent write to overtake. The verdict is
    // advisory by construction — the real delete below re-asks it under lock.
    try {
      await validateEntityRowPatchGrantingApprovedFields({
        tx: sql,
        ids: [entityId],
        patch: { softDelete: true },
        operation: "delete",
        approvedFields: opts?.approvedFields ?? [],
      });
    } catch (err) {
      if (!(err instanceof EntityRowValidationError)) throw err;
      return {
        message: `Dry run: entity would NOT be deleted — ${err.verdict.reason}`,
        deleted: 0,
        dry_run: true,
        refused: true,
      };
    }
    return {
      message: 'Dry run: entity would be soft-deleted',
      deleted: 0,
      dry_run: true,
    };
  }
  // Soft delete: stamp deleted_at, governed by the type's write rules.
  //
  // The rule sees `$deleted` flip to true, so freezing a row stops it being
  // tombstoned and not merely edited. This closes the KNOWN GAP that used to sit
  // here: the check was skipped because a pool-level read-then-write could be
  // overtaken between the two, and a racy check that looks like enforcement is
  // worse than an honest exemption. The transaction boundary is what makes it
  // honest — the `FOR UPDATE` below holds the row from the moment the rule judges
  // it until the tombstone commits, so no concurrent write can change the state
  // the verdict was based on.
  //
  // `force` above asks the same question of every row in the tree before it
  // hard-deletes any of them, so freezing a row survives both delete paths. The
  // physical helper `hardDeleteEntityRows` itself stays unguarded and is
  // deliberately exempt: its other callers are rollback paths that destroy a row
  // the platform created moments earlier in the same request
  // (`entity-link-upsert`, `promote-keyed-entities`). Judging
  // those would let a tenant rule wedge a half-built
  // record in place, which is the failure the rollback exists to prevent.
  //
  // A deny throws rather than returning: approval cannot launder an illegal
  // state into a legal one. An escalate throws too UNLESS this call is the
  // application of a delete a human already approved — see `approvedFields`.
  await withEntityWriteTransaction(sql, async (tx) => {
    // Lock first: the rule must judge the state that will actually be deleted.
    const locked = await tx<{ id: number }>`
      SELECT id FROM entities
      WHERE id = ${entityId} AND deleted_at IS NULL
      FOR UPDATE
    `;
    // Already tombstoned. `patchEntityRows` would no-op on its own
    // `deleted_at IS NULL` guard, exactly as the unlocked statement did; stopping
    // here also keeps a tenant rule from judging a row this call cannot write.
    if (locked.length === 0) return;
    const patch = await validateEntityRowPatchGrantingApprovedFields({
      tx,
      ids: [entityId],
      patch: { softDelete: true },
      operation: "delete",
      approvedFields: opts?.approvedFields ?? [],
    });
    if (runBeforeDeleteHook) await runBeforeDeleteHook(tx);
    await patchEntityRows({
      tx,
      ids: [entityId],
      patch,
    });
  });

  return {
    message: 'Entity soft-deleted successfully',
    deleted: 1,
  };
}

/**
 * Count a page's linked content with org/liveness/visibility filters on each
 * indexed event probe. UNION deduplicates direct and identity attribution
 * before counting, without an outer event-table scan for every listed entity.
 */
async function batchTotalContentCounts(
	db: DbClient,
	opts: {
		organizationId: string;
		userId: string | null;
		entityIds: number[];
	},
): Promise<Map<number, number>> {
	const counts = new Map<number, number>();
	const entityIds = opts.entityIds;
	if (entityIds.length === 0) return counts;

	// Conservative edge check: an entity with no live relationship at all is
	// its own whole identity group. Anything with an edge keeps the full
	// members CTE so ordinary relationships cannot group unrelated records.
	const edgedRows = await db.unsafe<{ id: number | string }>(
		`SELECT v.id FROM (VALUES ${entityIds.map((eid) => `(${eid})`).join(',')}) v(id)
     WHERE EXISTS (SELECT 1 FROM entity_relationships ir WHERE ir.from_entity_id = v.id AND ir.deleted_at IS NULL)
        OR EXISTS (SELECT 1 FROM entity_relationships ir WHERE ir.to_entity_id = v.id AND ir.deleted_at IS NULL)`,
	);
	const edged = new Set(edgedRows.map((row) => Number(row.id)));

	// Claims live on any group member, not just the listed root — expand
	// through the identity graph exactly like the `ei.entity_id IN (...)`
	// side of the legacy predicate, attributing member claims to the root.
	// Edgeless entities probe their own id directly (same result, no CTE).
	const scopeRows = await db.unsafe<{ eid: number | string; namespace: unknown; identifier: unknown; scope_key: unknown }>(
		entityIds
			.map(
				(eid) => `SELECT ${eid}::bigint AS eid, identity.namespace, identity.identifier, identity.scope_key
     FROM entity_identities identity
     WHERE ${edged.has(eid) ? `identity.entity_id IN (${identityMemberIdsSql(`${eid}::bigint`)})` : `identity.entity_id = ${eid}`}
       AND identity.deleted_at IS NULL
       AND identity.namespace = ANY('${pgTextArray([...STANDARD_IDENTITY_NAMESPACES])}'::text[])`,
			)
			.join('\nUNION ALL\n'),
	);
	const scopesByEntity = new Map<number, EntityIdentityScope[]>();
	for (const row of scopeRows) {
		const eid = Number(row.eid);
		const list = scopesByEntity.get(eid) ?? [];
		list.push({
			namespace: String(row.namespace),
			identifier: String(row.identifier),
			scopeKey: row.scope_key == null ? null : String(row.scope_key),
		});
		scopesByEntity.set(eid, list);
	}

	const params: unknown[] = [opts.organizationId];
	const orgParam = "$1::text";
	const visibility = buildConnectionVisibilityClause({
		organizationId: opts.organizationId, userId: opts.userId, baseParamIndex: params.length + 1,
	}, 'e2');
	params.push(...visibility.params);
	const arms: string[] = [];
	for (const eid of entityIds) {
		const { branches, params: branchParams } = buildEntityLinkBranches({
			entityIdLiteral: eid,
			scopes: scopesByEntity.get(eid) ?? [],
			baseParamIndex: params.length + 1,
			directMembersSql: edged.has(eid) ? undefined : `ARRAY[${eid}::bigint]`,
		});
		params.push(...branchParams);
		const probed = branches
			.map((branch) => `${branch} AND e2.organization_id = ${orgParam} AND e2.superseded_by IS NULL ${visibility.sql}`)
			.join('\n    UNION\n    ');
		arms.push(`SELECT ${eid}::bigint AS eid, COUNT(*) AS cnt FROM (\n    ${probed}\n  ) u`);
	}

	const rows = await db.unsafe<{ eid: number | string; cnt: number | string }>(
		arms.join('\nUNION ALL\n'),
		params,
	);
	for (const row of rows) counts.set(Number(row.eid), Number(row.cnt));
	return counts;
}

/** List readable identity roots within the caller's organization. */
export async function listEntities(
	filters: {
		entity_type?: string;
		parent_id?: number | null;
		search?: string;
		segment?: string;
		filters?: AttributeFilter[];
		limit?: number;
		offset?: number;
		sort_by?: string;
		sort_order?: "asc" | "desc";
	},
	_env: Env,
	ctx: ToolContext,
	readRestrictions: EntityReadRestrictions = [],
): Promise<{
  entities: CreatedEntity[];
  hasMore: boolean;
  totalCount: number;
  limit: number;
  offset: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}> {
	const sql = getDb();
	const limit = Math.min(Math.max(filters.limit || 100, 1), 500);
	const offset = Math.max(filters.offset || 0, 0);

	if (!ctx.organizationId) {
		return {
			entities: [],
			hasMore: false,
			totalCount: 0,
			limit,
			offset,
			sortBy: filters.sort_by ?? "created_at",
			sortOrder: filters.sort_order === "asc" ? "asc" : "desc",
		};
	}

	if (filters.segment && !filters.entity_type) {
		throw new ToolUserError(
			"segment requires entity_type: a segment is declared on one entity type.",
			400,
			"VALIDATION",
		);
	}
	if (filters.filters?.length && !filters.entity_type) {
		throw new ToolUserError("Attribute filters require entity_type", 400, "VALIDATION");
	}

	// Derived ("view") entity types have no rows in `entities` — their rows come
	// from `backing_sql`. Return them in the standard list shape so the frontend
	// renders them with the normal table (no derived-specific UI path).
	let segmentFilter: { sql: string; params: unknown[] } | null = null;
	if (filters.entity_type) {
		const etRows = await sql`
      SELECT id, backing_sql, backing_source, metrics_config, metadata_schema
      FROM entity_types
      WHERE slug = ${filters.entity_type}
        AND organization_id = ${ctx.organizationId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
		const backingSql = etRows[0]?.backing_sql as string | null | undefined;
		if (filters.filters?.length) validateAttributeFilters(filters.filters, etRows[0]?.metadata_schema);
		if (filters.segment) {
			if (backingSql) {
				throw new ToolUserError(
					`Derived entity type '${filters.entity_type}' has no stored entities to segment; filter its backing SQL instead.`,
					400,
					"VALIDATION",
				);
			}
			segmentFilter = compileEntitySegmentFilter(
				filters.entity_type,
				etRows[0] ? Number(etRows[0].id) : null,
				(etRows[0]?.metrics_config ?? null) as EntityMetrics | null,
				filters.segment,
				ctx,
			);
		}
		if (backingSql) {
			return listDerivedEntities(
				filters.entity_type,
				backingSql,
				(etRows[0]?.backing_source as string | null | undefined) ?? undefined,
				{ limit, offset, search: filters.search, filters: filters.filters, sort_by: filters.sort_by, sort_order: filters.sort_order },
				ctx,
			);
		}
	}

	const conditions: string[] = ["{e}.deleted_at IS NULL", identityRootSql("{e}")];
	// The scoped segment statement numbers its own placeholders from $1, so its
	// params lead the list and every other filter binds after them.
	const params: unknown[] = segmentFilter ? [...segmentFilter.params] : [];
	let paramIdx = params.length + 1;

	// Organization filter
	conditions.push(`{e}.organization_id = $${paramIdx++}`);
	params.push(ctx.organizationId);

	if (filters.entity_type) {
		conditions.push(`{et}.slug = $${paramIdx++}`);
		params.push(filters.entity_type);
	}

	const memberConditions: string[] = [];
	if (filters.parent_id !== undefined) {
		if (filters.parent_id === null) {
			memberConditions.push("member.parent_id IS NULL");
		} else {
			memberConditions.push(`member.parent_id = $${paramIdx++}`);
			params.push(filters.parent_id);
		}
	}

	if (filters.search) {
		memberConditions.push(`member.name ILIKE $${paramIdx} ESCAPE '!'`);
		params.push(`%${filters.search.replace(/[!%_]/g, '!$&')}%`);
		paramIdx++;
	}
	memberConditions.push(...attributeFilterSql(filters.filters ?? [], "member.metadata", params));
	conditions.push(entityReadPolicySql(readRestrictions, '{e}', params));

	// Render the shared conditions for a given pair of table aliases. The
	// enrichment uses e/et; the page-id query uses e2/et2 with the same filter
	// parameters.
	const renderWhere = (eAlias: string, etAlias: string) =>
		conditions
			.map((c) =>
				c.replace(/\{e\}\./g, `${eAlias}.`).replace(/\{et\}\./g, `${etAlias}.`),
			)
			// Every predicate must hold on one member, including the authored segment.
			// Append authored SQL after alias substitution so literal text is untouched.
			.concat(memberConditions.length || segmentFilter ? [`EXISTS (
        SELECT 1 FROM entities member WHERE member.id IN (${identityMemberIdsSql(`${eAlias}.id`)})
          AND ${[...memberConditions, ...(segmentFilter ? [`member.id IN (${segmentFilter.sql})`] : [])].join(' AND ')}
      )`] : [])
			.join(" AND ");

	const whereClause = renderWhere("e", "et");

	const sortColumnMap: Record<string, string> = {
		name: "e.name",
		domain: "e.metadata->>'domain'",
		created_at: "e.created_at",
		total_content: "total_content",
		active_connections: "active_connections",
		automations_count: "automations_count",
		children_count: "children_count",
	};

	const sortBy =
		filters.sort_by && sortColumnMap[filters.sort_by]
			? filters.sort_by
			: "created_at";
	const normalizedSortOrder = filters.sort_order === "asc" ? "asc" : "desc";
	const sortOrderSql = normalizedSortOrder === "asc" ? "ASC" : "DESC";
	const orderBy = `${sortColumnMap[sortBy]} ${sortOrderSql}, e.id ASC`;

	// Each statement binds only the parameter prefix its placeholders use:
	// filters, then enrichment policies, then event visibility.
	const filterParamCount = params.length;
  const parentReadPredicate = entityReadPolicySql(readRestrictions, 'pe', params);
  const childReadPredicate = entityReadPolicySql(readRestrictions, 'c', params);
	const enrichParamCount = params.length;

  const visibility = buildConnectionVisibilityClause({
    organizationId: ctx.organizationId, userId: ctx.userId, baseParamIndex: params.length + 1,
  }, 'ev');
  params.push(...visibility.params);

  const plainSort = sortBy === 'name' || sortBy === 'created_at' || sortBy === 'domain';

	const baseQuery = `
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities pe ON e.parent_id = pe.id AND ${parentReadPredicate}
    LEFT JOIN entity_types pet ON pet.id = pe.entity_type_id
    ${plainSort ? '' : `LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM current_event_records ev WHERE ${entityLinkMatchSql('e.id::bigint', 'ev')} AND ev.organization_id = e.organization_id ${visibility.sql}) tc ON true`}
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT c.connector_key) as cnt
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      WHERE f.deleted_at IS NULL
        AND c.deleted_at IS NULL
        AND ${feedLinkedToBusinessEntitySql('e.id', 'f', 'c', 'e.organization_id')}
    ) ac ON true
    LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM automations i WHERE e.id = ANY(i.entity_ids)) ic ON true
    LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM entities c WHERE c.parent_id = e.id AND ${childReadPredicate}) cc ON true
    WHERE ${whereClause}
  `;

  // Plain-column sorts select page ids before enrichment and batch the
  // content counts. Computed sorts need counts before selecting the page.
  const pageIdQuery = `SELECT e2.id FROM entities e2
          JOIN entity_types et2 ON et2.id = e2.entity_type_id
          WHERE ${renderWhere('e2', 'et2')}
          ORDER BY ${sortColumnMap[sortBy].replace(/^e\./, 'e2.')} ${sortOrderSql}, e2.id ASC
          LIMIT ${limit + 1} OFFSET ${offset}`;
  // Enrichment joins each produce at most one row per entity, so the total
  // needs only the filters.
  const countFrom = `
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE ${whereClause}
  `;
  const pageQuery = (pageIdClause = '') => `SELECT
      e.id, et.slug AS entity_type, e.name, e.slug, pe.id AS parent_id, e.metadata, e.created_at,
      ${plainSort ? '0' : 'COALESCE(tc.cnt, 0)'} as total_content,
      COALESCE(ac.cnt, 0) as active_connections,
      COALESCE(ic.cnt, 0) as automations_count,
      COALESCE(cc.cnt, 0) as children_count,
      pe.name as parent_name, pe.slug as parent_slug, pet.slug as parent_entity_type
    ${baseQuery}
    ${pageIdClause}
    ORDER BY ${orderBy}
    LIMIT ${limit + 1}
    ${plainSort ? '' : `OFFSET ${offset}`}`;
  const fetchPage = async (db: DbClient) => {
    if (!plainSort) {
      const totalCountResult = await db.unsafe<{ total_count: number }>(
        `SELECT CAST(COUNT(*) AS INTEGER) as total_count ${baseQuery}`,
        params
      );
      const result = await db.unsafe<CreatedEntity>(pageQuery(), params);
      return { totalCountResult, result, hasMoreIds: null as boolean | null };
    }
    const pageIds = (
      await db.unsafe<{ id: number | string }>(pageIdQuery, params.slice(0, filterParamCount))
    ).map((row) => Number(row.id));
    const hasMoreIds = pageIds.length > limit;
    const ids = hasMoreIds ? pageIds.slice(0, limit) : pageIds;
    const [totalCountResult, result, contentCounts] = await Promise.all([
      db.unsafe<{ total_count: number }>(
        `SELECT CAST(COUNT(*) AS INTEGER) as total_count ${countFrom}`,
        params.slice(0, filterParamCount)
      ),
      ids.length > 0
        ? db.unsafe<CreatedEntity>(
            pageQuery(`AND e.id = ANY('${pgBigintArray(ids)}'::bigint[])`),
            params.slice(0, enrichParamCount),
          )
        : Promise.resolve([] as CreatedEntity[]),
      batchTotalContentCounts(db, {
        organizationId: ctx.organizationId,
        userId: ctx.userId ?? null,
        entityIds: ids,
      }),
    ]);
    for (const row of result) {
      row.total_content = contentCounts.get(Number(row.id)) ?? 0;
    }
    return { totalCountResult, result, hasMoreIds };
  };
  // Parsing and scoping do not prevent function side effects or expensive
  // expressions. Run authored predicates with the SQL tools' execution limits.
  const { totalCountResult, result, hasMoreIds } = segmentFilter
    ? await sql
        .begin(async (tx) => {
          await tx.unsafe('SET TRANSACTION READ ONLY');
          await tx.unsafe("SET LOCAL statement_timeout = '5s'");
          return fetchPage(tx);
        })
        .catch((error: unknown) => {
          // A SQLSTATE fault (bad cast, read-only violation, timeout) is the
          // authored predicate's, not the server's; anything else rethrows.
          const code = classifyToolError({ pgCode: (error as { code?: string } | null)?.code });
          if (code !== 'VALIDATION' && code !== 'UPSTREAM_TIMEOUT') throw error;
          throw new ToolUserError(
            `Segment '${filters.segment}' failed: ${getErrorMessage(error)}`,
            toolErrorHttpStatus(code),
            code,
          );
        })
    : await fetchPage(sql);

  const hasMore = hasMoreIds ?? result.length > limit;
  const entities = hasMore
    ? (result.slice(0, limit) as unknown as CreatedEntity[])
    : (result as unknown as CreatedEntity[]);

  const totalCount = Number(totalCountResult[0]?.total_count || 0);

  const readableEntities = await filterEntityReadRows(sql, await attachEntityIdentities(sql, entities), readRestrictions);
  return { entities: readableEntities, hasMore, totalCount, limit, offset, sortBy, sortOrder: normalizedSortOrder };
}

/**
 * Lower a named `on: "entity"` segment to an org-scoped id subquery for the
 * entity list. The predicate is org-authored SQL, so it goes through the same
 * lowering ({@link entitySegmentPredicate}) and the same parse / validate /
 * org-scope pass ({@link validateAndScopeQuery}) as a metric's entity segment.
 * A list is a request path, so the predicate may read `entities` only: any
 * other table (events above all) would put a history walk behind every page.
 */
function compileEntitySegmentFilter(
	entityType: string,
	entityTypeId: number | null,
	metrics: EntityMetrics | null,
	segmentName: string,
	ctx: ToolContext,
): { sql: string; params: unknown[] } {
	const segment = metrics?.segments?.[segmentName];
	if (entityTypeId === null || !segment) {
		throw new ToolUserError(
			`Segment '${segmentName}' is not declared on entity type '${entityType}'.`,
			400,
			"VALIDATION",
		);
	}
	if (segment.on !== "entity") {
		throw new ToolUserError(
			`Segment '${segmentName}' filters events (on: '${segment.on}'), not entities; only on: 'entity' segments can narrow an entity list.`,
			400,
			"VALIDATION",
		);
	}
	let scoped: ReturnType<typeof validateAndScopeQuery>;
	try {
		scoped = validateAndScopeQuery(
			`SELECT seg.id FROM entities seg WHERE ${entitySegmentPredicate("seg.id", entityTypeId, segment.where)}`,
			ctx.organizationId,
			{
				userId: ctx.userId ?? null,
				// Match metric SQL: the outer type gate does not authorize nested
				// predicates to read protected member metadata.
				excludeMemberEntities: !isInProcessSystemCall(ctx) && !isAdminOrOwnerRole(ctx.memberRole),
			},
		);
	} catch (error) {
		throw new ToolUserError(
			`Segment '${segmentName}' has an invalid predicate: ${getErrorMessage(error)}`,
			400,
			"VALIDATION",
		);
	}
	const otherTables = scoped.tableRefs.filter((table) => table !== "entities");
	if (otherTables.length > 0) {
		throw new ToolUserError(
			`Segment '${segmentName}' reads ${[...new Set(otherTables)].join(", ")}; an entity-list segment may only filter on entities columns.`,
			400,
			"VALIDATION",
		);
	}
	return { sql: scoped.sql, params: scoped.params };
}

/**
 * Columns that carry a derived row's routing key, in precedence order. Shared
 * by {@link derivedRowSlug} and the SQL exact-match predicate that pushes the
 * same lookup into the view, so the two can never disagree about which column
 * names the row.
 */
const DERIVED_SLUG_COLUMNS = ['slug', 'id'] as const;

/**
 * Routing key for a derived row: the slug the backing SQL projects, falling
 * back to its `id` column. Both the list and the detail resolver derive the key
 * the same way so a listed row's link always resolves. Empty ⇒ unroutable.
 */
export function derivedRowSlug(row: Record<string, unknown>): string {
  let raw: unknown;
  for (const column of DERIVED_SLUG_COLUMNS) {
    if (row[column] != null) {
      raw = row[column];
      break;
    }
  }
  return raw != null ? String(raw).trim() : '';
}

/** Display name for a derived row: its name/title column, else the slug. */
export function derivedRowName(row: Record<string, unknown>, slug: string): string {
  const raw = row.name ?? row.title ?? slug;
  return raw != null && String(raw).trim() ? String(raw) : slug;
}

/**
 * List rows of a derived ("view") entity type by running its `backing_sql`
 * through {@link queryDerivedEntityView} (same executor as detail resolve and
 * type-level counts). Maps each row to the standard `CreatedEntity` shape so
 * the frontend treats derived rows like any other entity. Rows have no stored
 * numeric id; the projected `slug` (or `id`) is the routing key, so the
 * synthetic `id` is page-local and used only for table keys. Rows that project
 * no slug/id are unroutable and dropped (they can't link to a detail page).
 */
async function listDerivedEntities(
	entityType: string,
	backingSql: string,
	backingSource: string | undefined,
	page: { limit: number; offset: number; search?: string; filters?: AttributeFilter[]; sort_by?: string; sort_order?: "asc" | "desc" },
	ctx: ToolContext,
): Promise<{
  entities: CreatedEntity[];
  hasMore: boolean;
  totalCount: number;
  limit: number;
  offset: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}> {
	const result = await queryDerivedEntityView(
		backingSql,
		backingSource,
		page,
		ctx,
		// manage_entity transforms this already-limited page into entity rows.
		// Preserve its cardinality so fixed-offset UI pagination cannot skip a
		// byte-capped tail; per-cell text/JSON bounds still apply in querySqlImpl.
		{ preservePageRows: true },
	);
	if (result.error) {
		throw new ToolUserError(
			`Derived view '${entityType}' failed: ${result.error}`,
			400,
		);
	}

	const createdAt = new Date();
	const entities: CreatedEntity[] = [];
	result.rows.forEach((row, index) => {
		const slug = derivedRowSlug(row);
		// Drop unroutable rows: without a slug/id the detail link goes nowhere.
		if (!slug) return;
		entities.push({
			id: page.offset + index + 1,
			entity_type: entityType,
			name: derivedRowName(row, slug),
			slug,
			parent_id: null,
			metadata: row,
			created_at: createdAt,
			total_content: 0,
			active_connections: 0,
			automations_count: 0,
			children_count: 0,
		});
	});

	return {
		entities,
		hasMore: result.has_more,
		totalCount: result.total_count,
		limit: page.limit,
		offset: page.offset,
		sortBy: page.sort_by ?? "created_at",
		sortOrder: page.sort_order === "asc" ? "asc" : "desc",
	};
}

// ============================================
// Relationship Batch Loading
// ============================================

export interface RelationshipColumnSpec {
  relationship_type: string;
  direction?: 'outbound' | 'inbound' | 'both';
  label: string;
}

interface RelatedEntityInfo {
  id: number;
  name: string;
  slug: string;
  entity_type: string;
}

export async function batchLoadRelationships(
	entityIds: number[],
	specs: RelationshipColumnSpec[],
	organizationId: string,
	readRestrictions: EntityReadRestrictions = [],
): Promise<Map<number, Record<string, RelatedEntityInfo[]>>> {
  const result = new Map<number, Record<string, RelatedEntityInfo[]>>();
  if (entityIds.length === 0 || specs.length === 0) return result;

  const sql = getDb();
  const typeSlugs = pgTextArray([...new Set(specs.map((s) => s.relationship_type))]);
  const idArray = pgBigintArray(entityIds);

  const rows = await sql`
    SELECT
      r.from_entity_id,
      r.to_entity_id,
      rt.slug AS relationship_type_slug,
      fe.id AS from_id, fe.name AS from_name, fe.slug AS from_slug, fet.slug AS from_entity_type,
      te.id AS to_id, te.name AS to_name, te.slug AS to_slug, tet.slug AS to_entity_type
    FROM entity_relationships r
    JOIN entity_relationship_types rt ON r.relationship_type_id = rt.id
    LEFT JOIN entities fe ON r.from_entity_id = fe.id
    LEFT JOIN entity_types fet ON fet.id = fe.entity_type_id
    LEFT JOIN entities te ON r.to_entity_id = te.id
    LEFT JOIN entity_types tet ON tet.id = te.entity_type_id
    WHERE r.organization_id = ${organizationId}
      AND r.deleted_at IS NULL
      AND rt.slug = ANY(${typeSlugs}::text[])
      AND (r.from_entity_id = ANY(${idArray}::bigint[]) OR r.to_entity_id = ANY(${idArray}::bigint[]))
  `;

  const endpoints = rows.flatMap(row => [
    { id: Number(row.from_id), entity_type: String(row.from_entity_type) },
    { id: Number(row.to_id), entity_type: String(row.to_entity_type) },
  ]);
  const allowed = new Set((await filterEntityReadRows(sql, endpoints, readRestrictions)).map(row => row.id));

  // Build a direction lookup per spec
  const specByType = new Map<string, 'outbound' | 'inbound' | 'both'>();
  for (const spec of specs) {
    specByType.set(spec.relationship_type, spec.direction ?? 'both');
  }

  for (const row of rows) {
    if (!allowed.has(Number(row.from_id)) || !allowed.has(Number(row.to_id))) continue;
    const relType = row.relationship_type_slug as string;
    const direction = specByType.get(relType) ?? 'both';
    const fromId = Number(row.from_entity_id);
    const toId = Number(row.to_entity_id);

    const pairs: Array<[number, RelatedEntityInfo]> = [];

    if ((direction === 'outbound' || direction === 'both') && entityIds.includes(fromId)) {
      pairs.push([
        fromId,
        {
          id: Number(row.to_id),
          name: row.to_name as string,
          slug: row.to_slug as string,
          entity_type: row.to_entity_type as string,
        },
      ]);
    }
    if ((direction === 'inbound' || direction === 'both') && entityIds.includes(toId)) {
      pairs.push([
        toId,
        {
          id: Number(row.from_id),
          name: row.from_name as string,
          slug: row.from_slug as string,
          entity_type: row.from_entity_type as string,
        },
      ]);
    }

    for (const [entityId, related] of pairs) {
      let record = result.get(entityId);
      if (!record) {
        record = {};
        result.set(entityId, record);
      }
      if (!record[relType]) record[relType] = [];
      // Deduplicate by related entity id
      if (!record[relType].some((r) => r.id === related.id)) {
        record[relType].push(related);
      }
    }
  }

  return result;
}
