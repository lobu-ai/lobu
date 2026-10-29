/**
 * Integration test: `getContent` filter plumbing across every SQL site.
 *
 * `get_content` assembles its query in several independent builders: the list
 * path, the text-search path (positional parameter slots in a shared WHERE
 * template), the entity `sort_by: 'score'` builder (`buildFilterConditionsAndJoins`
 * in content-scoring.ts), the classification-filtered listing, explicit-ID and
 * superseded-history reads, and the classification stats. Each one enumerates
 * the filters it forwards, so a filter missing from one of them is silently
 * DROPPED: the query returns unfiltered rows rather than erroring. A mis-bound
 * positional slot typechecks and fails only against a real Postgres, usually as
 * silently wrong rows. Fixtures therefore give the NON-matching rows the higher
 * score, or their own classification, so a dropped filter fails loudly.
 *
 * Each describe seeds its own organization and owner. The orgs share one
 * database, and the org-wide assertions (row totals, "omitting the filter
 * returns everything") stay scoped to the describe's own org.
 *
 * Filters covered:
 *   - `client_ids` (list and search paths). `client_id` is a real indexed column
 *     on `events` (idx_events_client_id, FK → oauth_clients), not a metadata
 *     field. A client that re-registers gets a NEW oauth_clients row under the
 *     same client_name (prod had 6 ids for "Lobu CLI"), so the filter takes an
 *     array.
 *   - `entity_types` without `entity_id` (the Memory page's org-wide listing).
 *   - `event_category` + `resource_kind` + `resource_id` on every stored read.
 *   - `mcp_activity_id`, an exact MCP conversation across transport sessions.
 *   - the entity score path: `client_ids`, `agent_id` and
 *     `analyzed_by_automation_id` were all missing there once (a class, not a
 *     one-off), and an entity `sort_by: 'score'` call with a `query` must go
 *     through text search instead of the score listing.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import { buildContentItems } from '../../../tools/get_content/render';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

type Org = Awaited<ReturnType<typeof createTestOrganization>>;
type User = Awaited<ReturnType<typeof createTestUser>>;

/** A fresh organization with one owner, plus that owner's read context. */
async function seedOwnerOrg(
  orgName: string,
  email: string
): Promise<{ org: Org; user: User; ctx: ToolContext }> {
  const org = await createTestOrganization({ name: orgName });
  const user = await createTestUser({ email });
  await addUserToOrganization(user.id, org.id, 'owner');
  const ctx = {
    organizationId: org.id,
    userId: user.id,
    memberRole: 'owner',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: true,
    scopes: ['mcp:read'],
  } as ToolContext;
  return { org, user, ctx };
}

