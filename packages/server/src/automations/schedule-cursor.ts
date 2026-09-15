import {
	AgentErrorCode,
	PROVIDER_BALANCE_EXHAUSTED,
	PROVIDER_WINDOWED_QUOTA,
} from "@lobu/core";
import type { DbClient } from "../db/client";
import { nextRunAt } from "../utils/cron";
import logger from "../utils/logger";
import { resetScheduledFailureState } from "./scheduled-failure-policy";

const PROVIDER_RESET_GRACE_MS = 60_000;
const PROVIDER_RETRY_GRACE_MS = 1_000;
const PROVIDER_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
const PROVIDER_RELATIVE_RESET_MAX_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Extract the reset timestamp from provider quota errors such as:
 *
 * - "Your limit will reset at 2026-07-31"
 * - "Your limit will reset at 2026-07-10 04:32:47"
 *
 * Providers frequently omit a timezone. Treat an omitted zone as UTC rather
 * than the gateway host's local time so replicas in different regions agree.
 * The one-minute grace avoids retrying at the exact reset boundary.
 */
export function parseProviderQuotaResetAt(
	message: string,
	now: Date = new Date()
): Date | null {
	const match = message.match(
		/\breset(?:s)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?(?![ T]\d{2}:)(?![0-9A-Za-z:+-]|\.\d)/i
	);
	if (!match) return null;

	const [, date, hour, minute, second, milliseconds, rawZone] = match;
	const [yearText, monthText, dayText] = date.split("-");
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hourValue = Number(hour ?? "0");
	const minuteValue = Number(minute ?? "0");
	const secondValue = Number(second ?? "0");
	const daysInMonth = [
		31,
		year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1];
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		daysInMonth === undefined ||
		day > daysInMonth ||
		hourValue < 0 ||
		hourValue > 23 ||
		minuteValue < 0 ||
		minuteValue > 59 ||
		secondValue < 0 ||
		secondValue > 59
	) {
		return null;
	}

	const normalizedZone = rawZone?.toUpperCase();
	if (normalizedZone && normalizedZone !== "Z") {
		const offsetHour = Number(normalizedZone.slice(1, 3));
		const offsetMinute = Number(normalizedZone.slice(-2));
		if (offsetHour > 23 || offsetMinute > 59) {
			return null;
		}
	}
	const zone = normalizedZone
		? normalizedZone === "Z" || normalizedZone.includes(":")
			? normalizedZone
			: `${normalizedZone.slice(0, 3)}:${normalizedZone.slice(3)}`
		: "Z";
	const timestamp =
		`${date}T${hour ?? "00"}:${minute ?? "00"}:${second ?? "00"}.` +
		`${milliseconds?.padEnd(3, "0") ?? "000"}${zone}`;
	const parsed = new Date(timestamp);
	const notBeforeMs = parsed.getTime() + PROVIDER_RESET_GRACE_MS;
	if (
		!Number.isFinite(parsed.getTime()) ||
		notBeforeMs <= now.getTime()
	) {
		return null;
	}
	return new Date(notBeforeMs);
}

/**
 * Extract an explicit short retry horizon from provider errors such as:
 *
 * - "Please try again in 25.137s"
 * - "retryDelay: 26s"
 * - "Retry-After: 30"
 * - "Retry-After: Wed, 05 Aug 2026 10:00:30 GMT"
 *
 * Retry-After accepts either delta-seconds or an HTTP date. The one-second
 * grace avoids retrying exactly on the provider boundary. Ignore implausibly
 * long values: those belong to quota-reset / balance handling instead.
 */
