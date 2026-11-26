import { describe, expect, test } from 'bun:test';
import {
  canonicalizeHostname,
  decideEgress,
  isUnrestrictedMode,
  matchesDomainPattern,
  patternReaches,
  wildcardParentPatterns,
} from '../egress-policy.js';

describe('isUnrestrictedMode', () => {
  test('only the sole "*" entry is unrestricted', () => {
    expect(isUnrestrictedMode(['*'])).toBe(true);
    expect(isUnrestrictedMode(['*', 'example.com'])).toBe(false);
    expect(isUnrestrictedMode([])).toBe(false);
  });
});

describe('canonicalizeHostname', () => {
  test('strips trailing dots and lowercases', () => {
    expect(canonicalizeHostname('Example.COM.')).toBe('example.com');
    expect(canonicalizeHostname('evil.com..')).toBe('evil.com');
  });

  test('folds Unicode hosts to punycode so CONNECT and HTTP forms agree', () => {
    expect(canonicalizeHostname('münchen.de')).toBe('xn--mnchen-3ya.de');
    expect(canonicalizeHostname('MÜNCHEN.DE.')).toBe('xn--mnchen-3ya.de');
    expect(canonicalizeHostname('xn--mnchen-3ya.de')).toBe('xn--mnchen-3ya.de');
  });

  test('leaves IP literals and unparseable hosts alone (lowercased)', () => {
    expect(canonicalizeHostname('127.0.0.1')).toBe('127.0.0.1');
    expect(canonicalizeHostname('[::1]')).toBe('[::1]');
    expect(canonicalizeHostname('::FFFF:7F00:1')).toBe('::ffff:7f00:1');
    expect(canonicalizeHostname('ex%61mple.com')).toBe('ex%61mple.com');
    expect(canonicalizeHostname('')).toBe('');
  });
});

describe('matchesDomainPattern', () => {
  test('an exact pattern covers only that host', () => {
    expect(matchesDomainPattern('example.com', ['example.com'])).toBe(true);
    expect(matchesDomainPattern('sub.example.com', ['example.com'])).toBe(false);
    expect(matchesDomainPattern('example.COM', ['EXAMPLE.com'])).toBe(true);
  });

  test('a ".suffix" wildcard covers the apex and every subdomain, label-aligned', () => {
    expect(matchesDomainPattern('example.com', ['.example.com'])).toBe(true);
    expect(matchesDomainPattern('a.example.com', ['.example.com'])).toBe(true);
    expect(matchesDomainPattern('a.b.example.com', ['.example.com'])).toBe(true);
    expect(matchesDomainPattern('notexample.com', ['.example.com'])).toBe(false);
    expect(matchesDomainPattern('example.com', ['.ample.com'])).toBe(false);
  });

  test('"*.suffix" is the same wildcard', () => {
    expect(matchesDomainPattern('a.example.com', ['*.example.com'])).toBe(true);
    expect(matchesDomainPattern('example.com', ['*.example.com'])).toBe(true);
  });

  test('grant semantics: the wildcard does not cover its apex', () => {
    expect(matchesDomainPattern('example.com', ['.example.com'], { wildcardCoversRoot: false })).toBe(false);
    expect(matchesDomainPattern('a.example.com', ['.example.com'], { wildcardCoversRoot: false })).toBe(true);
  });

  test('"*" never matches as a hostname pattern', () => {
    expect(matchesDomainPattern('example.com', ['*'])).toBe(false);
    expect(matchesDomainPattern('example.com', ['other.com', '.example.com'])).toBe(true);
  });
});

describe('decideEgress with only the global lists', () => {
  const globalOnly = (hostname: string, allowedDomains: string[], deniedDomains: string[]) =>
    decideEgress({ hostname, global: { allowedDomains, deniedDomains } }).then((d) => d.allowed);

  test('an empty allowlist denies everything', async () => {
    expect(await globalOnly('example.com', [], [])).toBe(false);
  });

  test('unrestricted mode allows everything the denylist does not name', async () => {
    expect(await globalOnly('example.com', ['*'], [])).toBe(true);
    expect(await globalOnly('evil.com', ['*'], ['.evil.com'])).toBe(false);
    expect(await globalOnly('sub.evil.com', ['*'], ['.evil.com'])).toBe(false);
  });

  test('the denylist beats the allowlist', async () => {
    expect(await globalOnly('api.example.com', ['.example.com'], ['api.example.com'])).toBe(false);
    expect(await globalOnly('www.example.com', ['.example.com'], ['api.example.com'])).toBe(true);
    expect(await globalOnly('other.com', ['.example.com'], [])).toBe(false);
  });
});

