import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createIsolateConnectorCompiler, findBundledConnectorFile, flattenConnectorSourceFromFile } from '../compile/index.js';
import { IsolateLaneIneligibleError } from '../isolate/eligibility.js';

const MINIMAL_CONNECTOR = `
import { ConnectorRuntime } from '@lobu/connector-sdk';

export default class TestConnector extends ConnectorRuntime {
  definition = {
    key: 'test_connector',
    name: 'Test Connector',
    version: '1.0.0',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
  };
}
`;

const INELIGIBLE_CONNECTOR = `
import { ConnectorRuntime } from '@lobu/connector-sdk';
import * as fs from 'node:fs';

export default class IneligibleConnector extends ConnectorRuntime {
  definition = {
    key: 'ineligible',
    name: 'Ineligible',
    version: '1.0.0',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
  };
}
`;

describe('createIsolateConnectorCompiler from source', () => {
  it('resolves word separators in both layouts while rejecting path-shaped keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'connector-resolution-'));
    const connectors = join(root, 'connectors');
    await mkdir(join(connectors, 'test-inbox'), { recursive: true });
    await writeFile(join(connectors, 'test-inbox.ts'), '');
    await writeFile(join(connectors, 'test-inbox', 'send_message.ts'), '');
    await writeFile(join(connectors, 'test-inbox_send_message.ts'), '');
    await writeFile(join(root, 'outside.ts'), '');
    try {
      expect(findBundledConnectorFile('test-inbox', [connectors])).toBe(join(connectors, 'test-inbox.ts'));
      expect(findBundledConnectorFile('test-inbox.send_message', [connectors])).toBe(join(connectors, 'test-inbox', 'send_message.ts'));
      expect(findBundledConnectorFile('test-inbox_send_message', [connectors])).toBe(join(connectors, 'test-inbox_send_message.ts'));
      for (const key of ['../outside', 'test-inbox/../test-inbox', '..\\outside', '%2e%2e.outside', join(root, 'outside'), 'test--inbox', '-test-inbox', 'test-inbox.']) {
        expect(findBundledConnectorFile(key, [connectors])).toBeNull();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compiles the PostgreSQL socket dependency through file and retained-source entrypoints', async () => {
    const compiler = createIsolateConnectorCompiler();
    const entry = resolve(import.meta.dirname, '../../../connectors/src/postgres.ts');
    const root = resolve(import.meta.dirname, '../../../connectors');
    const source = await flattenConnectorSourceFromFile(entry);
    const bundles = [
      await compiler.compileConnectorForIsolateFromFile(entry),
      (await compiler.compileConnectorArtifactFromFile(entry, root)).compiledCode,
      (await compiler.compileConnectorArtifactFromSource(source)).compiledCode,
    ];
    for (const code of bundles) {
      const module = { exports: {} as { default: new () => { definition: { feeds: { query: { read: unknown } } } } } };
      // The production prelude provides this socket module through the host bridge.
      // Loading a connector must not attempt any network connection.
      const runtimeRequire = (name: string) => name === 'cloudflare:sockets'
        ? { connect: () => { throw new Error('Unexpected connection during module load'); } }
        : require(name);
      new Function('module', 'exports', 'require', code)(module, module.exports, runtimeRequire);
      expect(typeof new module.exports.default().definition.feeds.query.read).toBe('function');
    }
  });

  it('bundles pure-JS connector source into CJS for isolate lane', async () => {
    const compiler = createIsolateConnectorCompiler();
    const code = await compiler.compileConnectorForIsolateFromSource(MINIMAL_CONNECTOR);
    expect(code).toContain('TestConnector');
    // Verifies CJS output
    expect(code).toContain('module.exports');
    // Does not have top-level import
    expect(code).not.toMatch(/^import\s+/m);
  });

  it('rejects source that imports Node builtins with IsolateLaneIneligibleError', async () => {
    const compiler = createIsolateConnectorCompiler();
    let error: any;
    try {
      await compiler.compileConnectorForIsolateFromSource(INELIGIBLE_CONNECTOR);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(IsolateLaneIneligibleError);
    expect(error.builtins).toEqual(['fs']);
  });
});
