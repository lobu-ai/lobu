/**
 * The entity-row VALIDATION seam.
 *
 * `patchEntityRows` is the single physical writer for entity rows (the
 * `check-entity-write-funnel` gate proves no raw entity SQL lives outside
 * `entity-management.ts`). It is therefore the only place every write
 * converges, and the only place a state invariant can be enforced without
 * depending on 20-odd callers each remembering to ask.
 *
 * Enforcement is structural rather than conventional: `patchEntityRows` accepts
 * only a {@link ValidatedEntityRowPatch}, which this module alone can mint. A
 * caller that forgets to validate does not slip through — it fails to compile.
 *
 * Two reasons validation lives HERE and not in `runMutationGate`:
 *
 *  1. The gate answers a PERMISSION question (may this principal write this
 *     field) and is keyed on `principalKind` + ownership. Validation answers
 *     "is the resulting state legal", which has no principal in it.
 *  2. The gate runs BEFORE approval-held fields are stripped and before the
 *     ownership merge rewrites the patch. It therefore judges a proposal, not
 *     what commits. This seam sees the effective patch — the exact bytes about
 *     to hit the table — so it cannot be fooled by either transformation.
 */

import { type DbClient, pgBigintArray } from "../db/client";
import logger from "../utils/logger";
import type {
	EntityRowInsert,
	EntityRowPatch,
} from "../utils/entity-management";
import { type EntityRuleRow, runEntityRules } from "./entity-rule-executor";

declare const validatedBrand: unique symbol;

/**
 * An `EntityRowPatch` that has passed validation (or been explicitly exempted).
 * Only this module can produce one — the brand has no public constructor, so
 * `patchEntityRows` cannot be called with an unchecked patch.
 */
export type ValidatedEntityRowPatch = EntityRowPatch & {
	readonly [validatedBrand]: true;
};

/** The entity write a verdict judged, in the vocabulary the audit records. */
export type EntityWriteOperation = "create" | "update" | "delete" | "merge";

/** What a rule decided, carried on the error so a caller can route it. */
export interface EntityRowValidationVerdict {
	outcome: "deny" | "escalate";
	reason: string;
	/** Changed fields for a deny; fields named by the rule for an escalation. */
	fields: string[];
	operation: EntityWriteOperation;
	/** The row judged, or null for a create — there is no row yet. */
	entityId: number | null;
	entityType: string | null;
	entityOrganizationId: string | null;
}

/**
 * Thrown when a patch would produce an illegal state.
 *
 * Throwing rather than returning a verdict is deliberate: it makes failing
 * closed the DEFAULT for every caller. Only a caller with approval machinery to
 * route an escalation into opts in by catching this and reading {@link verdict}
 * — `updateEntity`, automation promotion (`promote-keyed-entities`), and
 * `manage_entity` deletion and merge. Link auto-create and eval scaffolding have
 * nowhere to queue a card, so for them a rule that asked for review must stop the
 * write — which is exactly what an uncaught throw does.
 *
 * Soft-delete (`deleteEntity`) and merge (`applyMergeInTransaction`) are the
 * in-between cases. The policy gate can queue either card, and `manage_entity`
 * also turns a delete rule's `$deleted` escalation into a delete card and a
 * merge rule's `$merged_into` escalation into a merge card. Applying those cards
 * grants `$deleted` or `$merged_into` — the one field each card can be said to
 * have approved. Callers without approval machinery still fail closed. A `deny`
 * stops the write either way, and force delete reaches this seam under the same
 * `$deleted` name, so freezing a row freezes both delete paths.
 */
export class EntityRowValidationError extends Error {
	readonly verdict: EntityRowValidationVerdict;

	constructor(message: string, verdict: EntityRowValidationVerdict) {
		super(message);
		this.name = "EntityRowValidationError";
		this.verdict = verdict;
	}
}

