/**
 * Integration test for the embed-backfill scanner's rewritten queries.
 *
 * The scanner was changed from a `current_event_records` view + LEFT JOIN form
 * to a base-`events` correlated-NOT EXISTS form, ordered newest-first, so the
 * partial index idx_events_missing_embedding_backfill drives it (prod: ~1.4s →
 * ~4ms). This locks in the SEMANTICS that rewrite must preserve:
 *   - events with a current-model embedding are NOT enqueued
 *   - events with no embedding ARE enqueued
 *   - superseded events are NOT enqueued (the view's mask)
 *   - empty-payload events are NOT enqueued
 *   - the batch is collected newest-first (created_at DESC)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { triggerEmbedBackfill } from '../../../scheduled/trigger-embed-backfill';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestOrganization,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const MODEL = 'Xenova/bge-base-en-v1.5';
const DIM = 768;

function vec(): number[] {
  const v = new Array(DIM).fill(0);
  v[0] = 1;
  return v;
}

describe('triggerEmbedBackfill query rewrite', () => {
  let orgId: string;
  let entityId: number;
  let connectionId: number;
  let originalModel: string | undefined;

  // ids of the events we expect (or not) to be enqueued
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    originalModel = process.env.EMBEDDINGS_MODEL;
    process.env.EMBEDDINGS_MODEL = MODEL;

    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Backfill Scan Org' });
    orgId = org.id;
    const entity = await createTestEntity({ name: 'Backfill Target', organization_id: org.id });
    entityId = entity.id;
    await createTestConnectorDefinition({
      key: 'backfill-connector',
      name: 'Backfill',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'backfill-connector',
      entity_ids: [entity.id],
    });
    connectionId = connection.id;

    const base = {
      entityIds: [entityId],
      organizationId: orgId,
      semanticType: 'content' as const,
      originType: 'content' as const,
      connectorKey: 'backfill-connector',
      connectionId,
    };

    // Inserted oldest → newest so created_at orders by insertion.
    // (1) Already embedded under the current model → must be EXCLUDED.
    ids.embedded = (
      await insertEvent({
        ...base,
        originId: 'embedded',
        title: 'embedded',
        content: 'already embedded content',
        occurredAt: new Date(),
        embedding: vec(),
        embeddingModel: MODEL,
      })
    ).id;

    // (2) Empty payload → must be EXCLUDED.
    ids.empty = (
      await insertEvent({
        ...base,
        originId: 'empty',
        title: 'empty',
        content: '',
        occurredAt: new Date(),
      })
    ).id;

    // (3) Unembedded, older → must be INCLUDED (second in DESC order).
    ids.unembeddedOld = (
      await insertEvent({
        ...base,
        originId: 'unembedded-old',
        title: 'unembedded old',
        content: 'older content needing an embedding',
        occurredAt: new Date(),
      })
    ).id;

    // (4) Original row that will be superseded, unembedded → must be EXCLUDED
    //     (masked by current_event_records).
    ids.superseded = (
      await insertEvent({
        ...base,
        originId: 'superseded-original',
        title: 'superseded original',
        content: 'this version is superseded and should not be backfilled',
        occurredAt: new Date(),
      })
    ).id;

    // (5) The superseding row, unembedded → must be INCLUDED.
    ids.superseding = (
      await insertEvent({
        ...base,
        originId: 'superseding',
        title: 'superseding',
        content: 'current version that supersedes the original',
        occurredAt: new Date(),
        supersedesEventId: ids.superseded,
      })
    ).id;

    // (6) Unembedded, newest → must be INCLUDED (first in DESC order).
    ids.unembeddedNew = (
      await insertEvent({
        ...base,
        originId: 'unembedded-new',
        title: 'unembedded new',
        content: 'newest content needing an embedding',
        occurredAt: new Date(),
      })
    ).id;
  });

  afterAll(() => {
    if (originalModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = originalModel;
  });

  it('enqueues exactly the unembedded, non-superseded, non-empty events, newest-first', async () => {
    const result = await triggerEmbedBackfill({} as Env);
    expect(result.runsCreated).toBe(1);

    const sql = getTestDb();
    const rows = (await sql`
      SELECT action_input
      FROM runs
      WHERE organization_id = ${orgId} AND run_type = 'embed_backfill' AND status = 'pending'
    `) as Array<{ action_input: { event_ids: number[] } }>;
    expect(rows).toHaveLength(1);

    const enqueued = rows[0]!.action_input.event_ids;

    // Correct set: only the three genuine backlog rows.
    expect([...enqueued].sort((a, b) => a - b)).toEqual(
      [ids.unembeddedOld, ids.superseding, ids.unembeddedNew].sort((a, b) => a - b)
    );

    // Excluded: embedded, empty-payload, and the superseded original.
    expect(enqueued).not.toContain(ids.embedded);
    expect(enqueued).not.toContain(ids.empty);
    expect(enqueued).not.toContain(ids.superseded);

    // Newest-first: the last-inserted unembedded row comes before the older one.
    expect(enqueued.indexOf(ids.unembeddedNew)).toBeLessThan(enqueued.indexOf(ids.unembeddedOld));
  });

  it('does not stack a second run while one is active', async () => {
    // The pending run from the previous case must serialize retries.
    const result = await triggerEmbedBackfill({} as Env);
    expect(result.runsCreated).toBe(0);
  });

  it('re-enqueues the still-unembedded backlog after its run failed', async () => {
    // A failed run is terminal; it must not dead-end the backlog.
    const sql = getTestDb();
    await sql`
      UPDATE runs SET status = 'failed'
      WHERE organization_id = ${orgId} AND run_type = 'embed_backfill' AND status = 'pending'
    `;
    const result = await triggerEmbedBackfill({} as Env);
    expect(result.runsCreated).toBe(1);

    const rows = (await sql`
      SELECT action_input FROM runs
      WHERE organization_id = ${orgId} AND run_type = 'embed_backfill' AND status = 'pending'
    `) as Array<{ action_input: { event_ids: number[] } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action_input.event_ids).toEqual(
      expect.arrayContaining([ids.unembeddedOld, ids.superseding, ids.unembeddedNew])
    );
  });
});

describe('triggerEmbedBackfill org-per-tick cap (serialize)', () => {
  let originalModel: string | undefined;
  let originalCap: string | undefined;

  // Three orgs each carrying unembedded backlog, so discovery has more
  // candidates than any cap under test.
  beforeAll(async () => {
    originalModel = process.env.EMBEDDINGS_MODEL;
    originalCap = process.env.EMBED_BACKFILL_MAX_ORGS_PER_TICK;
    process.env.EMBEDDINGS_MODEL = MODEL;

    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    for (let i = 0; i < 3; i++) {
      const org = await createTestOrganization({ name: `Cap Org ${i}` });
      const entity = await createTestEntity({ name: `Cap Target ${i}`, organization_id: org.id });
      await createTestConnectorDefinition({
        key: `cap-connector-${i}`,
        name: `Cap ${i}`,
        organization_id: org.id,
      });
      const connection = await createTestConnection({
        organization_id: org.id,
        connector_key: `cap-connector-${i}`,
        entity_ids: [entity.id],
      });
      await insertEvent({
        entityIds: [entity.id],
        organizationId: org.id,
        semanticType: 'content',
        originType: 'content',
        connectorKey: `cap-connector-${i}`,
        connectionId: connection.id,
        originId: `cap-unembedded-${i}`,
        title: `cap unembedded ${i}`,
        content: `org ${i} content needing an embedding`,
        occurredAt: new Date(),
      });
    }
  });

  afterAll(() => {
    if (originalModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = originalModel;
    if (originalCap === undefined) delete process.env.EMBED_BACKFILL_MAX_ORGS_PER_TICK;
    else process.env.EMBED_BACKFILL_MAX_ORGS_PER_TICK = originalCap;
  });

  it('defaults to a single org per tick — concurrent runs never pile onto the single embeddings service', async () => {
    delete process.env.EMBED_BACKFILL_MAX_ORGS_PER_TICK;
    const result = await triggerEmbedBackfill({} as Env);
    expect(result.runsCreated).toBe(1);
  });

  it('dispatches up to EMBED_BACKFILL_MAX_ORGS_PER_TICK when the embeddings tier is scaled', async () => {
    const sql = getTestDb();
    // Clear the prior tick's run so all three orgs are eligible again
    // (createBackfillRun skips an org with an active run).
    await sql`DELETE FROM runs WHERE run_type = 'embed_backfill'`;

    process.env.EMBED_BACKFILL_MAX_ORGS_PER_TICK = '2';
    const result = await triggerEmbedBackfill({} as Env);
    expect(result.runsCreated).toBe(2);
  });
});
