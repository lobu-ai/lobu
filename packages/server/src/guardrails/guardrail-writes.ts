/**
 * The guardrail library writers: `PUT /api/:org/guardrails[/:id]` and
 * `DELETE /api/:org/guardrails/:id`. The HTTP route admits only an owner/admin
 * web session or a human-minted `guardrails:write` PAT; this module validates
 * the write against everything the runtime relies on (shape, judge model,
 * egress shadowing), applies it with compare-and-swap, and records a config
 * event in the same transaction.
 */
import { createLogger, normalizeDomainPattern } from "@lobu/core";
import { isUnrestrictedMode, patternReaches } from "@lobu/connector-sdk/egress-policy";
import {
	isBuiltinGuardrailConfig,
	type PutGuardrailResult,
	type WorkspaceGuardrail,
} from "@lobu/core/contracts/workspace-guardrails";
import { assertGuardrailConfigReadAllowed } from "../authz/guardrail-config-access";
import { type DbClient, getDb, pgTextArray } from "../db/client";
import { loadAllowedDomains } from "../gateway/config/network-allowlist";
import { resolveSystemJudgeTarget } from "../gateway/inference/system-judge-target";
import {
	findSuppressedJudgedDomains,
	judgedEgressDomains,
	lockEgressJudgeDecisions,
} from "../gateway/permissions/policy-store";
import { getOrgDefaultModel } from "../lobu/stores/provider-secrets";
import { insertToolConfigChange } from "../tools/admin/helpers/config-audit";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import { requireOrgReadAccess } from "../utils/organization-access";
import { lockOrganizationForRelationshipClaims } from "../utils/relationship-claims";
import {
	type ApplyingGuardrail,
	applyGuardrailWrite,
	checkGuardrailWrite,
	type GuardrailBody,
	type GuardrailWrite,
	guardrailSubjectScope,
	normalizeGuardrailInput,
} from "./workspace-guardrails";

const logger = createLogger("guardrail-writes");

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

/**
 * A judge needs a model the judge can run: its own, or the organization's
 * default. A model that cannot resolve would save and then deny every request
 * the guardrail covers, so it is resolved here through the same function the
 * judge uses. Only a new or changed model is checked: a stored one keeps
 * saving, so a guardrail whose model stopped resolving can still be edited.
 */
async function assertJudgeModelRunnable(
	organizationId: string,
	next: GuardrailBody,
	before: WorkspaceGuardrail | null,
): Promise<void> {
	const config = next.config;
	if (isBuiltinGuardrailConfig(config) || config.kind !== "judge") return;
	const ownModel = config.model?.trim() ?? "";
	if (before && !isBuiltinGuardrailConfig(before.config) && before.config.kind === "judge") {
		if ((before.config.model?.trim() ?? "") === ownModel) return;
	}
	const orgDefault = ownModel ? "" : ((await getOrgDefaultModel(organizationId).catch(() => null))?.trim() ?? "");
	const model = ownModel || orgDefault;
	if (!model) {
		throw new ToolUserError(
			`Guardrail "${next.name}" needs config.model: this organization has no default provider model.`,
			422,
		);
	}
	const resolved = await resolveSystemJudgeTarget(model);
	if (!resolved.ok) {
		throw new ToolUserError(
			`Guardrail "${next.name}" ${ownModel ? `names judge model "${model}"` : `has no model, so it uses this organization's default model "${model}"`}, which this deployment cannot run: ${resolved.detail}. Use a "<provider>/<model>" ref whose provider has a system key and speaks the OpenAI-compatible or Anthropic Messages protocol.`,
			422,
		);
	}
}

/** The egress judge a write would store, as the runtime matchers see it. */
function asApplying(next: GuardrailBody): ApplyingGuardrail[] {
	return [{ id: "", name: next.name, config: next.config, enabled: next.enabled, revision: 0 }];
}

/**
 * An allow grant beats the egress judge: the proxy matches it first, so a
 * judged domain an agent's `networkConfig.allowedDomains` reaches would never
 * be judged. Refuse such a write, naming every (agent, domain, grant) it
 * would silence. The global `WORKER_ALLOWED_DOMAINS` shadows the same way but
 * is operator config, so it only warns. Runs inside the locked write
 * transaction, against the agents present then.
 */
