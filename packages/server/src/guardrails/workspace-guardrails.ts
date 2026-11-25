/**
 * The workspace guardrail library (`workspace_guardrails` +
 * `workspace_guardrail_subjects`). Every reader goes through here: the message
 * pipeline (chat input/output, pre-tool on the outbound MCP proxy), the egress
 * policy store and grant guards, the catalog's installed view, and the
 * read-only REST/SDK list/get.
 */
import type {
	GuardrailSubject,
	ListGuardrailsResult,
	WorkspaceGuardrail,
	WorkspaceGuardrailConfig,
} from "@lobu/core/contracts/workspace-guardrails";
import type { GuardrailStage } from "@lobu/core";
import type { ActingPrincipal } from "../authz/entity-policy";
import type { DbClient } from "../db/client";
import { pgTextArray } from "../db/client";
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

interface ApplyingQuery {
	enabledOnly: boolean;
	/** Only custom checks at this stage (built-ins carry no stage). */
	stage?: GuardrailStage;
	/** Skip transferring rows while the set still hashes to this revision. */
	knownRevision?: string | null;
}

/**
 * The unarchived guardrails that apply to `principal`, plus a content revision
 * of exactly that set. One indexed read over a bounded config table; the
 * subject predicate is `principalMatches` in SQL: everyone, the principal's
 * kind, the principal itself, or (for an Automation) its owner agent. `rows`
 * is null when the set still hashes to `knownRevision`, so a revision-checked
 * cache pays one read and no JSON transfer in the steady state.
 */
async function queryApplying(
	sql: DbClient,
	organizationId: string,
	principal: GuardrailPrincipal,
	query: ApplyingQuery,
): Promise<{ revision: string; rows: ApplyingGuardrail[] | null }> {
	const ownerAgentId = principal.kind === "automation" ? principal.ownerAgentId : null;
	const [result] = await sql<{ revision: string; rows: ApplyingGuardrail[] | null }>`
		WITH applying AS (
			SELECT g.id, g.name, g.config, g.enabled, g.revision
			FROM workspace_guardrails g
			WHERE g.organization_id = ${organizationId}
			  AND g.archived_at IS NULL
			  AND (${!query.enabledOnly} OR g.enabled)
			  AND (${query.stage ?? null}::text IS NULL OR g.config ->> 'stage' = ${query.stage ?? null})
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
		),
		digest AS (
			SELECT md5(COALESCE(
				jsonb_agg(jsonb_build_array(id, revision, name, enabled, config) ORDER BY id COLLATE "C")::text,
				''
			)) AS revision
			FROM applying
		)
		SELECT digest.revision,
		       CASE WHEN digest.revision IS DISTINCT FROM ${query.knownRevision ?? null}::text THEN (
		         SELECT COALESCE(jsonb_agg(
		           jsonb_build_object('id', id, 'name', name, 'config', config, 'enabled', enabled, 'revision', revision)
		           ORDER BY name COLLATE "C", id COLLATE "C"
		         ), '[]'::jsonb)
		         FROM applying
		       ) END AS rows
		FROM digest
	`;
	return {
		revision: result?.revision ?? "",
		rows: result?.rows ? result.rows.map((row) => ({ ...row, revision: Number(row.revision) })) : null,
	};
}

/**
 * The guardrails enforced for `principal`: enabled, unarchived, and applying
 * to it. Guardrails accumulate — every one returned runs, and any trip wins.
 */
export async function resolveGuardrails(
	sql: DbClient,
	organizationId: string,
	principal: GuardrailPrincipal,
): Promise<ApplyingGuardrail[]> {
	return (await queryApplying(sql, organizationId, principal, { enabledOnly: true })).rows ?? [];
}

/** Every unarchived guardrail applying to `principal`, disabled ones included (the installed view). */
export async function guardrailsApplyingTo(
	sql: DbClient,
	organizationId: string,
	principal: GuardrailPrincipal,
): Promise<ApplyingGuardrail[]> {
	return (await queryApplying(sql, organizationId, principal, { enabledOnly: false })).rows ?? [];
}

/**
 * The enabled `egress`-stage guardrails for `principal`, revision-checked: the
 * rows come back only when the set no longer hashes to `knownRevision`.
 */
export function resolveEgressGuardrails(
	sql: DbClient,
	organizationId: string,
	principal: GuardrailPrincipal,
	knownRevision: string | null,
): Promise<{ revision: string; rows: ApplyingGuardrail[] | null }> {
	return queryApplying(sql, organizationId, principal, {
		enabledOnly: true,
		stage: "egress",
		knownRevision,
	});
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
