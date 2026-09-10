import { describe, expect, test } from 'vitest';
import { __connectorOperationsTestOnly as api } from '../connector-operations';
import { __httpOperationTestOnly as http } from '../execute-http-operation';

describe('OpenAPI schema contract', () => {
  test('requires the query section when a provider requires a query parameter', () => {
    const schema = api.getOperationInputSchema(
      {},
      [],
      [{ name: 'min_created', in: 'query', required: true, schema: { type: 'integer' } }],
      undefined,
      undefined,
    );
    expect(schema?.required).toContain('query');
  });

  test('requires the headers section when a provider requires a header', () => {
    const schema = api.getOperationInputSchema(
      {},
      [],
      [{ name: 'version', in: 'header', required: true, schema: { type: 'string' } }],
      undefined,
      undefined,
    );
    expect(schema?.required).toContain('headers');
  });

  test('hides a header the gateway renders from credentials', () => {
    const schema = api.getOperationInputSchema(
      {},
      [],
      [{ name: 'x-api-key', in: 'header', required: true, schema: { type: 'string' } }],
      undefined,
      { 'X-API-Key': '{{API_KEY}}' },
    );
    expect(schema).toBeUndefined();
  });

  test('operation parameters override inherited parameters by name and location', () => {
    const schema = api.getOperationInputSchema(
      {},
      [{ name: 'page', in: 'query', required: true, schema: { type: 'integer' } }],
      [{ name: 'page', in: 'query', required: false, schema: { type: 'integer' } }],
      undefined,
      undefined,
    );
    const query = (schema?.properties as Record<string, { required?: string[] }>).query;
    expect(query.required ?? []).not.toContain('page');
    expect(schema?.required ?? []).not.toContain('query');
  });
});

describe('OpenAPI scope requirements', () => {
  const spec = {
    components: {
      securitySchemes: { account: { type: 'oauth2' }, key: { type: 'apiKey' } },
    },
    security: [{ account: ['read'] }],
  };

  test('inherits scopes and respects operation overrides', () => {
    expect(api.getOpenApiScopes(spec, {})).toEqual(['read']);
    expect(api.getOpenApiScopes(spec, { security: [{ account: ['orders'], key: [] }] })).toEqual([
      'orders',
    ]);
    expect(api.getOpenApiScopes(spec, { security: [] })).toEqual([]);
  });

  test('enforces only what every alternative requirement demands', () => {
    // Alternatives are an OR: an api-key-authorized call needs no scope, so
    // requiring the oauth2 arm's scopes would block it.
    expect(api.getOpenApiScopes(spec, { security: [{ key: [] }, { account: ['read'] }] })).toEqual(
      [],
    );
    expect(
      api.getOpenApiScopes(spec, {
        security: [{ account: ['read', 'orders'] }, { account: ['read'] }],
      }),
    ).toEqual(['read']);
  });
});

describe('host credential header templates', () => {
  test('combines selected credentials and refuses missing values or reserved headers', () => {
    expect(
      http
        .renderCredentialHeaders(
          { 'x-api-key': '{{KEY}}:{{SECRET}}' },
          { KEY: 'synthetic-key', SECRET: 'synthetic-secret' },
        )
        .get('x-api-key'),
    ).toBe('synthetic-key:synthetic-secret');
    expect(() => http.renderCredentialHeaders({ 'x-api-key': '{{MISSING}}' }, {})).toThrow(
      "Required app credential 'MISSING' is unavailable",
    );
    expect(() =>
      http.renderCredentialHeaders({ Authorization: '{{KEY}}' }, { KEY: 'synthetic-key' }),
    ).toThrow('Reserved credential header');
  });
});
