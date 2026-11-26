import { serve } from "@hono/node-server";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileInputSchema } from "@lobu/connector-sdk";
import { __resetEncryptionKeyCacheForTests } from "@lobu/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getOperationForConnection } from "../../../operations/connector-operations";
import { resolveRunConnectorPolicy } from "../../../authz/operation-run-policy";
import type { PolicyClassifyLookup, PolicyClassifyResult } from "../../../authz/policy-classify";
import { predictClassifier, resetPredictClassifierForTests } from "../../../gateway/inference/predict-classifier";
import { ArtifactStore } from "../../../gateway/files/artifact-store";
import { ingestInputFiles } from "../../../gateway/files/input-files";
import * as gateway from "../../../lobu/gateway";
import { flushPendingGuardrailAudits } from "../../../gateway/guardrails/audit";
import { evaluatePreToolGuardrails } from "../../../gateway/guardrails/pre-tool";
import { hasOutputGuardrails, runOutputGuardrailScan } from "../../../gateway/guardrails/output-scan";
import { createInferenceProvider } from "../../../lobu/stores/provider-secrets";
import * as dbClient from "../../../db/client";
import { app, type Env } from "../../../index";
import { initWorkspaceProvider } from "../../../workspace";
import { listEntityApprovalPolicies, resolveActingPrincipal, resolveConnectorPolicy, upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import { mcpRequest, mcpToolsCall, postForm } from "../../setup/test-helpers";
import { TestApiClient } from "../../setup/test-mcp-client";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { addUserToOrganization, createTestAccessToken, createTestAgent, createTestConnection, createTestConnectorDefinition, createTestEntity, createTestOAuthClient, createTestOrganization, createTestPAT, createTestSession, createTestUser } from "../../setup/test-fixtures";

const env = { ENVIRONMENT: "test", DATABASE_URL: process.env.DATABASE_URL, BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only", RATE_LIMIT_ENABLED: "false" } as Env;
let org: Awaited<ReturnType<typeof createTestOrganization>>;
let owner: Awaited<ReturnType<typeof createTestUser>>;
let cookie: string;
let server: Server;
let baseUrl: string;
const path = () => `/api/${org.slug}/write-permissions/connector-actions`;
function request(method: string, route: string, body?: unknown, token?: string) {
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: baseUrl, ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
// Rule ids are stored identity; scope assertions compare the rest.
const withoutIds = (rules: Array<Record<string, unknown>>) => rules.map(({ id: _id, ...rule }) => rule);
async function snapshot(token?: string) {
  const response = await request("GET", path(), undefined, token);
  expect(response.status).toBe(200);
  return response.json();
}
beforeAll(async () => {
  await initWorkspaceProvider();
  await new Promise<void>(resolve => {
    server = serve({ fetch: request => app.fetch(request, env), port: 0, hostname: "127.0.0.1" }, address => {
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    }) as Server;
  });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await cleanupTestDatabase();
});
beforeEach(async () => {
  org = await createTestOrganization();
  owner = await createTestUser();
  await addUserToOrganization(owner.id, org.id, "owner");
  cookie = (await createTestSession(owner.id)).cookieHeader;
});

describe("connector policy collection", () => {
  it("replaces only org connector rules, keeps delivery and IDs, and is idempotent", async () => {
    await createTestAgent({ organizationId: org.id, agentId: "policy-owner-fixture" });
    await upsertEntityApprovalPolicy(org.id, { resourceClass: "entity", effects: { update: "approval" } });
    await upsertEntityApprovalPolicy(org.id, { resourceClass: "connector_action", principalKind: "agent", principalId: "policy-owner-fixture", effects: { execute: "deny" } });
    await upsertEntityApprovalPolicy(org.id, { resourceClass: "connector_action", operationCategory: "read", effects: { execute: "auto" }, approvalChannelId: "synthetic-channel" });
    const before = await snapshot();
    expect(withoutIds(before.rules)).toEqual([{ operation_category: "read", effect: "auto" }]);
    const input = { revision: before.revision, rules: [{ effect: "approval" }, { operation_category: "read", effect: "auto" }] };
    const saved = await request("PUT", path(), input);
    expect(saved.status).toBe(200);
    const after = await saved.json();
    expect(after.rules).toHaveLength(2);
    expect(after.revision).not.toBe(before.revision);
    const rows = await listEntityApprovalPolicies(org.id);
    const read = rows.find(p => p.principalKind === null && p.resourceClass === "connector_action" && p.operationCategory === "read");
    expect(read?.deliveryTarget.channelId).toBe("synthetic-channel");
    expect(rows.some(p => p.principalId === "policy-owner-fixture" && p.effects.execute === "deny")).toBe(true);
    const repeated = await request("PUT", path(), { revision: after.revision, rules: [...after.rules].reverse() });
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).revision).toBe(after.revision);
    expect((await listEntityApprovalPolicies(org.id)).find(p => p.id === read?.id)).toBeDefined();
    expect((await request("PUT", path(), { revision: after.revision, rules: [] })).status).toBe(200);
    const remaining = await listEntityApprovalPolicies(org.id);
    expect(remaining.some(p => p.resourceClass === "entity")).toBe(true);
    expect(remaining.some(p => p.principalId === "policy-owner-fixture")).toBe(true);
    expect((await snapshot()).rules).toEqual([]);
  });

  it("manages guardrails beside grants on one scope, with notes, and rejects an auto guardrail", async () => {
    const note = "Never send credentials through a connector";
    const before = await snapshot();
    const created = await request("PUT", path(), { revision: before.revision, rules: [{ effect: "auto" }, { effect: "deny", kind: "guardrail", note: `  ${note}  ` }] });
    expect(created.status).toBe(200);
    const saved = await created.json();
    const grant = saved.rules.find((rule: { kind?: string }) => rule.kind === undefined);
    const guardrail = saved.rules.find((rule: { kind?: string }) => rule.kind === "guardrail");
    expect(grant).toEqual({ id: expect.any(Number), effect: "auto" });
    expect(guardrail).toEqual({ id: expect.any(Number), effect: "deny", kind: "guardrail", note });
    expect(await snapshot()).toEqual(saved);
    const stored = (await listEntityApprovalPolicies(org.id, "connector_action")).find(p => p.id === guardrail.id);
    expect(stored).toMatchObject({ kind: "guardrail", note, effects: { execute: "deny" } });

    // Echoing the collection, ids included, is a no-op that keeps both rows.
    const echoed = await request("PUT", path(), { revision: saved.revision, rules: [...saved.rules].reverse() });
    expect(echoed.status).toBe(200);
    expect(await echoed.json()).toEqual(saved);

    for (const rules of [
      [grant, { effect: "auto", kind: "guardrail" }],
      [grant, { ...guardrail, effect: "auto" }],
      [grant, { ...guardrail, kind: "invented" }],
      [grant, { ...guardrail, note: "x".repeat(281) }],
      [grant, { ...guardrail, note: 7 }],
      [grant, { ...guardrail, id: "forged" }],
    ]) {
      const rejected = await request("PUT", path(), { revision: saved.revision, rules });
      expect(rejected.status).toBe(400);
      expect(await snapshot()).toEqual(saved);
    }
    const autoGuardrail = await request("PUT", path(), { revision: saved.revision, rules: [grant, { ...guardrail, effect: "auto" }] });
    expect(await autoGuardrail.json()).toEqual({ error: "invalid_request", message: "A guardrail can only log, check, require approval or block; use a grant to allow." });

    // Editing the guardrail keeps its row; an omitted note clears it.
    const softened = await request("PUT", path(), { revision: saved.revision, rules: [grant, { effect: "approval", kind: "guardrail" }] });
    expect(softened.status).toBe(200);
    const afterEdit = await softened.json();
    expect(afterEdit.rules).toEqual(expect.arrayContaining([grant, { id: guardrail.id, effect: "approval", kind: "guardrail" }]));

    // Dropping the guardrail leaves the same-scope grant in place.
    const dropped = await request("PUT", path(), { revision: afterEdit.revision, rules: [grant] });
    expect(dropped.status).toBe(200);
    expect((await dropped.json()).rules).toEqual([grant]);
  });

  it("scopes a guardrail by audience beside the unscoped one, and refuses audience on a grant or outside the known values", async () => {
    const before = await snapshot();
    const unscoped = { effect: "log", kind: "guardrail" };
    const workspace = { effect: "approval", kind: "guardrail", audience: "workspace", note: "Ask before posting where the workspace sees it" };
    const created = await request("PUT", path(), { revision: before.revision, rules: [unscoped, workspace] });
    expect(created.status).toBe(200);
    const saved = await created.json();
    expect(withoutIds(saved.rules)).toEqual(expect.arrayContaining([unscoped, workspace]));
    expect(saved.rules).toHaveLength(2);
    const stored = await listEntityApprovalPolicies(org.id, "connector_action");
    expect(stored.find(p => p.audience === "workspace")).toMatchObject({ kind: "guardrail", effects: { execute: "approval" } });
    // Echoing the collection is a no-op; audience is part of each rule's identity.
    const echoed = await request("PUT", path(), { revision: saved.revision, rules: [...saved.rules].reverse() });
    expect(await echoed.json()).toEqual(saved);
    const duplicate = await request("PUT", path(), { revision: saved.revision, rules: [...saved.rules, { effect: "deny", kind: "guardrail", audience: "workspace" }] });
    expect(await duplicate.json()).toEqual({ error: "invalid_request", message: "Duplicate policy scope." });

    const onGrant = await request("PUT", path(), { revision: saved.revision, rules: [{ effect: "approval", audience: "workspace" }] });
    expect(onGrant.status).toBe(400);
    expect(await onGrant.json()).toEqual({ error: "invalid_request", message: "audience is only valid on a guardrail." });
    for (const audience of ["everyone", "private", 3]) {
      const invalid = await request("PUT", path(), { revision: saved.revision, rules: [{ effect: "deny", kind: "guardrail", audience }] });
      expect(invalid.status, String(audience)).toBe(400);
    }
    expect(await snapshot()).toEqual(saved);

    // Widening the audience is a different rule: the workspace one is replaced, the unscoped one stays.
    const widened = await request("PUT", path(), { revision: saved.revision, rules: [saved.rules.find((rule: { audience?: string }) => !rule.audience), { effect: "deny", kind: "guardrail", audience: "external" }] });
    expect(widened.status).toBe(200);
    expect(withoutIds((await widened.json()).rules)).toEqual(expect.arrayContaining([unscoped, { effect: "deny", kind: "guardrail", audience: "external" }]));
    expect((await listEntityApprovalPolicies(org.id, "connector_action")).map(p => p.audience).sort()).toEqual(["external", null]);
  });

  it("stores a rule's when as part of its identity and refuses malformed conditions by field", async () => {
    const before = await snapshot();
    const external = { effect: "approval", kind: "guardrail", note: "Ask before mailing outside", when: [{ field: "/to", op: "not_ends_with", value: "@acme.example" }] };
    const secrets = { effect: "deny", kind: "guardrail", when: [{ scan: "secrets", field: "/body" }, { field: "/draft", op: "exists" }] };
    const unconditional = { effect: "approval", kind: "guardrail", note: "Ask before mailing outside" };
    const created = await request("PUT", path(), { revision: before.revision, rules: [external, secrets, unconditional] });
    expect(created.status, await created.clone().text()).toBe(200);
    const saved = await created.json();
    // Two rules that differ only by `when` are separate rows.
    expect(saved.rules).toHaveLength(3);
    expect(withoutIds(saved.rules)).toEqual(expect.arrayContaining([external, secrets, unconditional]));
    expect(await snapshot()).toEqual(saved);
    const stored = await listEntityApprovalPolicies(org.id, "connector_action");
    expect(stored.map(p => p.condition)).toEqual(expect.arrayContaining([external.when, secrets.when, null]));
    // Echoing is a no-op with stable ids; key order inside a condition does not matter.
    const reordered = saved.rules.map((rule: { when?: Array<Record<string, unknown>> }) =>
      rule.when ? { ...rule, when: rule.when.map(condition => Object.fromEntries(Object.entries(condition).reverse())) } : rule);
    const echoed = await request("PUT", path(), { revision: saved.revision, rules: reordered.reverse() });
    expect(await echoed.json()).toEqual(saved);
    const duplicate = await request("PUT", path(), { revision: saved.revision, rules: [...saved.rules, { ...external, effect: "deny" }] });
    expect(await duplicate.json()).toEqual({ error: "invalid_request", message: "Duplicate policy scope." });

    const condition = (when: unknown) => ({ effect: "deny", kind: "guardrail", when });
    for (const [rule, message] of [
      [condition([{ field: "/to", op: "starts_with", value: "x" }]), "rules[0].when[0].op must be one of eq, neq, in, not_in, contains, ends_with, not_ends_with, exists."],
      [condition([{ field: "to", op: "eq", value: "x" }]), expect.stringMatching(/^rules\[0\]\.when\[0\]\.field must be a JSON pointer/)],
      [condition([{ field: "/a~2b", op: "exists" }]), expect.stringMatching(/^rules\[0\]\.when\[0\]\.field must be a JSON pointer/)],
      [condition(Array.from({ length: 9 }, () => ({ field: "/to", op: "exists" }))), "rules[0].when must list 1-8 conditions."],
      [condition([]), "rules[0].when must list 1-8 conditions."],
      [condition({ field: "/to", op: "exists" }), "rules[0].when must list 1-8 conditions."],
      [condition([{ field: "/to", op: "eq" }]), "rules[0].when[0].value is required with op eq."],
      [condition([{ field: "/to", op: "in", value: "x" }]), "rules[0].when[0].value must be a non-empty array with op in."],
      [condition([{ field: "/to", op: "ends_with", value: 3 }]), "rules[0].when[0].value must be a non-empty string with op ends_with."],
      [condition([{ field: "/to", op: "exists", value: true }]), "rules[0].when[0].value is not accepted with op exists."],
      [condition([{ scan: "credit_cards", field: "/body" }]), "rules[0].when[0].scan must be one of secrets, pii."],
      [condition([{ scan: "pii", field: "/body", op: "eq" }]), "rules[0].when[0].op is not accepted on a scan condition (scan, field)."],
    ] as const) {
      const rejected = await request("PUT", path(), { revision: saved.revision, rules: [rule] });
      expect(rejected.status, JSON.stringify(rule)).toBe(400);
      expect(await rejected.json()).toEqual({ error: "invalid_request", message });
    }
    // The single-rule path never drops a condition silently.
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });
    const single = await request("PUT", `/api/${org.slug}/agent/${agent.agentId}/permissions`, {
      resource_class: "connector_action", effects: { execute: "deny" }, when: [{ field: "/to", op: "exists" }],
    });
    expect(single.status).toBe(400);
    expect(await single.json()).toMatchObject({ message: "when is only accepted by /write-permissions/connector-actions." });
    expect(await snapshot()).toEqual(saved);

    // Dropping `when` from a rule replaces it with the unconditional one.
    const plain = await request("PUT", path(), { revision: saved.revision, rules: [unconditional] });
    expect(withoutIds((await plain.json()).rules)).toEqual([unconditional]);
    expect((await listEntityApprovalPolicies(org.id, "connector_action")).map(p => p.condition)).toEqual([null]);
  });

  it("rejects a stale plan after another collection edit", async () => {
    const before = await snapshot();
    expect((await request("PUT", path(), { revision: before.revision, rules: [{ effect: "deny" }] })).status).toBe(200);
    const stale = await request("PUT", path(), { revision: before.revision, rules: [] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "policy_conflict" });
    expect(withoutIds((await snapshot()).rules)).toContainEqual({ effect: "deny" });
  });

  it.each(["action", "connection", "connector"] as const)("preserves unchanged rules for a removed %s without accepting new grants", async target => {
    await createTestConnectorDefinition({ organization_id: org.id, key: "policy-retired", name: "Retired policy fixture" });
    const connection = await createTestConnection({ organization_id: org.id, connector_key: "policy-retired" });
    await getTestDb()`UPDATE connector_definitions SET supports_execute = true,
      actions_schema = '{"inspect":{"name":"Inspect","kind":"read"}}'::jsonb
      WHERE organization_id = ${org.id} AND key = 'policy-retired'`;
    const scope = target === "connection" ? { connection_id: connection.id }
      : target === "connector" ? { connector_key: "policy-retired" }
      : { operation_key: "policy-retired::inspect" };
    const initial = await snapshot();
    const created = await request("PUT", path(), { revision: initial.revision, rules: [{ ...scope, effect: "auto" }] });
    expect(created.status).toBe(200);
    const before = await created.json();
    if (target === "connection") await getTestDb()`UPDATE connections SET deleted_at = now() WHERE id = ${connection.id}`;
    else if (target === "connector") await getTestDb()`UPDATE connector_definitions SET status = 'archived' WHERE organization_id = ${org.id} AND key = 'policy-retired'`;
    else await getTestDb()`UPDATE connector_definitions SET actions_schema = '{}'::jsonb WHERE organization_id = ${org.id} AND key = 'policy-retired'`;

    const edited = await request("PUT", path(), { revision: before.revision, rules: [...before.rules, { effect: "deny" }] });
    expect(edited.status).toBe(200);
    const after = await edited.json();
    expect(after.rules).toEqual(expect.arrayContaining(before.rules));
    expect(withoutIds(after.rules)).toContainEqual({ effect: "deny" });
    const changed = await request("PUT", path(), { revision: after.revision, rules: [{ ...scope, effect: "approval" }, { effect: "deny" }] });
    expect(changed.status).toBe(400);
    expect(await snapshot()).toEqual(after);
    const removed = await request("PUT", path(), { revision: after.revision, rules: [{ effect: "deny" }] });
    expect(removed.status).toBe(200);
    const withoutRetired = await removed.json();
    expect(withoutIds(withoutRetired.rules)).toEqual([{ effect: "deny" }]);
    const stale = await request("PUT", path(), { revision: after.revision, rules: after.rules });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "policy_conflict" });
    expect((await request("PUT", path(), { revision: withoutRetired.revision, rules: [...before.rules, { effect: "deny" }] })).status).toBe(400);
    expect(await snapshot()).toEqual(withoutRetired);
  });

  it("serializes competing replacements so only one can use a revision", async () => {
    const before = await snapshot();
    const results = await Promise.all(["auto", "deny"].map(effect => request("PUT", path(), { revision: before.revision, rules: [{ effect }] })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await snapshot()).rules).toHaveLength(1);
  });

  it("validates the whole set and rejects unknown fields, duplicate scopes and foreign targets", async () => {
    const foreignOrg = await createTestOrganization();
    await createTestConnectorDefinition({ organization_id: foreignOrg.id, key: "policy-foreign", name: "Foreign policy fixture" });
    const foreign = await createTestConnection({ organization_id: foreignOrg.id, connector_key: "policy-foreign", name: "Foreign policy fixture" });
    const before = await snapshot();
    for (const rules of [
      [{ effect: "auto" }, { effect: "deny", connection_id: foreign.id }],
      [{ effect: "auto" }, { effect: "deny" }],
      [{ effect: "auto", principal_id: "forged" }],
      [{ effect: "auto", operation_category: "invented" }],
      [{ effect: "invalid" }],
      [{ effect: "auto", operation_key: "missing::action" }],
    ]) {
      expect((await request("PUT", path(), { revision: before.revision, rules })).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    }
    expect((await request("PUT", path(), { rules: [] })).status).toBe(400);
  });

  it("runtime reads cannot mix policy headers and effects across a replacement", async () => {
    await createTestConnectorDefinition({ organization_id: org.id, key: "policy-race", name: "Policy race fixture" });
    const connection = await createTestConnection({ organization_id: org.id, connector_key: "policy-race" });
    await getTestDb()`UPDATE connector_definitions SET supports_execute = true,
      actions_schema = '{"inspect":{"name":"Inspect","kind":"read"}}'::jsonb
      WHERE organization_id = ${org.id} AND key = 'policy-race'`;
    const before = await snapshot();
    const initial = await request("PUT", path(), { revision: before.revision, rules: [{ effect: "auto" }, { operation_category: "read", effect: "deny" }] });
    expect(initial.status).toBe(200);
    const current = await initial.json();
    const sql = dbClient.getDb();
    const operation = await getOperationForConnection(org.id, connection.id, "inspect");
    expect(operation).not.toBeNull();
    const actor = await resolveActingPrincipal(sql, { organizationId: org.id, userId: owner.id });
    let replaced = false;
    const racingSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        const query = Reflect.apply(target, thisArg, args);
        if (!replaced && Array.isArray(args[0]) && args[0].join("").includes("FROM write_approval_policies")) {
          replaced = true;
          return Promise.resolve(query).then(async rows => {
            const changed = await request("PUT", path(), { revision: current.revision, rules: [{ effect: "auto" }, { operation_key: "policy-race::inspect", effect: "deny" }] });
            expect(changed.status).toBe(200);
            return rows;
          });
        }
        return query;
      },
    });
    const decision = await resolveConnectorPolicy({ organizationId: org.id, connectionId: connection.id, operation: operation!.operation, actor, sql: racingSql });
    expect(replaced).toBe(true);
    // Both complete versions block this action. A mixed read must never grant Auto.
    expect(decision.effect).toBe("deny");
  });

  it("rolls back the entire set on a database failure", async () => {
    const before = await snapshot();
    const sql = getTestDb();
    await sql.unsafe(`CREATE FUNCTION policy_collection_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.effect = 'deny' THEN RAISE EXCEPTION 'synthetic policy storage failure'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER policy_collection_test_reject BEFORE INSERT ON write_policy_action_effects FOR EACH ROW EXECUTE FUNCTION policy_collection_test_reject()`);
    try {
      const failed = await request("PUT", path(), { revision: before.revision, rules: [{ effect: "auto" }, { operation_category: "write", effect: "deny" }] });
      expect(failed.status).toBe(500);
      expect(await snapshot()).toEqual(before);
    } finally {
      await sql.unsafe("DROP TRIGGER policy_collection_test_reject ON write_policy_action_effects");
      await sql.unsafe("DROP FUNCTION policy_collection_test_reject()");
    }
  });

  it("reports catalog storage failures as server errors on both write paths", async () => {
    const before = await snapshot();
    await createTestAgent({ organizationId: org.id, agentId: "policy-storage-fixture" });
    const sql = dbClient.getDb();
    const failingSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        if (Array.isArray(args[0]) && args[0].join("").includes("SELECT key FROM connector_definitions")) {
          throw new Error("synthetic catalog storage failure");
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
    const spy = vi.spyOn(dbClient, "getDb").mockReturnValue(failingSql);
    try {
      for (const [route, body] of [
        [path(), { revision: before.revision, rules: [{ connector_key: "policy-fixture", effect: "auto" }] }],
        [`/api/${org.slug}/agent/policy-storage-fixture/permissions`, { resource_class: "connector_action", connector_key: "policy-fixture", effects: { execute: "auto" } }],
      ] as const) {
        expect((await request("PUT", route, body)).status).toBe(500);
      }
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot()).toEqual(before);
  });

  it("requires an explicitly human-minted policy token and enforces role and revocation", async () => {
    const client = await createTestOAuthClient();
    const oauth = (await createTestAccessToken(owner.id, org.id, client.client_id, { scope: "mcp:admin" })).token;
    const ordinary = (await createTestPAT(owner.id, org.id, { scope: "mcp:admin" })).token;
    const before = await snapshot();
    const exchange = await postForm("/api/extension-session", { token: ordinary });
    expect(exchange.status).toBe(200);
    const { session_token } = await exchange.json();
    for (const token of [oauth, ordinary, session_token]) {
      expect((await request("PUT", path(), { revision: before.revision, rules: [] }, token)).status).toBe(403);
    }
    expect(await snapshot()).toEqual(before);
    expect((await request("GET", path(), undefined, session_token)).status).toBe(403);
    expect((await request("POST", `/api/${org.slug}/tokens`, { name: "policy-deploy", scope: "policies:write" }, oauth)).status).toBe(403);
    const minted = await request("POST", `/api/${org.slug}/tokens`, { name: "policy-deploy", scope: "policies:write" });
    expect(minted.status).toBe(201);
    const { token } = await minted.json();
    expect((await request("PUT", path(), { revision: before.revision, rules: [{ effect: "auto" }] }, token.token)).status).toBe(200);
    expect(withoutIds((await snapshot(token.token)).rules)).toEqual([{ effect: "auto" }]);
    const other = await createTestOrganization();
    await addUserToOrganization(owner.id, other.id, "owner");
    expect((await request("GET", `/api/${other.slug}/write-permissions/connector-actions`, undefined, token.token)).status).toBe(403);
    await getTestDb()`UPDATE personal_access_tokens SET worker_id = 'synthetic-worker' WHERE id = ${token.id}`;
    expect((await request("GET", path(), undefined, token.token)).status).toBe(403);
    await getTestDb()`UPDATE personal_access_tokens SET worker_id = NULL WHERE id = ${token.id}`;
    // A policy deployment credential does not acquire access to other settings.
    expect((await request("PUT", `/api/${org.slug}/write-permissions`, { resource_class: "entity", effects: { update: "auto" } }, token.token)).status).toBe(403);
    await getTestDb()`UPDATE "member" SET role = 'member' WHERE "userId" = ${owner.id} AND "organizationId" = ${org.id}`;
    expect((await request("GET", path(), undefined, token.token)).status).toBe(403);
    await getTestDb()`UPDATE "member" SET role = 'owner' WHERE "userId" = ${owner.id} AND "organizationId" = ${org.id}`;
    await getTestDb()`UPDATE personal_access_tokens SET revoked_at = now() WHERE id = ${token.id}`;
    expect((await request("GET", path(), undefined, token.token)).status).toBe(401);
  });
});

