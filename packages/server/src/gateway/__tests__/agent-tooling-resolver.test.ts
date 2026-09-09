/**
 * Connector-contributed agent tooling, end to end over a real database:
 * a connection whose connector declares `agentTooling` puts its CLI on the
 * agent's PATH, its leased credential in the sandbox env, and its hosts on the
 * egress allowlist — and NEVER puts the stored durable credential anywhere the
 * worker can read.
 *
 * The GitHub `/access_tokens` exchange is mocked at the `fetchImpl` seam of the
 * real provider, so no request reaches api.github.com while the App JWT signing
 * + install resolution + registry wiring all run for real.
 */

import { generateKeyPairSync } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  type MessagePayload,
  verifyEgressProxyToken,
  verifyWorkerToken,
} from "@lobu/core";
import { getDb } from "../../db/client.js";
import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import {
  CredentialLeaseRegistry,
  GitHubCredentialLeaseProvider,
} from "../agent-tooling/credential-lease.js";
import {
  resolveAgentTooling,
  resolveAgentToolingDeclaration,
} from "../agent-tooling/resolver.js";
import { GitHubInstallationTokenProvider } from "../installation/github-installation-token-provider.js";
import { InMemoryInstallationTokenCache } from "../installation/installation-token-provider.js";
import {
  __resetInstallationTokenRegistryForTests,
  getInstallationTokenRegistry,
} from "../installation/registry.js";
import {
  type DeploymentInfo,
  DeploymentManager,
  type OrchestratorConfig,
} from "../orchestration/deployment-manager.js";
import { GrantStore } from "../permissions/grant-store.js";
import { PolicyStore } from "../permissions/policy-store.js";
import type { SecretRef, WritableSecretStore } from "../secrets/index.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG = "test-org";
const AGENT = "agent-1";
const TENANT = "44556677";
const APP_ID = "lobu-app";
const MINTED_TOKEN = "ghs_minted_installation_token";
/**
 * The DURABLE credential stored on the connection. The invariant test asserts
 * this string never reaches the worker environment under any key.
 */
const STORED_DURABLE_SECRET = "ghp_durable_stored_pat_never_leaks";

const GITHUB_AGENT_TOOLING = {
  nix: { packages: ["gh"] },
  env: [{ name: "GH_TOKEN", credential: "lease" }],
  domains: ["api.github.com", "github.com"],
};

const GITHUB_AUTH_SCHEMA = {
  methods: [
    {
      type: "app_installation",
      provider: "github",
      providerInstance: "cloud",
      appIdKey: "TEST_GH_APP_ID",
      privateKeyKey: "TEST_GH_APP_KEY",
    },
  ],
};

/** Minimal writable secret store so placeholder injection actually runs. */
class InMemoryWritableStore implements WritableSecretStore {
  private readonly entries = new Map<string, string>();

  async get(ref: SecretRef): Promise<string | null> {
    if (!ref.startsWith("host://")) return null;
    return this.entries.get(decodeURIComponent(ref.slice("host://".length))) ?? null;
  }

  async put(name: string, value: string): Promise<SecretRef> {
    this.entries.set(name, value);
    return `host://${encodeURIComponent(name)}` as SecretRef;
  }

  async delete(nameOrRef: string): Promise<void> {
    this.entries.delete(
      nameOrRef.startsWith("host://")
        ? decodeURIComponent(nameOrRef.slice("host://".length))
        : nameOrRef
    );
  }

  async list(): Promise<never[]> {
    return [];
  }
}

/** Minimal concrete subclass — the base class is abstract over orchestration. */
class TestDeploymentManager extends DeploymentManager {
  async listDeployments(): Promise<DeploymentInfo[]> {
    return [];
  }
  protected async spawnDeployment(): Promise<void> {}
  async scaleDeployment(): Promise<void> {}
  async deleteDeployment(): Promise<void> {}
  async updateDeploymentActivity(): Promise<void> {}
  async validateWorkerImage(): Promise<void> {}
  protected getDispatcherHost(): string {
    return "localhost";
  }
  /** Expose the protected env assembly under test. */
  buildEnv(messageData: MessagePayload): Promise<Record<string, string>> {
    return this.generateEnvironmentVariables(
      "user",
      "user-1",
      "deploy-1",
      messageData
    );
  }
}

const TEST_CONFIG: OrchestratorConfig = {
  queues: { retryLimit: 3, retryDelay: 5, expireInSeconds: 300 },
  worker: { idleCleanupMinutes: 30, maxDeployments: 10 },
  cleanup: { initialDelayMs: 5000, intervalMs: 60000, veryOldDays: 7 },
};

