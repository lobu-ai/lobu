import { describe, expect, test } from "bun:test";
import type { DbClient } from "../../db/client";
import {
	classifyMutationPrincipal,
	evaluateEntityFieldUpdates,
	evaluateEntityMutation,
	mutationPrincipalId,
	resolveWritePolicyDecision,
} from "../../authz/entity-policy";

type PolicyRowSeed = {
	id?: number;
	resource_class?: string;
	principal_kind?: string | null;
	principal_id?: string | null;
	/** agent_config exception target; null = any target. */
	target_agent_id?: string | null;
	entity_type_slug?: string | null;
	field_path?: string | null;
	entity_id?: number | null;
	create_mode?: string;
	update_mode?: string;
	delete_mode?: string;
	/** Explicit action→effect child rows; otherwise derive entity/agent_config effects. */
	effects?: Array<{ action: string; effect: string }>;
};

const ORG = "org-1";

/** Derive entity/agent_config child action-effect rows from the fixture modes. */
function seedEffectRows(seed: PolicyRowSeed): Array<{ action: string; effect: string }> {
	if (seed.effects) return seed.effects;
	return [
		{ action: "create", effect: seed.create_mode ?? "auto" },
		{ action: "update", effect: seed.update_mode ?? "auto" },
		{ action: "delete", effect: seed.delete_mode ?? "approval" },
	];
}

/**
 * Tagged-template stub for the two queries the resolver issues:
 *  1. the candidate-policy header query (params: org, resource_class,
 *     principal_kind, principal_id, entity_type_slug, entity_id), and
 *  2. attachEffects' child query (single param: a pgBigintArray of policy ids).
 * The child query is detected by its lone string-array param.
 */
function stubSql(seeds: PolicyRowSeed[]): DbClient {
	const headers = seeds.map((seed, index) => ({
		id: seed.id ?? index + 1,
		organization_id: ORG,
		resource_class: seed.resource_class ?? "entity",
		principal_kind: seed.principal_kind ?? null,
		principal_id: seed.principal_id ?? null,
		operation_key: null,
		connector_key: null,
		connection_id: null,
		operation_category: null,
		target_agent_id: seed.target_agent_id ?? null,
		entity_type_slug: seed.entity_type_slug ?? null,
		field_path: seed.field_path ?? null,
		entity_id: seed.entity_id ?? null,
		approval_connection_id: null,
		approval_channel_id: null,
		approval_team_id: null,
		approval_channel_name: null,
	}));
	const childRows = seeds.flatMap((seed, index) =>
		seedEffectRows(seed).map((e) => ({
			policy_id: seed.id ?? index + 1,
			action: e.action,
			effect: e.effect,
		})),
	);
	const sql = (_strings: TemplateStringsArray, ...params: unknown[]) => {
		// attachEffects passes exactly one param: a pgBigintArray string like "{1,2}".
		if (params.length === 1 && typeof params[0] === "string") {
			const ids = new Set(
				(params[0] as string)
					.replace(/[{}]/g, "")
					.split(",")
					.filter(Boolean)
					.map((n) => Number(n)),
			);
			return Promise.resolve(childRows.filter((r) => ids.has(Number(r.policy_id))));
		}
		// Param order mirrors loadCandidatePolicies' WHERE: org, resourceClass,
		// principalKind, principalId, ownerAgentId×2, targetAgentId,
		// allEntityScopes, entityTypeSlug, allEntityScopes, entityId.
		const [
			org,
			resourceClass,
			principalKind,
			principalId,
			ownerAgentId,
			,
			targetAgentId,
			allEntityTypes,
			entityTypeSlug,
			allEntityIds,
			entityId,
		] = params as [
			string,
			string,
			string | null,
			string | null,
			string | null,
			string | null,
			string | null,
			boolean,
			string | null,
			boolean,
			number | null,
		];
		return Promise.resolve(
			headers.filter(
				(row) =>
					row.organization_id === org &&
					row.resource_class === resourceClass &&
					(row.principal_kind === null ||
						(row.principal_kind === principalKind &&
							(row.principal_id === null ||
								row.principal_id === principalId)) ||
						(ownerAgentId !== null &&
							row.principal_kind === "agent" &&
							(row.principal_id === null ||
								row.principal_id === ownerAgentId))) &&
					(row.target_agent_id === null ||
						row.target_agent_id === targetAgentId) &&
					(allEntityTypes || row.entity_type_slug === null ||
						row.entity_type_slug === entityTypeSlug) &&
					(allEntityIds || row.entity_id === null || row.entity_id === entityId),
			),
		);
	};
	return sql as unknown as DbClient;
}

