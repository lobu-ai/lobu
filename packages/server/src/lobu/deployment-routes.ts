/**
 * Deployments API — the config audit trail behind the owletto
 * Infrastructure → Deployments tab.
 *
 * A "deployment" is one `lobu apply` run: the CLI threads an
 * `x-lobu-apply-id` header through every mutation (grouping the
 * `metadata.category='config'` events those handlers emit) and POSTs a
 * summary here at the end, stored as a `metadata.category='deployment'`
 * event. Standalone config changes (web UI / API edits, no apply_id) appear
 * in the same feed as ungrouped rows.
 *
 * All rows are append-only and never superseded, so reads go to `events`
 * directly rather than the `current_event_records` view (same rationale as
 * the guardrail-trips feed: the view would force an `event_embeddings`
 * join). Org-scoped + Postgres-backed — correct under N replicas.
 */

import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { getDb } from "../db/client";
import type { Env } from "../index";
import { getApplyContext, parseApplyId } from "../utils/apply-context";
import {
	type ConfigResourceKind,
	isConfigResourceKind,
} from "../utils/config-redaction";
import { isRestorableDeployment } from "../utils/deployment-pause";
import { insertEvent } from "../utils/insert-event";
import { requireSessionOrAdminPat } from "./agent-routes";
import { orgContext } from "./stores/org-context";

const routes = new Hono<{ Bindings: Env }>();

routes.use("*", mcpAuth);

routes.use("*", async (c, next) => {
	const orgId = c.get("organizationId");
	if (!orgId) return c.json({ error: "Organization required" }, 401);
	return orgContext.run({ organizationId: orgId }, next);
});

const DEPLOYMENT_STATUSES = new Set([
	"succeeded",
	"partial_failure",
	// A run that was blocked by drift — it never mutated state. Carries the
	// blocking candidates so the reconciler/Deployments tab can act on them.
	"blocked",
]);

// `events` is append-only, so the config ledger still holds rows whose
// `resource_kind` predates the current union — pre-cutover Automation rows
// carry the retired kind verbatim. The wire field IS the `ConfigResourceKind`
// union, so anything outside it is reported as unknown rather than echoed
// back; the change itself, its fields, and its diff stay fully visible.
function canonicalConfigResourceKind(kind: unknown): ConfigResourceKind | null {
	return isConfigResourceKind(kind) ? kind : null;
}

// Stored manifest ceiling. The manifest is the REDACTED desired-state
// snapshot minus connector source bytes (those live in connector_versions and
// the manifest references them as {key: version} pins), so real configs are
// tens of KBs; the cap only guards against a pathological payload.
const MANIFEST_MAX_BYTES = 1_000_000;

function clampLimit(raw: string | undefined, fallback: number, max: number) {
	const parsed = Number.parseInt(raw ?? String(fallback), 10);
	return Number.isFinite(parsed)
		? Math.min(Math.max(parsed, 1), max)
		: fallback;
}

// ── Ingest a deployment summary (posted by `lobu apply`) ─────────────────────

