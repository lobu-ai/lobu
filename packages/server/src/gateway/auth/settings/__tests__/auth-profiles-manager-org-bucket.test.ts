import { describe, expect, mock, test } from "bun:test";
import { orgContext } from "../../../../lobu/stores/org-context.js";
import { AuthProfilesManager } from "../auth-profiles-manager.js";
import { orgBucketAgentId } from "../user-auth-profile-store.js";

// Resolution-merge coverage for the per-user ORG BUCKET.
//
// A subscription sign-in on the org inference-providers page is stored under
// `(userId, orgBucketAgentId(orgId))` — NOT under the running agentId — and must
// still surface when an agent runs. `listProfilesInOrgContext` reads the bucket
// (keyed on the ambient org id) and merges it AFTER the agent-specific user
// profile but BEFORE owner/ephemeral/declared. These tests pin that precedence
// and the ambient-org-context requirement, the one resolution surface the OAuth
// PR left covered only indirectly.

const AGENT_ID = "agent-1";
const ORG_ID = "org-A";
const USER_ID = "run-user";

function orgBucketProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "org-claude-1",
    provider: "claude",
    model: "*",
    authType: "oauth" as const,
    credentialRef:
      "secret://users/run-user/agents/__org_oauth__:org-A/auth-profiles/org-claude-1/credential",
    createdAt: 0,
    ...overrides,
  };
}

function agentUserProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-claude-1",
    provider: "claude",
    model: "*",
    authType: "oauth" as const,
    credentialRef:
      "secret://users/run-user/agents/agent-1/auth-profiles/agent-claude-1/credential",
    createdAt: 0,
    ...overrides,
  };
}

/**
 * Build a manager whose `userAuthProfiles.list(userId, agentId)` returns the
 * agent-specific profiles for the real agentId and the org-bucket profiles for
 * `orgBucketAgentId(ORG_ID)`, so the merge in `listProfilesInOrgContext` is
 * exercised exactly as it runs in prod. The secret store echoes a resolved
 * value keyed by the ref so we can assert WHICH profile survived dedupe.
 */
function makeManager(opts: {
  agentProfiles?: unknown[];
  bucketProfiles?: unknown[];
}) {
  const secretStore = {
    // Return the ref itself so the resolved credential identifies its source
    // profile — lets us assert precedence by which credentialRef came back.
    get: mock(async (ref: string) => `resolved:${ref}`),
    put: mock(async (name: string) => `secret://${name}`),
    delete: mock(async () => {}),
  };
  const bucketKey = orgBucketAgentId(ORG_ID);
  const manager = new AuthProfilesManager({
    ephemeralProfiles: { get: () => undefined } as never,
    declaredAgents: { get: () => undefined } as never,
    userAuthProfiles: {
      list: mock(async (uid: string, agentId: string) => {
        if (uid !== USER_ID) return [];
        if (agentId === bucketKey) return opts.bucketProfiles ?? [];
        if (agentId === AGENT_ID) return opts.agentProfiles ?? [];
        return [];
      }),
    } as never,
    secretStore: secretStore as never,
    // This fixture tests requesting-user precedence without an owner fallback.
    agentOwnerResolver: async () => undefined,
    agentOrgResolver: async () => ORG_ID,
  });
  return { manager, secretStore };
}

describe("AuthProfilesManager — org-bucket resolution merge", () => {
  test("org-bucket OAuth profile surfaces for a real agent run", async () => {
    const { manager } = makeManager({
      agentProfiles: [], // no per-agent sign-in
      bucketProfiles: [orgBucketProfile()],
    });

    await orgContext.run({ organizationId: ORG_ID }, async () => {
      const profiles = await manager.getProviderProfiles(
        AGENT_ID,
        "claude",
        USER_ID
      );
      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.id).toBe("org-claude-1");
      expect(profiles[0]?.credential).toContain("org-claude-1");
    });
  });

  test("agent-specific user profile wins over the org bucket (same scope)", async () => {
    const { manager } = makeManager({
      agentProfiles: [agentUserProfile()],
      bucketProfiles: [orgBucketProfile()],
    });

    await orgContext.run({ organizationId: ORG_ID }, async () => {
      const profiles = await manager.getProviderProfiles(
        AGENT_ID,
        "claude",
        USER_ID
      );
      // dedupeByScope keys on `provider:model` and keeps the FIRST entry —
      // the agent-user profile is merged before the org bucket, so an explicit
      // per-agent sign-in beats the org-wide one.
      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.id).toBe("agent-claude-1");
    });
  });

  test("org bucket takes over when the agent-specific profile is expired", async () => {
    const { manager } = makeManager({
      agentProfiles: [agentUserProfile({ metadata: { expiresAt: 1 } })], // long expired
      bucketProfiles: [orgBucketProfile()], // no expiry → fresh
    });

    await orgContext.run({ organizationId: ORG_ID }, async () => {
      const profiles = await manager.getProviderProfiles(
        AGENT_ID,
        "claude",
        USER_ID
      );
      // dedupeByScope swaps in the challenger when the incumbent is expired and
      // the challenger isn't — so a stale per-agent token yields to a live org
      // sign-in instead of stranding the run on a dead credential.
      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.id).toBe("org-claude-1");
    });
  });

  test("org bucket is NOT read without ambient org context", async () => {
    const { manager } = makeManager({
      agentProfiles: [],
      bucketProfiles: [orgBucketProfile()],
    });

    // agentOrgResolver yields ORG_ID, so listProfiles establishes org context
    // itself (chat-webhook path) and the bucket DOES resolve. To prove the
    // context-gating, drive the private path with a manager whose org resolver
    // yields nothing: no org id → bucket key never queried → no profile.
    const noOrg = new AuthProfilesManager({
      ephemeralProfiles: { get: () => undefined } as never,
      declaredAgents: { get: () => undefined } as never,
      userAuthProfiles: {
        list: mock(async (uid: string, agentId: string) =>
          uid === USER_ID && agentId === orgBucketAgentId(ORG_ID)
            ? [orgBucketProfile()]
            : []
        ),
      } as never,
      secretStore: {
        get: mock(async (ref: string) => `resolved:${ref}`),
        put: mock(async (name: string) => `secret://${name}`),
        delete: mock(async () => {}),
      } as never,
      agentOwnerResolver: async () => undefined,
      agentOrgResolver: async () => undefined, // org unresolvable
    });

    const profiles = await noOrg.getProviderProfiles(
      AGENT_ID,
      "claude",
      USER_ID
    );
    expect(profiles).toHaveLength(0);
  });
});
