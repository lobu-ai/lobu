import { createRequire } from 'node:module';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PROD_PG_VALUE_OPTIONS } from '../../db/client';
import { getTestDb } from '../setup/test-db';

const require = createRequire(import.meta.url);
const cjsPostgres: typeof postgres = require('postgres');

describe('Postgres cold connection reservations', () => {
  it.each([
    ['ESM', postgres],
    ['CommonJS', cjsPostgres],
  ] as const)('%s reserves cold connections and returns them to the pool', async (_name, driver) => {
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
