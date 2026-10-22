/**
 * PostgreSQL Database Client
 *
 * Provides a singleton postgres.js pool via getDb(), plus factory functions
 * for creating additional connections when needed.
 */

import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres, { type Sql } from 'postgres';
import type { Env } from '../index';
import logger from '../utils/logger';

/**
 * SQL client interface — a postgres.js tagged-template client.
 */
export type DbQuery<T = any> = Promise<T[] & { count: number }>;

export interface DbClient {
  <T = any>(strings: TemplateStringsArray, ...values: unknown[]): DbQuery<T>;
  unsafe<T = any>(query: string, params?: unknown[], queryOptions?: unknown): DbQuery<T>;
  array<T extends string | number>(values: T[], type?: string): unknown;
  json(value: unknown): unknown;
  begin<T>(fn: (sql: DbClient) => Promise<T>): Promise<T>;
  /**
   * Run `fn` inside a SAVEPOINT. A statement that errors inside `fn` rolls back
   * only to the savepoint instead of aborting the whole transaction, so callers
   * can recover (e.g. retry an INSERT with a different value) or skip a single
   * failing item without poisoning the surrounding `begin()` transaction. Only
   * valid when the client is already inside a transaction.
   */
  savepoint<T>(fn: (sql: DbClient) => Promise<T>): Promise<T>;
  end?: () => Promise<void>;
}

/**
 * Format a JS string array as a PostgreSQL array literal.
 *
 * postgres.js with `fetch_types: false` can't auto-serialize JS arrays
 * into PostgreSQL array values. This helper produces a literal like
 * `{"value1","value2"}` that can be used with a `::text[]` cast.
 */
export function pgTextArray(values: (string | null)[]): string {
  const escaped = values.map((v) =>
    v === null ? 'NULL' : '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  );
  return '{' + escaped.join(',') + '}';
}

/**
 * Format a JS number array as a PostgreSQL bigint[] literal.
 */
export function pgBigintArray(values: number[]): string {
  const normalized = values.map((value) => String(Math.trunc(value)));
  return '{' + normalized.join(',') + '}';
}

/**
 * Coerce a Postgres timestamp column value to epoch milliseconds, defaulting to
 * `Date.now()` when the row carried no value.
 *
 * postgres.js may hand a `Date` (typed timestamp) or a raw string/number
 * (untyped / `fetch_types: false`), so row mappers all wrote the same
 * `x instanceof Date ? x.getTime() : (x ?? Date.now())` triad. Use this instead.
 */
export function tsTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

/**
 * Like {@link tsTime}, but returns `undefined` (not "now") when the row carried
 * no value — for optional timestamps such as `last_used_at` where absence is
 * meaningful and must not be coerced to the current time.
 */
export function tsTimeOrNull(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

/**
 * Parse a value that may be a JS array or a PostgreSQL array literal
 * (`{a,b,"c d"}`) into a string array. Quoted elements are unquoted and
 * `\"` / `\\` escapes are resolved.
 *
 * The separator is only a separator OUTSIDE quotes: PostgreSQL quotes any
 * element containing a comma, so `{"https://x/cb?tags=a,b"}` is ONE element.
 * Splitting on every comma would shred it into two invalid ones.
 */
export function parsePgTextArray(
  raw: string | string[] | null | undefined
): string[] {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === '' || raw === '{}') return [];
  const inner =
    raw.startsWith('{') && raw.endsWith('}') ? raw.slice(1, -1) : raw;
  if (inner === '') return [];
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoted = false;
  let escaped = false;
  for (const ch of inner) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoted = true;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(quoted ? current : current.trim());
      current = '';
      quoted = false;
      continue;
    }
    current += ch;
  }
  out.push(quoted ? current : current.trim());
  return out;
}

/**
 * Parse a value that may be a JS array or a PostgreSQL array literal
 * (`{1,2,3}`) into a number array, dropping non-finite entries.
 */
export function parsePgNumberArray(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  if (typeof raw === 'string') {
    return raw
      .replace(/[{}]/g, '')
      .split(',')
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite);
  }
  return [];
}

// PostgreSQL type OIDs
const PG_OID_JSON = 114;
const PG_OID_JSONB = 3802;

