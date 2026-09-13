/**
 * Connector source lifecycle (#2045): the explicit, org-local
 * install → get_connector_source → validate_connector_source →
 * update_connector_source → rollback_connector_version round trip through the
 * manage_connections tool.
 *
 * Contract under test:
 *  - get returns the active source plus the retained version history
 *  - validate compiles + reports diagnostics and NEVER persists
 *  - update requires an installed connector, a matching definition.key, an
 *    optional optimistic expected_version, and a version bump when the code
 *    changes (so the prior version stays retained)
 *  - rollback re-activates a retained version in one operation and restores
 *    the definition's metadata from that version's stored code
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { seedOwnerContext } from '../../setup/test-fixtures';
import type { ToolContext } from '../../../tools/registry';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

const KEY = 'zz.lifecycleprobe';

function probeSource(version: string, marker: string): string {
  return `
export default class LifecycleProbeConnector {
  definition = {
    key: '${KEY}',
    name: 'Lifecycle Probe',
    description: '${marker}',
    version: '${version}',
  };
  async sync() { return { events: [], checkpoint: null }; }
  async execute() { return { marker: '${marker}' }; }
}
`;
}

describe('manage_connections connector source lifecycle (#2045)', () => {
  let ctx: ToolContext;
  let orgId: string;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext({
      orgName: 'Connector Lifecycle Org',
      userName: 'Connector Lifecycle User',
    });
    ctx = seeded.ctx;
    orgId = seeded.org.id;
  });

  it('runs the full round trip: install → get → validate → update → guards → rollback', async () => {
    const sql = getTestDb();

    // ---- install v1 from source ----
    const installed = await manageConnections(
      { action: 'install_connector', source_code: probeSource('1.0.0', 'V1') },
      TEST_ENV,
      ctx,
    );
    expect('error' in installed ? installed.error : undefined).toBeUndefined();
    expect('version' in installed ? installed.version : undefined).toBe(
      '1.0.0',
    );

    // ---- get_connector_source: active source + retained history ----
    const got = await manageConnections(
      { action: 'get_connector_source', connector_key: KEY },
      TEST_ENV,
      ctx,
    );
    expect('error' in got ? got.error : undefined).toBeUndefined();
    if (!('active_version' in got)) throw new Error('unexpected result shape');
    expect(got.active_version).toBe('1.0.0');
    expect(got.version).toBe('1.0.0');
    expect(got.source_code).toContain("marker: 'V1'");
    expect(got.versions).toEqual([
      expect.objectContaining({
        version: '1.0.0',
        active: true,
        has_source: true,
      }),
    ]);

    // ---- validate: broken source → diagnostics, no persistence ----
    const invalid = await manageConnections(
      {
        action: 'validate_connector_source',
        source_code: 'export default class Broken {',
      },
      TEST_ENV,
      ctx,
    );
    if (!('valid' in invalid)) throw new Error('unexpected result shape');
    expect(invalid.valid).toBe(false);
    expect(
      'diagnostics' in invalid && invalid.diagnostics.length,
    ).toBeGreaterThan(0);

    // ---- validate: compiles but missing identity → diagnostics too ----
    const noIdentity = await manageConnections(
      {
        action: 'validate_connector_source',
        source_code: `export default class NoKey {
  definition = { name: 'No Key' };
  async sync() { return { events: [], checkpoint: null }; }
  async execute() { return {}; }
}`,
      },
      TEST_ENV,
      ctx,
    );
    if (!('valid' in noIdentity)) throw new Error('unexpected result shape');
    expect(noIdentity.valid).toBe(false);
    expect('diagnostics' in noIdentity ? noIdentity.diagnostics : '').toMatch(
      /key, name, and version/,
    );

    // Neither validation persisted anything.
    const afterValidate = await sql`
      SELECT version FROM connector_versions
      WHERE connector_key = ${KEY} AND organization_id = ${orgId}
    `;
    expect(
      afterValidate.map((r) => (r as { version: string }).version),
    ).toEqual(['1.0.0']);

    // ---- validate: good v2 source → preflight metadata, still no persistence ----
    const valid = await manageConnections(
      {
        action: 'validate_connector_source',
        source_code: probeSource('2.0.0', 'V2'),
      },
      TEST_ENV,
      ctx,
    );
    if (!('valid' in valid) || valid.valid !== true) {
      throw new Error(`expected valid preflight, got ${JSON.stringify(valid)}`);
    }
    expect(valid.connector_key).toBe(KEY);
    expect(valid.version).toBe('2.0.0');
    expect(valid.installed).toBe(true);
    expect(valid.active_version).toBe('1.0.0');
    expect(valid.version_exists).toBe(false);

    // ---- validate surfaces extracted per-action kind + requiredScopes ----
    // Authors must be able to confirm these semantic-policy fields survived
    // extraction BEFORE persisting (a validate-without-install step).
    const withActions = await manageConnections(
      {
        action: 'validate_connector_source',
        source_code: `
export default class ActionProbeConnector {
  definition = {
    key: '${KEY}',
    name: 'Action Probe',
    version: '3.0.0',
    feeds: {
      articles: {
        key: 'articles',
        name: 'Articles',
        sync: async () => ({ events: [], checkpoint: null }),
      },
    },
    actions: {
      read_thing: { key: 'read_thing', name: 'Read thing', kind: 'read', requiresApproval: false, requiredScopes: ['probe.read'] },
      hinted_read: { key: 'hinted_read', name: 'Hinted read', requiresApproval: false, annotations: { readOnlyHint: true } },
      write_thing: { key: 'write_thing', name: 'Write thing', requiresApproval: true, requiredScopes: ['probe.write'] },
    },
  };
  async sync() { return { events: [], checkpoint: null }; }
  async execute() { return {}; }
}
`,
      },
      TEST_ENV,
      ctx,
    );
    if (!('valid' in withActions) || withActions.valid !== true) {
      throw new Error(
        `expected valid preflight, got ${JSON.stringify(withActions)}`,
      );
    }
    expect(withActions.actions.read_thing).toEqual({
      kind: 'read',
      requires_approval: false,
      required_scopes: ['probe.read'],
    });
    // annotations.readOnlyHint:true classifies as read too — must match the
    // runtime getLocalActionKind, not just an explicit kind field.
    expect(withActions.actions.hinted_read.kind).toBe('read');
    // kind defaults to write when omitted (matches the runtime default).
    expect(withActions.actions.write_thing).toEqual({
      kind: 'write',
      requires_approval: true,
      required_scopes: ['probe.write'],
    });
    expect(withActions.feed_keys).toEqual(['articles']);

    // ---- update guards ----
    // Wrong key inside the source: refused.
    const wrongKey = await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: KEY,
        source_code: probeSource('2.0.0', 'V2').replace(KEY, 'zz.otherprobe'),
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in wrongKey ? wrongKey.error : '').toContain(
      "defines connector 'zz.otherprobe'",
    );

    // Stale optimistic version check: refused.
    const staleExpected = await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: KEY,
        source_code: probeSource('2.0.0', 'V2'),
        expected_version: '0.9.9',
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in staleExpected ? staleExpected.error : '').toContain(
      'Version conflict',
    );

    // Same active version + different code: refused (rollback would be lost).
    const noBump = await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: KEY,
        source_code: probeSource('1.0.0', 'V1-changed'),
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in noBump ? noBump.error : '').toContain('Bump the version');

    // ---- update to v2 with the correct expected_version ----
    const updated = await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: KEY,
        source_code: probeSource('2.0.0', 'V2'),
        expected_version: '1.0.0',
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in updated ? updated.error : undefined).toBeUndefined();
    if (!('previous_version' in updated))
      throw new Error('unexpected result shape');
    expect(updated.previous_version).toBe('1.0.0');
    expect(updated.version).toBe('2.0.0');

    // The definition flipped and BOTH versions are retained.
    const defAfterUpdate = await sql`
      SELECT version, description FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${KEY} AND status = 'active'
    `;
    expect((defAfterUpdate[0] as { version: string }).version).toBe('2.0.0');
    expect((defAfterUpdate[0] as { description: string }).description).toBe(
      'V2',
    );
    const retained = await sql`
      SELECT version FROM connector_versions
      WHERE connector_key = ${KEY} AND organization_id = ${orgId}
      ORDER BY version
    `;
    expect(retained.map((r) => (r as { version: string }).version)).toEqual([
      '1.0.0',
      '2.0.0',
    ]);

    // ---- rollback guards ----
    const missingVersion = await manageConnections(
      {
        action: 'rollback_connector_version',
        connector_key: KEY,
        version: '9.9.9',
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in missingVersion ? missingVersion.error : '').toContain(
      "No retained version '9.9.9'",
    );
    expect('error' in missingVersion ? missingVersion.error : '').toContain(
      '1.0.0',
    );

    const alreadyActive = await manageConnections(
      {
        action: 'rollback_connector_version',
        connector_key: KEY,
        version: '2.0.0',
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in alreadyActive ? alreadyActive.error : '').toContain(
      'already the active version',
    );

    // ---- rollback to v1: one operation, definition metadata restored ----
    const rolled = await manageConnections(
      {
        action: 'rollback_connector_version',
        connector_key: KEY,
        version: '1.0.0',
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in rolled ? rolled.error : undefined).toBeUndefined();
    if (!('previous_version' in rolled))
      throw new Error('unexpected result shape');
    expect(rolled.previous_version).toBe('2.0.0');
    expect(rolled.version).toBe('1.0.0');

    const defAfterRollback = await sql`
      SELECT version, description FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = ${KEY} AND status = 'active'
    `;
    expect((defAfterRollback[0] as { version: string }).version).toBe('1.0.0');
    expect((defAfterRollback[0] as { description: string }).description).toBe(
      'V1',
    );

    // Rolling back consumed nothing: v2 stays retained for a roll-forward.
    const finalGet = await manageConnections(
      { action: 'get_connector_source', connector_key: KEY },
      TEST_ENV,
      ctx,
    );
    if (!('active_version' in finalGet))
      throw new Error('unexpected result shape');
    expect(finalGet.active_version).toBe('1.0.0');
    expect(finalGet.source_code).toContain("marker: 'V1'");
    expect(finalGet.versions.map((v) => v.version).sort()).toEqual([
      '1.0.0',
      '2.0.0',
    ]);
  }, 240_000);

  it('refuses to overwrite a RETAINED non-active version with different code (#2045 review)', async () => {
    const sql = getTestDb();
    const RKEY = 'zz.retainedclobber';
    const src = (version: string, marker: string) =>
      probeSource(version, marker).replace(new RegExp(KEY, 'g'), RKEY);

    // install v1, bump to v2 — v1 is now retained but NOT active.
    await manageConnections(
      { action: 'install_connector', source_code: src('1.0.0', 'R1') },
      TEST_ENV,
      ctx,
    );
    await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: RKEY,
        source_code: src('2.0.0', 'R2'),
        expected_version: '1.0.0',
      },
      TEST_ENV,
      ctx,
    );

    // Updating to v1 (retained, non-active) with DIFFERENT code must be refused:
    // the old guard only checked the ACTIVE version and let this clobber v1's
    // stored rollback code.
    const clobber = await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: RKEY,
        source_code: src('1.0.0', 'R1-tampered'),
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in clobber ? clobber.error : '').toContain(
      "Version '1.0.0'",
    );
    expect('error' in clobber ? clobber.error : '').toContain(
      'Bump the version',
    );

    // v1's retained source is intact on EVERY row (shared + dual-write org
    // copy) — the rollback target was not corrupted.
    const v1 = await sql`
      SELECT source_code FROM connector_versions
      WHERE connector_key = ${RKEY} AND version = '1.0.0'
    `;
    expect(v1.length).toBeGreaterThan(0);
    for (const row of v1) {
      expect((row as { source_code: string }).source_code).toContain(
        "marker: 'R1'",
      );
      expect((row as { source_code: string }).source_code).not.toContain(
        'R1-tampered',
      );
    }
  }, 120_000);

  it('clears per-feed checkpoints on a version bump and keeps them without one', async () => {
    const sql = getTestDb();
    const KEY2 = 'zz.checkpointprobe';
    const src = (version: string, marker: string) =>
      probeSource(version, marker).replaceAll(KEY, KEY2);

    const installed = await manageConnections(
      { action: 'install_connector', source_code: src('1.0.0', 'C1') },
      TEST_ENV,
      ctx,
    );
    expect('error' in installed ? installed.error : undefined).toBeUndefined();

    // A connection + feed of this connector carrying a committed checkpoint.
    const [conn] = await sql`
      INSERT INTO connections (organization_id, connector_key, display_name, slug, status)
      VALUES (${orgId}, ${KEY2}, 'Checkpoint Probe Conn', 'zz-checkpoint-probe-conn', 'active')
      RETURNING id
    `;
    const [feed] = await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, checkpoint)
      VALUES (${orgId}, ${conn.id}, 'items', 'active', ${sql.json({ cursor: 'old-cursor' })})
      RETURNING id
    `;

    // Same-version refresh with identical code: checkpoint must survive.
    const refresh = await manageConnections(
      { action: 'update_connector_source', connector_key: KEY2, source_code: src('1.0.0', 'C1') },
      TEST_ENV,
      ctx,
    );
    expect('error' in refresh ? refresh.error : undefined).toBeUndefined();
    const [kept] = await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
    expect(kept.checkpoint).toEqual({ cursor: 'old-cursor' });

    // Version bump: the old cursor must not gate what the new code collects.
    const bumped = await manageConnections(
      { action: 'update_connector_source', connector_key: KEY2, source_code: src('1.0.1', 'C2') },
      TEST_ENV,
      ctx,
    );
    expect('error' in bumped ? bumped.error : undefined).toBeUndefined();
    const [cleared] = await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
    expect(cleared.checkpoint).toBeNull();
  }, 120_000);

  it('refuses to update a connector that is not installed', async () => {
    const result = await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: 'zz.neverinstalled',
        source_code: probeSource('1.0.0', 'X').replace(
          KEY,
          'zz.neverinstalled',
        ),
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in result ? result.error : '').toContain(
      'not installed in this organization',
    );
  }, 60_000);
});
