/**
 * Connection slug identity.
 *
 * Covers the stable `connections.slug` added so `lobu apply` can diff
 * connections by an immutable key: slugify rules, auto-generation from
 * display_name, per-org collision suffixing, cross-org reuse, the partial
 * unique index (live rows only), the `excludeId` no-op on update, the explicit
 * -slug guard (format validation + error-not-suffix on collision), the
 * concurrent-create insert retry, and that the migration backfill semantics
 * (deterministic base / base-N, soft-deleted rows excluded) agree with the
 * runtime helpers (`utils/connections.ts` — the source of truth).
 *
 * The `manage_connections` tool handlers thread these helpers (schema +
 * `resolveNewConnectionSlug` / `insertConnectionWithSlug` / `connectionSlugFormatError`).
 * The tool-level suite below covers inbound webhook creates: the UI form has no
 * slug input, so the server derives a readable, non-numeric slug when the caller
 * supplies none, and still rejects an explicitly numeric one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { __setChatInstanceManagerForTests } from '../../../lobu/gateway';
import { runtimeConnectionIdToSlug } from '../../../lobu/stores/connections-projection';
import { orgContext } from '../../../lobu/stores/org-context';
import { manageConnections } from '../../../tools/admin/manage_connections';
import type { ToolContext } from '../../../tools/registry';
import {
  CONNECTION_SLUG_PATTERN,
  ConnectionSlugConflictError,
  connectionSlugFormatError,
  ensureUniqueConnectionSlug,
  insertConnectionWithSlug,
  resolveNewConnectionSlug,
  slugifyConnectionName,
} from '../../../utils/connections';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { initWorkspaceProvider } from '../../../workspace';

async function rawInsertConnection(orgId: string, slug: string, displayName: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_at, updated_at)
    VALUES (${orgId}, 'x', ${slug}, ${displayName}, 'active', 'org', NOW(), NOW())
  `;
}

describe('connections.slug', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('slugifyConnectionName lowercases, hyphenates, and trims', () => {
    expect(slugifyConnectionName('Acme Gmail Inbox')).toBe('acme-gmail-inbox');
    expect(slugifyConnectionName('  --Weird__Name!! ')).toBe('weird-name');
    expect(slugifyConnectionName('!!!')).toBe('');
    expect(slugifyConnectionName(null)).toBe('');
  });

  it('auto-generates a slugified slug from the display name', async () => {
    const org = await createTestOrganization({ name: 'Slug Org A' });
    const slug = await ensureUniqueConnectionSlug({
      organizationId: org.id,
      connectorKey: 'google.gmail',
      displayName: 'Support Inbox',
    });
    expect(slug).toBe('support-inbox');
  });

  it('falls back to the connector key when the name has no alphanumerics', async () => {
    const org = await createTestOrganization({ name: 'Slug Org B' });
    const slug = await ensureUniqueConnectionSlug({
      organizationId: org.id,
      connectorKey: 'google.gmail',
      displayName: '!!!',
    });
    expect(slug).toBe('google-gmail');
  });

  it('gives colliding display names distinct slugs within an org', async () => {
    const org = await createTestOrganization({ name: 'Slug Org C' });
    const a = await createTestConnection({
      organization_id: org.id,
      connector_key: 'google.gmail',
      display_name: 'Shared Name',
    });
    const b = await createTestConnection({
      organization_id: org.id,
      connector_key: 'google.gmail',
      display_name: 'Shared Name',
    });

    const sql = getTestDb();
    const rows = await sql`SELECT id, slug FROM connections WHERE organization_id = ${org.id} ORDER BY id`;
    const slugs = rows.map((r) => r.slug as string);
    expect(slugs).toEqual(['shared-name', 'shared-name-2']);
    expect(a.id).not.toBe(b.id);
  });

  it('the same slug can be reused in a different org', async () => {
    const orgA = await createTestOrganization({ name: 'Slug Org D1' });
    const orgB = await createTestOrganization({ name: 'Slug Org D2' });
    const s1 = await ensureUniqueConnectionSlug({
      organizationId: orgA.id,
      connectorKey: 'x',
      displayName: 'My Conn',
    });
    await createTestConnection({
      organization_id: orgA.id,
      connector_key: 'x',
      display_name: 'My Conn',
      slug: s1,
    });
    const s2 = await ensureUniqueConnectionSlug({
      organizationId: orgB.id,
      connectorKey: 'x',
      displayName: 'My Conn',
    });
    expect(s1).toBe('my-conn');
    expect(s2).toBe('my-conn');
  });

  it('enforces the partial unique index per org among live rows', async () => {
    const org = await createTestOrganization({ name: 'Slug Org E' });
    const sql = getTestDb();
    await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_at, updated_at)
      VALUES (${org.id}, 'x', 'dup-slug', 'Dup 1', 'active', 'org', NOW(), NOW())
    `;
    await expect(
      sql`
        INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_at, updated_at)
        VALUES (${org.id}, 'x', 'dup-slug', 'Dup 2', 'active', 'org', NOW(), NOW())
      `
    ).rejects.toThrow();
  });

  it('soft-deleting a row frees its slug for a new live row', async () => {
    const org = await createTestOrganization({ name: 'Slug Org E2' });
    const sql = getTestDb();
    await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, deleted_at, created_at, updated_at)
      VALUES (${org.id}, 'x', 'freed-slug', 'Old', 'active', 'org', NOW(), NOW(), NOW())
    `;
    await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_at, updated_at)
      VALUES (${org.id}, 'x', 'freed-slug', 'New', 'active', 'org', NOW(), NOW())
    `;
    const live = await sql`
      SELECT COUNT(*)::int AS n FROM connections
      WHERE organization_id = ${org.id} AND slug = 'freed-slug' AND deleted_at IS NULL
    `;
    expect((live[0] as { n: number }).n).toBe(1);
  });

  it('ensureUniqueConnectionSlug with excludeId ignores the row being updated', async () => {
    const org = await createTestOrganization({ name: 'Slug Org F' });
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'x',
      display_name: 'Keep Me',
      slug: 'keep-me',
    });
    // Re-resolving "keep-me" while excluding the same connection returns it
    // unchanged (a no-op update doesn't bump the suffix).
    const slug = await ensureUniqueConnectionSlug({
      organizationId: org.id,
      connectorKey: 'x',
      explicitSlug: 'keep-me',
      excludeId: conn.id,
    });
    expect(slug).toBe('keep-me');
  });

  // ── explicit-slug guard ────────────────────────────────────────────────────

  it('rejects malformed explicit slugs at the boundary', () => {
    expect(connectionSlugFormatError('valid-slug-1')).toBeNull();
    expect(connectionSlugFormatError('a')).toBeNull();
    expect(connectionSlugFormatError('UPPER')).not.toBeNull();
    expect(connectionSlugFormatError('-leading')).not.toBeNull();
    expect(connectionSlugFormatError('has space')).not.toBeNull();
    expect(connectionSlugFormatError('dot.slug')).not.toBeNull();
    expect(connectionSlugFormatError('a'.repeat(64))).not.toBeNull();
    expect(connectionSlugFormatError('a'.repeat(63))).toBeNull();
    expect(CONNECTION_SLUG_PATTERN.test('ok-1')).toBe(true);
  });

  it('resolveNewConnectionSlug errors (does NOT suffix) on an explicit-slug collision', async () => {
    const org = await createTestOrganization({ name: 'Slug Org G' });
    await rawInsertConnection(org.id, 'taken-slug', 'First');

    const explicitConflict = await resolveNewConnectionSlug({
      organizationId: org.id,
      connectorKey: 'x',
      explicitSlug: 'taken-slug',
      displayName: 'Second',
    });
    expect(explicitConflict).toEqual({
      error: `Connection slug 'taken-slug' already exists for this organization.`,
    });

    // Same display name, no explicit slug → auto-generate-and-suffix is fine.
    const auto = await resolveNewConnectionSlug({
      organizationId: org.id,
      connectorKey: 'x',
      displayName: 'Taken Slug',
    });
    expect(auto).toEqual({ slug: 'taken-slug-2' });
  });

  it('resolveNewConnectionSlug rejects a malformed explicit slug', async () => {
    const org = await createTestOrganization({ name: 'Slug Org G2' });
    const res = await resolveNewConnectionSlug({
      organizationId: org.id,
      connectorKey: 'x',
      explicitSlug: 'Bad Slug',
    });
    expect('error' in res).toBe(true);
  });

  it('insertConnectionWithSlug: explicit conflict throws ConnectionSlugConflictError (no retry)', async () => {
    const org = await createTestOrganization({ name: 'Slug Org H' });
    await rawInsertConnection(org.id, 'race-slug', 'Existing');
    const sql = getTestDb();
    await expect(
      insertConnectionWithSlug({
        organizationId: org.id,
        connectorKey: 'x',
        displayName: 'New',
        initialSlug: 'race-slug',
        explicit: true,
        doInsert: (s) => sql`
          INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_at, updated_at)
          VALUES (${org.id}, 'x', ${s}, 'New', 'active', 'org', NOW(), NOW())
          RETURNING *
        `,
      })
    ).rejects.toBeInstanceOf(ConnectionSlugConflictError);
  });

  it('insertConnectionWithSlug: auto-generated path retries on conflict with a fresh suffix', async () => {
    const org = await createTestOrganization({ name: 'Slug Org I' });
    await rawInsertConnection(org.id, 'busy', 'Existing');
    const sql = getTestDb();
    const inserted = (await insertConnectionWithSlug({
      organizationId: org.id,
      connectorKey: 'x',
      displayName: 'Busy',
      initialSlug: 'busy', // stale candidate — already taken
      explicit: false,
      doInsert: (s) => sql`
        INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_at, updated_at)
        VALUES (${org.id}, 'x', ${s}, 'Busy', 'active', 'org', NOW(), NOW())
        RETURNING *
      `,
    })) as Array<{ slug: string }>;
    expect(inserted[0]?.slug).toBe('busy-2');
  });

  // ── backfill collision resolution / runtime agreement ─────────────────────

  it('backfill semantics: deterministic base / base-N among colliding rows, soft-deleted rows excluded', async () => {
    // createTestConnection inserts via ensureUniqueConnectionSlug — the same
    // algorithm the migration backfill mirrors. A soft-deleted row keeps the
    // clean slug and does NOT consume a suffix slot for live rows.
    const org = await createTestOrganization({ name: 'Slug Org J' });
    const sql = getTestDb();
    await rawInsertConnection(org.id, 'collide', 'Soft Deleted');
    await sql`UPDATE connections SET deleted_at = NOW() WHERE organization_id = ${org.id} AND slug = 'collide'`;

    await createTestConnection({ organization_id: org.id, connector_key: 'x', display_name: 'Collide' });
    await createTestConnection({ organization_id: org.id, connector_key: 'x', display_name: 'Collide' });
    await createTestConnection({ organization_id: org.id, connector_key: 'x', display_name: 'Collide' });

    const live = await sql`
      SELECT slug FROM connections
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
      ORDER BY id
    `;
    expect(live.map((r) => r.slug as string)).toEqual(['collide', 'collide-2', 'collide-3']);
  });

  it('backfill slugify rules agree with slugifyConnectionName', () => {
    // The migration uses lower(...) + regexp_replace('[^a-z0-9]+'->'-') + trim,
    // which is exactly slugifyConnectionName / generateSlug.
    for (const sample of ['Acme Gmail', 'X', 'a.b.c', '  weird__name!! ', '日本語 mix 7']) {
      const expected = sample
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      expect(slugifyConnectionName(sample)).toBe(expected);
    }
  });
});

const TEST_ENV = {} as Env;

function ctxFor(organizationId: string, userId: string): ToolContext {
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
    baseUrl: 'https://gateway.test/lobu',
  } as ToolContext;
}

describe('webhook connection create without an explicit slug', () => {
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    // Adapterless platforms never instantiate a chat adapter; a stub manager
    // satisfies the connection-service seam without gateway startup. Its
    // addConnection persists the row the way ChatInstanceManager.persistConnection
    // does (no secret normalization needed for a synthetic token).
    __setChatInstanceManagerForTests({
      resolveConnectionConfig: async (_id: unknown, cfg: unknown) => cfg,
      addConnection: async (
        platform: string,
        _agentId: unknown,
        config: unknown,
        _settings: unknown,
        metadata: { teamName?: string } | undefined,
        stableId: string,
      ) => {
        const orgId = orgContext.getStore()?.organizationId;
        if (!orgId) throw new Error('stub addConnection outside org context');
        const sql = getTestDb();
        await sql`
          INSERT INTO connections (
            organization_id, connector_key, display_name, status, config,
            credential_mode, slug, visibility, created_at, updated_at
          ) VALUES (
            ${orgId}, ${platform}, ${metadata?.teamName ?? null}, 'active',
            ${sql.json((config ?? {}) as Record<string, unknown>)}, 'byo',
            ${runtimeConnectionIdToSlug(stableId)}, 'org', now(), now()
          )
        `;
      },
      connectionMatches: () => false,
      updateConnection: async () => {},
    });
  });

  afterAll(() => {
    __setChatInstanceManagerForTests(null);
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Webhook Slug Org' });
    const user = await createTestUser({ name: 'Webhook Slug User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ctx = ctxFor(org.id, user.id);
    await createTestConnectorDefinition({ key: 'webhook', name: 'Inbound Webhook' });
    const sql = getTestDb();
    await sql`
      UPDATE connector_definitions
      SET options_schema = ${sql.json({ 'x-lobu-adapterless-platform': 'webhook' })}
      WHERE key = 'webhook'
    `;
  });

  it('creates the connection with a derived non-numeric slug when none is supplied', async () => {
    const res = await manageConnections(
      {
        action: 'create',
        connector_key: 'webhook',
        display_name: 'My Inbound Hook',
        config: { token: 'wh_test_token_0123456789abcdef0123456789abcdef' },
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in res ? res.error : undefined).toBeUndefined();
    if (!('connection' in res)) throw new Error('unexpected result shape');
    const slug = (res.connection as { slug: string }).slug;
    expect(slug).toMatch(/^agentconn-my-inbound-hook-[0-9a-f]{6}$/);
    expect(slug).not.toMatch(/^\d+$/);
  });

  it('still rejects an explicitly numeric slug', async () => {
    const res = await manageConnections(
      { action: 'create', connector_key: 'webhook', slug: '12345', display_name: 'Numeric Hook' },
      TEST_ENV,
      ctx,
    );
    expect('error' in res && typeof res.error === 'string' ? res.error : '').toMatch(
      /numeric/i,
    );
  });

  it('honors an explicit non-numeric slug', async () => {
    const res = await manageConnections(
      {
        action: 'create',
        connector_key: 'webhook',
        slug: 'orders-hook',
        display_name: 'Orders Hook',
        config: { token: 'wh_test_token_fedcba9876543210fedcba9876543210' },
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in res ? res.error : undefined).toBeUndefined();
    if (!('connection' in res)) throw new Error('unexpected result shape');
    expect((res.connection as { slug: string }).slug).toBe('agentconn-orders-hook');
  });
});
