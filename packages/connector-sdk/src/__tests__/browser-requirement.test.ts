import { existsSync, readFileSync } from 'node:fs';
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

describe('browser operation allowlist', () => {
  const grant = { origins: ['https://example.test'] };
  const manifestPath = new URL('../../../owletto/apps/chrome/connector-manifests/chrome.json', import.meta.url);
  const NOT_FOR_CONNECTORS: Record<string, string> = {
    upload_file: 'takes absolute paths on the device, which would let connector code read device files',
    close_user_tabs: "closes the user's own tabs, which only the user or an agent with their grant may do",
  };

  it.each(['hover_ref', 'select_option', 'handle_dialog'])('admits %s with the catalog origin grant', (operation) => {
    expect(constrainBrowserInput(grant, operation, { tab_id: 7, allowed_origins: ['https://other.test'] }))
      .toEqual({ tab_id: 7, allowed_origins: grant.origins });
  });

  it.each(Object.keys(NOT_FOR_CONNECTORS))('refuses %s without a direct browser grant', (operation) => {
    expect(() => constrainBrowserInput(grant, operation, {})).toThrow('outside the declared browser resource');
  });

  // Forks can run SDK tests without the private Owletto submodule.
  it.skipIf(!existsSync(manifestPath))('admits every extension operation except the deliberate exclusions', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { actions_schema: Record<string, unknown> };
    const refused = Object.keys(manifest.actions_schema).filter((operation) => {
      if (operation in NOT_FOR_CONNECTORS) return false;
      try {
        constrainBrowserInput(grant, operation, operation === 'navigate' ? { url: 'https://example.test/' } : {});
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toEqual([]);
  });
});
