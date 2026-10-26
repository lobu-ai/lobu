/**
 * A connector key may not collide with a static `/connectors/` route segment.
 *
 * `/connectors/<key>/<connectionId>` is a catch-all param, and TanStack Router
 * matches a static sibling first — so a connector installed as `device` would
 * have every connection page it owns swallowed by the device detail route. The
 * install is rejected at metadata validation, the gate the source-backed
 * install paths (source_url, source_uri, source_code, bundled catalog) go
 * through. mcp_url installs skip it, but their keys are always `mcp.`-prefixed
 * and can never equal a bare route segment.
 */
import { describe, expect, test } from 'vitest';
import { CONNECTOR_SUBROUTE_SEGMENTS } from '@lobu/core';
import { validateConnectorMetadata } from '../connector-compiler';

const base = { name: 'Anything', version: '1.0.0' };

describe('validateConnectorMetadata reserved keys', () => {
  test.each(CONNECTOR_SUBROUTE_SEGMENTS)('rejects %s', (key) => {
    expect(() => validateConnectorMetadata({ ...base, key })).toThrow(/reserved/);
  });

  // The guard must cover every segment the router actually declares, not a
  // hand-copied subset: a new `/connectors/<segment>/$id` route added without
  // touching the reserved list is exactly the case that would slip through.
  // `deployments` is a retired route kept reserved so stale bookmarks resolve
  // to the not-installed fallback rather than a connector of that name.
  test('covers every declared subroute segment', () => {
    expect([...CONNECTOR_SUBROUTE_SEGMENTS].sort()).toEqual([
      'app',
      'client',
      'create',
      'deployments',
      'device',
    ]);
  });

  // The router matches static segments case-insensitively, so casing must not
  // sneak a reserved key past the guard.
  test('rejects a reserved key regardless of case', () => {
    expect(() => validateConnectorMetadata({ ...base, key: 'Device' })).toThrow(/reserved/);
  });

  test('accepts an ordinary key', () => {
    expect(() => validateConnectorMetadata({ ...base, key: 'slack' })).not.toThrow();
  });
});
