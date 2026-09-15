/**
 * search_memory must enforce the $member read policy, mirroring manage_entity
 * list/get: non-members (including anonymous public-org readers) never see
 * member entities, members without admin/owner see them with the email field
 * redacted, and cross-workspace $member rows are never visible.
 *
 * Regression: search served $member metadata (with emails) to anonymous
 * callers on public orgs while manage_entity denied the same list.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import {
  search,
  type SearchArgs,
} from '../../../tools/search';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';

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
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
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
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
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
