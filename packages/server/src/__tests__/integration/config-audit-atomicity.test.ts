import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { initWorkspaceProvider } from '../../workspace';
import { manageConnections } from '../../tools/admin/manage_connections';
import { manageAuthProfiles } from '../../tools/admin/manage_auth_profiles';
import { createAuthProfile } from '../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnectorDefinition, seedOwnerContext } from '../setup/test-fixtures';
import type { ToolContext } from '../../tools/registry';

const env = { ENVIRONMENT: 'test', DATABASE_URL: process.env.DATABASE_URL } as unknown as Env;
const key = 'zz.audit-atomicity';
let ctx: ToolContext;
async function rejectAudit<T>(run: () => Promise<T>): Promise<T> {
  const sql = getTestDb();
  await sql.unsafe(`CREATE OR REPLACE FUNCTION reject_synthetic_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'category' = 'config' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe('CREATE TRIGGER reject_synthetic_config_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_synthetic_config_audit()');
  try { return await run(); }
  finally { await sql.unsafe('DROP TRIGGER reject_synthetic_config_audit ON events'); await sql.unsafe('DROP FUNCTION reject_synthetic_config_audit()'); }
}
async function attempt(run: () => Promise<unknown>) {
  try { return await run(); } catch (error) { return { error: String(error) }; }
}
describe('configuration state and audit share a commit', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    ctx = (await seedOwnerContext()).ctx;
    await createTestConnectorDefinition({ key, name: 'Audit fixture', organization_id: ctx.organizationId, auth_schema: { methods: [{ type: 'none' }] } });
  });
  it('rolls back connection create, update and delete when audit fails', async () => {
    const sql = getTestDb();
    const create = (slug: string) => manageConnections({ action: 'create', connector_key: key, slug, display_name: 'Before', config: {} }, env, ctx);
    expect(await rejectAudit(() => attempt(() => create('failed-create')))).toHaveProperty('error');
    expect(await sql`SELECT id FROM connections WHERE organization_id = ${ctx.organizationId} AND slug = 'failed-create'`).toHaveLength(0);
    const made = await create('atomic-connection');
    expect(made).toMatchObject({ action: 'create' });
    if (!('connection' in made)) throw new Error(JSON.stringify(made));
    const id = Number(made.connection.id);
    expect(await rejectAudit(() => attempt(() => manageConnections({ action: 'update', connection_id: id, display_name: 'After' }, env, ctx)))).toHaveProperty('error');
    expect((await sql`SELECT display_name FROM connections WHERE id = ${id}`)[0].display_name).toBe('Before');
    expect(await rejectAudit(() => attempt(() => manageConnections({ action: 'delete', connection_id: id }, env, ctx)))).toHaveProperty('error');
    expect((await sql`SELECT deleted_at FROM connections WHERE id = ${id}`)[0].deleted_at).toBeNull();
    const audits = await sql`SELECT metadata, payload_data, created_by FROM events WHERE organization_id = ${ctx.organizationId} AND metadata->>'resource_kind' = 'connection' AND metadata->>'resource_id' = ${String(id)}`;
    expect(audits).toHaveLength(1);
    expect(audits[0].created_by).toBe(ctx.userId);
    expect(audits[0].payload_data.before).toBeNull();
    expect(audits[0].payload_data.state.display_name).toBe('Before');
  });
  it('rolls back credential writes and deletion when audit fails', async () => {
    const sql = getTestDb();
    const profile = await createAuthProfile({ organizationId: ctx.organizationId, connectorKey: key, slug: 'atomic-secret', displayName: 'Before', profileKind: 'env', authData: { API_KEY: 'synthetic-old-secret' }, createdBy: ctx.userId! });
    const before = await sql`SELECT ciphertext FROM agent_secrets WHERE organization_id = ${ctx.organizationId} ORDER BY name`;
    expect(await rejectAudit(() => attempt(() => manageAuthProfiles({ action: 'update_auth_profile', auth_profile_slug: profile.slug, display_name: 'After', credentials: { API_KEY: 'synthetic-new-secret' } }, env, ctx)))).toHaveProperty('error');
    expect((await sql`SELECT display_name FROM auth_profiles WHERE id = ${profile.id}`)[0].display_name).toBe('Before');
    expect(await sql`SELECT ciphertext FROM agent_secrets WHERE organization_id = ${ctx.organizationId} ORDER BY name`).toEqual(before);
    expect(await rejectAudit(() => attempt(() => manageAuthProfiles({ action: 'delete_auth_profile', auth_profile_slug: profile.slug }, env, ctx)))).toHaveProperty('error');
    expect(await sql`SELECT id FROM auth_profiles WHERE id = ${profile.id}`).toHaveLength(1);
    expect(await sql`SELECT ciphertext FROM agent_secrets WHERE organization_id = ${ctx.organizationId} ORDER BY name`).toEqual(before);
  });
  it('records both default transitions and preserves them when audit fails or the target is revoked', async () => {
    const sql = getTestDb();
    const profiles = await Promise.all(['first-app','second-app'].map(slug => createAuthProfile({ organizationId: ctx.organizationId, connectorKey: key, slug, displayName: slug, profileKind: 'oauth_app', provider: 'audit-fixture', authData: {}, createdBy: ctx.userId! })));
    const pin = (slug: string | null) => manageAuthProfiles({ action: 'set_default_auth_profile', connector_key: key, auth_profile_slug: slug }, env, ctx);
    expect(await pin('first-app')).toMatchObject({ action: 'set_default_auth_profile' });
    expect(await rejectAudit(() => attempt(() => pin('second-app')))).toHaveProperty('error');
    expect((await sql`SELECT slug FROM auth_profiles WHERE organization_id = ${ctx.organizationId} AND is_default_for_connector`)[0].slug).toBe('first-app');
    await sql`UPDATE auth_profiles SET status = 'revoked' WHERE id = ${profiles[1].id}`;
    expect(await pin('second-app')).toHaveProperty('error');
    expect((await sql`SELECT slug FROM auth_profiles WHERE organization_id = ${ctx.organizationId} AND is_default_for_connector`)[0].slug).toBe('first-app');
    await sql`UPDATE auth_profiles SET status = 'active' WHERE id = ${profiles[1].id}`;
    await pin('second-app');
    const audits = await sql`SELECT metadata, payload_data FROM events WHERE organization_id = ${ctx.organizationId} AND metadata->>'resource_kind' = 'auth-profile' ORDER BY id`;
    expect(audits).toHaveLength(3);
    expect(audits.map(({ metadata, payload_data }) => ({
      slug: metadata.resource_id,
      before: payload_data.before.is_default_for_connector,
      after: payload_data.state.is_default_for_connector,
    }))).toEqual(expect.arrayContaining([
      { slug: 'first-app', before: false, after: true },
      { slug: 'first-app', before: true, after: false },
      { slug: 'second-app', before: false, after: true },
    ]));
  });
  it('rolls back connector default configuration when its audit fails', async () => {
    const sql = getTestDb();
    expect(await rejectAudit(() => attempt(() => manageConnections({ action: 'update_connector_default_config', connector_key: key, default_connection_config: { host: 'synthetic.example' } }, env, ctx)))).toHaveProperty('error');
    expect((await sql`SELECT default_connection_config FROM connector_definitions WHERE organization_id = ${ctx.organizationId} AND key = ${key}`)[0].default_connection_config ?? {}).toEqual({});
  });
});
