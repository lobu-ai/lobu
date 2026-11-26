/**
 * The workspace guardrail library (`workspace_guardrails` +
 * `workspace_guardrail_subjects`). Every reader goes through here: the message
 * pipeline (chat input/output, pre-tool on the outbound MCP proxy and on inbound
 * MCP tool calls) and the read-only REST/SDK list/get; the REST writers apply
 * through here too.
 */
import { randomBytes } from "node:crypto";
import { isLibrarySkillName, LIBRARY_SKILL_NAME_MAX_CHARS } from "@lobu/core/agent-tooling";
import {
	type GuardrailSubject,
	type ListGuardrailsResult,
	parseGuardrailConfig,
	type WorkspaceGuardrail,
	type WorkspaceGuardrailConfig,
} from "@lobu/core/contracts/workspace-guardrails";
import type { ActingPrincipal } from "../authz/entity-policy";
import { appKeyProblem } from "../authz/policy-principal";
import { LOOP_POLICY_CUTOVER_INDEX } from "../authz/policy-hooks";
import type { DbClient } from "../db/client";
import { pgTextArray } from "../db/client";
import { builtinGuardrailStages } from "../gateway/guardrails/builtins";
import { ToolUserError } from "../utils/errors";

/** The subset of a principal a guardrail subject can name; see `principalMatches`. */
export type GuardrailPrincipal = Pick<ActingPrincipal, "kind" | "id" | "ownerAgentId">;

/** An agent as a guardrail subject sees it. */
export function agentGuardrailPrincipal(agentId: string): GuardrailPrincipal {
	return { kind: "agent", id: agentId, ownerAgentId: null };
}

/** A library guardrail as the enforcement points see it. */
export interface ApplyingGuardrail {
	id: string;
	name: string;
	config: WorkspaceGuardrailConfig;
	enabled: boolean;
	revision: number;
}

/**
 * The guardrails enforced for `principal`: enabled, unarchived, and applying
 * to it. Guardrails accumulate — every one returned runs, and any trip wins.
 * One indexed read over a bounded config table; the subject predicate is
 * `principalMatches` in SQL: everyone, the principal's kind, the principal
 * itself, or (for an Automation) its owner agent.
 */
export async function resolveGuardrails(
	sql: DbClient,
	organizationId: string,
	principal: GuardrailPrincipal,
): Promise<ApplyingGuardrail[]> {
	const ownerAgentId = principal.kind === "automation" ? principal.ownerAgentId : null;
	const rows = await sql<Omit<ApplyingGuardrail, "revision"> & { revision: string | number }>`
		SELECT g.id, g.name, g.config, g.enabled, g.revision
		FROM workspace_guardrails g
		WHERE g.organization_id = ${organizationId}
		  AND g.archived_at IS NULL
		  AND g.enabled
		  AND to_regclass(${LOOP_POLICY_CUTOVER_INDEX}) IS NULL
		  AND EXISTS (
		    SELECT 1 FROM workspace_guardrail_subjects gs
		    WHERE gs.guardrail_id = g.id
		      AND gs.organization_id = g.organization_id
		      AND (
		        gs.principal_kind IS NULL
		        OR (gs.principal_kind = ${principal.kind}
		            AND (gs.principal_id IS NULL OR gs.principal_id = ${principal.id}))
		        OR (${ownerAgentId}::text IS NOT NULL AND gs.principal_kind = 'agent'
		            AND (gs.principal_id IS NULL OR gs.principal_id = ${ownerAgentId}))
		      )
		  )
		ORDER BY g.name COLLATE "C", g.id COLLATE "C"
	`;
	return rows.map((row) => ({ ...row, revision: Number(row.revision) }));
}

// ============================================
// Read-only list / get (REST and client.guardrails)
// ============================================

interface GuardrailRow {
	id: string;
	name: string;
	config: WorkspaceGuardrailConfig;
	enabled: boolean;
	revision: string | number;
	archived_at: Date | string | null;
}

interface SubjectRow {
	guardrail_id: string;
	principal_kind: "agent" | "app" | null;
	principal_id: string | null;
}

function encodeCursor(cursor: { name: string; id: string }): string {
	return Buffer.from(JSON.stringify([cursor.name, cursor.id])).toString("base64url");
}

function decodeCursor(raw: string): { name: string; id: string } {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			typeof parsed[0] === "string" &&
			typeof parsed[1] === "string"
		) {
			return { name: parsed[0], id: parsed[1] };
		}
	} catch {
		// fall through to the 422 below
	}
	throw new ToolUserError("cursor is not a next_cursor returned by list.", 422);
}

