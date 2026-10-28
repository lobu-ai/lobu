/**
 * restartConnection persists OUTSIDE org context (multi-replica HIGH bug).
 *
 * On a cold pod, an inbound platform event hits the public per-connection
 * webhook (`/api/v1/webhooks/:id`) or the notification fan-out
 * (`postMessageToChannel`) — neither carries an HTTP request's ALS org id.
 * Both lazily warm the connection via `ensureConnectionRunning()` →
 * `restartConnection()`, whose `persistConnection()` calls route through the
 * Postgres store's `saveConnection()`, which calls `getOrgId()` and THROWS
 * when no org context is bound. The throw aborts the restart and the inbound
 * message/notification is silently dropped.
 *
 * These tests seed a connection under its org, then invoke
 * `restartConnection` with NO orgContext.run() (mirroring the webhook path)
 * and assert the row is persisted correctly — covering BOTH the success
 * persist and the startInstance-failure error persist.
 *
 * Uses the embedded Postgres gateway test harness; no network (startInstance
 * is stubbed so we exercise only the org-context-wrapped persistence).
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
}, 30_000);

async function buildManager() {
  const { ChatInstanceManager } = await import("../chat-instance-manager.js");
  const { createPostgresAgentConnectionStore } = await import(
    "../../../lobu/stores/postgres-stores.js"
  );
  const { PostgresSecretStore } = await import(
    "../../../lobu/stores/postgres-secret-store.js"
  );
  const { SecretStoreRegistry } = await import("../../secrets/index.js");
  const { orgContext } = await import("../../../lobu/stores/org-context.js");

  const connectionStore = createPostgresAgentConnectionStore();
  const postgresSecretStore = new PostgresSecretStore();
  const secretStore = new SecretStoreRegistry(postgresSecretStore, {
    secret: postgresSecretStore,
  });

  const services = {
    getPublicGatewayUrl: () => "",
    getSecretStore: () => secretStore,
    getConnectionStore: () => connectionStore,
    getAutomationSubscriptionService: () => ({ resolveForConnection: async () => null }),
    getCommandRegistry: () => undefined,
  } as any;

  const manager = new ChatInstanceManager() as any;
  manager.services = services;
  manager.publicGatewayUrl = "";
  manager.connectionStore = connectionStore;

  return { manager, connectionStore, orgContext };
}

/** Seed a Telegram connection (with a secret-ref bot token) in `orgId`. */
async function seedConnection(
  connectionStore: any,
  orgContext: any,
  args: {
    orgId: string;
    agentId: string;
    connectionId: string;
    mode?: string;
  }
): Promise<void> {
  await seedAgentRow(args.agentId, { organizationId: args.orgId });
  await orgContext.run({ organizationId: args.orgId }, async () => {
    await connectionStore.saveConnection({
      id: args.connectionId,
      platform: "telegram",
      agentId: args.agentId,
      organizationId: args.orgId,
      config: {
        platform: "telegram",
        botToken: "12345:fake-token",
        ...(args.mode ? { mode: args.mode } : {}),
      },
      settings: { allowGroups: true },
      metadata: {},
      // Start from an errored row so restart's "recover to active" persist runs.
      status: "error",
      errorMessage: "previous boot failed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe("restartConnection org-context (multi-replica cold-pod webhook path)", () => {
  test("restartConnection succeeds and persists active status with NO ambient org context", async () => {
    const { manager, connectionStore, orgContext } = await buildManager();

    await seedConnection(connectionStore, orgContext, {
      orgId: "org-A",
      agentId: "agent-A",
      connectionId: "conn-A",
    });

    // Telegram with no public gateway URL resolves to long-polling — an
    // exclusive transport — so restartConnection only persists the status
    // reset (the claim runner owns the actual start). Trip the test if a
    // request path ever tries to start the polling loop directly.
    manager.startInstance = async () => {
      throw new Error("request path must not start an exclusive transport");
    };

    // No orgContext.run() — mirrors the public /api/v1/webhooks/:id route and
    // notification fan-out on a cold pod. Before the fix, persistConnection ->
    // saveConnection -> getOrgId() throws here and the inbound event is dropped.
    await manager.restartConnection("conn-A");

    // The success persist must have landed the active status, scoped to org-A.
    const after = await orgContext.run(
      { organizationId: "org-A" },
      async () => connectionStore.getConnection("conn-A")
    );
    expect(after).not.toBeNull();
    expect(after.status).toBe("active");
    expect(after.errorMessage ?? null).toBeNull();
  });

  test("restartConnection's startInstance-failure error persist also runs org-less", async () => {
    const { manager, connectionStore, orgContext } = await buildManager();

    await seedConnection(connectionStore, orgContext, {
      orgId: "org-B",
      agentId: "agent-B",
      connectionId: "conn-B",
      // Explicit webhook mode: NOT an exclusive transport, so restart takes
      // the hydrate path whose failure persist this test pins.
      mode: "webhook",
    });

    // startInstance fails (e.g. unresolvable secret) — restartConnection must
    // still persist the error status so the UI reflects it. That persist also
    // ran org-less before the fix and threw on getOrgId(), masking the real
    // failure (and the re-thrown error below would be getOrgId's, not ours).
    manager.startInstance = async (conn: any) => {
      conn.status = "error";
      conn.errorMessage = "boot blew up";
      throw new Error("boot blew up");
    };

    await expect(manager.restartConnection("conn-B")).rejects.toThrow(
      "boot blew up"
    );

    const after = await orgContext.run(
      { organizationId: "org-B" },
      async () => connectionStore.getConnection("conn-B")
    );
    expect(after).not.toBeNull();
    expect(after.status).toBe("error");
    expect(after.errorMessage).toBe("Startup failed: boot blew up");
  });
});
