/**
 * Agent-facing content bounds (#2983): SQL-native list/window projections,
 * exact-id full text, nested JSON replacement, and the dynamic query_sql seam.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import { fingerprintAutomationSources } from '../../../tools/get_content/automation-mode';
import type { ToolContext } from '../../../tools/registry';
import { stableJson } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestConnection,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

const HEAD_CHARS = 4_000;
const LARGE_EVENT_CHARS = 5 * 1024 * 1024;
const LARGE_CONTROL_VALUE = 'c'.repeat(32 * 1024);
const LARGE_CONTROL_METADATA = { proposal: { note: LARGE_CONTROL_VALUE } };
const LARGE_CONTROL_SCHEMA = {
  type: 'object',
  properties: { note: { type: 'string', description: LARGE_CONTROL_VALUE } },
};
const LARGE_CONTROL_INPUT = { note: LARGE_CONTROL_VALUE };
const LARGE_CONTROL_OUTPUT = { preview: LARGE_CONTROL_VALUE };

describe('agent-facing content read bounds', () => {
  let owner: TestApiClient;
  let ownerCtx: ToolContext;
  let orgId: string;
  let agentId: string;
  let entityId: number;
  let feedId: number;
  let hugeEventId: number;
  let hugeText: string;
  let exactInputId: number;
  const exactInputText = 'Complete exact input.'.repeat(6_000);

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Content Read Bounds' });
    orgId = org.id;
    const user = await createTestUser({ email: 'content-bounds@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
    ownerCtx = ownerToolContext(org.id, user.id);

    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
    });
    agentId = agent.agentId;
    const entity = await createTestEntity({
      name: 'Bound document',
      entity_type: 'company',
      organization_id: org.id,
      created_by: user.id,
    });
    entityId = Number(entity.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test.connector',
      display_name: 'Bound source',
      slug: 'bound-source',
    });
    const [feed] = await getTestDb()<{ id: number | string }[]>`
      SELECT id FROM feeds WHERE connection_id = ${connection.id} AND feed_key = 'default'
    `;
    feedId = Number(feed.id);

    // The 4,000th PostgreSQL character is an astral code point. UTF-16 slicing
    // at 4,000 units would corrupt it; PG left(..., 4000) must retain it whole.
    hugeText = `${'a'.repeat(HEAD_CHARS - 1)}😀${'z'.repeat(
      LARGE_EVENT_CHARS - HEAD_CHARS
    )}`;
    const db = getTestDb();
    const [run] = await db<{ id: number | string }[]>`
      INSERT INTO runs (organization_id, run_type, status, approval_status)
      VALUES (${org.id}, 'action', 'pending', 'pending')
      RETURNING id
    `;
    const [inserted] = await db<{ id: number | string }[]>`
      INSERT INTO events (
        organization_id, entity_ids, connection_id, feed_id, feed_key,
        origin_id, title, payload_type, payload_text, payload_data, attachments,
        occurred_at, semantic_type, connector_key, metadata, created_at,
        interaction_type, interaction_status, interaction_input_schema,
        interaction_input, interaction_output, run_id
      ) VALUES (
        ${org.id}, ARRAY[${entityId}]::bigint[], ${connection.id}, ${feedId}, 'default',
        'content-bounds-huge', 'Huge document', 'text', ${hugeText},
        ${db.json({ body: 'p'.repeat(32 * 1024) })},
        ${db.json([{ text: 't'.repeat(32 * 1024) }])},
        NOW() - INTERVAL '1 second', 'operation', 'test.connector',
        ${db.json(LARGE_CONTROL_METADATA)}, NOW(), 'approval', 'pending',
        ${db.json(LARGE_CONTROL_SCHEMA)}, ${db.json(LARGE_CONTROL_INPUT)},
        ${db.json(LARGE_CONTROL_OUTPUT)}, ${run.id}
      )
      RETURNING id
    `;
    hugeEventId = Number(inserted.id);
    const [exactInput] = await db<{ id: number | string }[]>`
      INSERT INTO events (
        organization_id, entity_ids, connection_id, feed_id, feed_key,
        origin_id, payload_type, payload_text, payload_data, attachments,
        occurred_at, semantic_type, connector_key, created_at
      ) VALUES (
        ${org.id}, ARRAY[${entityId}]::bigint[], ${connection.id}, ${feedId}, 'default',
        'content-bounds-exact', 'text', ${exactInputText},
        ${db.json({ body: 'p'.repeat(32 * 1024) })},
        ${db.json([{ text: 't'.repeat(32 * 1024) }])},
        NOW(), 'content', 'test.connector', NOW()
      )
      RETURNING id
    `;
    exactInputId = Number(exactInput.id);
  }, 120_000);

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('bounds a 5MB chronological listing with PG char semantics and nested JSON markers', async () => {
    const result = (await owner.knowledge.read({
      entity_id: entityId,
      limit: 50,
    })) as { content: Array<Record<string, unknown>> };
    const huge = result.content.find((row) => Number(row.id) === hugeEventId);

    expect(huge).toBeDefined();
    expect(huge?.payload_truncated).toBe(true);
    expect(huge?.content_length).toBe(LARGE_EVENT_CHARS);
    expect(huge?.payload_text).toBe(`${'a'.repeat(HEAD_CHARS - 1)}😀… [truncated]`);
    expect(huge?.payload_data).toEqual({ _truncated: true, bytes: expect.any(Number) });
    expect(huge?.attachments).toEqual([]);
    expect(huge?.attachments_truncated).toBe(true);
    expect(huge?.attachments_bytes).toBeGreaterThan(32 * 1024);
    expect(huge?.metadata).toEqual(LARGE_CONTROL_METADATA);
    expect(huge?.interaction_input_schema).toEqual(LARGE_CONTROL_SCHEMA);
    expect(huge?.interaction_input).toEqual(LARGE_CONTROL_INPUT);
    expect(huge?.interaction_output).toEqual(LARGE_CONTROL_OUTPUT);
  });

  it('applies the same final projection after score ranking', async () => {
    const result = (await owner.knowledge.read({
      entity_id: entityId,
      sort_by: 'score',
      limit: 50,
    })) as { content: Array<Record<string, unknown>> };
    const huge = result.content.find((row) => Number(row.id) === hugeEventId);

    expect(huge?.payload_truncated).toBe(true);
    expect(huge?.content_length).toBe(LARGE_EVENT_CHARS);
    expect(huge?.payload_data).toEqual({ _truncated: true, bytes: expect.any(Number) });
    expect(huge?.attachments).toEqual([]);
    expect(huge?.attachments_truncated).toBe(true);
    expect(huge?.metadata).toEqual(LARGE_CONTROL_METADATA);
    expect(huge?.interaction_input_schema).toEqual(LARGE_CONTROL_SCHEMA);
    expect(huge?.interaction_input).toEqual(LARGE_CONTROL_INPUT);
    expect(huge?.interaction_output).toEqual(LARGE_CONTROL_OUTPUT);
  });

  it('bounds the historical listing after selecting its page', async () => {
    const result = (await owner.knowledge.read({
      entity_id: entityId,
      include_superseded: true,
      limit: 50,
    })) as { content: Array<Record<string, unknown>> };
    const huge = result.content.find((row) => Number(row.id) === hugeEventId);

    expect(huge?.payload_truncated).toBe(true);
    expect(huge?.payload_data).toEqual({ _truncated: true, bytes: expect.any(Number) });
    expect(huge?.attachments).toEqual([]);
    expect(huge?.metadata).toEqual(LARGE_CONTROL_METADATA);
    expect(huge?.interaction_input_schema).toEqual(LARGE_CONTROL_SCHEMA);
    expect(huge?.interaction_input).toEqual(LARGE_CONTROL_INPUT);
    expect(huge?.interaction_output).toEqual(LARGE_CONTROL_OUTPUT);
  });

  it('keeps the same event full on an explicit content_ids read', async () => {
    const result = (await owner.knowledge.read({ content_ids: [hugeEventId] })) as {
      content: Array<Record<string, unknown>>;
    };
    const huge = result.content.find((row) => Number(row.id) === hugeEventId);

    expect(huge?.payload_text).toBe(hugeText);
    expect(huge?.payload_truncated).not.toBe(true);
    expect(huge?.payload_data).toEqual({ body: 'p'.repeat(32 * 1024) });
    expect(huge?.attachments).toEqual([{ text: 't'.repeat(32 * 1024) }]);
    expect(huge?.attachments_truncated).not.toBe(true);
  });

  it('bounds Automation event sources and leaves the source page usable', async () => {
    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'content-bounds-automation',
      name: 'Content Bounds Automation',
      prompt: 'Summarize {{content}}.',
      managed_agent_id: agentId,
      sources: [{ name: 'content', query: `@feed:${feedId}` }],
    })) as { automation_id: string };
    const result = (await owner.knowledge.read({
      automation_id: Number(created.automation_id),
      since: 'today',
      until: 'today',
      limit: 50,
    })) as {
      content: Array<Record<string, unknown>>;
      sources: Record<string, Array<Record<string, unknown>>>;
      total_count_chars: number;
    };

    const contentHuge = result.content.find((row) => Number(row.id) === hugeEventId);
    const sourceHuge = result.sources.content.find((row) => Number(row.id) === hugeEventId);
    expect(contentHuge?.payload_truncated).toBe(true);
    expect(contentHuge?.content_length).toBe(LARGE_EVENT_CHARS);
    expect(contentHuge?.attachments).toEqual([]);
    expect(contentHuge?.attachments_truncated).toBe(true);
    expect(sourceHuge?.payload_truncated).toBe(true);
    expect(sourceHuge?.payload_data).toEqual({ _truncated: true, bytes: expect.any(Number) });
    expect(sourceHuge?.attachments).toBeNull();
    expect(result.total_count_chars).toBeGreaterThanOrEqual(LARGE_EVENT_CHARS);

    const defaultCreated = (await owner.automations.create({
      entity_id: entityId,
      slug: 'content-bounds-default-automation',
      name: 'Content Bounds Default Automation',
      prompt: 'Summarize {{content}}.',
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const defaultResult = (await owner.knowledge.read({
      automation_id: Number(defaultCreated.automation_id),
      since: 'today',
      until: 'today',
      limit: 50,
    })) as { sources: Record<string, Array<Record<string, unknown>>> };
    const defaultHuge = defaultResult.sources.content.find(
      (row) => Number(row.id) === hugeEventId
    );
    expect(defaultHuge?.payload_truncated).toBe(true);
    expect(defaultHuge?.payload_data).toEqual({ _truncated: true, bytes: expect.any(Number) });
    expect(defaultHuge?.attachments).toBeNull();
    // The historical default source is SELECT *: bounding must not silently
    // narrow away event columns that Automation prompts/scripts may consume.
    expect(defaultHuge).toHaveProperty('interaction_type');
    expect(defaultHuge).toHaveProperty('run_id');

    const customCreated = (await owner.automations.create({
      entity_id: entityId,
      slug: 'content-bounds-custom-sql-automation',
      name: 'Content Bounds Custom SQL Automation',
      prompt: 'Summarize {{content}}.',
      managed_agent_id: agentId,
      sources: [
        {
          name: 'content',
          query: `SELECT id, payload_text, payload_data, attachments, occurred_at
            FROM events WHERE feed_id = ${feedId} ORDER BY occurred_at DESC`,
        },
      ],
    })) as { automation_id: string };
    const customResult = (await owner.knowledge.read({
      automation_id: Number(customCreated.automation_id),
      since: 'today',
      until: 'today',
      limit: 50,
    })) as {
      content: Array<Record<string, unknown>>;
      sources: Record<string, Array<Record<string, unknown>>>;
      total_count_chars: number;
    };
    const customSourceHuge = customResult.sources.content.find(
      (row) => Number(row.id) === hugeEventId
    );
    const customContentHuge = customResult.content.find(
      (row) => Number(row.id) === hugeEventId
    );
    expect(customSourceHuge?.payload_truncated).toBe(true);
    expect(customSourceHuge?.content_length).toBe(LARGE_EVENT_CHARS);
    expect(customSourceHuge?.payload_data).toEqual({
      _truncated: true,
      bytes: expect.any(Number),
    });
    expect(customSourceHuge?.attachments).toBeNull();
    expect(customContentHuge?.payload_truncated).toBe(true);
    expect(customResult.total_count_chars).toBeGreaterThanOrEqual(LARGE_EVENT_CHARS);

    // Required exact inputs cannot be paged or silently shortened. Standalone
    // exact-id reads remain full fidelity; an oversized Automation envelope
    // must fail explicitly instead of overflowing the SDK transport.
    await expect(owner.knowledge.read({
      automation_id: Number(created.automation_id),
      content_ids: [hugeEventId],
      since: 'today',
      until: 'today',
      limit: 50,
    })).rejects.toThrow(/Automation knowledge response cannot fit its byte budget/);

    const exact = (await owner.knowledge.read({
      automation_id: Number(created.automation_id),
      content_ids: [exactInputId],
      since: 'today',
      until: 'today',
      limit: 50,
    })) as { sources: Record<string, Array<Record<string, unknown>>> };
    const exactTrigger = exact.sources.__event_inputs.find(
      (row) => Number(row.id) === exactInputId
    );
    expect(exactTrigger?.payload_text).toBe(exactInputText);
    expect(exactTrigger?.payload_truncated).not.toBe(true);
    expect(exactTrigger?.payload_data).toEqual({ body: 'p'.repeat(32 * 1024) });
    expect(exactTrigger?.attachments).toEqual([{ text: 't'.repeat(32 * 1024) }]);
    expect(exactTrigger?.attachments_truncated).not.toBe(true);

    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const before = await fingerprintAutomationSources({
      sql: getTestDb(),
      automationId: Number(created.automation_id),
      windowStart,
      windowEnd,
    });
    const db = getTestDb();
    const legacyRows = await db<Record<string, unknown>[]>`
      SELECT id, organization_id, entity_ids, origin_id, title, payload_type, payload_text,
        payload_data, payload_template, attachments, author_name, source_url, occurred_at, score,
        metadata, created_at, origin_parent_id, origin_type, connector_key, connection_id,
        feed_key, feed_id, semantic_type
      FROM current_event_records
      WHERE organization_id = ${orgId}
        AND feed_id = ${feedId}
        AND entity_ids && ARRAY[${entityId}]::bigint[]
        AND occurred_at >= ${windowStart}::timestamptz
        AND occurred_at < ${windowEnd}::timestamptz
      ORDER BY occurred_at DESC
    `;
    const legacySourceState = {
      content: legacyRows.sort((left, right) =>
        stableJson(left).localeCompare(stableJson(right))
      ),
    };
    expect(before.fingerprint).toBe(
      createHash('sha256').update(stableJson(legacySourceState)).digest('hex')
    );
  }, 120_000);

  it('bounds dynamic internal query_sql SELECT * results', async () => {
    const result = await querySql(
      {
        sql: `SELECT id, payload_text, payload_data, attachments FROM events WHERE id = ${hugeEventId}`,
        limit: 10,
      },
      {},
      ownerCtx
    );

    expect(result.error).toBeUndefined();
    expect(result.rows[0].payload_truncated).toBe(true);
    expect(result.rows[0].content_length).toBe(LARGE_EVENT_CHARS);
    expect(result.rows[0].payload_data).toEqual({ _truncated: true, bytes: expect.any(Number) });
    expect(result.rows[0].attachments).toBeNull();
    expect(result.rows[0].attachments_truncated).toBe(true);
  });
});