routes.post("/", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const organizationId = c.get("organizationId") as string;
	// Succeeded manifests now authorize prune deletes (owned + attribution).
	// A plain member must not forge a succeeded baseline that marks UI-created
	// definitions as delete-eligible for a later admin apply. Session members
	// may still post `blocked` reports (non-authorizing). PAT/oauth callers
	// already required mcp:admin via requireSessionOrAdminPat.
	const memberRole = c.get("memberRole") as string | null | undefined;
	const authSource = c.get("authSource") as "session" | "pat" | "oauth" | null;
	const isOrgAdmin = memberRole === "owner" || memberRole === "admin";

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}

	const applyId = parseApplyId(
		typeof body.apply_id === "string" ? body.apply_id : null,
	);
	if (!applyId) {
		return c.json({ error: "apply_id must match apl_<id>" }, 400);
	}
	const status = typeof body.status === "string" ? body.status : "";
	if (!DEPLOYMENT_STATUSES.has(status)) {
		return c.json(
			{
				error: "status must be 'succeeded', 'partial_failure', or 'blocked'",
			},
			400,
		);
	}
	if (
		(status === "succeeded" || status === "partial_failure") &&
		authSource === "session" &&
		!isOrgAdmin
	) {
		return c.json(
			{
				error:
					"Posting a succeeded deployment (prune authorization baseline) requires an owner or admin.",
			},
			403,
		);
	}
	const manifestHash =
		typeof body.manifest_hash === "string" ? body.manifest_hash : null;
	const cliVersion =
		typeof body.cli_version === "string" ? body.cli_version : null;
	const gitSha = typeof body.git_sha === "string" ? body.git_sha : null;
	const gitDirty = typeof body.git_dirty === "boolean" ? body.git_dirty : null;
	const counts =
		body.counts && typeof body.counts === "object" ? body.counts : {};
	const countsByKind =
		body.counts_by_kind && typeof body.counts_by_kind === "object"
			? body.counts_by_kind
			: {};
	const errorText = typeof body.error === "string" ? body.error : null;
	// Rollback deployments reference the deployment they restored.
	const rollbackOf = parseApplyId(
		typeof body.rollback_of === "string" ? body.rollback_of : null,
	);
	// The self-contained desired-state snapshot (secrets structurally redacted
	// CLI-side; connector bytes referenced as retained {key: version} pins, not
	// embedded) — what `lobu rollback` re-applies.
	let manifest: Record<string, unknown> | null = null;
	if (body.manifest !== undefined && body.manifest !== null) {
		if (typeof body.manifest !== "object" || Array.isArray(body.manifest)) {
			return c.json({ error: "manifest must be an object" }, 400);
		}
		if (JSON.stringify(body.manifest).length > MANIFEST_MAX_BYTES) {
			return c.json(
				{ error: `manifest exceeds ${MANIFEST_MAX_BYTES} bytes` },
				400,
			);
		}
		manifest = body.manifest as Record<string, unknown>;
	}
	// Blocking-drift candidates (blocking-item list + the confirm token) for a
	// `blocked` run — what the reconciler and the Deployments tab render.
	let candidates: unknown = null;
	if (body.candidates !== undefined && body.candidates !== null) {
		if (typeof body.candidates !== "object" || Array.isArray(body.candidates)) {
			return c.json({ error: "candidates must be an object" }, 400);
		}
		if (JSON.stringify(body.candidates).length > MANIFEST_MAX_BYTES) {
			return c.json(
				{ error: `candidates exceeds ${MANIFEST_MAX_BYTES} bytes` },
				400,
			);
		}
		candidates = body.candidates;
	}

	const sql = getDb();
	// Retried POSTs (CLI network blip) must not create a second deployment row.
	const existing = await sql`
		SELECT id FROM events
		WHERE organization_id = ${organizationId}
		  AND semantic_type = 'change'
		  AND metadata->>'category' = 'deployment'
		  AND metadata->>'apply_id' = ${applyId}
		LIMIT 1
	`;
	if (existing.length > 0) {
		return c.json({ id: existing[0].id, deduped: true });
	}

	const applyCtx = getApplyContext(c);
	const countsSummary = counts as Record<string, unknown>;
	const title = `Deployment ${applyId.slice(4, 12)} — ${Number(countsSummary.create) || 0} created, ${Number(countsSummary.update) || 0} updated, ${Number(countsSummary.delete) || 0} deleted`;

	// Awaited (unlike the fire-and-forget config writers): the CLI warns the
	// operator when the summary can't be recorded, so surface the failure.
	const event = await insertEvent({
		entityIds: [],
		organizationId,
		originId: `deployment_${applyId}`,
		title,
		semanticType: "change",
		originType: "deployment",
		payloadType: "empty",
		payloadData: {
			counts_by_kind: countsByKind,
			...(errorText ? { error: errorText } : {}),
			...(manifest ? { manifest } : {}),
			...(candidates !== null ? { candidates } : {}),
		},
		metadata: {
			category: "deployment",
			apply_id: applyId,
			status,
			manifest_hash: manifestHash,
			git_sha: gitSha,
			git_dirty: gitDirty,
			cli_version: cliVersion,
			counts,
			...(rollbackOf ? { rollback_of: rollbackOf } : {}),
		},
		createdBy: applyCtx.createdBy,
		clientId: applyCtx.clientId,
	});

	return c.json({ id: event.id }, 201);
});

// ── Feed: deployments + standalone config changes ────────────────────────────
//
// Keyset pagination on id DESC alone. For this append-only audit slice the
// event id (one global sequence, all replicas insert through the same PG) is
// the total order; a created_at cursor would be lossy — timestamps serialize
// to JSON at millisecond precision while Postgres stores microseconds, so
// same-millisecond rows get skipped on the next page. `payload_data` (the
// full state snapshots) is deliberately NOT selected — detail routes carry it.