describe("classifyMutationPrincipal", () => {
	test("a genuine automation (no agentId) classifies as automation", () => {
		expect(
			classifyMutationPrincipal({ automationSource: { automation_id: 5 } }),
		).toBe("automation");
	});

	test("SECURITY: a trusted agentId beats a caller-supplied automation_source", () => {
		// An agent run cannot demote itself to an automation (and escape its agent
		// policy) by tagging the write with an automation_source it controls.
		expect(
			classifyMutationPrincipal({
				agentId: "agent-A",
				automationSource: { automation_id: 5 },
			}),
		).toBe("agent");
	});

	test("real user session is a user", () => {
		expect(classifyMutationPrincipal({ userId: "u1" })).toBe("user");
	});

	test("agent run is an agent even with a user in context", () => {
		expect(classifyMutationPrincipal({ userId: "u1", agentId: "a1" })).toBe(
			"agent",
		);
	});

	test("system/automation context (no user, no agent) is an agent, not a user", () => {
		expect(classifyMutationPrincipal({})).toBe("agent");
	});
});

describe("mutationPrincipalId", () => {
	test("a genuine automation (no agentId) resolves to automation:<id>", () => {
		expect(mutationPrincipalId({ agentId: null, automationId: 6 })).toBe(
			"automation:6",
		);
	});

	test("SECURITY: agentId wins over a caller-supplied automationId — no spoofing", () => {
		// An agent supplying automation_source:{automation_id:6} still resolves to its own
		// agent id, so it is matched against ITS agent policy, not automation:6's.
		expect(mutationPrincipalId({ agentId: "agent-A", automationId: 6 })).toBe(
			"agent-A",
		);
	});

	test("no principal id → null (any agent)", () => {
		expect(mutationPrincipalId({})).toBeNull();
	});
});

