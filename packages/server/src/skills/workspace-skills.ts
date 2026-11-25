/**
 * The workspace skill library (`workspace_skills` +
 * `workspace_skill_subjects`). Every reader and writer goes through here: the
 * chat producer's per-principal resolution, the Automation save-time freeze,
 * and `manage_skills` list/get/put/archive/install_from_catalog.
 */
import { randomBytes } from "node:crypto";
import { isLibrarySkillName, LIBRARY_SKILL_NAME_MAX_CHARS } from "@lobu/core/agent-tooling";
import type { SkillInput, SkillSubject, WorkspaceSkill } from "@lobu/core/contracts/tools/manage-skills";
import type { DbClient } from "../db/client";
import { pgTextArray } from "../db/client";
import type { ActingPrincipal } from "../authz/entity-policy";
import { ToolUserError } from "../utils/errors";

/** The subset of a principal a skill subject can name; see `principalMatches`. */
export type SkillPrincipal = Pick<ActingPrincipal, "kind" | "id" | "ownerAgentId">;

interface SkillRow {
	id: string;
	name: string;
	description: string;
	content: string;
	provenance: string | null;
	enabled: boolean;
	sort_order: number;
	revision: string | number;
	archived_at: Date | string | null;
}

interface SubjectRow {
	skill_id: string;
	principal_kind: "agent" | "app" | null;
	principal_id: string | null;
}

/** A library skill as the per-principal readers see it. */
export interface ApplyingSkill {
	id: string;
	name: string;
	description: string;
	content: string;
	provenance: string | null;
	enabled: boolean;
	revision: number;
}

/**
 * The unarchived skills that apply to `principal`, in delivery order
 * `(sort_order, name)`. One indexed read over a bounded config table; the
 * subject predicate is `principalMatches` in SQL: everyone, the principal's
 * kind, the principal itself, or (for an Automation) its owner agent.
 * `enabledOnly` narrows to the skills a run receives.
 */
export async function librarySkillsApplyingTo(
	sql: DbClient,
	organizationId: string,
	principal: SkillPrincipal,
	options: { enabledOnly: boolean },
): Promise<ApplyingSkill[]> {
	const ownerAgentId = principal.kind === "automation" ? principal.ownerAgentId : null;
	const rows = await sql<Omit<ApplyingSkill, "revision"> & { revision: string | number }>`
		SELECT s.id, s.name, s.description, s.content, s.provenance, s.enabled, s.revision
		FROM workspace_skills s
		WHERE s.organization_id = ${organizationId}
		  AND (${!options.enabledOnly} OR s.enabled)
		  AND s.archived_at IS NULL
		  AND EXISTS (
		    SELECT 1 FROM workspace_skill_subjects ss
		    WHERE ss.skill_id = s.id
		      AND ss.organization_id = s.organization_id
		      AND (
		        ss.principal_kind IS NULL
		        OR (ss.principal_kind = ${principal.kind}
		            AND (ss.principal_id IS NULL OR ss.principal_id = ${principal.id}))
		        OR (${ownerAgentId}::text IS NOT NULL AND ss.principal_kind = 'agent'
		            AND (ss.principal_id IS NULL OR ss.principal_id = ${ownerAgentId}))
		      )
		  )
		ORDER BY s.sort_order, s.name COLLATE "C"
	`;
	return rows.map((row) => ({ ...row, revision: Number(row.revision) }));
}

/** The enabled skills a run for `principal` receives, as `{ name, content }`. */
export async function resolveLibrarySkillsFor(
	sql: DbClient,
	organizationId: string,
	principal: SkillPrincipal,
): Promise<Array<{ name: string; content: string }>> {
	const skills = await librarySkillsApplyingTo(sql, organizationId, principal, { enabledOnly: true });
	return skills.map((skill) => ({ name: skill.name, content: skill.content }));
}

/** A library skill as an Automation pin freezes it. */
export interface PinnableSkill {
	id: string;
	name: string;
	content: string;
	revision: number;
}

/**
 * The unarchived library skills with these names, keyed by name. Disabled
 * skills are included: an Automation freezes a disabled skill's body the same
 * as an enabled one, because naming it is the opt-in.
 */
