/**
 * Automation run types and the execution mode derived from them.
 *
 * An Automation run executes for real. Historical `automation_eval` rows must
 * remain captured after retirement of the product eval feature. Keeping their
 * distinct `runs.run_type` value means the
 * existing `run_type = 'automation'` predicates across the scheduler, reapers,
 * coalescing and automation-health exclude evals with no code change at all.
 * Only the execution path opts back in, via {@link AUTOMATION_RUN_TYPES}.
 *
 * The mode is ALWAYS derived here from the run row and never accepted from a
 * caller: it is computed at session creation (where the run row is already
 * being read to decide whether the session may exist) and then carried as a
 * signed worker-token claim, so an agent cannot ask to be live.
 */

/** An Automation run whose side effects really happen. */
export const AUTOMATION_RUN_TYPE = "automation";

/** Legacy stored replay discriminator. Retained so old runs stay captured. */
export const AUTOMATION_EVAL_RUN_TYPE = "automation_eval";

/**
 * Run types the Automation execution path accepts: claim, session creation,
 * window completion, run completion — plus historical run-thread reads.
 *
 * Deliberately NOT used by scheduling, coalescing or health predicates —
 * those stay `= 'automation'` so evals never compete with, suppress, or degrade
 * a real Automation.
 *
 * Reaping splits, and the test is whether the reaper touches anything beyond
 * the stranded row itself:
 * - Included — `resetOrphanedAutomationRuns` and `markStaleRunsAsTimeout`. Both
 *   only release or terminate the run they reap. Excluding evals there does
 *   not protect the Automation, it just strands the eval forever, and because
 *   the claim guards are same-lane that wedges every later eval of it.
 * - Excluded — `finalizeStalePendingAutomationRuns`, which advances
 *   `next_run_at`. An eval must never move the live schedule.
 */
export const AUTOMATION_RUN_TYPES: readonly string[] = [
	AUTOMATION_RUN_TYPE,
	AUTOMATION_EVAL_RUN_TYPE,
];

/**
 * The same list, pre-formatted as a Postgres `text[]` literal.
 *
 * Bind THIS at every `run_type = ANY(...)` site, never {@link AUTOMATION_RUN_TYPES}
 * itself: the pool runs with `fetch_types: false`, so a raw JS array is sent as
 * the bare string `automation,automation_eval` and Postgres rejects it at runtime
 * with `malformed array literal` — a query that typechecks and then always
 * throws. Safe to build by `join` because both values are compile-time
 * identifier constants with nothing to escape.
 */
export const AUTOMATION_RUN_TYPES_PG = `{${AUTOMATION_RUN_TYPES.join(",")}}`;

/**
 * `live` executes side effects; `capture` records what the agent tried to do
 * and performs none of it.
 */
export type ExecutionMode = "live" | "capture";

/**
 * Fail closed: anything that is not a known live Automation run captures. A run
 * type this module has not heard of never gets to write to the outside world.
 */
export function executionModeForRunType(
	runType: string | null | undefined,
): ExecutionMode {
	return runType === AUTOMATION_RUN_TYPE ? "live" : "capture";
}