/** Register an oauth_clients row so the events FK is satisfiable. */
async function registerClient(opts: {
  id: string;
  clientName: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO oauth_clients (id, client_name, redirect_uris, user_id, organization_id)
    VALUES (
      ${opts.id}, ${opts.clientName}, ARRAY['https://example.test/cb']::text[],
      ${opts.userId}, ${opts.organizationId}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await initWorkspaceProvider();
  await cleanupTestDatabase();
  await seedSystemEntityTypes();
});

describe('getContent > client_id scopes events to one OAuth client', () => {
  let ctx: ToolContext;

  // Two ids for the SAME logical client, as happens on re-registration.
  const CHATGPT = 'mcp_client_test_chatgpt';
  const CLI_A = 'mcp_client_test_cli_a';
  const CLI_B = 'mcp_client_test_cli_b';

  /** Insert one audit-shaped event attributed to `clientId` (or none). */
  async function insertAuditEvent(opts: {
    organizationId: string;
    title: string;
    clientId: string | null;
    occurredAt: Date;
  }): Promise<number> {
    const sql = getTestDb();
    const [row] = await sql`
      INSERT INTO events (
        organization_id, origin_id, title, payload_type, payload_text,
        semantic_type, client_id, occurred_at, created_at
      ) VALUES (
        ${opts.organizationId},
        ${`client-filter-${opts.title}-${opts.occurredAt.getTime()}`},
        ${opts.title}, 'text', ${opts.title},
        'audit', ${opts.clientId}, ${opts.occurredAt}, NOW()
      )
      RETURNING id
    `;
    return Number((row as { id: unknown }).id);
  }

  beforeAll(async () => {
    const seeded = await seedOwnerOrg('Client Filter Org', 'client-filter@example.com');
    const { org, user } = seeded;
    ctx = seeded.ctx;

    for (const [id, name] of [
      [CHATGPT, 'ChatGPT'],
      [CLI_A, 'Lobu CLI'],
      [CLI_B, 'Lobu CLI'],
    ] as const) {
      await registerClient({
        id,
        clientName: name,
        userId: user.id,
        organizationId: org.id,
      });
    }

    const t0 = new Date('2026-07-01T00:00:00Z');
    await insertAuditEvent({
      organizationId: org.id,
      title: 'chatgpt searched memory',
      clientId: CHATGPT,
      occurredAt: t0,
    });
    await insertAuditEvent({
      organizationId: org.id,
      title: 'cli ran query first registration',
      clientId: CLI_A,
      occurredAt: new Date(t0.getTime() + 1000),
    });
    await insertAuditEvent({
      organizationId: org.id,
      title: 'cli ran query second registration',
      clientId: CLI_B,
      occurredAt: new Date(t0.getTime() + 2000),
    });
    await insertAuditEvent({
      organizationId: org.id,
      title: 'server side activity with no client',
      clientId: null,
      occurredAt: new Date(t0.getTime() + 3000),
    });
  });

  it('list path: a single client id returns only that client’s events', async () => {
    const result = await getContent(
      { client_ids: [CHATGPT], semantic_type: 'audit', limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title)).toEqual(['chatgpt searched memory']);
  });

  it('list path: an array matches every registration of one client', async () => {
    const result = await getContent(
      { client_ids: [CLI_A, CLI_B], semantic_type: 'audit', limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title).sort()).toEqual([
      'cli ran query first registration',
      'cli ran query second registration',
    ]);
  });

  it('list path: omitting client_id returns every event, client-attributed or not', async () => {
    const result = await getContent(
      { semantic_type: 'audit', limit: 100 } as never,
      {} as never,
      ctx
    );
    // The null-client row must NOT be filtered out when no client is requested.
    expect(result.content.length).toBe(4);
    expect(result.content.map((c) => c.title)).toContain(
      'server side activity with no client'
    );
  });

  it('search path: client_id still scopes when a search_term shifts the param slots', async () => {
    // The search path binds client_id at fixed slot $12, reserves $13 for the
    // exact-conversation filter, and pushes orgScope to $14. If those indexes
    // drift, this returns the wrong rows rather than
    // erroring — which is exactly what makes it worth asserting.
    const result = await getContent(
      { query: "query", client_ids: [CLI_A, CLI_B], limit: 100 } as never,
      {} as never,
      ctx
    );
    const titles = result.content.map((c) => c.title);
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(title).toContain('cli ran query');
    }
    expect(titles).not.toContain('chatgpt searched memory');
  });

  it('search path: a client with no matching text returns nothing, not everything', async () => {
    // Guards the failure mode where a mis-bound slot makes the predicate a
    // no-op: ChatGPT has no event containing "query".
    const result = await getContent(
      { query: "query", client_ids: [CHATGPT], limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content).toEqual([]);
  });
});

describe('getContent > org-wide entity_types filter', () => {
  let ctx: ToolContext;
  let companyEntity: Awaited<ReturnType<typeof createTestEntity>>;
  let personEventId: number;
  let companyEventId: number;
  let unlinkedEventId: number;

  beforeAll(async () => {
    const seeded = await seedOwnerOrg('Entity Types Filter Org', 'entity-types-filter@example.com');
    const { org } = seeded;
    ctx = seeded.ctx;

    const personEntity = await createTestEntity({
      name: 'Alice',
      entity_type: 'person',
      organization_id: org.id,
    });
    companyEntity = await createTestEntity({
      name: 'Acme Corp',
      entity_type: 'company',
      organization_id: org.id,
    });

    personEventId = (
      await createTestEvent({
        entity_ids: [personEntity.id],
        content: 'Person-linked event',
        organization_id: org.id,
      })
    ).id;
    companyEventId = (
      await createTestEvent({
        entity_ids: [companyEntity.id],
        content: 'Company-linked event',
        organization_id: org.id,
      })
    ).id;
    unlinkedEventId = (
      await createTestEvent({
        entity_ids: [],
        content: 'Unlinked org event',
        organization_id: org.id,
      })
    ).id;
  });

  it('returns only events linked to entities of the selected type slugs', async () => {
    const result = await getContent(
      {
        entity_types: ['person'],
        sort_by: 'date',
        sort_order: 'desc',
        limit: 50,
      },
      {} as never,
      ctx
    );

    const ids = result.content.map((row) => row.id);
    expect(ids).toContain(personEventId);
    expect(ids).not.toContain(companyEventId);
    expect(ids).not.toContain(unlinkedEventId);
  });

  it('matches any of multiple selected entity type slugs', async () => {
    const result = await getContent(
      {
        entity_types: ['person', 'company'],
        sort_by: 'date',
        sort_order: 'desc',
        limit: 50,
      },
      {} as never,
      ctx
    );

    const ids = result.content.map((row) => row.id);
    expect(ids).toContain(personEventId);
    expect(ids).toContain(companyEventId);
    expect(ids).not.toContain(unlinkedEventId);
  });

  it('ignores entity_types when entity_id is set (entity-scoped mode)', async () => {
    const result = await getContent(
      {
        entity_id: companyEntity.id,
        entity_types: ['person'],
        sort_by: 'date',
        sort_order: 'desc',
        limit: 50,
      },
      {} as never,
      ctx
    );

    const ids = result.content.map((row) => row.id);
    expect(ids).toContain(companyEventId);
    expect(ids).not.toContain(personEventId);
  });
});

describe('getContent > resource filters intersect every stored read', () => {
  let ctx: ToolContext;
  const ids: number[] = [];
  let entityId: number;
  let username: string;
  const filter = { semantic_type: 'change', event_category: 'config', resource_kind: 'automation', resource_id: 'synthetic-workflow' };
  beforeAll(async () => {
    const seeded = await seedOwnerOrg('Resource filter test', 'resource-filter@example.test');
    const { org, user } = seeded;
    ctx = seeded.ctx;
    username = user.username;
    entityId = (await createTestEntity({ name: "Config subject", organization_id: org.id })).id;
    const connection = await createTestConnection({ organization_id: org.id, connector_key: "test.resource", entity_ids: [entityId], created_by: user.id });
    const sql = getTestDb();
    for (const [category, kind, resourceId] of [
      ['config', 'automation', 'synthetic-workflow'],
      ['config', 'automation', 'other-workflow'],
      ['config', 'connection', 'synthetic-workflow'],
      ['deployment', 'automation', 'synthetic-workflow'],
    ]) {
      const [row] = await sql`INSERT INTO events (organization_id, connection_id, entity_ids, origin_id, title, payload_type, payload_text, semantic_type, metadata, created_by, occurred_at)
        VALUES (${org.id}, ${connection.id}, ${`{${entityId}}`}::bigint[], ${`resource-filter-${ids.length}`}, 'Configuration needle', 'text', 'Configuration needle', 'change', ${sql.json({ category, resource_kind: kind, resource_id: resourceId })}, ${user.id}, NOW()) RETURNING id`;
      ids.push(Number(row.id));
    }
    const [facet] = await sql`INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by) VALUES (${org.id}, 'resource-test', 'Resource test', 'resource_test', 'active', ${user.id}) RETURNING id`;
    for (const id of ids) await sql`INSERT INTO event_classifications (event_id, classifier_id, "values", source, is_manual) VALUES (${id}, ${facet.id}, ARRAY['matched']::text[], 'user', true)`;
    const other = await createTestOrganization({ name: 'Foreign resource' });
    await sql`INSERT INTO events (organization_id, origin_id, title, payload_type, semantic_type, metadata) VALUES (${other.id}, 'foreign-resource', 'Forbidden', 'empty', 'change', ${sql.json({ category: 'config', resource_kind: 'automation', resource_id: 'synthetic-workflow' })})`;

  });
  const read = (args: Record<string, unknown>) => getContent(args as never, {} as never, ctx);
  it.each([
    ['date', {}],
    ['text search', { query: 'needle' }],
  ])('%s keeps the exact category and resource pair', async (_name, extra) => {
    const result = await read({ ...filter, ...extra, limit: 10 });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[0]]);
    expect(result.content[0].author_name).toBe(username);
  });
  it('exact IDs apply resource filters to results and counts', async () => {
    const result = await read({ ...filter, content_ids: ids, include_total: true });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[0]]);
    expect(result.content[0].author_name).toBe(username);
    expect(result.total).toBe(1);
  });
  it('superseded listings keep the same resource scope', async () => {
    const result = await read({ ...filter, entity_id: entityId, include_superseded: true, sort_by: 'date', sort_order: 'desc' });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[0]]);
    expect(result.content[0].author_name).toBe(username);
  });

  it('score rows and count retain the resource scope', async () => {
    const result = await read({ ...filter, entity_id: entityId, sort_by: 'score', include_total: true });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[0]]);
    expect(result.content[0].author_name).toBe(username);
    expect(result.total).toBe(1);
  });
  it('classification-filtered pages and statistics stay inside the resource', async () => {
    const result = await read({ ...filter, classification_filters: { 'resource-test': ['matched'] }, include_classification: 'summary', sort_by: 'date' });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[0]]);
    expect(result.content[0].author_name).toBe(username);
    expect(result.classification_stats).toEqual({ 'resource-test': { matched: 1 } });
    const next = await read({ ...filter, classification_filters: { 'resource-test': ['matched'] }, sort_by: 'date', before_occurred_at: result.content[0].occurred_at, before_id: ids[0] });
    expect(next.content).toEqual([]);
  });
  it('preserves recorded authors and does not expose creator identities to anonymous reads', async () => {
    const sql = getTestDb();
    const [row] = await sql`SELECT * FROM events WHERE id = ${ids[0]}`;
    const render = (raw: typeof row, privateAttribution: boolean) => buildContentItems({ sql, rawContent: [raw as never], organizationId: ctx.organizationId, ownerSlug: null, baseUrl: undefined, includePrivateAttribution: privateAttribution });
    expect((await render(row, false))[0].author_name).toBeNull();
    expect((await render({ ...row, author_name: 'Recorded actor' }, true))[0].author_name).toBe('Recorded actor');
    await sql`UPDATE events SET created_by = NULL WHERE id = ${ids[0]}`;
    try { expect((await render(row, true))[0].author_name).toBeNull(); }
    finally { await sql`UPDATE events SET created_by = ${ctx.userId} WHERE id = ${ids[0]}`; }
  });
  it('category alone remains useful', async () => {
    const result = await read({ semantic_type: 'change', event_category: 'deployment' });
    expect(result.content.map((event) => Number(event.id))).toEqual([ids[3]]);
  });
  it('omitting filters preserves existing results', async () => {
    const result = await read({ semantic_type: 'change' });
    expect(result.content).toHaveLength(4);
  });
  it.each([
    { resource_kind: 'automation' },
    { resource_id: 'synthetic-workflow' },
    { ...filter, view: 'changes', record: 'company/test' },
    { ...filter, automation_id: 123 },
  ])('rejects incomplete or unsupported scope %j', async (args) => {
    await expect(read(args)).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe('getContent > exact MCP activity filter on sibling SQL paths', () => {
  const CONVERSATION_ID = 'fixture-host-conversation';
  let entityId: number;
  let clientId: string;
  let ctx: ToolContext;

  async function insertEvent(opts: {
    organizationId: string;
    entityId: number;
    connectionId: number;
    clientId: string;
    title: string;
    sessionId: string;
    score: number;
    occurredAt: Date;
  }): Promise<{ id: number; title: string }> {
    const sql = getTestDb();
    const [row] = await sql<{ id: number; title: string }[]>`
      INSERT INTO events (
        entity_ids, connection_id, organization_id, origin_id, title,
        payload_type, payload_text, semantic_type, connector_key, metadata,
        client_id, score, occurred_at, created_at
      ) VALUES (
        ARRAY[${opts.entityId}]::bigint[],
        ${opts.connectionId},
        ${opts.organizationId},
        ${`conversation-filter-${opts.title}`},
        ${opts.title},
        'text',
        ${opts.title},
        'content',
        'test.mcp-conversation',
        ${sql.json({ mcp_session_id: opts.sessionId })},
        ${opts.clientId},
        ${opts.score},
        ${opts.occurredAt},
        NOW()
      )
      RETURNING id, title
    `;
    return { id: Number(row.id), title: row.title };
  }

  beforeAll(async () => {
    const seeded = await seedOwnerOrg(
      'Conversation Filter Paths Org',
      'conversation-filter-paths@example.com'
    );
    const { org, user } = seeded;
    ctx = seeded.ctx;
    clientId = (
      await createTestOAuthClient({
        client_name: 'ChatGPT',
        owner_user_id: user.id,
      })
    ).client_id;
    const entity = await createTestEntity({
      name: 'Conversation Filter Paths Entity',
      organization_id: org.id,
      created_by: user.id,
    });
    entityId = entity.id;
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test.mcp-conversation',
      entity_ids: [entity.id],
      created_by: user.id,
    });

    const t0 = new Date('2026-08-01T00:00:00Z');
    const historical = await insertEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      clientId,
      title: 'matching historical alpha',
      sessionId: 'transport-old',
      score: 1,
      occurredAt: t0,
    });
    const replacement = await insertEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      clientId,
      title: 'matching replacement beta',
      sessionId: 'transport-new',
      score: 2,
      occurredAt: new Date(t0.getTime() + 1000),
    });
    const matchingCurrent = await insertEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      clientId,
      title: 'matching current alpha',
      sessionId: 'transport-old',
      score: 3,
      occurredAt: new Date(t0.getTime() + 2000),
    });
    const unrelated = await insertEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      clientId,
      title: 'unrelated high score omega',
      sessionId: 'transport-other',
      score: 99,
      occurredAt: new Date(t0.getTime() + 3000),
    });

    const sql = getTestDb();
    await sql`
      UPDATE events
      SET superseded_by = ${replacement.id}
      WHERE id = ${historical.id}
    `;
    await sql`
      UPDATE events
      SET supersedes_event_id = ${historical.id}
      WHERE id = ${replacement.id}
    `;

    const [facet] = await sql<{ id: number }[]>`
      INSERT INTO classify_facet (
        organization_id, slug, name, attribute_key, status, created_by
      ) VALUES (
        ${org.id}, 'conversation-kind', 'Conversation kind',
        'conversation_kind', 'active', ${user.id}
      )
      RETURNING id
    `;
    for (const [eventId, value] of [
      [historical.id, 'alpha'],
      [replacement.id, 'beta'],
      [matchingCurrent.id, 'alpha'],
      [unrelated.id, 'omega'],
    ] as const) {
      await sql`
        INSERT INTO event_classifications (
          event_id, classifier_id, "values", source, is_manual
        ) VALUES (
          ${eventId}, ${facet.id}, ARRAY[${value}]::text[], 'user', true
        )
      `;
    }

    await sql`
      INSERT INTO mcp_client_conversations (
        user_id, client_identity, conversation_id,
        transport_session_ids, client_id, last_action, call_count
      ) VALUES (
        ${user.id}, ${clientId}, ${CONVERSATION_ID},
        ${sql.json(['transport-old', 'transport-new'])}, ${clientId}, 'read_knowledge', 1
      )
    `;
  });

  it('applies the exact filter to score-sorted rows and their total count', async () => {
    const result = await getContent(
      {
        entity_id: entityId,
        sort_by: 'score',
        client_ids: [clientId],
        mcp_activity_id: CONVERSATION_ID,
        limit: 100,
      } as never,
      {} as never,
      ctx
    );

    expect(result.content.map((item) => item.title)).toEqual([
      'matching current alpha',
      'matching replacement beta',
    ]);
    expect(result.total).toBe(2);
  });

  it('applies the exact filter in the classification-filtered listing builder', async () => {
    const result = await getContent(
      {
        entity_id: entityId,
        classification_filters: { 'conversation-kind': ['alpha'] },
        client_ids: [clientId],
        mcp_activity_id: CONVERSATION_ID,
        limit: 100,
      } as never,
      {} as never,
      ctx
    );

    expect(result.content.map((item) => item.title)).toEqual(['matching current alpha']);
  });

  it('keeps classification stats inside the exact conversation', async () => {
    const result = await getContent(
      {
        entity_id: entityId,
        include_classification: 'summary',
        client_ids: [clientId],
        mcp_activity_id: CONVERSATION_ID,
        limit: 100,
      } as never,
      {} as never,
      ctx
    );

    expect(result.classification_stats).toEqual({
      'conversation-kind': { alpha: 1, beta: 1 },
    });
  });

  it('applies the exact filter to explicit superseded-history reads', async () => {
    const result = await getContent(
      {
        entity_id: entityId,
        include_superseded: true,
        sort_by: 'date',
        client_ids: [clientId],
        mcp_activity_id: CONVERSATION_ID,
        limit: 100,
      } as never,
      {} as never,
      ctx
    );

    expect(result.content.map((item) => item.title)).toEqual([
      'matching current alpha',
      'matching replacement beta',
      'matching historical alpha',
    ]);
    expect(result.total).toBe(3);
  });

  it('fails closed for incomplete or unknown activity identities', async () => {
    await expect(
      getContent(
        { mcp_activity_id: CONVERSATION_ID } as never,
        {} as never,
        ctx
      )
    ).rejects.toMatchObject({
      httpStatus: 400,
      message: 'mcp_activity_id requires client_ids.',
    });
    await expect(
      getContent(
        {
          client_ids: [clientId],
          mcp_activity_id: 'unknown-chatgpt-conversation',
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toMatchObject({
      httpStatus: 404,
      message: 'MCP activity not found.',
    });
  });
});

describe('getContent > score path honours forwarded filters', () => {
  // Score sorting derives per-connection scoring formulas from the entity's
  // sources, so unlike the list-path fixtures these need a real entity and
  // connection.
  const CHATGPT = 'mcp_score_path_chatgpt';
  const CLI = 'mcp_score_path_cli';
  const AGENT_A = 'agent_score_path_a';
  const AGENT_B = 'agent_score_path_b';
  const AUTOMATION_A = 910_001;
  const AUTOMATION_B = 910_002;
  const QUOTED_SEMANTIC_TYPE = 'score"quoted';
  const BACKSLASH_SEMANTIC_TYPE = 'score\\backslash';

  let entityId: number;
  let ctx: ToolContext;

  async function insertAttributedEvent(opts: {
    organizationId: string;
    entityId: number;
    connectionId: number;
    title: string;
    clientId: string | null;
    agentId: string | null;
    semanticType?: string;
    score: number;
    occurredAt: Date;
  }): Promise<number> {
    const sql = getTestDb();
    const [row] = await sql`
      INSERT INTO events (
        entity_ids, connection_id, organization_id, origin_id, title,
        payload_type, payload_text, semantic_type, connector_key,
        client_id, metadata, score, occurred_at, created_at
      ) VALUES (
        ARRAY[${opts.entityId}]::bigint[],
        ${opts.connectionId},
        ${opts.organizationId},
        ${`score-attr-${opts.title}`},
        ${opts.title},
        'text',
        ${opts.title},
        ${opts.semanticType ?? 'content'},
        'test.connector',
        ${opts.clientId},
        ${sql.json(opts.agentId ? { agent_id: opts.agentId } : {})},
        ${opts.score},
        ${opts.occurredAt},
        NOW()
      )
      RETURNING id
    `;
    return Number((row as { id: unknown }).id);
  }

  beforeAll(async () => {
    const seeded = await seedOwnerOrg('Score Attribution Org', 'score-attr@example.com');
    const { org, user } = seeded;
    ctx = seeded.ctx;

    const entity = await createTestEntity({
      name: 'Score Attribution Entity',
      organization_id: org.id,
      created_by: user.id,
    });
    entityId = entity.id;

    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test.connector',
      display_name: 'Score source account',
      entity_ids: [entityId],
      created_by: user.id,
    });

    await registerClient({
      id: CHATGPT,
      clientName: 'ChatGPT',
      userId: user.id,
      organizationId: org.id,
    });
    await registerClient({
      id: CLI,
      clientName: 'Lobu CLI',
      userId: user.id,
      organizationId: org.id,
    });

    const t0 = new Date('2026-07-01T00:00:00Z');
    const chatgptEventId = await insertAttributedEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      title: 'chatgpt high score row',
      clientId: CHATGPT,
      agentId: AGENT_A,
      score: 99,
      occurredAt: t0,
    });
    const cliEventId = await insertAttributedEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      title: 'cli low score row',
      clientId: CLI,
      agentId: AGENT_B,
      score: 1,
      occurredAt: new Date(t0.getTime() + 1000),
    });
    await insertAttributedEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      title: 'unattributed row',
      clientId: null,
      agentId: null,
      score: 50,
      occurredAt: new Date(t0.getTime() + 2000),
    });
    await insertAttributedEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      title: 'quoted semantic type',
      clientId: null,
      agentId: null,
      semanticType: QUOTED_SEMANTIC_TYPE,
      score: 40,
      occurredAt: new Date(t0.getTime() + 3000),
    });
    await insertAttributedEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      title: 'backslash semantic type',
      clientId: null,
      agentId: null,
      semanticType: BACKSLASH_SEMANTIC_TYPE,
      score: 30,
      occurredAt: new Date(t0.getTime() + 4000),
    });

    const sql = getTestDb();
    await sql`
      INSERT INTO automations
        (id, organization_id, created_by, automation_group_id, name, slug, managed_agent_id)
      VALUES
        (${AUTOMATION_A}, ${org.id}, ${user.id}, ${AUTOMATION_A}, 'Score A', 'score-a', ${AGENT_A}),
        (${AUTOMATION_B}, ${org.id}, ${user.id}, ${AUTOMATION_B}, 'Score B', 'score-b', ${AGENT_B})
    `;
    const resultRuns = await sql<{ id: number }[]>`
      INSERT INTO runs (organization_id, automation_id, run_type, status)
      VALUES
        (${org.id}, ${AUTOMATION_A}, 'automation', 'completed'),
        (${org.id}, ${AUTOMATION_B}, 'automation', 'completed')
      RETURNING id
    `;
    await sql`
      INSERT INTO automation_run_events (run_id, event_id, automation_id)
      VALUES
        (${resultRuns[0].id}, ${chatgptEventId}, ${AUTOMATION_A}),
        (${resultRuns[1].id}, ${cliEventId}, ${AUTOMATION_B})
    `;
  });

  it('baseline: without a filter the score path returns every row', async () => {
    const result = await getContent(
      { entity_id: entityId, sort_by: 'score', limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title).sort()).toEqual([
      'backslash semantic type',
      'chatgpt high score row',
      'cli low score row',
      'quoted semantic type',
      'unattributed row',
    ]);
    expect(result.content.find((c) => c.title === 'chatgpt high score row')).toMatchObject({
      connection_name: 'Score source account',
      agent_id: AGENT_A,
      client_id: CHATGPT,
      client_name: 'ChatGPT',
    });
  });

  it('semantic_type preserves quotes and backslashes in PostgreSQL arrays', async () => {
    const result = await getContent(
      {
        entity_id: entityId,
        sort_by: 'score',
        semantic_type: [QUOTED_SEMANTIC_TYPE, BACKSLASH_SEMANTIC_TYPE],
        limit: 100,
      } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title).sort()).toEqual([
      'backslash semantic type',
      'quoted semantic type',
    ]);
    expect(result.total).toBe(2);
  });

  it('client_ids scopes score-sorted rows to that client', async () => {
    const result = await getContent(
      { entity_id: entityId, sort_by: 'score', client_ids: [CLI], limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title)).toEqual(['cli low score row']);
  });

  it('agent_id scopes score-sorted rows to that agent', async () => {
    const result = await getContent(
      { entity_id: entityId, sort_by: 'score', agent_id: AGENT_B, limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title)).toEqual(['cli low score row']);
  });

  it('analyzed_by_automation_id scopes score-sorted rows to that automation', async () => {
    const result = await getContent(
      {
        entity_id: entityId,
        sort_by: 'score',
        analyzed_by_automation_id: AUTOMATION_B,
        limit: 100,
      } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title)).toEqual(['cli low score row']);
  });

  it('include_superseded applies the client scope', async () => {
    const result = await getContent(
      {
        entity_id: entityId,
        include_superseded: true,
        client_ids: [CLI],
        limit: 100,
      } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title)).toEqual(['cli low score row']);
  });

  it('total count matches the filtered rows, not the unfiltered set', async () => {
    const result = await getContent(
      { entity_id: entityId, sort_by: 'score', client_ids: [CHATGPT], limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});

describe("getContent > entity query with sort_by=score searches instead of score-listing", () => {
  let entityId: number;
  let matchId: number;
  let ctx: ToolContext;

  beforeAll(async () => {
    const seeded = await seedOwnerOrg("Query Score Org", "query-score@example.com");
    const organizationId = seeded.org.id;
    const userId = seeded.user.id;
    ctx = seeded.ctx;

    const entity = await createTestEntity({
      name: "Query Score Entity",
      organization_id: organizationId,
      created_by: userId,
    });
    entityId = entity.id;

    await createTestConnectorDefinition({
      key: "query-score-connector",
      name: "Query Score Connector",
      organization_id: organizationId,
    });
    const connection = await createTestConnection({
      organization_id: organizationId,
      connector_key: "query-score-connector",
      entity_ids: [entityId],
      created_by: userId,
    });

    // The match scores LOW on purpose; the decoy scores HIGH. A score-listing
    // would return the decoy first with total 2.
    matchId = (
      await createTestEvent({
        entity_id: entityId,
        connection_id: connection.id,
        organization_id: organizationId,
        title: "physician rounds summary",
        content: "The physician visited every ward at noon",
      })
    ).id;
    await getTestDb()`UPDATE events SET score = 1 WHERE id = ${matchId}`;
    const decoy = await createTestEvent({
      entity_id: entityId,
      connection_id: connection.id,
      organization_id: organizationId,
      title: "Quarterly budget review",
      content: "Numbers and charts with no medical terms at all",
    });
    await getTestDb()`UPDATE events SET score = 99 WHERE id = ${decoy.id}`;
  });

  it("filters by the query and counts only matches", async () => {
    const result = await getContent(
      { entity_id: entityId, query: "physician", sort_by: "score", limit: 50 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((item) => item.id)).toEqual([matchId]);
    expect(result.total).toBe(1);

    // Vacuity guard: without the query the score listing still returns both.
    const listing = await getContent(
      { entity_id: entityId, sort_by: "score", limit: 50 } as never,
      {} as never,
      ctx
    );
    expect(listing.total).toBe(2);
  });
});
