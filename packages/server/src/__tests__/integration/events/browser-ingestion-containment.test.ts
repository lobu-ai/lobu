import type { Context } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index';
import { insertEvent } from '../../../utils/insert-event';
import {
  completeActionRun,
  completeAuthRun,
  completeWorkerJob,
  fetchEventsForEmbedding,
  streamContent,
} from '../../../worker-api';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestOrganization,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const WORKER_ID = 'browser-containment-worker';

function mockWorkerCtx(body: unknown): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    req: { json: async () => body },
    var: {},
    json: (value: unknown, status?: number) => {
      captured = { body: value, status: status ?? 200 };
      return captured as unknown as Response;
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { ctx, result: () => captured };
}

describe('browser ingestion containment', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;

  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Browser Containment Org' });
  });

  async function createBrowserRun(
    dryRun: boolean,
    runType: 'sync' | 'auth' | 'action' = 'sync'
  ): Promise<{
    connectionId: number;
    runId: number;
  }> {
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'chrome',
    });
    const rows = (await getTestDb()`
      INSERT INTO runs (
        organization_id, run_type, connection_id, connector_key,
        connector_version, status, claimed_by, dry_run,
        approval_status, action_key, created_at
      ) VALUES (
        ${org.id}, ${runType}, ${connection.id}, 'chrome',
        '1.0.0', 'running', ${WORKER_ID}, ${dryRun},
        ${runType === 'action' ? 'auto' : null},
        ${runType === 'action' ? 'navigate' : null}, NOW()
      )
      RETURNING id
    `) as Array<{ id: number }>;
    return { connectionId: Number(connection.id), runId: Number(rows[0].id) };
  }

  it('sanitizes retries before persistence, FTS generation, and embedding backfill', async () => {
    const chrome = await createTestConnection({
      organization_id: org.id,
      connector_key: 'chrome',
    });
    const raw = 'browser-callback-value-for-test';
    const nonUrlField = 'ordinary prose code=not-a-url';
    const originId = `https://example.test/tab?code=${raw}`;
    const params = {
      entityIds: [],
      organizationId: org.id,
      originId,
      parentOriginId: `https://example.test/parent?state=${raw}`,
      title: `https://example.test/tab?code=${raw}`,
      content: `Opened https://example.test/tab?access_token=${raw}`,
      sourceUrl: `https://example.test/tab?refresh_token=${raw}`,
      payloadData: {
        open_tabs: { href: `https://example.test/tab?id_token=${raw}` },
        tab_events: { from_url: `https://example.test/tab?state=${raw}` },
        watch: { url: `https://example.test/tab?token=${raw}` },
        history: { page_url: `https://example.test/tab?client_secret=${raw}` },
        bookmarks: { target_url: `https://example.test/tab?user_code=${raw}` },
        downloads: { download_url: `https://example.test/tab?code_verifier=${raw}` },
        watch_form: {
          form_action: `https://example.test/form?code=${raw}`,
          referrer: `https://example.test/referrer?state=${raw}`,
          origin_id: `https://example.test/watch?token=${raw}`,
        },
        arbitrary: nonUrlField,
      },
      attachments: [{ download_url: `https://example.test/tab?token=${raw}` }],
      metadata: {
        from_url: `https://example.test/tab?user_code=${raw}`,
        content_preview: `Callback https://example.test/tab?code=${raw}`,
        fields: [
          {
            label: `https://example.test/label?state=${raw}`,
            value: `https://example.test/value?token=${raw}`,
          },
        ],
      },
      interactionInput: { url: `https://example.test/tab?state=${raw}` },
      interactionOutput: { href: `https://example.test/tab?code=${raw}` },
      interactionError: `Failed at https://example.test/tab?token=${raw}`,
      embedding: [0.1, 0.2],
      embeddingModel: 'test-browser-model',
      semanticType: 'browser_tab',
      connectorKey: 'chrome',
      connectionId: Number(chrome.id),
      occurredAt: new Date('2026-04-09T00:00:00Z'),
    };

    const first = await insertEvent(params, { onConflictUpdate: true });
    const retry = await insertEvent(params, { onConflictUpdate: true });
    expect(retry.id).toBe(first.id);
    expect(retry.change).toBe('unchanged');

    const inheritedRaw = 'inherited-browser-lineage-value';
    const successor = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'browser-successor',
      title: `https://example.test/tab?code=${inheritedRaw}`,
      content: `https://example.test/tab?state=${inheritedRaw}`,
      payloadData: { url: `https://example.test/tab?token=${inheritedRaw}` },
      semanticType: 'browser_tab',
      supersedesEventId: Number(first.id),
    });

    const sql = getTestDb();
    const rows = (await sql`
      SELECT origin_id, origin_parent_id, title, payload_text, source_url,
             payload_data, attachments, metadata,
             interaction_input, interaction_output, interaction_error,
             search_tsv::text AS search_text
      FROM events
      WHERE id = ${first.id}
    `) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(raw);
    expect((rows[0].payload_data as Record<string, unknown>).arbitrary).toBe(nonUrlField);
    const successorRows = (await sql`
      SELECT connector_key, title, payload_text, payload_data
      FROM events
      WHERE id = ${successor.id}
    `) as Array<Record<string, unknown>>;
    expect(successorRows[0].connector_key).toBe('chrome');
    expect(JSON.stringify(successorRows[0])).not.toContain(inheritedRaw);

    const embeddings = await sql`
      SELECT 1 FROM event_embeddings WHERE event_id = ${first.id}
    `;
    expect(embeddings).toHaveLength(0);

    const fetched = mockWorkerCtx({ event_ids: [Number(first.id)] });
    await fetchEventsForEmbedding(fetched.ctx);
    expect(fetched.result().status).toBe(200);
    expect(JSON.stringify(fetched.result().body)).not.toContain(raw);
    expect(JSON.stringify(fetched.result().body)).toContain('REDACTED');
  });

  it('leaves unrelated connector records byte-for-byte unchanged', async () => {
    const github = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
    });
    const rawUrl = 'https://example.test/callback?code=unrelated-record-value';
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'unrelated-record',
      title: rawUrl,
      content: rawUrl,
      sourceUrl: rawUrl,
      payloadData: { url: rawUrl },
      metadata: { href: rawUrl },
      semanticType: 'content',
      connectorKey: 'github',
      connectionId: Number(github.id),
    });

    const rows = (await getTestDb()`
      SELECT title, payload_text, source_url, payload_data, metadata
      FROM events
      WHERE organization_id = ${org.id} AND origin_id = 'unrelated-record'
    `) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: rawUrl,
      payload_text: rawUrl,
      source_url: rawUrl,
      payload_data: { url: rawUrl },
      metadata: { href: rawUrl },
    });
  });

  it('supersedes a pre-containment browser row via a NUL-safe raw source origin', async () => {
    const chrome = await createTestConnection({
      organization_id: org.id,
      connector_key: 'chrome',
    });
    const raw = 'legacy-origin-only-callback-value';
    const rawOriginId = `https://example.test/callback?code=${raw}`;
    const containedOriginId = 'https://example.test/callback?code=REDACTED';
    const workerSourceOriginId = rawOriginId.replace('callback', 'call\0back');
    const legacyRows = (await getTestDb()`
      INSERT INTO events (
        organization_id, origin_id, origin_parent_id, title, payload_text, semantic_type,
        connector_key, connection_id
      ) VALUES (
        ${org.id}, ${rawOriginId}, ${`https://example.test/parent?state=${raw}`},
        'Already safe', 'Already safe', 'browser_tab',
        'chrome', ${chrome.id}
      )
      RETURNING id
    `) as Array<{ id: number }>;

    const contained = await insertEvent(
      {
        entityIds: [],
        organizationId: org.id,
        originId: containedOriginId,
        title: 'Already safe',
        content: 'Already safe',
        semanticType: 'browser_tab',
        connectorKey: 'chrome',
        connectionId: Number(chrome.id),
      },
      { onConflictUpdate: true, sourceOriginId: workerSourceOriginId }
    );

    expect(contained.change).toBe('superseded');
    expect(contained.id).not.toBe(Number(legacyRows[0].id));
    const retry = await insertEvent(
      {
        entityIds: [],
        organizationId: org.id,
        originId: containedOriginId,
        title: 'Already safe',
        content: 'Already safe',
        semanticType: 'browser_tab',
        connectorKey: 'chrome',
        connectionId: Number(chrome.id),
      },
      { onConflictUpdate: true, sourceOriginId: workerSourceOriginId }
    );
    expect(retry).toMatchObject({ id: contained.id, change: 'unchanged' });
    const rows = (await getTestDb()`
      SELECT id, origin_id, origin_parent_id, superseded_by
      FROM events
      WHERE id IN (${legacyRows[0].id}, ${contained.id})
      ORDER BY id
    `) as Array<{
      id: number;
      origin_id: string;
      origin_parent_id: string | null;
      superseded_by: number | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].superseded_by).toBe(contained.id);
    expect(rows[1].origin_id).not.toContain(raw);
    expect(rows[1].origin_parent_id).toBe(
      'https://example.test/parent?state=REDACTED'
    );

    const parentOnlyRows = (await getTestDb()`
      INSERT INTO events (
        organization_id, origin_id, origin_parent_id, title, payload_text,
        semantic_type, connector_key, connection_id
      ) VALUES (
        ${org.id}, 'legacy-parent-only',
        ${`https://example.test/parent?state=${raw}`},
        'Already safe', 'Already safe', 'browser_tab', 'chrome', ${chrome.id}
      )
      RETURNING id
    `) as Array<{ id: number }>;
    const parentContained = await insertEvent(
      {
        entityIds: [],
        organizationId: org.id,
        originId: 'legacy-parent-only',
        title: 'Already safe',
        content: 'Already safe',
        semanticType: 'browser_tab',
        connectorKey: 'chrome',
        connectionId: Number(chrome.id),
      },
      { onConflictUpdate: true }
    );
    expect(parentContained).toMatchObject({ change: 'superseded' });
    expect(parentContained.id).not.toBe(Number(parentOnlyRows[0].id));
    const parentContainedRows = (await getTestDb()`
      SELECT origin_parent_id FROM events WHERE id = ${parentContained.id}
    `) as Array<{ origin_parent_id: string | null }>;
    expect(parentContainedRows[0].origin_parent_id).toBe(
      'https://example.test/parent?state=REDACTED'
    );
  });

  it('sanitizes the browser stream before dry-run preview and checkpoint persistence', async () => {
    const { runId } = await createBrowserRun(true);
    const raw = 'dry-run-callback-value';
    const streamed = mockWorkerCtx({
      type: 'batch',
      run_id: runId,
      worker_id: WORKER_ID,
      checkpoint: { url: `https://example.test/cursor?state=${raw}` },
      items: [
        {
          id: `https://example.test/watch?code=${raw}`,
          title: `https://example.test/tab?code=${raw}`,
          payload_text: `Opened https://example.test/tab?access_token=${raw}`,
          source_url: `https://example.test/tab?refresh_token=${raw}`,
          payload_data: {
            href: `https://example.test/tab?id_token=${raw}`,
            form_action: `https://example.test/form?code=${raw}`,
            referrer: `https://example.test/referrer?state=${raw}`,
          },
          occurred_at: new Date().toISOString(),
        },
      ],
    });
    await streamContent(streamed.ctx);
    expect(streamed.result()).toMatchObject({ status: 200, body: { dry_run: true } });

    const runRows = (await getTestDb()`
      SELECT checkpoint, dry_run_preview FROM runs WHERE id = ${runId}
    `) as Array<Record<string, unknown>>;
    expect(runRows[0].checkpoint).toBeNull();
    expect(JSON.stringify(runRows[0].dry_run_preview)).not.toContain(raw);
    const events = await getTestDb()`SELECT 1 FROM events WHERE organization_id = ${org.id}`;
    expect(events).toHaveLength(0);

    const live = await createBrowserRun(false);
    const liveStream = mockWorkerCtx({
      type: 'batch',
      run_id: live.runId,
      worker_id: WORKER_ID,
      checkpoint: { current_url: `https://example.test/cursor?state=${raw}` },
      items: [
        {
          id: `https://example.test/live?code=${raw}`,
          title: `https://example.test/tab?code=${raw}`,
          payload_text: 'Live tab',
          occurred_at: new Date().toISOString(),
        },
      ],
    });
    await streamContent(liveStream.ctx);
    expect(liveStream.result().status).toBe(200);
    const liveRows = (await getTestDb()`
      SELECT checkpoint FROM runs WHERE id = ${live.runId}
    `) as Array<Record<string, unknown>>;
    expect(JSON.stringify(liveRows[0].checkpoint)).not.toContain(raw);
    expect(JSON.stringify(liveRows[0].checkpoint)).toContain('REDACTED');
  });

  it('sanitizes persisted browser failure diagnostics and retry checkpoints', async () => {
    const { runId } = await createBrowserRun(false);
    const raw = 'failed-run-callback-value';
    const completed = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'failed',
      error_message: `Failed at https://example.test/?code=${raw}`,
      output_tail: `Last page https://example.test/?access_token=${raw}`,
      checkpoint: { from_url: `https://example.test/?state=${raw}` },
    });
    await completeWorkerJob(completed.ctx);
    expect(completed.result()).toMatchObject({ status: 200, body: { success: true } });

    const rows = (await getTestDb()`
      SELECT error_message, output_tail, checkpoint FROM runs WHERE id = ${runId}
    `) as Array<Record<string, unknown>>;
    expect(JSON.stringify(rows[0])).not.toContain(raw);
    expect(JSON.stringify(rows[0])).toContain('REDACTED');
  });

  it('sanitizes browser auth diagnostics and action results', async () => {
    const auth = await createBrowserRun(false, 'auth');
    const action = await createBrowserRun(false, 'action');
    const raw = 'terminal-browser-callback-value';

    const completedAuth = mockWorkerCtx({
      run_id: auth.runId,
      worker_id: WORKER_ID,
      status: 'failed',
      error_message: `Auth failed at https://example.test/?code=${raw}`,
      output_tail: `Last redirect https://example.test/?state=${raw}`,
    });
    await completeAuthRun(completedAuth.ctx);
    expect(completedAuth.result()).toMatchObject({ status: 200, body: { success: true } });

    const completedAction = mockWorkerCtx({
      run_id: action.runId,
      worker_id: WORKER_ID,
      status: 'success',
      action_output: {
        final_url: `https://example.test/?access_token=${raw}`,
        value: `https://example.test/?code=${raw}`,
        result: { rows: [{ callback: `https://example.test/?state=${raw}` }] },
        responses: [{ body: `Callback https://example.test/?token=${raw}` }],
        tree: [{ name: `https://example.test/?code=${raw}` }],
        unrelated: 'unrelated action output',
      },
    });
    await completeActionRun(completedAction.ctx);
    expect(completedAction.result()).toMatchObject({ status: 200, body: { success: true } });

    const rows = (await getTestDb()`
      SELECT id, error_message, output_tail, action_output
      FROM runs
      WHERE id IN (${auth.runId}, ${action.runId})
      ORDER BY id
    `) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(raw);
    expect(JSON.stringify(rows)).toContain('REDACTED');
  });

  it.each(['payload_type', 'occurred_at'])('does not echo raw browser values when %s fails validation or storage', async (field) => {
    const { runId } = await createBrowserRun(false);
    const raw = 'stream-failure-callback-value';
    const failed = mockWorkerCtx({
      type: 'batch',
      run_id: runId,
      worker_id: WORKER_ID,
      items: [
        {
          id: `https://example.test/item?access_token=${raw}`,
          title: 'Broken item',
          payload_text: 'body',
          payload_type: 'text',
          occurred_at: new Date().toISOString(),
          [field]: `https://example.test/?code=${raw}`,
        },
      ],
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await streamContent(failed.ctx);
      expect(failed.result().status).toBe(field === 'payload_type' ? 422 : 500);
      expect(JSON.stringify(failed.result().body)).not.toContain(raw);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(raw);
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(raw);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
