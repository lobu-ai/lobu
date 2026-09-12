import { createHash } from 'node:crypto';

/**
 * Packages that cannot run inside a connector isolate. The compiler leaves
 * these imports unresolved so the guest fails closed with the package name;
 * externalization is not a promise to install or provide them at runtime.
 */
export const EXTERNAL_RUNTIME_DEPS = ['playwright', 'sharp', 'jimp'] as const;

/** The compiler needs the SDK source to inline it into every connector. */
const CONNECTOR_SDK_RUNTIME_DEP = '@lobu/connector-sdk' as const;
export const RUNTIME_PROVIDED_PACKAGES = [CONNECTOR_SDK_RUNTIME_DEP] as const;

/**
 * Bump when the compile pipeline changes in a way that makes previously
 * compiled artifacts unsafe to execute (esbuild banner/target/plugin
 * semantics). Changes to EXTERNAL_RUNTIME_DEPS are picked up automatically
 * via the fingerprint below.
 *
 * 2: the isolate build became the only build. A pipeline-1 artifact is either
 * SDK-externalized ESM with a `createRequire` banner or a bundle that still
 * requires a Node builtin — both shaped for the forked child that used to run
 * them. The isolate has no module loader, so `resolveConnectorCode` returning
 * one verbatim (which it does whenever the stored fingerprint matches) hands
 * the guest imports it cannot resolve. Every prod artifact carrying the
 * pipeline-1 fingerprint was in exactly that state, so the fingerprint has to
 * move for them to be recompiled from their stored source.
 */
const COMPILE_PIPELINE_VERSION = 2;

/** Fingerprint of the compile configuration that produced an artifact. */
export function computeCompileConfigHash(external: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ pipeline: COMPILE_PIPELINE_VERSION, external }))
    .digest('hex');
}

/**
 * Fingerprint of the CURRENT compile configuration. Stored on
 * `connector_versions.compile_config_hash` next to every persisted
 * `compiled_code`; an artifact whose stored fingerprint doesn't match is
 * stale (e.g. compiled when `pino` was still externalized) and must be
 * recompiled instead of executed.
 */
export const COMPILE_CONFIG_HASH = computeCompileConfigHash(EXTERNAL_RUNTIME_DEPS);

/**
 * Verify that every external runtime dep is resolvable from the current
 * process. Call this once at startup of any service that executes compiled
 * connectors. Throws (so the process crashes) instead of letting individual
 * feed runs fail with `Missing npm dependency: X`.
 */
export function assertExternalDepsResolvable(
  resolve: (specifier: string) => void
): void {
  const missing: string[] = [];
  for (const dep of RUNTIME_PROVIDED_PACKAGES) {
    try {
      resolve(dep);
    } catch {
      missing.push(dep);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Connector runtime is missing required npm packages: ${missing.join(', ')}. ` +
        `These are declared in RUNTIME_PROVIDED_PACKAGES (packages/connector-worker/src/runtime-deps.ts) ` +
        `and must be installed in every runtime that executes compiled connectors. ` +
        `Add them to packages/connector-worker/package.json and rebuild the runtime image.`
    );
  }
}