// =========================================================
// PostgreSQL client factory
// =========================================================

interface CreatedDbClient {
  /** Client used by application code. */
  wrapped: DbClient;
  /** Raw postgres.js Sql client (same instance as `wrapped`); named for the
   *  call sites that need the full Sql surface, e.g. Kysely via reserve(). */
  raw: Sql;
}

/**
 * postgres.js options that control how VALUES are (de)serialized — as opposed
 * to pool/connection knobs. These MUST be shared verbatim by every client that
 * stands in for prod (notably the integration-test client, `getTestDb()`):
 * `fetch_types: false` changes type inference, and a query whose correctness
 * depends on it (e.g. `= ANY(${jsArray})`, which needs `pgTextArray(...)::text[]`)
 * behaves differently between a fetch-types client and this one. Tests that run
 * against a different value-serialization config silently mask that class of bug.
 */
export const PROD_PG_VALUE_OPTIONS = {
  fetch_types: false,
  transform: {
    value: {
      // IMPORTANT: fetch_types: false means postgres.js doesn't auto-parse
      // JSON/JSONB columns. This transform runs on every value in every row
      // (both tagged-template and sql.unsafe() queries) and parses any
      // JSON/JSONB column based on its PostgreSQL OID. This is the single
      // source of truth for JSONB parsing — no per-field workarounds needed.
      from: (value: unknown, column: { type: number }) => {
        if (
          (column.type === PG_OID_JSON || column.type === PG_OID_JSONB) &&
          typeof value === 'string'
        ) {
          try {
            return JSON.parse(value);
          } catch {
            return value;
          }
        }
        return value;
      },
    },
  },
  types: {
    bigint: {
      to: 20,
      from: [20],
      parse: (value: string) => {
        const num = Number(value);
        if (process.env.NODE_ENV === 'development' && !Number.isSafeInteger(num)) {
          logger.warn({ value, parsed: num }, 'BIGINT value exceeds safe integer range');
        }
        return num;
      },
      serialize: (value: number) => String(value),
    },
  },
};

function createDbClient(connectionString: string, maxConnections?: number): CreatedDbClient {
  const poolMax = maxConnections ?? parseInt(process.env.DB_POOL_MAX || '20', 10);

  const rawClient = postgres(connectionString, {
    max: poolMax,
    // Keep connections forever client-side. Postgres handles eviction via its
    // own idle/lifetime settings; recycling every 20s on the client side
    // forces every spotty-traffic burst to pay a ~1s TCP+TLS handshake.
    idle_timeout: 0,
    // Cap connection lifetime so long-lived sockets survive a finite duration
    // (defends against PG-side state drift, certificate rotations, etc.).
    max_lifetime: 60 * 30,
    connection: {
      application_name: 'server',
    },
    ...PROD_PG_VALUE_OPTIONS,
  });

  // Hand back the raw postgres.js client directly. An earlier serialization
  // wrapper broke postgres.js fragment nesting (`sql`${query} AND …``) by
  // returning a Promise instead of a PendingQuery, which surfaced as
  // "syntax error at or near \"$1\"" from tools like manage_connections.
  const dbClient = rawClient as unknown as DbClient;
  return { wrapped: dbClient, raw: rawClient };
}

/**
 * Create a database client from environment.
 * Reuses the singleton pool — kept for call-site compatibility.
 */
export function createDbClientFromEnv(_env: Env): DbClient {
  return getDb();
}

// =========================================================
// Singleton pool
// =========================================================

let dbSingleton: DbClient | null = null;
let rawDbSingleton: Sql | null = null;

function ensureSingleton(): void {
  if (dbSingleton) return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  const created = createDbClient(url);
  dbSingleton = created.wrapped;
  rawDbSingleton = created.raw;
  logger.info('[DB] PostgreSQL singleton pool created');
}

/**
 * Get the singleton PostgreSQL client.
 * Lazily created from DATABASE_URL on first call.
 */
export function getDb(): DbClient {
  ensureSingleton();
  return dbSingleton as DbClient;
}

/**
 * Close and reset the singleton PostgreSQL client.
 * Primarily used by tests that need strict connection handoff between setup and workers.
 */
