/**
 * Reads of the workspace skill library (`workspace_skills` +
 * `workspace_skill_subjects`). Every reader goes through here: the chat
 * producer's per-principal resolution, the Automation save-time freeze, and
 * `manage_skills` list/get. Library writes arrive with P3b.
 */
import type { SkillSubject, WorkspaceSkill } from "@lobu/core/contracts/tools/manage-skills";
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