function buildPayload(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return {
    userId: "u",
    conversationId: "c",
    messageId: "m",
    channelId: "ch",
    teamId: "t",
    agentId: AGENT,
    organizationId: ORG,
    botId: "b",
    platform: "slack",
    messageText: "hi",
    platformMetadata: {},
    agentOptions: {},
    ...overrides,
  };
}

/** Seed a connector_definitions row, optionally carrying an agent_tooling declaration. */
async function seedConnectorDef(params: {
  key: string;
  agentTooling?: unknown;
  authSchema?: unknown;
  organizationId?: string;
  status?: string;
}): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, auth_schema, agent_tooling, status
    ) VALUES (
      ${params.organizationId ?? ORG}, ${params.key}, ${params.key}, '1.0.0',
      ${params.authSchema ? sql.json(params.authSchema) : null},
      ${params.agentTooling ? sql.json(params.agentTooling) : null},
      ${params.status ?? "active"}
    )
  `;
}

/** Seed an active app installation and return its id. */
async function seedInstall(organizationId = ORG, tenant = TENANT): Promise<number> {
  const row = await createPostgresAppInstallationStore().upsert({
    organizationId,
    provider: "github",
    providerInstance: "cloud",
    providerAppId: APP_ID,
    externalTenantId: tenant,
    status: "active",
    metadata: {},
  });
  return row.id;
}

/** Seed a connection row; returns its id. */
async function seedConnection(params: {
  connectorKey: string;
  installationRef?: number | null;
  agentId?: string | null;
  status?: string;
  organizationId?: string;
  credentials?: Record<string, unknown>;
  authProfileId?: number;
  deleted?: boolean;
  slug?: string;
}): Promise<number> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, status, agent_id, config,
      credentials, auth_profile_id, deleted_at
    ) VALUES (
      ${params.organizationId ?? ORG}, ${params.connectorKey},
      ${params.slug ?? `conn-${params.connectorKey}-${Math.random().toString(36).slice(2)}`},
      ${params.status ?? "active"}, ${params.agentId ?? null},
      ${sql.json(
        params.installationRef != null
          ? { installation_ref: params.installationRef }
          : {}
      )},
      ${params.credentials ? sql.json(params.credentials) : null},
      ${params.authProfileId ?? null},
      ${params.deleted ? new Date() : null}
    )
    RETURNING id
  `;
  return Number(row.id);
}

