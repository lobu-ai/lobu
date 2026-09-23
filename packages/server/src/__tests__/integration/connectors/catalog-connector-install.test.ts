import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { findBundledConnectorFile } from '../../../utils/connector-catalog';
import { resolveConnectorInstallSource } from '../../../utils/connector-definition-install';
import { resolveConnectorCodeForKey } from '../../../utils/ensure-connector-installed';
import { initWorkspaceProvider } from '../../../workspace';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestConnection, seedOwnerContext } from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

describe('manage_connections install_connector — catalog connector_id', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('enables a reviewed catalog connector by id and is idempotent', async () => {
    const { org, ctx } = await seedOwnerContext({
      orgName: 'Catalog Connector Org',
      userName: 'Catalog Connector User',
    });

    const first = await manageConnections(
      { action: 'install_connector', connector_id: 'hackernews' },
      TEST_ENV,
      ctx
    );

    expect('error' in first ? first.error : undefined).toBeUndefined();
    expect('connector_key' in first ? first.connector_key : undefined).toBe('hackernews');
    expect('installed' in first ? first.installed : undefined).toBe(true);

    const second = await manageConnections(
      { action: 'install_connector', connector_id: 'hackernews' },
      TEST_ENV,
      ctx
    );

    expect('error' in second ? second.error : undefined).toBeUndefined();
    expect('connector_key' in second ? second.connector_key : undefined).toBe('hackernews');
    expect('updated' in second ? second.updated : undefined).toBe(true);

    const sql = getTestDb();
    const rows = (await sql`
      SELECT key, COUNT(*)::int AS count
      FROM connector_definitions
      WHERE organization_id = ${org.id} AND key = 'hackernews' AND status = 'active'
      GROUP BY key
    `) as unknown as Array<{ key: string; count: number }>;

    expect(rows).toEqual([{ key: 'hackernews', count: 1 }]);
  });
});

