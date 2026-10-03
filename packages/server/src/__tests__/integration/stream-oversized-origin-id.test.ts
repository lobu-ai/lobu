/**
 * A connector-supplied origin_id is a btree key: events indexes it in
 * (connection_id, origin_id, created_at), (organization_id, origin_id) and the
 * webhook dedupe index. A key past the btree row-size limit made Postgres throw
 * "index row size N exceeds btree version 4 maximum 2704" mid-page, and
 * /api/workers/stream answered 500 — an untyped, retry-looking failure for an
 * input that can never land. The stream route must instead reject the batch
 * with the typed 422 batch_rejected contract before event writes or checkpoint
 * advancement, while preserving the diagnosis on the run.
 *
 * The oversized id is random base64, not a repeated character: Postgres
 * compresses index keys, so a compressible long id fits under the limit and
 * would not reproduce the failure.
 */

import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { streamContent } from '../../worker-api';
import { MAX_ORIGIN_ID_BYTES } from '../../worker-api/run-lifecycle';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const WORKER_ID = 'worker-origin-id';
const FEED_CHECKPOINT = { cursor: 'original-cursor' };

function mockWorkerCtx(body: unknown): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    req: { json: async () => body },
    var: {},
    json: (b: unknown, status?: number) => {
      captured = { body: b, status: status ?? 200 };
      return captured as unknown as Response;
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { ctx, result: () => captured };
}

async function seed(connectorKey: string) {
  const sql = getTestDb();
  const org = await createTestOrganization();
  const [conn] = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, status, visibility, slug, created_at, updated_at)
    VALUES (${org.id}, ${connectorKey}, 'active', 'org', 'origin-id-conn', NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  const [feed] = (await sql`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, status, schedule, checkpoint,
       created_at, updated_at)
    VALUES (${org.id}, ${conn.id}, 'items', 'active', '0 */6 * * *',
       ${sql.json(FEED_CHECKPOINT)}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  const [run] = (await sql`
    INSERT INTO runs
      (organization_id, run_type, feed_id, connection_id, connector_key,
       connector_version, status, claimed_by, created_at)
    VALUES (${org.id}, 'sync', ${feed.id}, ${conn.id}, ${connectorKey}, '1.0.0',
       'running', ${WORKER_ID}, NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return { orgId: org.id, feedId: feed.id, runId: run.id };
}

function item(id: string) {
  return {
    id,
    title: 'Typed in field',
    payload_text: 'observation',
    payload_type: 'text',
    occurred_at: new Date().toISOString(),
  };
}

// Mirrors the Chrome watch feed's `watch-input-${url}-${ts}-${field}` shape
// with an incompressible long URL.
function oversizedOriginId(): string {
  return `watch-input-https://example.test/?q=${randomBytes(3000).toString('base64')}-2026-09-20T21:38:51.081Z-search`;
}

describe('stream ingest bounds connector origin_id', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it.each([
    { connectorKey: 'rss', label: 'long URL', makeId: oversizedOriginId },
    { connectorKey: 'chrome', label: 'long URL', makeId: oversizedOriginId },
    {
      connectorKey: 'rss',
      label: 'ASCII one byte over',
      makeId: () => 'x'.repeat(MAX_ORIGIN_ID_BYTES + 1),
    },
    {
      connectorKey: 'rss',
      label: 'UTF-8 one byte over',
      makeId: () => `${'é'.repeat(MAX_ORIGIN_ID_BYTES / 2)}x`,
    },
  ])(
    'rejects an oversized origin_id without ingesting or advancing ($connectorKey, $label)',
    async ({ connectorKey, makeId }) => {
      const sql = getTestDb();
      const { orgId, feedId, runId } = await seed(connectorKey);
      const longId = makeId();

      const { ctx, result } = mockWorkerCtx({
        run_id: runId,
        worker_id: WORKER_ID,
        checkpoint: { cursor: 'advanced-cursor' },
        items: [item('ok-item'), item(longId)],
      });
      await streamContent(ctx);

      const res = result();
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        error: 'batch_rejected',
        error_description: expect.stringContaining('Fix the reported item validation errors'),
        rejected_items: [
          {
            id: longId,
            errors: [expect.stringContaining(`exceeds ${MAX_ORIGIN_ID_BYTES} bytes`)],
          },
        ],
      });
      expect(
        (await sql`SELECT count(*)::int AS count FROM events WHERE organization_id = ${orgId}`)[0]
          .count
      ).toBe(0);
      expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${feedId}`)[0].checkpoint).toEqual(
        FEED_CHECKPOINT
      );
      const [runRow] = await sql`SELECT checkpoint, error_message FROM runs WHERE id = ${runId}`;
      expect(runRow.checkpoint).toBeNull();
      expect(runRow.error_message).toMatch(/^422 batch_rejected: .*exceeds \d+ bytes/);
    }
  );

  it.each(['ASCII', 'UTF-8'])('accepts a %s origin_id at exactly the byte bound', async (encoding) => {
    const sql = getTestDb();
    const { orgId, runId } = await seed('rss');
    const atBound =
      encoding === 'UTF-8'
        ? 'é'.repeat(MAX_ORIGIN_ID_BYTES / 2)
        : randomBytes(MAX_ORIGIN_ID_BYTES).toString('base64').slice(0, MAX_ORIGIN_ID_BYTES);
    expect(Buffer.byteLength(atBound, 'utf8')).toBe(MAX_ORIGIN_ID_BYTES);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      items: [item(atBound)],
    });
    await streamContent(ctx);

    expect(result().status).toBe(200);
    const rows = await sql`
      SELECT origin_id FROM events WHERE organization_id = ${orgId}
    `;
    expect(rows.map((r) => r.origin_id)).toEqual([atBound]);
  });
});