export async function librarySkillsByName(
	sql: DbClient,
	organizationId: string,
	names: readonly string[],
): Promise<Map<string, PinnableSkill>> {
	if (names.length === 0) return new Map();
	const rows = await sql<Omit<PinnableSkill, "revision"> & { revision: string | number }>`
		SELECT id, name, content, revision
		FROM workspace_skills
		WHERE organization_id = ${organizationId}
		  AND archived_at IS NULL
		  AND name = ANY(${pgTextArray([...names])}::text[])
	`;
	return new Map(rows.map((row) => [row.name, { ...row, revision: Number(row.revision) }]));
}

/**
 * The current library state of the skills these pins recorded, for drift
 * flags: by `skill_id` for pins that carry one (archived rows included, so an
 * archived skill reads as missing rather than as a different skill), and by
 * name among unarchived rows for historical pins.
 */
export async function libraryStateForPins(
	sql: DbClient,
	organizationId: string,
	pins: { ids: readonly string[]; names: readonly string[] },
): Promise<{
	byId: Map<string, { revision: number; archived: boolean }>;
	byName: Map<string, { content: string }>;
}> {
	const byId = new Map<string, { revision: number; archived: boolean }>();
	const byName = new Map<string, { content: string }>();
	if (pins.ids.length > 0) {
		const rows = await sql<{ id: string; revision: string | number; archived: boolean }>`
			SELECT id, revision, archived_at IS NOT NULL AS archived
			FROM workspace_skills
			WHERE organization_id = ${organizationId}
			  AND id = ANY(${pgTextArray([...pins.ids])}::text[])
		`;
		for (const row of rows) byId.set(row.id, { revision: Number(row.revision), archived: row.archived });
	}
	if (pins.names.length > 0) {
		const rows = await sql<{ name: string; content: string }>`
			SELECT name, content
			FROM workspace_skills
			WHERE organization_id = ${organizationId}
			  AND archived_at IS NULL
			  AND name = ANY(${pgTextArray([...pins.names])}::text[])
		`;
		for (const row of rows) byName.set(row.name, { content: row.content });
	}
	return { byId, byName };
}

/** A frozen Automation skill copy, flagged against the library's current state. */
export type FlaggedSkillCopy<T extends { name: string; content: string }> = T & {
	/** The library no longer has this skill (archived, or no row by that name). */
	missing: boolean;
	/** The library's skill changed since the copy was frozen. */
	outdated: boolean;
};

/**
 * Flag each frozen copy `missing` or `outdated`. A pin that recorded its
 * `skill_id` compares by identity and revision; a historical pin (name and body
 * only) compares by name and body. One read per set of pins, not per copy.
 */
export async function flagPinnedSkillCopies<T extends { name: string; content: string; skill_id?: string; revision?: number }>(
	sql: DbClient,
	organizationId: string,
	copySets: ReadonlyArray<readonly T[]>,
): Promise<Array<Array<FlaggedSkillCopy<T>>>> {
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const copies of copySets) {
		for (const copy of copies) {
			if (copy.skill_id !== undefined) ids.add(copy.skill_id);
			else names.add(copy.name);
		}
	}
	const state = await libraryStateForPins(sql, organizationId, { ids: [...ids], names: [...names] });
	return copySets.map((copies) =>
		copies.map((copy) => {
			if (copy.skill_id !== undefined) {
				const current = state.byId.get(copy.skill_id);
				const missing = !current || current.archived;
				return { ...copy, missing, outdated: !missing && current?.revision !== copy.revision };
			}
			const current = state.byName.get(copy.name);
			return { ...copy, missing: !current, outdated: !!current && current.content !== copy.content };
		}),
	);
}

// ============================================
// manage_skills list / get
// ============================================

interface ListCursor {
	sortOrder: number;
	name: string;
	id: string;
}

function encodeCursor(cursor: ListCursor): string {
	return Buffer.from(JSON.stringify([cursor.sortOrder, cursor.name, cursor.id])).toString("base64url");
}

function decodeCursor(raw: string): ListCursor {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (
			Array.isArray(parsed) &&
			parsed.length === 3 &&
			Number.isInteger(parsed[0]) &&
			typeof parsed[1] === "string" &&
			typeof parsed[2] === "string"
		) {
			return { sortOrder: parsed[0], name: parsed[1], id: parsed[2] };
		}
	} catch {
		// fall through to the 422 below
	}
	throw new ToolUserError("cursor is not a next_cursor returned by list.", 422);
}

