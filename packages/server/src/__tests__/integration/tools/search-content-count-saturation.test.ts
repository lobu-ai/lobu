/**
 * search_memory entity/child content counts are bounded probes, not unbounded
 * scans — and visibility filtering applies BEFORE the cap.
 *
 * `entitySelectColumns` / the children query count via
 * `SELECT COUNT(*) FROM (SELECT 1 ... LIMIT 1001)`, so counts saturate at 1001
 * instead of walking an entity's full history. A count that excluded hidden
 * rows only after capping could leak (or undercount); these guards pin both
 * halves: saturation at exactly 1001 with 1002+ visible events, and exact
 * small counts that exclude private-connection events the reader cannot see.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { search, type SearchArgs } from '../../../tools/search';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

async function bulkSeedEvents(args: {
  entityId: number;
  organizationId: string;
  connectionId: number;
  count: number;
  label: string;
}) {
  const sql = getTestDb();
  await sql.unsafe(
    `INSERT INTO events (id, organization_id, entity_ids, title, payload_text, occurred_at, created_at, connector_key, connection_id)
     SELECT nextval('content_id_seq'), $1, ARRAY[$2]::bigint[],
            $4 || ' ' || g, 'body ' || g, NOW(), NOW(), 'saturation-connector', $3
     FROM generate_series(1, $5) g`,
    [args.organizationId, args.entityId, args.connectionId, args.label, args.count]
  );
}

describe('search_memory content_count saturation and visibility', () => {
  let orgId: string;
  let ownerCtx: ToolContext;
  let readerCtx: ToolContext;
  let rootId: number;
  let childId: number;

  function searchAs(args: Partial<SearchArgs>, ctx: ToolContext) {
    return search({ include_content: false, ...args } as SearchArgs, {} as Env, ctx);
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();
    const org = await createTestOrganization({ name: 'Saturation Org' });
    orgId = org.id;
    const owner = await createTestUser({ email: 'saturation-owner@test.example.com' });
    const reader = await createTestUser({ email: 'saturation-reader@test.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    await addUserToOrganization(reader.id, org.id, 'member');
    ownerCtx = {
      organizationId: org.id,
      userId: owner.id,
      tokenType: 'session',
      memberRole: 'owner',
    } as ToolContext;
    readerCtx = {
      organizationId: org.id,
      userId: reader.id,
      tokenType: 'session',
      memberRole: 'member',
    } as ToolContext;

    const root = await createTestEntity({ name: 'Saturation Target', organization_id: org.id });
    rootId = Number(root.id);
    const child = await createTestEntity({
      name: 'Saturation Child',
      organization_id: org.id,
      parent_id: rootId,
    });
    childId = Number(child.id);

    await createTestConnectorDefinition({
      key: 'saturation-connector',
      name: 'Saturation',
      organization_id: org.id,
    });
    const visible = await createTestConnection({
      organization_id: org.id,
      connector_key: 'saturation-connector',
      entity_ids: [rootId],
    });
    // Private to the owner: a plain member must not see these rows at all.
    const hidden = await createTestConnection({
      organization_id: org.id,
      connector_key: 'saturation-connector',
      entity_ids: [rootId, childId],
      visibility: 'private',
      created_by: owner.id,
    });

    // Root: over the probe cap on the visible connection, plus hidden rows
    // that must not leak into EITHER reader's count.
    await bulkSeedEvents({
      entityId: rootId,
      organizationId: orgId,
      connectionId: visible.id,
      count: 1002,
      label: 'visible root',
    });
    await bulkSeedEvents({
      entityId: rootId,
      organizationId: orgId,
      connectionId: hidden.id,
      count: 50,
      label: 'hidden root',
    });
    // Child: exact small numbers — visible + hidden.
    await bulkSeedEvents({
      entityId: childId,
      organizationId: orgId,
      connectionId: visible.id,
      count: 3,
      label: 'visible child',
    });
    await bulkSeedEvents({
      entityId: childId,
      organizationId: orgId,
      connectionId: hidden.id,
      count: 50,
      label: 'hidden child',
    });
  });

  it('saturates the entity content_count at the probe cap', async () => {
    for (const ctx of [ownerCtx, readerCtx]) {
      const result = await searchAs({ query: 'Saturation Target' }, ctx);
      const match = result.matches.find((m) => m.id === rootId);
      expect(match).toBeDefined();
      // 1002 visible + 50 hidden rows would read 1052 unbounded; the LIMIT
      // 1001 probe saturates instead of scanning the full history.
      expect(match!.stats.content_count).toBe(1001);
    }
  });

  it('excludes hidden-connection events from counts before the cap', async () => {
    const readerResult = await searchAs({ query: 'Saturation Target' }, readerCtx);
    const child = readerResult.children?.find((c) => c.id === childId);
    expect(child).toBeDefined();
    // 3 visible + 50 hidden: exact, because the reader cannot see the private
    // connection's rows and the total is far below the probe cap.
    expect(child!.content_count).toBe(3);

    const ownerResult = await searchAs({ query: 'Saturation Target' }, ownerCtx);
    const ownerChild = ownerResult.children?.find((c) => c.id === childId);
    expect(ownerChild).toBeDefined();
    // The owner sees both connections, so all 53 rows count.
    expect(ownerChild!.content_count).toBe(53);
  });
});
