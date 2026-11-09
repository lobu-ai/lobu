/**
 * Load `isolated-vm` for the worker's Node runtime.
 *
 * The native addon is ABI-bound to the Node major: Lobu ships one
 * `isolated-vm@7` build and runs it on Node 26 only. Bun cannot dlopen a V8
 * addon, and Node majors other than 26 have no matching ABI build, so both
 * return `null` and the executor selector fails an `isolate` run instead of
 * forking a child for it. Mirrors
 * `packages/server/src/sandbox/run-script.ts`.
 */

import type { IsolatedVm } from './ivm-types.js';

interface IsolatedVmModuleShape {
  default?: unknown;
  'module.exports'?: unknown;
}

function unwrapIsolatedVm(mod: unknown): IsolatedVm {
  const m = mod as IsolatedVmModuleShape;
  return (m.default ?? m['module.exports'] ?? m) as IsolatedVm;
}

function isBun(): boolean {
  return typeof (process.versions as { bun?: string }).bun === 'string';
}

function nodeMajor(): number {
  return Number(process.versions.node?.split('.')[0] ?? 0);
}

/** The only Node major this repo's isolated-vm build supports. */
const SUPPORTED_NODE_MAJOR = 26;

/**
 * Why this host cannot run an isolate, or `null` when it is the supported
 * Node 26 line. A load failure on an eligible host (native build skipped on
 * this platform) is reported by `loadIsolatedVm()` returning null; this only
 * classifies the runtime.
 */
export function isolatedVmUnavailableReason(): string | null {
  if (isBun()) {
    return `isolated-vm is a V8 native addon and cannot load under Bun ${process.versions.bun}`;
  }
  const major = nodeMajor();
  if (!Number.isFinite(major) || major === 0) return 'could not determine the Node major version';
  if (major !== SUPPORTED_NODE_MAJOR) {
    return `isolated-vm requires Node ${SUPPORTED_NODE_MAJOR}.x; this host runs Node ${process.versions.node}`;
  }
  return null;
}

/** The one optionalDependency that carries the Node 26 isolated-vm build. */
const IVM_MODULE = 'isolated-vm';

/**
 * The optionalDependency that carries this Node line's isolated-vm build, or
 * `null` when the runtime has none (`isolatedVmUnavailableReason()` says why).
 * Shared by the loader and the self-check so both name the same package.
 */
export function isolatedVmSpecifier(): string | null {
  return isolatedVmUnavailableReason() === null ? IVM_MODULE : null;
}

let cached: Promise<IsolatedVm | null> | null = null;

/**
 * Resolve the isolated-vm module for this Node line, or `null` when it cannot
 * load. Memoized per process: the addon is loaded once and shared by every
 * isolate the worker creates.
 */
export function loadIsolatedVm(): Promise<IsolatedVm | null> {
  if (!cached) cached = loadIsolatedVmUncached();
  return cached;
}

async function loadIsolatedVmUncached(): Promise<IsolatedVm | null> {
  const specifier = isolatedVmSpecifier();
  if (!specifier) return null;
  try {
    // Dynamic on purpose: the addon is an optionalDependency, and a static
    // import of a native addon absent on this host would fail this module
    // (and every static importer of the executor) at load instead of failing
    // closed for the isolate lane alone. The specifier is a variable so the
    // worker typechecks with the package absent; `unwrapIsolatedVm` narrows
    // to the structural `IsolatedVm`.
    return unwrapIsolatedVm(await import(specifier));
  } catch {
    return null;
  }
}
