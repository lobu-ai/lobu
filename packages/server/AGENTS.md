# Server package agent rules

Read root `AGENTS.md` first. This package owns the gateway, auth, connections, feeds, orchestration, connector operations, guardrails, Slackbot MCP integration, and embedded runtime.

## Package-specific traps
Read before editing. Full list in `docs/GOTCHAS.md`; these bite most often here:
- This package is **biome-excluded**. Never run biome on it — edit surgically, matching each file's existing style. CI will not catch the reflow.
- The DB client sets `fetch_types: false`, so a raw JS array bound as a parameter always fails. CI enforces this via `scripts/check-raw-array-params.mjs`; see GOTCHAS "DB & SQL" for the safe binding forms before reaching for a workaround.
- Data-derived SQL `LIKE` prefixes must escape `\\`, `%`, and `_` and declare `ESCAPE '\\'`; prefer equality or an indexable range when possible. Identifiers such as Slack team ids legitimately contain `_`, so an unescaped prefix can cross tenant boundaries.
- Hoisted `vi.mock()` silently fails in the integration suite (shared module registry). Use `vi.resetModules()` + `vi.doMock()` + dynamic import, and verify by co-running sibling test files.
- Dropping a column from a queryable table is a two-phase change across two releases — `QUERYABLE_SCHEMA` emits explicit column lists.

## Boundaries and vocabulary
- Connections are rows, not processes. Agents bind to connections/channels; replicas hydrate connection instances on demand from DB rows and must not assume boot warm-start.
- Connectors collect external data into feeds/events; chat platforms deliver conversations/messages. Do not blur connector sync with chat transport.
- Automations are the UI umbrella: Listen, Watch, Schedule. Each execution is a `runs` row; its temporal bounds live in `approved_input`, its result in `action_output`, and child work points back through `parent_run_id`. Artifacts are stored files, not automation state.
- Platform isolation: InteractionService events carry `platform`; each renderer filters on its own platform and never another's.

## Connections, feeds, and routing
- Chat platforms live under `src/gateway/connections/` and use Chat SDK adapters. Configure connections via `/agents` UI or CRUD API; do not add per-platform env vars or bespoke SDK transports.
- Webhooks are the default transport. Telegram alone supports `auto|webhook|polling`; reject polling in cloud mode.
- `feeds` is the unified list. A feed definition declares `operations` (`sync`, `read`, or both); storage is independent (`events` for connector data, `channel_messages` for chat). Only `sync` feeds may be scheduled. Source reads always go through the generic feed-read contract.
- Runtime connection ids may be slugs/managed ids (for example `slackinst-…`), not numeric `connections.id`. Resolve through connection stores; do not cast runtime ids to bigint.
- Bound chat channels should materialize an idempotent channel feed backed by `channel_messages`, so the UI has one feed model rather than a separate channel island.

## Auth, providers, and secrets
- Product auth uses better-auth/session/PAT flows in `src/auth`; model/provider auth and user auth profiles live under `src/gateway/auth`.
- Provider catalog/settings are org/user scoped. Do not hardcode provider credentials, base URLs, or model lists; resolve through the provider catalog/settings stores.
- Worker-run code never sees a real credential. The gateway secret/MCP proxies swap placeholders or inject OAuth/API credentials at egress; the connector worker is the second swap site — `credentials.accessToken` reaches its HOST, which mints a per-run `lobu_secret_<uuid>` (same grammar) and resolves it into the request header at `fetch`. Still delivered resolved, and NOT behind that vault: `connection_credentials` and an `authenticate` run's `previous_credentials`.
- MCP servers come from per-agent settings or `SKILL.md`; workers discover tools at startup and call them through the gateway proxy.
- Device-pinned connectors are special: resolved connection credentials may be delivered only to the authorized device worker that owns that run.
- Connector-contributed agent tooling (`gateway/agent-tooling/`) is the other carve-out, and only for **leases**: a short-lived provider-derived token (GitHub App installation tokens, ~1h) minted per deployment and injected as a real env var. It expires on its own and is revocable at the provider without touching the stored credential, which never leaves the gateway. `credential: 'lease'` is the only tier — there is deliberately no static-credential tier, because the worker egress proxy raw-tunnels HTTPS CONNECT and cannot swap a placeholder inside TLS; a CLI would send the placeholder to the provider verbatim. Any other tier value is dropped, not defaulted. Never widen this to a durable stored credential.

  **Lifecycle limitation (v1):** a lease is minted at deployment time and the worker reads its env once at process start, so a WARM deployment keeps the credential it was born with. On a conversation that stays continuously active past the token's ~1h life, `gh` starts reporting itself unauthenticated; a connector connected mid-conversation likewise does not appear until the worker is rebuilt. Bounded by `WORKER_IDLE_CLEANUP_MINUTES` (default 60): any hour-long idle gap reaps the worker and the next turn mints fresh. Recycling a deployment before its lease or tooling goes stale is tracked separately — it is a concurrency-sensitive change (teardown must not interrupt a live turn, and the message path only sees deployments its own pod owns), which is why it is not folded in here. Credentials, egress domains, and declared nix packages reach EVERY runtime: remote runtimes provision the packages from the signed `nixPackages` claim via the provider's optional `ensurePackages` (see the nix bullet under "Guardrails, network, and runtime"). A provider that implements no `ensurePackages` is the one case that still gets the credential plus whatever tools its image ships.

