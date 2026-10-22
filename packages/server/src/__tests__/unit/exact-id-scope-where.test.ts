import { describe, expect, it } from 'bun:test';
import type { DbClient } from '../../db/client';
import { buildExactIdScopeWhere } from '../../tools/get_content/query';

// The no-entityId probe path never touches the database handle.
const noDb = undefined as unknown as DbClient;

const base = {
  organizationId: 'org_test',
  visibilityScope: { organizationId: 'org_test', userId: 'user_1' },
  baseParamIndex: 1,
};

describe('buildExactIdScopeWhere', () => {
  it('emits the org boundary and visibility with $1-based params', async () => {
    const result = await buildExactIdScopeWhere(noDb, {
      ...base,
      excludeWorkspaceAudit: false,
      excludeOperationalTrail: false,
    });

    expect(result.sql).toContain('f.organization_id = $1::text');
    expect(result.params[0]).toBe('org_test');
    // Visibility binds after the org param without gaps or reuse.
    const indices = [...result.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...indices)).toBe(result.params.length);
    expect(result.sql).not.toContain('_lobu_workspace_audit');
    expect(result.sql).not.toContain('notification_targets');
  });

  it('adds the audit and trail exclusions only when asked', async () => {
    const result = await buildExactIdScopeWhere(noDb, {
      ...base,
      excludeWorkspaceAudit: true,
      excludeOperationalTrail: true,
    });

    expect(result.sql).toContain(`NOT (f.metadata ? '_lobu_workspace_audit')`);
    expect(result.sql).toContain('notification_targets');
  });

  it('honors a non-1 baseParamIndex for callers that bind id params first', async () => {
    const result = await buildExactIdScopeWhere(noDb, {
      ...base,
      baseParamIndex: 4,
      excludeWorkspaceAudit: false,
      excludeOperationalTrail: false,
    });

    expect(result.sql).toContain('f.organization_id = $4::text');
    expect(result.params[0]).toBe('org_test');
    const indices = [...new Set([...result.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))];
    expect(indices.sort((a, b) => a - b)).toEqual(
      result.params.map((_, index) => index + 4)
    );
  });
});
