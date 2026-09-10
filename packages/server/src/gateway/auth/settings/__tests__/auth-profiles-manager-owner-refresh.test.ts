import { describe, expect, mock, test } from "bun:test";
import { orgContext, tryGetOrgId } from "../../../../lobu/stores/org-context.js";
import { TokenRefreshJob } from "../../../proxy/token-refresh-job.js";
import { AuthProfilesManager } from "../auth-profiles-manager.js";
import { orgBucketAgentId } from "../user-auth-profile-store.js";

// Owner-fallback coverage for OAUTH SUBSCRIPTIONS on cloud Automation runs.
//
// A scheduled/chat run executes as a synthetic principal that owns no auth
// profile, so resolution falls back to the agent owner's rows. For a
// subscription sign-in that row lives in the org bucket
// (`orgBucketAgentId(orgId)`), not under the running agentId. Three things
// have to hold for the fallback to be usable rather than merely visible:
//
//   * refresh must target the row the credential was READ from — the owner
//     plus that storage agentId, inside that row's org partition — never the
//     synthetic requesting principal,
//   * an already-lapsed subscription must be rotated BEFORE the expiry filter
//     in `getBestProfile` drops it, or a run can never recover once its token
//     lapses, and
//   * the periodic refresher must NOT do the reverse: a merged fallback
//     credential must never be written into the row it happens to be scanning.
//
// The tenant boundary is pinned too: the owner-bucket read follows the AMBIENT
// org, so a run in another org never touches this org's subscription.
//
// Both refreshable literals are exercised: "device-code" is what a ChatGPT
// subscription persists, "oauth" is Claude's. A guard that named only one
// would leave the other permanently un-refreshable.

const AGENT_ID = "agent-1";
const ORG_ID = "org-A";
const OTHER_ORG_ID = "org-B";
const OWNER_ID = "owner-user";
const RUN_USER_ID = "run-user";
const PROFILE_ID = "owner-chatgpt-1";
const STORED_TOKEN = "stored-access-token";
const REFRESHED_TOKEN = "refreshed-access-token";
const HOUR_MS = 60 * 60 * 1000;
/** Inside `LAZY_REFRESH_BUFFER_MS` (5min): reads take the async-trigger path. */
const SOON_MS = 60 * 1000;
/** The exact literals a subscription sign-in persists (ChatGPT, then Claude). */
const REFRESHABLE_TYPES = ["device-code", "oauth"] as const;

type RefreshTarget = {
  userId: string;
  agentId: string;
  organizationId: string | null;
};

/**
 * Build a manager whose only stored profile is the OWNER's subscription
 * profile, held under `storageAgentId` — the org bucket by default, or the
 * agent's own id when `bucket: false`. `refreshNow` mutates that row the way
 * TokenRefreshJob does, and both hooks record the (userId, agentId, org) they
 * were asked to refresh so a test can assert the refresh targeted the storage
 * row rather than the principal that requested the credential.
 */
function makeManager(opts: {
  expiresAt: number;
  authType: "oauth" | "device-code";
  bucket?: boolean;
}) {
  const storageAgentId =
    opts.bucket === false ? AGENT_ID : orgBucketAgentId(ORG_ID);
  let credential = STORED_TOKEN;
  let expiresAt = opts.expiresAt;
  const list = mock(async (userId: string, agentId: string) =>
    userId === OWNER_ID && agentId === storageAgentId
      ? [
          {
            id: PROFILE_ID,
            provider: "chatgpt",
            model: "*",
            authType: opts.authType,
            credential,
            createdAt: 0,
            metadata: { expiresAt },
          },
        ]
      : []
  );

  const manager = new AuthProfilesManager({
    ephemeralProfiles: { get: () => undefined } as never,
    declaredAgents: { get: () => undefined } as never,
    userAuthProfiles: { list } as never,
    secretStore: { get: async () => undefined } as never,
    agentOwnerResolver: async () => OWNER_ID,
    agentOrgResolver: async () => ORG_ID,
  });

  // Recorded rather than asserted in-place: a hook that is never called would
  // make in-mock expectations pass vacuously.
  const refreshTargets: RefreshTarget[] = [];
  const record = (userId: string, agentId: string) => {
    refreshTargets.push({ userId, agentId, organizationId: tryGetOrgId() });
  };
  const triggerAsync = mock(async (userId: string, agentId: string) => {
    record(userId, agentId);
  });
  const refreshNow = mock(async (userId: string, agentId: string) => {
    record(userId, agentId);
    credential = REFRESHED_TOKEN;
    expiresAt = Date.now() + HOUR_MS;
  });
  manager.setLazyRefreshHooks({ triggerAsync, refreshNow });

  return { manager, list, refreshNow, refreshTargets, storageAgentId };
}

