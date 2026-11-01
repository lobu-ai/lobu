/**
 * Agent management-mutation access: only org owner/admin — a web session, or
 * a PAT/OAuth token carrying `mcp:admin` — may PATCH/DELETE an agent or
 * rewrite its config. `mcp:admin` alone is not enough: the caller's member
 * role must be owner/admin regardless of auth source. A plain org MEMBER must
 * get 403 on all three surfaces — and on the sibling mutations in the same
 * router: agent create and every inference-provider mutation (org-level
 * credentials) — and the sandbox mutations, which are the same tier of
 * org-level credential on a neighbouring router.
 *
 * Regression for the decision-brief finding: `requireSessionOrAdminPat` alone
 * lets any member rewrite/delete another member's agent (and change its
 * soulMd/guardrails/tool surface) via the REST routes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import {
  authStash,
  coreServicesStash,
  installRouteTestMocks,
} from "./helpers/route-test-mocks";

installRouteTestMocks();

const ORG = "org-manage-access";
const AGENT = "manage-access-agent";
/** Mirrors the `authStash` default in ./helpers/route-test-mocks. */
const DEFAULT_MEMBER_ROLE = "owner";

async function seedOrgAndAgent(): Promise<void> {
  const { getDb } = await import("../../db/client.js");
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG}) ON CONFLICT (id) DO NOTHING
  `;
  // The metadata PATCH fires a config-audit event whose `created_by` references
  // `user.id` (events_created_by_fkey); seed the caller so that insert lands
  // instead of logging a dropped audit row.
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES ('u1', 'Test', 'u1@test', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO agents (id, organization_id, name)
    VALUES (${AGENT}, ${ORG}, 'Manage Access Agent')
    ON CONFLICT (organization_id, id) DO NOTHING
  `;
}

async function importAgentRoutes() {
  const mod = await import("../agent-routes.js");
  return mod.agentRoutes;
}

async function importSandboxRoutes() {
  const mod = await import("../sandbox-routes.js");
  return mod.sandboxRoutes;
}

/** Every `authStash` field this file overwrites, as found on entry. */
let stashOnEntry: typeof authStash;

beforeAll(async () => {
  stashOnEntry = { ...authStash };
  await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
  await seedOrgAndAgent();
  authStash.user = {
    id: "u1",
    name: "Test",
    email: "u1@test",
    emailVerified: true,
  };
  authStash.organizationId = ORG;
  authStash.authSource = "session";
  authStash.mcpAuthInfo = null;
  // `authStash` is process-wide and shared by every src/lobu route test (see
  // the helper's header): bun runs all files in ONE process, so a file that
  // leaves a non-default value here breaks whichever sibling runs next and
  // relies on the default. `deployment-routes.test.ts` already save/restores
  // around its own override. So reset to the helper default (`owner`) here,
  // let each test opt into `member` explicitly, and put the whole stash back
  // in `afterAll` — otherwise this file's role, org and user leak out of it.
  authStash.memberRole = DEFAULT_MEMBER_ROLE;
  coreServicesStash.services = null;
}, 30_000);

afterAll(() => {
  Object.assign(authStash, stashOnEntry);
});

