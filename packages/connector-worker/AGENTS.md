# Connector worker package agent rules

Read root `AGENTS.md` first. This package is the connector/embedding executor: a
daemon polls the worker API for jobs and runs each connector sync/action inside
a V8 isolate. `@lobu/connector-worker/compile` is the shared compile pipeline
also used by `@lobu/cli` and `@lobu/server`.

## Boundaries

- Connector code runs in a V8 isolate in-process (`isolated-vm`), with no
  filesystem, no module loader, and no socket of its own — the host dials on
  the guest's behalf. `IsolateExecutor` defaults to a 10-minute wall clock and
  a 512 MB heap for every run (an agent turn caps its heap at 256 MB);
  interactive auth disables the fixed timeout while it waits for the user.
- The guest reaches the outside world only through the named host capabilities
  in `isolate/bridge.ts`; there is no ambient environment to inherit.
  Credentials and config belong in the typed job context; never expose
  `WORKER_API_TOKEN` to connector code.
- No durable state lives on the worker: connector checkpoints are persisted by
  the gateway, not here, and the guest has no direct Lobu DB handle.
- The executor is generic; device-pinned connectors and cloud-fleet daemons are
  caller concerns (capability/platform), not executor semantics.
- `@lobu/connector-sdk` is inlined into every bundle. The isolate has no module
  loader, so a bundle that still `require()`s anything is unloadable by
  construction — that is what `isolate/eligibility.ts` rejects.

## Key modules

- `compile/index.ts` — the shared connector esbuild pipeline
  (`createIsolateConnectorCompiler`, `EXTERNAL_RUNTIME_DEPS`, the `npm:`
  resolver, an mtime-keyed LRU). It owns compile flags and filename resolution;
  callers own their environment-specific candidate-directory lists. There is one
  build, and it is the isolate build — a bundle shaped for anything else cannot
  load.
- `executor/` — connector execution behind one `SyncExecutor` contract
  (`interface.ts`). `select.ts` returns the only implementation there is:
  `isolate.ts`, which runs a self-contained pure-JS bundle inside a V8 isolate
  in-process. There is no fallback — without `isolated-vm` the run fails.
  `@lobu/connector-sdk/redact` removes recognized secret patterns from the
  output before it reaches logs. The guest never holds the job's OAuth access
  token:
  `isolate.ts` hands it a per-run placeholder and resolves it at `fetch` (see
  `egress/credentials.ts`). `job.config`, `job.sessionState` and an
  `authenticate` run's `previousCredentials` are NOT behind that vault yet.
- `egress/` — the Node egress transport (`@lobu/connector-worker/egress`): resolve-then-pin DNS behind an `EgressDispatcher` (`fetchPublicUrl`), `resolveEgressAddresses` for callers that dial their own socket, the address axis (`block-private` / `allow-private` plus exact-host exemptions, cloud metadata refused under all of them), and the HTTPS-only credential rule. The gateway imports it for all of its untrusted egress (worker egress proxy, MCP proxy, OAuth and connector-operation fetches) and `executor/isolate.ts` dials both guest capabilities through it (`fetch` on a per-executor dispatcher, `socketOpen` via `resolveEgressAddresses` under the DB policy), so a hardening change here reaches every one of those. Policy is `@lobu/connector-sdk/egress-policy` and `ip-reachability`, never re-implemented here — no local matcher, no local resolver, no bare `fetch` to an untrusted host. `credentials.ts` is the lane's `CredentialVault`: a run's OAuth access token becomes a `lobu_secret_<uuid>` placeholder (the gateway secret proxy's grammar, which imports the prefix from here) that the host swaps back into request headers after the egress decision, over HTTPS (plaintext only to a loopback or reserved literal the allowlist names exactly), never into a URL; a refusal is the lane's `EgressDenied`; the vault dies with the run.
- `isolate/` — the isolate lane's host side: `load.ts` (Node-major gated
  `isolated-vm` loader, null under Bun), `bridge.ts` (`IsolateHost`: memory
  limit, wall clock, named sync/async capabilities as `ivm.Reference`s),
  `prelude.ts` (the guest's globals — timers, console, URL, TextEncoder,
  AbortController, fetch — all over host capabilities; add one only with a
  connector that needs it. `fetch` answers with headers as soon as they arrive
  and `Response.body` is a pull `ReadableStream` over `fetchRead`, one host
  chunk per read, so SSE and other long bodies are consumed as they stream;
  `TextDecoder` with `{ stream: true }` holds its state on the host between
  chunks), `eligibility.ts` (rejects bundles that still `require()` a Node
  builtin).
- `daemon/` — the poll loop (`worker.ts`, `executor.ts`) that claims and runs
  jobs from the worker API. `automation.ts` is the device-only Automation arm:
  it spawns the user's local agent CLI per its `AgentSpec` (from
  `@lobu/core/contracts/worker/device-automation`) with the user's own
  environment minus `WORKER_API_TOKEN` — not the connector-child env allowlist.
  `automation-process.ts` owns that CLI's OS process tree: it spawns the agent
  under a process-group anchor so descendants can be terminated through an
  identity the kernel cannot recycle underneath the daemon.
- `self-check/` — connector-runtime parity assertions (packaging only; no
  network or DB).
- `embeddings*.ts` — local/remote embedding generation for emitted content and
  embedding-backfill jobs.

## Package-specific traps

- This package is **biome-excluded** (`config/biome.config.json`); edit
  surgically, matching each file's existing style.
- Server/CLI consumers resolve this package through `dist`; rebuild before
  exercising those entrypoints, or you will test yesterday's build.
- `isolated-vm` is a native addon that loads only under Node (`isolate/load.ts`
  returns null under Bun), so the isolate lane cannot be exercised from a
  `bun test` suite.

## Validation

- Validation: targeted `@lobu/connector-worker` tests plus the root gates (see
  root `AGENTS.md`).
