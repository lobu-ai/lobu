/**
 * Compact entity history contracts kept from the old broad entity suites.
 *
 * These are high-value because they protect auditability and the append-only
 * event invariant: entity updates must emit change events, and force-deleting
 * a tree must detach — never delete — the event history that references it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { insertConnectionlessAuditEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

async function waitForChangeEvent(entityId: number) {
  const sql = getTestDb();
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await sql`
      SELECT title, metadata, created_by
      FROM events
      WHERE ${entityId} = ANY(entity_ids)
        AND semantic_type = 'change'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
    if (rows.length > 0) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for change event for entity ${entityId}`);
}

/**
 * Wait for a relationship audit event to land.
 *
 * Keyed on the relationship rather than the entity, because `waitForChangeEvent`
 * would return the metadata update's own change event immediately and prove
 * nothing about this one.
 */
async function waitForEdgeChangeEvent(relationshipId: number, op: 'link' | 'unlink') {
  const sql = getTestDb();
  for (let attempt = 0; attempt < 40; attempt++) {
    const rows = await sql`
      SELECT id
      FROM events
      WHERE semantic_type = 'change'
        AND metadata->>'category' = 'relationship'
        AND metadata->>'relationshipId' = ${String(relationshipId)}
        AND metadata->>'op' = ${op}
      LIMIT 1
    `;
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${op} audit event on relationship ${relationshipId}`);
}

/**
 * Wait until `count` other backends in this database are parked on a lock.
 *
 * Keyed on the count rather than on a query fragment: exactly which statement
 * each side parks on is an implementation detail of the delete path, and a test
 * that pinned the text would keep passing — vacuously — the day that path grows
 * a lock earlier or renames a column in an unrelated SELECT.
 */
async function waitForLockWaiters(count: number) {
  const sql = getTestDb();
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await sql<{ waiting: number }[]>`
      SELECT COUNT(*)::int AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `;
    if (rows[0].waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const active = await sql`
    SELECT wait_event_type, wait_event, LEFT(query, 300) AS query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND state <> 'idle'
  `;
  throw new Error(
    `Timed out waiting for ${count} lock waiters: ${JSON.stringify(active)}`
  );
}

describe('entity history contracts', () => {
  let workspace: TestWorkspace;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Entity History Org' });
    await workspace.owner.entity_schema.createType({ slug: 'brand', name: 'Brand' });
  });

  it('records a single change event for real metadata updates, not no-op repeats', async () => {
    const created = (await workspace.owner.entities.create({
      entity_type: 'brand',
      name: 'Audit Brand',
      metadata: { domain: 'old.example' },
    })) as { entity: { id: number } };

    await workspace.owner.entities.update({
      entity_id: created.entity.id,
      metadata: { domain: 'new.example' },
    });

    const event = await waitForChangeEvent(created.entity.id);
    expect(event.created_by).toBe(workspace.users.owner.id);
    expect(String(event.title)).toContain('domain');

    const metadata = event.metadata as { changes?: Array<{ field: string; old: unknown; new: unknown }> };
    expect(metadata.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'domain', old: 'old.example', new: 'new.example' }),
      ])
    );

    const before = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM events
      WHERE ${created.entity.id} = ANY(entity_ids)
        AND semantic_type = 'change'
    `;
    await workspace.owner.entities.update({
      entity_id: created.entity.id,
      metadata: { domain: 'new.example' },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM events
      WHERE ${created.entity.id} = ANY(entity_ids)
        AND semantic_type = 'change'
    `;
    expect(after[0].count).toBe(before[0].count);
  });

  it('rolls a relationship link back when its canonical event cannot be appended', async () => {
    const sql = getTestDb();
    await workspace.owner.entity_schema.createRelType({
      slug: 'atomic-related-brand',
      name: 'Atomic Related Brand',
    });
    const from = (await workspace.owner.entities.create({
      entity_type: 'brand',
      name: 'Atomic From',
    })) as { entity: { id: number } };
    const to = (await workspace.owner.entities.create({
      entity_type: 'brand',
      name: 'Atomic To',
    })) as { entity: { id: number } };
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION test_fail_relationship_link_event() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.metadata->>'_lobu_event_type' = 'relationship.linked' THEN
          RAISE EXCEPTION 'simulated relationship event persistence failure';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_relationship_link_event_trg
        BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION test_fail_relationship_link_event();
    `);
    try {
      await expect(
        workspace.owner.entities.link({
          from_entity_id: from.entity.id,
          to_entity_id: to.entity.id,
          relationship_type_slug: 'atomic-related-brand',
        })
      ).rejects.toThrow(/relationship event persistence failure/i);
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS test_fail_relationship_link_event_trg ON events;
        DROP FUNCTION IF EXISTS test_fail_relationship_link_event();
      `);
    }
    const edges = await sql`
      SELECT id FROM entity_relationships
      WHERE organization_id = ${workspace.org.id}
        AND from_entity_id = ${from.entity.id}
        AND to_entity_id = ${to.entity.id}
        AND deleted_at IS NULL
    `;
    expect(edges).toHaveLength(0);
  });

  it('force-deletes a tree with event history by detaching event references, not deleting events', async () => {
    const root = (await workspace.owner.entities.create({ entity_type: 'brand', name: 'Purged Root' })) as {
      entity: { id: number };
    };
    const child = (await workspace.owner.entities.create({
      entity_type: 'brand',
      name: 'Purged Child',
      parent_id: root.entity.id,
    })) as { entity: { id: number } };
    const grandchild = (await workspace.owner.entities.create({
      entity_type: 'brand',
      name: 'Purged Grandchild',
      parent_id: child.entity.id,
    })) as { entity: { id: number } };

    const event = await createTestEvent({
      entity_id: grandchild.entity.id,
      organization_id: workspace.org.id,
      content: 'Historical knowledge that must survive the purge',
    });

    // Preflight: dry_run reports what the delete would touch without mutating.
    const preview = (await workspace.owner.entities.delete({
      entity_id: root.entity.id,
      force_delete_tree: true,
      dry_run: true,
    })) as { action: string; deleted_count: number; dry_run?: boolean; tree?: Record<string, number> };
    expect(preview.dry_run).toBe(true);
    expect(preview.deleted_count).toBe(0);
    expect(preview.tree).toMatchObject({ entities: 3, events_detached: 1 });

    const afterPreview = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${root.entity.id},${child.entity.id},${grandchild.entity.id}}`}::bigint[])
        AND deleted_at IS NULL
    `;
    expect(afterPreview[0].count).toBe(3);

    const result = (await workspace.owner.entities.delete({
      entity_id: root.entity.id,
      force_delete_tree: true,
    })) as { action: string; deleted_count?: number; tree?: Record<string, number> };
    expect(result.action).toBe('delete');
    expect(result.deleted_count).toBe(3);
    expect(result.tree).toMatchObject({ entities: 3, events_detached: 1 });

    const remaining = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${root.entity.id},${child.entity.id},${grandchild.entity.id}}`}::bigint[])
    `;
    expect(remaining[0].count).toBe(0);

    // The event row survives as append-only history; only its entity linkage is gone.
    const eventRows = await getTestDb()`
      SELECT (${grandchild.entity.id} = ANY(entity_ids)) AS still_linked
      FROM events WHERE id = ${event.id}
    `;
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].still_linked).toBe(false);
  });

  it('force-deletes fresh entities whose own lifecycle produced platform change events (#2049)', async () => {
    await workspace.owner.entity_schema.createRelType({
      slug: 'related-brand',
      name: 'Related Brand',
    });

    const a = (await workspace.owner.entities.create({ entity_type: 'brand', name: 'Disposable A' })) as {
      entity: { id: number };
    };
    const b = (await workspace.owner.entities.create({ entity_type: 'brand', name: 'Disposable B' })) as {
      entity: { id: number };
    };

    // Normal lifecycle activity: a metadata update emits a platform change
    // event, and a temporary relationship is created then removed.
    await workspace.owner.entities.update({
      entity_id: a.entity.id,
      metadata: { domain: 'disposable.example' },
    });
    await waitForChangeEvent(a.entity.id);
    const linked = (await workspace.owner.entities.link({
      from_entity_id: a.entity.id,
      to_entity_id: b.entity.id,
      relationship_type_slug: 'related-brand',
    })) as { relationship: { id: number } };
    await waitForEdgeChangeEvent(linked.relationship.id, 'link');
    await workspace.owner.entities.unlink({
      relationship_id: linked.relationship.id,
    });
    await waitForEdgeChangeEvent(linked.relationship.id, 'unlink');

    // Prove the events are ATTACHED before deleting. Without this, the final
    // assertion below passes vacuously whenever the audit rows simply had not
    // arrived yet — it would prove nothing about detachment.
    const beforeDelete = await getTestDb()`
      SELECT COUNT(*)::int AS count FROM events
      WHERE semantic_type = 'change'
        AND ${a.entity.id} = ANY(entity_ids)
    `;
    expect(beforeDelete[0].count).toBeGreaterThanOrEqual(3);

    for (const id of [a.entity.id, b.entity.id]) {
      const result = (await workspace.owner.entities.delete({
        entity_id: id,
        force_delete_tree: true,
      })) as { action: string; deleted_count?: number };
      expect(result.action).toBe('delete');
      expect(result.deleted_count).toBe(1);
    }

    const remaining = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${a.entity.id},${b.entity.id}}`}::bigint[])
    `;
    expect(remaining[0].count).toBe(0);

    // The change event history is preserved (append-only), just detached.
    const changeEvents = await getTestDb()`
      SELECT entity_ids FROM events
      WHERE semantic_type = 'change'
        AND ${a.entity.id} = ANY(entity_ids)
    `;
    expect(changeEvents).toHaveLength(0);
  });

  /**
   * The force-delete dependency report is computed BEFORE the transaction takes
   * any lock, so an edge audit can commit inside that window and be detached by
   * a sweep the preflight never counted — the `events_detached` undercount in
   * #2812. Freeze `events` against writes (EXCLUSIVE still permits the delete's
   * own SELECTs, so its preflight really does read zero), park the audit on its
   * INSERT while it holds the org and entity locks, and let the delete queue
   * behind it.
   *
   * Doubles as the regression test for the audit's lock ORDER: it must claim
   * `organization` before `entities`, the order `lockOrgForAclInvalidation`
   * documents, because `events_organization_id_fkey` takes the org lock at
   * INSERT time. Reversed, this interleaving deadlocks and Postgres aborts one
   * of the two transactions instead of either assertion below being reached.
   */
  it('reports the event rows its transaction actually detached, not the preflight (#2812)', async () => {
    const deleted = (await workspace.owner.entities.create({
      entity_type: 'brand',
      name: 'Deleted During Audit',
    })) as { entity: { id: number } };
    const survivor = (await workspace.owner.entities.create({
      entity_type: 'brand',
      name: 'Concurrent Audit Survivor',
    })) as { entity: { id: number } };
    const sql = getTestDb();

    let signalEventsLocked!: () => void;
    const eventsLocked = new Promise<void>((resolve) => {
      signalEventsLocked = resolve;
    });
    let releaseEventsLock!: () => void;
    const eventsLockReleased = new Promise<void>((resolve) => {
      releaseEventsLock = resolve;
    });
    const tableBlocker = sql.begin(async (tx) => {
      await tx`LOCK TABLE events IN EXCLUSIVE MODE`;
      signalEventsLocked();
      await eventsLockReleased;
    });

    await eventsLocked;
    // Distinct offset from the synthetic edge above, so the two tests' audit
    // rows can never be mistaken for each other.
    const relationshipId = deleted.entity.id + 2_000_000_000;
    const originId = `edge-race-test:${relationshipId}`;
    let auditPromise: Promise<unknown> | undefined;
    let deletePromise: Promise<unknown> | undefined;
    try {
      auditPromise = insertConnectionlessAuditEvent(
        {
          entityIds: [deleted.entity.id, survivor.entity.id],
          organizationId: workspace.org.id,
          originId,
          semanticType: 'change',
          title: 'Concurrent relationship audit',
          metadata: {
            category: 'relationship',
            op: 'unlink',
            relationshipId: String(relationshipId),
          },
          createdBy: workspace.users.owner.id,
        },
        { subject: 'relationship', op: 'unlinked' },
        { lockAndPruneEntityRefs: true }
      );
      await waitForLockWaiters(1);

      deletePromise = workspace.owner.entities.delete({
        entity_id: deleted.entity.id,
        force_delete_tree: true,
      });
      await waitForLockWaiters(2);

      // Both sides are now frozen, so this is exactly what the delete's
      // preflight counted. Asserting it pins the discriminator: the report
      // below can only say 1 if it was recomputed from the sweep.
      const preflight = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM events
        WHERE ${deleted.entity.id} = ANY(entity_ids)
      `;
      expect(preflight[0].count).toBe(0);

      releaseEventsLock();
      await tableBlocker;
      await auditPromise;
      const result = (await deletePromise) as { tree?: Record<string, number> };
      expect(result.tree?.events_detached).toBe(1);
    } finally {
      releaseEventsLock();
      await tableBlocker.catch(() => undefined);
      await auditPromise?.catch(() => undefined);
      await deletePromise?.catch(() => undefined);
    }

    const rows = await sql<{ deleted_still_linked: boolean }[]>`
      SELECT ${deleted.entity.id} = ANY(entity_ids) AS deleted_still_linked
      FROM events
      WHERE origin_id = ${originId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_still_linked).toBe(false);
  });

  it('hard-deletes a descendant tree with no event history', async () => {
    const root = (await workspace.owner.entities.create({ entity_type: 'brand', name: 'Disposable Root' })) as {
      entity: { id: number };
    };
    const child = (await workspace.owner.entities.create({
      entity_type: 'brand',
      name: 'Disposable Child',
      parent_id: root.entity.id,
    })) as { entity: { id: number } };
    const grandchild = (await workspace.owner.entities.create({
      entity_type: 'brand',
      name: 'Disposable Grandchild',
      parent_id: child.entity.id,
    })) as { entity: { id: number } };

    const result = (await workspace.owner.entities.delete({
      entity_id: root.entity.id,
      force_delete_tree: true,
    })) as { action: string; deleted_count?: number };
    expect(result.action).toBe('delete');
    expect(result.deleted_count).toBe(3);

    const remaining = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${root.entity.id},${child.entity.id},${grandchild.entity.id}}`}::bigint[])
    `;
    expect(remaining[0].count).toBe(0);
  });
});
