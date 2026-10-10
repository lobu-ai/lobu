# MCP discovery-surface eval — Gemini Flash

Does an agent, given ONLY the default cloud Lobu MCP tools and NO skill
scaffolding, DISCOVER how to perform operations across the FULL MCP surface
starting from bare natural-language intent?

There is a single arm — the discrete default-cloud MCP surface. The
question is discovery: can the model find the right operation via `search_sdk` +
the tool descriptions, then execute it via `run_sdk` / `query_sdk` / `query_sql`?

## What is real

- **Model:** real Gemini Flash (`gemini-2.5-flash` by default) driven in-process
  via pi-ai. The model object is pi-ai's registry entry for provider `google`
  (api `google-generative-ai`), with `GEMINI_API_KEY` injected at runtime — the
  same way the worker's `model-resolver.ts` routes the `gemini` gateway slug.
- **Tools:** the REAL default cloud MCP surface — the ~6 first-class
  `AGENT_TOOLS` from `getAllTools({ includeInternalTools: false })`:
  `search_memory`, `save_memory`, `search_sdk`, `query_sql`, `query_sdk`,
  `run_sdk`. No admin/dispatch tools: the agent must discover every capability
  through `search_sdk` and reach it via the sandbox tools, exactly as a fresh
  cloud agent would.
- **Sandbox:** the REAL isolated-vm sandbox. `run_sdk` / `query_sdk` actually
  compile and run the model's TypeScript against the live `ClientSDK` +
  Postgres.
- **DB + handlers:** the real Lobu handlers against a real Postgres (server
  package fixtures + migrations on a `*test*` database).
- **Checks:** every task asserts resulting DB / entity / event / run STATE.
  Read/question tasks additionally score the final reply text for the right
  real facts (`replyCheck`).

## Why node@22 (not Bun)

`run_sdk` / `query_sdk` need isolated-vm, whose native addon only loads under
Node 22–24 — not under Bun. So this harness runs under **`node@22` + tsx**. The
local `tsconfig.json` resolves built workspace packages, matching the server
integration harness and preserving Node module interoperability. Build them
with `make build-packages` before running `run.sh`.

## Run it

```bash
# GEMINI_API_KEY is loaded from the repo .env; caller env takes precedence.
# DATABASE_URL must be a throwaway *test* Postgres (name contains "test");
# the harness runs migrations (DROP SCHEMA public CASCADE) against it.
DATABASE_URL=postgresql://localhost:5432/lobu_mcp_discovery_test \
  ./run.sh --trials 2
# optional: --tasks connect-website,create-entity
# --scope admin|default  (default: admin) — `default` is the mcp:read+mcp:write
#   token `lobu token create` mints; admin-gated actions (connect, Automations,
#   operations.execute, schedules) are blocked for it. Use to measure scope
#   sensitivity (e.g. PR #1955's connector-discovery visibility fix).
# optional overrides: NODE22_BIN=/path/to/node22  GEMINI_MODEL_ID=gemini-3-flash-preview
```

Requirements: a reachable Postgres with `vector` + `pg_trgm`; a Node 22–24 binary
with isolated-vm prebuilds (default `/opt/homebrew/opt/node@22/bin/node`); a
Gemini API key in `.env`.

## Tasks

Bare-intent discovery tasks spanning the MCP surface — see `tasks.ts`:

1. `connect-website` — collect a site's pages (connect + feed).
2. `connect-slack` — connect an auth-gated integration connector.
3. `run-operation` — run a connector operation (→ a completed `runs` row).
4. `create-entity` — add a company with 50 employees (type must be created first).
5. `query-entities` — count + name the seeded companies (reply-scored).
6. `create-automation` — watch the workspace and notify on a condition.
7. `save-and-recall-memory` — save a fact, then recall it (reply-scored).
8. `sql-discovery` — which tables can I query; how to find collected pages (reply-scored).
9. `org-discovery` — which workspace + installed connectors (reply-scored).
10. `schedule-a-job` — a weekly Monday-9am recurring job (→ `scheduled_jobs`).
11. `entity-relationship` — link a contact to a company as employer.

## Metrics per cell

`statePass`, `replyPass` (read tasks), `discovered` (called `search_sdk`),
`toolCalls`, `erroredCalls` (arg fumbles / handler errors), `rankOfFirstWrite`
(first run_sdk/query_sql/save_memory among calls), `maxIdenticalRun`, `turns`,
`elapsedMs`, `failNote`. Raw per-cell metrics are written to `last-run.json`
(gitignored — re-run to regenerate).

## Files

- `scenario.ts` — DB setup (shared with tool-surface), org fixtures, connector /
  entity-type seeding, the default-MCP dispatcher (real handlers incl. sandbox).
- `driver.ts` — builds the Gemini discovery session (the ~6 MCP tools as pi tools).
- `tasks.ts` — the discovery tasks + seeds + state/reply checks.
- `run.ts` — the runner; collects metrics, prints the tables.
- `run.sh` — launcher (sources `.env`, invokes node@22 + tsx).
