import { beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { MessagePayload } from "@lobu/core";
import {
  type DeploymentInfo,
  DeploymentManager,
  type OrchestratorConfig,
} from "../orchestration/deployment-manager.js";
import { GrantStore } from "../permissions/grant-store.js";
import { PolicyStore } from "../permissions/policy-store.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

/** Minimal concrete subclass — only exists so we can test grant syncing. */
class TestDeploymentManager extends DeploymentManager {
  async listDeployments(): Promise<DeploymentInfo[]> {
    return [];
  }
  async scaleDeployment(): Promise<void> {
    /* noop */
  }
  async deleteDeployment(): Promise<void> {
    /* noop */
  }
  async updateDeploymentActivity(): Promise<void> {
    /* noop */
  }
  async validateWorkerImage(): Promise<void> {
    /* noop */
  }
  protected getDispatcherHost(): string {
    return "localhost";
  }
}

const TEST_CONFIG: OrchestratorConfig = {
  queues: {
    connectionString: "postgres://localhost:5432/lobu",
    retryLimit: 3,
    retryDelay: 5,
    expireInSeconds: 300,
  },
  worker: {
    idleCleanupMinutes: 30,
    maxDeployments: 10,
  },
  cleanup: { initialDelayMs: 5000, intervalMs: 60000, veryOldDays: 7 },
};

function buildPayload(overrides: Partial<MessagePayload>): MessagePayload {
  return {
    userId: "u",
    conversationId: "c",
    messageId: "m",
    channelId: "ch",
    teamId: "t",
    agentId: "agent-1",
    organizationId: "test-org",
    botId: "b",
    platform: "slack",
    messageText: "hi",
    platformMetadata: {},
    agentOptions: {},
    ...overrides,
  };
}

describe("DeploymentManager.syncNetworkConfigGrants", () => {
  let grantStore: GrantStore;
  let policyStore: PolicyStore;
  let manager: TestDeploymentManager;

  // Grant reads are org-scoped, so every lookup needs the payload org.
  const hasGrant = (pattern: string, organizationId = "test-org") =>
    grantStore.hasGrant("agent-1", pattern, organizationId);
  const isDenied = (pattern: string, organizationId = "test-org") =>
    grantStore.isDenied("agent-1", pattern, organizationId);

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    // grants.agent_id has an FK on agents(id); seed the row used below.
    await seedAgentRow("agent-1");
    grantStore = new GrantStore();
    policyStore = new PolicyStore();
    manager = new TestDeploymentManager(TEST_CONFIG);
    manager.setGrantStore(grantStore);
    manager.setPolicyStore(policyStore);
  });

  test("syncs networkConfig.allowedDomains into the grant store", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: {
          allowedDomains: ["api.example.com", ".github.com"],
        },
      })
    );

    expect(await hasGrant("api.example.com")).toBe(true);
    expect(await hasGrant(".github.com")).toBe(true);
  });

  test("syncs preApprovedTools as MCP tool grants", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        preApprovedTools: [
          "/mcp/gmail/tools/list_messages",
          "/mcp/linear/tools/*",
        ],
      })
    );

    expect(await hasGrant("/mcp/gmail/tools/list_messages")).toBe(true);
    // Wildcard pattern should match a specific tool under it.
    expect(await hasGrant("/mcp/linear/tools/create_issue")).toBe(true);
  });

  test("syncs networkConfig.deniedDomains as deny grants", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: {
          allowedDomains: ["api.example.com"],
          deniedDomains: ["evil.com", "*.bad.com"],
        },
      })
    );

    expect(await hasGrant("api.example.com")).toBe(true);
    expect(await isDenied("evil.com")).toBe(true);
    expect(await isDenied("sub.bad.com")).toBe(true);
    expect(await hasGrant("evil.com")).toBe(false);
  });

  test("removing a denied domain from config revokes the deny grant", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { deniedDomains: ["evil.com"] },
      })
    );
    expect(await isDenied("evil.com")).toBe(true);

    await manager.syncNetworkConfigGrants(
      buildPayload({ networkConfig: { deniedDomains: [] } })
    );
    expect(await isDenied("evil.com")).toBe(false);
  });

  test("flipping a domain from denied to allowed updates the grant", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { deniedDomains: ["flip.example.com"] },
      })
    );
    expect(await isDenied("flip.example.com")).toBe(true);

    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["flip.example.com"] },
      })
    );
    expect(await isDenied("flip.example.com")).toBe(false);
    expect(await hasGrant("flip.example.com")).toBe(true);
  });

  test("same agent id in two orgs syncs independently (org-scoped cache)", async () => {
    await seedAgentRow("agent-1", { organizationId: "org-b" });

    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { deniedDomains: ["evil.com"] },
      })
    );
    // Identical payload for the SAME agent id under a different org must not
    // be swallowed by the sync cache — grants rows are org-scoped.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        organizationId: "org-b",
        networkConfig: { deniedDomains: ["evil.com"] },
      })
    );

    expect(await isDenied("evil.com")).toBe(true);
    expect(await isDenied("evil.com", "org-b")).toBe(true);
  });

  test("revokes a config-removed domain even when the sync cache is cold", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["a.example.com"] },
      })
    );
    expect(await hasGrant("a.example.com")).toBe(true);

    // Fresh manager = cold cache (pod restart / other replica). The domain
    // was removed from config; revocation must not depend on pod-local state.
    const freshManager = new TestDeploymentManager(TEST_CONFIG);
    freshManager.setGrantStore(grantStore);
    freshManager.setPolicyStore(policyStore);
    await freshManager.syncNetworkConfigGrants(
      buildPayload({ networkConfig: { allowedDomains: [] } })
    );

    expect(await hasGrant("a.example.com")).toBe(false);
  });

  test("cold-cache sync does not revoke user-approved MCP tool grants", async () => {
    // Simulates a Slack "always" tool approval — same store, mcp_tool kind,
    // no expiry. Config sync must never treat it as config-owned.
    await grantStore.grant(
      "agent-1",
      "/mcp/gmail/tools/send_email",
      null,
      undefined,
      "test-org"
    );

    const freshManager = new TestDeploymentManager(TEST_CONFIG);
    freshManager.setGrantStore(grantStore);
    freshManager.setPolicyStore(policyStore);
    await freshManager.syncNetworkConfigGrants(
      buildPayload({ networkConfig: { allowedDomains: ["x.example.com"] } })
    );

    expect(await hasGrant("/mcp/gmail/tools/send_email")).toBe(true);
  });

  test("grants nix cache domains while nix is configured, revokes on removal", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({ nixConfig: { packages: ["python311"] } })
    );
    expect(await hasGrant("cache.nixos.org")).toBe(true);

    const freshManager = new TestDeploymentManager(TEST_CONFIG);
    freshManager.setGrantStore(grantStore);
    freshManager.setPolicyStore(policyStore);
    await freshManager.syncNetworkConfigGrants(buildPayload({}));

    expect(await hasGrant("cache.nixos.org")).toBe(false);
  });

  test("removing a deny listed under an alias spelling re-allows the domain", async () => {
    // "*.example.com" and ".example.com" normalize to the same grant row.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: {
          allowedDomains: ["*.example.com"],
          deniedDomains: [".example.com"],
        },
      })
    );
    expect(await isDenied("api.example.com")).toBe(true);

    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["*.example.com"] },
      })
    );
    expect(await isDenied("api.example.com")).toBe(false);
    expect(await hasGrant("api.example.com")).toBe(true);
  });

  test("reconcile preserves infra-granted npm registry domains", async () => {
    // Simulates the CLI-backend deploy-time auto-grant, which is not
    // derivable from the message payload and must survive reconciliation.
    await grantStore.grant(
      "agent-1",
      "registry.npmjs.org",
      null,
      undefined,
      "test-org"
    );

    const freshManager = new TestDeploymentManager(TEST_CONFIG);
    freshManager.setGrantStore(grantStore);
    freshManager.setPolicyStore(policyStore);
    await freshManager.syncNetworkConfigGrants(
      buildPayload({ networkConfig: { allowedDomains: ["x.example.com"] } })
    );

    expect(await hasGrant("registry.npmjs.org")).toBe(true);
  });

  test("a config-denied npm registry row survives reconcile as a deny", async () => {
    // Deny the npm registry in config; the reconcile must keep the deny row
    // (it is config-expected), and the infra exemption must not resurrect it.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { deniedDomains: ["registry.npmjs.org"] },
      })
    );
    expect(await isDenied("registry.npmjs.org")).toBe(true);

    // Removing the deny from config drops the row even though the domain is
    // in the infra exempt set — a denied row is never exempt.
    const freshManager = new TestDeploymentManager(TEST_CONFIG);
    freshManager.setGrantStore(grantStore);
    freshManager.setPolicyStore(policyStore);
    await freshManager.syncNetworkConfigGrants(buildPayload({}));
    expect(await isDenied("registry.npmjs.org")).toBe(false);
  });

  test("two-replica X→Y→X: a warm stale cache must not skip reconciliation", async () => {
    const replicaA = manager;
    const replicaB = new TestDeploymentManager(TEST_CONFIG);
    replicaB.setGrantStore(grantStore);
    replicaB.setPolicyStore(policyStore);

    const configX = { networkConfig: { allowedDomains: ["x.example.com"] } };
    const configY = { networkConfig: { allowedDomains: ["y.example.com"] } };

    // Replica A syncs X (warm cache = X), replica B syncs Y (DB = Y).
    await replicaA.syncNetworkConfigGrants(buildPayload(configX));
    await replicaB.syncNetworkConfigGrants(buildPayload(configY));
    expect(await hasGrant("y.example.com")).toBe(true);
    expect(await hasGrant("x.example.com")).toBe(false);

    // Config reverts to X and the message lands on replica A, whose cache
    // already says X. Skipping on the pod-local cache would leave Y's rows
    // active and X's rows missing.
    await replicaA.syncNetworkConfigGrants(buildPayload(configX));
    expect(await hasGrant("y.example.com")).toBe(false);
    expect(await hasGrant("x.example.com")).toBe(true);
  });

  test("syncs both network and pre-approved tools in one call", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        preApprovedTools: ["/mcp/gmail/tools/send_email"],
      })
    );

    expect(await hasGrant("api.example.com")).toBe(true);
    expect(await hasGrant("/mcp/gmail/tools/send_email")).toBe(true);
  });

  test("no-op when grantStore is not set", async () => {
    const barebones = new TestDeploymentManager(TEST_CONFIG);
    // Does not throw, nothing to assert against.
    await barebones.syncNetworkConfigGrants(
      buildPayload({
        preApprovedTools: ["/mcp/gmail/tools/send_email"],
      })
    );
  });

  test("syncs egress judge policies even when no grant store is set", async () => {
    const barebones = new TestDeploymentManager(TEST_CONFIG);
    barebones.setPolicyStore(policyStore);

    // Egress judges are sourced from the agent's `egress`-stage inline
    // guardrails — each becomes a named judge gating its `domains`.
    await barebones.syncNetworkConfigGrants(
      buildPayload({
        guardrailsInline: [
          {
            name: "default",
            enabled: true,
            stage: "egress",
            policy: "initial policy",
            model: "model-x",
            domains: ["api.example.com"],
          },
        ],
      })
    );

    let resolved = policyStore.resolve("test-org", "agent-1", "api.example.com");
    expect(resolved?.policy).toContain("initial policy");
    expect(resolved?.judgeModel).toBe("model-x");

    await barebones.syncNetworkConfigGrants(
      buildPayload({
        guardrailsInline: [
          {
            name: "default",
            enabled: true,
            stage: "egress",
            policy: "updated policy",
            domains: ["api.example.com"],
          },
        ],
      })
    );

    resolved = policyStore.resolve("test-org", "agent-1", "api.example.com");
    expect(resolved?.policy).toContain("updated policy");
    expect(resolved?.policy).not.toContain("initial policy");

    await barebones.syncNetworkConfigGrants(buildPayload({}));
    expect(policyStore.resolve("test-org", "agent-1", "api.example.com")).toBeUndefined();
  });

  test("skips redundant writes when the pattern set has not changed", async () => {
    const grantSpy = spyOn(grantStore, "grant");
    const payload = buildPayload({
      networkConfig: { allowedDomains: ["api.example.com"] },
      preApprovedTools: ["/mcp/gmail/tools/send_email"],
    });

    await manager.syncNetworkConfigGrants(payload);
    const callsAfterFirst = grantSpy.mock.calls.length;
    expect(callsAfterFirst).toBe(2);

    // Second call with identical patterns — should be a no-op.
    await manager.syncNetworkConfigGrants(payload);
    expect(grantSpy.mock.calls.length).toBe(callsAfterFirst);

    // Same patterns in a different order — still a no-op.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        preApprovedTools: ["/mcp/gmail/tools/send_email"],
      })
    );
    expect(grantSpy.mock.calls.length).toBe(callsAfterFirst);

    // Adding a new pattern only grants the new one, leaves old alone.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        preApprovedTools: [
          "/mcp/gmail/tools/send_email",
          "/mcp/gmail/tools/list_messages",
        ],
      })
    );
    expect(grantSpy.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  test("revokes patterns removed from the agent's config", async () => {
    const revokeSpy = spyOn(grantStore, "revoke");

    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: {
          allowedDomains: ["api.example.com", ".github.com"],
        },
        preApprovedTools: ["/mcp/gmail/tools/send_email"],
      })
    );

    expect(await hasGrant("api.example.com")).toBe(true);
    expect(await hasGrant(".github.com")).toBe(true);
    expect(await hasGrant("/mcp/gmail/tools/send_email")).toBe(true);

    // Shrink the set: drop the second domain and the MCP tool grant.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
      })
    );

    expect(revokeSpy).toHaveBeenCalledTimes(2);
    expect(await hasGrant("api.example.com")).toBe(true);
    expect(await hasGrant(".github.com")).toBe(false);
    expect(await hasGrant("/mcp/gmail/tools/send_email")).toBe(false);
  });

  test("domain sync writes only on drift, and repairs drift without invalidation", async () => {
    // Domains reconcile against Postgres on every sync: identical repeat
    // syncs cost zero writes, and out-of-band drift (a revoked row) is
    // repaired on the next message with no cache invalidation involved.
    const grantSpy = spyOn(grantStore, "grant");

    const payload = buildPayload({
      networkConfig: { allowedDomains: ["api.example.com"] },
    });

    await manager.syncNetworkConfigGrants(payload);
    const firstCallCount = grantSpy.mock.calls.length;
    expect(firstCallCount).toBe(1);

    // Identical second call → rows already match → no new writes.
    await manager.syncNetworkConfigGrants(payload);
    expect(grantSpy.mock.calls.length).toBe(firstCallCount);

    // Simulate drift (row removed out of band): the next sync re-grants.
    await grantStore.revoke("agent-1", "api.example.com", "test-org");
    await manager.syncNetworkConfigGrants(payload);
    expect(grantSpy.mock.calls.length).toBe(firstCallCount + 1);
    expect(await hasGrant("api.example.com")).toBe(true);
  });

  test("revokes all grants when the config is cleared entirely", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        preApprovedTools: ["/mcp/gmail/tools/send_email"],
      })
    );

    expect(await hasGrant("api.example.com")).toBe(true);
    expect(await hasGrant("/mcp/gmail/tools/send_email")).toBe(true);

    // Operator clears both lists.
    await manager.syncNetworkConfigGrants(buildPayload({}));

    expect(await hasGrant("api.example.com")).toBe(false);
    expect(await hasGrant("/mcp/gmail/tools/send_email")).toBe(false);
  });
});

