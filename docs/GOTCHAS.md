# Gotchas

Traps that have each cost a real debugging session. Read the section for the surface you are touching before you start; each entry is written as a symptom you would actually see, so grep this file when something looks inexplicable.

Root `AGENTS.md` holds the invariants and the workflow. This file holds the mechanical failure modes.

## Symptom index

| You are seeing | Section |
| --- | --- |
| `TS2305: Module '@lobu/core' has no exported member` | Build & typecheck |
| `TS2307: Cannot find module '@lobu/<pkg>'` | Build & typecheck |
| Green typecheck that CI then fails | Build & typecheck |
| A formatting diff thousands of lines wide | Formatting & lint |
| `PostgresError: malformed array literal` | DB & SQL |
| A prefix lookup returns another tenant's identifier | DB & SQL |
| An embedding reads back as a string, not `number[]` | DB & SQL |
| squawk / migration job exits non-zero on a warning | DB & SQL |
| `ERR_RESOLVE_PACKAGE_ENTRY_FAIL` in integration setup | Testing |
| `could not create shared memory segment: No space left on device` | Testing |
| A mock that works alone but not in the suite | Testing |
| A server that is "healthy" suspiciously fast | Testing |
| An auth-cookie fix that is green in tests but wrong in prod | Testing |
| `gh run view --log-failed` printing nothing | CI triage |
| `grep` finding nothing in a CI log you can read | CI triage |
| `codex exec` / `pi -p` hanging at 0% CPU | Shell & CLI |
| `unexpected EOF while looking for matching '` | Shell & CLI |
| Paired browser unavailable | Browser & connectors |
| Browser automation hitting a login wall | Browser & connectors |
| A connector action exists live but not under `packages/connectors` | Browser & connectors |
| A device manifest edit never reaches `connector_definitions` | Browser & connectors |
| The extension may only implement `chrome.*` connectors | Browser & connectors |
| Changed unpacked-extension code is not active | Browser & connectors |
| A completed browser action opened on the wrong machine | Browser & connectors |
| `check-drift` failing on a submodule pointer | Submodule & cross-repo |
| A rebase that "already upstream"-ed your pointer commit | Submodule & cross-repo |

## Build & typecheck

**Stale dist gives a false green typecheck.** `packages/server` typechecks against the *built* `dist` of `@lobu/core`, not its source. If you change a `@lobu/core` contract and only run `make typecheck`, the green is meaningless. Run `make build-packages` first on any PR touching core contracts, and never `--admin`-merge past a typecheck check that has not reported.

**Phantom `TS2305: Module '@lobu/core' has no exported member 'X'` inside a worktree.** The worktree's own `@lobu/*` dists are missing, so tsc resolves through the *main checkout's* stale dist. Build the worktree's dists (`make build-packages`). `packages/core` is `composite: true`, so use `bunx tsc --build --force` — a plain `rm -rf dist` leaves a stale `tsconfig.tsbuildinfo` behind. Diagnose with `bunx tsc --noEmit --traceResolution 2>&1 | grep "@lobu/core"`.

**A new workspace package must be added to the dependency-layered build graph or CI fails while local passes.** Add it at the correct layer in `scripts/build-packages.mjs`. `make build-packages`, root `build:packages`, and the CI unit job all call that script; the unit job passes `--skip-applications` but still builds the shared package graph. Symptom is `TS2307: Cannot find module '@lobu/<pkg>'` cascading into implicit-any noise. Reproduce locally with `rm -rf packages/<pkg>/dist` then typecheck.

**Inter-package deps are always `"@lobu/*": "workspace:*"`.** Never a hardcoded version or caret range — the root `package.json` is the single source of version truth.

**`bun.lock` changed but you touched no dependencies.** Bun silently prunes the workspace importer when the `packages/owletto` submodule is absent, so `git submodule update --init` must precede `bun install`. `make task-setup` already does this in the right order — you only hit this by building a worktree by hand.

## Formatting & lint

**Format only via `bun run check:fix` from the repo root.** Never `bunx biome check --write <path>`. Bare biome uses its own defaults (tabs) and ignores the repo config at `config/biome.config.json`.

**Several packages are biome-EXCLUDED, and an explicit file argument bypasses the exclusion.** `config/biome.config.json` excludes `packages/server`, `packages/owletto`, connector-sdk, connectors, connector-worker, embeddings, apps, and skills. Running biome on a file in one of them can turn a surgical change into a broad reflow diff that the CI format check will not catch. Recover from a clean copy of the file at `HEAD`, preserve any unrelated local changes, and redo the intended edit by hand in that file's existing style. `packages/core` and `packages/cli` *are* biome-formatted.