describe('wildcardParentPatterns', () => {
  test('lists every ancestor suffix, most specific first, in both spellings', () => {
    expect(wildcardParentPatterns('a.b.example.com')).toEqual([
      '.b.example.com',
      '*.b.example.com',
      '.example.com',
      '*.example.com',
    ]);
  });

  test('the apex has no wildcard parent', () => {
    expect(wildcardParentPatterns('example.com')).toEqual([]);
    expect(wildcardParentPatterns('localhost')).toEqual([]);
  });
});

describe('patternReaches', () => {
  test('two exact patterns reach each other only when equal', () => {
    expect(patternReaches('example.com', 'example.com')).toBe(true);
    expect(patternReaches('example.com', 'other.com')).toBe(false);
  });

  test('an allow wildcard reaches an exact covered host under it', () => {
    expect(patternReaches('api.example.com', '.example.com')).toBe(true);
    expect(patternReaches('api.example.com', '.other.com')).toBe(false);
  });

  test('whether the allow wildcard reaches the apex depends on the enforcing matcher', () => {
    expect(patternReaches('example.com', '.example.com')).toBe(false);
    expect(patternReaches('example.com', '.example.com', { wildcardCoversRoot: true })).toBe(true);
    expect(patternReaches('example.com', '*.example.com', { wildcardCoversRoot: true })).toBe(true);
  });

  test('a covering wildcard is reached by its apex and any host under it', () => {
    expect(patternReaches('.example.com', 'example.com')).toBe(true);
    expect(patternReaches('.example.com', 'deep.sub.example.com')).toBe(true);
    expect(patternReaches('.example.com', 'example.org')).toBe(false);
  });

  test('two wildcards overlap when either suffix sits under the other', () => {
    expect(patternReaches('.example.com', '.api.example.com')).toBe(true);
    expect(patternReaches('.api.example.com', '.example.com')).toBe(true);
    expect(patternReaches('.example.com', '.example.com')).toBe(true);
    expect(patternReaches('.example.com', '.example.org')).toBe(false);
  });
});

describe('decideEgress', () => {
  function tenant(overrides: { denied?: string[]; granted?: string[] }) {
    const calls: string[] = [];
    return {
      calls,
      lookups: {
        isDenied: async (host: string) => {
          calls.push(`isDenied:${host}`);
          return (overrides.denied ?? []).includes(host);
        },
        hasGrant: async (host: string) => {
          calls.push(`hasGrant:${host}`);
          return (overrides.granted ?? []).includes(host);
        },
      },
    };
  }

  test('the global denylist wins over every allow', async () => {
    const t = tenant({ granted: ['evil.com'] });
    const decision = await decideEgress({
      hostname: 'evil.com',
      global: { allowedDomains: ['*'], deniedDomains: ['evil.com'] },
      tenant: t.lookups,
    });
    expect(decision).toEqual({ allowed: false, source: 'global' });
    expect(t.calls).toEqual([]);
  });

  test('a tenant deny beats the global allowlist', async () => {
    const t = tenant({ denied: ['api.example.com'] });
    const decision = await decideEgress({
      hostname: 'api.example.com',
      global: { allowedDomains: ['.example.com'], deniedDomains: [] },
      tenant: t.lookups,
    });
    expect(decision).toEqual({ allowed: false, source: 'grant' });
  });

  test('a global allow short-circuits before the allow grants', async () => {
    const t = tenant({});
    const decision = await decideEgress({
      hostname: 'www.example.com',
      global: { allowedDomains: ['.example.com'], deniedDomains: [] },
      tenant: t.lookups,
    });
    expect(decision).toEqual({ allowed: true, source: 'global' });
    expect(t.calls).toEqual(['isDenied:www.example.com']);
  });

  test('a tenant grant allows a host the global lists do not name', async () => {
    const t = tenant({ granted: ['api.other.com'] });
    const decision = await decideEgress({
      hostname: 'api.other.com',
      global: { allowedDomains: ['.example.com'], deniedDomains: [] },
      tenant: t.lookups,
    });
    expect(decision).toEqual({ allowed: true, source: 'grant' });
  });

  test('no list and no grant → deny', async () => {
    const decision = await decideEgress({
      hostname: 'nowhere.com',
      global: { allowedDomains: [], deniedDomains: [] },
      tenant: tenant({}).lookups,
    });
    expect(decision).toEqual({ allowed: false, source: 'global' });
  });

  test('the hostname is canonicalized before any lookup sees it', async () => {
    const t = tenant({ granted: ['xn--mnchen-3ya.de'] });
    const decision = await decideEgress({
      hostname: 'MÜNCHEN.de.',
      global: { allowedDomains: [], deniedDomains: [] },
      tenant: t.lookups,
    });
    expect(decision).toEqual({ allowed: true, source: 'grant' });
    expect(t.calls).toEqual(['isDenied:xn--mnchen-3ya.de', 'hasGrant:xn--mnchen-3ya.de']);
  });
});