function toSubject(row: SubjectRow): SkillSubject {
	return row.principal_kind === null
		? { principal_kind: null }
		: { principal_kind: row.principal_kind, principal_id: row.principal_id };
}

async function withSubjects(sql: DbClient, organizationId: string, rows: SkillRow[]): Promise<WorkspaceSkill[]> {
	if (rows.length === 0) return [];
	const subjects = await sql<SubjectRow>`
		SELECT skill_id, principal_kind, principal_id
		FROM workspace_skill_subjects
		WHERE organization_id = ${organizationId}
		  AND skill_id = ANY(${pgTextArray(rows.map((row) => row.id))}::text[])
		ORDER BY skill_id,
		         principal_kind NULLS FIRST,
		         principal_id COLLATE "C" NULLS FIRST
	`;
	const bySkill = new Map<string, SkillSubject[]>();
	for (const subject of subjects) {
		const list = bySkill.get(subject.skill_id) ?? [];
		list.push(toSubject(subject));
		bySkill.set(subject.skill_id, list);
	}
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		description: row.description,
		content: row.content,
		...(row.provenance === null ? {} : { provenance: row.provenance }),
		applies_to: bySkill.get(row.id) ?? [],
		enabled: row.enabled,
		sort_order: row.sort_order,
		revision: Number(row.revision),
		archived: row.archived_at !== null,
	}));
}

export async function listWorkspaceSkills(
	sql: DbClient,
	organizationId: string,
	options: { includeArchived: boolean; cursor?: string; limit: number },
): Promise<{ items: WorkspaceSkill[]; next_cursor: string | null }> {
	const after = options.cursor === undefined ? null : decodeCursor(options.cursor);
	const rows = await sql<SkillRow>`
		SELECT id, name, description, content, provenance, enabled, sort_order, revision, archived_at
		FROM workspace_skills
		WHERE organization_id = ${organizationId}
		  AND (${options.includeArchived} OR archived_at IS NULL)
		  AND (${after === null}
		       OR (sort_order, name COLLATE "C", id COLLATE "C")
		          > (${after?.sortOrder ?? 0}::integer, ${after?.name ?? ""}::text COLLATE "C", ${after?.id ?? ""}::text COLLATE "C"))
		ORDER BY sort_order, name COLLATE "C", id COLLATE "C"
		LIMIT ${options.limit + 1}
	`;
	const page = rows.slice(0, options.limit);
	const last = page.at(-1);
	return {
		items: await withSubjects(sql, organizationId, page),
		next_cursor:
			rows.length > options.limit && last
				? encodeCursor({ sortOrder: last.sort_order, name: last.name, id: last.id })
				: null,
	};
}

/** One skill by id (archived or not), or an unarchived skill by name; 404 when absent or in another workspace. */
export async function getWorkspaceSkill(
	sql: DbClient,
	organizationId: string,
	key: { id: string } | { name: string },
): Promise<WorkspaceSkill> {
	const rows =
		"id" in key
			? await sql<SkillRow>`
				SELECT id, name, description, content, provenance, enabled, sort_order, revision, archived_at
				FROM workspace_skills
				WHERE organization_id = ${organizationId} AND id = ${key.id}
			`
			: await sql<SkillRow>`
				SELECT id, name, description, content, provenance, enabled, sort_order, revision, archived_at
				FROM workspace_skills
				WHERE organization_id = ${organizationId} AND name = ${key.name} AND archived_at IS NULL
			`;
	const [skill] = await withSubjects(sql, organizationId, rows);
	if (!skill) {
		throw new ToolUserError(
			"id" in key ? `Skill "${key.id}" not found` : `No skill named "${key.name}"`,
			404,
		);
	}
	return skill;
}

// ============================================
// manage_skills writes
// ============================================

/** A skill's writable fields with every default applied. */
export interface SkillBody {
	name: string;
	description: string;
	content: string;
	provenance: string | null;
	applies_to: SkillSubject[];
	enabled: boolean;
	sort_order: number;
}

/**
 * One library write, validated and ready to apply: a create (no id, revision
 * 0), a full replace of skill `id` at `expected_revision`, or an archive.
 */