export function parseProviderRetryAfter(
	message: string,
	now: Date = new Date()
): Date | null {
	const unitMatch =
		message.match(
			/\b(?:please\s+)?(?:try\s+again\s+in|retry(?:[-_ ]?(?:in|after|delay))?\s*:?)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i
		) ?? null;
	const headerMatch =
		unitMatch == null
			? message.match(/\bretry[-_ ]?after\s*:\s*(\d+(?:\.\d+)?)\b/i)
			: null;
	const headerDateMatch =
		unitMatch == null && headerMatch == null
			? message.match(
					/\bretry[-_ ]?after\s*:\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)\b/i
				)
			: null;
	const match = unitMatch ?? headerMatch;
	if (!match && !headerDateMatch) return null;

	if (headerDateMatch) {
		const rawBoundary = headerDateMatch[1].replace(/\s+/g, " ");
		const boundaryMs = Date.parse(rawBoundary);
		const delayMs = boundaryMs - now.getTime();
		if (
			!Number.isFinite(boundaryMs) ||
			new Date(boundaryMs).toUTCString().toLowerCase() !==
				rawBoundary.toLowerCase() ||
			delayMs <= 0 ||
			delayMs > PROVIDER_RETRY_MAX_MS
		) {
			return null;
		}
		return new Date(boundaryMs + PROVIDER_RETRY_GRACE_MS);
	}
	if (!match) return null;

	const rawValue = Number(match[1]);
	if (!Number.isFinite(rawValue) || rawValue <= 0) return null;

	const unit = unitMatch?.[2]?.toLowerCase();
	let delayMs: number;
	if (unit === "ms" || unit?.startsWith("millisecond")) {
		delayMs = rawValue;
	} else if (unit === "m" || unit?.startsWith("min")) {
		delayMs = rawValue * 60_000;
	} else {
		delayMs = rawValue * 1_000;
	}
	if (!Number.isFinite(delayMs) || delayMs > PROVIDER_RETRY_MAX_MS) {
		return null;
	}
	return new Date(now.getTime() + delayMs + PROVIDER_RETRY_GRACE_MS);
}

/**
 * Extract a long account-window boundary such as OpenCode Go's
 * "Monthly usage limit reached. Resets in 14 days." or Codex's
 * "You have hit your ChatGPT usage limit (pro plan). Try again in ~8700 min."
 * These are not transient Retry-After delays: they exceed an Automation's
 * process budget and should park the cron cursor until the provider says the
 * account window resets.
 *
 * `parseProviderRetryAfter` also reads "try again in", but it does not admit
 * the `~` Codex puts before the number and it caps at PROVIDER_RETRY_MAX_MS (a
 * day) — 8700 min is ~6 days — so without this arm the Codex wording fell
 * through to no park at all. Minutes are accepted because callers already
 * gate on quota evidence, so the value is an account window rather than a
 * CLI's own retry advice; a short horizon parks only briefly, and
 * `advanceAutomationSchedule` never moves an existing cursor backward.
 */
function parseProviderQuotaResetIn(
	message: string,
	now: Date = new Date()
): Date | null {
	const match = message.match(
		/\b(?:reset(?:s)?|try\s+again)\s+in\s*~?\s*(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|hours?|days?|weeks?)\b/i
	);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	const unit = match[2].toLowerCase();
	const unitMs = unit.startsWith("week")
		? 7 * 24 * 60 * 60 * 1000
		: unit.startsWith("day")
			? 24 * 60 * 60 * 1000
			: unit.startsWith("hour")
				? 60 * 60 * 1000
				: 60 * 1000;
	const delayMs = value * unitMs;
	if (!Number.isFinite(delayMs) || delayMs > PROVIDER_RELATIVE_RESET_MAX_MS) {
		return null;
	}
	return new Date(now.getTime() + delayMs + PROVIDER_RESET_GRACE_MS);
}

/**
 * How long a depleted balance parks a schedule.
 *
 * A depleted balance is not a rate limit: it does not tick back on a timer, so
 * the provider has no reset to name and never will until a human tops the
 * account up. Retrying one of these on every cron tick burns a failed run per
 * tick forever — z.ai's "429 Insufficient balance or no resource package" cost
 * ~85 of them across two Automations before anyone looked.
 *
 * The wording that qualifies lives in `PROVIDER_BALANCE_EXHAUSTED` (core),
 * shared with the worker's `classifyError` — see the note there for why it is
 * not defined locally. It matches balance/billing wording only, NOT the broader
 * quota evidence set: a windowed rate limit ("too many requests", Gemini's
 * bodyless 429) DOES self-heal, often within the minute, and parking it for a
 * day would be far worse than one wasted run per tick.
 */
const PROVIDER_BALANCE_PARK_MS = 24 * 60 * 60 * 1000;

