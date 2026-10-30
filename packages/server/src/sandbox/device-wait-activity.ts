import type { DeviceWaitActivity } from "../tools/registry";

/** How many in-flight runs a deadline message names before summarizing the rest. */
const MAX_NAMED_RUNS = 5;

/**
 * What a script deadline cut short, or null when no device wait was in flight.
 *
 * The server marks such a run `timeout`, but that does not prove the device
 * stopped: a claimed command keeps running until the daemon notices (older
 * daemons never do), a late result is discarded, and completion can race the
 * timeout. So the reader is told the run, its phase, that effects may have
 * happened, to inspect the original run before retrying, and how to avoid
 * this next time. A fresh idempotency_key cannot dedupe the original run.
 */
export function describeInFlightDeviceWaits(
	deviceWaits: DeviceWaitActivity | undefined,
): string | null {
	if (!deviceWaits || deviceWaits.size === 0) return null;
	const risk =
		"The command may still be running on the device or may already have changed things; once the run is marked timeout, its output is discarded.";
	const prevention =
		"For long device work, pass background: true and an idempotency_key on the first operations.execute call, then read operations.getRun(run_id) in a later call.";
	if (deviceWaits.size === 1) {
		const [[runId, phase]] = [...deviceWaits];
		return (
			`operations.execute run ${runId} reached the script deadline (phase: ${phase}). ${risk} ` +
			`Don't rerun it blindly: read operations.getRun(${runId}) first. ${prevention}`
		);
	}
	const runs = [...deviceWaits];
	const named = runs
		.slice(0, MAX_NAMED_RUNS)
		.map(([runId, phase]) => `${runId} (${phase})`)
		.join(", ");
	const more = runs.length > MAX_NAMED_RUNS ? ` and ${runs.length - MAX_NAMED_RUNS} more` : "";
	return (
		`operations.execute runs ${named}${more} reached the script deadline. ${risk} ` +
		`Don't rerun them blindly: read operations.getRun(run_id) for each first. ${prevention}`
	);
}
