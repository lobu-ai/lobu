/**
 * Durable audit coverage for every manage_entity refusal — policy and write
 * rule, across create/update/delete. A clean refusal is only truthful
 * when the append-only denial row survives; a pre-transaction policy deny
 * commits its row first, and a rule deny raised inside the write transaction
 * is recorded after that transaction rolls back. Either way the attempted
 * mutation must never land, and the row must name fields only — never the
 * values the caller tried to write.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileEntityRule } from "../../../authz/entity-rule-executor";
import type { Env } from "../../../index";
import { manageEntity } from "../../../tools/admin/manage_entity";
import type { ToolContext } from "../../../tools/registry";
import { recordEntityWriteDenial } from "../../../utils/entity-write-denial-audit";
import { createEntity } from "../../../utils/entity-management";
import { ToolUserError } from "../../../utils/errors";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestUser,
	seedSystemEntityTypes,
} from "../../setup/test-fixtures";

const env = {} as Env;

function agentContext(
	organizationId: string,
	userId: string,
	agentId: string,
): ToolContext {
	return {
		organizationId,
		userId,
		memberRole: "owner",
		agentId,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		scopedToOrg: true,
		allowCrossOrg: false,
	} as ToolContext;
}

async function policyEffect(
	organizationId: string,
	principalId: string,
	action: "create" | "update" | "delete",
	effect: "auto" | "approval" | "deny",
): Promise<void> {
	const sql = getTestDb();
	const [policy] = await sql<{ id: number }[]>`
		INSERT INTO write_approval_policies (
			organization_id, resource_class, principal_kind, principal_id
		) VALUES (
			${organizationId}, 'entity', 'agent', ${principalId}
		)
		RETURNING id
	`;
	await sql`
		INSERT INTO write_policy_action_effects (policy_id, action, effect)
		VALUES (${policy.id}, ${action}, ${effect})
	`;
}

const DENY_ATTEMPTS_RULE = `
export default (row) => {
  if (row.op === "create" && row.next.status === "blocked") {
    row.deny("blocked invoices cannot be created");
  }
  if (row.op === "update" && row.changed("status") && row.next.status === "blocked") {
    row.deny("blocked is not a legal status");
  }
  if (row.op === "update" && row.changed("$deleted") && row.next.$deleted) {
    row.deny("this invoice cannot be deleted");
  }
};
`;

let denyAttemptsCompiled: string;

async function ruledWorkspace() {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Denied Rule Audit Org" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const agent = await createTestAgent({
		organizationId: org.id,
		ownerUserId: user.id,
	});
	await sql`
		INSERT INTO entity_types (
			organization_id, slug, name, metadata_schema, rules_compiled,
			created_at, updated_at
		) VALUES (
			${org.id}, 'invoice', 'Invoice', ${sql.json({ type: "object" })},
			${denyAttemptsCompiled}, current_timestamp, current_timestamp
		)
	`;
	return { org, user, agent };
}

async function denialEvents(organizationId: string) {
	return getTestDb()`
		SELECT id, to_jsonb(entity_ids) AS entity_ids, origin_id, origin_type,
		       title, payload_type, payload_text, payload_data, metadata,
		       organization_id, to_jsonb(linked_org_ids) AS linked_org_ids,
		       automation_id, run_id, created_by, client_id
		FROM events
		WHERE organization_id = ${organizationId}
		  AND semantic_type = 'change'
		  AND metadata->>'category' = 'entity_write_denial'
		ORDER BY id
	`;
}

describe("manage_entity write-denial audit", () => {
	beforeAll(async () => {
		denyAttemptsCompiled = await compileEntityRule(DENY_ATTEMPTS_RULE);
	}, 60_000);

	beforeEach(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		await seedSystemEntityTypes();
	});

	it("persists a privacy-safe create denial while creating no entity", async () => {
		const org = await createTestOrganization({ name: "Denied Create Audit Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		await policyEffect(org.id, agent.agentId, "create", "deny");

		const secretName = "attempted-name-must-not-persist";
		const secretContent = "attempted-content-must-not-persist";
		const secretValue = "attempted-metadata-value-must-not-persist";
		await expect(
			manageEntity(
				{
					action: "create",
					entity_type: "brand",
					name: secretName,
					content: secretContent,
					metadata: { private_attempt: secretValue },
				},
				env,
				agentContext(org.id, user.id, agent.agentId),
			),
		).rejects.toMatchObject({ httpStatus: 403 });

		const entities = await getTestDb()`
			SELECT id FROM entities
			WHERE organization_id = ${org.id} AND name = ${secretName}
		`;
		expect(entities).toHaveLength(0);

		const events = await denialEvents(org.id);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			entity_ids: null,
			origin_type: "entity_write_denial",
			title: "Entity create denied by policy",
			payload_type: "empty",
			payload_text: null,
			payload_data: {},
			organization_id: org.id,
			linked_org_ids: [],
		});
		expect(events[0].metadata).toMatchObject({
			category: "entity_write_denial",
			denial_source: "policy",
			operation: "create",
			denied_fields: [],
			entity_id: null,
			entity_type: "brand",
			principal_kind: "agent",
			principal_id: agent.agentId,
			automation_id: null,
			run_id: null,
			tool_call_id_or_equivalent: expect.stringMatching(
				/^[0-9a-f]{8}-[0-9a-f-]{27}$/,
			),
			_lobu_event_type: "entity.denied",
		});
		expect(events[0].origin_id).toBe(
			`entity_write_denial:v1:${events[0].metadata.tool_call_id_or_equivalent}:create`,
		);
		const stored = JSON.stringify(events[0]);
		expect(stored).not.toContain(secretName);
		expect(stored).not.toContain(secretContent);
		expect(stored).not.toContain(secretValue);
	});

	it("persists an anchored delete denial while leaving the entity live", async () => {
		const org = await createTestOrganization({ name: "Denied Delete Audit Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const entity = await createTestEntity({
			organization_id: org.id,
			entity_type: "brand",
			name: "Entity that must remain live",
			created_by: user.id,
		});
		await policyEffect(org.id, agent.agentId, "delete", "deny");

		await expect(
			manageEntity(
				{ action: "delete", entity_id: entity.id },
				env,
				agentContext(org.id, user.id, agent.agentId),
			),
		).rejects.toMatchObject({ httpStatus: 403 });

		const [storedEntity] = await getTestDb()`
			SELECT deleted_at FROM entities WHERE id = ${entity.id}
		`;
		expect(storedEntity.deleted_at).toBeNull();

		const events = await denialEvents(org.id);
		expect(events).toHaveLength(1);
		expect(events[0].entity_ids).toEqual([entity.id]);
		expect(events[0].linked_org_ids).toEqual([]);
		expect(events[0].metadata).toMatchObject({
			category: "entity_write_denial",
			denial_source: "policy",
			operation: "delete",
			denied_fields: [],
			entity_id: entity.id,
			entity_type: "brand",
			principal_kind: "agent",
			principal_id: agent.agentId,
		});
	});

	it("does not attach a caller-org audit to a public entity owned by another org", async () => {
		const callerOrg = await createTestOrganization({ name: "Audit Caller Org" });
		const publicOrg = await createTestOrganization({
			name: "Public Catalog Org",
			visibility: "public",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, callerOrg.id, "owner");
		const agent = await createTestAgent({
			organizationId: callerOrg.id,
			ownerUserId: user.id,
		});
		const publicEntity = await createTestEntity({
			organization_id: publicOrg.id,
			entity_type: "brand",
			name: "Readable public entity",
			created_by: user.id,
		});
		await policyEffect(callerOrg.id, agent.agentId, "delete", "deny");

		await expect(
			manageEntity(
				{ action: "delete", entity_id: publicEntity.id },
				env,
				agentContext(callerOrg.id, user.id, agent.agentId),
			),
		).rejects.toMatchObject({ httpStatus: 403 });

		const events = await denialEvents(callerOrg.id);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ entity_ids: null, linked_org_ids: [] });
		expect(events[0].metadata).toMatchObject({
			operation: "delete",
			entity_id: publicEntity.id,
		});
		const [storedEntity] = await getTestDb()`
			SELECT deleted_at FROM entities WHERE id = ${publicEntity.id}
		`;
		expect(storedEntity.deleted_at).toBeNull();
	});

	it("reuses one stable attempt id after failure and on duplicate delivery", async () => {
		const org = await createTestOrganization({ name: "Idempotent Audit Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const attemptId = "4dd3f5d0-4f2c-4fda-a086-bf1e103d0d73";
		const validCtx = agentContext(org.id, user.id, agent.agentId);
		const invalidCtx = {
			...validCtx,
			userId: "user_missing_for_audit_fk",
		};
		const audit = {
			organizationId: org.id,
			attemptId,
			denialSource: "policy" as const,
			operation: "create" as const,
			reason: "Policy denied creating brand",
			deniedFields: [],
			entityId: null,
			entityType: "brand",
			entityOrganizationId: null,
			actor: {
				kind: "agent" as const,
				id: agent.agentId,
				ownerAgentId: null,
				ownerResolved: true,
			},
			automationId: null,
		};

		await expect(
			recordEntityWriteDenial({ ...audit, ctx: invalidCtx }),
		).rejects.toThrow(
			"Entity write was blocked, but its denial audit could not be persisted",
		);
		await recordEntityWriteDenial({ ...audit, ctx: validCtx });
		await recordEntityWriteDenial({ ...audit, ctx: validCtx });

		const events = await denialEvents(org.id);
		expect(events).toHaveLength(1);
		expect(events[0].metadata.tool_call_id_or_equivalent).toBe(attemptId);
		expect(events[0].metadata._lobu_idempotency_key).toBe(
			`audit:entity_write_denial:v1:${attemptId}:create`,
		);
	});

	it("returns operational errors and leaves create/delete mutations absent when audits cannot commit", async () => {
		const org = await createTestOrganization({ name: "Failed Audit Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		await policyEffect(org.id, agent.agentId, "create", "deny");
		const ctx = agentContext(org.id, user.id, agent.agentId);
		ctx.userId = "user_missing_for_load_bearing_audit";

		let failure: unknown;
		try {
			await manageEntity(
				{ action: "create", entity_type: "brand", name: "Must not exist" },
				env,
				ctx,
			);
		} catch (err) {
			failure = err;
		}
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(ToolUserError);
		expect(failure).toMatchObject({
			message: "Entity write was blocked, but its denial audit could not be persisted",
		});
		const entities = await getTestDb()`
			SELECT id FROM entities
			WHERE organization_id = ${org.id} AND name = 'Must not exist'
		`;
		expect(entities).toHaveLength(0);
		expect(await denialEvents(org.id)).toHaveLength(0);

		const entity = await createTestEntity({
			organization_id: org.id,
			entity_type: "brand",
			name: "Must remain live",
			created_by: user.id,
		});
		await getTestDb()`
			INSERT INTO write_policy_action_effects (policy_id, action, effect)
			SELECT id, 'delete', 'deny'
			FROM write_approval_policies
			WHERE organization_id = ${org.id}
			  AND principal_kind = 'agent'
			  AND principal_id = ${agent.agentId}
		`;
		await expect(
			manageEntity({ action: "delete", entity_id: entity.id }, env, ctx),
		).rejects.toMatchObject({
			message: "Entity write was blocked, but its denial audit could not be persisted",
		});
		const [storedEntity] = await getTestDb()`
			SELECT deleted_at FROM entities WHERE id = ${entity.id}
		`;
		expect(storedEntity.deleted_at).toBeNull();
		expect(await denialEvents(org.id)).toHaveLength(0);
	});

	it("does not audit schema validation failures", async () => {
		const org = await createTestOrganization({ name: "Validation Failure Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		await policyEffect(org.id, agent.agentId, "create", "deny");

		await expect(
			manageEntity(
				{ action: "create", entity_type: "brand", name: "" },
				env,
				agentContext(org.id, user.id, agent.agentId),
			),
		).rejects.toMatchObject({ httpStatus: 400 });
		expect(await denialEvents(org.id)).toHaveLength(0);
	});

	it("does not classify an approval deferral as a denial", async () => {
		const org = await createTestOrganization({ name: "Deferred Create Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		await policyEffect(org.id, agent.agentId, "create", "approval");

		const result = await manageEntity(
			{ action: "create", entity_type: "brand", name: "Deferred entity" },
			env,
			agentContext(org.id, user.id, agent.agentId),
		);
		expect(result).toMatchObject({
			action: "create",
			approval_queued: true,
		});
		expect(await denialEvents(org.id)).toHaveLength(0);
		const entities = await getTestDb()`
			SELECT id FROM entities
			WHERE organization_id = ${org.id} AND name = 'Deferred entity'
		`;
		expect(entities).toHaveLength(0);
	});

	it("persists an update policy denial after rollback with field names only", async () => {
		const org = await createTestOrganization({ name: "Denied Update Audit Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const entity = await createTestEntity({
			organization_id: org.id,
			entity_type: "brand",
			name: "Policy protected",
			created_by: user.id,
		});
		await policyEffect(org.id, agent.agentId, "update", "deny");
		const secretValue = "attempted-update-value-must-not-persist";

		await expect(
			manageEntity(
				{
					action: "update",
					entity_id: entity.id,
					metadata: { private_attempt: secretValue },
				},
				env,
				agentContext(org.id, user.id, agent.agentId),
			),
		).rejects.toMatchObject({ httpStatus: 403 });

		const [storedEntity] = await getTestDb()`
			SELECT metadata FROM entities WHERE id = ${entity.id}
		`;
		expect(storedEntity.metadata).toEqual({});
		const events = await denialEvents(org.id);
		expect(events).toHaveLength(1);
		expect(events[0].metadata).toMatchObject({
			denial_source: "policy",
			operation: "update",
			denied_fields: ["private_attempt"],
			entity_id: entity.id,
			entity_type: "brand",
		});
		expect(JSON.stringify(events[0])).not.toContain(secretValue);
	});

	it("persists create and update rule denials after rollback without attempted values", async () => {
		const { org, user, agent } = await ruledWorkspace();
		const ctx = agentContext(org.id, user.id, agent.agentId);
		const createSecret = "blocked-create-secret";

		await expect(
			manageEntity(
				{
					action: "create",
					entity_type: "invoice",
					name: "Denied invoice",
					metadata: { status: "blocked", private_attempt: createSecret },
				},
				env,
				ctx,
			),
		).rejects.toThrow("blocked invoices cannot be created");

		const invoice = await createEntity({
			entity_type: "invoice",
			name: "Legal invoice",
			organization_id: org.id,
			created_by: user.id,
			metadata: { status: "draft", untouched: "keep" },
		});
		const updateSecret = "blocked-update-secret";
		await expect(
			manageEntity(
				{
					action: "update",
					entity_id: invoice.id,
					metadata: { status: "blocked", private_attempt: updateSecret },
				},
				env,
				ctx,
			),
		).rejects.toThrow("blocked is not a legal status");

		const [stored] = await getTestDb()`
			SELECT metadata FROM entities WHERE id = ${invoice.id}
		`;
		expect(stored.metadata).toMatchObject({ status: "draft", untouched: "keep" });
		const events = await denialEvents(org.id);
		expect(events).toHaveLength(2);
		expect(events[0].metadata).toMatchObject({
			denial_source: "rule",
			operation: "create",
			entity_id: null,
			entity_type: "invoice",
		});
		expect(events[0].metadata.denied_fields).toEqual(
			expect.arrayContaining(["status", "private_attempt"]),
		);
		expect(events[1].metadata).toMatchObject({
			denial_source: "rule",
			operation: "update",
			denied_fields: ["status", "private_attempt"],
			entity_id: invoice.id,
			entity_type: "invoice",
		});
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain(createSecret);
		expect(serialized).not.toContain(updateSecret);
	});

	it("audits real delete rule denials but not dry-run previews", async () => {
		const { org, user, agent } = await ruledWorkspace();
		await policyEffect(org.id, agent.agentId, "delete", "auto");
		const invoice = await createEntity({
			entity_type: "invoice",
			name: "Protected invoice",
			organization_id: org.id,
			created_by: user.id,
			metadata: { status: "draft" },
		});
		const agentCtx = agentContext(org.id, user.id, agent.agentId);

		await manageEntity(
			{ action: "delete", entity_id: invoice.id, dry_run: true },
			env,
			agentCtx,
		);
		expect(await denialEvents(org.id)).toHaveLength(0);

		await expect(
			manageEntity(
				{ action: "delete", entity_id: invoice.id },
				env,
				agentCtx,
			),
		).rejects.toThrow("this invoice cannot be deleted");

		const events = await denialEvents(org.id);
		expect(events).toHaveLength(1);
		expect(events[0].metadata).toMatchObject({
			operation: "delete",
			denial_source: "rule",
			denied_fields: ["$deleted"],
			entity_id: invoice.id,
		});
		const [stored] = await getTestDb()`
			SELECT deleted_at FROM entities WHERE id = ${invoice.id}
		`;
		expect(stored.deleted_at).toBeNull();
	});
});
