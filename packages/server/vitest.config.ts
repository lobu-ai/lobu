import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const PACKAGE_ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Anchor vitest to this package so test-db.ts's `process.cwd()`-based
  // migration resolution works the same way whether `vitest` is invoked from
  // the repo root (with an explicit Node-backed invocation) or from inside the
  // package via the canonical `bun run test -- run ...` script.
  root: PACKAGE_ROOT,
  resolve: {
    alias: {
      // Example fixtures load the real authoring config; server CI does not
      // build the CLI distribution, so resolve its dependency-light source.
      "@lobu/cli/config": fileURLToPath(
        new URL("../cli/src/config/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globalSetup: ["./src/__tests__/setup/global-setup.ts"],
    // Automation windows select rows by `events.created_at` and stop one
    // arrival settle window short of the database clock, so in production a row
    // is claimable 60s after it lands. An integration test inserts a row and
    // claims a window in the same breath, which that budget would hide
    // entirely. Collapse it here; `arrival-axis-window.test.ts` restores the
    // production value for the cases that exist to prove the settle window.
    // Set through `test.env` rather than `globalSetup`, which runs in a
    // separate process whose env does not reliably reach the forked workers.
    env: {
      AUTOMATION_ARRIVAL_SETTLE_MS: "0",
    },
    // Integration tests need a DB ready before any test file starts. Unit tests
    // don't touch the DB, so they run fast regardless.
    include: [
      "src/**/*.test.ts",
      // Example-owned lifecycle fixtures share this isolated Postgres harness.
      // The suffix keeps them out of examples' separate bun:test unit run.
      "../../examples/*/evals/*.integration.ts",
    ],
    // bun:test-style unit tests live alongside vitest integration tests — skip
    // those for vitest. They run via `bun test` (see the existing CI command).
    // Anything under `src/gateway/**/__tests__` is bun:test-style (carried over
    // from the merged @lobu/gateway package, plus the caches + queue unit tests).
    exclude: [
      "src/__tests__/unit/**",
      // Opt-in, key-gated live provider smoke — bun:test, run via
      // `make test-providers-live`, never as part of the integration gate.
      "src/__tests__/live-providers/**",
      "src/gateway/**/__tests__/**",
      // Only src/lobu/__tests__ is bun:test (route suites). Nested dirs like
      // src/lobu/stores/__tests__ are vitest-style and must stay visible to
      // vitest — do NOT broaden this back to src/lobu/**/__tests__/**.
      "src/lobu/__tests__/**",
      "src/scheduled/**/__tests__/**",
      "src/workspace/**/__tests__/**",
      // src/tools/admin/__tests__ is bun:test (schedule-delivery suites), run via
      // the same `bun test … src/tools/admin/__tests__` job — keep it off vitest.
      "src/tools/admin/__tests__/**",
      // src/auth/oauth/__tests__ is bun:test (OAuth scope suites), run via the
      // same `bun test … src/auth/oauth/__tests__` job — keep it off vitest.
      "src/auth/oauth/__tests__/**",
      // src/auth/__tests__ is a MIXED dir: most files are vitest-style and must
      // stay visible to vitest. system-provider-resolution imports bun:test, so
      // vitest cannot load it — exclude just that file (it runs via its own bun
      // test job). Do NOT broaden to src/auth/__tests__/** — that orphans the
      // vitest files. (tool-access is framework-less and runs fine in both.)
      "src/auth/__tests__/system-provider-resolution.test.ts",
      // src/tools/admin/manage_operations/__tests__ is a bun:test-only dir
      // (activity-feed collapse unit suite). Keep it off vitest; it runs via the
      // server bun:test units job. (Sibling src/tools/admin/__tests__ is handled
      // by its own exclude above.)
      "src/tools/admin/manage_operations/__tests__/**",
      // src/utils/__tests__ is a MIXED dir: most files are vitest-style. The
      // files below import bun:test (device-pin tombstones, plus the #2042/#2043
      // connector-compiler suites), so exclude just those files (they run via
      // the server bun:test units job). Do NOT broaden to
      // src/utils/__tests__/** — that orphans the vitest files.
      "src/utils/__tests__/device-pin-tombstones.test.ts",
      "src/utils/__tests__/catalog-connectors-compile.test.ts",
      "src/utils/__tests__/compiler-core.test.ts",
      "src/utils/__tests__/build-catalog-manifests-exit.test.ts",
      // Unlike the files above, this one needs Postgres (it executes the pause
      // decision against real rows), so it runs in the bun:test/Postgres job
      // alongside src/lobu/__tests__ rather than in the pure-unit job.
      "src/utils/__tests__/deployment-pause.test.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one Postgres. Running multiple files in
    // parallel means one file's `cleanupTestDatabase()` can wipe another file's
    // fixtures mid-run. Serialize files so fixtures stay stable.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // CRITICAL for the shared DB singleton in db/client.ts: with vitest's
    // default `isolate: true`, each test file gets a fresh module registry —
    // so each one re-runs `let dbSingleton = null` and opens its own pool.
    // `idle_timeout: 0` in db/client.ts means those orphaned pools' sockets
    // never close, and 70+ files × 5 connections each blew past the
    // pgvector-image `max_connections=100` with the classic "sorry, too many
    // clients already" error. Sharing the module graph (`isolate: false`)
    // keeps the singleton truly singleton across the whole run.
    isolate: false,
  },
});
