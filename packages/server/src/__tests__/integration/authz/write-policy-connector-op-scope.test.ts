/** Real-PG connector scopes use the same evaluator as execution and discovery. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateConnectorPolicy } from "../../../authz/connector-policy";
import {
	listEntityApprovalPolicies,
	resolveConnectorPolicy,
	upsertEntityApprovalPolicy,
} from "../../../authz/entity-policy";
import type { DbClient } from "../../../db/client";
import { qualifiedOperationKey } from "../../../tools/admin/manage_operations/handlers/shared";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestOrganization } from "../../setup/test-fixtures";

const actor = { kind: "agent", id: "op-agent", ownerAgentId: null, ownerResolved: true } as const;
const operation = (connector_key: string, operation_key: string) => ({
	connector_key,
	operation_key,
	kind: "write" as const,
});
const execFor = async (organizationId: string, connectorKey: string, operationKey: string) =>
	(await resolveConnectorPolicy({
		organizationId,
		connectionId: null,
		operation: operation(connectorKey, operationKey),
		actor,
	})).effect;

describe("connector_action per-operation scope", () => {
	afterAll(cleanupTestDatabase);
	let orgId: string;
	beforeEach(async () => {
		orgId = (await createTestOrganization()).id;
		await createTestAgent({ organizationId: orgId, agentId: actor.id });
	});

	it("an exact operation rule tightens only that operation", async () => {
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", effects: { execute: "auto" },
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			operationKey: qualifiedOperationKey("demo.first", "send"),
			effects: { execute: "approval" },
		});
		expect(await execFor(orgId, "demo.first", "send")).toBe("approval");
		expect(await execFor(orgId, "demo.first", "inspect")).toBe("auto");
	});

	it("agent restrictions cannot be loosened by a more specific agent Auto rule", async () => {
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", effects: { execute: "auto" },
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", principalKind: "agent", principalId: actor.id,
			effects: { execute: "deny" },
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", principalKind: "agent", principalId: actor.id,
			operationKey: qualifiedOperationKey("demo.first", "send"), effects: { execute: "auto" },
		});
		expect(await execFor(orgId, "demo.first", "send")).toBe("deny");
	});

	it("unmatched writes default to Ask", async () => {
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			operationKey: qualifiedOperationKey("demo.first", "send"), effects: { execute: "auto" },
		});
		expect(await execFor(orgId, "demo.first", "inspect")).toBe("approval");
		expect(await execFor(orgId, "demo.first", "send")).toBe("auto");
	});

	it("an exact org Auto overrides the broader org Block for that operation", async () => {
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", effects: { execute: "deny" },
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			operationKey: qualifiedOperationKey("demo.first", "send"), effects: { execute: "auto" },
		});
		expect(await execFor(orgId, "demo.first", "send")).toBe("auto");
		expect(await execFor(orgId, "demo.first", "inspect")).toBe("deny");
	});

	it("connector-qualified operation keys do not alias across connectors", async () => {
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", effects: { execute: "auto" },
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", principalKind: "agent", principalId: actor.id,
			operationKey: qualifiedOperationKey("demo.first", "send"), effects: { execute: "deny" },
		});
		expect(await execFor(orgId, "demo.first", "send")).toBe("deny");
		expect(await execFor(orgId, "demo.second", "send")).toBe("auto");
	});

	it("loads one bounded policy set for batch discovery decisions", async () => {
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", effects: { execute: "auto" },
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", principalKind: "agent", principalId: actor.id,
			operationKey: qualifiedOperationKey("demo.first", "send"), effects: { execute: "deny" },
		});
		let queryCount = 0;
		const counting = new Proxy(getTestDb(), {
			apply(target, thisArg, args) {
				queryCount += 1;
				return Reflect.apply(target, thisArg, args);
			},
		}) as DbClient;
		const policies = await listEntityApprovalPolicies(orgId, "connector_action", counting);
		const effects = [operation("demo.first", "send"), operation("demo.first", "inspect"), operation("demo.second", "send")]
			.map((operation) => evaluateConnectorPolicy({ organizationId: orgId, connectionId: null, operation, actor, policies }).effect);
		expect(queryCount).toBe(1);
		expect(effects).toEqual(["deny", "auto", "auto"]);
	});
});
