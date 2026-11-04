import XConnector, { followedAccountToEvent } from '@lobu/connectors/x';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEventAttributions,
  clearEntityLinkRulesCache,
} from '../../../utils/entity-link-upsert';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const connectorKey = 'x';
const feedKey = 'following';
const follower = { id: '1000000001', handle: 'testuser' };

/** Synthetic accounts: one person, one X Verified Organization (Business). */
function followedAccounts() {
  const observedAt = new Date('2026-11-01T00:00:00.000Z');
  return [
    followedAccountToEvent(
      {
        id: '2001',
        handle: 'Synth_Person',
        name: 'Synthetic Person',
        createdAt: 'Wed Jun 04 12:00:00 +0000 2014',
      },
      follower,
      observedAt
    ),
    followedAccountToEvent(
      {
        id: '2002',
        handle: 'synthetic_co',
        name: 'Synthetic Co',
        verifiedType: 'Business',
        profileImageShape: 'Square',
        createdAt: 'Mon Jan 02 09:00:00 +0000 2012',
      },
      follower,
      observedAt
    ),
  ];
}

/** The REAL X connector rules, so the person/company split is the shipped one. */
describe('X following attribution (real connector rules)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  async function seed() {
    const sql = getTestDb();
    const organization = await createTestOrganization({ name: 'X Following Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, organization.id, 'owner');
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES
        (${organization.id}, 'person', 'Person', current_timestamp, current_timestamp),
        (${organization.id}, 'company', 'Company', current_timestamp, current_timestamp)
    `;
    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'X',
      organization_id: organization.id,
      feeds_schema: new XConnector().definition.feeds as Record<
        string,
        Record<string, unknown>
      >,
    });
    const connection = await createTestConnection({
      organization_id: organization.id,
      connector_key: connectorKey,
      created_by: user.id,
    });
    clearEntityLinkRulesCache();
    return { organizationId: organization.id, connectionId: Number(connection.id) };
  }

  async function entities(organizationId: string, type: string) {
    return getTestDb()<{ id: number; name: string }[]>`
      SELECT e.id, e.name
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${organizationId}
        AND et.slug = ${type}
        AND e.deleted_at IS NULL
      ORDER BY e.name COLLATE "C"
    `;
  }

  async function ingest(organizationId: string, connectionId: number) {
    const items = followedAccounts();
    const resolved = await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: organizationId,
      items,
    });
    const inserted = [];
    for (const [index, item] of items.entries()) {
      inserted.push(
        await insertEvent(
          {
            entityIds: resolved.entityIdsByItem.get(index) ?? [],
            organizationId,
            connectionId,
            originId: item.origin_id,
            content: item.payload_text,
            authorName: item.author_name,
            sourceUrl: item.source_url,
            occurredAt: item.occurred_at,
            semanticType: item.origin_type ?? 'content',
            originType: item.origin_type,
            connectorKey,
            metadata: item.metadata,
          },
          { onConflictUpdate: true }
        )
      );
    }
    return { resolved, inserted };
  }

  it('creates a person for a normal account and a company for a Verified Organization, and a re-sync links without duplicating', async () => {
    const { organizationId, connectionId } = await seed();

    const first = await ingest(organizationId, connectionId);
    const people = await entities(organizationId, 'person');
    const companies = await entities(organizationId, 'company');
    // The connected account is the performer, so it is a person too.
    expect(people.map((person) => person.name)).toEqual(['@testuser', 'Synthetic Person']);
    expect(companies.map((company) => company.name)).toEqual(['Synthetic Co']);
    const syntheticPerson = people.find((person) => person.name === 'Synthetic Person')!;
    expect(first.resolved.entityIdsByItem.get(0)).toContain(syntheticPerson.id);
    expect(first.resolved.entityIdsByItem.get(1)).toContain(companies[0].id);

    // A later walk sees the same accounts again.
    const second = await ingest(organizationId, connectionId);
    expect(await entities(organizationId, 'person')).toEqual(people);
    expect(await entities(organizationId, 'company')).toEqual(companies);
    expect(second.resolved.entityIdsByItem.get(1)).toContain(companies[0].id);

    // Identical data re-observed is neither a new event nor a new version.
    expect(second.inserted.map((row) => row.change)).toEqual(['unchanged', 'unchanged']);
    expect(second.inserted.map((row) => row.id)).toEqual(first.inserted.map((row) => row.id));
    const versions = await getTestDb()<{ count: number }[]>`
      SELECT count(*)::int AS count FROM events
      WHERE organization_id = ${organizationId} AND connector_key = ${connectorKey}
    `;
    expect(versions[0].count).toBe(2);
  });
});