routes.get("/", async (c) => {
	const organizationId = c.get("organizationId") as string;
	const limit = clampLimit(c.req.query("limit"), 50, 100);
	const beforeId = Number.parseInt(c.req.query("before_id") ?? "", 10);
	const useCursor = Number.isFinite(beforeId);
	const resourceKind = c.req.query("resource_kind") ?? null;
	const resourceId = c.req.query("resource_id") ?? null;
	const resourceFiltered = resourceKind != null && resourceId != null;

	const sql = getDb();
	const rows = await sql`
		SELECT id, created_at, title, metadata, created_by, client_id
		FROM events
		WHERE organization_id = ${organizationId}
		  AND semantic_type = 'change'
		  AND (
		    ${resourceFiltered}
		    AND metadata->>'category' = 'config'
		    AND metadata->>'resource_kind' = ${resourceKind}
		    AND metadata->>'resource_id' = ${resourceId}
		    OR ${!resourceFiltered}
		    AND (
		      metadata->>'category' = 'deployment'
		      OR (metadata->>'category' = 'config' AND metadata->>'apply_id' IS NULL)
		    )
		  )
		  ${useCursor ? sql`AND id < ${beforeId}` : sql``}
		ORDER BY id DESC
		LIMIT ${limit + 1}
	`;

	const page = rows.slice(0, limit);
	const items = page.map((row) => {
		const metadata = (row.metadata ?? {}) as Record<string, unknown>;
		if (metadata.category === "deployment") {
			return {
				type: "deployment" as const,
				id: row.id,
				applyId: metadata.apply_id ?? null,
				createdAt: row.created_at,
				title: row.title,
				status: metadata.status ?? null,
				counts: metadata.counts ?? null,
				manifestHash: metadata.manifest_hash ?? null,
				gitSha: metadata.git_sha ?? null,
				gitDirty: metadata.git_dirty ?? null,
				cliVersion: metadata.cli_version ?? null,
				rollbackOf: metadata.rollback_of ?? null,
				createdBy: row.created_by ?? null,
			};
		}
		return {
			type: "change" as const,
			id: row.id,
			createdAt: row.created_at,
			title: row.title,
			resourceKind: canonicalConfigResourceKind(metadata.resource_kind),
			resourceId: metadata.resource_id ?? null,
			op: metadata.op ?? null,
			action: metadata.action ?? null,
			changedFields: metadata.changed_fields ?? null,
			actorSource: metadata.actor_source ?? null,
			createdBy: row.created_by ?? null,
			clientId: row.client_id ?? null,
			agentId: metadata.agent_id ?? null,
			actingAutomationId: metadata.acting_automation_id ?? null,
			actingRunId: metadata.acting_run_id ?? null,
			mcpSessionId: metadata.mcp_session_id ?? null,
			mcpConversationId: metadata.mcp_conversation_id ?? null,
			tokenType: metadata.token_type ?? null,
			requestedBy: metadata.requested_by ?? null,
			approvedBy: metadata.approved_by ?? null,
			approvalRunId: metadata.approval_run_id ?? null,
			approvalReference: metadata.approval_reference ?? null,
		};
	});

	return c.json({ items, has_more: rows.length > limit });
});

// ── Shared before/after computation ──────────────────────────────────────────
//
// `before` for each config event is the previous config event for the same
// (resource_kind, resource_id) — the event-sourced fold, one step deep. The
// LATERAL rides the config-changes partial index (org, created_at, id).

async function fetchChangesWithBefore(
	organizationId: string,
	filter: { applyId?: string; eventId?: number },
) {
	const sql = getDb();
	return sql`
		SELECT
			e.id, e.created_at, e.title, e.metadata, e.payload_data, e.created_by, e.client_id,
			prev.payload_data AS before_payload
		FROM events e
		LEFT JOIN LATERAL (
			SELECT p.payload_data
			FROM events p
			WHERE p.organization_id = e.organization_id
			  AND p.semantic_type = 'change'
			  AND p.metadata->>'category' = 'config'
			  AND p.metadata->>'resource_kind' = e.metadata->>'resource_kind'
			  AND p.metadata->>'resource_id' = e.metadata->>'resource_id'
			  AND p.id < e.id
			ORDER BY p.id DESC
			LIMIT 1
		) prev ON true
		WHERE e.organization_id = ${organizationId}
		  AND e.semantic_type = 'change'
		  AND e.metadata->>'category' = 'config'
		  ${
				filter.applyId !== undefined
					? sql`AND e.metadata->>'apply_id' = ${filter.applyId}`
					: sql`AND e.id = ${filter.eventId as number}`
			}
		ORDER BY e.id ASC
	`;
}

