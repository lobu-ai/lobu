import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { createIsolateConnectorCompiler, flattenConnectorSourceFromFile } from '../compile/index.js';
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
