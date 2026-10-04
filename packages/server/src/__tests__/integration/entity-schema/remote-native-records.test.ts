import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { executeTool, type AuthContext } from '../../../tools/execute';
import { invokeTemplateEventAction } from '../../../interactions/template-event-actions';
import {
  assertTemplateActionCapability,
  TEMPLATE_ACTION_CAPABILITY_META_KEY,
} from '../../../interactions/template-action-capability';
import { getMcpResultMeta } from '../../../tools/mcp-result-meta';
import type { ToolContext } from '../../../tools/registry';
import { manageEntity } from '../../../tools/admin/manage_entity';
import { getContent } from '../../../tools/get_content/handler';
import { resolvePath } from '../../../tools/resolve_path';
import { saveContent } from '../../../tools/save_content';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  createTestAgent,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

// The remote source is the test database itself, read through the bundled
// postgres connector. Every key and value is synthetic; account keys contain
// ':' on purpose.
const ACCOUNT_SQL = `SELECT 'k:' || n AS slug, 'Account ' || n AS name, n * 10 AS score
  FROM generate_series(1, 3) n`;
const CONTACT_SQL = `SELECT 'c-' || n AS slug, 'Contact ' || n AS name FROM generate_series(1, 3) n`;
// Seven touches per account, an hour apart, on 2026-01-01 UTC. (The connector
// rejects `:name` anywhere in the SQL, so times avoid the HH:MM spelling.)
const ACTIVITY_SQL = `SELECT 'k:' || a AS key,
    'touch-' || a || '-' || i AS origin_id,
    make_timestamptz(2026, 1, 1, i, 0, 0, 'UTC') AS occurred_at,
    'Touch ' || i AS title,
    to_char(make_timestamptz(2026, 1, 1, i, 0, 0, 'UTC') AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS') || '|' || lpad(i::text, 4, '0') AS sort_key,
    'https://source.example.test/touch/' || a || '/' || i AS url,
    'call' AS kind,
    i * 3 AS weight
  FROM generate_series(1, 3) a, generate_series(1, 7) i`;
const EDGE_SQL = `SELECT 'k:' || n AS from_key, 'c-' || n AS to_key,
    'Account ' || n AS from_name, 'Contact ' || n AS to_name, n * 2 AS strength
  FROM generate_series(1, 3) n`;
const env = {} as Env;

type ContentItem = { stream: string; id: number | null; origin_id: string; title: string | null; occurred_at: string };

