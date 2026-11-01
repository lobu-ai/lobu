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
import { AuthProfilesManager } from "../../gateway/auth/settings/auth-profiles-manager.js";
import { EphemeralAuthProfileRegistry } from "../../gateway/auth/settings/agent-settings-store.js";
import { UserAuthProfileStore } from "../../gateway/auth/settings/user-auth-profile-store.js";
import { DeclaredAgentRegistry } from "../../gateway/services/declared-agent-registry.js";
import { PostgresSecretStore } from "../stores/postgres-secret-store.js";
import { orgContext } from "../stores/org-context.js";

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
  test("auth profiles share the settings transaction for saves, removals and audit rollback", async () => {
    const secretStore = new PostgresSecretStore();
    const profiles = new UserAuthProfileStore(secretStore);
    const manager = new AuthProfilesManager({
      ephemeralProfiles: new EphemeralAuthProfileRegistry(),
      declaredAgents: new DeclaredAgentRegistry(),
      userAuthProfiles: profiles,
      secretStore,
    });
    coreServicesStash.services = { getAuthProfilesManager: () => manager };
    const app = await importAgentRoutes();
    const { getDb } = await import("../../db/client.js");
    const sql = getDb();
    let { revision } = await (await app.request(`/${AGENT}/config`)).json() as { revision: string };
    const patch = (body: Record<string, unknown>) => app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, expected_revision: revision }),
    });

    // Run with DB_POOL_MAX=1: even an empty list must not request another
    // pooled connection while the settings transaction owns the only one.
    const empty = await patch({ soulMd: "Saved without credentials", authProfiles: [] });
    expect(empty.status).toBe(200);
    revision = ((await empty.json()) as { revision: string }).revision;

    const saved = await patch({
      soulMd: "Saved with credentials",
      authProfiles: [{
        id: "transaction-profile", provider: "openai", label: "Test key",
        authType: "api-key", model: "*", credential: "synthetic-transaction-key",
      }],
    });
    expect(saved.status).toBe(200);
    revision = ((await saved.json()) as { revision: string }).revision;
    const storedProfiles = await profiles.list("u1", AGENT);
    expect(storedProfiles).toHaveLength(1);
    const secretRef = storedProfiles[0]!.credentialRef!;
    const readSecret = () => orgContext.run({ organizationId: ORG }, () => secretStore.get(secretRef));
    expect(await readSecret()).toBe("synthetic-transaction-key");

    await sql.unsafe("CREATE FUNCTION reject_agent_profile_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'category' = 'config' THEN RAISE EXCEPTION 'synthetic profile audit failure'; END IF; RETURN NEW; END $$");
    await sql.unsafe("CREATE TRIGGER reject_agent_profile_config_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_agent_profile_config_audit()");
    try {
      const rejected = await patch({ soulMd: "Must roll back", authProfiles: [] });
      expect(rejected.status).toBe(500);
      expect(await profiles.list("u1", AGENT)).toEqual(storedProfiles);
      expect(await readSecret()).toBe("synthetic-transaction-key");
      const current = await (await app.request(`/${AGENT}/config`)).json() as { revision: string; soulMd: string };
      expect(current).toMatchObject({ revision, soulMd: "Saved with credentials" });
    } finally {
      await sql.unsafe("DROP TRIGGER reject_agent_profile_config_audit ON events");
      await sql.unsafe("DROP FUNCTION reject_agent_profile_config_audit()");
    }

    const removed = await patch({ authProfiles: [] });
    expect(removed.status).toBe(200);
    expect(await profiles.list("u1", AGENT)).toEqual([]);
    expect(await readSecret()).toBeNull();
  }, 10_000);

  test("failed audit rolls back settings, metadata and deletion together with lifecycle events", async () => {
    const app = await importAgentRoutes();
    const { getDb } = await import("../../db/client.js");
    const sql = getDb();
    const before = await sql`SELECT * FROM agents WHERE organization_id = ${ORG} AND id = ${AGENT}`;
    const { revision } = await (await app.request(`/${AGENT}/config`)).json() as { revision: string };
    await sql.unsafe("CREATE FUNCTION reject_agent_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'category' = 'config' THEN RAISE EXCEPTION 'synthetic agent audit failure'; END IF; RETURN NEW; END $$");
    await sql.unsafe("CREATE TRIGGER reject_agent_config_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_agent_config_audit()");
    try {
      for (const [path, method, body] of [
        [`/${AGENT}/config`, "PATCH", { soulMd: "Changed" }],
        [`/${AGENT}`, "PATCH", { name: "Changed" }],
        [`/${AGENT}`, "DELETE", {}],
      ] as const) {
        const response = await app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, expected_revision: revision }) });
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
    const { revision } = await (await app.request(`/${AGENT}/config`)).json() as { revision: string };
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision: revision,
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

  test("one original revision admits one concurrent metadata or settings save", async () => {
    const app = await importAgentRoutes();
    const original = await (await app.request(`/${AGENT}/config`)).json() as { name: string; revision: string };
    expect(original.name).toBe("Models Config Agent");
    const responses = await Promise.all([
      app.request(`/${AGENT}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_revision: original.revision, name: "Renamed" }) }),
      app.request(`/${AGENT}/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_revision: original.revision, identityMd: "New identity" }) }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const rejected = await responses.find((r) => r.status === 409)!.json() as { code: string; retryable: boolean };
    expect(rejected).toMatchObject({ code: "REVISION_CONFLICT", retryable: false });
    const saved = await (await app.request(`/${AGENT}/config`)).json() as { name: string; identityMd?: string; revision: string };
    const receipt = await responses.find((r) => r.status === 200)!.json() as { revision: string };
    expect(saved.revision).toBe(receipt.revision);
    expect(saved.revision).not.toBe(original.revision);
    if (responses[0].status === 200) {
      expect(saved.name).toBe("Renamed");
      expect(saved.identityMd).not.toBe("New identity");
    } else {
      expect(saved.name).toBe(original.name);
      expect(saved.identityMd).toBe("New identity");
    }
  });

  test("settings require an original revision while runtime usage stamps leave it valid", async () => {
    const app = await importAgentRoutes();
    const original = await (await app.request(`/${AGENT}/config`)).json() as { revision: string };
    const missing = await app.request(`/${AGENT}/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ identityMd: "Blind edit" }) });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "REVISION_CONFLICT", retryable: false });
    const { getDb } = await import("../../db/client.js");
    await getDb()`UPDATE agents SET last_used_at = NOW(), updated_at = NOW() WHERE organization_id = ${ORG} AND id = ${AGENT}`;
    const saved = await app.request(`/${AGENT}/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_revision: original.revision, identityMd: "Guarded edit", sandboxId: null }) });
    expect(saved.status).toBe(200);
    const next = await saved.json() as { revision: string };
    const chained = await app.request(`/${AGENT}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_revision: next.revision, name: "Chained rename" }) });
    expect(chained.status).toBe(200);
    const state = await (await app.request(`/${AGENT}/config`)).json() as Record<string, unknown>;
    expect(state.name).toBe("Chained rename");
    expect(state.identityMd).toBe("Guarded edit");
    expect(state.sandboxId).toBeUndefined();
  });

  test("a deleted and recreated agent rejects the previous incarnation's revision", async () => {
    const app = await importAgentRoutes();
    const original = await (await app.request(`/${AGENT}/config`)).json() as { revision: string };
    const remove = await app.request(`/${AGENT}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_revision: original.revision }) });
    expect(remove.status).toBe(200);
    const recreate = await app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: AGENT, name: "Recreated" }) });
    expect(recreate.status).toBe(201);
    const receipt = await recreate.json() as { revision: string; created: boolean };
    expect(receipt.created).toBe(true);
    expect(receipt.revision).not.toBe(original.revision);
    const stale = await app.request(`/${AGENT}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_revision: original.revision }) });
    expect(stale.status).toBe(409);
    const duplicate = await app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: AGENT, name: "Must not overwrite" }) });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ created: false, name: "Recreated", revision: receipt.revision });
  });

});
