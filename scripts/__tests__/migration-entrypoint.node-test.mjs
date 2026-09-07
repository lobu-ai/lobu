import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// Run with `node --test <this file>`. The name sits outside bun's `*.test.*`
// discovery on purpose: `bun test scripts` must stay hermetic, and this suite
// needs a real PostgreSQL service.
// Explicit test service URL; each test creates and drops only its own database.
assert.ok(
  process.env.MIGRATION_TEST_DATABASE_URL,
  "MIGRATION_TEST_DATABASE_URL is required"
);
const admin = postgres(process.env.MIGRATION_TEST_DATABASE_URL, { max: 1 });
after(() => admin.end());
const root = fileURLToPath(new URL("../../", import.meta.url));
const actorMigration = "20260907183000_mcp_activity_actor_identity.sql";
const contractMigration = "20260622310000_drop_classifier_version_id.sql";

async function fixture(t) {
  const database = `migration_test_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const url = new URL(process.env.MIGRATION_TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  const dir = mkdtempSync(join(tmpdir(), "migration-entrypoint-"));
  t.after(async () => {
    await sql.end();
    await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
    rmSync(dir, { recursive: true, force: true });
  });
  const migrations = join(dir, "db/migrations");
  mkdirSync(join(migrations, "preconditions"), { recursive: true });
  copyFileSync(join(root, "docker/app/start.sh"), join(dir, "start.sh"));
  symlinkSync(join(root, "scripts"), join(dir, "scripts"), "dir");
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  const commands = join(dir, "kubectl.log");
  writeFileSync(commands, "");
  writeFileSync(
    join(dir, "kubectl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in *'get deployment'*) printf '1';; esac
`,
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    DATABASE_URL: url.toString(),
    NODE_ENV: "production",
    MIGRATIONS_DIR: migrations,
    MIGRATION_PENDING_CHECK: `node ${join(root, "scripts/migrate-up.mjs")} --check-pending`,
    KUBECTL_BIN: join(dir, "kubectl"),
    COMMAND_LOG: commands,
    NAMESPACE: "migration-test",
    APP_DEPLOYMENT: "test-api",
    APP_SELECTOR: "component=api",
    WORKER_DEPLOYMENT: "test-worker",
    WORKER_SELECTOR: "component=worker",
  };
  function run(args) {
    const result = spawnSync(args[0], args.slice(1), {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  }
  return {
    sql,
    dir,
    migrations,
    run,
    commands: () => readFileSync(commands, "utf8"),
    upgrade: () =>
      run([
        "sh",
        join(root, "charts/lobu/files/migrate-upgrade.sh"),
        "bash",
        join(dir, "start.sh"),
        "migrate",
      ]),
    migrate: () => run(["bash", join(dir, "start.sh"), "migrate"]),
    check: () =>
      run(["node", join(root, "scripts/migrate-up.mjs"), "--check-pending"]),
  };
}

async function contractFixture(t) {
  const f = await fixture(t);
  await f.sql.unsafe(`
    CREATE TABLE schema_migrations (version text PRIMARY KEY);
    CREATE TABLE event_classifications (classifier_id text);
    INSERT INTO event_classifications VALUES (NULL);
  `);
  writeFileSync(
    join(f.migrations, contractMigration),
    `-- migrate:up
ALTER TABLE event_classifications ALTER COLUMN classifier_id SET NOT NULL;
`
  );
  copyFileSync(
    join(root, "db/migrations/preconditions", contractMigration),
    join(f.migrations, "preconditions", contractMigration)
  );
  return f;
}

test("external backfill fails before scaling or migration; passes after backfill", async (t) => {
  const f = await contractFixture(t);
  const blocked = f.upgrade();
  assert.notEqual(blocked.status, 0, blocked.output);
  assert.match(blocked.output, /classifier_id.*NULL/);
  assert.equal(f.commands(), "", blocked.output);
  assert.equal((await f.sql`SELECT * FROM schema_migrations`).length, 0);
  const direct = f.migrate();
  assert.notEqual(direct.status, 0, direct.output);
  assert.match(direct.output, /classifier_id.*NULL/);
  await f.sql`UPDATE event_classifications SET classifier_id = 'synthetic-classifier'`;
  const applied = f.upgrade();
  assert.equal(applied.status, 0, applied.output);
  assert.match(f.commands(), /scale deployment test-api --replicas=0/);
  assert.match(f.commands(), /scale deployment test-worker --replicas=0/);
  assert.equal((await f.sql`SELECT * FROM schema_migrations`).length, 1);
  // An applied prerequisite is no longer evaluated.
  writeFileSync(
    join(f.migrations, "preconditions", contractMigration),
    "SELECT 1 / 0;"
  );
  assert.equal(f.check().status, 3);
});

test("read-only preconditions reject attempted writes without scaling", async (t) => {
  const f = await contractFixture(t);
  writeFileSync(
    join(f.migrations, "preconditions", contractMigration),
    "UPDATE event_classifications SET classifier_id = 'forbidden';"
  );
  const result = f.upgrade();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /read-only transaction/);
  assert.equal(f.commands(), "");
  assert.equal(
    (await f.sql`SELECT classifier_id FROM event_classifications`)[0]
      .classifier_id,
    null
  );
});

test("a broken precondition still blocks a no-quiesce migration", async (t) => {
  const f = await contractFixture(t);
  writeFileSync(
    join(f.migrations, contractMigration),
    "-- migrate:up\n-- lobu:no-quiesce\nSELECT 1;"
  );
  writeFileSync(
    join(f.migrations, "preconditions", contractMigration),
    "SELECT missing_column FROM event_classifications;"
  );
  const result = f.upgrade();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /missing_column/);
  assert.equal(f.commands(), "");
});