/**
 * Patch columns a write rule can never govern: platform bookkeeping that no
 * tenant declares in its schema. A patch touching only these skips validation
 * entirely — no rule read, no evaluation — which is what keeps the common write
 * off the validation path.
 *
 * The complement (`metadata`, `name`, `slug`, `parentId`, `content`,
 * `softDelete`) IS governed: freezing a document has to stop a rename, not
 * merely a metadata edit, and it has to stop the row being tombstoned out from
 * under the rule that froze it. `deleteEntity` proposes `softDelete` for a hard
 * (force) delete too, so a row about to be destroyed outright is judged by the
 * same `$deleted` name instead of slipping past the seam.
 */
const UNGOVERNED_COLUMNS: ReadonlySet<string> = new Set([
	"fieldControls",
	"enabledClassifiers",
	"embedding",
	"contentHash",
]);

/**
 * Reserved `$`-names a rule sees for non-metadata columns.
 *
 * This is the rule VOCABULARY, not the shape of `EntityRowPatch`. `mergedInto`
 * has no key on that patch — the merge ledger is written by
 * `transitionEntityMergeRows`, never `patchEntityRows` — so `flatten` never
 * finds it and only the merge seam proposes it. Keeping it here is what makes
 * `$merged_into` one namespace with the rest, so a rule reads
 * `row.next.$merged_into` exactly as it reads `row.next.$deleted`.
 */
export const RESERVED_COLUMN_NAMES: Readonly<Record<string, string>> = {
	name: "$name",
	slug: "$slug",
	parentId: "$parent_id",
	content: "$content",
	softDelete: "$deleted",
	mergedInto: "$merged_into",
};

function touchesGovernedColumn(patch: EntityRowPatch): boolean {
	return Object.keys(patch).some((k) => !UNGOVERNED_COLUMNS.has(k));
}

/**
 * Flatten a patch into the single namespace a rule reasons about: metadata keys
 * plus reserved `$`-names for columns.
 *
 * `patch.metadata` is the fully merged metadata object, not a delta, so most of
 * its keys are unchanged values. That is why `row.changed(f)` compares the VALUE
 * in `committed` against the one in `next` rather than asking whether the key is
 * present — presence is true for every metadata key on every metadata write, so
 * a presence test would fire on writes that never touched the field.
 */
function flatten(
	patch: EntityRowPatch,
	metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	const flat: Record<string, unknown> = { ...(metadata ?? {}) };
	for (const [column, reserved] of Object.entries(RESERVED_COLUMN_NAMES)) {
		if (Object.hasOwn(patch, column)) {
			flat[reserved] = patch[column as keyof EntityRowPatch] ?? null;
		}
	}
	return flat;
}

/**
 * The fields a denied write would actually have changed — names only, never the
 * attempted values, so the audit row stays privacy-safe.
 */
function changedFields(row: EntityRuleRow | undefined): string[] {
	if (!row) return [];
	const stable = (value: unknown) =>
		JSON.stringify(value === undefined ? null : value);
	return Object.keys(row.patch).filter(
		(field) => stable(row.committed[field]) !== stable(row.patch[field]),
	);
}

interface CommittedRow {
	id: number;
	organization_id: string;
	entity_type: string;
	metadata: unknown;
	rules_compiled: string | null;
	name: string | null;
	slug: string | null;
	parent_id: string | number | null;
	content: string | null;
	deleted_at: Date | null;
	merged_into: string | number | null;
}

function committedState(row: CommittedRow): Record<string, unknown> {
	const metadata = (
		typeof row.metadata === "string"
			? JSON.parse(row.metadata)
			: (row.metadata ?? {})
	) as Record<string, unknown>;
	return {
		...metadata,
		$name: row.name ?? null,
		$slug: row.slug ?? null,
		$parent_id: row.parent_id == null ? null : Number(row.parent_id),
		$content: row.content ?? null,
		$deleted: row.deleted_at != null,
		$merged_into: row.merged_into == null ? null : Number(row.merged_into),
	};
}

function grantSuffix(approvedFields: readonly string[]): string {
	return approvedFields.length > 0
		? ` — approved ${approvedFields.join(", ")}`
		: "";
}

