/**
 * Builds the agent-session guest bundle.
 *
 * The guest is Lobu's own code, not organization-supplied source, so it is
 * bundled once per worker process and reused for every turn. It goes through
 * the SAME `ISOLATE_LANE_BUILD_OPTIONS` a connector does — one set of esbuild
 * options, one eligibility rule — plus three alias rules that drop the provider
 * SDKs this lane never selects.
 *
 * Why the aliases are exactly these three: `@google/genai` resolves to its Node
 * build and drags google-auth-library, gaxios, ws, node-fetch, agent-base,
 * https-proxy-agent, proxy-agent, debug and supports-color in with it, and
 * `@aws-sdk/client-bedrock-runtime` drags the Bedrock path. Stubbing those two
 * roots removes every Node builtin from the bundle but one: pi-ai reads
 * `/proc/self/environ` through `node:fs` when it detects Bun with an empty
 * `process.env`. That single importer loses `fs`; every other module keeps it,
 * so a bare `require('fs')` anywhere else still survives into the bundle and
 * `assertIsolateEligible` still rejects it.
 */

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISOLATE_LANE_BUILD_OPTIONS } from '../compile/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** esbuild namespace for the aliased-away provider SDKs. */
const STUB_NAMESPACE = 'lobu-agent-guest-stub';
/** esbuild namespace for just-bash's lazily used zlib import. */
const ZLIB_STUB_NAMESPACE = 'lobu-agent-guest-zlib-stub';

/**
 * The compiled guest entry. `tsc` emits `guest-entry.js` next to this module;
 * under `tsx` only the TypeScript source exists, and esbuild takes either.
 */
function guestEntryPath(): string {
  const compiled = join(HERE, 'guest-entry.js');
  return existsSync(compiled) ? compiled : join(HERE, 'guest-entry.ts');
}

/**
 * The bundle `build-guest-bundle.ts` writes next to this file at build time.
 *
 * The published package ships this file and nothing else the guest needs: its
 * plugin dependencies are workspace packages that never reach the registry, so
 * bundling them at build time is what makes an installed copy self-contained.
 * In a source checkout (tsx, bun test) there is no such file and the guest is
 * bundled from the sources on first use.
 */
const PREBUILT_GUEST_BUNDLE = join(HERE, 'guest.bundle.js');

let cached: Promise<string> | null = null;

export async function buildAgentGuest(): Promise<string> {
  const result = await build({
    ...ISOLATE_LANE_BUILD_OPTIONS,
    entryPoints: [guestEntryPath()],
    bundle: true,
    write: false,
    minify: false,
    sourcemap: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'agent-guest-alias',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^(@google\/genai|@aws-sdk\/client-bedrock-runtime)(\/.*)?$/ }, (args) => ({
            path: args.path,
            namespace: STUB_NAMESPACE,
          }));
          pluginBuild.onResolve({ filter: /^(node:)?fs$/ }, (args) =>
            /pi-ai[/\\]dist[/\\]env-api-keys\.js$/.test(args.importer)
              ? { path: args.path, namespace: STUB_NAMESPACE }
              : undefined
          );
          // just-bash's browser build imports gunzip/gzip for its gzip, zcat
          // and rg-over-.gz commands and nothing else; the import is static, so
          // it must resolve, but the functions are only ever called when one of
          // those commands runs. The stub answers the import and throws on use.
          pluginBuild.onResolve({ filter: /^(node:)?zlib$/ }, (args) =>
            /just-bash[/\\]dist[/\\]/.test(args.importer) ? { path: args.path, namespace: ZLIB_STUB_NAMESPACE } : undefined
          );
          pluginBuild.onLoad({ filter: /.*/, namespace: ZLIB_STUB_NAMESPACE }, () => ({
            contents: [
              "function unavailable() { throw new Error('gzip is not available in the agent workspace'); }",
              'module.exports = { gunzipSync: unavailable, gzipSync: unavailable, constants: {} };',
            ].join('\n'),
            loader: 'js',
          }));
          pluginBuild.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, () => ({
            contents: 'module.exports = {};',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error('the agent guest bundle built to nothing');
  return code;
}

/**
 * The guest bundle for this process. Built on the first turn and kept: it is
 * the same bytes for every agent, and rebuilding it per turn would cost about a
 * second of the turn's own budget.
 */
export function agentGuestBundle(): Promise<string> {
  cached ??= (existsSync(PREBUILT_GUEST_BUNDLE) ? readFile(PREBUILT_GUEST_BUNDLE, 'utf8') : buildAgentGuest()).catch((error) => {
    // A failed build must not poison every later turn with the same rejection.
    cached = null;
    throw error;
  });
  return cached;
}
