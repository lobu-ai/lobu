import { describe, expect, it } from 'bun:test';
import { resolveBrowserRequirement, validateBrowserRequirement, constrainBrowserInput } from '../browser-requirement';

describe('browser resource requirements', () => {
  const browser = { origins: ['https://example.test'], authMethods: ['browser'] };

  it('does not grant browser access to an OAuth connection or an undeclared connector', () => {
    expect(resolveBrowserRequirement(browser, 'oauth')).toBeNull();
    expect(resolveBrowserRequirement(null, 'none')).toBeNull();
    expect(resolveBrowserRequirement(browser, 'browser')).toEqual(browser);
  });

  it('supports explicitly declared public browser scraping without account auth', () => {
    expect(resolveBrowserRequirement({ origins: ['https://example.test'] }, 'none')).not.toBeNull();
  });

  it('rejects malformed and broad grants instead of silently widening them', () => {
    for (const origins of [[], ['*'], ['http://example.test'], ['https://example.test/path'], ['https://user:secret@example.test']]) {
      expect(() => validateBrowserRequirement({ origins })).toThrow();
    }
    expect(() => validateBrowserRequirement({ origins: ['https://example.test'], accountProbe: { url: 'https://other.test', expression: 'null' } })).toThrow();
  });

  it('replaces caller-controlled origins and refuses out-of-scope navigation', () => {
    const grant = { origins: ['https://example.test'] };
    expect(constrainBrowserInput(grant, 'navigate', { url: 'https://example.test/inbox', allowed_origins: ['*'] }))
      .toEqual({ url: 'https://example.test/inbox', allowed_origins: ['https://example.test'] });
    expect(() => constrainBrowserInput(grant, 'navigate', { url: 'https://other.test' })).toThrow();
    expect(() => constrainBrowserInput(grant, 'navigate', { url: 'https://example.test.evil.test' })).toThrow();
  });
});
