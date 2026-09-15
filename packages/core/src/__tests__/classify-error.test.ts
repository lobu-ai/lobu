/**
 * Regression coverage for the failure classifier, recovered with the
 * implementation when the managed-subprocess package was deleted.
 *
 * Every case here is named for the incident that produced it: a credit
 * balance 400 that surfaced as a raw crash blob, the balance phrasings that
 * once lived only in the schedule parker, Gemini's MALFORMED_FUNCTION_CALL,
 * and "No model resolved" going unclassified. They are the reason the
 * patterns are this specific, so they travel with it.
 *
 * `handleExecutionError`'s cases are deliberately NOT ported: that half was
 * the subprocess transport's error path and went with the lane.
 */

import { describe, expect, test } from "bun:test";
import {
  AGENT_ERRORS,
  AgentErrorCode,
  classifyError,
  classifyErrorMessage,
  PROVIDER_BALANCE_EXHAUSTED,
} from "../index";

describe("classifyError", () => {
  test("recognizes provider auth failures", () => {
    expect(classifyError(new Error("Authentication failed for openai"))).toBe(
      "PROVIDER_AUTH"
    );
    expect(classifyError(new Error("incorrect api key provided"))).toBe(
      "PROVIDER_AUTH"
    );
    // The secret-proxy's every-tier-missed 401 (live red-test LOBU-BACKEND-W
    // landed as `unclassified` and dodged the PROVIDER_* alert).
    expect(
      classifyError(
        new Error(
          "401 No provider credentials configured. End-user provider setup is not available in chat yet."
        )
      )
    ).toBe("PROVIDER_AUTH");
    // Seen live on Telegram after connecting Claude via subscription OAuth:
    // Anthropic 403s the inference call for orgs that disallow OAuth. The
    // auth-hint regex misses it (no "api key"/"authentication failed" wording),
    // so it surfaced as a raw `Worker crashed: 403 {...}` blob with no CTA —
    // the credential IS the problem, so it belongs in the auth class.
    expect(
      classifyError(
        new Error(
          '403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_code":"oauth_not_allowed_for_organization"}},"request_id":"req_011CdVRTidLfu6D81Mjz76wh"}'
        )
      )
    ).toBe("PROVIDER_AUTH");
    // The generic shape, not just the one vendor string we happened to see.
    expect(
      classifyError(new Error('403 {"error":{"type":"permission_error"}}'))
    ).toBe("PROVIDER_AUTH");
  });

  test("recognizes unknown-model failures", () => {
    expect(
      classifyError(
        new Error('Model "x" not found for provider "openai". Check ...')
      )
    ).toBe("PROVIDER_UNKNOWN_MODEL");
    expect(
      classifyError(new Error("400 gpt-foo is not a valid model ID"))
    ).toBe("PROVIDER_UNKNOWN_MODEL");
  });

  test("recognizes unresolved provider base URL", () => {
    expect(
      classifyError(
        new Error('Could not resolve a base URL for provider "z-ai".')
      )
    ).toBe("PROVIDER_BASE_URL_UNRESOLVED");
    expect(
      classifyError(
        new Error(
          'The selected model (z-ai/glm-5.2) uses provider "z-ai", but that provider is not connected to this agent.'
        )
      )
    ).toBe("PROVIDER_BASE_URL_UNRESOLVED");
  });

  test("recognizes provider quota / rate-limit exhaustion", () => {
    expect(
      classifyError(
        new Error(
          "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-10 04:32:47"
        )
      )
    ).toBe("PROVIDER_QUOTA_EXHAUSTED");
    expect(classifyError(new Error("429 Too Many Requests"))).toBe(
      "PROVIDER_QUOTA_EXHAUSTED"
    );
    expect(classifyError(new Error("rate limit exceeded"))).toBe(
      "PROVIDER_QUOTA_EXHAUSTED"
    );
    expect(classifyError(new Error("RESOURCE_EXHAUSTED: quota"))).toBe(
      "PROVIDER_QUOTA_EXHAUSTED"
    );
  });

  test("leaves unrelated crashes unclassified", () => {
    expect(classifyError(new Error("kaboom"))).toBeUndefined();
    expect(classifyError("not an error")).toBeUndefined();
  });

  test("recognizes a credit/billing-exhausted 400 as quota, not a raw crash", () => {
    // Observed live: the Anthropic key was present but out of credits. This is
    // a BILLING-class failure, functionally identical to quota exhaustion, but
    // it carries no "quota"/"rate limit"/429 token so it fell through to
    // `undefined` → a raw `💥 Worker crashed: 400 {…}` blob in the user's chat.
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
    expect(classifyError(new Error(raw))).toBe("PROVIDER_QUOTA_EXHAUSTED");

    // Sibling phrasings from other providers.
    expect(
      classifyError(new Error("402 Payment Required: insufficient credits"))
    ).toBe("PROVIDER_QUOTA_EXHAUSTED");
    expect(
      classifyError(new Error("Your account has insufficient balance."))
    ).toBe("PROVIDER_QUOTA_EXHAUSTED");
    expect(classifyError(new Error("billing_hard_limit_reached"))).toBe(
      "PROVIDER_QUOTA_EXHAUSTED"
    );
  });

  test("recognizes the balance phrasings that previously lived only in the schedule parker's list", () => {
    // Captured verbatim from prod 2026-08-05 (org `buremba`, provider `openai`,
    // agent routed to openai/gpt-4o-mini): the worker logged a bare
    // `{"name":"Error","message":"You have no credits remaining…"}` because no
    // pre-split worker pattern matched this sentence. `undefined` here is not a
    // cosmetic miss — it silently disables the downstream feature that gates on
    // the code: `providerQuotaResetNotBefore` (24h Automation park). The provider
    // health row no longer depends on this classification — the proxy marks it
    // from the upstream HTTP status (`classifyProviderHealthStatus`). The parker
    // shipped believing this message classified.
    expect(
      classifyError(
        new Error(
          "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/."
        )
      )
    ).toBe("PROVIDER_QUOTA_EXHAUSTED");

    // z.ai's balance wording, likewise only in the server-side list until now.
    expect(
      classifyError(
        new Error("No resource package or the balance is insufficient")
      )
    ).toBe("PROVIDER_QUOTA_EXHAUSTED");
  });

  test("recognizes Gemini MALFORMED_FUNCTION_CALL as a provider tool-call failure", () => {
    expect(
      classifyError(
        new Error(
          "Provider finish_reason: function_call_filter: MALFORMED_FUNCTION_CALL"
        )
      )
    ).toBe("PROVIDER_TOOL_CALL_FAILED");
    expect(
      classifyError(new Error("Provider finish_reason: content_filter"))
    ).toBeUndefined();
    expect(
      classifyError(new Error("Provider finish_reason: length"))
    ).toBeUndefined();
  });

  test("SESSION_TIMEOUT and NO_MODEL_CONFIGURED still classify", () => {
    expect(classifyError(new Error("SESSION_TIMEOUT"))).toBe("SESSION_TIMEOUT");
    expect(classifyError(new Error("No model configured"))).toBe(
      "NO_MODEL_CONFIGURED"
    );
  });

  test("model-resolver's 'No model resolved' now classifies (was unclassified)", () => {
    // model-resolver.ts throws this when no default/per-automation/org model is
    // set. It previously fell through to `undefined` → raw crash delta + dodged
    // the PROVIDER_* Sentry alert. Now it renders the actionable catalog line.
    expect(
      classifyError(
        new Error(
          "No model resolved for this run. Set the agent's default model, a per-automation model, or an org default inference provider."
        )
      )
    ).toBe("NO_MODEL_CONFIGURED");
  });
});

