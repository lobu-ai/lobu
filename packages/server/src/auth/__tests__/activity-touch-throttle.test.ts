/**
 * Per-request "last used" stamps must not rewrite their row on every request.
 *
 * These calls run in separate transactions, so a changed xmin identifies a
 * rewrite. A repeat touch inside the window must preserve it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { OAuthClientsStore } from '../oauth/clients';
import { PersonalAccessTokenService } from '../tokens';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';

async function seedOwner(slug: string) {
  const org = await createTestOrganization({ slug });
  const user = await createTestUser({ email: `${slug}@test.example.com` });
  await addUserToOrganization(user.id, org.id, 'owner');
  return { org, user };
}

describe('PAT last_used_at', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('is written at most once per window', async () => {
    const sql = getTestDb();
    const { org, user } = await seedOwner('touch-pat-org');
    await createTestPAT(user.id, org.id);
    const [{ id }] = (await sql`
      SELECT id FROM personal_access_tokens WHERE user_id = ${user.id}
    `) as unknown as Array<{ id: number }>;
    const service = new PersonalAccessTokenService(sql);
    const touch = () => service['updateLastUsed'](id);
    const read = async () =>
      ((await sql`
        SELECT xmin::text AS xmin, last_used_at FROM personal_access_tokens WHERE id = ${id}
      `) as unknown as Array<{ xmin: string; last_used_at: Date | null }>)[0];

    await touch();
    const first = await read();
    expect(first.last_used_at).not.toBeNull();

    await touch();
    expect((await read()).xmin).toBe(first.xmin);

    await sql`
      UPDATE personal_access_tokens
      SET last_used_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${id}
    `;
    const stale = await read();
    await touch();
    const refreshed = await read();
    expect(refreshed.xmin).not.toBe(stale.xmin);
    expect(new Date(refreshed.last_used_at as Date).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });
});

describe('OAuth client activity', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('skips a repeat touch inside the window but records new client details', async () => {
    const sql = getTestDb();
    const { org, user } = await seedOwner('touch-client-org');
    const client = await createTestOAuthClient();
    const store = new OAuthClientsStore(sql);
    const touch = (extra: {
      userAgent?: string;
      clientInfo?: Record<string, unknown>;
      capabilities?: Record<string, unknown>;
    } = {}) =>
      store.touchClientActivity({
        clientId: client.client_id,
        organizationId: org.id,
        userId: user.id,
        userAgent: extra.userAgent ?? 'agent/1',
        clientInfo: extra.clientInfo ?? null,
        capabilities: extra.capabilities ?? null,
      });
    const read = async () =>
      ((await sql`
        SELECT xmin::text AS xmin, organization_id, user_id, metadata
        FROM oauth_clients WHERE id = ${client.client_id}
      `) as unknown as Array<{
        xmin: string;
        organization_id: string | null;
        user_id: string | null;
        metadata: Record<string, unknown>;
      }>)[0];

    await touch();
    const first = await read();
    expect(first.organization_id).toBe(org.id);
    expect(first.user_id).toBe(user.id);
    expect(first.metadata.last_user_agent).toBe('agent/1');

    await touch();
    expect((await read()).xmin).toBe(first.xmin);

    await touch({ userAgent: 'agent/2' });
    const newAgent = await read();
    expect(newAgent.xmin).not.toBe(first.xmin);
    expect(newAgent.metadata.last_user_agent).toBe('agent/2');

    await touch({ userAgent: 'agent/2', clientInfo: { name: 'claude-code', version: '2.0.0' } });
    const initialized = await read();
    expect(initialized.xmin).not.toBe(newAgent.xmin);
    expect(initialized.metadata.last_client_info).toEqual({ name: 'claude-code', version: '2.0.0' });

    await touch({ userAgent: 'agent/2', clientInfo: { name: 'claude-code' } });
    expect((await read()).metadata.last_client_info).toEqual({ name: 'claude-code' });
    await touch({ userAgent: 'agent/2', clientInfo: {} });
    expect((await read()).metadata.last_client_info).toEqual({});

    await touch({ userAgent: 'agent/2', capabilities: { roots: { listChanged: true }, sampling: {} } });
    await touch({ userAgent: 'agent/2', capabilities: { roots: {} } });
    expect((await read()).metadata.last_capabilities).toEqual({ roots: {} });
    await touch({ userAgent: 'agent/2', capabilities: {} });
    const cleared = await read();
    expect(cleared.metadata.last_capabilities).toEqual({});
    await touch({ userAgent: 'agent/2', capabilities: {} });
    expect((await read()).xmin).toBe(cleared.xmin);

    await sql`
      UPDATE oauth_clients
      SET metadata = metadata || jsonb_build_object('last_seen_at', ${Date.now() - 10 * 60_000}::bigint)
      WHERE id = ${client.client_id}
    `;
    const stale = await read();
    await touch({ userAgent: 'agent/2' });
    const refreshed = await read();
    expect(refreshed.xmin).not.toBe(stale.xmin);
    expect(refreshed.metadata.last_seen_at as number).toBeGreaterThan(Date.now() - 60_000);
  });
});
