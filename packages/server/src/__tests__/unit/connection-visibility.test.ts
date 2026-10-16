/**
 * M1: every read seam must compile its connection-visibility predicate from the
 * ONE compiler keyed on an AuthzScope. These pin the compiler's two shapes and
 * prove the recall/content adapter (`buildConnectionVisibilityClause`) is now a
 * byte-identical pass-through to it — so the SQL seam (buildScopedQuery) and the
 * recall/content seam can never drift.
 */
import { describe, expect, it } from 'bun:test';
import { buildConnectionVisibilityClause } from '../../utils/content-search/visibility';
import {
  compileConnectionFkVisibility,
  compileConnectionRowVisibility,
} from '../../authz/connection-visibility';
import { authzScopeFromToolContext, headlessScope } from '../../authz/scope';

const scope = { organizationId: 'org_test', principal: 'user_a' };

describe('connection-visibility compiler (M1 one-compiler)', () => {
  it('FK form gates by org + principal, NULL connection_id stays visible', () => {
    const { sql, params } = compileConnectionFkVisibility(scope, 5, 'ev');
    expect(sql).toContain('ev.connection_id IS NULL OR ev.connection_id IN');
    expect(sql).toContain('SELECT vc.id FROM public.connections vc');
    expect(sql).toContain("vc.visibility = 'org'");
    expect(sql).toContain('vc.created_by');
    // org bound at baseParamIndex, principal at baseParamIndex+1.
    expect(sql).toContain('$5::text');
    expect(sql).toContain('$6::text');
    expect(params).toEqual(['org_test', 'user_a']);
  });

  it('row form gates the connections row itself by principal', () => {
    expect(compileConnectionRowVisibility(scope, 'cn')).toBe(
      "AND (cn.visibility = 'org' OR cn.created_by = 'user_a')"
    );
  });

  it('row form escapes the principal literal', () => {
    expect(
      compileConnectionRowVisibility({ organizationId: 'org_test', principal: "us'er" }, 'cn')
    ).toBe("AND (cn.visibility = 'org' OR cn.created_by = 'us''er')");
  });

  it('a null principal (headless) is fail-closed to org-only', () => {
    const fk = compileConnectionFkVisibility(headlessScope('org_test'), 1, 'ev');
    expect(fk.params).toEqual(['org_test', null]);
    expect(compileConnectionRowVisibility(headlessScope('org_test'), 'cn')).toBe(
      "AND (cn.visibility = 'org')"
    );
  });

  it('row and FK forms encode the same rule — no admin arm, no legacy IS NULL widening', () => {
    // After the legacy backfill (every connection has a creator), the two forms
    // gate on the same predicate: org-visible or the principal's own. Neither
    // form may widen for admins via `created_by IS NULL`.
    expect(compileConnectionRowVisibility(scope, 'cn')).toBe(
      "AND (cn.visibility = 'org' OR cn.created_by = 'user_a')"
    );
    const { sql, params } = compileConnectionFkVisibility(scope, 1, 'ev');
    expect(sql).toContain("vc.visibility = 'org'");
    expect(sql).toContain('vc.created_by = $2::text');
    // The only `IS NULL` left in the FK form is the system-row pass-through
    // (`connection_id IS NULL`), never a `created_by` widening.
    expect(sql).not.toContain('created_by IS NULL');
    expect(params).toEqual(['org_test', 'user_a']);
  });

  it('authzScopeFromToolContext maps ctx.userId → principal', () => {
    expect(authzScopeFromToolContext({ organizationId: 'o', userId: 'u', agentId: 'a' })).toEqual({
      organizationId: 'o',
      principal: 'u',
      agentId: 'a',
      chatAccess: null,
    });
    expect(authzScopeFromToolContext({ organizationId: 'o', userId: null })).toEqual({
      organizationId: 'o',
      principal: null,
      agentId: null,
      chatAccess: null,
    });
  });

  it('uses the Automation creator for reads without changing the execution identity', () => {
    const ctx = Object.freeze({
      organizationId: 'org_test',
      userId: null,
      agentId: 'agent_test',
      actingAutomationId: 42,
      automationReadPrincipalId: 'user_creator',
    });
    const readScope = authzScopeFromToolContext(ctx);
    expect(readScope).toEqual({
      organizationId: 'org_test',
      principal: 'user_creator',
      agentId: 'agent_test',
      chatAccess: null,
    });
    expect(compileConnectionFkVisibility(readScope, 1, 'ev').params).toEqual([
      'org_test', 'user_creator',
    ]);
    expect(ctx.userId).toBeNull();
    expect(ctx.actingAutomationId).toBe(42);
  });

  it('keeps the authenticated caller ahead of the Automation creator', () => {
    const readScope = authzScopeFromToolContext({
      organizationId: 'org_test',
      userId: 'user_caller',
      automationReadPrincipalId: 'user_creator',
    });
    expect(compileConnectionFkVisibility(readScope, 1, 'ev').params).toEqual([
      'org_test', 'user_caller',
    ]);
  });

  it('fails closed when a headless Automation has no resolved creator', () => {
    const readScope = authzScopeFromToolContext({
      organizationId: 'org_test',
      userId: null,
      automationReadPrincipalId: null,
    });
    expect(compileConnectionRowVisibility(readScope, 'cn')).toBe(
      "AND (cn.visibility = 'org')"
    );
  });

  it('the recall/content adapter composes the connection-visibility compiler verbatim, then the resource gate', () => {
    const viaAdapter = buildConnectionVisibilityClause(
      { organizationId: 'org_test', userId: 'user_a', baseParamIndex: 7 },
      'f'
    );
    const viaCompiler = compileConnectionFkVisibility(scope, 7, 'f');
    // Connection visibility is STILL the one compiler's output, verbatim — the
    // adapter prefixes it (no re-derivation), then ANDs the orthogonal resource
    // gate, whose params follow the connection-visibility params in order.
    expect(viaAdapter.sql.startsWith(viaCompiler.sql)).toBe(true);
    expect(viaAdapter.params.slice(0, viaCompiler.params.length)).toEqual(viaCompiler.params);
    // Plus the per-resource membership gate composed after it.
    expect(viaAdapter.sql).toContain('member_of');
    expect(viaAdapter.params).toEqual(['org_test', 'user_a', 'org_test', 'user_a']);
  });

  it('the adapter still returns empty when no org is requested', () => {
    expect(buildConnectionVisibilityClause({ baseParamIndex: 1 }, 'f')).toEqual({
      sql: '',
      params: [],
    });
  });
});
