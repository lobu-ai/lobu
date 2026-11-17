import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getOperationForConnection } from "../../../operations/connector-operations";
import * as dbClient from "../../../db/client";
import { app, type Env } from "../../../index";
import { initWorkspaceProvider } from "../../../workspace";
import { listEntityApprovalPolicies, resolveActingPrincipal, resolveConnectorPolicy, upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import { postForm } from "../../setup/test-helpers";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { addUserToOrganization, createTestAccessToken, createTestAgent, createTestConnection, createTestConnectorDefinition, createTestOAuthClient, createTestOrganization, createTestPAT, createTestSession, createTestUser } from "../../setup/test-fixtures";

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
    expect(await autoGuardrail.json()).toEqual({ error: "invalid_request", message: "A guardrail can only require approval or block; use a grant to allow." });

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

describe("connected app caller identity", () => {
  const appPath = (id: string) => `${path()}?principal_kind=app&principal_id=${encodeURIComponent(id)}`;
  async function setRules(route: string, rules: unknown[]) {
    const current = await request("GET", route);
    expect(current.status).toBe(200);
    const saved = await request("PUT", route, { revision: (await current.json()).revision, rules });
    expect(saved.status, await saved.clone().text()).toBe(200);
    return saved.json();
  }
  async function execute(token?: string) {
    const response = await request("POST", `/api/${org.slug}/manage_operations`, { action: "execute", connection_id: connectionId, operation_key: "needs_approval", input: {} }, token);
    return { status: response.status, body: await response.json() as { status?: string; run_id?: number; error?: string } };
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
    for (const [key, token] of [
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

  it("lets the user cancel a run their app is holding", async () => {
    const member = await createTestUser();
    await addUserToOrganization(member.id, org.id, "member");
    const client = await createTestOAuthClient({ redirect_uris: ["https://app.example.com/callback"] });
    const { token } = await createTestAccessToken(member.id, org.id, client.client_id, { scope: "mcp:read mcp:write", authorizationGrantType: "authorization_code" });
    await setRules(appPath("web:example.com"), [{ effect: "approval", kind: "guardrail" }]);
    const held = await execute(token);
    expect(held.body.status).toBe("pending_approval");
    cookie = (await createTestSession(member.id)).cookieHeader;
    const cancelled = await request("POST", `/api/${org.slug}/manage_operations`, { action: "cancel", run_id: held.body.run_id });
    expect(await cancelled.json()).toMatchObject({ cancelled: true });
  });

  it("accepts only guardrails for an app and rejects malformed app scopes", async () => {
    const empty = await (await request("GET", appPath("web:example.com"))).json();
    for (const rule of [{ effect: "approval" }, { effect: "auto", kind: "grant" }, { effect: "auto", kind: "guardrail" }]) {
      const loosened = await request("PUT", appPath("web:example.com"), { revision: empty.revision, rules: [rule] });
      expect(loosened.status, JSON.stringify(rule)).toBe(400);
    }
    const grant = await request("PUT", appPath("web:example.com"), { revision: empty.revision, rules: [{ effect: "deny" }] });
    expect(await grant.json()).toMatchObject({ message: "A rule for an app must be a guardrail; use a workspace grant to allow." });
    for (const query of ["?principal_kind=agent&principal_id=x", "?principal_id=web:example.com", "?principal_kind=app&principal_id=example.com", "?principal_kind=app&principal_id=%20web:example.com"]) {
      expect((await request("GET", `${path()}${query}`)).status, query).toBe(400);
    }
    expect(withoutIds((await snapshot()).rules)).toEqual([{ effect: "auto" }]);
  });
});
