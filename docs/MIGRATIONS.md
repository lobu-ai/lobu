# Migrations

dbmate-managed SQL under `db/migrations/`. Names are `<UTC-yyyymmddHHMMSS>_<slug>.sql` with a `-- migrate:up` / `-- migrate:down` split. The pre-upgrade Helm hook invokes `docker/app/start.sh migrate`, which runs `scripts/migrate-up.mjs` against the database before the app rolls. The runner records versions in the dbmate-compatible ledger.

Most migrations are routine: an additive column, a small index, a view bump. The risk lives in the ones that **rewrite a hot table** or **rebuild a large index**. Get those wrong and prod stalls under `ACCESS EXCLUSIVE` until the database's `statement_timeout` fires, after which dbmate exits non-zero, the migration leaves no row in `schema_migrations`, and the app deploys forward into a schema it expects but doesn't have. That's the 2026-05-16 outage in one sentence ([PR #767](https://github.com/lobu-ai/lobu/pull/767)).

The rules below are what we wish #765 had followed.

---

## Always

- **Read what your DDL actually does.** Postgres has three speeds: `O(1)` metadata flip, `O(rows)` table rewrite under `ACCESS EXCLUSIVE`, and `O(rows)` write with regular row locks. Know which one you wrote.
- **State the operational cost in the migration body** as a comment, in seconds for the real table size, not "should be fast." Cite the row count you tested on. If you didn't test on the real size, say so.
- **Keep migrations idempotent on the up-side** when practical (`CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`). dbmate doesn't retry, but a half-applied transaction recovered manually is easier when the SQL is re-runnable.

---

## The deploy window (`-- lobu:no-quiesce` / `-- lobu:quiesce`)

Unless every pending migration declares `-- lobu:no-quiesce`, the pre-upgrade hook scales the app and workers **to zero** before migrating. This stops old replicas from accessing the changed schema. The ingress answers with 503 until replacement pods are ready; the window includes migration execution and pod startup.

**Every new migration declares its window**, and `make pre-pr` / CI fail one that doesn't (`scripts/check-migration-quiesce.mjs`). The check applies from version `20261015120001`; earlier migrations remain unchanged. Declare exactly one:

- `-- lobu:no-quiesce` — the old replicas keep serving across the migration.
- `-- lobu:quiesce <reason>` — they must stop first. The reason names what in the running code breaks against the new schema.

The expand half of an expand/contract pair — an additive nullable column, a comment, a new index — can leave the *old* code compatible with the new schema. Mark those to skip the scale-to-zero window; lock contention and other migration costs still need review:

```sql
-- migrate:up
-- lobu:no-quiesce  (additive: no code before this deploy selects the column)

ALTER TABLE public.device_workers
  ADD COLUMN IF NOT EXISTS agent_kinds text[];
```

Rules:

- A declaration must be **its own comment line starting at column 0**, before `-- migrate:down`. Prose mentioning it does not arm it.
- `lobu:no-quiesce` asserts something about the **application**, not the DDL: that the code running *before* this deploy keeps working against the post-migration schema. The declaration checker does not inspect your SQL, because backward compatibility depends on sequencing relative to the running code. For example, a `DROP COLUMN` may be compatible once nothing reads or writes that column. Only you know whether the running code still depends on what changes.
- **Every** pending migration in the deploy must declare exactly one `lobu:no-quiesce`, or the whole batch quiesces. A missing or conflicting declaration removes the fast path for all of them.
- An unmarked migration quiesces only after validation succeeds. An unreadable migration, failed prerequisite, or crashed pending check aborts deployment before any scaling. A missing pending-check command also aborts.

Declare `-- lobu:quiesce <reason>` when the running code would actually break: a column it still reads is going away, a constraint is being tightened under it, or a new `NOT NULL` column has no `DEFAULT` to fill in for inserts that predate it. That is what the window exists for.

---

## External migration prerequisites

When a migration requires an operator to complete work **before deployment**, add a SQL sidecar at `db/migrations/preconditions/<exact migration filename>`. The runner executes sidecars for pending migrations in a read-only transaction with a 10-second statement timeout, before the upgrade hook stops any replicas. A failed assertion, SQL error, timeout, or unreadable file blocks deployment. A sidecar with no matching migration is an error.

