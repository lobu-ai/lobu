/**
 * Test Fixtures
 *
 * Factory functions for creating test data in the database.
 * Each function creates the necessary records and returns the relevant IDs.
 */

import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { normalizeSlackUserId } from '@lobu/connectors/slack-identity';
import { serializeSigned } from 'hono/utils/cookie';
import { hashClientSecret } from '../../auth/oauth/clients';
import { NON_PUBLIC_OAUTH_SCOPES } from '../../auth/oauth/scopes';
import { slugify } from '@lobu/core';
import { generateSecureToken, hashToken } from '../../auth/oauth/utils';
import { pgBigintArray, pgTextArray } from '../../db/client';
import { ensureUniqueConnectionSlug } from '../../utils/connections';
import { getConfiguredEmbeddingModel } from '../../utils/embeddings';
import type { ToolContext } from '../../tools/registry';
import { provisionMemberAndCoreIdentities } from '../../auth/subject-identities';
import { getTestDb } from './test-db';

const TEST_SYSTEM_ORG_ID = 'default';
const TEST_AUTH_SECRET = 'test-auth-secret-for-testing-only';

// ============================================
// Organization Fixtures
// ============================================

export interface TestOrganization {
  id: string;
  name: string;
  slug: string;
}

export async function createTestOrganization(options?: {
  name?: string;
  slug?: string;
  description?: string | null;
  logo?: string | null;
  visibility?: 'public' | 'private';
}): Promise<TestOrganization> {
  const sql = getTestDb();
  const id = `org_${generateSecureToken(8)}`;
  const name = options?.name || `Test Org ${id.slice(4, 12)}`;
  const slug = options?.slug || `test-org-${id.slice(4, 12)}`;

  await sql`
    INSERT INTO "organization" (id, name, slug, description, logo, visibility, "createdAt")
    VALUES (
      ${id},
      ${name},
      ${slug},
      ${options?.description ?? null},
      ${options?.logo ?? null},
      ${options?.visibility ?? 'private'},
      NOW()
    )
  `;

  return { id, name, slug };
}

// ============================================
// User Fixtures
// ============================================

export interface TestUser {
  id: string;
  email: string;
  name: string;
  username: string;
}

interface TestAgent {
  agentId: string;
  organizationId: string;
  name: string;
}

export async function createTestUser(options?: {
  email?: string;
  name?: string;
  username?: string;
}): Promise<TestUser> {
  const sql = getTestDb();
  const id = `user_${generateSecureToken(8)}`;
  const email = options?.email || `${id.slice(5, 13)}@test.example.com`;
  const name = options?.name || `Test User ${id.slice(5, 13)}`;
  const baseUsername =
    options?.username ||
    email
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '');
  const username =
    baseUsername.length > 0
      ? `${baseUsername}-${id.slice(5, 9)}`
      : `user-${id.slice(5, 9)}`;

  await sql`
    INSERT INTO "user" (id, email, name, username, "emailVerified", "createdAt", "updatedAt")
    VALUES (${id}, ${email}, ${name}, ${username}, true, NOW(), NOW())
  `;

  return { id, email, name, username };
}

export async function addUserToOrganization(
  userId: string,
  organizationId: string,
  role: string = 'member',
): Promise<string> {
  const sql = getTestDb();
  const memberId = `member_${generateSecureToken(8)}`;

  await sql`
    INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
    VALUES (${memberId}, ${userId}, ${organizationId}, ${role}, NOW())
  `;

  return memberId;
}

/**
 * A `ToolContext` for an org owner with full MCP scopes — the shape connector
 * admin-tool tests need to call `manageConnections` / `manageFeeds` as the
 * connection owner.
 */
export function ownerToolContext(
  organizationId: string,
  userId: string,
): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  } as ToolContext;
}

/**
 * Seed an org with `user` as owner, returning both plus a ready owner
 * `ToolContext`. Collapses the org + user + membership + context boilerplate
 * that connector admin-tool tests otherwise repeat per case.
 */
