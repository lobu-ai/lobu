/**
 * Postgres connector sync — keyset incremental + validation, against a real DB.
 *
 * Drives the connector directly, pointed at the test DB URL, reading a
 * throwaway table. Exercises validateBaseQuery → keyset compound-cursor wrap →
 * column-type probe → checkpoint round-trip end to end. Direct drive covers the
 * SQL contract and the connector-owned TLS gate only: the ADDRESS half of
 * egress is the isolate host's, so the policy cases run on the lane (the last
 * case below), the only place the connector executes in production.
 */

import type { EventEnvelope } from '@lobu/connector-sdk';
import PostgresConnector from '@lobu/connectors/postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDb } from '../../setup/test-db';

const conn = new PostgresConnector();
const cfg = {
  query: 'SELECT id, email, created_at FROM pgc_it',
  primary_key: 'id',
  cursor_column: 'created_at',
};
/** One sync pass, with everything it committed collected in commit order. */
const run = async (over: Record<string, unknown>, checkpoint: unknown, feedId?: number) => {
  const events: EventEnvelope[] = [];
  let committed: unknown = null;
  const result = await conn.sync({
    feedKey: 'query',
    feedId,
    config: { DATABASE_URL: process.env.DATABASE_URL, ...cfg, ...over } as never,
    checkpoint: checkpoint as never,
    credentials: null,
    entityIds: [],
    commit: async (page, next) => {
      events.push(...page);
      if (next !== null) committed = next;
    },
  });
  return { ...result, events, checkpoint: committed as Record<string, unknown> | null };
};