async function assertEgressJudgeNotShadowed(
	tx: DbClient,
	organizationId: string,
	next: GuardrailBody,
): Promise<void> {
	const judged = judgedEgressDomains(asApplying(next));
	if (judged.length === 0) return;
	const { everyAgent, agentIds } = guardrailSubjectScope(next.applies_to);
	const rows = await tx<{ id: string; network_config: { allowedDomains?: string[] } | null }>`
		SELECT id, network_config FROM agents
		WHERE organization_id = ${organizationId}
		  AND (${everyAgent}::boolean OR id = ANY(${pgTextArray(agentIds)}::text[]))
		ORDER BY id
	`;
	const pairs = rows.flatMap((row) =>
		findSuppressedJudgedDomains(asApplying(next), row.network_config?.allowedDomains ?? []).map(
			({ domain, grant }) => `agent "${row.id}" allows "${grant}", which covers judged domain "${domain}"`,
		),
	);
	if (pairs.length > 0) {
		throw new ToolUserError(
			`Guardrail "${next.name}" would never run for some agents: the proxy matches an allow grant before the egress judge. ${pairs.join("; ")}. Remove the domain from those agents' networkConfig.allowedDomains (a judged domain is reachable through its judge), or drop it from config.domains.`,
			422,
		);
	}
	const globalAllowed = loadAllowedDomains();
	const unrestricted = isUnrestrictedMode(globalAllowed);
	if (
		unrestricted ||
		findSuppressedJudgedDomains(asApplying(next), globalAllowed, { wildcardCoversRoot: true }).length > 0
	) {
		logger.warn(
			`[guardrails] egress judge "${next.name}" governs domains covered by WORKER_ALLOWED_DOMAINS${
				unrestricted ? " (unrestricted, '*')" : ""
			}. The global allowlist is matched before the judge, so it will not run for them.`,
		);
	}
}

/**
 * Revoke the allow grants (not the denies) that reach a domain the written
 * judge governs, for every agent its subjects cover when the locked write
 * transaction runs, including one created a moment ago. A stored allow grant
 * outranks the judge, and the dispatch reconcile never revisits an expiring
 * one, so without this an approved "allow for an hour" would keep the new
 * judge silent until it lapsed. A deny outranks the judge by design.
 */
async function revokeShadowingGrants(tx: DbClient, organizationId: string, next: GuardrailBody): Promise<void> {
	const judged = judgedEgressDomains(asApplying(next));
	if (judged.length === 0) return;
	const { everyAgent, agentIds } = guardrailSubjectScope(next.applies_to);
	const grants = await tx<{ agent_id: string; pattern: string }>`
		SELECT g.agent_id, g.pattern FROM grants g
		JOIN agents a ON a.id = g.agent_id AND a.organization_id = g.organization_id
		WHERE g.organization_id = ${organizationId}
		  AND g.kind = 'domain' AND NOT g.denied
		  AND (${everyAgent}::boolean OR a.id = ANY(${pgTextArray(agentIds)}::text[]))
	`;
	const revoked = grants.filter((grant) => {
		const pattern = normalizeDomainPattern(grant.pattern);
		return judged.some((domain) => patternReaches(domain, pattern));
	});
	if (revoked.length === 0) return;
	await tx`
		DELETE FROM grants
		WHERE organization_id = ${organizationId} AND kind = 'domain' AND NOT denied
		  AND (agent_id, pattern) IN (
			SELECT * FROM unnest(
				${pgTextArray(revoked.map((grant) => grant.agent_id))}::text[],
				${pgTextArray(revoked.map((grant) => grant.pattern))}::text[]
			)
		  )
	`;
	logger.info("Revoked allow grants that would shadow an egress judge", {
		guardrail: next.name,
		grants: revoked.map((grant) => ({ agentId: grant.agent_id, pattern: grant.pattern })),
	});
}

/** Audit fields: what a config event says changed between two revisions. */
const AUDITED_FIELDS = ["config", "applies_to", "enabled"] as const;

async function applyAndAudit(ctx: ToolContext, write: GuardrailWrite): Promise<WorkspaceGuardrail> {
	return getDb().begin(async (tx) => {
		await lockOrganizationForRelationshipClaims(tx, ctx.organizationId);
		// Shared with GrantStore.grant: an allow grant commits either before
		// this write's grant cleanup or after its judge is visible. Everything
		// that depends on which agents exist is read after this lock.
		await lockEgressJudgeDecisions(tx, ctx.organizationId);
		if (write.guardrail) await assertEgressJudgeNotShadowed(tx, ctx.organizationId, write.guardrail);
		const { before, after, changed } = await applyGuardrailWrite(tx, ctx.organizationId, write);
		if (!changed) return after;
		if (write.guardrail) await revokeShadowingGrants(tx, ctx.organizationId, write.guardrail);
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
	const sql = getDb();
	const before = await checkGuardrailWrite(sql, ctx.organizationId, write, { lock: false });
	// `write.guardrail` is set for create and update.
	const next = write.guardrail as GuardrailBody;
	await assertJudgeModelRunnable(ctx.organizationId, next, before);
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