/**
 * Validate an effective patch against every target row's declared write rules,
 * returning the patch branded for {@link patchEntityRows}.
 *
 * This entry point WAIVES NOTHING: it takes no approval list, so any escalate
 * throws and the caller decides whether to route it into an approval or fail
 * closed. A patch that is itself the application of a card a human approved
 * must go through {@link validateEntityRowPatchGrantingApprovedFields}.
 *
 * Queries only the caller's handle — never `getDb()`. A pooled query from
 * inside an entity write transaction is the #2818 deadlock (every pool session
 * parked `idle in transaction` on the same statement), and it would also read a
 * different snapshot than the one being written.
 *
 * @throws EntityRowValidationError when a rule denies the write, when a rule
 * crashes or times out (fail closed: a rule that did not finish cannot bless a
 * write), or when it returns an unusable verdict.
 */
export async function validateEntityRowPatch(params: {
	tx: DbClient;
	ids: number[];
	patch: EntityRowPatch;
	operation?: EntityWriteOperation;
}): Promise<ValidatedEntityRowPatch> {
	return validateEntityRowPatchGrantingApprovedFields({
		...params,
		approvedFields: [],
	});
}

/**
 * The GRANTING validator: the only way to waive an escalation.
 *
 * Takes the fields a human already approved — taken from the proposal that
 * minted their card — and REQUIRES them (no default), so an ordinary write path
 * that never validates against them fails to compile rather than silently
 * waiving.
 *
 * Without this, escalation is a dead end: approving re-runs the same rule
 * against the same state, it escalates again, and the write throws — so the
 * approval a rule asked for could never be honoured.
 *
 * SCOPED, not a blanket waiver. A mode flag would wave through every escalate
 * the rule can raise, including one raised for the first time after the card
 * was minted (a redeployed rule, a moved row) — consent to a field nobody
 * reviewed. Only fields actually on the card are covered; a new escalation
 * needs its own card. A `deny` still throws regardless: approval cannot make
 * an illegal state legal. When an escalate is NOT covered, the thrown error
 * names the approved fields and the rule's requested ones side by side, so an
 * unapproved skip cannot pass in silence.
 *
 * GRANTING is a module-boundary property: only the approval apply path (the
 * module that routed a card) and the entity write kernel that forwards a grant
 * may import this. Enforced by `scripts/check-security-patterns.sh`. Known
 * ceiling: TypeScript has no module-private, so grep is the strongest available
 * enforcement, and the script's allowlist/exemption list can be edited.
 *
 * Same handle/#2818 contract as {@link validateEntityRowPatch}: only the
 * caller's transaction handle, never `getDb()` — because a read on one pooled
 * connection followed by a write on another can be overtaken in between.
 *
 * The single exception is a caller that WRITES NOTHING: `deleteEntity`'s dry
 * run passes the pool deliberately, because a preview enforces nothing and so
 * has no check for a concurrent write to overtake. If a call can commit, it
 * owes this function a transaction.
 *
 * Rows are grouped by their type's compiled rule so each distinct rule runs in
 * ONE isolate over its whole group. Per-row isolates do not scale — measured at
 * ~300 evals/sec, or ~21s for a 5,000-row sync, against ~29.7ms for the same
 * rows batched (see `entity-rule-executor.ts` for the full curve).
 *
 * @throws EntityRowValidationError when a rule denies the write, when a rule
 * crashes or times out (fail closed: a rule that did not finish cannot bless a
 * write), when it returns an unusable verdict, or when it escalates fields the
 * caller has not been granted.
 */
export async function validateEntityRowPatchGrantingApprovedFields(params: {
	tx: DbClient;
	ids: number[];
	patch: EntityRowPatch;
	operation?: EntityWriteOperation;
	/** REQUIRED. Fields a human already approved; anything an escalate names
	 * outside this list throws with the gap spelled out. */
	approvedFields: readonly string[];
}): Promise<ValidatedEntityRowPatch> {
	const { tx, ids, patch, approvedFields, operation = "update" } = params;
	const branded = patch as ValidatedEntityRowPatch;
	if (ids.length === 0) return branded;
	// Fast path: nothing a rule could govern, so no read and no evaluation.
	if (!touchesGovernedColumn(patch)) return branded;

	await enforceCompiledRules({
		tx,
		ids,
		flatPatch: flatten(patch, patch.metadata),
		approvedFields,
		operation,
	});
	return branded;
}

