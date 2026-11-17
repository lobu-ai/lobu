import LinkedInConnector from '@lobu/connectors/linkedin';
import { LINKEDIN_IDENTITY } from '@lobu/connectors/linkedin-identity';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { materializeDueFeeds } from '../../../scheduled/check-due-feeds';
import { ingestConnectorItems } from '../../../worker-api/run-lifecycle';
import {
  applyEventAttributions,
  clearEntityLinkRulesCache,
} from '../../../utils/entity-link-upsert';
import { entityLinkMatchSql } from '../../../utils/content-search/entity-link';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
  declaredFeedsSchema,
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

/**
 * Stored 1:1 messages through the real ingestion path and the REAL connector
 * declaration: every message, whoever sent it, lands on the person on the
 * other side, an already-known person is found rather than duplicated, a
 * re-sync stores nothing twice, and the feed only runs once it is scheduled.
 */
describe('LinkedIn direct_messages (real connector rules)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  const SELF = 'urn:li:fsd_profile:synthetic-self';
  const DM = `urn:li:msg_conversation:(${SELF},2-synthetic-dm==)`;
  const DM_SAM = `urn:li:msg_conversation:(${SELF},2-synthetic-dm-sam==)`;
  const message = (
    id: string,
    conversation: string,
    thread: string,
    sender: { name: string; memberId: string; slug?: string; fromMe: boolean },
    counterpart: { name: string; memberId: string; slug?: string },
    text: string,
    occurredAt: string,
  ) => ({
    id: `urn:li:msg_message:(${SELF},${id})`,
    origin_type: 'message',
    origin_parent_id: thread,
    payload_text: text,
    author_name: sender.name,
    source_url: `https://www.linkedin.com/messaging/thread/${thread}/`,
    occurred_at: occurredAt,
    metadata: {
      conversation_id: conversation,
      content_kind: 'text',
      has_attachments: false,
      from_me: sender.fromMe,
      sender_member_id: sender.memberId,
      ...(sender.slug ? { sender_slug: sender.slug } : {}),
      sender_name: sender.name,
      counterpart_member_id: counterpart.memberId,
      ...(counterpart.slug ? { counterpart_slug: counterpart.slug } : {}),
      counterpart_name: counterpart.name,
    },
  });

  it('links both sides of each 1:1 to the counterpart, re-ingests without duplicates, and never syncs unscheduled', async () => {
    const sql = getTestDb();
    const organization = await createTestOrganization({ name: 'LinkedIn DM Org' });
    const owner = await createTestUser();
    await addUserToOrganization(owner.id, organization.id, 'owner');
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
      feeds_schema: declaredFeedsSchema(new LinkedInConnector().definition),
    });
    clearEntityLinkRulesCache();
    const connection = await createTestConnection({
      organization_id: organization.id,
      connector_key: connectorKey,
      created_by: owner.id,
      createDefaultFeed: false,
    });
    // As create_feed stores a feed added without a schedule.
    const [feed] = await sql<{ id: number }[]>`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, next_run_at)
      VALUES (${organization.id}, ${connection.id}, 'direct_messages', 'active', NULL, NULL)
      RETURNING id
    `;
    const feedId = Number(feed.id);
    const syncRuns = async () =>
      Number(
        (
          await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM runs WHERE feed_id = ${feedId} AND run_type = 'sync'
          `
        )[0].n,
      );
    await materializeDueFeeds({} as Env, sql);
    expect(await syncRuns()).toBe(0);

    // Alex is already known from the home feed, by slug only.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: organization.id,
      items: [
        {
          origin_type: 'post',
          author_name: 'Alex Example',
          metadata: {
            author: 'Alex Example',
            author_linkedin_slug: 'alex-example-synthetic',
          },
        },
      ],
    });

    const me = { name: 'Self Member', memberId: 'synthetic-self', fromMe: true };
    const alex = { name: 'Alex Example', memberId: 'ACoAASyntheticPeer', slug: 'alex-example-synthetic' };
    // A member-id profile URL names no slug: Sam is known by member id only.
    const sam = { name: 'Sam Sample', memberId: 'ACoAASyntheticSam' };
    const items = [
      message('2-synthetic-inbound', DM, '2-synthetic-dm==', { ...alex, fromMe: false }, alex, 'Are you around?', '2023-11-14T22:13:20.000Z'),
      message('2-synthetic-reply', DM, '2-synthetic-dm==', me, alex, 'Yes, here.', '2023-11-14T22:13:20.200Z'),
      message('2-synthetic-sam', DM_SAM, '2-synthetic-dm-sam==', { ...sam, fromMe: false }, sam, 'Hello', '2023-11-14T22:13:20.100Z'),
    ];
    const target = {
      runId: null,
      workerId: null,
      organizationId: organization.id,
      connectionId: connection.id,
      connectorKey,
      feedId,
      feedKey: 'direct_messages',
      entityIds: [],
      dryRun: false,
    };
    const ingest = () => ingestConnectorItems(sql, target, structuredClone(items), null);
    expect(await ingest()).toMatchObject({ status: 'committed', totalItems: 3 });

    const people = await sql<{ id: number; name: string }[]>`
      SELECT e.id, e.name
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${organization.id}
        AND et.slug = 'person'
        AND e.deleted_at IS NULL
      ORDER BY e.name
    `;
    // Alex was found, not duplicated; nobody was minted for the sender "me".
    expect(people.map((person) => person.name)).toEqual(['Alex Example', 'Sam Sample']);

    const stored = async () =>
      sql<{ id: number; origin_id: string; origin_parent_id: string | null }[]>`
        SELECT id, origin_id, origin_parent_id
        FROM events
        WHERE connection_id = ${connection.id}
        ORDER BY origin_id
      `;
    const first = await stored();
    expect(first.map((row) => [row.origin_id, row.origin_parent_id])).toEqual([
      [items[0].id, '2-synthetic-dm=='],
      [items[1].id, '2-synthetic-dm=='],
      [items[2].id, '2-synthetic-dm-sam=='],
    ]);
    const idOf = (originId: string) => Number(first.find((row) => row.origin_id === originId)?.id);
    const linkedTo = async (entityId: number) =>
      (
        await sql<{ id: number }[]>`
          SELECT f.id
          FROM events f
          WHERE f.organization_id = ${organization.id}
            AND f.connection_id = ${connection.id}
            AND ${sql.unsafe(entityLinkMatchSql(`${entityId}::bigint`, 'f'))}
          ORDER BY f.id
        `
      ).map((row) => Number(row.id));
    expect(await linkedTo(people[0].id)).toEqual(
      [idOf(items[0].id), idOf(items[1].id)].sort((a, b) => a - b),
    );
    expect(await linkedTo(people[1].id)).toEqual([idOf(items[2].id)]);

    // The member id the message carried now identifies the slug-only person.
    const alexIdentities = await sql<{ namespace: string; identifier: string }[]>`
      SELECT namespace, identifier FROM entity_identities
      WHERE entity_id = ${people[0].id} AND deleted_at IS NULL
      ORDER BY namespace
    `;
    expect(alexIdentities).toEqual([
      { namespace: LINKEDIN_IDENTITY.MEMBER_ID, identifier: 'ACoAASyntheticPeer' },
      { namespace: LINKEDIN_IDENTITY.SLUG, identifier: 'alex-example-synthetic' },
    ]);

    // A re-sync of the same messages stores nothing new.
    await ingest();
    expect((await stored()).map((row) => Number(row.id))).toEqual(first.map((row) => Number(row.id)));

    // Scheduling the feed is what starts storage.
    await sql`
      UPDATE feeds SET schedule = '0 * * * *', next_run_at = NOW() - INTERVAL '1 minute'
      WHERE id = ${feedId}
    `;
    await materializeDueFeeds({} as Env, sql);
    expect(await syncRuns()).toBe(1);
  });
});
