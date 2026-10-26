import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../db/client';

const binding = {
  organizationId: 'synthetic-private-org', authProfileId: 101, appAuthProfileId: 202,
  ownerUserId: 'synthetic-private-owner', reservePending: true,
};
const profile = {
  profile_kind: 'oauth_account', provider: 'synthetic', created_by: binding.ownerUserId as string | null,
  account_id: 'synthetic-private-account' as string | null,
  auth_data: {
    app_auth_profile_id: 202,
    access_token: 'synthetic-access-secret', refresh_token: 'synthetic-refresh-secret',
    client_secret: 'synthetic-client-secret', email: 'synthetic-private@example.test',
  } as Record<string, unknown> | null,
};

async function setup(rows: {
  profile?: Partial<typeof profile> | null;
  account?: { userId: string | null; providerId?: string } | null;
  conflicts?: object[];
} = {}) {
  const account = rows.account === undefined ? { userId: binding.ownerUserId, providerId: 'synthetic' } : rows.account;
  const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray) => {
    const query = parts.join('?');
    if (query.includes('FROM auth_profiles')) return rows.profile === null ? [] : [{ ...profile, ...rows.profile }];
    if (query.includes('FROM account')) return account ? [account] : [];
    if (query.includes('FROM connections')) return rows.conflicts ?? [];
    if (query.includes('UPDATE auth_profiles')) return [];
    throw new Error(`Unexpected query: ${query}`);
  }), { json: vi.fn(value => value) });
  vi.doMock('../../db/client', () => ({ getDb: () => sql }));
  vi.doMock('../auth-profiles', () => ({ getAuthProfileById: vi.fn(), updateAuthProfile: vi.fn() }));
  const { lockOAuthAccountBinding } = await import('../oauth-connection-state');
  const { default: logger } = await import('../logger');
  const warn = vi.spyOn(logger, 'warn');
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return { lockOAuthAccountBinding, sql, tx: sql as unknown as DbClient, warn, output };
}

describe('OAuth account binding diagnostics', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../db/client');
    vi.doUnmock('../auth-profiles');
    vi.resetModules();
  });

  it.each<{ reason: string; rows: Parameters<typeof setup>[0]; queries: number }>([
    { reason: 'missing_account_profile', rows: { profile: null }, queries: 1 },
    { reason: 'profile_owner', rows: { profile: { created_by: 'synthetic-other-owner' } }, queries: 1 },
    { reason: 'backing_account_absent', rows: { account: null }, queries: 2 },
    { reason: 'backing_account_owner', rows: { account: { userId: 'synthetic-other-owner' } }, queries: 2 },
    { reason: 'backing_account_provider', rows: { account: { userId: binding.ownerUserId, providerId: 'other' } }, queries: 2 },
    { reason: 'stored_app_mismatch', rows: { profile: { auth_data: { ...profile.auth_data, app_auth_profile_id: 303 } } }, queries: 2 },
    { reason: 'live_connection_app_mismatch', rows: { conflicts: [{ '?column?': 1 }] }, queries: 3 },
  ])('still rejects $reason and logs only safe fields', async ({ reason, rows, queries }) => {
    const { lockOAuthAccountBinding, tx, sql, warn, output } = await setup(rows);
    expect(await lockOAuthAccountBinding(tx, binding)).toBe(false);
    expect(sql).toHaveBeenCalledTimes(queries);
    expect(sql.json).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([[
      { reason, authProfileId: 101, appAuthProfileId: 202 }, 'OAuth account binding refused',
    ]]);
    const logged = output.mock.calls.map(([line]) => String(line)).join('');
    expect(JSON.parse(logged)).toMatchObject({ level: 'warn', reason, authProfileId: 101, appAuthProfileId: 202 });
    for (const value of [
      binding.organizationId, binding.ownerUserId, profile.account_id, 'synthetic-other-owner',
      ...Object.values(profile.auth_data!).filter(value => typeof value === 'string'),
    ]) {
      expect(logged).not.toContain(value);
    }
  });

  it.each([null, 'synthetic-other-owner'])('preserves the profile-owner guard for caller %s', async ownerUserId => {
    const { lockOAuthAccountBinding, tx, sql, warn } = await setup();
    expect(await lockOAuthAccountBinding(tx, { ...binding, ownerUserId })).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      { reason: 'profile_owner', authProfileId: 101, appAuthProfileId: 202 }, 'OAuth account binding refused',
    );
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it.each([
    { rows: {}, reason: 'stored_app_mismatch' },
    { rows: { profile: { auth_data: null }, conflicts: [{ '?column?': 1 }] }, reason: 'live_connection_app_mismatch' },
  ])('preserves $reason when no app is selected', async ({ rows, reason }) => {
    const { lockOAuthAccountBinding, tx, warn } = await setup(rows);
    expect(await lockOAuthAccountBinding(tx, { ...binding, appAuthProfileId: null })).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      { reason, authProfileId: 101, appAuthProfileId: null }, 'OAuth account binding refused',
    );
  });

  it.each([
    { name: 'existing grant', accountId: profile.account_id, stored: 202, appId: 202, reserve: true, queries: 3, writes: 0 },
    { name: 'pending reservation', accountId: null, stored: undefined, appId: 202, reserve: true, queries: 3, writes: 1 },
    { name: 'pending check', accountId: null, stored: undefined, appId: 202, reserve: false, queries: 2, writes: 0 },
    { name: 'no selected app', accountId: null, stored: undefined, appId: null, reserve: true, queries: 2, writes: 0 },
    { name: 'non-numeric stored app', accountId: profile.account_id, stored: 'synthetic-private-app', appId: 202, reserve: true, queries: 3, writes: 0 },
  ])('keeps $name successful and quiet', async ({ accountId, stored, appId, reserve, queries, writes }) => {
    const { lockOAuthAccountBinding, tx, sql, warn, output } = await setup({
      profile: { account_id: accountId, auth_data: { ...profile.auth_data, app_auth_profile_id: stored } },
    });
    expect(await lockOAuthAccountBinding(tx, { ...binding, appAuthProfileId: appId, reservePending: reserve })).toBe(true);
    expect(sql).toHaveBeenCalledTimes(queries);
    expect(sql.json).toHaveBeenCalledTimes(writes);
    if (writes) expect(sql.json).toHaveBeenCalledWith({ app_auth_profile_id: 202 });
    expect(warn).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it('keeps the connect-token error unchanged and refuses before inserting a token', async () => {
    const { tx, sql, warn } = await setup({ account: null });
    const { createConnectToken } = await import('../connect-tokens');
    await expect(createConnectToken({
      organizationId: binding.organizationId, authProfileId: binding.authProfileId,
      connectorKey: 'synthetic.oauth', authType: 'oauth',
      authConfig: { appAuthProfileId: binding.appAuthProfileId }, createdBy: binding.ownerUserId,
    }, tx)).rejects.toThrow(
      'This account is already bound to a different OAuth app or owner. Use your own account profile with its selected app.',
    );
    expect(sql).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      { reason: 'backing_account_absent', authProfileId: 101, appAuthProfileId: 202 }, 'OAuth account binding refused',
    );
  });
});
