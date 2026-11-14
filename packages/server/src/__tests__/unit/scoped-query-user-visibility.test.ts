/**
 * S0 spike: the events CTE in `buildScopedQuery` (query_sql / metrics /
 * automations / client.query) must intersect with PER-USER connection visibility,
 * not just org scope — otherwise a multi-user agent's `client.query` can read
 * another user's private-connection events. The content-search/recall seams
 * already apply `buildConnectionVisibilityClause`; this pins that the
 * buildScopedQuery seam does too.
 */

import { describe, expect, it } from 'bun:test';
import { buildScopedQuery } from '../../utils/execute-data-sources';

describe('buildScopedQuery events CTE — per-user connection visibility (S0)', () => {
  it('restricts connection-sourced events to the requesting user (visibility=org OR created_by=user)', () => {
    const { sql, params } = buildScopedQuery('SELECT * FROM events', ['events'], {
      organizationId: 'org_test',
      userId: 'user_a',
    });

    // The events CTE must intersect with connection visibility, not just org scope.
    expect(sql).toContain("vc.visibility = 'org'");
    expect(sql).toContain('vc.created_by');

    // The requesting user is bound as a param so private connections created by
    // OTHER users are excluded.
    expect(params).toContain('user_a');
  });

  it('still emits org scope when no userId is provided (no regression)', () => {
    const { sql } = buildScopedQuery('SELECT * FROM events', ['events'], {
      organizationId: 'org_test',
    });
    expect(sql).toContain('ev.organization_id');
  });

  it('gates event_classifications too (excerpts carry verbatim source text)', () => {
    // The EXISTS over `ev` must apply the same per-user connection visibility,
    // else a member reads classifications of another user's private events.
    const { sql, params } = buildScopedQuery(
      'SELECT excerpts FROM event_classifications',
      ['event_classifications'],
      { organizationId: 'org_test', userId: 'user_a' }
    );
    expect(sql).toContain('ev.connection_id');
    expect(sql).toContain("vc.visibility = 'org'");
    expect(params).toContain('user_a');
  });

  it('gates the connections row itself (private-connection metadata)', () => {
    const { sql } = buildScopedQuery(
      'SELECT display_name FROM connections',
      ['connections'],
      { organizationId: 'org_test', userId: 'user_a' }
    );
    // The row predicate embeds the requesting user as an escaped literal (see
    // compileConnectionRowVisibility), so private connections created by OTHER
    // users are still excluded.
    expect(sql).toContain("cn.visibility = 'org'");
    expect(sql).toContain("cn.created_by = 'user_a'");
  });

  it('gates feeds via their owning connection (connection_id NOT NULL)', () => {
    // The gate is the connection ROW predicate (same one manage_feeds applies),
    // not the FK/events form. The FK form additionally required the connection
    // to be non-soft-deleted, which hid live feeds that `client.feeds.get`
    // still returned — the SDK and the SQL view disagreed about what exists.
    const { sql } = buildScopedQuery('SELECT config FROM feeds', ['feeds'], {
      organizationId: 'org_test',
      userId: 'user_a',
    });
    expect(sql).toContain('fc.id = fd.connection_id');
    expect(sql).toContain("fc.visibility = 'org'");
    // Private connections created by OTHER users are still excluded.
    expect(sql).toContain("fc.created_by = 'user_a'");
  });

  it('does not leak another org’s feeds when widening connection visibility', () => {
    // Both the feed row and its owning connection stay bound to the org param —
    // widening must never trade a visibility bug for a tenancy leak.
    const { sql, params } = buildScopedQuery('SELECT id FROM feeds', ['feeds'], {
      organizationId: 'org_test',
      userId: 'user_a',
    });
    expect(sql).toContain('fd.organization_id = $1');
    expect(sql).toContain('fc.organization_id = $1');
    expect(params[0]).toBe('org_test');
  });
});


describe('buildScopedQuery org scope', () => {
  it('scopes events and their classifications to the owning organization only', () => {
    for (const [query, table] of [
      ['SELECT * FROM events', 'events'],
      ['SELECT excerpts FROM event_classifications', 'event_classifications'],
    ] as const) {
      const { sql } = buildScopedQuery(query, [table], { organizationId: 'org_test' });
      expect(sql).toContain('ev.organization_id = $1');
      expect(sql).not.toContain('linked_org_ids');
      expect(sql).not.toContain('public.entities ent');
    }
  });

  it('excludeWorkspaceAudit filters events CTE for ordinary members', () => {
    const { sql } = buildScopedQuery('SELECT * FROM events', ['events'], {
      organizationId: 'org_test',
      userId: 'user_a',
    }, {
      excludeWorkspaceAudit: true,
    });
    expect(sql).toContain("NOT (ev.metadata ? '_lobu_workspace_audit')");
  });

  it('excludeWorkspaceAudit filters event_classifications CTE', () => {
    const { sql } = buildScopedQuery(
      'SELECT excerpts FROM event_classifications',
      ['event_classifications'],
      { organizationId: 'org_test', userId: 'user_a' },
      { excludeWorkspaceAudit: true }
    );
    expect(sql).toContain("NOT (ev.metadata ? '_lobu_workspace_audit')");
  });

  it('omits the workspace filter when the flag is absent (admin / system callers)', () => {
    const { sql } = buildScopedQuery('SELECT * FROM events', ['events'], {
      organizationId: 'org_test',
      userId: 'user_a',
    });
    expect(sql).not.toContain("_lobu_workspace_audit");
  });
});