Use `DO` / `RAISE EXCEPTION` with an actionable message to assert a prerequisite. A successful statement passes; returning `false` from a `SELECT` does **not** fail a check. Sidecars cannot backfill or change the schema. They must handle the schema before *any* pending migration runs, including a fresh install where an earlier expand migration has not created the table or column yet. The classifier contract sidecar is an example of an external backfill check.

Do not declare an external prerequisite when the migration itself repairs the data. The runner does not infer prerequisites by scanning `SET NOT NULL`: a migration can legitimately clear, rebuild, or backfill those NULLs before adding its constraint. Keep assertions about intermediate migration state inside that migration.

**A sidecar may only assert an external prerequisite — never the effect of another pending migration.** The runner evaluates every pending sidecar before any migration applies, so a sidecar that requires a constraint, column, or index created by an earlier migration refuses every install where that earlier migration is also pending: anyone upgrading release to release, even with nothing to fix. If a migration needs an earlier migration's effect, the filename order already provides it; if it needs data repaired, repair it in a migration that sorts first. The 21.2.1→22.0.0 upgrade was blocked this way once (two sidecars demanded a validated fence that a migration in the same batch creates), which is why `scripts/__tests__/migration-entrypoint.node-test.mjs` runs every sidecar against the previous release tag's schema with no data.

The same runner checks prerequisites under its existing advisory lock before applying migrations, including direct startup and fresh installs. This recheck can catch a prerequisite that changed after the hook's check; it is not a guarantee that concurrent writers cannot invalidate data later. Applied migrations do not rerun their sidecars. Keep sidecars with their owning migrations when squashing or removing history. Historical migration SQL remains immutable, but a sidecar is not ledgered: it may be corrected or deleted after it ships, and CI's immutability check excludes `db/migrations/preconditions/` for that reason.

---

## Watch out for

### `ADD COLUMN ... GENERATED ALWAYS AS (...) STORED`

This rewrites every row to materialize the generated value. On the 1.15M-row `events` table the rewrite took >60s and tripped the DB's `statement_timeout`. Do not use `GENERATED STORED` on any table over ~100k rows during a Helm hook.

**Safe pattern:**

```sql
-- migrate:up

-- Step 1: nullable column, no backfill, no rewrite. O(1).
ALTER TABLE events ADD COLUMN IF NOT EXISTS search_tsv tsvector;

-- Step 2: trigger so new rows get the value (fast inserts; trigger overhead
-- is the cost of doing this incrementally).
CREATE OR REPLACE FUNCTION events_set_search_tsv() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.payload_text, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_set_search_tsv ON events;
CREATE TRIGGER trg_events_set_search_tsv
  BEFORE INSERT OR UPDATE OF title, payload_text ON events
  FOR EACH ROW EXECUTE FUNCTION events_set_search_tsv();
```

Then **backfill in a separate migration / script** that runs in batches outside the Helm hook (e.g. a `BATCH_BACKFILL=1`-gated boot path or a `scripts/backfill-*.sh` runbook):

```sql
UPDATE events SET search_tsv =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(payload_text, '')), 'B')
WHERE id BETWEEN $START AND $END AND search_tsv IS NULL;
```

Pace ~10k rows per batch with a sleep between batches; each batch is its own transaction so VACUUM can keep up.

### `CREATE INDEX` on a large table

Plain `CREATE INDEX` takes a `SHARE` lock on the table — reads still work, but **writes block** for the duration of the build. On `events` that's seconds of stalled INSERTs.

**Safe pattern:** `CREATE INDEX CONCURRENTLY`. Multiple passes, but only takes `SHARE UPDATE EXCLUSIVE` so reads + writes continue.

```sql
-- CONCURRENTLY does not run inside a transaction. dbmate runs each .sql
-- file in a single implicit transaction unless you opt out, so:
--
-- migrate:up transaction:false
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_search_tsv
  ON events USING gin (search_tsv);
```

If the migration *must* be one file with the column-add too, the column-add stays in a normal transaction-wrapped migration and the index is a follow-up `transaction:false` migration.

**`CONCURRENTLY` + `IF NOT EXISTS` trap:** if a previous `CREATE INDEX CONCURRENTLY` failed mid-build (timeout, deadlock, connection dropped), Postgres leaves an **invalid** index behind. The index *name* exists, so the next `CREATE INDEX CONCURRENTLY IF NOT EXISTS` skips the rebuild — and now your "successful" deploy is using a half-built index that the planner refuses to read from. Before retrying, check:

```sql
SELECT i.relname, x.indisvalid
  FROM pg_class i
  JOIN pg_index x ON x.indexrelid = i.oid
 WHERE i.relname = 'idx_events_search_tsv';
```