const ownerStorage = (agentId: string): RefreshTarget[] => [
  { userId: OWNER_ID, agentId, organizationId: ORG_ID },
];

describe("owner subscription credentials for cloud Automations", () => {
  test("resolves the owner's org subscription for a synthetic run", async () => {
    const { manager } = makeManager({
      expiresAt: Date.now() + HOUR_MS,
      authType: "device-code",
    });

    const profile = await manager.getBestProfile(
      AGENT_ID,
      "chatgpt",
      undefined,
      { userId: RUN_USER_ID }
    );

    expect(profile?.credential).toBe(STORED_TOKEN);
  });

  for (const authType of REFRESHABLE_TYPES) {
    for (const bucket of [true, false]) {
      test(`refreshes the owner storage row, not the run user (${authType}, bucket=${bucket})`, async () => {
        const { manager, refreshTargets, storageAgentId } = makeManager({
          expiresAt: Date.now() + SOON_MS,
          authType,
          bucket,
        });

        const profile = await manager.getBestProfile(
          AGENT_ID,
          "chatgpt",
          undefined,
          { userId: RUN_USER_ID }
        );
        expect(profile).not.toBeNull();
        // Still valid for the buffer window, so the current token comes back
        // while the refresh is triggered against the owner's row.
        const credential = await manager.ensureFreshCredential(profile!, {
          userId: RUN_USER_ID,
          agentId: AGENT_ID,
        });

        expect(credential).toBe(STORED_TOKEN);
        expect(refreshTargets).toEqual(ownerStorage(storageAgentId));
      });

      test(`rotates a lapsed owner subscription instead of dropping it (${authType}, bucket=${bucket})`, async () => {
        const { manager, refreshNow, refreshTargets, storageAgentId } =
          makeManager({
            expiresAt: Date.now() - HOUR_MS,
            authType,
            bucket,
          });

        const profile = await manager.getBestProfile(
          AGENT_ID,
          "chatgpt",
          undefined,
          { userId: RUN_USER_ID }
        );

        expect(profile?.credential).toBe(REFRESHED_TOKEN);
        expect(refreshNow).toHaveBeenCalledTimes(1);
        expect(refreshTargets).toEqual(ownerStorage(storageAgentId));
      });
    }
  }

  test("refreshes the org bucket for a direct owner request too", async () => {
    const { manager, refreshTargets, storageAgentId } = makeManager({
      expiresAt: Date.now() + SOON_MS,
      authType: "device-code",
    });

    const profile = await manager.getBestProfile(
      AGENT_ID,
      "chatgpt",
      undefined,
      { userId: OWNER_ID }
    );
    await manager.ensureFreshCredential(profile!, {
      userId: OWNER_ID,
      agentId: AGENT_ID,
    });

    // The credential lives in the bucket, so refreshing `AGENT_ID` — the id the
    // caller passed — would find no refresh token at all.
    expect(refreshTargets).toEqual(ownerStorage(storageAgentId));
  });

  test("does not read another organization's subscription bucket", async () => {
    const { manager, list } = makeManager({
      expiresAt: Date.now() + HOUR_MS,
      authType: "device-code",
    });

    await orgContext.run({ organizationId: OTHER_ORG_ID }, async () => {
      const profile = await manager.getBestProfile(
        AGENT_ID,
        "chatgpt",
        undefined,
        { userId: RUN_USER_ID }
      );
      expect(profile).toBeNull();
    });

    expect(list.mock.calls.map(([, agentId]) => agentId)).not.toContain(
      orgBucketAgentId(ORG_ID)
    );
  });
});

