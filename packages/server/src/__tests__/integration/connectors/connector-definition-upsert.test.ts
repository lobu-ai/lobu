/**
 * upsertConnectorDefinitionRecords: the active-update (upgrade) path must still
 * persist the connector_versions row. Regression guard — an earlier refactor
 * early-returned after updating an active definition and skipped the version
 * upsert, leaving the definition pointing at a version with no executable
 * source record.
 *
 * A connector's `agentTooling` declaration must also survive both branches into
 * `connector_definitions.agent_tooling` — that column, not connector code, is
 * what the deployment resolver reads — and a later version that drops it must
 * clear it.
 */

import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestOrganization } from '../../setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { upsertConnectorDefinitionRecords } from '../../../utils/connector-definition-install';
import type { ConnectorMetadata } from '../../../utils/connector-compiler';
import { parseAgentTooling } from '../../../gateway/agent-tooling/resolver';

function metadataFor(version: string): ConnectorMetadata {
  return {
    key: 'upsert-probe',
    name: 'Upsert Probe',
    version,
    authSchema: null,
    webhook: null,
    feeds: null,
    actions: null,
    automationEvents: [
      {
        key: `probe.updated.${version}`,
        label: `Probe updated ${version}`,
        capabilities: { steering: version === '1.1.0' },
      },
    ],
    optionsSchema: null,
  };
}

function versionRecordFor(version: string) {
  return {
    compiledCode: `// compiled ${version}`,
    compiledCodeHash: `hash-${version}`,
    compileConfigHash: COMPILE_CONFIG_HASH,
    sourceCode: `// source ${version}`,
    sourcePath: `upsert-probe@${version}.ts`,
  };
}

const AGENT_TOOLING = {
  nix: { packages: ['gh'] },
  env: [{ name: 'GH_TOKEN', credential: 'lease' as const }],
  domains: ['api.github.com', 'github.com'],
};

function agentToolingMetadataFor(
  version: string,
  agentTooling: ConnectorMetadata['agentTooling']
): ConnectorMetadata {
  return {
    key: 'agent-tooling-probe',
    name: 'Agent Tooling Probe',
    version,
    authSchema: null,
    webhook: null,
    feeds: null,
    actions: null,
    automationEvents: null,
    optionsSchema: null,
    agentTooling,
  };
}

function agentToolingVersionRecordFor(version: string) {
  return {
    compiledCode: `// compiled ${version}`,
    compiledCodeHash: `hash-${version}`,
    compileConfigHash: COMPILE_CONFIG_HASH,
    sourceCode: `// source ${version}`,
    sourcePath: `agent-tooling-probe@${version}.ts`,
  };
}

async function installAgentToolingProbe(
  orgId: string,
  version: string,
  agentTooling: ConnectorMetadata['agentTooling']
): Promise<void> {
  await upsertConnectorDefinitionRecords({
    sql: getTestDb(),
    organizationId: orgId,
    metadata: agentToolingMetadataFor(version, agentTooling),
    versionRecord: agentToolingVersionRecordFor(version),
    versionScope: 'organization',
  });
}

async function storedAgentTooling(orgId: string): Promise<unknown> {
  const rows = await getTestDb()`
    SELECT agent_tooling FROM connector_definitions
    WHERE organization_id = ${orgId} AND key = 'agent-tooling-probe' AND status = 'active'
  `;
  return rows[0]?.agent_tooling ?? null;
}

