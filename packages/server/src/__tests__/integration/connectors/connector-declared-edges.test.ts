/**
 * Connector-declared relationship E2E.
 *
 * Drives the real connector definition -> attribution -> worker stream ->
 * event/relationship transaction used by CRM and ERP feeds.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { parsePgNumberArray } from '../../../db/client';
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { entityLinkMatchSql } from '../../../utils/content-search/entity-link';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { post } from '../../setup/test-helpers';
import {
  createTestConnection,
  createTestConnectorDefinition,
} from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const CONNECTOR_KEY = 'erp-crm-relationships';
const FEED_KEY = 'invoices';

describe('connector-declared relationships', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('materializes a source-owned invoice -> customer edge through worker ingestion', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'ERP CRM Relationship E2E' });
    await workspace.owner.entity_schema.createType({ slug: 'invoice', name: 'Invoice' });
    await workspace.owner.entity_schema.createType({ slug: 'customer', name: 'Customer' });
    await workspace.owner.entity_schema.createRelType({
      slug: 'invoice_customer',
      name: 'Invoice Customer',
    });
    await workspace.owner.entity_schema.addRule({
      slug: 'invoice_customer',
      source_entity_type_slug: 'invoice',
      target_entity_type_slug: 'customer',
    });
    await createTestConnectorDefinition({
      key: CONNECTOR_KEY,
      name: 'ERP CRM Relationships',
      organization_id: workspace.org.id,
      feeds_schema: {
        [FEED_KEY]: {
          eventKinds: {
            invoice: {
              attributions: [
                {
                  name: 'invoice',
                  role: 'belongs_to',
                  autoCreate: true,
                  target: {
                    entityType: 'invoice',
                    titlePath: 'metadata.invoice_number',
                    identities: [
                      { namespace: 'erp_invoice_id', eventPath: 'metadata.invoice_id' },
                    ],
                  },
                },
                {
                  name: 'customer',
                  role: 'about',
                  autoCreate: true,
                  target: {
                    entityType: 'customer',
                    titlePath: 'metadata.customer_name',
                    identities: [
                      { namespace: 'crm_customer_id', eventPath: 'metadata.customer_id' },
                      {
                        namespace: 'email',
                        eventPath: 'metadata.customer_email',
                      },
                    ],
                  },
                },
              ],
              relationships: [
                { type: 'invoice_customer', from: 'invoice', to: 'customer' },
              ],
            },
          },
        },
      },
    });
    const connection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: CONNECTOR_KEY,
      created_by: workspace.users.owner.id,
      createDefaultFeed: false,
    });
    const manualInvoice = (await workspace.owner.entities.create({
      entity_type: 'invoice',
      name: 'INV-1001',
    })) as { entity: { id: number } };
    const manualCustomer = (await workspace.owner.entities.create({
      entity_type: 'customer',
      name: 'Acme Ltd',
    })) as { entity: { id: number } };
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES
        (${workspace.org.id}, ${manualInvoice.entity.id}, 'erp_invoice_id', 'inv-1001'),
        (${workspace.org.id}, ${manualCustomer.entity.id}, 'crm_customer_id', 'cust-42')
    `;
    const manualAssertion = (await workspace.owner.entities.link({
      from_entity_id: manualInvoice.entity.id,
      to_entity_id: manualCustomer.entity.id,
      relationship_type_slug: 'invoice_customer',
    })) as { relationship: { metadata: Record<string, unknown> | null } };
    expect(manualAssertion.relationship.metadata).toBeNull();
    const [feed] = await sql`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, status, created_at, updated_at
      ) VALUES (
        ${workspace.org.id}, ${connection.id}, ${FEED_KEY}, 'active', NOW(), NOW()
      )
      RETURNING id
    `;
    const [run] = await sql`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id, connector_key,
        connector_version, status, approval_status, created_at
      ) VALUES (
        ${workspace.org.id}, 'sync', ${feed.id}, ${connection.id}, ${CONNECTOR_KEY},
        '1.0.0', 'running', 'auto', NOW()
      )
      RETURNING id
    `;

    const originId = 'invoice:inv-1001';
    const response = await post('/api/workers/stream', {
      body: {
        type: 'batch',
        run_id: Number(run.id),
        items: [
          {
            id: originId,
            origin_type: 'invoice',
            title: 'Invoice INV-1001',
            payload_text: 'Invoice INV-1001 belongs to Acme Ltd',
            metadata: {
              invoice_id: 'inv-1001',
              invoice_number: 'INV-1001',
              customer_id: 'cust-42',
              customer_name: 'Acme Ltd',
            },
          },
        ],
      },
    });
    expect(response.status).toBe(200);

    const edges = await sql`
      SELECT r.id, r.from_entity_id, r.to_entity_id,
             fe.name AS from_name, te.name AS to_name, rt.slug AS type, r.metadata
      FROM entity_relationships r
      JOIN entities fe ON fe.id = r.from_entity_id
      JOIN entities te ON te.id = r.to_entity_id
      JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
      WHERE r.organization_id = ${workspace.org.id}
        AND r.deleted_at IS NULL
        AND rt.slug = 'invoice_customer'
    `;
    expect(edges).toHaveLength(1);
    const recalledInvoiceEvents = await sql.unsafe(
      `SELECT e.id, e.entity_ids FROM events e
       WHERE e.organization_id = $1 AND e.origin_type = 'invoice'
         AND ${entityLinkMatchSql('$2', 'e')}`,
      [workspace.org.id, manualInvoice.entity.id],
    );
    expect(recalledInvoiceEvents).toHaveLength(1);
    expect(parsePgNumberArray(recalledInvoiceEvents[0].entity_ids).sort((a, b) => a - b)).toEqual(
      [manualInvoice.entity.id, manualCustomer.entity.id].sort((a, b) => a - b)
    );
    expect(edges[0]).toMatchObject({
      from_name: 'INV-1001',
      to_name: 'Acme Ltd',
      type: 'invoice_customer',
      metadata: {
        _lobu_claims: {
          manual: {},
          [`connection:${connection.id}:feed:${originId}`]: {},
        },
      },
    });

    // The connector merged its claim into the manual graph fact instead of
    // creating a duplicate row. Each owner can retract independently.
    const [coOwned] = await sql`
      SELECT metadata FROM entity_relationships WHERE id = ${edges[0].id}
    `;
    expect(Object.keys(coOwned.metadata._lobu_claims).sort()).toEqual([
      `connection:${connection.id}:feed:${originId}`,
      'manual',
    ]);

    // A temporarily ambiguous endpoint is not evidence that the source item
    // withdrew its previous assertion. Preserve the existing connector claim
    // until every referenced attribution resolves again.
    const conflictingCustomer = (await workspace.owner.entities.create({
      entity_type: 'customer',
      name: 'Rival GmbH',
    })) as { entity: { id: number } };
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES (
        ${workspace.org.id},
        ${conflictingCustomer.entity.id},
        'email',
        'rival@example.com'
      )
    `;
    const ambiguous = await post('/api/workers/stream', {
      body: {
        type: 'batch',
        run_id: Number(run.id),
        items: [
          {
            id: originId,
            origin_type: 'invoice',
            title: 'Invoice INV-1001',
            payload_text: 'Invoice INV-1001 has an ambiguous customer identity',
            metadata: {
              invoice_id: 'inv-1001',
              invoice_number: 'INV-1001',
              customer_id: 'cust-42',
              customer_email: 'rival@example.com',
              customer_name: 'Acme Ltd',
            },
          },
        ],
      },
    });
    expect(ambiguous.status).toBe(200);
    const [afterAmbiguousResolution] = await sql`
      SELECT metadata FROM entity_relationships WHERE id = ${edges[0].id}
    `;
    expect(afterAmbiguousResolution.metadata._lobu_claims).toHaveProperty(
      `connection:${connection.id}:feed:${originId}`
    );

    // A present but malformed identity is also an unresolved read, not proof
    // that the source withdrew the endpoint.
    const malformed = await post('/api/workers/stream', {
      body: {
        type: 'batch',
        run_id: Number(run.id),
        items: [
          {
            id: originId,
            origin_type: 'invoice',
            title: 'Invoice INV-1001',
            payload_text: 'Invoice INV-1001 carries an invalid customer email',
            metadata: {
              invoice_id: 'inv-1001',
              invoice_number: 'INV-1001',
              customer_email: 'not-an-email',
              customer_name: 'Acme Ltd',
            },
          },
        ],
      },
    });
    expect(malformed.status).toBe(200);
    const [afterMalformedIdentity] = await sql`
      SELECT metadata FROM entity_relationships WHERE id = ${edges[0].id}
    `;
    expect(afterMalformedIdentity.metadata._lobu_claims).toHaveProperty(
      `connection:${connection.id}:feed:${originId}`
    );

    // An endpoint the item stops mentioning at all IS a withdrawal, and stays
    // distinct from the unresolved case above: the connector claim is retracted
    // while the co-owning manual claim keeps the graph fact live.
    const withdrawn = await post('/api/workers/stream', {
      body: {
        type: 'batch',
        run_id: Number(run.id),
        items: [
          {
            id: originId,
            origin_type: 'invoice',
            title: 'Invoice INV-1001',
            payload_text: 'Invoice INV-1001 no longer names a customer',
            metadata: { invoice_id: 'inv-1001', invoice_number: 'INV-1001' },
          },
        ],
      },
    });
    expect(withdrawn.status).toBe(200);
    const [afterWithdrawal] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${edges[0].id}
    `;
    expect(afterWithdrawal.deleted_at).toBeNull();
    expect(afterWithdrawal.metadata._lobu_claims).toEqual({ manual: {} });

    // Restore the connector claim for the rest of the lifecycle below.
    const reasserted = await post('/api/workers/stream', {
      body: {
        type: 'batch',
        run_id: Number(run.id),
        items: [
          {
            id: originId,
            origin_type: 'invoice',
            title: 'Invoice INV-1001',
            payload_text: 'Invoice INV-1001 belongs to Acme Ltd',
            metadata: {
              invoice_id: 'inv-1001',
              invoice_number: 'INV-1001',
              customer_id: 'cust-42',
              customer_name: 'Acme Ltd',
            },
          },
        ],
      },
    });
    expect(reasserted.status).toBe(200);
    const [afterReassertion] = await sql`
      SELECT metadata FROM entity_relationships WHERE id = ${edges[0].id}
    `;
    expect(Object.keys(afterReassertion.metadata._lobu_claims).sort()).toEqual([
      `connection:${connection.id}:feed:${originId}`,
      'manual',
    ]);

    await workspace.owner.entities.updateLink({
      relationship_id: Number(edges[0].id),
      metadata: { reviewed: true },
    });
    const [afterManualUpdate] = await sql`
      SELECT metadata FROM entity_relationships WHERE id = ${edges[0].id}
    `;
    expect(afterManualUpdate.metadata).toMatchObject({
      reviewed: true,
      _lobu_claims: {
        manual: {},
        [`connection:${connection.id}:feed:${originId}`]: expect.any(Object),
      },
    });

    // Resyncing the same durable source item to a different customer moves only
    // its connector claim. The old relationship stays live because manual still
    // asserts it; the new relationship is connector-owned.
    const moved = await post('/api/workers/stream', {
      body: {
        type: 'batch',
        run_id: Number(run.id),
        items: [
          {
            id: originId,
            origin_type: 'invoice',
            title: 'Invoice INV-1001',
            payload_text: 'Invoice INV-1001 now belongs to Beta GmbH',
            metadata: {
              invoice_id: 'inv-1001',
              invoice_number: 'INV-1001',
              customer_id: 'cust-84',
              customer_name: 'Beta GmbH',
            },
          },
        ],
      },
    });
    expect(moved.status).toBe(200);

    const liveAfterMove = await sql`
      SELECT r.id, r.from_entity_id, r.to_entity_id, te.name AS to_name, r.metadata
      FROM entity_relationships r
      JOIN entities te ON te.id = r.to_entity_id
      JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
      WHERE r.organization_id = ${workspace.org.id}
        AND r.deleted_at IS NULL
        AND rt.slug = 'invoice_customer'
      ORDER BY te.name
    `;
    expect(liveAfterMove).toHaveLength(2);
    const oldManual = liveAfterMove.find((row) => row.to_name === 'Acme Ltd');
    const newSource = liveAfterMove.find((row) => row.to_name === 'Beta GmbH');
    expect(oldManual?.metadata).toEqual({ reviewed: true, _lobu_claims: { manual: {} } });
    expect(Object.keys(newSource?.metadata._lobu_claims ?? {})).toEqual([
      `connection:${connection.id}:feed:${originId}`,
    ]);

    await expect(
      workspace.owner.entities.unlink({
        relationship_id: Number(newSource?.id),
      })
    ).rejects.toThrow(/source-managed/i);

    // Removing the declaration is also a complete desired-set change. A later
    // resync of the same durable source item must retract its old claim instead
    // of leaving the relationship live forever merely because the new plan has
    // zero declarations to iterate.
    await sql`
      UPDATE connector_definitions
      SET feeds_schema = jsonb_set(
            feeds_schema,
            ARRAY[${FEED_KEY}, 'eventKinds', 'invoice', 'relationships']::text[],
            '[]'::jsonb,
            false
          ),
          updated_at = NOW()
      WHERE organization_id = ${workspace.org.id}
        AND key = ${CONNECTOR_KEY}
        AND status = 'active'
    `;
    clearEntityLinkRulesCache();
    const withoutDeclaration = await post('/api/workers/stream', {
      body: {
        type: 'batch',
        run_id: Number(run.id),
        items: [
          {
            id: originId,
            origin_type: 'invoice',
            title: 'Invoice INV-1001',
            payload_text: 'Invoice INV-1001 now belongs to Beta GmbH',
            metadata: {
              invoice_id: 'inv-1001',
              invoice_number: 'INV-1001',
              customer_id: 'cust-84',
              customer_name: 'Beta GmbH',
            },
          },
        ],
      },
    });
    expect(withoutDeclaration.status).toBe(200);
    const [sourceAfterDeclarationRemoval] = await sql`
      SELECT deleted_at FROM entity_relationships WHERE id = ${newSource?.id}
    `;
    expect(sourceAfterDeclarationRemoval.deleted_at).not.toBeNull();

    await workspace.owner.entities.unlink({
      relationship_id: Number(oldManual?.id),
    });
    const [oldAfterUnlink] = await sql`
      SELECT deleted_at FROM entity_relationships WHERE id = ${oldManual?.id}
    `;
    expect(oldAfterUnlink.deleted_at).not.toBeNull();

    // Connection deletion retracts its remaining claims in the same durable
    // lifecycle transaction, so no connector-owned graph fact is orphaned.
    const deleted = (await workspace.owner.connections.delete(connection.id)) as {
      deleted?: boolean;
    };
    expect(deleted.deleted).toBe(true);
    const [remaining] = await sql`
      SELECT count(*)::int AS count
      FROM entity_relationships r
      JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
      WHERE r.organization_id = ${workspace.org.id}
        AND r.deleted_at IS NULL
        AND rt.slug = 'invoice_customer'
    `;
    expect(Number(remaining.count)).toBe(0);
  });
});