/**
 * Read every target row, group by compiled rule, evaluate, and enforce the
 * verdicts. Shared by the patch seam and the merge seam so the two cannot drift
 * on how a deny is logged or how a grant waives an escalate.
 *
 * Takes an ALREADY-FLAT patch, because the two seams flatten differently: an
 * ordinary patch maps its columns through `RESERVED_COLUMN_NAMES`, while a
 * merge proposes exactly one reserved name and has no metadata of its own.
 */
async function enforceCompiledRules(params: {
	tx: DbClient;
	ids: number[];
	flatPatch: Record<string, unknown>;
	approvedFields: readonly string[];
	operation: EntityWriteOperation;
}): Promise<void> {
	const { tx, ids, flatPatch, approvedFields, operation } = params;

	// The pool runs with `fetch_types: false`, so a raw JS array binds as
	// "malformed array literal". Bind the formatted `{n,n}` text and cast, exactly
	// as `patchEntityRows` itself does.
	//
	// `rules_compiled` rides the join this query already makes, so rule lookup
	// costs no extra round trip.
	const rows = await tx<CommittedRow>`
    SELECT e.id, e.organization_id, et.slug AS entity_type,
           e.metadata, e.name, e.slug, e.parent_id, e.content,
           e.deleted_at, e.merged_into, et.rules_compiled
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(ids)}::bigint[])
  `;

	// One group per distinct compiled rule. Types without rules never reach an
	// isolate at all, which keeps an unruled org's writes exactly as cheap as
	// they are today.
	const groups = new Map<
		string,
		{ targets: CommittedRow[]; rows: EntityRuleRow[] }
	>();
	for (const row of rows) {
		if (!row.rules_compiled) continue;
		const group = groups.get(row.rules_compiled) ?? { targets: [], rows: [] };
		group.targets.push(row);
		group.rows.push({ committed: committedState(row), patch: flatPatch });
		groups.set(row.rules_compiled, group);
	}
	if (groups.size === 0) return;

	for (const [compiled, group] of groups) {
		const verdicts = await runEntityRules({
			compiled,
			rows: group.rows,
			op: "update",
		});
		for (const [index, verdict] of verdicts.entries()) {
			const target = group.targets[index];
			const entityId = target?.id ?? null;
			const entityType = target?.entity_type ?? null;
			const entityOrganizationId = target?.organization_id ?? null;
			if (verdict.outcome === "deny") {
				// The ONLY trace a denial leaves. Without it a rule that rejects a
				// write in prod is structurally invisible — no event, no audit row —
				// and the first incident gets debugged blind.
				logger.info(
					{
						module: "entity-rules",
						entityId,
						outcome: "deny",
						reason: verdict.reason,
					},
					"entity rule verdict",
				);
				throw new EntityRowValidationError(
					`entity ${entityId}: ${verdict.reason}`,
					{
						outcome: "deny",
						reason: verdict.reason,
						fields: changedFields(group.rows[index]),
						operation,
						entityId,
						entityType,
						entityOrganizationId,
					},
				);
			}
			if (verdict.outcome === "escalate") {
				// Every escalated field was on the card a human approved.
				if (
					verdict.fields.length > 0 &&
					verdict.fields.every((f) => approvedFields.includes(f))
				) {
					continue;
				}
				// Not covered: spell out the gap so a partial approval cannot pass
				// in silence. With an empty grant (the waives-nothing entry point)
				// this reads exactly as before.
				throw new EntityRowValidationError(
					`entity ${entityId}: ${verdict.reason} ` +
						`(approval required for ${verdict.fields.join(", ")})` +
						grantSuffix(approvedFields),
					{
						outcome: "escalate",
						reason: verdict.reason,
						fields: verdict.fields,
						operation,
						entityId,
						entityType,
						entityOrganizationId,
					},
				);
			}
		}
	}
}

