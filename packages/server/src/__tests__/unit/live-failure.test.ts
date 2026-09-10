import { describe, expect, test } from "bun:test";
import {
	completeWithLiveRetry,
	isCapacityFailure,
	quotaHidKeyedTier,
} from "../live-providers/live-failure";

/**
 * `completeSimple` reports the provider SDK's own `Error.message`, which leads
 * with the HTTP status (`429 <body>`, `401 <body>`) and carries no test-side
 * prefix. Fixtures use that shape, since it is the only input the live smoke
 * ever passes to `isCapacityFailure`.
 */
const GEMINI_FREE_TIER_429 =
	'429 [{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-2.5-pro","status":"RESOURCE_EXHAUSTED"}}]';

const ZAI_WEEKLY_429 =
	'429 {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-10 04:32:47"}}';

const CLAUDE_OAUTH_403 =
	'403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_code":"oauth_not_allowed_for_organization"}}}';

const GEMINI_BODILESS_404 = "404 status code (no body)";

describe("isCapacityFailure", () => {
	describe("classifies a real operating condition as quota", () => {
		const quota: ReadonlyArray<[string, string]> = [
			["gemini free-tier exhaustion", GEMINI_FREE_TIER_429],
			["z.ai weekly limit", ZAI_WEEKLY_429],
			[
				// Byte-identical to `QUOTA_BODY` in scripts/sdk-e2e/mock-openai.mjs,
				// which pins z.ai's real production body.
				"z.ai body as the repo already pins it",
				"429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-10 04:32:47",
			],
			["429 quoted inside a log line", "x chat returned 429: slow down"],
			["SDK 429 without quota prose", '429 {"error":{"message":"Too many concurrent requests"}}'],
			// The rest carry no 429 in HTTP-status position, keeping each semantic
			// signal independently covered.
			["bare RESOURCE_EXHAUSTED status", '{"status":"RESOURCE_EXHAUSTED"}'],
			["weekly limit prose with no status", '{"message":"Weekly/Monthly Limit Exhausted"}'],
			[
				"Google metric exhaustion without a status line",
				"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0",
			],
			[
				"OpenAI billing prose without a status line",
				"You exceeded your current quota, please check your plan and billing details.",
			],
			[
				"Anthropic exhausted credit balance",
				'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
			],
			[
				"OpenAI exhausted credits",
				"You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
			],
			["OpenAI insufficient_quota", '{"code":"insufficient_quota"}'],
			["plain rate limit prose", "rate limited, retry later"],
			["rate_limit_error token", '{"type":"rate_limit_error"}'],
			["too many requests prose", "Too Many Requests"],
		];
		for (const [label, message] of quota) {
			test(label, () => {
				expect(isCapacityFailure(message)).toBe(true);
			});
		}
	});

	describe("classifies a real break as NOT quota", () => {
		const breaks: ReadonlyArray<[string, string]> = [
			["claude OAuth 403", CLAUDE_OAUTH_403],
			["bodiless 404", GEMINI_BODILESS_404],
			["400 invalid request", '400 {"error":{"code":"invalid_request_error"}}'],
			["401 bad credential", "401 Incorrect API key provided: sk-not-a***robe"],
			["500 upstream error", "500 internal server error"],
			["unparseable provider error", "unknown provider error"],
		];
		for (const [label, message] of breaks) {
			test(label, () => {
				expect(isCapacityFailure(message)).toBe(false);
			});
		}
	});

	describe("never mistakes an incidental number for throttling", () => {
		// The one direction this must never get wrong: reading a genuine break
		// as mere quota silently disarms the tier for that provider.
		const notQuota: ReadonlyArray<[string, string]> = [
			["429 inside a token count", '400 {"usage":{"total_tokens":429}}'],
			["429 inside a request id", "400 req_0429ab"],
			["429 as a vendor error code", '400 {"vendor_code":1429}'],
			["429 in a structured provider code", '400 {"error":{"code":429}}'],
			["rate_limit in an invalid parameter name", "400 invalid rate_limit option"],
		];
		for (const [label, message] of notQuota) {
			test(label, () => {
				expect(isCapacityFailure(message)).toBe(false);
			});
		}
	});

	test("an unreadable failure is a break, not quota", () => {
		expect(isCapacityFailure(undefined)).toBe(false);
		expect(isCapacityFailure(null)).toBe(false);
		expect(isCapacityFailure("")).toBe(false);
	});
});

