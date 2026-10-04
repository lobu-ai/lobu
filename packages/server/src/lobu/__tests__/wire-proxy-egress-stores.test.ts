/**
 * Regression guard for the gateway boot wiring of the HTTP egress proxy.
 *
 * The proxy READS per-agent grants + judged-domain policy from module-level
 * stores that must be injected at boot (`setProxyGrantStore` /
 * `setProxyPolicyStore`). #672's dead-code sweep deleted those two boot calls
 * (it kept `startFilteringProxy()`), so at runtime the proxy silently skipped
 * grants and never consulted the egress judge — only the global
 * `WORKER_ALLOWED_DOMAINS` allowlist stayed in force. Every proxy test injects
 * the stores itself, so nothing covered the boot path and the regression shipped.
 *
 * `wireProxyEgressStores` is the extracted boot step. These tests prove, in the
 * red→green sense, that:
 *   - WITHOUT it, a per-agent grant / judged-domain rule has no effect (the
 *     exact regression); and
 *   - WITH it, the grant is honored and the judged domain reaches the judge.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { GrantStore } from "../../gateway/permissions/grant-store.js";
import type {
  PolicyStore,
  ResolvedJudgeRule,
} from "../../gateway/permissions/policy-store.js";
import { EgressJudge } from "../../gateway/proxy/egress-judge/judge.js";
import type {
  JudgeClient,
  JudgeVerdict,
} from "../../gateway/proxy/egress-judge/types.js";
import {
  __testOnly,
  resolveNetworkConfig,
  setProxyEgressJudge,
} from "../../gateway/proxy/http-proxy.js";
import { wireProxyEgressStores } from "../../gateway/proxy/proxy-manager.js";

// Deny-all global config so every decision falls through to the per-agent grant
// store / judged-domain policy — the layers the boot wiring is responsible for.
function denyAllConfig() {
  const prev = process.env.WORKER_ALLOWED_DOMAINS;
  process.env.WORKER_ALLOWED_DOMAINS = "";
  const config = resolveNetworkConfig();
  if (prev === undefined) delete process.env.WORKER_ALLOWED_DOMAINS;
  else process.env.WORKER_ALLOWED_DOMAINS = prev;
  return config;
}

function grantStoreAllowing(
  agentId: string,
  hostname: string,
  orgId: string
): GrantStore {
  return {
    async hasGrant(a: string, h: string, o?: string): Promise<boolean> {
      return a === agentId && h === hostname && o === orgId;
    },
    async isDenied(): Promise<boolean> {
      return false;
    },
  } as unknown as GrantStore;
}

function policyStoreReturning(rule: ResolvedJudgeRule): PolicyStore {
  return { resolve: () => rule } as unknown as PolicyStore;
}

describe("wireProxyEgressStores — boot wiring of the HTTP egress proxy", () => {
  beforeEach(() => {
    // Start from the unwired runtime state — the regression baseline.
    __testOnly.reset();
  });

  test("UNWIRED: a per-agent grant has no effect (regression baseline)", async () => {
    const config = denyAllConfig();
    const decision = await __testOnly.checkDomainAccess(
      config,
      "github.com",
      "agent-a",
      "org-1"
    );
    // No grant store wired → grant path skipped → blocked by global deny-all.
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("global");
  });

  test("WIRED: the grant store is connected so a per-agent grant is honored", async () => {
    wireProxyEgressStores({
      getGrantStore: () => grantStoreAllowing("agent-a", "github.com", "org-1"),
      getPolicyStore: () => undefined,
    });

    const config = denyAllConfig();
    const decision = await __testOnly.checkDomainAccess(
      config,
      "github.com",
      "agent-a",
      "org-1"
    );
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe("grant");
  });

  test("UNWIRED: a judged domain is never judged (falls through to deny)", async () => {
    const config = denyAllConfig();
    const decision = await __testOnly.checkDomainAccess(
      config,
      "api.github.com",
      "agent-a",
      "org-1"
    );
    expect(decision.source).not.toBe("judge");
    expect(decision.allowed).toBe(false);
  });

  test("WIRED: the policy store is connected so a judged domain reaches the egress judge", async () => {
    const rule: ResolvedJudgeRule = {
      judgeName: "repo-owner-only",
      policy: "allow only repos the user owns",
      policyHash: "policy-hash-1",
    };
    wireProxyEgressStores({
      getGrantStore: () => undefined,
      getPolicyStore: () => policyStoreReturning(rule),
    });
    // `setProxyPolicyStore` lazily builds a real EgressJudge; swap in a fake
    // client so the verdict is deterministic and no model is called. This proves
    // the policy store was wired (the judge path is only reached when resolve()
    // returns a rule from the wired store).
    const denyClient: JudgeClient = {
      async judge(): Promise<JudgeVerdict> {
        return { verdict: "deny", reason: "not permitted" };
      },
    };
    setProxyEgressJudge(
      new EgressJudge({ client: denyClient, resolveOrgDefaultModel: async () => "judge-test" })
    );

    const config = denyAllConfig();
    const decision = await __testOnly.checkDomainAccess(
      config,
      "api.github.com",
      "agent-a",
      "org-1"
    );
    expect(decision.source).toBe("judge");
    expect(decision.judge?.verdict).toBe("deny");
  });
});
