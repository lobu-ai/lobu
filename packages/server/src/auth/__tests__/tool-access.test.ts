/**
 * Tool Access Tests
 *
 * Tests for requiresOwnerAdmin and isPublicReadable authorization checks.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ToolNotRegisteredError } from '../../utils/errors';
import { routeAction } from '../../tools/admin/action-router';
import { type AuthContext, checkToolAccess, extractAuthContext } from '../../tools/execute';
import {
  getAllTools,
  getTool,
  isAuthorizationReadOnly,
  type ToolContext,
} from '../../tools/registry';
import {
  getRequiredAccessLevel,
  hasRequiredMcpScope,
  isPublicReadable,
  requiresMemberWrite,
  requiresOwnerAdmin,
  resolveMaxAccessLevel,
  resolveSdkMaxAccessLevel,
  SCOPE_CHECK_NOT_APPLICABLE,
} from '../tool-access';

describe('requiresOwnerAdmin', () => {
  it('treats query_sql as read-tier — members may query; sensitive tables gated per-query', () => {
    expect(requiresOwnerAdmin('query_sql', {}, true)).toBe(false);
  });

  it('should require admin for destructive and bulk manage_entity actions', () => {
    expect(requiresOwnerAdmin('manage_entity', { action: 'create' }, false)).toBe(false);
    expect(requiresOwnerAdmin('manage_entity', { action: 'update' }, false)).toBe(false);
    expect(requiresOwnerAdmin('manage_entity', { action: 'delete' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_entity', { action: 'merge' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_entity', { action: 'resolve_duplicates' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_entity', { action: 'unmerge' }, false)).toBe(true);
  });

  it('should not require admin for read-only manage_entity actions', () => {
    expect(requiresOwnerAdmin('manage_entity', { action: 'list' }, true)).toBe(false);
    expect(requiresOwnerAdmin('manage_entity', { action: 'get' }, true)).toBe(false);
  });

  it('should require admin for manage_classifiers mutating actions', () => {
    expect(requiresOwnerAdmin('manage_classifiers', { action: 'create' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_classifiers', { action: 'classify' }, false)).toBe(true);
    // `apply` writes event_classifications in bulk. The pinned access-matrix
    // fixture would also catch a regression, but it is a snapshot — this states
    // the requirement directly, and names the tier a reader should expect.
    expect(requiresOwnerAdmin('manage_classifiers', { action: 'apply' }, false)).toBe(true);
    expect(isPublicReadable('manage_classifiers', { action: 'apply' })).toBe(false);
  });

  it('should NOT require admin for manage_operations execute; it is member-write (handler re-checks per-principal visibility)', () => {
    // Members run connector operations on connections VISIBLE to them; the
    // execute handler re-runs the per-principal visibility query and every
    // existing gate (active status, action_modes, connector_action policy).
    expect(requiresOwnerAdmin('manage_operations', { action: 'execute' }, false)).toBe(false);
    expect(requiresMemberWrite('manage_operations', { action: 'execute' }, false)).toBe(true);
    // Owner-routed approvals: the recorded field owner (a plain member) may
    // decide their own entity-change run, so approve/reject sit at write tier
    // and manage_operations enforces admin-or-run-owner per run.
    expect(requiresOwnerAdmin('manage_operations', { action: 'approve' }, false)).toBe(false);
    expect(requiresMemberWrite('manage_operations', { action: 'approve' }, false)).toBe(true);
    expect(requiresMemberWrite('manage_operations', { action: 'reject' }, false)).toBe(true);
  });

  it('should require admin for manage_connections login and connector mutations', () => {
    expect(
      requiresOwnerAdmin('manage_connections', { action: 'toggle_connector_login' }, false)
    ).toBe(true);
    expect(
      requiresOwnerAdmin('manage_connections', { action: 'update_connector_auth' }, false)
    ).toBe(true);
    expect(
      requiresOwnerAdmin('manage_connections', { action: 'update_connector_default_config' }, false)
    ).toBe(true);
  });

  it('should allow members to create, managed-connect, and reauthenticate their own connections', () => {
    // `manage_connections.create`, `connect_managed`, and `reauthenticate` are member-write; the
    // handler enforces app_auth_profile_slug must match the org default for
    // non-admins, so non-admins can't bring an alternate OAuth client.
    expect(requiresOwnerAdmin('manage_connections', { action: 'create' }, false)).toBe(false);
    expect(requiresMemberWrite('manage_connections', { action: 'create' }, false)).toBe(true);
    expect(
      requiresOwnerAdmin('manage_connections', { action: 'connect_managed' }, false)
    ).toBe(false);
    expect(
      requiresMemberWrite('manage_connections', { action: 'connect_managed' }, false)
    ).toBe(true);
    expect(requiresOwnerAdmin('manage_connections', { action: 'reauthenticate' }, false)).toBe(
      false
    );
    expect(requiresMemberWrite('manage_connections', { action: 'reauthenticate' }, false)).toBe(
      true
    );
  });

  it('should allow public auth profile metadata reads and require admin for sensitive actions', () => {
    expect(requiresOwnerAdmin('manage_auth_profiles', { action: 'get_auth_profile' }, false)).toBe(
      false
    );
    expect(
      getRequiredAccessLevel('manage_auth_profiles', { action: 'get_auth_profile' }, false)
    ).toBe('read');
    expect(isPublicReadable('manage_auth_profiles', { action: 'get_auth_profile' })).toBe(true);
    expect(requiresOwnerAdmin('manage_auth_profiles', { action: 'test_auth_profile' }, false)).toBe(
      true
    );
    expect(
      requiresOwnerAdmin('manage_auth_profiles', { action: 'delete_auth_profile' }, false)
    ).toBe(true);
    expect(
      requiresOwnerAdmin('manage_auth_profiles', { action: 'set_default_auth_profile' }, false)
    ).toBe(true);
  });

  it('should allow members to create their own oauth_account profile', () => {
    // create_auth_profile / update_auth_profile are member-write at the
    // policy layer; the handler gates by profile_kind so non-oauth_account
    // kinds (env, oauth_app, browser_session) stay admin-only.
    expect(
      requiresOwnerAdmin('manage_auth_profiles', { action: 'create_auth_profile' }, false)
    ).toBe(false);
    expect(
      requiresMemberWrite('manage_auth_profiles', { action: 'create_auth_profile' }, false)
    ).toBe(true);
    expect(
      requiresOwnerAdmin('manage_auth_profiles', { action: 'update_auth_profile' }, false)
    ).toBe(false);
    expect(
      requiresMemberWrite('manage_auth_profiles', { action: 'update_auth_profile' }, false)
    ).toBe(true);
  });

  it('should require admin for manage_feeds mutations', () => {
    expect(requiresOwnerAdmin('manage_feeds', { action: 'create_feed' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_feeds', { action: 'trigger_feed' }, false)).toBe(true);
  });

  it('should require admin for manage_automations mutating actions', () => {
    expect(requiresOwnerAdmin('manage_automations', { action: 'create' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_automations', { action: 'create_version' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_automations', { action: 'set_reaction_script' }, false)).toBe(
      true
    );
    // `trigger` is write-tier (manual activation — the open execution lane),
    // guarded per-automation by requireAutomationAccess in the handler, like
    // `claim_next_window` and `complete_window`. It is execution, not administration.
    expect(requiresOwnerAdmin('manage_automations', { action: 'trigger' }, false)).toBe(false);
    expect(requiresOwnerAdmin('manage_automations', { action: 'claim_next_window' }, false)).toBe(
      false
    );
    expect(requiresOwnerAdmin('manage_automations', { action: 'create_from_version' }, false)).toBe(
      true
    );
  });

  it('should not require admin for manage_automations read actions', () => {
    expect(requiresOwnerAdmin('manage_automations', { action: 'get_versions' }, false)).toBe(false);
    expect(requiresOwnerAdmin('manage_automations', { action: 'get_version_details' }, false)).toBe(
      false
    );
    expect(
      requiresOwnerAdmin('manage_automations', { action: 'get_component_reference' }, false)
    ).toBe(false);
    expect(requiresOwnerAdmin('manage_automations', { action: 'get_feedback' }, false)).toBe(false);
  });

  it('should require admin for view template mutations while leaving reads as read-tier', () => {
    expect(requiresOwnerAdmin('manage_view_templates', { action: 'set' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_view_templates', { action: 'rollback' }, false)).toBe(true);
    expect(requiresOwnerAdmin('manage_view_templates', { action: 'get' }, false)).toBe(false);
  });

  it('treats manage_catalog list actions as READ-tier so a default mcp:read token can discover connectors', () => {
    // Both actions are read-only (no writes exist). Previously manage_catalog had
    // no policy entry, so the no-policy fallback classified them admin — a default
    // `lobu token create` token (mcp:read mcp:write) then couldn't discover
    // connectors at all.
    expect(requiresOwnerAdmin('manage_catalog', { action: 'list_installed' }, false)).toBe(false);
    expect(requiresOwnerAdmin('manage_catalog', { action: 'list_catalog' }, false)).toBe(false);
    expect(getRequiredAccessLevel('manage_catalog', { action: 'list_installed' }, false)).toBe(
      'read'
    );
    expect(getRequiredAccessLevel('manage_catalog', { action: 'list_catalog' }, false)).toBe(
      'read'
    );
  });
});

describe('member write access', () => {
  it('should allow members to save memory', () => {
    expect(requiresMemberWrite('save_memory', {}, false)).toBe(true);
    expect(getRequiredAccessLevel('save_memory', {}, false)).toBe('write');
    expect(requiresMemberWrite('resolve_approval', {}, false)).toBe(true);
    expect(getRequiredAccessLevel('resolve_approval', {}, false)).toBe('write');
    expect(requiresMemberWrite('run_sdk', {}, false)).toBe(true);
    expect(getRequiredAccessLevel('run_sdk', {}, false)).toBe('write');
  });

  it('should allow members to create and update entities without admin role', () => {
    expect(requiresMemberWrite('manage_entity', { action: 'create' }, false)).toBe(true);
    expect(requiresMemberWrite('manage_entity', { action: 'update' }, false)).toBe(true);
    expect(requiresMemberWrite('manage_entity', { action: 'link' }, false)).toBe(true);
    expect(getRequiredAccessLevel('manage_entity', { action: 'create' }, false)).toBe('write');
  });

  it('should keep destructive and bulk entity actions as admin-only', () => {
    expect(requiresMemberWrite('manage_entity', { action: 'delete' }, false)).toBe(false);
    expect(getRequiredAccessLevel('manage_entity', { action: 'delete' }, false)).toBe('admin');
    expect(getRequiredAccessLevel('manage_entity', { action: 'resolve_duplicates' }, false)).toBe(
      'admin'
    );
  });
});

describe('extractAuthContext scopes (F8 source side)', () => {
  type FakeVars = {
    mcpAuthInfo?: {
      scopes?: string[];
      userId?: string;
      clientId?: string;
    } | null;
    session?: { userId?: string } | null;
    organizationId?: string | null;
    memberRole?: string | null;
    mcpIsAuthenticated?: boolean;
  };

  function fakeCtx(vars: FakeVars, url = 'http://localhost/mcp/acme') {
    return {
      req: {
        url,
        param: (_k: string) => undefined,
        header: (_k: string) => undefined,
      },
      var: vars,
    } as unknown as Parameters<typeof extractAuthContext>[0];
  }

  it('passes real token scopes through for oauth/pat callers', () => {
    const ctx = extractAuthContext(
      fakeCtx({
        mcpAuthInfo: { scopes: ['mcp:read', 'mcp:write'], userId: 'u1' },
        mcpIsAuthenticated: true,
        organizationId: 'org_1',
      })
    );
    expect(ctx.scopes).toEqual(['mcp:read', 'mcp:write']);
  });

  it('emits [] (denies) for a token minted with no scopes — never the bypass sentinel', () => {
    const ctx = extractAuthContext(
      fakeCtx({ mcpAuthInfo: { userId: 'u1' }, mcpIsAuthenticated: true })
    );
    expect(ctx.scopes).toEqual([]);
    expect(hasRequiredMcpScope('read', ctx.scopes)).toBe(false);
  });

  it('emits the not-applicable sentinel for a session caller (no mcpAuthInfo)', () => {
    const ctx = extractAuthContext(
      fakeCtx({
        mcpAuthInfo: null,
        session: { userId: 'u1' },
        mcpIsAuthenticated: true,
      })
    );
    expect(ctx.scopes).toEqual([...SCOPE_CHECK_NOT_APPLICABLE]);
  });

  it('emits the not-applicable sentinel for anonymous callers', () => {
    const ctx = extractAuthContext(fakeCtx({ mcpAuthInfo: null, session: null }));
    expect(ctx.scopes).toEqual([...SCOPE_CHECK_NOT_APPLICABLE]);
  });
});

describe('extractAuthContext adminTools — only the verified worker allowlist rides through', () => {
  // `adminTools` is a LIMIT in checkToolAccess on ADMIN-tier actions. Under
  // the uniform surface model (no internal-tool axis) no allowlist is ever
  // DERIVED for external admin callers — role x scope already grant them every
  // tool. Only the builder worker token's per-run allowlist is carried.
  function ctxFor(opts: { scopes?: string[]; adminTools?: string[] | null; url?: string }) {
    const fake = {
      req: {
        url: opts.url ?? 'http://localhost/mcp/acme',
        param: (_k: string) => undefined,
        header: (_k: string) => undefined,
      },
      var: {
        mcpAuthInfo: {
          userId: 'u1',
          scopes: opts.scopes,
          adminTools: opts.adminTools ?? null,
        },
        mcpIsAuthenticated: true,
        organizationId: 'org_1',
      },
    } as unknown as Parameters<typeof extractAuthContext>[0];
    return extractAuthContext(fake);
  }

  it('does NOT derive an allowlist for an external /mcp admin caller (uniform surface)', () => {
    const ctx = ctxFor({ scopes: ['mcp:admin'] });
    expect(ctx.adminTools).toBeNull();
  });

  it('does NOT derive an allowlist for an admin caller on the REST proxy', () => {
    const ctx = ctxFor({
      scopes: ['mcp:admin'],
      url: 'http://localhost/api/v1/tools/manage_automations',
    });
    expect(ctx.adminTools).toBeNull();
  });

  it('carries a builder worker per-run allowlist through unchanged', () => {
    const ctx = ctxFor({
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      adminTools: ['manage_agents'],
    });
    expect(ctx.adminTools).toEqual(['manage_agents']);
  });

  it('leaves adminTools null for a non-admin /mcp caller', () => {
    const ctx = ctxFor({ scopes: ['mcp:read', 'mcp:write'] });
    expect(ctx.adminTools).toBeNull();
  });
});

describe('hasRequiredMcpScope — fail closed on null (F8)', () => {
  // SECURITY INVARIANT: a null/undefined scope set is an under-specified
  // caller, NOT a grant of full access. Before the fix this returned `true`,
  // so any path that built an AuthContext with `scopes: undefined` silently
  // bypassed every MCP scope gate.
  it('returns false for null scopes at every access level', () => {
    expect(hasRequiredMcpScope('read', null)).toBe(false);
    expect(hasRequiredMcpScope('write', null)).toBe(false);
    expect(hasRequiredMcpScope('admin', null)).toBe(false);
  });

  it('returns false for undefined scopes at every access level', () => {
    expect(hasRequiredMcpScope('read', undefined)).toBe(false);
    expect(hasRequiredMcpScope('write', undefined)).toBe(false);
    expect(hasRequiredMcpScope('admin', undefined)).toBe(false);
  });

  it('returns false for an empty scope array (token minted without scopes)', () => {
    expect(hasRequiredMcpScope('read', [])).toBe(false);
    expect(hasRequiredMcpScope('admin', [])).toBe(false);
  });

  it('honors real token scopes by tier', () => {
    expect(hasRequiredMcpScope('read', ['mcp:read'])).toBe(true);
    expect(hasRequiredMcpScope('write', ['mcp:read'])).toBe(false);
    expect(hasRequiredMcpScope('write', ['mcp:write'])).toBe(true);
    expect(hasRequiredMcpScope('admin', ['mcp:write'])).toBe(false);
    expect(hasRequiredMcpScope('admin', ['mcp:admin'])).toBe(true);
  });

  it('treats the not-applicable sentinel as a bypass (session/anonymous auth)', () => {
    // The sentinel means "scope dimension does not apply" — these callers are
    // gated by role + public-readability upstream, not by token scopes.
    expect(hasRequiredMcpScope('read', SCOPE_CHECK_NOT_APPLICABLE)).toBe(true);
    expect(hasRequiredMcpScope('write', SCOPE_CHECK_NOT_APPLICABLE)).toBe(true);
    expect(hasRequiredMcpScope('admin', SCOPE_CHECK_NOT_APPLICABLE)).toBe(true);
    // The sentinel is `['*']` — not a scope any oauth/pat token can present.
    expect(SCOPE_CHECK_NOT_APPLICABLE).toEqual(['*']);
  });
});

describe('isPublicReadable', () => {
  it('should allow public read for resolve_path', () => {
    expect(isPublicReadable('resolve_path', {})).toBe(true);
  });

  it('should allow public read for search memory tools', () => {
    expect(isPublicReadable('search_memory', {})).toBe(true);
    expect(isPublicReadable('search_sdk', {})).toBe(true);
  });

  it('keeps approval details private to workspace members', () => {
    expect(isPublicReadable('get_approval', {})).toBe(false);
  });

  it('should allow public read for read_knowledge', () => {
    expect(isPublicReadable('read_knowledge', {})).toBe(true);
  });

  it('should allow public read for get_automation', () => {
    expect(isPublicReadable('get_automation', {})).toBe(true);
  });

  it('should allow public read for manage_entity list', () => {
    expect(isPublicReadable('manage_entity', { action: 'list' })).toBe(true);
  });

  it('should allow public read for manage_connections lists', () => {
    expect(isPublicReadable('manage_connections', { action: 'list' })).toBe(true);
    expect(
      isPublicReadable('manage_connections', {
        action: 'list_connector_groups',
      })
    ).toBe(true);
  });

  it('should deny public read for manage_entity create', () => {
    expect(isPublicReadable('manage_entity', { action: 'create' })).toBe(false);
  });

  it('should deny public read for query_sql', () => {
    expect(isPublicReadable('query_sql', {})).toBe(false);
  });

  it('should deny public read for unknown tools', () => {
    expect(isPublicReadable('unknown_tool', {})).toBe(false);
  });

  it('should allow public read for manage_automations read actions', () => {
    expect(isPublicReadable('manage_automations', { action: 'list' })).toBe(true);
    expect(isPublicReadable('manage_automations', { action: 'get_versions' })).toBe(true);
    expect(isPublicReadable('manage_automations', { action: 'get_version_details' })).toBe(true);
    expect(
      isPublicReadable('manage_automations', {
        action: 'get_component_reference',
      })
    ).toBe(true);
  });

  it('should deny public read for manage_automations mutations', () => {
    expect(isPublicReadable('manage_automations', { action: 'create' })).toBe(false);
    expect(isPublicReadable('manage_automations', { action: 'create_version' })).toBe(false);
    expect(isPublicReadable('manage_automations', { action: 'set_reaction_script' })).toBe(false);
  });

  it('should allow public read for manage_classifiers list', () => {
    expect(isPublicReadable('manage_classifiers', { action: 'list' })).toBe(true);
  });

  it('should deny public read for manage_classifiers create', () => {
    expect(isPublicReadable('manage_classifiers', { action: 'create' })).toBe(false);
  });

  it('should allow public read for manage_operations list_available', () => {
    expect(isPublicReadable('manage_operations', { action: 'list_available' })).toBe(true);
  });

  it('should deny public read for manage_operations execute', () => {
    expect(isPublicReadable('manage_operations', { action: 'execute' })).toBe(false);
  });
});

describe('routeAction per-action enforcement', () => {
  const memberWriteCtx: ToolContext = {
    organizationId: 'org_123',
    userId: 'user_123',
    memberRole: 'member',
    isAuthenticated: true,
    scopes: ['mcp:write'],
  };

  it('blocks admin-only handler actions reached through execute for write-tier members', async () => {
    let called = false;
    await expect(
      routeAction('manage_entity_schema', 'create', memberWriteCtx, {
        create: async () => {
          called = true;
          return { ok: true };
        },
      })
    ).rejects.toThrow(/requires admin or owner access/i);
    expect(called).toBe(false);
  });

  it('requires admin MCP scope even for owner/admin roles', async () => {
    await expect(
      routeAction(
        'manage_connections',
        'install_connector',
        {
          ...memberWriteCtx,
          memberRole: 'admin',
        },
        {
          install_connector: async () => ({ ok: true }),
        }
      )
    ).rejects.toThrow(/requires an MCP session with admin access/i);
  });

  it('preserves system reaction calls', async () => {
    await expect(
      routeAction(
        'manage_operations',
        'execute',
        {
          organizationId: 'org_123',
          userId: null,
          memberRole: null,
          isAuthenticated: true,
        },
        {
          execute: async () => ({ ok: true }),
        }
      )
    ).resolves.toEqual({ ok: true });
  });
});

describe('checkToolAccess', () => {
  const baseAuth: AuthContext = {
    organizationId: 'org_123',
    userId: 'user_123',
    memberRole: null,
    agentId: null,
    requestedAgentId: null,
    isAuthenticated: true,
    clientId: 'client_123',
    scopes: ['mcp:read'],
    requestUrl: 'http://localhost/mcp/acme',
    baseUrl: 'http://localhost',
    scopedToOrg: true,
  };

  it('explains the public read-only situation on write attempts', () => {
    expect(() => checkToolAccess('save_memory', {}, baseAuth)).toThrow(
      /public workspace is read-only/i
    );
  });

  it('requires write scope for member writes', () => {
    expect(() => checkToolAccess('save_memory', {}, { ...baseAuth, memberRole: 'member' })).toThrow(
      /MCP session is read-only/i
    );
  });

  it('allows members with write scope to save memory', () => {
    expect(() =>
      checkToolAccess(
        'save_memory',
        {},
        {
          ...baseAuth,
          memberRole: 'member',
          scopes: ['mcp:write'],
        }
      )
    ).not.toThrow();
  });

  it('exposes admin tools on external MCP uniformly (no internal-tool hiding)', () => {
    expect(() =>
      checkToolAccess('manage_entity', { action: 'list' }, { ...baseAuth, memberRole: 'owner' })
    ).not.toThrow();
  });

  it('throws ToolNotRegisteredError for genuinely unregistered names so REST proxy can alert', () => {
    expect(() =>
      checkToolAccess('this_tool_does_not_exist', {}, { ...baseAuth, memberRole: 'owner' })
    ).toThrow(ToolNotRegisteredError);
  });

  it('allows admin tools on any surface subject to role x scope (uniform model)', () => {
    expect(() =>
      checkToolAccess(
        'manage_entity',
        { action: 'create' },
        {
          ...baseAuth,
          memberRole: 'member',
          scopes: ['mcp:write'],
        }
      )
    ).not.toThrow();
  });

  it('adminTools allowlist limits ADMIN-tier actions to listed tools only', () => {
    const adminToolsAuth = {
      ...baseAuth,
      memberRole: 'owner',
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      adminTools: ['manage_agents'],
    };
    // Admin-tier action on a listed tool — allowed.
    expect(() => checkToolAccess('manage_agents', { action: 'update' }, adminToolsAuth)).not.toThrow();
    // Admin-tier action on an unlisted tool — blocked by the allowlist.
    expect(() => checkToolAccess('manage_classifiers', { action: 'delete' }, adminToolsAuth)).toThrow(
      /may not perform admin actions/
    );
    // Read/write-tier actions on unlisted tools follow the uniform model.
    expect(() =>
      checkToolAccess('manage_classifiers', { action: 'list' }, adminToolsAuth)
    ).not.toThrow();
  });

  it('lets members run query_sql (read-tier; auth/identity tables gated per-query, not at the tool gate)', () => {
    expect(() =>
      checkToolAccess(
        'query_sql',
        { sql: 'SELECT 1', sort_by: 'id' },
        { ...baseAuth, memberRole: 'member', scopes: ['mcp:read'] }
      )
    ).not.toThrow();
  });

  it('keeps every entity-schema mutation admin-tier', () => {
    expect(requiresOwnerAdmin('manage_entity_schema', { action: 'create' }, false)).toBe(true);
    expect(
      getRequiredAccessLevel(
        'manage_entity_schema',
        { action: 'create', schema_type: 'entity_type' },
        false
      )
    ).toBe('admin');
    expect(
      getRequiredAccessLevel(
        'manage_entity_schema',
        { action: 'create', schema_type: 'relationship_type' },
        false
      )
    ).toBe('admin');
  });

  it('returns the exact access tier that was authorized', () => {
    const owner = {
      ...baseAuth,
      memberRole: 'owner',
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    };

    expect(checkToolAccess('manage_entity_schema', { action: 'list' }, owner)).toBe('read');
    expect(checkToolAccess('save_memory', {}, owner)).toBe('write');
    expect(checkToolAccess('manage_entity_schema', { action: 'create' }, owner)).toBe('admin');
    expect(
      checkToolAccess(
        'manage_entity_schema',
        { action: 'create', schema_type: 'entity_type' },
        owner
      )
    ).toBe('admin');
  });
});

describe('first-party tool-name coverage', () => {
  // REST callers dispatch through `restToolProxy` → `executeTool` →
  // `getTool(name)`, while MCP adds presentation-only Apps tools. These tests
  // pin registration for the first-party REST callers below.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webSrcRoot = join(__dirname, '..', '..', '..', '..', 'web', 'src');
  // The standalone lobu-cli package was merged into @lobu/cli's `memory`
  // namespace; the REST callTool(...) sites moved to packages/cli/src/commands/memory/.
  const cliSrcRoot = join(__dirname, '..', '..', '..', '..', 'cli', 'src', 'commands', 'memory');

  function present(path: string): boolean {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  function collectTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        collectTsFiles(full, out);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  function extractMatches(root: string, pattern: RegExp): Set<string> {
    const names = new Set<string>();
    for (const file of collectTsFiles(root)) {
      for (const match of readFileSync(file, 'utf-8').matchAll(pattern)) {
        names.add(match[1]);
      }
    }
    return names;
  }

  // Names a first-party caller invokes that have no backend handler. Each
  // entry is dead code — kept here so the test fails the day someone wires
  // it up without first registering the tool. Empty this set when cleaned up.
  const KNOWN_DEAD_NAMES = new Set<string>([
    // useDeleteWindow in web/src/hooks/use-automations.ts has no caller;
    // manage_queue was never registered. Delete the hook or add the tool.
    'manage_queue',
  ]);

  function assertRegistered(used: Set<string>): void {
    const drift: string[] = [];
    const stale: string[] = [];
    for (const name of used) {
      const registered = !!getTool(name);
      if (KNOWN_DEAD_NAMES.has(name)) {
        if (registered) stale.push(name);
        continue;
      }
      if (!registered) drift.push(name);
    }
    expect(drift).toEqual([]);
    // If a previously-dead name is now registered, remove it from the allowlist.
    expect(stale).toEqual([]);
  }

  it('every web tool reference (apiCall + hook-factory) is registered', () => {
    if (!present(webSrcRoot)) return; // submodule not checked out (shallow clone)
    // Two patterns: direct `apiCall(<...>?)('foo', …)` and the hook-factory
    // config form `tool: 'foo'` (used at api/entities.ts:165, api/connections.ts,
    // etc. — over 30 sites the direct-apiCall regex would otherwise miss).
    const apiCallNames = extractMatches(
      webSrcRoot,
      /\bapiCall(?:<[^>]*>)?\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g
    );
    const hookFactoryNames = extractMatches(
      webSrcRoot,
      /\btool:\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g
    );
    assertRegistered(new Set([...apiCallNames, ...hookFactoryNames]));
  });

  it('every lobu memory REST callTool(ctx, name) is registered', () => {
    if (!present(cliSrcRoot)) return;
    const used = extractMatches(
      cliSrcRoot,
      /\bcallTool\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g
    );
    assertRegistered(used);
  });

  // CLI bootstrap tools that the `lobu memory browser-auth` flow drives via the
  // REST proxy (`POST /api/{slug}/{toolName}`). Under the uniform surface
  // model they are ordinary registered tools — visible everywhere, gated by
  // per-action tier x role x scope like everything else.
  const CLI_REST_BOOTSTRAP_TOOLS = ['manage_catalog', 'manage_auth_profiles'] as const;

  it.each(CLI_REST_BOOTSTRAP_TOOLS)('CLI bootstrap tool %s is registered', (name) => {
    expect(getTool(name)).toBeDefined();
  });

  it('CLI browser-auth no longer calls bootstrap tools over MCP RPC', () => {
    // After the REST migration, browser-auth.ts must use `restToolCall(...)`
    // for these tools — never `mcpRpc(..., 'tools/call', ...)`. This drift
    // detector fails the moment someone re-introduces an MCP RPC call site.
    if (!present(cliSrcRoot)) return;
    const browserAuth = join(cliSrcRoot, '_lib', 'browser-auth-cmd.ts');
    if (!present(browserAuth)) return;
    const content = readFileSync(browserAuth, 'utf-8');
    expect(content).not.toMatch(/'tools\/call'/);
    for (const tool of CLI_REST_BOOTSTRAP_TOOLS) {
      // The REST helper takes the tool name as the second positional argument.
      const restPattern = new RegExp(`restToolCall<[^>]*>\\(\\s*\\w+\\s*,\\s*['"]${tool}['"]`);
      expect(content).toMatch(restPattern);
    }
  });
});

const ACCESS_SURFACE = `
search_memory: read+public ?=read+public
save_memory: write ?=write
search_sdk: read+public ?=read+public
query_sdk: read ?=read
query_sql: read ?=read
run_sdk: write ?=write
manage_entity: create=write update=write list=read+public get=read+public delete=admin link=write unlink=write update_link=write list_links=read+public merge=admin resolve_duplicates=admin unmerge=admin ?=read
manage_entity_schema: list=read+public get=read+public create=admin update=admin delete=admin audit=read+public add_rule=admin remove_rule=admin list_rules=read+public ?=read
manage_connections: list_connector_groups=read+public list=read+public get=read+public create=write setup_options=read+public connect=admin connect_managed=write update=write apply_chat_connection=admin delete=admin reauthenticate=write test=admin install_connector=admin uninstall_connector=admin get_connector_source=admin validate_connector_source=admin update_connector_source=admin rollback_connector_version=admin toggle_connector_login=admin update_connector_auth=admin update_connector_default_config=admin set_channel_about=admin ?=read
manage_catalog: list_catalog=read+public list_installed=read+public ?=read
manage_agents: list=read+public get=read+public create=admin update=admin delete=admin ?=read
manage_conversations: list=read get=read send=write ?=read
manage_feeds: list_feeds=read+public read_feed=read+public read_feeds=read+public create_feed=admin update_feed=admin delete_feed=admin trigger_feed=admin ?=read
manage_auth_profiles: list_auth_profiles=read+public get_auth_profile=read+public test_auth_profile=admin create_auth_profile=write update_auth_profile=write delete_auth_profile=admin set_default_auth_profile=admin ?=read
manage_operations: list_available=read+public execute=write list_runs=read+public get_run=read+public list_activity=read+public approve=write reject=write approve_batch=write reject_batch=write ?=read
notify: send=admin ?=admin
manage_schedules: create=admin list=admin update=admin pause=admin cancel=admin ?=read
manage_automations: create=admin list=read+public update=admin create_version=admin complete_window=write claim_next_window=write trigger=write delete=admin set_reaction_script=admin get_versions=read+public get_version_details=read+public get_component_reference=read+public submit_feedback=admin get_feedback=read+public list_promoted=read create_from_version=admin ?=read
get_automation: read+public ?=read+public
read_knowledge: read+public ?=read+public
manage_classifiers: create=admin list=read+public generate_embeddings=admin delete=admin classify=admin apply=admin ?=read
manage_view_templates: set=admin get=read+public rollback=admin remove_tab=admin clear=admin ?=read
list_organizations: read ?=read
list_metrics: read ?=read
query_metric: read ?=read
metric_series: read ?=read
resolve_path: read+public ?=read+public
`.trim();

describe('pinned access matrix', () => {
  // One line per tool: every action's tier (+public readability) plus the `?`
  // unknown-action probe (pins the fallback branch). A diff here is an
  // access-control change — review it as one; regenerate lines from the
  // failure diff. Captured before the internal-flag removal and identical
  // after it: visibility changed, the access matrix did not.
  function actionsOf(schema: any): string[] | null {
    const action = schema?.properties?.action;
    if (Array.isArray(action?.enum)) return action.enum.map(String);
    if (typeof action?.const === 'string') return [action.const];
    // Flat tools keep `action` as a TypeBox union → anyOf-of-const.
    if (Array.isArray(action?.anyOf)) {
      const consts = action.anyOf
        .map((v: any) => v?.const)
        .filter((v: unknown): v is string => typeof v === 'string');
      return consts.length > 0 ? consts : null;
    }
    return null;
  }

  it('matches the fixture for every registered tool and action', () => {
    const lines = getAllTools({
      publicOnly: false,
      maxAccessLevel: 'admin',
    }).map((tool) => {
      const readOnly = isAuthorizationReadOnly(getTool(tool.name));
      const parts = [...(actionsOf(tool.inputSchema) ?? ['-']), '?'].map((action) => {
        const args = action === '-' ? {} : { action };
        const tier = getRequiredAccessLevel(tool.name, args, readOnly);
        const pub = isPublicReadable(tool.name, args) ? '+public' : '';
        return `${action === '-' ? '' : `${action}=`}${tier}${pub}`;
      });
      return `${tool.name}: ${parts.join(' ')}`;
    });
    expect(lines.join('\n')).toBe(ACCESS_SURFACE);
  });

  it('resolveMaxAccessLevel is the min of role and scope tiers', () => {
    expect(resolveMaxAccessLevel('owner', ['mcp:admin'])).toBe('admin');
    expect(resolveMaxAccessLevel('owner', ['mcp:write'])).toBe('write');
    expect(resolveMaxAccessLevel('member', ['mcp:admin'])).toBe('write');
    expect(resolveMaxAccessLevel(null, ['mcp:admin'])).toBe('read');
    expect(resolveMaxAccessLevel('owner', null)).toBe('admin');
  });

  it('raises only owner/admin SDK ceilings for progressive admin authorization', () => {
    expect(resolveSdkMaxAccessLevel('owner', ['mcp:write'])).toBe('admin');
    expect(resolveSdkMaxAccessLevel('admin', ['mcp:read', 'mcp:write'])).toBe('admin');
    expect(resolveSdkMaxAccessLevel('member', ['mcp:write'])).toBe('write');
    expect(resolveSdkMaxAccessLevel('member', ['mcp:admin'])).toBe('write');
    expect(resolveSdkMaxAccessLevel('owner', ['mcp:read'])).toBe('read');
  });
});
