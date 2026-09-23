/**
 * Shared connector compile pipeline.
 *
 * Three packages (`@lobu/connector-worker` itself, `@lobu/cli`, and
 * `@lobu/server`) each used to ship their own near-identical copies of:
 *
 *   - `findBundledConnectorFile(key)` — walks a list of candidate dirs
 *     trying both filename conventions (`browser.evaluate → browser/evaluate.ts`
 *     and `chrome.tabs → chrome_tabs.ts`).
 *   - a connector compile step — esbuild bundle with the `npm:` specifier
 *     plugin, the `lobu` / `@lobu/connector-sdk` aliases, and an mtime-keyed
 *     LRU cache.
 *   - The `npm:` specifier resolver plugin.
 *   - The `EXTERNAL_RUNTIME_DEPS` constant.
 *
 * Three copies meant three "keep these in sync" comments and three places
 * to fix every esbuild-flag or candidate-dir change. This module is the
 * one place that owns those mechanics; each caller supplies its own
 * candidate-dir list (and optional warn hook) since those are genuinely
 * environment-specific (gateway pod vs worker pod vs npm-installed CLI).
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RetainedSource } from '@lobu/core/contracts/tools/source-files';
import { build, type BuildOptions, type Metafile, type Plugin } from 'esbuild';
import {
  IsolateLaneIneligibleError,
  ISOLATE_PRELUDE_PROVIDED_BUILTINS,
  isNodeBuiltinSpecifier,
} from '../isolate/eligibility.js';
import { EXTERNAL_RUNTIME_DEPS } from '../runtime-deps.js';
import { createSourceCapture } from './source-capture.js';

export { createSourceCapture, sourceDependencies } from './source-capture.js';

export {
  assertExternalDepsResolvable,
  COMPILE_CONFIG_HASH,
  computeCompileConfigHash,
  EXTERNAL_RUNTIME_DEPS,
  RUNTIME_PROVIDED_PACKAGES,
} from '../runtime-deps.js';

// Strict regex for connector_key: lowercase letters/digits, optional dots
// for namespacing, underscores for word separators. Defense-in-depth even
// though keys come from a trusted DB column — we're about to use the value
// to construct a filesystem path.
const CONNECTOR_KEY_RE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;

/**
 * Resolve a connector_key to a `.ts` source file under one of the supplied
 * candidate directories.
 *
 * Tries two filename conventions in order:
 *   - subdirectory layout: `browser.evaluate` → `browser/evaluate.ts`
 *     (lets us group related primitives without renaming the key);
 *   - flat-with-underscores: `chrome.tabs` → `chrome_tabs.ts`
 *     (existing convention).
 *
 * Returns the absolute path of the first match, or `null` if none exists.
 * Performs no caching of its own — callers that hit this on a hot path
 * (gateway worker-poll, CLI compile loop) can layer their own memo on
 * top, since the right TTL depends on whether they expect new connector
 * files to appear at runtime.
 */
export function findBundledConnectorFile(
  key: string,
  candidateDirs: readonly string[]
): string | null {
  if (!CONNECTOR_KEY_RE.test(key)) return null;
  const candidates = [
    `${key.replace(/\./g, '/')}.ts`,
    `${key.replace(/\./g, '_')}.ts`,
  ];
  for (const dir of candidateDirs) {
    for (const fileName of candidates) {
      const filePath = resolve(dir, fileName);
      // Belt-and-braces: the resolved path must stay under the candidate
      // dir. CONNECTOR_KEY_RE already forbids `..`, but the regex doesn't
      // know about our path-joining choices.
      if (!filePath.startsWith(`${dir}/`)) continue;
      if (existsSync(filePath)) return filePath;
    }
  }
  return null;
}