/**
 * Fallback boundary for a terminal quota error the provider did not date.
 *
 * Deliberately a fixed park rather than an escalating backoff: the recovery
 * signal is a human adding funds, which no amount of waiting predicts, and a
 * growing park would need durable per-provider attempt state to compute. A flat
 * day bounds the waste at one run instead of one per tick, and a manual trigger
 * still runs immediately because parking only moves the cron cursor.
 */
function balanceExhaustedNotBefore(message: string, now: Date): Date | null {
	// A provider-named retry horizon ("Please retry in 26s", `retryDelay`, a
	// quoted `Retry-After:` header) means the limit is windowed, not a balance —
	// Gemini attaches one to its per-minute free-tier 429s while reusing
	// OpenAI's billing wording ("exceeded your current quota"). Never day-park
	// those. The separator class covers every spelling of the header because a
	// missed horizon costs a wrong day-park, while a spurious one costs only the
	// pre-existing one-run-per-tick.
	if (/\bretry[-_ ]?(?:in|after|delay)\b/i.test(message)) return null;
	return PROVIDER_BALANCE_EXHAUSTED.test(message)
		? new Date(now.getTime() + PROVIDER_BALANCE_PARK_MS)
		: null;
}

/**
 * Resolve a provider reset boundary for a terminal error.
 *
 * Structured worker/API paths must explicitly classify the error as quota
 * exhaustion; this prevents an unrelated provider sentence containing
 * "reset at" from moving a schedule.
 *
 * A named reset always wins — it is the provider's own answer. Only when there
 * is none do we fall back to the balance-exhaustion park.
 */
export function providerQuotaResetNotBefore(
	message: string,
	errorCode?: string,
	now: Date = new Date()
): Date | null {
	if (errorCode !== AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED) {
		return null;
	}
	return (
		parseProviderQuotaResetAt(message, now) ??
		parseProviderRetryAfter(message, now) ??
		balanceExhaustedNotBefore(message, now)
	);
}

/**
 * Device CLI reports do not carry a structured error code, so require
 * provider-quota wording before moving a durable schedule, plus either a
 * provider-named boundary (a reset timestamp, a retry horizon, or a relative
 * reset) or balance-exhaustion wording. This prevents unrelated stderr such as
 * "session resets at ..." from parking an Automation.
 */
export function deviceProviderQuotaResetNotBefore(
	message: string,
	now: Date = new Date()
): Date | null {
	// Balance wording is quota evidence by definition; composing the matchers
	// keeps them in lockstep so a new balance alternate cannot silently fail to
	// park on this path.
	// The qualifier is `usage`, not `reached`: OpenCode Go reports an account
	// window as "Monthly usage limit reached" and Codex on a ChatGPT plan as
	// "usage limit (pro plan)", while a CLI's own "context limit reached" /
	// "session limit reached" / "tool call limit reached" are not provider quota
	// and must not park a durable schedule — the same hazard the doc comment
	// above names for "session resets at ...". Matching `usage limit` rather
	// than the full `usage limit reached` admits the subscription wording
	// without admitting any of those, since none of them is about usage.
	const hasQuotaEvidence =
		PROVIDER_BALANCE_EXHAUSTED.test(message) ||
		PROVIDER_WINDOWED_QUOTA.test(message);
	if (!hasQuotaEvidence) return null;
	return (
		parseProviderQuotaResetAt(message, now) ??
		parseProviderRetryAfter(message, now) ??
		parseProviderQuotaResetIn(message, now) ??
		balanceExhaustedNotBefore(message, now)
	);
}

