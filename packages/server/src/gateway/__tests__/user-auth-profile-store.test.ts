import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { PostgresSecretStore } from "../../lobu/stores/postgres-secret-store.js";
import { UserAuthProfileStore } from "../auth/settings/user-auth-profile-store.js";
import {
  ensureEncryptionKey,
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

let secretStore: PostgresSecretStore;
let store: UserAuthProfileStore;

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  ensureEncryptionKey();
  await resetTestDatabase();
  secretStore = new PostgresSecretStore();
  store = new UserAuthProfileStore(secretStore);
});

describe("UserAuthProfileStore", () => {
  test("suspension is idempotent, preserves secrets, and cannot overwrite a reconnect", async () => {
    const stored = await store.upsert("u1", "agent-1", {
      id: "oauth-old",
      provider: "claude",
      credential: "test-access",
      authType: "oauth",
      label: "test",
      model: "*",
      createdAt: 0,
      metadata: { refreshToken: "test-refresh", expiresAt: 1 },
    });
    const suspend = (profileId: string) => getDb().begin((tx) =>
      store.suspendRefresh("u1", "agent-1", profileId, {
        code: "invalid_grant",
        at: 123,
      }, tx)
    );

    expect(await suspend(stored.id)).toBe("suspended");
    expect(await suspend(stored.id)).toBe("already-suspended");
    expect(await store.list("u1", "agent-1")).toEqual([{
      ...stored,
      metadata: {
        ...stored.metadata,
        refreshSuspended: { code: "invalid_grant", at: 123 },
      },
    }]);
    expect(await secretStore.get(stored.credentialRef!)).toBe("test-access");
    expect(await secretStore.get(stored.metadata!.refreshTokenRef!))
      .toBe("test-refresh");

    const reconnected = await store.upsert("u1", "agent-1", {
      ...stored,
      id: "oauth-new",
      credential: "new-access",
      metadata: { refreshToken: "new-refresh", expiresAt: Date.now() + 3600_000 },
    });
    expect(await suspend(stored.id)).toBe("missing");
    expect(await store.list("u1", "agent-1")).toEqual([reconnected]);
    expect(reconnected.metadata?.refreshSuspended).toBeUndefined();

    await store.remove("u1", "agent-1", { provider: "claude" });
    expect(await suspend(reconnected.id)).toBe("missing");
    expect(await store.list("u1", "agent-1")).toEqual([]);
  });

  test("upsert stores profile under (userId, agentId) and replaces credential with ref", async () => {
    const stored = await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "openai",
      credential: "sk-secret",
      authType: "api-key",
      label: "openai",
      model: "*",
      createdAt: 0,
    });

    expect(stored.credential).toBeUndefined();
    expect(stored.credentialRef).toBeDefined();
    expect(await secretStore.get(stored.credentialRef!)).toBe("sk-secret");

    const list = await store.list("u1", "agent-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("p1");
    expect(list[0]?.credentialRef).toBeDefined();
    expect(list[0]?.credential).toBeUndefined();
  });

  test("upsert persists refresh token through secret store", async () => {
    const stored = await store.upsert("u1", "agent-1", {
      id: "oauth-1",
      provider: "claude",
      credential: "access-token",
      authType: "oauth",
      label: "claude",
      model: "*",
      createdAt: 0,
      metadata: {
        refreshToken: "refresh-token-123",
        expiresAt: 9_999_999_999,
      },
    });

    expect(stored.metadata?.refreshToken).toBeUndefined();
    expect(stored.metadata?.refreshTokenRef).toBeDefined();
    expect(await secretStore.get(stored.metadata!.refreshTokenRef!)).toBe(
      "refresh-token-123"
    );
  });

  test("upsert with same (provider, model) replaces existing entry", async () => {
    await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "openai",
      credential: "sk-1",
      authType: "api-key",
      label: "old",
      model: "*",
      createdAt: 0,
    });
    await store.upsert("u1", "agent-1", {
      id: "p2",
      provider: "openai",
      credential: "sk-2",
      authType: "api-key",
      label: "new",
      model: "*",
      createdAt: 0,
    });

    const list = await store.list("u1", "agent-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("p2");
  });

  test("isolates profiles per user", async () => {
    await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "openai",
      credential: "sk-u1",
      authType: "api-key",
      label: "u1",
      model: "*",
      createdAt: 0,
    });
    await store.upsert("u2", "agent-1", {
      id: "p2",
      provider: "openai",
      credential: "sk-u2",
      authType: "api-key",
      label: "u2",
      model: "*",
      createdAt: 0,
    });

    expect(await store.list("u1", "agent-1")).toHaveLength(1);
    expect(await store.list("u2", "agent-1")).toHaveLength(1);
    expect(await store.list("u3", "agent-1")).toEqual([]);
  });

  test("remove drops profile and its secrets", async () => {
    const stored = await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "openai",
      credential: "sk-1",
      authType: "api-key",
      label: "u1",
      model: "*",
      createdAt: 0,
    });

    const result = await store.remove("u1", "agent-1", { provider: "openai" });
    expect(result.removed).toHaveLength(1);
    expect(result.secretsDeleted).toBeGreaterThan(0);
    expect(await store.list("u1", "agent-1")).toEqual([]);
    expect(await secretStore.get(stored.credentialRef!)).toBeNull();
  });

  test("dropAgent cascades through all secrets", async () => {
    const stored = await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "openai",
      credential: "sk-1",
      authType: "api-key",
      label: "u1",
      model: "*",
      createdAt: 0,
    });
    await store.dropAgent("u1", "agent-1");

    expect(await store.list("u1", "agent-1")).toEqual([]);
    expect(await secretStore.get(stored.credentialRef!)).toBeNull();
  });

  test("scanAllOAuth yields every (userId, agentId, organizationId) triple", async () => {
    // scanAllOAuth INNER JOINs agents to surface org id for org-context
    // wrapping in TokenRefreshJob, so the test fixtures need real agent rows.
    await seedAgentRow("agent-1", { organizationId: "org-a" });
    await seedAgentRow("agent-2", { organizationId: "org-b" });

    await store.upsert("u1", "agent-1", {
      id: "p1",
      provider: "claude",
      credential: "x",
      authType: "oauth",
      label: "x",
      model: "*",
      createdAt: 0,
    });
    await store.upsert("u2", "agent-2", {
      id: "p2",
      provider: "claude",
      credential: "y",
      authType: "oauth",
      label: "y",
      model: "*",
      createdAt: 0,
    });

    const refs: string[] = [];
    for await (const ref of store.scanAllOAuth()) {
      refs.push(`${ref.userId}:${ref.agentId}:${ref.organizationId}`);
    }
    expect(refs.sort()).toEqual(["u1:agent-1:org-a", "u2:agent-2:org-b"]);
  });

  test("scanAllOAuth skips profiles whose agent row is missing", async () => {
    // No seedAgentRow — the INNER JOIN should drop the orphaned profile
    // rather than yield it without an org. (Refresh job can't establish
    // org context for a deleted agent anyway.)
    await store.upsert("u1", "ghost-agent", {
      id: "p1",
      provider: "claude",
      credential: "x",
      authType: "oauth",
      label: "x",
      model: "*",
      createdAt: 0,
    });

    const refs: string[] = [];
    for await (const ref of store.scanAllOAuth()) {
      refs.push(`${ref.userId}:${ref.agentId}`);
    }
    expect(refs).toEqual([]);
  });
});