## Multi-replica correctness
- Production can run N>1 replicas. Before claiming a feature works, ask: “does this hold with 3 replicas?” Correctness must not depend on session affinity.
- Per-pod state (`SseManager`, event backlog, in-process worker map, deploy-lock cache) is pod-local. Cross-replica delivery must use Postgres (`thread_response` queue or equivalent).
- API/SSE terminal rows and interaction cards are owner-routed; non-owners requeue until the owning pod claims. Headless rows with no SSE client may be delivered by first claim.
- Streaming deltas/status are best-effort across pods today. Do not build correctness on cross-pod in-memory delivery.
- Exclusive transports such as Telegram polling run on exactly one replica via `connection_claims`; webhook transports must run on any replica.

## Durable dispatch and coordination
- **Fail closed on durable dispatch/delivery state.** When a durable coordination or delivery operation fails, its caller must not reinterpret the error as proceed, deliver, or skip. Propagate a retry, defer, or terminal-failure outcome with a visible log; if the operation may already have succeeded, reconcile idempotently before retrying. Lock timeouts, pool errors, and ambiguous or expired rows are failures, not "nothing changed".
- **Coordination design brake.** A change that needs a second lock, a second retry/deferral budget, or a prose termination argument to explain why it halts is patching a misplaced check. Re-derive where the decision belongs, and put it at the chokepoint that already serializes the action — worker dispatch is serialized by `job-router` on the worker-SSE-owner pod. Prefer deleting the state transition over coordinating it, and reuse queue-native retry over a hand-rolled hold/requeue.
- **Interactive browser drafts are page-activated, never tab-pushed.** Persist the draft operation and its normal Lobu notification; the generic Chrome extension badges exact pending URLs and activates the run only when the user visits one in a user-owned tab. Extension and server core carry no connector, Automation, selector, or site-specific rules — connector/reaction code owns URL shapes and page interaction. Never auto-submit. Only scrape-owned scratch tabs may be opened and closed automatically.

## Connector operations and feed health
- Built-in connector definitions/catalog install in server; connector implementation details belong in `packages/connectors/AGENTS.md`.
- The active `connector_definitions` row is capability truth. Definitions may come from bundled source, organization-scoped `connector_versions`, or device manifests, so a grep under `packages/connectors` cannot prove an action is absent; inspect the active row and `operations.listAvailable`.
- Organization-scoped compiled code shadows the shared artifact for the active version. `refreshConnectorDefinitions` skips keys with no bundled source, but re-syncs every active key that does have bundled source and can reset its definition version/schema to bundled metadata; inspect the active definition after deploy instead of assuming an override survived.
- A data connection's `device_worker_id` is scrape affinity, not evidence that the browser is in front of the user. Connector-initiated browser actions currently inherit that pin. Until an interactive flow carries an explicit Chrome connection, a `completed` action proves execution on the selected extension, not that the user can see it; verify the resolved Chrome connection/worker before claiming delivery.
- Connector health scans `connections` + `feeds`; chat connections are not collector connections and should not trip zero-feed collector health rules.
- Feed hard auto-pause emits `feed.auto_paused` (Automation signal + lifecycle event). Prefer a normal Automation over new special-case agent subsystems.

