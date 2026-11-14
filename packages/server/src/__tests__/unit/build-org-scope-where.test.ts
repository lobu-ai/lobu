/**
 * Unit coverage for the org-scoping clause used by the content read paths: an
 * event is in scope only when the caller's organization owns it. The real
 * read path is exercised end-to-end in
 * `__tests__/integration/events/search-content-org-scope.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { buildOrgScopeWhere } from '../../utils/content-search';

describe('buildOrgScopeWhere', () => {
  it('returns empty SQL when entity_id is set (entity_id implies its own scoping)', () => {
    const result = buildOrgScopeWhere({
      entity_id: 42,
      organization_id: 'org_test',
      baseParamIndex: 1,
    });
    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('keeps the org fence for strict entity-scoped MCP recall', () => {
    const result = buildOrgScopeWhere({
      entity_id: 42,
      organization_id: 'org_selected',
      strict_organization_scope: true,
      baseParamIndex: 3,
    });

    expect(result.sql).toBe('AND f.organization_id = $3::text');
    expect(result.params).toEqual(['org_selected']);
  });

  it('returns empty SQL when organization_id is missing (caller has no org binding)', () => {
    const result = buildOrgScopeWhere({ baseParamIndex: 1 });
    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('scopes to events the organization owns, with no cross-organization arm', () => {
    const result = buildOrgScopeWhere({
      organization_id: 'org_buremba',
      baseParamIndex: 5,
    });
    expect(result.sql).toBe('AND f.organization_id = $5::text');
    expect(result.params).toEqual(['org_buremba']);
  });

  it('honors the supplied baseParamIndex', () => {
    const a = buildOrgScopeWhere({ organization_id: 'org_x', baseParamIndex: 1 });
    const b = buildOrgScopeWhere({ organization_id: 'org_x', baseParamIndex: 7 });
    expect(a.sql).toContain('$1::text');
    expect(a.sql).not.toContain('$7::text');
    expect(b.sql).toContain('$7::text');
    expect(b.sql).not.toContain('$1::text');
  });
});
