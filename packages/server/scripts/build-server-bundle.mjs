#!/usr/bin/env node
/**
 * Bundle the single server entrypoint into a standalone ESM file consumed by
 * the published @lobu/cli package. One entry (server.ts) serves both backends.
 *
 * Why: prod runs under Node so isolated-vm (V8 native addon) loads. Running
 * the TS source through tsx exposes Node's CJS↔ESM lexer interop with
 * @lobu/core's CJS dist (#430 history). Bundling resolves all workspace
 * imports at build time, so Node only ever sees the bundle's own ESM
 * surface plus a small set of npm externals it can load from node_modules.
 *
 * Resolution conditions: 'bun' first, so workspace packages resolve to
 * their TS source (./src/index.ts via the package.json `bun` condition)
 * instead of their CJS dist. esbuild compiles the TS inline.
 *
 * External: bare specifiers stay external (loaded from node_modules at
 * runtime). Published `@lobu/cli` declares those runtime dependencies
 * directly so Node's resolver finds them from the CLI install. Native addons
 * (isolated-vm), embedded-postgres + pgvector binaries, and packages with
 * require-in-the-middle hooks (Sentry, OpenTelemetry, pino) MUST stay external
 * to keep their runtime hooks working.
 */

import esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');

const commonOptions = {
  absWorkingDir: pkgDir,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  conditions: ['bun', 'import', 'module', 'default'],
  // Bundle only @lobu/* workspace packages and relative imports. Everything
  // else stays external.
  plugins: [
    {
      name: 'external-non-workspace',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === 'entry-point') return null;
          const id = args.path;
          if (id.startsWith('.') || id.startsWith('/')) return null;
          // @lobu/pgvector-embedded ships prebuilt binary assets under
          // prebuilt/ that esbuild can't inline; keep it external so it loads
          // from node_modules with its assets intact (like the npm externals).
          if (id === '@lobu/pgvector-embedded' || id.startsWith('@lobu/pgvector-embedded/'))
            return { external: true };
          if (id.startsWith('@lobu/')) return null;
          return { external: true };
        });
      },
    },
  ],
  // CJS-style require() shim for any leftover require() calls in bundled
  // code (esbuild emits these when it inlines CJS-flavoured workspace src).
  // Don't inject __filename/__dirname here — esbuild emits per-module shims
  // when bundled CJS source references them; top-level shims would collide.
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
  },
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
};

async function buildBundle(entryPoint, outfile) {
  const result = await esbuild.build({
    ...commonOptions,
    entryPoints: [entryPoint],
    outfile,
  });

  assertSingleConnectorWorkerIdentity(result.metafile, outfile);

  const output = Object.entries(result.metafile.outputs).find(([file]) =>
    file.endsWith(outfile),
  )?.[1];
  const bytes = output?.bytes ?? 0;
  console.log(
    `\n=== bundle ready: ${outfile} (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
  );
  console.log(`    warnings: ${result.warnings.length}, errors: ${result.errors.length}`);
}

// Guard against the #v14 regression where a caller imported connector-worker
// via a cross-package `../../../connector-worker/src/...` path while the rest of
// the tree used its `@lobu/connector-worker/*` exports. The bundler then carried
// the same module twice — once as workspace `src`, once as compiled `dist` —
// treating equivalent code as separate modules. Fail the build if any
// connector-worker module stem is reached through both.
function assertSingleConnectorWorkerIdentity(metafile, outfile) {
  const byStem = new Map();
  for (const p of Object.keys(metafile.inputs)) {
    const m = p.match(/connector-worker\/(src|dist)\/(.+?)\.(?:m?[jt]s)$/);
    if (!m) continue;
    const [, kind, stem] = m;
    if (!byStem.has(stem)) byStem.set(stem, new Set());
    byStem.get(stem).add(kind);
  }
  const dupes = [...byStem.entries()]
    .filter(([, kinds]) => kinds.has('src') && kinds.has('dist'))
    .map(([stem]) => stem);
  console.log(
    `    connector-worker inputs: ${byStem.size} module stem(s), ${dupes.length} duplicated across src+dist`,
  );
  if (dupes.length > 0) {
    throw new Error(
      `[build-server-bundle] ${outfile}: ${dupes.length} connector-worker module(s) ` +
        `bundled through BOTH src and dist — import them via @lobu/connector-worker/* ` +
        `exports, not cross-package src paths:\n  ${dupes.sort().join('\n  ')}`,
    );
  }
}

// Single server graph for both backends: server.ts branches on DATABASE_URL
// (postgres:// = external; path/file:// = embedded, lazy-loading the embedded
// Postgres runtime so the external/prod path never resolves that binary).
//
// Two-file split for the Node-version gate:
//   server.bundle.mjs       — tiny gate entry (server-entry.ts). Zero app deps.
//                             Runs a dependency-free Node-major check, then
//                             dynamically imports ./server-main.bundle.mjs.
//   server-main.bundle.mjs  — the real server graph (server.ts + all deps).
//
// The gate MUST be its own file so esbuild can't hoist the server graph's
// @sentry/node → undici import above the check. On Node 18, undici references
// the absent `File` global and throws `File is not defined` at load —
// before any in-graph guard could run. Keeping the graph behind a runtime
// dynamic import to a *separate* bundle means undici only loads after the gate
// passes. server-entry.ts constructs the sibling URL at runtime so esbuild
// cannot resolve and inline it.
await buildBundle('src/server.ts', 'dist/server-main.bundle.mjs');
await buildBundle('src/server-entry.ts', 'dist/server.bundle.mjs');

// Inlining the guest loader moves its import.meta.url here. Keep its
// prebuilt guest beside the server graph, just as in connector-worker/dist.
cpSync(
  join(pkgDir, '..', 'connector-worker', 'dist', 'agent-turn', 'guest.bundle.js'),
  join(pkgDir, 'dist', 'guest.bundle.js'),
);

const connectorsSrc = join(pkgDir, '..', 'connectors', 'src');
const connectorsDest = join(pkgDir, 'dist', 'connectors');
if (existsSync(connectorsSrc)) {
  if (existsSync(connectorsDest)) {
    rmSync(connectorsDest, { recursive: true, force: true });
  }
  mkdirSync(dirname(connectorsDest), { recursive: true });
  cpSync(connectorsSrc, connectorsDest, { recursive: true });
  console.log(`\n=== copied connectors: ${connectorsDest}`);
}
