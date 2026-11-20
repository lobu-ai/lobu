import {
	classifyToolError,
	createSpan,
	describeError,
	recordError,
} from "@lobu/core";
import logger from "../utils/logger";

/**
 * A failed feed sync as an issue occurrence.
 *
 * Connector code reports a sync failure as text on the run, and the worker's
 * own log line carries no fingerprint, so the occurrence rollup never counted
 * one. It is recorded once, where the run terminalizes and the server still
 * holds the run's typed signals (exit reason, dependency marker) and its org.
 *
 * Grouping is by connector, feed and parameterized message, like an operation
 * failure. The error carries no stack: the server's frames would merge every
 * connector's failures into one issue.
 */

export interface SyncFailure {
	runId: number;
	organizationId: string;
	connectorKey: string;
	feedId: number;
	feedKey: string;
	errorMessage: string | null;
	exitReason: string | null;
	exitCode: number | null;
	exitSignal: string | null;
	/** Reason of a `dependency_unavailable` marker the connector failed with. */
	dependencyReason: string | null;
}

/**
 * The kind and code follow only from structure the server holds: a dependency
 * marker, or how the worker ended the run. Connector failure text carries no
 * typed status over the completion contract, so the rest is ours (system).
 */
function syncFailureError(failure: SyncFailure) {
	const scope = `sync ${failure.connectorKey}.${failure.feedKey}`;
	const message = failure.errorMessage ?? `Run ${failure.runId} failed`;
	if (failure.dependencyReason) {
		return {
			error: { name: "SyncFailed", message, code: failure.dependencyReason },
			options: { scope, kind: "dependency" as const },
		};
	}
	const exitReason = failure.exitReason;
	const code =
		exitReason === "timeout" || exitReason === "oom" || exitReason === "crash"
			? classifyToolError({ exitReason })
			: null;
	return code
		? { error: { name: "SyncFailed", message, code }, options: { scope } }
		: {
				error: { name: "SyncFailed", message },
				options: { scope, kind: "system" as const },
			};
}

/**
 * Record one committed sync failure: a span named after the feed (the issue's
 * culprit) and an error log line with the same fingerprint, which the
 * occurrence rollup counts once. The caller skips the generic run-failure log
 * for it, so a crash is not counted twice.
 */
export function recordSyncFailure(failure: SyncFailure): void {
	const { error, options } = syncFailureError(failure);
	const report = describeError(error, options);
	const span = createSpan(options.scope, {
		"lobu.org_id": failure.organizationId,
		"lobu.run_id": failure.runId,
		"lobu.connector_key": failure.connectorKey,
		"lobu.feed_id": failure.feedId,
	});
	recordError(span, error, options);
	span?.end();
	// Value-free fields only, like an operation failure: connector errors quote
	// third-party pages. The span carries the title and the run keeps the text.
	logger.error(
		{
			error_fingerprint: report.fingerprint,
			error_type: report.type,
			error_kind: report.kind,
			...(report.code ? { error_code: report.code } : {}),
			source: "sync_failure",
			organization_id: failure.organizationId,
			run_id: failure.runId,
			connector_key: failure.connectorKey,
			feed_id: failure.feedId,
			exit_reason: failure.exitReason,
			exit_code: failure.exitCode,
			exit_signal: failure.exitSignal,
		},
		"Sync failed",
	);
}