describe("evaluateEntityMutation", () => {
	test("cross-org write is denied regardless of policy", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "update",
				entityTypeSlug: "task",
				entityOrgId: "other-org",
				sql: stubSql([]),
			}),
		).toBe("deny");
	});

	test("human mutations are never gated here", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "user",
				action: "delete",
				entityTypeSlug: "task",
				sql: stubSql([]),
			}),
		).toBe("allow");
	});

	test("default policy: agent delete requires approval, create is auto", async () => {
		const sql = stubSql([]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "automation",
				action: "delete",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("require_approval");
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "create",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("allow");
	});

	test("delete_mode auto actually disables the delete gate", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "delete",
				entityTypeSlug: "task",
				sql: stubSql([{ delete_mode: "auto" }]),
			}),
		).toBe("allow");
	});

	test("create_mode approval gates agent creates", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "create",
				entityTypeSlug: "task",
				sql: stubSql([{ entity_type_slug: "task", create_mode: "approval" }]),
			}),
		).toBe("require_approval");
	});

	test("deny mode is a hard floor — the write is denied, not queued", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "create",
				entityTypeSlug: "task",
				sql: stubSql([{ entity_type_slug: "task", create_mode: "deny" }]),
			}),
		).toBe("deny");
	});

	test("per-principal row beats a broader any-principal row", async () => {
		// Global says auto for creates; a row pinned to this one agent says approval.
		const sql = stubSql([
			{ create_mode: "auto" },
			{ principal_kind: "agent", principal_id: "agent-77", create_mode: "approval" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				principalId: "agent-77",
				action: "create",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("require_approval");
		// A different agent is unaffected and falls back to the global auto.
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				principalId: "agent-99",
				action: "create",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("allow");
	});

	test("principal-kind row (any id) applies to every agent of that kind", async () => {
		const sql = stubSql([
			{ principal_kind: "automation", delete_mode: "deny" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "automation",
				principalId: "automation:5",
				action: "delete",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("deny");
		// An agent (different kind) is not matched by an automation-kind row.
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("require_approval");
	});

	test("peer overrides fold most-restrictive: a per-type auto cannot loosen a per-agent approval", async () => {
		// entity-type row (any principal) says auto; an agent-pinned row says approval.
		// Under the v1.1 floor rule, restrictiveness wins over scope — a narrow `auto`
		// can never open a hole a broader `approval` meant to close. Both rows address
		// `update`, so the stricter (approval) governs → the pinned agent is gated.
		const sql = stubSql([
			{ entity_type_slug: "task", update_mode: "auto" },
			{ principal_kind: "agent", principal_id: "agent-77", update_mode: "approval" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				principalId: "agent-77",
				action: "update",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("require_approval");
	});

	test("an agent-global auto must NOT shadow an entity-type-specific deny", async () => {
		// A broad per-principal `auto` cannot open up a narrowly-scoped `deny`.
		// Restrictiveness wins in the fold → deny (deny is the strictest effect).
		const sql = stubSql([
			{ entity_type_slug: "invoice", update_mode: "deny" },
			{ principal_kind: "agent", principal_id: "agent-A", update_mode: "auto" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				principalId: "agent-A",
				action: "update",
				entityTypeSlug: "invoice",
				sql,
			}),
		).toBe("deny");
	});

	test("principal breaks a SCOPE tie: two global rows, the pinned one wins", async () => {
		// Both rows are global scope (equal scope specificity), so principal
		// specificity is the tie-break — the agent-pinned approval governs.
		const sql = stubSql([
			{ update_mode: "auto" },
			{ principal_kind: "agent", principal_id: "agent-77", update_mode: "approval" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				principalId: "agent-77",
				action: "update",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("require_approval");
	});

	test("restrictive-wins breaks a full tie: deny beats auto at equal specificity", async () => {
		// Same scope + same (null) principal → tie broken by restrictiveness: deny wins.
		const sql = stubSql([
			{ entity_type_slug: "task", update_mode: "auto" },
			{ entity_type_slug: "task", update_mode: "deny" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "update",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("deny");
	});

	test("entity-scoped (row-level) policy beats the type policy", async () => {
		const sql = stubSql([
			{ entity_type_slug: "task", delete_mode: "auto" },
			{ entity_type_slug: "task", entity_id: 3202, delete_mode: "approval" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "delete",
				entityTypeSlug: "task",
				entityId: 3202,
				sql,
			}),
		).toBe("require_approval");
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "delete",
				entityTypeSlug: "task",
				entityId: 9999,
				sql,
			}),
		).toBe("allow");
	});
});

describe("resolveWritePolicyDecision (agent_config)", () => {
	test("a human member applies immediately regardless of policy", async () => {
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "user",
				action: "update",
				sql: stubSql([{ resource_class: "agent_config", update_mode: "deny" }]),
			}),
		).toBe("allow");
	});

	test("default: agent create/update queue approval, delete is denied", async () => {
		const sql = stubSql([]);
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "agent",
				action: "create",
				sql,
			}),
		).toBe("require_approval");
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "agent",
				action: "delete",
				sql,
			}),
		).toBe("deny");
	});

	test("an org policy row can loosen the agent_config default to auto", async () => {
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "agent",
				action: "update",
				sql: stubSql([{ resource_class: "agent_config", update_mode: "auto" }]),
			}),
		).toBe("allow");
	});

	test("an entity-class row does not leak into an agent_config decision", async () => {
		// Only an entity row exists; agent_config falls back to its own default.
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "agent",
				action: "update",
				sql: stubSql([{ resource_class: "entity", update_mode: "auto" }]),
			}),
		).toBe("require_approval");
	});
});

