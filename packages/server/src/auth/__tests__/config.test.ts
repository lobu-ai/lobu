/**
 * Auth Config — pure helper unit tests.
 *
 * These cover the side-effect-free logic only (scope extraction, provider
 * collection, baseline↔org merge). The catalog/DB-backed paths
 * (getBaselineLoginProviderConfigs, getEnabledLoginProviderConfigs, getAuthConfig)
 * are exercised against the real catalog + embedded Postgres in
 * config.baseline.integration.test.ts — mocking those modules is unreliable here
 * because the suite runs with `isolate: false` (shared module registry).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGenericOAuthEntry,
  collectEnabledLoginProviderConfigs,
  type EnabledLoginProviderConfig,
  getAuthConfig,
  getLoginProviderScopes,
  mergeLoginProviderConfigs,
} from '../config';

describe('login provider helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns connector-declared scopes verbatim', () => {
    expect(getLoginProviderScopes('google', ['openid', 'email', 'profile'])).toEqual([
      'openid',
      'email',
      'profile',
    ]);
  });

  it('returns null when the connector declares no login scopes', () => {
    // Core no longer assumes scopes for any provider — connectors must declare them.
    expect(getLoginProviderScopes('google')).toBeNull();
    expect(getLoginProviderScopes('github')).toBeNull();
    expect(getLoginProviderScopes('reddit')).toBeNull();
  });

  it('dedupes providers and ignores connectors without declared login scopes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const configs = collectEnabledLoginProviderConfigs([
      {
        // Sensitive connector scopes never leak into login: a connector that declares
        // only requiredScopes (no loginScopes) is filtered out of the login flow.
        key: 'google.calendar',
        auth_schema: {
          methods: [
            {
              type: 'oauth',
              provider: 'google',
              requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
            },
          ],
        },
      },
      {
        // Sensitive requiredScopes + auto-provisioning must NOT leak into login:
        // login stays identity-only (openid/email/profile); gmail.readonly is granted
        // later via the connector's own incremental-auth flow.
        key: 'google.gmail',
        auth_schema:
          '{"methods":[{"type":"oauth","provider":"google","loginScopes":["openid","email","profile"],"requiredScopes":["https://www.googleapis.com/auth/gmail.readonly"],"loginProvisioning":{"autoCreateConnection":true}}]}',
      },
      {
        key: 'github.issues',
        auth_schema: {
          methods: [
            {
              type: 'oauth',
              provider: 'github',
              loginScopes: ['read:user', 'user:email'],
              clientIdKey: 'GH_ID',
              clientSecretKey: 'GH_SECRET',
            },
          ],
        },
      },
      {
        key: 'twitter.timeline',
        auth_schema: {
          methods: [
            {
              type: 'oauth',
              provider: 'twitter',
              loginScopes: ['users.read', 'tweet.read', 'offline.access', 'users.email'],
            },
          ],
        },
      },
      {
        // No loginScopes → filtered out even though it's OAuth.
        key: 'reddit',
        auth_schema: {
          methods: [{ type: 'oauth', provider: 'reddit', requiredScopes: ['read'] }],
        },
      },
    ]);

    expect(configs).toEqual([
      {
        connectorKey: 'google.gmail',
        provider: 'google',
        displayName: 'Google',
        faviconDomain: null,
        loginScopes: ['openid', 'email', 'profile'],
        clientIdKey: 'GOOGLE_CLIENT_ID',
        clientSecretKey: 'GOOGLE_CLIENT_SECRET',
      },
      {
        connectorKey: 'github.issues',
        provider: 'github',
        displayName: 'Github',
        faviconDomain: null,
        loginScopes: ['read:user', 'user:email'],
        clientIdKey: 'GH_ID',
        clientSecretKey: 'GH_SECRET',
      },
      {
        connectorKey: 'twitter.timeline',
        provider: 'twitter',
        displayName: 'Twitter',
        faviconDomain: null,
        loginScopes: ['users.read', 'tweet.read', 'offline.access', 'users.email'],
        clientIdKey: 'TWITTER_CLIENT_ID',
        clientSecretKey: 'TWITTER_CLIENT_SECRET',
      },
    ]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('quiet mode suppresses the no-scope / multi-connector warnings (catalog baseline)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const configs = collectEnabledLoginProviderConfigs(
      [
        {
          key: 'google.calendar',
          auth_schema: {
            methods: [{ type: 'oauth', provider: 'google', loginScopes: ['openid', 'email'] }],
          },
        },
        {
          // Same provider via a second connector — would warn without quiet.
          key: 'google.gmail',
          auth_schema: {
            methods: [{ type: 'oauth', provider: 'google', loginScopes: ['openid', 'email'] }],
          },
        },
        {
          // OAuth but no login scopes — would warn without quiet.
          key: 'reddit',
          auth_schema: {
            methods: [{ type: 'oauth', provider: 'reddit', requiredScopes: ['read'] }],
          },
        },
      ],
      { quiet: true }
    );

    expect(configs.map((c) => c.provider)).toEqual(['google']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('derives displayName/faviconDomain from the owning connector row', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configs = collectEnabledLoginProviderConfigs([
      {
        key: 'agentid',
        name: 'AgentID',
        favicon_domain: 'agentid.com',
        auth_schema: {
          methods: [
            { type: 'oauth', provider: 'agentid', loginScopes: ['openid', 'email', 'profile'] },
          ],
        },
      },
      {
        // No name → capitalized provider key; no favicon → null.
        key: 'noname',
        auth_schema: {
          methods: [{ type: 'oauth', provider: 'noname', loginScopes: ['openid'] }],
        },
      },
      {
        // Blank name trims to nothing → same fallback as absent.
        key: 'blankname',
        name: '   ',
        auth_schema: {
          methods: [{ type: 'oauth', provider: 'blankname', loginScopes: ['openid'] }],
        },
      },
    ]);
    expect(configs).toMatchObject([
      { provider: 'agentid', displayName: 'AgentID', faviconDomain: 'agentid.com' },
      { provider: 'noname', displayName: 'Noname', faviconDomain: null },
      { provider: 'blankname', displayName: 'Blankname', faviconDomain: null },
    ]);
  });
});

describe('mergeLoginProviderConfigs', () => {
  const baselineGoogle = {
    connectorKey: 'google.gmail',
    provider: 'google',
    displayName: 'Gmail',
    faviconDomain: 'mail.google.com',
    loginScopes: ['openid', 'email', 'profile'],
    clientIdKey: 'GOOGLE_CLIENT_ID',
    clientSecretKey: 'GOOGLE_CLIENT_SECRET',
  };
  const baselineGithub = {
    connectorKey: 'github.issues',
    provider: 'github',
    displayName: 'GitHub',
    faviconDomain: 'github.com',
    loginScopes: ['read:user'],
    clientIdKey: 'GITHUB_CLIENT_ID',
    clientSecretKey: 'GITHUB_CLIENT_SECRET',
  };

  it('returns the baseline unchanged when the org adds nothing', () => {
    expect(mergeLoginProviderConfigs([baselineGoogle, baselineGithub], [])).toEqual([
      baselineGoogle,
      baselineGithub,
    ]);
  });

  it('is additive — an org-only provider is appended, the baseline is never dropped', () => {
    const orgOnly = {
      connectorKey: 'okta.sso',
      provider: 'okta',
      displayName: 'Acme SSO',
      faviconDomain: null,
      loginScopes: ['openid'],
      clientIdKey: 'OKTA_CLIENT_ID',
      clientSecretKey: 'OKTA_CLIENT_SECRET',
    };
    const merged = mergeLoginProviderConfigs([baselineGoogle], [orgOnly]);
    expect(merged).toEqual([baselineGoogle, orgOnly]);
  });

  it('lets an org override the baseline for the same provider (BYO OAuth app)', () => {
    const orgGoogle = {
      connectorKey: 'org.google',
      provider: 'google',
      displayName: 'Org Google',
      faviconDomain: null,
      loginScopes: ['openid', 'email'],
      clientIdKey: 'ORG_GOOGLE_ID',
      clientSecretKey: 'ORG_GOOGLE_SECRET',
    };
    const merged = mergeLoginProviderConfigs([baselineGoogle, baselineGithub], [orgGoogle]);
    // google is replaced by the org config; github (baseline) survives.
    expect(merged).toEqual([orgGoogle, baselineGithub]);
  });
});

describe('getAuthConfig', () => {
  it('should be an async function', () => {
    const result = getAuthConfig({} as never);
    result.catch(() => {});
    expect(result).toBeInstanceOf(Promise);
  });

  it('should export getAuthConfig function', () => {
    expect(typeof getAuthConfig).toBe('function');
  });
});

describe('non-OIDC login provider config (PKCE / basic-auth / extra params)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collectEnabledLoginProviderConfigs threads usePkce, tokenEndpointAuthMethod and authParams', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configs = collectEnabledLoginProviderConfigs([
      {
        key: 'custom.pkce',
        auth_schema: {
          methods: [
            {
              type: 'oauth',
              provider: 'custompkce',
              loginScopes: ['openid', 'email'],
              authorizationUrl: 'https://idp.example.com/authorize',
              tokenUrl: 'https://idp.example.com/token',
              userinfoUrl: 'https://idp.example.com/userinfo',
              tokenEndpointAuthMethod: 'client_secret_basic',
              usePkce: true,
              authParams: { prompt: 'consent', access_type: 'offline' },
            },
          ],
        },
      },
    ]);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      provider: 'custompkce',
      tokenEndpointAuthMethod: 'client_secret_basic',
      usePkce: true,
      authParams: { prompt: 'consent', access_type: 'offline' },
    });
  });

  const baseRow: EnabledLoginProviderConfig = {
    connectorKey: 'custom.pkce',
    provider: 'custompkce',
    displayName: 'Custom PKCE',
    faviconDomain: null,
    loginScopes: ['openid', 'email'],
    clientIdKey: 'CUSTOMPKCE_CLIENT_ID',
    clientSecretKey: 'CUSTOMPKCE_CLIENT_SECRET',
    authorizationUrl: 'https://idp.example.com/authorize',
    tokenUrl: 'https://idp.example.com/token',
    userinfoUrl: 'https://idp.example.com/userinfo',
  };

  it('buildGenericOAuthEntry threads pkce + basic authentication + authorizationUrlParams', () => {
    const entry = buildGenericOAuthEntry(
      {
        ...baseRow,
        tokenEndpointAuthMethod: 'client_secret_basic',
        usePkce: true,
        authParams: { prompt: 'consent' },
      },
      'cid',
      'secret'
    );
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      providerId: 'custompkce',
      clientId: 'cid',
      clientSecret: 'secret',
      authorizationUrl: 'https://idp.example.com/authorize',
      tokenUrl: 'https://idp.example.com/token',
      userInfoUrl: 'https://idp.example.com/userinfo',
      scopes: ['openid', 'email'],
      pkce: true,
      authentication: 'basic',
      authorizationUrlParams: { prompt: 'consent' },
    });
  });

  it('maps client_secret_post → post and omits pkce/params when unset', () => {
    const entry = buildGenericOAuthEntry(
      { ...baseRow, tokenEndpointAuthMethod: 'client_secret_post' },
      'cid',
      'secret'
    );
    expect(entry?.authentication).toBe('post');
    expect(entry).not.toHaveProperty('pkce');
    expect(entry).not.toHaveProperty('authorizationUrlParams');
  });

  it('returns null (→ socialProviders route) when any endpoint is missing', () => {
    const { userinfoUrl, ...noUserinfo } = baseRow;
    expect(buildGenericOAuthEntry(noUserinfo, 'cid', 'secret')).toBeNull();
  });
});
