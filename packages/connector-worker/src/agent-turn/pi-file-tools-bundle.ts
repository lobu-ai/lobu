import type { Plugin } from 'esbuild';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pi publishes the file factories through its Node/TUI barrel. Bundle their
 * original leaf modules, keeping its file and truncation algorithms unchanged. The
 * guest supplies filesystem operations; terminal rendering is never invoked.
 * Every alias is importer-scoped so an unrelated Node import still fails the
 * isolate eligibility gate, and a builtin Pi grows later is not aliased either:
 * it survives as a bare require and `assertIsolateEligible` rejects the guest
 * before it runs.
 */
export function piFileToolsBundle(): Plugin {
  const piRoot = dirname(realpathSync(fileURLToPath(import.meta.resolve('@mariozechner/pi-coding-agent'))));
  const toolsRoot = join(piRoot, 'core', 'tools');
  const namespace = 'lobu-pi-file-tools';
  const unavailable = "function unavailable() { throw new Error('Pi file tools must use workspace operations; terminal rendering and ambient filesystem access are unavailable'); }";
  const modules: Record<string, string> = {
    entry: [
      ...['read', 'write', 'edit', 'ls', 'find'].map((name) => `export { create${name[0].toUpperCase()}${name.slice(1)}Tool } from ${JSON.stringify(join(toolsRoot, `${name}.js`))};`),
      `export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateTail, truncateLine } from ${JSON.stringify(join(toolsRoot, 'truncate.js'))};`,
    ].join('\n'),
    fs: `${unavailable}\nexport const constants = { F_OK: 0, R_OK: 4, W_OK: 2 }; export { unavailable as accessSync, unavailable as existsSync, unavailable as readdirSync, unavailable as statSync }; export const realpathSync = Object.assign(unavailable, { native: unavailable });`,
    'fs/promises': `${unavailable}\nexport { unavailable as readFile, unavailable as writeFile, unavailable as mkdir, unavailable as access };`,
    os: "export function homedir() { return '/workspace'; }",
    tui: `${unavailable}\nexport { unavailable as Text, unavailable as Container, unavailable as Box, unavailable as Spacer, unavailable as getCapabilities, unavailable as getImageDimensions, unavailable as imageFallback };`,
    theme: `${unavailable}\nexport { unavailable as getLanguageFromPath, unavailable as highlightCode };`,
    keyHint: `${unavailable}\nexport { unavailable as keyHint, unavailable as keyText };`,
    renderDiff: `${unavailable}\nexport { unavailable as renderDiff };`,
    shell: `${unavailable}\nexport { unavailable as sanitizeBinaryOutput };`,
    config: `${unavailable}\nexport { unavailable as getReadmePath };`,
    imageResize: `${unavailable}\nexport { unavailable as formatDimensionNote, unavailable as resizeImage };`,
    mime: `${unavailable}\nexport { unavailable as detectSupportedImageMimeTypeFromFile };`,
    toolsManager: `${unavailable}\nexport { unavailable as ensureTool };`,
    readline: `${unavailable}\nexport { unavailable as createInterface };`,
    child_process: `${unavailable}\nexport { unavailable as spawn };`,
  };
  const aliases: Record<string, string> = {
    '@mariozechner/pi-tui': 'tui',
    '../../modes/interactive/theme/theme.js': 'theme',
    '../../modes/interactive/components/keybinding-hints.js': 'keyHint',
    '../../modes/interactive/components/diff.js': 'renderDiff',
    '../../utils/shell.js': 'shell',
    '../../config.js': 'config',
    '../../utils/image-resize.js': 'imageResize',
    '../../utils/mime.js': 'mime',
    '../../utils/tools-manager.js': 'toolsManager',
  };
  return {
    name: namespace,
    setup(build) {
      build.onResolve({ filter: /^@mariozechner\/pi-coding-agent$/ }, (args) =>
        /[/\\]agent-turn[/\\]workspace\.[jt]s$/.test(args.importer)
          ? { path: 'entry', namespace } : undefined
      );
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer.startsWith(`${toolsRoot}/`)) return undefined;
        const builtin = args.path.replace(/^node:/, '');
        if (builtin === 'path') return { path: createRequire(import.meta.url).resolve('pathe') };
        // Find's custom glob bypasses these defaults. No other importer gets a
        // process binding: a newly reachable Node dependency still fails closed.
        const findDefault = args.importer === join(toolsRoot, 'find.js') && ['readline', 'child_process'].includes(builtin);
        const alias = aliases[args.path] ?? (['fs', 'fs/promises', 'os'].includes(builtin) || findDefault ? builtin : undefined);
        return alias ? { path: alias, namespace } : undefined;
      });
      build.onLoad({ filter: /.*/, namespace }, (args) => ({ contents: modules[args.path], loader: 'js', resolveDir: piRoot }));
    },
  };
}
