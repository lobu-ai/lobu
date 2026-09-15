/**
 * Outcome taxonomy for terminal runs (evals PR 1, lobu#2564).
 *
 * `runs.status` says HOW a run ended; `runs.outcome` says whose fault it was —
 * which is the question every quality read actually asks. The July-2026 z.ai
 * quota storm was misread as a prompt regression because provider 429s and
 * genuine agent protocol violations shared the `failed` bucket.
 *
 * This is THE classifier, and its stamping scope is deliberate:
 *  - every Automation-run terminal-status writer stamps
 *    `outcome = classifyRunOutcome(...)` in the same UPDATE;
 *  - every `status = 'timeout'` writer and every poll.ts dispatch-failure
 *    writer stamps regardless of run_type — those classifications are
 *    message-independent (a timeout or a run the agent never received is
 *    infra for any run type);
 *  - connector/internal-queue/builder completed+failed writers do NOT stamp:
 *    agent_error/scoreable are agent-run concepts, and the message patterns
 *    below are tuned on Automation-run failures. Eval reads filter
 *    `run_type = 'automation'`.
 * The historical backfill (scripts/backfill-run-outcomes.ts) mirrors exactly
 * that scope by calling this exact function — never a SQL re-encoding of it.
 *
 * Classification prefers structure over string-matching:
 *  1. `completed` → scoreable; `timeout` → infra_error (every timeout class —
 *     unclaimed, heartbeat-stale, coarse TTL, SIGKILL time budget — is a
 *     platform condition, not agent evidence). A coordination-cancelled run
 *     superseded by the Automation's arrival mark is infra for the same reason.
 *  2. A known `AgentErrorCode` → infra_error. The catalog (core/errors.ts) is
 *     exclusively provider/worker/config failures today; an agent-fault code
 *     added there must be mapped here explicitly.
 *  3. Message patterns, ordered agent-protocol → infra → agent-process, with
 *     unknown failures defaulting to agent_error: fail toward VISIBILITY. An
 *     unrecognized failure shows up in the quality-relevant bucket and gets a
 *     pattern added here, rather than being silently excused as infra.
 */

import { AgentErrorCode } from "@lobu/core";

export type RunOutcome = "infra_error" | "agent_error" | "scoreable";

const KNOWN_AGENT_ERROR_CODES: ReadonlySet<string> = new Set(
	Object.values(AgentErrorCode),
);

/**
 * The agent ran its turn and violated the Automation protocol. Matches the
 * cloud finalize miss (run-completion.ts describeFinalizeMiss) and the device
 * variant (run-lifecycle.ts completeAutomationRun) — both phrase the miss as
 * "without calling".
 */
const AGENT_PROTOCOL_PATTERNS: readonly RegExp[] = [
	/without calling (?:run_sdk|completeWindow|complete_window)/i,
];

/**
 * Provider/platform/config faults. Sources, in prod-frequency order (14-day
 * corpus, 2026-08-06): provider quota 429s (2,209 of 2,651 failures), the
 * provider-error formatter shape (`url-builder.ts` labelProviderErrorBody),
 * synthesized worker texts from the AGENT_ERRORS catalog, gateway
 * session/enqueue failures, executor config, and approval walls (a headless
 * run blocked on a human approval is an environment condition, not agent
 * evidence).
 */
const INFRA_PATTERNS: readonly RegExp[] = [
	/returned an error:/i,
	/\b429\b/,
	/rate limit/i,
	/quota/i,
	/limit exhausted/i,
	/limit reached/i,
	/insufficient balance/i,
	/billing/i,
	/\b401\b/,
	/unauthorized/i,
	/authentication required/i,
	/timed? ?out/i,
	/didn't finish responding/i,
	/couldn't start/i,
	/stopped unexpectedly/i,
	/provider rejected its own tool call/i,
	/no model is configured/i,
	/remained pending/i,
	/blocked on tool approval/i,
	/no local agent executor/i,
	/worker sandbox/i,
	/failed to (?:create|resume|enqueue)/i,
];

/**
 * The `error_message` a run carries when `claim_next_window` cancels it because
 * the Automation's arrival mark moved past the range it was queued for.
 *
 * Exported because three places have to agree on it: the producer in
 * `claim-next-window.ts`, the `cancelled` branch below, and the test that pins
 * the mapping. They each held their own copy of the string until the arrival
 * cutover changed it, at which point the classifier silently started returning
 * `null` for every superseded run — neither infra nor agent evidence, just
 * absent from the taxonomy. One constant, compared by equality, removes the
 * class rather than the instance.
 */
export const SUPERSEDED_BY_ARRIVAL_MARK = "Superseded by the Automation arrival mark";

/**
 * Classify a terminal run. Returns null for non-terminal statuses and for
 * `cancelled` (a human choice — neither infra nor agent evidence).
 */
export function classifyRunOutcome(input: {
	status: string;
	errorCode?: string | null;
	errorMessage?: string | null;
}): RunOutcome | null {
	switch (input.status) {
		case "completed":
			return "scoreable";
		case "timeout":
			return "infra_error";
		case "cancelled":
			return input.errorMessage === SUPERSEDED_BY_ARRIVAL_MARK
				? "infra_error"
				: null;
		case "failed":
			break;
		default:
			return null;
	}

	if (input.errorCode && KNOWN_AGENT_ERROR_CODES.has(input.errorCode)) {
		return "infra_error";
	}

	const message = input.errorMessage ?? "";
	if (AGENT_PROTOCOL_PATTERNS.some((p) => p.test(message))) {
		return "agent_error";
	}
	if (INFRA_PATTERNS.some((p) => p.test(message))) {
		return "infra_error";
	}
	// Unknown failures (incl. agent-process crashes like "claude exited with
	// non-zero status 1") land here: fail toward visibility.
	return "agent_error";
}
