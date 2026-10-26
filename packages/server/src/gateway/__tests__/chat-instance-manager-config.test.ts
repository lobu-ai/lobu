/**
 * Reproducers for two gateway/connections config-handling bugs:
 *
 *   #2 (security) — Telegram webhook forgeable when `secretToken` is unset.
 *       The adapter only verifies `x-telegram-bot-api-secret-token` when a
 *       secretToken is configured, and the public webhook route only checks
 *       the connection exists. `addConnection` must auto-generate a strong
 *       secretToken for Telegram connections created without one, persist it,
 *       and `configurePlatformWebhook` must register it via setWebhook so the
 *       adapter always verifies.
 *
 *   #8 — `configsEqual` was shallow (`!==` on top-level values), so a changed
 *       NESTED config field (e.g. an OAuth block or scopes array) compared
 *       equal by reference and `needsRestart` stayed false → a stale config
 *       persisted without restarting the adapter. The comparison must be deep.
 *
 * Uses the embedded Postgres gateway test harness; no network (fetch mocked).
 */

import { timingSafeEqual } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
}, 30_000);

async function buildManager(orgId: string, agentId: string) {
  await seedAgentRow(agentId, { organizationId: orgId });

  const { ChatInstanceManager } = await import(
    "../connections/chat-instance-manager.js"
  );
  const { createPostgresAgentConnectionStore } = await import(
    "../../lobu/stores/postgres-stores.js"
  );
  const { PostgresSecretStore } = await import(
    "../../lobu/stores/postgres-secret-store.js"
  );
  const { SecretStoreRegistry } = await import("../secrets/index.js");
  const { orgContext } = await import("../../lobu/stores/org-context.js");

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
  manager.slackCoordinator = manager.buildSlackCoordinator();

  return { manager, connectionStore, secretStore, orgContext };
}

