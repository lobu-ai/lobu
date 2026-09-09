import type { DbClient } from "../db/client";
import { getDb, pgTextArray } from "../db/client";
import { listPendingToolsForRun } from "../gateway/auth/mcp/pending-tool-store";
import { classifyRunOutcome } from "../runs/run-outcome";
import logger from "../utils/logger";
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from "../utils/run-statuses";
import {
	advanceScheduleAfterTerminalFailure,
	providerQuotaResetNotBefore,
} from "./schedule-cursor";
import { recordScheduledExecutionFailure } from "./scheduled-failure-policy";
import {
	AUTOMATION_EVAL_RUN_TYPE,
	AUTOMATION_RUN_TYPE,
	AUTOMATION_RUN_TYPES_PG,
} from "../runs/run-types.js";
import { runLeaseFence } from "../runs/run-lease";

type AutomationTerminalResult =
	| { ok: true }
	| {
			ok: false;
			error: string;
			errorCode?: string;
			/** Raw provider text used only to parse a quota reset boundary. */
			quotaResetError?: string;
		};

/**
 * How many times an automation run that finished its agent turn WITHOUT calling
 * `complete_window` is re-dispatched before being marked failed. The agent
 * read its inputs and replied but skipped the finalize tool call — a soft,
 * usually-non-deterministic miss (the model "forgot" the closing step). A
 * bounded re-dispatch gives it a fresh turn to finalize. Default 1 (one extra
 * attempt); 0 disables. Each re-dispatch is a full agent turn, so keep it low.
 *
 * NOTE: this is a re-dispatch (a fresh session via the existing dispatch loop),
 * not a warm in-session nudge — the turn runtime is platform-agnostic and has
 * no notion of automations/complete_window, so a worker-side self-nudge would
 * break that isolation. This constant is the GLOBAL default; an automation can
 * override it via execution_config.finalize_nudges (see
 * resolveFinalizeNudgeBudget). A declarative defineAutomation surface for it is
 * the remaining follow-up (the CLI doesn't expose execution_config yet).
 */
const MAX_FINALIZE_NUDGES: number = (() => {
	const raw = process.env.LOBU_AUTOMATION_FINALIZE_NUDGES;
	if (raw === undefined) return 1;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.min(5, Math.floor(n)) : 1;
})();

/**
 * Finalize-nudge budget for a run: the automation's per-automation override
 * (execution_config.finalize_nudges, 0-5) when set, else the global default.
 * Clamped defensively in case a raw DB value sits outside the schema's range.
 *
 * Shared by the cloud dispatch path and the device `complete-automation` exit
 * report so both honor the same per-Automation / global budget.
 */
export function resolveFinalizeNudgeBudget(
	executionConfig: Record<string, unknown> | null | undefined
): number {
	const override = executionConfig?.finalize_nudges;
	if (typeof override === "number" && Number.isFinite(override)) {
		return Math.min(5, Math.max(0, Math.floor(override)));
	}
	return MAX_FINALIZE_NUDGES;
}

/**
 * Device-held finalize retry: keep the run `running` under the same claim and
 * bump `approved_input.finalize_nudge_count` so the Mac app can re-spawn the
 * local CLI with a nudge. Unlike {@link requeueAutomationRunForFinalizeNudge}
 * (cloud: release claim → pending), this does not clear `claimed_by`.
 *
 * Returns false when the row is no longer `running` under this worker's claim,
 * or when the stored count already moved past the caller's read. The count
 * predicate is a compare-and-swap: two duplicate exit reports (a Mac retry
 * after a timed-out response) both read the same `finalize_nudge_count` and
 * both pass the caller's `attemptsSoFar < budget` check, so without it both
 * would be granted a resume and the run would get one more spawn than the
 * budget allows. Callers derive `nextNudgeCount` as read + 1, so
 * `nextNudgeCount - 1` is the expected prior value. The count is only ever
 * written with `to_jsonb(int)`, so the cast is safe.
 */
