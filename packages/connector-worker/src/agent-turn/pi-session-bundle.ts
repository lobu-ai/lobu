import type { Plugin } from 'esbuild';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Import Pi's original session modules; adapt only host boundaries. Pi's disk
 * discovery, CLI rendering and local process tools are unavailable. Callers
 * supply a resource loader, tools, resolved model and an in-memory session.
 * Aliases are importer-scoped; new ambient dependencies still fail eligibility.
 */
export function piSessionBundle(): Plugin {
  const pi = dirname(realpathSync(fileURLToPath(import.meta.resolve('@mariozechner/pi-coding-agent'))));
  const ai = dirname(realpathSync(fileURLToPath(import.meta.resolve('@mariozechner/pi-ai'))));
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const namespace = 'lobu-pi-session';
  const unavailable = "function unavailable() { throw new Error('Pi host operation unavailable in the agent isolate'); }";
  const modules: Record<string, string> = {
    entry: [
      ['AgentSession', 'core/agent-session.js'],
      ['SessionManager', 'core/session-manager.js'],
      ['CURRENT_SESSION_VERSION', 'core/session-manager.js'],
      ['SettingsManager', 'core/settings-manager.js'],
      ['createExtensionRuntime', 'core/extensions/loader.js'],
      ['createSyntheticSourceInfo', 'core/source-info.js'],
      ['convertToLlm', 'core/messages.js'],
    ].map(([name, path]) => `export { ${name} } from ${JSON.stringify(join(pi, path!))};`).join('\n'),
    config: `${unavailable} export const CONFIG_DIR_NAME = '.pi', APP_NAME = 'Lobu', isBunBinary = false;
      export function getAgentDir() { return '/session'; }
      export { unavailable as getSessionsDir, unavailable as getReadmePath, unavailable as getDocsPath, unavailable as getExamplesPath, unavailable as getBinDir };`,
    fs: `${unavailable}
      export { existsSync, readFileSync } from ${JSON.stringify(join(here, `pi-session-fs.${extension}`))};
      export { unavailable as appendFileSync, unavailable as closeSync, unavailable as mkdirSync, unavailable as openSync, unavailable as readdirSync, unavailable as readSync, unavailable as statSync, unavailable as writeFileSync, unavailable as createWriteStream, unavailable as realpathSync, unavailable as accessSync };
      export const constants = { F_OK: 0, R_OK: 4, W_OK: 2 };`,
    'fs/promises': `${unavailable} export { unavailable as readdir, unavailable as readFile, unavailable as stat, unavailable as writeFile, unavailable as mkdir, unavailable as access };`,
    os: "export function homedir() { return '/workspace'; } export function tmpdir() { return '/tmp'; }",
    theme: `${unavailable} export const theme = new Proxy({}, { get: () => unavailable }); export { unavailable as getLanguageFromPath, unavailable as highlightCode };`,
    html: `${unavailable} export { unavailable as exportSessionToHtml, unavailable as createToolHtmlRenderer };`,
    tools: `${unavailable} export { unavailable as createAllToolDefinitions, unavailable as createLocalBashOperations };`,
    lock: `${unavailable} export default { lockSync: unavailable };`,
    tui: `${unavailable} export { unavailable as Text, unavailable as Container, unavailable as Box, unavailable as Spacer, unavailable as getCapabilities, unavailable as getImageDimensions, unavailable as imageFallback };`,
    empty: 'export {};',
    jiti: `${unavailable} export { unavailable as createJiti };`,
    exec: `${unavailable} export { unavailable as execCommand };`,
    ai: [
      "export { Type } from 'typebox';",
      ...['api-registry', 'models', 'session-resources', 'stream', 'utils/event-stream', 'utils/json-parse', 'utils/overflow', 'utils/validation', 'utils/typebox-helpers']
        .map((path) => `export * from ${JSON.stringify(join(ai, `${path}.js`))};`),
      `${unavailable} export { unavailable as resetApiProviders };`,
    ].join('\n'),
  };
  return {
    name: namespace,
    setup(build) {
      build.onResolve({ filter: /^@mariozechner\/pi-coding-agent$/ }, (args) =>
        /[/\\](agent-turn|plugin-toolkit)[/\\]/.test(args.importer) ? { path: 'entry', namespace } : undefined
      );
      build.onResolve({ filter: /^@mariozechner\/pi-ai$/ }, (args) =>
        args.importer.startsWith(pi) || /[/\\](pi-agent-core|agent-turn)[/\\]/.test(args.importer)
          ? { path: 'ai', namespace } : undefined
      );
      build.onResolve({ filter: /.*/ }, (args) => {
        // The turn registers its selected proxied provider; no ambient provider discovery.
        if (args.importer.startsWith(ai) && args.path.endsWith('providers/register-builtins.js')) return { path: 'empty', namespace };
        if (!args.importer.startsWith(`${pi}/`)) return undefined;
        const target = args.path.startsWith('.') ? resolve(dirname(args.importer), args.path) : args.path;
        const builtin = args.path.replace(/^node:/, '');
        let alias: string | undefined;
        if (target === join(pi, 'config.js')) alias = 'config';
        else if (target === join(pi, 'modes/interactive/theme/theme.js')) alias = 'theme';
        else if (target.startsWith(join(pi, 'core/export-html/'))) alias = 'html';
        else if (args.importer === join(pi, 'core/agent-session.js') && ['core/tools/index.js', 'core/tools/bash.js'].some((path) => target === join(pi, path))) alias = 'tools';
        else if (['fs', 'fs/promises', 'os'].includes(builtin)) alias = builtin;
        else if (builtin === 'path') return { path: require.resolve('pathe') };
        else if (args.path === 'yaml') return { path: join(dirname(require.resolve('yaml/package.json')), 'browser/index.js') };
        else if (args.path === 'proper-lockfile') alias = 'lock';
        else if (args.path === '@mariozechner/pi-tui') alias = 'tui';
        else if (args.importer === join(pi, 'core/extensions/loader.js')) {
          if (args.path === 'jiti/static') alias = 'jiti';
          else if (target === join(pi, 'core/exec.js')) alias = 'exec';
          else if (target === join(pi, 'index.js') || args.path === '@mariozechner/pi-ai/oauth') alias = 'empty';
        }
        return alias ? { path: alias, namespace } : undefined;
      });
      build.onLoad({ filter: /.*/, namespace }, (args) => ({ contents: modules[args.path], loader: 'js', resolveDir: pi }));
    },
  };
}
