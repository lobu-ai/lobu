/**
 * Ephemeral embedded-Postgres backend for tests.
 *
 * Spawns a real PostgreSQL 18 (embedded-postgres) on a throwaway datadir and
 * returns a plain DATABASE_URL any postgres.js client can use — so `make test`
 * needs no external Postgres, exactly like `lobu run`. Same binary + pgvector
 * injection as the production embedded path (src/embedded-runtime.ts), so tests
 * exercise the real engine (prepared statements, multi-conn pool, LISTEN/NOTIFY,
 * cube/earthdistance, pgvector).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ensureNativeLibSonames,
  installPgvector,
  resolveEmbeddedNativeDir,
} from '@lobu/pgvector-embedded';
import exitHook from 'async-exit-hook';
import EmbeddedPostgres from 'embedded-postgres';
import { withFreePortRetry } from './free-port';
import { reapStaleClustersIn, STALE_CLUSTER_MS } from './reap-stale-clusters';

// Importing `embedded-postgres` registers async-exit-hook, whose `beforeExit`
// handler force-exits with code 0 (`process.nextTick(process.exit.bind(null, 0))`).
// Because the vitest globalSetup imports this module, that hook lives in the
// MAIN vitest process: after a failed run vitest sets `process.exitCode = 1`
// and lets the loop drain, Node emits `beforeExit`, and the hook overwrites the
// failure with exit 0 — CI went green on a run with 8 failed tests (#1216).
// The `exit` hook is removed too: it calls the async gracefulShutdown without
// a `done` callback (`done is not a function` unhandled rejection on every
// clean run), and async cleanup can't execute during `exit` anyway. Signal
// hooks (SIGINT/SIGTERM/SIGHUP) stay so Ctrl-C still stops embedded clusters;
// the normal path stops them explicitly through stopActiveEmbeddedBackend().
exitHook.unhookEvent('beforeExit');
exitHook.unhookEvent('exit');

export interface EmbeddedBackend {
  url: string;
  stop: () => Promise<void>;
}

let active: EmbeddedBackend | null = null;
let reapedStaleClusters = false;

/**
 * Reap orphaned `lobu-test-pg-*` clusters left by prior runs that were KILLED
 * (SIGKILL / timeout / OOM / ENOSPC / `pkill`) before teardown could run — those
 * paths skip BOTH the `beforeExit` hook and `async-exit-hook`, so the data dir
 * (~150-400 MB each) leaks to tmp forever. A whole session of killed runs once
 * piled up 65 GB and filled the disk; `make clean-test-pg` only freed SHM slots,
 * never the dirs. Self-healing: every run reaps the previous runs' leaks, once
 * per process, before adding its own — so a kill can never accumulate. The pure
 * logic lives in ./reap-stale-clusters (no embedded-postgres import, so the
 * no-database unit suite can test it directly).
 */
function reapStaleClusters(): void {
  if (reapedStaleClusters) return;
  reapedStaleClusters = true;
  reapStaleClustersIn(tmpdir(), Date.now(), STALE_CLUSTER_MS);
}

let activeStopImpl: (() => Promise<void>) | null = null;
let activeExitStopImpl: (() => void) | null = null;
let stopPromise: Promise<void> | null = null;
let shutdownHooksRegistered = false;

function registerShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  // Best-effort cleanup for vitest/node paths that let the event loop drain.
  // Unlike async-exit-hook, this never calls process.exit(0) and therefore
  // cannot mask a failing test run's exit code.
  process.on('beforeExit', () => {
    // Keep the process alive until async pg.stop() finishes; never call
    // process.exit() here (#1216).
    const pending = stopActiveEmbeddedBackend().catch((err) => {
      console.error('[embedded-postgres-test] cleanup failed during beforeExit', err);
    });
    void pending;
  });

  // Bun may skip `beforeExit` and, with shared module caching across test files,
  // the per-file afterAll owner can finish before the final embedded backend is
  // started. `exit` cannot await async cleanup, so only issue a synchronous
  // pg_ctl stop as a last-ditch orphan-prevention fallback; never change the
  // process exit code.
  process.on('exit', () => {
    activeExitStopImpl?.();
  });
}