describe('upsertConnectorDefinitionRecords', () => {
  let orgId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Upsert Probe Org' });
    orgId = org.id;
  });

  it('persists the connector_versions row on both the initial install and the upgrade', async () => {
    const sql = getTestDb();

    // Initial install → INSERT branch.
    const first = await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: metadataFor('1.0.0'),
      versionRecord: versionRecordFor('1.0.0'),
      versionScope: 'organization',
    });
    expect(first.updated).toBe(false);

    // Re-install a new version → active-UPDATE branch. This must STILL write the
    // connector_versions row for 1.1.0 (the regression: early-return skipped it).
    const second = await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: metadataFor('1.1.0'),
      versionRecord: versionRecordFor('1.1.0'),
      versionScope: 'organization',
    });
    expect(second.updated).toBe(true);

    // Org-scoped writes (#2045): org-supplied content lands only on the org's
    // own rows — the shared namespace holds bundled pointers alone.
    const versions = await sql<
      {
        version: string;
        organization_id: string | null;
        source_code: string | null;
        compile_config_hash: string | null;
      }[]
    >`
      SELECT version, organization_id, source_code, compile_config_hash FROM connector_versions
      WHERE connector_key = 'upsert-probe'
      ORDER BY version
    `;
    expect(versions.every((v) => v.organization_id === orgId)).toBe(true);
    const byVersion = new Map(versions.map((v) => [v.version, v.source_code]));
    // Both versions' executable source rows exist — the definition never points
    // at a version with no source record.
    expect(byVersion.has('1.0.0')).toBe(true);
    expect(byVersion.get('1.1.0')).toBe('// source 1.1.0');
    // Every installed artifact carries the compile-config fingerprint —
    // resolveConnectorCode refuses unstamped/mismatched artifacts as stale.
    for (const v of versions) {
      expect(v.compile_config_hash).toBe(COMPILE_CONFIG_HASH);
    }

    // The definition itself reflects the upgrade.
    const def = await sql<{ version: string; automation_events: Array<Record<string, unknown>> }[]>`
      SELECT version, automation_events FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = 'upsert-probe' AND status = 'active'
    `;
    expect(def[0]?.version).toBe('1.1.0');
    expect(def[0]?.automation_events).toEqual([
      {
        key: 'probe.updated.1.1.0',
        label: 'Probe updated 1.1.0',
        capabilities: { steering: true },
      },
    ]);
  });

  it('rejects a reserved chrome.* key at the shared writer, and admits its device manifest', async () => {
    // The guard lives in the shared definition writer rather than on the
    // compile path, because a device-manifest install skips compilation
    // entirely. This exercises that wiring — the pure helper's own unit tests
    // cover the decision, but only this proves the writer actually consults it.
    const sql = getTestDb();
    const chromeMetadata: ConnectorMetadata = {
      ...metadataFor('1.0.0'),
      key: 'chrome.probe',
    };

    await expect(
      upsertConnectorDefinitionRecords({
        sql,
        organizationId: orgId,
        metadata: chromeMetadata,
        // Ordinary compiled install: exactly what cannot live on a chrome.* key.
        versionRecord: versionRecordFor('1.0.0'),
        versionScope: 'organization',
      })
    ).rejects.toThrow(/reserved 'chrome\.\*' namespace/);

    // Nothing was persisted — the guard runs before any definition or version
    // row can become active.
    const rejected = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM connector_definitions WHERE key = 'chrome.probe'
    `;
    expect(rejected[0]?.count).toBe('0');

    // The legitimate path still works: an identity, no payload.
    const admitted = await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: chromeMetadata,
      versionRecord: {
        compiledCode: null,
        compiledCodeHash: 'manifest-hash-chrome-probe',
        compileConfigHash: null,
        sourceCode: null,
        sourcePath: 'device-manifest://chrome-extension/chrome.probe@1.0.0',
      },
      versionScope: 'organization',
    });
    expect(admitted.updated).toBe(false);
  });

  it('replaces compiled provenance atomically with a device-manifest artifact', async () => {
    const sql = getTestDb();
    const version = '2.0.0';
    await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: metadataFor(version),
      versionRecord: versionRecordFor(version),
      versionScope: 'organization',
    });

    await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: metadataFor(version),
      versionRecord: {
        compiledCode: null,
        compiledCodeHash: 'manifest-hash-2.0.0',
        compileConfigHash: null,
        sourceCode: null,
        sourcePath: 'device-manifest://chrome-extension/upsert-probe@2.0.0',
      },
      versionScope: 'organization',
    });

    const [artifact] = (await sql`
      SELECT compiled_code, compiled_code_hash, compile_config_hash, source_code, source_path
      FROM connector_versions
      WHERE organization_id = ${orgId}
        AND connector_key = 'upsert-probe'
        AND version = ${version}
    `) as unknown as Array<{
      compiled_code: string | null;
      compiled_code_hash: string | null;
      compile_config_hash: string | null;
      source_code: string | null;
      source_path: string | null;
    }>;
    expect(artifact).toEqual({
      compiled_code: null,
      compiled_code_hash: 'manifest-hash-2.0.0',
      compile_config_hash: null,
      source_code: null,
      source_path: 'device-manifest://chrome-extension/upsert-probe@2.0.0',
    });
  });

  it('replaces device-manifest provenance atomically with compiled source', async () => {
    const sql = getTestDb();
    const version = '3.0.0';
    await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: metadataFor(version),
      versionRecord: {
        compiledCode: null,
        compiledCodeHash: 'manifest-hash-3.0.0',
        compileConfigHash: null,
        sourceCode: null,
        sourcePath: 'device-manifest://chrome-extension/upsert-probe@3.0.0',
      },
      versionScope: 'organization',
    });

    await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: metadataFor(version),
      versionRecord: versionRecordFor(version),
      versionScope: 'organization',
    });

    const [artifact] = (await sql`
      SELECT compiled_code, compiled_code_hash, compile_config_hash, source_code, source_path
      FROM connector_versions
      WHERE organization_id = ${orgId}
        AND connector_key = 'upsert-probe'
        AND version = ${version}
    `) as unknown as Array<{
      compiled_code: string | null;
      compiled_code_hash: string | null;
      compile_config_hash: string | null;
      source_code: string | null;
      source_path: string | null;
    }>;
    expect(artifact).toEqual({
      compiled_code: `// compiled ${version}`,
      compiled_code_hash: `hash-${version}`,
      compile_config_hash: COMPILE_CONFIG_HASH,
      source_code: `// source ${version}`,
      source_path: `upsert-probe@${version}.ts`,
    });
  });

  it('replaces device-manifest provenance atomically with a metadata-only artifact', async () => {
    const sql = getTestDb();
    const version = '4.0.0';
    await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: metadataFor(version),
      versionRecord: {
        compiledCode: null,
        compiledCodeHash: 'manifest-hash-4.0.0',
        compileConfigHash: null,
        sourceCode: null,
        sourcePath: 'device-manifest://chrome-extension/upsert-probe@4.0.0',
      },
      versionScope: 'organization',
    });

    await upsertConnectorDefinitionRecords({
      sql,
      organizationId: orgId,
      metadata: metadataFor(version),
      versionRecord: {
        compiledCode: null,
        compiledCodeHash: null,
        compileConfigHash: null,
        sourceCode: null,
        sourcePath: null,
      },
      versionScope: 'organization',
      replaceVersionArtifact: true,
    });

    const [artifact] = (await sql`
      SELECT compiled_code, compiled_code_hash, compile_config_hash, source_code, source_path
      FROM connector_versions
      WHERE organization_id = ${orgId}
        AND connector_key = 'upsert-probe'
        AND version = ${version}
    `) as unknown as Array<Record<string, string | null>>;
    expect(artifact).toEqual({
      compiled_code: null,
      compiled_code_hash: null,
      compile_config_hash: null,
      source_code: null,
      source_path: null,
    });
  });

  it('round-trips an agentTooling declaration through install, upgrade, and removal', async () => {
    // INSERT branch.
    await installAgentToolingProbe(orgId, '1.0.0', AGENT_TOOLING);
    expect(await storedAgentTooling(orgId)).toEqual(AGENT_TOOLING);
    // The stored shape is exactly what the resolver accepts — no adapter between
    // the install path and the read path.
    expect(parseAgentTooling(await storedAgentTooling(orgId))).toEqual(AGENT_TOOLING);

    // Active-UPDATE branch: an upgrade must carry the declaration forward.
    await installAgentToolingProbe(orgId, '1.1.0', {
      ...AGENT_TOOLING,
      nix: { packages: ['gh', 'git'] },
    });
    expect(await storedAgentTooling(orgId)).toEqual({
      ...AGENT_TOOLING,
      nix: { packages: ['gh', 'git'] },
    });

    // A version that drops the declaration must clear the column, not keep a
    // stale contribution alive.
    await installAgentToolingProbe(orgId, '1.2.0', null);
    expect(await storedAgentTooling(orgId)).toBeNull();
  });

  it('leaves agent_tooling NULL for a connector that declares nothing', async () => {
    const org = await createTestOrganization({ name: 'No Tooling Org' });
    await installAgentToolingProbe(org.id, '1.0.0', undefined);
    expect(await storedAgentTooling(org.id)).toBeNull();
  });
});
