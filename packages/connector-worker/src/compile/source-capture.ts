import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertSourcePath,
  SOURCE_MAX_BYTES,
  type RetainedSource,
  validateRetainedSource,
} from '@lobu/core/contracts/tools/source-files';
import type { Plugin } from 'esbuild';

function within(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function packageAt(file: string): { root: string; name: string; version: string } | null {
  let root = dirname(file);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
        return { root, name: pkg.name, version: pkg.version };
      }
    } catch { /* Continue to the package root. */ }
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

/** Exact installed versions for runtime-provided source imports. */
export function sourceDependencies(files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => {
    const pkg = packageAt(file);
    if (!pkg) throw new Error('Cannot determine source dependency version');
    return [pkg.name, pkg.version];
  }));
}

/** The onLoad bytes are both compiled and retained; no post-build file reread. */
export function createSourceCapture(entry: string, projectRoot: string): {
  plugin: Plugin;
  source: () => RetainedSource;
} {
  const root = realpathSync(projectRoot);
  const entrypoint = relative(root, realpathSync(entry)).split(sep).join('/');
  assertSourcePath(entrypoint);
  const files: Record<string, string> = Object.create(null);
  const dependencies: Record<string, string> = Object.create(null);
  const packageRoots = new Set<string>();
  const resolving = Symbol('source-capture-resolve');
  const isDependency = (file: string) => [...packageRoots].some((base) => within(base, file));
  const isProjectFile = (file: string) => within(root, file) && !isDependency(file);
  const source = (): RetainedSource => {
    const sourceFiles = { entrypoint, files: { ...files } };
    validateRetainedSource(files[entrypoint] ?? '', sourceFiles, dependencies);
    return { sourceFiles, dependencies: { ...dependencies } };
  };
  const plugin: Plugin = {
    name: 'retain-project-source',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.[resolving]) return;
        const found = await build.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          namespace: args.namespace,
          pluginData: { ...args.pluginData, [resolving]: true },
        });
        if (found.pluginData?.[resolving]) {
          found.pluginData = { ...found.pluginData };
          delete found.pluginData[resolving];
        }
        if (found.errors.length || found.external || found.namespace !== 'file') return found;
        const file = realpathSync(found.path);
        const fromProject = !args.importer || isProjectFile(args.importer);
        const bare = !isAbsolute(args.path) && !args.path.startsWith('.');
        if (bare) {
          const pkg = packageAt(file);
          if (pkg && pkg.root !== root) {
            packageRoots.add(pkg.root);
            if (fromProject) {
              if (dependencies[pkg.name] && dependencies[pkg.name] !== pkg.version) {
                throw new Error(`Conflicting source dependency versions: ${pkg.name}`);
              }
              dependencies[pkg.name] = pkg.version;
            }
          }
        } else if (fromProject && !within(root, file)) {
          throw new Error(`Source import leaves the project: ${args.path}`);
        }
        return found;
      });
      build.onLoad({ filter: /.*/, namespace: 'file' }, (args) => {
        const file = realpathSync(args.path);
        if (isDependency(file)) return;
        if (!within(root, file)) throw new Error('Source file leaves the project');
        const path = relative(root, file).split(sep).join('/');
        assertSourcePath(path);
        // Reuse these same bytes when the view's metadata pass loads the module.
        const contents = files[path] ?? readFileSync(file, 'utf8');
        files[path] = contents;
        if (Buffer.byteLength(JSON.stringify(files), 'utf8') > SOURCE_MAX_BYTES) {
          throw new Error(`Source files exceed ${SOURCE_MAX_BYTES} bytes`);
        }
        return { contents, loader: 'default', resolveDir: dirname(resolve(file)) };
      });
    },
  };
  return { plugin, source };
}