describe("hook-scoped loop policy collections", () => {
  it("isolates revisions and atomically replaces only the selected agent's hook rules", async () => {
    const agent = "agent-loop-rule-fixture";
    await createTestAgent({ organizationId: org.id, agentId: agent });
    const otherOrg = await createTestOrganization();
    await createTestAgent({ organizationId: otherOrg.id, agentId: "foreign-agent-loop-rule-fixture" });
    const operation = await snapshot();
    const tool = `${path()}?hook=tool_call&principal_kind=agent&principal_id=${agent}`;
    const reply = `${path()}?hook=reply_out&principal_kind=agent&principal_id=${agent}`;
    const initialResponse = await request("GET", tool);
    expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json();
    const emptyReply = await (await request("GET", reply)).json();
    expect(initial.revision).not.toBe(emptyReply.revision);
    const update = (route: string, rules: unknown[], revision = initial.revision) =>
      request("PUT", route, { revision, rules });
    const rule = { hook: "tool_call", effect: "deny", tools: ["github__*", "admin.tools.list"] };
    expect((await update(reply, [], initial.revision)).status).toBe(409);
    expect((await update(reply, [rule], emptyReply.revision)).status).toBe(400);
    expect((await update(tool, [{ ...rule, effect: "auto" }])).status).toBe(400);
    for (const tools of [[], ["github*"], Array.from({ length: 51 }, (_, index) => `tool-${index}`)]) {
      expect((await update(tool, [{ ...rule, tools }])).status).toBe(400);
    }
    expect((await update(tool, [{ ...rule, operation_key: "github__delete_repo" }])).status).toBe(400);
    expect((await request("GET", `${path()}?hook=invalid`)).status).toBe(400);
    expect((await request("GET", `${path()}?principal_kind=agent&principal_id=${agent}`)).status).toBe(400);
    expect((await request("GET", tool.replace(agent, "foreign-agent-loop-rule-fixture"))).status).toBe(400);
    const pat = await createTestPAT(owner.id, org.id, { scope: "mcp:read policies:write" });
    expect((await request("GET", tool, undefined, pat.token)).status).toBe(403);
    expect((await request("GET", `${path()}?hook=tool_call`, undefined, pat.token)).status).toBe(200);

    const saved = await update(tool, [rule]);
    expect(saved.status, await saved.clone().text()).toBe(200);
    const current = await saved.json();
    expect(current.rules).toEqual([{ ...rule, id: expect.any(Number), kind: "guardrail", tools: ["admin.tools.list", "github__*"] }]);
    expect(await snapshot()).toEqual(operation);
    expect(await (await request("GET", reply)).json()).toEqual(emptyReply);
    expect((await update(tool, [], initial.revision)).status).toBe(409);
    expect(await (await update(tool, current.rules, current.revision)).json()).toEqual(current);
    const withoutAgentId = await request("GET", `${path()}?hook=tool_call&principal_kind=agent`);
    expect(withoutAgentId.status).toBe(200);
    expect((await withoutAgentId.json()).rules).toEqual([]);
  });
});

