import { describe, expect, mock, test } from "bun:test";
import { orgContext, tryGetOrgId } from "../../../../lobu/stores/org-context.js";
import { AuthProfilesManager } from "../auth-profiles-manager.js";
import { orgBucketAgentId } from "../user-auth-profile-store.js";

// Owner-fallback coverage for OAUTH SUBSCRIPTIONS on cloud Automation runs.
//
// A scheduled/chat run executes as a synthetic principal that owns no auth
// profile, so resolution falls back to the agent owner's rows. For a
// subscription sign-in that row lives in the org bucket
// (`orgBucketAgentId(orgId)`), not under the running agentId. Two things have
// to hold for the fallback to be usable rather than merely visible:
//
//   * refresh must target the row the credential was READ from — the owner
//     plus that storage agentId, inside that row's org partition — never the
//     synthetic requesting principal, and
//   * an already-expired subscription must be refreshed BEFORE the expiry
//     filter in `getBestProfile` drops it, or a scheduled run can never
//     recover once its token lapses.
//
// The last test pins the tenant boundary: the owner-bucket read follows the
// AMBIENT org, so a run in another org never touches this org's subscription.

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

type RefreshTarget = {
  userId: string;
  agentId: string;
  organizationId: string | null;
};

/**
 * Build a manager whose only stored profile is the OWNER's OAuth profile, held
 * under `storageAgentId` — the org bucket by default, or the agent's own id
 * when `bucket: false`. `refreshNow` mutates that row the way TokenRefreshJob
 * does, and both hooks record the (userId, agentId, org) they were asked to
 * refresh so a test can assert the refresh targeted the storage row rather
 * than the principal that requested the credential.
 */
function makeManager(opts: { expiresAt: number; bucket?: boolean }) {
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
            authType: "oauth" as const,
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
    const { manager } = makeManager({ expiresAt: Date.now() + HOUR_MS });

    const profile = await manager.getBestProfile(AGENT_ID, "chatgpt", undefined, {
      userId: RUN_USER_ID,
    });

    expect(profile?.credential).toBe(STORED_TOKEN);
  });

  for (const bucket of [true, false]) {
    test(`refreshes the owner storage row, not the run user (bucket=${bucket})`, async () => {
      const { manager, refreshTargets, storageAgentId } = makeManager({
        expiresAt: Date.now() + SOON_MS,
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
  }

  test("refreshes an expired owner subscription instead of dropping it", async () => {
    const { manager, refreshNow, refreshTargets, storageAgentId } = makeManager({
      expiresAt: Date.now() - HOUR_MS,
    });

    const profile = await manager.getBestProfile(AGENT_ID, "chatgpt", undefined, {
      userId: RUN_USER_ID,
    });

    expect(profile?.credential).toBe(REFRESHED_TOKEN);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(refreshTargets).toEqual(ownerStorage(storageAgentId));
  });

  test("refreshes the org bucket for a direct owner request too", async () => {
    const { manager, refreshTargets, storageAgentId } = makeManager({
      expiresAt: Date.now() + SOON_MS,
    });

    const profile = await manager.getBestProfile(AGENT_ID, "chatgpt", undefined, {
      userId: OWNER_ID,
    });
    await manager.ensureFreshCredential(profile!, {
      userId: OWNER_ID,
      agentId: AGENT_ID,
    });

    // The credential lives in the bucket, so refreshing `AGENT_ID` — the id the
    // caller passed — would find no refresh token at all.
    expect(refreshTargets).toEqual(ownerStorage(storageAgentId));
  });

  test("does not read another organization's subscription bucket", async () => {
    const { manager, list } = makeManager({ expiresAt: Date.now() + HOUR_MS });

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
