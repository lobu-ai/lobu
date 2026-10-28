/**
 * Shared compiler infrastructure for connector compilation.
 *
 * Two-step process:
 * 1. esbuild compilation (safe, pure text transform — no code execution):
 *    - Validates imports and resolves npm: specifiers via esbuild onResolve
 *      plugins (AST-level — string/comment contents are never misread as
 *      imports, #2043), bundles via esbuild
 *    - Produces compiled_code + compiled_code_hash (SHA-256)
 *
 * 2. Metadata extraction (isolated subprocess):
 *    - Writes compiled JS to temp file
 *    - Forks subprocess with custom runner code
 *    - Returns metadata to the caller
 */

import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import {
  RUNTIME_PROVIDED_PACKAGES,
  SDK_SPECIFIER_RE,
  createNpmSpecifierPlugin,
  normalizeSdkSpecifier,
} from '@lobu/connector-worker/compile';
import { type BuildOptions, type Plugin, build } from 'esbuild';
import logger from './logger';
import { getErrorMessage } from "@lobu/core";

const require = createRequire(import.meta.url);

const SDK_PACKAGE = '@lobu/connector-sdk';

/**
 * esbuild options for code that runs inside a V8 isolate, owned by the
 * connector worker's compile pipeline so the gateway sandbox
 * (`sandbox/run-script.ts`) and the connector isolate lane share one config.
 */
export { ISOLATE_LANE_BUILD_OPTIONS } from '@lobu/connector-worker/compile';

/** The SDK's package root + its parsed `exports` map, read once. */
let sdkPackageCache: { root: string; exports: Record<string, unknown> } | null | undefined;

function sdkPackage(): { root: string; exports: Record<string, unknown> } | null {
  if (sdkPackageCache !== undefined) return sdkPackageCache;
  const root = resolvePackageRoot(SDK_PACKAGE);
  if (!root) {
    sdkPackageCache = null;
    return null;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      exports?: Record<string, unknown>;
    };
    sdkPackageCache = { root, exports: pkg.exports ?? {} };
  } catch {
    sdkPackageCache = null;
  }
  return sdkPackageCache;
}