describe("loop policy runtime", () => {
  it("keeps reply rules out of operation replacements and buffers only blocking replies", async () => {
    const agent = "reply-policy-agent";
    await createTestAgent({ organizationId: org.id, agentId: agent });
    const rule = {
      resourceClass: "connector_action" as const,
      hook: "reply_out" as const,
      principalKind: "agent" as const,
      principalId: agent,
      kind: "guardrail" as const,
      condition: [{ field: "/text", op: "contains", value: "synthetic phrase" }],
    };
    const before = await snapshot();
    const log = await upsertEntityApprovalPolicy(org.id, { ...rule, effects: { execute: "log" } });
    const ctx = { organizationId: org.id, agentId: agent, userId: owner.id, platform: "lobu" };
    expect(await hasOutputGuardrails(ctx)).toBe(false);
    expect(await runOutputGuardrailScan("synthetic phrase", ctx)).toBeNull();

    const block = await upsertEntityApprovalPolicy(org.id, { ...rule, effects: { execute: "deny" } });
    expect(block.id).toBe(log.id);
    expect(await hasOutputGuardrails(ctx)).toBe(true);
    expect(await runOutputGuardrailScan("unrestricted reply", ctx)).toBeNull();
    expect(await runOutputGuardrailScan("synthetic phrase", ctx)).not.toBeNull();
    expect(await runOutputGuardrailScan("synthetic phrase", { ...ctx, agentId: "different-agent" })).toBeNull();
    expect(await snapshot()).toEqual(before);
    const replaced = await request("PUT", path(), { revision: before.revision, rules: [{ effect: "auto" }] });
    expect(replaced.status).toBe(200);
    expect(await runOutputGuardrailScan("synthetic phrase", ctx)).not.toBeNull();
    await flushPendingGuardrailAudits();
  });

  it("keeps distinct tool selectors and matches only the intended tool namespace", async () => {
    const agent = "tool-policy-agent";
    await createTestAgent({ organizationId: org.id, agentId: agent });
    const rule = {
      resourceClass: "connector_action" as const,
      hook: "tool_call" as const,
      principalKind: "agent" as const,
      principalId: agent,
      kind: "guardrail" as const,
      effects: { execute: "deny" as const },
    };
    const exact = await upsertEntityApprovalPolicy(org.id, { ...rule, toolPatterns: ["repo.delete_branch"] });
    const namespaced = await upsertEntityApprovalPolicy(org.id, { ...rule, toolPatterns: ["github__*"] });
    expect(exact.id).not.toBe(namespaced.id);
    const call = (toolName: string, id = agent, namespace?: string) => evaluatePreToolGuardrails({
      organizationId: org.id,
      principal: { kind: "agent", id, ownerAgentId: null },
      userId: owner.id,
      toolName,
      namespace,
      arguments: {},
    });
    expect(await call("repo.delete_branch")).not.toBeNull();
    expect(await call("repoXdelete_branch")).toBeNull();
    expect(await call("github__list_issues")).not.toBeNull();
    expect(await call("list_issues", agent, "github")).not.toBeNull();
    expect(await call("list_issues", agent, "other")).toBeNull();
    expect(await call("othergithub__list_issues")).toBeNull();
    expect(await call("github__list_issues", "another-agent")).toBeNull();
    await flushPendingGuardrailAudits();
  });
});