describe("ChatInstanceManager — Telegram webhook secret (finding #2)", () => {
  test("addConnection auto-generates and persists a secretToken when none is supplied", async () => {
    const orgId = "org-tg-secret";
    const agentId = "agent-tg-secret";
    const { manager, connectionStore, secretStore, orgContext } =
      await buildManager(orgId, agentId);

    // Stub the adapter-boot side of addConnection so we exercise only the
    // auto-gen + persist path (booting a real Telegram adapter would hit the
    // network). The auto-gen happens before persistConnection regardless.
    manager.startInstance = async () => {
      /* no-op */
    };

    const created = await orgContext.run({ organizationId: orgId }, () =>
      manager.addConnection(
        "telegram",
        agentId,
        { platform: "telegram", botToken: "123456:fake-token" },
        { allowGroups: true }
      )
    );

    // The returned connection carries a strong (>=32 char) secretToken.
    const generated = created.config.secretToken as string;
    expect(typeof generated).toBe("string");
    expect(generated.length).toBeGreaterThanOrEqual(32);

    // It is persisted (as a `secret://` ref — "secretToken" is a secret field)
    // and resolves back to the generated value.
    const stored = await orgContext.run({ organizationId: orgId }, () =>
      connectionStore.getConnection(created.id)
    );
    expect(stored).not.toBeNull();
    const storedToken = (stored!.config as any).secretToken as string;
    expect(typeof storedToken).toBe("string");
    expect(storedToken.length).toBeGreaterThan(0);
    expect(storedToken.startsWith("secret://")).toBe(true);

    // The persisted ref resolves back to the generated value — so the adapter
    // gets the real token at boot and registers it via setWebhook.
    const resolved = await orgContext.run({ organizationId: orgId }, () =>
      secretStore.get(storedToken)
    );
    expect(resolved).toBe(generated);
  });

  test("addConnection preserves a caller-supplied secretToken", async () => {
    const orgId = "org-tg-keep";
    const agentId = "agent-tg-keep";
    const { manager, orgContext } = await buildManager(orgId, agentId);
    manager.startInstance = async () => {
      /* no-op */
    };

    const created = await orgContext.run({ organizationId: orgId }, () =>
      manager.addConnection(
        "telegram",
        agentId,
        {
          platform: "telegram",
          botToken: "123456:fake-token",
          secretToken: "caller-chosen-secret-token-value-1234",
        },
        { allowGroups: true }
      )
    );
    expect(created.config.secretToken).toBe(
      "caller-chosen-secret-token-value-1234"
    );
  });

  test("configurePlatformWebhook registers the secret_token via setWebhook", async () => {
    const orgId = "org-tg-hook";
    const agentId = "agent-tg-hook";
    const { manager } = await buildManager(orgId, agentId);

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as any;
    try {
      await manager.configurePlatformWebhook(
        {
          id: "conn-hook",
          platform: "telegram",
          config: {
            platform: "telegram",
            botToken: "123456:fake-token",
            secretToken: "the-generated-secret-token-abcdef0123",
          },
          settings: { allowGroups: true },
          metadata: {},
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        "https://gw.example.com/api/v1/webhooks/conn-hook"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("/setWebhook");
    const sentBody = JSON.parse(String(call[1].body));
    expect(sentBody.secret_token).toBe("the-generated-secret-token-abcdef0123");
    expect(sentBody.url).toBe(
      "https://gw.example.com/api/v1/webhooks/conn-hook"
    );
  });

  test("ensureTelegramWebhookSecret backfills + persists a token for an existing no-token connection", async () => {
    const orgId = "org-tg-backfill";
    const agentId = "agent-tg-backfill";
    const { manager, connectionStore, orgContext } = await buildManager(
      orgId,
      agentId
    );

    // Seed a Telegram row WITHOUT a secretToken — the pre-fix forgeable shape
    // for connections created before auto-generation existed.
    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id: "conn-legacy-tg",
        platform: "telegram",
        agentId,
        organizationId: orgId,
        config: { platform: "telegram", botToken: "123456:fake-token" },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    // Drive the backfill the way startInstanceUnscoped does (config already
    // resolved to plaintext; here it has no secretToken).
    const runtimeConnection: any = {
      id: "conn-legacy-tg",
      platform: "telegram",
      agentId,
      organizationId: orgId,
      config: { platform: "telegram", botToken: "123456:fake-token" },
      settings: { allowGroups: true },
      metadata: {},
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await orgContext.run({ organizationId: orgId }, () =>
      manager.ensureTelegramWebhookSecret(runtimeConnection)
    );

    // In-memory config now carries a strong plaintext token (so this boot's
    // adapter verifies it and configurePlatformWebhook registers it).
    const token = runtimeConnection.config.secretToken as string;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThanOrEqual(32);

    // The stored row gained a persisted (secret://-ref) token.
    const stored = await orgContext.run({ organizationId: orgId }, () =>
      connectionStore.getConnection("conn-legacy-tg")
    );
    const storedToken = (stored!.config as any).secretToken as string;
    expect(typeof storedToken).toBe("string");
    expect(storedToken.startsWith("secret://")).toBe(true);

    // A second backfill (e.g. another replica / a later restart) adopts the
    // already-persisted token instead of generating a fresh one.
    const secondConnection: any = {
      ...runtimeConnection,
      config: { platform: "telegram", botToken: "123456:fake-token" },
    };
    await orgContext.run({ organizationId: orgId }, () =>
      manager.ensureTelegramWebhookSecret(secondConnection)
    );
    expect(secondConnection.config.secretToken).toBe(token);
  });

  test("concurrent backfills for the same connection converge on one token (multi-replica)", async () => {
    const orgId = "org-tg-concurrent";
    const agentId = "agent-tg-concurrent";
    const { manager, connectionStore, secretStore, orgContext } =
      await buildManager(orgId, agentId);

    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id: "conn-concurrent-tg",
        platform: "telegram",
        agentId,
        organizationId: orgId,
        config: { platform: "telegram", botToken: "123456:fake-token" },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    // Two simulated replicas backfill the SAME legacy connection at once. The
    // row-locked claim must serialize them so both runtime configs (and the
    // persisted row) end up with one identical token — never divergent ones
    // that would leave a pod verifying a token Telegram no longer sends.
    const makeRuntime = () => ({
      id: "conn-concurrent-tg",
      platform: "telegram",
      agentId,
      organizationId: orgId,
      config: { platform: "telegram", botToken: "123456:fake-token" } as any,
      settings: { allowGroups: true },
      metadata: {},
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // Two replicas race at once: a naive get-then-save lets both see "no token"
    // before either persists, so they diverge. The row lock serializes them.
    // Two is enough to prove convergence; piling more concurrent row-locked
    // backfills onto CI's constrained Postgres pool starves the rest of the
    // suite (every later test's DB setup blocks until its hook timeout).
    const replicas = Array.from({ length: 2 }, makeRuntime);
    await orgContext.run({ organizationId: orgId }, () =>
      Promise.all(
        replicas.map((r) => manager.ensureTelegramWebhookSecret(r))
      )
    );

    const tokens = replicas.map((r) => r.config.secretToken as string);
    for (const t of tokens) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThanOrEqual(32);
    }
    // Every replica converged on a single token (no divergence).
    expect(new Set(tokens).size).toBe(1);

    // And it matches the single persisted row's token.
    const stored = await orgContext.run({ organizationId: orgId }, () =>
      connectionStore.getConnection("conn-concurrent-tg")
    );
    const storedRef = (stored!.config as any).secretToken as string;
    const resolvedStored = await orgContext.run(
      { organizationId: orgId },
      () => secretStore.get(storedRef)
    );
    expect(resolvedStored).toBe(tokens[0]);
    // Two row-locked backfills serialize on the connection row; allow headroom
    // over the 5s default for CI's slower Postgres.
  }, 15000);

  test("a chat connection id is globally unique — a second org cannot claim the same slug", async () => {
    // The retired agent_connections.id was a GLOBAL primary key, and orgless
    // runtime paths (the webhook URL, restart, claims) resolve a connection by
    // id alone. `connections_chat_slug_unique` restores that invariant: a live
    // chat slug is unique across ALL orgs, so a second org claiming the same
    // runtime id is rejected (rather than creating an ambiguous duplicate an
    // orgless lookup could route to the wrong tenant).
    const orgA = "org-tg-iso-a";
    const orgB = "org-tg-iso-b";
    const agentA = "agent-tg-iso-a";
    const agentB = "agent-tg-iso-b";
    const sharedId = "conn-shared-tg";
    const { connectionStore, orgContext } = await buildManager(orgA, agentA);
    await seedAgentRow(agentB, { organizationId: orgB });

    const make = (org: string, agent: string) => ({
      id: sharedId,
      platform: "telegram",
      agentId: agent,
      organizationId: org,
      config: { platform: "telegram", botToken: "123456:fake" },
      settings: { allowGroups: true },
      metadata: {},
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await orgContext.run({ organizationId: orgA }, () =>
      connectionStore.saveConnection(make(orgA, agentA))
    );
    // orgB claiming the same runtime id (→ same slug) is rejected.
    await expect(
      orgContext.run({ organizationId: orgB }, () =>
        connectionStore.saveConnection(make(orgB, agentB))
      )
    ).rejects.toThrow();

    // So an orgless lookup by that id is unambiguous: exactly one live row.
    const orglessHit = await connectionStore.getConnection(sharedId);
    expect(orglessHit?.organizationId).toBe(orgA);
  });
});

describe("ChatInstanceManager — Telegram webhook auth E2E (finding #2)", () => {
  // Drive the REAL webhook router (manager.handleWebhook, the exact path
  // POST /api/v1/webhooks/:id reaches) and assert the auto-generated secret is
  // enforced: missing/wrong x-telegram-bot-api-secret-token → 401, correct →
  // accepted; no-secret connection → unverified-accept (the forgeable hazard
  // the fix closes).
  //
  // The registered instance is a STUB whose `chat.webhooks.telegram` mirrors
  // the @chat-adapter/telegram verification contract (constant-time compare of
  // the header against the configured secretToken; reject when configured and
  // missing/mismatched, accept otherwise). We deliberately do NOT instantiate
  // the real Chat SDK / telegram adapter here: booting it opens a background
  // socket (bot-identity fetch / long-poll machinery) that hangs for 30s in
  // CI's network sandbox and poisons the shared bun:test process, cascading
  // timeouts across the suite. The Lobu fix under test is the secret auto-gen/
  // backfill + the manager routing webhooks to the instance — both fully
  // exercised here with zero sockets. (Adapter-side verification is the SDK's
  // own contract, covered by its own tests.)

  function makeTelegramWebhookStub(secretToken: string | undefined) {
    return async (request: Request): Promise<Response> => {
      if (secretToken) {
        const header = request.headers.get("x-telegram-bot-api-secret-token");
        let valid = false;
        try {
          valid =
            !!header &&
            timingSafeEqual(Buffer.from(header), Buffer.from(secretToken));
        } catch {
          valid = false;
        }
        if (!valid) {
          return new Response("Invalid secret token", { status: 401 });
        }
      }
      return new Response("OK", { status: 200 });
    };
  }

  function registerStubInstance(
    manager: any,
    orgId: string,
    connectionId: string,
    secretToken: string | undefined
  ): void {
    manager.instances.set(connectionId, {
      connection: {
        id: connectionId,
        platform: "telegram",
        organizationId: orgId,
        config: {
          platform: "telegram",
          botToken: "123456:fake-token",
          ...(secretToken ? { secretToken } : {}),
        },
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      chat: { webhooks: { telegram: makeTelegramWebhookStub(secretToken) } },
      conversationState: { listHistoryChannels: async () => [] },
      messageBridge: {},
    });
  }

  function webhookRequest(connectionId: string, secretHeader?: string) {
    return new Request(
      `https://gw.example.com/api/v1/webhooks/${connectionId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secretHeader
            ? { "x-telegram-bot-api-secret-token": secretHeader }
            : {}),
        },
        body: JSON.stringify({ update_id: 1 }),
      }
    );
  }

  test("auto-generated secret is enforced: wrong/missing rejected, correct accepted", async () => {
    const orgId = "org-tg-e2e";
    const agentId = "agent-tg-e2e";
    const { manager, connectionStore, secretStore, orgContext } =
      await buildManager(orgId, agentId);

    // Stub the heavy adapter-boot (full services) — we drive the real webhook
    // router against a registered stub instance below. Telegram with no
    // public gateway URL is an exclusive transport, so also silence the
    // claim runner: its async tick would otherwise race this test's stub
    // instance (hydrate stops the stub, the stubbed start registers
    // nothing, and the webhook 404s).
    manager.startInstance = async () => {
      /* exercised via registerStubInstance below */
    };
    manager.exclusiveTick = async () => {
      /* lease-owned start path not under test here */
    };
    const created = await orgContext.run({ organizationId: orgId }, () =>
      manager.addConnection(
        "telegram",
        agentId,
        { platform: "telegram", botToken: "123456:fake-token" },
        { allowGroups: true }
      )
    );

    // addConnection auto-generated a strong secretToken.
    const realToken = created.config.secretToken as string;
    expect(typeof realToken).toBe("string");
    expect(realToken.length).toBeGreaterThanOrEqual(32);

    // Persisted as a resolvable ref.
    const stored = await orgContext.run({ organizationId: orgId }, () =>
      connectionStore.getConnection(created.id)
    );
    const storedRef = (stored!.config as any).secretToken as string;
    expect(storedRef.startsWith("secret://")).toBe(true);
    const resolved = await orgContext.run({ organizationId: orgId }, () =>
      secretStore.get(storedRef)
    );
    expect(resolved).toBe(realToken);

    // Register a running instance carrying the auto-generated token and drive
    // the REAL manager.handleWebhook routing (instance.chat.webhooks.telegram).
    registerStubInstance(manager, orgId, created.id, realToken);

    // No secret header → forged webhook REJECTED (401), never dispatched.
    const noHeader = await manager.handleWebhook(
      created.id,
      webhookRequest(created.id)
    );
    expect(noHeader.status).toBe(401);

    // Wrong secret → REJECTED.
    const wrong = await manager.handleWebhook(
      created.id,
      webhookRequest(created.id, "definitely-not-the-secret")
    );
    expect(wrong.status).toBe(401);

    // Correct (auto-generated) secret → ACCEPTED.
    const right = await manager.handleWebhook(
      created.id,
      webhookRequest(created.id, realToken)
    );
    expect(right.status).not.toBe(401);
  }, 5000);

  test("a connection with NO secret token is forgeable (the pre-fix hazard)", async () => {
    // Pins the vulnerability the auto-gen + backfill close: when no secretToken
    // is configured the webhook is accepted unverified. This is why
    // addConnection auto-generates and startInstance backfills — so this state
    // is never reached in practice.
    const orgId = "org-tg-e2e-vuln";
    const agentId = "agent-tg-e2e-vuln";
    const { manager, orgContext } = await buildManager(orgId, agentId);

    registerStubInstance(manager, orgId, "conn-no-secret", undefined);
    // No secretToken → an unsigned forged update is ACCEPTED with no check.
    const res = await manager.handleWebhook(
      "conn-no-secret",
      webhookRequest("conn-no-secret")
    );
    expect(res.status).not.toBe(401);
  }, 5000);
});

describe("ChatInstanceManager — config change detection (finding #8)", () => {
  // updateConnection restarts only `active` connections. We seed the row as
  // `stopped` so no adapter boot is attempted; we observe needsRestart's effect
  // indirectly via whether stopInstance/startInstance run. Cleaner: spy on the
  // private startInstance + stopInstance and assert they fire (or not) for a
  // nested change. We keep status `active` but stub both lifecycle hooks.
  let restored: (() => void) | null = null;
  afterEach(() => {
    restored?.();
    restored = null;
  });

  async function seedActiveConnection(
    manager: any,
    connectionStore: any,
    orgContext: any,
    orgId: string,
    agentId: string,
    config: Record<string, unknown>
  ): Promise<string> {
    const id = "conn-cfg";
    await orgContext.run({ organizationId: orgId }, async () => {
      await connectionStore.saveConnection({
        id,
        platform: config.platform,
        agentId,
        organizationId: orgId,
        config,
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    // Pretend the instance is warm so updateConnection's `active` branch runs.
    manager.instances.set(id, {
      connection: {
        id,
        platform: config.platform,
        agentId,
        organizationId: orgId,
        config,
        settings: { allowGroups: true },
        metadata: {},
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      chat: {},
      conversationState: {},
      messageBridge: {},
    });
    return id;
  }

  test("a changed NESTED config field flips needsRestart to true", async () => {
    const orgId = "org-cfg-nested";
    const agentId = "agent-cfg-nested";
    const { manager, connectionStore, orgContext } = await buildManager(
      orgId,
      agentId
    );

    // Discord config with a nested object/array that differs only deep down.
    const initialConfig = {
      platform: "discord",
      botToken: "tok-1",
      mentionRoleIds: ["role-A", "role-B"],
    };
    const id = await seedActiveConnection(
      manager,
      connectionStore,
      orgContext,
      orgId,
      agentId,
      initialConfig
    );

    let stopped = 0;
    let started = 0;
    const origStop = manager.stopInstance.bind(manager);
    const origStart = manager.startInstance.bind(manager);
    manager.stopInstance = async (cid: string) => {
      stopped++;
      manager.instances.delete(cid);
    };
    manager.startInstance = async (conn: any) => {
      started++;
      // Mirror real registration: updateConnection's hydrate path verifies
      // the instance registered and stamps its rowVersion.
      manager.instances.set(conn.id, {
        connection: conn,
        chat: {},
        conversationState: {},
        messageBridge: {},
        rowVersion: conn.updatedAt,
      });
    };
    restored = () => {
      manager.stopInstance = origStop;
      manager.startInstance = origStart;
    };

    // Change only a nested array element. A shallow compare sees the array
    // reference differ from the resolved-previous (also reconstructed), but the
    // ORIGINAL bug compared the *same* nested reference and missed real changes.
    // Concretely: re-applying an identical config must NOT restart, while a
    // genuine nested change MUST restart. Test the genuine-change direction.
    await orgContext.run({ organizationId: orgId }, () =>
      manager.updateConnection(id, {
        config: {
          platform: "discord",
          botToken: "tok-1",
          mentionRoleIds: ["role-A", "role-CHANGED"],
        },
      })
    );

    expect(started).toBe(1);
    expect(stopped).toBe(1);
  });

  test("re-applying an identical nested config does NOT restart", async () => {
    const orgId = "org-cfg-same";
    const agentId = "agent-cfg-same";
    const { manager, connectionStore, orgContext } = await buildManager(
      orgId,
      agentId
    );

    const config = {
      platform: "discord",
      botToken: "tok-1",
      mentionRoleIds: ["role-A", "role-B"],
    };
    const id = await seedActiveConnection(
      manager,
      connectionStore,
      orgContext,
      orgId,
      agentId,
      config
    );

    let restartFired = false;
    const origStop = manager.stopInstance.bind(manager);
    const origStart = manager.startInstance.bind(manager);
    manager.stopInstance = async () => {
      restartFired = true;
    };
    manager.startInstance = async () => {
      restartFired = true;
    };
    restored = () => {
      manager.stopInstance = origStop;
      manager.startInstance = origStart;
    };

    await orgContext.run({ organizationId: orgId }, () =>
      manager.updateConnection(id, {
        config: {
          platform: "discord",
          botToken: "tok-1",
          // Same values, NEW array reference + different key order.
          mentionRoleIds: ["role-A", "role-B"],
        },
      })
    );

    expect(restartFired).toBe(false);
  });
});


describe('chat config audit transaction boundary', () => {
  test('failed audits roll back creation and rotation, and committed rotation invalidates cached refs', async () => {
    const orgId = 'org-chat-audit';
    const { manager, connectionStore, secretStore, orgContext } = await buildManager(orgId, 'chat-audit-agent');
    const { createChatMutationPersistence } = await import('../connections/chat-connection-service.js');
    const { insertConfigChangeEventInTransaction } = await import('../../utils/insert-event.js');
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    const persistence = createChatMutationPersistence({ organizationId: orgId, onPersist: async (tx, { before, after }) => {
      await insertConfigChangeEventInTransaction({ organizationId: orgId, resourceKind: 'connection', resourceId: (after ?? before!).id, op: after ? before ? 'updated' : 'created' : 'deleted', summary: 'Synthetic chat change', before: before as unknown as Record<string, unknown> | null, state: after as unknown as Record<string, unknown> | null, actorSource: 'api' }, tx);
    } }, manager);
    const reject = async (run: () => Promise<unknown>) => {
      await sql.unsafe(`CREATE OR REPLACE FUNCTION reject_chat_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'category' = 'config' THEN RAISE EXCEPTION 'synthetic chat audit failure'; END IF; RETURN NEW; END $$`);
      await sql.unsafe('CREATE TRIGGER reject_chat_config_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_chat_config_audit()');
      try { await expect(run()).rejects.toThrow('synthetic chat audit failure'); }
      finally { await sql.unsafe('DROP TRIGGER reject_chat_config_audit ON events'); await sql.unsafe('DROP FUNCTION reject_chat_config_audit()'); }
    };
    const id = 'chat-audit-fixture';
    const oldToken = 'synthetic-old-token-12345678901234567890';
    const newToken = 'synthetic-new-token-12345678901234567890';
    await orgContext.run({ organizationId: orgId }, async () => {
      const create = () => manager.addConnection('webhook', undefined, { platform: 'webhook', token: oldToken }, undefined, {}, id, undefined, persistence);
      await reject(create);
      expect(await connectionStore.getConnection(id)).toBeNull();
      expect(await sql`SELECT name FROM agent_secrets WHERE organization_id = ${orgId}`).toHaveLength(0);
      await create();
      const row = await connectionStore.getConnection(id);
      const ref = row!.config.token;
      expect(await secretStore.get(ref)).toBe(oldToken);
      await reject(() => manager.updateConnection(id, { config: { platform: 'webhook', token: newToken } }, persistence));
      expect(await secretStore.get(ref)).toBe(oldToken);
      await manager.updateConnection(id, { config: { platform: 'webhook', token: newToken } }, persistence);
      expect(await secretStore.get(ref)).toBe(newToken);
      expect((await sql`SELECT count(*)::int AS count FROM events WHERE organization_id = ${orgId} AND metadata->>'category' = 'config'`)[0].count).toBe(2);
    });
  });
});


test('audited chat startup compensation commits a tombstone and preserves both history entries', async () => {
  const orgId = 'org-chat-compensation';
  const { manager, connectionStore, orgContext } = await buildManager(orgId, 'chat-compensation-agent');
  const { createChatMutationPersistence } = await import('../connections/chat-connection-service.js');
  const { insertConfigChangeEventInTransaction } = await import('../../utils/insert-event.js');
  const { getDb } = await import('../../db/client.js');
  const persistence = createChatMutationPersistence({ organizationId: orgId, onPersist: async (tx, { before, after }) => {
    await insertConfigChangeEventInTransaction({ organizationId: orgId, resourceKind: 'connection', resourceId: (after ?? before!).id, op: after ? 'created' : 'deleted', summary: 'Synthetic startup compensation', before: before as unknown as Record<string, unknown> | null, state: after as unknown as Record<string, unknown> | null, actorSource: 'api' }, tx);
  } }, manager);
  manager.hydrateFromRow = async () => { throw new Error('synthetic startup failure'); };
  await orgContext.run({ organizationId: orgId }, async () => {
    await expect(manager.addConnection('discord', undefined, { platform: 'discord', botToken: 'synthetic-token', applicationId: 'synthetic-app', publicKey: 'synthetic-key' }, undefined, {}, 'compensated-chat', undefined, persistence)).rejects.toThrow('synthetic startup failure');
    expect(await connectionStore.getConnection('compensated-chat')).toBeNull();
    const sql = getDb();
    expect(await sql`SELECT name FROM agent_secrets WHERE organization_id = ${orgId}`).toHaveLength(0);
    const audits = await sql`SELECT metadata, payload_data FROM events WHERE organization_id = ${orgId} AND metadata->>'category' = 'config' ORDER BY id`;
    expect(audits.map(row => row.metadata.op)).toEqual(['created', 'deleted']);
    expect(audits[1].payload_data.state).toBeNull();
  });
});
