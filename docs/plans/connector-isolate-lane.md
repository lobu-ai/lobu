# Connector isolate lane: action plan

Status: SUPERSEDED. PR 1 (the SDK split) and PR 3 (the isolate executor) shipped as written.
PRs 2, 4, 5 and 6 below are the original proposals and did NOT ship in this shape: the follow-up
consolidation removed the subprocess lane outright, so there is no `lane` routing key, no
`process` fallback, and no per-provenance Cloud gate to extend -- every connector runs in the
isolate and egress policy is the boundary. Read the sections below as the reasoning that led
there, not as a description of the code. The owner confirmed the direction on 2026-09-02 after
the experiment below.

## Problem

Lobu Cloud refuses organization-supplied connector code (#3246, narrowed by #3285). The refusal
is correct for the lane that exists: `SubprocessExecutor` forks a Node child that gets process
isolation only (`packages/connectors/src/README.md`, "How connector code runs" item 4), receives
the connection's real credentials (`packages/server/src/worker-api/poll.ts:1770`), and can open any
socket. So a tenant cannot author a connector on Cloud at all. MCP covers tools only, never feeds.

Reactions, `run_sdk`, entity rules and schema extraction already run tenant code in `isolated-vm`
(`packages/server/src/sandbox/run-script.ts` and three callers). Connectors are the one tenant-code
lane not on it. Epic #966 already chose declared runtime requirements as the routing key and named
a pure-JS backend; an in-process isolate executor is that backend's embedded form.

## Evidence

Method: bundle each connector with the isolate lane's exact esbuild config (`bundle`, `format: cjs`,
`platform: node`, `external: []`, `metafile`), then `isolate.compileScript` + `run` in
`isolated-vm@7` on Node 26 with the CJS preamble `run-script.ts` uses (`var module = {exports:{}}`).
A universal Proxy stub enumerated every missing global at load. The end-to-end sync used host
`ivm.Reference`s for `fetch`, `sleep`, `emit`, `log`.

| connector | as-is | after stubbing `@lobu/core`, `sdk/browser/*`, `sdk/sources/*` |
|---|---|---|
| midas (tenant, extension dispatch) | FAIL `require(util)`; 6,456 KB, 1,955 modules | load OK 3 ms; 140 KB, 297 modules; 0 builtins |
| hackernews (fetch only) | FAIL `require(util)`; 7,006 KB | load OK 11 ms; 690 KB; **sync OK 10.5 s, 1 fetch to `hn.algolia.com`, 5 events, checkpoint `last_sync_at`, heap 2 MB**; residual `node:net` |
| reddit (fetch only) | FAIL | load OK 2 ms; 147 KB; 0 builtins |
| x (extension dispatch) | FAIL | load OK 3 ms; 223 KB; 0 builtins |
| github (imports `node:crypto`) | FAIL | loads; residual `node:crypto` from its own import: the correct fork-lane routing signal |

Root cause of the 6.5 MB and the failure: the SDK imported `@lobu/core` root for exactly two
symbols, `createLogger` (`logger.ts`) and `retryWithBackoff` (`retry.ts`). Core's index `export *`s its winston logger, Sentry,
credentials (`node:fs`) and more, and neither package sets `sideEffects`, so esbuild cannot drop any
of it. The SDK's own Node surface is small: `browser/*` and `sources/*` (10 files),
`ip-reachability.ts:33` (`node:net`, reached from `url-guards.ts` via `validatePublicUrl`), and
`device-manifest.ts:1` (`node:crypto`, re-exported from the index).

Bare `isolated-vm` context globals are ECMAScript plus `console` only. Needed at load: timers
(hackernews via domino). Needed at call time by `ky`, which the SDK re-exports: `Request`,
`Response`, `Headers`, `URLSearchParams`, `AbortController`, `TextEncoder`, `URL`. `process.env` is
read at call time by `browser/network.ts`.

## Target shape

One guest contract (context in, named host capabilities out, result or stream back). One host
bridge implementation embedded twice: gateway for reactions and the SDK sandbox, connector-worker
for connectors. One bundle format with an isolate-safe SDK core. Admission by lane, not provenance.
Credentials held by the host. Isolate is the default lane in dev, self-hosted and Cloud so the lane
tenants use is the lane CI runs.

