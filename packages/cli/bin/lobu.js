#!/usr/bin/env node

// ─────────────────────────────────────────────────────────────────────────────
// Node-version gate. MUST run before `import "../dist/index.js"`.
//
// The floor is Node 22 because Lobu's agent-code sandbox (isolated-vm) only
// has native builds for Node 22–24 and 26+. Separately, on Node < 20 the
// bundled server's undici references the `File` global and
// the very first `import` of the bundle throws a cryptic
// `ReferenceError: File is not defined` — before any Lobu code, including the
// server's own assert-node-version guard, can run (ESM hoists the graph's
// imports above module bodies). So the check lives here, with zero imports, so
// nothing loads before it, and old-Node users get a clear message instead.
//
// Keep the threshold in sync with packages/cli/src/internal/node-version.ts
// (`lobu doctor`) and packages/server's assert-node-version.ts. 25 boots but
// has no isolated-vm build (no SDK sandbox).
// ─────────────────────────────────────────────────────────────────────────────
{
  const MIN_NODE_MAJOR = 22;
  const current = process.versions.node;
  const major = Number.parseInt(current.split(".")[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `\n  Lobu needs Node.js ${MIN_NODE_MAJOR} or newer — you're on Node ${current}.\n\n  (Lobu runs agent code in an isolated-vm sandbox whose native builds\n   only cover Node ${MIN_NODE_MAJOR}–24 and 26+, so ${MIN_NODE_MAJOR} is the minimum.)\n\n  Install a supported Node, then re-run:\n    • nvm:   nvm install 22 && nvm use 22\n    • fnm:   fnm install 22 && fnm use 22\n    • brew:  brew install node@22\n\n  Check your version with:  node --version\n\n`
    );
    process.exit(1);
  }
}

// Dynamic import (not a static top-level `import`) is REQUIRED here: a static
// import is hoisted and evaluated before the guard block above runs, so the
// bundle — and undici — would load before we could reject an old Node. The
// dynamic import defers that load until after the version gate has passed.
const { runCli } = await import("../dist/index.js");

await runCli(process.argv);