export async function closeDbSingleton(): Promise<void> {
  if (rawDbSingleton?.end) {
    await rawDbSingleton.end();
  } else if (dbSingleton?.end) {
    await dbSingleton.end();
  }
  dbSingleton = null;
  rawDbSingleton = null;
  if (lockDbSingleton) {
    await lockDbSingleton.end();
    lockDbSingleton = null;
  }
  if (readinessDbSingleton) {
    const readiness = readinessDbSingleton;
    readinessDbSingleton = null;
    await readiness.end({ timeout: 0 });
  }
}

// =========================================================
// Dedicated readiness-probe connection
// =========================================================

let readinessDbSingleton: Sql | null = null;

/**
 * Budget for one readiness check, connect included. It stays under the
 * chart's readinessProbe.timeoutSeconds (3s) so an unreachable database
 * surfaces as a 503 the kubelet reads, not as a probe timeout.
 */
const READINESS_CHECK_TIMEOUT_MS = 2000;

/**
 * One connection reserved for `/health/ready`, kept apart from the main pool.
 *
 * Readiness answers "can this pod reach Postgres", not "is the main pool idle".
 * On the main pool the probe's `SELECT 1` queued behind whatever saturated it,
 * timed out on a healthy pod, and with a single replica k8s pulled the only
 * Service endpoint, so the ingress answered `503 no available server` to every
 * client. Same separation `getLockDb()` uses for advisory locks.
 */
function getReadinessDb(): Sql {
  if (!readinessDbSingleton) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is required');
    }
    readinessDbSingleton = postgres(url, {
      max: 1,
      // Keep the one connection warm between probes; only the first probe
      // after a connect or a max_lifetime recycle pays the handshake.
      idle_timeout: 0,
      max_lifetime: 60 * 30,
      connect_timeout: READINESS_CHECK_TIMEOUT_MS / 1000,
      // No statement_timeout startup GUC: PgBouncer rejects unsupported startup
      // parameters (see getLockDb). checkDatabaseReadiness bounds the round
      // trip client-side instead.
      connection: {
        application_name: 'server-readiness',
      },
    });
  }
  return readinessDbSingleton;
}

/**
 * Round-trip `SELECT 1` on the readiness connection, bounded by
 * READINESS_CHECK_TIMEOUT_MS. Rejects on a refused, failed, or hung
 * connection. A failed check discards the connection so a wedged socket
 * cannot pin every later probe; the next check dials fresh.
 */
export async function checkDatabaseReadiness(): Promise<void> {
  const sql = getReadinessDb();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`readiness SELECT 1 timed out after ${READINESS_CHECK_TIMEOUT_MS}ms`)
        ),
      READINESS_CHECK_TIMEOUT_MS
    );
  });
  try {
    await Promise.race([sql`SELECT 1`, deadline]);
  } catch (err) {
    if (readinessDbSingleton === sql) readinessDbSingleton = null;
    sql.end({ timeout: 0 }).catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// =========================================================
// Dedicated advisory-lock pool
// =========================================================

let lockDbSingleton: Sql | null = null;

/**
 * Tiny connection pool reserved for SESSION-level advisory locks
 * (`sql.reserve()` + `pg_advisory_lock` held across a critical section).
 *
 * Holding a session lock requires camping on a physical connection for the
 * whole critical section. Doing that on the MAIN pool starves it: with
 * N >= DB_POOL_MAX concurrent holders (or blocked waiters), lock connections
 * consume every slot and the critical sections' own queries/transactions —
 * which run on the main pool — can never be served. That is a permanent,
 * pool-wide deadlock (session advisory waits never time out).
 *
 * A separate pool breaks the cycle structurally: lock holders camp HERE while
 * their work runs on the main pool, so the dependency is one-directional and
 * deadlock-free for any pool size >= 1. Excess lock requests queue FIFO on
 * this pool and progress as holders finish. `lock_timeout` bounds any
 * advisory-lock wait so a stuck holder surfaces as a clean 55P03 error
 * instead of an unbounded stall.
 *
 * Keep `max` small: these connections exist only to pin lock ownership, and
 * every slot counts against the Postgres connection budget (see the
 * DB_POOL_MAX note in ci.yml).
 */
export function getLockDb(): Sql {
  if (!lockDbSingleton) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is required');
    }
    lockDbSingleton = postgres(url, {
      max: 3,
      // Match the main pool: keep connections; PG owns eviction.
      idle_timeout: 0,
      max_lifetime: 60 * 30,
      connection: {
        application_name: 'server-locks',
        // Do NOT set lock_timeout here as a startup GUC — Neon/PgBouncer and
        // other poolers reject unsupported startup parameters and the whole
        // reserve() fails with "unsupported startup parameter: lock_timeout".
        // withSessionAdvisoryLock SETs lock_timeout on the reserved session
        // instead.
      },
    });
    logger.info('[DB] PostgreSQL advisory-lock pool created');
  }
  return lockDbSingleton;
}

