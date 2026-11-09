import { describe, expect, it } from 'vitest';
import { isExcludedSpaPath } from '../../../http/spa-route-filter';

describe('SPA route filter', () => {
  it('allows frontend OAuth pages through the SPA fallback', () => {
    expect(isExcludedSpaPath('/oauth/device')).toBe(false);
    expect(isExcludedSpaPath('/oauth/device/')).toBe(false);
    expect(isExcludedSpaPath('/oauth/consent')).toBe(false);
  });

  it('keeps OAuth API endpoints excluded from the SPA fallback', () => {
    expect(isExcludedSpaPath('/oauth/authorize')).toBe(true);
    expect(isExcludedSpaPath('/oauth/device_authorization')).toBe(true);
    expect(isExcludedSpaPath('/oauth/device/approve')).toBe(true);
  });

  it.each([
    '/legal',
    '/legal/',
    '/legal//',
    '/legal/data/..',
  ])('keeps the standalone legal page excluded at %s', (requestPath) => {
    expect(isExcludedSpaPath(requestPath)).toBe(true);
  });

  it.each([
    '/legal/data',
    '/legal/data/-/views/case-register',
    '/legal/events/123',
    '/legal/events/123/-/views/case-review',
    '/legal/data/../settings/',
    '/legal-aid/events/123',
  ])('allows workspace page %s through the SPA fallback', (requestPath) => {
    expect(isExcludedSpaPath(requestPath)).toBe(false);
  });

  it.each([
    '/.well-known',
    '/api',
    '/connect',
    '/health',
    '/logo.png',
    '/mcp',
    '/openapi.json',
    '/oauth',
  ])('keeps reserved namespace %s excluded', (prefix) => {
    expect(isExcludedSpaPath(prefix)).toBe(true);
    expect(isExcludedSpaPath(prefix + '/child')).toBe(true);
  });
});