describe("caller action allowlists", () => {
  const allowlistPath = (kind: "agent" | "pat", id: string | number) =>
    `/api/${org.slug}/write-permissions/allowlists/${kind}/${id}`;
  async function readAllowlist(route: string) {
    const response = await request("GET", route);
    expect(response.status).toBe(200);
    return response.json();
  }
  async function replaceAllowlist(route: string, entries: unknown[]) {
    const { revision } = await readAllowlist(route);
    const response = await request("PUT", route, { revision, entries });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }

  it("distinguishes inherited and empty allowlists, validates targets, and serializes edits", async () => {
    const pat = await createTestPAT(owner.id, org.id, { scope: "mcp:read mcp:write mcp:admin" });
    const route = allowlistPath("pat", pat.id);
    const before = await readAllowlist(route);
    expect(before.entries).toBeNull();
    const foreignOrg = await createTestOrganization();
    const foreign = await createTestEntity({ name: "Foreign record", organization_id: foreignOrg.id });
    const own = await createTestEntity({ name: "Local record", organization_id: org.id });
    const entry = { action: "entity.update", entity_id: own.id };
    for (const entries of [[entry, entry], [{ ...entry, entity_id: foreign.id }], Array(101).fill(entry)]) {
      expect((await request("PUT", route, { revision: before.revision, entries })).status).toBe(400);
    }
    expect((await request("GET", route, undefined, pat.token)).status).toBe(403);
    expect((await request("PUT", route, { revision: before.revision, entries: [] }, pat.token)).status).toBe(403);
    expect((await request("DELETE", route, { revision: before.revision }, pat.token)).status).toBe(403);
    expect((await request("GET", allowlistPath("agent", "missing-agent"))).status).toBe(404);
    const results = await Promise.all([[], [entry]].map(entries =>
      request("PUT", route, { revision: before.revision, entries }),
    ));
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    const empty = await replaceAllowlist(route, []);
    expect(empty.entries).toEqual([]);
    expect(empty.revision).not.toBe(before.revision);
    expect((await request("DELETE", route, { revision: before.revision })).status).toBe(409);
    const reset = await request("DELETE", route, { revision: empty.revision });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual(before);
  });

  it("preserves the caller's PAT allowlist through Chrome sibling session minting", async () => {
    await getTestDb()`UPDATE organization SET metadata = ${JSON.stringify({ personal_org_for_user_id: owner.id })} WHERE id = ${org.id}`;
    const pat = await createTestPAT(owner.id, org.id, { scope: "mcp:read mcp:write mcp:admin device_worker:run" });
    const allowed = await createTestEntity({ name: "Allowed by PAT", organization_id: org.id });
    const excluded = await createTestEntity({ name: "Excluded by PAT", organization_id: org.id });
    await replaceAllowlist(allowlistPath("pat", pat.id), [{ action: "entity.update", entity_id: allowed.id }]);
    const minted = await request("POST", "/api/me/devices/mint-child-token", { platform: "chrome-extension" }, pat.token);
    expect(minted.status).toBe(200);
    const body = await minted.json();
    expect(typeof body.session_token).toBe("string");
    const update = (entity_id: number) => request("POST", `/api/${org.slug}/manage_entity`, {
      action: "update", entity_id, name: "Updated through sibling session",
    }, body.session_token);
    expect((await update(excluded.id)).status).toBe(403);
    expect((await update(allowed.id)).status).toBe(200);
    const [unmodified] = await getTestDb()`SELECT name FROM entities WHERE id = ${excluded.id}`;
    expect(unmodified.name).toBe("Excluded by PAT");
  });

  it("limits agent SDK and PAT SDK/MCP updates to the two named records", async () => {
    await upsertEntityApprovalPolicy(org.id, { resourceClass: "entity", effects: { update: "auto" } });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });
    const sdk = await TestApiClient.for({
      organizationId: org.id, userId: owner.id, memberRole: "owner", agentId: agent.agentId,
    });
    const pat = await createTestPAT(owner.id, org.id, { scope: "mcp:read mcp:write mcp:admin" });
    const mcp = { token: pat.token, orgSlug: org.slug };
    const updateViaSdk = (entity_id: number, name: string) => mcpToolsCall("run_sdk", {
      script: `export default async (_ctx, client) => client.entities.update(${JSON.stringify({ entity_id, name })});`,
    }, mcp);
    for (const [kind, id] of [["agent", agent.agentId], ["pat", pat.id]] as const) {
      // Sequential: concurrent fixtures race to seed the org's entity type.
      const first = await createTestEntity({ name: `${kind} First`, organization_id: org.id });
      const second = await createTestEntity({ name: `${kind} Second`, organization_id: org.id });
      const outside = await createTestEntity({ name: `${kind} Outside`, organization_id: org.id });
      await replaceAllowlist(allowlistPath(kind, id), [first, second].map(record => ({
        action: "entity.update", entity_id: record.id,
      })));
      if (kind === "agent") {
        await sdk.entities.update({ entity_id: first.id, name: "Updated agent first" });
        await sdk.entities.update({ entity_id: second.id, name: "Updated agent second" });
        await expect(sdk.entities.update({ entity_id: outside.id, name: "Forbidden" })).rejects.toMatchObject({ httpStatus: 403 });
      } else {
        const updated = await updateViaSdk(first.id, "Updated pat first");
        expect(updated.success, JSON.stringify(updated.error)).toBe(true);
        await mcpToolsCall("manage_entity", { action: "update", entity_id: second.id, name: "Updated pat second" }, mcp);
        const blockedSdk = await updateViaSdk(outside.id, "Forbidden");
        expect(blockedSdk).toMatchObject({ success: false, error: { code: "PERMISSION" } });
        const blocked = await mcpRequest("tools/call", {
          name: "manage_entity", arguments: { action: "update", entity_id: outside.id, name: "Forbidden" },
        }, mcp);
        expect(blocked.result.isError).toBe(true);
        const exchange = await postForm("/api/extension-session", { token: pat.token });
        expect(exchange.status).toBe(200);
        const { session_token } = await exchange.json();
        const webWrite = await request("POST", `/api/${org.slug}/manage_entity`, {
          action: "update", entity_id: outside.id, name: "Forbidden",
        }, session_token);
        expect(webWrite.status).toBe(403);
        const read = await mcpToolsCall("run_sdk", {
          script: `export default async (_ctx, client) => client.entities.get({entity_id: ${outside.id}});`,
        }, mcp);
        expect(read).toMatchObject({ success: true });
      }
      const sql = getTestDb();
      const rows = await sql`SELECT name FROM entities WHERE id IN (${first.id}, ${second.id}, ${outside.id}) ORDER BY id`;
      expect(rows.map(row => row.name)).toEqual([`Updated ${kind} first`, `Updated ${kind} second`, `${kind} Outside`]);
    }
  });

  it("holds named operations for Ask or Check and applies workspace restrictions", async () => {
    const key = "caller-allowlist-fixture";
    await createTestConnectorDefinition({
      key, name: "Caller allowlist fixture", organization_id: org.id, auth_schema: { methods: [{ type: "none" }] },
    });
    const sql = getTestDb();
    const actions = {
      ...Object.fromEntries(["ask", "check", "log", "restricted", "outside"].map(name => [name, { name, kind: "write" }])),
      lookup: { name: "lookup", kind: "read" },
    };
    await sql`UPDATE connector_definitions SET supports_execute = true, actions_schema = ${sql.json(actions)}
      WHERE organization_id = ${org.id} AND key = ${key}`;
    await sql`UPDATE connector_versions SET compiled_code = ${`
      class ConnectorRuntime {
        async sync() { return { items: [] }; }
        async execute() { return { success: true, output: { fixture: true } }; }
      }
      module.exports = { ConnectorRuntime };
    `} WHERE connector_key = ${key}`;
    const { id: connection_id } = await createTestConnection({
      organization_id: org.id, connector_key: key, created_by: owner.id,
    });
    const pat = await createTestPAT(owner.id, org.id, { scope: "mcp:read mcp:write" });
    const route = allowlistPath("pat", pat.id);
    const entry = (name: string, effect: string) =>
      ({ action: "connector.execute", connection_id, operation_key: name, effect });
    const { revision } = await snapshot();
    expect((await request("PUT", path(), { revision, rules: [
      { effect: "auto" },
      { operation_key: `${key}::restricted`, kind: "guardrail", effect: "deny" },
    ] })).status).toBe(200);
    const before = await readAllowlist(route);
    expect((await request("PUT", route, { revision: before.revision, entries: [entry("missing", "auto")] })).status).toBe(400);
    await replaceAllowlist(route, [entry("ask", "approval"), entry("check", "check"), entry("log", "log"), entry("restricted", "auto")]);
    const operationPath = `/api/${org.slug}/manage_operations`;
    const execute = (operation_key: string) => request("POST", operationPath, {
      action: "execute", connection_id, operation_key, input: {},
    }, pat.token);
    expect(await (await execute("ask")).json()).toMatchObject({ status: "pending_approval" });
    const check = await (await execute("check")).json();
    expect(check).toMatchObject({ status: "pending_check", run_id: expect.any(Number) });
    const logged = await (await execute("log")).json();
    expect(logged, JSON.stringify(logged)).toMatchObject({ status: "completed", output: { fixture: true } });
    const [ledger] = await sql`SELECT metadata FROM events WHERE run_id = ${logged.run_id}
      AND organization_id = ${org.id} AND semantic_type = 'operation' AND superseded_by IS NULL`;
    expect(ledger?.metadata).toMatchObject({ policy: { effect: "log" } });
    // The token's own list refuses an unlisted write and says so, with a link
    // for the owner to the Policies page narrowed to this app (a connection
    // filter would hide the list, which is not a connector rule);
    // a workspace rule still refuses a listed one.
    const caller = { kind: "app", id: `pat:${pat.id}`, label: "Test PAT" };
    const outside = await (await execute("outside")).json();
    expect(outside).toMatchObject({
      policy: { reason: "allowlist", rules: [], principal: caller },
      fix: { action: "edit_allowlist", who: "you", workspace: org.slug },
    });
    const allowlistUrl = new URL(outside.fix.url);
    expect(allowlistUrl.pathname).toBe(`/${org.slug}/settings/policies`);
    expect(Object.fromEntries(allowlistUrl.searchParams)).toEqual({ app: caller.id });
    expect(outside.error).toBe(
      `'outside' isn't on this caller's allowed actions list. To change this app's allowed actions in ${org.slug}, open ${outside.fix.url}`,
    );
    expect(await (await execute("restricted")).json()).toMatchObject({
      error: expect.stringContaining("Policy blocks 'restricted'"),
      policy: { reason: "guardrail", principal: caller },
    });
    // The list limits what the token may change, so an unlisted read still runs.
    expect(await (await execute("lookup")).json()).toMatchObject({ status: "completed", output: { fixture: true } });
    // Binding the PAT's MCP session to an unrestricted agent keeps the PAT's allowlist.
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: owner.id });
    const bound = { token: pat.token, orgSlug: org.slug, agentId: agent.agentId };
    const boundSdk = (body: string) => mcpToolsCall("run_sdk", { script: `export default async (_ctx, client) => ${body};` }, bound);
    const listed = await boundSdk(`client.operations.listAvailable({ connection_id: ${connection_id} })`);
    expect(listed.success, JSON.stringify(listed.error)).toBe(true);
    const listedKeys = listed.return_value.operations.map((operation: { operation_key: string }) => operation.operation_key);
    expect(listedKeys).toContain("log");
    expect(listedKeys).not.toContain("outside");
    const boundExecute = (operation_key: string) => boundSdk(`client.operations.execute(${JSON.stringify({
      connection_id, operation_key, input: {},
    })})`);
    expect(await boundExecute("log")).toMatchObject({ success: true });
    expect(await boundExecute("outside")).toMatchObject({ success: false, error: { code: "PERMISSION" } });
    // A Check the bound session was admitted for is refused once the PAT list drops it.
    const boundCheck = await boundExecute("check");
    expect(boundCheck.return_value, JSON.stringify(boundCheck)).toMatchObject({ status: "pending_check", run_id: expect.any(Number) });
    await replaceAllowlist(route, [entry("ask", "approval"), entry("log", "log"), entry("restricted", "auto")]);
    const boundConfirm = await boundSdk(`client.operations.confirm(${JSON.stringify({
      run_id: boundCheck.return_value.run_id, statement: "Inspected the inputs",
    })})`);
    expect(boundConfirm, JSON.stringify(boundConfirm)).toMatchObject({ success: false, error: { code: "PERMISSION" } });
    expect(JSON.stringify(boundConfirm.error)).toContain("'check' isn't on this caller's allowed actions list.");
    const [boundRun] = await sql`SELECT approval_status, status FROM runs WHERE id = ${boundCheck.return_value.run_id}`;
    expect(boundRun).toMatchObject({ approval_status: "rejected", status: "cancelled" });
    expect(await boundExecute("log")).toMatchObject({ success: true });
    await replaceAllowlist(route, []);
    const confirmation = await request("POST", operationPath, {
      action: "confirm", run_id: check.run_id, statement: "Inspected the inputs",
    }, pat.token);
    expect(await confirmation.json()).toMatchObject({ error: "'check' isn't on this caller's allowed actions list." });
  });
});

