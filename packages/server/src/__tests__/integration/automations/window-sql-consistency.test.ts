import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import { runScript } from '../../../sandbox/run-script';
import { generateWindowToken, verifyWindowToken } from '../../../utils/jwt';
import { buildClientSDK } from '../../../sandbox/client-sdk';
import { querySql } from '../../../tools/admin/query_sql';
import { createAutomationRun } from '../../../runs/queue-service';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEvent, createTestConnection, createTestUser, seedOwnerContext } from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

const ENV = { JWT_SECRET: 'test-jwt-secret-for-testing-only' } as Env;
const START = '2026-08-01T10:00:00.000Z';
const END = '2026-08-01T11:00:00.000Z';
const SELECT = "SELECT id, payload_text FROM events WHERE semantic_type = 'window_fixture' ORDER BY id";

describe('Automation window SQL event-version consistency', () => {
  let sql: DbClient;
  let ctx: Awaited<ReturnType<typeof seedOwnerContext>>['ctx'];
  let api: TestApiClient;
  let automationId: number;
  let runId: number;

  beforeAll(async () => { await initWorkspaceProvider(); });
  beforeEach(async () => {
    await cleanupTestDatabase();
    ({ ctx } = await seedOwnerContext());
    sql = getTestDb() as unknown as DbClient;
    const agent = await createTestAgent({ organizationId: ctx.organizationId, ownerUserId: ctx.userId!, agentId: 'window-sql-agent' });
    api = await TestApiClient.for({ organizationId: ctx.organizationId, userId: ctx.userId, memberRole: 'owner' });
    const created = await api.automations.create({
      slug: 'window-sql-fixture', name: 'Window SQL fixture', managed_agent_id: agent.agentId,
      prompt: 'Analyze this window.', outputs: { signals: { event: 'observation' } },
      sources: [{ name: 'arrival_frame', context: true, query: "SELECT COUNT(*)::int AS n FROM events WHERE semantic_type = 'window_fixture'" }],
    }) as { automation_id: string };
    automationId = Number(created.automation_id);
    const run = await createAutomationRun({ organizationId: ctx.organizationId, automationId,
      agentId: agent.agentId, windowStart: START, windowEnd: END, dispatchSource: 'scheduled' });
    runId = run.runId;
    await sql`UPDATE runs SET status = 'running' WHERE id = ${runId}`;
    await sql`UPDATE automations SET next_window_start = ${START}::timestamptz WHERE id = ${automationId}`;
  });

  async function event(text: string, at: string, previous?: number) {
    const row = await createTestEvent({ organization_id: ctx.organizationId, content: text,
      semantic_type: 'window_fixture', created_at: new Date(at), occurred_at: new Date(at) });
    if (previous) {
      await sql`UPDATE events SET supersedes_event_id = ${previous} WHERE id = ${row.id}`;
      await sql`UPDATE events SET superseded_by = ${row.id} WHERE id = ${previous}`;
    }
    return row.id;
  }

  async function read() {
    return api.knowledge.read({ automation_id: automationId, run_id: runId, limit: 25 }) as Promise<{
      window_token: string; sources: { arrival_frame: Array<{ n: number }> };
    }>;
  }

  it('keeps the summary and SQL details consistent through repeated refreshes, then completes', async () => {
    const original = await event('original evidence', '2026-08-01T10:30:00.000Z');
    const first = await read();
    expect(first.sources.arrival_frame).toEqual([{ n: 1 }]);
    const replacement = await event('new evidence', END, original);
    await event('newest evidence', '2026-08-01T12:00:00.000Z', replacement);
    const repeated = await read();
    expect(repeated.sources.arrival_frame).toEqual(first.sources.arrival_frame);
    const detail = await querySql({ sql: SELECT, window_token: first.window_token }, ENV, ctx);
    expect(detail.error).toBeUndefined();
    expect(detail.rows).toEqual([{ id: original, payload_text: 'original evidence' }]);
    const sdk = buildClientSDK(ctx, ENV, { mode: 'read' });
    expect(await sdk.query(SELECT, { window_token: first.window_token })).toEqual(detail.rows);
    const sandbox = await runScript({
      sdk, sdkMode: 'read', source: `export default async (_ctx, client) => client.query(${JSON.stringify(SELECT)}, {window_token:${JSON.stringify(first.window_token)}});`,
    });
    expect(sandbox.success, sandbox.error?.message).toBe(true);
    expect(sandbox.returnValue).toEqual(detail.rows);
    expect((await querySql({ sql: SELECT }, ENV, ctx)).rows).toEqual([
      expect.objectContaining({ payload_text: 'newest evidence' }),
    ]);
    await api.automations.completeWindow({ run_id: runId, window_tokens: [first.window_token], extracted_data: { signals: [] } });
    const [mark] = await sql`SELECT next_window_start FROM automations WHERE id = ${automationId}`;
    expect(new Date(mark.next_window_start as string).toISOString()).toBe(END);
  });
  it('selects the last in-window version and leaves boundary successors for the next window', async () => {
    const old = await event('first version', '2026-08-01T10:15:00.000Z');
    const inside = await event('last in-window version', '2026-08-01T10:59:59.999Z', old);
    const boundary = await event('next window version', END, inside);
    const first = await read();
    expect(first.sources.arrival_frame).toEqual([{ n: 1 }]);
    expect((await querySql({ sql: SELECT, window_token: first.window_token }, ENV, ctx)).rows)
      .toEqual([{ id: inside, payload_text: 'last in-window version' }]);
    await api.automations.completeWindow({ run_id: runId, window_tokens: [first.window_token], extracted_data: { signals: [] } });
    const [run] = await sql`SELECT approved_input FROM runs WHERE id = ${runId}`;
    const next = await createAutomationRun({ organizationId: ctx.organizationId, automationId,
      agentId: (run.approved_input as {agent_id: string}).agent_id, windowStart: END,
      windowEnd: '2026-08-01T12:00:00.000Z', dispatchSource: 'scheduled' });
    runId = next.runId;
    const second = await read();
    expect((await querySql({ sql: SELECT, window_token: second.window_token }, ENV, ctx)).rows)
      .toEqual([{ id: boundary, payload_text: 'next window version' }]);
  });

  it.each(['2026-08-01T10:59:59.999Z', END])('applies tombstones at %s using the same boundary', async (at) => {
    const original = await event('deleted evidence', '2026-08-01T10:10:00.000Z');
    const tombstone = await event('', at, original);
    await sql`UPDATE events SET semantic_type = 'tombstone', metadata = '{"tombstone":true}'::jsonb WHERE id = ${tombstone}`;
    const page = await read();
    const expected = at === END ? [{ id: original, payload_text: 'deleted evidence' }] : [];
    expect((await querySql({ sql: SELECT, window_token: page.window_token }, ENV, ctx)).rows).toEqual(expected);
    expect((await querySql({ sql: SELECT }, ENV, ctx)).rows).toEqual([]);
  });

  it('keeps classifications joined to the same event versions after a refresh', async () => {
    const original = await event('classified evidence', '2026-08-01T10:10:00.000Z');
    const [facet] = await sql<{id: number}>`
      INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status, created_by,
        entity_ids, attribute_values, min_similarity)
      VALUES (${ctx.organizationId}, 'window-topic', 'Window topic', 'topic', 'active', ${ctx.userId},
        ARRAY[]::bigint[], '{"positive":{"description":"p","examples":["great"]}}'::jsonb, 0.7) RETURNING id`;
    await sql`INSERT INTO event_classifications (event_id, classifier_id, "values", confidences, source, is_manual, reasoning)
      VALUES (${original}, ${facet.id}, '{positive}'::text[], '{"positive":1}'::jsonb, 'user', true, 'evidence')`;
    const page = await read();
    await event('replacement', END, original);
    const q = 'SELECT e.id, ec.reasoning FROM events e JOIN event_classifications ec ON ec.event_id = e.id';
    expect((await querySql({ sql: q, window_token: page.window_token }, ENV, ctx)).rows)
      .toEqual([{ id: original, reasoning: 'evidence' }]);
    expect((await querySql({ sql: q }, ENV, ctx)).rows).toEqual([]);
  });

  it('enforces current connection permissions after claiming a historical version', async () => {
    const other = await createTestUser({ email: 'window-other@example.com' });
    const conn = await createTestConnection({ organization_id: ctx.organizationId,
      connector_key: 'fixture.snapshot', visibility: 'org', created_by: other.id });
    const original = await createTestEvent({ organization_id: ctx.organizationId, connection_id: conn.id,
      content: 'private after claim', semantic_type: 'window_fixture', created_at: new Date(START) });
    const page = await read();
    expect(page.sources.arrival_frame).toEqual([{ n: 1 }]);
    await event('replacement', END, original.id);
    await sql`UPDATE connections SET visibility = 'private' WHERE id = ${conn.id}`;
    expect((await querySql({ sql: SELECT, window_token: page.window_token }, ENV, ctx)).rows).toEqual([]);
    expect(await buildClientSDK(ctx, ENV).query(SELECT, { window_token: page.window_token })).toEqual([]);
    expect((await read()).sources.arrival_frame).toEqual([{ n: 0 }]);
  });

  it('rejects foreign, altered, preview, mismatched-window and inactive-run tokens', async () => {
    const page = await read();
    const payload = await verifyWindowToken(page.window_token, ENV);
    const other = await seedOwnerContext();
    await expect(querySql({ sql: SELECT, window_token: page.window_token }, ENV, other.ctx)).rejects.toThrow(/Access denied/);
    const parts = page.window_token.split('.');
    parts[1] = Buffer.from(JSON.stringify({...payload, window_end: '2026-08-01T12:00:00.000Z'})).toString('base64url');
    await expect(querySql({ sql: SELECT, window_token: parts.join('.') }, ENV, ctx)).rejects.toThrow(/signature/);
    const preview = await generateWindowToken({...payload, run_id: undefined}, ENV);
    await expect(querySql({ sql: SELECT, window_token: preview }, ENV, ctx)).rejects.toThrow(/run-bound/);
    const wrongWindow = await generateWindowToken({...payload, window_end: '2026-08-01T12:00:00.000Z'}, ENV);
    await expect(querySql({ sql: SELECT, window_token: wrongWindow }, ENV, ctx)).rejects.toThrow(/queued Automation window/);
    const wrongRun = await generateWindowToken({...payload, run_id: runId + 100_000}, ENV);
    await expect(querySql({ sql: SELECT, window_token: wrongRun }, ENV, ctx)).rejects.toThrow(/does not belong/);
    await expect(querySql({ sql: SELECT, window_token: page.window_token }, ENV, {...ctx, executionMode: 'capture'})).rejects.toThrow(/execution mode/);
    await expect(querySql({ sql: SELECT, window_token: page.window_token, connection: 'fixture' }, ENV, ctx)).rejects.toThrow(/external/);
    await sql`UPDATE runs SET status = 'failed' WHERE id = ${runId}`;
    await expect(querySql({ sql: SELECT, window_token: page.window_token }, ENV, ctx)).rejects.toThrow(/inactive/);
  });

  it('rejects expired or renewed leases and accepts the latest lease token', async () => {
    const page = await read();
    const payload = await verifyWindowToken(page.window_token, ENV);
    const lease = new Date(Date.now() + 60_000).toISOString();
    await sql`UPDATE runs SET expires_at = ${lease}::timestamptz WHERE id = ${runId}`;
    await expect(querySql({ sql: SELECT, window_token: page.window_token }, ENV, ctx)).rejects.toThrow(/lease/);
    const fresh = await generateWindowToken({...payload, lease_expires_at: lease}, ENV);
    expect((await querySql({ sql: SELECT, window_token: fresh }, ENV, ctx)).error).toBeUndefined();
    const expired = new Date(Date.now() - 1_000).toISOString();
    await sql`UPDATE runs SET expires_at = ${expired}::timestamptz WHERE id = ${runId}`;
    const stale = await generateWindowToken({...payload, lease_expires_at: expired}, ENV);
    await expect(querySql({ sql: SELECT, window_token: stale }, ENV, ctx)).rejects.toThrow(/lease/);
  });

  it('pages event versions through a refresh, renews the lease and completes with every token', async () => {
    await sql`UPDATE runs SET status = 'failed' WHERE id = ${runId}`;
    const sources = [{ name: 'content', query: "SELECT id, occurred_at, payload_text FROM events WHERE semantic_type = 'window_fixture' ORDER BY occurred_at DESC, id DESC" }];
    await api.automations.createVersion({ automation_id: String(automationId), prompt: 'Analyze each page.', sources });
    const older = await event('older', '2026-08-01T10:10:00.000Z');
    const newer = await event('newer', '2026-08-01T10:20:00.000Z');
    type Claim = { run_id: number; context: { window_token: string; window_end: string;
      content: Array<{id: number}>; page: {has_more: boolean; next_cursor?: {occurred_at: string; id: number}} } };
    const first = await api.automations.claimNextWindow({ automation_id: String(automationId), limit: 1 }) as Claim;
    expect(first.context.content.map(e => e.id)).toEqual([newer]);
    expect(first.context.page.has_more).toBe(true);
    await event('older refreshed', first.context.window_end, older);
    const cursor = first.context.page.next_cursor!;
    const second = await api.automations.claimNextWindow({ automation_id: String(automationId), run_id: first.run_id,
      limit: 1, before_occurred_at: cursor.occurred_at, before_id: cursor.id }) as Claim;
    expect(second.context.content.map(e => e.id)).toEqual([older]);
    expect(second.context.page.has_more).toBe(false);
    await expect(querySql({ sql: SELECT, window_token: first.context.window_token }, ENV, ctx)).rejects.toThrow(/lease/);
    expect((await querySql({ sql: SELECT, window_token: second.context.window_token }, ENV, ctx)).rows.map(r => r.id)).toEqual([older, newer]);
    await api.automations.completeWindow({ run_id: first.run_id,
      window_tokens: [first.context.window_token, second.context.window_token], extracted_data: { signals: [] } });
    const [mark] = await sql`SELECT next_window_start FROM automations WHERE id = ${automationId}`;
    expect(new Date(mark.next_window_start as string).toISOString()).toBe(first.context.window_end);
  });

  it('rejects expired JWTs and malformed SDK options instead of silently reading current rows', async () => {
    const page = await read();
    const sdk = buildClientSDK(ctx, ENV);
    await expect(sdk.query(SELECT, { window_token: '' })).rejects.toThrow(/window_token/);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_602_000);
    try {
      await expect(querySql({ sql: SELECT, window_token: page.window_token }, ENV, ctx)).rejects.toThrow(/expired/);
    } finally { clock.mockRestore(); }
  });

});
