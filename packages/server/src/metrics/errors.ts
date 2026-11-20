/**
 * Metric compilation errors, shared by the compiler and the read-mode resolver.
 *
 * Every throw names something the caller asked for or the workspace declared
 * (an undeclared measure, a malformed `asOf`, an unsupported aggregation), so
 * the class is a `VALIDATION` caller fault: the REST proxy answers 400 and the
 * tool boundary does not report it as a server failure.
 *
 * `MetricNotImplementedError` extends `MetricCompileError` so a caller that
 * catches the base class still catches deferred-feature failures.
 */

import { ToolUserError } from "../utils/errors";

export class MetricCompileError extends ToolUserError {
	constructor(message: string) {
		super(message, 400, "VALIDATION");
	}
}
export class MetricNotImplementedError extends MetricCompileError {}
