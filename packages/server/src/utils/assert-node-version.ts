/**
 * Boot-time Node.js version and sandbox-addon assertion.
 *
 * Lobu's gateway and worker load isolated-vm, whose native addon is tied to a
 * single Node major's V8 ABI. This repo ships one isolated-vm 7 build and runs
 * it on Node 26 only. Below or above that line the sandbox cannot load, so the
 * server hard-fails with an actionable error instead of booting without the
 * core agent-code lane.
 *
 * The addon itself is probed once here, at startup, so a missing or broken
 * native build is visible in the boot log rather than only when a user invokes
 * query_sdk / run_sdk. The probe is deliberately non-fatal: the rest of the
 * gateway (chat, connections, memory) does not need a V8 isolate, and the
 * executor selector still fails closed per run.
 */

import { createRequire } from "node:module";

const REQUIRED_NODE_MAJOR = 26;

function assertSupportedNodeVersion(): void {
  const current = process.versions.node;
  const major = Number(current?.split('.')[0] ?? 0);

  if (!Number.isFinite(major) || major !== REQUIRED_NODE_MAJOR) {
    const message = [
      `Lobu requires Node.js ${REQUIRED_NODE_MAJOR}.x. Detected ${current}.`,
      `Fix: install Node ${REQUIRED_NODE_MAJOR} (e.g. \`brew install node@${REQUIRED_NODE_MAJOR}\`, then \`PATH=/opt/homebrew/opt/node@${REQUIRED_NODE_MAJOR}/bin:$PATH make dev\`)`,
      'or use a version manager that honours .nvmrc/.node-version (nvm, fnm, mise, asdf, volta).',
    ].join('\n  ');
    throw new Error(`Unsupported Node.js runtime.\n  ${message}`);
  }
}

// Run on module load so a single side-effect import at the top of an entry
// file fires the check BEFORE any other static import executes. ESM evaluates
// sibling imports in textual order; placing this module's import first
// guarantees the assertion runs before instrument.ts, dotenv, embedded-postgres, etc.
assertSupportedNodeVersion();

const moduleRequire = createRequire(import.meta.url);

function probeIsolatedVm(): { ok: true; version: string | null } | { ok: false; reason: string } {
  try {
    const ivm = moduleRequire('isolated-vm') as {
      Isolate: new (options?: { memoryLimit?: number }) => { dispose(): void };
    };
    const isolate = new ivm.Isolate({ memoryLimit: 8 });
    isolate.dispose();
    let version: string | null = null;
    try {
      version = (moduleRequire('isolated-vm/package.json') as { version?: string }).version ?? null;
    } catch {
      // Version is diagnostics only.
    }
    return { ok: true, version };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const sandbox = probeIsolatedVm();
if (!sandbox.ok) {
  console.error(
    [
      `[lobu] WARNING: the isolated-vm native addon failed to load on Node ${process.versions.node}.`,
      `  ${sandbox.reason}`,
      '  The SDK sandbox (query_sdk / run_sdk) and the connector isolate lane will be unavailable.',
      '  Reinstall on Node 26 with `bun install`; if no prebuilt binary matches this platform, install python3 and build-essential and reinstall.',
    ].join('\n'),
  );
}
