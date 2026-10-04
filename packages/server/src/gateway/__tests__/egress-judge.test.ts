import { describe, expect, test } from "bun:test";
import type { ResolvedJudgeRule } from "../permissions/policy-store.js";
import { EgressJudge } from "../proxy/egress-judge/judge.js";
import type { JudgeClient, JudgeVerdict } from "../proxy/egress-judge/types.js";

class StubClient implements JudgeClient {
  calls = 0;
  lastModel: string | undefined;
  constructor(private impl: () => Promise<JudgeVerdict>) {}
  async judge(args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeVerdict> {
    this.calls++;
    this.lastModel = args.model;
    return this.impl();
  }
}

function rule(overrides: Partial<ResolvedJudgeRule> = {}): ResolvedJudgeRule {
  return {
    judgeName: "default",
    policy: "allow only repos the user owns",
    policyHash: "policy-hash-1",
    ...overrides,
  };
}

describe("EgressJudge.decide", () => {
  test("returns an allow verdict from the client", async () => {
    const client = new StubClient(async () => ({
      verdict: "allow",
      reason: "within policy",
    }));
    const judge = new EgressJudge({ client, resolveOrgDefaultModel: async () => "judge-test-model" });
    const decision = await judge.decide(
      { agentId: "agent-a", hostname: "api.github.com" },
      rule()
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.reason).toBe("within policy");
    expect(decision.source).toBe("judge");
    expect(client.calls).toBe(1);
  });

  test("returns a deny verdict from the client", async () => {
    const client = new StubClient(async () => ({
      verdict: "deny",
      reason: "unknown repo",
    }));
    const judge = new EgressJudge({ client, resolveOrgDefaultModel: async () => "judge-test-model" });
    const decision = await judge.decide(
      { agentId: "agent-a", hostname: "api.github.com" },
      rule()
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("judge");
  });

  test("second identical request hits the cache", async () => {
    const client = new StubClient(async () => ({
      verdict: "allow",
      reason: "ok",
    }));
    const judge = new EgressJudge({ client, resolveOrgDefaultModel: async () => "judge-test-model" });
    const req = { agentId: "agent-a", hostname: "api.github.com" };
    const r = rule();
    await judge.decide(req, r);
    const second = await judge.decide(req, r);
    expect(client.calls).toBe(1);
    expect(second.source).toBe("cache");
  });

  test("a different policy hash misses the cache", async () => {
    const client = new StubClient(async () => ({
      verdict: "allow",
      reason: "ok",
    }));
    const judge = new EgressJudge({ client, resolveOrgDefaultModel: async () => "judge-test-model" });
    const req = { agentId: "agent-a", hostname: "api.github.com" };
    await judge.decide(req, rule({ policyHash: "h1" }));
    await judge.decide(req, rule({ policyHash: "h2" }));
    expect(client.calls).toBe(2);
  });

  test("concurrent identical requests share a single judge call", async () => {
    let resolveOne: (v: JudgeVerdict) => void = () => {
      // Overwritten before the promise is awaited.
    };
    const client = new StubClient(
      () =>
        new Promise<JudgeVerdict>((resolve) => {
          resolveOne = resolve;
        })
    );
    const judge = new EgressJudge({ client, resolveOrgDefaultModel: async () => "judge-test-model" });
    const req = { agentId: "agent-a", hostname: "api.github.com" };
    const r = rule();
    const a = judge.decide(req, r);
    const b = judge.decide(req, r);
    resolveOne({ verdict: "allow", reason: "ok" });
    const [dA, dB] = await Promise.all([a, b]);
    expect(client.calls).toBe(1);
    expect(dA.verdict).toBe("allow");
    expect(dB.verdict).toBe("allow");
  });

  test("fails closed when the client throws", async () => {
    const client = new StubClient(async () => {
      throw new Error("boom");
    });
    const judge = new EgressJudge({ client, resolveOrgDefaultModel: async () => "judge-test-model" });
    const decision = await judge.decide(
      { agentId: "agent-a", hostname: "api.github.com" },
      rule()
    );
    expect(decision.verdict).toBe("deny");
    // A single judge-call failure is not the same as the breaker being
    // open; audit logs need to distinguish them.
    expect(decision.source).toBe("judge-error");
  });

  test("trips the circuit after consecutive failures and stops calling the client", async () => {
    const client = new StubClient(async () => {
      throw new Error("upstream down");
    });
    const judge = new EgressJudge({
      client,
      resolveOrgDefaultModel: async () => "judge-test-model",
      breakerFailureThreshold: 2,
      breakerCooldownMs: 60_000,
    });
    // Use non-cached requests (same policy, different hostnames so the cache
    // doesn't short-circuit the failure path).
    for (let i = 0; i < 5; i++) {
      await judge.decide(
        { agentId: "agent-a", hostname: `h${i}.example.com` },
        rule()
      );
    }
    // Two failures hit the client; the breaker then opens and short-circuits.
    expect(client.calls).toBe(2);
  });

  test("honours the per-agent judge model override", async () => {
    const client = new StubClient(async () => ({
      verdict: "allow",
      reason: "",
    }));
    const judge = new EgressJudge({
      client,
      resolveOrgDefaultModel: async () => "default-model",
    });
    await judge.decide(
      { agentId: "agent-a", hostname: "x.com" },
      rule({ judgeModel: "override-model" })
    );
    expect(client.lastModel).toBe("override-model");
  });
});
