import { describe, expect, test } from "bun:test";
// Load the registry before sdk_run: the registry imports sdk_run, and sdk_run's
// own import graph reaches the registry, so entering that cycle at sdk_run
// leaves its exports uninitialized when the registry evaluates and breaks a
// standalone run of this file.
import "../../tools/registry";
import { boundScriptErrorText } from "../../sandbox/run-script";
import {
	classifySdkScriptError,
	SdkScriptResultSchema,
	toMcpPublicSdkScriptResult,
} from "../../tools/sdk_run";
import { validateToolResult } from "../../tools/validate-args";

describe("SDK MCP public result", () => {
	test("strips internal diagnostics while preserving the requested result and dry-run proposal", () => {
		const richInternal = {
			title: "  Company pipeline  ",
			success: false,
			return_value: { answer: 42 },
			logs: [{ level: "warn", message: "private diagnostic", ts: 123 }],
			error: {
				name: "TypeError",
				message: "boom",
				details: { request_id: "internal-123" },
				stack: "secret stack",
				line: 3,
				column: 7,
				code: "VALIDATION",
				retryable: false,
			},
			duration_ms: 42,
			sdk_calls: 3,
			skipped_calls: 1,
			sdk_call_trace: [
				{
					path: "entities.list",
					orgPath: ["private-org"],
					access: "read",
					args: [{}],
					skipped: false,
				},
			],
			side_effect_preview: [
				{
					path: "entities.create",
					orgPath: ["private-org"],
					access: "write",
					args: [{ name: "A" }],
					skipped: true,
					required_access: "write",
					authorization_status: "not_evaluated",
				},
			],
			dry_run: true,
		};

		const publicResult = toMcpPublicSdkScriptResult(richInternal) as Record<string, unknown>;

		expect(validateToolResult(SdkScriptResultSchema, publicResult)).not.toBeNull();
		expect(publicResult.title).toBe("Company pipeline");
		expect(publicResult.success).toBe(false);
		expect(publicResult.dry_run).toBe(true);
		expect(publicResult.skipped_calls).toBe(1);
		expect(publicResult.return_value).toEqual({ answer: 42 });
		expect(publicResult.side_effect_preview).toEqual([
			{
				path: "entities.create",
				access: "write",
				args: [{ name: "A" }],
				required_access: "write",
				authorization_status: "not_evaluated",
			},
		]);
		expect(publicResult.error).toEqual({
			name: "TypeError",
			message: "boom",
			code: "VALIDATION",
			retryable: false,
		});

		const serialized = JSON.stringify(publicResult);
		for (const forbidden of [
			"private diagnostic",
			"internal-123",
			"secret stack",
			"private-org",
			"duration_ms",
			"sdk_call_trace",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	test("does not advertise diagnostic-only fields in the public schema", () => {
		const schema = JSON.stringify(SdkScriptResultSchema);
		for (const forbidden of [
			'"logs"',
			'"ts"',
			'"stack"',
			'"duration_ms"',
			'"sdk_calls"',
			'"sdk_call_trace"',
			'"orgPath"',
		]) {
			expect(schema).not.toContain(forbidden);
		}
	});

	test("replaces oversized SDK action details with a truncation marker", () => {
		const publicResult = toMcpPublicSdkScriptResult({
			success: false,
			error: {
				name: "ClientSdkActionError",
				message: "failed",
				details: { output: { blob: "x".repeat(40_000) } },
			},
			skipped_calls: 0,
			side_effect_preview: [],
			dry_run: false,
		}) as { error: { details?: Record<string, unknown> } };
		expect(publicResult.error.details).toMatchObject({ truncated: true });
		expect(JSON.stringify(publicResult).length).toBeLessThan(1_000);
	});

	test("normalizes the bounded dry-run preview contract", () => {
		const publicResult = toMcpPublicSdkScriptResult({
			success: true,
			skipped_calls: 3,
			side_effect_preview: [
				{
					path: "entities.create",
					access: "mystery",
					args: [],
					required_access: "write",
					authorization_status: "not_evaluated",
				},
				{ path: 42, args: [] },
			],
			return_value_preview: "head",
			return_truncated: { total_bytes: 10, kept_bytes: 4 },
			dry_run: true,
		}) as Record<string, unknown>;

		expect(validateToolResult(SdkScriptResultSchema, publicResult)).not.toBeNull();
		expect(publicResult.side_effect_preview).toEqual([
			{
				path: "entities.create",
				access: "unknown",
				args: [],
				required_access: "write",
				authorization_status: "not_evaluated",
			},
		]);
		expect(publicResult.side_effect_preview_truncated).toEqual({ dropped_entries: 2 });
		expect(publicResult.return_value_preview).toBe("head");
		expect(publicResult.return_truncated).toEqual({ total_bytes: 10, kept_bytes: 4 });
	});

	test("preserves a caller-supplied title and drops blank titles", () => {
		expect(
			(
				toMcpPublicSdkScriptResult({
					title: "Pipeline",
					success: true,
					skipped_calls: 0,
					side_effect_preview: [],
					dry_run: false,
				}) as Record<string, unknown>
			).title,
		).toBe("Pipeline");
		expect(
			(
				toMcpPublicSdkScriptResult({
					title: "   ",
					success: true,
					skipped_calls: 0,
					side_effect_preview: [],
					dry_run: false,
				}) as Record<string, unknown>
			).title,
		).toBeUndefined();
	});

	test("defensively bounds public error fields", () => {
		const publicResult = toMcpPublicSdkScriptResult({
			success: false,
			skipped_calls: 0,
			side_effect_preview: [],
			dry_run: false,
			error: {
				name: "N".repeat(2_000),
				message: "💥".repeat(100_000),
			},
		}) as Record<string, unknown>;

		expect(validateToolResult(SdkScriptResultSchema, publicResult)).not.toBeNull();
		const error = publicResult.error as { name: string; message: string };
		expect(Buffer.byteLength(error.name, "utf8")).toBeLessThanOrEqual(256);
		expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(16_384);
		expect(error.name).toEndWith("… [truncated]");
		expect(error.message).toEndWith("… [truncated]");
	});

	test("honors error bounds smaller than the truncation suffix", () => {
		const bounded = boundScriptErrorText("💥abcdef", 5);
		expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(5);
		expect(bounded).toBe("💥a");
	});

	test("classifies deterministic caller failures as validation errors", () => {
		expect(
			classifySdkScriptError({
				name: "ValidationError",
				message: "Invalid arguments for client.agents.list: unknown argument(s): limit",
			}),
		).toEqual({ code: "VALIDATION", retryable: false });
		// The compiler block also owns filesystem/module-loading failures, so its
		// generic name alone is not proof the caller supplied invalid source.
		expect(
			classifySdkScriptError({
				name: "CompileError",
				message: "ENOSPC while loading compiler infrastructure",
			}),
		).toEqual({ code: "INTERNAL", retryable: false });
		expect(
			classifySdkScriptError({
				name: "ScriptError",
				message: "unexpected application failure",
			}),
		).toEqual({ code: "INTERNAL", retryable: false });
	});

	test("prefers structured classifications and ignores script-controlled markers", () => {
		expect(
			classifySdkScriptError({
				name: "ToolUserError",
				message: "temporary provider failure",
				code: "NETWORK",
			}),
		).toEqual({ code: "NETWORK", retryable: true });
		expect(
			classifySdkScriptError({
				name: "ToolUserError",
				message: "provider unavailable",
			}),
		).toEqual({ code: "INTERNAL", retryable: false });
		expect(
			classifySdkScriptError({
				name: "ClientSdkActionError",
				message: "rate limit",
			}),
		).toEqual({ code: "INTERNAL", retryable: false });
		expect(
			classifySdkScriptError({
				name: "TimeoutError",
				message: "script exceeded its wall-clock budget",
			}),
		).toEqual({ code: "INTERNAL", retryable: false });
		expect(
			classifySdkScriptError({
				name: "McpScopeRequiredError",
				message: "mcp:admin is required",
			}),
		).toEqual({ code: "PERMISSION", retryable: false });
		expect(
			classifySdkScriptError({
				name: "ScriptError",
				message: "user text says 429 and rate limit",
			}),
		).toEqual({ code: "INTERNAL", retryable: false });
	});

	test("summarizes change-capable calls a failed live run already dispatched", () => {
		// The renderer's warning depends on this crossing the boundary: the raw
		// sdk_call_trace never does, so a trace-derived warning would be invisible
		// to every MCP client.
		const result = toMcpPublicSdkScriptResult({
			success: false,
			skipped_calls: 0,
			side_effect_preview: [],
			dry_run: false,
			error: { message: "TimeoutError: script exceeded 60000ms" },
			sdk_call_trace: [
				{ path: "entities.update", access: "write", skipped: false, args: [{ secret: "x" }] },
			],
			started_side_effects: [
				{ path: "entities.update", access: "write", count: 2 },
				{ path: "slack.postMessage", access: "external", count: 1 },
				{ path: "something.odd", access: "unknown", count: 3 },
			],
		}) as Record<string, unknown>;

		// Reads, skipped calls, and unknown-access calls are not evidence of change.
		expect(result.started_side_effects).toEqual([
			{ path: "entities.update", access: "write", count: 2 },
			{ path: "slack.postMessage", access: "external", count: 1 },
		]);
		// The diagnostic trace itself still never crosses, args included.
		expect(result.sdk_call_trace).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	test("still warns when trace eviction left only reads behind", () => {
		// traceBytes evicts OLDEST entries, so a long run's early writes vanish
		// from sdk_call_trace and the survivors can be entirely reads. Deriving
		// the summary from the trace would suppress the warning on exactly the
		// runs most likely to have timed out mid-write; the sandbox's dispatch
		// tally is the source of truth.
		const result = toMcpPublicSdkScriptResult({
			success: false,
			skipped_calls: 0,
			side_effect_preview: [],
			dry_run: false,
			sdk_call_trace: [
				{ path: "entities.list", access: "read", skipped: false },
				{ path: "entities.get", access: "read", skipped: false },
			],
			sdk_call_trace_truncated: { dropped_entries: 880 },
			started_side_effects: [{ path: "entities.update", access: "write", count: 412 }],
		}) as Record<string, unknown>;

		expect(result.started_side_effects).toEqual([
			{ path: "entities.update", access: "write", count: 412 },
		]);
		// The tally is complete by construction, so trace eviction must NOT hedge
		// it — an "at least" count here would understate a real write volume.
		expect(result.started_side_effects_truncated).toBeUndefined();
	});

	test("omits the summary for successful, dry-run, and read-only failures", () => {
		const base = {
			skipped_calls: 0,
			side_effect_preview: [],
			started_side_effects: [{ path: "entities.update", access: "write", count: 1 }],
		};
		// Succeeded: nothing to warn about.
		expect(
			(toMcpPublicSdkScriptResult({ ...base, success: true, dry_run: false }) as Record<
				string,
				unknown
			>).started_side_effects,
		).toBeUndefined();
		// Dry-run: the sandbox skipped the writes.
		expect(
			(toMcpPublicSdkScriptResult({ ...base, success: false, dry_run: true }) as Record<
				string,
				unknown
			>).started_side_effects,
		).toBeUndefined();
		// Failed, but only read.
		expect(
			(
				toMcpPublicSdkScriptResult({
					success: false,
					skipped_calls: 0,
					side_effect_preview: [],
					dry_run: false,
					started_side_effects: [],
				}) as Record<string, unknown>
			).started_side_effects,
		).toBeUndefined();
	});
});
