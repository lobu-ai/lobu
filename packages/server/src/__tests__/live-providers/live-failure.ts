/**
 * Semantic capacity markers independent of HTTP status.
 *
 * Deliberately stricter than core's remediation classifier: a rate-limit docs
 * URL or invalid parameter name must not suppress an integration assertion.
 * Core selects advice for an already-failed turn; this predicate skips checks.
 */
const QUOTA_SIGNALS: readonly RegExp[] = [
	/\bRESOURCE_EXHAUSTED\b/,
	/\blimit exhausted\b/i,
	/\bquota exceeded\b/i,
	/\bexceeded your current quota\b/i,
	/\binsufficient[_ ]quota\b/i,
	/\byour credit balance is too low\b/i,
	/\byou have no credits remaining\b/i,
	/\bthis request requires more credits\b/i,
	/["']type["']\s*:\s*["']rate_limit_error["']/i,
	/\brate[ -]limit(?:ed| (?:exceeded|reached))\b/i,
	/^\s*too many requests\b/i,
];

/**
 * A 429 counts only in HTTP-status position. `completeSimple` hands back the
 * provider SDK's own `Error.message`, which leads with the status (`429 <body>`,
 * `401 <body>`), so that position is the head of the string; the remaining
 * alternatives catch a status quoted inside a log line. A bare `429` also turns
 * up inside token counts (`"total_tokens":429`) and vendor error codes, so
 * matching it anywhere would classify a genuine break as mere throttling — the
 * one direction of error this module must never make.
 */
const HTTP_429 =
	/^\s*429\b|(?:returned|failed:|status(?:\s+code)?:?)\s*429\b|\bHTTP\s*429\b/i;

/**
 * True when a failed live turn is a quota/rate-limit condition rather than a
 * broken integration.
 *
 * Undefined or empty input is NOT quota: an error we cannot read is a break we
 * have not diagnosed, and defaulting to "quota" there would silently disarm
 * the whole tier.
 */
export function isCapacityFailure(message: string | undefined | null): boolean {
	if (!message) return false;
	if (HTTP_429.test(message)) return true;
	return QUOTA_SIGNALS.some((signal) => signal.test(message));
}

interface LiveOutcome {
	stopReason?: string;
}

/**
 * Run a live turn repeatedly so a transient provider failure can clear.
 *
 * Capacity classification belongs to the caller after the final attempt: a
 * generic 429 can be a short, windowed limit that succeeds on retry.
 */
export async function completeWithLiveRetry<T extends LiveOutcome>(
	attempt: () => Promise<T>,
	opts: {
		attempts: number;
		backoffMs: number;
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<T> {
	const sleep =
		opts.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let outcome = await attempt();
	for (let n = 2; n <= opts.attempts; n++) {
		if (outcome.stopReason !== "error") return outcome;
		await sleep(opts.backoffMs * (n - 1));
		outcome = await attempt();
	}
	return outcome;
}

/**
 * True when quota alone decided the keyed tier: at least one required provider
 * was capacity-skipped and no required provider ever got past that gate, so no
 * contract assertion ran and a green result would prove nothing.
 *
 * An empty `capacitySkipped` is never a quota verdict — the turns either ran
 * and their own assertions decided, or none produced an outcome at all and is
 * already red on its own test. Reporting that as a quota problem would only
 * misattribute it.
 */
export function quotaHidKeyedTier(
	capacitySkipped: ReadonlySet<string>,
	reachedContract: ReadonlySet<string>,
): boolean {
	return capacitySkipped.size > 0 && reachedContract.size === 0;
}
