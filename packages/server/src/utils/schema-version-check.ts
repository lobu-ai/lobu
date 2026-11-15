/**
 * Boot-time schema-version assertion.
 *
 * Checks every migration version present in `db/migrations/` against the
 * database's `schema_migrations` ledger. If a required migration is missing,
 * throws — the server boot path catches it, logs, and exits non-zero so the
 * pod fails readiness and Kubernetes refuses to route traffic.
 *
 * Why: on 2026-05-16 the pre-upgrade migration Job for
 * `20260516200000_events_search_tsv.sql` timed out at 60s (table rewrite on
 * a 1.15M-row events table under ACCESS EXCLUSIVE > statement_timeout). The
 * Job exited non-zero, but the app Deployment rolled forward anyway with an
 * image that queried the new view's `search_tsv` column. Every request
 * through the affected paths threw; the pod OOM'd and CrashLoopBackOff'd.
 * A boot-time gate would have refused to start that image and kept the
 * previous version serving traffic.
 */

import { readdirSync } from 'node:fs';
import type { DbClient } from '../db/client';
import { assertUniqueMigrationVersions } from '../db/migration-loader';
import logger from './logger';

const MIGRATION_FILENAME_RE = /^(\d+)_[^/]+\.sql$/;

/**
 * Read the required version prefixes from the image's migration files.
 * Returns an empty list if the directory is empty / unreadable —
 * that case is treated as "no expectation" rather than failing closed, so a
 * dev environment without migrations checked out doesn't deadlock boot.
 */
function readExpectedSchemaVersions(migrationsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir);
  } catch (err) {
    logger.warn(
      { err, migrationsDir },
      '[schema-check] migrations directory not readable — skipping schema-version assertion'
    );
    return [];
  }

  assertUniqueMigrationVersions(entries);

  return entries.flatMap((name) => {
    const match = MIGRATION_FILENAME_RE.exec(name);
    return match ? [match[1]!] : [];
  }).sort();
}

export function readExpectedSchemaVersion(migrationsDir: string): string | null {
  return readExpectedSchemaVersions(migrationsDir).at(-1) ?? null;
}

interface SchemaVersionMismatch {
  kind: 'mismatch';
  expected: string;
  applied: string | null;
}

interface SchemaVersionOk {
  kind: 'ok';
  expected: string | null;
  applied: string | null;
}

/**
 * Compare expected (from disk) vs applied (from DB). Returns a discriminated
 * union the caller can branch on, instead of throwing — keeps tests cheap.
 */
export function compareSchemaVersions(
  expected: string | null,
  applied: string | null
): SchemaVersionOk | SchemaVersionMismatch {
  if (expected === null) return { kind: 'ok', expected, applied };
  if (applied !== null && applied >= expected) {
    return { kind: 'ok', expected, applied };
  }
  return { kind: 'mismatch', expected, applied };
}

/**
 * Boot-time assertion: throws if the database is behind the image's
 * migrations directory. Call once during server startup, before opening the
 * HTTP listener.
 *
 * Fails closed in production: if `migrationsDir` can't be listed (bad path,
 * missing copy in the image, wrong volume mount), `NODE_ENV=production`
 * treats that as a deployment defect and throws. In dev a missing/empty
 * directory degrades to a warning — so `bun run dev` from a worktree that
 * doesn't have `db/` checked out still boots.
 */
export async function assertSchemaUpToDate(
  sql: DbClient,
  options: { migrationsDir: string }
): Promise<void> {
  const required = readExpectedSchemaVersions(options.migrationsDir);
  const expected = required.at(-1) ?? null;

  if (expected === null && process.env.NODE_ENV === 'production') {
    const msg =
      `[schema-check] migrations directory ${options.migrationsDir} is empty or unreadable in a ` +
      `production build — the image is missing db/migrations. Refusing to start.`;
    logger.error({ migrationsDir: options.migrationsDir }, msg);
    throw new Error(msg);
  }

  // A newer ledger entry can coexist with an unapplied older migration.
  // Extra newer entries remain compatible with an older image.
  const rows = (await sql`SELECT version FROM public.schema_migrations`) as Array<{ version: string }>;
  const appliedVersions = new Set(rows.map((row) => row.version));
  const applied = [...appliedVersions].sort().at(-1) ?? null;
  const missing = required.filter((version) => !appliedVersions.has(version));

  if (missing.length > 0) {
    const msg =
      `[schema-check] database is behind the image. Missing required migrations: ${missing.join(', ')}. ` +
      `The highest applied version is ${applied ?? '(none)'}. ` +
      `Run \`dbmate up\` against this database before rolling out this image.`;
    logger.error(
      { expected, applied, missing, migrationsDir: options.migrationsDir },
      msg
    );
    throw new Error(msg);
  }

  logger.info(
    { expected, applied },
    '[schema-check] schema version up to date'
  );
}