If `indisvalid = false`, drop it with `DROP INDEX CONCURRENTLY idx_events_search_tsv;` (also `transaction:false`) and retry the create.

### `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`

Postgres has to verify every row, scanning the whole table under `ACCESS EXCLUSIVE`. On a hot table this stalls.

**Safe pattern (PG 12+):** add a `CHECK (col IS NOT NULL) NOT VALID` first, run `ALTER TABLE … VALIDATE CONSTRAINT` (only takes `SHARE UPDATE EXCLUSIVE`), then `ALTER COLUMN SET NOT NULL` becomes `O(1)` because the constraint already proves the property.

```sql
ALTER TABLE events ADD CONSTRAINT events_title_not_null
  CHECK (title IS NOT NULL) NOT VALID;
ALTER TABLE events VALIDATE CONSTRAINT events_title_not_null;
ALTER TABLE events ALTER COLUMN title SET NOT NULL;
ALTER TABLE events DROP CONSTRAINT events_title_not_null;
```

### Cascading `ON DELETE SET NULL` / `ON DELETE CASCADE` on hot tables

A single `DELETE FROM connections WHERE id IN (...)` triggers an internal `UPDATE events SET connection_id = NULL WHERE connection_id IN (...)`. For a connection with 92k events that's a 13s blocking UPDATE — visible to ops as "the admin action hung the API."

**Safe pattern:** keep cascades for *small* parent tables only. For parents that fan out to events, automation_run_events, or anything else 100k+ rows wide:

1. Make sure the **child FK column is indexed** (e.g. `idx_events_connection_id`) — without it, the cascade falls back to a seq scan and the UPDATE goes from 13s to minutes.
2. Manage the dependent nulling in application code with batched UPDATEs (e.g. 1k rows per loop, sleep between).
3. Run the parent `DELETE` only **after** the child rows are already nulled/orphaned — the cascade then has nothing to do and the delete is fast.

Indexing alone helps the cascade, but it doesn't eliminate the per-row WAL write; batching before the delete is what keeps the API responsive.

**Lobu-specific policy:** **connections are never hard-deleted in prod.** Setting `connections.deleted_at` is the final state. The `events_connection_id_fkey ... ON DELETE SET NULL` cascade exists in the schema for completeness, but actually invoking it (`DELETE FROM connections WHERE deleted_at IS NOT NULL`) blocks the API for ~13s per connection at current scale — the 2026-05-16 `pg_stat_statements` showed exactly this pattern at rank #8 (5 calls × 13.4s each). Soft-deleted connections cost ~50 bytes apiece in the `connections` table; the occasional accumulation isn't worth the recurring stall. The connection-creation rollback path in `tools/admin/manage_connections.ts` (which only deletes never-activated rows that have no events yet) is the only acceptable use of `DELETE FROM connections`.

### Bare `DROP INDEX`

Takes `ACCESS EXCLUSIVE`. Use `DROP INDEX CONCURRENTLY` (also `transaction:false`).

---

## Operational checklist for any "big" migration

If the migration touches a table over ~100k rows or rebuilds a GIN/ivfflat index, before you open the PR:

