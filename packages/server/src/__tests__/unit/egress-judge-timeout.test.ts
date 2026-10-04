/**
 * Egress-judge per-call timeout + circuit hygiene.
 *
 * The judge is awaited synchronously by the HTTP proxy when a `judge`-action
 * rule matches, so a hung model call would otherwise stall an outbound
 * request indefinitely. These tests pin: (1) a call that hangs past the
 * timeout resolves to a deny verdict within ~timeout, and (2) consecutive
 * timeouts count as breaker failures, so the circuit opens and later calls
 * fail closed without touching the model.
 */
import { describe, expect, test } from "bun:test";
import type { ResolvedJudgeRule } from "../../gateway/permissions/policy-store.js";
import { EgressJudge } from "../../gateway/proxy/egress-judge/judge.js";
import type {
  JudgeClient,
  JudgeVerdict,
} from "../../gateway/proxy/egress-judge/types.js";

class HangingClient implements JudgeClient {
  calls = 0;
  async judge(): Promise<JudgeVerdict> {
    this.calls++;
    // Never settles — the judge's own timeout must rescue the caller.
    return new Promise<JudgeVerdict>(() => {});
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

describe("EgressJudge timeout", () => {
  test("a hung judge call fails closed within ~timeout", async () => {
    const client = new HangingClient();
    const judge = new EgressJudge({ client, judgeTimeoutMs: 30, resolveOrgDefaultModel: async () => "judge-test-model" });
    const started = Date.now();
    const decision = await judge.decide(
      { agentId: "agent-a", organizationId: "org-1", hostname: "api.github.com" },
      rule()
    );
    const elapsed = Date.now() - started;
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("judge-error");
    expect(decision.reason).toContain("timed out");
    expect(elapsed).toBeLessThan(500);
    expect(client.calls).toBe(1);
  });

  test("consecutive timeouts trip the breaker and stop calling the model", async () => {
    const client = new HangingClient();
    const judge = new EgressJudge({
      client,
      judgeTimeoutMs: 20,
      resolveOrgDefaultModel: async () => "judge-test-model",
      breakerFailureThreshold: 2,
      breakerCooldownMs: 60_000,
    });
    // Distinct hostnames so the verdict cache never short-circuits the path.
    for (let i = 0; i < 5; i++) {
      const decision = await judge.decide(
        { agentId: "agent-a", organizationId: "org-1", hostname: `h${i}.example.com` },
        rule()
      );
      expect(decision.verdict).toBe("deny");
    }
    // First two calls time out and count as breaker failures; the breaker
    // then opens and the remaining three short-circuit without the model.
    expect(client.calls).toBe(2);

    const afterOpen = await judge.decide(
      { agentId: "agent-a", organizationId: "org-1", hostname: "another.example.com" },
      rule()
    );
    expect(afterOpen.verdict).toBe("deny");
    expect(afterOpen.source).toBe("circuit-open");
    expect(client.calls).toBe(2);
  });

  test("EGRESS_JUDGE_TIMEOUT_MS env var sets the default", async () => {
    const prev = process.env.EGRESS_JUDGE_TIMEOUT_MS;
    process.env.EGRESS_JUDGE_TIMEOUT_MS = "25";
    try {
      const client = new HangingClient();
      const judge = new EgressJudge({ client, resolveOrgDefaultModel: async () => "judge-test-model" });
      const started = Date.now();
      const decision = await judge.decide(
        { agentId: "agent-a", organizationId: "org-1", hostname: "api.github.com" },
        rule()
      );
      expect(decision.verdict).toBe("deny");
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      if (prev === undefined) delete process.env.EGRESS_JUDGE_TIMEOUT_MS;
      else process.env.EGRESS_JUDGE_TIMEOUT_MS = prev;
    }
  });
});
