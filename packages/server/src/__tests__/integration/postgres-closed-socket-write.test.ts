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

/** Re-frames the server's byte stream into whole protocol messages for `rewrite`. */
function messageRewriter(rewrite: (message: Buffer) => Buffer) {
  let pending = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const out: Buffer[] = [];
    while (pending.length >= 5 && pending.length >= 1 + pending.readUInt32BE(1)) {
      const end = 1 + pending.readUInt32BE(1);
      out.push(rewrite(pending.subarray(0, end)));
      pending = pending.subarray(end);
    }
    return Buffer.concat(out);
  };
}

async function withProxiedDriver(
  driver: typeof postgres,
  run: (proxied: Proxied) => Promise<void>,
  rewriteServerMessage?: (message: Buffer) => Buffer
) {
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
    if (rewriteServerMessage) {
      const rewrite = messageRewriter(rewriteServerMessage);
      client.pipe(upstream);
      upstream.on('data', (chunk: Buffer) => client.write(rewrite(chunk)));
    } else {
      client.pipe(upstream).pipe(client);
    }
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

describe('Postgres transaction reservations under pipeline pressure', () => {
  it.each(drivers)('%s reserves BEGIN when the pipeline reaches capacity', async (_name, driver) => {
    await getTestDb()`SELECT 1`;
    const sql = driver(process.env.DATABASE_URL!, { max: 2, ...PROD_PG_VALUE_OPTIONS });
    try {
      const warm = await Promise.all([sql.reserve(), sql.reserve()]);
      await Promise.all(warm.map(connection => connection`SELECT 1`));
      for (const connection of warm) connection.release();

      // Use the normal 100-query pipeline, not max:1 (which disables the
      // driver's unreserved-BEGIN guard). The next BEGIN reaches its edge.
      const preceding = Array.from({ length: 200 }, () => sql`SELECT pg_sleep(0.01)`.execute());
      const transaction = sql.begin(async tx => {
        const [before] = await tx`SELECT pg_backend_pid() AS pid`;
        await tx`CREATE TEMP TABLE pipeline_reservation_test (value int) ON COMMIT DROP`;
        await tx`INSERT INTO pipeline_reservation_test VALUES (7)`;
        const [after] = await tx`SELECT pg_backend_pid() AS pid, value FROM pipeline_reservation_test`;
        expect(after).toEqual({ pid: before.pid, value: 7 });
      });
      // Attach both rejection handlers immediately; the failing BEGIN must
      // not escape as an unhandled rejection while preceding work drains.
      await Promise.all([...preceding, transaction]);
      expect((await sql`SELECT 1 AS reusable`)[0].reusable).toBe(1);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});

describe('Postgres replies stay matched to their queries', () => {
  it.each(drivers)('%s drops a connection whose replies it could not parse', async (_name, driver) => {
    let corrupted = false;
    // Repeat the marker statement's column description once, so the driver
    // caches a two-column statement whose rows carry one column: the shape of
    // a reply handed to the wrong query.
    const duplicateMarkerColumns = (message: Buffer) => {
      if (corrupted || message[0] !== 0x54 || !message.includes('desync_marker')) return message;
      corrupted = true;
      const fields = message.subarray(7);
      const doubled = Buffer.concat([message.subarray(0, 7), fields, fields]);
      doubled.writeUInt32BE(doubled.length - 1, 1);
      doubled.writeUInt16BE(message.readUInt16BE(5) * 2, 5);
      return doubled;
    };
    await withProxiedDriver(driver, async ({ sql, stalled }) => {
      await expect(Promise.race([sql`SELECT 'v' AS desync_marker`, stalled])).rejects.toMatchObject({
        code: 'ERR_OUT_OF_RANGE',
      });
      // The same statement on the same pool must not inherit that state.
      expect(await Promise.race([sql`SELECT 'v' AS desync_marker`, stalled])).toEqual([{ desync_marker: 'v' }]);
      expect(corrupted).toBe(true);
    }, duplicateMarkerColumns);
  });

  it.each(drivers)('%s keeps a canceled pipelined query in line with its replies', async (_name, driver) => {
    await getTestDb()`SELECT 1`;
    const sql = driver(process.env.DATABASE_URL!, { max: 1, ...PROD_PG_VALUE_OPTIONS });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await sql`SELECT 1`;
      const running = sql`SELECT pg_sleep(0.2)`.execute();
      // Both are written behind `running` on the one connection. `canceled`
      // is still running when its cancel request lands.
      const canceled = sql`SELECT pg_sleep(0.5), 1 AS a, 2 AS b`.execute();
      const behind = sql`SELECT 'behind' AS only`.execute();
      await new Promise((resolve) => setTimeout(resolve, 20));
      canceled.cancel();
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Canceled pipelined query never settled')), 3000);
      });
      await running;
      await expect(Promise.race([canceled, stalled])).rejects.toMatchObject({ code: '57014' });
      expect(await behind).toEqual([{ only: 'behind' }]);
      expect(await sql`SELECT 'behind' AS only`).toEqual([{ only: 'behind' }]);
    } finally {
      clearTimeout(timer);
      await sql.end({ timeout: 0 });
    }
  });

  it.each(drivers)('%s starts the next result at row zero after a query fails mid-result', async (_name, driver) => {
    await getTestDb()`SELECT 1`;
    const sql = driver(process.env.DATABASE_URL!, { max: 1, ...PROD_PG_VALUE_OPTIONS });
    try {
      // Four rows reach the client before the error, as with a statement
      // timeout or cancel during a large read.
      await expect(
        sql`SELECT CASE WHEN n < 5 THEN n ELSE 1 / (n - n) END AS n FROM generate_series(1, 100) n`
      ).rejects.toMatchObject({ code: '22012' });
      expect([...(await sql`SELECT 42 AS id`)]).toEqual([{ id: 42 }]);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});