/**
 * Validate the MERGE of a losing row into a winner.
 *
 * Merge does NOT borrow `$deleted`. A merge tombstones the loser as an
 * implementation detail of the redirect, but the act is a consolidation, not a
 * destruction: the row's data survives, reachable through `merged_into`, and
 * `applyUnmerge` can put it back. A tenant must be able to freeze deletion of a
 * posted invoice without also freezing the dedupe of a double-entered one, so
 * the merge gets its own reserved name and a rule says which it means.
 *
 * Scope is the LOSER's transition only. The winner's metadata patch is NOT
 * validated here: `mergeEntityState` appends the loser's name to
 * `metadata.aliases` on every merge, so validating the winner would present a
 * metadata change to the rule engine every single time — a rule freezing a
 * canonical row would make it unable to absorb any duplicate at all. That needs
 * a decision about what approving a merge grants, not a call added here. The
 * redirect repoint (`expectedMergedInto` non-null) is likewise out of scope: it
 * only ever touches rows that are already tombstoned.
 *
 * Same handle contract as the patch seam — the caller's transaction, never
 * `getDb()`, because `applyMergeInTransaction` already holds the row locks this
 * verdict is judged under.
 *
 * @throws EntityRowValidationError when a rule denies or escalates the merge.
 */
export async function validateEntityRowMergeGrantingApprovedFields(params: {
	tx: DbClient;
	/** The rows being merged AWAY. The winner is not judged here. */
	loserIds: number[];
	/** The canonical row they are being pointed at. */
	mergedInto: number;
	/** REQUIRED, as on the patch seam. `["$merged_into"]` when this call is the
	 * application of a merge a human approved. */
	approvedFields: readonly string[];
}): Promise<void> {
	const { tx, loserIds, mergedInto, approvedFields } = params;
	if (loserIds.length === 0) return;
	await enforceCompiledRules({
		tx,
		ids: loserIds,
		flatPatch: { [RESERVED_COLUMN_NAMES.mergedInto]: mergedInto },
		approvedFields,
		operation: "merge",
	});
}

/**
 * Mint a validated patch WITHOUT running validation.
 *
 * For platform bookkeeping that legitimately sits outside tenant state rules —
 * eval scaffolding, ACL graph upkeep, merge-ledger transitions. Deliberately
 * named and greppable: an exemption should be visible in review, unlike the
 * implicit bypass that every direct `patchEntityRows` caller enjoyed before
 * this seam existed.
 *
 * @param reason why this write is not subject to state validation.
 */
export function unvalidatedEntityRowPatch(params: {
	patch: EntityRowPatch;
	reason: string;
}): ValidatedEntityRowPatch {
	return params.patch as ValidatedEntityRowPatch;
}

// ---------------------------------------------------------------------------
// Inserts
//
// The brand above made skipping validation a compile error for the UPDATE
// writer, and stopped there — so creates went straight to the table. That made
// every rule trivially routable: an agent denied a `draft -> posted` update
// simply creates the document already posted. Regression-tested, with the
// contrast case, in `__tests__/integration/authz/entity-create-validation.test.ts`.
//
// The fix is not a new mechanism, it is the SAME brand on the second writer. A
// create is an update from nothing: `committed` is `{}`, so `changed(f)` is true
// for every field being set and a rule's transition check rejects a document
// born in a state nothing exits into.
// ---------------------------------------------------------------------------

/**
 * An `EntityRowInsert` that has passed validation (or been explicitly exempted).
 * Shares {@link validatedBrand} with {@link ValidatedEntityRowPatch}: one brand,
 * two shapes, so there is one thing to reason about rather than two.
 */
export type ValidatedEntityRowInsert = EntityRowInsert & {
	readonly [validatedBrand]: true;
};

