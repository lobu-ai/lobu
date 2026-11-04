import LinkedInConnector from '@lobu/connectors/linkedin';
import { LINKEDIN_IDENTITY } from '@lobu/connectors/linkedin-identity';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEventAttributions,
  clearEntityLinkRulesCache,
} from '../../../utils/entity-link-upsert';
import { entityLinkMatchSql } from '../../../utils/content-search/entity-link';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const connectorKey = 'linkedin';
const feedKey = 'home_feed';

async function seedOrganization(): Promise<string> {
  const sql = getTestDb();
  const organization = await createTestOrganization({
    name: 'LinkedIn Recall Org',
  });
  const user = await createTestUser();
  await addUserToOrganization(user.id, organization.id, 'owner');
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${organization.id}, 'person', 'Person', current_timestamp, current_timestamp)
  `;
  await createTestConnectorDefinition({
    key: connectorKey,
    name: 'LinkedIn',
    organization_id: organization.id,
    feeds_schema: {
      [feedKey]: {
        eventKinds: {
          post: {
            attributions: [
              {
                role: 'authored_by',
                autoCreate: true,
                target: {
                  entityType: 'person',
                  titlePath: 'metadata.author',
                  identities: [
                    {
                      namespace: LINKEDIN_IDENTITY.MEMBER_ID,
                      eventPath: 'metadata.author_member_id',
                    },
                    {
                      namespace: LINKEDIN_IDENTITY.SLUG,
                      eventPath: 'metadata.author_linkedin_slug',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });
  clearEntityLinkRulesCache();
  return organization.id;
}

describe('LinkedIn person event recall', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('recalls persisted posts through slug-only and member-id identities', async () => {
    const organizationId = await seedOrganization();
    const sql = getTestDb();
    const items: Array<{
      origin_type: string;
      metadata: Record<string, unknown>;
    }> = [
      {
        origin_type: 'post',
        metadata: {
          author: 'Jane Doe',
          author_linkedin_slug: 'Jane-Doe',
        },
      },
      {
        origin_type: 'post',
        metadata: {
          author: 'John Doe',
          author_member_id: 'urn:li:fsd_profile:ACoAAB1234',
        },
      },
    ];

    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: organizationId,
      items,
    });

    expect(items[0].metadata.linkedin_slug).toBe('jane-doe');
    expect(items[1].metadata.linkedin_member_id).toBe('ACoAAB1234');

    const inserted = await Promise.all(
      items.map((item, index) =>
        insertEvent({
          entityIds: [],
          organizationId,
          originId: `linkedin-post-${index + 1}`,
          semanticType: 'post',
          title: `LinkedIn post ${index + 1}`,
          originType: 'post',
          connectorKey,
          metadata: item.metadata,
        }),
      ),
    );

    const people = await sql<{ id: number; name: string }[]>`
      SELECT e.id, e.name
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${organizationId}
        AND et.slug = 'person'
        AND e.deleted_at IS NULL
      ORDER BY e.name
    `;
    expect(people.map((person) => person.name)).toEqual([
      'Jane Doe',
      'John Doe',
    ]);

    const eventIdsFor = async (entityId: number): Promise<number[]> => {
      const rows = await sql<{ id: number }[]>`
        SELECT f.id
        FROM events f
        WHERE f.organization_id = ${organizationId}
          AND ${sql.unsafe(entityLinkMatchSql(`${entityId}::bigint`, 'f'))}
        ORDER BY f.id
      `;
      return rows.map((row) => Number(row.id));
    };

    expect(await eventIdsFor(people[0].id)).toEqual([Number(inserted[0].id)]);
    expect(await eventIdsFor(people[1].id)).toEqual([Number(inserted[1].id)]);
  });
});

/**
 * The REAL LinkedIn home_feed rules, not a hand-built copy, so a regression in
 * the connector's declared company author or engager gate fails at the
 * pipeline level where the company graph and the reactor flood actually land.
 */
describe('LinkedIn home_feed attribution (real connector rules)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  async function seedRealRules(): Promise<string> {
    const sql = getTestDb();
    const organization = await createTestOrganization({
      name: 'LinkedIn Real Rules Org',
    });
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
      name: 'LinkedIn',
      organization_id: organization.id,
      feeds_schema: new LinkedInConnector().definition.feeds as Record<
        string,
        unknown
      >,
    });
    clearEntityLinkRulesCache();
    return organization.id;
  }

  async function entityNames(organizationId: string, type: string) {
    const rows = await getTestDb()<{ name: string; metadata: { linkedin_url?: string } }[]>`
      SELECT e.name, e.metadata
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${organizationId}
        AND et.slug = ${type}
        AND e.deleted_at IS NULL
      ORDER BY e.name
    `;
    return rows;
  }

  const engagementPost = (createEngagerPeople: boolean, engager: string) => ({
    origin_type: 'post',
    author_name: 'Fixture Author',
    metadata: {
      author: 'Fixture Author',
      author_linkedin_slug: 'fixture-author',
      author_profile_url: 'https://www.linkedin.com/in/fixture-author',
      social_actor: engager,
      social_action: 'like',
      social_actor_slug: engager.toLowerCase().replace(/ /g, '-'),
      create_engager_people: createEngagerPeople,
    },
  });

  it('creates a company author keyed on its company slug', async () => {
    const organizationId = await seedRealRules();
    const companyPost = {
      origin_type: 'post',
      author_name: 'Synthetic Co',
      metadata: {
        author: 'Synthetic Co',
        author_company_slug: 'synthetic-co',
        author_company_url: 'https://www.linkedin.com/company/synthetic-co',
        create_engager_people: true,
      },
    };
    const resolved = await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: organizationId,
      items: [companyPost],
    });

    const companies = await entityNames(organizationId, 'company');
    expect(companies).toEqual([
      {
        name: 'Synthetic Co',
        metadata: expect.objectContaining({
          linkedin_url: 'https://www.linkedin.com/company/synthetic-co',
        }),
      },
    ]);
    expect(await entityNames(organizationId, 'person')).toEqual([]);
    expect(resolved.namedEntityIdsByItem.get(0)?.has('company_author')).toBe(
      true
    );
  });

  it('create_engager_people off links a known reactor but creates no new reactor', async () => {
    const organizationId = await seedRealRules();
    // A reactor already in the graph (created while the switch was on).
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: organizationId,
      items: [engagementPost(true, 'Known Reactor')],
    });
    expect(
      (await entityNames(organizationId, 'person')).map((p) => p.name)
    ).toEqual(['Fixture Author', 'Known Reactor']);

    const knownAgain = engagementPost(false, 'Known Reactor');
    const stranger = engagementPost(false, 'Stranger Reactor');
    const resolved = await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: organizationId,
      items: [knownAgain, stranger],
    });

    // No person for the stranger; the author still resolves.
    expect(
      (await entityNames(organizationId, 'person')).map((p) => p.name)
    ).toEqual(['Fixture Author', 'Known Reactor']);
    expect(resolved.namedEntityIdsByItem.get(0)?.has('engager')).toBe(true);
    expect(resolved.namedEntityIdsByItem.get(1)?.has('engager')).toBe(false);
    expect(resolved.namedEntityIdsByItem.get(1)?.has('author')).toBe(true);
  });
});
