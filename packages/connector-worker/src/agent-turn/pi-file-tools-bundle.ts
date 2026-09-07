import type { Plugin } from 'esbuild';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pi publishes the file factories through its Node/TUI barrel. Bundle their
 * original leaf modules, keeping its edit and mutation algorithms unchanged. The
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
    entry: `export { createWriteTool } from ${JSON.stringify(join(toolsRoot, 'write.js'))};\nexport { createEditTool } from ${JSON.stringify(join(toolsRoot, 'edit.js'))};`,
    fs: `${unavailable}\nexport const constants = { F_OK: 0, R_OK: 4, W_OK: 2 }; export const accessSync = unavailable; export const realpathSync = Object.assign(unavailable, { native: unavailable });`,
    'fs/promises': `${unavailable}\nexport { unavailable as readFile, unavailable as writeFile, unavailable as mkdir, unavailable as access };`,
    os: "export function homedir() { return '/workspace'; }",
    tui: `${unavailable}\nexport { unavailable as Text, unavailable as Container, unavailable as Box, unavailable as Spacer, unavailable as getCapabilities, unavailable as getImageDimensions, unavailable as imageFallback };`,
    theme: `${unavailable}\nexport { unavailable as getLanguageFromPath, unavailable as highlightCode };`,
    keyHint: `${unavailable}\nexport { unavailable as keyHint };`,
    renderDiff: `${unavailable}\nexport { unavailable as renderDiff };`,
    shell: `${unavailable}\nexport { unavailable as sanitizeBinaryOutput };`,
  };
  const aliases: Record<string, string> = {
    '@mariozechner/pi-tui': 'tui',
    '../../modes/interactive/theme/theme.js': 'theme',
    '../../modes/interactive/components/keybinding-hints.js': 'keyHint',
    '../../modes/interactive/components/diff.js': 'renderDiff',
    '../../utils/shell.js': 'shell',
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
        const alias = aliases[args.path] ?? (['fs', 'fs/promises', 'os'].includes(builtin) ? builtin : undefined);
        return alias ? { path: alias, namespace } : undefined;
      });
      build.onLoad({ filter: /.*/, namespace }, (args) => ({ contents: modules[args.path], loader: 'js', resolveDir: piRoot }));
    },
  };
}
