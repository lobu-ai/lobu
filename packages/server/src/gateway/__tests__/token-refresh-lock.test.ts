/**
 * F5: OAuth refresh-token rotation race — advisory-lock serialization in
 * `TokenRefreshJob`.
 *
 * The job used to dedup concurrent refreshes only via a per-pod in-memory
 * `refreshLocks` Map, so two replicas could both rotate the same profile and
 * clobber each other. The fix wraps each per-profile refresh in a Postgres
 * advisory lock (`pg_advisory_xact_lock(hashtext('oauth_token_refresh:<id>'))`)
 * and RE-READS expiry inside the lock — a loser that acquires the lock after
 * the winner committed sees a future expiry and no-ops.
 *
 * The test injects a fake `DbClient` into `TokenRefreshJob` (via its optional
 * getDb accessor) so we can observe the lock + re-read flow and drive the
 * "already rotated" branch without a live DB — and without a process-global
 * `mock.module` that would leak across the bun:test gateway suite.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { TokenRefreshJob } from "../proxy/token-refresh-job.js";

interface RecordedCall {
  kind: "advisory_lock" | "lookup_org" | "other";
  text: string;
}

const calls: RecordedCall[] = [];

const fakeDb = Object.assign(
  (strings: TemplateStringsArray, ..._v: unknown[]) => {
    const text = strings.join("?");
    if (/FROM agents WHERE id/i.test(text)) {
      calls.push({ kind: "lookup_org", text });
      return Promise.resolve([{ organization_id: "org_1" }]);
    }
    calls.push({ kind: "other", text });
    return Promise.resolve([]);
  },
  {
    unsafe: (query: string) => {
      if (/pg_advisory_xact_lock/i.test(query)) {
        calls.push({ kind: "advisory_lock", text: query });
      } else {
        calls.push({ kind: "other", text: query });
      }
      return Promise.resolve([]);
    },
    begin: async (fn: (sql: unknown) => Promise<unknown>) => fn(fakeDb),
  }
);

// ─── Fakes ────────────────────────────────────────────────────────────────────

function makeProfile(expiresAt: number, refreshToken = "stored-refresh") {
  return {
    id: "profile-1",
    provider: "claude",
    authType: "oauth" as const,
    label: "Claude",
    model: undefined,
    metadata: { refreshToken, expiresAt },
  };
}

function makeManager(opts: {
  profileSequence: ReturnType<typeof makeProfile>[][];
}) {
  let getCount = 0;
  const upserts: unknown[] = [];
  return {
    upserts,
    manager: {
      getUserAuthProfileStore: () => ({}),
      async getStoredProviderProfiles() {
        const idx = Math.min(getCount, opts.profileSequence.length - 1);
        getCount += 1;
        return opts.profileSequence[idx];
      },
      async upsertProfile(input: unknown) {
        upserts.push(input);
        return input;
      },
    },
  };
}

const oauthClient = {
  refreshToken: mock(async () => ({
    accessToken: "new-access",
    refreshToken: "rotated-refresh",
    expiresAt: Date.now() + 3600_000,
  })),
};

describe("TokenRefreshJob advisory lock (F5)", () => {
  beforeEach(() => {
    calls.length = 0;
    oauthClient.refreshToken.mockClear();
  });

  test("acquires the advisory lock and refreshes when still expiring", async () => {
    const expiring = Date.now() + 60_000; // within 5-min buffer
    const { manager, upserts } = makeManager({
      profileSequence: [[makeProfile(expiring)], [makeProfile(expiring)]],
    });

    const job = new TokenRefreshJob(manager as never, [
      { providerId: "claude", refresher: oauthClient as never },
    ], () => fakeDb);
    await job.refreshForUserAgent("u1", "agent-1");

    expect(calls.some((c) => c.kind === "advisory_lock")).toBe(true);
    expect(oauthClient.refreshToken).toHaveBeenCalledTimes(1);
    expect(upserts.length).toBe(1);
  });

  test("no-ops when the in-lock re-read shows the token already rotated by another replica", async () => {
    const expiring = Date.now() + 60_000; // pre-check (outside lock) sees expiring
    const rotated = Date.now() + 3600_000; // in-lock re-read sees future expiry
    const { manager, upserts } = makeManager({
      // 1st getStoredProviderProfiles (pre-check) → expiring; 2nd (inside lock) → rotated.
      profileSequence: [[makeProfile(expiring)], [makeProfile(rotated)]],
    });

    const job = new TokenRefreshJob(manager as never, [
      { providerId: "claude", refresher: oauthClient as never },
    ], () => fakeDb);
    await job.refreshForUserAgent("u1", "agent-1");

    // Lock was taken, but the loser must NOT refresh or persist.
    expect(calls.some((c) => c.kind === "advisory_lock")).toBe(true);
    expect(oauthClient.refreshToken).not.toHaveBeenCalled();
    expect(upserts.length).toBe(0);
  });

  test("skips the lock entirely for a profile that is not near expiry", async () => {
    const healthy = Date.now() + 3600_000;
    const { manager } = makeManager({
      profileSequence: [[makeProfile(healthy)]],
    });

    const job = new TokenRefreshJob(manager as never, [
      { providerId: "claude", refresher: oauthClient as never },
    ], () => fakeDb);
    await job.refreshForUserAgent("u1", "agent-1");

    // Cheap pre-check short-circuits before any lock/refresh.
    expect(calls.some((c) => c.kind === "advisory_lock")).toBe(false);
    expect(oauthClient.refreshToken).not.toHaveBeenCalled();
  });
});
