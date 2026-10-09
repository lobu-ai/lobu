/** Atomic source-claim invariants for shared relationship triples. */

import { beforeEach, describe, expect, it } from 'vitest';
import { autoLinkEvent } from '../../../utils/auto-linker';
import { ensureRelationshipType, upsertEdges } from '../../../utils/edge-writes';
import {
  connectionRelationshipClaimKey,
  reconcileConnectorRelationshipClaims,
  RELATIONSHIP_CLAIMS_METADATA_KEY,
  retractConnectionRelationshipClaims,
} from '../../../utils/relationship-claims';
import {
  PURPOSE_AUTHORIZATION,
  withAclEdgeWrite,
} from '../../../utils/relationship-validation';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestConnection } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

async function seedClaimGraph() {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({ name: 'Relationship Claim Races' });
  await workspace.owner.entity_schema.createType({ slug: 'invoice', name: 'Invoice' });
  await workspace.owner.entity_schema.createType({ slug: 'customer', name: 'Customer' });
  await workspace.owner.entity_schema.createRelType({
    slug: 'invoice_customer',
    name: 'Invoice Customer',
  });
  const invoice = (await workspace.owner.entities.create({
    entity_type: 'invoice',
    name: 'INV-RACE',
  })) as { entity: { id: number } };
  const customer = (await workspace.owner.entities.create({
    entity_type: 'customer',
    name: 'Race Customer',
  })) as { entity: { id: number } };
  const connection = await createTestConnection({
    organization_id: workspace.org.id,
    connector_key: 'claim-race',
    created_by: workspace.users.owner.id,
    createDefaultFeed: false,
  });
  const desired = [
    {
      declaration: {
        type: 'invoice_customer',
        from: 'invoice',
        to: 'customer',
      },
      fromEntityId: invoice.entity.id,
      toEntityId: customer.entity.id,
    },
  ];
  return { sql, workspace, connection, invoice, customer, desired };
}