async function seedEnvAuthProfile(params: {
  connectorKey: string;
  authData: Record<string, string>;
}): Promise<number> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO auth_profiles (
      organization_id, connector_key, slug, display_name,
      profile_kind, status, auth_data
    ) VALUES (
      ${ORG}, ${params.connectorKey}, ${`tooling-${params.connectorKey}`},
      ${`Tooling ${params.connectorKey}`}, 'env', 'active',
      ${sql.json(params.authData)}
    )
    RETURNING id
  `;
  return Number(row.id);
}

/**
 * A lease registry whose GitHub provider mints through the REAL installation
 * token provider, with only the provider's HTTP exchange mocked.
 */
function buildLeaseRegistry(options?: {
  respond?: () => Response;
}): CredentialLeaseRegistry {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();

  __resetInstallationTokenRegistryForTests();
  getInstallationTokenRegistry().register(
    new GitHubInstallationTokenProvider({
      env: { TEST_GH_APP_ID: "12345", TEST_GH_APP_KEY: privateKeyPem },
      cache: new InMemoryInstallationTokenCache(),
      fetchImpl: (async () =>
        options?.respond?.() ??
        new Response(
          JSON.stringify({
            token: MINTED_TOKEN,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )) as unknown as typeof fetch,
    })
  );

  const registry = new CredentialLeaseRegistry();
  registry.register(
    new GitHubCredentialLeaseProvider(createPostgresAppInstallationStore())
  );
  return registry;
}

function resolve(params: {
  registry: CredentialLeaseRegistry;
  agentId?: string;
  organizationId?: string;
}) {
  return resolveAgentTooling({
    agentId: params.agentId ?? AGENT,
    organizationId: params.organizationId ?? ORG,
    deploymentName: "deploy-1",
    leaseRegistry: params.registry,
  });
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  await seedAgentRow(AGENT);
});

afterEach(() => {
  __resetInstallationTokenRegistryForTests();
});

describe("resolveAgentTooling", () => {
  test("a GitHub connection contributes gh, a leased GH_TOKEN, and its domains", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual(["gh"]);
    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(resolved.domains).toEqual(["api.github.com", "github.com"]);
    // The declaration-only resolver (the queue path) must carry BOTH halves.
    // Domains alone would let the warm-path grant reconcile revoke the nix
    // binary-cache hosts that the contributed packages depend on.
    expect(
      await resolveAgentToolingDeclaration({
        organizationId: ORG,
      })
    ).toMatchObject({
      packages: ["gh"],
      domains: ["api.github.com", "github.com"],
    });
  });

  test("surfaces the earliest lease expiry so the deployment can be recycled", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const before = Date.now();
    const resolved = await resolve({ registry: buildLeaseRegistry() });

    // Without this the deployment has no idea when its credential dies, and a
    // never-idle worker keeps serving an expired token.
    expect(resolved.leaseExpiresAt).toBeInstanceOf(Date);
    expect(resolved.leaseExpiresAt!.getTime()).toBeGreaterThan(before);
  });

  test("no lease minted means no expiry to track", async () => {
    // Packages/domains still contribute, but there is nothing to recycle for.
    await seedConnectorDef({
      key: "github",
      agentTooling: { nix: { packages: ["gh"] }, domains: ["github.com"] },
    });
    await seedConnection({ connectorKey: "github" });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual(["gh"]);
    expect(resolved.leaseExpiresAt).toBeNull();
  });

  test("two connections claiming one env var resolve to the lower connection id", async () => {
    // A sandbox has a single $GH_TOKEN. The choice is arbitrary but must be
    // STABLE — an agent that swapped identity between turns as rows were added
    // would be far worse than one that consistently sees the first install.
    const installA = await seedInstall(ORG, "44556677");
    const installB = await seedInstall(ORG, "99887766");
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    const first = await seedConnection({
      connectorKey: "github",
      installationRef: installA,
    });
    const second = await seedConnection({
      connectorKey: "github",
      installationRef: installB,
    });
    expect(Number(second)).toBeGreaterThan(Number(first));

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
    // Exactly one credential is contributed — the collision is dropped, not
    // merged into some ambiguous combined value.
    expect(Object.keys(resolved.env)).toEqual(["GH_TOKEN"]);
  });

  test("an out-of-range installation_ref cannot break valid tooling rows", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    const malformed = await seedConnection({ connectorKey: "github" });
    await getDb()`
      UPDATE connections
         SET config = ${getDb().json({
           installation_ref: "999999999999999999999999999999999999",
         })}
       WHERE id = ${malformed}
    `;
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    // The malformed row contributes only its declaration. In particular, its
    // bigint cast must not abort the org-wide query before the valid row mints.
    expect(resolved.packages).toEqual(["gh"]);
    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
  });

  test("a connector that declares no agentTooling contributes nothing", async () => {
    await seedConnectorDef({ key: "linear" });
    await seedConnection({ connectorKey: "linear" });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual([]);
    expect(resolved.env).toEqual({});
    expect(resolved.domains).toEqual([]);
  });

  test("packages and domains still apply when the lease cannot be minted", async () => {
    // No installation backing: the CLI belongs on PATH regardless, so the agent
    // gets a `gh` that reports itself unauthenticated rather than a missing binary.
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: null });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual(["gh"]);
    expect(resolved.domains).toEqual(["api.github.com", "github.com"]);
    expect(resolved.env.GH_TOKEN).toBeUndefined();
  });

  test("a failed provider exchange drops the credential without failing resolution", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const resolved = await resolve({
      registry: buildLeaseRegistry({
        respond: () => new Response("suspended", { status: 404 }),
      }),
    });

    expect(resolved.env.GH_TOKEN).toBeUndefined();
    expect(resolved.packages).toEqual(["gh"]);
  });

  test("the chat fallback agent does not scope an org connection's tooling", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedAgentRow("agent-2");
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      agentId: "agent-2",
    });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual(["gh"]);
    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
  });

  test("a paused or soft-deleted connection contributes nothing", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      status: "paused",
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      deleted: true,
    });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.packages).toEqual([]);
    expect(resolved.env).toEqual({});
  });

  test("another org's connection never contributes to this org's agent", async () => {
    await seedAgentRow(AGENT, { organizationId: "org-b" });
    const otherInstall = await seedInstall("org-b", "99887766");
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      organizationId: "org-b",
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: otherInstall,
      organizationId: "org-b",
    });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.env).toEqual({});
    expect(resolved.packages).toEqual([]);
  });

  test("a cross-tenant installation_ref is rejected without minting", async () => {
    // org-b owns the install; this org's connection points at it anyway.
    await seedAgentRow("agent-b", { organizationId: "org-b" });
    const foreignInstall = await seedInstall("org-b", "12121212");
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: foreignInstall,
    });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.env.GH_TOKEN).toBeUndefined();
  });

  test("a suspended install does not mint", async () => {
    const installId = await seedInstall();
    await getDb()`
      UPDATE app_installations SET status = 'suspended' WHERE id = ${installId}
    `;
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.env.GH_TOKEN).toBeUndefined();
  });

  test("two connections of one connector do not fight over the env var", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      slug: "conn-a",
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      slug: "conn-b",
    });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(resolved.packages).toEqual(["gh"]);
  });
});

describe("deployment env assembly", () => {
  let manager: TestDeploymentManager;

  beforeEach(async () => {
    manager = new TestDeploymentManager(TEST_CONFIG);
    manager.setGrantStore(new GrantStore());
    manager.setPolicyStore(new PolicyStore());
  });

  test("the sandbox env carries the lease and nix packages include gh", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(buildPayload());

    expect(env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(verifyWorkerToken(env.WORKER_TOKEN)?.nixPackages).toContain("gh");
    const proxyToken = decodeURIComponent(
      new URL(env.HTTP_PROXY ?? "").password
    );
    expect(verifyEgressProxyToken(proxyToken)).not.toBeNull();
    expect(verifyWorkerToken(proxyToken)).toBeNull();
  });

  test("contributed nix packages union with the agent's own, never replace them", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(
      buildPayload({ nixConfig: { packages: ["ripgrep"] } })
    );

    // The union rides the SIGNED token — the only thing a runtime provisions
    // from. This claim is what makes the contributed `gh` portable across
    // backends.
    expect(
      verifyWorkerToken(env.WORKER_TOKEN)?.nixPackages?.slice().sort()
    ).toEqual(["gh", "ripgrep"]);
  });

  test("contributed domains are granted on the worker's egress allowlist", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const grantStore = new GrantStore();
    manager.setGrantStore(grantStore);
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(buildPayload());

    expect(await grantStore.hasGrant(AGENT, "api.github.com", ORG)).toBe(true);
    expect(await grantStore.hasGrant(AGENT, "github.com", ORG)).toBe(true);
    expect(verifyWorkerToken(env.WORKER_TOKEN)?.allowedDomains).toEqual([
      "api.github.com",
      "github.com",
    ]);
  });

  test("INVARIANT: cold create and a warm turn give the sandbox the same tooling", async () => {
    // The two paths must single-source their contribution. If they diverge, a
    // warm turn silently drops a package or has its egress reconciled away,
    // and the failure surfaces to the user as "the agent could do this a
    // minute ago and now it can't".
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const grantStore = new GrantStore();
    manager.setGrantStore(grantStore);
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const listAllowed = async () =>
      (await grantStore.listGrants(AGENT, ORG))
        .filter((g) => g.kind === "domain" && !g.denied)
        .map((g) => g.pattern)
        .sort();

    // Cold: the manager resolves and folds the contribution itself.
    const coldEnv = await manager.buildEnv(buildPayload());
    const coldPackages = (
      verifyWorkerToken(coldEnv.WORKER_TOKEN)?.nixPackages ?? []
    )
      .slice()
      .sort();
    const coldGrants = await listAllowed();

    // Warm: the CONSUMER folds into the payload, then the reconcile runs.
    const contribution = await resolveAgentToolingDeclaration({
      organizationId: ORG,
    });
    const warmPayload = buildPayload({
      networkConfig: { allowedDomains: contribution.domains },
      nixConfig: { packages: contribution.packages },
    });
    await manager.syncNetworkConfigGrants(warmPayload);
    // Sampled HERE, immediately after the reconcile — `buildEnv` re-resolves
    // the contribution through the cold path and would re-grant whatever the
    // reconcile just revoked, hiding the divergence being tested.
    const warmGrants = await listAllowed();
    const warmEnv = await manager.buildEnv(warmPayload);
    const warmPackages = (
      verifyWorkerToken(warmEnv.WORKER_TOKEN)?.nixPackages ?? []
    )
      .slice()
      .sort();

    expect(coldPackages).toContain("gh");
    // What the CONSUMER folded is what reaches the runtime: the signed
    // nixPackages claim is built from the payload, so a package missing from
    // the fold is missing from the sandbox's PATH.
    expect(contribution.packages).toContain("gh");
    expect(warmPackages).toEqual(coldPackages);
    // Identical sets, so grant rows do not flap revoke/re-grant per turn.
    expect(warmGrants).toEqual(coldGrants);
    expect(warmEnv.GH_TOKEN).toBe(MINTED_TOKEN);
  });

  test("REGRESSION: the warm-path reconcile keeps the nix cache hosts a contributed package needs", async () => {
    // The warm path (existing thread) re-runs syncNetworkConfigGrants against
    // the QUEUE payload, which is built by the consumer — not by buildEnv. That
    // reconcile derives the nix binary-cache hosts from nixConfig.packages and
    // unconditionally revokes anything not in the expected set. So if the
    // consumer folds contributed domains but NOT contributed packages, the
    // second message of a conversation revokes cache.nixos.org — potentially
    // out from under an in-flight first-deploy download of that very package.
    //
    // Mutation check: drop the `contribution.packages` fold in message-consumer
    // and this test fails on the cache.nixos.org assertion.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const grantStore = new GrantStore();
    manager.setGrantStore(grantStore);
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    // Cold create: grants the connector domains AND the nix cache hosts.
    await manager.buildEnv(buildPayload());
    expect(await grantStore.hasGrant(AGENT, "cache.nixos.org", ORG)).toBe(true);

    // Warm path: the agent declares no nix packages of its own, so the cache
    // hosts survive only if the consumer folded the contributed package.
    const contribution = await resolveAgentToolingDeclaration({
      organizationId: ORG,
    });
    await manager.syncNetworkConfigGrants({
      ...buildPayload(),
      networkConfig: { allowedDomains: contribution.domains },
      nixConfig: { packages: contribution.packages },
    });

    expect(await grantStore.hasGrant(AGENT, "cache.nixos.org", ORG)).toBe(true);
    expect(await grantStore.hasGrant(AGENT, "api.github.com", ORG)).toBe(true);
  });

  test("REGRESSION: a warm deployment whose lease is expiring is flagged for recycling", async () => {
    // Worker env is read once at process start, so a live worker cannot be
    // handed a fresh token. Idle cleanup defaults to 60m and GitHub
    // installation tokens last ~60m, so a deployment that never goes idle
    // would otherwise serve a sandbox whose `gh` has started 401ing.
    //
    // Mutation check: drop the leaseExpiryByDeployment.set() in
    // deployment-manager and the "expiring" assertion below fails.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    await manager.buildEnv(buildPayload());

    // The harness mints a token valid for 1h. Fresh now...
    expect(manager.hasExpiringLease("deploy-1")).toBe(false);
    // ...and inside the recycle margin as its expiry approaches.
    expect(
      manager.hasExpiringLease("deploy-1", new Date(Date.now() + 58 * 60_000))
    ).toBe(true);
    // An unknown deployment has no lease to expire and must never be recycled.
    expect(manager.hasExpiringLease("deploy-unknown")).toBe(false);
  });

  test("a deployment with no minted lease is never recycled for expiry", async () => {
    await seedConnectorDef({
      key: "github",
      agentTooling: { nix: { packages: ["gh"] }, domains: ["github.com"] },
    });
    await seedConnection({ connectorKey: "github" });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    await manager.buildEnv(buildPayload());

    expect(
      manager.hasExpiringLease("deploy-1", new Date(Date.now() + 86_400_000))
    ).toBe(false);
  });

  test("REGRESSION: connecting a connector mid-conversation recycles the warm worker", async () => {
    // A worker reads its env once at process start, so a deployment created
    // before the GitHub connection existed has no gh and no GH_TOKEN. Without
    // change detection it keeps serving that stale sandbox and the user sees
    // "I connected GitHub but the agent still can't use it".
    //
    // Mutation: drop the toolingFingerprintByDeployment.set() in
    // deployment-manager and the "changed" assertion below fails.
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    // Turn 1: no tooling connections at all.
    await manager.buildEnv(buildPayload());
    const before = await resolveAgentToolingDeclaration({ organizationId: ORG });
    expect(manager.hasToolingStampMismatch("deploy-1", before.fingerprint)).toBe(
      false
    );

    // The user connects GitHub.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    // Turn 2: the warm deployment must be recognized as stale — the new stamp
    // mismatches AND the DB-truth drift check confirms the org really changed.
    const after = await resolveAgentToolingDeclaration({ organizationId: ORG });
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(manager.hasToolingStampMismatch("deploy-1", after.fingerprint)).toBe(
      true
    );
    expect(await manager.hasToolingDrifted("deploy-1", buildPayload())).toBe(
      true
    );

    // And after recycling, the rebuilt sandbox actually carries the credential.
    const rebuilt = await manager.buildEnv(buildPayload());
    expect(rebuilt.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(manager.hasToolingStampMismatch("deploy-1", after.fingerprint)).toBe(
      false
    );
  });

  test("REGRESSION: an outdated stamp does not recycle the rebuilt worker — DB truth decides", async () => {
    // A queued job carries the fingerprint resolved at ITS enqueue, so after a
    // rebuild it legitimately mismatches the reborn fingerprint. No chronology
    // can order the stamp (`runs.id` is not processing order across replicas —
    // review round 11 refuted the runId watermark), so `hasToolingDrifted`
    // re-reads the org's CURRENT declaration digest instead: it matches the
    // rebuilt deployment, so the stamp is merely outdated → deliver, never a
    // churn loop.
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    // Fingerprint of the org BEFORE GitHub existed — what a pre-change job
    // would have been stamped with.
    const before = await resolveAgentToolingDeclaration({ organizationId: ORG });

    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    // Deployment (re)built against the post-change truth.
    await manager.buildEnv(buildPayload({ runId: 100 }));

    // The old stamp mismatches, but the current digest equals the born one.
    expect(manager.hasToolingStampMismatch("deploy-1", before.fingerprint)).toBe(
      true
    );
    expect(await manager.hasToolingDrifted("deploy-1", buildPayload())).toBe(
      false
    );
    // A deployment this pod never built reports no drift either.
    expect(
      await manager.hasToolingDrifted("deploy-unknown", buildPayload())
    ).toBe(false);
  });

  test("repointing a connection at a different installation is a change", async () => {
    // Two installs can declare identical tooling while being different
    // identities. Packages and domains are unchanged, so only the installation
    // ref in the digest catches it — without that the agent keeps acting as
    // the previous GitHub org.
    const installA = await seedInstall(ORG, "11112222");
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    const connId = await seedConnection({
      connectorKey: "github",
      installationRef: installA,
    });
    const before = await resolveAgentToolingDeclaration({ organizationId: ORG });

    const installB = await seedInstall(ORG, "33334444");
    await getDb()`
      UPDATE connections
         SET config = ${getDb().json({ installation_ref: installB })}
       WHERE id = ${connId}
    `;
    const after = await resolveAgentToolingDeclaration({ organizationId: ORG });

    // Capability is identical...
    expect(after.packages).toEqual(before.packages);
    expect(after.domains).toEqual(before.domains);
    // ...but identity is not.
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test("changing the lease auth method invalidates a warm worker", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const before = await resolveAgentToolingDeclaration({ organizationId: ORG });

    await getDb()`
      UPDATE connector_definitions
         SET auth_schema = ${getDb().json({
           methods: [
             {
               ...GITHUB_AUTH_SCHEMA.methods[0],
               appIdKey: "OTHER_GH_APP_ID",
             },
           ],
         })}
       WHERE organization_id = ${ORG}
         AND key = 'github'
    `;
    const after = await resolveAgentToolingDeclaration({ organizationId: ORG });

    // Packages and domains did not change, but the gateway would mint under a
    // different App identity after rebuild.
    expect(after.packages).toEqual(before.packages);
    expect(after.domains).toEqual(before.domains);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test("REGRESSION: suspending an installation invalidates a warm worker", async () => {
    // Revoking the App install at GitHub leaves connections/connector_definitions
    // untouched, so a fingerprint over those alone would not change and the warm
    // worker would keep using a token minted under authority it no longer has.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const before = await resolveAgentToolingDeclaration({ organizationId: ORG });

    await getDb()`
      UPDATE app_installations SET status = 'revoked' WHERE id = ${installId}
    `;
    const after = await resolveAgentToolingDeclaration({ organizationId: ORG });

    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test("REGRESSION: transferring an installation to another tenant is a change", async () => {
    // Same App id, same declaration, different GitHub org — the agent's
    // identity changed even though nothing about the connection did.
    const installId = await seedInstall(ORG, "55556666");
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const before = await resolveAgentToolingDeclaration({ organizationId: ORG });

    await getDb()`
      UPDATE app_installations
         SET external_tenant_id = '77778888'
       WHERE id = ${installId}
    `;
    const after = await resolveAgentToolingDeclaration({ organizationId: ORG });

    expect(after.packages).toEqual(before.packages);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test("BLOCKER REGRESSION: a re-mint never returns a token inside the recycle margin", async () => {
    // The recycle exists to replace a dying credential. The provider cache
    // serves any token with >60s left, but the deployment recycles at <=5min
    // remaining — so without a stricter TTL on the LEASE path the re-mint
    // hands back the SAME dying token, re-records the same expiry, and
    // recycles again next turn: a cold start every turn, forever, and every
    // deployment born with a nearly-dead credential.
    //
    // Uses the REAL InMemoryInstallationTokenCache, unlike the mint-fresh
    // harness registry, because the cache IS the thing under test.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey
      .export({ type: "pkcs1", format: "pem" })
      .toString();

    // First mint yields a token with only 3 minutes left — inside the margin.
    // Every later mint yields a healthy 1h token.
    let mintCount = 0;
    __resetInstallationTokenRegistryForTests();
    getInstallationTokenRegistry().register(
      new GitHubInstallationTokenProvider({
        env: { TEST_GH_APP_ID: "12345", TEST_GH_APP_KEY: privateKeyPem },
        cache: new InMemoryInstallationTokenCache(),
        fetchImpl: (async () => {
          mintCount += 1;
          const ttl = mintCount === 1 ? 3 * 60_000 : 3_600_000;
          return new Response(
            JSON.stringify({
              token: `ghs_mint_${mintCount}`,
              expires_at: new Date(Date.now() + ttl).toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }) as unknown as typeof fetch,
      })
    );
    const registry = new CredentialLeaseRegistry();
    registry.register(
      new GitHubCredentialLeaseProvider(createPostgresAppInstallationStore())
    );

    const first = await resolve({ registry });
    expect(first.env.GH_TOKEN).toBe("ghs_mint_1");

    // The recycle re-mints. The 3-minute token is still cache-eligible under
    // the default 60s skew, so only the lease path's stricter TTL forces a
    // fresh one.
    const second = await resolve({ registry });
    expect(second.env.GH_TOKEN).toBe("ghs_mint_2");
    expect(mintCount).toBe(2);

    // And the replacement is actually outside the recycle margin, so the
    // rebuilt deployment does not immediately qualify for recycling again.
    const remainingMs = second.leaseExpiresAt!.getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(5 * 60_000);
  });

  test("a born-expiring lease is delivered and still renews", async () => {
    // A provider issuing a token already inside the recycle margin (clock
    // skew, or a fault) still gets its credential delivered — a short life
    // beats none — and its expiry IS recorded so the deployment renews. An
    // earlier draft suppressed the expiry to avoid a recycle loop; that was
    // wrong on both counts: the loop is prevented structurally by the
    // manager's age floor, and suppressing left the deployment unable to
    // renew at all.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const resolved = await resolve({
      registry: buildLeaseRegistry({
        respond: () =>
          new Response(
            JSON.stringify({
              token: MINTED_TOKEN,
              // 2 minutes: inside the 5-minute recycle margin.
              expires_at: new Date(Date.now() + 2 * 60_000).toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          ),
      }),
    });

    // The credential is still delivered — a short life beats none — and its
    // expiry IS recorded, so the deployment renews. What prevents a loop is
    // the manager's minimum-age floor, not suppressing the expiry: suppressing
    // it would leave the deployment unable to renew at all.
    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(resolved.leaseExpiresAt).toBeInstanceOf(Date);
  });

  test("REGRESSION: a short lease renews at expiry without per-turn recycling", async () => {
    // Without an age floor, a provider issuing tokens already inside the
    // 5-minute margin would make every turn recycle: rebuild, still expiring,
    // rebuild again, forever — each one a cold start.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(
      buildLeaseRegistry({
        respond: () =>
          new Response(
            JSON.stringify({
              token: MINTED_TOKEN,
              expires_at: new Date(Date.now() + 2 * 60_000).toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          ),
      })
    );

    await manager.buildEnv(buildPayload());

    // Expiring by the raw margin, but still usable and too young to recycle.
    expect(manager.hasExpiringLease("deploy-1")).toBe(false);
    // Once the short credential itself has expired, the age floor must not
    // leave the sandbox unauthenticated for the rest of ten minutes.
    expect(
      manager.hasExpiringLease("deploy-1", new Date(Date.now() + 3 * 60_000))
    ).toBe(true);
  });

  test("an unchanged org keeps its warm worker", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    await manager.buildEnv(buildPayload());
    const again = await resolveAgentToolingDeclaration({ organizationId: ORG });

    // Recycling a healthy worker every turn would be worse than the bug.
    expect(manager.hasToolingStampMismatch("deploy-1", again.fingerprint)).toBe(
      false
    );
    // A deployment this pod never built is not evidence of a change.
    expect(
      manager.hasToolingStampMismatch("deploy-unknown", again.fingerprint)
    ).toBe(false);
  });

  test("a lease env var survives secret-placeholder injection", async () => {
    // GH_TOKEN matches the _TOKEN secret heuristic, so without recognizing the
    // already-materialized lease it would be swapped for a proxy placeholder.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());
    manager.setSecretStore(new InMemoryWritableStore());

    const env = await manager.buildEnv(buildPayload());

    expect(env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(env.GH_TOKEN).not.toContain("lobu_secret_");
    expect(env.GH_TOKEN).not.toBe("lobu-proxy");
  });

  test("an operator override of a lease-named env var is still protected", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const withOverride = new TestDeploymentManager({
      ...TEST_CONFIG,
      worker: { ...TEST_CONFIG.worker, env: { GH_TOKEN: STORED_DURABLE_SECRET } },
    });
    withOverride.setGrantStore(new GrantStore());
    withOverride.setPolicyStore(new PolicyStore());
    withOverride.setCredentialLeaseRegistry(buildLeaseRegistry());
    withOverride.setSecretStore(new InMemoryWritableStore());

    const env = await withOverride.buildEnv(buildPayload());

    expect(env.GH_TOKEN).not.toBe(STORED_DURABLE_SECRET);
    expect(env.GH_TOKEN).toContain("lobu_secret_");
  });

  test("a NON-lease secret alongside a lease is still swapped for a placeholder", async () => {
    // Proves the exemption is scoped to lease vars rather than being a blanket
    // disable of placeholder injection: the sibling secret must still be swapped.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    const withSecret = new TestDeploymentManager({
      ...TEST_CONFIG,
      worker: { ...TEST_CONFIG.worker, env: { SOME_API_TOKEN: "durable-value" } },
    });
    withSecret.setGrantStore(new GrantStore());
    withSecret.setPolicyStore(new PolicyStore());
    withSecret.setCredentialLeaseRegistry(buildLeaseRegistry());
    withSecret.setSecretStore(new InMemoryWritableStore());

    const env = await withSecret.buildEnv(buildPayload());

    expect(env.GH_TOKEN).toBe(MINTED_TOKEN);
    expect(env.SOME_API_TOKEN).not.toBe("durable-value");
    expect(env.SOME_API_TOKEN).toContain("lobu_secret_");
  });

  test("a retired placeholder-tier declaration contributes no env var at all", async () => {
    // The egress proxy raw-tunnels HTTPS CONNECT, so a placeholder in a CLI
    // env var would be sent to the provider verbatim. The tier was removed:
    // a persisted declaration still using it must contribute nothing — and
    // in particular must never fall back to the stored durable credential.
    const connectorKey = "placeholder-probe";
    await seedConnectorDef({
      key: connectorKey,
      agentTooling: {
        env: [{ name: "API_TOKEN", credential: "placeholder" }],
      },
    });
    const authProfileId = await seedEnvAuthProfile({
      connectorKey,
      authData: { API_TOKEN: STORED_DURABLE_SECRET },
    });
    await seedConnection({ connectorKey, authProfileId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());
    manager.setSecretStore(new InMemoryWritableStore());

    const env = await manager.buildEnv(buildPayload());

    expect(env.API_TOKEN).toBeUndefined();
    for (const [key, value] of Object.entries(env)) {
      expect(`${key}=${value}`).not.toContain(STORED_DURABLE_SECRET);
    }
  });

  test("INVARIANT: the connection's stored durable credential never reaches the worker env", async () => {
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: GITHUB_AGENT_TOOLING,
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({
      connectorKey: "github",
      installationRef: installId,
      credentials: { access_token: STORED_DURABLE_SECRET },
    });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(buildPayload());

    // The worker gets the ephemeral lease...
    expect(env.GH_TOKEN).toBe(MINTED_TOKEN);
    // ...and the durable stored credential appears under NO key at all.
    for (const [key, value] of Object.entries(env)) {
      expect(`${key}=${value}`).not.toContain(STORED_DURABLE_SECRET);
    }
  });

  test("INVARIANT: a hostile declaration cannot hijack the signed worker token or PATH", async () => {
    // The contribution is merged OVER the already-built base env, so an
    // unguarded reserved name would REPLACE gateway-owned runtime state — and a
    // contributed WORKER_TOKEN would additionally inherit the lease exemption
    // from placeholder injection, leaving the worker authenticating with a
    // connector-chosen token.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: {
        ...GITHUB_AGENT_TOOLING,
        env: [
          { name: "WORKER_TOKEN", credential: "lease" },
          { name: "PATH", credential: "lease" },
          { name: "HTTPS_PROXY", credential: "lease" },
          { name: "GH_TOKEN", credential: "lease" },
        ],
      },
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(buildPayload());

    // The legitimate contribution still lands...
    expect(env.GH_TOKEN).toBe(MINTED_TOKEN);
    // ...while every reserved name keeps its gateway-owned value.
    expect(env.WORKER_TOKEN).not.toBe(MINTED_TOKEN);
    expect(env.PATH).not.toBe(MINTED_TOKEN);
    expect(env.HTTPS_PROXY).not.toBe(MINTED_TOKEN);
    // The worker token must still verify as a token the GATEWAY signed.
    expect(verifyWorkerToken(env.WORKER_TOKEN)).toBeTruthy();
  });

  test("no declaring connection leaves the env and nix config untouched", async () => {
    await seedConnectorDef({ key: "linear" });
    await seedConnection({ connectorKey: "linear" });
    manager.setCredentialLeaseRegistry(buildLeaseRegistry());

    const env = await manager.buildEnv(buildPayload());

    expect(env.GH_TOKEN).toBeUndefined();
    expect(verifyWorkerToken(env.WORKER_TOKEN)?.nixPackages ?? []).toEqual([]);
  });
});
