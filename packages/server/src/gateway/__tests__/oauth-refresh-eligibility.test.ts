/**
 * Refresh-eligibility regression for the OAuth-flow consolidation.
 *
 * The token-refresh job selects a stored profile for rotation via
 * `REFRESHABLE_AUTH_TYPES.has(profile.authType) && !!profile.metadata.refreshToken`.
 * The two literals — `"oauth"` (Claude) and `"device-code"` (ChatGPT) — are the
 * EXACT strings the flow persists. A silent rename during consolidation would
 * leave already-signed-in users' tokens un-refreshed ~1h after sign-in,
 * invisibly. This pins both:
 *
 *   1. Both provider configs still carry their exact `authType` literal, and
 *      both are members of `REFRESHABLE_AUTH_TYPES` (the eligibility predicate).
 *   2. `scanAllOAuth` (LEFT JOIN agents + COALESCE) surfaces an ORG-BUCKET row
 *      (`agent_id = "__org_oauth__:<org>"`, no agents row, `organization_id`
 *      set on the row) with the right org — the fix that keeps org-bucket tokens
 *      refreshing. A plain per-agent row still resolves its org via the join.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PostgresSecretStore } from "../../lobu/stores/postgres-secret-store.js";
import {
  TEST_CHATGPT_OAUTH,
  TEST_CLAUDE_OAUTH,
} from "../auth/oauth/__tests__/fixtures.js";
import {
  isOrgBucketAgentId,
  orgBucketAgentId,
  REFRESHABLE_AUTH_TYPES,
  UserAuthProfileStore,
} from "../auth/settings/user-auth-profile-store.js";
import {
  ensureDbForGatewayTests,
  ensureEncryptionKey,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG = "org-refresh";

let store: UserAuthProfileStore;

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  ensureEncryptionKey();
  await resetTestDatabase();
  store = new UserAuthProfileStore(new PostgresSecretStore());
});

describe("OAuth refresh eligibility", () => {
  test("both provider configs carry their exact refreshable authType literal", () => {
    expect(TEST_CLAUDE_OAUTH.authType).toBe("oauth");
    expect(TEST_CHATGPT_OAUTH.authType).toBe("device-code");
    // The refresh job's Set is keyed on these exact strings.
    expect(REFRESHABLE_AUTH_TYPES.has(TEST_CLAUDE_OAUTH.authType!)).toBe(true);
    expect(REFRESHABLE_AUTH_TYPES.has(TEST_CHATGPT_OAUTH.authType!)).toBe(true);
    // A stored api-key profile must NOT be selected.
    expect(REFRESHABLE_AUTH_TYPES.has("api-key")).toBe(false);
  });

  test("the eligibility predicate selects both an oauth and a device-code profile", async () => {
    await seedAgentRow("agent-1", { organizationId: ORG });
    await store.upsert("u1", "agent-1", {
      id: "claude-1",
      provider: "claude",
      credential: "sk-ant-oat01",
      authType: "oauth",
      label: "Claude",
      model: "*",
      createdAt: 0,
      metadata: { refreshToken: "rt-claude", expiresAt: 1 },
    });
    await store.upsert(
      "u1",
      "agent-1",
      {
        id: "chatgpt-1",
        provider: "chatgpt",
        credential: "chatgpt-access",
        authType: "device-code",
        label: "ChatGPT",
        model: "*",
        createdAt: 0,
        metadata: { refreshToken: "rt-chatgpt", expiresAt: 1 },
      },
      { makePrimary: false },
    );

    const profiles = await store.list("u1", "agent-1");
    // Replicate the exact predicate `doRefresh` uses on stored profiles.
    const eligible = profiles.filter(
      (p) =>
        REFRESHABLE_AUTH_TYPES.has(p.authType) && !!p.metadata?.refreshTokenRef,
    );
    const eligibleTypes = eligible.map((p) => p.authType).sort();
    expect(eligibleTypes).toEqual(["device-code", "oauth"]);
  });

  test("scanAllOAuth surfaces an org-bucket row via LEFT JOIN + COALESCE", async () => {
    // A normal per-agent row (org derived via the agents join).
    await seedAgentRow("agent-1", { organizationId: ORG });
    await store.upsert("u1", "agent-1", {
      id: "claude-1",
      provider: "claude",
      credential: "sk-ant-oat01",
      authType: "oauth",
      label: "Claude",
      model: "*",
      createdAt: 0,
      metadata: { refreshToken: "rt-claude", expiresAt: 1 },
    });

    // An ORG-BUCKET row: NO agents row, org lives on the row's column.
    const bucketAgentId = orgBucketAgentId(ORG);
    expect(isOrgBucketAgentId(bucketAgentId)).toBe(true);
    await store.upsert(
      "u1",
      bucketAgentId,
      {
        id: "org-claude-1",
        provider: "claude",
        credential: "sk-ant-oat01-org",
        authType: "oauth",
        label: "Claude (org)",
        model: "*",
        createdAt: 0,
        metadata: { refreshToken: "rt-org", expiresAt: 1 },
      },
      { organizationId: ORG },
    );

    const seen = new Map<string, string>();
    for await (const ref of store.scanAllOAuth()) {
      seen.set(ref.agentId, ref.organizationId);
    }
    // Both rows are surfaced, each with the right org — the org-bucket one via
    // the column (no agents row), the plain one via the join.
    expect(seen.get("agent-1")).toBe(ORG);
    expect(seen.get(bucketAgentId)).toBe(ORG);

    // And the direct read the refresh job uses for org-bucket ids works.
    expect(await store.getOrganizationId("u1", bucketAgentId)).toBe(ORG);
  });
});