export type SkillWrite =
	| { op: "create"; id: null; expected_revision: 0; skill: SkillBody }
	| { op: "update"; id: string; expected_revision: number; skill: SkillBody }
	| { op: "archive"; id: string; expected_revision: number; skill: null };

const EVERYONE: SkillSubject[] = [{ principal_kind: null }];

/**
 * Apply defaults and the rules the input schema cannot express: the library
 * name grammar, non-blank text, agent-only subjects (app subjects arrive with
 * the MCP Skills extension), and duplicate subjects folded. 422 on bad input.
 */
export function normalizeSkillInput(input: SkillInput): SkillBody {
	if (!isLibrarySkillName(input.name)) {
		throw new ToolUserError(
			`Skill name "${input.name}" is invalid: use lowercase letters, digits and single inner hyphens, at most ${LIBRARY_SKILL_NAME_MAX_CHARS} characters.`,
			422,
		);
	}
	const description = input.description.trim();
	if (!description) throw new ToolUserError("Skill description must not be blank.", 422);
	if (!input.content.trim()) throw new ToolUserError("Skill content must not be blank.", 422);
	return {
		name: input.name,
		description,
		content: input.content,
		provenance: input.provenance ?? null,
		applies_to: normalizeSkillSubjects(input.applies_to ?? EVERYONE),
		enabled: input.enabled ?? true,
		sort_order: input.sort_order ?? 0,
	};
}

