/**
 * Regression test: `sort_by: 'score'` must honour the forwarded filters.
 *
 * `get_content` has FOUR filter-application sites, and the
 * `sort_by === 'score' && entity_id` branch runs through its own builder
 * (`buildFilterConditionsAndJoins` in content-scoring.ts). Both it and the
 * handler's filters object enumerate fields explicitly, so anything not listed
 * is silently DROPPED — the query returns unfiltered rows rather than erroring,
 * which is the worst failure shape: a caller asking "what did this client do"
 * gets everything, led by whatever scored highest.
 *
 * THREE filters were missing, i.e. a class not a one-off:
 *   - `client_ids`             — added alongside the filter in this branch
 *   - `agent_id`               — pre-existing
 *   - `analyzed_by_automation_id`— pre-existing; the handler always passed it
 *
 * Fixtures deliberately give the NON-matching rows the higher score, so a
 * dropped filter surfaces them first and fails loudly rather than passing by
 * accident on ordering. Score sorting derives per-connection scoring formulas
 * from the entity's sources, so unlike the list-path test these fixtures need a
 * real entity + connection.
 *
 * The list and search paths are covered by get-content-client-id-filter.test.ts.
 *
 * With a `query` present, an entity-scoped `sort_by: 'score'` call must go
 * through text search instead of the score listing: the query filters rows.
 * That fixture also gives the NON-matching decoy the higher stored score, so
 * routing to the score builder surfaces the decoy and inflates the total.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
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

const CHATGPT = 'mcp_score_path_chatgpt';
const CLI = 'mcp_score_path_cli';
const AGENT_A = 'agent_score_path_a';
const AGENT_B = 'agent_score_path_b';
const AUTOMATION_A = 910_001;
const AUTOMATION_B = 910_002;
const QUOTED_SEMANTIC_TYPE = 'score"quoted';
const BACKSLASH_SEMANTIC_TYPE = 'score\\backslash';

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

describe('getContent > score path honours forwarded filters', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entityId: number;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Score Attribution Org' });
    user = await createTestUser({ email: 'score-attr@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

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

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    } as ToolContext;
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
  let organizationId: string;
  let userId: string;
  let entityId: number;
  let connectionId: number;
  let matchId: number;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();

    const org = await createTestOrganization({ name: "Query Score Org" });
    organizationId = org.id;
    const user = await createTestUser({ email: "query-score@example.com" });
    userId = user.id;
    await addUserToOrganization(userId, organizationId, "owner");

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
    connectionId = connection.id;

    // The match scores LOW on purpose; the decoy scores HIGH. A score-listing
    // would return the decoy first with total 2.
    matchId = (
      await createTestEvent({
        entity_id: entityId,
        connection_id: connectionId,
        organization_id: organizationId,
        title: "physician rounds summary",
        content: "The physician visited every ward at noon",
      })
    ).id;
    await getTestDb()`UPDATE events SET score = 1 WHERE id = ${matchId}`;
    const decoy = await createTestEvent({
      entity_id: entityId,
      connection_id: connectionId,
      organization_id: organizationId,
      title: "Quarterly budget review",
      content: "Numbers and charts with no medical terms at all",
    });
    await getTestDb()`UPDATE events SET score = 99 WHERE id = ${decoy.id}`;

    ctx = {
      organizationId,
      userId,
      memberRole: "owner",
      isAuthenticated: true,
      tokenType: "oauth",
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ["mcp:read"],
    } as ToolContext;
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