describe('PostgresConnector.sync (keyset incremental, real DB)', () => {
  beforeAll(async () => {
    const db = getTestDb();
    await db`DROP TABLE IF EXISTS pgc_it`;
    await db`CREATE TABLE pgc_it (id bigserial primary key, email text, created_at timestamptz)`;
    // two rows share created_at → exercises the (cursor, pk) keyset tiebreak.
    await db`INSERT INTO pgc_it (email, created_at) VALUES
      ('a@x.com','2026-01-01T10:00:00Z'),
      ('b@x.com','2026-01-01T10:00:00Z'),
      ('c@x.com','2026-01-02T10:00:00Z')`;
  });

  afterAll(async () => {
    await getTestDb()`DROP TABLE IF EXISTS pgc_it`;
  });

  it('pulls all rows on first sync and advances the compound checkpoint', async () => {
    const r = await run({}, null);
    expect(r.events.map((e) => e.origin_id)).toEqual(['query:1', 'query:2', 'query:3']);
    expect(r.checkpoint).toMatchObject({
      last_cursor: expect.any(String),
      last_pk: expect.any(String),
    });
  });

  it('a pass capped by max_rows_per_sync commits its rows, asks for more, and the next pass resumes', async () => {
    const r1 = await run({ max_rows_per_sync: 2 }, null);
    expect(r1.status).toBe('more');
    expect(r1.events.map((e) => e.origin_id)).toEqual(['query:1', 'query:2']);
    const r2 = await run({ max_rows_per_sync: 2 }, r1.checkpoint);
    expect(r2.status).toBe('complete');
    expect(r2.events.map((e) => e.origin_id)).toEqual(['query:3']);
  });

  it('is incremental: a re-sync from the checkpoint yields no rows', async () => {
    const r1 = await run({}, null);
    const r2 = await run({}, r1.checkpoint);
    expect(r2.events).toHaveLength(0);
  });

  it('picks up only newly-inserted rows past the watermark', async () => {
    const r1 = await run({}, null);
    const db = getTestDb();
    await db`INSERT INTO pgc_it (email, created_at) VALUES ('d@x.com','2026-01-03T10:00:00Z')`;
    try {
      const r2 = await run({}, r1.checkpoint);
      expect(r2.events.map((e) => e.origin_id)).toEqual(['query:4']);
    } finally {
      await db`DELETE FROM pgc_it WHERE email = 'd@x.com'`;
    }
  });

  it('accepts exotic-but-valid Postgres (no SQL parser to false-reject it)', async () => {
    // The connector does a structural read-only check, not an AST parse, so SQL a
    // Postgres-grammar parser would choke on (`IS NOT DISTINCT FROM`, FTS @@,
    // jsonpath, GROUPING SETS, range casts …) runs fine — the read-only
    // transaction is the real write seal.
    const r = await run(
      { query: 'SELECT id, email, created_at FROM pgc_it WHERE email IS NOT DISTINCT FROM email' },
      null
    );
    expect(r.events.map((e) => e.origin_id)).toEqual(['query:1', 'query:2', 'query:3']);
  });

  it('namespaces origin_id by feed instance so two feeds on one connection do not collide', async () => {
    // Both feeds share feedKey 'query' and the same primary keys; distinct feedId
    // must keep their origin_ids apart (else one supersedes the other's events).
    const feedA = await run({}, null, 101);
    const feedB = await run({}, null, 202);
    expect(feedA.events[0].origin_id).toBe('101:1');
    expect(feedB.events[0].origin_id).toBe('202:1');
    // Same pk, different feed → no collision.
    const aIds = new Set(feedA.events.map((e) => e.origin_id));
    expect(feedB.events.some((e) => aIds.has(e.origin_id))).toBe(false);
  });

  it('rejects invalid base queries before connecting', async () => {
    await expect(run({ query: 'SELECT 1; DROP TABLE pgc_it' }, null)).rejects.toThrow(
      /single statement/i
    );
    await expect(run({ query: 'SELECT id, created_at FROM pgc_it LIMIT 5' }, null)).rejects.toThrow(
      /LIMIT/i
    );
    await expect(run({ query: 'UPDATE pgc_it SET email = NULL' }, null)).rejects.toThrow(/SELECT/i);
  });

  it('rejects sslmode=disable under block-private before any socket opens (forced TLS)', async () => {
    const base = (process.env.DATABASE_URL ?? '').replace(/[?&]sslmode=[^&]*/, '');
    const disabled = base + (base.includes('?') ? '&' : '?') + 'sslmode=disable';
    await expect(
      run({ DATABASE_URL: disabled, LOBU_DB_EGRESS_POLICY: 'block-private' }, null)
    ).rejects.toThrow(/TLS is required/i);
  });

  it('labels result column types from the OID map (incl. name / jsonb / oid)', async () => {
    const conn2 = new PostgresConnector();
    const r = await conn2.query({
      feedKey: null,
      query:
        "SELECT 1::bigint AS a, 'x'::text AS b, true AS c, now() AS d, '{}'::jsonb AS e, 'y'::name AS f, 1::oid AS g, 1.5::numeric AS h",
      config: { DATABASE_URL: process.env.DATABASE_URL },
      credentials: null,
    } as never);
    const types = Object.fromEntries((r.columns ?? []).map((c) => [c.name, c.type]));
    expect(types).toMatchObject({
      a: 'bigint',
      b: 'text',
      c: 'boolean',
      d: 'timestamptz',
      e: 'jsonb',
      f: 'name',
      g: 'oid',
      h: 'numeric',
    });
  });

  it('rejects a write-capable CTE (read-only connector contract)', async () => {
    await expect(
      run(
        {
          query:
            "WITH x AS (INSERT INTO pgc_it (email, created_at) VALUES ('hack','2030-01-01') RETURNING id) SELECT * FROM x",
        },
        null
      )
    ).rejects.toThrow(/data-modifying/i);
    // The write must NOT have happened.
    const [{ n }] = await getTestDb()`SELECT count(*)::int AS n FROM pgc_it WHERE email = 'hack'`;
    expect(Number(n)).toBe(0);
  });

  it('executes postgres query inside V8 isolate with host-mediated socket and egress policy', async () => {
    const { createIsolateConnectorCompiler } = await import('@lobu/connector-worker/compile');
    const { IsolateExecutor } = await import('@lobu/connector-worker/executor/isolate');
    const path = await import('node:path');
    const { compileConnectorForIsolateFromFile } = createIsolateConnectorCompiler();
    const connectorPath = path.resolve(__dirname, '../../../../../connectors/src/postgres.ts');
    const code = await compileConnectorForIsolateFromFile(connectorPath);

    const executor = new IsolateExecutor({ timeoutMs: 10000, memoryMb: 512 });

    // The TLS gate runs before the host dials (case 4), so strip any
    // `sslmode=disable` off the test URL to reach the address checks -- the
    // same strip the direct-drive TLS case above uses.
    const baseUrl = (process.env.DATABASE_URL ?? '').replace(/[?&]sslmode=[^&]*/, '');

    // 1. Under block-private policy in env, the host's socketOpen refuses the loopback test DB
    await expect(
      executor.execute(code, {
        mode: 'query',
        query: 'SELECT 1 AS n',
        config: { DATABASE_URL: baseUrl },
        checkpoint: null,
        credentials: null,
        sessionState: null,
        env: { LOBU_DB_EGRESS_POLICY: 'block-private' },
      })
    ).rejects.toThrow(/EgressDenied/);

    // 1b. Policy passed via config (gateway pushdown pattern) is also enforced
    await expect(
      executor.execute(code, {
        mode: 'query',
        query: 'SELECT 1 AS n',
        config: {
          DATABASE_URL: baseUrl,
          LOBU_DB_EGRESS_POLICY: 'block-private',
        },
        checkpoint: null,
        credentials: null,
        sessionState: null,
        env: {},
      })
    ).rejects.toThrow(/EgressDenied/);

    // 2. Under allow-private policy, connection succeeds through isolate host socket
    const res = await executor.execute(code, {
      mode: 'query',
      query: 'SELECT count(*)::int AS n FROM pgc_it',
      config: { DATABASE_URL: process.env.DATABASE_URL },
      checkpoint: null,
      credentials: null,
      sessionState: null,
      env: { LOBU_DB_EGRESS_POLICY: 'allow-private' },
    });
    expect(res).toBeDefined();
    expect((res as any).rows[0].n).toBe(3);

    // 3. Under allow-private policy, sync mode runs inside isolate and emits all events
    const emittedEvents: any[] = [];
    const syncRes = await executor.execute(
      code,
      {
        mode: 'sync',
        feedKey: 'query',
        config: {
          DATABASE_URL: process.env.DATABASE_URL,
          query: 'SELECT id, email, created_at FROM pgc_it',
          primary_key: 'id',
          cursor_column: 'created_at',
        },
        checkpoint: null,
        credentials: null,
        sessionState: null,
        env: { LOBU_DB_EGRESS_POLICY: 'allow-private' },
      },
      {
        onCommit: async (events) => {
          emittedEvents.push(...events);
        },
      }
    );
    expect(syncRes).toMatchObject({ mode: 'sync' });
    expect(emittedEvents.map((e: any) => e.origin_id)).toEqual(['query:1', 'query:2', 'query:3']);

    // 4. block-private forces TLS on the isolate lane too. The guest cannot
    // resolve a name, so the HOST owns the address half of the policy (cases 1
    // and 1b above) -- but nothing on the wire tells the host that THIS socket
    // carries database credentials, and postgres.js only upgrades a connection
    // when the pool was handed `ssl`. So the connector still resolves
    // `requiredTlsMode` in the isolate, and `sslmode=disable` is refused before
    // any socket opens. Without that the cloud lane would send credentials in
    // cleartext -- proven by mutation: dropping the `ssl` option lets a
    // block-private run with `127.0.0.1` allowlisted sync happily unencrypted.
    const disabledTls = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}sslmode=disable`;
    await expect(
      executor.execute(code, {
        mode: 'query',
        query: 'SELECT 1 AS n',
        config: {
          DATABASE_URL: disabledTls,
          LOBU_DB_EGRESS_POLICY: 'block-private',
          LOBU_DB_EGRESS_ALLOW_HOSTS: '127.0.0.1',
        },
        checkpoint: null,
        credentials: null,
        sessionState: null,
        env: {},
      })
    ).rejects.toThrow(/TLS is required/i);

    // 5. ...and self-hosted is untouched: the same URL under allow-private
    // still connects in cleartext, so the floor is a CLOUD rule, not a new
    // requirement on every install.
    const selfHosted = await executor.execute(code, {
      mode: 'query',
      query: 'SELECT 1 AS n',
      config: { DATABASE_URL: disabledTls },
      checkpoint: null,
      credentials: null,
      sessionState: null,
      env: { LOBU_DB_EGRESS_POLICY: 'allow-private' },
    });
    expect((selfHosted as any).rows[0].n).toBe(1);

    // 6. A URL that asks the driver to VERIFY the chain fails closed on this
    // lane, under every policy, before a socket opens. postgres.js's WinterCG
    // polyfill upgrades with `startTls({ servername })` -- `rejectUnauthorized`
    // and `ca` never cross -- so the host can only encrypt at the `require`
    // floor; connecting would silently turn verify-full into unverified TLS.
    // Mutation-proved: without the guard the same URL dies later in the
    // handshake with a driver error that never mentions verification.
    for (const verifying of ['sslmode=verify-full', 'sslmode=verify-ca', 'sslrootcert=system']) {
      const verifyUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${verifying}`;
      for (const policy of ['allow-private', 'block-private'] as const) {
        await expect(
          executor.execute(code, {
            mode: 'query',
            query: 'SELECT 1 AS n',
            config: {
              DATABASE_URL: verifyUrl,
              LOBU_DB_EGRESS_POLICY: policy,
              LOBU_DB_EGRESS_ALLOW_HOSTS: '127.0.0.1',
            },
            checkpoint: null,
            credentials: null,
            sessionState: null,
            env: {},
          })
        ).rejects.toThrow(/cannot verify server certificates/i);
      }
    }
  });
});
