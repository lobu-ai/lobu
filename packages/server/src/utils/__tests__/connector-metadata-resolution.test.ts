/**
 * Reproducer for #1181: the gateway's bundled-connector install path compiles
 * a connector, then extracts metadata in a subprocess from a temp dir under
 * `process.cwd()`. When the server runs inside a user project with no
 * node_modules (fresh `lobu init` + `lobu run`), a bare import left in the
 * bundle used to fail with `Cannot find package …` because resolution only
 * walked UP from the temp dir. `extractMetadata` now stages a node_modules
 * inside the temp dir, symlinking the runtime-provided packages as the server
 * resolves them — so extraction succeeds regardless of the project's
 * node_modules. The isolate bundle inlines the SDK, but still externalises
 * `EXTERNAL_RUNTIME_DEPS`, so the staging remains load-bearing.
 *
 * Vitest (not the bun unit lane) on purpose: the extraction subprocess is a
 * `fork()` of the test runtime, and under bun the child would auto-install
 * the missing SDK from npm, silently masking the regression. Prod and the
 * embedded `lobu run` both run under node, which vitest matches.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolateConnectorCompiler } from '@lobu/connector-worker/compile';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { formatMetadataExtractionError } from '../compiler-core';
import {
  extractConnectorMetadata,
  NO_CONNECTOR_RUNTIME_ERROR,
} from '../connector-compiler';
import { resolveBundledAgentToolingMetadata } from '../connector-catalog';

const CONNECTOR_SOURCE = `
import { ConnectorRuntime, type RuntimeConnectorDefinition } from '@lobu/connector-sdk';

export default class MetaResolutionProbeConnector extends ConnectorRuntime {
  definition: RuntimeConnectorDefinition = {
    key: 'meta_resolution_probe',
    name: 'Metadata Resolution Probe',
    description: 'Synthetic connector for the #1181 extraction reproducer.',
    version: '0.0.1',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {
      invoices: {
        key: 'invoices',
        name: 'Invoices',
        sync: async (ctx) => {
          await ctx.commit([], null);
          return { status: 'complete', metadata: { items_found: 0, items_skipped: 0 } };
        },
        eventKinds: {
          invoice: {
            attributions: [
              { name: 'invoice', role: 'belongs_to', target: { entityType: 'invoice' } },
              { name: 'customer', role: 'about', target: { entityType: 'customer' } },
            ],
            relationships: [
              { type: 'invoice_customer', from: 'invoice', to: 'customer' },
            ],
          },
        },
      },
    },
  };

}
`;

describe('extractConnectorMetadata in a project dir without node_modules', () => {
  const originalCwd = process.cwd();
  let sourceDir: string;
  let emptyProjectDir: string;

  beforeAll(() => {
    sourceDir = mkdtempSync(join(tmpdir(), 'lobu-1181-src-'));
    // Stands in for a fresh `lobu init` project: no node_modules anywhere up
    // the OS tmpdir ancestry.
    emptyProjectDir = mkdtempSync(join(tmpdir(), 'lobu-1181-proj-'));
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(emptyProjectDir, { recursive: true, force: true });
  });

  test('extracts metadata from the compiled bundle', async () => {
    const connectorPath = join(sourceDir, 'meta_resolution_probe.ts');
    writeFileSync(connectorPath, CONNECTOR_SOURCE);

    // The same compiler the gateway's bundled-connector install path uses.
    // It inlines the SDK, so no bare SDK specifier survives into the bundle.
    const { compileConnectorForIsolateFromFile } = createIsolateConnectorCompiler();
    const compiled = await compileConnectorForIsolateFromFile(connectorPath);
    expect(compiled).not.toMatch(/from\s+['"]@lobu\/connector-sdk['"]/);
    expect(compiled).not.toMatch(/require\(\s*['"]@lobu\/connector-sdk['"]\s*\)/);

    process.chdir(emptyProjectDir);
    try {
      const metadata = await extractConnectorMetadata(compiled);
      expect(metadata.key).toBe('meta_resolution_probe');
      expect(metadata.name).toBe('Metadata Resolution Probe');
      expect(metadata.version).toBe('0.0.1');
      expect(metadata.feeds).toMatchObject({
        invoices: {
          operations: ['sync'],
          eventKinds: {
            invoice: {
              attributions: [
                { name: 'invoice' },
                { name: 'customer' },
              ],
              relationships: [
                { type: 'invoice_customer', from: 'invoice', to: 'customer' },
              ],
            },
          },
        },
      });
    } finally {
      process.chdir(originalCwd);
    }
  }, 30_000);
});

describe('formatMetadataExtractionError', () => {
  test('appends install guidance when the connector SDK is unresolvable', () => {
    const raw =
      "Cannot find package '@lobu/connector-sdk' imported from /tmp/proj/.connector-meta-XXXX/source.mjs";
    const formatted = formatMetadataExtractionError(raw);
    expect(formatted).toContain('Metadata extraction failed:');
    expect(formatted).toContain(raw);
    expect(formatted).toContain('npm install');
    expect(formatted).toContain('bun install');
    expect(formatted).toContain('@lobu/connector-sdk');
  });

  test('handles the bare `lobu` alias specifier too', () => {
    const formatted = formatMetadataExtractionError(
      "Cannot find package 'lobu' imported from /tmp/x/source.mjs"
    );
    expect(formatted).toContain('npm install');
  });

  test('leaves unrelated errors untouched', () => {
    const formatted = formatMetadataExtractionError(
      'No ConnectorRuntime class found in compiled code.'
    );
    expect(formatted).toBe(
      'Metadata extraction failed: No ConnectorRuntime class found in compiled code.'
    );
    expect(formatted).not.toContain('npm install');
  });

  test('does not misfire on other missing packages', () => {
    const formatted = formatMetadataExtractionError(
      "Cannot find package 'left-pad' imported from /tmp/x/source.mjs"
    );
    expect(formatted).not.toContain('npm install');
  });
});

describe('resolveBundledAgentToolingMetadata', () => {
  test('returns tooling and auth only for an exact bundled key and version', async () => {
    const metadata = await resolveBundledAgentToolingMetadata('github', '1.3.0');
    expect(metadata?.agentTooling).toMatchObject({
      nix: { packages: ['gh'] },
      env: [{ name: 'GH_TOKEN', credential: 'lease' }],
    });
    expect(metadata?.authSchema?.methods).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'app_installation' })]),
    );
  });

  test('rejects a selected version that does not match the image metadata', async () => {
    expect(
      await resolveBundledAgentToolingMetadata('github', '1.0.0'),
    ).toBeNull();
  });
});

/**
 * `connector-catalog` routes "file exports no ConnectorRuntime" outcomes to
 * debug instead of warn by matching NO_CONNECTOR_RUNTIME_ERROR against the
 * error message — the throw happens in a subprocess and crosses back as
 * `process.send({ error: error.message })`, so a string is the only channel.
 *
 * This pins the coupling, not the wording: the runner interpolates the same
 * constant, so rewording it moves both sides together and stays green. What
 * turns it red is breaking the coupling — replacing the
 * `${JSON.stringify(NO_CONNECTOR_RUNTIME_ERROR)}` interpolation with a
 * hardcoded literal — at which point the catalog stops recognising its own
 * sentinel and every not-a-connector file silently routes back to `warn`.
 */
describe('non-connector files are identifiable, not just failures', () => {
  test('a module with no ConnectorRuntime rejects with exactly NO_CONNECTOR_RUNTIME_ERROR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lobu-nonconnector-'));
    try {
      const modulePath = join(dir, 'support_module.ts');
      // Shaped like the real offenders: a plain support module that exports
      // helpers and no class with sync()/execute().
      writeFileSync(
        modulePath,
        'export const NAMESPACES = ["github"];\n' +
          'export function normalize(v: string) { return v.toLowerCase(); }\n'
      );

      const { compileConnectorForIsolateFromFile } = createIsolateConnectorCompiler();
      const compiled = await compileConnectorForIsolateFromFile(modulePath);

      await expect(extractConnectorMetadata(compiled)).rejects.toThrow(
        NO_CONNECTOR_RUNTIME_ERROR
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
