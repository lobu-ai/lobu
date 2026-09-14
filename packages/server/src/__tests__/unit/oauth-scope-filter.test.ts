import { describe, expect, it } from 'bun:test';
import {
  canonicalizeOAuthScopeGrant,
  DISCOVERY_SCOPES,
  filterScopeByRole,
  isOAuthScopeGrantWithinRequest,
  NON_PUBLIC_OAUTH_SCOPES,
  AVAILABLE_SCOPES,
  filterRequestedScopes,
  narrowAuthorizationCodeScopes,
  normalizeOAuthScopeRequest,
  registrableScopesFor,
  stripNonPublicOAuthScopes,
} from '../../auth/oauth/scopes';

describe('DISCOVERY_SCOPES', () => {
  it('excludes first-party-only scopes that third-party MCP clients must not request', () => {
    expect(DISCOVERY_SCOPES).toContain('mcp:read');
    expect(DISCOVERY_SCOPES).toContain('mcp:write');
    expect(DISCOVERY_SCOPES).toContain('mcp:admin');
    expect(DISCOVERY_SCOPES).toContain('profile:read');
    for (const scope of NON_PUBLIC_OAUTH_SCOPES) {
      expect(DISCOVERY_SCOPES).not.toContain(scope);
    }
  });
});

describe('stripNonPublicOAuthScopes', () => {
  it('strips device_worker:run and connections:token from a Slack-style full-list request', () => {
    const result = stripNonPublicOAuthScopes(
      'mcp:read mcp:write mcp:admin profile:read device_worker:run connections:token'
    );
    expect(result).toBe('mcp:read mcp:write mcp:admin profile:read');
  });

  it('returns empty string when only non-public scopes were requested', () => {
    expect(stripNonPublicOAuthScopes('device_worker:run connections:token')).toBe('');
  });

  it('passes public scopes through unchanged', () => {
    expect(stripNonPublicOAuthScopes('mcp:read mcp:write profile:read')).toBe(
      'mcp:read mcp:write profile:read'
    );
  });
});

describe('OAuth scope grant normalization', () => {
  it('rejects unknown requested scopes at the OAuth boundary', () => {
    expect(normalizeOAuthScopeRequest('mcp:read invented:scope')).toBeNull();
    expect(normalizeOAuthScopeRequest('mcp:read profile:read')).toBe(
      'mcp:read profile:read'
    );
  });

  it('treats MCP access as a hierarchy when reducing consent', () => {
    expect(isOAuthScopeGrantWithinRequest('mcp:read mcp:write', 'mcp:read')).toBe(true);
    expect(isOAuthScopeGrantWithinRequest('mcp:write', 'mcp:read')).toBe(true);
    expect(isOAuthScopeGrantWithinRequest('mcp:read', 'mcp:write')).toBe(false);
    expect(isOAuthScopeGrantWithinRequest('mcp:admin profile:read', 'mcp:write')).toBe(true);
    expect(
      isOAuthScopeGrantWithinRequest('mcp:admin', 'mcp:read connections:token')
    ).toBe(false);
  });

  it('persists the hierarchy explicitly', () => {
    expect(canonicalizeOAuthScopeGrant('mcp:write profile:read')).toBe(
      'mcp:read mcp:write profile:read'
    );
    expect(canonicalizeOAuthScopeGrant('mcp:admin connections:token')).toBe(
      'mcp:read mcp:write mcp:admin connections:token'
    );
  });
});

