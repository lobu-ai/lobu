import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, parsePgTextArray, pgTextArray } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOAuthClient, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const migration = readFileSync(new URL(
  '../../../../../../db/migrations/20260907220000_oauth_account_grant_cutover.sql', import.meta.url,
), 'utf8').split('-- migrate:down')[0]!;

interface CredentialFixture {
  name: string;
  group?: string;
  resource: string | null;
  scope?: string | null;
  provenance?: string | null;
  organizationId?: string | null;
  userId?: string;
  grants?: string[] | null;
  expired?: boolean;
  revoked?: boolean;
  effect?: 'revoke' | 'backfill';
}

describe('OAuth account grant credential cutover', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('revokes only proven ordinary grants, preserves protected credentials and ambiguous sessions, and replays without changing events', async () => {
    const org = await createTestOrganization({ slug: 'cutover-explicit-workspace' });
    const otherOrg = await createTestOrganization({ slug: 'cutover-other-workspace' });
    const user = await createTestUser({ email: 'cutover-owner@example.test' });
    const otherUser = await createTestUser({ email: 'cutover-other@example.test' });
    const bare = 'https://lobu.ai/mcp';
    const appBare = 'https://app.lobu.ai/mcp';
    const scoped = `${bare}/${org.slug}`;
    const groups = ['ordinary', 'device', 'scoped', 'ambiguous', 'mixed-worker', 'mixed-code', 'mixed-null', 'codes-only', 'expired-worker'];
    const clients = Object.fromEntries(await Promise.all(groups.map(async (group) => [
      group, (await createTestOAuthClient({ client_name: `Cutover ${group}` })).client_id,
    ])));
    const credentials: CredentialFixture[] = [
      { name: 'legacy-apex', group: 'ordinary', resource: bare, provenance: null, effect: 'revoke' },
      { name: 'auth-code-app', group: 'ordinary', resource: appBare, grants: [org.id], effect: 'revoke' },
      { name: 'ordinary-device', group: 'ordinary', resource: bare, provenance: 'device_code', effect: 'revoke' },
      { name: 'downscoped-profile', group: 'ordinary', resource: appBare, scope: 'profile:read', effect: 'revoke' },
      { name: 'other-user-worker', group: 'ordinary', resource: null, userId: otherUser.id, scope: 'device_worker:run', provenance: 'device_code', effect: 'backfill' },
      { name: 'worker', group: 'device', resource: null, scope: 'device_worker:run mcp:read', provenance: 'device_code', effect: 'backfill' },
      { name: 'worker-bare', group: 'device', resource: bare, scope: 'device_worker:run', provenance: 'device_code', effect: 'backfill' },
      { name: 'worker-empty', group: 'device', resource: null, scope: 'device_worker:run', provenance: 'device_code', grants: [] },
      { name: 'managed-connection', resource: bare, scope: 'connections:token', provenance: 'device_code', grants: [org.id] },
      { name: 'legacy-scoped', group: 'scoped', resource: scoped, provenance: null, effect: 'backfill' },
      { name: 'scoped-empty', group: 'scoped', resource: scoped, grants: [] },
      { name: 'scoped-narrowed', group: 'scoped', resource: scoped, grants: [otherOrg.id] },
      { name: 'scoped-mismatch', group: 'scoped', resource: `${bare}/${otherOrg.slug}` },
      { name: 'resource-null', resource: null, provenance: null },
      { name: 'tenant-host', resource: 'https://cutover-tenant.lobu.ai/mcp' },
      { name: 'unknown-provenance', resource: bare, provenance: 'unknown-grant' },
      { name: 'unknown-scope', resource: bare, scope: 'future:scope' },
      { name: 'missing-scope', resource: bare, scope: null },
      { name: 'new-account', resource: bare, organizationId: null, grants: [org.id] },
      { name: 'expired-ordinary', resource: bare, expired: true },
      { name: 'revoked-ordinary', resource: bare, revoked: true },
      { name: 'mixed-worker-old', group: 'mixed-worker', resource: bare, effect: 'revoke' },
      { name: 'mixed-worker-live', group: 'mixed-worker', resource: null, scope: 'device_worker:run', provenance: 'device_code', effect: 'backfill' },
      { name: 'mixed-code-old', group: 'mixed-code', resource: bare, effect: 'revoke' },
      { name: 'mixed-null-old', group: 'mixed-null', resource: bare, effect: 'revoke' },
      { name: 'mixed-null-live', group: 'mixed-null', resource: null },
      { name: 'expired-worker-old', group: 'expired-worker', resource: bare, effect: 'revoke' },
      { name: 'expired-worker-protected', group: 'expired-worker', resource: null, scope: 'device_worker:run', provenance: 'device_code', expired: true },
    ];
    const authorizationCodes: CredentialFixture[] = [
      { name: 'old-auth-code', group: 'codes-only', resource: appBare, effect: 'revoke' },
      { name: 'scoped-auth-code', group: 'scoped', resource: scoped, effect: 'backfill' },
      { name: 'mixed-protected-code', group: 'mixed-code', resource: scoped, effect: 'backfill' },
      { name: 'account-profile-code', resource: null, organizationId: null, grants: [], scope: 'profile:read' },
      { name: 'ambiguous-auth-code', resource: null },
      { name: 'expired-auth-code', resource: bare, expired: true },
      { name: 'scoped-empty-code', group: 'scoped', resource: scoped, grants: [] },
    ];
    const deviceCodes: CredentialFixture[] = [
      { name: 'old-device-code', group: 'codes-only', resource: bare, effect: 'revoke' },
      { name: 'worker-code', group: 'device', resource: null, scope: 'device_worker:run', effect: 'backfill' },
      { name: 'scoped-device-code', group: 'scoped', resource: scoped, effect: 'backfill' },
      { name: 'ambiguous-device-code', resource: null },
      { name: 'unclaimed-device-code', resource: bare, organizationId: null },
    ];
    const rollback = new Error('rollback isolated credential cutover fixtures');

    await expect(getDb().begin(async tx => {
      const clientId = (fixture: CredentialFixture) => clients[fixture.group ?? 'ambiguous']!;
      const organizationId = (fixture: CredentialFixture) => fixture.organizationId === undefined ? org.id : fixture.organizationId;
      const scope = (fixture: CredentialFixture) => fixture.scope === undefined ? 'mcp:read mcp:write' : fixture.scope;
      const grants = (fixture: CredentialFixture) => fixture.grants == null ? null : pgTextArray(fixture.grants);
      for (const fixture of credentials) {
        for (const type of ['access', 'refresh']) {
          await tx`INSERT INTO oauth_tokens (id, token_type, token_hash, client_id, user_id, organization_id,
              granted_organization_ids, authorization_grant_type, scope, resource, revoked_at, expires_at)
            VALUES (${`${fixture.name}-${type}`}, ${type}, ${`synthetic-${fixture.name}-${type}`},
              ${clientId(fixture)}, ${fixture.userId ?? user.id}, ${organizationId(fixture)},
              ${grants(fixture)}::text[], ${fixture.provenance === undefined ? 'authorization_code' : fixture.provenance},
              ${scope(fixture)}, ${fixture.resource}, ${fixture.revoked ? new Date(0) : null},
              now() + ${fixture.expired ? '-1 hour' : '1 day'}::interval)`;
        }
      }
      for (const fixture of authorizationCodes) {
        await tx`INSERT INTO oauth_authorization_codes (code, client_id, user_id, organization_id,
            granted_organization_ids, scope, resource, code_challenge, redirect_uri, expires_at)
          VALUES (${fixture.name}, ${clientId(fixture)}, ${user.id}, ${organizationId(fixture)},
            ${grants(fixture)}::text[], ${scope(fixture)}, ${fixture.resource}, 'synthetic-challenge',
            'https://client.example.test/callback', now() + ${fixture.expired ? '-1 hour' : '1 day'}::interval)`;
      }
      for (const fixture of deviceCodes) {
        await tx`INSERT INTO oauth_device_codes (device_code, user_code, client_id, user_id, organization_id,
            granted_organization_ids, scope, resource, status, expires_at)
          VALUES (${fixture.name}, ${fixture.name}, ${clientId(fixture)},
            ${fixture.name === 'unclaimed-device-code' ? null : user.id}, ${organizationId(fixture)},
            ${grants(fixture)}::text[], ${scope(fixture)}, ${fixture.resource},
            ${fixture.name === 'unclaimed-device-code' ? 'pending' : 'approved'}, now() + interval '1 day')`;
      }
      await tx`INSERT INTO personal_access_tokens (user_id, organization_id, name, token_hash, token_prefix, scope)
        VALUES (${user.id}, ${org.id}, 'Explicit PAT', 'synthetic-cutover-pat', 'owl_pat_test', 'mcp:read')`;
      const sessions = [
        { name: 'ordinary', group: 'ordinary', deleted: true },
        { name: 'codes-only', group: 'codes-only', deleted: true },
        { name: 'expired-worker', group: 'expired-worker', deleted: true },
        { name: 'mixed-worker', group: 'mixed-worker' },
        { name: 'mixed-code', group: 'mixed-code' },
        { name: 'mixed-null', group: 'mixed-null' },
        { name: 'device', group: 'device' },
        { name: 'scoped', group: 'ordinary', scoped: true },
        { name: 'agent', group: 'ordinary', agent: 'synthetic-requested-agent' },
        { name: 'pat', group: null },
        { name: 'other-user', group: 'ordinary', otherUser: true },
        { name: 'other-org', group: 'ordinary', otherOrg: true },
        { name: 'null-target', group: 'ordinary', nullOrg: true },
      ];
      for (const session of sessions) {
        const actor = session.otherUser ? otherUser.id : user.id;
        const target = session.nullOrg ? null : session.otherOrg ? otherOrg.id : org.id;
        const client = session.group ? clients[session.group]! : null;
        await tx`INSERT INTO mcp_sessions (session_id, client_id, user_id, organization_id, member_role,
            is_authenticated, scoped_to_org, requested_agent_id, expires_at)
          VALUES (${`cutover-${session.name}`}, ${client}, ${actor}, ${target}, 'owner', true,
            ${session.scoped ?? false}, ${session.agent ?? null}, now() + interval '1 day')`;
        await tx`INSERT INTO events (organization_id, created_by, client_id, semantic_type, origin_type, metadata, payload_data, occurred_at)
          VALUES (${target}, ${actor}, ${client}, 'audit', 'tool_invocation',
            ${tx.json({ mcp_session_id: `cutover-${session.name}` })}, ${tx.json({ tool_name: 'run_sdk', success: true })}, now())`;
      }
      const snapshot = async () => ({
        tokens: await tx`SELECT * FROM oauth_tokens ORDER BY id`,
        authorizationCodes: await tx`SELECT * FROM oauth_authorization_codes ORDER BY code`,
        deviceCodes: await tx`SELECT * FROM oauth_device_codes ORDER BY device_code`,
        sessions: await tx`SELECT * FROM mcp_sessions ORDER BY session_id`,
        pats: await tx`SELECT * FROM personal_access_tokens ORDER BY id`,
        events: await tx`SELECT * FROM events ORDER BY id`,
      });
      const before = await snapshot();
      await tx.unsafe(migration);
      const after = await snapshot();
      for (const fixture of credentials) {
        for (const type of ['access', 'refresh']) {
          const id = `${fixture.name}-${type}`;
          const previous = before.tokens.find(row => row.id === id)!;
          const current = after.tokens.find(row => row.id === id)!;
          expect(current, id).toEqual({
            ...previous,
            ...(fixture.effect === 'revoke' ? { revoked_at: expect.anything() } : {}),
            ...(fixture.effect === 'backfill' ? { granted_organization_ids: expect.anything() } : {}),
          });
          if (fixture.effect === 'backfill') {
            expect(parsePgTextArray(current.granted_organization_ids as string), id).toEqual([org.id]);
          }
        }
      }
      for (const [fixtures, previous, current, key] of [
        [authorizationCodes, before.authorizationCodes, after.authorizationCodes, 'code'],
        [deviceCodes, before.deviceCodes, after.deviceCodes, 'device_code'],
      ] as const) {
        expect(current).toHaveLength(fixtures.filter(fixture => fixture.effect !== 'revoke').length);
        for (const fixture of fixtures.filter(fixture => fixture.effect !== 'revoke')) {
          const row = current.find(row => row[key] === fixture.name)!;
          expect(row, fixture.name).toEqual({
            ...previous.find(row => row[key] === fixture.name),
            ...(fixture.effect === 'backfill' ? { granted_organization_ids: expect.anything() } : {}),
          });
          if (fixture.effect === 'backfill') expect(parsePgTextArray(row.granted_organization_ids as string)).toEqual([org.id]);
        }
      }
      expect(after.sessions).toEqual(before.sessions.filter(row => !sessions.some(session => session.deleted && row.session_id === `cutover-${session.name}`)));
      expect(after.pats).toEqual(before.pats);
      expect(after.events).toEqual(before.events);
      await tx.unsafe(migration);
      expect(await snapshot()).toEqual(after);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