/**
 * Matches the connector SDK as a root or subpath import, under either the
 * `lobu` alias or its real package name. Shared with the server's source-text
 * compiler (`packages/server/src/utils/compiler-core.ts`) so the two compilers
 * cannot disagree about what counts as an SDK import — one externalizes it,
 * the other resolves it to a file, and a specifier only one of them recognises
 * would compile in one runtime and fail in the other.
 */
export const SDK_SPECIFIER_RE = /^(lobu|@lobu\/connector-sdk)(\/.*)?$/;

/** Normalize the `lobu` alias to the real package name, preserving any subpath. */
export function normalizeSdkSpecifier(specifier: string): string {
  return specifier.replace(/^lobu(?=$|\/)/, '@lobu/connector-sdk');
}

/**
 * esbuild options for code that runs inside a V8 isolate: the gateway's script
 * sandbox (`packages/server/src/sandbox/run-script.ts`, via the server's
 * `compiler-core`) and the connector isolate lane. `external: []` inlines every
 * import because an isolate has no module resolver, and `platform: 'node'`
 * leaves Node builtins as bare `require()` calls that throw at load — the
 * fail-closed signal `findIsolateIneligibleBuiltins` and the lane tests key
 * on. One constant so the runtime and the tests that classify bundles can
 * never disagree.
 */
export const ISOLATE_LANE_BUILD_OPTIONS = {
  format: 'cjs',
  target: 'esnext',
  platform: 'node',
  conditions: ['workerd'],
  supported: { 'dynamic-import': false },
  external: [],
} as const satisfies Partial<BuildOptions>;

/**
 * Retained artifacts travel with their source, so they must be portable:
 * esbuild otherwise embeds build paths in module comments, CommonJS wrapper
 * keys, and generated identifiers. Whitespace minification alone keeps them.
 */
const RETAINED_SOURCE_BUILD_OPTIONS = {
  minify: true,
  legalComments: 'none',
} as const satisfies Partial<BuildOptions>;

export interface NpmSpecifierPluginOptions {
  /**
   * Called when a `npm:foo@1.2.3` import resolves to a package that's not
   * installed in the current environment. The plugin externalises the
   * import (so the bundle still emits) and the runtime must supply it.
   * Use this hook to log / surface the externalisation.
   * Ignored under `unresolved: 'error'`.
   */
  onUnresolved?: (info: { bareSpecifier: string; importer: string }) => void;
  /**
   * What to do when the bare package can't be resolved in the build
   * environment: `'externalize'` (default) emits the import as external and
   * the runtime must provide it; `'error'` fails the build with esbuild's
   * resolution error (used by compilers whose artifacts must be fully
   * self-contained, e.g. the server's source-text compiler).
   */
  unresolved?: 'externalize' | 'error';
}

/**
 * esbuild plugin that strips the `npm:` prefix from connector imports
 * (`import x from 'npm:foo@1.2.3'`) and resolves the bare specifier
 * against node_modules. Unresolved packages are externalised or failed
 * per {@link NpmSpecifierPluginOptions.unresolved}. Registered as an
 * onResolve hook, so it only ever sees real module declarations parsed
 * from the source AST — `npm:` text inside strings or comments is data,
 * never rewritten (#2043).
 */
export function createNpmSpecifierPlugin(options?: NpmSpecifierPluginOptions): Plugin {
  return {
    name: 'npm-specifier',
    setup(b) {
      b.onResolve({ filter: /^npm:/ }, async (args) => {
        const bare = args.path
          .slice(4)
          .replace(/^(@[^/]+\/[^/@]+)@[^/]*/, '$1')
          .replace(/^([^/@]+)@[^/]*/, '$1');
        if (!bare) {
          return {
            errors: [
              {
                text: `Invalid npm: import specifier "${args.path}". Expected npm:package@version or npm:@scope/package@version.`,
              },
            ],
          };
        }
        const resolved = await b.resolve(bare, {
          resolveDir: args.resolveDir,
          kind: args.kind,
        });
        if (resolved.errors.length > 0) {
          if (options?.unresolved === 'error') return resolved;
          options?.onUnresolved?.({ bareSpecifier: bare, importer: args.importer });
          return { path: bare, external: true, errors: [], warnings: [] };
        }
        return resolved;
      });
    },
  };
}