describe("persisted mode fails closed (sol review #7)", () => {
	test("an UNKNOWN stored mode resolves to deny, never allow", async () => {
		// A mode a future build introduced mid-rolling-upgrade, or corrupt data from
		// manual SQL, must NOT read as `allow`. parsePersistedMode maps it to deny.
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "create",
				entityTypeSlug: "task",
				sql: stubSql([
					{ entity_type_slug: "task", create_mode: "quantum-approve" },
				]),
			}),
		).toBe("deny");
	});

	test("unknown stored mode fails closed for agent_config too", async () => {
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "agent",
				action: "update",
				sql: stubSql([
					{ resource_class: "agent_config", update_mode: "??" },
				]),
			}),
		).toBe("deny");
	});

	test("a valid stored mode still resolves normally (no over-eager deny)", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "create",
				entityTypeSlug: "task",
				sql: stubSql([
					{ entity_type_slug: "task", create_mode: "approval" },
				]),
			}),
		).toBe("require_approval");
	});
});

describe("evaluateEntityFieldUpdates", () => {
	const baseArgs = {
		organizationId: ORG,
		entityTypeSlug: "task",
		entityId: 3202,
		entityOrgId: ORG,
	} as const;

	test("human-owned field requires approval even when policy is auto", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "automation",
			fields: { rationale: "human", status: "none" },
			sql: stubSql([]),
		});
		expect(decisions.rationale).toBe("require_approval");
		expect(decisions.status).toBe("allow");
	});

	test("update_mode approval gates unowned fields too", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "agent",
			fields: { status: "none" },
			sql: stubSql([{ entity_type_slug: "task", update_mode: "approval" }]),
		});
		expect(decisions.status).toBe("require_approval");
	});

	test("field-scoped policy overrides the type policy for that field only", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "agent",
			fields: { rationale: "none", status: "none" },
			sql: stubSql([
				{ entity_type_slug: "task", update_mode: "auto" },
				{
					entity_type_slug: "task",
					field_path: "rationale",
					update_mode: "approval",
				},
			]),
		});
		expect(decisions.rationale).toBe("require_approval");
		expect(decisions.status).toBe("allow");
	});

	test("entity-scoped policy gates updates to that entity only", async () => {
		const sql = stubSql([
			{ entity_type_slug: "task", entity_id: 3202, update_mode: "approval" },
		]);
		const gated = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "agent",
			fields: { status: "none" },
			sql,
		});
		expect(gated.status).toBe("require_approval");
		const other = await evaluateEntityFieldUpdates({
			...baseArgs,
			entityId: 9999,
			principalKind: "agent",
			fields: { status: "none" },
			sql,
		});
		expect(other.status).toBe("allow");
	});

	test("deny mode on a field denies it even when human-owned", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "agent",
			fields: { locked: "human", status: "none" },
			sql: stubSql([{ entity_type_slug: "task", update_mode: "deny" }]),
		});
		expect(decisions.locked).toBe("deny");
		expect(decisions.status).toBe("deny");
	});

	test("per-principal update policy gates only the pinned automation", async () => {
		const sql = stubSql([
			{ principal_kind: "automation", principal_id: "automation:6", update_mode: "approval" },
		]);
		const pinned = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "automation",
			principalId: "automation:6",
			fields: { status: "none" },
			sql,
		});
		expect(pinned.status).toBe("require_approval");
		const other = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "automation",
			principalId: "automation:7",
			fields: { status: "none" },
			sql,
		});
		expect(other.status).toBe("allow");
	});

	test("cross-org update denies every field", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			entityOrgId: "other-org",
			principalKind: "agent",
			fields: { status: "none" },
			sql: stubSql([]),
		});
		expect(decisions.status).toBe("deny");
	});

	test("human edits pass through untouched", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "user",
			fields: { rationale: "human" },
			sql: stubSql([]),
		});
		expect(decisions.rationale).toBe("allow");
	});
});
