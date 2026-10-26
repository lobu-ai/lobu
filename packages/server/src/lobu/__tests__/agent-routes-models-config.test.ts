/**
 * Round-2 review coverage for the agent PATCH/GET `/config` model surface:
 *   #1  a PATCH carrying a removed legacy field (defaultModel / installedProviders)
 *       is REJECTED (400) — never silently dropped to models=NULL=allow-all.
 *   #8  GET returns the ordered `models` list and NO legacy `defaultModel`.
 *   #7  a PATCH whose `models` fails validation is ATOMIC — it rejects BEFORE
 *       mutating auth profiles, so a co-sent credential is NOT persisted.
 *
 * Drives the real `agentRoutes` Hono app over the embedded-PG harness with the
 * shared route-test auth mocks (same pattern as agent-routes-guardrail-trips).
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedOrgMembership,
} from "../../gateway/__tests__/helpers/db-setup.js";
import {
  authStash,
  coreServicesStash,
  installRouteTestMocks,
} from "./helpers/route-test-mocks";

installRouteTestMocks();

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ORG = "org-models-config";
const AGENT = "models-config-agent";

async function seedOrgAndAgent(): Promise<void> {
  const { getDb } = await import("../../db/client.js");
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG}) ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO agents (id, organization_id, name)
    VALUES (${AGENT}, ${ORG}, 'Models Config Agent')
    ON CONFLICT (organization_id, id) DO NOTHING
  `;
}

async function importAgentRoutes() {
  const mod = await import("../agent-routes.js");
  return mod.agentRoutes;
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
  await seedOrgAndAgent();
  await seedOrgMembership(ORG, "u1", "owner");
  authStash.user = {
    id: "u1",
    name: "Test",
    email: "u1@test",
    emailVerified: true,
  };
  authStash.organizationId = ORG;
  authStash.authSource = "session";
  authStash.mcpAuthInfo = null;
  coreServicesStash.services = null;
}, 30_000);

describe("agent PATCH/GET /config — models surface", () => {
  test("failed audit rolls back settings, metadata and deletion together with lifecycle events", async () => {
    const app = await importAgentRoutes();
    const { getDb } = await import("../../db/client.js");
    const sql = getDb();
    const before = await sql`SELECT * FROM agents WHERE organization_id = ${ORG} AND id = ${AGENT}`;
    await sql.unsafe("CREATE FUNCTION reject_agent_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'category' = 'config' THEN RAISE EXCEPTION 'synthetic agent audit failure'; END IF; RETURN NEW; END $$");
    await sql.unsafe("CREATE TRIGGER reject_agent_config_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_agent_config_audit()");
    try {
      for (const [path, method, body] of [
        [`/${AGENT}/config`, "PATCH", { soulMd: "Changed" }],
        [`/${AGENT}`, "PATCH", { name: "Changed" }],
        [`/${AGENT}`, "DELETE", {}],
      ] as const) {
        const response = await app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        expect(response.status).toBe(500);
        expect(await sql`SELECT * FROM agents WHERE organization_id = ${ORG} AND id = ${AGENT}`).toEqual(before);
        expect(await sql`SELECT id FROM events WHERE organization_id = ${ORG}`).toHaveLength(0);
      }
    } finally {
      await sql.unsafe("DROP TRIGGER reject_agent_config_audit ON events");
      await sql.unsafe("DROP FUNCTION reject_agent_config_audit()");
    }
  });

  test("#1: a PATCH carrying legacy defaultModel is rejected (not silently dropped)", async () => {
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultModel: "openai/gpt-5" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; field?: string };
    expect(body.error).toBe("legacy_model_field");
    expect(body.field).toBe("defaultModel");
  });

  test("#1: a PATCH carrying legacy installedProviders is rejected", async () => {
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installedProviders: [{ providerId: "openai", installedAt: 1 }],
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "legacy_model_field"
    );
  });

  test("#8: GET returns the ordered models list and no defaultModel", async () => {
    const { getDb } = await import("../../db/client.js");
    const sql = getDb();
    await sql`
      UPDATE agents SET models = ${sql.json(["openai/gpt-5", "claude/claude-sonnet-5"])}
      WHERE organization_id = ${ORG} AND id = ${AGENT}
    `;
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.models).toEqual(["openai/gpt-5", "claude/claude-sonnet-5"]);
    expect(body).not.toHaveProperty("defaultModel");
    expect(body).not.toHaveProperty("installedProviders");
  });

  test("#7: a PATCH with an invalid models list rejects BEFORE persisting auth profiles (atomic)", async () => {
    // Spy manager: record any upsertProfile call. The handler must NOT reach it
    // when models validation fails first.
    const upserts: unknown[] = [];
    coreServicesStash.services = {
      getAuthProfilesManager: () => ({
        upsertProfile: async (p: unknown) => {
          upserts.push(p);
        },
        getUserAuthProfileStore: () => ({
          list: async () => [],
        }),
      }),
    };

    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // "ghost" is not a provider in this org → validation fails.
        models: ["ghost/some-model"],
        authProfiles: [
          {
            id: "p1",
            provider: "ghost",
            model: "ghost/some-model",
            label: "key",
            authType: "api-key",
            credential: "sk-should-not-persist",
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "model_provider_not_connected"
    );
    // The credential was NEVER persisted — the PATCH was a true no-op.
    expect(upserts).toHaveLength(0);

    // And the agent's models were not mutated either.
    const { getDb } = await import("../../db/client.js");
    const sql = getDb();
    const rows = (await sql`
      SELECT models FROM agents WHERE organization_id = ${ORG} AND id = ${AGENT}
    `) as Array<{ models: string[] | null }>;
    expect(rows[0]?.models ?? null).toBeNull();
  });

  test("#6: a PATCH with a __unresolved__ sentinel + a soulMd change succeeds and round-trips", async () => {
    // A migrated legacy agent carries `models = ["legacy/__unresolved__"]`.
    // Editing ANY setting (soulMd) PATCHes the FULL desired settings incl.
    // models; the sentinel must be ACCEPTED as valid (not invalid_model_ref),
    // so the apply doesn't break on an unrelated edit.
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        models: ["legacy/__unresolved__", "chatgpt/__unresolved__"],
        soulMd: "Be concise.",
      }),
    });
    expect(res.status).toBe(200);

    // GET round-trips the exact sentinel list + the soulMd edit.
    const get = await app.request(`/${AGENT}/config`);
    const body = (await get.json()) as Record<string, unknown>;
    expect(body.models).toEqual([
      "legacy/__unresolved__",
      "chatgpt/__unresolved__",
    ]);
    expect(body.soulMd).toBe("Be concise.");
  });
});