export async function seedOwnerContext(opts?: {
  orgName?: string;
  userName?: string;
  visibility?: 'public' | 'private';
}): Promise<{ org: TestOrganization; user: TestUser; ctx: ToolContext }> {
  const org = await createTestOrganization({
    name: opts?.orgName ?? 'Test Org',
    ...(opts?.visibility ? { visibility: opts.visibility } : {}),
  });
  const user = await createTestUser({ name: opts?.userName ?? 'Test User' });
  await addUserToOrganization(user.id, org.id, 'owner');
  return { org, user, ctx: ownerToolContext(org.id, user.id) };
}

export async function createTestAgent(options: {
  organizationId: string;
  agentId?: string;
  name?: string;
  description?: string | null;
  ownerUserId?: string;
}): Promise<TestAgent> {
  const sql = getTestDb();
  const agentId =
    options.agentId ?? `agent-${generateSecureToken(8).toLowerCase()}`;
  const name = options.name ?? `Test Agent ${agentId.slice(-4)}`;
  const ownerUserId = options.ownerUserId ?? `user_${generateSecureToken(8)}`;

  await sql`
    INSERT INTO agents (
      id,
      organization_id,
      name,
      description,
      owner_platform,
      owner_user_id,
      created_at,
      updated_at
    ) VALUES (
      ${agentId},
      ${options.organizationId},
      ${name},
      ${options.description ?? null},
      'lobu',
      ${ownerUserId},
      NOW(),
      NOW()
    )
  `;

  return { agentId, organizationId: options.organizationId, name };
}

// ============================================
// Chat connection fixtures
// ============================================

/**
 * Seed a chat connection directly into the unified `connections` table in the
 * folded shape the runtime reads (mirror of `upsertChatConnectionProjection` +
 * the Stage-1 backfill). Replaces the legacy `INSERT INTO agent_connections`
 * fixture now that `connections` is the sole source of truth.
 *
 * `id` is the runtime connection id; the slug is derived the same way the
 * projection does (`slackinst-` ids pass through, everything else gets the
 * `agentconn-` namespace). `settings` and `metadata` fold into
 * `config.{settings,chatMetadata}`; `metadata.teamId` lifts into the first-class
 * `external_tenant_id` column. Legacy status maps stopped/* → paused.
 */
export async function insertChatConnectionRow(opts: {
  id: string;
  organizationId: string;
  agentId?: string | null;
  platform: string;
  status?: 'active' | 'stopped' | 'error' | 'paused';
  config?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  credentialMode?: 'byo' | 'managed';
}): Promise<void> {
  const sql = getTestDb();
  const slug = opts.id.startsWith('slackinst-')
    ? opts.id
    : `agentconn-${opts.id}`;
  const metadata = opts.metadata ?? {};
  const teamId =
    typeof metadata.teamId === 'string' && metadata.teamId.length > 0
      ? metadata.teamId
      : null;
  const teamName =
    typeof metadata.teamName === 'string' && metadata.teamName.length > 0
      ? metadata.teamName
      : null;
  const rawStatus = opts.status ?? 'active';
  const status =
    rawStatus === 'active'
      ? 'active'
      : rawStatus === 'error'
        ? 'error'
        : 'paused';
  const credentialMode =
    opts.credentialMode ??
    (opts.id.startsWith('slackinst-') ? 'managed' : 'byo');
  const foldedConfig = {
    ...(opts.config ?? {}),
    settings: opts.settings ?? {},
    chatMetadata: metadata,
  };

  await sql`
    INSERT INTO connections (
      organization_id, connector_key, external_tenant_id, agent_id, display_name,
      status, config, credential_mode, slug, visibility, created_at, updated_at
    ) VALUES (
      ${opts.organizationId}, ${opts.platform}, ${teamId}, ${opts.agentId ?? null},
      ${teamName ?? opts.platform}, ${status}, ${sql.json(foldedConfig)},
      ${credentialMode}, ${slug}, 'org', NOW(), NOW()
    )
    ON CONFLICT (organization_id, slug) WHERE deleted_at IS NULL DO UPDATE SET
      connector_key = EXCLUDED.connector_key,
      external_tenant_id = EXCLUDED.external_tenant_id,
      agent_id = EXCLUDED.agent_id,
      display_name = EXCLUDED.display_name,
      status = EXCLUDED.status,
      config = EXCLUDED.config,
      credential_mode = EXCLUDED.credential_mode,
      updated_at = NOW()
  `;
}