1. **Time it locally against a copy of prod-sized data**, not a 1k-row dev DB. We have `psql "$DATABASE_URL" -c '\COPY ...'` paths to clone a single table for this purpose.
2. **Write the actual observed timing in the migration's header comment**, not a guess.
3. **Compare against the DB's `statement_timeout`** for the migration role. Prod is 60s. If your migration is close, restructure — don't ship hoping it'll fit.
4. **State the recovery plan** in the PR body: if the migration times out, what's the manual `SET statement_timeout=0; \i path/to/file` recipe?
5. **Verify the new app image still boots against an un-applied schema** by running it locally with the migration held back. With the boot-time schema-version assertion from [#767](https://github.com/lobu-ai/lobu/pull/767), it should refuse to start — that's good. The point is to confirm the refusal is loud and clean.

---

## When dbmate fails in prod

Symptoms: `summaries-app-lobu-migrate-*` pod in `Error` state, app pod in `CrashLoopBackOff` or stuck in a tight error loop. Confirm the schema state:

```sh
DB="$(... pull DATABASE_URL from secret ...)"
psql "$DB" -tAc "SELECT max(version) FROM schema_migrations"
psql "$DB" -tAc "SELECT 1 FROM information_schema.columns WHERE table_name='<table>' AND column_name='<col>'"
```

If a migration left no `schema_migrations` row, the safe recovery is to apply it manually with the cap lifted. Two paths depending on whether the migration uses `CONCURRENTLY`:

**Standard migration (no CONCURRENTLY):** one transaction with the timeouts lifted.

```sh
psql "$DB" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;
-- paste the migrate:up section here
INSERT INTO public.schema_migrations(version) VALUES ('<UTC-yyyymmddHHMMSS>');
COMMIT;
SQL
```

**`transaction:false` migration (any `CREATE/DROP INDEX CONCURRENTLY` or `REINDEX CONCURRENTLY`):** these can't run inside `BEGIN`. Use session-level `SET` and run statements one at a time. Verify success between each, then record the migration:

```sh
psql "$DB" <<'SQL'
SET statement_timeout = 0;
SET lock_timeout = 0;

-- one statement at a time, no BEGIN
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_foo ON bar (baz);
-- verify the index is valid before continuing:
SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_foo'::regclass;
-- if false: DROP INDEX CONCURRENTLY idx_foo; and rerun the create above.

-- once everything is healthy, record the migration in its own tiny txn:
BEGIN;
INSERT INTO public.schema_migrations(version) VALUES ('<UTC-yyyymmddHHMMSS>');
COMMIT;
SQL
```

Then `kubectl rollout restart deploy/<release>-lobu-app` to wipe cached prepared statements.

If the migration partially applied (column created, index missing, view missing), figure out which subset succeeded with `\d <table>` and run only the missing pieces.

---

## See also

- [PR #767](https://github.com/lobu-ai/lobu/pull/767) — the boot-time schema-version assertion that catches behind-DB images at startup.
- The post-incident commentary on the original migration ([#765](https://github.com/lobu-ai/lobu/pull/765)) for what "operational note" looks like when a migration's risks are flagged but not addressed.

### Retiring physical entity merges (21.2.1 → 22.0.0)

22.0.0 retires physical entity merges inside the upgrade. Take a backup first,
as for any release. `20261009015900_retire_remaining_physical_merges.sql` sorts
before the retirement migrations and, wherever `entities.merged_into` still
exists, rewrites every remaining redirect in one transaction: `events.entity_ids`
and the other entity-id arrays point at the survivor (order kept, duplicates
removed, no other event column touched); `channel_messages.author_entity_id`
and child `parent_id` rows are retargeted; live identities and ordinary
relationships move to the survivor the way the 21.2.1 merge executor moved them,
keeping `entity_identities.merged_from_entity_id` provenance; active
`entity_merge_operations` ledgers are deleted (undo is retired; undone rows stay
as audit); `auto_merge` resolution rules become `auto_link`; the tombstoned
loser is hard-deleted. `20261009020000` then fences the column and
`20261009030001` drops it. The migration returns immediately if the column has
already been dropped; fresh installs replay the earlier migrations and reach
it without redirects. The batch is quiesced because 21.2.1 code reads the column.
Soft-deleted identities and relationships, authorization edges and approval
policies keyed on a merged record cascade away with it. `classify_facet.entity_id`
and `automation_reactions.entity_id` have no foreign keys and retain their
historical record IDs.

Two conditions stay with the operator. The sidecar of `20261009020000` asserts
them before anything applies, and each message carries the SQL that lists the
rows:

- Merge decisions in `runs` (`action_key = 'entity_change'`, operation `merge`,
  `unmerge` or `resolve_duplicates`) that are pending, in flight, or rejected.
  Finish or cancel the pending and in-flight ones in the product while still
  on 21.2.1. 22.0.0 neither executes nor reads any of them; after review, delete
  the remaining rows.
- Saved Automation scripts that call `entities.manage`, `entities.search`,
  `entities.merge`, `entities.unmerge` or `entities.resolveDuplicates`, or read
  `merged_into`. Rewrite them against the identity-association methods first.

Installs with nonempty `agents.tools_config` are refused by the sidecars of
`20261005150000` and `20261005173700`: the settings API that managed those
restrictions is gone in 22.0.0 and the column follows. Review, then clear:

```sql
SELECT id, organization_id, tools_config FROM agents
 WHERE tools_config IS NOT NULL AND tools_config <> '{}'::jsonb;
UPDATE agents SET tools_config = '{}'::jsonb
 WHERE tools_config IS NOT NULL AND tools_config <> '{}'::jsonb;
```
