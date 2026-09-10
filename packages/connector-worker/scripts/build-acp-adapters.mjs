// Ship protocol implementations, including the Claude SDK's JavaScript, without
// exposing their engine-bearing package manifests to the consumer's installer.
// Keep upstream packages pinned as build inputs; do not replace/stub their SDKs.
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Tests use a private output directory so they cannot overwrite a concurrent build.
const outputRoot = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist/daemon/acp-adapters');
const notices = new Map();
for (const adapter of ['claude', 'codex']) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`src/daemon/acp-adapters/${adapter}.ts`],
    outfile: join(outputRoot, `${adapter}.js`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    metafile: true,
    // Upstream prebundled CJS dependencies can require Node builtins from ESM.
    banner: { js: "import { createRequire as lobuCreateRequire } from 'node:module'; const require = lobuCreateRequire(import.meta.url);" },
    legalComments: 'inline',
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    if (/@(?:anthropic-ai\/claude-agent-sdk-[^/]+|openai\/codex)(?:\/|$)/.test(input)) {
      throw new Error(`ACP bundle unexpectedly includes an agent engine: ${input}`);
    }
    let directory = dirname(resolve(root, input));
    while (directory !== dirname(directory) && (!existsSync(join(directory, 'package.json')) ||
      !JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name)) {
      directory = dirname(directory);
    }
    if (!directory.includes('node_modules')) continue;
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const key = `${manifest.name}@${manifest.version}`;
    if (notices.has(key)) continue;
    const licenseFiles = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'NOTICE'];
    const license = licenseFiles.filter((file) => existsSync(join(directory, file)))
      .map((file) => readFileSync(join(directory, file), 'utf8')).join('\n');
    if (!license) throw new Error(`Missing license text for bundled dependency ${key}`);
    notices.set(key, `${key}\nLicense: ${manifest.license}\n${license}`);
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !isBuiltin(dependency.path)) {
        throw new Error(`ACP bundle has an unresolved runtime dependency: ${dependency.path}`);
      }
    }
  }
  console.log(`[acp] bundled ${adapter}: ${Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0)} bytes`);
}
writeFileSync(join(outputRoot, 'THIRD_PARTY_LICENSES.txt'),
  [...notices.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join('\n\n'));