// ============================================
// Entity Fixtures
// ============================================

interface TestEntity {
  id: number;
  name: string;
  entity_type: string;
  organization_id: string;
}

/**
 * Re-seed system entity types after cleanupTestDatabase() truncates them.
 * Must be called in beforeAll if tests use manage_entity (which validates entity_type).
 */
export async function seedSystemEntityTypes(): Promise<void> {
  const sql = getTestDb();

  await sql`
    INSERT INTO "organization" (id, name, slug, "createdAt")
    VALUES (${TEST_SYSTEM_ORG_ID}, 'Lobu System', 'public-lobu', NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  // Brand gets a typed schema so metadata-validation tests can verify constraints
  const brandSchema = JSON.stringify({
    type: 'object',
    properties: {
      industry: { type: 'string' },
      founded_year: { type: 'number' },
      headquarters: { type: 'string' },
      website: { type: 'string' },
      domain: { type: 'string' },
      category: { type: 'string' },
    },
    additionalProperties: true,
  });

  const types: [string, string, string, string, string][] = [
    [
      'brand',
      'Brand',
      'A company, product line, or brand identity',
      '🏢',
      brandSchema,
    ],
    ['product', 'Product', 'A specific product, app, or service', '📦', '{}'],
    ['competitor', 'Competitor', 'A competing brand or product', '🎯', '{}'],
    ['feature', 'Feature', 'A product feature or capability', '✨', '{}'],
    ['campaign', 'Campaign', 'A marketing campaign or initiative', '📢', '{}'],
    ['topic', 'Topic', 'A subject area or theme to monitor', '💡', '{}'],
  ];

  for (const [slug, name, description, icon, schema] of types) {
    const existing = await sql`
      SELECT id
      FROM entity_types
      WHERE slug = ${slug}
        AND organization_id = ${TEST_SYSTEM_ORG_ID}
      LIMIT 1
    `;
    if (existing.length === 0) {
      await sql`
        INSERT INTO entity_types (
          organization_id,
          slug,
          name,
          description,
          icon,
          metadata_schema,
          created_at,
          updated_at
        )
        VALUES (
          ${TEST_SYSTEM_ORG_ID},
          ${slug},
          ${name},
          ${description},
          ${icon},
          ${sql.json(JSON.parse(schema))},
          current_timestamp,
          current_timestamp
        )
      `;
    } else {
      // Always refresh the schema in case a prior test run used an empty one
      await sql`
        UPDATE entity_types
        SET metadata_schema = ${sql.json(JSON.parse(schema))}
        WHERE slug = ${slug}
          AND organization_id = ${TEST_SYSTEM_ORG_ID}
      `;
    }
  }
}

export async function createTestEntity(options: {
  name: string;
  entity_type?: string;
  organization_id: string;
  parent_id?: number;
  domain?: string;
  created_by?: string;
}): Promise<TestEntity> {
  const sql = getTestDb();
  const slug = slugify(options.name);
  const metadata = options.domain ? { domain: options.domain } : {};

  // Resolve created_by: use provided user ID or find any existing user in the org
  let createdBy = options.created_by;
  if (!createdBy) {
    const members = await sql`
      SELECT "userId" FROM "member" WHERE "organizationId" = ${options.organization_id} LIMIT 1
    `;
    if (members.length > 0) {
      createdBy = members[0].userId as string;
    } else {
      createdBy = 'test-seed-user';
      await sql`
        INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
        VALUES (${createdBy}, 'Test Seed User', 'test-seed-user@example.com', 'test-seed-user', true, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  // Tests routinely create entities in fresh orgs without first calling
  // seedSystemEntityTypes(); ensure the requested type exists so the FK
  // (entities.entity_type_id) resolves without forcing every test to seed.
  const entityTypeSlug = options.entity_type || 'brand';
  let typeRows = await sql<{ id: number }[]>`
    SELECT id FROM entity_types
    WHERE slug = ${entityTypeSlug}
      AND organization_id = ${options.organization_id}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (typeRows.length === 0) {
    typeRows = await sql<{ id: number }[]>`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${options.organization_id}, ${entityTypeSlug}, ${entityTypeSlug}, current_timestamp, current_timestamp)
      RETURNING id
    `;
  }
  const entityTypeId = typeRows[0].id;

  const [inserted] = await sql`
    INSERT INTO entities (
      name,
      slug,
      entity_type_id,
      organization_id,
      parent_id,
      metadata,
      created_by,
      created_at,
      updated_at
    ) VALUES (
      ${options.name},
      ${slug},
      ${entityTypeId},
      ${options.organization_id},
      ${options.parent_id || null},
      ${sql.json(metadata)},
      ${createdBy},
      NOW(), NOW()
    )
    RETURNING id
  `;

  return {
    id: Number(inserted.id),
    name: options.name,
    entity_type: options.entity_type || 'brand',
    organization_id: options.organization_id,
  };
}

// ============================================
// OAuth Client Fixtures
// ============================================

export interface TestOAuthClient {
  client_id: string;
  client_secret: string; // Plaintext for testing
  redirect_uris: string[];
}

export async function createTestOAuthClient(options?: {
  redirect_uris?: string[];
  client_name?: string | null;
  grant_types?: string[];
  software_id?: string | null;
  software_version?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<TestOAuthClient> {
  const sql = getTestDb();
  const client_id = `mcp_${generateSecureToken(16)}`;
  const client_secret = `secret_${generateSecureToken(32)}`;
  const redirect_uris = options?.redirect_uris || [
    'http://localhost:3000/callback',
  ];
  const grant_types = options?.grant_types || [
    'authorization_code',
    'refresh_token',
  ];
  const clientName =
    options && Object.hasOwn(options, 'client_name')
      ? (options.client_name ?? null)
      : 'Test Client';

  await sql`
    INSERT INTO oauth_clients (
      id, client_secret, redirect_uris, grant_types, response_types,
      token_endpoint_auth_method, client_name, software_id, software_version, metadata, created_at, updated_at
    ) VALUES (
      ${client_id},
      ${hashClientSecret(client_secret)},
      ${pgTextArray(redirect_uris)}::text[],
      ${pgTextArray(grant_types)}::text[],
      ${pgTextArray(['code'])}::text[],
      'client_secret_post',
      ${clientName},
      ${options?.software_id ?? null},
      ${options?.software_version ?? null},
      ${sql.json((options?.metadata || {}) as Record<string, string>)},
      NOW(), NOW()
    )
  `;

  return { client_id, client_secret, redirect_uris };
}

// ============================================
// Token Fixtures
// ============================================

interface TestAccessToken {
  token: string;
  userId: string;
  organizationId: string;
}

export async function createTestAccessToken(
  userId: string,
  organizationId: string,
  clientId: string,
  options?: {
    expiresIn?: number; // seconds
    scope?: string;
    resource?: string | null;
    grantedOrganizationIds?: string[] | null;
  },
): Promise<TestAccessToken> {
  const sql = getTestDb();
  const token = generateSecureToken(32);
  const tokenHash = hashToken(token);
  const id = generateSecureToken(16);
  const expiresAt = new Date(Date.now() + (options?.expiresIn || 3600) * 1000);
  const scope = options?.scope || 'mcp:read mcp:write';
  // Only the device-code flow can mint private scopes — mirrored by the
  // oauth_tokens_private_scopes_require_device_grant check constraint.
  const grantType = scope
    .split(/\s+/)
    .some((s) => (NON_PUBLIC_OAUTH_SCOPES as readonly string[]).includes(s))
    ? 'device_code'
    : null;

  const grantedOrganizationIds = options?.grantedOrganizationIds === undefined
    ? [organizationId]
    : options.grantedOrganizationIds;

  await sql`
    INSERT INTO oauth_tokens (
      id, token_type, token_hash, client_id, user_id, organization_id,
      granted_organization_ids, authorization_grant_type, scope, resource, expires_at, created_at
    ) VALUES (
      ${id}, 'access', ${tokenHash}, ${clientId}, ${userId}, ${organizationId},
      ${grantedOrganizationIds === null ? null : pgTextArray(grantedOrganizationIds)}::text[],
      ${grantType}, ${scope}, ${options?.resource ?? null}, ${expiresAt}, NOW()
    )
  `;

  return { token, userId, organizationId };
}

export async function createExpiredAccessToken(
  userId: string,
  organizationId: string,
  clientId: string,
): Promise<TestAccessToken> {
  const sql = getTestDb();
  const token = generateSecureToken(32);
  const tokenHash = hashToken(token);
  const id = generateSecureToken(16);
  const expiresAt = new Date(Date.now() - 3600 * 1000); // Expired 1 hour ago

  await sql`
    INSERT INTO oauth_tokens (
      id, token_type, token_hash, client_id, user_id, organization_id,
      scope, expires_at, created_at
    ) VALUES (
      ${id}, 'access', ${tokenHash}, ${clientId}, ${userId}, ${organizationId},
      'mcp:read mcp:write', ${expiresAt}, NOW() - INTERVAL '2 hours'
    )
  `;

  return { token, userId, organizationId };
}

// ============================================
// Personal Access Token Fixtures
// ============================================

interface TestPAT {
  token: string;
  userId: string;
  organizationId: string;
}

export async function createTestPAT(
  userId: string,
  organizationId: string,
  options?: { scope?: string },
): Promise<TestPAT> {
  const sql = getTestDb();
  const token = `owl_pat_${generateSecureToken(24)}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.substring(0, 12);

  await sql`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, scope, created_at, updated_at
    ) VALUES (
      ${tokenHash}, ${tokenPrefix}, ${userId}, ${organizationId}, 'Test PAT', ${options?.scope ?? null}, NOW(), NOW()
    )
  `;

  return { token, userId, organizationId };
}

