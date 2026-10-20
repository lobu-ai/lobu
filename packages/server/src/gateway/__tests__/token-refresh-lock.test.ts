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
import { type AuthProfile, isRefreshSuspended } from "@lobu/core";
import { OAuthTokenError } from "../auth/oauth/base-client.js";
import { UserAuthProfileStore } from "../auth/settings/user-auth-profile-store.js";
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

function makeProfile(expiresAt: number, refreshToken = "stored-refresh"): AuthProfile {
  return {
    id: "profile-1",
    provider: "claude",
    authType: "oauth" as const,
    label: "Claude",
    model: "*",
    createdAt: 0,
    metadata: { refreshToken, expiresAt },
  };
}

function makeManager(opts: {
  profileSequence: ReturnType<typeof makeProfile>[][];
}) {
  let getCount = 0;
  const upserts: unknown[] = [];
  const suspensions: unknown[] = [];
  return {
    upserts,
    suspensions,
    manager: {
      getUserAuthProfileStore: () => ({
        async suspendRefresh(...input: unknown[]) {
          suspensions.push(input);
          return "suspended" as const;
        },
      }),
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

function grantDeadError() {
  return new OAuthTokenError("Token refresh failed", {
    status: 400,
    code: "invalid_grant",
  });
}

function suspendedProfile(expiresAt: number) {
  return {
    ...makeProfile(expiresAt),
    metadata: {
      refreshToken: "stored-refresh",
      expiresAt,
      refreshSuspended: { code: "invalid_grant", at: Date.now() },
    },
  };
}

describe("TokenRefreshJob refresh suspension (dead grants)", () => {
  beforeEach(() => {
    calls.length = 0;
    oauthClient.refreshToken.mockClear();
  });

  function runJob(
    fakes: ReturnType<typeof makeManager>,
    refresher: unknown = oauthClient
  ) {
    return new TokenRefreshJob(fakes.manager as never, [
      { providerId: "claude", refresher: refresher as never },
    ], () => fakeDb);
  }

  test("suspends the profile on invalid_grant and never retries it", async () => {
    const expiring = Date.now() + 60_000;
    const failingRefresher = {
      refreshToken: mock(async () => {
        throw grantDeadError();
      }),
    };
    const fakes = makeManager({
      // Two store reads per tick (pre-check + in-lock re-read). Tick 1 sees
      // the expiring profile twice; tick 2+ sees the suspended profile.
      profileSequence: [
        [makeProfile(expiring)],
        [makeProfile(expiring)],
        [suspendedProfile(expiring)],
        [suspendedProfile(expiring)],
      ],
    });
    const job = runJob(fakes, failingRefresher);

    await job.refreshForUserAgent("u1", "agent-1");
    expect(failingRefresher.refreshToken).toHaveBeenCalledTimes(1);
    expect(fakes.suspensions.length).toBe(1);
    expect(fakes.suspensions[0]).toEqual([
      "u1",
      "agent-1",
      "profile-1",
      { code: "invalid_grant", at: expect.any(Number) },
      fakeDb,
    ]);

    // Second tick sees the suspension and skips lock + provider call.
    const locksBefore = calls.filter((c) => c.kind === "advisory_lock").length;
    await job.refreshForUserAgent("u1", "agent-1");
    expect(failingRefresher.refreshToken).toHaveBeenCalledTimes(1);
    expect(fakes.suspensions.length).toBe(1);
    expect(
      calls.filter((c) => c.kind === "advisory_lock").length
    ).toBe(locksBefore);
  });

  test("retries transient failures without suspending", async () => {
    const expiring = Date.now() + 60_000;
    const flakyRefresher = {
      refreshToken: mock(async () => {
        throw new Error("Token refresh failed: 500 Internal Server Error");
      }),
    };
    const fakes = makeManager({
      profileSequence: [[makeProfile(expiring)]],
    });
    const job = runJob(fakes, flakyRefresher);

    await job.refreshForUserAgent("u1", "agent-1");
    await job.refreshForUserAgent("u1", "agent-1");

    expect(flakyRefresher.refreshToken).toHaveBeenCalledTimes(2);
    expect(fakes.suspensions.length).toBe(0);
  });

  test("skips the write-back when a reconnect replaced the stored profile", async () => {
    const expiring = Date.now() + 60_000;
    const fresh = Date.now() + 3600_000;
    const reconnected = {
      ...makeProfile(fresh),
      id: "profile-2",
    };
    const fakes = makeManager({
      profileSequence: [
        [makeProfile(expiring)],
        [reconnected],
      ],
    });
    const job = runJob(fakes);

    await job.refreshForUserAgent("u1", "agent-1");

    // The reconnected profile must survive: no refresh, no write-back.
    expect(oauthClient.refreshToken).not.toHaveBeenCalled();
    expect(fakes.upserts.length).toBe(0);
  });

  test("skips the refresh when a reconnected sibling is present alongside the stale profile", async () => {
    const expiring = Date.now() + 60_000;
    const fresh = Date.now() + 3600_000;
    const reconnected = {
      ...makeProfile(fresh),
      id: "profile-2",
    };
    const fakes = makeManager({
      profileSequence: [
        [makeProfile(expiring)],
        [makeProfile(expiring), reconnected],
      ],
    });
    const job = runJob(fakes);

    await job.refreshForUserAgent("u1", "agent-1");

    // Refreshing the stale grant and writing it back under the old id would
    // delete the reconnected profile via upsert's provider+model replace.
    expect(oauthClient.refreshToken).not.toHaveBeenCalled();
    expect(fakes.upserts.length).toBe(0);
    expect(fakes.suspensions.length).toBe(0);
  });

  test("refreshes an expiring profile alongside a healthy different-model profile", async () => {
    const expiring = makeProfile(Date.now() + 60_000);
    const sibling = {
      ...makeProfile(Date.now() + 3600_000),
      id: "profile-2",
      model: "other-model",
    };
    const fakes = makeManager({
      profileSequence: [[expiring, sibling]],
    });

    await runJob(fakes).refreshForUserAgent("u1", "agent-1");

    expect(oauthClient.refreshToken).toHaveBeenCalledTimes(1);
    expect(fakes.upserts).toHaveLength(1);
  });

  test("does not let a suspended profile hide another refreshable profile", async () => {
    const active = { ...makeProfile(Date.now() + 60_000), id: "profile-2" };
    const fakes = makeManager({
      profileSequence: [[suspendedProfile(Date.now()), active]],
    });

    await runJob(fakes).refreshForUserAgent("u1", "agent-1");

    expect(oauthClient.refreshToken).toHaveBeenCalledTimes(1);
    expect(fakes.upserts).toHaveLength(1);
  });

  test("honors a suspension recorded while waiting for the advisory lock", async () => {
    const expiring = Date.now() + 60_000;
    const fakes = makeManager({
      profileSequence: [[makeProfile(expiring)], [suspendedProfile(expiring)]],
    });

    await runJob(fakes).refreshForUserAgent("u1", "agent-1");

    expect(calls.some((call) => call.kind === "advisory_lock")).toBe(true);
    expect(oauthClient.refreshToken).not.toHaveBeenCalled();
    expect(fakes.upserts).toHaveLength(0);
    expect(fakes.suspensions).toHaveLength(0);
  });

  test("suspends with the existing transaction and preserves stored secret refs", async () => {
    const stored = {
      ...makeProfile(Date.now()),
      credentialRef: "secret://test-access",
      metadata: {
        expiresAt: 1,
        refreshTokenRef: "secret://test-refresh",
      },
    };
    let written: unknown;
    // postgres.js transaction clients have no begin(); the job already owns
    // the transaction and advisory lock when it calls suspendRefresh.
    const tx = Object.assign(
      async (strings: TemplateStringsArray) =>
        strings.join("").includes("SELECT profiles")
          ? [{ profiles: [stored] }]
          : [],
      {
        json: (value: unknown) => {
          written = value;
          return value;
        },
      }
    );
    const store = new UserAuthProfileStore({} as never);
    const reason = { code: "invalid_grant", at: 123 };

    expect(
      await store.suspendRefresh("u1", "agent-1", stored.id, reason, tx as never)
    ).toBe("suspended");
    expect(written).toEqual([
      {
        ...stored,
        metadata: { ...stored.metadata, refreshSuspended: reason },
      },
    ]);
  });

  test("isRefreshSuspended flags only suspended profiles", () => {
    expect(isRefreshSuspended(makeProfile(Date.now()))).toBe(false);
    expect(
      isRefreshSuspended(suspendedProfile(Date.now()))
    ).toBe(true);
  });
});
