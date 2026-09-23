/**
 * Postgres dogfood E2E (test DB, NOT live prod).
 *
 * Mirrors Lobu's user/member/organization shape (mixed-case quoted identifiers,
 * like the real schema) in `dog_*` tables, then drives the whole feature path:
 *   1. memory feed: PostgresConnector.sync() turns the realistic signup JOIN into
 *      mapped EventEnvelopes with a keyset checkpoint.
 *   2. register a connection pointing back at the test DB (the "external" DB).
 *   3. connection-backed derived entity: create it via manage_entity_schema, then
 *      read it LIVE via query_sql({ connection }) — the compile → fork →
 *      connector.query() pushdown chain — and get real funnel counts.
 *
 * What it does NOT prove (needs a live-prod run or a heavier worker-protocol
 * test): the sync→events insert/upsert/dedup in the worker stream path; the
 * scheduled CheckDueFeeds→poll path (covered by postgres-sync-cloud-gate.test.ts);
 * and real prod creds / the least-privilege read-only role.
 */
import type { EventEnvelope } from '@lobu/connector-sdk';
import PostgresConnector from '@lobu/connectors/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../../tools/admin/query_sql';
import type { ToolContext } from '../../../tools/registry';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { post } from '../../setup/test-helpers';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

// Base SELECTs adapted from examples/lobu-crm/lobu.config.ts (dog_-prefixed so
// they can't collide with the app's own user/member/organization tables).
const SIGNUP_SQL = `SELECT u.id, u.email, u.name, u."createdAt" AS created_at, o.slug AS org
  FROM dog_user u
  JOIN dog_member m ON m."userId" = u.id
  JOIN dog_org o ON o.id = m."organizationId"`;

const FUNNEL_SQL = `SELECT o.slug AS org,
         count(DISTINCT u.id) AS signups,
         max(u."createdAt") AS last_signup
  FROM dog_user u
  JOIN dog_member m ON m."userId" = u.id
  JOIN dog_org o ON o.id = m."organizationId"
  GROUP BY o.slug`;

const syncPostgres = async (
  conn: PostgresConnector,
  input: Omit<Parameters<PostgresConnector['sync']>[0], 'commit'>
) => {
  const events: EventEnvelope[] = [];
  let checkpoint: Record<string, unknown> | null = null;
  const result = await conn.sync({
    ...input,
    commit: async (page, next) => {
      events.push(...page);
      if (next !== null) checkpoint = next;
    },
  });
  return { ...result, events, checkpoint };
};