// ============================================
// Connector Definition Fixtures
// ============================================

interface TestConnectorDefinition {
  key: string;
  name: string;
}

export async function createTestConnectorDefinition(options: {
  key: string;
  name: string;
  version?: string;
  feeds_schema?: Record<string, Record<string, unknown>>;
  auth_schema?: Record<string, unknown>;
  automation_events?: Array<Record<string, unknown>>;
  organization_id?: string | null;
}): Promise<TestConnectorDefinition> {
  const sql = getTestDb();
  const version = options.version ?? '1.0.0';
  // The fixture runtime below implements sync for every declared feed. Mirror
  // the compiler's handler-derived metadata so test definitions cannot claim
  // fewer capabilities than the runtime they install. Preserve explicit
  // operations (including []) for capability-validation tests.
  const feedsSchema = Object.fromEntries(
    Object.entries(options.feeds_schema ?? { default: {} }).map(
      ([feedKey, rawDefinition]) => {
        const definition =
          rawDefinition && typeof rawDefinition === 'object'
            ? rawDefinition
            : {};
        return [
          feedKey,
          {
            ...definition,
            operations: Array.isArray(definition.operations)
              ? definition.operations
              : ['sync'],
          },
        ];
      },
    ),
  );

  await sql`
    INSERT INTO connector_definitions (
      key, name, version, feeds_schema, auth_schema, automation_events,
      organization_id,
      status, created_at, updated_at
    ) VALUES (
      ${options.key},
      ${options.name},
      ${version},
      ${sql.json(feedsSchema)},
      ${sql.json(options.auth_schema ?? {})},
      ${options.automation_events ? sql.json(options.automation_events) : null},
      ${options.organization_id ?? null},
      'active',
      NOW(), NOW()
    )
  `;

  // Also insert a connector_versions row so trigger_feed / createSyncRun can
  // find compiled code. Stamped with the current compile-config fingerprint,
  // exactly like the real install paths — an unstamped artifact is treated as
  // stale by resolveConnectorCode and refused.
  await sql`
    INSERT INTO connector_versions (
      connector_key, version, compiled_code, compile_config_hash, created_at
    ) VALUES (
      ${options.key},
      ${version},
      ${'module.exports = { sync: async () => ({ items: [] }) }'},
      ${COMPILE_CONFIG_HASH},
      NOW()
    )
    ON CONFLICT DO NOTHING
  `;

  return { key: options.key, name: options.name };
}

