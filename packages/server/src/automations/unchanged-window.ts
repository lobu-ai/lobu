import type { DbClient } from "../db/client";
import { classifyRunOutcome } from "../runs/run-outcome";
import { fingerprintAutomationSources } from "../tools/get_content/automation-mode";
import { advanceAutomationArrivalMark } from "../utils/window-utils";

export interface UnchangedWindowState {
	/** Fingerprint to persist on the run so the next window compares against it. */
	sourceFingerprint: string | undefined;
	/** Every source returned zero rows for the window. */
	empty: boolean;
	/** The window carries nothing new: empty, or identical to the last completed run. */
	unchanged: boolean;
}

function scheduleSkipsUnchanged(
	triggers: ReadonlyArray<Record<string, unknown>> | null | undefined,
): boolean {
	const schedule = triggers?.find((trigger) => trigger.kind === "schedule");
	return schedule?.skip_if_unchanged === true;
}

/**
 * Decide whether a due arrival window needs an agent at all. Returns null
 * when the schedule trigger does not opt in to `skip_if_unchanged`. Every
 * lane that books a scheduled window (native materializer, external claim)
 * consults this one function so the flag means the same thing everywhere.
 */
export async function inspectUnchangedWindow(
	sql: DbClient,
	automation: { id: number; triggers?: ReadonlyArray<Record<string, unknown>> | null },
	window: { windowStart: Date; windowEnd: Date },
): Promise<UnchangedWindowState | null> {
	if (!scheduleSkipsUnchanged(automation.triggers)) return null;
	const sourceState = await fingerprintAutomationSources({
		sql,
		automationId: automation.id,
		windowStart: window.windowStart.toISOString(),
		windowEnd: window.windowEnd.toISOString(),
	});
	const previous = await sql<{ fingerprint: string | null }>`
		SELECT approved_input->>'source_fingerprint' AS fingerprint
		FROM runs
		WHERE automation_id = ${automation.id}
		  AND run_type = 'automation'
		  AND status = 'completed'
		  AND approved_input->>'source_fingerprint' IS NOT NULL
		ORDER BY completed_at DESC NULLS LAST, id DESC
		LIMIT 1
	`;
	return {
		sourceFingerprint: sourceState.fingerprint,
		empty: sourceState.empty,
		unchanged:
			sourceState.empty ||
			(sourceState.fingerprint !== undefined &&
				previous[0]?.fingerprint === sourceState.fingerprint),
	};
}

/**
 * Finish a pending run as a no-op and book its window. The caller holds the
 * Automation row lock inside its own transaction. Returns false when the run
 * was no longer pending (a concurrent dispatch owns it).
 */
export async function completeSkippedAutomationRun(
	tx: DbClient,
	automationId: number,
	windowStart: Date,
	windowEnd: Date,
	runId: number,
): Promise<boolean> {
	// A server-side skip has no child stdout. Preserve the historical `{}`
	// action_output for consumers, while output_tail makes the terminal no-op
	// intentional to humans and run_metadata remains the machine-readable signal.
	const [completed] = await tx`
		UPDATE runs
		SET status = 'completed',
		    outcome = ${classifyRunOutcome({ status: "completed" })},
		    action_output = '{}'::jsonb,
		    output_tail = 'No-op: scheduled source content is unchanged.',
		    run_metadata = COALESCE(run_metadata, '{}'::jsonb)
		      || '{"content_analyzed":0,"skipped_unchanged":true}'::jsonb,
		    completed_at = current_timestamp
		WHERE id = ${runId}
		  AND automation_id = ${automationId}
		  AND status = 'pending'
		RETURNING id
	`;
	if (!completed) return false;
	// An unchanged window is still arrival progress: the mark moves so the
	// next tick fingerprints what arrives next instead of the same range.
	await advanceAutomationArrivalMark(tx, automationId, windowStart, windowEnd);
	return true;
}
