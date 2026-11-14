/**
 * `device_workers` is the one allowlisted relation that is NOT org-scoped.
 *
 * Its PK is `(user_id, worker_id)` and `organization_id` is nullable — the org
 * records where a device is ATTACHED, not who owns it. Scoping the CTE on the
 * org alone would let any member of a shared workspace enumerate every
 * colleague's machines: `label` is normally a personal name and `last_seen_at`
 * is a presence feed. `query_sql` is member-safe, so the owner predicate is
 * what makes this entry safe to expose at all.
 *
 * The integration sibling (device-workers-query-scope.test.ts) proves the rows
 * really are filtered; this pins the emitted SQL so the predicate can't be
 * loosened without a test noticing.
 */

import { describe, expect, it } from 'bun:test';
import { buildScopedQuery } from '../../utils/execute-data-sources';
import { SAFE_COLUMN_DEFS } from '../../utils/table-schema';

/**
 * Every user-facing caller (`query_sql`, metrics, member `client.query`)
 * passes SAFE_COLUMN_DEFS; without it the CTE degrades to `dw.*` and every
 * column-exclusion assertion below would pass vacuously. (System-context
 * `client.query` omits it, but a system context has no principal, so the
 * owner predicate already yields zero rows there.)
 */
const opts = { safeColumns: SAFE_COLUMN_DEFS };

describe('buildScopedQuery device_workers CTE — owner scoping', () => {
  it('filters on the requesting user, not just the organization', () => {
    const { sql, params } = buildScopedQuery(
      'SELECT id, label FROM device_workers',
      ['device_workers'],
      { organizationId: 'org_test', userId: 'user_a' },
      opts
    );

    expect(sql).toContain('dw.user_id =');
    expect(sql).toContain('public.device_workers');
    // Both the owner and the org must be bound — the org arm alone is the leak.
    expect(params).toContain('user_a');
    expect(params).toContain('org_test');
  });

  it('admits an unattached device, since its owner may already pin it', () => {
    // evaluateDeviceWorkerAccess lets an owner pin a device they own regardless
    // of attachment, so hiding organization_id IS NULL rows would leave a device
    // you can pin but cannot find.
    const { sql } = buildScopedQuery(
      'SELECT id FROM device_workers',
      ['device_workers'],
      { organizationId: 'org_test', userId: 'user_a' },
      opts
    );
    expect(sql).toContain('dw.organization_id IS NULL');
  });

  it('binds a null principal rather than dropping the predicate', () => {
    // A headless/service caller has no user. The predicate must still be
    // emitted: `user_id = NULL` matches nothing, which is the fail-closed
    // direction. Dropping it would make every device in the org readable.
    const { sql, params } = buildScopedQuery(
      'SELECT id FROM device_workers',
      ['device_workers'],
      { organizationId: 'org_test' },
      opts
    );
    expect(sql).toContain('dw.user_id =');
    expect(params).toContain(null);
  });

  it('never exposes connector_manifests or user_id', () => {
    // connector_manifests is free-form jsonb the device writes verbatim — the
    // same uncurated-write risk class that forced redaction onto
    // connections.config. user_id is always the caller here, so projecting it
    // only invites correlation.
    const { sql } = buildScopedQuery(
      'SELECT * FROM device_workers',
      ['device_workers'],
      { organizationId: 'org_test', userId: 'user_a' },
      opts
    );
    const cte = sql.slice(sql.indexOf('"device_workers" AS'));
    expect(cte).not.toContain('connector_manifests');
    expect(cte.slice(0, cte.indexOf('FROM'))).not.toContain('user_id');
  });

  it('projects the id an Automation pin needs', () => {
    // The whole point of the entry: automations.device_worker_id takes this
    // UUID, and without it an agent has to reconstruct it from a lifecycle event.
    const { sql } = buildScopedQuery(
      'SELECT id FROM device_workers',
      ['device_workers'],
      { organizationId: 'org_test', userId: 'user_a' },
      opts
    );
    expect(sql).toContain('"device_workers" AS NOT MATERIALIZED (SELECT');
    expect(sql).toMatch(/"device_workers" AS NOT MATERIALIZED \(SELECT[^)]*\bid\b/);
    // and the projection must be explicit, never a wildcard
    expect(sql).not.toContain('dw.*');
  });
});
