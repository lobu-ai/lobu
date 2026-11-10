/**
 * Connector Auth Tests
 */

import { describe, expect, it } from 'vitest';
import type { ConnectorAuthAppInstallation } from '@lobu/connector-sdk';
import {
  getAppInstallationAuthMethods,
  getOAuthAuthMethods,
  normalizeConnectorAuthSchema,
  resolveEnvHttpCredential,
} from '../connector-auth';

describe('normalizeConnectorAuthSchema', () => {
  it('should return default for null', () => {
    const result = normalizeConnectorAuthSchema(null);
    expect(result.methods).toEqual([{ type: 'none' }]);
  });

  it('should return default for undefined', () => {
    const result = normalizeConnectorAuthSchema(undefined);
    expect(result.methods).toEqual([{ type: 'none' }]);
  });

  it('should return default for empty object', () => {
    const result = normalizeConnectorAuthSchema({});
    expect(result.methods).toEqual([{ type: 'none' }]);
  });

  it('should parse valid env_keys method', () => {
    const result = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'env_keys',
          fields: [
            { key: 'API_KEY', label: 'API Key', secret: true },
            { key: 'BASE_URL', label: 'Base URL' },
          ],
        },
      ],
    });
    expect(result.methods.length).toBe(1);
    expect(result.methods[0].type).toBe('env_keys');
    const method = result.methods[0] as any;
    expect(method.fields.length).toBe(2);
    expect(method.fields[0].key).toBe('API_KEY');
    expect(method.fields[0].secret).toBe(true);
  });

  it('should parse valid oauth method', () => {
    const result = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'oauth',
          provider: 'google',
          requiredScopes: ['read', 'write'],
          authorizationUrl: 'https://example.com/authorize',
          tokenUrl: 'https://example.com/token',
          userinfoUrl: 'https://example.com/me',
          authParams: { audience: 'example-api' },
          tokenEndpointAuthMethod: 'client_secret_basic',
          usePkce: true,
          loginScopes: ['openid', 'email'],
        },
      ],
    });
    expect(result.methods.length).toBe(1);
    expect(result.methods[0].type).toBe('oauth');
    const method = result.methods[0] as any;
    expect(method.provider).toBe('google');
    expect(method.requiredScopes).toEqual(['read', 'write']);
    expect(method.authorizationUrl).toBe('https://example.com/authorize');
    expect(method.tokenUrl).toBe('https://example.com/token');
    expect(method.userinfoUrl).toBe('https://example.com/me');
    expect(method.authParams).toEqual({ audience: 'example-api' });
    expect(method.tokenEndpointAuthMethod).toBe('client_secret_basic');
    expect(method.usePkce).toBe(true);
    expect(method.loginScopes).toEqual(['openid', 'email']);
  });

  it('should parse JSON string input', () => {
    const json = JSON.stringify({
      methods: [{ type: 'none' }],
    });
    const result = normalizeConnectorAuthSchema(json);
    expect(result.methods.length).toBe(1);
    expect(result.methods[0].type).toBe('none');
  });

  it('should return default for invalid JSON string', () => {
    const result = normalizeConnectorAuthSchema('not-json');
    expect(result.methods).toEqual([{ type: 'none' }]);
  });

  it('should detect secret keys automatically', () => {
    const result = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'env_keys',
          fields: [{ key: 'client_secret' }, { key: 'api_key' }, { key: 'base_url' }],
        },
      ],
    });
    const method = result.methods[0] as any;
    expect(method.fields[0].secret).toBe(true); // client_secret
    expect(method.fields[1].secret).toBe(true); // api_key
    expect(method.fields[2].secret).toBe(false); // base_url
  });

  it('should skip fields with empty keys', () => {
    const result = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'env_keys',
          fields: [{ key: '' }, { key: 'VALID_KEY' }],
        },
      ],
    });
    const method = result.methods[0] as any;
    expect(method.fields.length).toBe(1);
    expect(method.fields[0].key).toBe('VALID_KEY');
  });

  it('should skip oauth methods with empty provider', () => {
    const result = normalizeConnectorAuthSchema({
      methods: [{ type: 'oauth', provider: '', requiredScopes: [] }],
    });
    expect(result.methods).toEqual([{ type: 'none' }]);
  });
});

