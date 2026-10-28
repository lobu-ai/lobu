import { createRequire } from 'node:module';
import net from 'node:net';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PROD_PG_VALUE_OPTIONS } from '../../db/client';
import { getTestDb } from '../setup/test-db';

const require = createRequire(import.meta.url);
const cjsPostgres: typeof postgres = require('postgres');
const drivers = [
  ['ESM', postgres],
  ['CommonJS', cjsPostgres],
] as const;

type Proxied = {
  sql: postgres.Sql;
  /** Close the connection the way a pooler does and wait until the driver sees it. */
  closeServerSide: () => Promise<void>;
  /** Rejects if a query never settles. */
  stalled: Promise<never>;
};

async function withProxiedDriver(driver: typeof postgres, run: (proxied: Proxied) => Promise<void>) {
  await getTestDb()`SELECT 1`;
  const target = new URL(process.env.DATABASE_URL!);
  let downstream: net.Socket | undefined;
  const sockets: net.Socket[] = [];
  // A proxy lets the test send a clean FIN while the driver still holds the
  // connection, which is how a pooler restart closes it.
  const proxy = net.createServer((client) => {
    downstream = client;
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    sockets.push(client, upstream);
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  let sql: postgres.Sql | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const proxied = new URL(target);
    proxied.hostname = '127.0.0.1';
    proxied.port = String((proxy.address() as net.AddressInfo).port);
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    sql = driver(proxied.toString(), { max: 1, ...PROD_PG_VALUE_OPTIONS, onclose: resolveClosed });
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Closed connection query stalled')), 2000);
    });
    stalled.catch(() => {});
    await run({
      sql,
      stalled,
      closeServerSide: async () => {
        downstream!.end();
        await Promise.race([closed, stalled]);
      },
    });
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await sql?.end({ timeout: 0 });
    if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

describe('Postgres writes after the server closes a connection', () => {
  it.each(drivers)('%s rejects queries on a closed reservation instead of crashing', async (_name, driver) => {
    await withProxiedDriver(driver, async ({ sql, closeServerSide, stalled }) => {
      const reserved = await sql.reserve();
      await reserved`SELECT 1`;
      await closeServerSide();

      // A reserved connection is pinned, so the pool cannot rotate the dead
      // one away. Buffered writes, immediate flushes and describe-first
      // queries through it must all settle as a catchable error.
      for (const query of [
        reserved`SELECT 1`,
        reserved.unsafe(`SELECT 1 /* ${'x'.repeat(2048)} */`),
        reserved`SELECT ${1}::int`,
        reserved`SELECT 2`,
      ]) {
        await expect(Promise.race([query, stalled])).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
      }
      reserved.release();
    });
  });

  it.each(drivers)('%s rejects a cursor continued after the connection closed', async (_name, driver) => {
    await withProxiedDriver(driver, async ({ sql, closeServerSide, stalled }) => {
      let batches = 0;
      // The cursor asks for its next batch only after this callback returns,
      // so that request is written after the socket is gone.
      const cursor = sql`SELECT generate_series(1, 10) AS n`.cursor(1, async () => {
        batches += 1;
        if (batches === 1) await closeServerSide();
      });
      await expect(Promise.race([cursor, stalled])).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
      expect(batches).toBe(1);
    });
  });
});

describe('Postgres cold connection reservations', () => {
  it.each(drivers)('%s reserves cold connections and returns them to the pool', async (_name, driver) => {
    await getTestDb()`SELECT 1`;
    const sql = driver(process.env.DATABASE_URL!, { max: 2, ...PROD_PG_VALUE_OPTIONS });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Auth uses reserve() on the same pool as entity transactions. With
      // fetch_types:false, cold reservations must finish without another query
      // first warming the pool; otherwise auth silently exhausts its capacity.
      await Promise.race([
        (async () => {
          const connections = await Promise.all([sql.reserve(), sql.reserve()]);
          try {
            const rows = await Promise.all(connections.map(conn => conn`SELECT pg_backend_pid() AS pid`));
            expect(new Set(rows.map(result => result[0].pid)).size).toBe(2);
          } finally {
            for (const connection of connections) connection.release();
          }
          await sql.begin(async tx => {
            expect((await tx`SELECT 1 AS value`)[0].value).toBe(1);
            expect((await sql`SELECT 2 AS value`)[0].value).toBe(2);
          });
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Cold reservation stalled')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await sql.end({ timeout: 0 });
    }
  });
});
