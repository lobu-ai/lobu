/**
 * Multi-replica contracts for the connection-row model (#1139 successor):
 *
 *  1. `connection_claims` lease: exactly ONE replica runs an exclusive
 *     (long-polling) connection. Two managers sharing a DB tick their claim
 *     loops; one wins, the other must not start. Lease handoff works via
 *     explicit release (shutdown) and via heartbeat expiry (pod death).
 *  2. Row-versioned hydration: a replica serving a connection re-hydrates
 *     when the stored row is newer (config edited on any replica) and tears
 *     down when the row is stopped/deleted — no cross-pod restart fan-out.
 *  3. `idx_agent_connections_slack_workspace`: the DB refuses a second
 *     non-stopped Slack connection for the same (org, workspace), closing
 *     the concurrent-install race.
 *
 * Two ChatInstanceManager instances against ONE embedded Postgres simulate
 * two replicas. Adapter startup is stubbed (network-free): hydrateFromRow is
 * replaced with a recorder that registers a fake instance, exactly like the
 * real path's outcome, while the claim SQL and ensure logic stay real.
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

async function buildReplica() {
  const { ChatInstanceManager } = await import("../chat-instance-manager.js");
  const { createPostgresAgentConnectionStore } = await import(
    "../../../lobu/stores/postgres-stores.js"
  );
  const { PostgresSecretStore } = await import(
    "../../../lobu/stores/postgres-secret-store.js"
  );
  const { SecretStoreRegistry } = await import("../../secrets/index.js");

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

  // Network-free start: register a fake instance the way the real
  // hydrateFromRow would, and record the call.
  manager.hydrateCalls = [] as string[];
  manager.hydrateFromRow = async (stored: any) => {
    manager.hydrateCalls.push(stored.id);
    manager.instances.set(stored.id, {
      connection: { id: stored.id, platform: stored.platform },
      chat: {},
      conversationState: {},
      messageBridge: {},
      rowVersion: stored.updatedAt,
    });
  };

  return { manager, connectionStore };
}

async function seedTelegramPolling(
  connectionStore: any,
  orgId: string,
  agentId: string,
	connectionId: string,
): Promise<void> {
  const { orgContext } = await import("../../../lobu/stores/org-context.js");
  await seedAgentRow(agentId, { organizationId: orgId });
  await orgContext.run({ organizationId: orgId }, async () => {
    await connectionStore.saveConnection({
      id: connectionId,
      platform: "telegram",
      agentId,
      organizationId: orgId,
      config: {
        platform: "telegram",
        botToken: "12345:fake",
        mode: "polling",
      },
      settings: { allowGroups: true },
      metadata: {},
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe("connection_claims lease (exclusive transports)", () => {
  test("exactly one of two replicas runs a polling connection; handoff on release and on expiry", async () => {
    const { getDb } = await import("../../../db/client.js");
    const { manager: a } = await buildReplica();
    const { manager: b, connectionStore } = await buildReplica();

		await seedTelegramPolling(
			connectionStore,
			"org-lease",
			"agent-lease",
			"conn-poll",
		);

    // Both replicas tick: exactly one must hold the instance.
    await a.exclusiveTick();
    await b.exclusiveTick();
    const aHas = a.instances.has("conn-poll");
    const bHas = b.instances.has("conn-poll");
    expect(aHas !== bHas).toBe(true);

    const owner = aHas ? a : b;
    const other = aHas ? b : a;

    // Renewal: the owner keeps the lease across ticks; the other still can't start.
    await owner.exclusiveTick();
    await other.exclusiveTick();
    expect(owner.instances.has("conn-poll")).toBe(true);
    expect(other.instances.has("conn-poll")).toBe(false);

    // Explicit release (clean shutdown): the peer claims on its next tick.
    await owner.shutdown();
    await other.exclusiveTick();
    expect(other.instances.has("conn-poll")).toBe(true);

    // Heartbeat expiry (pod death): age the claim past the TTL; a fresh
    // replica must be able to take over without any release.
    const { manager: c } = await buildReplica();
    await getDb()`
      UPDATE connection_claims
      SET heartbeat_at = now() - interval '120 seconds'
      WHERE connection_id = 'conn-poll'
    `;
    await c.exclusiveTick();
    expect(c.instances.has("conn-poll")).toBe(true);
    // The stale former owner loses on its next tick and stops its loop.
    await other.exclusiveTick();
    expect(other.instances.has("conn-poll")).toBe(false);
  });

  test("a TRANSIENT exclusive-start failure is retried automatically after backoff, with NO row edit", async () => {
    const { manager, connectionStore } = await buildReplica();
    await seedTelegramPolling(
      connectionStore,
      "org-transient",
      "agent-transient",
			"conn-transient",
    );

    // First hydrate throws (Telegram 5xx / DB blip class) — this leaves the
    // row errored. Subsequent hydrates succeed.
    let calls = 0;
    manager.hydrateFromRow = async (stored: any) => {
      calls += 1;
      if (calls === 1) throw new Error("transient boom (5xx)");
      manager.instances.set(stored.id, {
        connection: { id: stored.id, platform: stored.platform },
        chat: {},
        conversationState: {},
        messageBridge: {},
        rowVersion: stored.updatedAt,
      });
    };

    // Tick 1: claims the lease, hydrate throws → row errored, backoff scheduled.
    await manager.exclusiveTick();
    expect(manager.instances.has("conn-transient")).toBe(false);
    const errored = await connectionStore.getConnection("conn-transient");
    expect(errored!.status).toBe("error");
    expect(errored!.errorMessage ?? "").toContain("Startup failed");

    // A failure record exists and gates the very next tick (still in backoff).
    const failure = manager.exclusiveFailures.get("conn-transient");
    expect(failure).toBeDefined();
    await manager.exclusiveTick();
    expect(manager.instances.has("conn-transient")).toBe(false);
    expect(calls).toBe(1); // gated — no second hydrate attempt yet

    // Simulate elapsed backoff WITHOUT any config/row edit: the time-based gate
    // must now allow re-hydration. (Old code keyed retry purely on updated_at,
    // so it would NEVER retry without a human edit — this is the regression.)
		manager.exclusiveFailures.get("conn-transient").nextRetryAt =
			Date.now() - 1;
    await manager.exclusiveTick();
    expect(calls).toBe(2);
    expect(manager.instances.has("conn-transient")).toBe(true);
    // Success clears the failure record.
    expect(manager.exclusiveFailures.has("conn-transient")).toBe(false);
  });

  test("backoff accumulates across retries even when the transient error MESSAGE varies (no updated_at churn)", async () => {
    const { manager, connectionStore } = await buildReplica();
    await seedTelegramPolling(
      connectionStore,
      "org-vary",
      "agent-vary",
			"conn-vary",
    );

    // Every hydrate throws with a DIFFERENT message — real transient start
    // errors vary between attempts (ETIMEDOUT vs ECONNRESET, socket addresses,
    // request ids). The error STATUS must only be written on the first failure,
    // otherwise a changing message bumps updated_at every retry, resets the
    // backoff record (keyed on updated_at), and defeats the exponential backoff.
    let calls = 0;
    manager.hydrateFromRow = async () => {
      calls += 1;
      throw new Error(`transient boom #${calls}`);
    };

    // Tick 1: first failure → status written once, attempts = 1.
    await manager.exclusiveTick();
    const afterFirst = await connectionStore.getConnection("conn-vary");
    const v1 = afterFirst!.updatedAt;
    expect(manager.exclusiveFailures.get("conn-vary")!.attempts).toBe(1);

    // Elapse the backoff and retry — fails again with a DIFFERENT message.
    manager.exclusiveFailures.get("conn-vary")!.nextRetryAt = Date.now() - 1;
    await manager.exclusiveTick();
    expect(calls).toBe(2);

    const afterSecond = await connectionStore.getConnection("conn-vary");
    // The varying message must NOT re-write the status / bump updated_at...
    expect(afterSecond!.updatedAt).toBe(v1);
    // ...so the backoff keeps ACCUMULATING (attempts → 2) instead of resetting.
    expect(manager.exclusiveFailures.get("conn-vary")!.attempts).toBe(2);
  });

  test("removeConnection deletes the connection_claims lease row (no orphan)", async () => {
    const { getDb } = await import("../../../db/client.js");
    const { manager, connectionStore } = await buildReplica();
    await seedTelegramPolling(
      connectionStore,
      "org-rm",
      "agent-rm",
			"conn-rm-claim",
    );

    // Register a minimal instance whose conversationState is a no-op stub, so
    // removeConnection's history-cleanup is network/DB-free and the test
    // isolates the claim-row deletion (the semantics under test).
    manager.hydrateFromRow = async (stored: any) => {
      manager.instances.set(stored.id, {
        connection: { id: stored.id, platform: stored.platform },
        conversationState: { clearAllHistory: async () => 0 },
        rowVersion: stored.updatedAt,
      });
    };

    // Claim the lease for this connection.
    await manager.exclusiveTick();
    expect(manager.instances.has("conn-rm-claim")).toBe(true);
    const before = await getDb()`
      SELECT 1 FROM connection_claims WHERE connection_id = 'conn-rm-claim'
    `;
    expect(before.length).toBe(1);

    // Remove the connection: the lease row must be gone (no FK cascade exists).
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    await orgContext.run({ organizationId: "org-rm" }, () =>
			manager.removeConnection("conn-rm-claim"),
    );
    const after = await getDb()`
      SELECT 1 FROM connection_claims WHERE connection_id = 'conn-rm-claim'
    `;
    expect(after.length).toBe(0);
  });

  test("request paths never start an exclusive connection on a non-owner replica", async () => {
    const { manager: a } = await buildReplica();
    const { manager: b, connectionStore } = await buildReplica();
		await seedTelegramPolling(
			connectionStore,
			"org-req",
			"agent-req",
			"conn-poll-2",
		);

    await a.exclusiveTick();
    expect(a.instances.has("conn-poll-2")).toBe(true);

    // A webhook/fan-out path on the non-owner must refuse, not start a
    // second polling loop.
    const ok = await b.warmConnection("conn-poll-2");
    expect(ok).toBe(false);
    expect(b.instances.has("conn-poll-2")).toBe(false);
    expect(b.hydrateCalls).toEqual([]);
  });
});

describe("row-versioned lazy hydration (webhook transports)", () => {
  async function seedSlack(
    connectionStore: any,
    orgId: string,
    agentId: string,
		connectionId: string,
  ): Promise<void> {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    await seedAgentRow(agentId, { organizationId: orgId });
    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id: connectionId,
        platform: "slack",
        agentId,
        organizationId: orgId,
        config: { platform: "slack", botToken: "xoxb-fake" },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  test("a config edit on replica A re-hydrates replica B on next use; a stop tears it down", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { manager: a, connectionStore } = await buildReplica();
    const { manager: b } = await buildReplica();
    await seedSlack(connectionStore, "org-rv", "agent-rv", "conn-rv");

    // Replica B serves the connection (cold pod, lazy hydration).
    expect(await b.warmConnection("conn-rv")).toBe(true);
    expect(b.hydrateCalls).toEqual(["conn-rv"]);

    // Fresh memo: a second use does NOT re-hydrate.
    expect(await b.warmConnection("conn-rv")).toBe(true);
    expect(b.hydrateCalls).toEqual(["conn-rv"]);

    // Replica A edits the row (store bumps updated_at). The next use on B
    // must re-hydrate from the new row — no cross-pod fan-out involved.
    await new Promise((r) => setTimeout(r, 5));
    await orgContext.run({ organizationId: "org-rv" }, async () => {
      await connectionStore.updateConnection("conn-rv", {
        config: { platform: "slack", botToken: "xoxb-rotated" } as any,
      });
    });
    expect(await b.warmConnection("conn-rv")).toBe(true);
    expect(b.hydrateCalls).toEqual(["conn-rv", "conn-rv"]);

    // Replica A stops the row; B's next use tears its local instance down.
    await orgContext.run({ organizationId: "org-rv" }, async () => {
      await connectionStore.updateConnection("conn-rv", { status: "stopped" });
    });
    expect(await b.warmConnection("conn-rv")).toBe(false);
    expect(b.instances.has("conn-rv")).toBe(false);
    void a;
  });

  test("overlapping hydrations of one connection leave exactly one interaction bridge", async () => {
    const { InteractionService } = await import("../../interactions.js");
    const { manager, connectionStore } = await buildReplica();
    await seedSlack(connectionStore, "org-hf", "agent-hf", "conn-hf");

    // Real hydrate → startInstance → registerInteractionBridge path; only the
    // network-facing adapter and the state store are stubbed. Adapter startup
    // (Slack's auth.test) holds until a second start reaches it, so two starts
    // overlap the way a Slack @mention's `message` and `app_mention` webhooks
    // do; the timeout keeps a lone start moving.
    delete manager.hydrateFromRow;
    let waiting: Array<() => void> = [];
    const overlap = () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) {
          for (const release of waiting.splice(0)) release();
          return;
        }
        setTimeout(() => {
          waiting = waiting.filter((release) => release !== resolve);
          resolve();
        }, 250);
      });
    const interactions = new InteractionService();
    manager.services.getInteractionService = () => interactions;
    manager.services.getArtifactStore = () => undefined;
    manager.resolveConfigForRuntime = async (_id: string, config: unknown) => config;
    manager.ensurePlatformWebhookSecret = async () => {};
    manager.createStateAdapter = async () => ({
      connect: async () => {},
      disconnect: async () => {},
    });
    manager.createAdapter = async () => {
      await overlap();
      return { name: "slack", initialize: async () => {} };
    };
    const bridges = () => interactions.listenerCount("suggestion:created");

    // Two concurrent requests on a cold memo.
    expect(
      await Promise.all([
        manager.warmConnection("conn-hf"),
        manager.warmConnection("conn-hf"),
      ]),
    ).toEqual([true, true]);
    expect(bridges()).toBe(1);

    // A restart racing a request-path hydration replaces, never orphans.
    await manager.stopInstance("conn-hf");
    expect(bridges()).toBe(0);
    await Promise.all([
      manager.restartConnection("conn-hf"),
      manager.warmConnection("conn-hf"),
    ]);
    expect(bridges()).toBe(1);

    await manager.stopInstance("conn-hf");
    expect(bridges()).toBe(0);
  });
});

describe("updateConnection config rejection (parity with addConnection)", () => {
  test("flipping a Telegram connection to polling under cloud mode is refused before persist", async () => {
    const originalCloud = process.env.LOBU_CLOUD_MODE;
    process.env.LOBU_CLOUD_MODE = "1";
    try {
      const { orgContext } = await import(
        "../../../lobu/stores/org-context.js"
      );
      const { manager, connectionStore } = await buildReplica();
      await seedAgentRow("agent-upd-rej", { organizationId: "org-upd-rej" });
      await orgContext.run({ organizationId: "org-upd-rej" }, async () => {
        await connectionStore.saveConnection({
          id: "conn-upd-rej",
          platform: "telegram",
          agentId: "agent-upd-rej",
          organizationId: "org-upd-rej",
          config: {
            platform: "telegram",
            botToken: "12345:fake",
            mode: "webhook",
          },
          settings: { allowGroups: true },
          metadata: {},
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      });

      await expect(
        orgContext.run({ organizationId: "org-upd-rej" }, () =>
          manager.updateConnection("conn-upd-rej", {
            config: {
              platform: "telegram",
              botToken: "12345:fake",
              mode: "polling",
            },
					}),
				),
      ).rejects.toThrow(/Polling mode/);

      // The refused config must NOT have been persisted.
      const stored = await orgContext.run(
        { organizationId: "org-upd-rej" },
				() => connectionStore.getConnection("conn-upd-rej"),
      );
      expect((stored!.config as any).mode).toBe("webhook");
    } finally {
      if (originalCloud !== undefined) {
        process.env.LOBU_CLOUD_MODE = originalCloud;
      } else {
        delete process.env.LOBU_CLOUD_MODE;
      }
    }
  });

  test("a failing eager restart in updateConnection marks the persisted row errored", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { manager, connectionStore } = await buildReplica();
    await seedAgentRow("agent-upd-err", { organizationId: "org-upd-err" });
    await orgContext.run({ organizationId: "org-upd-err" }, async () => {
      await connectionStore.saveConnection({
        id: "conn-upd-err",
        platform: "slack",
        agentId: "agent-upd-err",
        organizationId: "org-upd-err",
        config: { platform: "slack", botToken: "xoxb-old" },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    manager.hydrateFromRow = async () => {
      throw new Error("adapter exploded");
    };

    await expect(
      orgContext.run({ organizationId: "org-upd-err" }, () =>
        manager.updateConnection("conn-upd-err", {
          config: { platform: "slack", botToken: "xoxb-broken" },
				}),
			),
    ).rejects.toThrow("adapter exploded");

    // The new config persisted (the edit isn't silently lost), but the row
    // must reflect that it cannot start — not sit `active` until next use.
    const stored = await orgContext.run({ organizationId: "org-upd-err" }, () =>
			connectionStore.getConnection("conn-upd-err"),
    );
    expect(stored!.status).toBe("error");
    expect(stored!.errorMessage ?? "").toContain("adapter exploded");
  });
});

describe("connections_active_chat_tenant (one active per workspace)", () => {
  test("a second active Slack connection for the same (org, teamId) DEMOTES the first", async () => {
    const { orgContext } = await import("../../../lobu/stores/org-context.js");
    const { connectionStore } = await buildReplica();
    await seedAgentRow("agent-slack-uniq", { organizationId: "org-uniq" });

    const row = (id: string) => ({
      id,
      platform: "slack",
      agentId: "agent-slack-uniq",
      organizationId: "org-uniq",
      config: { platform: "slack", botToken: "xoxb-1" },
      settings: { allowGroups: true },
      metadata: { teamId: "T0DUP" },
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const get = (id: string) =>
      orgContext.run({ organizationId: "org-uniq" }, () =>
        connectionStore.getConnection(id),
      );

    await orgContext.run({ organizationId: "org-uniq" }, async () => {
      await connectionStore.saveConnection(row("conn-uniq-1"));
    });

    // Activating a second connection for the SAME workspace is no longer
    // refused: the projection writer takes the one-active-per-tenant slot and
    // demotes the prior active sibling to 'paused' (→ 'stopped' on read), the
    // same way the Slack app-installation store does. The partial unique index
    // `connections_active_chat_tenant` is never contended because the demote
    // runs first in the same transaction.
    await orgContext.run({ organizationId: "org-uniq" }, async () => {
      await connectionStore.saveConnection(row("conn-uniq-2"));
    });
    expect((await get("conn-uniq-1"))?.status).toBe("stopped");
    expect((await get("conn-uniq-2"))?.status).toBe("active");

    // A stopped duplicate doesn't contend for the slot at all.
    await orgContext.run({ organizationId: "org-uniq" }, async () => {
      await connectionStore.saveConnection({
        ...row("conn-uniq-3"),
        status: "stopped" as const,
      });
    });
    expect((await get("conn-uniq-2"))?.status).toBe("active");
    expect((await get("conn-uniq-3"))?.status).toBe("stopped");

    // A different workspace in the same org keeps its own active slot.
    await orgContext.run({ organizationId: "org-uniq" }, async () => {
      await connectionStore.saveConnection({
        ...row("conn-uniq-4"),
        metadata: { teamId: "T0OTHER" },
      });
    });
    expect((await get("conn-uniq-2"))?.status).toBe("active");
    expect((await get("conn-uniq-4"))?.status).toBe("active");
  });
});