/**
 * A judged domain must never receive a blanket ALLOW grant.
 *
 * `checkDomainAccess` consults per-agent allow grants BEFORE the egress judge,
 * so an allow grant on a judged domain makes that judge permanently inert —
 * the request succeeds at `source: "grant"` and the policy never runs. PR #3299
 * rejects the combination when an operator types it into agent config, but the
 * dispatch path can still produce it without anyone typing it: connector
 * `agentTooling` contributions are folded into
 * `payload.networkConfig.allowedDomains` (`foldConnectorTooling`) AFTER that
 * write-time check, and this reconcile then grants them.
 *
 * So the invariant is enforced HERE, where the judged set and the grant
 * reconcile meet: a domain the judge governs is skipped on the allow side.
 * Deny still wins — a deny grant outranks the judge by design.
 */
describe("syncNetworkConfigGrants — a judged domain gets no allow grant", () => {
  let grantStore: GrantStore;
  let policyStore: PolicyStore;
  let manager: TestDeploymentManager;

  const hasGrant = (pattern: string, organizationId = "test-org") =>
    grantStore.hasGrant("agent-1", pattern, organizationId);
  const isDenied = (pattern: string, organizationId = "test-org") =>
    grantStore.isDenied("agent-1", pattern, organizationId);

  const judgeOn = (...domains: string[]) => [
    {
      name: "watchdog",
      stage: "egress" as const,
      enabled: true,
      policy: "Allow read-only GETs.",
      domains,
    },
  ];

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow("agent-1");
    grantStore = new GrantStore();
    policyStore = new PolicyStore();
    manager = new TestDeploymentManager(TEST_CONFIG);
    manager.setGrantStore(grantStore);
    manager.setPolicyStore(policyStore);
  });

  test("skips the allow grant for a domain its own judge governs", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        guardrailsInline: judgeOn("api.example.com"),
      })
    );
    expect(await hasGrant("api.example.com")).toBe(false);
    // The judge itself must still be registered, or we have just denied it.
    expect(
      policyStore.resolve("test-org", "agent-1", "api.example.com")
    ).toBeDefined();
  });

  test("still grants an UNJUDGED domain in the same payload", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: {
          allowedDomains: ["api.example.com", "plain.example.net"],
        },
        guardrailsInline: judgeOn("api.example.com"),
      })
    );
    expect(await hasGrant("api.example.com")).toBe(false);
    expect(await hasGrant("plain.example.net")).toBe(true);
  });

  test("skips a connector-folded domain the judge governs", async () => {
    // The motivating case. This is the shape `foldConnectorTooling` produces:
    // the domain arrives in `allowedDomains` ON THE PAYLOAD and was never in
    // the saved agent config, so PR #3299's write-time guard never saw it.
    // Mechanically identical to a config domain — which is the point: the
    // reconcile cannot tell them apart, so enforcing here covers both.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["contributed.example.com"] },
        guardrailsInline: judgeOn("contributed.example.com"),
      })
    );
    expect(await hasGrant("contributed.example.com")).toBe(false);
  });

  test("skips a Nix cache domain the judge governs, keeps the rest", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        nixConfig: { packages: ["python311"] },
        guardrailsInline: judgeOn("cache.nixos.org"),
      })
    );
    expect(await hasGrant("cache.nixos.org")).toBe(false);
    expect(await hasGrant("channels.nixos.org")).toBe(true);
  });

  test("matches a judged WILDCARD against a specific allowed host", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        guardrailsInline: judgeOn("*.example.com"),
      })
    );
    expect(await hasGrant("api.example.com")).toBe(false);
  });

  test("normalizes both sides — alias spellings still collapse", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["*.example.com"] },
        guardrailsInline: judgeOn(".EXAMPLE.com"),
      })
    );
    expect(await hasGrant(".example.com")).toBe(false);
  });

  test("DENY still wins over the judge", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: {
          allowedDomains: ["api.example.com"],
          deniedDomains: ["api.example.com"],
        },
        guardrailsInline: judgeOn("api.example.com"),
      })
    );
    expect(await isDenied("api.example.com")).toBe(true);
  });

  test("HEALS an existing shadowed grant by revoking it", async () => {
    // First dispatch with no judge: the domain gets a normal allow grant.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
      })
    );
    expect(await hasGrant("api.example.com")).toBe(true);

    // Adding a judge over it must reconcile the stale grant AWAY, or the
    // judge stays inert for every agent that was already in this state.
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        guardrailsInline: judgeOn("api.example.com"),
      })
    );
    expect(await hasGrant("api.example.com")).toBe(false);
  });

  test("a DISABLED judge does not suppress the grant", async () => {
    await manager.syncNetworkConfigGrants(
      buildPayload({
        networkConfig: { allowedDomains: ["api.example.com"] },
        guardrailsInline: [
          { ...judgeOn("api.example.com")[0], enabled: false },
        ],
      })
    );
    expect(await hasGrant("api.example.com")).toBe(true);
  });
});