describe('install_connector — source for a built-in key', () => {
  const savedCloudMode = process.env.LOBU_CLOUD_MODE;
  const uploadedVersion = '0.0.1-uploaded';
  let imageVersion: string;
  let imageName: string;

  beforeAll(async () => {
    await initWorkspaceProvider();
    const { metadata } = await resolveConnectorInstallSource({
      sourceUri: pathToFileURL(imageFile()).href,
    });
    imageVersion = metadata.version;
    imageName = metadata.name;
    expect(imageVersion).not.toBe(uploadedVersion);
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(() => {
    if (savedCloudMode === undefined) delete process.env.LOBU_CLOUD_MODE;
    else process.env.LOBU_CLOUD_MODE = savedCloudMode;
  });

  const imageFile = () => {
    const file = findBundledConnectorFile('rss');
    if (!file) throw new Error('rss must ship as a bundled connector');
    return file;
  };

  function uploadedSource(key = 'rss') {
    return `export default class UploadedConnector {
      definition = { key: '${key}', name: 'Uploaded Connector', version: '${uploadedVersion}' };
      async sync(ctx) { await ctx.commit([], null); return { status: 'complete' }; }
      async execute() { return { marker: 'UPLOADED-SOURCE' }; }
    }`;
  }

  async function versionRows(orgId: string) {
    const sql = getTestDb();
    return (await sql`
      SELECT d.version, d.name,
        cv.organization_id IS NOT NULL AS org_scoped, cv.compiled_code IS NOT NULL AS has_code
      FROM connector_definitions d
      JOIN connector_versions cv ON cv.connector_key = d.key AND cv.version = d.version
        AND (cv.organization_id = d.organization_id OR cv.organization_id IS NULL)
      WHERE d.organization_id = ${orgId} AND d.key = 'rss' AND d.status = 'active'
    `) as unknown as Array<{ version: string; name: string; org_scoped: boolean; has_code: boolean }>;
  }

  async function orgScopedRowCount(orgId: string) {
    const sql = getTestDb();
    const [row] = (await sql`
      SELECT COUNT(*)::int AS count FROM connector_versions
      WHERE organization_id = ${orgId} AND connector_key = 'rss'
    `) as unknown as Array<{ count: number }>;
    return row.count;
  }

  it('in cloud, a source_uri install of the image file stores no org copy', async () => {
    process.env.LOBU_CLOUD_MODE = '1';
    const { org, ctx } = await seedOwnerContext({ orgName: 'Cloud Uri Org', userName: 'Cloud Uri User' });

    const result = await manageConnections(
      { action: 'install_connector', source_uri: pathToFileURL(imageFile()).href },
      TEST_ENV,
      ctx
    );

    expect('error' in result ? result.error : undefined).toBeUndefined();
    expect('connector_key' in result ? result.connector_key : undefined).toBe('rss');
    expect(await orgScopedRowCount(org.id)).toBe(0);
    expect(await versionRows(org.id)).toEqual([
      { version: imageVersion, name: imageName, org_scoped: false, has_code: false },
    ]);
  });

  it('in cloud, a source_code install of a built-in key stores no org copy', async () => {
    process.env.LOBU_CLOUD_MODE = '1';
    const { org, ctx } = await seedOwnerContext({ orgName: 'Cloud Code Org', userName: 'Cloud Code User' });

    const result = await manageConnections(
      { action: 'install_connector', source_code: uploadedSource() },
      TEST_ENV,
      ctx
    );

    expect('error' in result ? result.error : undefined).toBeUndefined();
    expect('version' in result ? result.version : undefined).toBe(imageVersion);
    expect(await orgScopedRowCount(org.id)).toBe(0);
    expect(await versionRows(org.id)).toEqual([
      { version: imageVersion, name: imageName, org_scoped: false, has_code: false },
    ]);
    expect(await resolveConnectorCodeForKey('rss', org.id)).not.toContain('UPLOADED-SOURCE');
  });

  it('in cloud, update_connector_source on a built-in key stores no org copy', async () => {
    process.env.LOBU_CLOUD_MODE = '1';
    const { org, ctx } = await seedOwnerContext({ orgName: 'Cloud Update Org', userName: 'Cloud Update User' });
    const installed = await manageConnections({ action: 'install_connector', connector_id: 'rss' }, TEST_ENV, ctx);
    expect('error' in installed ? installed.error : undefined).toBeUndefined();

    const result = await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: 'rss',
        source_code: uploadedSource(),
        expected_version: imageVersion,
      },
      TEST_ENV,
      ctx
    );

    expect('error' in result ? result.error : undefined).toBeUndefined();
    expect('version' in result ? result.version : undefined).toBe(imageVersion);
    expect(await orgScopedRowCount(org.id)).toBe(0);
    expect(await versionRows(org.id)).toEqual([
      { version: imageVersion, name: imageName, org_scoped: false, has_code: false },
    ]);
  });

  it('self-hosted keeps the org copy, which is a real override there', async () => {
    delete process.env.LOBU_CLOUD_MODE;
    const { org, ctx } = await seedOwnerContext({ orgName: 'Self Hosted Org', userName: 'Self Hosted User' });

    const result = await manageConnections(
      { action: 'install_connector', source_code: uploadedSource() },
      TEST_ENV,
      ctx
    );

    expect('error' in result ? result.error : undefined).toBeUndefined();
    expect(await orgScopedRowCount(org.id)).toBe(1);
    expect(await versionRows(org.id)).toEqual([
      { version: uploadedVersion, name: 'Uploaded Connector', org_scoped: true, has_code: true },
    ]);
    expect(await resolveConnectorCodeForKey('rss', org.id)).toContain('UPLOADED-SOURCE');
  });

  it('in cloud, updating a legacy org version selects the image and resets its cursor once', async () => {
    delete process.env.LOBU_CLOUD_MODE;
    const { org, ctx } = await seedOwnerContext({ orgName: 'Legacy Source Org', userName: 'Legacy Source User' });
    const installed = await manageConnections(
      { action: 'install_connector', source_code: uploadedSource() },
      TEST_ENV,
      ctx
    );
    expect('error' in installed ? installed.error : undefined).toBeUndefined();

    const sql = getTestDb();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'rss',
      createDefaultFeed: false,
    });
    const [feed] = await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, checkpoint)
      VALUES (${org.id}, ${connection.id}, 'articles', 'active', '{"cursor":"old-cursor"}'::jsonb)
      RETURNING id
    `;
    process.env.LOBU_CLOUD_MODE = '1';

    const updated = await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: 'rss',
        source_code: uploadedSource(),
        expected_version: uploadedVersion,
      },
      TEST_ENV,
      ctx
    );
    expect('error' in updated ? updated.error : undefined).toBeUndefined();
    expect('previous_version' in updated ? updated.previous_version : undefined).toBe(uploadedVersion);
    expect('version' in updated ? updated.version : undefined).toBe(imageVersion);
    expect(await versionRows(org.id)).toEqual([
      { version: imageVersion, name: imageName, org_scoped: false, has_code: false },
    ]);
    expect(await orgScopedRowCount(org.id)).toBe(1);
    const [reset] = await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
    expect(reset.checkpoint).toBeNull();

    await sql`UPDATE feeds SET checkpoint = '{"cursor":"image-cursor"}'::jsonb WHERE id = ${feed.id}`;
    const refreshed = await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: 'rss',
        source_code: uploadedSource(),
        expected_version: imageVersion,
      },
      TEST_ENV,
      ctx
    );
    expect('error' in refreshed ? refreshed.error : undefined).toBeUndefined();
    const [kept] = await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
    expect(kept.checkpoint).toEqual({ cursor: 'image-cursor' });
  });

  it('in cloud, a custom key retains the uploaded source for execution', async () => {
    process.env.LOBU_CLOUD_MODE = '1';
    const { org, ctx } = await seedOwnerContext({ orgName: 'Cloud Custom Org', userName: 'Cloud Custom User' });
    const key = 'zz.installroutingprobe';

    const result = await manageConnections(
      { action: 'install_connector', source_code: uploadedSource(key) },
      TEST_ENV,
      ctx
    );

    expect('error' in result ? result.error : undefined).toBeUndefined();
    expect('version' in result ? result.version : undefined).toBe(uploadedVersion);

    const updated = await manageConnections(
      {
        action: 'update_connector_source',
        connector_key: key,
        source_code: uploadedSource(key),
        expected_version: uploadedVersion,
      },
      TEST_ENV,
      ctx
    );
    expect('error' in updated ? updated.error : undefined).toBeUndefined();
    expect('version' in updated ? updated.version : undefined).toBe(uploadedVersion);
    expect(await resolveConnectorCodeForKey(key, org.id)).toContain('UPLOADED-SOURCE');
  });
});