function toChangeDetail(row: Record<string, any>) {
	const metadata = (row.metadata ?? {}) as Record<string, unknown>;
	const payload = (row.payload_data ?? {}) as Record<string, unknown>;
	const beforePayload = (row.before_payload ?? null) as Record<
		string,
		unknown
	> | null;
	// Explicit `before` on the row wins — including an explicit null for
	// creates; otherwise fall back to the event-sourced fold (previous state
	// for the same resource). Presence (hasOwn), not nullishness, decides:
	// legacy rows predate the field entirely, while creates stamp before:null
	// to assert "no predecessor". Falling back on explicit null would attach
	// the previous resource's state to a create.
	const hasExplicitBefore = Object.prototype.hasOwnProperty.call(payload, 'before');
	const explicitBefore = (hasExplicitBefore ? payload.before : undefined) as Record<string, unknown> | null | undefined;
	return {
		id: row.id,
		createdAt: row.created_at,
		title: row.title,
		resourceKind: canonicalConfigResourceKind(metadata.resource_kind),
		resourceId: metadata.resource_id ?? null,
		op: metadata.op ?? null,
		action: metadata.action ?? null,
		changedFields: metadata.changed_fields ?? null,
		actorSource: metadata.actor_source ?? null,
		applyId: metadata.apply_id ?? null,
		createdBy: row.created_by ?? null,
		clientId: row.client_id ?? null,
		agentId: metadata.agent_id ?? null,
		actingAutomationId: metadata.acting_automation_id ?? null,
		actingRunId: metadata.acting_run_id ?? null,
		mcpSessionId: metadata.mcp_session_id ?? null,
		mcpConversationId: metadata.mcp_conversation_id ?? null,
		tokenType: metadata.token_type ?? null,
		requestedBy: metadata.requested_by ?? null,
		approvedBy: metadata.approved_by ?? null,
		approvalRunId: metadata.approval_run_id ?? null,
		approvalReference: metadata.approval_reference ?? null,
		before: hasExplicitBefore ? (explicitBefore ?? null) : (beforePayload?.state ?? null),
		after: payload.state ?? null,
	};
}

// ── Standalone-change detail ─────────────────────────────────────────────────
// Registered before `/:applyId` so the literal segment wins the match.

routes.get("/changes/:eventId", async (c) => {
	const organizationId = c.get("organizationId") as string;
	const eventId = Number.parseInt(c.req.param("eventId"), 10);
	if (!Number.isFinite(eventId)) {
		return c.json({ error: "eventId must be a number" }, 400);
	}

	const rows = await fetchChangesWithBefore(organizationId, { eventId });
	if (rows.length === 0) return c.json({ error: "Change not found" }, 404);
	return c.json({ change: toChangeDetail(rows[0]) });
});

// ── Promotions pause (set by `lobu rollback`, cleared by `lobu apply --resume`) ──
// Registered before `/:applyId` so the literal segment wins the match. A
// workflow guard for the org's own operators (CI must not silently re-promote
// over a deliberate rollback), not a security boundary.

routes.get("/pause", async (c) => {
	const organizationId = c.get("organizationId") as string;
	const sql = getDb();
	const rows = await sql`
		SELECT paused_at, apply_id, rollback_of, paused_by
		FROM deployment_pause
		WHERE organization_id = ${organizationId}
		LIMIT 1
	`;
	if (rows.length === 0) return c.json({ paused: false });
	const row = rows[0];
	return c.json({
		paused: true,
		pausedAt: row.paused_at,
		applyId: row.apply_id ?? null,
		rollbackOf: row.rollback_of ?? null,
		pausedBy: row.paused_by ?? null,
	});
});

