/**
 * GitHub member-identity attribution contract (#17).
 *
 * Two ingestion paths must attribute a GitHub author to a tenant-scoped
 * `person`, keyed PRIMARY on the immutable `github_user_id` and SECONDARY on
 * `github_login`:
 *
 *   1. poll/sync — `applyEventAttributions` reads the connector's `attributions` rules
 *      from `connector_definitions` and resolves/creates the person.
 *   2. live record — a verified star delivery's `connector-record` job runs
 *      the connector's own `normalize` in the isolate and ingests the envelope
 *      through the same page ingest, so the SAME rules resolve the SAME person.
 *
 * Both are org-scoped end to end: entity_identities are UNIQUE per
 * (org, namespace, identifier), so a second org never resolves to another's
 * person even with the same login/id.
 */

import { fileURLToPath } from 'node:url';
import GitHubConnector from '@lobu/connectors/github';
import { createIsolateConnectorCompiler } from '@lobu/connector-worker/compile';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processConnectorRecord } from '../../../connectors/webhook-delivery';
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

const connectorKey = 'github';
const feedKey = 'issues';

/** The github person attribution rule, mirrored from the github connector. */
const githubPersonAttribution = {
  role: 'authored_by',
  autoCreate: true,
  target: {
    entityType: 'person',
    titlePath: 'metadata.author_login',
    identities: [
      { namespace: 'github_user_id', eventPath: 'metadata.author_id', primary: true },
      { namespace: 'github_login', eventPath: 'metadata.author_login' },
    ],
  },
  traits: {
    github_login: { eventPath: 'metadata.author_login', mergeStrategy: 'prefer_non_empty' },
    last_authored_at: { eventPath: 'occurred_at', mergeStrategy: 'overwrite' },
  },
};

async function ensurePersonType(orgId: string): Promise<void> {
  const sql = getTestDb();
  const existing = await sql`
    SELECT id FROM entity_types
    WHERE organization_id = ${orgId} AND slug = 'person' AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length === 0) {
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${orgId}, 'person', 'Person', current_timestamp, current_timestamp)
    `;
  }
}

async function seedOrg(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensurePersonType(org.id);
  return org;
}

async function seedGithubConnector(orgId: string) {
  await createTestConnectorDefinition({
    key: connectorKey,
    name: 'GitHub',
    organization_id: orgId,
    feeds_schema: {
      [feedKey]: {
        eventKinds: {
          issue: { attributions: [githubPersonAttribution] },
        },
      },
    },
  });
}

async function members(orgId: string) {
  const sql = getTestDb();
  return sql<{ id: number; name: string; metadata: Record<string, unknown> }[]>`
    SELECT e.id, e.name, e.metadata
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${orgId}
      AND et.slug = 'person'
      AND e.deleted_at IS NULL
  `;
}

async function identitiesFor(entityId: number) {
  const sql = getTestDb();
  const rows = await sql<{ namespace: string; identifier: string }[]>`
    SELECT namespace, identifier
    FROM entity_identities
    WHERE entity_id = ${entityId} AND deleted_at IS NULL
    ORDER BY namespace, identifier
  `;
  return rows.map((r) => `${r.namespace}:${r.identifier}`);
}