/** Walk a conditional-exports value down to its file target. */
function exportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const conditions = value as Record<string, unknown>;
  for (const key of ['import', 'default', 'require', 'node']) {
    if (key in conditions) {
      const found = exportTarget(conditions[key]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve `@lobu/connector-sdk`, root or subpath, to a file on disk.
 *
 * `require.resolve` handles the root everywhere. It CANNOT see subpaths: the
 * SDK is `"type": "module"` and its subpath `exports` declare only an `import`
 * condition, which the CJS resolver skips. `import.meta.resolve` would see them
 * but is not dependable here — under Vitest's module transform it throws even
 * for the root, which silently broke every connector install. So subpaths are
 * resolved by reading the package's own `exports` map off disk: deterministic,
 * and identical under Bun, Node, and Vitest.
 */
function resolveSdkFile(specifier: string): string | null {
  try {
    return require.resolve(specifier);
  } catch {
    // ESM-only subpath — fall through to the exports map.
  }
  const sdk = sdkPackage();
  if (!sdk) return null;
  const subpath =
    specifier === SDK_PACKAGE ? '.' : `.${specifier.slice(SDK_PACKAGE.length)}`;
  const target = exportTarget(sdk.exports[subpath]);
  return target ? join(sdk.root, target) : null;
}

/**
 * Resolve `lobu` / `@lobu/connector-sdk` — root OR subpath — to a real file in
 * the server's own installation, so source compiled in a temp dir outside the
 * workspace can still find the SDK.
 *
 * Shares {@link SDK_SPECIFIER_RE} with the worker's externalizing compiler so
 * both agree on what an SDK import looks like.
 *
 * This is an onResolve plugin rather than an esbuild `alias` because `alias`
 * substitutes by PREFIX: aliasing `@lobu/connector-sdk` to its entry FILE turned
 * `@lobu/connector-sdk/ip-reachability` into `.../dist/index.js/ip-reachability`.
 */
function createSdkResolvePlugin(): Plugin {
  return {
    name: 'sdk-resolve',
    setup(b) {
      b.onResolve({ filter: SDK_SPECIFIER_RE }, (args) => {
        const specifier = normalizeSdkSpecifier(args.path);
        const resolved = resolveSdkFile(specifier);
        if (resolved) return { path: resolved };
        return {
          errors: [
            {
              text: `Cannot resolve "${args.path}" from the server's ${SDK_PACKAGE} installation. If this is a new SDK subpath, add it to the package's "exports" map.`,
            },
          ],
        };
      });
    },
  };
}

export interface CompileResult {
  compiledCode: string;
  compiledCodeHash: string;
}

export interface SourceCompileDiagnostic {
  location?: { file?: string; line?: number; column?: number } | null;
}

/** A compiler failure tied to a location in the caller's source text. */
export class SourceCompileError extends Error {
  readonly name = 'SourceCompileError';

  constructor(
    message: string,
    readonly diagnostics: SourceCompileDiagnostic[],
    cause: Error
  ) {
    super(message, { cause });
  }
}

interface CompileConfig {
  /** Prefix for temp directory names, e.g. '.connector-compile-' */
  tmpPrefix: string;
  /** Label for log/error messages, e.g. 'ConnectorCompiler' */
  label: string;
  /** esbuild overrides beyond the shared defaults */
  buildOptions: Partial<BuildOptions>;
}

interface ExtractConfig {
  /** Prefix for temp directory names, e.g. '.connector-meta-' */
  tmpPrefix: string;
  /** JS code that runs in the subprocess to extract metadata (see runners in each compiler) */
  runnerCode: string;
}

/**
 * Reject imports that can never resolve for a single-file source compiled from
 * text (DB-stored connector source, run_sdk scripts, reaction scripts):
 * relative paths, project aliases (`@/`), and absolute filesystem paths.
 *
 * Registered as an esbuild onResolve hook, so it fires ONLY for real module
 * declarations parsed from the source AST — dependency-like text inside string
 * literals, template literals, or comments is data, never an import (#2043).
 * Scoped to declarations made by the entry source itself: bundled npm
 * dependencies legitimately use relative imports internally and fall through
 * to esbuild's default resolver.
 *
 * Absolute paths are rejected for the same single-file contract plus
 * containment: a source compiled server-side must not be able to bundle
 * arbitrary files from the gateway's filesystem into its artifact.
 */
function createImportGuardPlugin(entryPath: string, label: string): Plugin {
  return {
    name: 'import-guard',
    setup(b) {
      b.onResolve({ filter: /^(\.\.?(\/|$)|@\/|\/)/ }, (args) => {
        if (args.kind === 'entry-point') return undefined;
        if (args.importer !== entryPath) return undefined;
        return {
          errors: [
            {
              text: `Unsupported import "${args.path}". ${label} sources must be single-file and may only import from lobu, npm:... specifiers, or published packages.`,
            },
          ],
        };
      });
    },
  };
}

export function computeCodeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Step 1: Compile TypeScript source to JavaScript.
 * Pure text transform via esbuild — no code execution.
 */
export async function compileSource(
  sourceCode: string,
  config: CompileConfig
): Promise<CompileResult> {
  const tmpDir = await mkdtemp(join(process.cwd(), config.tmpPrefix));

  try {
    const inputPath = join(tmpDir, 'source.ts');
    const outputPath = join(tmpDir, 'source.mjs');

    await writeFile(inputPath, sourceCode, 'utf-8');

    const { plugins: overridePlugins = [], ...buildOverrides } = config.buildOptions;
    const buildOptions: BuildOptions = {
      entryPoints: [inputPath],
      outfile: outputPath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: true,
      minify: false,
      sourcemap: false,
      ...buildOverrides,
      plugins: [
        createImportGuardPlugin(inputPath, config.label),
        createSdkResolvePlugin(),
        // Source-text artifacts must be self-contained: an npm: package that
        // isn't installed in this image is a hard compile error, never a
        // silent externalisation the runtime can't satisfy.
        createNpmSpecifierPlugin({ unresolved: 'error' }),
        ...overridePlugins,
      ],
    };

    try {
      try {
        await build(buildOptions);
      } catch (error) {
        const message = getErrorMessage(error);
        if (message.includes('The service is no longer running')) {
          logger.warn(`[${config.label}] esbuild service stopped unexpectedly; retrying once...`);
          await build(buildOptions);
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        const message =
          `${config.label} compilation failed: ${error.message}. ` +
          'If this source imports local project modules, replace them with lobu or npm: imports.';
        const buildErrors = (error as { errors?: unknown }).errors;
        const sourceDiagnostics = Array.isArray(buildErrors)
          ? buildErrors.filter(
              (diagnostic): diagnostic is SourceCompileDiagnostic =>
                diagnostic !== null &&
                typeof diagnostic === 'object' &&
                typeof (diagnostic as SourceCompileDiagnostic).location?.file === 'string' &&
                resolve(
                  process.cwd(),
                  (diagnostic as SourceCompileDiagnostic).location?.file ?? ''
                ) === inputPath
            )
          : [];
        if (sourceDiagnostics.length > 0) {
          throw new SourceCompileError(message, sourceDiagnostics, error);
        }
        throw new Error(message, { cause: error });
      }
      throw error;
    }

    const compiledCode = await readFile(outputPath, 'utf-8');
    const compiledCodeHash = computeCodeHash(compiledCode);

    return { compiledCode, compiledCodeHash };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Resolve the on-disk package root for a bare specifier, as THIS process (the
 * server, which always has the SDK installed) resolves it. Walks up from the
 * resolved entry file and accepts a directory when its package.json declares
 * the package's name (covers workspace layouts where require.resolve
 * realpath's through a symlink to e.g. `packages/connector-sdk`, outside any
 * node_modules) or when it sits directly under a node_modules dir (covers
 * npm-aliased installs like `playwright` → patchright, whose package.json
 * name differs from the specifier).
 */
function resolvePackageRoot(pkgName: string): string | null {
  let entry: string;
  try {
    entry = require.resolve(pkgName);
  } catch {
    return null;
  }
  let dir = dirname(entry);
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      const parent = dirname(dir);
      const underNodeModules =
        basename(parent) === 'node_modules' ||
        (basename(parent).startsWith('@') && basename(dirname(parent)) === 'node_modules');
      if (underNodeModules) return dir;
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
          name?: string;
        };
        if (pkg.name === pkgName) return dir;
      } catch {
        // unreadable/invalid package.json — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const packageRootCache = new Map<string, string | null>();

/**
 * Stage a `node_modules` inside the extraction temp dir with symlinks to the
 * runtime-provided packages, resolved from the server's own installation.
 *
 * Why: the temp dir lives under `process.cwd()`, which for an embedded
 * `lobu run` is the USER'S project directory. The compiled bundle imports
 * `@lobu/connector-sdk` as a bare (externalized) specifier, so Node resolves
 * it by walking up from the temp dir — which only worked when the server's
 * installation happened to be an ancestor. A fresh `lobu init` project has no
 * node_modules, so the first bundled-connector install failed with
 * `Cannot find package '@lobu/connector-sdk'` (#1181). Symlinks (not
 * NODE_PATH) because ESM resolution ignores NODE_PATH entirely. Packages that
 * don't resolve from the server are skipped — the subprocess then falls back
 * to the ancestor walk exactly as before.
 */
async function stageRuntimeProvidedPackages(tmpDir: string): Promise<void> {
  for (const pkgName of RUNTIME_PROVIDED_PACKAGES) {
    if (!packageRootCache.has(pkgName)) {
      packageRootCache.set(pkgName, resolvePackageRoot(pkgName));
    }
    const root = packageRootCache.get(pkgName);
    if (!root) continue;
    const linkPath = join(tmpDir, 'node_modules', pkgName);
    try {
      await mkdir(dirname(linkPath), { recursive: true });
      // 'junction' only matters on Windows (ignored elsewhere); junctions
      // don't need elevated privileges there.
      await symlink(root, linkPath, 'junction');
    } catch (err) {
      logger.warn({ pkgName, err }, 'Failed to stage runtime-provided package for extraction');
    }
  }
}

/**
 * Map a raw extraction failure to an actionable message. Safety net for
 * environments where staging didn't cover resolution: a missing connector SDK
 * means the project's npm deps were never installed, so say exactly that.
 */
function formatMetadataExtractionError(rawError: string): string {
  const base = `Metadata extraction failed: ${rawError}`;
  if (/Cannot find (?:package|module) '(?:@lobu\/connector-sdk|lobu)'/.test(rawError)) {
    return (
      `${base}. The connector SDK could not be resolved from the project — ` +
      'run `npm install` (or `bun install`) in the project directory to install ' +
      '@lobu/connector-sdk, then retry.'
    );
  }
  return base;
}

/**
 * Step 2: Extract metadata from compiled code via subprocess.
 * Spawns a child process to safely instantiate the class and read metadata.
 */
export async function extractMetadata<TMetadata>(
  compiledCode: string,
  config: ExtractConfig
): Promise<TMetadata> {
  const tmpDir = await mkdtemp(join(process.cwd(), config.tmpPrefix));

  try {
    await stageRuntimeProvidedPackages(tmpDir);
    const isEsm = compiledCode.startsWith('import ') || compiledCode.includes('\nimport ');
    const codePath = join(tmpDir, isEsm ? 'source.mjs' : 'source.cjs');
    const runnerPath = join(tmpDir, 'runner.mjs');

    await writeFile(codePath, compiledCode, 'utf-8');
    await writeFile(runnerPath, config.runnerCode, 'utf-8');

    const metadata = await new Promise<TMetadata>((resolve, reject) => {
      const child = fork(runnerPath, [codePath], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--max-old-space-size=256'],
        timeout: 30000,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'production',
        },
      });

      let resolved = false;
      let stderrOutput = '';
      let deadline: ReturnType<typeof setTimeout> | null = null;

      const settle = (fn: () => void): void => {
        if (resolved) return;
        resolved = true;
        if (deadline) {
          clearTimeout(deadline);
          deadline = null;
        }
        fn();
      };

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrOutput += chunk.toString();
      });

      child.on('message', (msg: any) => {
        settle(() => {
          if (msg.success) {
            resolve(msg.metadata);
          } else {
            reject(new Error(formatMetadataExtractionError(String(msg.error))));
          }
        });
      });

      child.on('error', (err) => {
        settle(() => {
          reject(new Error(`Metadata extraction subprocess error: ${err.message}`));
        });
      });

      child.on('exit', (code) => {
        settle(() => {
          const stderr = stderrOutput.trim();
          reject(
            new Error(
              stderr
                ? formatMetadataExtractionError(`subprocess exited with code ${code}: ${stderr}`)
                : `Metadata extraction subprocess exited with code ${code}`
            )
          );
        });
      });

      deadline = setTimeout(() => {
        settle(() => {
          child.kill('SIGKILL');
          reject(new Error('Metadata extraction timed out after 30s'));
        });
      }, 30000);
    });

    return metadata;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