describe('filterScopeByRole', () => {
  it('keeps mcp:admin when the user is an owner', () => {
    const result = filterScopeByRole('mcp:read mcp:write mcp:admin profile:read', 'owner');
    expect(result).not.toBeNull();
    expect((result as string).split(' ')).toContain('mcp:admin');
    expect((result as string).split(' ')).toContain('mcp:write');
    expect((result as string).split(' ')).toContain('mcp:read');
    expect((result as string).split(' ')).toContain('profile:read');
  });

  it('keeps mcp:admin when the user is an admin', () => {
    const result = filterScopeByRole('mcp:read mcp:write mcp:admin profile:read', 'admin');
    expect(result).not.toBeNull();
    expect((result as string).split(' ')).toContain('mcp:admin');
  });

  it('strips mcp:admin when the user is a regular member', () => {
    const result = filterScopeByRole('mcp:read mcp:write mcp:admin profile:read', 'member');
    expect(result).not.toBeNull();
    expect((result as string).split(' ')).not.toContain('mcp:admin');
    expect((result as string).split(' ')).toContain('mcp:write');
    expect((result as string).split(' ')).toContain('mcp:read');
    expect((result as string).split(' ')).toContain('profile:read');
  });

  it('strips mcp:admin when the user has no membership', () => {
    const result = filterScopeByRole('mcp:read mcp:admin', null);
    expect(result).not.toBeNull();
    expect((result as string).split(' ')).not.toContain('mcp:admin');
    expect((result as string).split(' ')).toContain('mcp:read');
  });

  it('passes through non-admin scopes unchanged for any role', () => {
    const result = filterScopeByRole('mcp:read mcp:write profile:read', 'member');
    expect(result).toBe('mcp:read mcp:write profile:read');
  });

  it('returns empty string when no scope is requested at all', () => {
    expect(filterScopeByRole('', 'member')).toBe('');
    expect(filterScopeByRole(null, 'member')).toBe('');
    expect(filterScopeByRole(undefined, 'owner')).toBe('');
  });

  it('returns null when filtering wipes out a non-empty admin-only request for non-admins', () => {
    // A non-admin requesting only mcp:admin must NOT silently get an empty
    // grant — the OAuth code path stores empty scope as null, which
    // downstream parsing treats as the default scope set, unintentionally
    // granting mcp:read mcp:write. Returning null forces the caller to
    // reject with invalid_scope (RFC 6749 §4.1.2.1).
    expect(filterScopeByRole('mcp:admin', 'member')).toBeNull();
    expect(filterScopeByRole('mcp:admin', null)).toBeNull();
    expect(filterScopeByRole('  mcp:admin  ', 'member')).toBeNull();
  });

  it('returns the scope string when admins request only mcp:admin', () => {
    expect(filterScopeByRole('mcp:admin', 'owner')).toBe('mcp:admin');
    expect(filterScopeByRole('mcp:admin', 'admin')).toBe('mcp:admin');
  });

  it('collapses extra whitespace', () => {
    const result = filterScopeByRole('  mcp:read   mcp:admin   ', 'owner');
    expect(result).toBe('mcp:read mcp:admin');
  });

  it('preserves an explicitly-requested connections:token for any role', () => {
    // `lobu login` requests `connections:token` explicitly; role filtering only
    // strips `mcp:admin`, so a regular member's login still carries it.
    const member = filterScopeByRole(
      'mcp:read mcp:write profile:read connections:token',
      'member'
    );
    expect((member as string).split(' ')).toContain('connections:token');
    expect((member as string).split(' ')).not.toContain('mcp:admin');

    const owner = filterScopeByRole(
      'mcp:read mcp:write mcp:admin connections:token',
      'owner'
    );
    expect((owner as string).split(' ')).toContain('connections:token');
    expect((owner as string).split(' ')).toContain('mcp:admin');
  });
});

describe('filterRequestedScopes', () => {
  // The /oauth/authorize endpoint takes a STRANGER's scope string. Slack,
  // Claude Desktop and Cursor all append standard OIDC scopes that Lobu has
  // never issued. Rejecting the whole request over one of them breaks the
  // integration; narrowing it just grants less.
  it('keeps grantable scopes and ignores OIDC scopes Lobu does not issue', () => {
    expect(filterRequestedScopes('openid email profile offline_access mcp:read', DISCOVERY_SCOPES)).toBe(
      'mcp:read'
    );
  });

  it('drops non-public scopes without needing stripNonPublicOAuthScopes first', () => {
    expect(filterRequestedScopes('mcp:read device_worker:run connections:token', DISCOVERY_SCOPES)).toBe(
      'mcp:read'
    );
  });

  it('returns null only when nothing requested is grantable', () => {
    expect(filterRequestedScopes('openid offline_access', DISCOVERY_SCOPES)).toBeNull();
    expect(filterRequestedScopes('', DISCOVERY_SCOPES)).toBeNull();
  });

  // The contrast that motivates the split: the strict form is still correct
  // for scope strings we generate ourselves (consent form, device flow).
  it('is deliberately more permissive than the strict normalizer', () => {
    expect(normalizeOAuthScopeRequest('openid mcp:read', DISCOVERY_SCOPES)).toBeNull();
    expect(filterRequestedScopes('openid mcp:read', DISCOVERY_SCOPES)).toBe('mcp:read');
  });
});