type AdvisoryLockKey = {
  namespace: string;
  /** Bound as an int4 by default; set `hashValue` to key on an arbitrary string. */
  value: string | number;
  hashValue?: boolean;
};

type SessionAdvisoryLockOptions = {
  /**
   * Session GUC bounding the advisory-lock WAIT (not a startup parameter —
   * poolers reject `lock_timeout` on connect). Expiry surfaces as 55P03.
   */
  timeout?: string;
  /**
   * Translate a 55P03 raised while ACQUIRING the lock. Scoped to acquisition
   * on purpose: a 55P03 thrown from inside `fn` is a different contention and
   * must not be relabelled as a lock-acquisition conflict.
   */
  onAcquireTimeout?: (err: unknown) => Error;
};

/**
 * Run `fn` while holding a SESSION-level Postgres advisory lock. Acquire and
 * release happen on ONE reserved connection so the session identity is stable
 * — any other pool connection serving the unlock would error `you don't own a
 * lock of type ExclusiveLock`.
 *
 * That connection comes from the DEDICATED lock pool (`getLockDb`), never the
 * main pool. Holders camp on it for the whole critical section while `fn` runs
 * its reads/transactions on the main pool; if holders camped on the main pool,
 * N >= DB_POOL_MAX concurrent locked writes would consume every slot and starve
 * their own handlers — a permanent pool-wide deadlock. With a separate pool the
 * dependency is one-directional and deadlock-free; excess requests queue FIFO.
 */
export async function withSessionAdvisoryLock<T>(
  key: AdvisoryLockKey,
  fn: () => Promise<T>,
  options: SessionAdvisoryLockOptions = {}
): Promise<T> {
  const { timeout = '30s', onAcquireTimeout } = options;
  const reserved = await getLockDb().reserve();
  const keyValue = key.hashValue
    ? reserved`hashtext(${String(key.value)})`
    : reserved`${key.value}`;
  let acquired = false;

  try {
    await reserved`SELECT set_config('lock_timeout', ${timeout}, false)`;
    try {
      await reserved`SELECT pg_advisory_lock(hashtext(${key.namespace}), ${keyValue})`;
    } catch (err) {
      // We do NOT hold the lock here, so the reserved session is clean; the
      // outer finally just releases it.
      if (onAcquireTimeout && (err as { code?: string }).code === '55P03') {
        throw onAcquireTimeout(err);
      }
      throw err;
    }
    acquired = true;
    try {
      return await fn();
    } finally {
      await reserved`SELECT pg_advisory_unlock(hashtext(${key.namespace}), ${keyValue})`;
      acquired = false;
    }
  } finally {
    // A failed unlock leaves the session still owning the lock; returning it to
    // the pool would leak the lock for the connection's whole lifetime, so kill
    // the backend instead — Postgres drops session advisory locks on exit.
    // Deliberately NOT released afterwards: postgres.js only reconnects a
    // connection it holds in its `closed` queue, and `release()` would move the
    // dead one into `open` (or hand it straight to a waiting reserve()), so the
    // next borrower would get a destroyed socket. Skipping release lets the
    // socket's own close handler requeue it for reconnect.
    if (acquired) {
      await reserved`SELECT pg_terminate_backend(pg_backend_pid())`.catch(
        () => undefined
      );
    } else {
      reserved.release();
    }
  }
}

