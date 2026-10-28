/**
 * Compact resolve_path route contract.
 *
 * Keeps the important coverage from the old broad page tests while using the
 * reusable MCP client/session helper introduced in this PR.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestApiClient } from '../../setup/test-mcp-client';

interface Fixture {
  orgId: string;
  ownerId: string;
  orgSlug: string;
  token: string;
  memberToken: string;
  canonicalDealId: number;
  associatedDealId: number;
}

async function seedFixture(): Promise<Fixture> {
  const org = await createTestOrganization({ name: 'Resolve Contract Org', slug: 'resolve-contract' });
  const user = await createTestUser({ email: 'resolve-contract@test.example.com' });
  const member = await createTestUser({
    email: 'resolve-contract-member@test.example.com',
  });
  await addUserToOrganization(user.id, org.id, 'owner');
  await addUserToOrganization(member.id, org.id, 'member');

  const api = await TestApiClient.for({
    organizationId: org.id,
    userId: user.id,
    memberRole: 'owner',
  });
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES
      (${org.id}, 'brand', 'Brand', NOW(), NOW()),
      (${org.id}, 'product', 'Product', NOW(), NOW())
  `;
  // A typed entity type WITH a metadata_schema (no view template declared) —
  // exercises the auto-default rendering tail.
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
    VALUES (
      ${org.id}, 'deal', 'Deal',
      ${sql.json({
        type: 'object',
        properties: {
          stage: { title: 'Deal Stage', 'x-table-column': 1 },
          amount: { 'x-table-column': 2 },
        },
      })},
      NOW(), NOW()
    )
  `;

  const brand = (await api.entities.create({ entity_type: 'brand', name: 'Acme Brand' })) as {
    entity: { id: number };
  };
  await api.entities.create({
    entity_type: 'product',
    name: 'Acme Product',
    parent_id: brand.entity.id,
  });
  const canonicalDeal = (await api.entities.create({
    entity_type: 'deal',
    name: 'Acme Deal',
    metadata: { stage: 'negotiation', amount: 50000 },
  })) as { entity: { id: number } };
  const associatedDeal = (await api.entities.create({
    entity_type: 'deal',
    name: 'Acme Deal Import',
    metadata: { source: 'Import', owner: 'Reviewer' },
  })) as { entity: { id: number } };
  const human = api.withAuth({ tokenType: 'session' });
  await human.entity_schema.createRelType({ slug: 'same_record', name: 'Same record', purpose: 'identity' });
  await human.entities.link({
    from_entity_id: associatedDeal.entity.id,
    to_entity_id: canonicalDeal.entity.id,
    relationship_type_slug: 'same_record',
  });

  const oauthClient = await createTestOAuthClient();
  const token = (await createTestAccessToken(user.id, org.id, oauthClient.client_id)).token;
  const memberToken = (
    await createTestAccessToken(member.id, org.id, oauthClient.client_id)
  ).token;
  return {
    orgId: org.id,
    ownerId: user.id,
    orgSlug: org.slug,
    token,
    memberToken,
    canonicalDealId: canonicalDeal.entity.id,
    associatedDealId: associatedDeal.entity.id,
  };
}

async function resolvePath(
  fixture: Pick<Fixture, 'orgSlug' | 'token'>,
  args: Record<string, unknown>,
  token = fixture.token
) {
  const response = await post(`/api/${fixture.orgSlug}/resolve_path`, {
    body: args,
    token,
  });
  if (response.status >= 400) {
    const body = (await response.json()) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json();
}

describe('resolve_path contract', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    await cleanupTestDatabase();
    fixture = await seedFixture();
  });

  it('resolves workspace and nested entity paths', async () => {
    const workspace = (await resolvePath(fixture, { path: `/${fixture.orgSlug}` })) as {
      workspace?: { slug: string };
    };
    expect(workspace.workspace?.slug).toBe(fixture.orgSlug);

    const nested = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}/brand/acme-brand/product/acme-product`,
    })) as { entity?: { name: string } };
    expect(nested.entity?.name).toBe('Acme Product');
  });

  it('auto-generates a default json_template from metadata_schema when none is declared', async () => {
    const resolved = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}/deal/acme-deal`,
    })) as { entity?: { json_template?: Record<string, unknown> | null } };

    const template = resolved.entity?.json_template;
    expect(template).toBeTruthy();
    // The root node is a card, and each schema field is data-bound by key.
    const serialized = JSON.stringify(template);
    expect(template?.type).toBe('card');
    expect(serialized).toContain('"path":"stage"');
    expect(serialized).toContain('"path":"amount"');
    expect(serialized).toContain('Deal Stage');
  });

  it('does not synthesize a template for a type without metadata_schema', async () => {
    const resolved = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}/brand/acme-brand`,
    })) as { entity?: { json_template?: Record<string, unknown> | null } };
    expect(resolved.entity?.json_template ?? null).toBeNull();
  });

  it('keeps identity member URLs exact and omits retired merge undo details', async () => {
    const member = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}/deal/acme-deal-import`,
    })) as { entity?: { id: number; metadata: unknown }; redirect?: unknown };
    expect(member.entity?.id).toBe(fixture.associatedDealId);
    expect(member.entity?.metadata).toEqual({ source: 'Import', owner: 'Reviewer' });
    expect(member).not.toHaveProperty("redirect");
    expect(member.entity).not.toHaveProperty('merged_records');

    const root = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}/deal/acme-deal`,
    })) as { entity?: { id: number }; redirect?: unknown };
    expect(root.entity?.id).toBe(fixture.canonicalDealId);
    expect(root).not.toHaveProperty("redirect");
    expect(root.entity).not.toHaveProperty('merged_records');

    const memberView = (await resolvePath(
      fixture,
      { path: `/${fixture.orgSlug}/deal/acme-deal-import` },
      fixture.memberToken
    )) as { entity?: { id: number } };
    expect(memberView.entity?.id).toBe(fixture.associatedDealId);
    expect(memberView.entity).not.toHaveProperty('merged_records');
  });

  it('rejects malformed or missing paths instead of silently falling back', async () => {
    await expect(resolvePath(fixture, { path: `/${fixture.orgSlug}/brand` })).rejects.toThrow();
    await expect(
      resolvePath(fixture, { path: `/${fixture.orgSlug}/brand/missing-brand` })
    ).rejects.toThrow();
  });

  it('returns bootstrap only when requested', async () => {
    const withoutBootstrap = (await resolvePath(fixture, { path: `/${fixture.orgSlug}` })) as {
      bootstrap?: unknown;
    };
    expect(withoutBootstrap.bootstrap).toBeNull();

    const withBootstrap = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}`,
      include_bootstrap: true,
    })) as { bootstrap?: { entity_types?: unknown[]; recent_automations?: unknown[] } };
    expect(withBootstrap.bootstrap?.entity_types?.length).toBeGreaterThan(0);
    expect(withBootstrap.bootstrap).not.toHaveProperty('recent_automations');
  });

  it('strips audit requests from bootstrap content without altering ordinary payloads', async () => {
    const sql = getTestDb();
    await sql`
      INSERT INTO events
        (organization_id, origin_id, title, semantic_type, origin_type, payload_type,
         payload_data, created_by)
      VALUES
        (${fixture.orgId}, 'resolve-audit-request', 'Audit request', 'audit',
         'tool_invocation', 'empty', ${sql.json({ request: { sql: 'SELECT 1' } })},
         ${fixture.ownerId}),
        (${fixture.orgId}, 'resolve-ordinary-request', 'Ordinary request', 'note',
         'manual', 'empty', ${sql.json({ request: { method: 'GET' } })},
         ${fixture.ownerId})
    `;

    const resolved = (await resolvePath(fixture, {
      path: `/${fixture.orgSlug}`,
      include_bootstrap: true,
    })) as {
      bootstrap?: {
        recent_content?: Array<{ title?: string; payload_data?: Record<string, unknown> }>;
      };
    };
    const audit = resolved.bootstrap?.recent_content?.find((item) => item.title === 'Audit request');
    const ordinary = resolved.bootstrap?.recent_content?.find(
      (item) => item.title === 'Ordinary request'
    );
    expect(audit?.payload_data).not.toHaveProperty('request');
    expect(ordinary?.payload_data).toEqual({ request: { method: 'GET' } });
  });
});

/**
 * `resolve_path.counts` drives nav badges and onboarding states, so a wrong
 * number tells someone their workspace is set up when it isn't.
 */