describe('remote-native records', () => {
  let orgId: string;
  let orgSlug: string;
  let otherOrgId: string;
  let userId: string;

  async function attachSource(org: string, user: string) {
    const profile = await createAuthProfile({
      organizationId: org,
      connectorKey: 'postgres',
      displayName: 'Source database',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });
    await getTestDb()`INSERT INTO connections
      (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by)
      VALUES (${org}, 'postgres', 'warehouse', 'Warehouse', 'active', ${profile.id}, 'org', ${user})`;
    return TestApiClient.for({ organizationId: org, userId: user, memberRole: 'owner' });
  }

  async function sourceProportionalCounts() {
    const [row] = await getTestDb()`
      SELECT
        (SELECT count(*)::int FROM entities WHERE organization_id IN (${orgId}, ${otherOrgId})) AS entities,
        (SELECT count(*)::int FROM entity_identities WHERE organization_id IN (${orgId}, ${otherOrgId})) AS identities,
        (SELECT count(*)::int FROM entity_relationships WHERE organization_id IN (${orgId}, ${otherOrgId})) AS relationships,
        (SELECT count(*)::int FROM events WHERE organization_id IN (${orgId}, ${otherOrgId})) AS events`;
    return row;
  }

  const ctx = () => ownerToolContext(orgId, userId);

  async function brief(ref: string, title: string, occurredAt: string, extra: Record<string, unknown> = {}) {
    return saveContent(
      { content: `${title} body`, title, semantic_type: 'note', entity_refs: [ref], occurred_at: occurredAt, ...extra },
      env,
      ctx()
    );
  }

  async function readAll(ref: string, limit: number) {
    const pages: ContentItem[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await getContent({ entity: ref, limit, ...(cursor ? { cursor } : {}) }, env, ctx());
      expect(page.streams?.filter((s) => !s.ok)).toEqual([]);
      pages.push(page.content as ContentItem[]);
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    return pages;
  }

  const identity = (item: ContentItem) => (item.stream === 'lobu' ? `lobu:${item.id}` : `source:${item.origin_id}`);

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Remote Records' });
    orgId = org.id;
    orgSlug = org.slug;
    const other = await createTestOrganization({ name: 'Other Remote Records' });
    otherOrgId = other.id;
    const user = await createTestUser({ email: 'remote-records@example.test' });
    userId = user.id;
    await addUserToOrganization(userId, orgId, 'owner');
    await addUserToOrganization(userId, otherOrgId, 'owner');

    const api = await attachSource(orgId, userId);
    await api.entity_schema.createType({
      slug: 'account',
      name: 'Account',
      backing: { sql: ACCOUNT_SQL, connection: 'warehouse', activity: { sql: ACTIVITY_SQL } },
    });
    await api.entity_schema.createType({
      slug: 'contact',
      name: 'Contact',
      backing: { sql: CONTACT_SQL, connection: 'warehouse' },
    });
    await api.entity_schema.createType({
      slug: 'broken',
      name: 'Broken',
      backing: {
        sql: ACCOUNT_SQL,
        connection: 'warehouse',
        activity: { sql: 'SELECT * FROM remote_native_missing_table' },
      },
    });
    await api.entity_schema.createRelType({
      slug: 'has-contact',
      name: 'Has contact',
      backing: { sql: EDGE_SQL, connection: 'warehouse' },
    });
    await api.entity_schema.addRule({
      slug: 'has-contact',
      source_entity_type_slug: 'account',
      target_entity_type_slug: 'contact',
    });

    // Another org with the same type slug, keys and connection slug.
    const otherApi = await attachSource(otherOrgId, userId);
    await otherApi.entity_schema.createType({
      slug: 'account',
      name: 'Account',
      backing: { sql: ACCOUNT_SQL, connection: 'warehouse', activity: { sql: ACTIVITY_SQL } },
    });
  }, 120_000);

  it('resolves a remote record with its ref and capabilities', async () => {
    const result = await resolvePath({ path: `/${orgSlug}/account/k:1` }, {}, ctx());
    expect(result.entity).toMatchObject({
      id: 0,
      slug: 'k:1',
      ref: 'account:k:1',
      capabilities: { activity: true, relationships: true },
    });
    const contact = await resolvePath({ path: `/${orgSlug}/contact/c-1` }, {}, ctx());
    expect(contact.entity).toMatchObject({ ref: 'contact:c-1', capabilities: { activity: false, relationships: true } });
  });

  it('merges source activity with Lobu briefs, newest first, across pages without skips or duplicates', async () => {
    // Ties: one brief at a source row's exact time, two briefs at one time.
    await brief('account:k:1', 'Brief at touch 4', '2026-01-01T04:00:00.000Z');
    await brief('account:k:1', 'Brief A at 05:30', '2026-01-01T05:30:00.000Z');
    await brief('account:k:1', 'Brief B at 05:30', '2026-01-01T05:30:00.000Z');
    await brief('account:k:2', 'Brief for another record', '2026-01-01T06:00:00.000Z');
    const before = await sourceProportionalCounts();

    const [all] = await readAll('account:k:1', 100);
    expect(all).toHaveLength(10);
    expect(all.filter((i) => i.stream === 'source')).toHaveLength(7);
    expect(all.filter((i) => i.stream === 'lobu').map((i) => i.title).sort()).toEqual([
      'Brief A at 05:30',
      'Brief B at 05:30',
      'Brief at touch 4',
    ]);
    const times = all.map((i) => Date.parse(i.occurred_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    for (const limit of [1, 2, 3, 4]) {
      const pages = await readAll('account:k:1', limit);
      const flat = pages.flat();
      expect(pages.every((p) => p.length <= limit)).toBe(true);
      expect(flat.map(identity)).toEqual(all.map(identity));
    }

    // The invariant: reading creates no source-proportional rows.
    await resolvePath({ path: `/${orgSlug}/account/k:1` }, {}, ctx());
    await manageEntity({ action: 'list_links', entity: 'account:k:1' }, env, ctx());
    expect(await sourceProportionalCounts()).toEqual(before);
  });

  it('stores the ref on the Lobu event only', async () => {
    const saved = await brief('account:k:3', 'Ref only', '2026-01-02T00:00:00.000Z');
    const [row] = await getTestDb()`SELECT entity_refs FROM events WHERE id = ${saved.id}`;
    expect(row.entity_refs).toBe('{account:k:3}');
  });

  it("renders a metadata-only Lobu event from its remote type's kind", async () => {
    const api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    await api.entity_schema.updateType({
      slug: 'contact',
      event_kinds: {
        'contact-score': {
          description: 'A synthetic score',
          metadataSchema: { type: 'object', properties: { score: { type: 'number' } } },
        },
      },
    });
    const saved = await saveContent(
      {
        semantic_type: 'contact-score',
        payload_type: 'empty',
        metadata: { score: 7 },
        entity_refs: ['contact:c-1'],
        occurred_at: '2026-01-04T00:00:00.000Z',
      },
      env,
      ctx()
    );
    const activity = await getContent({ entity: 'contact:c-1' }, env, ctx());
    const fromActivity = (activity.content as Array<Record<string, unknown>>).find((i) => i.id === saved.id);
    const exact = await getContent({ content_ids: [saved.id] }, env, ctx());
    for (const item of [fromActivity, exact.content[0] as Record<string, unknown>]) {
      expect(item).toMatchObject({ payload_type: 'json_template', payload_data: { score: 7 } });
      expect(item?.payload_template).toBeTruthy();
    }
  });

  it("makes an interactive event about a remote record actionable through its type's kinds", async () => {
    const api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    // A fresh type: event kinds are cached per type for a short TTL.
    await api.entity_schema.createType({
      slug: 'renewal',
      name: 'Renewal',
      backing: { sql: ACCOUNT_SQL, connection: 'warehouse' },
      event_kinds: {
        'account-poll': {
          description: 'A synthetic poll',
          jsonTemplate: {
            type: 'card',
            children: [{ type: 'button', props: { label: 'Yes', onClick: '@vote', value: 'yes' } }],
          },
          interactions: { vote: { emits: 'account-vote' } },
        },
        'account-vote': { description: 'A synthetic vote' },
      },
    });
    const poll = await saveContent(
      {
        semantic_type: 'account-poll',
        payload_type: 'empty',
        metadata: { question: 'Renew?' },
        entity_refs: ['renewal:k:3'],
        occurred_at: '2026-01-05T00:00:00.000Z',
      },
      env,
      ctx()
    );
    const appCtx = {
      ...ctx(),
      clientId: 'remote-records-app',
      mcpSessionId: 'remote-records-session',
      mcpConversationId: 'remote-records-conversation',
    } as ToolContext & { userId: string; clientId: string; mcpSessionId: string };
    const page = await getContent({ entity: 'renewal:k:3' }, env, appCtx);
    const capability = getMcpResultMeta(page)?.[TEMPLATE_ACTION_CAPABILITY_META_KEY];
    expect(typeof capability).toBe('string');
    expect(() => assertTemplateActionCapability(capability as string, poll.id, appCtx)).not.toThrow();

    const voted = await invokeTemplateEventAction({
      organizationId: orgId,
      sourceEventId: poll.id,
      action: 'vote',
      value: 'yes',
      interactionId: 'remote-vote-1',
      surface: 'web',
      actor: { platform: 'web', platformUserId: userId, userId },
    } as never);
    expect(voted).toMatchObject({ created: true, eventType: 'account-vote' });
    const [row] = await getTestDb()`SELECT entity_refs FROM events WHERE id = ${voted.eventId}`;
    expect(row.entity_refs).toBe('{renewal:k:3}');
  });

  it("applies a remote type's read policy to its events read by content id or by ref", async () => {
    const agent = await createTestAgent({ organizationId: orgId, ownerUserId: userId, agentId: 'remote-records-reader' });
    const saved = await brief('broken:k:3', 'Policy-guarded brief', '2026-01-06T00:00:00.000Z');
    const [policy] = await getTestDb()<{ id: number }>`
      INSERT INTO write_approval_policies
        (organization_id, resource_class, principal_kind, principal_id, entity_type_slug)
      VALUES (${orgId}, 'entity', 'agent', ${agent.agentId}, 'broken')
      RETURNING id`;
    await getTestDb()`INSERT INTO write_policy_action_effects (policy_id, action, effect)
      VALUES (${policy.id}, 'read', 'deny')`;
    const agentCtx = { ...ctx(), agentId: agent.agentId } as ToolContext;
    await expect(getContent({ content_ids: [saved.id] }, env, agentCtx)).rejects.toThrow(
      /Policy denies reading entities of type 'broken'/
    );
    await expect(getContent({ entity: 'broken:k:3' }, env, agentCtx)).rejects.toThrow(
      /Policy denies reading entities of type 'broken'/
    );
    // The owner, acting as a user, still reads it.
    expect((await getContent({ content_ids: [saved.id] }, env, ctx())).content).toHaveLength(1);
  });

  it('rejects a cursor replayed against another ref', async () => {
    const page = await getContent({ entity: 'account:k:1', limit: 2 }, env, ctx());
    expect(page.next_cursor).toBeTruthy();
    await expect(
      getContent({ entity: 'account:k:2', limit: 2, cursor: page.next_cursor }, env, ctx())
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(getContent({ entity: 'account:k:1', cursor: 'not-a-cursor' }, env, ctx())).rejects.toMatchObject({
      httpStatus: 400,
    });
  });

  it('reports a failing stream next to the stream that succeeded', async () => {
    await brief('broken:k:1', 'Still readable', '2026-01-03T00:00:00.000Z');
    const page = await getContent({ entity: 'broken:k:1' }, env, ctx());
    const source = page.streams?.find((s) => s.stream === 'source');
    expect(source).toMatchObject({ ok: false });
    expect(source?.error_code).toBeTruthy();
    expect(page.streams?.find((s) => s.stream === 'lobu')).toMatchObject({ ok: true });
    expect((page.content as ContentItem[]).map((i) => i.title)).toEqual(['Still readable']);
  });

  it('reads backed relationships in both directions with attributes', async () => {
    const out = (await manageEntity({ action: 'list_links', entity: 'account:k:2' }, env, ctx())) as {
      edges: unknown[];
      streams: Array<{ ok: boolean; direction: string }>;
      relationships: unknown[];
    };
    expect(out.relationships).toEqual([]);
    expect(out.streams).toEqual([expect.objectContaining({ ok: true, direction: 'outbound', returned: 1, has_more: false })]);
    expect(out.edges).toEqual([
      {
        type: 'has-contact',
        from: 'account:k:2',
        to: 'contact:c-2',
        from_name: 'Account 2',
        to_name: 'Contact 2',
        attributes: { strength: 4 },
        source: 'remote',
      },
    ]);
    const inbound = (await manageEntity({ action: 'list_links', entity: 'contact:c-3' }, env, ctx())) as {
      edges: Array<{ from: string; to: string }>;
      streams: Array<{ direction: string }>;
    };
    expect(inbound.streams.map((s) => s.direction)).toEqual(['inbound']);
    expect(inbound.edges.map((e) => [e.from, e.to])).toEqual([['account:k:3', 'contact:c-3']]);
  });

  it('list_links takes exactly one of entity_id and entity', async () => {
    await expect(manageEntity({ action: 'list_links' }, env, ctx())).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      manageEntity({ action: 'list_links', entity_id: 1, entity: 'account:k:1' }, env, ctx())
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('canonicalizes edge keys like record keys and reports the next page at the query row cap', async () => {
    const api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    await api.entity_schema.createRelType({
      slug: 'many-contacts',
      name: 'Many contacts',
      backing: {
        sql: `SELECT 'k:1' AS from_key, ' c-' || lpad(n::text, 4, '0') || ' ' AS to_key
          FROM generate_series(1, 501) n`,
        connection: 'warehouse',
      },
    });
    await api.entity_schema.addRule({
      slug: 'many-contacts',
      source_entity_type_slug: 'account',
      target_entity_type_slug: 'contact',
    });
    const read = (offset: number) => manageEntity({
      action: 'list_links', entity: 'account:k:1', relationship_type_slug: 'many-contacts',
      limit: 500, offset,
    }, env, ctx()) as Promise<{ edges: Array<{ to: string }>; streams: Array<{ has_more: boolean }> }>;
    const first = await read(0);
    expect(first.edges).toHaveLength(500);
    expect.soft(first.edges[0].to).toBe('contact:c-0001');
    expect.soft(first.streams[0].has_more).toBe(true);
    const last = await read(500);
    expect(last.edges.map((edge) => edge.to)).toEqual(['contact:c-0501']);
    expect(last.streams[0].has_more).toBe(false);
  });

  it('rejects unsupported activity filters instead of silently ignoring them', async () => {
    for (const filter of [{ since: '2030-01-01' }, { offset: 2 }, { sort_order: 'asc' as const }]) {
      await expect(getContent({ entity: 'account:k:1', ...filter }, env, ctx()))
        .rejects.toMatchObject({ httpStatus: 400 });
    }
  });

  it('opens a view for a remote record by its key', async () => {
    const authCtx = {
      ...ctx(),
      tokenOrganizationId: orgId,
      requestedAgentId: null,
      requestUrl: `http://localhost/api/${orgId}`,
      baseUrl: '',
    } as unknown as AuthContext;
    await executeTool(
      'manage_views',
      {
        action: 'set',
        key: 'account-pane',
        source_code: 'export default function Pane() { return null; }\n',
        attach: [{ entity: 'k:2', placement: 'tab' }],
      },
      env,
      authCtx
    );
    const opened = (await executeTool(
      'open_view',
      { key: 'account-pane', scope: { type: 'account', entity: 'k:2' } },
      env,
      authCtx
    )) as { url: string; scope: unknown };
    expect(new URL(opened.url).pathname).toBe(`/${orgSlug}/account/k%3A2/-/views/account-pane`);
    expect(opened.scope).toEqual({ type: 'account', entity: 'k:2' });
    await expect(
      executeTool('open_view', { key: 'account-pane', scope: { entity: 'k:2' } }, env, authCtx)
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('scopes refs to the caller org', async () => {
    // Same type slug and ref in another org: that org's Lobu stream holds none of ours.
    const otherCtx = ownerToolContext(otherOrgId, userId);
    const page = await getContent({ entity: 'account:k:1', limit: 100 }, env, otherCtx);
    expect((page.content as ContentItem[]).filter((i) => i.stream === 'lobu')).toEqual([]);
    expect((page.content as ContentItem[]).filter((i) => i.stream === 'source')).toHaveLength(7);
    // A type that exists only in our org is not resolvable from the other one.
    await expect(getContent({ entity: 'contact:c-1' }, env, otherCtx)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(
      saveContent({ content: 'x', semantic_type: 'note', entity_refs: ['contact:c-1'] }, env, otherCtx)
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('validates refs and backing declarations', async () => {
    await expect(
      saveContent({ content: 'x', semantic_type: 'note', entity_refs: ['no-separator'] }, env, ctx())
    ).rejects.toMatchObject({ httpStatus: 400 });
    const api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    await expect(
      api.entity_schema.createType({
        slug: 'local-view',
        name: 'Local view',
        backing: { sql: 'SELECT 1 AS id', activity: { sql: ACTIVITY_SQL } },
      })
    ).rejects.toThrow(/requires backing.connection/);
    await expect(
      api.entity_schema.createRelType({ slug: 'half-backed', name: 'Half', backing: { sql: EDGE_SQL } })
    ).rejects.toThrow(/requires backing.connection/);
  });

  it('refuses stored edges on a backed relationship type', async () => {
    const [rt] = await getTestDb()`SELECT id FROM entity_relationship_types WHERE organization_id = ${orgId} AND slug = 'has-contact'`;
    await expect(
      getTestDb()`INSERT INTO entity_relationships (organization_id, from_entity_id, to_entity_id, relationship_type_id)
        VALUES (${orgId}, 1, 2, ${rt.id})`
    ).rejects.toMatchObject({ code: '23514' });
  });
});
