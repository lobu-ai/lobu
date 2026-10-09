/**
 * Bundle entry wrapper — Node-version gate FIRST, then the real server.
 *
 * Server dependencies require the supported Node globals and native ABI.
 * This entry has no static server imports: the version check must run before
 * dependency evaluation, so unsupported Node versions get an actionable error.
 * The build emits server-main.bundle.mjs separately to prevent import hoisting.
 *
 * Keep the threshold in sync with ./utils/assert-node-version.ts and the CLI's
 * internal/node-version.ts + bin/lobu.js.
 */

const MIN_NODE_MAJOR = 22;

function assertNodeOrExit(): void {
  const current = process.versions.node;
  const major = Number.parseInt((current ?? "").split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `\n  Lobu needs Node.js ${MIN_NODE_MAJOR} or newer — you're on Node ${current}.\n` +
        `  (The isolated-vm sandbox only has native builds for Node ${MIN_NODE_MAJOR}–24 and 26+.)\n` +
        `  Install Node ${MIN_NODE_MAJOR}+ (nvm/fnm/brew) and re-run.\n\n`,
    );
    process.exit(1);
  }
}

assertNodeOrExit();

// Dynamic import of the SEPARATE server-main bundle is REQUIRED: a static
// import — or a dynamic import esbuild can resolve and inline — would hoist the
// server dependency graph above assertNodeOrExit(), defeating the
// gate. Constructing the URL at runtime leaves the import for Node and defers
// dependencies until after the check passes. server-main self-executes its main() on
// load, so importing it boots the server.
//
// The specifier is resolved relative to this file's URL so it works from the
// bundle's dist dir regardless of cwd. In the TS source (dev/tsx) the sibling
// bundle doesn't exist; that path is bundle-only, which is why this entry is
// the build's entrypoint, not something imported by the TS server at runtime.
const serverMainUrl = new URL("./server-main.bundle.mjs", import.meta.url).href;
await import(serverMainUrl);