/**
 * Kysely dialect bound to the singleton postgres.js client. Used by better-auth
 * so that auth queries share the same connection pool as the rest of the app
 * instead of opening a second pg.Pool with its own (cold-prone) connections.
 * PostgresJSDialect calls sql.reserve() to acquire a dedicated connection.
 */
export function getAuthDialect(): PostgresJSDialect {
  ensureSingleton();
  if (!rawDbSingleton) {
    throw new Error('rawDbSingleton was not initialized');
  }
  return new PostgresJSDialect({ postgres: rawDbSingleton });
}

/**
 * Raw postgres.js Sql client. Exposes the full postgres-js surface (most
 * notably `listen()` / `notify()`) which the `DbClient` wrapper does not.
 *
 * postgres-js's `sql.listen(channel, fn)` lazily constructs ONE dedicated
 * listener connection (max:1, idle_timeout:null) and multiplexes every
 * subscriber across the whole gateway onto that single connection. So all
 * caches + the runs queue all share one LISTEN socket via this entry point.
 */
function getRawDb(): Sql {
  ensureSingleton();
  if (!rawDbSingleton) {
    throw new Error('rawDbSingleton was not initialized');
  }
  return rawDbSingleton;
}

/**
 * Typed view of postgres-js's `sql.listen()` surface. Use this instead of
 * `getRawDb()` when you only need LISTEN/NOTIFY — keeps the broader Sql
 * type out of caller signatures and centralises the cast that postgres-js's
 * own typings sometimes need.
 *
 * `onListen` fires once on initial subscribe and again on every reconnect
 * (postgres-js's internal `onclose` re-issues LISTEN automatically); use
 * it to drop any cached state that may have crossed a missed-NOTIFY gap.
 */
interface DbListener {
  listen(
    channel: string,
    onNotify: (payload: unknown) => void,
    onListen?: () => void
  ): Promise<{ unlisten: () => Promise<unknown> }>;
}

export function getDbListener(): DbListener {
  return getRawDb() as unknown as DbListener;
}

/**
 * Verify that LISTEN/NOTIFY round-trips through the configured DATABASE_URL.
 *
 * Why this exists: pgbouncer in transaction-mode silently drops `LISTEN` (the
 * subscription is bound to the backend, but transaction-mode pooling returns
 * a different backend on the next checkout). RDS Proxy and other transaction-
 * mode poolers behave the same. `RunsQueue` depends on LISTEN being delivered
 * for sub-200ms dispatch wakeup; without the probe, a misconfiguration surfaces
 * as 200ms-poll queue latency with no error.
 *
 * Resolves with `void` on success. Rejects with a clear message after the
 * `timeoutMs` window if no notification arrives — the caller (server boot)
 * is expected to fail-fast.
 */
export async function probeListenNotify(timeoutMs = 1500): Promise<void> {
  const sql = getRawDb();
  const listener = getDbListener();
  const channel = `lobu_probe_${process.pid}_${Date.now().toString(36)}`;

  let received = false;
  let resolveReceived: (() => void) | null = null;
  const receivedPromise = new Promise<void>((res) => {
    resolveReceived = res;
  });

  const result = await listener.listen(channel, () => {
    received = true;
    resolveReceived?.();
  });

  try {
    await sql`SELECT pg_notify(${channel}, 'probe')`;

    const timeout = new Promise<void>((_, reject) => {
      const t = setTimeout(() => {
        if (received) return;
        reject(
          new Error(
            `LISTEN/NOTIFY probe timed out after ${timeoutMs}ms — DATABASE_URL ` +
              'appears to point at a transaction-mode connection pooler ' +
              '(pgbouncer transaction-mode, RDS Proxy, etc.) which silently ' +
              'drops LISTEN. The cache invalidation and runs-queue wakeup ' +
              'paths require a session-mode pool. Set DATABASE_URL to a ' +
              'session-mode endpoint (or session-mode pooler) and retry.'
          )
        );
      }, timeoutMs);
      t.unref?.();
    });

    await Promise.race([receivedPromise, timeout]);
  } finally {
    try {
      await result.unlisten();
    } catch {
      // ignore
    }
  }
}
