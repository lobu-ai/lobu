import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  initialize,
  isConnectorRuntimeDependency,
  resolve,
} from '../executor/runtime-dependency-loader.js';

describe('connector runtime dependency loader', () => {
  test('only stages the SDK needed for compilation', () => {
    expect(isConnectorRuntimeDependency('@lobu/connector-sdk')).toBe(true);
    expect(
      isConnectorRuntimeDependency('@lobu/connector-sdk/define-connector')
    ).toBe(true);
    expect(isConnectorRuntimeDependency('playwright')).toBe(false);
    expect(isConnectorRuntimeDependency('sharp/lib/index.js')).toBe(false);
    expect(isConnectorRuntimeDependency('node:fs')).toBe(false);
    expect(isConnectorRuntimeDependency('connector-owned-package')).toBe(false);
  });

  test('rebases runtime packages to the connector-worker installation', async () => {
    const runtimeAnchorUrl =
      'file:///runtime/node_modules/@lobu/connector-worker/dist/executor/runtime-dependency-loader.js';
    initialize({ runtimeAnchorUrl });

    const calls: Array<{
      specifier: string;
      context: Record<string, unknown>;
    }> = [];
    const nextResolve = async (
      specifier: string,
      context: Record<string, unknown>
    ) => {
      calls.push({ specifier, context });
      return { url: `file:///resolved/${encodeURIComponent(specifier)}` };
    };

    await resolve(
      '@lobu/connector-sdk/define-connector',
      { parentURL: 'file:///unrelated/operator-cwd/connector.mjs' },
      nextResolve
    );
    await resolve(
      'connector-owned-package',
      { parentURL: 'file:///unrelated/operator-cwd/connector.mjs' },
      nextResolve
    );

    expect(calls[0]).toMatchObject({
      specifier: '@lobu/connector-sdk/define-connector',
      context: { parentURL: runtimeAnchorUrl },
    });
    expect(calls[1]).toMatchObject({
      specifier: 'connector-owned-package',
      context: {
        parentURL: 'file:///unrelated/operator-cwd/connector.mjs',
      },
    });
  });

  test.skipIf(!existsSync('/sys') && !existsSync('/System'))(
    'boots from a read-only cwd with a CommonJS runtime dependency',
    () => {
      const readOnlyCwd = existsSync('/sys') ? '/sys' : '/System';
      const selfCheckUrl = new URL(
        '../../dist/self-check/index.js',
        import.meta.url
      ).href;
      const probe = `
        const timeout = setTimeout(() => process.exit(9), 20_000);
        const { assertConnectorRuntimeLoadable } = await import(${JSON.stringify(
          selfCheckUrl
        )});
        await assertConnectorRuntimeLoadable();
        clearTimeout(timeout);
      `;
      const env = { ...process.env };
      delete env.NODE_PATH;
      const result = spawnSync(
        'node',
        ['--input-type=module', '--eval', probe],
        {
          cwd: readOnlyCwd,
          env,
          encoding: 'utf-8',
          timeout: 30_000,
        }
      );

      expect(
        result.status,
        `read-only cwd readiness probe failed:\n${result.stdout}${result.stderr}`
      ).toBe(0);
    }
  );
});
