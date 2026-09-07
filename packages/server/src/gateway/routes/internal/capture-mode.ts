/**
 * Capture-mode guard for internal worker routes (evals PR 2, lobu#2564).
 *
 * The SDK lane already captures: `sandbox/run-script.ts` skips and records any
 * method whose `METHOD_METADATA` access is not `read`, and `tools/sdk_run.ts`
 * forces that path on for a capture run. But the agent framework also calls a
 * handful of internal routes DIRECTLY, without going through the SDK — sending
 * a real chat message, posting an interaction card, delivering files into the
 * conversation, executing in a sandbox, generating billable media. Those are
 * the ones that would still reach the outside world during an eval replay or
 * a native shadow turn.
 *
 * This guard is the one thing those routes need. It reads the signed
 * `executionMode` claim off the already-verified worker token — no DB lookup,
 * no re-derivation from the conversationId — and, when the run is a capture
 * run, records the attempt and answers with a success-shaped body so the agent
 * continues its turn normally. A capture run that got an error back would
 * mostly be measuring its own retry logic, which is not the semantics we want
 * to score.
 */

import type { WorkerTokenData } from "@lobu/core";
import type { Context } from "hono";
import { getDb } from "../../../db/client.js";
import { AUTOMATION_EVAL_RUN_TYPE } from "../../../runs/run-types.js";
import logger from "../../../utils/logger.js";
import type { WorkerContext } from "./types.js";

/**
 * Nothing a capture run "sends" ever fails or throttles, so a looping agent
 * would grow this jsonb column without bound. Capped at the write, and the run
 * is flagged so a truncated record is never read as a complete one.
 */
export const MAX_CAPTURED_SIDE_EFFECTS = 50;

/**
 * Cap on one entry's `details`. The entry cap above bounds how MANY effects are
 * recorded, not how big each one is, and these payloads carry agent-authored
 * free text — a chat message body, a shell command. Bounded here rather than at
 * the call sites so every capture point, including ones added later, is
 * covered.
 */
export const MAX_CAPTURED_DETAIL_CHARS = 4000;

/**
 * Serialised size, not key count: a single long string is the shape that
 * actually bloats the column. Over budget, the entry keeps a readable prefix
 * and says it was cut, because a score reads what the agent tried to do and a
 * truncated attempt is still that.
 */
function boundDetails(details: Record<string, unknown>): Record<string, unknown> {
	const json = JSON.stringify(details) ?? "";
	if (json.length <= MAX_CAPTURED_DETAIL_CHARS) return details;
	return {
		details_truncated: true,
		details_preview: json.slice(0, MAX_CAPTURED_DETAIL_CHARS),
	};
}

/**
 * Short-circuit a mutating internal route when the run captures side effects
 * (an eval replay or a native shadow turn).
 * Returns a Response to return immediately, or null to proceed for real.
 *
 * `action` and `details` are appended to `runs.dry_run_preview.side_effects` —
 * the same column `handleCompleteWindow` uses. A score needs "what did the
 * agent try to do" joinable to a run, and a log line is not.
 *
 * `responseBody` overrides the default `{ success, captured, ... }` body for
 * routes whose caller parses a specific contract off a 2xx rather than just
 * checking `ok` — e.g. `runtime.exec`, where the worker reads
 * `{ stdout, exitCode }` and an absent exitCode is reported to the agent as
 * the command failing (exit 1), which would send a capture run into retry
 * loops instead of continuing its turn.
 */
export async function captureSideEffect(
	c: Context<WorkerContext>,
	action: string,
	details: Record<string, unknown>,
	responseBody?: Record<string, unknown>,
): Promise<Response | null> {
	const worker = c.get("worker");
	if (worker.executionMode !== "capture") return null;
	const result = await captureEffect(worker, action, details);
	return c.json(responseBody ?? result);
}

/** Signed identity, propagated per request through internal MCP and SDK calls. */
export type CaptureIdentity = Pick<WorkerTokenData,
	"organizationId" | "agentId" | "conversationId" | "automationRunId" | "runId"
>;

/** Shared capture result for HTTP, direct tools and proxied MCP invocations. */
export async function captureEffect(
	identity: CaptureIdentity | null | undefined,
	action: string,
	details: Record<string, unknown>,
) {
	if (identity?.organizationId && (identity.automationRunId || identity.runId)) {
		await recordCapturedSideEffect(identity, action, details);
	} else {
		logger.error({ action }, "Capture identity missing: effect suppressed but not recorded");
	}
	return {
		success: true,
		captured: true,
		action,
		message: "Recorded but not performed: this run captures side effects.",
	};
}

/**
 * Append one suppressed side effect to its eval or native shadow run.
 *
 * One UPDATE reading and rewriting under the row lock, so concurrent handlers
 * on different replicas cannot lose each other's entry. `run_type` is guarded
 * in the WHERE, not in TypeScript, so a claim aimed at a live run cannot stamp
 * it.
 *
 * Never throws: suppression already happened, and a route error is what sends
 * a capture run into retry loops. A lost record degrades scoring; performing
 * the side effect would break the guarantee.
 */
async function recordCapturedSideEffect(
	identity: CaptureIdentity,
	action: string,
	details: Record<string, unknown>,
): Promise<void> {
	try {
		const sql = getDb();
		// One assignment to `dry_run_preview` — Postgres rejects a SET clause that
		// touches the same column twice — so both keys are written by nesting the
		// two jsonb_set calls. Every `dry_run_preview` on the right-hand side is
		// the pre-UPDATE value, which is what makes the length check and the
		// append agree with each other.
		await sql`
      UPDATE runs
      SET dry_run = true,
          dry_run_preview = jsonb_set(
            jsonb_set(
              coalesce(dry_run_preview, '{}'::jsonb),
              '{side_effects}',
              CASE
                WHEN jsonb_array_length(
                       coalesce(dry_run_preview->'side_effects', '[]'::jsonb)
                     ) >= ${MAX_CAPTURED_SIDE_EFFECTS}
                THEN coalesce(dry_run_preview->'side_effects', '[]'::jsonb)
                ELSE coalesce(dry_run_preview->'side_effects', '[]'::jsonb)
                     || jsonb_build_array(
                          jsonb_build_object(
                            'action', ${action}::text,
                            'details', ${sql.json(boundDetails(details) as never)}::jsonb,
                            'at', to_jsonb(current_timestamp)
                          )
                        )
              END
            ),
            '{side_effects_truncated}',
            to_jsonb(
              jsonb_array_length(
                coalesce(dry_run_preview->'side_effects', '[]'::jsonb)
              ) >= ${MAX_CAPTURED_SIDE_EFFECTS}
            )
          )
      WHERE id = ${identity.automationRunId ?? identity.runId ?? null}
        AND organization_id = ${identity.organizationId!}
        AND (
          (${identity.automationRunId !== undefined} AND run_type = ${AUTOMATION_EVAL_RUN_TYPE})
          OR (
            ${identity.automationRunId === undefined} AND run_type = 'agent_turn'
            AND action_input->'turn'->>'shadow' = 'true'
            AND action_input->'turn'->>'agent_id' = ${identity.agentId ?? null}
            AND action_input->'turn'->>'conversation_id' = ${identity.conversationId ?? null}
          )
        )
    `;
	} catch (error) {
		logger.error(
			{ error, runId: identity.automationRunId ?? identity.runId, action },
			"[eval-capture] side effect suppressed but its record could not be written",
		);
	}
}