routes.put("/pause", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const organizationId = c.get("organizationId") as string;

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		body = {};
	}
	const applyId = parseApplyId(
		typeof body.apply_id === "string" ? body.apply_id : null,
	);
	const rollbackOf = parseApplyId(
		typeof body.rollback_of === "string" ? body.rollback_of : null,
	);
	if (!applyId || !rollbackOf) {
		return c.json(
			{ error: "apply_id and rollback_of must each match apl_<id>" },
			400,
		);
	}
	if (!(await isRestorableDeployment(organizationId, rollbackOf))) {
		return c.json(
			{
				error:
					"rollback_of must name a restorable deployment in this organization",
			},
			400,
		);
	}
	const applyCtx = getApplyContext(c);

	const sql = getDb();
	await sql`
		INSERT INTO deployment_pause (organization_id, apply_id, rollback_of, paused_by)
		VALUES (${organizationId}, ${applyId}, ${rollbackOf}, ${applyCtx.createdBy ?? null})
		ON CONFLICT (organization_id) DO UPDATE
		SET paused_at = now(),
		    apply_id = EXCLUDED.apply_id,
		    rollback_of = EXCLUDED.rollback_of,
		    paused_by = EXCLUDED.paused_by
	`;
	return c.json({ paused: true });
});

routes.delete("/pause", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const organizationId = c.get("organizationId") as string;
	const sql = getDb();
	await sql`DELETE FROM deployment_pause WHERE organization_id = ${organizationId}`;
	return c.json({ paused: false });
});

// ── Latest succeeded deployment (attribution baseline for `lobu apply`) ──────
// Registered before `/:applyId` so the literal segment wins the match. Bounded
// single-row read on the events_succeeded_deployments_idx partial index; the
// mixed feed cannot answer this reliably (it interleaves standalone config
// changes and blocked applies).

routes.get("/latest", async (c) => {
	const organizationId = c.get("organizationId") as string;
	const sql = getDb();
	const rows = await sql`
		SELECT id, created_at, title, metadata, payload_data, created_by
		FROM events
		WHERE organization_id = ${organizationId}
		  AND semantic_type = 'change'
		  AND metadata->>'category' = 'deployment'
		  AND metadata->>'status' = 'succeeded'
		ORDER BY id DESC
		LIMIT 1
	`;
	if (rows.length === 0) return c.json({ deployment: null });
	const summary = rows[0];
	const summaryMeta = (summary.metadata ?? {}) as Record<string, unknown>;
	const summaryPayload = (summary.payload_data ?? {}) as Record<
		string,
		unknown
	>;
	return c.json({
		deployment: {
			id: summary.id,
			applyId: summaryMeta.apply_id ?? null,
			createdAt: summary.created_at,
			title: summary.title,
			status: summaryMeta.status ?? null,
			manifestHash: summaryMeta.manifest_hash ?? null,
			gitSha: summaryMeta.git_sha ?? null,
			manifest: summaryPayload.manifest ?? null,
			createdBy: summary.created_by ?? null,
		},
	});
});

// ── Deployment detail ────────────────────────────────────────────────────────

routes.get("/:applyId", async (c) => {
	const organizationId = c.get("organizationId") as string;
	const applyId = parseApplyId(c.req.param("applyId"));
	if (!applyId) return c.json({ error: "Invalid apply id" }, 400);

	const sql = getDb();
	const summaryRows = await sql`
		SELECT id, created_at, title, metadata, payload_data, created_by
		FROM events
		WHERE organization_id = ${organizationId}
		  AND semantic_type = 'change'
		  AND metadata->>'category' = 'deployment'
		  AND metadata->>'apply_id' = ${applyId}
		LIMIT 1
	`;
	if (summaryRows.length === 0) {
		return c.json({ error: "Deployment not found" }, 404);
	}
	const summary = summaryRows[0];
	const summaryMeta = (summary.metadata ?? {}) as Record<string, unknown>;
	const summaryPayload = (summary.payload_data ?? {}) as Record<
		string,
		unknown
	>;

	const changeRows = await fetchChangesWithBefore(organizationId, { applyId });

	return c.json({
		deployment: {
			id: summary.id,
			applyId,
			createdAt: summary.created_at,
			title: summary.title,
			status: summaryMeta.status ?? null,
			counts: summaryMeta.counts ?? null,
			countsByKind: summaryPayload.counts_by_kind ?? null,
			error: summaryPayload.error ?? null,
			manifestHash: summaryMeta.manifest_hash ?? null,
			gitSha: summaryMeta.git_sha ?? null,
			gitDirty: summaryMeta.git_dirty ?? null,
			cliVersion: summaryMeta.cli_version ?? null,
			rollbackOf: summaryMeta.rollback_of ?? null,
			manifest: summaryPayload.manifest ?? null,
			candidates: summaryPayload.candidates ?? null,
			createdBy: summary.created_by ?? null,
		},
		changes: changeRows.map(toChangeDetail),
	});
});

export { routes as deploymentRoutes };
