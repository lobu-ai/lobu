import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization, createTestAccessToken, createTestAgent, createTestConnection,
  createTestEntity, createTestOAuthClient, createTestOrganization, createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient, TestMcpClient } from '../../setup/test-mcp-client';
import { fingerprintAutomationSources } from '../../../tools/get_content/automation-mode';
import { materializeDueAutomationRuns } from '../../../automations/automation';
import type { Env } from '../../../index';

const ROW_COUNT = 1001;

type WindowRead = {
  content: Array<{ id: number; payload_text?: string; text_content?: string }>;
  sources: Record<string, Array<Record<string, unknown>>>;
  sources_page: Record<string, { has_more: boolean }>;
  window_token: string;
  window_start: string;
  window_end: string;
  page: { has_more: boolean; next_cursor?: { occurred_at: string; id: number } };
};

describe('SQL frame Automation coverage', () => {
  let api: TestApiClient;
  let wire: TestMcpClient;
  let entityId: number;
  let feedId: number;
  let agentId: string;
  let expectedIds: number[];

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'SQL Frame Coverage Org' });
    const user = await createTestUser({ email: 'sql-frame@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    api = await TestApiClient.for({ organizationId: org.id, userId: user.id, memberRole: 'owner' });
    const oauth = await createTestOAuthClient();
    const { token } = await createTestAccessToken(user.id, org.id, oauth.client_id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });
    wire = new TestMcpClient({ token, orgSlug: org.slug });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    agentId = agent.agentId;
    const entity = await createTestEntity({
      organization_id: org.id, created_by: user.id, name: 'Frame subject', entity_type: 'company',
    });
    entityId = Number(entity.id);
    const connection = await createTestConnection({
      organization_id: org.id, connector_key: 'test.connector', slug: 'sql-frame-source',
    });
    const sql = getTestDb();
    const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${connection.id} AND feed_key = 'default'`;
    feedId = Number(feed.id);
    const inserted = await sql`
      INSERT INTO events (organization_id, entity_ids, connection_id, feed_id, feed_key,
        origin_id, title, payload_type, payload_text, semantic_type, connector_key, occurred_at, created_at)
      SELECT ${org.id}, ARRAY[${entityId}]::bigint[], ${connection.id}, ${feedId}, 'default',
        'sql-frame-' || n, 'Frame input ' || n, 'text', 'Raw body stays outside the model frame',
        'content', 'test.connector', NOW() - (n + 120) * INTERVAL '1 second', NOW() - INTERVAL '2 minutes'
      FROM generate_series(1, ${ROW_COUNT}) n
      RETURNING id
    `;
    expectedIds = inserted.map(row => Number(row.id)).sort((a, b) => a - b);
  });

  afterAll(async () => { await cleanupTestDatabase(); });

  async function create(slug: string, frameQuery?: string, scheduled = false) {
    return await api.automations.create({
      entity_id: entityId, slug, name: slug, prompt: 'Analyze the SQL frame, using event IDs for provenance.',
      managed_agent_id: agentId,
      ...(scheduled ? { triggers: [{ kind: 'schedule', cron: '* * * * *', skip_if_unchanged: true }] } : {}),
      sources: [
        { name: 'content', query: `SELECT id, occurred_at FROM events WHERE feed_id = ${feedId}` },
        ...(frameQuery ? [{ name: 'frame', query: frameQuery, context: true }] : []),
      ],
      outputs: { signals: { event: 'observation' } },
    }) as { automation_id: string };
  }

  async function claim(automationId: string, limit: number) {
    return await api.automations.claimNextWindow({ automation_id: automationId, limit }) as {
      run_id: number; context: WindowRead;
    };
  }

  async function scheduledRun(automationId: string) {
    const sql = getTestDb();
    const [automation] = await sql`SELECT organization_id, current_version_id, next_window_start FROM automations WHERE id = ${Number(automationId)}`;
    const [run] = await sql`INSERT INTO runs (organization_id, automation_id, run_type, status, approved_input)
      VALUES (${automation.organization_id}, ${Number(automationId)}, 'automation', 'running',
        ${sql.json({ automation_id: Number(automationId), agent_id: agentId,
          version_id: Number(automation.current_version_id), dispatch_source: 'scheduled',
          window_start: new Date(automation.next_window_start).toISOString(), window_end: new Date().toISOString() })})
      RETURNING id`;
    return { run_id: Number(run.id) };
  }

  it('completes a reduced SQL frame without returning raw event bodies', async () => {
    const created = await create('sql-frame-completion',
      `SELECT 1 AS id, COUNT(*)::int AS event_count FROM events WHERE feed_id = ${feedId}`);
    let claimed = await claim(created.automation_id, 500);
    const runId = claimed.run_id;
    const tokens: string[] = [];
    const ids: number[] = [];
    const analyzedFrame = claimed.context.sources.frame;
    expect(analyzedFrame).toEqual([{ id: 1, event_count: ROW_COUNT }]);
    for (let page = 0; page < 10; page++) {
      const r = claimed.context;
      expect(r.sources.frame).toEqual(analyzedFrame);
      expect(r.sources_page.frame.has_more).toBe(false);
      expect(r.content.every(row => row.payload_text == null && row.text_content == null)).toBe(true);
      tokens.push(r.window_token);
      ids.push(...r.content.map(row => Number(row.id)));
      if (!r.page.has_more) break;
      const cursor = r.page.next_cursor!;
      claimed = await api.automations.claimNextWindow({
        automation_id: created.automation_id, run_id: runId, limit: 500,
        before_occurred_at: cursor.occurred_at, before_id: cursor.id,
      }) as typeof claimed;
    }
    expect(ids.sort((a, b) => a - b)).toEqual(expectedIds);
    const completed = await api.automations.completeWindow({
      automation_id: created.automation_id, run_id: runId, window_tokens: tokens,
      extracted_data: { signals: [{ content: `Observed ${analyzedFrame[0].event_count} inputs`, idempotency_key: 'sql-frame-count' }] },
    }) as { content_linked: number };
    expect(completed.content_linked).toBe(ROW_COUNT);
    const [persisted] = await getTestDb()`SELECT a.next_window_start, r.status,
      r.approved_input->>'window_end' AS window_end
      FROM automations a JOIN runs r ON r.automation_id = a.id
      WHERE a.id = ${Number(created.automation_id)} AND r.id = ${runId}`;
    expect(persisted.status).toBe('completed');
    expect(new Date(persisted.next_window_start).toISOString()).toBe(new Date(persisted.window_end).toISOString());
  });

  it('retains the overflow sentinel at the maximum event page size', async () => {
    const created = await create('sql-frame-max-page');
    // Scheduled reads use knowledge.read; externally leased claims must page
    // through claimNextWindow to retain their lease fence.
    const claimed = await scheduledRun(created.automation_id);
    const read = await api.knowledge.read({
      automation_id: Number(created.automation_id), run_id: claimed.run_id, limit: 1000,
    }) as WindowRead;
    expect(read.content).toHaveLength(1000);
    expect(read.page.has_more).toBe(true);
    await expect(api.automations.completeWindow({
      automation_id: created.automation_id, run_id: claimed.run_id,
      window_token: read.window_token, extracted_data: { signals: [] },
    })).rejects.toThrow(/More Automation source pages remain/);
    const cursor = read.page.next_cursor!;
    const continuation = await api.knowledge.read({
      automation_id: Number(created.automation_id), run_id: claimed.run_id, limit: 1000,
      before_occurred_at: cursor.occurred_at, before_id: cursor.id,
    }) as WindowRead;
    expect(continuation.content).toHaveLength(1);
    expect(continuation.page.has_more).toBe(false);
    expect([...read.content, ...continuation.content].map(row => Number(row.id)).sort((a, b) => a - b))
      .toEqual(expectedIds);
    const completed = await api.automations.completeWindow({
      automation_id: created.automation_id, run_id: claimed.run_id,
      window_tokens: [read.window_token, continuation.window_token], extracted_data: { signals: [] },
    }) as { content_linked: number };
    expect(completed.content_linked).toBe(ROW_COUNT);
  });

  it('completes a context-only SQL aggregate without enumerating its input events', async () => {
    const created = await api.automations.create({
      entity_id: entityId, slug: 'sql-frame-context-only', name: 'Context-only aggregate',
      prompt: 'Analyze the SQL aggregate.', managed_agent_id: agentId,
      // The constant id also satisfies the old validator: this execution path
      // predates the fix allowing context aggregates to omit an id column.
      sources: [{ name: 'frame', context: true,
        query: `SELECT 1 AS id, COUNT(*)::int AS event_count FROM events WHERE feed_id = ${feedId}` }],
      outputs: { signals: { event: 'observation' } },
    }) as { automation_id: string };
    await api.automations.setReactionScript({
      automation_id: created.automation_id,
      reaction_script: 'export default async function reaction() { return; }',
    });
    const result = await wire.runSdk<{
      success: boolean; error?: unknown;
      return_value?: { run_id: number; event_count: number; returned_events: number;
        linked: number; completed_now: boolean; reaction_status: string; reaction_task_run_id: number };
    }>(`export default async (_ctx, client) => {
      const claimed = await client.automations.claimNextWindow({ automation_id: '${created.automation_id}', limit: 500 });
      const input = claimed.context;
      if (input.content.length || input.page.has_more || input.sources_page.frame.has_more)
        throw new Error('Expected one complete context-only frame');
      const event_count = input.sources.frame[0].event_count;
      const done = await client.automations.completeWindow({
        automation_id: '${created.automation_id}', run_id: claimed.run_id, window_token: input.window_token,
        extracted_data: { signals: [{ content: 'Context-only aggregate observed ' + event_count + ' inputs',
          idempotency_key: 'context-only-frame-count' }] },
      });
      return { run_id: claimed.run_id, event_count, returned_events: input.content.length,
        linked: done.content_linked, completed_now: done.completed_now,
        reaction_status: done.reaction_status, reaction_task_run_id: done.reaction_task_run_id };
    }`);
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(result.return_value).toMatchObject({ event_count: ROW_COUNT, returned_events: 0,
      linked: 0, completed_now: true, reaction_status: 'queued' });
    const sql = getTestDb();
    const [persisted] = await sql`SELECT a.next_window_start, r.approved_input->>'window_end' AS window_end,
      r.status FROM automations a JOIN runs r ON r.automation_id = a.id WHERE r.id = ${result.return_value!.run_id}`;
    expect(persisted.status).toBe('completed');
    expect(new Date(persisted.next_window_start).toISOString()).toBe(new Date(persisted.window_end).toISOString());
    const outputs = await sql`SELECT id FROM events WHERE payload_text = ${`Context-only aggregate observed ${ROW_COUNT} inputs`}
      AND semantic_type = 'observation' AND ${entityId} = ANY(entity_ids)`;
    expect(outputs).toHaveLength(1);
    const [reaction] = await sql`SELECT parent_run_id, status FROM runs WHERE id = ${result.return_value!.reaction_task_run_id}`;
    expect(Number(reaction.parent_run_id)).toBe(result.return_value!.run_id);
    expect(reaction.status).toBe('pending');
  }, 60_000);

  it('reports context overflow at the maximum requested page size', async () => {
    const created = await create('sql-frame-context-overflow',
      `SELECT id FROM events WHERE feed_id = ${feedId} ORDER BY id`);
    const claimed = await claim(created.automation_id, 500);
    const read = await api.knowledge.read({
      automation_id: Number(created.automation_id), run_id: claimed.run_id, limit: 1000,
    }) as WindowRead;
    expect(read.sources.frame).toHaveLength(1000);
    expect(read.sources_page.frame.has_more).toBe(true);
  });

  it('rejects a run-bound knowledge read when its frame query fails', async () => {
    const created = await create('sql-frame-query-failure',
      `SELECT id, occurred_at, 1 / (id - id) AS broken FROM events WHERE feed_id = ${feedId}`);
    const run = await scheduledRun(created.automation_id);
    await expect(api.knowledge.read({
      automation_id: Number(created.automation_id), run_id: run.run_id, limit: 500,
    })).rejects.toThrow(/division by zero|Data source.*failed/);
  });

  it('accepts an aggregate context source without an event id projection', async () => {
    const created = await create('sql-frame-aggregate-no-id',
      `SELECT COUNT(*)::int AS event_count FROM events WHERE feed_id = ${feedId}`);
    const claimed = await claim(created.automation_id, 500);
    expect(claimed.context.sources.frame).toEqual([{ event_count: ROW_COUNT }]);
  });

  it('still requires event ids for event sources', async () => {
    await expect(api.automations.create({
      entity_id: entityId, slug: 'sql-frame-event-id-required', name: 'Event id required',
      prompt: 'Analyze events.', managed_agent_id: agentId,
      sources: [{ name: 'content', query: `SELECT COUNT(*)::int AS event_count FROM events WHERE feed_id = ${feedId}` }],
      outputs: { signals: { event: 'observation' } },
    })).rejects.toThrow(/query must project an "id" column/);
  });

  it('still validates context query columns', async () => {
    await expect(create('sql-frame-invalid-column',
      'SELECT SUM(nonexistent_frame_column) AS total FROM events',
    )).rejects.toThrow(/nonexistent_frame_column/);
  });

  it('does not use a truncated source fingerprint to skip a scheduled run', async () => {
    const created = await create('sql-frame-incomplete-fingerprint', undefined, true);
    const [automation] = await getTestDb()`SELECT next_window_start FROM automations WHERE id = ${Number(created.automation_id)}`;
    const fingerprint = await fingerprintAutomationSources({
      sql: getTestDb(), automationId: Number(created.automation_id),
      windowStart: new Date(automation.next_window_start).toISOString(), windowEnd: new Date().toISOString(),
    });
    expect(fingerprint.empty).toBe(false);
    expect(fingerprint.fingerprint).toBeUndefined();
    await getTestDb()`UPDATE automations SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = ${Number(created.automation_id)}`;
    const scheduled = await materializeDueAutomationRuns({} as Env, getTestDb());
    expect(scheduled).toMatchObject({ runsCreated: 1, skipped: 0 });
    const [after] = await getTestDb()`SELECT next_window_start FROM automations WHERE id = ${Number(created.automation_id)}`;
    expect(new Date(after.next_window_start).toISOString()).toBe(new Date(automation.next_window_start).toISOString());
  });

  it('keeps raw inputs and completion tokens outside the model-facing MCP result', async () => {
    const created = await create('sql-frame-wire',
      `SELECT COUNT(*)::int AS event_count FROM events WHERE feed_id = ${feedId}`);
    const claimed = await wire.runSdk<{
      success: boolean; error?: unknown;
      return_value?: { run_id: number; frame: Array<{ event_count: number }> };
    }>(`export default async (_ctx, client) => {
      const r = await client.automations.claimNextWindow({ automation_id: '${created.automation_id}', limit: 500 });
      return { run_id: r.run_id, frame: r.context.sources.frame };
    }`);
    expect(claimed.success, JSON.stringify(claimed.error)).toBe(true);
    expect(claimed.return_value?.frame).toEqual([{ event_count: ROW_COUNT }]);
    const result = await wire.runSdk<{
      success: boolean; error?: unknown;
      return_value?: { pages: number; linked: number; completed_now: boolean; replayed: boolean };
    }>(`export default async (_ctx, client) => {
      const tokens = [];
      let cursor = {}, pages = 0;
      while (pages < 10) {
        const r = await client.automations.claimNextWindow({
          automation_id: '${created.automation_id}', run_id: ${claimed.return_value!.run_id}, limit: 500, ...cursor,
        });
        const input = r.context;
        if (input.sources.frame.length !== 1 || input.sources.frame[0].event_count !== ${ROW_COUNT} ||
            input.sources_page.frame.has_more) throw new Error('Frame changed or is incomplete');
        if (input.content.some(row => row.payload_text || row.text_content)) throw new Error('Raw body in thin input');
        tokens.push(input.window_token);
        pages++;
        if (!input.page.has_more) break;
        cursor = { before_occurred_at: input.page.next_cursor.occurred_at, before_id: input.page.next_cursor.id };
      }
      const completion = { automation_id: '${created.automation_id}', run_id: ${claimed.return_value!.run_id},
        window_tokens: tokens, extracted_data: { signals: [{ content: 'Observed ${ROW_COUNT} inputs', idempotency_key: 'wire-frame-count' }] } };
      const done = await client.automations.completeWindow(completion);
      const replay = await client.automations.completeWindow(completion);
      return { pages, linked: done.content_linked, completed_now: done.completed_now, replayed: replay.completed_now === false };
    }`);
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(result.return_value).toEqual({ pages: 3, linked: ROW_COUNT, completed_now: true, replayed: true });
    expect(JSON.stringify([claimed.return_value, result.return_value])).not.toContain('Raw body');
    const [persisted] = await getTestDb()`SELECT a.next_window_start, r.approved_input->>'window_end' AS window_end,
      r.status FROM automations a JOIN runs r ON r.automation_id = a.id WHERE r.id = ${claimed.return_value!.run_id}`;
    expect(persisted.status).toBe('completed');
    expect(new Date(persisted.next_window_start).toISOString()).toBe(new Date(persisted.window_end).toISOString());
  }, 60_000);
});