/**
 * Move an automation's `next_run_at` forward without shortening its current park.
 *
 * The target is `nextRunAt(schedule, now)` unless a scheduled failure supplies
 * an earlier transient retry boundary or any caller supplies a later
 * `notBefore` boundary. The write never moves an existing cursor backward, so
 * overlapping completions cannot erase a quota park.
 * (Basing it on `max(now, next_run_at)` instead compounded the schedule: each
 * manual trigger's completion pushed an already-future `next_run_at` one more
 * tick out, so N manual runs silently skipped N cron slots.)
 *
 * Pass either the singleton `sql` client or a transaction handle from
 * `sql.begin(...)` to advance inside the caller's transaction. Schedule-less
 * automations (manual-only) are no-ops.
 *
 * Errors are split by whether a retry could ever succeed, because the callers
 * are terminal state transitions inside a transaction:
 *
 * - **Database errors propagate.** They are transient, so the caller SHOULD roll
 *   back its run-failure/completion and let the next tick retry.
 * - **An unparseable cron/timezone does NOT propagate.** It is permanent, so
 *   throwing would roll the caller back forever. Worse, `dispatchAutomationRun`
 *   calls `failAutomationRun` from inside its own `catch`, and
 *   `dispatchPendingAutomationRuns` has no per-run guard — a throw there escapes
 *   both and aborts the dispatch tick for EVERY org, permanently, since the
 *   rolled-back run is re-claimed next tick. Park the Automation instead: NULL
 *   drops out of the `next_run_at <= now()` due predicate, so it stops
 *   re-selecting until someone fixes the schedule.
 */
export async function advanceAutomationSchedule(
	sql: DbClient,
	automationId: number | null | undefined,
	notBefore?: Date | null,
	allowBeforeNextTick = false
): Promise<void> {
	if (automationId == null) return;
	const rows = await sql`
    SELECT schedule, timezone, schedule_auto_paused_at
    FROM automations
    WHERE id = ${automationId}
    LIMIT 1
  `;
	const schedule = (rows[0]?.schedule as string | null) ?? null;
	const timezone = (rows[0]?.timezone as string | null) ?? null;
	const autoPausedAt = rows[0]?.schedule_auto_paused_at ?? null;
	if (autoPausedAt != null) return;
	if (!schedule) return;

	// `nextRunAt` returns an ISO string, not a Date.
	let nextTick: string;
	try {
		nextTick = nextRunAt(schedule, new Date(), timezone);
	} catch (error) {
		logger.error(
			{ error, automationId, schedule, timezone },
			"[automations] Automation schedule is unparseable — parking it (next_run_at = NULL). " +
				"It will not run again until the schedule or timezone is corrected."
		);
		await sql`
      UPDATE automations
      SET next_run_at = NULL,
          updated_at = NOW()
      WHERE id = ${automationId}
        AND schedule_auto_paused_at IS NULL
    `;
		return;
	}

	const notBeforeMs = notBefore?.getTime();
	const target =
		typeof notBeforeMs === "number" &&
		Number.isFinite(notBeforeMs) &&
		(allowBeforeNextTick || notBeforeMs > new Date(nextTick).getTime())
			? new Date(notBeforeMs).toISOString()
			: nextTick;

	await sql`
    UPDATE automations
    SET next_run_at = GREATEST(next_run_at, ${target}::timestamptz),
        updated_at = NOW()
    WHERE id = ${automationId}
      AND schedule_auto_paused_at IS NULL
  `;
}

/**
 * A completed window clears the failure streak and moves the cron cursor to
 * the next tick. There is no catch-up loop: one arrival window covers however
 * long a device was offline, so the next tick already reads everything since.
 */
export async function advanceAutomationScheduleAfterSuccessfulWindow(
	sql: DbClient,
	automationId: number
): Promise<void> {
	await resetScheduledFailureState(sql, automationId);
	await advanceAutomationSchedule(sql, automationId);
}

/**
 * Advance after terminal failure unless the run came from an event with no
 * explicit retry boundary. Ordinary event delivery is independent of the cron
 * cursor, but a provider quota boundary must park any scheduled activation too.
 * Call inside the caller's terminal-state transaction. Run-backed failures and
 * reply-to-source turns share this policy so their event carve-out cannot drift.
 */
export async function advanceScheduleAfterTerminalFailure(
	sql: DbClient,
	automationId: number | null | undefined,
	dispatchSource: string | null | undefined,
	notBefore?: Date | null
): Promise<void> {
	if (dispatchSource === "event" && notBefore == null) return;
	const scheduledDispatch =
		dispatchSource == null || dispatchSource === "scheduled";
	await advanceAutomationSchedule(
		sql,
		automationId,
		notBefore,
		scheduledDispatch && notBefore != null
	);
}
