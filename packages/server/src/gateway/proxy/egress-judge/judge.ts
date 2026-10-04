import type { ResolvedJudgeRule } from "../../permissions/policy-store.js";
import { VerdictCache } from "./cache.js";
import { JudgeRunner, type JudgeRunnerOptions } from "./judge-runner.js";
import { buildSystemPrompt, buildUserPrompt } from "./policy-composer.js";
import type { JudgeDecision, JudgeRequest } from "./types.js";

/**
 * Egress judge: wraps a JudgeClient with a per-policy verdict cache and
 * circuit breaker, and composes prompts from skill/operator policy + the
 * request.
 *
 * Thread-safety: single-threaded Node event loop; no locks needed. The
 * in-flight dedup map (owned by {@link JudgeRunner}) coalesces concurrent
 * judge calls for the same cache key so a burst of identical requests costs
 * exactly one API call.
 */
export class EgressJudge extends JudgeRunner<JudgeDecision> {
  constructor(options: JudgeRunnerOptions = {}) {
    super(
      {
        loggerName: "egress-judge",
        logPrefix: "Egress judge",
        separator: "—",
        deniedSuffix: "request denied",
      },
      options
    );
  }

  async decide(
    request: JudgeRequest,
    rule: ResolvedJudgeRule
  ): Promise<JudgeDecision> {
    const cacheKey = VerdictCache.key({
      orgId: request.organizationId,
      policyHash: rule.policyHash,
      hostname: request.hostname,
      method: request.method,
      path: request.path,
    });

    return this.run({
      cacheKey,
      policyHash: rule.policyHash,
      // Per-rule model from the egress guardrail's own `model` field; unset
      // falls back to the org's default provider model.
      model: rule.judgeModel,
      orgId: request.organizationId,
      logFields: { hostname: request.hostname },
      buildPrompts: () => ({
        systemPrompt: buildSystemPrompt(),
        userPrompt: buildUserPrompt({ policy: rule.policy, request }),
      }),
      decorate: (verdict, meta) => ({
        ...verdict,
        source: meta.source,
        latencyMs: meta.latencyMs,
        policyHash: rule.policyHash,
        judgeName: rule.judgeName,
      }),
    });
  }
}