describe("connected app caller identity", () => {
  const appPath = (id: string) => `${path()}?principal_kind=app&principal_id=${encodeURIComponent(id)}`;
  async function setRules(route: string, rules: unknown[]) {
    const current = await request("GET", route);
    expect(current.status).toBe(200);
    const saved = await request("PUT", route, { revision: (await current.json()).revision, rules });
    expect(saved.status, await saved.clone().text()).toBe(200);
    return saved.json();
  }
  async function execute(token?: string, input: Record<string, unknown> = {}) {
    const response = await request("POST", `/api/${org.slug}/manage_operations`, { action: "execute", connection_id: connectionId, operation_key: "needs_approval", input }, token);
    return { status: response.status, body: await response.json() as { status?: string; run_id?: number; error?: string; policy?: { rules: Array<Record<string, unknown>> } } };
  }
  async function oauthToken(redirect_uris: string[], authorizationGrantType: "authorization_code" | "device_code" = "authorization_code", client_name: string | null = "Synthetic App") {
    const client = await createTestOAuthClient({ redirect_uris, client_name });
    const { token } = await createTestAccessToken(owner.id, org.id, client.client_id, { scope: "mcp:read mcp:write", authorizationGrantType });
    return { clientId: client.client_id, token };
  }
  let connectionId: number;
  beforeEach(async () => {
    await createTestConnectorDefinition({ key: "app-policy", name: "App policy fixture", organization_id: org.id, auth_schema: { methods: [{ type: "none" }] } });
    await getTestDb()`UPDATE connector_definitions SET supports_execute = true,
      actions_schema = '{"needs_approval":{"name":"Needs approval","kind":"write"}}'::jsonb
      WHERE organization_id = ${org.id} AND key = 'app-policy'`;
    connectionId = (await createTestConnection({ organization_id: org.id, connector_key: "app-policy", created_by: owner.id })).id;
    await setRules(path(), [{ effect: "auto" }]);
  });

  it("holds a write from the hosted web client an app rule names, and only from it", async () => {
    await setRules(appPath("web:example.com"), [{ effect: "approval", kind: "guardrail" }]);
    expect(withoutIds((await snapshot()).rules)).toEqual([{ effect: "auto" }]);

    const named = await oauthToken(["https://app.example.com/callback", "https://login.example.com/cb"]);
    const held = await execute(named.token);
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(held.body.status).toBe("pending_approval");
    const [run] = await getTestDb()`SELECT policy_principal_kind, policy_principal_id FROM runs WHERE id = ${held.body.run_id}`;
    expect(run).toEqual({ policy_principal_kind: "app", policy_principal_id: "web:example.com" });

    const other = await oauthToken(["https://tools.example.org/cb"]);
    for (const caller of [other.token, undefined]) {
      const allowed = await execute(caller);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect(allowed.body.status).not.toBe("pending_approval");
    }

    // The app withdraws its own held run.
    const cancelled = await request("POST", `/api/${org.slug}/manage_operations`, { action: "cancel", run_id: held.body.run_id }, named.token);
    expect(await cancelled.json()).toMatchObject({ cancelled: true });
  });

  it("keys a PAT by its id, a local client by the name it sent, and other clients by their ids", async () => {
    const pat = await createTestPAT(owner.id, org.id, { scope: "mcp:read mcp:write" });
    const spanning = await oauthToken(["https://a.example.com/cb", "https://b.example.net/cb"]);
    const device = await oauthToken([], "device_code", "  Synthetic CLI  ");
    const nameless = await oauthToken(["http://127.0.0.1:8123/cb"], "authorization_code", null);
    // A private public suffix keeps tenants on one host apart.
    const tenant = await oauthToken(["https://synthetic-tenant.vercel.app/cb"]);
    for (const [key, token] of [
      ["web:synthetic-tenant.vercel.app", tenant.token],
      [`pat:${pat.id}`, pat.token],
      [`client:${spanning.clientId}`, spanning.token],
      ["local:Synthetic CLI", device.token],
      [`client:${nameless.clientId}`, nameless.token],
    ] as const) {
      expect((await execute(token)).body.status, key).not.toBe("pending_approval");
      await setRules(appPath(key), [{ effect: "approval", kind: "guardrail" }]);
      const held = await execute(token);
      expect(held.body.status, key).toBe("pending_approval");
      const [run] = await getTestDb()`SELECT policy_principal_id FROM runs WHERE id = ${held.body.run_id}`;
      expect(run.policy_principal_id).toBe(key);
    }
  });

  it("lets the user cancel a run their app is holding, but not another user of the same app", async () => {
    const member = await createTestUser();
    await addUserToOrganization(member.id, org.id, "member");
    const client = await createTestOAuthClient({ redirect_uris: ["https://app.example.com/callback"] });
    const { token } = await createTestAccessToken(member.id, org.id, client.client_id, { scope: "mcp:read mcp:write", authorizationGrantType: "authorization_code" });
    await setRules(appPath("web:example.com"), [{ effect: "approval", kind: "guardrail" }]);
    const held = await execute(token);
    expect(held.body.status).toBe("pending_approval");

    // The app key is shared by every user of the app, so it confers no ownership.
    const otherMember = await createTestUser();
    await addUserToOrganization(otherMember.id, org.id, "member");
    const sameApp = await createTestAccessToken(otherMember.id, org.id, client.client_id, { scope: "mcp:read mcp:write", authorizationGrantType: "authorization_code" });
    const refused = await request("POST", `/api/${org.slug}/manage_operations`, { action: "cancel", run_id: held.body.run_id }, sameApp.token);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("Only the requester") });
    const [stillHeld] = await getTestDb()`SELECT status FROM runs WHERE id = ${held.body.run_id}`;
    expect(stillHeld.status).toBe("pending");

    cookie = (await createTestSession(member.id)).cookieHeader;
    const cancelled = await request("POST", `/api/${org.slug}/manage_operations`, { action: "cancel", run_id: held.body.run_id });
    expect(await cancelled.json()).toMatchObject({ cancelled: true });
  });

  it("allows an app or Automation one action on one connection only, and rejects malformed caller scopes", async () => {
    const exact = { connection_id: connectionId, operation_key: "app-policy::needs_approval", effect: "auto" };
    async function refusal(route: string, rule: Record<string, unknown>) {
      const empty = await (await request("GET", route)).json();
      const refused = await request("PUT", route, { revision: empty.revision, rules: [rule] });
      expect(refused.status, `${route} ${JSON.stringify(rule)}`).toBe(400);
      return ((await refused.json()) as { message: string }).message;
    }
    const mustGuard = "A rule for an app must be a guardrail; use a workspace grant to allow.";
    const oneAction = "An app or Automation can only be allowed one action on one connection.";
    for (const [rule, message] of [
      [{ effect: "approval" }, mustGuard],
      [{ effect: "deny" }, mustGuard],
      [{ ...exact, effect: "approval" }, mustGuard],
      [{ effect: "auto" }, oneAction],
      [{ connection_id: connectionId, effect: "auto" }, oneAction],
      [{ operation_key: exact.operation_key, effect: "auto" }, oneAction],
    ] as const) {
      expect(await refusal(appPath("web:example.com"), rule)).toBe(message);
    }
    expect(await refusal(appPath("web:example.com"), { effect: "auto", kind: "guardrail" })).toMatch(/only log, check, require approval or block/);
    // A rule for every app, or for a client that only names itself, never allows.
    expect(await refusal(`${path()}?principal_kind=app`, exact)).toBe(mustGuard);
    expect(await refusal(appPath("local:Synthetic CLI"), exact)).toBe("An app that only names itself (local:) can't be allowed; add a workspace rule instead.");
    expect(withoutIds((await setRules(appPath("web:example.com"), [exact])).rules)).toEqual([exact]);

    const sql = getTestDb();
    const insertAutomation = async (organizationId: string) => Number((await sql`
      WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
      INSERT INTO automations (id, automation_group_id, organization_id, created_by, name, slug)
      SELECT id, id, ${organizationId}, ${owner.id}, 'Synthetic code Automation', 'synthetic-code-automation' FROM next_id
      RETURNING id`)[0].id);
    const automationPath = (id: string) => `${path()}?principal_kind=automation&principal_id=${encodeURIComponent(id)}`;
    const automationId = await insertAutomation(org.id);
    expect(withoutIds((await setRules(automationPath(`automation:${automationId}`), [exact])).rules)).toEqual([exact]);
    expect(await refusal(automationPath(`automation:${automationId}`), { effect: "auto" })).toBe(oneAction);
    const foreignId = await insertAutomation((await createTestOrganization()).id);
    for (const id of [foreignId, automationId + 1000]) {
      expect(await refusal(automationPath(`automation:${id}`), exact)).toBe("Automation not found in this workspace.");
      // Clearing a missing Automation's rules stays possible.
      expect((await setRules(automationPath(`automation:${id}`), [])).rules).toEqual([]);
    }
    // Only callers with rules of their own are listed: apps first, then Automations.
    const { callers } = await (await request("GET", `${path()}/callers`)).json() as { callers: Array<Record<string, unknown>> };
    expect(callers.map(({ principal_kind, principal_id, label, rules }) => ({ principal_kind, principal_id, label, rules: withoutIds(rules as Array<Record<string, unknown>>) }))).toEqual([
      { principal_kind: "app", principal_id: "web:example.com", label: "example.com", rules: [exact] },
      { principal_kind: "automation", principal_id: `automation:${automationId}`, label: "Synthetic code Automation", rules: [exact] },
    ]);
    expect((await request("GET", `${path()}/callers?principal_kind=app`)).status).toBe(400);
    const member = await createTestUser();
    await addUserToOrganization(member.id, org.id, "member");
    cookie = (await createTestSession(member.id)).cookieHeader;
    expect((await request("GET", `${path()}/callers`)).status).toBe(403);
    cookie = (await createTestSession(owner.id)).cookieHeader;

    for (const query of [
      "?principal_kind=agent&principal_id=x", "?principal_id=web:example.com", "?principal_kind=app&principal_id=example.com",
      "?principal_kind=app&principal_id=%20web:example.com", "?principal_kind=app&principal_id=web:Example.com",
      "?principal_kind=automation&principal_id=automation:abc", "?principal_kind=automation&principal_id=automation:01",
      "?principal_kind=automation&principal_id=automation:0", "?principal_kind=automation&principal_id=7",
    ]) {
      expect((await request("GET", `${path()}${query}`)).status, query).toBe(400);
    }
    expect(withoutIds((await snapshot()).rules)).toEqual([{ effect: "auto" }]);
  });

  it("an app's own Always allow lifts a workspace Ask for that app only", async () => {
    const exact = { connection_id: connectionId, operation_key: "app-policy::needs_approval" };
    await setRules(path(), [{ effect: "auto" }, { ...exact, effect: "approval", kind: "guardrail" }]);
    const named = await oauthToken(["https://app.example.com/callback"]);
    const other = await oauthToken(["https://tools.example.org/cb"]);
    const explain = async (requester: string) => {
      const response = await request("GET", `/api/${org.slug}/write-permissions/explain?connection_id=${connectionId}&operation_key=needs_approval&${requester}`);
      return { status: response.status, body: await response.json() as { effect?: string } };
    };
    expect((await explain("app_key=web%3Aexample.com")).body.effect).toBe("approval");
    const held = await execute(named.token);
    expect(held.body.status).toBe("pending_approval");

    // The approval history names the caller the policy decided for.
    const listed = await request("POST", `/api/${org.slug}/manage_operations`, { action: "list_runs", run_types: ["action"] });
    const { runs } = await listed.json() as { runs: Array<{ id: number; policy_principal: unknown }> };
    expect(runs.find(run => run.id === held.body.run_id)?.policy_principal).toEqual({ kind: "app", id: "web:example.com", label: "example.com" });

    const saved = await setRules(appPath("web:example.com"), [{ ...exact, effect: "auto" }]);
    expect((await explain("app_key=web%3Aexample.com")).body.effect).toBe("auto");
    expect((await explain("app_key=web%3Aexample.org")).body.effect).toBe("approval");
    const allowed = await execute(named.token);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.status).not.toBe("pending_approval");
    expect((await execute(other.token)).body.status).toBe("pending_approval");

    // The Policies page finds the app's rules, editable with the collection's own revision.
    const callers = await (await request("GET", `${path()}/callers`)).json();
    expect(callers).toEqual({ callers: [{ principal_kind: "app", principal_id: "web:example.com", label: "example.com", revision: saved.revision, rules: saved.rules }] });

    for (const requester of ["app_key=example.com", "app_key=web%3AExample.com", "app_key=web%3Aexample.com&automation_id=1"]) {
      expect((await explain(requester)).status, requester).toBe(400);
    }
  });

  it("a rule's when decides on the operation input, and discovery takes the strict side", async () => {
    const exact = { connection_id: connectionId, operation_key: "app-policy::needs_approval" };
    const outside = { field: "/to", op: "not_ends_with", value: "@acme.example" };
    await setRules(path(), [{ effect: "auto" }, { ...exact, effect: "approval", kind: "guardrail", note: "Ask before mailing outside", when: [outside] }]);
    const named = await oauthToken(["https://app.example.com/callback"]);
    const explain = async () => ((await (await request("GET",
      `/api/${org.slug}/write-permissions/explain?connection_id=${connectionId}&operation_key=needs_approval&app_key=web%3Aexample.com`)).json()) as { effect: string }).effect;
    // Without an input, a conditional Ask counts as holding.
    expect(await explain()).toBe("approval");
    // Discovery reports that strict side with the rule note, never the condition.
    const listed = await (await request("POST", `/api/${org.slug}/manage_operations`, { action: "list_available", connection_id: connectionId }, named.token)).json() as
      { operations: Array<{ operation_key: string; policy: { effect: string; rules: unknown[] }; execution_targets: Array<{ policy: { rules: unknown[] } }> }> };
    const discovered = listed.operations.find((operation) => operation.operation_key === "needs_approval");
    expect(discovered?.policy, JSON.stringify(listed)).toMatchObject({ effect: "approval", rules: [{ kind: "guardrail", note: "Ask before mailing outside" }] });
    expect(discovered?.execution_targets[0]?.policy.rules).toEqual(discovered?.policy.rules);
    expect(JSON.stringify(listed)).not.toContain("acme.example");

    const held = await execute(named.token, { to: "someone@outside.example" });
    expect(held.body.status, JSON.stringify(held.body)).toBe("pending_approval");
    // The requester gets the rule note; the approval card shows the condition that matched.
    expect(held.body.policy?.rules).toEqual([{ id: expect.any(Number), kind: "guardrail", note: "Ask before mailing outside" }]);
    const [card] = await getTestDb()`SELECT metadata FROM events WHERE run_id = ${held.body.run_id}
      AND organization_id = ${org.id} AND superseded_by IS NULL AND metadata->>'status' = 'pending_approval'`;
    expect(card?.metadata?.policy?.rules).toEqual([{ id: expect.any(Number), kind: "guardrail", note: "Ask before mailing outside", when: [outside] }]);
    // not_ends_with is exactly !ends_with: one outside recipient, an empty list or a non-string recipient holds it.
    for (const to of [["someone@outside.example", "other@outside.example"], ["someone@outside.example", "teammate@acme.example"], [], ["teammate@acme.example", 7]]) {
      expect((await execute(named.token, { to })).body.status, JSON.stringify(to)).toBe("pending_approval");
    }
    // String ops compare the raw value; a comma-joined list is one string.
    expect((await execute(named.token, { to: "someone@outside.example, teammate@acme.example" })).body.status).not.toBe("pending_approval");
    for (const to of ["teammate@acme.example", ["teammate@acme.example", "lead@acme.example"]]) {
      const internal = await execute(named.token, { to });
      expect(internal.status, JSON.stringify(internal.body)).toBe(200);
      expect(internal.body.status, JSON.stringify(to)).not.toBe("pending_approval");
    }
    // A missing field holds no comparison, so the Ask does not apply.
    expect((await execute(named.token, {})).body.status).not.toBe("pending_approval");

    // A conditional Always allow lifts the Ask only for an input it holds on, and never in discovery.
    await setRules(path(), [{ effect: "auto" }, { ...exact, effect: "approval", kind: "guardrail" }]);
    await setRules(appPath("web:example.com"), [{ ...exact, effect: "auto", when: [{ field: "/to", op: "ends_with", value: "@acme.example" }] }]);
    expect(await explain()).toBe("approval");
    const lifted = await execute(named.token, { to: "teammate@acme.example" });
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    expect(lifted.body.status).not.toBe("pending_approval");
    expect((await execute(named.token, { to: "someone@outside.example" })).body.status).toBe("pending_approval");
    await setRules(appPath("web:example.com"), []);

    // A Block on a body that looks like it carries a secret.
    await setRules(path(), [{ effect: "auto" }, { ...exact, effect: "deny", kind: "guardrail", note: "Never send credentials", when: [{ scan: "secrets", field: "/body" }] }]);
    expect(await explain()).toBe("deny");
    const blocked = await execute(named.token, { body: `token ghp_${"c".repeat(36)}` });
    expect(blocked.body.error, JSON.stringify(blocked.body)).toContain("Policy blocks 'needs_approval'");
    expect(blocked.body.policy?.rules).toEqual([{ id: expect.any(Number), kind: "guardrail", note: "Never send credentials" }]);
    const clean = await execute(named.token, { body: "See you at the review." });
    expect(clean.status, JSON.stringify(clean.body)).toBe(200);
    expect(clean.body.error ?? "").not.toContain("Policy blocks");
  });

  describe("classify conditions", () => {
    // A local model speaking Chat Completions. It answers from the judged text
    // so each case reads on its own: "wire" is a payment, "hello" chitchat,
    // "abstain" no value, "garbage" not JSON, "slow" later than the budget.
    let model: Server;
    let modelUrl: string;
    beforeAll(async () => {
      process.env.LOBU_ENCRYPTION_KEY ||= "a".repeat(64);
      __resetEncryptionKeyCacheForTests();
      model = createServer((req, res) => {
        let raw = "";
        req.on("data", chunk => { raw += chunk; });
        req.on("end", () => {
          const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
          const text = body.messages.find(message => message.role === "user")?.content ?? "";
          const reply = (content: string) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
          };
          const verdict = (value: string | null) => JSON.stringify({ value, reasoning: "synthetic" });
          if (text.includes("transport-failure")) res.writeHead(503).end();
          else if (text.includes("slow")) setTimeout(() => reply(verdict("payment")), 4_000);
          else if (text.includes("garbage")) reply("I think it is a payment.");
          else if (text.includes("abstain")) reply(verdict(null));
          else if (text.includes("wire")) reply(verdict("payment"));
          else reply(verdict("chitchat"));
        });
      });
      await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
      modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
    });
    afterAll(async () => {
      model.closeAllConnections();
      await new Promise<void>(resolve => model.close(() => resolve()));
    });
    beforeEach(() => resetPredictClassifierForTests());

    async function addClassifier(slug = "topic") {
      const [row] = await getTestDb()<{ id: number }>`
        INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by, entity_ids, attribute_values, min_similarity)
        VALUES (${org.id}, ${slug}, 'Topic', ${slug}, 'active', ${owner.id}, ARRAY[]::bigint[],
          '{"payment":{"description":"Moves money","examples":["wire 500 to this account"]},"chitchat":{"description":"Small talk"}}'::jsonb, 0.7)
        RETURNING id`;
      return Number(row.id);
    }
    async function addModelProvider() {
      const created = await createInferenceProvider({ organizationId: org.id, slug: "fake-model", kind: "openai", apiKey: "sk-synthetic",
        capabilities: { text: { model: "fake-1", base_url: modelUrl } } });
      if ("error" in created) throw new Error(created.error);
      await getTestDb()`UPDATE inference_providers SET is_default = true WHERE organization_id = ${org.id} AND slug = 'fake-model'`;
    }
    const exact = () => ({ connection_id: connectionId, operation_key: "app-policy::needs_approval" });
    const payment = { classify: "topic", field: "/body", is: ["payment"] };

    it("recovers after provider resolution fails during a half-open probe", async () => {
      await addClassifier();
      await addModelProvider();
      const predict = (text: string) => predictClassifier({ organizationId: org.id, classifier: "topic", model: "fake-model/fake-1", text });
      for (let attempt = 0; attempt < 5; attempt++) {
        expect(await predict(`transport-failure ${attempt}`)).toMatchObject({ ok: false, error: "unavailable" });
      }
      expect(await predict("hello before cooldown")).toMatchObject({ ok: false, error: "unavailable" });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
      try {
        await getTestDb()`UPDATE inference_providers SET deleted_at = now() WHERE organization_id = ${org.id} AND slug = 'fake-model'`;
        expect(await predict("hello during probe")).toMatchObject({ ok: false, error: "no_model_provider" });
        await getTestDb()`UPDATE inference_providers SET deleted_at = NULL WHERE organization_id = ${org.id} AND slug = 'fake-model'`;
        expect(await predict("hello before retry")).toMatchObject({ ok: false, error: "unavailable" });
        clock.mockReturnValue(now + 90_002);
        expect(await predict("hello after recovery")).toMatchObject({ ok: true, value: "chitchat" });
      } finally {
        clock.mockRestore();
      }
    });

    it.each(["", "/payload", "/payload/image"])("replays classification of prepared file input at %j", async (field) => {
      await addClassifier();
      await addModelProvider();
      const sql = getTestDb();
      await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({ needs_approval: {
        name: "Needs approval", kind: "write", input_schema: { type: "object", properties: {
          payload: { type: "object", properties: { image: fileInputSchema({ maxBytes: 1024, contentTypes: ["image/png"] }) } },
        } },
      } })} WHERE organization_id = ${org.id} AND key = 'app-policy'`;
      await setRules(path(), [{ effect: "auto" }, { ...exact(), effect: "deny", kind: "guardrail", when: [{ ...payment, field }] }]);
      const named = await oauthToken(["https://app.example.com/callback"]);
      const directory = await mkdtemp(join(tmpdir(), "policy-classify-files-"));
      const store = new ArtifactStore(directory);
      const services = vi.spyOn(gateway, "getLobuCoreServices").mockReturnValue({ getArtifactStore: () => store });
      try {
        const [file] = await ingestInputFiles([{ name: "photo.png", mimeType: "image/png", data: Buffer.from("photo") }],
          { organizationId: org.id, userId: owner.id, isAuthenticated: true }, store, baseUrl);
        const admitted = await execute(named.token, { payload: { image: { $file: file.$file } } });
        expect(admitted.body, JSON.stringify(admitted.body)).toMatchObject({ run_id: expect.any(Number) });
        const runId = admitted.body.run_id!;
        const [run] = await sql`SELECT action_input, run_metadata FROM runs WHERE id = ${runId}`;
        expect(run.action_input).toEqual({ payload: { image: file } });
        expect(run.run_metadata.policy_classify).toEqual([expect.objectContaining({ result: "not" })]);
        expect((await resolveRunConnectorPolicy({ organizationId: org.id, runId }))?.effect).toBe("auto");
      } finally {
        services.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("refuses a classify condition the workspace cannot run, naming the field, and stores the default model", async () => {
      const before = await snapshot();
      const put = (when: unknown[]) => request("PUT", path(), { revision: before.revision, rules: [{ effect: "deny", kind: "guardrail", when }] });
      const refusal = async (when: unknown[]) => {
        const response = await put(when);
        expect(response.status, JSON.stringify(when)).toBe(400);
        return ((await response.json()) as { message: string }).message;
      };
      expect(await refusal([payment])).toBe('rules[0].when[0].classify: no classifier "topic" in this workspace.');
      await addClassifier();
      expect(await refusal([{ field: "/to", op: "exists" }, { ...payment, is: ["payment", "refund"] }]))
        .toBe('rules[0].when[1].is: "refund" is not a value of classifier "topic".');
      expect(await refusal([payment])).toBe("rules[0].when[0]: ChatGPT sign-in can't run policy checks; add a provider with an API key.");
      expect(await refusal([payment, payment, { ...payment, field: "/title" }])).toBe("rules[0].when may hold at most 2 classify conditions.");
      expect(await refusal([{ ...payment, is: [] }])).toBe("rules[0].when[0].is must be a non-empty list of distinct classifier values.");
      await addModelProvider();
      const saved = await put([payment]);
      expect(saved.status, await saved.clone().text()).toBe(200);
      const { rules, revision } = await saved.json();
      expect(rules[0].when).toEqual([{ ...payment, model: "fake-model/fake-1" }]);
      // Echoing the stored rule keeps its identity.
      const echoed = await request("PUT", path(), { revision, rules });
      expect((await echoed.json()).rules).toEqual(rules);
    });

    it("applies a rule on holds, ignores it on not, and treats a failed call as unknown", async () => {
      await addClassifier();
      await addModelProvider();
      await setRules(path(), [{ effect: "auto" }, { ...exact(), effect: "approval", kind: "guardrail", note: "Ask before moving money", when: [payment] }]);
      const named = await oauthToken(["https://app.example.com/callback"]);
      const status = async (body: string) => (await execute(named.token, { body })).body.status;
      expect(await status("please wire 500 today")).toBe("pending_approval");
      expect(await status("hello, see you at the review")).not.toBe("pending_approval");
      // Unknown keeps a restriction: invalid output, an abstention, and a call past the budget.
      expect(await status("garbage")).toBe("pending_approval");
      expect(await status("abstain")).toBe("pending_approval");
      const started = Date.now();
      expect(await status("slow")).toBe("pending_approval");
      expect(Date.now() - started).toBeLessThan(3_900);
      // An input with no such field holds nothing, so the Ask does not apply and no call is made.
      expect((await execute(named.token, {})).body.status).not.toBe("pending_approval");

      // Unknown drops a grant: the app's conditional Always allow lifts the Ask only on holds.
      await setRules(path(), [{ effect: "auto" }, { ...exact(), effect: "approval", kind: "guardrail" }]);
      await setRules(appPath("web:example.com"), [{ ...exact(), effect: "auto", when: [{ ...payment, is: ["chitchat"] }] }]);
      expect(await status("hello again")).not.toBe("pending_approval");
      expect(await status("garbage again")).toBe("pending_approval");
    });

    it("replays the admission result after the model is gone, and a missing one is unknown", async () => {
      await addClassifier();
      await addModelProvider();
      await setRules(path(), [{ effect: "auto" }, { ...exact(), effect: "approval", kind: "guardrail" }]);
      await setRules(appPath("web:example.com"), [{ ...exact(), effect: "auto", when: [{ ...payment, is: ["chitchat"] }] }]);
      const named = await oauthToken(["https://app.example.com/callback"]);
      const admitted = await execute(named.token, { body: "hello, replay me" });
      expect(admitted.body.status, JSON.stringify(admitted.body)).not.toBe("pending_approval");
      const runId = admitted.body.run_id!;
      const [run] = await getTestDb()<{ run_metadata: Record<string, unknown> }>`SELECT run_metadata FROM runs WHERE id = ${runId}`;
      // Only the outcome is stored: never the judged text or the model's reasoning.
      expect(run.run_metadata.policy_classify).toEqual([
        { rule: expect.any(Number), condition: 0, text: expect.any(String), result: "holds", model: "fake-model/fake-1", classifier: expect.any(String) },
      ]);
      expect(JSON.stringify(run.run_metadata)).not.toContain("synthetic");

      model.closeAllConnections();
      await new Promise<void>(resolve => model.close(() => resolve()));
      resetPredictClassifierForTests();
      try {
        expect((await resolveRunConnectorPolicy({ organizationId: org.id, runId }))?.effect).toBe("auto");
        await getTestDb()`UPDATE runs SET run_metadata = run_metadata - 'policy_classify' WHERE id = ${runId}`;
        expect((await resolveRunConnectorPolicy({ organizationId: org.id, runId }))?.effect).toBe("approval");
      } finally {
        await new Promise<void>(resolve => model.listen(Number(new URL(modelUrl).port), "127.0.0.1", resolve));
      }
    });

    it("decides whether the audience matters after classifying, live and on replay", async () => {
      await addClassifier();
      await addModelProvider();
      await setRules(path(), [{ effect: "auto" }, { effect: "deny", kind: "guardrail", when: [payment] },
        { effect: "approval", kind: "guardrail", audience: "external", note: "Ask before posting outside" }]);
      // A connector that can say who sees the channel; the channel was classified external before.
      const operation = { connector_key: "slack", operation_key: "post", kind: "write" as const,
        input_schema: { type: "object", properties: { channel: { type: "string", "x-lobu-destination": true }, body: { type: "string" } } } };
      const actor = await resolveActingPrincipal(getTestDb(), { organizationId: org.id, userId: owner.id });
      const decide = (body: string, classify: PolicyClassifyLookup) =>
        resolveConnectorPolicy({ organizationId: org.id, connectionId, operation, actor, input: { channel: "C-outside", body },
          destination: { live: false, seen: [{ connectionId, destination: "C-outside", audience: "external" }] }, classify });
      const results: PolicyClassifyResult[] = [];
      // Not a payment, so the Block drops and the external Ask still applies.
      expect((await decide("hello, see you at the review", { live: true, results })).effect).toBe("approval");
      expect(results).toEqual([expect.objectContaining({ result: "not" })]);
      expect((await decide("hello, see you at the review", { live: false, results })).effect).toBe("approval");
      expect((await decide("please wire 500 today", { live: true, results: [] })).effect).toBe("deny");
    });

    it("classifies an approver's edited input afresh, and a stale result never answers for it", async () => {
      await addClassifier();
      await addModelProvider();
      await setRules(path(), [{ effect: "auto" }, { ...exact(), effect: "approval", kind: "guardrail" },
        { effect: "deny", kind: "guardrail", note: "Never move money", when: [payment] }]);
      const named = await oauthToken(["https://app.example.com/callback"]);
      const held = await execute(named.token, { body: "hello, see you at the review" });
      expect(held.body.status, JSON.stringify(held.body)).toBe("pending_approval");
      const runId = held.body.run_id!;
      // The stored "not" judged other text, so replaying it for the edit is unknown and the Block applies.
      await getTestDb()`UPDATE runs SET action_input = ${getTestDb().json({ body: "please wire 500 today" })} WHERE id = ${runId}`;
      expect((await resolveRunConnectorPolicy({ organizationId: org.id, runId }))?.effect).toBe("deny");
      await getTestDb()`UPDATE runs SET action_input = ${getTestDb().json({ body: "hello, see you at the review" })} WHERE id = ${runId}`;
      expect((await resolveRunConnectorPolicy({ organizationId: org.id, runId }))?.effect).toBe("approval");

      const approved = await request("POST", `/api/${org.slug}/manage_operations`, { action: "approve", run_id: runId, input: { body: "please wire 500 today" } });
      const body = await approved.json() as { error?: string };
      expect(body.error, JSON.stringify(body)).toContain("Policy now blocks 'needs_approval'");
      const [run] = await getTestDb()<{ status: string; approval_status: string; action_input: unknown }>`
        SELECT status, approval_status, action_input FROM runs WHERE id = ${runId}`;
      expect(run).toMatchObject({ status: "cancelled", approval_status: "rejected", action_input: { body: "hello, see you at the review" } });
    });

    it("refuses to delete a classifier a rule's condition uses", async () => {
      const classifierId = await addClassifier();
      await addModelProvider();
      const saved = await setRules(path(), [{ effect: "deny", kind: "guardrail", when: [payment] }]);
      const remove = () => request("POST", `/api/${org.slug}/manage_classifiers`, { action: "delete", classifier_id: classifierId });
      const refused = await remove();
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: `Classifier "topic" is used by policy rule ${saved.rules[0].id}; remove its classify condition first.` });
      const [still] = await getTestDb()`SELECT status FROM classify_facet WHERE id = ${classifierId}`;
      expect(still.status).toBe("active");
      await setRules(path(), []);
      const removed = await remove();
      expect(removed.status, await removed.clone().text()).toBe(200);
    });
  });
});
