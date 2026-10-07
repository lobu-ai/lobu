import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
const PROFILE = 'https://www.googleapis.com/auth/userinfo.profile';

describe('OAuth scope reconciliation', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock('../../db/client');
    vi.doUnmock('../auth-profiles');
    vi.resetModules();
  });

  it.each([
    { isolated: false, declared: ['email', 'profile'], granted: [EMAIL, PROFILE], status: 'active' },
    { isolated: false, declared: [EMAIL, PROFILE], granted: ['email', 'profile'], status: 'active' },
    { isolated: true, declared: ['email', 'profile'], granted: [EMAIL, PROFILE], status: 'active' },
    { isolated: false, declared: ['email', 'profile'], granted: [EMAIL], status: 'pending_auth' },
    { isolated: true, declared: ['email', 'profile'], granted: [EMAIL], status: 'pending_auth' },
  ])('preserves aliases and connector grants: %j', async ({ isolated, declared, granted, status }) => {
    const profile = {
      id: 1, slug: 'synthetic-profile', connector_key: 'synthetic.oauth',
      profile_kind: 'oauth_account', provider: 'synthetic', account_id: 'synthetic-account',
      status: 'active',
      auth_data: { requested_scopes: [...declared, ...(isolated ? [] : ['sibling.read'])] },
    };
    // Shared profiles may already contain sibling requests from old logins.
    // Isolated accounts retain even grants missing from profile metadata.
    const accountScopes = [
      ...granted, 'optional.read', 'feed.read', 'retired.read',
      ...(isolated ? [] : ['sibling.read']),
    ];
    const updateAuthProfile = vi.fn();
    const sql = vi.fn(async (parts: TemplateStringsArray) => {
      const query = parts.join('?');
      if (query.includes('FROM "account"')) return [{
        accountId: isolated ? 'lobu-connector:synthetic:oauth:1' : 'synthetic-provider-user',
        scope: accountScopes.join(' '),
      }];
      if (query.includes('FROM connector_definitions')) return [{
        auth_schema: { methods: [{ type: 'oauth', provider: 'synthetic',
          requiredScopes: declared, optionalScopes: ['optional.read', 'not-granted.read'] }] },
        feeds_schema: { items: { requiredScopes: ['feed.read'] } },
      }];
      if (query.includes('FROM feeds') || query.includes('FROM connections')) return [];
      throw new Error(`Unexpected query: ${query}`);
    });
    vi.doMock('../../db/client', () => ({ getDb: () => sql }));
    vi.doMock('../auth-profiles', () => ({
      getAuthProfileById: async () => profile,
      updateAuthProfile,
    }));
    const { syncOAuthConnectionsForAuthProfile } = await import('../oauth-connection-state');
    await syncOAuthConnectionsForAuthProfile('synthetic-org', profile.id);
    expect(updateAuthProfile).toHaveBeenCalledWith(expect.objectContaining({
      status,
      authData: {
        ...profile.auth_data,
        granted_scopes: [...granted, 'optional.read', 'feed.read', ...(isolated ? ['retired.read'] : [])],
      },
    }));
  });
});
