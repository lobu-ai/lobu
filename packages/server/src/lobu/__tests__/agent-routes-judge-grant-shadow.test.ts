/**
 * An allow grant BEATS the egress judge. `checkDomainAccess` (gateway/proxy/
 * http-proxy.ts) consults per-agent allow grants BEFORE the judge, so a domain
 * that is both judged and allow-granted returns `source: "grant"` and its judge
 * policy never runs. The request still succeeds, which is why nobody notices.
 *
 * PATCH `/:agentId/config` rejects an allow list that collides with an egress
 * judge from the workspace guardrail library that applies to the agent (400
 * `guardrail_domain_shadowed_by_grant`). These tests drive the real
 * `agentRoutes` Hono app over the embedded-PG harness, because the part a pure
 * unit test cannot cover is the read: which library guardrails apply to the
 * agent being patched.
 *
 * Pure matching/normalization coverage for `findSuppressedJudgedDomains` lives
 * in `gateway/__tests__/policy-store.test.ts`.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createTestWorkspaceGuardrail } from "../../__tests__/setup/test-fixtures.js";
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

const OTHER_AGENT = "judge-shadow-other";

/** Seed an egress judge in the library, applying to `agentId` (AGENT by default). */
function seedJudge(
  name: string,
  domains: string[],
  agentId: string = AGENT
): Promise<unknown> {
  return createTestWorkspaceGuardrail({
    organizationId: ORG,
    name,
    config: {
      kind: "judge",
      stage: "egress",
      policy: "Allow read-only GETs.",
      domains,
    },
    appliesTo: [{ kind: "agent", id: agentId }],
  });
}

async function seedOrgAndAgent(): Promise<void> {
  const { getDb } = await import("../../db/client.js");
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG}) ON CONFLICT (id) DO NOTHING
  `;
  for (const id of [AGENT, OTHER_AGENT]) {
    await sql`
      INSERT INTO agents (id, organization_id, name)
      VALUES (${id}, ${ORG}, ${id})
      ON CONFLICT (organization_id, id) DO NOTHING
    `;
  }
}

/** Write the allow list straight to the row, bypassing the route's validation. */
async function storeAllowedDomains(allowedDomains: string[]): Promise<void> {
  const { getDb } = await import("../../db/client.js");
  await getDb()`
    UPDATE agents SET network_config = ${getDb().json({ allowedDomains })}
    WHERE organization_id = ${ORG} AND id = ${AGENT}
  `;
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
  test("rejects an allow list that collides with a library judge", async () => {
    await seedJudge("watchdog", ["example.com"]);
    const res = await patchConfig({
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

  test("names EVERY judge a grant silences, not just one", async () => {
    // Every judge covering a host runs, so one grant over a domain judged by
    // two guardrails hides both — the operator must see both to repair it.
    await seedJudge("watchdog", ["example.com"]);
    await seedJudge("second-watch", ["example.com"]);
    const res = await patchConfig({
      networkConfig: { allowedDomains: ["example.com"] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_description?: string };
    expect(body.error_description).toContain("watchdog");
    expect(body.error_description).toContain("second-watch");
  });

  test("rejects a WILDCARD grant that covers a judged subdomain", async () => {
    await seedJudge("watchdog", ["api.example.com"]);
    const res = await patchConfig({
      networkConfig: { allowedDomains: ["*.example.com"] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "guardrail_domain_shadowed_by_grant"
    );
  });

  // ── the config must still be repairable, and healthy configs must save ──
  test("accepts a judged domain with NO grant (the correct shape)", async () => {
    await seedJudge("watchdog", ["example.com"]);
    const res = await patchConfig({ networkConfig: { allowedDomains: [] } });
    expect(res.status).toBe(200);
  });

  test("accepts a grant for an UNRELATED domain alongside a judge", async () => {
    await seedJudge("watchdog", ["example.com"]);
    const res = await patchConfig({
      networkConfig: { allowedDomains: ["example.org"] },
    });
    expect(res.status).toBe(200);
  });

  test("a judge that applies to ANOTHER agent does not block this one", async () => {
    await seedJudge("watchdog", ["example.com"], OTHER_AGENT);
    const res = await patchConfig({
      networkConfig: { allowedDomains: ["example.com"] },
    });
    expect(res.status).toBe(200);
  });

  test("REPAIR: removing the grant saves, even from a shadowed stored state", async () => {
    await seedJudge("watchdog", ["example.com"]);
    await storeAllowedDomains(["example.com"]);
    const res = await patchConfig({ networkConfig: { allowedDomains: [] } });
    expect(res.status).toBe(200);
  });

  test("an UNRELATED patch is not blocked by a pre-existing shadowed state", async () => {
    // Rejecting here would lock the agent out of edits it cannot use to repair
    // the overlap.
    await seedJudge("watchdog", ["example.com"]);
    await storeAllowedDomains(["example.com"]);
    const res = await patchConfig({ soulMd: "An unrelated edit." });
    expect(res.status).toBe(200);
  });
});