/**
 * Flatten a multi-file connector source into ONE self-contained source text:
 * the relative import graph is inlined (source-level bundle) while `lobu` /
 * `@lobu/connector-sdk`, `npm:` specifiers, bare packages, and node builtins
 * stay as import statements for the downstream compiler to resolve.
 *
 * This is what install paths persist as `source_code` for file-backed
 * connectors: a stored source must recompile under the strict single-file
 * source-text compiler (`compileConnectorSource`) years later, on any replica,
 * with no repo checkout — raw multi-file text with relative imports can never
 * do that (#2042, the Gmail scraper-utils outage).
 *
 * Deterministic: same inputs produce the same output (esbuild text transform,
 * no minification, no timestamps).
 */
export async function flattenConnectorSourceFromFile(filePath: string): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'lobu-connector-flatten-'));
  const outPath = join(tmpDir, 'flattened.mjs');
  try {
    await build({
      entryPoints: [filePath],
      outfile: outPath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'esnext',
      plugins: [
        {
          name: 'external-non-relative',
          setup(b) {
            // Absolute-path imports (`/etc/passwd`) are NOT caught by the
            // externalise filter below (`[^./]` excludes a leading `/`), so
            // without this they fall through to esbuild's default resolver and,
            // with bundle:true, get their host-file contents inlined into the
            // flattened snapshot BEFORE the downstream source-text import guard
            // (compiler-core) can reject them. Reject them here too, for
            // containment. Skip the entry point: esbuild passes it as an
            // absolute path.
            b.onResolve({ filter: /^\// }, (args) =>
              args.kind === 'entry-point'
                ? undefined
                : {
                    errors: [
                      {
                        text: `Unsupported absolute import "${args.path}". Connector sources may only import from lobu, npm:... specifiers, published packages, or sibling relative files.`,
                      },
                    ],
                  }
            );
            // Everything that is not a relative path (bare packages, npm:,
            // lobu, node:) is left as-is for the real compile step.
            b.onResolve({ filter: /^[^./]/ }, (args) => ({ path: args.path, external: true }));
          },
        },
      ],
      write: true,
      minify: false,
      sourcemap: false,
    });
    return await readFile(outPath, 'utf-8');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

interface IsolateCompileOptions {
  /**
   * Max entries kept in the mtime-keyed LRU. Each entry is a self-contained
   * bundle — the connector's own code plus the SDK and every npm dep inlined,
   * since the isolate has no module loader to resolve anything at run time.
   * Cap default 8 keeps memory bounded; pass a smaller value in
   * memory-constrained environments.
   * @default 8
   */
  cacheMax?: number;
}

const DEFAULT_CACHE_MAX = 8;

const workerRequire = createRequire(import.meta.url);

function resolveSdkFile(specifier: string): string | null {
  try {
    return workerRequire.resolve(specifier);
  } catch {
    // subpath or monorepo workspace resolution
  }
  try {
    const root = workerRequire.resolve('@lobu/connector-sdk');
    const rootDir = root.includes('/dist/') ? root.split('/dist/')[0] : root.split('/src/')[0];
    const subpath = specifier === '@lobu/connector-sdk' ? '' : specifier.replace(/^@lobu\/connector-sdk\/?/, '');
    if (!subpath) return root;
    const candidates = [
      join(rootDir, 'dist', `${subpath}.js`),
      join(rootDir, 'dist', `${subpath}/index.js`),
      join(rootDir, 'src', `${subpath}.ts`),
      join(rootDir, 'src', `${subpath}/index.ts`),
    ];
    for (const cand of candidates) {
      if (existsSync(cand)) return cand;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * esbuild plugin that resolves the `lobu` alias and `@lobu/connector-sdk` so the
 * SDK is INLINED into the bundle. The isolate has no module loader, so nothing
 * may be externalized; the real package name falls through to esbuild's own
 * resolution.
 */
function createSdkInlinePlugin(): Plugin {
  return {
    name: 'sdk-inline',
    setup(b) {
      b.onResolve({ filter: SDK_SPECIFIER_RE }, (args) => {
        const specifier = normalizeSdkSpecifier(args.path);
        const resolved = resolveSdkFile(specifier);
        if (resolved) return { path: resolved };
        // `bundleConnectorForIsolateFromSource` writes its entry point into a
        // temp dir, which has no node_modules above it. Fall back to this
        // module's own directory so esbuild walks up into the workspace the
        // worker was installed from.
        const fromTmp = args.resolveDir.startsWith(tmpdir());
        return b.resolve(specifier, {
          resolveDir: fromTmp ? import.meta.dirname : args.resolveDir,
          kind: args.kind,
          importer: args.importer,
        });
      });
    },
  };
}

/**
 * esbuild plugin that keeps `EXTERNAL_RUNTIME_DEPS` (Playwright, sharp, jimp)
 * out of an isolate bundle. They are native or browser-launching packages that
 * only a Node process can host; leaving them as bare `require()` calls makes
 * the guest's fail-closed `require` name them at load instead of esbuild
 * choking on a `.node` binary mid-bundle.
 */
function createRuntimeDepsExternalPlugin(): Plugin {
  const roots = new Set<string>(EXTERNAL_RUNTIME_DEPS);
  return {
    name: 'runtime-deps-external',
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        const root = args.path.startsWith('@')
          ? args.path.split('/').slice(0, 2).join('/')
          : args.path.split('/')[0];
        return roots.has(root) ? { path: args.path, external: true } : undefined;
      });
    },
  };
}

export interface IsolateBundle {
  /** CJS bundle text; `module.exports.default` is the ConnectorRuntime class. */
  code: string;
  /** Node builtins the bundle still requires (`node:` prefix stripped), sorted. Empty means isolate-eligible. */
  builtins: string[];
}

function builtinsFromMetafile(metafile: Metafile): string[] {
  const found = new Set<string>();
  for (const meta of Object.values(metafile.inputs)) {
    for (const imp of meta.imports) {
      if (imp.external && isNodeBuiltinSpecifier(imp.path)) {
        const bare = imp.path.replace(/^node:/, '');
        if (!ISOLATE_PRELUDE_PROVIDED_BUILTINS.has(bare) && !ISOLATE_PRELUDE_PROVIDED_BUILTINS.has(imp.path)) {
          found.add(bare);
        }
      }
    }
  }
  return [...found].sort();
}

/**
 * Compile a connector source file into a self-contained CJS bundle for the
 * isolate lane (`ISOLATE_LANE_BUILD_OPTIONS`): the SDK and every pure-JS
 * dependency are inlined; `npm:` specifiers must resolve (`unresolved:
 * 'error'`) because the isolate cannot supply them at runtime. The metafile
 * reports which Node builtins survive as bare requires, which is how a bundle
 * is found to be unloadable before it ever reaches an isolate.
 */
export function createIsolateConnectorCompiler(options?: IsolateCompileOptions) {
  const cacheMax = options?.cacheMax ?? DEFAULT_CACHE_MAX;
  const cache = new Map<string, { mtimeMs: number; bundle: IsolateBundle }>();
  const plugins: Plugin[] = [
    createSdkInlinePlugin(),
    createRuntimeDepsExternalPlugin(),
    createNpmSpecifierPlugin({ unresolved: 'error' }),
  ];

  function touch(filePath: string, entry: { mtimeMs: number; bundle: IsolateBundle }): void {
    cache.delete(filePath);
    cache.set(filePath, entry);
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function bundleConnectorForIsolate(filePath: string, capture?: ReturnType<typeof createSourceCapture>): Promise<IsolateBundle> {
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
      const cached = cache.get(filePath);
      if (!capture && cached && cached.mtimeMs === mtimeMs) {
        touch(filePath, cached);
        return cached.bundle;
      }
    } catch {
      // stat failed — let the build surface the real error.
    }
    const result = await build({
      ...ISOLATE_LANE_BUILD_OPTIONS,
      entryPoints: [filePath],
      bundle: true,
      write: false,
      metafile: true,
      minify: false,
      ...(capture && RETAINED_SOURCE_BUILD_OPTIONS),
      sourcemap: false,
      logLevel: 'silent',
      plugins: capture ? [capture.plugin, ...plugins] : plugins,
    });
    const code = result.outputFiles[0]?.text ?? '';
    const bundle: IsolateBundle = {
      code,
      builtins: builtinsFromMetafile(result.metafile),
    };
    if (!capture && mtimeMs !== null) touch(filePath, { mtimeMs, bundle });
    return bundle;
  }

  /** Bundle for the isolate lane, or throw `IsolateLaneIneligibleError` naming the builtins. */
  async function compileConnectorForIsolateFromFile(filePath: string): Promise<string> {
    const bundle = await bundleConnectorForIsolate(filePath);
    if (bundle.builtins.length > 0) throw new IsolateLaneIneligibleError(bundle.builtins, filePath);
    return bundle.code;
  }

  async function compileConnectorArtifactFromFile(filePath: string, projectRoot: string) {
    const capture = createSourceCapture(filePath, projectRoot);
    const bundle = await bundleConnectorForIsolate(filePath, capture);
    if (bundle.builtins.length > 0) throw new IsolateLaneIneligibleError(bundle.builtins, filePath);
    return { compiledCode: bundle.code, ...capture.source() };
  }

  async function bundleConnectorForIsolateFromSource(sourceCode: string, retainSource = false): Promise<IsolateBundle & Partial<RetainedSource>> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'lobu-connector-isolate-'));
    const sourcePath = join(tmpDir, 'source.ts');
    try {
      await writeFile(sourcePath, sourceCode, 'utf-8');
      const capture = retainSource ? createSourceCapture(sourcePath, tmpDir) : undefined;
      const result = await build({
        ...ISOLATE_LANE_BUILD_OPTIONS,
        entryPoints: [sourcePath],
        bundle: true,
        write: false,
        metafile: true,
        minify: false,
        ...(capture && RETAINED_SOURCE_BUILD_OPTIONS),
        sourcemap: false,
        logLevel: 'silent',
        nodePaths: [resolve(process.cwd(), 'node_modules')],
        plugins: [...(capture ? [capture.plugin] : []), ...plugins],
      });
      const code = result.outputFiles[0]?.text ?? '';
      return {
        code,
        ...(capture?.source() ?? {}),
        builtins: builtinsFromMetafile(result.metafile),
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  async function compileConnectorArtifactFromSource(sourceCode: string) {
    const bundle = await bundleConnectorForIsolateFromSource(sourceCode, true);
    if (bundle.builtins.length > 0) throw new IsolateLaneIneligibleError(bundle.builtins, '<source>');
    return { compiledCode: bundle.code, sourceFiles: bundle.sourceFiles!, dependencies: bundle.dependencies! };
  }

  async function compileConnectorForIsolateFromSource(sourceCode: string): Promise<string> {
    const bundle = await bundleConnectorForIsolateFromSource(sourceCode);
    if (bundle.builtins.length > 0) throw new IsolateLaneIneligibleError(bundle.builtins, '<source>');
    return bundle.code;
  }

  return {
    bundleConnectorForIsolate,
    compileConnectorArtifactFromFile,
    compileConnectorArtifactFromSource,
    compileConnectorForIsolateFromFile,
    compileConnectorForIsolateFromSource,
  };
}
