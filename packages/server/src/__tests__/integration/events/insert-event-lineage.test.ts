/**
 * A supersede is the next version of the same thing. Lineage is copied from
 * the predecessor inside insertEvent — omit or null cannot drop it. A later
 * number restamps this version's producer/run.
 *
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { type DbClient, getDb, parsePgNumberArray } from '../../../db/client';
import { supersedeActionEvent } from '../../../tools/admin/approval-events';
import { EVENT_SUPERSEDE_RULES, insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

async function insertAutomation(
  organizationId: string,
  userId: string,
  slug: string
): Promise<{ id: number; versionId: number }> {
  const sql = getDb();
  const [automation] = await sql`
    INSERT INTO automations (
      organization_id, created_by, automation_group_id, name, slug, managed_agent_id
    ) VALUES (
      ${organizationId}, ${userId}, 0, ${slug}, ${slug}, 'lineage-agent'
    )
    RETURNING id
  `;
  const id = Number(automation.id);
  await sql`UPDATE automations SET automation_group_id = ${id} WHERE id = ${id}`;
  const [version] = await sql`
    INSERT INTO automation_versions (
      automation_id, version, name, created_by, prompt
    ) VALUES (
      ${id}, 1, ${slug}, ${userId}, 'prompt'
    )
    RETURNING id
  `;
  return { id, versionId: Number(version.id) };
}

async function insertRun(organizationId: string): Promise<number> {
  const [row] = await getDb()`
    INSERT INTO runs
      (organization_id, run_type, status, approval_status, action_key, created_at)
    VALUES
      (${organizationId}, 'action', 'pending', 'pending', 'screenshot', NOW())
    RETURNING id
  `;
  return Number((row as { id: number }).id);
}

async function insertFeed(
  organizationId: string,
  connectionId: number,
  feedKey: string
): Promise<number> {
  const [row] = await getDb()`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status, created_at, updated_at
    ) VALUES (
      ${organizationId}, ${connectionId}, ${feedKey}, 'active', NOW(), NOW()
    )
    RETURNING id
  `;
  return Number((row as { id: number }).id);
}

async function lineageOf(eventId: number): Promise<{
  automation_id: number | null;
  automation_version_id: number | null;
  run_id: number | null;
  connection_id: number | null;
  connector_key: string | null;
  feed_id: number | null;
  feed_key: string | null;
  identity_ns: string | null;
  identity_key: string | null;
  origin_parent_id: string | null;
  client_id: string | null;
}> {
  const [row] = await getDb()`
    SELECT automation_id, automation_version_id, run_id, connection_id, connector_key,
           feed_id, feed_key, identity_ns, identity_key, origin_parent_id, client_id
    FROM events WHERE id = ${eventId}
  `;
  const r = row as Record<string, unknown>;
  return {
    automation_id: r.automation_id == null ? null : Number(r.automation_id),
    automation_version_id:
      r.automation_version_id == null ? null : Number(r.automation_version_id),
    run_id: r.run_id == null ? null : Number(r.run_id),
    connection_id: r.connection_id == null ? null : Number(r.connection_id),
    connector_key: (r.connector_key as string | null) ?? null,
    feed_id: r.feed_id == null ? null : Number(r.feed_id),
    feed_key: (r.feed_key as string | null) ?? null,
    identity_ns: (r.identity_ns as string | null) ?? null,
    identity_key: (r.identity_key as string | null) ?? null,
    origin_parent_id: (r.origin_parent_id as string | null) ?? null,
    client_id: (r.client_id as string | null) ?? null,
  };
}

describe('insertEvent lineage on supersede', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('returns the replaced head activity time only on a source supersede, including afterPersist', async () => {
    const org = await createTestOrganization();
    const connection = await createTestConnection({ organization_id: org.id, connector_key: 'test_updates' });
    const params = {
      entityIds: [], organizationId: org.id, connectionId: Number(connection.id),
      originId: 'test-thread-1', semanticType: 'thread', content: 'Original message',
      occurredAt: new Date('2026-08-11T09:00:00.000Z'),
    };
    const seen: unknown[] = [];
    const options = { onConflictUpdate: true, afterPersist: async (row: { previous_occurred_at?: string | null }) => {
      seen.push(row.previous_occurred_at);
    } };
    const first = await insertEvent(params, options);
    expect(first.change).toBe('inserted');
    expect(first).not.toHaveProperty('previous_occurred_at');
    const reply = { ...params, content: 'Original message\nNew reply', occurredAt: new Date('2026-08-11T10:00:00.000Z') };
    const next = await insertEvent(reply, options);
    expect(next.change).toBe('superseded');
    expect(new Date(next.previous_occurred_at!).toISOString()).toBe(params.occurredAt.toISOString());
    expect(new Date(seen[1] as string).toISOString()).toBe(params.occurredAt.toISOString());
    const replay = await insertEvent(reply, options);
    expect(replay.change).toBe('unchanged');
    expect(replay).not.toHaveProperty('previous_occurred_at');
    const counters = await insertEvent({ ...reply, metadata: { reply_count: 3 } }, options);
    expect(counters.change).toBe('state_updated');
    expect(counters).not.toHaveProperty('previous_occurred_at');
    expect(seen[0]).toBeUndefined();
    expect(seen[2]).toBeUndefined();
    expect(seen[3]).toBeUndefined();
  });

  it('copies producer and source lineage even when the successor omits them', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    const automation = await insertAutomation(org.id, user.id, 'lineage-copy');
    const runId = await insertRun(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
    });
    const feedId = await insertFeed(org.id, Number(connection.id), 'front');

    const prior = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-root',
      title: 'root',
      content: 'root',
      semanticType: 'observation',
      connectorKey: 'reddit',
      connectionId: Number(connection.id),
      feedKey: 'front',
      feedId,
      runId,
      automationId: automation.id,
      automationVersionId: automation.versionId,
      parentOriginId: 'parent-origin',
      identity: { ns: 'test.lineage', key: 'thing-1' },
    });

    const next = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-next',
      title: 'next',
      content: 'next',
      semanticType: 'observation',
      supersedesEventId: Number(prior.id),
    });

    expect(await lineageOf(Number(next.id))).toEqual({
      automation_id: automation.id,
      automation_version_id: automation.versionId,
      run_id: runId,
      connection_id: Number(connection.id),
      connector_key: 'reddit',
      feed_id: feedId,
      feed_key: 'front',
      identity_ns: 'test.lineage',
      identity_key: 'thing-1',
      origin_parent_id: 'parent-origin',
      client_id: null,
    });
  });

  it('keeps lineage when the successor explicitly passes nulls', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    const automation = await insertAutomation(org.id, user.id, 'lineage-nulls');
    const runId = await insertRun(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
    });
    const feedId = await insertFeed(org.id, Number(connection.id), 'front');

    const prior = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-nulls-root',
      title: 'root',
      content: 'root',
      semanticType: 'observation',
      connectorKey: 'reddit',
      connectionId: Number(connection.id),
      feedKey: 'front',
      feedId,
      runId,
      automationId: automation.id,
      automationVersionId: automation.versionId,
      parentOriginId: 'parent-origin',
      identity: { ns: 'test.lineage', key: 'thing-nulls' },
    });

    const next = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-nulls-next',
      title: 'next',
      content: 'next',
      semanticType: 'observation',
      automationId: null,
      automationVersionId: null,
      runId: null,
      connectionId: null,
      connectorKey: null,
      feedId: null,
      feedKey: null,
      parentOriginId: null,
      identity: null,
      supersedesEventId: Number(prior.id),
    });

    expect(await lineageOf(Number(next.id))).toEqual({
      automation_id: automation.id,
      automation_version_id: automation.versionId,
      run_id: runId,
      connection_id: Number(connection.id),
      connector_key: 'reddit',
      feed_id: feedId,
      feed_key: 'front',
      identity_ns: 'test.lineage',
      identity_key: 'thing-nulls',
      origin_parent_id: 'parent-origin',
      client_id: null,
    });
  });

  it('uses explicitly supplied attribution for the new stored version', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    const firstAutomation = await insertAutomation(
      org.id,
      user.id,
      'lineage-first-producer'
    );
    const nextAutomation = await insertAutomation(
      org.id,
      user.id,
      'lineage-next-producer'
    );
    const firstRunId = await insertRun(org.id);
    const nextRunId = await insertRun(org.id);

    const prior = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-attribution-root',
      title: 'root',
      content: 'root',
      semanticType: 'observation',
      runId: firstRunId,
      automationId: firstAutomation.id,
      automationVersionId: firstAutomation.versionId,
      parentOriginId: 'first-parent',
    });

    const next = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-attribution-next',
      title: 'next',
      content: 'next',
      semanticType: 'observation',
      runId: nextRunId,
      automationId: nextAutomation.id,
      automationVersionId: nextAutomation.versionId,
      parentOriginId: 'next-parent',
      supersedesEventId: Number(prior.id),
    });

    expect(await lineageOf(Number(next.id))).toMatchObject({
      run_id: nextRunId,
      automation_id: nextAutomation.id,
      automation_version_id: nextAutomation.versionId,
      origin_parent_id: 'next-parent',
    });
  });

  it('does not re-supersede a copied-parent head on a parentless re-sync', async () => {
    const org = await createTestOrganization();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
    });

    const root = await insertEvent(
      {
        entityIds: [],
        organizationId: org.id,
        originId: 'lineage-resync',
        title: 'item',
        content: 'v1',
        semanticType: 'observation',
        connectorKey: 'reddit',
        connectionId: Number(connection.id),
        parentOriginId: 'resync-parent',
      },
      { onConflictUpdate: true }
    );
    expect(root.change).toBe('inserted');

    // Content changed, parent omitted: supersedes and copies the parent.
    const resyncParams = {
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-resync',
      title: 'item',
      content: 'v2',
      semanticType: 'observation',
      connectorKey: 'reddit',
      connectionId: Number(connection.id),
    };
    const superseded = await insertEvent(resyncParams, { onConflictUpdate: true });
    expect(superseded.change).toBe('superseded');
    expect(await lineageOf(Number(superseded.id))).toMatchObject({
      origin_parent_id: 'resync-parent',
    });

    // Identical parentless re-sync: the copied parent must not read as a
    // difference, or every sync would mint a new stored version forever.
    const resync = await insertEvent(resyncParams, { onConflictUpdate: true });
    expect(resync.change).toBe('unchanged');
    expect(Number(resync.id)).toBe(Number(superseded.id));
  });

  it('supersedes changed entity attribution and deduplicates reordered replay', async () => {
    const org = await createTestOrganization();
    const connection = await createTestConnection({ organization_id: org.id, connector_key: 'reddit' });
    const first = await createTestEntity({ organization_id: org.id, name: 'First' });
    const second = await createTestEntity({ organization_id: org.id, name: 'Second' });
    const base = {
      organizationId: org.id,
      connectionId: Number(connection.id),
      originId: 'attribution-resync',
      semanticType: 'observation',
      title: 'Unchanged source record',
    };
    const upsert = (entityIds: number[]) => insertEvent({ ...base, entityIds }, { onConflictUpdate: true });
    const prior = await upsert([]);
    const next = await upsert([first.id, second.id]);
    expect(next.change).toBe('superseded');
    expect(parsePgNumberArray(next.entity_ids)).toEqual([first.id, second.id]);
    const replay = await upsert([second.id, first.id, first.id]);
    expect(replay.change).toBe('unchanged');
    expect(replay.id).toBe(next.id);
    const removed = await upsert([second.id]);
    expect(removed.change).toBe('superseded');
    const cleared = await upsert([]);
    expect(cleared.change).toBe('superseded');
    expect(parsePgNumberArray(cleared.entity_ids)).toEqual([]);
    const emptyReplay = await upsert([]);
    expect(emptyReplay.change).toBe('unchanged');
    expect(emptyReplay.id).toBe(cleared.id);
    const rows = await getDb()`
      SELECT id, entity_ids, supersedes_event_id FROM events
      WHERE organization_id = ${org.id} AND origin_id = ${base.originId} ORDER BY id
    `;
    expect(rows.map((row) => parsePgNumberArray(row.entity_ids))).toEqual([
      [], [first.id, second.id], [second.id], [],
    ]);
    expect(rows.map((row) => row.supersedes_event_id)).toEqual([null, prior.id, next.id, removed.id]);
  });

  it('fails closed when the predecessor is missing', async () => {
    const org = await createTestOrganization();
    await expect(
      insertEvent({
        entityIds: [],
        organizationId: org.id,
        originId: 'lineage-missing-prior',
        title: 'next',
        content: 'next',
        semanticType: 'observation',
        supersedesEventId: 9_000_000_001,
      })
    ).rejects.toThrow(/cannot supersede event 9000000001/i);
  });

  it('preserves Automation attribution through an approval successor that does not pass it', async () => {
    const org = await createTestOrganization();
    const reviewer = await createTestUser({ name: 'Ada Approver' });
    const automation = await insertAutomation(org.id, reviewer.id, 'lineage-approval');
    const runId = await insertRun(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'apple.computer_use',
    });

    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `run_${runId}_pending`,
      title: 'screenshot — pending approval',
      content: 'Agent requested a screenshot.',
      semanticType: 'operation',
      connectorKey: 'apple.computer_use',
      connectionId: Number(connection.id),
      runId,
      automationId: automation.id,
      automationVersionId: automation.versionId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      metadata: { status: 'pending_approval' },
    });

    const approvedId = await supersedeActionEvent(
      runId,
      org.id,
      'confirmed',
      'screenshot — executing',
      'Operation confirmed',
      {},
      { userId: reviewer.id, name: reviewer.name }
    );

    expect(await lineageOf(approvedId!)).toMatchObject({
      automation_id: automation.id,
      automation_version_id: automation.versionId,
      run_id: runId,
      connector_key: 'apple.computer_use',
      connection_id: Number(connection.id),
    });
  });

  it('decides every events column: a new one cannot be dropped by omission', async () => {
    const rows = await getDb()`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'events'
    `;
    const columns = rows.map((row) => (row as { column_name: string }).column_name).sort();
    expect(Object.keys(EVENT_SUPERSEDE_RULES).sort()).toEqual(columns);
  });

  it('keeps the requesting client through approval decisions and plain supersedes', async () => {
    const org = await createTestOrganization();
    const reviewer = await createTestUser({ name: 'Ada Approver' });
    const requester = await createTestOAuthClient();
    const runId = await insertRun(org.id);

    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `run_${runId}_pending`,
      title: 'send_email — pending approval',
      semanticType: 'operation',
      runId,
      clientId: requester.client_id,
      authorName: requester.client_id,
      interactionType: 'approval',
      interactionStatus: 'pending',
      metadata: { status: 'pending_approval' },
    });

    const rejectedId = await supersedeActionEvent(
      runId,
      org.id,
      'rejected',
      'send_email — rejected',
      'Operation rejected',
      {},
      { userId: reviewer.id, name: reviewer.name }
    );
    expect((await lineageOf(rejectedId!)).client_id).toBe(requester.client_id);

    const nulled = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `run_${runId}_note`,
      semanticType: 'operation',
      clientId: null,
      supersedesEventId: rejectedId!,
    });
    expect((await lineageOf(nulled.id)).client_id).toBe(requester.client_id);

    const editor = await createTestOAuthClient();
    const edited = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `run_${runId}_edit`,
      semanticType: 'operation',
      clientId: editor.client_id,
      supersedesEventId: nulled.id,
    });
    expect((await lineageOf(edited.id)).client_id).toBe(editor.client_id);
  });

  it('reads lineage inside the write transaction after a source feed is removed', async () => {
    const org = await createTestOrganization();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test.lineage',
    });
    const feedId = await insertFeed(org.id, Number(connection.id), 'items');
    const prior = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'feed-removal-root',
      semanticType: 'observation',
      connectionId: Number(connection.id),
      connectorKey: 'test.lineage',
      feedId,
      feedKey: 'items',
    });

    // Simulate a concurrent deletion after the sanitizer's predecessor read,
    // before the supersede transaction starts. The FK clears events.feed_id.
    const sql = getDb();
    const deleteFeedBeforeBegin = new Proxy(sql, {
      get(target, property, receiver) {
        if (property === 'begin') {
          return async (fn: (tx: DbClient) => Promise<unknown>) => {
            await sql`DELETE FROM feeds WHERE id = ${feedId}`;
            return target.begin(fn);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const next = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'feed-removal-successor',
      semanticType: 'observation',
      supersedesEventId: prior.id,
    }, { sql: deleteFeedBeforeBegin });

    expect(await lineageOf(next.id)).toMatchObject({
      connection_id: Number(connection.id),
      feed_id: null,
      feed_key: 'items',
    });
  });
});