/** Reject app subjects and fold duplicates, keeping the caller's order. */
function normalizeSkillSubjects(subjects: readonly SkillSubject[]): SkillSubject[] {
	const seen = new Set<string>();
	const out: SkillSubject[] = [];
	for (const subject of subjects) {
		if (subject.principal_kind === "app") {
			throw new ToolUserError("Skills apply to everyone or to agents; app subjects are not accepted yet.", 422);
		}
		const key = subject.principal_kind === null ? "" : `agent:${subject.principal_id ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(subject);
	}
	return out;
}

/** 422 when a subject names an agent this workspace does not have. */
async function assertSubjectAgentsExist(sql: DbClient, organizationId: string, subjects: readonly SkillSubject[]): Promise<void> {
	const ids = subjects.flatMap((subject) =>
		subject.principal_kind === "agent" && subject.principal_id !== null ? [subject.principal_id] : [],
	);
	if (ids.length === 0) return;
	const rows = await sql<{ id: string }>`
		SELECT id FROM agents
		WHERE organization_id = ${organizationId} AND id = ANY(${pgTextArray(ids)}::text[])
	`;
	const found = new Set(rows.map((row) => row.id));
	const missing = ids.filter((id) => !found.has(id));
	if (missing.length > 0) {
		throw new ToolUserError(`applies_to names agent(s) not in this workspace: ${missing.join(", ")}`, 422);
	}
}

/**
 * Check a write against the library's current state and return the skill it
 * replaces (null for a create): 404 for a missing or foreign id, 409 for an
 * archived target, a stale `expected_revision` or a taken name, 422 for a
 * rename. `lock` takes the target row's write lock, for the applying
 * transaction; the approval queue checks without it.
 */
export async function checkSkillWrite(
	sql: DbClient,
	organizationId: string,
	write: SkillWrite,
	options: { lock: boolean },
): Promise<WorkspaceSkill | null> {
	if (write.skill) await assertSubjectAgentsExist(sql, organizationId, write.skill.applies_to);
	if (write.op === "create") {
		const [taken] = await sql<{ id: string }>`
			SELECT id FROM workspace_skills
			WHERE organization_id = ${organizationId} AND name = ${write.skill.name} AND archived_at IS NULL
		`;
		if (taken) throw new ToolUserError(`A skill named "${write.skill.name}" already exists (id ${taken.id}).`, 409);
		return null;
	}
	const rows = options.lock
		? await sql<SkillRow>`
			SELECT id, name, description, content, provenance, enabled, sort_order, revision, archived_at
			FROM workspace_skills
			WHERE organization_id = ${organizationId} AND id = ${write.id}
			FOR UPDATE
		`
		: await sql<SkillRow>`
			SELECT id, name, description, content, provenance, enabled, sort_order, revision, archived_at
			FROM workspace_skills
			WHERE organization_id = ${organizationId} AND id = ${write.id}
		`;
	const [current] = await withSubjects(sql, organizationId, rows);
	if (!current) throw new ToolUserError(`Skill "${write.id}" not found`, 404);
	if (current.archived) throw new ToolUserError(`Skill "${write.id}" is archived.`, 409);
	if (current.revision !== write.expected_revision) {
		throw new ToolUserError(
			`Skill "${current.name}" is at revision ${current.revision}, not ${write.expected_revision}; re-read it and retry.`,
			409,
		);
	}
	if (write.op === "update" && write.skill.name !== current.name) {
		throw new ToolUserError(
			`Skill names are fixed: "${current.name}" cannot become "${write.skill.name}". Archive it and create a new skill instead.`,
			422,
		);
	}
	return current;
}

function subjectKeys(subjects: readonly SkillSubject[]): string {
	return subjects
		.map((subject) => (subject.principal_kind === null ? "*" : `${subject.principal_kind}:${subject.principal_id ?? "*"}`))
		.sort()
		.join("\n");
}

function sameSkillBody(current: WorkspaceSkill, next: SkillBody): boolean {
	return (
		current.description === next.description &&
		current.content === next.content &&
		(current.provenance ?? null) === next.provenance &&
		current.enabled === next.enabled &&
		current.sort_order === next.sort_order &&
		subjectKeys(current.applies_to) === subjectKeys(next.applies_to)
	);
}

async function insertSubjects(sql: DbClient, organizationId: string, skillId: string, subjects: readonly SkillSubject[]): Promise<void> {
	for (const subject of subjects) {
		await sql`
			INSERT INTO workspace_skill_subjects (skill_id, organization_id, principal_kind, principal_id)
			VALUES (${skillId}, ${organizationId}, ${subject.principal_kind},
			        ${subject.principal_kind === null ? null : subject.principal_id})
		`;
	}
}

/**
 * Apply a write inside the caller's transaction, re-checking it under the row
 * lock first. Returns the skill before and after; `changed` is false for a put
 * that matches the stored skill, which then keeps its revision.
 */
export async function applySkillWrite(
	tx: DbClient,
	organizationId: string,
	write: SkillWrite,
): Promise<{ before: WorkspaceSkill | null; after: WorkspaceSkill; changed: boolean }> {
	const before = await checkSkillWrite(tx, organizationId, write, { lock: true });
	if (write.op === "archive") {
		await tx`
			UPDATE workspace_skills
			SET archived_at = now(), revision = revision + 1, updated_at = now()
			WHERE organization_id = ${organizationId} AND id = ${write.id}
		`;
		return { before, after: await getWorkspaceSkill(tx, organizationId, { id: write.id }), changed: true };
	}
	const skill = write.skill;
	if (write.op === "update" && before && sameSkillBody(before, skill)) {
		return { before, after: before, changed: false };
	}
	let id: string;
	if (write.op === "create") {
		id = `skill_${randomBytes(16).toString("hex")}`;
		// A concurrent create can take the name between the check and here; the
		// partial unique index on unarchived names turns that into no row.
		const inserted = await tx`
			INSERT INTO workspace_skills
			  (id, organization_id, name, description, content, provenance, enabled, sort_order)
			VALUES (${id}, ${organizationId}, ${skill.name}, ${skill.description}, ${skill.content},
			        ${skill.provenance}, ${skill.enabled}, ${skill.sort_order})
			ON CONFLICT DO NOTHING
			RETURNING id
		`;
		if (inserted.length === 0) throw new ToolUserError(`A skill named "${skill.name}" already exists.`, 409);
	} else {
		id = write.id;
		await tx`
			UPDATE workspace_skills
			SET description = ${skill.description}, content = ${skill.content}, provenance = ${skill.provenance},
			    enabled = ${skill.enabled}, sort_order = ${skill.sort_order},
			    revision = revision + 1, updated_at = now()
			WHERE organization_id = ${organizationId} AND id = ${id}
		`;
		await tx`
			DELETE FROM workspace_skill_subjects
			WHERE organization_id = ${organizationId} AND skill_id = ${id}
		`;
	}
	await insertSubjects(tx, organizationId, id, skill.applies_to);
	return { before, after: await getWorkspaceSkill(tx, organizationId, { id }), changed: true };
}