## DB & SQL

**Adding an `events` column is two edits, and skipping the second fails SILENTLY.** Automation source queries do not read `public.events` — `execute-data-sources.ts` builds its events CTE over the `public.current_event_records` view, whose column list is hand-maintained by every migration that adds a column. Reference a column you added to the table but not the view and the CTE dies with `column ev.<name> does not exist`; `executeDataSources` then LOGS that at warn level and returns the source as an EMPTY array rather than raising, so every Automation silently reads nothing and each one just looks like it had a quiet window. Grep for the previous column's name (`identity_key`, `linked_org_ids`) to find all three places a column has to be listed: the view's `migrate:up`, the view's `migrate:down`, and `SAFE_COLUMN_DEFS` in `utils/table-schema.ts` if scripts should be able to select it.

**A canonical platform transition is state + event + activation task in one transaction.** For `entity.updated` and `relationship.linked/unlinked/updated`, use the awaited transactional helpers in `utils/insert-event.ts` from the semantic tool boundary. Do not call the fire-and-forget `recordChangeEvent`/`recordEdgeChangeEvent` helpers from a semantic mutation: an event or activation enqueue failure would otherwise leave world state committed without the Automation signal. Do not move emission into physical row helpers either; connector projections, repairs, promotion, and identity maintenance are intentionally not implicit Automation triggers.

**Never bind a raw JS array as a query parameter in `packages/server`.** The client sets `fetch_types: false` (`PROD_PG_VALUE_OPTIONS` in `packages/server/src/db/client.ts`), so postgres.js ships arrays as scalars and you get `PostgresError: malformed array literal`. This holds for `number[]` and `string[]`, tagged-template and `sql.unsafe`, with or without an `::type[]` cast. Safe forms only:

```ts
sql`... WHERE id = ANY(${pgTextArray(ids)}::text[])`     // strings
sql`... WHERE id = ANY(${pgBigintArray(ids)}::bigint[])` // numbers
```

Both helpers are exported from `packages/server/src/db/client.ts`. `sql.array(a)`, `ARRAY[$a, $b]` of scalars, and spreads are also safe. JSONB is exempt (`JSON.stringify` / `sql.json`). CI enforces this via `scripts/check-raw-array-params.mjs`; the escape hatch is a `raw-array-ok` line comment.

**A data-derived `LIKE ${prefix}%` is not a literal prefix match.** SQL treats `_` as any one character and `%` as any run, and identifiers such as Slack team ids may contain `_`; an unescaped authorization lookup can therefore match another workspace. Prefer equality or an indexable range. If the suffix is genuinely unknown, escape `\\`, `%`, and `_`, add `ESCAPE '\\'`, and reproduce with sibling identifiers that differ at an underscore position—not only the happy key.

**pgvector columns read back as the text string `"[1,2,3]"`, not `number[]`.** Parse before use.

**Keep array-binding repros on the production value options.** `getDb()` and the integration harness's `getTestDb()` both use `PROD_PG_VALUE_OPTIONS`; an ad hoc `postgres()` client without those options can mask the failure you are chasing.

**Dropping a column from a queryable table is a two-phase change.** `buildScopedQuery` emits explicit column lists from `QUERYABLE_SCHEMA`, so a single-release drop breaks old replicas mid-rollout. Remove the column from `QUERYABLE_SCHEMA` in release N; ship the `DROP COLUMN` migration in release N+1.

**Bare OAuth account grants use a quiesced cutover.** Ordinary authorization for a canonical bare `/mcp` resource always persists an explicit `granted_organization_ids` snapshot and leaves `organization_id` null. `LOBU_OAUTH_MULTI_WORKSPACE_GRANTS` now controls only whether that snapshot may contain more than one workspace; the consent UI submits the grant-shaped payload in both modes. Migration `20260907220000_oauth_account_grant_cutover.sql` intentionally omits `lobu:no-quiesce`, so the upgrade hook stops the old app and workers before it revokes proven default-bound bare grants, pending codes, and their unshared MCP sessions. Do not make this migration rolling-safe by restoring the retired `organization_id` fallback.

Rollback to a pre-cutover binary must also be quiesced and deploy its matching UI and server together. Before old-server traffic resumes, revoke ordinary bare account credentials and pending codes with a null `organization_id`, then remove their MCP sessions so clients re-authorize through the old default-bound flow. Turning the multi-workspace flag off is insufficient: singleton account grants also have no default workspace. Because an application rollback does not make the completed cutover migration run again, a later forward deploy needs an equivalent cleanup migration for any default-bound grants issued after rollback.