describe('filterRequestedScopes on the device flow', () => {
  // Device-code registration is open (DCR), so this scope string comes from a
  // stranger too — but the device flow may legitimately grant the non-public
  // scopes when a client asks for them explicitly, gated by the user's
  // device-code consent. So it filters against AVAILABLE_SCOPES, not
  // DISCOVERY_SCOPES.
  it('keeps explicitly requested non-public scopes that the authorize path drops', () => {
    expect(filterRequestedScopes('mcp:read connections:token', AVAILABLE_SCOPES)).toBe(
      'mcp:read connections:token'
    );
    expect(filterRequestedScopes('mcp:read connections:token', DISCOVERY_SCOPES)).toBe('mcp:read');
  });

  it('still ignores OIDC scopes rather than failing the device authorization', () => {
    expect(filterRequestedScopes('openid offline_access mcp:read', AVAILABLE_SCOPES)).toBe(
      'mcp:read'
    );
  });
});

describe('registrableScopesFor', () => {
  it('never lets an authorization-code client register a device-flow-only scope', () => {
    const registrable = registrableScopesFor(false);
    for (const scope of NON_PUBLIC_OAUTH_SCOPES) {
      expect(registrable).not.toContain(scope);
    }
  });

  it('lets a device-code client register them, since its consent is the boundary', () => {
    const registrable = registrableScopesFor(true);
    for (const scope of NON_PUBLIC_OAUTH_SCOPES) {
      expect(registrable).toContain(scope);
    }
  });

  // THE GUARD. A DCR client is held to the scope it registered with, so
  // registration must never promise something authorization will not deliver.
  // If a future change moves a scope out of DISCOVERY_SCOPES without moving it
  // out of what /oauth/register hands back, this fails instead of silently
  // wedging every client that registers afterwards.
  it('only registers scopes the authorization-code flow will grant back in full', () => {
    for (const scope of registrableScopesFor(false)) {
      expect(narrowAuthorizationCodeScopes(scope)).toEqual({ scope });
    }
    expect(narrowAuthorizationCodeScopes(registrableScopesFor(false).join(' '))).toEqual({
      scope: registrableScopesFor(false).join(' '),
    });
  });
});

describe('narrowAuthorizationCodeScopes', () => {
  // The literal string Slack's DCR client sent on 2026-09-13. It registered
  // while discovery still advertised all six (before #1901, 2026-07-13), so it
  // asked for all six forever, was silently handed four, and refused the
  // connection with "you didn't select all the required permissions" — while
  // every server-side hop logged 200.
  const SLACK_REQUEST =
    'mcp:read mcp:write mcp:admin profile:read device_worker:run connections:token';

  it('rejects the stale Slack request loudly instead of silently reducing it', () => {
    const result = narrowAuthorizationCodeScopes(SLACK_REQUEST);
    expect(result).toEqual({
      error: 'non_public',
      scopes: ['device_worker:run', 'connections:token'],
    });
  });

  it('names every offending scope so the error is diagnosable in one line', () => {
    expect(narrowAuthorizationCodeScopes('mcp:read connections:token')).toEqual({
      error: 'non_public',
      scopes: ['connections:token'],
    });
  });

  it('still DROPS unknown scopes — strangers send OIDC dialect we never issue', () => {
    expect(narrowAuthorizationCodeScopes('openid email profile offline_access mcp:read')).toEqual({
      scope: 'mcp:read',
    });
  });

  it('reports an empty request when nothing asked for is grantable', () => {
    expect(narrowAuthorizationCodeScopes('openid offline_access')).toEqual({ error: 'empty' });
    expect(narrowAuthorizationCodeScopes('')).toEqual({ error: 'empty' });
  });

  it('passes a well-formed public request through untouched', () => {
    expect(narrowAuthorizationCodeScopes('mcp:read mcp:write profile:read')).toEqual({
      scope: 'mcp:read mcp:write profile:read',
    });
  });
});

describe('discovery scope stability', () => {
  // Changing this literal is a MIGRATION, not an edit.
  //
  // A DCR client is held to the scope it registered with, and it only
  // re-registers when the resource returns 401 — a scope mismatch never gets
  // that far, because the client rejects the narrower token client-side after a
  // successful exchange. So REMOVING a scope here strands every client that
  // registered while it was advertised: they go on asking for the old set
  // forever, and nothing short of re-registration recovers them.
  //
  // That is exactly how Slack broke. Discovery advertised six scopes until
  // #1901 (2026-07-13) shrank the list to four; Slack had registered against
  // the six and went on requesting them, so its connection wedged while every
  // hop kept returning 200.
  //
  // Adding a scope is safe. Before removing one, work out how already-
  // registered clients will re-register — then update this list.
  it('advertises exactly this set — shrinking it strands already-registered clients', () => {
    expect([...DISCOVERY_SCOPES]).toEqual([
      'mcp:read',
      'mcp:write',
      'mcp:admin',
      'profile:read',
    ]);
  });
});