describe('getOAuthAuthMethods', () => {
  it('should return only oauth methods', () => {
    const schema = normalizeConnectorAuthSchema({
      methods: [
        { type: 'none' },
        { type: 'oauth', provider: 'google', requiredScopes: ['read'] },
        { type: 'env_keys', fields: [{ key: 'API_KEY' }] },
      ],
    });
    const oauthMethods = getOAuthAuthMethods(schema);
    expect(oauthMethods.length).toBe(1);
    expect(oauthMethods[0].provider).toBe('google');
  });
});

describe('app_installation auth method', () => {
  it('preserves provider + appIdKey/privateKeyKey through normalization', () => {
    const schema = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'app_installation',
          provider: 'github',
          providerInstance: 'cloud',
          appIdKey: 'GITHUB_APP_ID',
          privateKeyKey: 'GITHUB_APP_PRIVATE_KEY',
          installUrlTemplate: 'https://github.com/apps/lobu/installations/new',
          permissions: ['issues:read'],
          events: ['issues'],
        },
      ],
    });
    const methods = getAppInstallationAuthMethods(schema);
    expect(methods.length).toBe(1);
    const m = methods[0] as ConnectorAuthAppInstallation;
    expect(m.provider).toBe('github');
    expect(m.providerInstance).toBe('cloud');
    expect(m.appIdKey).toBe('GITHUB_APP_ID');
    expect(m.privateKeyKey).toBe('GITHUB_APP_PRIVATE_KEY');
    expect(m.installUrlTemplate).toContain('installations/new');
    expect(m.permissions).toEqual(['issues:read']);
    expect(m.events).toEqual(['issues']);
  });

  it('drops an app_installation method with no provider', () => {
    const schema = normalizeConnectorAuthSchema({
      methods: [{ type: 'app_installation' }],
    });
    expect(getAppInstallationAuthMethods(schema).length).toBe(0);
    // No valid methods left → default 'none'.
    expect(schema.methods).toEqual([{ type: 'none' }]);
  });

  it('coexists with oauth + env_keys fallbacks on one connector', () => {
    const schema = normalizeConnectorAuthSchema({
      methods: [
        { type: 'app_installation', provider: 'github' },
        { type: 'oauth', provider: 'github', clientIdKey: 'GITHUB_CLIENT_ID' },
        { type: 'env_keys', fields: [{ key: 'GITHUB_TOKEN', secret: true }] },
      ],
    });
    expect(getAppInstallationAuthMethods(schema).length).toBe(1);
    expect(getOAuthAuthMethods(schema).length).toBe(1);
    expect(schema.methods.length).toBe(3);
  });
});

describe('resolveEnvHttpCredential', () => {
  const schema = (...fields: Array<Record<string, unknown>>) => ({
    methods: [{ type: 'oauth', provider: 'test', requiredScopes: [] }, { type: 'env_keys', fields }],
  });

  it('is absent unless a field declares it', () => {
    expect(resolveEnvHttpCredential(schema({ key: 'API_TOKEN' }))).toBeNull();
    expect(resolveEnvHttpCredential(null)).toBeNull();
  });

  it('defaults to an Authorization bearer and honours an override', () => {
    expect(resolveEnvHttpCredential(schema({ key: 'API_TOKEN', httpCredential: {} }))).toEqual({
      fieldKey: 'API_TOKEN', header: 'Authorization', scheme: 'Bearer',
    });
    expect(resolveEnvHttpCredential(schema({ key: 'API_TOKEN', httpCredential: { header: 'X-Api-Key', scheme: 'Token' } }))).toEqual({
      fieldKey: 'API_TOKEN', header: 'X-Api-Key', scheme: 'Token',
    });
  });

  it.each([
    'Host', 'cookie', 'Set-Cookie', 'Content-Length', 'Transfer-Encoding', 'Proxy-Authorization',
    'X Api', 'X-Api:Key', 'X-Api\r\nInjected: 1', 'Authörization',
  ])('rejects header %j', (header) => {
    expect(() => resolveEnvHttpCredential(schema({ key: 'API_TOKEN', httpCredential: { header } }))).toThrow(/header/);
  });

  it.each(['Bearer token', 'Bearer\r\nX: 1'])('rejects scheme %j', (scheme) => {
    expect(() => resolveEnvHttpCredential(schema({ key: 'API_TOKEN', httpCredential: { scheme } }))).toThrow(/scheme/);
  });

  it('allows at most one credential field per connector', () => {
    expect(() => resolveEnvHttpCredential({
      methods: [
        { type: 'env_keys', fields: [{ key: 'A', httpCredential: {} }] },
        { type: 'env_keys', fields: [{ key: 'B', httpCredential: {} }] },
      ],
    })).toThrow(/At most one/);
  });
});
