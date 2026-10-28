/**
 * Shared entity field-merge primitive for the automation<->human feedback loop.
 *
 * The value lives in `entities.metadata`; per-field ownership lives in the sparse
 * `entities.field_controls` jsonb column (a key present = that field is human-owned).
 * This is the SINGLE write path for both human edits and automation promotion:
 *   - source='human'  : writes every changed field AND marks it owned (note/set_by/set_at).
 *   - source='automation': writes only fields that are NOT human-owned; owned fields are
 *     returned in `blocked` (the caller emits an approval) and never overwritten.
 *
 * This module is the pure decision engine — unit-testable without a DB. The
 * transaction-bound persistence wrapper is `mergeEntityFields`, which lives in
 * entity-management.ts so the write goes through the physical row kernel.
 * Callers own the audit `'change'` event (handleUpdate / promotion emit it).
 */

export type FieldWriteSource = "human" | "automation";

/** Per-field ownership marker stored under entities.field_controls[field]. */
export interface FieldControl {
	note?: string | null;
	set_by?: string | null;
	set_at?: string;
	/** The token client (`pat_<id>`) whose `manual_edit` assertion claimed the field. */
	asserted_by_client?: string;
}

export interface AppliedChange {
	old: unknown;
	new: unknown;
}
export interface BlockedChange {
	current: unknown;
	proposed: unknown;
}
export interface StaleChange {
	/** The live value the proposal was based on (proposal.current snapshot). */
	expected: unknown;
	/** The value actually in metadata now — a human moved it since the proposal. */
	live: unknown;
}

export interface FieldMergeResult {
	/** Fields whose value changed and were written to metadata. */
	applied: Record<string, AppliedChange>;
	/** Owned fields an automation tried to change — NOT written; surface as an approval. */
	blocked: Record<string, BlockedChange>;
	/** Fields skipped because the live value drifted from the proposal's snapshot
	 *  (a human re-edited the field after the proposal was queued). NOT written. */
	stale: Record<string, StaleChange>;
	/** Fields whose CURRENT value a human affirmed — value unchanged, but ownership
	 *  is now claimed so an automation can't silently overwrite it. */
	affirmed: string[];
	nextMetadata: Record<string, unknown>;
	nextControls: Record<string, FieldControl>;
	changed: boolean;
}

/** Order-insensitive value comparison for change detection. */
function sameValue(a: unknown, b: unknown): boolean {
	return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(
		([a], [b]) => a.localeCompare(b),
	);
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Pure merge decision. Given the current metadata + ownership controls, decide which
 * proposed `fields` get applied vs blocked, and produce the next metadata/controls.
 * No DB, no I/O — the unit-tested heart of the feedback loop's correctness.
 */
export function computeFieldMerge(args: {
	metadata: Record<string, unknown>;
	controls: Record<string, FieldControl>;
	fields: Record<string, unknown>;
	source: FieldWriteSource;
	actorId: string | null;
	note: string | null;
	nowIso: string;
	/** When provided (deferred apply of a queued proposal), each field is written only
	 *  if its live metadata value still equals the snapshot the proposal was built on.
	 *  A drifted field is skipped (`stale`) so a stale approval can't clobber a value
	 *  the human moved after the proposal was queued. */
	expectedCurrent?: Record<string, unknown> | null;
	/** Fields (source='human' only) whose CURRENT value the human approves as-is:
	 *  no value change, but ownership is claimed so an automation can't later overwrite
	 *  it without an approval. This is the "approve" half of the per-item recap
	 *  feedback loop — affirming a value is NOT a no-op the way re-setting an
	 *  unchanged value is. */
	affirm?: string[];
	/** source='human' only: the client whose `manual_edit` assertion made this a
	 *  human edit, recorded on each ownership marker this merge writes. */
	assertedByClient?: string | null;
	/** Additional fields a non-human policy decision requires approval for, even
	 * when the field is not already human-owned. */
	requireApproval?: string[] | Set<string>;
}): FieldMergeResult {
	const {
		metadata,
		controls,
		fields,
		source,
		actorId,
		note,
		nowIso,
		expectedCurrent,
		affirm,
		assertedByClient,
	} = args;
	const marker = (): FieldControl => ({
		note,
		set_by: actorId,
		set_at: nowIso,
		...(assertedByClient ? { asserted_by_client: assertedByClient } : {}),
	});
	const requireApproval = new Set(args.requireApproval ?? []);
	const nextMetadata: Record<string, unknown> = { ...metadata };
	const nextControls: Record<string, FieldControl> = { ...controls };
	const applied: Record<string, AppliedChange> = {};
	const blocked: Record<string, BlockedChange> = {};
	const stale: Record<string, StaleChange> = {};
	const affirmed: string[] = [];

	for (const [field, value] of Object.entries(fields)) {
		const current = metadata[field];
		const owned = Object.hasOwn(controls, field);

		// Deferred-apply staleness guard: the human re-edited the field after this
		// proposal was queued, so the proposal is based on an outdated value — skip it.
		if (expectedCurrent && Object.hasOwn(expectedCurrent, field)) {
			if (!sameValue(current, expectedCurrent[field])) {
				stale[field] = {
					expected: expectedCurrent[field] ?? null,
					live: current ?? null,
				};
				continue;
			}
		}

		// An automation must never overwrite a human-owned field — propose instead.
		// Policy may also require approval for fields that are not human-owned yet.
		if (source === "automation" && (owned || requireApproval.has(field))) {
			if (!sameValue(current, value)) {
				blocked[field] = { current: current ?? null, proposed: value };
			}
			continue;
		}

		if (sameValue(current, value)) continue;

		applied[field] = { old: current ?? null, new: value };
		nextMetadata[field] = value;
		// A human edit claims ownership of the field it sets.
		if (source === "human") {
			nextControls[field] = marker();
		}
	}

	// Approve/affirm: claim ownership of a field's current value without changing
	// it. Only humans can affirm; a field already written above is skipped (the
	// set already claimed it). Marking an owned-but-unchanged field is idempotent
	// (it refreshes set_by/set_at/note), so re-approving is safe.
	if (source === "human" && affirm) {
		for (const field of affirm) {
			if (Object.hasOwn(applied, field)) continue;
			if (!Object.hasOwn(metadata, field)) continue;
			nextControls[field] = marker();
			affirmed.push(field);
		}
	}

	return {
		applied,
		blocked,
		stale,
		affirmed,
		nextMetadata,
		nextControls,
		changed: Object.keys(applied).length > 0 || affirmed.length > 0,
	};
}
