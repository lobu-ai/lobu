/**
 * Bun:test PG harness shared across the gateway test suite.
 *
 * Store tests in this directory read/write Postgres directly, so callers
 * need a real DB. The first time `ensureDbForGatewayTests()` is called we use
 * DATABASE_URL if set, else spawn an ephemeral embedded Postgres once per test
 * process, run migrations, and reuse it for the rest of the suite.
 *
 * Tests that don't need PG (pure helpers, classification logic, etc.) can
 * skip calling this entirely and pay no cost.
 *
 * Suite teardown is registered in bun-test-teardown.ts (bunfig preload).
 * startEmbeddedBackend's beforeExit/exit hooks are a fallback on interrupt.
 */

import GitHubConnector from "@lobu/connectors/github";
import { closeDbSingleton, getDb } from "../../../db/client.js";
import { declaredFeedsSchema } from "../../../__tests__/setup/test-fixtures.js";
import {
  type EmbeddedBackend,
  startEmbeddedBackend,
  stopActiveEmbeddedBackend,
} from "../../../__tests__/setup/embedded-postgres-backend.js";
import {
  cleanupTestDatabase,
  closeTestDb,
  setupTestDatabase,
} from "../../../__tests__/setup/test-db.js";

let initPromise: Promise<void> | null = null;
let backend: EmbeddedBackend | null = null;

/**
 * Idempotent. Starts the DB + runs migrations on first call, returns the
 * same Promise on every subsequent call. Tests should `await` it from a
 * `beforeAll` — repeated calls are cheap.
 */
export function ensureDbForGatewayTests(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!process.env.DATABASE_URL) {
      backend = await startEmbeddedBackend();
      process.env.DATABASE_URL = backend.url;
      process.env.PGSSLMODE = "disable";
    }
    if (!process.env.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    }
    await setupTestDatabase();
    // Gateway routes reach `getWorkspaceProvider()` (org-slug lookups behind
    // view URLs, auth resolution), which throws unless the provider was
    // initialized. Until now no gateway suite initialized it: files that
    // needed one inherited it from a lane neighbour, because bun shares module
    // singletons across every file in a `bun test` process and
    // `interaction-bridge-owner-approval.test.ts` calls it. Lanes are
    // partitioned by SOURCE SIZE (scripts/run-gateway-test-lanes.mjs), so
    // editing an unrelated test file reshuffles them and silently strips a
    // suite of its initializer. Own it here instead of leaving it to the
    // partition. Dynamically imported: `workspace/index` pulls the whole
    // multi-tenant auth graph, and only suites that actually start the DB
    // should pay for it.
    const { initWorkspaceProvider } = await import("../../../workspace/index.js");
    await initWorkspaceProvider();
    // Hand the schema-ready DATABASE_URL off to the singleton without keeping
    // setup-time connections around.
    await closeTestDb();
    await closeDbSingleton();
  })().catch(async (err) => {
    await stopDbForGatewayTests();
    throw err;
  });

  return initPromise;
}

/** Stop and forget the embedded gateway-test database, if this process owns one. */
export async function stopDbForGatewayTests(): Promise<void> {
  const embeddedUrl = backend?.url;
  await closeTestDb();
  await closeDbSingleton();
  if (backend) {
    await stopActiveEmbeddedBackend();
  }
  if (embeddedUrl && process.env.DATABASE_URL === embeddedUrl) {
    delete process.env.DATABASE_URL;
  }
  backend = null;
  initPromise = null;
}

/**
 * Idempotent ENCRYPTION_KEY guard. Some bun:test files in this directory
 * `delete process.env.ENCRYPTION_KEY` in their afterAll, which breaks any
 * subsequent file that lazily reads it. Call this at the start of beforeEach
 * (or beforeAll) in any file that uses encrypt()/decrypt() or stores that
 * route through the secret store.
 */
export function ensureEncryptionKey(): void {
  if (!process.env.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  }
}

/** Truncate every test-known table without dropping the schema. */
export async function resetTestDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL || !initPromise) {
    await ensureDbForGatewayTests();
  } else {
    await initPromise;
  }
  // Re-assert ENCRYPTION_KEY on every beforeEach: ensureDbForGatewayTests()
  // sets it once inside a memoized block, so a later file that deletes the key
  // (and resets the encryption cache) in its teardown would otherwise leave
  // every subsequent DB-using file's lazy encrypt()/decrypt() broken.
  ensureEncryptionKey();
  await cleanupTestDatabase();
}

/**
 * Convenience for tests that need an org_id present in `organizations` and
 * a row in `agents` so the FK-constrained tables (agent_users, automations,
 * grants, etc.) accept inserts.
 *
 * Returns the org_id used; defaults to "test-org".
 */
export async function seedAgentRow(
  agentId: string,
  options: {
    organizationId?: string;
    name?: string;
    ownerPlatform?: string;
    ownerUserId?: string;
  } = {}
): Promise<string> {
  const sql = getDb();
  const orgId = options.organizationId ?? "test-org";

  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${orgId}, ${orgId}, ${orgId})
    ON CONFLICT (id) DO NOTHING
  `;

  await sql`
    INSERT INTO agents (
      id, organization_id, name, owner_platform, owner_user_id
    )
    VALUES (
      ${agentId}, ${orgId}, ${options.name ?? agentId},
      ${options.ownerPlatform ?? null}, ${options.ownerUserId ?? null}
    )
    ON CONFLICT (organization_id, id) DO NOTHING
  `;
  return orgId;
}

/** Seed a `member` row (and the `user` it references) for an org. */
export async function seedOrgMembership(
  organizationId: string,
  userId: string,
  role: string
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, ${userId}, ${`${userId}@test`}, true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`m-${organizationId}-${userId}`}, ${organizationId}, ${userId}, ${role}, now())
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Seed the org's `github` connector_definitions row with the real connector's
 * feed declarations (webhook events/kind/match + attribution rules), so gateway
 * tests exercise the DB-driven dispatch path, not a server-side hardcode.
 */
export async function seedGithubConnectorDef(
  orgId: string,
  options: { version?: string; status?: string; feedsSchema?: Record<string, Record<string, unknown>> } = {},
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${orgId}, ${orgId}, ${orgId})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, feeds_schema, status, created_at, updated_at
    ) VALUES (
      ${orgId}, 'github', 'GitHub', ${options.version ?? "1.0.0"},
      ${sql.json(options.feedsSchema ?? declaredFeedsSchema(new GitHubConnector().definition))}, ${options.status ?? "active"}, NOW(), NOW()
    )
    ON CONFLICT DO NOTHING
  `;
}
