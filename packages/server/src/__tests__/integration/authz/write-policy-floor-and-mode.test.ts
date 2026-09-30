/**
 * Real-PG tests for write-gate floor + single-envelope semantics:
 *
 *  - ORG FLOOR is a hard floor: a per-agent row can never LOOSEN a broader
 *    any-principal (org) row. The strictest matched effect wins.
 *  - The class default is a STARTING POINT, not a floor: an explicit row may
 *    loosen the default (agent_config update = auto → allow).
 *  - One envelope for chat and automations (principal_mode dropped): automations
 *    inherit the owning agent's envelope via ownerAgentId.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	evaluateEntityMutation,
	listEntityApprovalPolicies,
	resolveConnectorPolicy,
	resolveWritePolicyDecision,
	upsertEntityApprovalPolicy,
} from "../../../authz/entity-policy";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

async function seedPolicy(args: {
	orgId: string;
	resourceClass: string;
	principalKind?: string | null;
	principalId?: string | null;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
	operationKey?: string | null;
	targetAgentId?: string | null;
	effects: Array<{ action: string; effect: string }>;
}): Promise<number> {
	const sql = getTestDb();
	const rows = await sql<{ id: number }>`
    INSERT INTO write_approval_policies
      (organization_id, resource_class, principal_kind, principal_id,
       operation_key, target_agent_id, entity_type_slug, field_path, entity_id)
    VALUES
      (${args.orgId}, ${args.resourceClass}, ${args.principalKind ?? null},
       ${args.principalId ?? null}, ${args.operationKey ?? null},
       ${args.targetAgentId ?? null}, ${args.entityTypeSlug ?? null},
       ${args.fieldPath ?? null}, ${args.entityId ?? null})
    RETURNING id
  `;
	const id = Number(rows[0].id);
	for (const { action, effect } of args.effects) {
		await sql`
      INSERT INTO write_policy_action_effects (policy_id, action, effect)
      VALUES (${id}, ${action}, ${effect})
    `;
	}
	return id;
}

describe("write-gate floor + single-envelope semantics", () => {
	afterAll(async () => {
		await cleanupTestDatabase();
	});

	let orgId: string;
	beforeEach(async () => {
		const org = await createTestOrganization();
		orgId = org.id;
		// Tests pin policies to these agent ids. Prod guarantees a bound agent id has an
		// agents row (auth binds only after existence; codex-17), and the policy trigger
		// + resolver enforce it — so seed the rows the tests assume.
		for (const agentId of ["agent-1", "agent-auto", "agent-deliv"]) {
			await createTestAgent({ organizationId: orgId, agentId });
		}
	});

	it("org floor holds: a per-agent auto cannot loosen an org approval", async () => {
		// Org (any-principal) row: delete needs approval. Agent-pinned row: delete auto.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			effects: [{ action: "delete", effect: "approval" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "auto" }],
		});
		// The strictest matched effect (approval) wins — the agent can't self-loosen.
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
			}),
		).toBe("require_approval");
	});

	it("org deny is an absolute floor: a per-agent auto still resolves to deny", async () => {
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			effects: [{ action: "delete", effect: "deny" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "auto" }],
		});
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
			}),
		).toBe("deny");
	});

	it("class default is a starting point: an explicit row loosens agent_config update to auto", async () => {
		// Default agent_config update is `approval`. An explicit org row sets auto.
		await seedPolicy({
			orgId,
			resourceClass: "agent_config",
			effects: [{ action: "update", effect: "auto" }],
		});
		expect(
			await resolveWritePolicyDecision({
				organizationId: orgId,
				resourceClass: "agent_config",
				principalKind: "agent",
				principalId: "agent-1",
				action: "update",
			}),
		).toBe("allow");
	});

	it("no row → class default applies (agent_config update = approval)", async () => {
		expect(
			await resolveWritePolicyDecision({
				organizationId: orgId,
				resourceClass: "agent_config",
				principalKind: "agent",
				principalId: "agent-1",
				action: "update",
			}),
		).toBe("require_approval");
	});

	it("chat and automation share one envelope: same agent policy binds both modes", async () => {
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "deny" }],
		});
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
			}),
		).toBe("deny");
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
			}),
		).toBe("deny");
	});

	it("entity read: default auto; per-type deny blocks that type only", async () => {
		// No row → class default read=auto.
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "read",
				entityTypeSlug: "task",
			}),
		).toBe("allow");
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			entityTypeSlug: "secret",
			effects: [{ action: "read", effect: "deny" }],
		});
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "read",
				entityTypeSlug: "secret",
			}),
		).toBe("deny");
		// Other types still auto.
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "read",
				entityTypeSlug: "task",
			}),
		).toBe("allow");
	});

	it("agent_config read: default auto; per-target deny blocks that agent only", async () => {
		expect(
			await resolveWritePolicyDecision({
				organizationId: orgId,
				resourceClass: "agent_config",
				principalKind: "agent",
				principalId: "agent-1",
				action: "read",
				targetAgentId: "agent-auto",
			}),
		).toBe("allow");
		await seedPolicy({
			orgId,
			resourceClass: "agent_config",
			principalKind: "agent",
			principalId: "agent-1",
			targetAgentId: "agent-auto",
			effects: [{ action: "read", effect: "deny" }],
		});
		expect(
			await resolveWritePolicyDecision({
				organizationId: orgId,
				resourceClass: "agent_config",
				principalKind: "agent",
				principalId: "agent-1",
				action: "read",
				targetAgentId: "agent-auto",
			}),
		).toBe("deny");
		// Other targets still auto.
		expect(
			await resolveWritePolicyDecision({
				organizationId: orgId,
				resourceClass: "agent_config",
				principalKind: "agent",
				principalId: "agent-1",
				action: "read",
				targetAgentId: "agent-deliv",
			}),
		).toBe("allow");
	});

	it("per-type override tightens only its type; other types follow the agent default", async () => {
		// Agent default: delete auto. Per-type override for `trip`: delete deny.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "auto" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			entityTypeSlug: "trip",
			effects: [{ action: "delete", effect: "deny" }],
		});
		// trip is denied…
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "trip",
			}),
		).toBe("deny");
		// …but a different type still follows the agent default (auto).
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
			}),
		).toBe("allow");
	});

	it("owner-agent fold: an automation inherits its agent's envelope via ownerAgentId", async () => {
		// The agent (owning agent) sets delete=deny. The AUTOMATION is the acting
		// principal (principalKind='automation') with its agent folded in via
		// ownerAgentId — the agent's deny must bind the automation's write.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "deny" }],
		});
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "automation",
				principalId: "automation:7",
				ownerAgentId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
			}),
		).toBe("deny");
	});

	it("owner-agent fold: an automation-specific deny is NOT loosened by a looser agent envelope", async () => {
		// The owning agent auto-approves delete; a pre-existing AUTOMATION-specific row
		// denies it. Folding the agent envelope in must NOT loosen the automation's own
		// deny — the strictest matched effect wins (this is the P1 regression).
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "auto" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "automation",
			principalId: "automation:7",
			effects: [{ action: "delete", effect: "deny" }],
		});
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "automation",
				principalId: "automation:7",
				ownerAgentId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
			}),
		).toBe("deny");
	});

	it("a field-scoped row does NOT bleed into the entity create/delete decision", async () => {
		// A deny on ONE field (person.ssn update) must govern only that field, never
		// the whole entity's create or delete (this is the P2 regression). With no
		// entity-level row, create/delete follow their class defaults.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			entityTypeSlug: "person",
			fieldPath: "ssn",
			effects: [{ action: "update", effect: "deny" }],
		});
		// create default = auto → allow (the field deny is irrelevant to create).
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "create",
				entityTypeSlug: "person",
			}),
		).toBe("allow");
		// delete default = approval → require_approval (NOT deny from the field row).
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "person",
			}),
		).toBe("require_approval");
	});

	it("a sparse effects input persists ONLY the named actions (untouched stay abstaining)", async () => {
		// A sparse {delete: deny} override must NOT also pin create/update — a
		// stored row for those would stop them inheriting later blanket changes.
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: { delete: "deny" },
		});
		const rows = await listEntityApprovalPolicies(orgId);
		const stored = rows.find(
			(r) =>
				r.principalKind === "agent" &&
				r.principalId === "agent-1" &&
				r.entityTypeSlug === null,
		);
		expect(stored).toBeTruthy();
		// Exactly one child effect row — create/update absent (abstaining).
		expect(stored?.effects).toEqual({ delete: "deny" });
	});

	it("fails CLOSED when an automation's owning agent can't be resolved (codex-8)", async () => {
		// A reaction whose automation row was hard-deleted mid-flight arrives with
		// ownerResolved=false. Even with the most permissive org default (entity
		// create = auto, no deny anywhere), the gate must DENY — proceeding as an
		// unowned automation would let the write slip its agent's envelope.
		const denied = await evaluateEntityMutation({
			organizationId: orgId,
			principalKind: "automation",
			principalId: "automation:999",
			ownerResolved: false,
			action: "create",
			entityTypeSlug: "task",
		});
		expect(denied).toBe("deny");
		// Sanity: the SAME call with a resolved owner (default true) allows (auto).
		const allowed = await evaluateEntityMutation({
			organizationId: orgId,
			principalKind: "automation",
			principalId: "automation:999",
			action: "create",
			entityTypeSlug: "task",
		});
		expect(allowed).toBe("allow");
	});

	it("connector policy fails closed on an unresolved Automation owner", async () => {
		const result = await resolveConnectorPolicy({
			organizationId: orgId,
			connectionId: null,
			operation: { connector_key: "demo.policy", operation_key: "send", kind: "write" },
			actor: { kind: "automation", id: "automation:999", ownerAgentId: null, ownerResolved: false },
		});
		expect(result.effect).toBe("deny");
	});

	it("preserveDelivery keeps a stored approval target across an effect-only update (codex-7)", async () => {
		// First save configures a delivery target (as the entity-settings path would).
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-deliv",
			effects: { create: "approval" },
			approvalConnectionId: "conn_slack",
			approvalChannelId: "chan_ops",
			approvalTeamId: "T123",
			approvalChannelName: "#ops",
		});
		// The effect-only permissions PUT re-saves with NO delivery fields but
		// preserveDelivery set — the stored target must survive.
		const updated = await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-deliv",
			effects: { create: "deny" },
			preserveDelivery: true,
		});
		expect(updated.deliveryTarget.connectionId).toBe("conn_slack");
		expect(updated.deliveryTarget.channelId).toBe("chan_ops");
		expect(updated.effects).toEqual({ create: "deny" });

		// Without preserveDelivery, an omitted delivery still CLEARS it (the
		// entity-settings path means what it sends).
		const cleared = await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-deliv",
			effects: { create: "approval" },
		});
		expect(cleared.deliveryTarget.connectionId).toBeNull();
		expect(cleared.deliveryTarget.channelId).toBeNull();
	});
});
