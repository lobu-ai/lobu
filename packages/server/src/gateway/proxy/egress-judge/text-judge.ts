import { createHash } from "node:crypto";
import { VerdictCache } from "./cache.js";
import { JudgeRunner, type JudgeRunnerOptions } from "./judge-runner.js";

/**
 * Separator between policy and text when hashing the cache key. ASCII 0x1F
 * (Unit Separator) so a policy ending in "foo" + text "bar" can't collide
 * with policy "f" + text "oobar". Written as the JS escape "\u001F" rather than a literal
 * control byte so the file stays plain ASCII (a literal 0x1F makes git
 * treat the source as binary).
 */
const HASH_SEPARATOR = "\u001F";

const TEXT_JUDGE_SYSTEM_PROMPT = `You are a safety judge for an autonomous AI agent's text outputs and inputs.

You decide whether a single piece of text is safe to pass, given the policy the operator has configured. The text may be a user message inbound to the agent, the agent's outbound response, or a tool-call argument bundle the agent is about to execute.

Return ONLY a JSON object matching this exact shape:
{ "verdict": "allow" | "deny", "reason": "<short sentence>" }

- "allow" means the text is within policy.
- "deny" means the text violates policy and the action must be blocked.
- "reason" is a short sentence (under 30 words). Do not include chain of thought.
- If the policy is ambiguous, fail closed: deny with a reason explaining the ambiguity.
- Output must be parseable JSON. No prose outside the JSON object.`;

function buildUserPrompt(policy: string, text: string): string {
  return `Policy:
${policy.trim()}

Text:
${text}`;
}

function hashTextJudgeKey(policy: string, text: string): string {
  const h = createHash("sha256");
  h.update(policy);
  h.update(HASH_SEPARATOR);
  h.update(text);
  return h.digest("hex");
}

function hashPolicy(policy: string): string {
  return createHash("sha256").update(policy).digest("hex");
}

/**
 * Reusable text judge: takes a policy + a chunk of text and returns
 * `{ allow, reason }`. Shares the cache/breaker/timeout/dedup machinery with
 * the egress judge via {@link JudgeRunner} -- the cache is a separate instance
 * so verdicts from request-shaped requests can't satisfy text-shaped ones.
 *
 * Single-threaded Node event loop; no locks. Concurrent calls for the same
 * `(policy, text)` are deduped via the runner's in-flight map.
 */
export class TextJudge extends JudgeRunner<{ allow: boolean; reason: string }> {
  constructor(options: JudgeRunnerOptions = {}) {
    super(
      {
        loggerName: "text-judge",
        logPrefix: "Text judge",
        separator: "--",
        deniedSuffix: "denied",
      },
      options
    );
  }

  /**
   * Evaluate a chunk of text against a policy. Returns `{ allow, reason }`
   * -- `allow: false` means the policy was tripped (or the call failed
   * closed).
   *
   * Cache key is `(policyHash, textHash)`. The caller passes the policy
   * text, not a hash, because callers don't need to track the hash
   * themselves. Editing the policy invalidates prior verdicts automatically.
   */
  async decide(
    policy: string,
    text: string,
    options: { model?: string; orgId?: string } = {}
  ): Promise<{ allow: boolean; reason: string }> {
    const policyHash = hashPolicy(policy);
    const cacheKey = VerdictCache.key({
      orgId: "text-judge",
      policyHash,
      // VerdictCache uses `hostname` as its third component but treats it as
      // an opaque string (lowercase + join). Here we pass a sha256 of the
      // (policy, text) pair — the field name is borrowed from the egress
      // judge, not load-bearing here.
      hostname: hashTextJudgeKey(policy, text),
    });

    return this.run({
      cacheKey,
      policyHash,
      model: options.model,
      orgId: options.orgId,
      buildPrompts: () => ({
        systemPrompt: TEXT_JUDGE_SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(policy, text),
      }),
      decorate: (verdict) => ({
        allow: verdict.verdict === "allow",
        reason: verdict.reason,
      }),
    });
  }
}
