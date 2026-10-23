import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import logger from "../../utils/logger";
import { ToolUserError } from "../../utils/errors";
import { logToolCallFailure } from "../tool-error-log";

afterEach(() => vi.restoreAllMocks());

describe("logToolCallFailure", () => {
	it("logs a 5xx ToolUserError with class, code, tool, call id and duration", () => {
		const log = vi.spyOn(logger, "error").mockImplementation(() => {});
		const error = new ToolUserError("upstream timed out", 500, "UPSTREAM_TIMEOUT");
		logToolCallFailure({ error, toolName: "resolve_path", callId: "call-1", durationMs: 10012 });
		expect(log).toHaveBeenCalledExactlyOnceWith(
			{
				tool_name: "resolve_path",
				call_id: "call-1",
				duration_ms: 10012,
				error_class: "ToolUserError",
				error_code: "UPSTREAM_TIMEOUT",
			},
			"Tool call failed",
		);
	});

	it.each([400, 403, 404, 429] as const)("does not log a %d ToolUserError", (status) => {
		const log = vi.spyOn(logger, "error").mockImplementation(() => {});
		logToolCallFailure({
			error: new ToolUserError("caller error", status),
			toolName: "resolve_path",
			callId: "call-2",
			durationMs: 3,
		});
		expect(log).not.toHaveBeenCalled();
	});

	it("logs a PostgresError by class and SQLSTATE without query, parameters or message", () => {
		const log = vi.spyOn(logger, "error").mockImplementation(() => {});
		const error = new postgres.PostgresError({
			severity_local: "ERROR",
			severity: "ERROR",
			code: "57014",
			message: "canceling statement due to statement timeout",
			detail: "",
			hint: "",
			position: "",
			internal_position: "",
			internal_query: "",
			where: "",
			schema_name: "",
			table_name: "",
			column_name: "",
			data_type_name: "",
			constraint_name: "",
			file: "postgres.c",
			line: "3345",
			routine: "ProcessInterrupts",
		});
		// postgres.js attaches the offending statement and its bound values to
		// the error object; logging the raw error would leak both.
		(error as Record<string, unknown>).query = "SELECT * FROM entities WHERE title = $$sensitive-payload-XYZ$$";
		(error as Record<string, unknown>).parameters = ["sensitive-payload-XYZ"];
		logToolCallFailure({ error, toolName: "resolve_path", callId: "call-3", durationMs: 10005 });
		expect(log).toHaveBeenCalledExactlyOnceWith(
			{
				tool_name: "resolve_path",
				call_id: "call-3",
				duration_ms: 10005,
				error_class: "PostgresError",
				error_code: "57014",
			},
			"Tool call failed",
		);
		expect(JSON.stringify(log.mock.calls[0])).not.toContain("sensitive-payload-XYZ");
	});

	it("never logs the raw error object, so message text cannot leak payloads", () => {
		const log = vi.spyOn(logger, "error").mockImplementation(() => {});
		const error = new Error("failed for entity sensitive-payload-XYZ with token tok_secret_123");
		logToolCallFailure({ error, toolName: "manage_entity", callId: "call-4", durationMs: 2220 });
		expect(log).toHaveBeenCalledExactlyOnceWith(
			{
				tool_name: "manage_entity",
				call_id: "call-4",
				duration_ms: 2220,
				error_class: "Error",
				error_code: undefined,
			},
			"Tool call failed",
		);
		expect(JSON.stringify(log.mock.calls[0])).not.toContain("sensitive-payload-XYZ");
		expect(JSON.stringify(log.mock.calls[0])).not.toContain("tok_secret_123");
	});

	it("drops a code that is not a bounded constant", () => {
		const log = vi.spyOn(logger, "error").mockImplementation(() => {});
		const error = new Error("boom");
		(error as { code?: unknown }).code = "value was sensitive-payload-XYZ";
		logToolCallFailure({ error, toolName: "resolve_path", callId: "call-5", durationMs: 1 });
		expect(log).toHaveBeenCalledExactlyOnceWith(
			{
				tool_name: "resolve_path",
				call_id: "call-5",
				duration_ms: 1,
				error_class: "Error",
				error_code: undefined,
			},
			"Tool call failed",
		);
		expect(JSON.stringify(log.mock.calls[0])).not.toContain("sensitive-payload-XYZ");
	});

	it("handles a non-Error thrown value", () => {
		const log = vi.spyOn(logger, "error").mockImplementation(() => {});
		logToolCallFailure({ error: "string failure", toolName: "resolve_path", callId: "call-6", durationMs: 2 });
		expect(log).toHaveBeenCalledExactlyOnceWith(
			{
				tool_name: "resolve_path",
				call_id: "call-6",
				duration_ms: 2,
				error_class: "string",
				error_code: undefined,
			},
			"Tool call failed",
		);
	});
});
