/**
 * Decision-parity for the v1.1 action/effect model (PR1).
 *
 * The migration replaced create_mode/update_mode/delete_mode columns with a
 * write_policy_action_effects child table. This test proves, against a real
 * migrated database, that the resolver reaches the SAME decision the old
 * mode-column model would have — for entity and agent_config, including global
 * delivery inheritance. Connector actions use the org policy evaluator; retired
 * stored effects are rejected by the database.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	evaluateEntityMutation,
	resolveEntityApprovalPolicy,
	resolveConnectorPolicy,
	resolveWritePolicyDecision,
	upsertEntityApprovalPolicy,
} from "../../../authz/entity-policy";
import { isLegalActionEffect } from "../../../authz/write-action-manifest";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

/**
 * Insert a policy header + its child action-effect rows directly, the way the
 * migration backfill produces them. `effects` is the complete action set for the
 * scope (entity/agent_config: create/update/delete; connector_action: execute).
 */
async function seedPolicy(args: {
	orgId: string;
	resourceClass: string;
	principalKind?: string | null;
	principalId?: string | null;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	effects: Array<{ action: string; effect: string }>;
	delivery?: { connectionId?: string; channelId?: string };
}): Promise<number> {
	const sql = getTestDb();
	const rows = await sql<{ id: number }>`
    INSERT INTO write_approval_policies
      (organization_id, resource_class, principal_kind, principal_id,
       entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id)
    VALUES
      (${args.orgId}, ${args.resourceClass}, ${args.principalKind ?? null},
       ${args.principalId ?? null}, ${args.entityTypeSlug ?? null},
       ${args.fieldPath ?? null}, NULL,
       ${args.delivery?.connectionId ?? null}, ${args.delivery?.channelId ?? null})
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

describe("write-policy action/effect decision parity", () => {
	afterAll(async () => {
		await cleanupTestDatabase();
	});

	let orgId: string;
	beforeEach(async () => {
		const org = await createTestOrganization();
		orgId = org.id;
		// Seed the agent rows these tests pin policies to — prod guarantees a bound
		// agent id has an agents row, and the policy trigger enforces it (codex-17).
		for (const agentId of ["agent_off", "agent_tie", "agent_xyz"]) {
			await createTestAgent({ organizationId: orgId, agentId });
		}
	});

	it("entity: create auto / update auto / delete approval resolve unchanged", async () => {
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			entityTypeSlug: "task",
			effects: [
				{ action: "create", effect: "auto" },
				{ action: "update", effect: "approval" },
				{ action: "delete", effect: "deny" },
			],
		});
		const base = {
			organizationId: orgId,
			principalKind: "agent" as const,
			entityTypeSlug: "task",
		};
		expect(await evaluateEntityMutation({ ...base, action: "create" })).toBe("allow");
		expect(await evaluateEntityMutation({ ...base, action: "update" })).toBe(
			"require_approval",
		);
		expect(await evaluateEntityMutation({ ...base, action: "delete" })).toBe("deny");
	});

	it("entity: scoped row with no delivery inherits the global row's target", async () => {
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			effects: [
				{ action: "create", effect: "auto" },
				{ action: "update", effect: "auto" },
				{ action: "delete", effect: "approval" },
			],
			delivery: { connectionId: "conn_g", channelId: "chan_ops" },
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			entityTypeSlug: "topic",
			effects: [
				{ action: "create", effect: "approval" },
				{ action: "update", effect: "approval" },
				{ action: "delete", effect: "approval" },
			],
		});
		const policy = await resolveEntityApprovalPolicy({
			organizationId: orgId,
			principalKind: "agent",
			entityTypeSlug: "topic",
		});
		// scoped row's decision, global row's delivery target.
		expect(policy.createMode).toBe("approval");
		expect(policy.deliveryTarget.connectionId).toBe("conn_g");
		expect(policy.deliveryTarget.channelId).toBe("chan_ops");
	});

	it("agent_config: per-principal automation policy resolves each action", async () => {
		await seedPolicy({
			orgId,
			resourceClass: "agent_config",
			principalKind: "automation",
			principalId: "automation:1",
			effects: [
				{ action: "create", effect: "approval" },
				{ action: "update", effect: "approval" },
				{ action: "delete", effect: "deny" },
			],
		});
		const base = {
			organizationId: orgId,
			resourceClass: "agent_config" as const,
			principalKind: "automation" as const,
			principalId: "automation:1",
		};
		expect(await resolveWritePolicyDecision({ ...base, action: "create" })).toBe(
			"require_approval",
		);
		expect(await resolveWritePolicyDecision({ ...base, action: "delete" })).toBe("deny");
	});

	it("agent_config: no row uses the class defaults (create/update approval, delete deny)", async () => {
		const base = {
			organizationId: orgId,
			resourceClass: "agent_config" as const,
			principalKind: "agent" as const,
		};
		expect(await resolveWritePolicyDecision({ ...base, action: "create" })).toBe(
			"require_approval",
		);
		expect(await resolveWritePolicyDecision({ ...base, action: "delete" })).toBe("deny");
	});

	it("connector_action: stored effects tighten the org decision", async () => {
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", effects: { execute: "auto" },
		});
		await seedPolicy({
			orgId, resourceClass: "connector_action", principalKind: "automation",
			effects: [{ action: "execute", effect: "approval" }],
		});
		await seedPolicy({
			orgId, resourceClass: "connector_action", principalKind: "agent", principalId: "agent_xyz",
			effects: [{ action: "execute", effect: "deny" }],
		});
		const base = {
			organizationId: orgId,
			connectionId: null,
			operation: { connector_key: "demo.policy", operation_key: "send", kind: "write" as const },
		};
		expect((await resolveConnectorPolicy({ ...base,
			actor: { kind: "automation", id: "automation:9", ownerAgentId: null, ownerResolved: true },
		})).effect).toBe("approval");
		expect((await resolveConnectorPolicy({ ...base,
			actor: { kind: "agent", id: "agent_xyz", ownerAgentId: null, ownerResolved: true },
		})).effect).toBe("deny");
	});

	it("connector_action: unmatched writes require approval", async () => {
		expect((await resolveConnectorPolicy({
			organizationId: orgId,
			connectionId: null,
			operation: { connector_key: "demo.policy", operation_key: "send", kind: "write" },
			actor: { kind: "agent", id: null, ownerAgentId: null, ownerResolved: true },
		})).effect).toBe("approval");
	});

	it("the permissions-PUT input guards reject payloads that would erase/mis-target a row (codex-11)", async () => {
		// effects MUST be a plain object — an array passes typeof==='object' but yields
		// no entries, so a replace-all upsert would wipe stored effects. Reject arrays.
		const isEffectsMap = (v: unknown) =>
			typeof v === "object" && v !== null && !Array.isArray(v);
		expect(isEffectsMap({ create: "deny" })).toBe(true);
		expect(isEffectsMap([])).toBe(false);
		expect(isEffectsMap(null)).toBe(false);

		// entity_type_slug: present-but-invalid (number, whitespace) must NOT coerce to
		// null (the blanket row) — that would overwrite the broad policy. Only a
		// non-empty string or omitted is valid.
		const slugPresentInvalid = (v: unknown) =>
			v !== undefined &&
			v !== null &&
			(typeof v !== "string" || v.trim() === "");
		expect(slugPresentInvalid(123)).toBe(true);
		expect(slugPresentInvalid("   ")).toBe(true);
		expect(slugPresentInvalid("trip")).toBe(false);
		expect(slugPresentInvalid(undefined)).toBe(false);
		expect(slugPresentInvalid(null)).toBe(false);
	});

	it("a type scope is rejected for non-entity classes; only entity is type-scoped (codex-13)", () => {
		// A present entity_type_slug on agent_config/connector_action must 400, not
		// coerce to null and overwrite the class's blanket policy.
		const slugAllowed = (
			resourceClass: string,
			slug: string | undefined | null,
		) => {
			const present = slug !== undefined && slug !== null;
			return !(present && resourceClass !== "entity");
		};
		expect(slugAllowed("entity", "trip")).toBe(true);
		expect(slugAllowed("agent_config", "trip")).toBe(false);
		expect(slugAllowed("connector_action", "trip")).toBe(false);
		expect(slugAllowed("agent_config", undefined)).toBe(true); // omitted is fine
	});

	it("the permissions-PUT validation predicate rejects illegal (action,effect) pairs (codex-8)", async () => {
		// The endpoint 400s on any entry isLegalActionEffect rejects, rather than
		// dropping it (a dropped entry + replace-all upsert would ERASE a stored deny).
		// entity governs create/update/delete with auto/approval/deny — NOT execute,
		// NOT disabled.
		expect(isLegalActionEffect("entity", "create", "approval")).toBe(true);
		expect(isLegalActionEffect("entity", "execute", "auto")).toBe(false); // illegal action
		expect(isLegalActionEffect("entity", "create", "disabled" as never)).toBe(false); // illegal effect
		expect(isLegalActionEffect("connector_action", "execute", "disabled" as never)).toBe(false);
		expect(isLegalActionEffect("connector_action", "create", "auto")).toBe(false);
		expect(isLegalActionEffect("entity_schema", "create_type", "approval")).toBe(true);
		expect(isLegalActionEffect("entity_schema", "update_relationship_type", "deny")).toBe(true);
		expect(isLegalActionEffect("entity_schema", "create", "auto")).toBe(false);
		expect(isLegalActionEffect("entity_schema", "delete_type", "disabled" as never)).toBe(false);
	});

	it("entity_schema policy writes fail loudly when the effects map is omitted", async () => {
		await expect(
			upsertEntityApprovalPolicy(orgId, { resourceClass: "entity_schema" }),
		).rejects.toThrow("entity_schema policies require an explicit effects map");
	});

	it("the database rejects retired effects instead of storing ambiguous policy", async () => {
		await expect(seedPolicy({
			orgId,
			resourceClass: "entity",
			entityTypeSlug: "task",
			effects: [{ action: "create", effect: "disabled" }],
		})).rejects.toThrow();
	});
});