## Phases

### PR 1: isolate-safe SDK core (shipped with this document)

Outcome, measured after the split with the real SDK and no stubs: midas bundles to 21 KB and
loads in 0 ms; reddit 31 KB, x 107 KB, hackernews 572 KB (domino). hackernews completed a
live sync inside the isolate in 18.9 s over 9 host fetches with a 10 MB heap once the guest
had `AbortController` and `TextEncoder`, which fixes the PR 2 prelude list. Of the 23
bundled connectors, 18 are isolate-eligible; github, jira and linear need `node:crypto` for
webhook HMACs, os_shell spawns commands, and postgres opens raw TCP. The test
`packages/server/src/__tests__/integration/sandbox/connector-isolate-lane.test.ts` pins that
set and loads all 18 in a real isolate. Prod blast radius of the export move: 31 of 287
`connector_versions` rows referenced a moved symbol, all org-scoped and all either shadowed by
an image key or already denied by the Cloud gate, so nothing executing in Cloud changed.

What changed:

- `logger.ts`: SDK-owned console logger with core's level gating and key redaction; no
  `@lobu/core` import. `console` is the only sink, so each host routes logs itself.
- `retry.ts`: core's `retryWithBackoff` inlined, reduced to the exponential, capped, full-jitter
  path `withHttpRetry` uses. The remaining core import,
  `@lobu/core/contracts/tools/manage-automations`, is a pure TypeBox subpath and stays.
- `browser/*` moved to `@lobu/connector-sdk/browser` and the `FileSystemSource` implementations
  to `@lobu/connector-sdk/sources`; the root index stops re-exporting them and keeps only the
  `FileSystemSource` types. Importers updated: the brand-intelligence example connectors
  (`runReviewScrape`, `launchBrowser`), server `auth-profiles.ts` (`cdp`), and the
  `deviceManifestHash` callers in server and device-connectors.
- `ip-reachability.ts`: `ipFamily` ports Node's own `isIP` regular expressions; differentially
  checked against `node:net` on 52 inputs, pinned in `ip-family.test.ts`. `deviceManifestHash`
  moved to the `./device-manifest-hash` subpath; only the server verifies hashes.
- Gate: `connector-isolate-lane.test.ts` (vitest, Node, fails hard without `isolated-vm`)
  bundles the SDK root from source with `ISOLATE_LANE_BUILD_OPTIONS`, now exported from
  `utils/compiler-core.ts` and used by `run-script.ts`, so the runtime and the test share one
  config. It asserts no builtin, none of core's heavy graph, and under 1 MB.
- `sideEffects: false` on the SDK. Public SDK is on npm; the export move is a breaking change,
  released as a major through release-please. Compiled bundles that import a moved symbol from
  the root need a re-run of `lobu apply`.

### PR 2: shared guest host bridge

- New `packages/connector-worker/src/isolate/host.ts` (server already imports
  `@lobu/connector-worker/compile`, so the dependency direction holds). Owns isolate creation and
  limits, capability registration from a manifest via `ivm.Reference`, quota, message caps,
  termination, redaction, and the guest prelude: timers to host `sleep`, `console` to host log,
  `process.env` from `job.env`, plus `URL`, `URLSearchParams`, `TextEncoder`/`TextDecoder`,
  `AbortController`, minimal `Headers`/`Request`/`Response`, `atob`/`btoa`, `structuredClone`,
  `queueMicrotask`, `crypto.randomUUID`/`getRandomValues` via host.
- Refactor `run-script.ts` onto it with no functional change. Gate: existing sandbox suites
  (`run-script-runtime.test.ts`, `execute-wire.test.ts`, reaction tests) stay green unchanged.

### PR 3: `IsolateExecutor` in connector-worker

- `packages/connector-worker/src/executor/isolate.ts` implementing the same `execute(job, hooks)`
  contract as `SubprocessExecutor` (`executor/interface.ts:189`). Capabilities map to existing
  hooks: `events.emit` chunked to `onEventChunk`, `checkpoint.update` to `onCheckpointUpdate`,
  `device.dispatch` to `onChromeDispatch`, `signal.wait`, `http.fetch` (host fetch, buffered body
  with a cap), `log`, `sleep`.
