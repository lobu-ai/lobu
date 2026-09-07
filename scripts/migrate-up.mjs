#!/usr/bin/env node
/**
 * Apply db/migrations/*.sql the way dbmate `up` does, with one important fix:
 * `transaction:false` sections run statement-at-a-time so CREATE/DROP INDEX
 * CONCURRENTLY is not trapped inside Postgres's implicit multi-statement
 * transaction (required when a heal DO precedes CONCURRENTLY in the same file).
 *
 * Records versions in public.schema_migrations (dbmate-compatible).
 *
 * Usage:
 *   DATABASE_URL=... node scripts/migrate-up.mjs
 *   MIGRATIONS_DIR=/app/db/migrations node scripts/migrate-up.mjs
 *   DATABASE_URL=... node scripts/migrate-up.mjs --check-pending
 *
 * --check-pending applies nothing. It validates declared prerequisites
 * (db/migrations/preconditions/, see docs/MIGRATIONS.md) and reports whether
 * any migration file is missing from the ledger, encoding the answer in the
 * exit status so the chart's pre-upgrade hook can skip its scale-to-zero
 * quiesce on the common deploy that ships no schema change:
 *   0 - at least one migration is pending (the caller must quiesce)
 *   3 - the ledger is complete, nothing is pending (safe to skip the quiesce)
 *   4 - migrations are pending, but every one of them carries the author's
 *       `-- lobu:no-quiesce` declaration, so the old replicas can keep
 *       serving across the migration
 *   1 - validation failed or the answer is unknown (abort before quiescing)
 * Only 0 permits quiescing; 3 and 4 allow migration without stopping replicas.
 * Any other status, including a crash, must abort the deployment.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const CHECK_PENDING_NONE_EXIT = 3;
const CHECK_PENDING_COMPATIBLE_EXIT = 4;

/**
 * The author's assertion that the code deployed *before* this migration keeps
 * working against the post-migration schema -- the expand half of an
 * expand/contract pair, or a contract whose last reference went away in an
 * earlier deploy.
 *
 * There is deliberately no SQL analysis behind this. Backward compatibility is
 * a property of sequencing relative to the running code, not of the DDL verbs:
 * a DROP COLUMN is safe once nothing reads it, and a widened CHECK constraint
 * is safe because it only ever accepts more. The SQL cannot express either, so
 * only the author can make the call.
 */
const NO_QUIESCE_MARKER = /^--[ \t]*lobu:no-quiesce\b/m;

const checkPendingOnly = process.argv.slice(2).includes("--check-pending");
const migrationsDir =
  process.env.MIGRATIONS_DIR || join(process.cwd(), "db/migrations");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

function listMigrationFiles(dir) {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const ownerByVersion = new Map();
  for (const file of files) {
    const version = /^(\d+)_[^/]+\.sql$/.exec(file)?.[1];
    if (!version) continue;
    const owner = ownerByVersion.get(version);
    if (owner) {
      throw new Error(
        `Duplicate migration version ${version}: ${owner} and ${file}. ` +
          "Each schema_migrations ledger version must identify exactly one file."
      );
    }
    ownerByVersion.set(version, file);
  }
  return files;
}

function parseTransactionOption(markerLine) {
  return !/\btransaction\s*:\s*false\b/i.test(markerLine);
}

function loadMigrationUp(dir, file) {
  const content = readFileSync(join(dir, file), "utf-8");
  const upMarker = content.match(/^--\s*migrate:up(.*)$/m);
  if (!upMarker) throw new Error(`${file}: missing -- migrate:up directive`);
  const transaction = parseTransactionOption(upMarker[0]);
  const up = content.split(/^--\s*migrate:down.*$/m)[0];
  const sql = up
    .replace(/^--\s*migrate:up.*$/m, "")
    .replace(/^SET transaction_timeout = 0;\s*$/gm, "")
    .trim();
  return { sql, transaction, noQuiesce: NO_QUIESCE_MARKER.test(up) };
}

