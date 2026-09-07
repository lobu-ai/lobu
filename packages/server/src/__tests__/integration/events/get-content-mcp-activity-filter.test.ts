/**
 * Exact MCP activity filtering crosses several independently assembled SQL
 * paths. Every assertion gives the unrelated session a higher score or its own
 * classification so a dropped filter fails by leaking a loud, plausible row.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

interface SeededEvent {
  id: number;
  title: string;
}

const CONVERSATION_ID = 'fixture-host-conversation';

async function insertEvent(opts: {
  organizationId: string;
  entityId: number;
  connectionId: number;
  clientId: string;
  title: string;
  sessionId: string;
  score: number;
  occurredAt: Date;
}): Promise<SeededEvent> {
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

describe('getContent > exact MCP activity filter on sibling SQL paths', () => {
  let entityId: number;
  let clientId: string;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Conversation Filter Paths Org' });
    const user = await createTestUser({ email: 'conversation-filter-paths@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
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
        organization_id, client_identity, conversation_id,
        transport_session_ids, client_id, last_action, call_count
      ) VALUES (
        ${org.id}, ${clientId}, ${CONVERSATION_ID},
        ${sql.json(['transport-old', 'transport-new'])}, ${clientId}, 'read_knowledge', 1
      )
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