// ============================================
// Connection Fixtures
// ============================================

interface TestConnection {
  id: number;
  connector_key: string;
  status: string;
}

export async function createTestConnection(options: {
  organization_id: string;
  connector_key: string;
  entity_ids?: number[];
  status?: string;
  display_name?: string;
  slug?: string;
  created_by?: string;
  visibility?: 'org' | 'private';
  /** Persisted into the connection `config` JSONB (e.g. `{ managedBy: { org } }`). */
  config?: Record<string, unknown>;
  /**
   * Whether to create the default feed (true = the historical semantics). Pass
   * `false` for consent-only / managed-grant connections, which must have no
   * feeds.
   */
  createDefaultFeed?: boolean;
}): Promise<TestConnection> {
  const sql = getTestDb();

  const displayName =
    options.display_name ?? `Test Connection ${options.connector_key}`;
  const slug = await ensureUniqueConnectionSlug({
    organizationId: options.organization_id,
    connectorKey: options.connector_key,
    explicitSlug: options.slug,
    displayName,
  });

  const entityIdsLiteral = options.entity_ids
    ? pgBigintArray(options.entity_ids)
    : null;
  const [inserted] = await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      created_by, visibility, config, created_at, updated_at
    ) VALUES (
      ${options.organization_id},
      ${options.connector_key},
      ${slug},
      ${displayName},
      ${options.status ?? 'active'},
      ${options.created_by ?? null},
      ${options.visibility ?? 'org'},
      ${options.config ? sql.json(options.config as Record<string, string>) : null},
      NOW(), NOW()
    )
    RETURNING id, connector_key, status
  `;

  if (options.createDefaultFeed !== false) {
    await sql`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, status, entity_ids, created_at, updated_at
      ) VALUES (
        ${options.organization_id},
        ${inserted.id},
        'default',
        ${options.status ?? 'active'},
        ${entityIdsLiteral}::bigint[],
        NOW(),
        NOW()
      )
    `;
  }

  return {
    id: Number(inserted.id),
    connector_key: String(inserted.connector_key),
    status: String(inserted.status),
  };
}

// ============================================
// Event Fixtures
// ============================================

interface TestEvent {
  id: number;
  origin_id: string;
}

export async function createTestEvent(options: {
  entity_id?: number;
  connection_id?: number;
  feed_id?: number;
  feed_key?: string;
  automation_id?: number;
  automation_version_id?: number;
  title?: string;
  content: string;
  occurred_at?: Date;
  /**
   * When Lobu stored the row — the axis Automation windows run on.
   *
   * Defaults to `NOW()`, which the suite's collapsed arrival settle window
   * (see `vitest.config.ts`) makes immediately claimable. Set it to simulate a
   * late arrival, or to exercise the settle window itself.
   */
  created_at?: Date;
  origin_id?: string;
  embedding?: number[];
  /** Model stamp for the embedding. Defaults to the configured model (mirrors
   *  real ingestion, which always stamps); set null to simulate a legacy row. */
  embedding_model?: string | null;
  semantic_type?: string;
  connector_key?: string;
  entity_ids?: number[];
  organization_id?: string;
  metadata?: Record<string, unknown>;
}): Promise<TestEvent> {
  const sql = getTestDb();
  const originId = options.origin_id ?? `test-event-${generateSecureToken(8)}`;
  const resolvedEntityIds =
    options.entity_ids ??
    (options.entity_id != null ? [options.entity_id] : []);
  const entityIdsLiteral = pgBigintArray(resolvedEntityIds);

  // Resolve organization_id from the first entity if not provided
  let organizationId = options.organization_id ?? null;
  if (!organizationId && resolvedEntityIds.length > 0) {
    const entityRow =
      await sql`SELECT organization_id FROM entities WHERE id = ${resolvedEntityIds[0]}`;
    if (entityRow.length > 0)
      organizationId = entityRow[0].organization_id as string;
  }

  let inserted: { id: number | string; origin_id: string };
  [inserted] = await sql`
    INSERT INTO events (
      entity_ids, connection_id, feed_id, feed_key, automation_id, automation_version_id, origin_id,
      title, payload_type, payload_text, occurred_at, semantic_type,
      connector_key, metadata,
      organization_id, created_at
    ) VALUES (
      ${entityIdsLiteral}::bigint[],
      ${options.connection_id ?? null},
      ${options.feed_id ?? null},
      ${options.feed_key ?? null},
      ${options.automation_id ?? null},
      ${options.automation_version_id ?? null},
      ${originId},
      ${options.title ?? null},
      'text',
      ${options.content},
      ${options.occurred_at ?? new Date()},
      ${options.semantic_type ?? 'content'},
      ${options.connector_key ?? 'test.connector'},
      ${sql.json((options.metadata ?? {}) as Record<string, string>)},
      ${organizationId},
      ${options.created_at ?? sql`NOW()`}
    )
    RETURNING id, origin_id
  `;

  if (options.embedding) {
    // Stamp the configured model by default so vector-scoped search (which only
    // compares same-model rows) sees these fixtures; pass embedding_model: null
    // to deliberately simulate a legacy unstamped row.
    const stamp =
      options.embedding_model === undefined
        ? getConfiguredEmbeddingModel()
        : options.embedding_model;
    await sql`
      INSERT INTO event_embeddings (event_id, embedding, embedding_model)
      VALUES (${inserted.id}, ${JSON.stringify(options.embedding)}::vector, ${stamp})
    `;
  }

  return {
    id: Number(inserted.id),
    origin_id: String(inserted.origin_id),
  };
}

// ============================================
// Session Fixtures (for requireAuth-protected endpoints)
// ============================================

interface TestSession {
  sessionId: string;
  token: string;
  userId: string;
  cookieHeader: string;
}

export async function createTestSession(userId: string): Promise<TestSession> {
  const sql = getTestDb();
  const sessionId = `session_${generateSecureToken(16)}`;
  const token = generateSecureToken(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const signedCookie = await serializeSigned(
    'better-auth.session_token',
    token,
    TEST_AUTH_SECRET,
    {
    httpOnly: true,
    path: '/',
    sameSite: 'Lax',
    },
  );

  await sql`
    INSERT INTO "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
    VALUES (${sessionId}, ${token}, ${userId}, ${expiresAt}, NOW(), NOW())
  `;

  return {
    sessionId,
    token,
    userId,
    cookieHeader: signedCookie.split(';', 1)[0] || '',
  };
}

// ============================================
// Device Code Fixtures
// ============================================

interface TestDeviceCode {
  deviceCode: string;
  userCode: string;
  clientId: string;
}

export async function createTestDeviceCode(
  clientId: string,
  options?: {
    scope?: string;
    resource?: string;
  },
): Promise<TestDeviceCode> {
  const sql = getTestDb();
  const deviceCode = `dc_${generateSecureToken(16)}`;
  const userCode =
    `${generateSecureToken(2).toUpperCase()}-${generateSecureToken(2).toUpperCase()}`.slice(
      0,
      9,
    );
  const expiresAt = new Date(Date.now() + 600 * 1000); // 10 min

  await sql`
    INSERT INTO oauth_device_codes (
      device_code, user_code, client_id,
      scope, resource, status, poll_interval, expires_at
    ) VALUES (
      ${deviceCode}, ${userCode}, ${clientId},
      ${options?.scope ?? 'mcp:read mcp:write'}, ${options?.resource ?? null},
      'pending', 5, ${expiresAt}
    )
  `;

  return { deviceCode, userCode, clientId };
}

// ============================================
// Automation result fixture
// ============================================

/** Create or complete the run that owns an Automation result. */
export async function createAutomationResultRun(options: {
  automationId: number;
  organizationId: string;
  windowStart: Date | string;
  windowEnd: Date | string;
  extractedData?: Record<string, unknown>;
  contentAnalyzed?: number;
  versionId?: number | null;
  runId?: number | null;
  createdBy?: string | null;
  createdAt?: Date | string | null;
  entityIds?: number[];
  clientId?: string | null;
  modelUsed?: string | null;
  runMetadata?: Record<string, unknown> | null;
}): Promise<number> {
  const sql = getTestDb();
  const windowStartIso = new Date(options.windowStart as string).toISOString();
  const windowEndIso = new Date(options.windowEnd as string).toISOString();
  const approvedInput = {
    window_start: windowStartIso,
    window_end: windowEndIso,
    version_id: options.versionId ?? null,
  };
  const runMetadata = {
    ...(options.runMetadata ?? {}),
    content_analyzed: options.contentAnalyzed ?? 0,
    ...(options.clientId ? { client_id: options.clientId } : {}),
  };
  if (options.runId != null) {
    const [row] = await sql`
      UPDATE runs
      SET status = 'completed',
          outcome = 'scoreable',
          action_output = ${sql.json(options.extractedData ?? {})},
          approved_input = COALESCE(approved_input, '{}'::jsonb) || ${sql.json(approvedInput)}::jsonb,
          model_used = COALESCE(${options.modelUsed ?? null}, model_used),
          run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ${sql.json(runMetadata)}::jsonb,
          completed_at = ${options.createdAt != null ? new Date(options.createdAt as string) : new Date(windowEndIso)}
      WHERE id = ${options.runId}
      RETURNING id
    `;
    if (!row) throw new Error(`Automation run ${options.runId} not found`);
    return Number(row.id);
  }

  const [row] = await sql`
    INSERT INTO runs (
      organization_id, run_type, automation_id, status, outcome,
      action_output, approved_input, model_used, run_metadata,
      created_by_user_id, created_at, completed_at
    ) VALUES (
      ${options.organizationId}, 'automation', ${options.automationId}, 'completed', 'scoreable',
      ${sql.json(options.extractedData ?? {})}, ${sql.json(approvedInput)},
      ${options.modelUsed ?? null}, ${sql.json(runMetadata)}, ${options.createdBy ?? null},
      ${options.createdAt != null ? new Date(options.createdAt as string) : new Date(windowEndIso)},
      ${options.createdAt != null ? new Date(options.createdAt as string) : new Date(windowEndIso)}
    )
    RETURNING id
  `;
  return Number(row.id);
}

/**
 * Link a Slack workspace user to a Lobu user the way production does: provision
 * the user's `$member` in the org (which writes the `auth_user_id` identity)
 * and stamp the workspace-scoped `TEAM:USER` `slack_user_id` identity onto it.
 *
 * This replaces seeding the old `chat_user_identities` table. Going through the
 * real provisioning call matters — the resolver joins `slack_user_id` to
 * `auth_user_id` with `source_connector = 'auth:signup'`, so a hand-rolled
 * INSERT that skipped that would pass while production failed.
 */
export async function linkSlackIdentityInGraph(opts: {
  organizationId: string;
  userId: string;
  teamId: string;
  slackUserId: string;
}): Promise<void> {
  const sql = getTestDb();
  const users = await sql<{ email: string | null }>`
    SELECT email FROM "user" WHERE id = ${opts.userId} LIMIT 1
  `;
  const email = users[0]?.email;
  if (!email) throw new Error(`no user row for ${opts.userId}`);

  const { memberEntityId } = await provisionMemberAndCoreIdentities(
    opts.organizationId,
    { userId: opts.userId, email },
  );

  const identifier = normalizeSlackUserId(opts.teamId, opts.slackUserId);
  if (!identifier) {
    throw new Error(
      `unnormalizable Slack identity: ${opts.teamId}/${opts.slackUserId}`,
    );
  }
  await sql`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector
    ) VALUES (
      ${opts.organizationId}, ${memberEntityId}, 'slack_user_id', ${identifier}, 'auth:signup'
    )
    ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, '')) WHERE deleted_at IS NULL
    DO NOTHING
  `;
}
