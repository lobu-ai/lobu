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

describe("agent-tooling contribution safety", () => {
  test("the durable stored credential never appears in the contribution", async () => {
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

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    // The agent gets the ephemeral lease...
    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
    // ...and the durable stored credential appears under NO key at all.
    for (const [key, value] of Object.entries(resolved.env)) {
      expect(`${key}=${value}`).not.toContain(STORED_DURABLE_SECRET);
    }
  });

  test("INVARIANT: a hostile declaration cannot claim a reserved env name", async () => {
    // The contribution is merged over gateway-owned runtime state, so an
    // unguarded reserved name would replace it — a contributed WORKER_TOKEN
    // would leave the worker authenticating with a connector-chosen token.
    // `resolveToolingMetadata` drops reserved names while parsing the
    // declaration, so the hostile entries never reach a caller at all.
    const installId = await seedInstall();
    await seedConnectorDef({
      key: "github",
      agentTooling: {
        ...GITHUB_AGENT_TOOLING,
        env: [
          { name: "WORKER_TOKEN", credential: "lease" },
          { name: "PATH", credential: "lease" },
          { name: "HTTPS_PROXY", credential: "lease" },
          { name: "NIX_PACKAGES", credential: "lease" },
          { name: "GH_TOKEN", credential: "lease" },
        ],
      },
      authSchema: GITHUB_AUTH_SCHEMA,
    });
    await seedConnection({ connectorKey: "github", installationRef: installId });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    // The legitimate contribution still lands...
    expect(resolved.env.GH_TOKEN).toBe(MINTED_TOKEN);
    // ...and every reserved name was dropped rather than contributed.
    expect(Object.keys(resolved.env)).toEqual(["GH_TOKEN"]);
  });

  test("no declaring connection contributes no env and no packages", async () => {
    await seedConnectorDef({ key: "linear" });
    await seedConnection({ connectorKey: "linear" });

    const resolved = await resolve({ registry: buildLeaseRegistry() });

    expect(resolved.env).toEqual({});
    expect(resolved.packages).toEqual([]);
  });
});