/** Stop the active embedded Postgres, if any, serializing concurrent callers. */
export function stopActiveEmbeddedBackend(): Promise<void> {
  if (stopPromise) return stopPromise;
  if (!activeStopImpl) {
    active = null;
    activeExitStopImpl = null;
    return Promise.resolve();
  }

  const stopImpl = activeStopImpl;
  stopPromise = stopImpl().finally(() => {
    if (activeStopImpl === stopImpl) {
      activeStopImpl = null;
    }
    active = null;
    activeExitStopImpl = null;
    stopPromise = null;
  });
  return stopPromise;
}

/**
 * Start an ephemeral embedded Postgres and return a connectable DATABASE_URL.
 * Idempotent: repeated calls return the same instance until `stop()` runs.
 */
export async function startEmbeddedBackend(): Promise<EmbeddedBackend> {
  if (stopPromise) await stopPromise;
  if (active) return active;

  // Self-heal: clear orphaned clusters from previously-killed runs before we add
  // our own, so a kill can never accumulate disk (see reapStaleClusters).
  reapStaleClusters();

  ensureNativeLibSonames(resolveEmbeddedNativeDir());
  // Staged outside the installed binary tree, like the embedded runtime. One
  // shared dir is safe: installPgvector is idempotent and swaps files atomically.
  const { postgresFlags } = installPgvector(join(tmpdir(), 'lobu-test-pgvector'));

  // embedded-postgres needs a concrete port at construction. Ask the OS for a
  // free one and retry on collision rather than picking a random high port and
  // failing loud — under concurrent test load that races to EADDRINUSE (#976).
  // Each attempt gets a fresh datadir because initdb refuses a reused one.
  const { pg, port, dataDir } = await withFreePortRetry(async (candidate) => {
    const dir = mkdtempSync(join(tmpdir(), 'lobu-test-pg-'));
    // embedded-postgres rejects start() with `undefined` on ANY early exit —
    // a port collision included — so the OS-level EADDRINUSE never reaches the
    // catch. Capture stderr and re-tag a bind failure as EADDRINUSE so the
    // retry wrapper actually retries; surface anything else as a real error.
    let log = '';
    const instance = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postgres',
      password: 'postgres',
      port: candidate,
      persistent: false,
      postgresFlags,
      onLog: (message) => {
        log += message;
      },
    });
    const originalStop = instance.stop.bind(instance);
    let instanceStopPromise: Promise<void> | null = null;
    instance.stop = async () => {
      instanceStopPromise ??= originalStop();
      await instanceStopPromise;
    };
    try {
      await instance.initialise();
      await instance.start();
      // Create a dedicated, test-named database. The harness runs
      // `DROP SCHEMA public CASCADE`, guarded by assertSafeTestDatabaseUrl which
      // only accepts databases whose name marks them as test/CI. The embedded
      // cluster's default db is `postgres`, which the guard (rightly) rejects —
      // so without this, `make test`/`make review` against the ephemeral backend
      // fail before a single test runs. A `*_test` name satisfies the guard
      // naturally, keeping the prod-wipe protection intact (no destructive
      // override needed).
      await instance.createDatabase('lobu_test');
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      if (/address already in use|could not bind/i.test(log)) {
        throw Object.assign(new Error(`embedded-postgres: port ${candidate} in use`), {
          code: 'EADDRINUSE',
        });
      }
      throw err instanceof Error
        ? err
        : new Error(`embedded-postgres failed to start: ${log.slice(-500) || 'no output'}`);
    }
    return { pg: instance, port: candidate, dataDir: dir };
  });

  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/lobu_test?sslmode=disable`;
  const child = (pg as unknown as { process?: { spawnfile?: string } }).process;
  const pgCtl = child?.spawnfile ? join(dirname(child.spawnfile), 'pg_ctl') : null;
  activeExitStopImpl = () => {
    if (!pgCtl) return;
    spawnSync(pgCtl, ['stop', '-D', dataDir, '-m', 'fast', '-w'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    rmSync(dataDir, { recursive: true, force: true });
  };
  activeStopImpl = async () => {
    try {
      await pg.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
  active = {
    url,
    stop: stopActiveEmbeddedBackend,
  };
  registerShutdownHooks();
  return active;
}
