/**
 * Repro for ISSUE 7 (2026-09-13 self-host QA): a failed embed_backfill run
 * must NOT dead-end the backlog - the next trigger tick must re-enqueue the
 * still-unembedded events in a fresh run.
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

describe('triggerEmbedBackfill retries after a failed run', () => {
  let orgId: string;
  let eventId: number;
  let originalModel: string | undefined;

  beforeAll(async () => {
    originalModel = process.env.EMBEDDINGS_MODEL;
    process.env.EMBEDDINGS_MODEL = MODEL;

    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Backfill Retry Org' });
    orgId = org.id;
    const entity = await createTestEntity({ name: 'Retry Target', organization_id: org.id });
    await createTestConnectorDefinition({
      key: 'retry-connector',
      name: 'Retry',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'retry-connector',
      entity_ids: [entity.id],
    });

    eventId = (
      await insertEvent({
        entityIds: [entity.id],
        organizationId: orgId,
        semanticType: 'content' as const,
        originType: 'content' as const,
        connectorKey: 'retry-connector',
        connectionId: connection.id,
        originId: 'failed-once',
        title: 'failed once',
        content: 'content whose first embedding attempt failed at cold boot',
        occurredAt: new Date(),
      })
    ).id;

    // The failed first attempt: terminal status, no longer active.
    await getTestDb()`
      INSERT INTO runs (organization_id, run_type, status, approval_status, action_input, created_at)
      VALUES (${orgId}, 'embed_backfill', 'failed', 'auto', ${getTestDb().json({ event_ids: [eventId] })}, current_timestamp)
    `;
  });

  afterAll(() => {
    if (originalModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = originalModel;
  });

  it('re-enqueues unembedded events after their run failed', async () => {
    const result = await triggerEmbedBackfill({} as Env);
    expect(result.runsCreated).toBe(1);

    const rows = (await getTestDb()`
      SELECT action_input FROM runs
      WHERE organization_id = ${orgId} AND run_type = 'embed_backfill' AND status = 'pending'
    `) as Array<{ action_input: { event_ids: number[] } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action_input.event_ids).toContain(eventId);
  });

  it('does not stack a second run while one is active', async () => {
    // A pending run now exists from the previous test: the dedup must hold so
    // retries serialize instead of piling up.
    const result = await triggerEmbedBackfill({} as Env);
    expect(result.runsCreated).toBe(0);
  });
});
