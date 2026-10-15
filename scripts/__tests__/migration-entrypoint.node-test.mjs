import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
const migrationsRoot = join(root, "db/migrations");
const preconditionsRoot = join(migrationsRoot, "preconditions");
const actorMigration = "20260907183000_mcp_activity_actor_identity.sql";
const contractMigration = "20260622310000_drop_classifier_version_id.sql";
const retirementMigration =
  "20261009015900_retire_remaining_physical_merges.sql";

function sqlFiles(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

/** Copy head's migrations (and the sidecar of each copied one) into a fixture. */
function copyHeadMigrations(f, keep = () => true) {
  const sidecars = sqlFiles(preconditionsRoot);
  for (const file of sqlFiles(migrationsRoot)) {
    if (!keep(file)) continue;
    copyFileSync(join(migrationsRoot, file), join(f.migrations, file));
    if (sidecars.includes(file)) {
      copyFileSync(
        join(preconditionsRoot, file),
        join(f.migrations, "preconditions", file)
      );
    }
  }
}

/**
 * db/migrations as of the previous release tag, applied by the production
 * runner: the schema every release-to-release upgrade starts from. Throws when
 * no lobu-v* tag is reachable; give the checkout its tags (fetch-depth: 0)
 * rather than skipping, or the gate below silently stops gating.
 */
async function previousReleaseSchema(t) {
  const f = await fixture(t);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const tag = git("describe", "--tags", "--abbrev=0", "--match", "lobu-v*");
  const archive = join(f.dir, "previous-release.tar");
  git("archive", "--format=tar", "-o", archive, tag, "db/migrations");
  execFileSync("tar", ["-xf", archive, "-C", f.dir]);
  // Only the schema is wanted from the tag: head's sidecars are the subject.
  rmSync(join(f.migrations, "preconditions"), { recursive: true, force: true });
  mkdirSync(join(f.migrations, "preconditions"));
  const built = f.migrate();
  assert.equal(built.status, 0, built.output);
  return { f, tag, applied: sqlFiles(f.migrations) };
}

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

test("source-backed identity prerequisite handles fresh installs and rejects live stored rows", async (t) => {
  const f = await fixture(t);
  const prerequisite = readFileSync(
    join(
      root,
      "db/migrations/preconditions/20261003200000_drop_source_backed_entity_identity.sql"
    ),
    "utf8"
  );
  const check = () => f.sql.begin("read only", (tx) => tx.unsafe(prerequisite));

  await check();
  await f.sql.unsafe(`
    CREATE TABLE entity_types (id bigint PRIMARY KEY);
    CREATE TABLE entities (entity_type_id bigint, deleted_at timestamptz);
  `);
  await check();
  await f.sql.unsafe(`
    ALTER TABLE entity_types ADD COLUMN backing_sql text;
    INSERT INTO entity_types VALUES (1, 'SELECT 1 AS id'), (2, NULL);
    INSERT INTO entities VALUES (1, now()), (2, NULL);
  `);
  await check();
  await f.sql`INSERT INTO entities VALUES (1, NULL)`;
  await assert.rejects(check(), {
    code: "P0001",
    message:
      "stored entities exist on source-backed entity types; delete them before deploying",
  });
  assert.equal((await f.sql`SELECT * FROM entities`).length, 3);
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

// The runner evaluates every pending sidecar before any migration applies, so a
// sidecar may assert only external prerequisites, never another pending
// migration's effect (docs/MIGRATIONS.md). This enumerates the whole class:
// each sidecar, against the schema an operator actually upgrades from.
test("every precondition sidecar passes on the previous release's schema with no data", async (t) => {
  const { f, tag, applied } = await previousReleaseSchema(t);
  const sidecars = sqlFiles(preconditionsRoot);
  assert.ok(sidecars.length > 0, "no precondition sidecars found");
  const refusals = [];
  for (const file of sidecars) {
    try {
      await f.sql.begin("read only", (tx) =>
        tx.unsafe(readFileSync(join(preconditionsRoot, file), "utf8"))
      );
    } catch (error) {
      refusals.push(`${file}: ${error.message}`);
    }
  }
  assert.deepEqual(
    refusals,
    [],
    `sidecars that refuse an empty ${tag} database:\n${refusals.join("\n")}`
  );
  // The same upgrade through the production hook: head over that schema.
  copyHeadMigrations(f);
  const upgraded = f.upgrade();
  assert.equal(upgraded.status, 0, upgraded.output);
  for (const file of sqlFiles(f.migrations)) {
    if (!applied.includes(file)) {
      assert.ok(upgraded.output.includes(`Applied: ${file}`), upgraded.output);
    }
  }
  assert.equal(f.check().status, 3);
});

test("a physical merge left in the database is retired onto its survivor during the upgrade", async (t) => {
  const f = await fixture(t);
  // The schema exactly as the retirement migration finds it: head's history up
  // to the file before it. The redirect column still exists here.
  copyHeadMigrations(f, (file) => file < retirementMigration);
  const boundary = f.migrate();
  assert.equal(boundary.status, 0, boundary.output);
  await f.sql.unsafe(`
    INSERT INTO organization (id, name, slug) VALUES ('org-synth', 'Synthetic', 'synthetic');
    INSERT INTO "user" (id, name, email) VALUES ('user-synth', 'Synthetic', 'synthetic@example.test');
    INSERT INTO entity_types (id, organization_id, slug, name, metadata_schema) VALUES (901, 'org-synth', 'person', 'Person',
      '{"type":"object","x-lobu-resolution":{"rules":[{"fields":["email"],"normalizer":"email","onMatch":"auto_merge"},{"fields":["name"],"normalizer":"exact","onMatch":"review"}]}}');
    INSERT INTO entities (id, organization_id, entity_type_id, created_by, name, slug, deleted_at, merged_into) VALUES
      (9001, 'org-synth', 901, 'user-synth', 'Survivor', 'survivor', NULL, NULL),
      (9002, 'org-synth', 901, 'user-synth', 'Loser', 'loser', now(), 9001),
      (9003, 'org-synth', 901, 'user-synth', 'Other', 'other', NULL, NULL);
    INSERT INTO entities (id, organization_id, entity_type_id, created_by, name, slug, parent_id)
      VALUES (9004, 'org-synth', 901, 'user-synth', 'Child of loser', 'child', 9002);
    INSERT INTO events (organization_id, created_by, semantic_type, origin_type, metadata, payload_data, occurred_at, entity_ids) VALUES
      ('org-synth', 'user-synth', 'audit', 'synthetic', '{}', '{"n":1}', now(), ARRAY[9002, 9003, 9001]::bigint[]),
      ('org-synth', 'user-synth', 'audit', 'synthetic', '{}', '{"n":2}', now(), ARRAY[9002]::bigint[]),
      ('org-synth', 'user-synth', 'audit', 'synthetic', '{}', '{"n":3}', now(), ARRAY[9001, 9002, 9002, 9003]::bigint[]),
      ('org-synth', 'user-synth', 'audit', 'synthetic', '{}', '{"n":4}', now(), ARRAY[9003]::bigint[]);
    INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, merged_from_entity_id, deleted_at) VALUES
      ('org-synth', 9001, 'email', 'loser@example.test', 9002, NULL),
      ('org-synth', 9002, 'email', 'old@example.test', NULL, now()),
      ('org-synth', 9002, 'phone', '+15550100', NULL, NULL);
    INSERT INTO entity_merge_operations (organization_id, winner_entity_id, loser_entity_id, decision, status, ledger, merged_by) VALUES
      ('org-synth', 9001, 9002, 'human', 'active', '{}', 'user-synth'),
      ('org-synth', 9001, 9002, 'human', 'undone', '{"history":true}', 'user-synth');
    INSERT INTO automations (organization_id, created_by, automation_group_id, name, entity_ids)
      VALUES ('org-synth', 'user-synth', 1, 'Scoped', ARRAY[9002, 9001]::bigint[]);
    INSERT INTO channel_messages (organization_id, connection_id, platform, channel_id, platform_message_id, text, occurred_at, author_entity_id)
      VALUES ('org-synth', 'conn-synth', 'slack', 'C1', 'M1', 'hello', now(), 9002);
  `);
  const rows = async (query) => Array.from(await query);
  const snapshot = async () => ({
    events: (
      await rows(
        f.sql`SELECT entity_ids FROM events WHERE organization_id = 'org-synth' ORDER BY id`
      )
    ).map((row) => row.entity_ids),
    entities: await rows(
      f.sql`SELECT id, parent_id, deleted_at IS NOT NULL AS tombstoned FROM entities WHERE organization_id = 'org-synth' ORDER BY id`
    ),
    identities: await rows(
      f.sql`SELECT entity_id, namespace, identifier, merged_from_entity_id, deleted_at IS NOT NULL AS retired FROM entity_identities WHERE organization_id = 'org-synth' ORDER BY id`
    ),
    ledgers: await rows(
      f.sql`SELECT status, winner_entity_id, loser_entity_id, ledger FROM entity_merge_operations ORDER BY id`
    ),
    rules: (
      await f.sql`SELECT metadata_schema->'x-lobu-resolution'->'rules' AS rules FROM entity_types WHERE id = 901`
    )[0].rules,
    automations: (
      await rows(
        f.sql`SELECT entity_ids FROM automations WHERE organization_id = 'org-synth'`
      )
    ).map((row) => row.entity_ids),
    authors: (
      await rows(
        f.sql`SELECT author_entity_id FROM channel_messages WHERE organization_id = 'org-synth'`
      )
    ).map((row) => row.author_entity_id),
  });
  const otherEventColumns = async () =>
    (
      await rows(
        f.sql`SELECT * FROM events WHERE organization_id = 'org-synth' ORDER BY id`
      )
    ).map(({ entity_ids, ...rest }) => rest);
  const eventsBefore = await otherEventColumns();

  copyHeadMigrations(f, (file) => file === retirementMigration);
  // Declared `lobu:quiesce`: the hook must stop 21.2.1 replicas for it.
  assert.equal(f.check().status, 0);
  const retired = f.migrate();
  assert.equal(retired.status, 0, retired.output);
  const expected = {
    events: [["9001", "9003"], ["9001"], ["9001", "9003"], ["9003"]],
    entities: [
      { id: "9001", parent_id: null, tombstoned: false },
      { id: "9003", parent_id: null, tombstoned: false },
      { id: "9004", parent_id: "9001", tombstoned: false },
    ],
    identities: [
      {
        entity_id: "9001",
        namespace: "email",
        identifier: "loser@example.test",
        merged_from_entity_id: "9002",
        retired: false,
      },
      {
        entity_id: "9001",
        namespace: "phone",
        identifier: "+15550100",
        merged_from_entity_id: "9002",
        retired: false,
      },
    ],
    ledgers: [
      {
        status: "undone",
        winner_entity_id: "9001",
        loser_entity_id: "9002",
        ledger: { history: true },
      },
    ],
    rules: [
      { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
      { fields: ["name"], normalizer: "exact", onMatch: "review" },
    ],
    automations: [["9001"]],
    authors: ["9001"],
  };
  assert.deepEqual(await snapshot(), expected);
  assert.deepEqual(await otherEventColumns(), eventsBefore);
  assert.deepEqual(
    await rows(
      f.sql`SELECT count(*)::int AS redirects FROM entities WHERE merged_into IS NOT NULL`
    ),
    [{ redirects: 0 }]
  );
  // The same SQL again changes nothing.
  await f.sql.unsafe(
    readFileSync(join(migrationsRoot, retirementMigration), "utf8").split(
      "-- migrate:down"
    )[0]
  );
  assert.deepEqual(await snapshot(), expected);
  // The rest of head fences and drops the column over the repaired data.
  copyHeadMigrations(f);
  const upgraded = f.upgrade();
  assert.equal(upgraded.status, 0, upgraded.output);
  assert.deepEqual(await snapshot(), expected);
  assert.deepEqual(await otherEventColumns(), eventsBefore);
  assert.deepEqual(
    await rows(f.sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'entities' AND column_name = 'merged_into') AS redirect_column`),
    [{ redirect_column: false }]
  );
  assert.equal(f.check().status, 3);
});