**New migrations are lock-safety linted by squawk in CI, and it exits non-zero on warnings.** The `migrations` job runs `squawk-cli` (version pinned in both `.github/workflows/ci.yml` and the `db:lint` script) over only the changed `db/migrations/*.sql`. Note `make review` does *not* run it. Conventions: `CREATE TABLE IF NOT EXISTS`; fold unique indexes into a table-level `CONSTRAINT ... UNIQUE`; a non-unique index on a brand-new table needs `CREATE INDEX IF NOT EXISTS` plus `-- squawk-ignore require-concurrent-index-creation`; a `migrate:down` DROP needs `-- squawk-ignore ban-drop-table`. Check locally with `bun run db:lint db/migrations/<file>.sql`.

**Read the actual SQL before scoping performance work.** A review agent claiming "JSONB full scan" is a claim, not a measurement — a PK-anchored JSONB extract is microseconds. `EXPLAIN ANALYZE` before you denormalize anything.

## Testing

**Hoisted `vi.mock()` silently fails in the server *integration* suite.** That run shares a module registry across files, so a test that is green alone loads the real module in CI. Use `vi.resetModules()` + `vi.doMock(...)` + a dynamic `await import()` *after* the mock, with an `afterEach` that resets modules and un-mocks. Always verify by co-running siblings — `cd packages/server && bun run test -- run <fileA> <fileB>` — because green-alone is not green-in-suite.

**`ERR_RESOLVE_PACKAGE_ENTRY_FAIL` during integration global setup.** `@lobu/pgvector-embedded` is not built. `cd packages/pgvector-embedded && bun run build`.

**`could not create shared memory segment: No space left on device` on macOS.** The SHMMNI limit, not disk. Reap detached segments: `ipcs -mob`, then `ipcrm -m <id>` for entries with `nattch=0` **only**.

**Integration suite prerequisites.** Node 22 is the repo default (`.node-version`); Lobu accepts Node 22–24 and 26+, while Node 25 boots without the SDK sandbox. Global setup uses `DATABASE_URL` if set, otherwise spawns an ephemeral embedded Postgres + pgvector.

**Vitest 3.2.6 `list --shard=N/M` prints every file, even though `run --shard=N/M` partitions correctly.** Do not use `vitest list` to prove shard coverage. Run each shard with the JSON reporter and compare `testResults`: the three-way CI split owns 126 of 378 files per shard, with no overlap at execution time.

**The test env speaks plain HTTP, so it validates the WRONG auth-cookie name.** Better Auth derives the session cookie name from `useSecureCookies`: tests get `better-auth.session_token`, prod gets `__Secure-better-auth.session_token`, and `getSession` reads exactly one of them and is blind to the other. Any code that *constructs* or *matches* that name can therefore pass a full red→green integration test and still fail in prod — #2578 nearly shipped a probe that rewrote every candidate to the bare basename, which would have locked out every duplicated jar in production (caught by `make review-fix`, not by the suite). Use `sessionCookieName(isHttps)` from `packages/server/src/auth/session-cookie-scope.ts`, never a literal, and cover **both** spellings explicitly. A unit test with a faked `getSession` is the stronger test here; the full-stack one inherits the harness's http-ness.

**A cookie can be rejected two different ways, and the cheap fake only exercises one.** `better-call`'s `getSignedCookie` rejects a bad HMAC *before the database is consulted* (`context.mjs`: it also bails early on any signature that is not 44 base64 chars ending in `=`); a real stale twin is correctly signed and dies on the session lookup instead. A hand-written garbage token only ever tests the first path. To test the second, mint a real session and delete its `session` row.

**`make dev` is not the test harness.** It migrates its owned local per-branch database and boots the app, but that does not exercise the branches a relevant unit or integration suite covers.

**A scratch server that is "healthy" before the fresh initdb and migration logs appear is probably an orphan.** A cold embedded boot runs `initdb` as a subprocess, so a genuinely fresh server logs it; instant health means you reached a server that was already running. Confirm with the data dir rather than the clock — `<dir>/.lobu/pgdata/PG_VERSION` should exist and be newly created. Kill orphans by port, not name — `pkill -f "lobu run --port"` never matches, because the real cmdline is `node .../server.bundle.mjs`. Confirm what you are about to kill first (`lsof -iTCP:<port> -sTCP:LISTEN`, check it is the expected `server.bundle.mjs`), then `lsof -tiTCP:<port> -sTCP:LISTEN | xargs kill`. Reserve `-9` for a process that ignores the polite signal.

