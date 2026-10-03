import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	type ActingPrincipal,
	type EntityApprovalPolicyInput,
	deleteEntityApprovalPolicy,
	listEntityApprovalPolicies,
	resolveConnectorPolicy,
	upsertEntityApprovalPolicy,
} from "../../../authz/entity-policy";
import { qualifiedOperationKey } from "../../../tools/admin/manage_operations/handlers/shared";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestConnection,
	createTestConnectorDefinition,
	createTestOrganization,
} from "../../setup/test-fixtures";

describe("org connector policy scopes", () => {
	let orgId: string;
	let connectionId: number;
	const operation = {
		connector_key: "policy-fixture",
		operation_key: "classify",
		kind: "write" as const,
	};
	const human: ActingPrincipal = {
		kind: "user",
		id: null,
		ownerAgentId: null,
		ownerResolved: true,
	};
	const agent: ActingPrincipal = {
		kind: "agent",
		id: "policy-agent",
		ownerAgentId: null,
		ownerResolved: true,
	};
	const save = (input: EntityApprovalPolicyInput) =>
		upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			...input,
		});
	const decide = (actor = human, op = operation) =>
		resolveConnectorPolicy({
			organizationId: orgId,
			connectionId,
			operation: op,
			actor,
		});
	beforeEach(async () => {
		orgId = (await createTestOrganization()).id;
	// Exercise the fallback decision independently of the explicit new-org read grant.
		await deleteEntityApprovalPolicy({ organizationId: orgId, resourceClass: "connector_action", operationCategory: "read" });
		await createTestAgent({ organizationId: orgId, agentId: "policy-agent" });
		await createTestConnectorDefinition({
			key: "policy-fixture",
			name: "Policy fixture",
			organization_id: orgId,
		});
		await getTestDb()`UPDATE connector_definitions SET actions_schema = '{"classify":{"name":"Classify","kind":"write"},"read":{"name":"Read","kind":"read"}}'::jsonb WHERE organization_id = ${orgId} AND key = 'policy-fixture'`;
		connectionId = (
			await createTestConnection({
				organization_id: orgId,
				connector_key: "policy-fixture",
			})
		).id;
	});
	afterAll(cleanupTestDatabase);

	it("new orgs receive a visible Reads Auto rule, and deleting it restores Ask without reseeding", async () => {
		const freshOrg = await createTestOrganization();
		const policies = await listEntityApprovalPolicies(freshOrg.id, "connector_action");
		const readRule = policies.find((policy) => policy.operationCategory === "read");
		expect(readRule).toMatchObject({ principalKind: null, connectionId: null, connectorKey: null, effects: { execute: "auto" } });
		const inspect = () => resolveConnectorPolicy({ organizationId: freshOrg.id, connectionId: null, operation: { ...operation, kind: "read" }, actor: human });
		expect(await inspect()).toMatchObject({ effect: "auto", ruleIds: [readRule!.id], reason: "matched_rule" });
		expect(await deleteEntityApprovalPolicy({ organizationId: freshOrg.id, resourceClass: "connector_action", operationCategory: "read" })).toBe(true);
		for (let i = 0; i < 2; i++) expect(await inspect()).toEqual({ effect: "approval", ruleIds: [], reason: "default_approval" });
		expect(await listEntityApprovalPolicies(freshOrg.id, "connector_action")).toEqual([]);
	});

	it("defaults to Ask for humans and agents, including reads until a rule grants them Auto", async () => {
		expect(await decide()).toEqual({
			effect: "approval",
			ruleIds: [],
			reason: "default_approval",
		});
		expect((await decide(agent)).effect).toBe("approval");
		const read = { ...operation, kind: "read" as const };
		expect(
			(
				await resolveConnectorPolicy({
					organizationId: orgId,
					connectionId,
					operation: read,
					actor: agent,
				})
			).effect,
		).toBe("approval");
		await save({ operationCategory: "read", effects: { execute: "auto" } });
		expect(
			(
				await resolveConnectorPolicy({
					organizationId: orgId,
					connectionId,
					operation: read,
					actor: agent,
				})
			).effect,
		).toBe("auto");
		expect((await decide(agent)).effect).toBe("approval");
	});

	it("an explicit classification Auto rule permits a conservatively typed write", async () => {
		const rule = await save({
			connectorKey: operation.connector_key,
			operationKey: qualifiedOperationKey(
				operation.connector_key,
				operation.operation_key,
			),
			effects: { execute: "auto" },
		});
		expect(await decide(agent)).toEqual({
			effect: "auto",
			ruleIds: [rule.id],
			reason: "matched_rule",
		});
		expect(
			(await decide(agent, { ...operation, connector_key: "other-fixture" }))
				.effect,
		).toBe("approval");
	});

	it("canonicalizes exact actions and requires exceptions to narrow both target and action", async () => {
		const exact = await save({
			operationKey: qualifiedOperationKey(
				operation.connector_key,
				operation.operation_key,
			),
			effects: { execute: "deny" },
		});
		expect(exact.connectorKey).toBe(operation.connector_key);
		await save({
			connectorKey: operation.connector_key,
			effects: { execute: "approval" },
		});
		expect((await decide()).effect).toBe("deny");
		await save({ connectionId, effects: { execute: "auto" } });
		expect((await decide()).effect).toBe("deny");
		await save({ connectionId, operationKey: exact.operationKey, effects: { execute: "auto" } });
		expect((await decide()).effect).toBe("auto");
		await deleteEntityApprovalPolicy({ organizationId: orgId, resourceClass: "connector_action", connectionId, operationKey: exact.operationKey });
		await deleteEntityApprovalPolicy({
			organizationId: orgId,
			resourceClass: "connector_action",
			connectionId,
		});
		await deleteEntityApprovalPolicy({
			organizationId: orgId,
			resourceClass: "connector_action",
			connectorKey: operation.connector_key,
		});
		expect((await decide()).effect).toBe("deny");
	});

	it("keeps destructive restrictions under a broad connection Auto until the same category is excepted", async () => {
		const op = { ...operation, annotations: { destructiveHint: true } };
		const inspect = () => resolveConnectorPolicy({ organizationId: orgId, connectionId, operation: op, actor: agent });
		await save({ effects: { execute: "auto" } });
		const block = await save({ operationCategory: "destructive", effects: { execute: "deny" } });
		await save({ connectionId, effects: { execute: "auto" } });
		expect(await inspect()).toMatchObject({ effect: "deny", ruleIds: [block.id] });
		// Writes and destructive are different categories, not interchangeable exceptions.
		await save({ connectionId, operationCategory: "write", effects: { execute: "auto" } });
		expect((await inspect()).effect).toBe("deny");
		const exception = await save({ connectionId, operationCategory: "destructive", effects: { execute: "auto" } });
		expect(await inspect()).toMatchObject({ effect: "auto", ruleIds: expect.arrayContaining([exception.id]) });
	});

	it("keeps an org category Ask under connection Auto while allowing exact action exceptions", async () => {
		await save({ operationCategory: "write", effects: { execute: "approval" } });
		await save({ connectionId, effects: { execute: "auto" } });
		expect((await decide()).effect).toBe("approval");
		await save({ connectionId, operationKey: qualifiedOperationKey(operation.connector_key, operation.operation_key), effects: { execute: "auto" } });
		expect((await decide()).effect).toBe("auto");
	});

	it("uses defaults as fallbacks and keeps impact categories off reads", async () => {
		await save({ effects: { execute: "deny" } });
		await save({ connectorKey: operation.connector_key, effects: { execute: "auto" } });
		expect((await decide()).effect).toBe("auto");
		for (const operationCategory of ["unknown", "destructive", "non_destructive"] as const) {
			await save({ connectorKey: operation.connector_key, operationCategory, effects: { execute: "deny" } });
		}
		for (const destructiveHint of [undefined, true, false]) {
			expect((await resolveConnectorPolicy({
				organizationId: orgId, connectionId, actor: agent,
				operation: { ...operation, kind: "read", annotations: { destructiveHint } },
			})).effect).toBe("auto");
		}
		expect((await decide()).effect).toBe("deny");
	});

	it("exact operation beats category, which beats all operations within one target", async () => {
		await save({
			connectorKey: operation.connector_key,
			effects: { execute: "deny" },
		});
		await save({
			connectorKey: operation.connector_key,
			operationCategory: "write",
			effects: { execute: "approval" },
		});
		expect((await decide()).effect).toBe("approval");
		await save({
			connectorKey: operation.connector_key,
			operationKey: qualifiedOperationKey(
				operation.connector_key,
				operation.operation_key,
			),
			effects: { execute: "auto" },
		});
		expect((await decide()).effect).toBe("auto");
	});

	it("overlapping categories choose the stricter effect, without inferring missing metadata", async () => {
		await save({ operationCategory: "write", effects: { execute: "auto" } });
		await save({
			operationCategory: "destructive",
			effects: { execute: "deny" },
		});
		const rule = await save({
			operationCategory: "unknown",
			effects: { execute: "approval" },
		});
		expect(await decide()).toEqual({
			effect: "approval",
			ruleIds: [rule.id],
			reason: "matched_rule",
		});
		for (const destructiveHint of [false, true]) {
			const result = await resolveConnectorPolicy({
				organizationId: orgId,
				connectionId,
				actor: agent,
				operation: { ...operation, annotations: { destructiveHint } },
			});
			expect(result.effect).toBe(destructiveHint ? "deny" : "auto");
		}
	});

	it("agent restrictions cannot loosen org policy and still bind their Automation", async () => {
		await save({
			principalKind: "agent",
			principalId: agent.id,
			effects: { execute: "auto" },
		});
		expect((await decide(agent)).effect).toBe("approval");
		await save({ effects: { execute: "auto" } });
		await save({
			principalKind: "agent",
			principalId: agent.id,
			effects: { execute: "deny" },
		});
		expect((await decide(agent)).effect).toBe("deny");
		expect(
			(
				await decide({
					kind: "automation",
					id: "automation:123",
					ownerAgentId: agent.id,
					ownerResolved: true,
				})
			).effect,
		).toBe("deny");
		expect((await decide()).effect).toBe("auto");
		expect(await decide({ ...agent, ownerResolved: false })).toEqual({
			effect: "deny",
			ruleIds: [],
			reason: "unresolved_principal",
		});
	});

	it("scopes never cross tenants, including direct database writes", async () => {
		const other = await createTestOrganization();
		await upsertEntityApprovalPolicy(other.id, {
			resourceClass: "connector_action",
			effects: { execute: "auto" },
		});
		expect((await decide()).effect).toBe("approval");
		await expect(
			upsertEntityApprovalPolicy(other.id, {
				resourceClass: "connector_action",
				connectionId,
				effects: { execute: "auto" },
			}),
		).rejects.toMatchObject({ code: "23503" });
	});

	it("concurrent saves preserve one identity and keep approval delivery separate from target connection", async () => {
		const input = {
			connectionId,
			operationCategory: "write" as const,
			effects: { execute: "approval" as const },
			approvalConnectionId: "test-approval-destination",
		};
		const results = await Promise.all(
			Array.from({ length: 5 }, () => save(input)),
		);
		expect(new Set(results.map((row) => row.id)).size).toBe(1);
		const updated = await save({
			connectionId,
			operationCategory: "write",
			effects: { execute: "auto" },
			preserveDelivery: true,
		});
		expect(updated.deliveryTarget.connectionId).toBe(
			"test-approval-destination",
		);
		expect(updated.connectionId).toBe(connectionId);
	});

	it("stores org, connector and connection category rules as distinct rows", async () => {
		const base = {
			resourceClass: "connector_action" as const,
			effects: { execute: "approval" as const },
		};
		await upsertEntityApprovalPolicy(orgId, base);
		await upsertEntityApprovalPolicy(orgId, {
			...base,
			connectorKey: "policy-fixture",
			operationCategory: "destructive",
		});
		await upsertEntityApprovalPolicy(orgId, {
			...base,
			connectionId,
			operationCategory: "destructive",
		});
		const rows = await listEntityApprovalPolicies(orgId, "connector_action");
		expect(rows).toHaveLength(3);
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					connectorKey: "policy-fixture",
					connectionId: null,
					operationCategory: "destructive",
				}),
				expect.objectContaining({
					connectorKey: null,
					connectionId,
					operationCategory: "destructive",
				}),
			]),
		);
	});

	it("deleting a connection category rule preserves broader rules", async () => {
		const base = {
			resourceClass: "connector_action" as const,
			effects: { execute: "approval" as const },
		};
		const org = await upsertEntityApprovalPolicy(orgId, base);
		await upsertEntityApprovalPolicy(orgId, {
			...base,
			connectionId,
			operationCategory: "read",
		});
		expect(
			await deleteEntityApprovalPolicy({
				organizationId: orgId,
				resourceClass: "connector_action",
				connectionId,
				operationCategory: "read",
			}),
		).toBe(true);
		expect(
			(await listEntityApprovalPolicies(orgId, "connector_action")).map(
				(row) => row.id,
			),
		).toEqual([org.id]);
	});
});
