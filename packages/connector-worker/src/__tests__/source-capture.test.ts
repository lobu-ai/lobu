import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createSourceCapture, createIsolateConnectorCompiler } from '../compile/index.js';

const roots: string[] = [];
function project(files: Record<string, string>) {
  const root = mkdtempSync(join(import.meta.dir, 'source-fixture-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function capture(root: string) {
  const retained = createSourceCapture(join(root, 'src/index.ts'), root);
  const artifact = await build({ entryPoints: [join(root, 'src/index.ts')], plugins: [retained.plugin], bundle: true, write: false, platform: 'node', logLevel: 'silent' });
  return { ...retained.source(), code: artifact.outputFiles[0].text };
}

describe('source retention', () => {
  it('captures consumed project bytes and exact direct dependency versions, excluding unrelated files and package implementation', async () => {
    const files = {
      'src/index.ts': `import { value } from '../lib/value'; import answer from 'fixture-package'; console.log(value, answer);`,
      'lib/value.ts': '// Keep this comment\nexport const value = 7;',
      'node_modules/fixture-package/package.json': '{"name":"fixture-package","version":"1.2.3","main":"index.js"}',
      'node_modules/fixture-package/index.js': 'module.exports = 42;',
      '.env': 'PRIVATE=do-not-retain',
      'unused.ts': 'export const unused = true;',
    };
    const root = project(files);
    const result = await capture(root);
    expect(result.sourceFiles).toEqual({ entrypoint: 'src/index.ts', files: { 'src/index.ts': files['src/index.ts'], 'lib/value.ts': files['lib/value.ts'] } });
    expect(result.dependencies).toEqual({ 'fixture-package': '1.2.3' });
    expect(JSON.stringify(result.sourceFiles)).not.toContain(root);
    writeFileSync(join(root, 'lib/value.ts'), '// Changed comment\nexport const value = 7;');
    expect((await capture(root)).sourceFiles.files['lib/value.ts']).toStartWith('// Changed comment');
  });

  it('rejects out-of-project imports, including symlinks, and sensitive project files', async () => {
    const outside = project({ 'private.ts': 'export default "secret";' });
    const root = project({ 'src/index.ts': `import value from './linked'; console.log(value);` });
    symlinkSync(join(outside, 'private.ts'), join(root, 'src/linked.ts'));
    await expect(capture(root)).rejects.toThrow('leaves the project');
    writeFileSync(join(root, '.env.ts'), 'export default "secret";');
    writeFileSync(join(root, 'src/index.ts'), `import value from '../.env.ts'; console.log(value);`);
    await expect(capture(root)).rejects.toThrow('portable project file');
  });

  it('rejects oversized source before publishing an artifact', async () => {
    const root = project({ 'src/index.ts': `//${'x'.repeat(1_000_001)}\nexport default 1;` });
    await expect(capture(root)).rejects.toThrow('exceed');
  });

  it('emits identical portable artifacts from different build directories, including CommonJS modules', async () => {
    const files = {
      'src/index.ts': `import value from './helper.cjs'; export default value;`,
      'src/helper.cjs': 'module.exports = { value: 42 };',
    };
    const firstRoot = project(files);
    const secondRoot = project(files);
    const compiler = createIsolateConnectorCompiler();
    const first = await compiler.compileConnectorArtifactFromFile(join(firstRoot, 'src/index.ts'), firstRoot);
    const second = await compiler.compileConnectorArtifactFromFile(join(secondRoot, 'src/index.ts'), secondRoot);
    expect(first.compiledCode).not.toContain('source-fixture-');
    expect(first.compiledCode).toBe(second.compiledCode);
    expect(first.sourceFiles).toEqual(second.sourceFiles);
  });

  it('captures the SDK dependency for both CLI file and MCP source compiles', async () => {
    const source = `import { ConnectorRuntime } from '@lobu/connector-sdk'; export default class Probe extends ConnectorRuntime { definition = { key: 'zz.sourceprobe', name: 'Probe', version: '1.0.0' }; }`;
    const root = project({ 'src/index.ts': source });
    const compiler = createIsolateConnectorCompiler();
    const file = await compiler.compileConnectorArtifactFromFile(join(root, 'src/index.ts'), root);
    const inline = await compiler.compileConnectorArtifactFromSource(source);
    const sdk = JSON.parse(readFileSync(join(import.meta.dir, '../../../connector-sdk/package.json'), 'utf8'));
    expect(file.sourceFiles.files).toEqual({ 'src/index.ts': source });
    expect(inline.sourceFiles.files).toEqual({ 'source.ts': source });
    expect(file.dependencies).toEqual({ '@lobu/connector-sdk': sdk.version });
    expect(inline.dependencies).toEqual(file.dependencies);
    expect(file.compiledCode).toContain('module.exports');
  });
});
