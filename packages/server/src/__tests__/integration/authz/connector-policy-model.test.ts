import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	type ActingPrincipal,
	type EntityApprovalPolicyInput,
	deleteEntityApprovalPolicy,
	listEntityApprovalPolicies,
	resolveConnectorPolicy,
	upsertEntityApprovalPolicy,
} from "../../../authz/entity-policy";
import { connectorPolicyNoteSuffix, evaluateConnectorPolicy, explainConnectorPolicy } from "../../../authz/connector-policy";
import { qualifiedOperationKey } from "../../../tools/admin/manage_operations/handlers/shared";
import type { DbClient } from "../../../db/client";
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

	it("new orgs receive a visible Reads Auto rule, and deleting it falls back to the Auto default without reseeding", async () => {
		const freshOrg = await createTestOrganization();
		const policies = await listEntityApprovalPolicies(freshOrg.id, "connector_action");
		const readRule = policies.find((policy) => policy.operationCategory === "read");
		expect(readRule).toMatchObject({ principalKind: null, connectionId: null, connectorKey: null, effects: { execute: "auto" } });
		const inspect = () => resolveConnectorPolicy({ organizationId: freshOrg.id, connectionId: null, operation: { ...operation, kind: "read" }, actor: human });
		expect(await inspect()).toMatchObject({ effect: "auto", ruleIds: [readRule!.id], reason: "matched_rule" });
		expect(await deleteEntityApprovalPolicy({ organizationId: freshOrg.id, resourceClass: "connector_action", operationCategory: "read" })).toBe(true);
		for (let i = 0; i < 2; i++) expect(await inspect()).toEqual({ effect: "auto", ruleIds: [], rules: [], reason: "default_auto" });
		expect(await listEntityApprovalPolicies(freshOrg.id, "connector_action")).toEqual([]);
	});

	it("defaults to Auto for humans and agents, reads and writes, until a rule asks", async () => {
		expect(await decide()).toEqual({
			effect: "auto",
			ruleIds: [],
			rules: [],
			reason: "default_auto",
		});
		expect((await decide(agent)).effect).toBe("auto");
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
		).toBe("auto");
		await save({ operationCategory: "write", effects: { execute: "approval" } });
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
		expect(await decide(agent)).toMatchObject({ effect: "approval", reason: "matched_rule" });
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
			rules: [{ id: rule.id, kind: "grant" }],
			reason: "matched_rule",
		});
		expect(
			await decide(agent, { ...operation, connector_key: "other-fixture" }),
		).toMatchObject({ effect: "auto", ruleIds: [], reason: "default_auto" });
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
			rules: [{ id: rule.id, kind: "grant" }],
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
		await save({ effects: { execute: "approval" } });
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
			rules: [],
			reason: "unresolved_principal",
		});
	});

	it("guardrails apply after the narrowest grant, only tighten, and fail closed", async () => {
		const exact = await save({
			operationKey: qualifiedOperationKey(operation.connector_key, operation.operation_key),
			note: "Safe to run unattended",
			effects: { execute: "auto" },
		});
		// A device owner's hold over an Auto grant is not explained by that grant's note.
		const allowed = await decide();
		expect(allowed).toMatchObject({ effect: "auto", rules: [{ id: exact.id, note: "Safe to run unattended" }] });
		const asked = { kind: "user", id: null, label: null } as const;
		expect(explainConnectorPolicy(allowed, asked, true)).toMatchObject({ reason: "device_owner", principal: asked });
		expect(connectorPolicyNoteSuffix(explainConnectorPolicy(allowed, asked, true))).toBe("");
		// A grant and a guardrail can share one scope.
		const hold = await save({ connectorKey: operation.connector_key, kind: "guardrail", note: "Review fixture writes", effects: { execute: "approval" } });
		const sameScopeGrant = await save({ connectorKey: operation.connector_key, effects: { execute: "auto" } });
		expect(sameScopeGrant.id).not.toBe(hold.id);
		expect(await decide()).toEqual({
			effect: "approval",
			ruleIds: [hold.id],
			rules: [{ id: hold.id, kind: "guardrail", note: "Review fixture writes" }],
			reason: "guardrail",
		});
		// A guardrail's Ask never loosens a grant's Block.
		const block = await save({ connectionId, effects: { execute: "deny" } });
		expect(await decide()).toMatchObject({ effect: "deny", ruleIds: [block.id], reason: "matched_rule" });
		await deleteEntityApprovalPolicy({ organizationId: orgId, resourceClass: "connector_action", connectionId });

		// A principal guardrail binds that agent and its Automations only.
		await save({ principalKind: "agent", principalId: agent.id, kind: "guardrail", effects: { execute: "deny" } });
		expect((await decide(agent)).effect).toBe("deny");
		expect((await decide({ kind: "automation", id: "automation:123", ownerAgentId: agent.id, ownerResolved: true })).effect).toBe("deny");
		expect((await decide()).effect).toBe("approval");
		// A person in the web app is never held or blocked by a rule; an agent
		// carrying the same flag still is.
		expect(await resolveConnectorPolicy({ organizationId: orgId, connectionId, operation, actor: human, person: true }))
			.toEqual({ effect: "auto", ruleIds: [], rules: [], reason: "default_auto" });
		expect((await resolveConnectorPolicy({ organizationId: orgId, connectionId, operation, actor: agent, person: true })).effect).toBe("deny");

		// Writes reject a guardrail that would allow, or one outside connector actions.
		await expect(save({ kind: "guardrail", effects: { execute: "auto" } })).rejects.toThrow(/only log, check, require approval or block/);
		await expect(upsertEntityApprovalPolicy(orgId, { resourceClass: "entity", kind: "guardrail", entityTypeSlug: "x", createMode: "deny" }))
			.rejects.toThrow(/Only connector action rules/);
		// A stored Auto on a guardrail (only reachable by a direct write) reads as Block.
		await getTestDb()`UPDATE write_policy_action_effects SET effect = 'auto' WHERE policy_id = ${hold.id}`;
		expect(await decide()).toMatchObject({ effect: "deny", reason: "guardrail", rules: [{ id: hold.id, kind: "guardrail" }] });
		expect(await deleteEntityApprovalPolicy({ organizationId: orgId, resourceClass: "connector_action", connectorKey: operation.connector_key, kind: "guardrail" })).toBe(true);
		expect(await decide()).toMatchObject({ effect: "auto", ruleIds: [exact.id], reason: "matched_rule" });
	});

	it("Log runs unattended, Check falls back to Ask for actors that cannot confirm, and both are guardrail-only", async () => {
		const log = await save({ connectionId, kind: "guardrail", note: "Record fixture writes", effects: { execute: "log" } });
		expect(await decide()).toMatchObject({ effect: "log", reason: "guardrail", rules: [{ id: log.id, kind: "guardrail" }] });
		expect((await decide(agent)).effect).toBe("log");

		const check = await save({ connectorKey: operation.connector_key, kind: "guardrail", note: "Only to people in the thread", effects: { execute: "check" } });
		// The stricter guardrail explains the result; Log no longer does.
		expect(await decide(agent)).toMatchObject({ effect: "check", rules: [{ id: check.id, note: "Only to people in the thread" }] });
		expect((await decide({ kind: "app", id: "app:fixture", ownerAgentId: null, ownerResolved: true })).effect).toBe("check");
		expect((await decide({ kind: "automation", id: "automation:1", ownerAgentId: agent.id, ownerResolved: true })).effect).toBe("check");
		// Nobody can confirm for a person or a code-only Automation, so a person is asked.
		expect(await decide()).toMatchObject({ effect: "approval", rules: [{ id: check.id }] });
		expect((await decide({ kind: "automation", id: "automation:2", ownerAgentId: null, ownerResolved: true })).effect).toBe("approval");

		// An Ask guardrail outranks Check; Check never releases an Ask.
		const ask = await save({ operationKey: qualifiedOperationKey(operation.connector_key, operation.operation_key), kind: "guardrail", effects: { execute: "approval" } });
		expect(await decide(agent)).toMatchObject({ effect: "approval", ruleIds: [ask.id] });

		await expect(save({ connectionId, effects: { execute: "log" } })).rejects.toThrow(/guardrail modes/);
		await expect(save({ connectionId, effects: { execute: "check" } })).rejects.toThrow(/guardrail modes/);
	});

	it("a caller's own exact Auto rule lifts Ask first for that caller only, never Block, Check or Log", async () => {
		const operationKey = qualifiedOperationKey(operation.connector_key, operation.operation_key);
		const app: ActingPrincipal = { kind: "app", id: "pat:fixture", ownerAgentId: null, ownerResolved: true };
		const otherApp: ActingPrincipal = { ...app, id: "pat:other" };
		const otherAgent: ActingPrincipal = { ...agent, id: "other-agent" };
		const ownedAutomation: ActingPrincipal = { kind: "automation", id: "automation:7", ownerAgentId: agent.id, ownerResolved: true };
		const codeAutomation: ActingPrincipal = { kind: "automation", id: "automation:8", ownerAgentId: null, ownerResolved: true };
		const askAll = await save({ effects: { execute: "approval" } });
		const askHere = await save({ connectionId, operationKey, kind: "guardrail", effects: { execute: "approval" } });
		// A broader rule for this agent, or an exact rule for every agent, lifts nothing.
		await save({ principalKind: "agent", principalId: agent.id, connectionId, effects: { execute: "auto" } });
		await save({ principalKind: "agent", connectionId, operationKey, effects: { execute: "auto" } });
		expect((await decide(agent)).effect).toBe("approval");

		const agentAllow = await save({ principalKind: "agent", principalId: agent.id, connectionId, operationKey, effects: { execute: "auto" } });
		const appAllow = await save({ principalKind: "app", principalId: app.id, connectionId, operationKey, effects: { execute: "auto" } });
		const automationAllow = await save({ principalKind: "automation", principalId: codeAutomation.id, connectionId, operationKey, effects: { execute: "auto" } });
		for (const [caller, allow] of [[agent, agentAllow], [ownedAutomation, agentAllow], [app, appAllow], [codeAutomation, automationAllow]] as const) {
			const result = await decide(caller);
			expect(result.effect, caller.id!).toBe("auto");
			expect(result.ruleIds, caller.id!).toContain(allow.id);
			expect(result.ruleIds, caller.id!).not.toContain(askAll.id);
			expect(result.ruleIds, caller.id!).not.toContain(askHere.id);
		}
		for (const caller of [otherAgent, otherApp, human]) {
			expect(await decide(caller), String(caller.id)).toMatchObject({ effect: "approval", ruleIds: [askAll.id, askHere.id] });
		}
		// "Ask next time" on an Automation outranks its agent's Always allow,
		// which still lifts the workspace Asks for the agent and the Automation.
		const askOwned = await save({ principalKind: "automation", principalId: ownedAutomation.id, connectionId, operationKey, kind: "guardrail", effects: { execute: "approval" } });
		expect(await decide(ownedAutomation)).toMatchObject({ effect: "approval", ruleIds: [askOwned.id] });
		expect((await decide(agent)).effect).toBe("auto");
		await save({ principalKind: "automation", principalId: ownedAutomation.id, connectionId, operationKey, effects: { execute: "auto" } });
		expect((await decide(ownedAutomation)).effect).toBe("auto");

		const log = await save({ connectionId, kind: "guardrail", effects: { execute: "log" } });
		expect(await decide(app)).toMatchObject({ effect: "log", ruleIds: [log.id], reason: "guardrail" });
		// Only a caller that can confirm a Check gets one; the rest are still asked.
		const check = await save({ connectorKey: operation.connector_key, kind: "guardrail", effects: { execute: "check" } });
		expect(await decide(app)).toMatchObject({ effect: "check", ruleIds: [check.id] });
		expect(await decide(codeAutomation)).toMatchObject({ effect: "approval", ruleIds: [check.id] });
		const block = await save({ principalKind: "app", principalId: app.id, kind: "guardrail", effects: { execute: "deny" } });
		expect(await decide(app)).toMatchObject({ effect: "deny", ruleIds: [block.id] });
	});

	it("an audience guardrail applies only where the destination is at least that wide, and unknown counts as external", async () => {
		const workspace = await save({ connectorKey: operation.connector_key, kind: "guardrail", audience: "workspace", note: "Ask before posting where the workspace sees it", effects: { execute: "approval" } });
		const external = await save({ connectorKey: operation.connector_key, kind: "guardrail", audience: "external", effects: { execute: "deny" } });
		const unscoped = await save({ connectorKey: operation.connector_key, kind: "guardrail", effects: { execute: "log" } });
		// Audience is part of the identity: three guardrails on one scope, and a re-save updates in place.
		expect(new Set([workspace.id, external.id, unscoped.id]).size).toBe(3);
		expect((await save({ connectorKey: operation.connector_key, kind: "guardrail", audience: "workspace", effects: { execute: "check" } })).id).toBe(workspace.id);
		await save({ connectorKey: operation.connector_key, kind: "guardrail", audience: "workspace", effects: { execute: "approval" } });
		const listed = await listEntityApprovalPolicies(orgId, "connector_action");
		expect(listed.find((policy) => policy.id === workspace.id)).toMatchObject({ audience: "workspace", kind: "guardrail" });
		expect(listed.find((policy) => policy.id === unscoped.id)).toMatchObject({ audience: null });

		const policies = listed;
		const evaluate = (destinationAudience?: "private" | "workspace" | "external" | "unknown", actor = agent, person?: boolean) =>
			evaluateConnectorPolicy({ organizationId: orgId, connectionId, operation, actor, policies, person, destinationAudience });
		// A destination the connector cannot classify never matches an audience rule.
		expect(evaluate(undefined)).toMatchObject({ effect: "log", ruleIds: [unscoped.id] });
		expect(evaluate("private")).toMatchObject({ effect: "log", ruleIds: [unscoped.id] });
		expect(evaluate("workspace")).toMatchObject({ effect: "approval", ruleIds: [workspace.id], rules: [{ id: workspace.id, note: "Ask before posting where the workspace sees it" }] });
		expect(evaluate("external")).toMatchObject({ effect: "deny", ruleIds: [external.id] });
		expect(evaluate("unknown")).toMatchObject({ effect: "deny", ruleIds: [external.id] });
		// A person in the web app is never matched, whatever the audience.
		expect(evaluate("external", human, true)).toEqual({ effect: "auto", ruleIds: [], rules: [], reason: "default_auto" });
		// This fixture connector has no audience source, so the live decision never matches either audience rule.
		expect(await resolveConnectorPolicy({ organizationId: orgId, connectionId, operation, actor: agent, input: { channel: "C1" }, destination: { live: true, seen: [] } }))
			.toMatchObject({ effect: "log", ruleIds: [unscoped.id] });

		// Only a guardrail narrows by audience, in the writer and in the database.
		await expect(save({ connectorKey: operation.connector_key, audience: "workspace", effects: { execute: "approval" } })).rejects.toThrow("audience is only valid on a guardrail.");
		await expect(getTestDb()`UPDATE write_approval_policies SET kind = 'grant' WHERE id = ${workspace.id}`).rejects.toMatchObject({ code: "23514" });
		await expect(getTestDb()`UPDATE write_approval_policies SET audience = 'everyone' WHERE id = ${workspace.id}`).rejects.toMatchObject({ code: "23514" });
		// Deleting one audience's guardrail keeps the others on the same scope.
		expect(await deleteEntityApprovalPolicy({ organizationId: orgId, resourceClass: "connector_action", connectorKey: operation.connector_key, kind: "guardrail", audience: "external" })).toBe(true);
		expect((await listEntityApprovalPolicies(orgId, "connector_action")).map((policy) => policy.id).sort()).toEqual([workspace.id, unscoped.id].sort());
	});

	it("a conditional rule applies only where its when holds, and an undecidable one takes the asked side", async () => {
		const qualified = qualifiedOperationKey(operation.connector_key, operation.operation_key);
		const ask = await save({ connectorKey: operation.connector_key, effects: { execute: "approval" } });
		const internal = [{ field: "/to", op: "ends_with", value: "@acme.example" }];
		const narrow = await save({ connectionId, operationKey: qualified, condition: internal, effects: { execute: "auto" } });
		const secrets = await save({ connectorKey: operation.connector_key, kind: "guardrail", condition: [{ scan: "secrets", field: "/body" }], effects: { execute: "deny" } });
		// The same scope without the condition is a different rule.
		const plain = await save({ connectionId, operationKey: qualified, effects: { execute: "approval" } });
		expect(new Set([narrow.id, plain.id]).size).toBe(2);
		expect((await save({ connectionId, operationKey: qualified, condition: internal, effects: { execute: "auto" } })).id).toBe(narrow.id);
		await deleteEntityApprovalPolicy({ organizationId: orgId, resourceClass: "connector_action", connectionId, operationKey: qualified });
		expect((await listEntityApprovalPolicies(orgId, "connector_action")).map((policy) => policy.id).sort()).toEqual([ask.id, narrow.id, secrets.id].sort());

		const policies = await listEntityApprovalPolicies(orgId, "connector_action");
		const evaluate = (input?: Record<string, unknown> | null, unknownConditions?: "strict" | "lenient", rules = policies) =>
			evaluateConnectorPolicy({ organizationId: orgId, connectionId, operation, actor: agent, policies: rules, input, unknownConditions });
		// Discovery: a conditional Auto neither grants nor shadows the broader Ask, and a conditional Block counts.
		expect(evaluate()).toMatchObject({ effect: "deny", ruleIds: [secrets.id] });
		expect(evaluate(undefined, "lenient")).toMatchObject({ effect: "auto", ruleIds: [narrow.id] });
		// At execution each condition is decided on the input.
		expect(evaluate({ to: "teammate@acme.example", body: "hello" })).toMatchObject({ effect: "auto", ruleIds: [narrow.id] });
		expect(evaluate({ to: "someone@outside.example", body: "hello" })).toMatchObject({ effect: "approval", ruleIds: [ask.id] });
		expect(evaluate(null)).toMatchObject({ effect: "approval", ruleIds: [ask.id] });
		expect(evaluate({ to: "teammate@acme.example", body: { nested: `ghp_${"c".repeat(36)}` } }))
			.toMatchObject({ effect: "deny", ruleIds: [secrets.id], rules: [{ id: secrets.id, when: [{ scan: "secrets", field: "/body" }] }] });
		// A stored condition this runtime cannot read is undecidable, whatever the input.
		const unreadable = policies.map((policy) => policy.id === narrow.id ? { ...policy, condition: [{ field: "/to", op: "starts_with", value: "a" }] } : policy);
		expect(evaluate({ to: "teammate@acme.example", body: "hello" }, "strict", unreadable)).toMatchObject({ effect: "approval", ruleIds: [ask.id] });
		// The writer and the database refuse a malformed condition.
		await expect(save({ connectionId, condition: [], effects: { execute: "deny" }, kind: "guardrail" })).rejects.toThrow("when must list 1-8 conditions.");
		await expect(upsertEntityApprovalPolicy(orgId, { resourceClass: "entity", entityTypeSlug: "x", createMode: "deny", condition: internal }))
			.rejects.toThrow("when is only valid on a connector action rule.");
		await expect(getTestDb()`UPDATE write_approval_policies SET condition = '{}'::jsonb WHERE id = ${narrow.id}`).rejects.toMatchObject({ code: "23514" });
	});

	it("an allowed actions list binds a caller's writes only and is named as the reason", async () => {
		const policies = await listEntityApprovalPolicies(orgId, "connector_action");
		const evaluate = (op: typeof operation | { connector_key: string; operation_key: string; kind: "read" }, allowlists: Parameters<typeof evaluateConnectorPolicy>[0]["allowlists"]) =>
			evaluateConnectorPolicy({ organizationId: orgId, connectionId, operation: op, actor: agent, policies, allowlists });
		expect(evaluate(operation, [[]])).toEqual({ effect: "deny", ruleIds: [], rules: [], reason: "allowlist" });
		expect(evaluate({ ...operation, operation_key: "read", kind: "read" }, [[]]).effect).toBe("auto");
		const listed = { action: "connector.execute", connection_id: connectionId, operation_key: operation.operation_key, effect: "approval" } as const;
		expect(evaluate(operation, [[listed]])).toEqual({ effect: "approval", ruleIds: [], rules: [], reason: "allowlist" });
	});

	it("scopes never cross tenants, including direct database writes", async () => {
		const other = await createTestOrganization();
		await upsertEntityApprovalPolicy(other.id, {
			resourceClass: "connector_action",
			effects: { execute: "deny" },
		});
		expect(await decide()).toMatchObject({ effect: "auto", reason: "default_auto" });
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

	it("a writer that omits a newer scope column only addresses rules that leave it unset", async () => {
		// The next release adds a nullable scope column and keys on it; this code omits it.
		const scope = {
			resourceClass: "connector_action" as const,
			connectionId,
			operationKey: qualifiedOperationKey(operation.connector_key, operation.operation_key),
			kind: "guardrail" as const,
		};
		const rollback = new Error("rollback");
		const run = getTestDb().begin(async (sql) => {
			const tx = sql as unknown as DbClient;
			await sql.unsafe(`
				ALTER TABLE write_approval_policies ADD COLUMN variant text;
				ALTER FUNCTION write_approval_policy_scope_key(write_approval_policies) RENAME TO released_scope_key;
				CREATE FUNCTION write_approval_policy_scope_key(p write_approval_policies) RETURNS text LANGUAGE sql STABLE
				AS $$ SELECT CASE WHEN p.variant IS NULL THEN released_scope_key(p) ELSE md5(released_scope_key(p) || p.variant) END $$`);
			const base = await upsertEntityApprovalPolicy(orgId, { ...scope, effects: { execute: "deny" } }, tx);
			const [variant] = await sql`
				INSERT INTO write_approval_policies (organization_id, resource_class, connection_id, operation_key, kind, note, variant)
				SELECT organization_id, resource_class, connection_id, operation_key, kind, 'variant', 'v'
				FROM write_approval_policies WHERE id = ${base.id} RETURNING id`;
			await sql`INSERT INTO write_policy_action_effects (policy_id, action, effect) VALUES (${variant.id}, 'execute', 'log')`;
			const rows = async () => (await listEntityApprovalPolicies(orgId, "connector_action", tx))
				.filter((row) => row.operationKey === scope.operationKey)
				.map((row) => ({ id: row.id, note: row.note, execute: row.effects.execute }));

			await upsertEntityApprovalPolicy(orgId, { ...scope, note: "edited", effects: { execute: "approval" } }, tx);
			expect(await rows()).toEqual([
				{ id: base.id, note: "edited", execute: "approval" },
				{ id: Number(variant.id), note: "variant", execute: "log" },
			]);
			expect(await deleteEntityApprovalPolicy({ organizationId: orgId, ...scope }, tx)).toBe(true);
			expect(await rows()).toEqual([{ id: Number(variant.id), note: "variant", execute: "log" }]);
			throw rollback;
		});
		await expect(run).rejects.toBe(rollback);
	});
});