export async function bumpDeviceFinalizeNudge(
	sql: DbClient,
	runId: number,
	workerId: string,
	nextNudgeCount: number,
	outputTail: string | null
): Promise<boolean> {
	const rows = (await sql`
    UPDATE runs
    SET approved_input = jsonb_set(
          COALESCE(approved_input, '{}'::jsonb),
          '{finalize_nudge_count}',
          to_jsonb(${nextNudgeCount}::int)
        ),
        output_tail = ${outputTail},
        error_message = ${`Device CLI attempt ${nextNudgeCount}: completeWindow not called — resume allowed`}
    WHERE id = ${runId}
      ${runLeaseFence(sql, workerId)}
      AND COALESCE((approved_input->>'finalize_nudge_count')::int, 0)
          = ${nextNudgeCount - 1}
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	return rows.length > 0;
}

/**
 * Mark an Automation run completed, recording who executed it when the caller
 * knows.
 *
 * `complete_window` used to default `runs.model_used` to the literal
 * 'external-client' whenever its caller omitted `model`, and the platform's own
 * Lobu agent omits it — so server-dispatched runs were labelled as though an
 * outside MCP client had executed them. That label reads as an observation and
 * is not one: triaging the July 2026 Automation collapse from this column
 * produced exactly that wrong conclusion.
 *
 * `fallbackModel` is the caller's assertion about the executor and is applied
 * ONLY over the placeholder or a NULL — a model the agent genuinely reported
 * always wins. Callers that cannot prove who executed the run must omit it
 * rather than guess: `reconcileAutomationRuns` sweeps active runs without
 * filtering on `dispatched_message_id`, so it can reach runs an external client
 * created, and stamping those would invert the very bug this fixes.
 *
 * (SQL comments are kept out of the template literal: a backtick inside one
 * terminates the string and fails the esbuild transform, not just at runtime.)
 */
export async function markAutomationRunCompleted(
	sql: DbClient,
	runId: number,
	fallbackModel?: string
): Promise<void> {
	await sql`
    UPDATE runs
    SET status = 'completed',
        outcome = ${classifyRunOutcome({ status: "completed" })},
        completed_at = current_timestamp,
        error_message = NULL,
        model_used = COALESCE(
          NULLIF(model_used, 'external-client'),
          ${fallbackModel ?? null},
          model_used
        )
    WHERE id = ${runId}
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;
}

async function markAutomationRunFailed(
	sql: DbClient,
	runId: number,
	message: string,
	notBefore?: Date | null,
	errorCode?: string | null
): Promise<boolean> {
	return sql.begin(async (tx) => {
		const [failed] = await tx<{
			automation_id: string | number | null;
			run_type: string;
			dispatch_source: string | null;
		}>`
      UPDATE runs
      SET status = 'failed',
          outcome = ${classifyRunOutcome({ status: "failed", errorCode, errorMessage: message })},
          completed_at = current_timestamp,
          error_message = ${message}
      WHERE id = ${runId}
        AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
      RETURNING automation_id, run_type, approved_input->>'dispatch_source' AS dispatch_source
    `;
		if (!failed) return false;
		// Only a REAL Automation failure moves the schedule. An eval replay copies
		// the source run's dispatch_source verbatim, so without this gate a
		// failing eval (a quota 429, a scoring rerun) would advance — or park for
		// a day — the live Automation's cron cursor it is merely replaying.
		if (failed.run_type === AUTOMATION_RUN_TYPE) {
			await recordScheduledExecutionFailure(
				tx,
				failed.automation_id == null ? null : Number(failed.automation_id),
				failed.dispatch_source,
			);
			await advanceScheduleAfterTerminalFailure(
				tx,
				failed.automation_id == null ? null : Number(failed.automation_id),
				failed.dispatch_source,
				notBefore
			);
		}
		return true;
	});
}

/**
 * Reset an automation run that missed `complete_window` back to `pending` so the
 * automation dispatch loop (`dispatchPendingAutomationRuns` → `claimAutomationRun`)
 * re-dispatches it for one more agent turn. Mirrors `resetOrphanedAutomationRuns`
 * (the proven re-dispatch shape) and records the attempt in
 * `approved_input.finalize_nudge_count` so it is strictly bounded. Status-
 * guarded so it can't resurrect an already-terminal run (replica-safe).
 */
async function requeueAutomationRunForFinalizeNudge(
	sql: DbClient,
	runId: number,
	nextNudgeCount: number
): Promise<void> {
	await sql`
    UPDATE runs
    SET status = 'pending',
        claimed_by = NULL,
        claimed_at = NULL,
        dispatched_message_id = NULL,
        error_message = NULL,
        approved_input = jsonb_set(
          COALESCE(approved_input, '{}'::jsonb),
          '{finalize_nudge_count}',
          to_jsonb(${nextNudgeCount}::int)
        )
    WHERE id = ${runId}
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;
}

export async function resolveAutomationRunsByMessageIds(
	messageIds: Iterable<string>,
	result: AutomationTerminalResult,
	db?: DbClient
): Promise<{ resolved: number }> {
	const ids = Array.from(new Set(Array.from(messageIds).filter(Boolean)));
	if (ids.length === 0) return { resolved: 0 };

	const sql = db ?? getDb();
	const rows = await sql`
    SELECT r.id, r.run_type, r.approved_input, w.execution_config
    FROM runs r
    LEFT JOIN automations w ON w.id = r.automation_id
    WHERE r.run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
      AND r.dispatched_message_id = ANY(${pgTextArray(ids)}::text[])
      AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;

	let resolved = 0;
	for (const row of rows) {
		const typedRow = row as {
			id: unknown;
			run_type: string;
			approved_input: Record<string, unknown> | null;
			execution_config: Record<string, unknown> | null;
		};
		const runId = Number(typedRow.id);
		if (!Number.isFinite(runId)) continue;

		if (!result.ok) {
			const notBefore = providerQuotaResetNotBefore(
				result.quotaResetError ?? result.error,
				result.errorCode
			);
			if (
				await markAutomationRunFailed(
					sql,
					runId,
					result.error,
					notBefore,
					result.errorCode
				)
			) {
				resolved++;
			}
			continue;
		}

		if (typedRow.approved_input?.trigger_execution === "turn") {
			await markAutomationRunCompleted(sql, runId, "lobu-agent");
			resolved++;
			continue;
		}

		// Capture-mode evals persist their preview instead of a live result.
		if (typedRow.run_type === AUTOMATION_EVAL_RUN_TYPE) {
			await markAutomationRunCompleted(sql, runId, "lobu-agent");
			resolved++;
			continue;
		}

		// Any live run still active when its reply finishes did not call
		// complete_window: that call completes the run atomically with its result.
		const budget = resolveFinalizeNudgeBudget(typedRow.execution_config);
		const nudgeCount = Number(
			typedRow.approved_input?.finalize_nudge_count ?? 0
		);
		if (Number.isFinite(nudgeCount) && nudgeCount < budget) {
			await requeueAutomationRunForFinalizeNudge(sql, runId, nudgeCount + 1);
			logger.info(
				{ run_id: runId, attempt: nudgeCount + 1, max: budget },
				"[automations] Agent finished without complete_window — re-dispatching for finalize nudge"
			);
			resolved++;
			continue;
		}
		if (
			await markAutomationRunFailed(
				sql,
				runId,
				await describeFinalizeMiss(sql, runId, budget)
			)
		) {
			resolved++;
		}
	}

	return { resolved };
}

async function describeFinalizeMiss(
	sql: DbClient,
	runId: number,
	budget: number
): Promise<string> {
	const attempts = budget > 0 ? ` after ${budget + 1} attempt(s)` : "";
	const agentMiss =
		"Agent reply finished without calling run_sdk (client.automations.completeWindow)" +
		attempts;
	let pending: Array<{ mcpId: string; toolName: string }>;
	try {
		pending = await listPendingToolsForRun(runId, sql);
	} catch (error) {
		logger.warn(
			{ error, run_id: runId },
			"[automations] Could not check pending tool approvals for a finalize miss"
		);
		return (
			agentMiss +
			". Tool approval status could not be checked; inspect the warning log " +
			"before attributing the miss to the agent."
		);
	}

	if (pending.length > 0) {
		const tools = pending.map((p) => `${p.mcpId}/${p.toolName}`).join(", ");
		const grants = pending
			.map((p) => `/mcp/${p.mcpId}/tools/${p.toolName}`)
			.join(", ");
		return (
			`Automation run blocked on tool approval${attempts}: ${tools} queued for ` +
			"human approval, so complete_window never ran. Headless Automation runs " +
			`cannot answer approval cards; grant standing access (${grants}) and ` +
			"retry the Automation."
		);
	}

	return (
		agentMiss +
		". No active tool approval was found, so check that the assigned agent has the " +
		"lobu-memory MCP attached and that query_sdk / run_sdk are available to it."
	);
}