test("unreadable migration files abort before scaling", async (t) => {
  const f = await fixture(t);
  await f.sql`CREATE TABLE schema_migrations (version text PRIMARY KEY)`;
  symlinkSync(
    join(f.dir, "missing.sql"),
    join(f.migrations, "20990101000000_missing.sql")
  );
  const result = f.upgrade();
  assert.notEqual(result.status, 0, result.output);
  assert.equal(f.commands(), "");
});

test("missing directives and unmatched prerequisites abort before scaling", async (t) => {
  const f = await fixture(t);
  await f.sql`CREATE TABLE schema_migrations (version text PRIMARY KEY)`;
  const file = "20990101000000_probe.sql";
  writeFileSync(join(f.migrations, file), "SELECT 1;");
  const invalid = f.upgrade();
  assert.notEqual(invalid.status, 0, invalid.output);
  assert.match(invalid.output, /missing -- migrate:up/);
  assert.equal(f.commands(), "");
  writeFileSync(join(f.migrations, file), "-- migrate:up\nSELECT 1;");
  writeFileSync(
    join(f.migrations, "preconditions", "unmatched.sql"),
    "SELECT 1;"
  );
  const unmatched = f.upgrade();
  assert.notEqual(unmatched.status, 0, unmatched.output);
  assert.match(unmatched.output, /no matching migration/);
  assert.equal(f.commands(), "");
});

test("a compatible migration validates and applies without touching replicas", async (t) => {
  const f = await fixture(t);
  await f.sql`CREATE TABLE schema_migrations (version text PRIMARY KEY)`;
  const file = "20990101000000_compatible.sql";
  writeFileSync(
    join(f.migrations, file),
    "-- migrate:up\nSELECT 1;\n-- migrate:down\n-- lobu:no-quiesce\nSELECT 1;"
  );
  // A rollback-only compatibility declaration cannot authorize the upgrade.
  assert.equal(f.check().status, 0);
  writeFileSync(
    join(f.migrations, file),
    "-- migrate:up\n-- lobu:no-quiesce\nCREATE TABLE test_projection (id int);"
  );
  writeFileSync(join(f.migrations, "preconditions", file), "SELECT 1;");
  assert.equal(f.check().status, 4);
  const result = f.upgrade();
  assert.equal(result.status, 0, result.output);
  assert.equal(f.commands(), "");
  assert.equal((await f.sql`SELECT * FROM test_projection`).length, 0);
  assert.equal(f.check().status, 3);
});

test("legacy MCP NULL actors rebuild through the production entrypoint and hook", async (t) => {
  const f = await fixture(t);
  // Apply the actual historical schema, then seed the state the empty-DB CI missed.
  for (const file of readdirSync(join(root, "db/migrations"))) {
    if (file.endsWith(".sql") && file < actorMigration) {
      copyFileSync(join(root, "db/migrations", file), join(f.migrations, file));
    }
  }
  copyFileSync(
    join(root, "db/migrations/preconditions", contractMigration),
    join(f.migrations, "preconditions", contractMigration)
  );
  const previous = f.migrate();
  assert.equal(previous.status, 0, previous.output);
  await f.sql.unsafe(`
    INSERT INTO organization (id, name, slug) VALUES ('synthetic-org', 'Migration test', 'migration-test');
    INSERT INTO public."user" (id, name, email) VALUES ('synthetic-user', 'Migration test', 'migration@example.test');
    INSERT INTO oauth_clients (id, redirect_uris) VALUES ('synthetic-client', ARRAY['https://example.test/callback']);
    INSERT INTO mcp_client_conversations (organization_id, client_identity, conversation_id, last_action)
      SELECT 'synthetic-org', 'synthetic-client', 'legacy-' || n, 'test_action' FROM generate_series(1, 3) n;
    INSERT INTO events (organization_id, client_id, created_by, semantic_type, origin_type, metadata, payload_data, occurred_at)
      VALUES ('synthetic-org', 'synthetic-client', 'synthetic-user', 'audit', 'tool_invocation',
        '{"mcp_conversation_id":"known-actor"}', '{"tool_name":"test_action","success":true}', now());
  `);
  const eventsBefore = await f.sql`SELECT * FROM events ORDER BY id`;
  copyFileSync(
    join(root, "db/migrations", actorMigration),
    join(f.migrations, actorMigration)
  );
  assert.equal(f.check().status, 0);
  assert.equal(
    (await f.sql`SELECT * FROM mcp_client_conversations WHERE user_id IS NULL`)
      .length,
    3
  );
  const upgraded = f.upgrade();
  assert.equal(upgraded.status, 0, upgraded.output);
  assert.match(f.commands(), /scale deployment test-api --replicas=0/);
  assert.deepEqual(
    Array.from(
      await f.sql`SELECT user_id, conversation_id FROM mcp_client_conversations`
    ),
    [{ user_id: "synthetic-user", conversation_id: "known-actor" }]
  );
  assert.deepEqual(await f.sql`SELECT * FROM events ORDER BY id`, eventsBefore);
  assert.equal(f.check().status, 3);
  const replay = f.migrate();
  assert.equal(replay.status, 0, replay.output);
  assert.deepEqual(await f.sql`SELECT * FROM events ORDER BY id`, eventsBefore);
});
