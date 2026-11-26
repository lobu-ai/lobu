/**
 * The guardrail library writers: `PUT /api/:org/guardrails[/:id]` and
 * `DELETE /api/:org/guardrails/:id`. The HTTP route admits only an owner/admin
 * web session or a human-minted `guardrails:write` PAT; this module validates
 * the write against everything the runtime relies on, applies it with
 * compare-and-swap, and records a config event in the same transaction.
 */
import type {
	PutGuardrailResult,
	WorkspaceGuardrail,
} from "@lobu/core/contracts/workspace-guardrails";
import { assertGuardrailConfigReadAllowed } from "../authz/guardrail-config-access";
import { getDb } from "../db/client";
import { insertToolConfigChange } from "../tools/admin/helpers/config-audit";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import { requireOrgReadAccess } from "../utils/organization-access";
import { lockOrganizationForRelationshipClaims } from "../utils/relationship-claims";
import {
	applyGuardrailWrite,
	type GuardrailWrite,
	normalizeGuardrailInput,
} from "./workspace-guardrails";

/**
 * Parse a PUT: `expected_revision` 0 creates (no id); otherwise it replaces
 * guardrail `id` at that revision. 422 on a mismatched pair or bad input.
 */
function preparePut(id: string | undefined, body: unknown): GuardrailWrite {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ToolUserError("Request body must be an object.", 422);
	}
	const { guardrail, expected_revision: expectedRevision, ...rest } = body as Record<string, unknown>;
	const extra = Object.keys(rest);
	if (extra.length > 0) throw new ToolUserError(`Unknown field(s): ${extra.join(", ")}.`, 422);
	if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
		throw new ToolUserError("expected_revision must be a non-negative integer (0 to create).", 422);
	}
	const normalized = normalizeGuardrailInput(guardrail);
	if (id === undefined) {
		if (expectedRevision !== 0) {
			throw new ToolUserError("Creating a guardrail takes expected_revision 0; PUT /guardrails/:id replaces one.", 422);
		}
		return { op: "create", id: null, expected_revision: 0, guardrail: normalized };
	}
	if (expectedRevision === 0) {
		throw new ToolUserError("Replacing a guardrail takes its current revision; PUT /guardrails (no id) creates one.", 422);
	}
	return { op: "update", id, expected_revision: expectedRevision, guardrail: normalized };
}

/** Audit fields: what a config event says changed between two revisions. */
const AUDITED_FIELDS = ["config", "applies_to", "enabled"] as const;

async function applyAndAudit(ctx: ToolContext, write: GuardrailWrite): Promise<WorkspaceGuardrail> {
	return getDb().begin(async (tx) => {
		await lockOrganizationForRelationshipClaims(tx, ctx.organizationId);
		const { before, after, changed } = await applyGuardrailWrite(tx, ctx.organizationId, write);
		if (!changed) return after;
		const op = write.op === "create" ? "created" : write.op === "archive" ? "deleted" : "updated";
		await insertToolConfigChange(
			ctx,
			{
				resourceKind: "guardrail",
				resourceId: after.id,
				op,
				summary: `Guardrail '${after.name}' ${write.op === "archive" ? "archived" : op}`,
				state: write.op === "archive" ? null : { ...after },
				before: before ? { ...before } : null,
				action: write.op === "archive" ? "archive" : "put",
				...(before && write.op === "update"
					? {
							changedFields: AUDITED_FIELDS.filter(
								(field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
							),
						}
					: {}),
			},
			tx,
		);
		return after;
	});
}

/**
 * A write answers with library state (the stored guardrail, a conflict naming
 * the current revision or a taken name), so it needs the read grant too.
 */
async function assertReadable(ctx: ToolContext): Promise<void> {
	await requireOrgReadAccess(getDb(), ctx);
	await assertGuardrailConfigReadAllowed(ctx);
}

/** Create (`id` undefined, `expected_revision: 0`) or fully replace a guardrail. */
export async function putGuardrail(
	params: { id?: string; body: unknown },
	ctx: ToolContext,
): Promise<PutGuardrailResult> {
	const write = preparePut(params.id, params.body);
	await assertReadable(ctx);
	return { guardrail: await applyAndAudit(ctx, write) };
}

/** Archive a guardrail at its current revision; it stops applying at once. */
export async function archiveGuardrail(
	params: { id: string; expected_revision: unknown },
	ctx: ToolContext,
): Promise<PutGuardrailResult> {
	const revision = Number(params.expected_revision);
	if (params.expected_revision === undefined || !Number.isInteger(revision) || revision < 1) {
		throw new ToolUserError("expected_revision must be the guardrail's current revision.", 422);
	}
	await assertReadable(ctx);
	return {
		guardrail: await applyAndAudit(ctx, { op: "archive", id: params.id, expected_revision: revision, guardrail: null }),
	};
}