describe("classifyErrorMessage", () => {
  test("classifies a bare string, which is what the wire delivers", () => {
    // The turn-completion route holds `body.error` as a string. Routing it
    // through the `unknown` overload would hit its `instanceof Error` guard
    // and classify nothing — the defect this split exists to prevent.
    expect(classifyErrorMessage("429 rate limit exceeded")).toBe(
      AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED
    );
    expect(classifyError("429 rate limit exceeded")).toBeUndefined();
  });

  test("agrees with the Error overload on the same message", () => {
    const message = "invalid x-api-key";
    expect(classifyErrorMessage(message)).toBe(
      classifyError(new Error(message))
    );
  });
});

describe("isolate host wall-clock timeout", () => {
  test("classifies as WORKER_UNRESPONSIVE, and NOT the silent SESSION_TIMEOUT", () => {
    // `IsolateHost` terminates a runaway turn with this exact text. It used to
    // classify as nothing, so the user got a raw internal string.
    const code = classifyErrorMessage("wall-clock budget of 600000ms exceeded");
    expect(code).toBe(AgentErrorCode.WORKER_UNRESPONSIVE);
    // The distinction is the point: SESSION_TIMEOUT is `silent` because the
    // old lane's queue retried it. Nothing retries the host kill, so silencing
    // it would leave the user with no answer and no reason.
    expect(AGENT_ERRORS[AgentErrorCode.SESSION_TIMEOUT].silent).toBe(true);
    expect(AGENT_ERRORS[code!].silent).toBeUndefined();
    expect(AGENT_ERRORS[code!].message).toBeTruthy();
  });

  test("the literal SESSION_TIMEOUT sentinel still wins its own branch", () => {
    expect(classifyErrorMessage("SESSION_TIMEOUT")).toBe(
      AgentErrorCode.SESSION_TIMEOUT
    );
  });

  test("classifies a hostile-length message in linear time", () => {
    // The unknown-model branch used a greedy `.*` between two literals, which
    // backtracks polynomially: 16k repetitions of "model " took ~1s, and this
    // text arrives from an upstream provider whose length is not ours to
    // trust. Asserted as a budget rather than a ratio so it fails on the
    // quadratic shape returning without pinning machine speed.
    const hostile = "model ".repeat(16_000);
    const started = performance.now();
    expect(classifyErrorMessage(hostile)).not.toBe(
      AgentErrorCode.PROVIDER_UNKNOWN_MODEL
    );
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("still classifies the real unknown-model messages, quoted ids included", () => {
    for (const message of [
      "400 gpt-foo is not a valid model ID",
      "unknown model: claude-x",
      'Model "claude-opus-4-8" not found for provider claude',
      // A quoted id containing a space must survive the bounded run.
      'Model "some model name" not found for provider claude',
    ]) {
      expect(classifyErrorMessage(message), message).toBe(
        AgentErrorCode.PROVIDER_UNKNOWN_MODEL
      );
    }
  });
});

describe("provider refusals prod was recording as the agent's fault", () => {
  test("classifies the provider refusals prod was blaming on the agent", () => {
    // Every case below is a verbatim prod `runs.error_message` from the 30
    // days to 2026-09-15, when each landed unclassified: no remediation CTA
    // for the user, no PROVIDER_* alert, and `outcome = agent_error` on a run
    // the provider had refused.

    // ChatGPT subscription limit — the single largest unclassified class, 47
    // of the 52. Reaches us three ways: direct, and relayed through a codex or
    // opencode crash tail, which is why the plain phrase has to match and not
    // an anchored shape.
    for (const message of [
      "You have hit your ChatGPT usage limit (pro plan). Try again in ~8700 minutes.",
      "codex exited with status 1: ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 7th, 2026 3:26 AM.",
      'opencode exited with status 1: error="The usage limit has been reached" stack="AI_APICallError: The usage limit has been reached"',
    ]) {
      expect(classifyErrorMessage(message), message).toBe(
        AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED
      );
    }

    // A windowed subscription limit must NOT reach the balance union, which
    // parks an Automation for a flat day; this one names its own reset.
    expect(
      PROVIDER_BALANCE_EXHAUSTED.test(
        "You have hit your ChatGPT usage limit (pro plan). Try again in ~8700 minutes."
      )
    ).toBe(false);

    // The account is not entitled to this model. The credential is valid and
    // other models still work, so the remediation is "Choose model", not
    // "Reconnect provider".
    expect(
      classifyErrorMessage(
        "403 Access to model denied. Please make sure you are eligible for using the model."
      )
    ).toBe(AgentErrorCode.PROVIDER_UNKNOWN_MODEL);
  });

  test("classifies a model that cannot serve the request as a model problem", () => {
    // Reproduced live on 2026-09-15 by pointing a hosted agent at
    // `openai/o1-pro` and `openrouter/openai/o1-pro`: both turns failed, and
    // both were charged to the agent. Nothing about the agent was wrong — the
    // chosen model cannot serve chat completions / tool use, and the fix is to
    // pick another model, which is exactly this code's CTA.
    for (const message of [
      "404 This model is only supported in v1/responses and not in v1/chat/completions.",
      '404 No endpoints found that support tool use. Try disabling "search_memory".',
    ]) {
      expect(classifyErrorMessage(message), message).toBe(
        AgentErrorCode.PROVIDER_UNKNOWN_MODEL
      );
    }
  });

  test("classifies the isolate executor timeout, in both spellings", () => {
    // The executor's budget kill is a separate path from the host wall-clock
    // kill and went unclassified, so a wedged turn rendered as a raw
    // "...timed out after 600000ms". Workers deploy on their own cadence and
    // the server classifies whatever text the worker sent, so the pre-rename
    // "Feed execution" spelling must keep classifying too.
    for (const message of [
      "Execution timed out after 600000ms",
      "Feed execution timed out after 600000ms",
    ]) {
      expect(classifyErrorMessage(message), message).toBe(
        AgentErrorCode.WORKER_UNRESPONSIVE
      );
    }
  });
});
