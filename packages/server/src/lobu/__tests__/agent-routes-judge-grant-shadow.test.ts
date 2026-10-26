/**
 * An allow grant BEATS the egress judge. `checkDomainAccess` (gateway/proxy/
 * http-proxy.ts) consults per-agent allow grants BEFORE the judge, so a domain
 * that is both judged and allow-granted returns `source: "grant"` and its judge
 * policy never runs. The request still succeeds, which is why nobody notices.
 *
 * PATCH `/:agentId/config` rejects that combination (400
 * `guardrail_domain_shadowed_by_grant`). These tests drive the real `agentRoutes`
 * Hono app over the embedded-PG harness, because the part that cannot be
 * covered by a pure unit test is the MERGE: a PATCH may carry `guardrailsInline`
 * alone, `networkConfig` alone, or both, and the hole only exists in the
 * combination of the patch with what is already stored.
 *
 * Pure matching/normalization coverage for `findSuppressedJudgedDomains` lives
 * in `gateway/__tests__/policy-store.test.ts`.
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
const ORG = "org-judge-shadow";
const AGENT = "judge-shadow-agent";

const JUDGE = {
  name: "watchdog",
  stage: "egress",
  enabled: true,
  policy: "Allow read-only GETs.",
  domains: ["example.com"],
  // Named explicitly so the route's judge-model check cannot be what rejects.
  model: "openai/gpt-4o-mini",
};

async function seedOrgAndAgent(): Promise<void> {
  const { getDb } = await import("../../db/client.js");
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG}) ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO agents (id, organization_id, name)
    VALUES (${AGENT}, ${ORG}, 'Judge Shadow Agent')
    ON CONFLICT (organization_id, id) DO NOTHING
  `;
}

/** Write settings straight to the row, bypassing the route's validation. */
async function storeSettings(settings: Record<string, unknown>): Promise<void> {
  const { getDb } = await import("../../db/client.js");
  const sql = getDb();
  for (const [column, value] of Object.entries({
    guardrails_inline: settings.guardrailsInline ?? [],
    network_config: settings.networkConfig ?? {},
  })) {
    await sql`
      UPDATE agents SET ${sql(column)} = ${sql.json(value as object)}
      WHERE organization_id = ${ORG} AND id = ${AGENT}
    `;
  }
}

async function patchConfig(body: unknown) {
  const { agentRoutes } = await import("../agent-routes.js");
  return agentRoutes.request(`/${AGENT}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  // The route resolves every NEW judge model against the provider registry
  // before it reaches the shadowing check, so `JUDGE.model` needs a registry
  // and a system key or `guardrail_model_unresolvable` is the rejection.
  process.env.LOBU_PROVIDER_REGISTRY_PATH = new URL(
    "../../../../../config/providers.json",
    import.meta.url
  ).pathname;
  process.env.OPENAI_API_KEY ||= "sk-test-deployment-owned";
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

describe("PATCH /config — a judged domain must not be allow-granted", () => {
  test("rejects when ONE patch carries both sides", async () => {
    const res = await patchConfig({
      guardrailsInline: [JUDGE],
      networkConfig: { allowedDomains: ["example.com"] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(body.error).toBe("guardrail_domain_shadowed_by_grant");
    // The message must name all three parties or the operator cannot act on it.
    expect(body.error_description).toContain("watchdog");
    expect(body.error_description).toContain("example.com");
  });

  test("rejects a guardrail patch that collides with the STORED allow list", async () => {
    await storeSettings({ networkConfig: { allowedDomains: ["example.com"] } });
    const res = await patchConfig({ guardrailsInline: [JUDGE] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "guardrail_domain_shadowed_by_grant"
    );
  });

  test("rejects a networkConfig patch that collides with the STORED guardrail", async () => {
    await storeSettings({ guardrailsInline: [JUDGE] });
    const res = await patchConfig({
      networkConfig: { allowedDomains: ["example.com"] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "guardrail_domain_shadowed_by_grant"
    );
  });

  test("rejects when a stored WILDCARD grant covers a newly judged subdomain", async () => {
    await storeSettings({
      networkConfig: { allowedDomains: ["*.example.com"] },
    });
    const res = await patchConfig({
      guardrailsInline: [{ ...JUDGE, domains: ["api.example.com"] }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "guardrail_domain_shadowed_by_grant"
    );
  });

  // ── the config must still be repairable, and healthy configs must save ──
  test("accepts a judged domain with NO grant (the correct shape)", async () => {
    const res = await patchConfig({
      guardrailsInline: [JUDGE],
      networkConfig: { allowedDomains: [] },
    });
    expect(res.status).toBe(200);
  });

  test("accepts a grant for an UNRELATED domain alongside a judge", async () => {
    const res = await patchConfig({
      guardrailsInline: [JUDGE],
      networkConfig: { allowedDomains: ["example.org"] },
    });
    expect(res.status).toBe(200);
  });

  test("REPAIR: removing the grant saves, even from a shadowed stored state", async () => {
    await storeSettings({
      guardrailsInline: [JUDGE],
      networkConfig: { allowedDomains: ["example.com"] },
    });
    const res = await patchConfig({ networkConfig: { allowedDomains: [] } });
    expect(res.status).toBe(200);
  });

  test("REPAIR: dropping the guardrail saves, even from a shadowed stored state", async () => {
    await storeSettings({
      guardrailsInline: [JUDGE],
      networkConfig: { allowedDomains: ["example.com"] },
    });
    const res = await patchConfig({ guardrailsInline: [] });
    expect(res.status).toBe(200);
  });

  test("an UNRELATED patch is not blocked by a pre-existing shadowed state", async () => {
    // Rejecting here would lock the agent out of edits it cannot use to repair
    // the overlap — the same reasoning that grandfathers stored judge models.
    await storeSettings({
      guardrailsInline: [JUDGE],
      networkConfig: { allowedDomains: ["example.com"] },
    });
    const res = await patchConfig({ skillsConfig: { skills: [] } });
    expect(res.status).toBe(200);
  });
});