/**
 * Validate a pending insert against its type's write rules, returning the row
 * branded for {@link insertEntityRow}.
 *
 * Same waives-nothing contract as {@link validateEntityRowPatch}: no approval
 * list, so an escalate stops the create. A create that APPLIES a card a human
 * approved must go through {@link validateEntityRowInsertGrantingApprovedFields}.
 *
 * Reads `entity_types` directly rather than joining through `entities`, because
 * the row does not exist yet — that is the only structural difference from the
 * update path.
 *
 * @throws EntityRowValidationError when the rule denies the create, or when it
 * escalates and the caller has not opted into approval routing.
 */
export async function validateEntityRowInsert(params: {
	tx: DbClient;
	row: EntityRowInsert;
}): Promise<ValidatedEntityRowInsert> {
	return validateEntityRowInsertGrantingApprovedFields({
		...params,
		approvedFields: [],
	});
}

/**
 * The GRANTING validator for creates: the only way to waive an escalation on
 * an insert.
 *
 * Same required-approval-list contract as
 * {@link validateEntityRowPatchGrantingApprovedFields}, including the
 * module-boundary restriction and the diagnostic on an uncovered escalate — a
 * create that is the application of a card may only cover fields that card
 * showed.
 */
export async function validateEntityRowInsertGrantingApprovedFields(params: {
	tx: DbClient;
	row: EntityRowInsert;
	/** REQUIRED. Fields a human already approved on the create card. */
	approvedFields: readonly string[];
}): Promise<ValidatedEntityRowInsert> {
	const { tx, row, approvedFields } = params;
	const branded = row as ValidatedEntityRowInsert;

	const types = await tx<{
		rules_compiled: string | null;
		slug: string;
	}>`
    SELECT rules_compiled, slug
    FROM entity_types WHERE id = ${row.entityTypeId}
  `;
	const type = types[0];
	const compiled = type?.rules_compiled;
	if (!compiled) return branded;
	const flatPatch = flatten(
		{
			name: row.name,
			slug: row.slug,
			parentId: row.parentId ?? null,
			content: row.content ?? null,
		},
		row.metadata,
	);

	const [verdict] = await runEntityRules({
		compiled,
		op: "create",
		rows: [
			{
				// Nothing is committed yet, so a transition check reads the create as
				// a move from nothing — which a rule can either let fall through its
				// transition table or handle explicitly via `op`.
				committed: {},
				patch: flatPatch,
			},
		],
	});

	if (verdict?.outcome === "deny") {
		throw new EntityRowValidationError(`new ${row.slug}: ${verdict.reason}`, {
			outcome: "deny",
			reason: verdict.reason,
			fields: changedFields({ committed: {}, patch: flatPatch }),
			operation: "create",
			entityId: null,
			entityType: type?.slug ?? null,
			entityOrganizationId: row.organizationId,
		});
	}
	if (verdict?.outcome === "escalate") {
		// Every escalated field was on the card a human approved.
		if (
			verdict.fields.length > 0 &&
			verdict.fields.every((f) => approvedFields.includes(f))
		) {
			return branded;
		}
		// Otherwise stop the create and let the caller route it. A create needs no
		// held-field bookkeeping — the row does not exist, so an aborted
		// transaction leaves nothing behind and the whole proposal is the card.
		throw new EntityRowValidationError(
			`new ${row.slug}: ${verdict.reason} ` +
				`(approval required for ${verdict.fields.join(", ")})` +
				grantSuffix(approvedFields),
			{
				outcome: "escalate",
				reason: verdict.reason,
				fields: verdict.fields,
				operation: "create",
				entityId: null,
				entityType: type?.slug ?? null,
				entityOrganizationId: row.organizationId,
			},
		);
	}
	return branded;
}

/**
 * Mint a validated insert WITHOUT running validation.
 *
 * Same contract as {@link unvalidatedEntityRowPatch}: platform bookkeeping that
 * legitimately sits outside tenant rules, named so the exemption is greppable
 * and visible in review.
 *
 * @param reason why this create is not subject to write rules.
 */
export function unvalidatedEntityRowInsert(params: {
	row: EntityRowInsert;
	reason: string;
}): ValidatedEntityRowInsert {
	return params.row as ValidatedEntityRowInsert;
}