interface Counts {
  connections: number;
  automations: number;
  agents: number;
  devices: number;
  clients: number;
}

interface CountsFixture {
  orgId: string;
  orgSlug: string;
  userId: string;
  token: string;
}

async function resolveCounts(
  fixture: CountsFixture,
  args: Record<string, unknown> = {}
): Promise<Counts> {
  const result = (await resolvePath(fixture, { path: `/${fixture.orgSlug}`, ...args })) as {
    counts?: Counts;
  };
  if (!result.counts) throw new Error('resolve_path returned no counts');
  return result.counts;
}

describe('resolve_path workspace counts', () => {
  let fixture: CountsFixture;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({
      name: 'Counts Org',
      slug: 'counts-org',
    });
    const user = await createTestUser({ email: 'counts@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const access = await createTestAccessToken(
      user.id,
      org.id,
      (await createTestOAuthClient({ client_name: 'Counts Session' })).client_id
    );
    fixture = {
      orgId: org.id,
      orgSlug: org.slug,
      userId: user.id,
      token: access.token,
    };
  });

  it('counts connections the user made, not connectors they could install', async () => {
    // An installable connector in the catalog is not a connection. This is the
    // regression: counting `connector_definitions` here reported 1.
    await createTestConnectorDefinition({
      key: 'countable-connector',
      name: 'Countable Connector',
      organization_id: fixture.orgId,
    });

    expect((await resolveCounts(fixture)).connections).toBe(0);

    const connection = await createTestConnection({
      organization_id: fixture.orgId,
      connector_key: 'countable-connector',
    });
    expect((await resolveCounts(fixture)).connections).toBe(1);

    // Soft-deleted connections are gone from the user's point of view.
    const sql = getTestDb();
    await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${connection.id}`;
    expect((await resolveCounts(fixture)).connections).toBe(0);
  });

  it('counts distinct MCP apps with a live grant', async () => {
    // The Agents page groups repeat registrations for the same app and only
    // shows a group while at least one grant is live. The compact workspace
    // count must use those same semantics or onboarding and the sidebar drift.
    const before = (await resolveCounts(fixture)).clients;

    const registered = await createTestOAuthClient({ client_name: 'Registered' });
    const sql = getTestDb();
    await sql`
      UPDATE oauth_clients SET organization_id = ${fixture.orgId}
      WHERE id = ${registered.client_id}
    `;
    expect((await resolveCounts(fixture)).clients).toBe(before);

    const first = await createTestOAuthClient({ client_name: 'Repeat app' });
    const second = await createTestOAuthClient({ client_name: 'Repeat app' });
    await createTestAccessToken(fixture.userId, fixture.orgId, first.client_id);
    await createTestAccessToken(fixture.userId, fixture.orgId, second.client_id);
    expect((await resolveCounts(fixture)).clients).toBe(before + 1);

    // One revoked registration does not disconnect the grouped app while its
    // sibling registration still has a live grant.
    await sql`
      UPDATE oauth_tokens SET revoked_at = NOW()
      WHERE client_id = ${first.client_id}
        AND organization_id = ${fixture.orgId}
    `;
    expect((await resolveCounts(fixture)).clients).toBe(before + 1);

    await sql`
      UPDATE oauth_tokens SET revoked_at = NOW()
      WHERE client_id = ${second.client_id}
        AND organization_id = ${fixture.orgId}
    `;
    expect((await resolveCounts(fixture)).clients).toBe(before);

    // Registered nowhere and holding no token here: not this workspace's.
    await createTestOAuthClient({ client_name: 'Stranger' });
    expect((await resolveCounts(fixture)).clients).toBe(before);
  });

  it('counts active automations', async () => {
    const sql = getTestDb();
    await sql`
      INSERT INTO automations
        (organization_id, created_by, automation_group_id, name, status,
         min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (${fixture.orgId}, ${fixture.userId}, 0, 'Live', 'active',
         0, NOW(), NOW()),
        (${fixture.orgId}, ${fixture.userId}, 0, 'Archived', 'archived',
         0, NOW(), NOW())
    `;
    expect((await resolveCounts(fixture)).automations).toBe(1);
  });

  it('returns counts without include_bootstrap', async () => {
    // The whole point of moving these out of the bootstrap payload: a page
    // that only needs to know whether the workspace is empty should not have
    // to pull entity types, feeds and recent content to find out.
    const counts = await resolveCounts(fixture, { include_bootstrap: false });
    expect(counts).toEqual({
      connections: expect.any(Number),
      automations: expect.any(Number),
      agents: expect.any(Number),
      devices: expect.any(Number),
      clients: expect.any(Number),
    });
  });
});
