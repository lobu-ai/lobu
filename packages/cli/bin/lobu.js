#!/usr/bin/env node

// ─────────────────────────────────────────────────────────────────────────────
// Node-version gate. MUST run before `import "../dist/index.js"`.
//
// Lobu's gateway and worker load isolated-vm, whose native addon is built for
// Node 26's V8 ABI in this repo. Separately, on Node < 20 the bundled server's
// undici references the `File` global and the very first `import` of the
// bundle throws a cryptic `ReferenceError: File is not defined` — before any
// Lobu code, including the server's own assert-node-version guard, can run
// (ESM hoists the graph's imports above module bodies). So the check lives
// here, with zero imports, so nothing loads before it.
//
// Keep the major in sync with packages/cli/src/internal/node-version.ts
// (`lobu doctor`) and packages/server's assert-node-version.ts. Bun reports a
// Node-compatible version here, so this gate intentionally lets a Bun-hosted
// CLI through: `lobu run` resolves a real Node 26 binary before spawning the
// backend (see src/internal/node-binary.ts).
// ─────────────────────────────────────────────────────────────────────────────
{
  const REQUIRED_NODE_MAJOR = 26;
  const current = process.versions.node;
  const major = Number.parseInt(current.split(".")[0], 10);
  if (!Number.isFinite(major) || major !== REQUIRED_NODE_MAJOR) {
    process.stderr.write(
      `\n  Lobu needs Node.js ${REQUIRED_NODE_MAJOR}.x — you're on Node ${current}.\n\n  (Lobu runs agent code in an isolated-vm sandbox whose native build\n   covers Node ${REQUIRED_NODE_MAJOR}.x only.)\n\n  Install Node ${REQUIRED_NODE_MAJOR}, then re-run:\n    • nvm:   nvm install ${REQUIRED_NODE_MAJOR} && nvm use ${REQUIRED_NODE_MAJOR}\n    • fnm:   fnm install ${REQUIRED_NODE_MAJOR} && fnm use ${REQUIRED_NODE_MAJOR}\n    • brew:  brew install node@${REQUIRED_NODE_MAJOR}\n\n  Check your version with:  node --version\n\n`
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
