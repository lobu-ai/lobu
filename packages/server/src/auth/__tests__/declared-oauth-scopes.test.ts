import { describe, expect, it } from 'vitest';
import { getOAuthAuthMethods, normalizeConnectorAuthSchema } from '../../utils/connector-auth';
import { listCatalogConnectorDefinitions } from '../../utils/connector-catalog';
import { declaredOAuthScopes } from '../oauth/scopes';

const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';

describe('declaredOAuthScopes', () => {
  it('unions login, required, optional and keyed feed scopes in declaration order', () => {
    expect(
      declaredOAuthScopes(
        {
          loginScopes: ['openid', 'email'],
          requiredScopes: [DRIVE_READONLY],
          optionalScopes: [DRIVE_FILE],
        },
        { files: { requiredScopes: ['feed.read'] }, media: { requiredScopes: ['media.read'] } }
      )
    ).toEqual(['openid', 'email', DRIVE_READONLY, DRIVE_FILE, 'feed.read', 'media.read']);
  });

  it('counts optional scopes as declared even when nothing requests them', () => {
    const declared = declaredOAuthScopes(
      { requiredScopes: [DRIVE_READONLY], optionalScopes: [DRIVE_FILE] },
      null
    );
    expect(declared).toContain(DRIVE_FILE);
  });

  it('reads feed requirements from list-shaped schemas too', () => {
    expect(
      declaredOAuthScopes({ requiredScopes: ['base'] }, [
        { key: 'items', requiredScopes: ['items.read'] },
        { key: 'media', requiredScopes: ['media.read', 'items.read'] },
      ])
    ).toEqual(['base', 'items.read', 'media.read']);
  });

  it('dedupes across sources and trims whitespace', () => {
    expect(
      declaredOAuthScopes(
        { loginScopes: ['openid', ' email '], requiredScopes: 'openid profile', optionalScopes: ['profile'] },
        { items: { requiredScopes: ['email', ''] } }
      )
    ).toEqual(['openid', 'email', 'profile']);
  });

  it('returns nothing for a missing method, malformed scope fields and an empty feeds schema', () => {
    expect(declaredOAuthScopes(null, null)).toEqual([]);
    expect(declaredOAuthScopes(undefined, {})).toEqual([]);
    expect(
      declaredOAuthScopes({ loginScopes: 42, requiredScopes: { not: 'a list' } }, { items: {} })
    ).toEqual([]);
  });
});

describe('declaredOAuthScopes across bundled connectors', () => {
  it('equals the login + required + optional + feed union for every bundled OAuth method', async () => {
    const definitions = await listCatalogConnectorDefinitions();
    const checked: string[] = [];
    let withLogin = 0;
    let withOptional = 0;
    let withFeedScopes = 0;

    for (const definition of definitions) {
      const methods = getOAuthAuthMethods(normalizeConnectorAuthSchema(definition.auth_schema));
      for (const method of methods) {
        // Expected set built from the definition itself, the way each former
        // call site spelled it out by hand: trimmed, deduped, declaration order.
        const feedScopes = Object.values(definition.feeds_schema ?? {}).flatMap((feed) => {
          const scopes = (feed as { requiredScopes?: unknown } | null)?.requiredScopes;
          return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [];
        });
        const expected = [
          ...new Set(
            [
              ...(method.loginScopes ?? []),
              ...method.requiredScopes,
              ...(method.optionalScopes ?? []),
              ...feedScopes,
            ]
              .map((scope) => scope.trim())
              .filter(Boolean)
          ),
        ];

        const label = `${definition.key}/${method.provider}`;
        expect(declaredOAuthScopes(method, definition.feeds_schema), label).toEqual(expected);
        checked.push(label);
        if ((method.loginScopes ?? []).length > 0) withLogin += 1;
        if ((method.optionalScopes ?? []).length > 0) withOptional += 1;
        if (feedScopes.length > 0) withFeedScopes += 1;
      }
    }

    // The class is not vacuous: every scope source the helper unions is
    // exercised by at least one bundled connector.
    expect(checked.length).toBeGreaterThan(0);
    expect(withLogin).toBeGreaterThan(0);
    expect(withOptional).toBeGreaterThan(0);
    expect(withFeedScopes).toBeGreaterThan(0);
  });
});
