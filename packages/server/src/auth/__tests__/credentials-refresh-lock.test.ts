/**
 * F5: OAuth refresh-token rotation race — advisory-lock serialization in
 * `CredentialService`.
 *
 * Two replicas can both notice the same account's token is expiring and race to
 * refresh it. Without serialization the loser POSTs the now-rotated refresh
 * token (rejected) and/or overwrites the winner's freshly-stored token. The fix
 * wraps refresh+persist in a Postgres advisory lock keyed on the account id and
 * RE-READS expiry inside the lock — so a refresh that's already happened makes
 * the loser no-op instead of replaying a rotated-away token.
 *
 * These tests use a fake `DbClient` so they pin what the loser does (re-read
 * inside the lock, skip when no longer expiring) without a live DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../db/client';
import { CredentialService } from '../credentials';

interface RecordedCall {
  kind: 'advisory_lock' | 'select_for_update' | 'update_persist' | 'other';
  text: string;
}

/**
 * Minimal fake postgres.js client. `begin` runs the callback with the same
 * client; `unsafe` records the advisory lock; the tagged-template captures the
 * re-read SELECT and the persist UPDATE. `selectRows` is what the in-lock
 * re-read returns.
 */
function makeFakeDb(selectRows: unknown[]): { db: DbClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const tagged = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?');
    if (/FOR UPDATE/i.test(text)) {
      calls.push({ kind: 'select_for_update', text });
      return Promise.resolve(selectRows) as never;
    }
    if (/UPDATE "account"/i.test(text)) {
      calls.push({ kind: 'update_persist', text });
      return Promise.resolve([]) as never;
    }
    calls.push({ kind: 'other', text });
    return Promise.resolve([]) as never;
  };

  const db = Object.assign(tagged, {
    unsafe: (query: string, _params?: unknown[]) => {
      if (/pg_advisory_xact_lock/i.test(query)) {
        calls.push({ kind: 'advisory_lock', text: query });
      } else {
        calls.push({ kind: 'other', text: query });
      }
      return Promise.resolve([]) as never;
    },
    begin: async <T>(fn: (sql: DbClient) => Promise<T>): Promise<T> => fn(db as DbClient),
    array: () => undefined,
    json: (v: unknown) => v,
  }) as unknown as DbClient;

  return { db, calls };
}

const oauthConfig = {
  tokenUrl: 'https://provider.example/token',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  accountId: 'acct-1',
  refreshToken: 'stored-refresh-token',
};

describe('CredentialService.refreshWithConfig — advisory lock (F5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('NO-OPS the refresh when the in-lock re-read shows the token already rotated', async () => {
    // The loser acquires the lock AFTER the winner committed: the re-read shows
    // an expiry well in the future, so no fetch and no second persist happen.
    const { db, calls } = makeFakeDb([
      {
        accessToken: 'already-rotated-access',
        refreshToken: 'rotated-by-winner',
        expiresAt: new Date(Date.now() + 60 * 60_000), // 1h out — not expiring
      },
    ]);

    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const svc = new CredentialService(db);
    const result = await svc.refreshWithConfig(oauthConfig);

    // It returns the now-current access token without refreshing.
    expect(result?.accessToken).toBe('already-rotated-access');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.some((c) => c.kind === 'advisory_lock')).toBe(true);
    expect(calls.some((c) => c.kind === 'select_for_update')).toBe(true);
    // The loser must NOT clobber the winner's row.
    expect(calls.some((c) => c.kind === 'update_persist')).toBe(false);
  });

  it('returns null when the account has no stored refresh token', async () => {
    const { db, calls } = makeFakeDb([
      { accessToken: 'a', refreshToken: null, expiresAt: new Date(Date.now() + 1000) },
    ]);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const svc = new CredentialService(db);
    const result = await svc.refreshWithConfig(oauthConfig);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // Lock was still taken (we only learn there's no token after re-reading).
    expect(calls.some((c) => c.kind === 'advisory_lock')).toBe(true);
    expect(calls.some((c) => c.kind === 'update_persist')).toBe(false);
  });
});