describe("periodic refresh stays inside the row it scanned", () => {
  const BUCKET_ID = orgBucketAgentId(ORG_ID);

  /**
   * Drive `TokenRefreshJob.runOnce` over a single scanned row. Only the
   * owner's bucket row physically holds the subscription, so scanning the run
   * user's per-agent row must rotate nothing — the merged owner fallback that
   * inference sees is not a refresh grant this row owns.
   */
  function makeJob(scanned: { userId: string; agentId: string }) {
    const refreshToken = mock(async () => ({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      expiresAt: Date.now() + HOUR_MS,
    }));
    const upsert = mock(
      async (_userId: string, _agentId: string, profile: unknown) => profile
    );
    const manager = new AuthProfilesManager({
      ephemeralProfiles: { get: () => undefined } as never,
      declaredAgents: { get: () => undefined } as never,
      userAuthProfiles: {
        list: async (userId: string, agentId: string) =>
          userId === OWNER_ID && agentId === BUCKET_ID
            ? [
                {
                  id: PROFILE_ID,
                  provider: "chatgpt",
                  model: "*",
                  authType: "device-code",
                  credential: STORED_TOKEN,
                  createdAt: 0,
                  metadata: {
                    expiresAt: 1,
                    refreshToken: "owner-refresh-token",
                  },
                },
              ]
            : [],
        upsert,
        scanAllOAuth: async function* () {
          yield { ...scanned, organizationId: ORG_ID };
        },
      } as never,
      secretStore: { get: async () => undefined } as never,
      agentOwnerResolver: async () => OWNER_ID,
    });
    const db = {
      begin: async (fn: (tx: unknown) => Promise<void>) =>
        fn({ unsafe: async () => [] }),
    };
    const job = new TokenRefreshJob(
      manager,
      [{ providerId: "chatgpt", refresher: { refreshToken } }],
      () => db as never
    );
    return { job, refreshToken, upsert };
  }

  test("rotates the owner bucket row it scanned", async () => {
    const { job, refreshToken, upsert } = makeJob({
      userId: OWNER_ID,
      agentId: BUCKET_ID,
    });

    await job.runOnce();

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.slice(0, 2)).toEqual([OWNER_ID, BUCKET_ID]);
  });

  test("writes nothing when the scanned row holds no profile of its own", async () => {
    const { job, refreshToken, upsert } = makeJob({
      userId: RUN_USER_ID,
      agentId: AGENT_ID,
    });

    await job.runOnce();

    expect(refreshToken).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("owner lookups are cached per (org, agent)", () => {
  const OWNER_B = "owner-user-b";
  const TOKEN_B = "org-b-access-token";
  const ownerFor = (orgId: string) =>
    orgId === OTHER_ORG_ID ? OWNER_B : OWNER_ID;

  /**
   * Two orgs can own an agent with the same id — `agents` is keyed on
   * `(organization_id, id)` — and the real resolver reads it behind a
   * cross-tenant guard that yields nothing without org context. So the owner
   * answer is per (org, agent), and the short-lived owner cache has to be too.
   */
  function makeMultiOrgManager() {
    return new AuthProfilesManager({
      ephemeralProfiles: { get: () => undefined } as never,
      declaredAgents: { get: () => undefined } as never,
      userAuthProfiles: {
        list: async (userId: string, agentId: string) => {
          const orgId = tryGetOrgId();
          if (!orgId || agentId !== orgBucketAgentId(orgId)) return [];
          if (userId !== ownerFor(orgId)) return [];
          return [
            {
              id: PROFILE_ID,
              provider: "chatgpt",
              model: "*",
              authType: "device-code",
              credential: userId === OWNER_B ? TOKEN_B : STORED_TOKEN,
              createdAt: 0,
              metadata: { expiresAt: Date.now() + HOUR_MS },
            },
          ];
        },
      } as never,
      secretStore: { get: async () => undefined } as never,
      agentOwnerResolver: async () => {
        const orgId = tryGetOrgId();
        return orgId ? ownerFor(orgId) : undefined;
      },
    });
  }

  const resolve = (manager: AuthProfilesManager) =>
    manager.getBestProfile(AGENT_ID, "chatgpt", undefined, {
      userId: RUN_USER_ID,
    });

  test("each org resolves its own owner for the same agent id", async () => {
    const manager = makeMultiOrgManager();

    const inOwnOrg = await orgContext.run({ organizationId: ORG_ID }, () =>
      resolve(manager)
    );
    const inOtherOrg = await orgContext.run(
      { organizationId: OTHER_ORG_ID },
      () => resolve(manager)
    );

    expect(inOwnOrg?.credential).toBe(STORED_TOKEN);
    expect(inOtherOrg?.credential).toBe(TOKEN_B);
  });

  test("a miss without org context does not poison the scoped lookup", async () => {
    const manager = makeMultiOrgManager();

    // No ambient org and no `agentOrgResolver`: the guard yields no owner.
    expect(await resolve(manager)).toBeNull();
    const scoped = await orgContext.run({ organizationId: ORG_ID }, () =>
      resolve(manager)
    );

    expect(scoped?.credential).toBe(STORED_TOKEN);
  });
});