describe("completeWithLiveRetry", () => {
	const ok = { stopReason: "stop" as const };
	const err = (errorMessage: string) => ({
		stopReason: "error" as const,
		errorMessage,
	});
	/** Records the backoffs so the schedule itself is asserted, not just the count. */
	function harness(outcomes: Array<{ stopReason: string; errorMessage?: string }>) {
		const slept: number[] = [];
		let calls = 0;
		const attempt = async () => {
			calls++;
			return outcomes[Math.min(calls - 1, outcomes.length - 1)];
		};
		return {
			slept,
			run: () =>
				completeWithLiveRetry(attempt, {
					attempts: 3,
					backoffMs: 10,
					sleep: async (ms) => {
						slept.push(ms);
					},
				}),
			calls: () => calls,
		};
	}

	test("a success is returned without retrying", async () => {
		const h = harness([ok]);
		expect((await h.run()).stopReason).toBe("stop");
		expect(h.calls()).toBe(1);
		expect(h.slept).toEqual([]);
	});

	test("a transient failure clears on retry", async () => {
		const h = harness([err(GEMINI_BODILESS_404), ok]);
		const outcome = await h.run();
		expect(outcome.stopReason).toBe("stop");
		expect(h.calls()).toBe(2);
	});

	test("a transient rate limit can clear on retry", async () => {
		const h = harness([err("429 Too Many Requests"), ok]);
		expect((await h.run()).stopReason).toBe("stop");
		expect(h.calls()).toBe(2);
	});

	test("a persistent break exhausts every attempt and still fails", async () => {
		const h = harness([err("401 invalid x-api-key")]);
		const outcome = await h.run();
		expect(outcome.stopReason).toBe("error");
		expect(h.calls()).toBe(3);
		// Backoff grows, so a flapping upstream is not hammered.
		expect(h.slept).toEqual([10, 20]);
	});

	test("persistent quota is returned after the retry budget", async () => {
		const h = harness([err("429 Weekly/Monthly Limit Exhausted")]);
		const outcome = await h.run();
		expect(outcome.stopReason).toBe("error");
		expect(h.calls()).toBe(3);
		expect(h.slept).toEqual([10, 20]);
	});

	test("a failure that only clears on the last attempt still passes", async () => {
		const h = harness([err("boom"), err("boom"), ok]);
		expect((await h.run()).stopReason).toBe("stop");
		expect(h.calls()).toBe(3);
	});
});

describe("quotaHidKeyedTier", () => {
	const set = (...ids: string[]) => new Set(ids);

	test("quota alone decided the tier when every required provider was skipped", () => {
		expect(quotaHidKeyedTier(set("gemini"), set())).toBe(true);
		expect(quotaHidKeyedTier(set("gemini", "claude"), set())).toBe(true);
	});

	test("one required provider reaching its contract clears the tier", () => {
		expect(quotaHidKeyedTier(set("gemini"), set("claude"))).toBe(false);
	});

	test("a provider skipped on one turn and exercised on another clears it", () => {
		expect(quotaHidKeyedTier(set("gemini"), set("gemini"))).toBe(false);
	});

	// A run with nothing capacity-skipped is never a quota verdict: the turns
	// either ran and their own assertions decided, or they are already red.
	test("no capacity skip is never reported as a quota problem", () => {
		expect(quotaHidKeyedTier(set(), set())).toBe(false);
		expect(quotaHidKeyedTier(set(), set("gemini"))).toBe(false);
	});
});
