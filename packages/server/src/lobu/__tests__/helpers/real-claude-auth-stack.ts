/**
 * Builds a REAL Claude auth stack (the actual `AuthProfilesManager` +
 * `ProviderOAuthStateStore`) backed by the test Postgres + an in-memory secret
 * store, via a real `CoreServices`.
 *
 * Why this exists: the OAuth-route regression test used to stash a *fake*
 * `authProfilesManager` whose `upsertProfile` ignored `userId`. That fake
 * silently accepted the persist the real manager rejects, so the test stayed
 * green while prod failed with "upsertProfile requires userId" (the bug behind
 * lobu #1321). Running the genuine `AuthProfilesManager.upsertProfile` guard —
 * not a hand-mirrored copy of it — is the whole point: the test now breaks for
 * the same reason prod did.
 */
import type { SecretPutOptions, SecretRef } from "@lobu/core";
import { InMemoryStateAdapter } from "../../../gateway/__tests__/fixtures/in-memory-state-adapter.js";
import { MockMessageQueue } from "../../../gateway/__tests__/setup.js";
import type { ProviderOAuthStateStore } from "../../../gateway/auth/oauth/state-store.js";
import type { AuthProfilesManager } from "../../../gateway/auth/settings/auth-profiles-manager.js";
import type { GatewayConfig } from "../../../gateway/config/index.js";
import { PostgresSecretStore } from "../../stores/postgres-secret-store.js";
import {
  SecretStoreRegistry,
  type WritableSecretStore,
} from "../../../gateway/secrets/index.js";
import { CoreServices } from "../../../gateway/services/core-services.js";

/** Minimal in-memory `WritableSecretStore` (the persisted credential lands
 *  here; the profile row itself goes to the test Postgres). */
class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<string, { value: string }>();
	constructor(private readonly scheme: string = "host") {}
  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith(`${this.scheme}://`)) return null;
    const name = decodeURIComponent(ref.slice(`${this.scheme}://`.length));
    return this.entries.get(name)?.value ?? null;
  }
  async put(
    name: string,
    value: string,
		_options?: SecretPutOptions,
  ): Promise<SecretRef> {
    this.entries.set(name, { value });
    return `${this.scheme}://${encodeURIComponent(name)}` as SecretRef;
  }
  async delete(): Promise<void> {}
  async list(): Promise<{ name: string; updatedAt: number }[]> {
    return [];
  }
}

function minimalGatewayConfig(): GatewayConfig {
  return {
    agentDefaults: {},
    sessionTimeoutMinutes: 5,
		logLevel: "INFO",
    queues: {
			connectionString: "postgres://test",
			directMessage: "direct_message",
			messageQueue: "message_queue",
      retryLimit: 3,
      retryDelay: 1,
      expireInHours: 24,
    },
    anthropicProxy: { enabled: true },
    orchestration: {
      queues: {
				connectionString: "postgres://test",
        retryLimit: 3,
        retryDelay: 1,
        expireInSeconds: 3600,
      },
      worker: {
        startupTimeoutSeconds: 90,
        idleCleanupMinutes: 60,
        maxDeployments: 100,
      },
      cleanup: { initialDelayMs: 1000, intervalMs: 60000, veryOldDays: 7 },
    },
		mcp: { publicGatewayUrl: "http://localhost:8080" },
    auth: {},

    secrets: { aws: {} },
  } as GatewayConfig;
}

export interface RealClaudeAuthStack {
  authProfilesManager: AuthProfilesManager;
  oauthStateStore: ProviderOAuthStateStore;
  /**
   * Stop the SSE fanout / queue listeners this stack started. Call from the
   * test's `afterEach` — `initializeClaudeServices()` also registers provider
   * modules into the process-global `moduleRegistry` bound to THIS stack's
   * manager, so leaving it running leaks listeners into later tests that share
   * the Bun process.
   */
  shutdown(): Promise<void>;
}

/**
 * Construct a real CoreServices against the test DB and return the genuine
 * `AuthProfilesManager` + OAuth state store the SPA route will use. Call after
 * `ensureDbForGatewayTests()` + `resetTestDatabase()` + the org/agent seed.
 */
export async function buildRealClaudeAuthStack(options: { durableSecrets?: boolean } = {}): Promise<RealClaudeAuthStack> {
  const hostStore = new InMemoryWritableStore();
  const postgres = new PostgresSecretStore();
  const secretStore = options.durableSecrets
    ? new SecretStoreRegistry(postgres, { secret: postgres, host: hostStore })
    : new SecretStoreRegistry(hostStore, { host: hostStore });
  const coreServices = new CoreServices(minimalGatewayConfig(), {
    secretStore,
    stateAdapter: new InMemoryStateAdapter(),
    // Presence-only stubs — initializeSessionServices just checks these exist;
    // the route's own module-level Postgres config store handles hasAgent().
    configStore: {
      getSettings: async () => null,
      saveSettings: async () => {},
      updateSettings: async () => {},
      deleteSettings: async () => {},
      hasSettings: async () => false,
      getMetadata: async () => null,
      saveMetadata: async () => {},
      updateMetadata: async () => {},
      deleteMetadata: async () => {},
      hasAgent: async () => false,
      listAgents: async () => [],
    } as never,
    connectionStore: {
      getConnection: async () => null,
      listConnections: async () => [],
      saveConnection: async () => {},
      updateConnection: async () => {},
      deleteConnection: async () => {},
    } as never,
  });
  // MockMessageQueue has no stop(); coreServices.shutdown() calls queue.stop(),
  // so give the injected queue a no-op stop to keep teardown clean.
  (coreServices as unknown as { queue: unknown }).queue = Object.assign(
    new MockMessageQueue(),
		{ stop: async () => {} },
  );

  await (
    coreServices as unknown as {
      initializeSessionServices(): Promise<void>;
      initializeClaudeServices(): Promise<void>;
    }
  ).initializeSessionServices();
  await (
    coreServices as unknown as {
      initializeClaudeServices(): Promise<void>;
    }
  ).initializeClaudeServices();

  const authProfilesManager = coreServices.getAuthProfilesManager();
  const oauthStateStore = coreServices.getOAuthStateStore();
  if (!authProfilesManager || !oauthStateStore) {
		throw new Error("CoreServices did not initialize the Claude auth stack");
  }
  return {
    authProfilesManager,
    oauthStateStore,
    shutdown: () => coreServices.shutdown(),
  };
}