async function withPausedRelationshipUpdates(run: () => Promise<unknown>): Promise<void> {
  const sql = getTestDb();
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION test_pause_relationship_claim_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_sleep(0.5);
      RETURN NEW;
    END
    $$
  `);
  await sql.unsafe(`
    CREATE TRIGGER test_pause_relationship_claim_update
    BEFORE UPDATE ON entity_relationships
    FOR EACH ROW
    EXECUTE FUNCTION test_pause_relationship_claim_update()
  `);

  try {
    await run();
  } finally {
    await sql.unsafe(`
      DROP TRIGGER IF EXISTS test_pause_relationship_claim_update
      ON entity_relationships
    `);
    await sql.unsafe(`DROP FUNCTION IF EXISTS test_pause_relationship_claim_update()`);
  }
}

describe('relationship source claims', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('atomically keeps two concurrent source claims on one live triple', async () => {
    const { sql, workspace, connection, desired } = await seedClaimGraph();
    const [index] = await sql`
      SELECT i.indisvalid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_entity_relationships_live_claims'
    `;
    expect(index?.indisvalid).toBe(true);

    await Promise.all([
      sql.begin((tx) =>
        reconcileConnectorRelationshipClaims(tx, {
          organizationId: workspace.org.id,
          connectionId: connection.id,
          originId: 'invoice:source-a',
          desired,
        })
      ),
      sql.begin((tx) =>
        reconcileConnectorRelationshipClaims(tx, {
          organizationId: workspace.org.id,
          connectionId: connection.id,
          originId: 'invoice:source-b',
          desired,
        })
      ),
    ]);

    const rows = await sql`
      SELECT id, metadata
      FROM entity_relationships
      WHERE organization_id = ${workspace.org.id} AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0].metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).sort()).toEqual([
      `connection:${connection.id}:feed:invoice:source-a`,
      `connection:${connection.id}:feed:invoice:source-b`,
    ]);
    const [relationshipEvents] = await sql`
      SELECT count(*)::int AS count
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND metadata->>'_lobu_relationship_change' = 'true'
    `;
    // Connector projections maintain graph state but are not semantic user
    // mutations, so they must not implicitly activate relationship Automations.
    expect(relationshipEvents.count).toBe(0);

    await sql.begin((tx) =>
      reconcileConnectorRelationshipClaims(tx, {
        organizationId: workspace.org.id,
        connectionId: connection.id,
        originId: 'invoice:source-a',
        desired: [],
      })
    );
    const [retained] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${rows[0].id}
    `;
    expect(retained.deleted_at).toBeNull();
    expect(Object.keys(retained.metadata[RELATIONSHIP_CLAIMS_METADATA_KEY])).toEqual([
      `connection:${connection.id}:feed:invoice:source-b`,
    ]);
  });

  it('locks concurrent multi-edge assertions in triple order', async () => {
    const { sql, workspace, connection, desired } = await seedClaimGraph();
    const secondCustomer = (await workspace.owner.entities.create({
      entity_type: 'customer',
      name: 'Second Race Customer',
    })) as { entity: { id: number } };
    const secondEdge = {
      ...desired[0],
      toEntityId: secondCustomer.entity.id,
    };

    await Promise.all([
      sql.begin((tx) =>
        reconcileConnectorRelationshipClaims(tx, {
          organizationId: workspace.org.id,
          connectionId: connection.id,
          originId: 'invoice:ordered-a',
          desired: [desired[0], secondEdge],
        })
      ),
      sql.begin((tx) =>
        reconcileConnectorRelationshipClaims(tx, {
          organizationId: workspace.org.id,
          connectionId: connection.id,
          originId: 'invoice:ordered-b',
          desired: [secondEdge, desired[0]],
        })
      ),
    ]);

    const rows = await sql`
      SELECT metadata FROM entity_relationships
      WHERE organization_id = ${workspace.org.id} AND deleted_at IS NULL
      ORDER BY id
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row.metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).sort()).toEqual([
        `connection:${connection.id}:feed:invoice:ordered-a`,
        `connection:${connection.id}:feed:invoice:ordered-b`,
      ]);
    }
  });

  it('locks desired and departing claims in one order during concurrent moves', async () => {
    const { sql, workspace, connection, desired } = await seedClaimGraph();
    const secondCustomer = (await workspace.owner.entities.create({
      entity_type: 'customer',
      name: 'Move Race Customer',
    })) as { entity: { id: number } };
    const secondEdge = {
      ...desired[0],
      toEntityId: secondCustomer.entity.id,
    };

    await sql.begin((tx) =>
      reconcileConnectorRelationshipClaims(tx, {
        organizationId: workspace.org.id,
        connectionId: connection.id,
        originId: 'invoice:move-a',
        desired: [secondEdge],
      })
    );
    await sql.begin((tx) =>
      reconcileConnectorRelationshipClaims(tx, {
        organizationId: workspace.org.id,
        connectionId: connection.id,
        originId: 'invoice:move-b',
        desired,
      })
    );

    await withPausedRelationshipUpdates(() =>
      Promise.all([
        sql.begin((tx) =>
          reconcileConnectorRelationshipClaims(tx, {
            organizationId: workspace.org.id,
            connectionId: connection.id,
            originId: 'invoice:move-a',
            desired,
          })
        ),
        sql.begin((tx) =>
          reconcileConnectorRelationshipClaims(tx, {
            organizationId: workspace.org.id,
            connectionId: connection.id,
            originId: 'invoice:move-b',
            desired: [secondEdge],
          })
        ),
      ])
    );

    const rows = await sql`
      SELECT to_entity_id, metadata
      FROM entity_relationships
      WHERE organization_id = ${workspace.org.id}
        AND deleted_at IS NULL
      ORDER BY to_entity_id
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).toEqual({
      [`connection:${connection.id}:feed:invoice:move-a`]: {},
    });
    expect(rows[1].metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).toEqual({
      [`connection:${connection.id}:feed:invoice:move-b`]: {},
    });
  });

  it('uses the same existing-row lock order in batch and claim writers', async () => {
    const { sql, workspace, connection, desired } = await seedClaimGraph();
    const secondCustomer = (await workspace.owner.entities.create({
      entity_type: 'customer',
      name: 'Cross Writer Customer',
    })) as { entity: { id: number } };
    const secondEdge = {
      ...desired[0],
      toEntityId: secondCustomer.entity.id,
    };
    const [type] = await sql`
      SELECT id FROM entity_relationship_types
      WHERE organization_id = ${workspace.org.id} AND slug = 'invoice_customer'
    `;

    // Create the lexicographically later triple first so row-id and triple order
    // disagree. The two writers must still prelock both existing rows by id.
    await sql.begin((tx) =>
      reconcileConnectorRelationshipClaims(tx, {
        organizationId: workspace.org.id,
        connectionId: connection.id,
        originId: 'invoice:cross-writer',
        desired: [secondEdge],
      })
    );
    await upsertEdges({
      db: sql,
      organizationId: workspace.org.id,
      relationshipTypeId: Number(type.id),
      pairs: [desired[0]],
      source: 'feed',
      claimKey: 'config:cross-writer-seed',
      onConflict: 'ignore',
    });

    await withPausedRelationshipUpdates(() =>
      Promise.all([
        upsertEdges({
          db: sql,
          organizationId: workspace.org.id,
          relationshipTypeId: Number(type.id),
          pairs: [desired[0], secondEdge],
          source: 'feed',
          claimKey: 'config:cross-writer-batch',
          onConflict: 'ignore',
        }),
        sql.begin((tx) =>
          reconcileConnectorRelationshipClaims(tx, {
            organizationId: workspace.org.id,
            connectionId: connection.id,
            originId: 'invoice:cross-writer',
            desired,
          })
        ),
      ])
    );

    const rows = await sql`
      SELECT to_entity_id, metadata
      FROM entity_relationships
      WHERE organization_id = ${workspace.org.id}
        AND relationship_type_id = ${type.id}
        AND deleted_at IS NULL
      ORDER BY to_entity_id
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).toEqual({
      'config:cross-writer-seed': {},
      'config:cross-writer-batch': {},
      [`connection:${connection.id}:feed:invoice:cross-writer`]: {},
    });
    expect(rows[1].metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).toEqual({
      'config:cross-writer-batch': {},
    });
  });

  it('fails closed on an unclaimed pre-cutover row instead of silently adopting it', async () => {
    const { sql, workspace, connection, invoice, customer, desired } = await seedClaimGraph();
    const [type] = await sql`
      SELECT id FROM entity_relationship_types
      WHERE organization_id = ${workspace.org.id} AND slug = 'invoice_customer'
    `;
    await sql`
      INSERT INTO entity_relationships (
        organization_id, from_entity_id, to_entity_id, relationship_type_id,
        metadata, source, created_at, updated_at
      ) VALUES (
        ${workspace.org.id}, ${invoice.entity.id}, ${customer.entity.id}, ${type.id},
        ${sql.json({ migrated: false })}, 'api', NOW(), NOW()
      )
    `;

    await expect(
      sql.begin((tx) =>
        reconcileConnectorRelationshipClaims(tx, {
          organizationId: workspace.org.id,
          connectionId: connection.id,
          originId: 'invoice:needs-migration',
          desired,
        })
      )
    ).rejects.toThrow(/_lobu_claims.*migrate/i);

    const [unchanged] = await sql`
      SELECT metadata FROM entity_relationships WHERE organization_id = ${workspace.org.id}
    `;
    expect(unchanged.metadata).toEqual({ migrated: false });
  });

  it('retracts every claim one connection owns on a co-owned edge in one pass', async () => {
    const { sql, workspace, connection, invoice, customer, desired } = await seedClaimGraph();
    await workspace.owner.entities.link({
      from_entity_id: invoice.entity.id,
      to_entity_id: customer.entity.id,
      relationship_type_slug: 'invoice_customer',
    });
    for (const originId of ['invoice:source-a', 'invoice:source-b']) {
      await sql.begin((tx) =>
        reconcileConnectorRelationshipClaims(tx, {
          organizationId: workspace.org.id,
          connectionId: connection.id,
          originId,
          desired,
        })
      );
    }
    const [type] = await sql`
      SELECT id FROM entity_relationship_types
      WHERE organization_id = ${workspace.org.id} AND slug = 'invoice_customer'
    `;
    for (const owner of ['config:access-graph', 'config:channel-about:invoices']) {
      await upsertEdges({
        db: sql,
        organizationId: workspace.org.id,
        relationshipTypeId: Number(type.id),
        pairs: [
          { fromEntityId: invoice.entity.id, toEntityId: customer.entity.id },
        ],
        source: 'feed',
        claimKey: connectionRelationshipClaimKey(connection.id, owner),
        onConflict: 'ignore',
      });
    }
    await sql.begin((tx) =>
      retractConnectionRelationshipClaims(tx, {
        organizationId: workspace.org.id,
        connectionId: connection.id,
      })
    );

    const [row] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships
      WHERE organization_id = ${workspace.org.id}
    `;
    expect(row.deleted_at).toBeNull();
    expect(row.metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).toEqual({ manual: {} });
  });

  it('retracts a connection-owned authorization edge with scoped ACL privilege', async () => {
    const { sql, workspace, connection, invoice, customer } = await seedClaimGraph();
    const typeId = await ensureRelationshipType({
      organizationId: workspace.org.id,
      slug: 'acl_claim_probe',
      name: 'ACL claim probe',
      description: 'Authorization edge owned by a connection',
      purpose: PURPOSE_AUTHORIZATION,
    });
    const relationshipIds = await withAclEdgeWrite(sql, (tx) =>
      upsertEdges({
        db: tx,
        organizationId: workspace.org.id,
        relationshipTypeId: typeId,
        pairs: [
          { fromEntityId: invoice.entity.id, toEntityId: customer.entity.id },
        ],
        source: 'feed',
        claimKey: connectionRelationshipClaimKey(connection.id, 'config:access-graph'),
        onConflict: 'ignore',
      })
    );
    expect(relationshipIds).toHaveLength(1);
    const relationshipId = relationshipIds[0];

    await sql.begin((tx) =>
      retractConnectionRelationshipClaims(tx, {
        organizationId: workspace.org.id,
        connectionId: connection.id,
      })
    );

    const [row] = await sql`
      SELECT deleted_at FROM entity_relationships WHERE id = ${relationshipId}
    `;
    expect(row.deleted_at).not.toBeNull();
  });

  it('keeps link duplicate semantics when a connector already owns the edge', async () => {
    const { sql, workspace, connection, invoice, customer, desired } = await seedClaimGraph();
    await sql.begin((tx) =>
      reconcileConnectorRelationshipClaims(tx, {
        organizationId: workspace.org.id,
        connectionId: connection.id,
        originId: 'invoice:source',
        desired,
      })
    );

    await expect(
      workspace.owner.entities.link({
        from_entity_id: invoice.entity.id,
        to_entity_id: customer.entity.id,
        relationship_type_slug: 'invoice_customer',
        metadata: { requested: 'must-not-be-dropped' },
      })
    ).rejects.toThrow(/already exists/i);

    const [row] = await sql`
      SELECT metadata FROM entity_relationships WHERE organization_id = ${workspace.org.id}
    `;
    expect(row.metadata).not.toHaveProperty('requested');
    expect(Object.keys(row.metadata[RELATIONSHIP_CLAIMS_METADATA_KEY])).toEqual([
      `connection:${connection.id}:feed:invoice:source`,
    ]);
  });

  it('keeps auto-linked mention guesses manually removable', async () => {
    const { sql, workspace, invoice, customer } = await seedClaimGraph();
    await autoLinkEvent({
      eventId: 1,
      entityIds: [invoice.entity.id],
      content: 'Race Customer is mentioned here.',
      organizationId: workspace.org.id,
    });

    const [row] = await sql`
      SELECT r.id, r.metadata, r.confidence, r.source
      FROM entity_relationships r
      JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
      WHERE r.organization_id = ${workspace.org.id}
        AND r.from_entity_id = ${invoice.entity.id}
        AND r.to_entity_id = ${customer.entity.id}
        AND rt.slug = 'mentions'
        AND r.deleted_at IS NULL
    `;
    expect(row.metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).toEqual({ manual: {} });
    expect(row.confidence).toBe(0.4);
    expect(row.source).toBe('feed');

    await workspace.owner.entities.unlink({
      relationship_id: Number(row.id),
    });

    const [removed] = await sql`
      SELECT deleted_at FROM entity_relationships WHERE id = ${row.id}
    `;
    expect(removed.deleted_at).not.toBeNull();
  });

  // The same fail-closed rule the migration header documents, from the caller
  // surface: an unclaimed row is not manually owned either, so manage_entity
  // refuses it instead of guessing who asserts it.
  it('refuses manual mutation of an unclaimed relationship', async () => {
    const { sql, workspace, invoice, customer } = await seedClaimGraph();
    const [type] = await sql`
      SELECT id FROM entity_relationship_types
      WHERE organization_id = ${workspace.org.id} AND slug = 'invoice_customer'
    `;
    const [unclaimed] = await sql`
      INSERT INTO entity_relationships (
        organization_id, from_entity_id, to_entity_id, relationship_type_id,
        source, created_at, updated_at
      ) VALUES (
        ${workspace.org.id}, ${invoice.entity.id}, ${customer.entity.id}, ${type.id},
        'api', NOW(), NOW()
      )
      RETURNING id
    `;

    await expect(
      workspace.owner.entities.updateLink({
        relationship_id: Number(unclaimed.id),
        confidence: 0.5,
      })
    ).rejects.toThrow(/_lobu_claims/);
    await expect(
      workspace.owner.entities.unlink({
        relationship_id: Number(unclaimed.id),
      })
    ).rejects.toThrow(/_lobu_claims/);

    const [live] = await sql`
      SELECT deleted_at, confidence FROM entity_relationships WHERE id = ${unclaimed.id}
    `;
    expect(live.deleted_at).toBeNull();
    expect(live.confidence).toBeNull();
  });
});
