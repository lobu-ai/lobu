import logger from "../utils/logger";
import { ToolUserError } from "../utils/errors";

/**
 * Failure logging for the `executeTool` boundary, the shared chokepoint every
 * tool call (REST `/api/:orgSlug/:toolName`, MCP, SDK) passes through. A
 * failure here used to surface only as a bare "HTTP 500" request line with no
 * error class, code or correlation id, leaving bursts undiagnosable from the
 * log stream alone.
 *
 * Only whitelisted, value-free fields are recorded: the error's class, a
 * bounded constant-shaped code, the tool name (the route identity at the REST
 * proxy), the call-scoped correlation id and the wall-clock duration. The raw
 * error object is deliberately NOT passed to the logger: pino's err
 * serializer copies every enumerable own property, and a postgres.js
 * `PostgresError` carries `query`/`parameters`/`internal_query` — raw SQL and
 * bound values must never reach the diagnostic stream. Messages are excluded
 * for the same reason: they can embed entity titles, payload values or
 * credentials.
 */

// Only bounded, constant-shaped codes are safe to log: ToolErrorCode values,
// Postgres SQLSTATEs and Node system codes. Anything longer or carrying
// punctuation could embed a value, so it is dropped.
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,32}$/i;

function safeErrorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : undefined;
}

/**
 * Log one line for a tool call that failed in a way the caller cannot fix.
 * A 4xx-class `ToolUserError` is the caller's answer, not a server failure
 * (same rule as `logUnhandledAuthEndpointError`), and is not logged here.
 */
export function logToolCallFailure(args: {
	error: unknown;
	toolName: string;
	callId: string;
	durationMs: number;
}): void {
	const { error, toolName, callId, durationMs } = args;
	if (error instanceof ToolUserError && error.httpStatus < 500) return;
	logger.error(
		{
			tool_name: toolName,
			call_id: callId,
			duration_ms: durationMs,
			error_class: error instanceof Error ? error.constructor.name : typeof error,
			error_code: safeErrorCode(error),
		},
		"Tool call failed",
	);
}