**Isolating a benchmark/scratch server:** pass `DATABASE_URL="file:///tmp/<dir>"` — the embedded runtime creates `<dir>/.lobu/pgdata`. The runtime reads `DATABASE_URL`; `lobu run` maps `LOBU_DATA_DIR` into it only when `DATABASE_URL` is absent. Without either, `lobu run` defaults to the shared `~/.lobu/pgdata`.

## CI triage

**Fetch a failing job's log exactly once, to a file:** `gh run view --job <id> --log | sed 's/^[^Z]*Z //' > /tmp/ci-<id>.log`, then search the file with `grep -a '<pattern>' /tmp/ci-<id>.log`. Refetching is the single most repeated waste in CI triage — 21 sessions have re-pulled the same log 170 times, one of them hitting the same job 9 times in 105 seconds.

**Use `--log`, not `--log-failed`.** `--log-failed` is empty for any failure that is not a failed test step — `check-drift` and `publish-packages` both print nothing — and that empty result is what forces the second fetch.

**`grep` needs `-a`, and the lines are prefixed.** Job logs are timestamped and ANSI-coloured, so grep treats them as binary and the prefix defeats anchored patterns. The `sed 's/^[^Z]*Z //'` in the fetch above strips the prefix once, at save time; `-a` is still needed for the ANSI bytes that remain.

## Shell & CLI

**Always append `< /dev/null` to `codex exec` and `pi -p`** in any non-tty or background invocation. Without it they block in `S` state at 0% CPU and silently produce nothing.

**macOS `/bin/sh` is bash 3.2 and mis-parses a heredoc nested inside `"$(cat <<'DELIM' … DELIM)"`.** A single apostrophe in the body kills the script with `unexpected EOF while looking for matching '`. Never inline user- or server-controlled text into a generated shell script that way — write it to a `0600` tempfile and read it back with `"$(cat '<file>')"` at runtime. Validate generated scripts with `/bin/sh -n`, not interactive zsh.

## Browser & connectors

**Browser operations use the paired extension.** Lobu no longer installs a
standalone Chromium runtime or accepts external remote-debugging endpoints.
Check the paired device's capabilities, connection pin and heartbeat when a
browser operation cannot run. The extension owns its internal browser protocol
connection; see `docs/BROWSER_TESTING.md`.

**Connector success status in `runs` is `completed`, not `success`.** To re-trigger one feed: `UPDATE feeds SET next_run_at = now() WHERE id = <id>` — always with the `WHERE`, and against a dev database. Unscoped, it schedules every feed in the table at once.

**To drive the user's real logged-in browser, use the paired Owletto extension**, not claude-in-chrome (that drives a different Chrome without their sessions). The local CDP-based `lobu connector run` command has been retired. The recipe is in `docs/BROWSER_TESTING.md` under "Driving the paired Owletto extension"; it routes through `packages/server/src/worker-api/dispatch-chrome-action.ts`. Discover the `operations` namespace with `search_sdk operations`, then call it through `run_sdk`. A new server-side chrome action also needs a handler in the *installed* extension build, so check `git ls-tree origin/main packages/owletto`, never the working-tree submodule HEAD.

**A connector capability can be DB-backed with no file under `packages/connectors`.** Check the active `connector_definitions` row and `operations.listAvailable({ connection_id })` before declaring an action absent. Organization-scoped code in `connector_versions` wins over the shared artifact for the active version. Catalog refresh skips keys with no bundled source, but re-syncs keys that do have bundled source and can reset their active definition to bundled metadata; inspect the active version after deploy. Connector source in `examples/` still requires `lobu apply` to update the organization copy.

**One invalid device manifest preserves the whole previous inventory.** `validateDeviceConnectorManifests` marks the entire poll payload unaccepted when any entry fails validation (including `manifest_hash mismatch`), and `poll.ts` then retains the prior `connector_manifests`. The rejection is only an app-pod warning; a definition with stale `updated_at` is the DB symptom. `manifest_hash` is optional input and is computed over the normalized manifest by the server—when editing checked-in Chrome manifests, keep the JSON and emitted `connector-manifests.js` payload aligned and validate the exact object the extension sends.

