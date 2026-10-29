/**
 * Who can see what through `search_memory` (`search()` in tools/search.ts).
 *
 * - Connection visibility on the entity view: the `connections` list returns
 *   only org-visible and self-owned connections, and hidden private
 *   connections never count toward entity stats or suggestions.
 * - Connection visibility on the recall path (`search()` with include_content).
 *   Regression for a private-connection content leak: `fetchContentSnippets`
 *   called `searchContentByText` WITHOUT a `visibility_scope`, so the
 *   connection-visibility clause (`buildConnectionVisibilityClause`) was
 *   skipped entirely — it short-circuits to an empty fragment when
 *   `visibility_scope.organizationId` is undefined. Because `search_memory` is
 *   publicly readable (tool-access.ts: `search_memory: null`) and
 *   `include_content` defaults to true, any org member — or an anonymous reader
 *   of a public workspace — could recall content ingested through another
 *   member's `private` connection. Uses explicit embeddings so the recall
 *   candidate path is deterministic without a live embedding service.
 * - The `$member` read policy, mirroring manage_entity list/get: non-members
 *   (including anonymous public-org readers) never see member entities, members
 *   without admin/owner see them with the email redacted, and cross-workspace
 *   `$member` rows are never visible. Regression: search served `$member`
 *   metadata (with emails) to anonymous callers on public orgs while
 *   manage_entity denied the same list. query_sql enforces the same policy.
 * - Content counts are bounded probes, and visibility filtering applies BEFORE
 *   the cap. `entitySelectColumns` / the children query count via
 *   `SELECT COUNT(*) FROM (SELECT 1 ... LIMIT 1001)`, so counts saturate at 1001
 *   instead of walking an entity's full history. A count that excluded hidden
 *   rows only after capping could leak (or undercount).
 *
 * Every describe seeds its own organizations into one shared database.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { search, type SearchArgs } from '../../../tools/search';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

function ctxFor(
  orgId: string,
  userId: string | null,
  memberRole: 'owner' | 'admin' | 'member' | null = 'member'
): ToolContext {
  return {
    organizationId: orgId,
    userId,
    memberRole: userId ? memberRole : null,
    isAuthenticated: !!userId,
    tokenType: userId ? 'oauth' : 'anonymous',
    scopedToOrg: !userId,
    allowCrossOrg: !!userId,
    scopes: userId ? ['mcp:read'] : undefined,
  };
}

const EMBEDDING_DIM = 768;

function axisVec(axis: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[axis] = 1;
  return v;
}

async function bulkSeedEvents(args: {
  entityId: number;
  organizationId: string;
  connectionId: number;
  count: number;
  label: string;
}) {
  const sql = getTestDb();
  await sql.unsafe(
    `INSERT INTO events (id, organization_id, entity_ids, title, payload_text, occurred_at, created_at, connector_key, connection_id)
     SELECT nextval('content_id_seq'), $1, ARRAY[$2]::bigint[],
            $4 || ' ' || g, 'body ' || g, NOW(), NOW(), 'saturation-connector', $3
     FROM generate_series(1, $5) g`,
    [args.organizationId, args.entityId, args.connectionId, args.label, args.count]
  );
}

beforeAll(async () => {
  await initWorkspaceProvider();
  await cleanupTestDatabase();
  await seedSystemEntityTypes();
});

describe('search_memory connection visibility', () => {
  let orgId: string;
  let entityId: number;
  let privateOnlyEntityId: number;
  let ownerUserId: string;
  let adminUserId: string;
  let memberUserId: string;
  let orgConnectionId: number;
  let ownerPrivateConnectionId: number;
  let memberPrivateConnectionId: number;
  let legacyUnownedConnectionId: number;
  let deletedOrgConnectionId: number;
  let foreignOrgConnectionId: number;

  beforeAll(async () => {
    const org = await createTestOrganization({ name: 'Search Conn Visibility Org' });
    orgId = org.id;

    const owner = await createTestUser();
    const admin = await createTestUser();
    const member = await createTestUser();
    ownerUserId = owner.id;
    adminUserId = admin.id;
    memberUserId = member.id;
    await addUserToOrganization(ownerUserId, orgId, 'owner');
    await addUserToOrganization(adminUserId, orgId, 'admin');
    await addUserToOrganization(memberUserId, orgId, 'member');

    const entity = await createTestEntity({
      name: 'Visibility Probe Co',
      entity_type: 'company',
      organization_id: orgId,
      created_by: ownerUserId,
    });
    entityId = entity.id;
    privateOnlyEntityId = (
      await createTestEntity({
        name: 'Private Connection Only Co',
        entity_type: 'company',
        organization_id: orgId,
        created_by: ownerUserId,
      })
    ).id;

    const mk = async (opts: {
      display_name: string;
      created_by?: string;
      visibility: 'org' | 'private';
    }) =>
      (
        await createTestConnection({
          organization_id: orgId,
          connector_key: 'github',
          display_name: opts.display_name,
          entity_ids: [entityId],
          created_by: opts.created_by,
          visibility: opts.visibility,
        })
      ).id;

    orgConnectionId = await mk({
      display_name: 'Org Visible GitHub',
      created_by: ownerUserId,
      visibility: 'org',
    });
    ownerPrivateConnectionId = await mk({
      display_name: 'Owner Private GitHub',
      created_by: ownerUserId,
      visibility: 'private',
    });
    memberPrivateConnectionId = await mk({
      display_name: 'Member Private GitHub',
      created_by: memberUserId,
      visibility: 'private',
    });
    legacyUnownedConnectionId = await mk({
      display_name: 'Legacy Unowned GitHub',
      visibility: 'private',
    });
    deletedOrgConnectionId = await mk({
      display_name: 'Soft Deleted GitHub',
      created_by: ownerUserId,
      visibility: 'org',
    });
    await createTestConnection({
      organization_id: orgId,
      connector_key: 'github',
      display_name: 'Private Only GitHub',
      entity_ids: [privateOnlyEntityId],
      created_by: ownerUserId,
      visibility: 'private',
    });

    await getTestDb()`
      UPDATE connections SET deleted_at = NOW() WHERE id = ${deletedOrgConnectionId}
    `;

    const foreignOrg = await createTestOrganization({ name: 'Foreign Search Org' });
    foreignOrgConnectionId = (
      await createTestConnection({
        organization_id: foreignOrg.id,
        connector_key: 'github',
        display_name: 'Foreign Org GitHub',
        entity_ids: [entityId],
        visibility: 'org',
      })
    ).id;
  });

  async function connectionIdsFor(ctx: ToolContext): Promise<number[]> {
    const result = await search(
      { entity_id: entityId, include_content: false },
      {} as Parameters<typeof search>[1],
      ctx
    );
    return (result.connections ?? []).map((connection) => Number(connection.connection_id));
  }

  it('returns only org-visible and self-owned connections to a member', async () => {
    const ids = await connectionIdsFor(ctxFor(orgId, memberUserId, 'member'));

    expect(ids).toContain(orgConnectionId);
    expect(ids).toContain(memberPrivateConnectionId);
    expect(ids).not.toContain(ownerPrivateConnectionId);
    expect(ids).not.toContain(legacyUnownedConnectionId);
    expect(ids).not.toContain(foreignOrgConnectionId);
  });

  it('still returns the owner their own private connection', async () => {
    const ids = await connectionIdsFor(ctxFor(orgId, ownerUserId, 'owner'));

    expect(ids).toContain(ownerPrivateConnectionId);
    expect(ids).toContain(orgConnectionId);
    expect(ids).not.toContain(legacyUnownedConnectionId);
    expect(ids).not.toContain(memberPrivateConnectionId);
  });

  it('shows an admin org-visible connections only — legacy-unowned rows are no longer a separate admin tier', async () => {
    const ids = await connectionIdsFor(ctxFor(orgId, adminUserId, 'admin'));

    expect(ids).toContain(orgConnectionId);
    // No admin arm: a private connection with no creator is invisible to
    // everyone, including admins — matching the FK/events surfaces so there is
    // no split-brain where connections.list shows a row the content paths hide.
    expect(ids).not.toContain(legacyUnownedConnectionId);
    expect(ids).not.toContain(ownerPrivateConnectionId);
    expect(ids).not.toContain(memberPrivateConnectionId);
  });

  it('gives an anonymous caller org-visible connections only', async () => {
    const ids = await connectionIdsFor(ctxFor(orgId, null, null));

    expect(ids).toContain(orgConnectionId);
    expect(ids).not.toContain(ownerPrivateConnectionId);
    expect(ids).not.toContain(memberPrivateConnectionId);
    expect(ids).not.toContain(legacyUnownedConnectionId);
  });

  it('excludes soft-deleted connections', async () => {
    const ids = await connectionIdsFor(ctxFor(orgId, ownerUserId, 'owner'));

    expect(ids).not.toContain(deletedOrgConnectionId);
  });

  it('does not count hidden private connections in entity stats or suggestions', async () => {
    const result = await search(
      { entity_id: privateOnlyEntityId, include_content: false },
      {} as Parameters<typeof search>[1],
      ctxFor(orgId, memberUserId, 'member')
    );

    expect(result.connections).toEqual([]);
    expect(result.entity?.stats.connection_count).toBe(0);
    expect(result.entity?.stats.active_connection_count).toBe(0);
    expect(result.suggestion).toContain('no connections');
  });
});

describe('search_memory recall > connection visibility enforced', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let aliceUser: Awaited<ReturnType<typeof createTestUser>>;
  let bobUser: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  let orgEventId: number;
  let alicePrivateEventId: number;
  let bobPrivateEventId: number;

  // search() needs a query, entity_id, or embedding. Forwarding the embedding
  // exercises fetchContentSnippets' bounded recall candidate path the same way
  // production does, with deterministic similarity (all targets share axis 0).
  async function recall(ctx: ToolContext) {
    const result = await search(
      {
        query: 'recall-visibility-probe',
        query_embedding: axisVec(0),
        include_content: true,
        content_limit: 50,
      } as never,
      {} as never,
      ctx
    );
    return new Set((result.content ?? []).map((c) => c.id));
  }

  beforeAll(async () => {
    org = await createTestOrganization({ name: 'Recall Visibility Org' });
    aliceUser = await createTestUser({ email: 'alice-recall@example.com' });
    bobUser = await createTestUser({ email: 'bob-recall@example.com' });
    await addUserToOrganization(aliceUser.id, org.id, 'owner');
    await addUserToOrganization(bobUser.id, org.id, 'owner');

    entity = await createTestEntity({ name: 'Recall Entity', organization_id: org.id });

    await createTestConnectorDefinition({
      key: 'recall-vis-connector',
      name: 'Recall Vis',
      organization_id: org.id,
    });

    const orgConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'recall-vis-connector',
      entity_ids: [entity.id],
      visibility: 'org',
      created_by: aliceUser.id,
      display_name: 'Org-visible',
    });
    const alicePrivConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'recall-vis-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: aliceUser.id,
      display_name: 'Alice private',
    });
    const bobPrivConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'recall-vis-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: bobUser.id,
      display_name: 'Bob private',
    });

    orgEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: orgConn.id,
        content: 'org-visible recall target',
        embedding: axisVec(0),
      })
    ).id;
    alicePrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: alicePrivConn.id,
        content: 'alice private recall target',
        embedding: axisVec(0),
      })
    ).id;
    bobPrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: bobPrivConn.id,
        content: 'bob private recall target',
        embedding: axisVec(0),
      })
    ).id;
  });

  it('an org member does NOT recall another member private-connection content', async () => {
    const ids = await recall(ctxFor(org.id, bobUser.id, 'owner'));
    // Bob sees org-visible content and his own private content...
    expect(ids.has(orgEventId)).toBe(true);
    expect(ids.has(bobPrivateEventId)).toBe(true);
    // ...but NOT Alice's private connection content (the leak).
    expect(ids.has(alicePrivateEventId)).toBe(false);
  });

  it('the owning member DOES recall their own private-connection content', async () => {
    const ids = await recall(ctxFor(org.id, aliceUser.id, 'owner'));
    expect(ids.has(orgEventId)).toBe(true);
    expect(ids.has(alicePrivateEventId)).toBe(true);
    expect(ids.has(bobPrivateEventId)).toBe(false);
  });

  it('an anonymous public-workspace reader recalls only org-visible content', async () => {
    const ids = await recall(ctxFor(org.id, null, null));
    expect(ids.has(orgEventId)).toBe(true);
    expect(ids.has(alicePrivateEventId)).toBe(false);
    expect(ids.has(bobPrivateEventId)).toBe(false);
  });
});

const MEMBER_EMAIL = 'search-member-visibility@test.example.com';

describe('search_memory $member visibility', () => {
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let otherOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let member: Awaited<ReturnType<typeof createTestUser>>;
  let memberEntityId: number;

  function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      organizationId: publicOrg.id,
      userId: null,
      memberRole: null,
      isAuthenticated: false,
      tokenType: 'anonymous',
      scopedToOrg: true,
      allowCrossOrg: false,
      ...overrides,
    } as ToolContext;
  }

  async function searchAs(args: Partial<SearchArgs>, context: ToolContext) {
    return search(
      { query: 'Search Member', include_content: false, ...args },
      {} as Env,
      context
    );
  }

  function memberHits(result: Awaited<ReturnType<typeof search>>) {
    return (result.matches ?? []).filter((m: { type: string }) => m.type === '$member');
  }

  beforeAll(async () => {
    publicOrg = await createTestOrganization({ name: 'Member Visibility Public', visibility: 'public' });
    otherOrg = await createTestOrganization({ name: 'Member Visibility Other' });
    owner = await createTestUser({ email: 'search-member-owner@test.example.com' });
    member = await createTestUser({ email: 'search-member-member@test.example.com' });
    await addUserToOrganization(owner.id, publicOrg.id, 'owner');
    await addUserToOrganization(member.id, publicOrg.id, 'member');
    await addUserToOrganization(owner.id, otherOrg.id, 'owner');
    await ensureMemberEntityType(publicOrg.id);
    const sql = getTestDb();
    const [et] = await sql`SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${publicOrg.id} LIMIT 1`;
    const [row] = await sql`
      INSERT INTO entities (entity_type_id, organization_id, name, slug, metadata, created_by, created_at, updated_at)
      VALUES (${et.id}, ${publicOrg.id}, 'Search Member', 'search-member', ${sql.json({ email: MEMBER_EMAIL, role: 'owner', display_name: 'Search Member' })}, ${owner.id}, NOW(), NOW())
      RETURNING id
    `;
    memberEntityId = Number(row.id);
  });

  it('hides $member entities (and emails) from anonymous callers', async () => {
    for (const args of [
      { query: 'Search Member', entity_type: '$member' },
      { query: MEMBER_EMAIL },
      { query: 'Search Member' },
    ]) {
      const result = await searchAs(args, ctx());
      expect(memberHits(result)).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(MEMBER_EMAIL);
    }
    const byId = await searchAs({ query: 'Search Member', entity_id: memberEntityId } as Partial<SearchArgs>, ctx());
    expect(memberHits(byId)).toEqual([]);
    expect(JSON.stringify(byId)).not.toContain(MEMBER_EMAIL);
  });

  it('shows members to members with the email redacted', async () => {
    const context = ctx({ userId: member.id, memberRole: 'member', isAuthenticated: true, tokenType: 'session' });
    const result = await searchAs({ entity_type: '$member' }, context);
    const hits = memberHits(result);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.name).toBeTruthy();
      expect(JSON.stringify((hit as { metadata: unknown }).metadata)).not.toContain(MEMBER_EMAIL);
    }
    expect(JSON.stringify(result)).not.toContain(MEMBER_EMAIL);
  });

  it('shows emails to owners', async () => {
    const context = ctx({ userId: owner.id, memberRole: 'owner', isAuthenticated: true, tokenType: 'session' });
    const result = await searchAs({ entity_type: '$member' }, context);
    expect(memberHits(result).length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).toContain(MEMBER_EMAIL);
  });

  it('drops cross-workspace $member rows even for privileged callers', async () => {
    // Owner of a *different* org searching with public-catalog scope must not
    // receive this org's member list through search.
    const context = ctx({
      organizationId: otherOrg.id,
      userId: owner.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopes: ['mcp:read'],
    });
    const result = await searchAs({ query: 'Search Member', include_public_catalogs: true }, context);
    expect(memberHits(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(MEMBER_EMAIL);
  });
});

describe('query_sql $member visibility', () => {
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let member: Awaited<ReturnType<typeof createTestUser>>;

  function sqlCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      organizationId: publicOrg.id,
      userId: member.id,
      memberRole: 'member',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: true,
      allowCrossOrg: false,
      scopes: ['mcp:read'],
      ...overrides,
    } as ToolContext;
  }

  beforeAll(async () => {
    publicOrg = await createTestOrganization({ name: 'SQL Member Visibility', visibility: 'public' });
    owner = await createTestUser({ email: 'sql-member-owner@test.example.com' });
    member = await createTestUser({ email: 'sql-member-member@test.example.com' });
    await addUserToOrganization(owner.id, publicOrg.id, 'owner');
    await addUserToOrganization(member.id, publicOrg.id, 'member');
    await ensureMemberEntityType(publicOrg.id);
    const sql = getTestDb();
    const [et] = await sql`SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${publicOrg.id} LIMIT 1`;
    await sql`
      INSERT INTO entities (entity_type_id, organization_id, name, slug, metadata, created_by, created_at, updated_at)
      VALUES (${et.id}, ${publicOrg.id}, 'SQL Member', 'sql-member', ${sql.json({ email: 'sql-member-owner@test.example.com', role: 'owner' })}, ${owner.id}, NOW(), NOW())
    `;
    await createTestEntity({ organization_id: publicOrg.id, name: 'SQL Brand', created_by: owner.id });
  });

  it('hides $member rows from ordinary members via raw SQL', async () => {
    const result = await querySql(
      { sql: `SELECT name, metadata FROM entities WHERE entity_type = '$member'` } as never,
      {} as never,
      sqlCtx()
    );
    expect(result.rows).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('sql-member-owner@test.example.com');
  });

  it('keeps $member rows for owners and system callers', async () => {
    const owned = await querySql(
      { sql: `SELECT name, metadata FROM entities WHERE entity_type = '$member'` } as never,
      {} as never,
      sqlCtx({ userId: owner.id, memberRole: 'owner' })
    );
    expect(owned.rows).toHaveLength(1);
    expect(JSON.stringify(owned)).toContain('sql-member-owner@test.example.com');

    const system = await querySql(
      { sql: `SELECT name FROM entities WHERE entity_type = '$member'` } as never,
      {} as never,
      sqlCtx({ userId: null, memberRole: null, tokenType: 'session' })
    );
    expect(system.rows).toHaveLength(1);
  });

  it('still serves non-member entities to members via raw SQL', async () => {
    const result = await querySql(
      { sql: `SELECT name FROM entities ORDER BY name` } as never,
      {} as never,
      sqlCtx()
    );
    expect(result.rows).toEqual([{ name: 'SQL Brand' }]);
  });
});

describe('search_memory content_count saturation and visibility', () => {
  let orgId: string;
  let ownerCtx: ToolContext;
  let readerCtx: ToolContext;
  let rootId: number;
  let childId: number;

  function searchAs(args: Partial<SearchArgs>, ctx: ToolContext) {
    return search({ include_content: false, ...args } as SearchArgs, {} as Env, ctx);
  }

  beforeAll(async () => {
    const org = await createTestOrganization({ name: 'Saturation Org' });
    orgId = org.id;
    const owner = await createTestUser({ email: 'saturation-owner@test.example.com' });
    const reader = await createTestUser({ email: 'saturation-reader@test.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    await addUserToOrganization(reader.id, org.id, 'member');
    ownerCtx = {
      organizationId: org.id,
      userId: owner.id,
      tokenType: 'session',
      memberRole: 'owner',
    } as ToolContext;
    readerCtx = {
      organizationId: org.id,
      userId: reader.id,
      tokenType: 'session',
      memberRole: 'member',
    } as ToolContext;

    const root = await createTestEntity({ name: 'Saturation Target', organization_id: org.id });
    rootId = Number(root.id);
    const child = await createTestEntity({
      name: 'Saturation Child',
      organization_id: org.id,
      parent_id: rootId,
    });
    childId = Number(child.id);

    await createTestConnectorDefinition({
      key: 'saturation-connector',
      name: 'Saturation',
      organization_id: org.id,
    });
    const visible = await createTestConnection({
      organization_id: org.id,
      connector_key: 'saturation-connector',
      entity_ids: [rootId],
    });
    // Private to the owner: a plain member must not see these rows at all.
    const hidden = await createTestConnection({
      organization_id: org.id,
      connector_key: 'saturation-connector',
      entity_ids: [rootId, childId],
      visibility: 'private',
      created_by: owner.id,
    });

    // Root: over the probe cap on the visible connection, plus hidden rows
    // that must not leak into EITHER reader's count.
    await bulkSeedEvents({
      entityId: rootId,
      organizationId: orgId,
      connectionId: visible.id,
      count: 1002,
      label: 'visible root',
    });
    await bulkSeedEvents({
      entityId: rootId,
      organizationId: orgId,
      connectionId: hidden.id,
      count: 50,
      label: 'hidden root',
    });
    // Child: exact small numbers — visible + hidden.
    await bulkSeedEvents({
      entityId: childId,
      organizationId: orgId,
      connectionId: visible.id,
      count: 3,
      label: 'visible child',
    });
    await bulkSeedEvents({
      entityId: childId,
      organizationId: orgId,
      connectionId: hidden.id,
      count: 50,
      label: 'hidden child',
    });
  });

  it('saturates the entity content_count at the probe cap', async () => {
    for (const ctx of [ownerCtx, readerCtx]) {
      const result = await searchAs({ query: 'Saturation Target' }, ctx);
      const match = result.matches.find((m) => m.id === rootId);
      expect(match).toBeDefined();
      // 1002 visible + 50 hidden rows would read 1052 unbounded; the LIMIT
      // 1001 probe saturates instead of scanning the full history.
      expect(match!.stats.content_count).toBe(1001);
    }
  });

  it('excludes hidden-connection events from counts before the cap', async () => {
    const readerResult = await searchAs({ query: 'Saturation Target' }, readerCtx);
    const child = readerResult.children?.find((c) => c.id === childId);
    expect(child).toBeDefined();
    // 3 visible + 50 hidden: exact, because the reader cannot see the private
    // connection's rows and the total is far below the probe cap.
    expect(child!.content_count).toBe(3);

    const ownerResult = await searchAs({ query: 'Saturation Target' }, ownerCtx);
    const ownerChild = ownerResult.children?.find((c) => c.id === childId);
    expect(ownerChild).toBeDefined();
    // The owner sees both connections, so all 53 rows count.
    expect(ownerChild!.content_count).toBe(53);
  });
});
