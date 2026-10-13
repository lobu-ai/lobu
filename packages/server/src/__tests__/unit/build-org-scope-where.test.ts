/**
 * Unit coverage for the org-scoping clause used by `searchContentByText`
 * and (mirrored) by the events CTE in `execute-data-sources`. The runtime
 * automation — that an event with `f.organization_id = caller` and no entity
 * bridge is now visible — is exercised end-to-end in
 * `__tests__/integration/events/search-content-org-scope.test.ts`. This
 * file pins the SQL shape so accidental regressions on the OR-triplet are
 * caught in unit-CI.
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

    expect(result.sql).toContain('f.organization_id = $3::text');
    expect(result.sql).toContain('ent_org.organization_id = $3::text');
    expect(result.sql).toContain('c.organization_id = $3::text');
    expect(result.params).toEqual(['org_selected']);
  });

  it('returns empty SQL when organization_id is missing (caller has no org binding)', () => {
    const result = buildOrgScopeWhere({ baseParamIndex: 1 });
    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('emits the triple-OR org-scope clause when only organization_id is set', () => {
    const result = buildOrgScopeWhere({
      organization_id: 'org_buremba',
      baseParamIndex: 5,
    });

    // direct match on the event's own organization_id (covers events saved
    // with no entity_ids and no connection — the original "invisible save"
    // bug)
    expect(result.sql).toContain('f.organization_id = $5::text');

    // entity-bridge — events linked to entities owned by the caller
    expect(result.sql).toContain(
      'EXISTS (SELECT 1 FROM entities ent_org WHERE ent_org.id = ANY(f.entity_ids) AND ent_org.organization_id = $5::text)'
    );

    // connection-bridge — events ingested through a connection in the
    // caller's org
    expect(result.sql).toContain('c.organization_id = $5::text');

    // The three branches are OR'd; nothing else gates them. In particular,
    // no `entity_ids IS NULL OR entity_ids = '{}'` precondition — that gate
    // was the bug.
    expect(result.sql).not.toContain("entity_ids = '{}'");
    expect(result.sql).not.toContain('entity_ids IS NULL');

    // Single param bound to the organization id, repeated three times in
    // the SQL via the placeholder.
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

  it('exposes disjoint direct/linked arms only under the linked-org bridge', () => {
    const previous = process.env.LOBU_LINKED_ORG_SCOPE;
    try {
      delete process.env.LOBU_LINKED_ORG_SCOPE;
      expect(buildOrgScopeWhere({ organization_id: 'org_x', baseParamIndex: 2 }).branches).toBeNull();

      process.env.LOBU_LINKED_ORG_SCOPE = '1';
      const result = buildOrgScopeWhere({ organization_id: 'org_x', baseParamIndex: 2 });
      expect(result.sql).toBe(
        'AND (f.organization_id = $2::text OR f.linked_org_ids @> ARRAY[$2::text]::text[])'
      );
      expect(result.branches).toEqual({
        direct: 'f.organization_id = $2::text',
        linked:
          'f.linked_org_ids @> ARRAY[$2::text]::text[] AND f.organization_id IS DISTINCT FROM $2::text',
      });
    } finally {
      if (previous === undefined) delete process.env.LOBU_LINKED_ORG_SCOPE;
      else process.env.LOBU_LINKED_ORG_SCOPE = previous;
    }
  });
});