**The Chrome extension may only implement connectors in the reserved `chrome.*` namespace.** The namespace is a two-way contract: a `chrome.*` key ships no bundle (the gateway withholds `compiled_code` because the extension already has the implementation), and every other key ships its own code that the extension never sees. Both halves are guarded — `assertChromeNamespaceInstallIsDeviceManifest` server-side, `apps/chrome/connector-ownership.test.js` in the extension. `whatsapp.local` was the one exception, an ordinary key the extension nonetheless implemented natively in ~6,000 lines; it broke silently whenever WhatsApp renamed a private module (`window.require` returns null for a dead name rather than throwing, so the failure read as an indefinite "still hydrating") and every fix waited on a Web Store review round. It is retired. A connector needing its own code is an ordinary connector pinned to a chrome-extension device, driving the page through the generic browser ops. The latest device manifest, capability set, and heartbeat remain the canonical facts; `ready`, `setup_required`, and `device_offline` are derived at read time and must not be stored as a second setup-status silo. A manifest-backed connector is claimable only by a device advertising the exact winning manifest and required capability, not by every device sharing a generic browser capability. The successor is `whatsapp.web`: a NEW key, so it gets its own connection and `messages` feed and inherits none of `whatsapp.local`'s `origin_id` dedupe history — pre-cutover connections move by hand, not by migration code. Its page adapter is injected by serialising a function, so the shipped bundle must stay self-contained; a hoisted downlevel helper would only fail in the browser.

**Do not use a process restart as deployment proof for changed unpacked-extension code.** Chrome's unpacked-extension workflow requires an explicit extension reload for manifest, service-worker, and content-script changes. Reload it from `chrome://extensions`, then verify the poll payload/action semantics rather than reasoning from checked-out files.

**A data connection's browser pin means “scrape here,” not “the user is here.”** Connector-initiated Chrome actions inherit the parent connection's `device_worker_id`; an interactive draft can report `completed` on an always-on machine the user cannot see. Direct one-off operations should target the intended Chrome connection id. For connector actions, verify the resolved Chrome connection/worker and do not claim human-visible delivery unless the flow carries an explicit interactive target.

**Receiving real third-party webhooks against a local gateway** uses Tailscale Funnel on :443: `tailscale funnel --bg --https=443 http://127.0.0.1:<port>`. The `serve` subcommand looks identical but silently makes the port tailnet-only — always `funnel`, and verify with `tailscale funnel status`. curl from the same machine resolves over the tailnet, so a local 200 does not prove public reachability.

## Submodule & cross-repo

**Never point the parent repo at a submodule SHA that is unreachable from the submodule's remote.** Push the submodule first, then bump the pointer. Prod submodule clones fail on unreachable SHAs.

**Landing paired lobu + owletto PRs:** merge the owletto PR (squash), take the resulting owletto-main SHA, re-point the lobu submodule pointer PR at *that squash SHA*, then merge lobu. `check-drift` fails until the pointer is an ancestor of owletto/main. When the pointer branch is behind lobu main, use `git merge origin/main` — **never `git rebase`**, which drops the pointer commit as "patch contents already upstream", after which a `--amend` corrupts HEAD. To recover, first make the damage reversible — `git status` must be clean (stop if it is not, and commit rather than discard), then tag the current tip so nothing is stranded: `git branch backup/<branch>-$(git rev-parse --short HEAD)`. Only then reset to the remote tip with `git reset --keep origin/<branch>` (it refuses rather than clobbering uncommitted work; use `--hard` only on a confirmed-clean tree). Then merge and resolve the single submodule conflict:

```sh
git -C packages/owletto checkout <squash-sha> && git add packages/owletto && git commit --no-edit
```

**Owletto drift does not serialize unrelated PRs.** On a pull request, `check-drift` hard-fails only for an off-main pointer, a backward/sideways pointer move, or an unauthorized fork pointer change. If non-bot Owletto commits land past an unchanged parent pin, the PR passes with a warning; deploy-only Flux commits remain exempt. A forward pointer PR also remains policy-valid when main advances after it opened; Git may carry the newer descendant into the merge result, so the check accepts that synthetic pointer only when it contains the PR head pointer. Push and scheduled runs remain strict so missing parent bumps stay visible without making every Lobu PR chase a moving submodule head.

**Never fold a private repo into public `lobu`.** Check `gh repo view --json visibility` on both sides before any "consolidate into the monorepo" move — a past fold leaked a large private frontend publicly.

## Prod safety

**Your local run gets claimed and failed by a prod worker.** A prod worker pod polling the same database will claim your pending runs and fail them out from under local dev. The fix is to stop sharing the database: point `DATABASE_URL` at a local or embedded Postgres (see "Isolating a benchmark/scratch server" above). Scaling the prod worker deployment down is a production change, not a dev step — it stops real users' runs, so it requires the deployment owner's explicit approval, a coordinated maintenance window, and a restore plan; never run an ad hoc `kubectl scale` mid-debug.
