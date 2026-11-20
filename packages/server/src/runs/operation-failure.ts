import {
	createSpan,
	describeError,
	type ErrorReport,
	recordError,
	type ToolErrorCode,
} from "@lobu/core";
import { parseDependencyUnavailableError } from "../connectors/dependency-unavailable";
import logger from "../utils/logger";

/**
 * A failed connector operation run as an issue occurrence.
 *
 * Connector code reports failure as text on the run, not as a thrown error, so
 * nothing recorded it before: the run's tool call returned normally and its
 * span ended OK. These failures are the ones an agent hits and works around,
 * so they are recorded once, where the run terminalizes, and the same
 * fingerprint is handed back to the caller that waits for the run. An agent
 * that reports the failure cites it, and the report lands on the issue the
 * tracker opened for it (`issue-<fingerprint>`).
 *
 * Grouping is by connector, operation and parameterized message. The connector
 * version is left out so a regression in a new release reopens the same issue
 * instead of starting a new one.
 */

export interface OperationFailure {
	connectorKey: string;
	operationKey: string;
	errorMessage: string;
	/**
	 * The typed code the run recorded with its failure (a device reports one
	 * when it can tell why). It sets the issue's code and kind, so a target's
	 * refusal is not counted as a system fault.
	 */
	errorCode?: ToolErrorCode;
}

/**
 * The message a failed run is reported and fingerprinted under. A device worker
 * may finish a run as failed without one; the waiter that answers the caller and
 * the terminal write that records the failure must agree on the same text.
 */
export function operationFailureMessage(
	runId: number,
	errorMessage: string | null | undefined,
): string {
	return errorMessage ?? `Run ${runId} failed`;
}

export function operationFailureScope(
	failure: Pick<OperationFailure, "connectorKey" | "operationKey">,
): string {
	return `operation ${failure.connectorKey}.${failure.operationKey}`;
}

/**
 * The failure as an error-shaped value. A typed code is carried as the error's
 * code and its kind follows from it; otherwise a dependency marker becomes the
 * code.
 */
function operationFailureError(failure: OperationFailure) {
	if (failure.errorCode) {
		return {
			error: {
				name: "OperationFailed",
				message: failure.errorMessage,
				code: failure.errorCode,
			},
			options: { scope: operationFailureScope(failure) },
		};
	}
	const dependency = parseDependencyUnavailableError(failure.errorMessage);
	return {
		error: {
			name: "OperationFailed",
			message: dependency?.message ?? failure.errorMessage,
			...(dependency ? { code: dependency.reason } : {}),
		},
		options: {
			scope: operationFailureScope(failure),
			kind: dependency ? ("dependency" as const) : ("system" as const),
		},
	};
}

export function describeOperationFailure(failure: OperationFailure): ErrorReport {
	const { error, options } = operationFailureError(failure);
	return describeError(error, options);
}

/**
 * Record one committed operation failure: a span named after the operation
 * (the issue's culprit) and an error log line with the same fingerprint, which
 * the occurrence rollup counts once. Only the agent-facing run is recorded;
 * a child step's failure reaches the agent through its parent's message.
 */
export function recordOperationFailure(
	run: OperationFailure & {
		runId: number;
		organizationId: string;
		parentRunId?: number | null;
	},
): void {
	if (run.parentRunId != null) return;
	const { error, options } = operationFailureError(run);
	const report = describeError(error, options);
	const span = createSpan(options.scope, {
		"lobu.org_id": run.organizationId,
		"lobu.run_id": run.runId,
		"lobu.connector_key": run.connectorKey,
		"lobu.operation_key": run.operationKey,
	});
	recordError(span, error, options);
	span?.end();
	// Like the tool failure log: the hash and value-free fields only. Connector
	// errors quote third-party pages, and a parameterized message can still
	// hold plain words; the span carries the title and the run keeps the text.
	logger.error(
		{
			error_fingerprint: report.fingerprint,
			error_type: report.type,
			error_kind: report.kind,
			...(report.code ? { error_code: report.code } : {}),
			source: "operation_failure",
			organization_id: run.organizationId,
			run_id: run.runId,
			connector_key: run.connectorKey,
			operation_key: run.operationKey,
		},
		"Operation failed",
	);
}
