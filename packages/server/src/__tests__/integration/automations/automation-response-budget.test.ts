import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization, createTestAccessToken, createTestAgent,
  createTestConnection, createTestEntity, createTestOAuthClient,
  createTestOrganization, createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient, TestMcpClient } from '../../setup/test-mcp-client';
import { GetAutomationResultSchema, type GetAutomationResult } from '../../../tools/get_automation';
import { REACTION_RESULT_BUDGET_BYTES, WINDOW_DATA_BUDGET_BYTES } from '../../../types/automations';
import { validateToolResult } from '../../../tools/validate-args';

const ROW_COUNT = 150;

describe('Automation response byte budget', () => {
  let api: TestApiClient;
  let wire: TestMcpClient;
  let orgId: string;
  let entityId: number;
  let feedId: number;
  let agentId: string;
  let expectedIds: number[];

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Response Budget Org' });
    const user = await createTestUser({ email: 'response-budget@test.example.com' });
    orgId = org.id;
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
      organization_id: org.id, created_by: user.id, name: 'Budget context', entity_type: 'company',
    });
    entityId = Number(entity.id);
    const connection = await createTestConnection({
      organization_id: org.id, connector_key: 'test.connector', slug: 'response-budget-source',
    });
    const sql = getTestDb();
    const [feed] = await sql`SELECT id FROM feeds WHERE connection_id = ${connection.id} AND feed_key = 'default'`;
    feedId = Number(feed.id);
    const inserted = await sql`
      INSERT INTO events (organization_id, entity_ids, connection_id, feed_id, feed_key,
        origin_id, title, payload_type, payload_text, semantic_type, connector_key, occurred_at, created_at)
      SELECT ${org.id}, ARRAY[${entityId}]::bigint[], ${connection.id}, ${feedId}, 'default',
        'response-budget-' || n, 'Large Unicode event ' || n, 'text', repeat('😀', 4100),
        'content', 'test.connector', NOW() - (n + 120) * INTERVAL '1 second', NOW() - INTERVAL '2 minutes'
      FROM generate_series(1, ${ROW_COUNT}) n
      RETURNING id
    `;
    expectedIds = inserted.map(row => Number(row.id)).sort((a, b) => a - b);
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  async function automation(slug: string, contextBytes = 100_000, sourceQuery = `@feed:${feedId}`) {
    return await api.automations.create({
      entity_id: entityId, slug, name: slug, prompt: 'Review all source rows.',
      sources: [
        { name: 'content', query: sourceQuery },
        { name: 'context_rows', query: `SELECT id, name, repeat('c', ${contextBytes}) AS note FROM entities WHERE id = ${entityId}`, context: true },
      ],
      outputs: { signals: { event: 'observation' } },
    }) as { automation_id: string };
  }

  it.each(['ref', 'sql'] as const)('reads every %s page through the real bridge and links the submitted token chain', async (kind) => {
    const created = await automation(`response-budget-wire-${kind}`, 100_000,
      kind === 'ref' ? `@feed:${feedId}` : `SELECT * FROM events WHERE feed_id = ${feedId} ORDER BY occurred_at DESC`);
    const result = await wire.runSdk<{
      success: boolean;
      error?: unknown;
      return_value?: { ids: number[]; pages: number; firstCount: number; completed: { run_id: number; content_linked: number } };
    }>(`export default async (_ctx, client) => {
      const tokens = [], ids = [];
      let runId, cursor = {}, pages = 0, firstCount;
      while (pages < 100) {
        const claim = await client.automations.claimNextWindow({
          automation_id: '${created.automation_id}', limit: 500, lease_seconds: 900,
          ...(runId ? { run_id: runId } : {}), ...cursor,
        });
        runId = claim.run_id;
        const r = claim.context;
        if (r.sources.context_rows.length !== 1 || r.sources.context_rows[0].note.length !== 100000 ||
            r.sources_page.context_rows.has_more) throw new Error('context coverage changed');
        if (r.sources.content.length !== r.content.length) throw new Error('source/content mismatch');
        if (r.sources_page.content.returned !== r.content.length) throw new Error('wrong retained count');
        tokens.push(r.window_token);
        ids.push(...r.content.map(row => Number(row.id)));
        pages++;
        if (pages === 1) firstCount = r.content.length;
        if (!r.page.has_more) break;
        if (!r.page.next_cursor || !r.content.length) throw new Error('page cannot advance');
        const last = r.sources.content[r.sources.content.length - 1];
        if (Number(last.id) !== r.page.next_cursor.id) throw new Error('cursor skipped a retained row');
        cursor = { before_occurred_at: r.page.next_cursor.occurred_at, before_id: r.page.next_cursor.id };
      }
      const completed = await client.automations.completeWindow({
        automation_id: '${created.automation_id}', run_id: runId, window_tokens: tokens, extracted_data: { signals: [] },
      });
      return { ids, pages, firstCount, completed };
    }`);
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    const value = result.return_value!;
    expect(value.pages).toBeGreaterThan(1);
    expect(value.firstCount).toBeGreaterThan(0);
    expect(value.firstCount).toBeLessThan(ROW_COUNT);
    expect(value.ids.sort((a, b) => a - b)).toEqual(expectedIds);
    expect(new Set(value.ids).size).toBe(ROW_COUNT);
    expect(value.completed.content_linked).toBe(ROW_COUNT);
    const [persisted] = await getTestDb()`
      SELECT a.next_window_start, r.status, r.approved_input->>'window_end' AS window_end
      FROM automations a JOIN runs r ON r.id = ${value.completed.run_id}
      WHERE a.id = ${Number(created.automation_id)} AND a.organization_id = ${orgId}
    `;
    expect(persisted.status).toBe('completed');
    expect(new Date(persisted.next_window_start).toISOString()).toBe(new Date(persisted.window_end).toISOString());
  }, 60_000);

  it('bounds the complete UTF-8 envelope and advances from its last retained row', async () => {
    const created = await automation('response-budget-envelope');
    const result = await api.knowledge.read({
      automation_id: Number(created.automation_id), since: 'today', until: 'today', limit: 500,
    }) as {
      content: Array<{ id: number; payload_text: string; payload_truncated: boolean }>;
      sources: Record<string, Array<{ id: number; note?: string }>>;
      page: { has_more: boolean; next_cursor: { id: number } };
    };
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1_048_576);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content.length).toBeLessThan(ROW_COUNT);
    expect(result.sources.context_rows[0].note).toHaveLength(100_000);
    expect(result.content[0].payload_text).toBe('😀'.repeat(4000) + '… [truncated]');
    expect(result.content[0].payload_truncated).toBe(true);
    expect(result.page.has_more).toBe(true);
    expect(result.page.next_cursor.id).toBe(Number(result.sources.content.at(-1)?.id));
  });

  it.each([true, false])('budgets duplicate events using source precedence (primary first: %s)', async (primaryFirst) => {
    const primary = { name: 'content', query: `@feed:${feedId}` };
    const duplicate = {
      name: 'duplicate',
      query: `SELECT * FROM events WHERE id = ${expectedIds[0]}`,
    };
    const created = await api.automations.create({
      entity_id: entityId,
      slug: `response-budget-duplicate-${primaryFirst}`,
      name: 'Duplicate source response budget',
      prompt: 'Review all source rows.',
      managed_agent_id: agentId,
      sources: [
        ...(primaryFirst ? [primary, duplicate] : [duplicate, primary]),
        { name: 'context_rows', query: `SELECT id, repeat('c', 960000) AS note FROM entities WHERE id = ${entityId}`, context: true },
      ],
      outputs: { signals: { event: 'observation' } },
    }) as { automation_id: string };
    const result = await api.knowledge.read({
      automation_id: Number(created.automation_id), since: 'today', until: 'today', limit: 500,
    }) as {
      content: Array<{ id: number }>;
      sources: Record<string, Array<{ id: number; note?: string }>>;
      page: { has_more: boolean; next_cursor: { id: number } };
    };
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1_048_576);
    expect(result.sources.content).toHaveLength(1);
    expect(result.content).toHaveLength(1);
    expect(Number(result.content[0].id)).toBe(expectedIds[0]);
    expect(result.sources.duplicate).toHaveLength(1);
    expect(result.sources.context_rows[0].note).toHaveLength(960_000);
    expect(result.page.has_more).toBe(true);
    expect(result.page.next_cursor.id).toBe(expectedIds[0]);
  });

  it.each([5_000_000, 1_040_000])('fails explicitly when required context leaves no room for a content row (%i bytes)', async (contextBytes) => {
    const created = await automation(`response-budget-context-${contextBytes}`, contextBytes);
    const result = await wire.querySdk<{ success: boolean; error?: { message: string } }>(
      `export default async (_ctx, client) => {
        const r = await client.knowledge.read({ automation_id: ${created.automation_id}, since: 'today', until: 'today', limit: 500 });
        return { count: r.content.length };
      }`
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Automation knowledge response cannot fit its byte budget/);
    expect(result.error?.message).not.toMatch(/OutputSizeExceeded/);
    const completed = await getTestDb()`SELECT id FROM runs
      WHERE automation_id = ${Number(created.automation_id)} AND status = 'completed'`;
    expect(completed).toEqual([]);
  });

  it('bounds get_automation window outputs by bytes and keeps omitted outputs on getRun', async () => {
    const created = await automation('response-budget-windows');
    const automationId = Number(created.automation_id);
    // Four-byte characters, so a character-counting budget would let twice as
    // much through. Newest first: two large outputs fill the budget, the third
    // does not fit, a later small one still does, and the rest are large again.
    const largeChars = Math.floor((WINDOW_DATA_BUDGET_BYTES * 0.4) / 4);
    const kinds = ['large', 'large', 'large', 'small', ...Array<string>(8).fill('large')];
    const sql = getTestDb();
    const runIds: number[] = [];
    for (const [index, kind] of kinds.entries()) {
      const [run] = await sql`
        INSERT INTO runs (organization_id, run_type, automation_id, approval_status, status,
          approved_input, action_output, completed_at)
        VALUES (${orgId}, 'automation', ${automationId}, 'auto', 'completed',
          jsonb_build_object(
            'window_start', NOW() - make_interval(days => ${index + 1}::int),
            'window_end', NOW() - make_interval(days => ${index}::int)),
          jsonb_build_object('summary', CASE WHEN ${kind}::text = 'large'
            THEN repeat('😀', ${largeChars}::int) ELSE 'small' END),
          NOW())
        RETURNING id
      `;
      runIds.push(Number(run.id));
    }
    const largeSummary = '😀'.repeat(largeChars);
    // Reaction script results are capped per row on write; a page of them
    // shares its own budget too, newest first.
    const resultChars = 15_000;
    for (const runId of runIds) {
      await sql`
        INSERT INTO automation_reactions (organization_id, automation_id, source_run_id,
          reaction_type, tool_name, tool_args, tool_result, created_at)
        SELECT ${orgId}, ${automationId}, ${runId}, 'script_execution', 'reaction_executor',
          jsonb_build_object('attempt', n),
          jsonb_build_object('success', true, 'result', jsonb_build_object('note', repeat('r', ${resultChars}::int))),
          NOW() - make_interval(secs => (${runId}::int * 10 + n)::double precision)
        FROM generate_series(1, 7) n
      `;
    }

    // An external client walking its Automations through the SDK bridge must
    // not trip the 4 MiB bridge cap, and an omitted output stays readable.
    const bridged = await wire.querySdk<{
      success: boolean;
      error?: unknown;
      return_value?: { listed: number; omittedRunId: number; fullSummary: string };
    }>(`export default async (_ctx, client) => {
      const detail = await client.automations.get({ automation_id: '${automationId}' });
      const omitted = detail.windows.find((w) => w.extracted_data_omitted);
      const { run } = await client.operations.getRun(omitted.run_id);
      return { listed: detail.windows.length, omittedRunId: omitted.run_id, fullSummary: run.output.summary };
    }`);
    expect(bridged.success, JSON.stringify(bridged.error)).toBe(true);
    expect(bridged.return_value?.listed).toBe(kinds.length);
    expect(bridged.return_value?.omittedRunId).toBe(runIds[2]);
    expect(bridged.return_value?.fullSummary).toBe(largeSummary);

    const detail = (await api.automations.get({
      automation_id: String(automationId),
    })) as GetAutomationResult;
    expect(validateToolResult(GetAutomationResultSchema, detail)).not.toBeNull();
    expect(detail.pagination.total).toBe(kinds.length);
    expect(detail.windows.map((w) => w.run_id)).toEqual(runIds);
    for (const window of detail.windows) {
      expect(window).not.toHaveProperty('previous_extracted_data');
    }
    const reactions = detail.windows
      .flatMap((w) => w.reactions ?? [])
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    expect(reactions).toHaveLength(runIds.length * 7);
    const resultBytes = Buffer.byteLength(JSON.stringify({ note: 'r'.repeat(resultChars) }), 'utf8');
    const keptResults = reactions.filter((r) => r.tool_result?.result !== undefined);
    expect(keptResults).toHaveLength(Math.floor(REACTION_RESULT_BUDGET_BYTES / resultBytes));
    expect(reactions.slice(0, keptResults.length)).toEqual(keptResults);
    for (const reaction of reactions.slice(keptResults.length)) {
      expect(reaction.tool_result).toEqual({ success: true, result_omitted: { bytes: resultBytes } });
    }
    const kept = detail.windows.filter((w) => w.extracted_data !== null);
    expect(kept.map((w) => w.run_id)).toEqual([runIds[0], runIds[1], runIds[3]]);
    expect(kept.map((w) => w.extracted_data)).toEqual([
      { summary: largeSummary },
      { summary: largeSummary },
      { summary: 'small' },
    ]);
    expect(kept.every((w) => w.extracted_data_omitted === undefined)).toBe(true);
    const keptBytes = kept.reduce(
      (total, w) => total + Buffer.byteLength(JSON.stringify(w.extracted_data), 'utf8'),
      0
    );
    expect(keptBytes).toBeLessThanOrEqual(WINDOW_DATA_BUDGET_BYTES);
    const largeBytes = Buffer.byteLength(JSON.stringify({ summary: largeSummary }), 'utf8');
    const omitted = detail.windows.filter((w) => w.extracted_data === null);
    expect(omitted).toHaveLength(kinds.length - kept.length);
    for (const window of omitted) {
      expect(window.extracted_data_omitted?.bytes).toBeGreaterThanOrEqual(largeBytes);
      expect(window.extracted_data_omitted?.bytes).toBeGreaterThan(
        WINDOW_DATA_BUDGET_BYTES - keptBytes
      );
    }

    // Omission never shrinks a page: walking pages through the bridge with an
    // explicit page_size visits every window once, in order, with an exact total.
    const paged = await wire.querySdk<{
      success: boolean;
      error?: unknown;
      return_value?: { runIds: number[]; totals: number[]; pageLengths: number[]; omittedPerPage: number[] };
    }>(`export default async (_ctx, client) => {
      const runIds = [], totals = [], pageLengths = [], omittedPerPage = [];
      for (let page = 1; page <= 3; page++) {
        const r = await client.automations.get({ automation_id: '${automationId}', page, page_size: 5 });
        runIds.push(...r.windows.map((w) => w.run_id));
        totals.push(r.pagination.total);
        pageLengths.push(r.windows.length);
        omittedPerPage.push(r.windows.filter((w) => w.extracted_data_omitted).length);
      }
      return { runIds, totals, pageLengths, omittedPerPage };
    }`);
    expect(paged.success, JSON.stringify(paged.error)).toBe(true);
    expect(paged.return_value?.runIds).toEqual(runIds);
    expect(paged.return_value?.totals).toEqual([kinds.length, kinds.length, kinds.length]);
    expect(paged.return_value?.pageLengths).toEqual([5, 5, 2]);
    expect(paged.return_value?.omittedPerPage[0]).toBeGreaterThan(0);
    expect(paged.return_value?.omittedPerPage[1]).toBeGreaterThan(0);
  }, 60_000);
});
