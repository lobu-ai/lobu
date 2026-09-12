import { describe, expect, test } from 'bun:test';
import workerPackage from '../../package.json';
import { RUNTIME_PROVIDED_PACKAGES } from '../runtime-deps.js';

describe('connector runtime dependency packaging', () => {
  test('does not install browser and image packages the isolate cannot load', () => {
    for (const name of ['playwright', 'patchright', 'jimp', 'sharp']) {
      expect(workerPackage.dependencies).not.toHaveProperty(name);
      expect(RUNTIME_PROVIDED_PACKAGES as readonly string[]).not.toContain(name);
    }
  });

  test('the worker declares every package its compiled connectors load at runtime', () => {
    const dependencies = new Set(Object.keys(workerPackage.dependencies ?? {}));
    expect(RUNTIME_PROVIDED_PACKAGES).toContain('@lobu/connector-sdk');
    expect(RUNTIME_PROVIDED_PACKAGES.filter((name) => !dependencies.has(name))).toEqual([]);
  });
});