describe('postgres dogfood E2E (memory feed + connection-backed derived entity)', () => {
  let ctx: ToolContext;
  let owner: TestApiClient;
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Dogfood' });
    orgId = org.id;
    const user = await createTestUser({ email: 'dogfood@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ctx = ownerToolContext(orgId, user.id);
    owner = await TestApiClient.for({
      organizationId: orgId,
      userId: user.id,
      memberRole: 'owner',
    });

    const db = getTestDb();
    await db`DROP TABLE IF EXISTS dog_member`;
    await db`DROP TABLE IF EXISTS dog_user`;
    await db`DROP TABLE IF EXISTS dog_org`;
    await db`CREATE TABLE dog_org (id text PRIMARY KEY, slug text)`;
    await db`CREATE TABLE dog_user (id text PRIMARY KEY, email text, name text, "createdAt" timestamptz)`;
    await db`CREATE TABLE dog_member ("userId" text, "organizationId" text)`;
    await db`INSERT INTO dog_org (id, slug) VALUES ('o1', 'acme'), ('o2', 'beta')`;
    await db`INSERT INTO dog_user (id, email, name, "createdAt") VALUES
      ('u1', 'a1@x.com', 'A One', '2026-01-01T10:00:00Z'),
      ('u2', 'a2@x.com', 'A Two', '2026-01-02T10:00:00Z'),
      ('u3', 'b1@x.com', 'B One', '2026-01-03T10:00:00Z')`;
    // acme (o1) has two signups, beta (o2) has one.
    await db`INSERT INTO dog_member ("userId", "organizationId") VALUES
      ('u1', 'o1'), ('u2', 'o1'), ('u3', 'o2')`;

    const profile = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'postgres',
      displayName: 'dog prod db',
      profileKind: 'env',
      authData: { DATABASE_URL: process.env.DATABASE_URL as string },
    });
    await db`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, auth_profile_id, visibility, created_by, created_at, updated_at)
      VALUES
        (${orgId}, 'postgres', 'dog-prod-db', 'Dog Prod DB', 'active', ${profile.id}, 'org', ${user.id}, NOW(), NOW())
    `;
  }, 120_000);

  afterAll(async () => {
    const db = getTestDb();
    await db`DROP TABLE IF EXISTS dog_member`;
    await db`DROP TABLE IF EXISTS dog_user`;
    await db`DROP TABLE IF EXISTS dog_org`;
  });

  it('memory feed: sync() maps the signup JOIN to events with a keyset checkpoint', async () => {
    const conn = new PostgresConnector();
    const r = await syncPostgres(conn, {
      feedKey: 'query',
      config: {
        DATABASE_URL: process.env.DATABASE_URL,
        query: SIGNUP_SQL,
        primary_key: 'id',
        cursor_column: 'created_at',
        mapping: { title: 'email', occurred_at: 'created_at' },
      } as never,
      checkpoint: null as never,
      credentials: null,
      entityIds: [],
    });

    // Ordered by the (created_at, id) keyset → u1, u2, u3.
    expect(r.events.map((e) => e.origin_id)).toEqual(['query:u1', 'query:u2', 'query:u3']);
    expect(r.events[0].title).toBe('a1@x.com');
    expect(r.events[0].occurred_at).toBeInstanceOf(Date);
    expect(r.checkpoint).toMatchObject({
      last_cursor: expect.any(String),
      last_pk: 'u3',
    });
  }, 60_000);

  it('incremental: re-sync from the checkpoint yields no rows', async () => {
    const conn = new PostgresConnector();
    const base = {
      DATABASE_URL: process.env.DATABASE_URL,
      query: SIGNUP_SQL,
      primary_key: 'id',
      cursor_column: 'created_at',
    };
    const r1 = await syncPostgres(conn, {
      feedKey: 'query',
      config: base as never,
      checkpoint: null as never,
      credentials: null,
      entityIds: [],
    });
    const r2 = await syncPostgres(conn, {
      feedKey: 'query',
      config: base as never,
      checkpoint: r1.checkpoint as never,
      credentials: null,
      entityIds: [],
    });
    expect(r2.events).toHaveLength(0);
  }, 60_000);

  it('memory feed ingestion: connector envelopes land in events via the worker stream, deduped by origin_id', async () => {
    const db = getTestDb();
    const conn = new PostgresConnector();
    const r = await syncPostgres(conn, {
      feedKey: 'query',
      config: {
        DATABASE_URL: process.env.DATABASE_URL,
        query: SIGNUP_SQL,
        primary_key: 'id',
        cursor_column: 'created_at',
        mapping: { title: 'email', occurred_at: 'created_at' },
      } as never,
      checkpoint: null as never,
      credentials: null,
      entityIds: [],
    });

    const [connRow] = await db`
      SELECT id FROM connections WHERE slug = 'dog-prod-db' AND organization_id = ${orgId}
    `;
    const connId = Number((connRow as { id: number }).id);
    const [feed] = await db`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, created_at, updated_at)
      VALUES (${orgId}, ${connId}, 'query', 'active', NOW(), NOW()) RETURNING id
    `;
    const feedId = Number((feed as { id: number }).id);
    const [run] = await db`
      INSERT INTO runs
        (organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, approval_status, created_at)
      VALUES
        (${orgId}, 'sync', ${feedId}, ${connId}, 'postgres', '1.0.0', 'running', 'auto', current_timestamp)
      RETURNING id
    `;
    const runId = Number((run as { id: number }).id);

    // The worker streams the connector's EventEnvelopes to the gateway.
    const items = r.events.map((e) => ({
      id: e.origin_id,
      title: e.title,
      payload_text: e.payload_text,
      occurred_at: (e.occurred_at as Date).toISOString(),
    }));
    const res = await post('/api/workers/stream', { body: { type: 'batch', run_id: runId, items } });
    expect(res.status).toBe(200);

    const events = await db`
      SELECT origin_id, connector_key FROM events
      WHERE connection_id = ${connId} AND origin_id LIKE 'query:%'
      ORDER BY origin_id
    `;
    expect(events.map((e) => (e as { origin_id: string }).origin_id)).toEqual([
      'query:u1',
      'query:u2',
      'query:u3',
    ]);
    expect(events.every((e) => (e as { connector_key: string }).connector_key === 'postgres')).toBe(
      true
    );

    // Re-stream the SAME envelopes → dedup by origin_id: still 3 current records, not 6.
    await post('/api/workers/stream', { body: { type: 'batch', run_id: runId, items } });
    const [current] = await db`
      SELECT count(*)::int AS n FROM current_event_records
      WHERE connection_id = ${connId} AND origin_id LIKE 'query:%'
    `;
    expect(Number((current as { n: number }).n)).toBe(3);
  }, 60_000);

  it('connection-backed derived entity: create, get_type returns backing_source, read LIVE via pushdown', async () => {
    // Typed SDK surface: createType accepts backing.connection (external-backed).
    await owner.entity_schema.createType({
      slug: 'dog-funnel',
      name: 'Dog Funnel',
      backing: { sql: FUNNEL_SQL, connection: 'dog-prod-db' },
    });

    const got = (await owner.entity_schema.getType('dog-funnel')) as {
      entity_type?: { backing_sql?: string | null; backing_source?: string | null };
    };
    expect(got.entity_type?.backing_source).toBe('dog-prod-db');
    expect(got.entity_type?.backing_sql).toBe(FUNNEL_SQL);

    // Read the derived entity LIVE the way the agent would: backing_sql through
    // query_sql with connection = backing_source.
    const res = await querySql(
      {
        sql: got.entity_type?.backing_sql as string,
        connection: got.entity_type?.backing_source as string,
        sort_by: 'org',
      },
      {},
      ctx
    );

    expect(res.error).toBeUndefined();
    expect(res.rows.map((row) => row.org)).toEqual(['acme', 'beta']);
    expect(Number(res.rows[0].signups)).toBe(2);
    expect(Number(res.rows[1].signups)).toBe(1);
    expect(res.total_count).toBe(2);
    expect(res.has_more).toBe(false);
  }, 60_000);
});