describe("agent management mutations — role gate", () => {
  test("member: PATCH /config is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ soulMd: "override" }),
    });
    expect(res.status).toBe(403);
  });

  test("member: PATCH /:agentId (metadata) is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(403);
  });

  test("member: DELETE /:agentId is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}`, { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  test("owner: PATCH /config passes the gate (reaches handler validation)", async () => {
    authStash.memberRole = "owner";
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultModel: "openai/gpt-5" }),
    });
    // 400 (legacy field rejected by the handler) proves it cleared the gate;
    // a 403 would mean the role check wrongly blocked the owner.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "legacy_model_field"
    );
  });

  test("owner: PATCH /:agentId (metadata) succeeds", async () => {
    authStash.memberRole = "owner";
    const app = await importAgentRoutes();
    const { revision } = await (await app.request(`/${AGENT}/config`)).json() as { revision: string };
    const res = await app.request(`/${AGENT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", expected_revision: revision }),
    });
    expect(res.status).toBe(200);
  });

  test("member + PAT with mcp:admin is still denied (role is not authorizable by scope)", async () => {
    authStash.memberRole = "member";
    authStash.authSource = "pat";
    authStash.mcpAuthInfo = { scopes: ["mcp:admin"] };
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultModel: "openai/gpt-5" }),
    });
    expect(res.status).toBe(403);
  });

  test("owner + PAT with mcp:admin passes the gate", async () => {
    authStash.memberRole = "owner";
    authStash.authSource = "pat";
    authStash.mcpAuthInfo = { scopes: ["mcp:admin"] };
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultModel: "openai/gpt-5" }),
    });
    // Same 400-legacy-field marker: the owner's mcp:admin token passes the gate.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "legacy_model_field"
    );
  });

  // Sibling mutations in the same file: agent CREATE and every
  // inference-provider mutation. Inference providers are ORG-level
  // credentials (an API key / OAuth grant shared by every agent in the org),
  // so they sit on the same owner/admin tier as agent administration.
  test("member: POST / (create agent) is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "member-made", name: "Member Made" }),
    });
    expect(res.status).toBe(403);
  });

  test("owner: POST / (create agent) succeeds", async () => {
    authStash.memberRole = "owner";
    const app = await importAgentRoutes();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "owner-made", name: "Owner Made" }),
    });
    expect(res.status).toBe(201);
  });

  test("member: POST /inference-providers is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "openai", kind: "openai", apiKey: "sk-x" }),
    });
    expect(res.status).toBe(403);
  });

  test("owner: POST /inference-providers passes the gate (reaches handler validation)", async () => {
    authStash.memberRole = "owner";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // 400 (missing slug) proves it cleared the gate; 403 would mean the role
    // check wrongly blocked the owner.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("slug");
  });

  test("member: PUT /inference-providers/:slug/key is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers/openai/key", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-rotated" }),
    });
    expect(res.status).toBe(403);
  });

  test("owner: PUT /inference-providers/:slug/key passes the gate (reaches handler validation)", async () => {
    authStash.memberRole = "owner";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers/openai/key", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("value");
  });

  test("member: DELETE /inference-providers/:slug is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers/openai", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  test("owner: DELETE /inference-providers/:slug passes the gate (reaches lookup)", async () => {
    authStash.memberRole = "owner";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers/no-such-provider", {
      method: "DELETE",
    });
    // 404 (no such provider row) proves it cleared the gate.
    expect(res.status).toBe(404);
  });

  test("member: POST /inference-providers/oauth/start is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openai-codex" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_description?: string };
    expect(body.error_description).toContain("owner or admin");
  });

  // The remaining newly gated mutations. The owner side is proven by the
  // representative pairs above — every route shares the one
  // `requireManageAgentAccess` helper — so these assert only that each route
  // is actually wired to it.
  test("member: POST /inference-providers/oauth/complete is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers/oauth/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "openai-codex", code: "abc" }),
    });
    expect(res.status).toBe(403);
  });

  test("member: PUT /inference-providers/:slug is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Renamed" }),
    });
    expect(res.status).toBe(403);
  });

  test("member: PUT /inference-providers/:slug/default is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers/openai/default", {
      method: "PUT",
    });
    expect(res.status).toBe(403);
  });

  test("member: PUT /inference-providers/:slug/capabilities/:modality is denied", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request("/inference-providers/openai/capabilities/text", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5" }),
    });
    expect(res.status).toBe(403);
  });

  test("member: GET config stays readable (read is org-wide by decision)", async () => {
    authStash.memberRole = "member";
    const app = await importAgentRoutes();
    const res = await app.request(`/${AGENT}/config`);
    expect(res.status).toBe(200);
  });
});

describe("sandbox mutations — same org-credential role gate", () => {
  // A sandbox binds an org vault credential to a runtime provider, and deleting
  // one drops every dependent agent back to the built-in runtime. That is the
  // same blast radius as an inference provider, so it sits on the same tier —
  // `requireSessionOrAdminPat` alone let any member create, re-key or delete
  // one.
  test("member: POST / is denied", async () => {
    authStash.memberRole = "member";
    const app = await importSandboxRoutes();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sb", provider_kind: "daytona" }),
    });
    expect(res.status).toBe(403);
  });

  test("member: PUT /:id/credential is denied", async () => {
    authStash.memberRole = "member";
    const app = await importSandboxRoutes();
    const res = await app.request("/sb-1/credential", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: { api_key: "k" } }),
    });
    expect(res.status).toBe(403);
  });

  test("member: DELETE /:id is denied", async () => {
    authStash.memberRole = "member";
    const app = await importSandboxRoutes();
    const res = await app.request("/sb-1", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  test("member + PAT with mcp:admin is still denied on a sandbox mutation", async () => {
    authStash.memberRole = "member";
    authStash.authSource = "pat";
    authStash.mcpAuthInfo = { scopes: ["mcp:admin"] };
    const app = await importSandboxRoutes();
    const res = await app.request("/sb-1", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  test("owner: DELETE /:id clears the gate and reaches the handler", async () => {
    authStash.memberRole = "owner";
    const app = await importSandboxRoutes();
    const res = await app.request("/sb-1", { method: "DELETE" });
    // 404 (no such sandbox) proves the role gate passed; a 403 would mean the
    // owner was wrongly blocked.
    expect(res.status).toBe(404);
  });

  test("member: GET / stays readable (read is org-wide, as on agents)", async () => {
    authStash.memberRole = "member";
    const app = await importSandboxRoutes();
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });
});

describe("agent list wire keys", () => {
  // Owletto declares `automationCount` on AgentItem but reads nothing from it
  // today, so a key mismatch would surface as no type error and no broken
  // screen; this server-side assertion is the only thing that catches it.
  test("GET / exposes active automation rows as automationCount", async () => {
    const { getDb } = await import("../../db/client.js");
    // The archived row keeps `automationCount: 1` from passing on a mere
    // "some rows exist" read.
    await getDb()`
      INSERT INTO automations (
        id, organization_id, slug, name, managed_agent_id, created_by,
        automation_group_id, status
      ) VALUES (
        9001, ${ORG}, 'counted-automation', 'Counted Automation', ${AGENT},
        'u1', 9001, 'active'
      ), (
        9002, ${ORG}, 'archived-automation', 'Archived Automation', ${AGENT},
        'u1', 9002, 'archived'
      )
    `;
    const app = await importAgentRoutes();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents.find((item) => item.agentId === AGENT)).toMatchObject({
      agentId: AGENT,
      automationCount: 1,
    });
  });
});