## Guardrails, network, and runtime
- Guardrails live under `packages/core/src/guardrails/`; server built-ins/aggregation live under gateway guardrail code. Guardrail infra errors fail open; each trip writes a `guardrail-trip` event.
- Worker HTTP(S) egress goes through the authenticated gateway proxy plus `WORKER_ALLOWED_DOMAINS`/`WORKER_DISALLOWED_DOMAINS`. The pattern grammar and the deny → tenant deny → allow → grant → judge decision order are `@lobu/connector-sdk/egress-policy`, and DNS pinning plus `fetchPublicUrl` / `resolveEgressAddresses` are `@lobu/connector-worker/egress`; the proxy, the MCP proxy, the grant/policy stores, the Vercel network policy and the connector isolate lane all call those — never add a local matcher or resolver. The proxy binds `127.0.0.1` **by design** — the Linux `IPAddressDeny=any` / `IPAddressAllow=127.0.0.1` scope depends on it, so do not make the host configurable. The port comes from `WORKER_PROXY_PORT` (default 8118); consume the injected `HTTP_PROXY` URL rather than rebuilding it.
- Agent turns run as isolate jobs in `connector-worker`, claimed over `POST /api/workers/poll` against a durable `runs` row. There is no per-conversation subprocess and no local process sandbox: the turn's filesystem is the isolate's in-memory one, and bash goes to the pinned runtime provider through `/internal/runtime/exec`.
- Nix packages (agent + connector-contributed, unioned at resolve time; legacy skill-level packages are ignored) are portable across runtimes. Remote runtimes get the set as the SIGNED `nixPackages` worker-token claim and `/internal/runtime/exec` provisions it via the provider's optional `ensurePackages` before the first command. Rules when touching this: the list comes from the token claim and NEVER the request body (same as `allowedDomains` — the worker is the sandbox-ee); every name goes through `nixPackageAttrRef` before it reaches a command line; idempotence is a marker file in the sandbox filesystem, never a gateway Map (another replica handles the next message); and provisioning degrades honestly — a failed install or a provider with no `ensurePackages` leaves the CLI absent and says so in the exec result, it never fails the turn. Remote provisioning needs the nix substituter hosts in the sandbox network policy, added gateway-side only when there is a validated package set.

## Local dev and validation
- Prereqs: Bun, supported Node per package engines, and Postgres+pgvector via `DATABASE_URL`. `./scripts/setup-dev.sh` provisions local Postgres where needed.
- `make dev` uses shared brew Postgres with one DB per branch. `LOBU_EMBEDDED=1 make dev` / `make dev-embedded` uses embedded per-worktree Postgres.
- Parallel worktrees use `.env.local` for non-default `PORT`/`WORKER_PROXY_PORT`; do not `git switch` while a dev server runs. Read your worktree's `PORT` from `.env.local` — it is not 8787.
- Smoke a booted server: `curl -s localhost:$PORT/api/health` (readiness is `/health/ready`). The SPA is pathless at `:$PORT`; the agent API is under `:$PORT/lobu`. "It booted" is not "it works" — drive the path you changed.
- Validation: the root gates (see root `AGENTS.md`) plus the relevant server suites. Run bun:test files with `bun test <path>`. Run Vitest files with `bun run test -- run <path>` from `packages/server`, or the whole DB-backed suite with `make test-integration`; never use `bunx vitest` for server Vitest because integration files share one Postgres and require Node's configured `forks.singleFork` execution.

## Slackbot MCP integration
- Slackbot is an MCP client. A Slack app exposes tools/resources only with `mcp:connect` bot scope plus an `mcp_servers` manifest block; after scope changes, reinstall the app.
- Manifest template: `config/slack-app-manifest.self-install.json`. Manage it with `scripts/slack-manifest.ts` (`print|validate|update`) and Slack config credentials.
- `/mcp` is mounted at app root, not under `/lobu`. Manifest MCP URL is `<origin>/mcp`; webhook/slash/OAuth URLs keep the `/lobu` base. Do not change this to `/lobu/mcp`.
- `PUBLIC_GATEWAY_URL` is the canonical web/OAuth origin advertised in protected-resource metadata. MCP `WWW-Authenticate` resource metadata uses the request host when it is the configured origin or belongs to `AUTH_COOKIE_DOMAIN`; otherwise it falls back to `PUBLIC_GATEWAY_URL`. For Slack cloud flows these must resolve to public HTTPS origins; update env and restart when switching origins.
- Local public dev endpoint is Tailscale Funnel to gateway `:8787`; verify `/mcp` returns auth challenge, not 404.
