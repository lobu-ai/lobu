/**
 * Org-preferring connector_versions resolution + the #2045 cross-org fence
 * (PR 2 of the isolation rollout).
 *
 * The regression this locks in: two orgs installing DIFFERENT code under the
 * same custom (connector_key, version) used to last-writer-win on one global
 * row — org A would silently EXECUTE org B's code. With org-preferring
 * resolution each org's own row shadows the shared row for that org only.
 *
 * Step 3 (org-only custom writes + backfill) is in: custom installs write no
 * shared rows at all, so the guarantees below hold with no transitional
 * exposure.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { seedOwnerContext } from '../../setup/test-fixtures';
import type { ToolContext } from '../../../tools/registry';
import {
  ensureConnectorInstalled,
  resolveConnectorCodeForKey,
  upsertBundledConnectorForOrg,
} from '../../../utils/ensure-connector-installed';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

function sourceFor(key: string, version: string, marker: string): string {
  return `
export default class IsolationProbeConnector {
  definition = {
    key: '${key}',
    name: 'Isolation Probe',
    description: '${marker}',
    version: '${version}',
  };
  async sync(ctx) { await ctx.commit([], null); return { status: 'complete' }; }
  async execute() { return { marker: '${marker}' }; }
}
`;
}

describe('connector_versions org isolation (#2045 read cutover)', () => {
  let ctxA: ToolContext;
  let ctxB: ToolContext;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    const a = await seedOwnerContext({ orgName: 'Isolation Org A', userName: 'Iso User A' });
    const b = await seedOwnerContext({ orgName: 'Isolation Org B', userName: 'Iso User B' });
    ctxA = a.ctx;
    ctxB = b.ctx;
    orgA = a.org.id;
    orgB = b.org.id;
  });

  it('resolves each org its OWN code when two orgs collide on (key, version)', async () => {
    const KEY = 'zz.isocollide';
    for (const [ctx, marker] of [
      [ctxA, 'CODE-A'],
      [ctxB, 'CODE-B'],
    ] as const) {
      const res = await manageConnections(
        { action: 'install_connector', source_code: sourceFor(KEY, '1.0.0', marker) },
        TEST_ENV,
        ctx
      );
      expect('error' in res ? res.error : undefined).toBeUndefined();
    }

    // Pre-cutover this returned CODE-B for BOTH orgs (B's install clobbered
    // the single global row). Each org now executes its own bytes.
    const codeA = await resolveConnectorCodeForKey(KEY, orgA, '1.0.0');
    const codeB = await resolveConnectorCodeForKey(KEY, orgB, '1.0.0');
    expect(codeA).toContain('CODE-A');
    expect(codeA).not.toContain('CODE-B');
    expect(codeB).toContain('CODE-B');
    expect(codeB).not.toContain('CODE-A');

    // Read isolation through the tool surface: each org reads back its own
    // source from get_connector_source.
    const gotA = await manageConnections(
      { action: 'get_connector_source', connector_key: KEY },
      TEST_ENV,
      ctxA
    );
    const gotB = await manageConnections(
      { action: 'get_connector_source', connector_key: KEY },
      TEST_ENV,
      ctxB
    );
    expect('source_code' in gotA ? gotA.source_code : '').toContain('CODE-A');
    expect('source_code' in gotA ? gotA.source_code : '').not.toContain('CODE-B');
    expect('source_code' in gotB ? gotB.source_code : '').toContain('CODE-B');
  });

  it("cannot read or roll back to a version that exists only as another org's private row", async () => {
    const KEY = 'zz.isofence';
    const install = await manageConnections(
      { action: 'install_connector', source_code: sourceFor(KEY, '1.0.0', 'FENCE-BASE') },
      TEST_ENV,
      ctxB
    );
    expect('error' in install ? install.error : undefined).toBeUndefined();

    // Org A retains a private 3.0.0 of the same key — a real install now
    // produces exactly an org-only row.
    const installA = await manageConnections(
      { action: 'install_connector', source_code: sourceFor(KEY, '3.0.0', 'PRIVATE-A') },
      TEST_ENV,
      ctxA
    );
    expect('error' in installA ? installA.error : undefined).toBeUndefined();
    const sql = getTestDb();
    const sharedRows = await sql`
      SELECT 1 FROM connector_versions
      WHERE connector_key = ${KEY} AND version = '3.0.0' AND organization_id IS NULL
    `;
    expect(sharedRows).toHaveLength(0);

    // Org B must not see 3.0.0 in history…
    const gotB = await manageConnections(
      { action: 'get_connector_source', connector_key: KEY },
      TEST_ENV,
      ctxB
    );
    expect('error' in gotB ? gotB.error : undefined).toBeUndefined();
    const versions = 'versions' in gotB ? gotB.versions : [];
    const versionStrings = versions.map((v: { version: string }) => v.version);
    expect(versionStrings).toContain('1.0.0');
    expect(versionStrings).not.toContain('3.0.0');

    // …nor activate it.
    const rolled = await manageConnections(
      { action: 'rollback_connector_version', connector_key: KEY, version: '3.0.0' },
      TEST_ENV,
      ctxB
    );
    expect('error' in rolled ? rolled.error : '').toContain("No retained version '3.0.0'");
  });

  it('resolves the active definition version before preferring an org-local artifact', async () => {
    // Reproduce the production Calendar shape: an org retains an older private
    // artifact, then the bundled catalog advances the active definition to a
    // newer shared version. A no-version execution must follow the ACTIVE
    // definition; org-local preference only applies within that exact version.
    const KEY = 'hackernews';
    const staleVersion = '0.0.1-stale-org';
    const stale = await manageConnections(
      {
        action: 'install_connector',
        source_code: sourceFor(KEY, staleVersion, 'STALE-ORG-CODE'),
      },
      TEST_ENV,
      ctxA
    );
    expect('error' in stale ? stale.error : undefined).toBeUndefined();

    const promoted = await upsertBundledConnectorForOrg({
      organizationId: orgA,
      connectorKey: KEY,
    });
    expect(promoted).not.toBeNull();
    expect(promoted?.version).not.toBe(staleVersion);

    const sql = getTestDb();
    const [definition] = await sql`
      SELECT version FROM connector_definitions
      WHERE organization_id = ${orgA} AND key = ${KEY} AND status = 'active'
      LIMIT 1
    `;
    expect(definition?.version).toBe(promoted?.version);

    // This is the regression: old resolution picked the org-local stale row
    // before considering the active definition's newer shared version.
    const activeCode = await resolveConnectorCodeForKey(KEY, orgA);
    expect(activeCode).not.toContain('STALE-ORG-CODE');

    // Explicit historical-version resolution keeps rollback/debug semantics:
    // within the requested version, the org-local artifact still wins.
    const staleCode = await resolveConnectorCodeForKey(KEY, orgA, staleVersion);
    expect(staleCode).toContain('STALE-ORG-CODE');
  });

  it('branching a bundled connector shadows it for the branching org only', async () => {
    // Org B runs the stock bundled connector.
    const installed = await ensureConnectorInstalled({
      organizationId: orgB,
      connectorKey: 'hackernews',
    });
    expect(installed).toBe(true);

    // Org A branches it: same key, custom code under its own version.
    const branch = await manageConnections(
      {
        action: 'install_connector',
        source_code: sourceFor('hackernews', '99.0.0-acme', 'ACME-BRANCH'),
      },
      TEST_ENV,
      ctxA
    );
    expect('error' in branch ? branch.error : undefined).toBeUndefined();

    // Org A resolves its branch (org row shadows the bundled row)…
    const codeA = await resolveConnectorCodeForKey('hackernews', orgA);
    expect(codeA).toContain('ACME-BRANCH');

    // …while org B still resolves the stock bundled connector.
    const codeB = await resolveConnectorCodeForKey('hackernews', orgB);
    expect(codeB).not.toContain('ACME-BRANCH');
    expect(codeB.length).toBeGreaterThan(0);
  });
});
