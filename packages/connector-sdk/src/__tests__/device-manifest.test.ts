import { describe, expect, test } from 'bun:test';
import { defineConnector } from '../define-connector.js';
import {
  canonicalDeviceManifestJson,
  defineDeviceConnector,
  serializeDeviceConnector,
} from '../device-manifest.js';
import { deviceManifestHash } from '../device-manifest-hash.js';

const validSpec = () => ({
  key: 'apple.test',
  version: '0.1.0',
  name: 'Test device connector',
  requiredCapability: 'calendar',
  runtime: { platforms: ['macos'] },
  feeds: {
    events: {
      key: 'events',
      name: 'Events',
      operations: ['sync' as const],
      configSchema: { type: 'object' },
      eventKinds: { event: { metadataSchema: { type: 'object' } } },
    },
  },
});

describe('defineDeviceConnector', () => {
  test('serializes no implementation marker and never executable handlers', () => {
    const definition = defineDeviceConnector(validSpec());
    const manifest = serializeDeviceConnector(definition);

    expect(manifest.runtime).toEqual({ platforms: ['macos'] });
    expect(manifest.auth_schema).toEqual({ methods: [{ type: 'none' }] });
    expect(manifest.feeds_schema.events).toEqual(validSpec().feeds.events);
    expect(typeof (manifest.feeds_schema.events as Record<string, unknown>).sync).toBe('undefined');
    expect(typeof (manifest.feeds_schema.events as Record<string, unknown>).read).toBe('undefined');
  });

  test('rejects missing identity, capability, platforms, and a declared implementation', () => {
    for (const field of ['key', 'version', 'name', 'requiredCapability'] as const) {
      const spec = validSpec();
      delete (spec as Record<string, unknown>)[field];
      expect(() => defineDeviceConnector(spec)).toThrow(`${field} is required`);
    }
    expect(() => defineDeviceConnector({ ...validSpec(), runtime: {} })).toThrow(
      'runtime.platforms is required',
    );
    // The manifest is hashed to form the connector's identity, so naming the
    // endpoint that implements it would give two endpoints of one contract two
    // hashes — and an organization elects exactly one manifest per key.
    expect(() =>
      defineDeviceConnector({
        ...validSpec(),
        runtime: { platforms: ['macos'], execution: 'bridge' },
      } as never),
    ).toThrow('runtime.execution is not part of a device contract');
  });

  test('accepts a contract shared by several platforms', () => {
    const manifest = serializeDeviceConnector(
      defineDeviceConnector({ ...validSpec(), runtime: { platforms: ['headless', 'macos'] } }),
    );
    expect(manifest.runtime).toEqual({ platforms: ['headless', 'macos'] });
  });

  test('rejects executable handlers and malformed feed/action schemas', () => {
    expect(() =>
      defineDeviceConnector({
        ...validSpec(),
        feeds: { events: { ...validSpec().feeds.events, sync: async () => ({}) } },
      } as never),
    ).toThrow('sync handler');
    expect(() =>
      defineDeviceConnector({
        ...validSpec(),
        actions: {
          run: {
            key: 'run',
            name: 'Run',
            inputSchema: 'not-a-schema',
            execute: async () => ({ success: true }),
          },
        },
      } as never),
    ).toThrow('execute handler');
    expect(() =>
      defineDeviceConnector({
        ...validSpec(),
        feeds: { events: { ...validSpec().feeds.events, key: 'wrong' } },
      }),
    ).toThrow("invalid feed schema 'events'");
    expect(() =>
      defineDeviceConnector({
        ...validSpec(),
        actions: { run: { key: 'run', name: 'Run', inputSchema: [] } },
      } as never),
    ).toThrow("invalid action inputSchema 'run'");
  });

  for (const handler of ['read', 'onDelivery']) {
    test(`rejects an executable ${handler} handler in a metadata-only device manifest`, () => {
      expect(() => defineDeviceConnector({
        ...validSpec(),
        feeds: { events: { ...validSpec().feeds.events, [handler]: async () => ({}) } },
      } as never)).toThrow(`${handler} handler`);
    });
  }

  test('rejects duplicate keys in a registry batch', () => {
    expect(() => defineDeviceConnector([validSpec(), validSpec()])).toThrow(
      "duplicate device connector key 'apple.test'",
    );
  });

  test('keeps server-executed Connector SDK definitions distinct from device manifests', () => {
    const ordinary = defineConnector({
      key: 'ordinary',
      version: '1.0.0',
      name: 'Ordinary',
      feeds: { items: { name: 'Items', sync: async () => ({ events: [], checkpoint: null }) } },
    });
    expect(new ordinary().definition.runtime).toBeUndefined();
  });
});

describe('device manifest canonicalization', () => {
  test('is stable across object insertion order and changes on schema/version changes', () => {
    const first = serializeDeviceConnector(validSpec());
    const reordered = {
      runtime: { platforms: ['macos'] },
      feeds_schema: first.feeds_schema,
      required_capability: first.required_capability,
      auth_schema: first.auth_schema,
      name: first.name,
      version: first.version,
      key: first.key,
    };
    expect(deviceManifestHash(first)).toBe(deviceManifestHash(reordered));
    expect(canonicalDeviceManifestJson(first)).toBe(canonicalDeviceManifestJson(reordered));
    expect(deviceManifestHash({ ...first, version: '0.2.0' })).not.toBe(deviceManifestHash(first));
    expect(
      deviceManifestHash({
        ...first,
        feeds_schema: { ...first.feeds_schema, events: { ...first.feeds_schema.events, name: 'Changed' } },
      }),
    ).not.toBe(deviceManifestHash(first));
  });
});