describe('github member-identity attribution', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('poll/sync: a synced issue auto-creates a person with github_user_id + github_login identities and stamps the metadata namespace slot', async () => {
    const org = await seedOrg('GitHub Poll Org');
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();

    const item: {
      origin_type: string;
      occurred_at: string;
      metadata: Record<string, unknown>;
    } = {
      origin_type: 'issue',
      // Top-level EventEnvelope field — the `last_authored_at` trait reads it.
      occurred_at: '2026-06-22T00:00:00.000Z',
      metadata: {
        number: 7,
        author_login: 'Octocat',
        author_id: '583231',
      },
    };

    await applyEventAttributions({ connectorKey, feedKey, orgId: org.id, items: [item] });

    const people = await members(org.id);
    expect(people).toHaveLength(1);
    expect(people[0].name).toBe('Octocat');
    // The `github_login` trait preserves the raw display casing; the identity
    // (and the read-time metadata slot below) carry the normalized form.
    expect(people[0].metadata.github_login).toBe('Octocat');
    expect(people[0].metadata.last_authored_at).toBe('2026-06-22T00:00:00.000Z');

    expect(await identitiesFor(people[0].id)).toEqual([
      'github_login:octocat',
      'github_user_id:583231',
    ]);

    // The canonical read-time namespace slot (normalized) is stamped onto the
    // item so the entity_identities JOIN surfaces the event.
    expect(item.metadata.github_login).toBe('octocat');
    expect(item.metadata.github_user_id).toBe('583231');
  });

  it('poll/sync: a renamed login still resolves to the same person via the immutable github_user_id', async () => {
    const org = await seedOrg('GitHub Rename Org');
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();

    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [
        {
          origin_type: 'issue',
          metadata: { author_login: 'oldname', author_id: '999', occurred_at: '2026-06-01T00:00:00.000Z' },
        },
      ],
    });
    // Same user id, new login → must NOT create a second person.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [
        {
          origin_type: 'issue',
          metadata: { author_login: 'newname', author_id: '999', occurred_at: '2026-06-22T00:00:00.000Z' },
        },
      ],
    });

    const people = await members(org.id);
    expect(people).toHaveLength(1);
    // Both logins are now claimed by the one person (sorted by namespace then
    // identifier; both logins share the github_login namespace).
    expect(await identitiesFor(people[0].id)).toEqual([
      'github_login:newname',
      'github_login:oldname',
      'github_user_id:999',
    ]);
  });

  it('poll/sync: a renamed-then-reused login does NOT conflate a new account into the old person (github_user_id primary)', async () => {
    const org = await seedOrg('GitHub Reuse Org');
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();

    // Login "shared" was user_id 1 → person-1 created and claims github_login:shared.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [{ origin_type: 'issue', metadata: { author_login: 'shared', author_id: '1' } }],
    });
    const afterFirst = await members(org.id);
    expect(afterFirst).toHaveLength(1);
    const personOneId = afterFirst[0].id;

    // The original "shared" account renamed away; a DIFFERENT account (user_id 2)
    // now uses the login "shared". The immutable github_user_id is PRIMARY and
    // present (=2, unmatched), so resolution must NOT fall through to the stale
    // github_login:shared match → a distinct person-2 is created.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [{ origin_type: 'issue', metadata: { author_login: 'shared', author_id: '2' } }],
    });

    const people = await members(org.id);
    expect(people).toHaveLength(2);
    const personTwo = people.find((p) => p.id !== personOneId);
    expect(personTwo).toBeDefined();
    // person-2 owns github_user_id:2. The login stayed with whoever claimed it
    // first (UNIQUE per org,namespace,identifier), so person-2 only has the id.
    expect(await identitiesFor(personTwo!.id)).toEqual(['github_user_id:2']);
    // person-1 is untouched — no conflation.
    expect(await identitiesFor(personOneId)).toEqual([
      'github_login:shared',
      'github_user_id:1',
    ]);
  });

  it('poll/sync: a stale secondary identity is NOT mis-claimed in the in-batch matches map', async () => {
    const org = await seedOrg('GitHub Map Claim Org');
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();

    // Pre-seed person-1 owning github_login:shared + github_user_id:1.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [{ origin_type: 'issue', metadata: { author_login: 'shared', author_id: '1' } }],
    });
    const personOneId = (await members(org.id))[0].id;

    // In ONE batch:
    //   (a) login "shared" + a FRESH id 2 → creates person-2; the login stays on
    //       person-1 (ON CONFLICT no-op), so the matches map must NOT claim
    //       github_login:shared for person-2.
    //   (b) a login-only "shared" event → must resolve to person-1 (the real
    //       owner of that login), proving the map wasn't mis-claimed for person-2.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [
        { origin_type: 'issue', metadata: { author_login: 'shared', author_id: '2' } },
        { origin_type: 'issue', metadata: { author_login: 'shared' } },
      ],
    });

    const people = await members(org.id);
    // Exactly two people: person-1 (login owner) and person-2 (id:2). The
    // login-only event resolved to person-1, NOT a third entity or person-2.
    expect(people).toHaveLength(2);
    const personTwo = people.find((p) => p.id !== personOneId);
    expect(personTwo).toBeDefined();
    expect(await identitiesFor(personTwo!.id)).toEqual(['github_user_id:2']);
    expect(await identitiesFor(personOneId)).toEqual([
      'github_login:shared',
      'github_user_id:1',
    ]);
  });

  it('poll/sync READ-TIME: a reused-login event attributes to the user_id-2 person, NOT the old person-1', async () => {
    const org = await seedOrg('GitHub Read-Time Reuse Org');
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();
    const sql = getTestDb();

    // Helper: which events attribute to `entityId` at READ TIME (the
    // entityLinkMatchSql JOIN against entity_identities + events.metadata).
    const readTimeEventIds = async (entityId: number): Promise<number[]> => {
      const rows = await sql<{ id: number }[]>`
        SELECT f.id FROM events f
        WHERE f.organization_id = ${org.id}
          AND ${sql.unsafe(entityLinkMatchSql(`${entityId}::bigint`, 'f'))}
        ORDER BY f.id
      `;
      return rows.map((r) => Number(r.id));
    };

    // Event 1: login "shared" + user_id 1 → person-1. applyEventAttributions stamps
    // the attached identifier slots onto item1.metadata.
    const item1: { origin_type: string; metadata: Record<string, unknown> } = {
      origin_type: 'issue',
      metadata: { author_login: 'shared', author_id: '1' },
    };
    await applyEventAttributions({ connectorKey, feedKey, orgId: org.id, items: [item1] });
    const personOneId = (await members(org.id))[0].id;
    const e1 = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'evt-1',
      semanticType: 'content',
      title: 'issue 1',
      originType: 'issue',
      connectorKey: 'github',
      metadata: item1.metadata,
    });

    // Event 2: same login "shared" reclaimed by a DIFFERENT account (user_id 2)
    // → person-2 (immutable id primary). applyEventAttributions stamps ONLY the
    // attached identifier (github_user_id:2), not the stale github_login:shared.
    const item2: { origin_type: string; metadata: Record<string, unknown> } = {
      origin_type: 'issue',
      metadata: { author_login: 'shared', author_id: '2' },
    };
    await applyEventAttributions({ connectorKey, feedKey, orgId: org.id, items: [item2] });
    const people = await members(org.id);
    expect(people).toHaveLength(2);
    const personTwoId = people.find((p) => p.id !== personOneId)!.id;
    const e2 = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'evt-2',
      semanticType: 'content',
      title: 'issue 2',
      originType: 'issue',
      connectorKey: 'github',
      metadata: item2.metadata,
    });

    // THE read-time assertion: event-2 attributes to person-2 (via the immutable
    // github_user_id), NOT to the old person-1 (the reused login is not stamped).
    expect(await readTimeEventIds(personTwoId)).toEqual([Number(e2.id)]);
    expect(await readTimeEventIds(personOneId)).toEqual([Number(e1.id)]);
    // The stale login is not on event-2's metadata, so it can't JOIN person-1.
    expect(item2.metadata.github_login).toBeUndefined();
    expect(item2.metadata.github_user_id).toBe('2');
  });

  describe('live star record', () => {
    let compiledGithub: string;
    beforeAll(async () => {
      const source = fileURLToPath(new URL('../../../../../connectors/src/github.ts', import.meta.url));
      compiledGithub = await createIsolateConnectorCompiler().compileConnectorForIsolateFromFile(source);
    }, 120_000);

    /** The org's real github declaration + compiled code, one connection, one stargazers feed. */
    async function seedStargazersFeed(orgId: string) {
      const sql = getTestDb();
      await createTestConnectorDefinition({
        key: connectorKey,
        name: 'GitHub',
        organization_id: orgId,
        feeds_schema: declaredFeedsSchema(new GitHubConnector().definition),
      });
      await sql`UPDATE connector_versions SET compiled_code = ${compiledGithub} WHERE connector_key = ${connectorKey}`;
      const owner = await createTestUser();
      await addUserToOrganization(owner.id, orgId, 'admin');
      const connection = await createTestConnection({
        organization_id: orgId,
        connector_key: connectorKey,
        created_by: owner.id,
        createDefaultFeed: false,
      });
      const [feed] = await sql<{ id: number }[]>`
        INSERT INTO feeds (organization_id, connection_id, feed_key, status, config)
        VALUES (${orgId}, ${connection.id}, 'stargazers', 'active', ${sql.json({ repo_owner: 'acme', repo_name: 'api' })})
        RETURNING id
      `;
      return { connectionId: connection.id, feedId: Number(feed.id) };
    }

    const star = (orgId: string, target: { connectionId: number; feedId: number }, action = 'created') => ({
      organizationId: orgId,
      connectionId: target.connectionId,
      feedId: target.feedId,
      eventType: 'star',
      receivedAt: '2026-06-20T10:00:05.000Z',
      payload: {
        action,
        starred_at: '2026-06-20T10:00:00Z',
        sender: { login: 'Octocat', id: 583231, html_url: 'https://github.com/Octocat' },
        repository: { owner: { login: 'ACME' }, name: 'API', html_url: 'https://github.com/ACME/API' },
      },
    });

    it('records the stargazer event under the feed and resolves the sender to a person', async () => {
      const org = await seedOrg('GitHub Star Record Org');
      const target = await seedStargazersFeed(org.id);

      expect(await processConnectorRecord(star(org.id, target))).toBe('recorded');

      const sql = getTestDb();
      const events = await sql<{ origin_id: string; origin_type: string; feed_id: number; connection_id: number; run_id: number | null; metadata: Record<string, unknown> }[]>`
        SELECT origin_id, origin_type, feed_id, connection_id, run_id, metadata FROM events
        WHERE organization_id = ${org.id} AND superseded_by IS NULL
      `;
      expect(events).toHaveLength(1);
      // The feed config's casing names the repo, so the poll keys the same origin_id.
      expect(events[0]).toMatchObject({
        origin_id: 'stargazer_acme_api_github_user_id_583231',
        origin_type: 'stargazer',
        run_id: null,
      });
      expect(Number(events[0].feed_id)).toBe(target.feedId);
      expect(Number(events[0].connection_id)).toBe(target.connectionId);
      expect(events[0].metadata).toMatchObject({ action: 'starred', source: 'github_star_webhook', github_login: 'octocat', github_user_id: '583231' });

      const people = await members(org.id);
      expect(people).toHaveLength(1);
      expect(people[0].name.toLowerCase()).toBe('octocat');
      expect(await identitiesFor(people[0].id)).toEqual(['github_login:octocat', 'github_user_id:583231']);
      const sources = await sql<{ connection_id: number | null }[]>`
        SELECT connection_id FROM entity_identities WHERE entity_id = ${people[0].id} AND deleted_at IS NULL
      `;
      expect(sources.map((row) => Number(row.connection_id))).toEqual([target.connectionId, target.connectionId]);
      // The record never touches the feed's poll state.
      const [feed] = await sql`SELECT checkpoint, last_sync_at, next_run_at FROM feeds WHERE id = ${target.feedId}`;
      expect(feed).toMatchObject({ checkpoint: null, last_sync_at: null, next_run_at: null });
    }, 60_000);

    it('a record never touches feeds.checkpoint or runs.checkpoint, and ingest refuses a run-less checkpoint', async () => {
      const org = await seedOrg('GitHub Record Checkpoint Org');
      const target = await seedStargazersFeed(org.id);
      const sql = getTestDb();
      const polled = { last_sync_at: '2026-06-01T00:00:00.000Z', stargazers: [] };
      await sql`UPDATE feeds SET checkpoint = ${sql.json(polled)} WHERE id = ${target.feedId}`;
      const [run] = await sql<{ id: number }[]>`
        INSERT INTO runs (organization_id, run_type, feed_id, connection_id, connector_key, status, checkpoint)
        VALUES (${org.id}, 'sync', ${target.feedId}, ${target.connectionId}, 'github', 'running', ${sql.json({ page: 2 })})
        RETURNING id
      `;

      expect(await processConnectorRecord(star(org.id, target))).toBe('recorded');
      expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${target.feedId}`)[0].checkpoint).toEqual(polled);
      expect((await sql`SELECT checkpoint FROM runs WHERE id = ${run.id}`)[0].checkpoint).toEqual({ page: 2 });

      const live = { runId: null, workerId: null, organizationId: org.id, connectionId: target.connectionId,
        connectorKey: connectorKey, feedId: target.feedId, feedKey: 'stargazers', entityIds: [], dryRun: false };
      await expect(ingestConnectorItems(sql, live, [], { cursor: 'x' })).rejects.toThrow(/cannot carry a checkpoint/);
      await expect(ingestConnectorItems(sql, { ...live, runId: Number(run.id), liveRecord: { feedKey: 'stargazers', config: null } }, [], { cursor: 'x' }))
        .rejects.toThrow(/cannot carry a checkpoint/);
      expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${target.feedId}`)[0].checkpoint).toEqual(polled);
    }, 60_000);

    it('an unstar records nothing and resolves no actor (the poll diff owns removals)', async () => {
      const org = await seedOrg('GitHub Unstar Org');
      const target = await seedStargazersFeed(org.id);
      expect(await processConnectorRecord(star(org.id, target, 'deleted'))).toBe('ignored');
      expect(await getTestDb()`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(0);
      expect(await members(org.id)).toHaveLength(0);
    }, 60_000);

    it('a job whose feed was paused since the delivery records nothing', async () => {
      const org = await seedOrg('GitHub Paused Record Org');
      const target = await seedStargazersFeed(org.id);
      await getTestDb()`UPDATE feeds SET status = 'paused' WHERE id = ${target.feedId}`;
      expect(await processConnectorRecord(star(org.id, target))).toBe('ignored');
      expect(await getTestDb()`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(0);
    }, 60_000);

    it.each(['config', 'events'])('ignores a queued delivery after its %s no longer matches', async (change) => {
      const org = await seedOrg('GitHub Retargeted Record Org');
      const target = await seedStargazersFeed(org.id);
      const sql = getTestDb();
      if (change === 'config') {
        await sql`UPDATE feeds SET config = ${sql.json({ repo_owner: 'acme', repo_name: 'other' })} WHERE id = ${target.feedId}`;
      } else {
        await sql`UPDATE connector_definitions SET feeds_schema = jsonb_set(feeds_schema,
          '{stargazers,webhook,events}', '["watch"]'::jsonb) WHERE organization_id = ${org.id}`;
      }
      expect(await processConnectorRecord(star(org.id, target))).toBe('ignored');
      expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(0);
    }, 60_000);

    it.each(['feed pause', 'connection pause', 'config'])('fences a %s during normalization', async (change) => {
      const org = await seedOrg('GitHub Record Fence Org');
      const target = await seedStargazersFeed(org.id);
      const sql = getTestDb();
      const connector = new GitHubConnector();
      const job = star(org.id, target);
      expect(await processConnectorRecord(job, { executor: { execute: async () => {
        if (change === 'feed pause') {
          await sql`UPDATE feeds SET status = 'paused' WHERE id = ${target.feedId}`;
        } else if (change === 'connection pause') {
          await sql`UPDATE connections SET status = 'paused' WHERE id = ${target.connectionId}`;
        } else {
          await sql`UPDATE feeds SET config = ${sql.json({ repo_owner: 'acme', repo_name: 'other' })} WHERE id = ${target.feedId}`;
        }
        return { mode: 'webhook_record', event: await connector.definition.feeds!.stargazers.webhook!.normalize!(job.payload, {
          feedKey: 'stargazers', eventType: job.eventType, receivedAt: job.receivedAt,
          config: { repo_owner: 'acme', repo_name: 'api' },
        }) };
      } } })).toBe('ignored');
      expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(0);
      expect(await members(org.id)).toHaveLength(0);
    }, 60_000);

    it('tenant-scoped: the same star in two orgs resolves to two distinct persons', async () => {
      const orgA = await seedOrg('GitHub Tenant A');
      const orgB = await seedOrg('GitHub Tenant B');
      const targetA = await seedStargazersFeed(orgA.id);
      const targetB = await seedStargazersFeed(orgB.id);
      // A job naming another org's feed is not that org's record.
      expect(await processConnectorRecord({ ...star(orgA.id, targetB) })).toBe('ignored');

      expect(await processConnectorRecord(star(orgA.id, targetA))).toBe('recorded');
      expect(await processConnectorRecord(star(orgB.id, targetB))).toBe('recorded');
      const peopleA = await members(orgA.id);
      const peopleB = await members(orgB.id);
      expect(peopleA).toHaveLength(1);
      expect(peopleB).toHaveLength(1);
      // entity_identities are UNIQUE per (org, namespace, identifier), never cross-org.
      expect(peopleA[0].id).not.toBe(peopleB[0].id);
    }, 60_000);
  });
});