function loadPendingMigrations(applied) {
  const dir = join(migrationsDir, "preconditions");
  let checks = [];
  try {
    checks = readdirSync(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const file of checks) {
    if (!migrationFiles.includes(file)) {
      throw new Error(`Precondition ${file} has no matching migration`);
    }
  }
  return migrationFiles
    .filter((file) => !applied.has(file.split("_")[0]))
    .map((file) => ({
      file,
      ...loadMigrationUp(migrationsDir, file),
      precondition: checks.includes(file)
        ? readFileSync(join(dir, file), "utf8")
        : "",
    }));
}

async function validatePreconditions(sqlClient, pending) {
  const checks = pending.filter((migration) => migration.precondition);
  if (checks.length === 0) return;
  // Author-written assertions describe external prerequisites, not effects of
  // the migration itself. Postgres enforces read-only access before quiescence.
  await sqlClient.begin("read only", async (tx) => {
    await tx.unsafe("SET LOCAL statement_timeout = '10s'");
    for (const migration of checks) {
      try {
        await tx.unsafe(migration.precondition);
        console.log(`Precondition passed: ${migration.file}`);
      } catch (error) {
        throw new Error(
          `Precondition failed: ${migration.file}: ${error.message}`,
          { cause: error }
        );
      }
    }
  });
}

/** Dollar-quote / string-literal aware statement splitter (see migration-loader.ts). */
function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
      current += chunk;
      i += chunk.length;
      continue;
    }

    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      current += chunk;
      i += chunk.length;
      continue;
    }

    if (ch === "$") {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) {
          current += sql.slice(i);
          break;
        }
        current += sql.slice(i, close + tag.length);
        i = close + tag.length;
        continue;
      }
    }

    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < n) {
        current += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === ";") {
      pushCurrent();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  pushCurrent();
  return statements;
}

async function executeSection(sqlClient, section) {
  if (!section.sql.trim()) return;
  if (section.transaction) {
    await sqlClient.unsafe(section.sql);
    return;
  }
  for (const statement of splitSqlStatements(section.sql)) {
    await sqlClient.unsafe(statement);
  }
}

async function recordMigration(sqlClient, version) {
  await sqlClient.unsafe(
    `INSERT INTO public.schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
    [version]
  );
}

async function applyMigration(sqlClient, section, version) {
  if (section.transaction) {
    await sqlClient.begin(async (tx) => {
      await executeSection(tx, section);
      await recordMigration(tx, version);
    });
    return;
  }

  // CONCURRENTLY cannot share a transaction with the ledger write. These
  // migrations must therefore remain replay-safe, as dbmate also requires for
  // transaction:false migrations interrupted before their version is recorded.
  await executeSection(sqlClient, section);
  await recordMigration(sqlClient, version);
}

const migrationFiles = listMigrationFiles(migrationsDir);
const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
let migrationLockHeld = false;

if (checkPendingOnly) {
  // Read-only: no ledger table creation and no advisory lock, so this can run
  // while the old replicas are still serving. A version present in the ledger
  // but absent from disk is not pending — only the other direction blocks.
  let pending;
  try {
    const appliedRows = await sql.unsafe(
      `SELECT version FROM public.schema_migrations`
    );
    const applied = new Set(appliedRows.map((r) => r.version));
    pending = loadPendingMigrations(applied);
    await validatePreconditions(sql, pending);
  } catch (error) {
    console.error(
      `ERROR: could not determine pending migrations: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    await sql.end({ timeout: 1 }).catch(() => undefined);
    process.exit(1);
  }
  await sql.end({ timeout: 1 }).catch(() => undefined);
  if (pending.length === 0) {
    console.log("No pending migrations");
    process.exit(CHECK_PENDING_NONE_EXIT);
  }
  console.log(
    `Pending migrations (${pending.length}): ${pending.map((migration) => migration.file).join(", ")}`
  );

  // Quiescing costs a full scale-to-zero, which the ingress answers with 503.
  // A migration the running code can already serve against does not need it.
  const unmarked = pending.filter((migration) => !migration.noQuiesce);
  if (unmarked.length === 0) {
    console.log(
      "Every pending migration is marked -- lobu:no-quiesce; the quiesce can be skipped."
    );
    process.exit(CHECK_PENDING_COMPATIBLE_EXIT);
  }
  for (const { file } of unmarked) {
    console.log(`  ${file}: not marked -- lobu:no-quiesce`);
  }
  process.exit(0);
}

try {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version character varying(128) NOT NULL PRIMARY KEY
    )
  `);

  // start.sh runs on every replica. Serialize the ledger read + migration loop
  // on one Postgres session so two fresh pods cannot apply the same version.
  await sql.unsafe(`SELECT pg_advisory_lock(hashtext('lobu_migrate_up'))`);
  migrationLockHeld = true;

  const appliedRows = await sql.unsafe(
    `SELECT version FROM public.schema_migrations`
  );
  const applied = new Set(appliedRows.map((r) => r.version));
  const pending = loadPendingMigrations(applied);
  await validatePreconditions(sql, pending);

  for (const up of pending) {
    const { file } = up;
    const version = file.split("_")[0] ?? "";
    if (!up.sql) continue;

    console.log(`Applying: ${file}`);
    await sql.unsafe("SET search_path TO public");
    await applyMigration(sql, up, version);
    console.log(`Applied: ${file}`);
  }

  console.log("Migrations complete");
} finally {
  if (migrationLockHeld) {
    await sql
      .unsafe(`SELECT pg_advisory_unlock(hashtext('lobu_migrate_up'))`)
      .catch(() => undefined);
  }
  await sql.end({ timeout: 1 }).catch(() => undefined);
}