- SDK linking: inline per bundle. Proven and cheap now that the root is ~330 KB before
  tree-shaking; a linked SDK module per process is an optimization to measure later.
- Limits per lane: memory 512 MB (matches the fork's old-space setting), wall clock 10 min, message
  cap 4 to 16 MB, fetch body cap.
- Selection by `job.lane` at `daemon/executor.ts:234`, `:493`, `:682` and `executor/runtime.ts:31`.
- Tests (bun): fixture connector through sync, action, auth; chunked emit; timeout kill; memory kill;
  fetch to an undeclared domain denied; a bundle with a `node:` import rejected at init. Mutation
  test the deny paths.
- E2E: `lobu connector run` hackernews through the isolate executor; diff events against the fork
  lane run. Then midas through `device.dispatch` on a paired device.

### PR 4: lane derivation and lane-based admission

- At install and compile (`utils/connector-definition-install.ts`, `utils/connector-catalog.ts`)
  derive `lane: 'isolate' | 'process'` from metafile builtin externals, declared `nixPackages`, and
  `requiredCapability`. Store it in the existing `runtime` JSONB (additive key, no migration).
  Confirm the column before starting.
- Worker poll ships `lane`. `utils/custom-connector-cloud-gate.ts` admits `isolate` regardless of
  provenance; `process` keeps the image-only rule in Cloud. `assertCustomConnectorInstallAllowed`
  admits source installs whose compiled lane is `isolate`.
- Gate: extend the gate unit and integration tests (`custom-connector-cloud-gate.test.ts`,
  `postgres-sync-cloud-gate`) with both lanes.
- E2E on Cloud: install midas as organization-supplied; the midas feed flips from `cloud_restricted` to
  `completed`; an org-supplied `node:crypto` connector is still denied with the remedy sentence.

### PR 5: host-held credentials

- Isolate `http.fetch`: `ctx.credentials` keeps its shape but carries `lobu_secret_<uuid>`
  placeholders (`gateway/proxy/secret-proxy.ts` pattern); the host resolves them at egress and
  enforces the connector's declared domains. Then extend to fork-lane workers (#969), ending the
  real-credential delivery at `poll.ts:1770`.
- Enumerate connectors that sign with the secret (HMAC, JWT); route them to the `lease` tier or a
  host `sign` capability.

### PR 6: isolate by default, delete the provenance gate

- Route bundled pure-JS connectors through the isolate in dev, self-hosted and Cloud; CI runs the
  connector suites in that lane.
- Delete the provenance branch of `cloudDenialReason`; keep the `process`-lane image-only rule.
  Update the README section "How connector code runs".

## Constraints

- SDK surface change and any stored-shape change surface first (AGENTS.md). No new table.
- Connector logic stays connector-owned; midas stays in `examples/personal-agent`.
- `isolated-vm` ABI: Node 26 only (`isolated-vm@7`); Bun cannot host it. Worker image is Node 26.
  Local `bun run dev` hosts the gateway and worker under Node 26 (`tsx`), so the isolate lane is
  available without a fork fallback.
- One branch, one concern; each PR lands through `make pre-pr`, `make review`,
  `make ui-review` (not applicable), `make land`.

## Open decisions for the owner

1. The threat model behind #3246: lateral movement to internal Postgres and metadata, or the
   compliance sentence "Cloud only runs code shipped in its image". The isolate closes the first
   structurally; the second needs a new sentence.
2. May a Cloud guest ever hold a credential? Decides whether PR 5 lands before PR 4 opens admission.
3. Bridge home: `packages/connector-worker/src/isolate` (proposed) or a new package.
4. Inline SDK per bundle (proven) or one linked SDK module per process (unmeasured).

## Verification still owed

- Extension dispatch inside the isolate (midas, x) was load-tested only; no `device.dispatch` run.
- Only hackernews was exercised at call time. Its needs beyond load were `AbortController` and
  `TextEncoder`; `ky` users will add `Headers`, `Request`, `Response`, `URLSearchParams`, `URL`.
- Memory and wall-clock cost on a large sync (thousands of events) is unmeasured.
- The `runtime` JSONB column and its readers need confirming before PR 4.