function toSubject(row: SubjectRow): GuardrailSubject {
	return row.principal_kind === null
		? { principal_kind: null }
		: { principal_kind: row.principal_kind, principal_id: row.principal_id };
}

async function withSubjects(
	sql: DbClient,
	organizationId: string,
	rows: GuardrailRow[],
): Promise<WorkspaceGuardrail[]> {
	if (rows.length === 0) return [];
	const subjects = await sql<SubjectRow>`
		SELECT guardrail_id, principal_kind, principal_id
		FROM workspace_guardrail_subjects
		WHERE organization_id = ${organizationId}
		  AND guardrail_id = ANY(${pgTextArray(rows.map((row) => row.id))}::text[])
		ORDER BY guardrail_id,
		         principal_kind NULLS FIRST,
		         principal_id COLLATE "C" NULLS FIRST
	`;
	const byGuardrail = new Map<string, GuardrailSubject[]>();
	for (const subject of subjects) {
		const list = byGuardrail.get(subject.guardrail_id) ?? [];
		list.push(toSubject(subject));
		byGuardrail.set(subject.guardrail_id, list);
	}
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		config: row.config,
		applies_to: byGuardrail.get(row.id) ?? [],
		enabled: row.enabled,
		revision: Number(row.revision),
		archived: row.archived_at !== null,
	}));
}

/** The workspace guardrail library, ordered by name, keyset-paginated. */
export async function listWorkspaceGuardrails(
	sql: DbClient,
	organizationId: string,
	options: { includeArchived: boolean; cursor?: string; limit: number },
): Promise<ListGuardrailsResult> {
	const after = options.cursor === undefined ? null : decodeCursor(options.cursor);
	const rows = await sql<GuardrailRow>`
		SELECT id, name, config, enabled, revision, archived_at
		FROM workspace_guardrails
		WHERE organization_id = ${organizationId}
		  AND (${options.includeArchived} OR archived_at IS NULL)
		  AND (${after === null}
		       OR (name COLLATE "C", id COLLATE "C")
		          > (${after?.name ?? ""}::text COLLATE "C", ${after?.id ?? ""}::text COLLATE "C"))
		ORDER BY name COLLATE "C", id COLLATE "C"
		LIMIT ${options.limit + 1}
	`;
	const page = rows.slice(0, options.limit);
	const last = page.at(-1);
	return {
		items: await withSubjects(sql, organizationId, page),
		next_cursor:
			rows.length > options.limit && last ? encodeCursor({ name: last.name, id: last.id }) : null,
	};
}

/** One guardrail by id, archived or not; 404 when absent or in another workspace. */
export async function getWorkspaceGuardrail(
	sql: DbClient,
	organizationId: string,
	id: string,
): Promise<WorkspaceGuardrail> {
	const rows = await sql<GuardrailRow>`
		SELECT id, name, config, enabled, revision, archived_at
		FROM workspace_guardrails
		WHERE organization_id = ${organizationId} AND id = ${id}
	`;
	const [guardrail] = await withSubjects(sql, organizationId, rows);
	if (!guardrail) throw new ToolUserError(`Guardrail "${id}" not found`, 404);
	return guardrail;
}

// ============================================
// Library writes (REST PUT / DELETE)
// ============================================

/** A guardrail's writable fields with every default applied. */
export interface GuardrailBody {
	name: string;
	config: WorkspaceGuardrailConfig;
	applies_to: GuardrailSubject[];
	enabled: boolean;
}

/**
 * One library write, validated and ready to apply: a create (revision 0), a
 * full replace of guardrail `id` at `expected_revision`, or an archive.
 */
export type GuardrailWrite =
	| { op: "create"; id: null; expected_revision: 0; guardrail: GuardrailBody }
	| { op: "update"; id: string; expected_revision: number; guardrail: GuardrailBody }
	| { op: "archive"; id: string; expected_revision: number; guardrail: null };

const EVERY_AGENT: GuardrailSubject[] = [{ principal_kind: "agent", principal_id: null }];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The config a guardrail stores, canonical, or a 422 naming what is wrong. */
function normalizeGuardrailConfig(raw: unknown): WorkspaceGuardrailConfig {
	const parsed = parseGuardrailConfig(raw);
	if (!parsed.ok) throw new ToolUserError(parsed.error, 422);
	return parsed.config;
}

