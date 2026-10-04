import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClient from "../../../db/client";
import { app, type Env } from "../../../index";
import { initWorkspaceProvider } from "../../../workspace";
import { listEntityApprovalPolicies, upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
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
    expect(before.rules).toEqual([{ operation_category: "read", effect: "auto" }]);
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

  it("rejects a stale plan after a single-rule UI edit", async () => {
    const before = await snapshot();
    expect((await request("PUT", `/api/${org.slug}/write-permissions`, { resource_class: "connector_action", effects: { execute: "deny" } })).status).toBe(200);
    const stale = await request("PUT", path(), { revision: before.revision, rules: [] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "policy_conflict" });
    expect((await snapshot()).rules).toContainEqual({ effect: "deny" });
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
        [`/api/${org.slug}/write-permissions`, { resource_class: "connector_action", connector_key: "policy-fixture", effects: { execute: "auto" } }],
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
    for (const token of [oauth, ordinary]) {
      expect((await request("PUT", path(), { revision: before.revision, rules: [] }, token)).status).toBe(403);
    }
    expect((await request("POST", `/api/${org.slug}/tokens`, { name: "policy-deploy", scope: "policies:write" }, oauth)).status).toBe(403);
    const minted = await request("POST", `/api/${org.slug}/tokens`, { name: "policy-deploy", scope: "policies:write" });
    expect(minted.status).toBe(201);
    const { token } = await minted.json();
    expect((await request("PUT", path(), { revision: before.revision, rules: [{ effect: "auto" }] }, token.token)).status).toBe(200);
    expect((await snapshot(token.token)).rules).toEqual([{ effect: "auto" }]);
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