/**
 * True when a guardrail runs at the pre-tool stage only: a built-in that
 * implements no other stage (forbidden-tools).
 */
function runsOnlyPreTool(config: WorkspaceGuardrailConfig): boolean {
	const stages = builtinGuardrailStages(config.builtin);
	return stages.length > 0 && stages.every((stage) => stage === "pre-tool");
}

/**
 * Fold duplicate subjects and accept agent and app subjects: every agent or
 * app (`principal_id: null`), one agent, or one app key. An app reaches
 * guardrails only through its calls to Lobu's MCP server, so an app subject is
 * 422 unless the guardrail runs at the pre-tool stage only. Everyone is 422.
 */
function normalizeGuardrailSubjects(subjects: unknown, config: WorkspaceGuardrailConfig): GuardrailSubject[] {
	if (!Array.isArray(subjects) || subjects.length === 0) {
		throw new ToolUserError("applies_to must list at least one subject; disable or archive the guardrail instead.", 422);
	}
	const seen = new Set<string>();
	const out: GuardrailSubject[] = [];
	for (const subject of subjects) {
		if (
			!isPlainObject(subject) ||
			(subject.principal_kind !== "agent" && subject.principal_kind !== "app") ||
			!(subject.principal_id === null || (typeof subject.principal_id === "string" && subject.principal_id.trim() !== ""))
		) {
			throw new ToolUserError(
				'applies_to takes agent or app subjects: { "principal_kind": "agent", "principal_id": null } for every agent, an agent id, or (on a pre-tool guardrail) { "principal_kind": "app", "principal_id": null } for every app, or an app key.',
				422,
			);
		}
		const kind = subject.principal_kind;
		const id = subject.principal_id as string | null;
		if (kind === "app") {
			if (!runsOnlyPreTool(config)) {
				throw new ToolUserError(
					"App subjects apply only to pre-tool guardrails: the forbidden-tools built-in.",
					422,
				);
			}
			const problem = id === null ? null : appKeyProblem(id, "An app subject's principal_id");
			if (problem) throw new ToolUserError(problem, 422);
		}
		const key = `${kind}:${id ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ principal_kind: kind, principal_id: id });
	}
	return out;
}

/** Apply defaults and validate a guardrail's writable fields; 422 on bad input. */
export function normalizeGuardrailInput(input: unknown): GuardrailBody {
	if (!isPlainObject(input)) throw new ToolUserError("guardrail must be an object.", 422);
	const unknown = Object.keys(input).filter((key) => !["name", "config", "applies_to", "enabled"].includes(key));
	if (unknown.length > 0) throw new ToolUserError(`guardrail has unknown field(s): ${unknown.join(", ")}.`, 422);
	if (typeof input.name !== "string" || !isLibrarySkillName(input.name)) {
		throw new ToolUserError(
			`Guardrail name "${String(input.name)}" is invalid: use lowercase letters, digits and single inner hyphens, at most ${LIBRARY_SKILL_NAME_MAX_CHARS} characters.`,
			422,
		);
	}
	if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
		throw new ToolUserError("enabled must be a boolean.", 422);
	}
	const config = normalizeGuardrailConfig(input.config);
	return {
		name: input.name,
		config,
		applies_to: normalizeGuardrailSubjects(input.applies_to ?? EVERY_AGENT, config),
		enabled: input.enabled ?? true,
	};
}

/** 422 when a subject names an agent this workspace does not have. */
async function assertSubjectAgentsExist(
	sql: DbClient,
	organizationId: string,
	subjects: readonly GuardrailSubject[],
): Promise<void> {
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
 * Check a write against the library's current state and return the guardrail
 * it replaces (null for a create): 404 for a missing or foreign id, 409 for an
 * archived target, a stale `expected_revision` or a taken name, 422 for a
 * rename. It takes the target row's write lock for the applying transaction.
 */
async function checkGuardrailWrite(
	sql: DbClient,
	organizationId: string,
	write: GuardrailWrite,
): Promise<WorkspaceGuardrail | null> {
	if (write.guardrail) await assertSubjectAgentsExist(sql, organizationId, write.guardrail.applies_to);
	if (write.op === "create") {
		const [taken] = await sql<{ id: string }>`
			SELECT id FROM workspace_guardrails
			WHERE organization_id = ${organizationId} AND name = ${write.guardrail.name} AND archived_at IS NULL
		`;
		if (taken) {
			throw new ToolUserError(`A guardrail named "${write.guardrail.name}" already exists (id ${taken.id}).`, 409);
		}
		return null;
	}
	const rows = await sql<GuardrailRow>`
		SELECT id, name, config, enabled, revision, archived_at FROM workspace_guardrails
		WHERE organization_id = ${organizationId} AND id = ${write.id}
		FOR UPDATE
	`;
	const [current] = await withSubjects(sql, organizationId, rows);
	if (!current) throw new ToolUserError(`Guardrail "${write.id}" not found`, 404);
	if (current.archived) throw new ToolUserError(`Guardrail "${write.id}" is archived.`, 409);
	if (current.revision !== write.expected_revision) {
		throw new ToolUserError(
			`Guardrail "${current.name}" is at revision ${current.revision}, not ${write.expected_revision}; re-read it and retry.`,
			409,
		);
	}
	if (write.op === "update" && write.guardrail.name !== current.name) {
		throw new ToolUserError(
			`Guardrail names are fixed: "${current.name}" cannot become "${write.guardrail.name}". Archive it and create a new guardrail instead.`,
			422,
		);
	}
	return current;
}

/** JSON with object keys sorted, so two configs compare by content, not key order. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isPlainObject(value)) {
		return `{${Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function subjectKeys(subjects: readonly GuardrailSubject[]): string {
	return subjects
		.map((subject) => (subject.principal_kind === null ? "*" : `${subject.principal_kind}:${subject.principal_id ?? "*"}`))
		.sort()
		.join("\n");
}

function sameGuardrailBody(current: WorkspaceGuardrail, next: GuardrailBody): boolean {
	return (
		current.enabled === next.enabled &&
		stableJson(current.config) === stableJson(next.config) &&
		subjectKeys(current.applies_to) === subjectKeys(next.applies_to)
	);
}

/**
 * Apply a write inside the caller's transaction, re-checking it under the row
 * lock first. Returns the guardrail before and after; `changed` is false for a
 * put that matches the stored guardrail, which then keeps its revision.
 */
export async function applyGuardrailWrite(
	tx: DbClient,
	organizationId: string,
	write: GuardrailWrite,
): Promise<{ before: WorkspaceGuardrail | null; after: WorkspaceGuardrail; changed: boolean }> {
	const before = await checkGuardrailWrite(tx, organizationId, write);
	if (write.op === "archive") {
		await tx`
			UPDATE workspace_guardrails
			SET archived_at = now(), revision = revision + 1, updated_at = now()
			WHERE organization_id = ${organizationId} AND id = ${write.id}
		`;
		return { before, after: await getWorkspaceGuardrail(tx, organizationId, write.id), changed: true };
	}
	const guardrail = write.guardrail;
	if (write.op === "update" && before && sameGuardrailBody(before, guardrail)) {
		return { before, after: before, changed: false };
	}
	let id: string;
	if (write.op === "create") {
		id = `guardrail_${randomBytes(16).toString("hex")}`;
		// A concurrent create can take the name between the check and here; the
		// partial unique index on unarchived names turns that into no row.
		const inserted = await tx`
			INSERT INTO workspace_guardrails (id, organization_id, name, config, enabled)
			VALUES (${id}, ${organizationId}, ${guardrail.name}, ${tx.json(guardrail.config)}, ${guardrail.enabled})
			ON CONFLICT DO NOTHING
			RETURNING id
		`;
		if (inserted.length === 0) throw new ToolUserError(`A guardrail named "${guardrail.name}" already exists.`, 409);
	} else {
		id = write.id;
		await tx`
			UPDATE workspace_guardrails
			SET config = ${tx.json(guardrail.config)}, enabled = ${guardrail.enabled},
			    revision = revision + 1, updated_at = now()
			WHERE organization_id = ${organizationId} AND id = ${id}
		`;
		await tx`
			DELETE FROM workspace_guardrail_subjects
			WHERE organization_id = ${organizationId} AND guardrail_id = ${id}
		`;
	}
	for (const subject of guardrail.applies_to) {
		await tx`
			INSERT INTO workspace_guardrail_subjects (guardrail_id, organization_id, principal_kind, principal_id)
			VALUES (${id}, ${organizationId}, ${subject.principal_kind},
			        ${subject.principal_kind === null ? null : subject.principal_id})
		`;
	}
	return { before, after: await getWorkspaceGuardrail(tx, organizationId, id), changed: true };
}
