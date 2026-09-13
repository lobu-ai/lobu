/**
 * Compiles a TypeScript user-script via esbuild, runs it in a V8 isolate, and
 * bridges SDK calls back to the host. Output is bounded per-purpose: interactive
 * return values are capped at 1 MB (an oversized value is replaced by a bounded
 * `returnValuePreview` head plus a report, never shipped in full to the model),
 * console logs are capped at 64 KB and the guest console bridge is disabled
 * once full. Each single
 * host↔guest bridge message (SDK payload, SDK result, or return envelope) is
 * capped at 4 MB — a larger message, or exhausting the 200-call quota,
 * terminates the run by disposing the isolate (uncatchable by the guest).
 * Extracted named exports keep the old hard-fail semantics because a partial
 * schema would be worse than none. Other caps: 180s wall-clock max
 * (a device-bound operation can consume most of it — see
 * `MAX_SCRIPT_TIMEOUT_MS`), and 30s per `ctx.sleep()`.
 * `client.org()` is stateless — each guest call carries
 * `orgPath` so the host re-walks org swaps without holding refs.
 */

import { randomUUID } from "node:crypto";
import type { ClientSDK } from "./client-sdk";
import {
	classifyToolError,
	isRetryable,
	isToolError,
	toToolErrorCode,
	type ToolErrorCode,
} from "@lobu/core";
import { ClientSdkActionError } from "./namespaces/action-call";
import { METHOD_METADATA, type MethodAccess } from "./method-metadata";
import type { ToolAccessLevel } from "../auth/tool-access";
import { enumerateSDKManifest, type SDKMode } from "./sdk-manifest";
import { McpScopeRequiredError } from "../tools/access-control";
import { getSdkPreflight } from "./sdk-preflight";
import { ToolUserError } from "../utils/errors";

export interface RunLimits {
	memoryMb?: number;
	timeoutMs?: number;
	sdkCallQuota?: number;
	/** Preview threshold and byte cap for interactive returns; extracted exports hard-fail instead. */
	outputBytes?: number;
	/** Cap for captured console logs; messages past it are dropped. */
	logBytes?: number;
	/** Serialized cap for EACH of `sdk_call_trace` and `side_effect_preview`; oldest entries are dropped past it. */
	traceBytes?: number;
	/** Single-message cap for host↔guest bridge traffic; a larger message terminates the run. */
	messageBytes?: number;
}

/** What the host kept when a return value exceeded `outputBytes` and became a preview. */
interface ReturnPreviewInfo {
	total_bytes: number;
	kept_bytes: number;
}

/**
 * Whether one SDK call is skipped-and-recorded rather than dispatched.
 *
 * Exported so the capture contract is pinned by a test against THIS expression
 * rather than a copy of it — a mirrored predicate in a test can never catch a
 * regression here.
 */
export function isSkippedUnderDryRun(args: {
	dryRun?: boolean;
	dryRunDispatchPaths?: readonly string[];
	access: string;
	path: string;
}): boolean {
	if (args.dryRun !== true) return false;
	if (args.access === "read") return false;
	return !args.dryRunDispatchPaths?.includes(args.path);
}

export interface RunScriptOptions {
	source: string;
	context?: Record<string, unknown>;
	/**
	 * Preview mode for full-SDK scripts. Read calls still execute so scripts can
	 * inspect state, but write/external SDK calls are skipped and returned in
	 * `sideEffectPreview` instead of mutating state or reaching external systems.
	 */
	dryRun?: boolean;
	/**
	 * SDK paths that still DISPATCH under {@link dryRun}, because the handler
	 * behind them is itself capture-aware and refuses its own writes.
	 *
	 * This exists for exactly one case: an eval replay is told to finalize via
	 * `client.automations.completeWindow`, and the blanket skip would swallow that
	 * call — leaving the run with no window, so it gets nudged into a second
	 * full replay and then failed with "finished without calling run_sdk". The
	 * handler needs to RUN so it can record the extraction and answer
	 * `captured: true`; it reads the same `executionMode` off its ToolContext
	 * and writes nothing.
	 *
	 * Deliberately NOT populated for an agent-requested `dry_run: true` — there
	 * the agent asked for a preview and skipping is the correct answer.
	 */
	dryRunDispatchPaths?: readonly string[];
	/**
	 * Either a pre-built SDK or a builder that receives the wall-clock
	 * AbortSignal so handlers can race their work against the timeout and
	 * unblock the awaiting caller (postgres connections aren't cancelled —
	 * see `ToolContext.abortSignal`). Prefer the builder form for sandbox MCP tools.
	 */
	sdk: ClientSDK | ((signal: AbortSignal) => ClientSDK);
	sdkMode?: SDKMode;
	/** Whether `client.org` is reachable inside the guest. Defaults to false. */
	allowCrossOrg?: boolean;
	/** Caller access tier — filters the dispatch manifest (defaults to read). */
	maxAccessLevel?: ToolAccessLevel;
	limits?: RunLimits;
	/** Forwarded to the script entry point after `(ctx, client)`. */
	extraArgs?: unknown[];
	/**
	 * When set, the module is loaded but its default handler is NOT invoked;
	 * instead `returnValue` is the named export, serialized via JSON (drops
	 * non-enumerable TypeBox symbols, leaving plain JSON Schema). Used to read a
	 * reaction's exported `input` contract. Runs strictly LESS guest code than a
	 * normal run (top-level only, no handler), so it adds no attack surface.
	 */
	extractExport?: string;
}

interface LogEntry {
	level: "log" | "warn" | "error";
	message: string;
	ts: number;
}

interface SdkCallTraceEntry {
	path: string;
	orgPath: string[];
	access: MethodAccess | "unknown";
	args: unknown[];
	skipped: boolean;
	/**
	 * Resolved tier, never the `external` side-effect marker: preflight maps an
	 * external method through its `enforcedTier`, and the public `run_sdk`
	 * schema drops any entry that still carries `external`.
	 */
	required_access?: Exclude<MethodAccess, "external">;
	authorization_status?: "not_evaluated";
}

interface RunScriptResult {
	success: boolean;
	returnValue?: unknown;
	/** Whether the invoked handler explicitly returned a value (including null). */
	didReturnValue?: boolean;
	/** UTF-8-safe head of the serialized return value when it exceeded `outputBytes`. */
	returnValuePreview?: string;
	/** Present with `returnValuePreview`: original JSON and preview-string byte sizes. */
	returnTruncated?: ReturnPreviewInfo;
	/** Total calls skipped under dry-run (independent of preview retention). */
	skippedCalls: number;
	/** Trace entries dropped because the `traceBytes` cap was exceeded. */
	traceDropped: number;
	logs: LogEntry[];
	sdkCallTrace: SdkCallTraceEntry[];
	/** Change-capable dispatches by path; unbounded, so trace eviction cannot hide them. */
	startedSideEffects: Array<{ path: string; access: MethodAccess; count: number }>;
	/** Token scopes requested by post-role-check SDK denials during this run. */
	requiredMcpScopes: Array<"mcp:admin">;
	sideEffectPreview: SdkCallTraceEntry[];
	error?: {
		name: string;
		message: string;
		code?: ToolErrorCode;
		retryable?: boolean;
		details?: unknown;
		stack?: string;
		line?: number;
		column?: number;
	};
	durationMs: number;
	sdkCalls: number;
}

const DEFAULT_LIMITS: Required<RunLimits> = {
	memoryMb: 64,
	timeoutMs: 60_000,
	sdkCallQuota: 200,
	outputBytes: 1_048_576,
	logBytes: 65_536,
	traceBytes: 131_072,
	messageBytes: 4_194_304,
};
/**
 * Device action waits allow a 60s queue budget plus a post-claim budget of 95s
 * by default, or the action's declared `timeout_ms` maximum plus a 30s
 * completion grace (see tools/admin/device-action-wait.ts). The sandbox must
 * outlive the common case; the waiter also honors the script's own abort, so a
 * script that hits this ceiling mid-wait finalizes its device run rather than
 * leaking it.
 */
export const MAX_SCRIPT_TIMEOUT_MS = 180_000;
export const MAX_SLEEP_MS = 30_000;
const MAX_TRACE_ARGS_BYTES = 8192;
const MAX_ERROR_DETAILS_BYTES = 16_384;
export const MAX_SCRIPT_ERROR_NAME_BYTES = 256;
export const MAX_SCRIPT_ERROR_MESSAGE_BYTES = 16_384;
export const MAX_SCRIPT_ERROR_STACK_BYTES = 32_768;
const SENSITIVE_TRACE_KEY =
	/(api[_-]?key|apikey|auth[_-]?data|auth[_-]?values|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;

function jsonBytes(value: unknown): number {
	const json = JSON.stringify(value);
	return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

function redactTraceValue(
	value: unknown,
	depth = 0,
	ancestors = new WeakSet<object>(),
): unknown {
	if (depth > 8) return "[truncated]";
	if (typeof value === "bigint") return value.toString();
	if (!value || typeof value !== "object") return value;
	if (ancestors.has(value)) return "[circular]";
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item) => redactTraceValue(item, depth + 1, ancestors));
		}
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, child]) => [
				key,
				SENSITIVE_TRACE_KEY.test(key)
					? "[redacted]"
					: redactTraceValue(child, depth + 1, ancestors),
			]),
		);
	} finally {
		ancestors.delete(value);
	}
}

function traceArgs(args: unknown[]): unknown[] {
	const redacted = redactTraceValue(args) as unknown[];
	const json = JSON.stringify(redacted);
	if (Buffer.byteLength(json, "utf8") > MAX_TRACE_ARGS_BYTES) {
		return [{ truncated: true, bytes: Buffer.byteLength(json, "utf8") }];
	}
	return JSON.parse(json) as unknown[];
}

export function safeErrorDetails(value: unknown): unknown {
	try {
		const redacted = redactTraceValue(value);
		const json = JSON.stringify(redacted);
		if (typeof json !== "string") {
			return {
				truncated: true,
				message: "Structured SDK error details were not JSON-serializable.",
			};
		}
		if (Buffer.byteLength(json, "utf8") <= MAX_ERROR_DETAILS_BYTES) {
			return redacted;
		}
		return {
			truncated: true,
			bytes: Buffer.byteLength(json, "utf8"),
			message: "Structured SDK error details exceeded the transport limit.",
		};
	} catch {
		return {
			truncated: true,
			message: "Structured SDK error details could not be serialized safely.",
		};
	}
}

const MAX_RETURN_PREVIEW_BYTES = 262_144;
const PREVIEW_SUFFIX = "\u2026 [truncated]";

/** Longest byte-bounded prefix of `value` that does not split a UTF-16 surrogate pair. */
function byteBoundedPrefix(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let lo = 0;
	let hi = value.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) lo = mid;
		else hi = mid - 1;
	}
	if (lo > 0 && lo < value.length) {
		const c = value.charCodeAt(lo - 1);
		if (c >= 0xd800 && c <= 0xdbff) lo -= 1; // don't split a surrogate pair
	}
	return value.slice(0, lo);
}

function errorFieldText(value: unknown, fallback: string): string {
	if (typeof value === "string") return value;
	if (value == null) return fallback;
	try {
		return String(value);
	} catch {
		return fallback;
	}
}

/** Bound one SDK script error field without cutting a UTF-16 surrogate pair. */
export function boundScriptErrorText(value: unknown, maxBytes: number): string {
	const text = errorFieldText(value, "");
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffixBytes = Buffer.byteLength(PREVIEW_SUFFIX, "utf8");
	if (maxBytes <= suffixBytes) return byteBoundedPrefix(text, maxBytes);
	return `${byteBoundedPrefix(text, Math.max(0, maxBytes - suffixBytes))}${PREVIEW_SUFFIX}`;
}

/**
 * Build the preview for an oversized interactive return value: a UTF-8-safe
 * head of the serialized JSON (a preview the model reads to decide what to
 * query, never a value it could mistake for complete output) plus the byte
 * sizes. Only called when the serialized value already exceeds `outputBytes`.
 */
function buildReturnPreview(
	valueJson: string,
	totalBytes: number,
	maxBytes: number,
): { preview: string; info: ReturnPreviewInfo } {
	const kept = byteBoundedPrefix(
		valueJson,
		maxBytes - Buffer.byteLength(PREVIEW_SUFFIX, "utf8"),
	);
	const preview = `${kept}${PREVIEW_SUFFIX}`;
	return {
		preview,
		info: {
			total_bytes: totalBytes,
			kept_bytes: Buffer.byteLength(preview, "utf8"),
		},
	};
}

type TrustedErrorClassification = {
	code: ToolErrorCode;
	retryable: boolean;
};

function classifyToolUserError(error: ToolUserError): ToolErrorCode {
	const directCode = toToolErrorCode(error.code);
	if (directCode) return directCode;
	if (error.httpStatus === 403) return "PERMISSION";
	return classifyToolError({ httpStatus: error.httpStatus });
}

function classifyClientSdkActionResult(
	result: Readonly<Record<string, unknown>>,
): ToolErrorCode {
	const directCode =
		toToolErrorCode(result.error_code) ?? toToolErrorCode(result.code);
	if (directCode) return directCode;
	if (result.status === "timeout" || result.status === "timed_out") {
		return "UPSTREAM_TIMEOUT";
	}
	const httpStatus =
		typeof result.http_status === "number"
			? result.http_status
			: typeof result.httpStatus === "number"
				? result.httpStatus
				: undefined;
	if (httpStatus !== undefined) return classifyToolError({ httpStatus });
	const failedItem = Array.isArray(result.results)
		? result.results.find(
				(item): item is Record<string, unknown> =>
					item !== null &&
					typeof item === "object" &&
					!Array.isArray(item) &&
					(item as Record<string, unknown>).success === false,
			)
		: undefined;
	const message = [
		result.error,
		result.error_message,
		result.message,
		result.reason,
		failedItem?.error,
		failedItem?.error_message,
		failedItem?.message,
		failedItem?.reason,
	].find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
	return classifyToolError({ message });
}

function trustedRuntimeClassification(
	error: Record<string, unknown>,
	trustedClassifications?: ReadonlyMap<string, TrustedErrorClassification>,
): TrustedErrorClassification | undefined {
	const token = error.classificationToken;
	return typeof token === "string"
		? trustedClassifications?.get(token)
		: undefined;
}

function classifyRuntimeError(
	error: unknown,
	trustedClassifications?: ReadonlyMap<string, TrustedErrorClassification>,
): NonNullable<RunScriptResult["error"]> {
	const record =
		error !== null && typeof error === "object"
			? (error as Record<string, unknown>)
			: {};
	const rawName = errorFieldText(record.name, "Error");
	const rawMessage = errorFieldText(record.message, "Script execution failed");
	const message = boundScriptErrorText(
		rawMessage,
		MAX_SCRIPT_ERROR_MESSAGE_BYTES,
	);
	const classification = trustedRuntimeClassification(
		record,
		trustedClassifications,
	);
	// Expected user-input errors (bad SDK args, business-rule failures) must NOT
	// leak a server-bundle stack to the client — the message already carries the
	// actionable "Invalid arguments for client.x.y: …" guidance, and the full
	// stack stays in server logs/observability. An unexpected ScriptError keeps
	// its stack (a genuine bug the developer needs to trace).
	const isExpectedUserError =
		rawName === "ClientSdkActionError" ||
		rawName === "McpScopeRequiredError" ||
		rawName === "ToolUserError" ||
		rawMessage === "Script must `export default` an async function" ||
		/^Invalid arguments for /.test(rawMessage);
	if (rawName === "ClientSdkActionError") {
		return {
			name: "ClientSdkActionError",
			message,
			...classification,
			...(record.details === undefined
				? {}
				: { details: safeErrorDetails(record.details) }),
		};
	}
	if (rawName === "McpScopeRequiredError") {
		return { name: "McpScopeRequiredError", message, ...classification };
	}
	if (rawName === "ToolUserError") {
		return {
			name:
				classification?.code === "VALIDATION"
					? "ValidationError"
					: "ToolUserError",
			message,
			...classification,
		};
	}
	if (isExpectedUserError) {
		return { name: "ValidationError", message, ...classification };
	}

	const isTimeout = /script execution timed out|TimeoutError/i.test(rawMessage);
	const isQuota = /QuotaExceeded/.test(rawMessage);
	const isSleepLimit = /SleepLimitExceeded/.test(rawMessage);
	const isInvalidSleep = /InvalidSleepDuration/.test(rawMessage);
	const isOversize = /OutputSizeExceeded/.test(rawMessage);
	const isOom = /memory|allocation|isolate was disposed/i.test(rawMessage);
	const name = isTimeout
		? "TimeoutError"
		: isQuota
			? "QuotaExceeded"
			: isSleepLimit
				? "SleepLimitExceeded"
				: isInvalidSleep
					? "InvalidSleepDuration"
					: isOversize
						? "OutputSizeExceeded"
						: isOom
							? "OutOfMemory"
							: "ScriptError";
	return {
		name,
		message,
		...classification,
		...(record.stack != null
			? {
					stack: boundScriptErrorText(
						record.stack,
						MAX_SCRIPT_ERROR_STACK_BYTES,
					),
				}
			: {}),
	};
}

function clampNumber(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
) {
	const n = Number.isFinite(value) ? value : fallback;
	return Math.max(min, Math.min(n ?? fallback, max));
}

function clampLimits(limits?: RunLimits): Required<RunLimits> {
	return {
		memoryMb: clampNumber(
			limits?.memoryMb,
			DEFAULT_LIMITS.memoryMb,
			8,
			DEFAULT_LIMITS.memoryMb,
		),
		timeoutMs: clampNumber(
			limits?.timeoutMs,
			DEFAULT_LIMITS.timeoutMs,
			1,
			MAX_SCRIPT_TIMEOUT_MS,
		),
		sdkCallQuota: clampNumber(
			limits?.sdkCallQuota,
			DEFAULT_LIMITS.sdkCallQuota,
			1,
			DEFAULT_LIMITS.sdkCallQuota,
		),
		outputBytes: clampNumber(
			limits?.outputBytes,
			DEFAULT_LIMITS.outputBytes,
			1024,
			DEFAULT_LIMITS.outputBytes,
		),
		logBytes: clampNumber(
			limits?.logBytes,
			DEFAULT_LIMITS.logBytes,
			1024,
			DEFAULT_LIMITS.logBytes,
		),
		traceBytes: clampNumber(
			limits?.traceBytes,
			DEFAULT_LIMITS.traceBytes,
			1024,
			DEFAULT_LIMITS.traceBytes,
		),
		messageBytes: clampNumber(
			limits?.messageBytes,
			DEFAULT_LIMITS.messageBytes,
			65_536,
			DEFAULT_LIMITS.messageBytes,
		),
	};
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`TimeoutError: script exceeded ${timeoutMs}ms wall-clock budget`,
				),
			);
		}, timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function raceAgainstAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(
			signal.reason instanceof Error
				? signal.reason
				: new Error("AbortError: signal aborted"),
		);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error("AbortError: signal aborted"),
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

export function sleepAgainstAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < 0) {
		return Promise.reject(
			new Error("InvalidSleepDuration: ctx.sleep(ms) requires a non-negative integer"),
		);
	}
	if (ms > MAX_SLEEP_MS) {
		return Promise.reject(
			new Error(
				`SleepLimitExceeded: ctx.sleep(ms) allows at most ${MAX_SLEEP_MS}ms per call`,
			),
		);
	}
	if (signal.aborted) {
		return Promise.reject(
			signal.reason instanceof Error
				? signal.reason
				: new Error("AbortError: signal aborted"),
		);
	}
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error("AbortError: signal aborted"),
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

type IsolatedVmRuntime = typeof import("isolated-vm");

function unwrapIsolatedVm(mod: unknown): IsolatedVmRuntime {
	const m = mod as IsolatedVmRuntime & {
		default?: IsolatedVmRuntime;
		"module.exports"?: IsolatedVmRuntime;
	};
	return m.default ?? m["module.exports"] ?? m;
}

async function loadIsolatedVm(): Promise<IsolatedVmRuntime | null> {
	// isolated-vm's native addon is ABI-bound per Node line. We ship two builds via
	// optionalDependencies: isolated-vm@6 (Node 22–24) and the aliased
	// `isolated-vm-next` = isolated-vm@7 (Node 26+). Node 25 is an EOL non-LTS line
	// upstream skipped (issue #553), so it has no build → no sandbox. Pick by Node
	// major and fail closed if the chosen build can't load (e.g. native build was
	// skipped on this platform) rather than taking down the MCP server.
	const nodeMajor = Number(process.versions.node?.split(".")[0] ?? 0);
	if (!Number.isFinite(nodeMajor)) return null;

	try {
		if (nodeMajor >= 22 && nodeMajor < 25) {
			return unwrapIsolatedVm(await import("isolated-vm"));
		}
		if (nodeMajor >= 26) {
			// Aliased to isolated-vm@7 in package.json optionalDependencies.
			return unwrapIsolatedVm(await import("isolated-vm-next"));
		}
		return null;
	} catch {
		return null;
	}
}

function guestPreamble(errorTokenReader: string): string {
	return `
const __ctxData = JSON.parse(__ctx_json);
const ctx = Object.freeze({
  ...__ctxData,
  sleep: async (ms) => __sleep.apply(undefined, [ms], { result: { promise: true, copy: true } }),
});
const { client, takeErrorToken: ${errorTokenReader} } = (() => {
const __hostSdkDispatch = __sdk_dispatch;
try {
  globalThis.__sdk_dispatch = undefined;
  delete globalThis.__sdk_dispatch;
} catch {}
const __parseJson = JSON.parse.bind(JSON);
const __trustedErrors = new WeakMap();
const __rememberTrustedError = WeakMap.prototype.set.bind(__trustedErrors);
const __readTrustedError = WeakMap.prototype.get.bind(__trustedErrors);
const __forgetTrustedError = WeakMap.prototype.delete.bind(__trustedErrors);
const __manifest = __parseJson(__sdk_manifest_json);
const __namespaceMethods = __manifest.byNamespace;
const __topLevelKeys = new Set(__manifest.topLevel);
const __namespaceKeys = new Set(Object.keys(__namespaceMethods));
// Namespaces that EXIST in the SDK but are hidden by the current mode/tier
// (e.g. \`agents\` when running below admin). Accessing one should throw a
// structured "not available in this mode" error, not return undefined and fail
// later with the opaque "Cannot read properties of undefined (reading 'list')".
const __hiddenNamespaceKeys = new Set(
  (__manifest.allNamespaces || []).filter((ns) => !__namespaceKeys.has(ns))
);

// Skip awaitable/coercion probes (\`then\`, \`toJSON\`, etc.) before they hit the
// host. Otherwise an accidental \`JSON.stringify(client.x)\` consumes quota.
function __isReservedKey(k) {
  return typeof k === 'symbol'
    || k === 'then' || k === 'catch' || k === 'finally'
    || k === 'inspect' || k === 'constructor' || k === '__proto__'
    || k === 'toJSON' || k === 'toString' || k === 'valueOf';
}

function __dispatchCall(path, orgPath) {
  return async (...args) => {
    const payload = JSON.stringify({ args, orgPath });
    const r = await __hostSdkDispatch.apply(undefined, [path, payload], { result: { promise: true, copy: true } });
    if (r === undefined) return undefined;
    const envelope = __parseJson(r);
    if (!envelope || envelope.__lobu_sdk_dispatch !== 1) {
      throw new Error('InvalidSDKDispatchEnvelope');
    }
    if (!envelope.ok) {
      const error = new Error(envelope.error?.message || 'ClientSDK call failed');
      error.name = envelope.error?.name || 'ClientSdkActionError';
      if (envelope.error?.details !== undefined) error.details = envelope.error.details;
      if (typeof envelope.error?.classificationToken === 'string') {
		__rememberTrustedError(error, envelope.error.classificationToken);
      }
      throw error;
    }
    return envelope.has_value ? envelope.value : undefined;
  };
}

function __makeNamespaceProxy(ns, orgPath) {
  const methods = new Set(__namespaceMethods[ns] || []);
  return new Proxy({}, {
    get: (_, k) => __isReservedKey(k) || !methods.has(String(k))
      ? undefined
      : __dispatchCall(ns + '.' + String(k), orgPath),
    has: (_, k) => typeof k === 'string' && methods.has(k),
    ownKeys: () => Array.from(methods),
    getOwnPropertyDescriptor: (_, k) => typeof k === 'string' && methods.has(k)
      ? { enumerable: true, configurable: true, writable: false, value: undefined }
      : undefined,
  });
}

// A namespace known to the SDK but filtered out of THIS mode. Every method
// access returns a thunk that throws the same structured error the host would,
// so discovery (search_sdk) and runtime agree instead of the guest hitting an
// undefined property. Mirrors the client.org stub pattern above.
function __makeHiddenNamespaceProxy(ns) {
  const err = () => {
    throw new Error('NamespaceNotAvailable: the \\'' + ns + '\\' namespace is not available in this SDK mode (read-only or restricted tier). Re-run with a session that has the required access, or use a namespace listed by search_sdk in this mode.');
  };
  return new Proxy({}, {
    get: (_, k) => __isReservedKey(k) ? undefined : err,
    has: () => true,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

function __makeClient(orgPath) {
  const allKeys = new Set([...__topLevelKeys, ...__namespaceKeys, ...__hiddenNamespaceKeys]);
  return new Proxy({}, {
    get(_, key) {
      if (__isReservedKey(key)) return undefined;
      const k = String(key);
      // client.org is advertised by search_sdk with a "Throws
      // CrossOrgAccessDenied on scoped/PAT endpoints" note. When cross-org is
      // unavailable the manifest omits it from __topLevelKeys -- but returning
      // undefined makes client.org('x') fail with the opaque
      // "client.org is not a function", contradicting the docs. Return a stub
      // that throws the SAME structured error the host path raises, so
      // discovery and runtime agree. (This block lives inside a template
      // literal; keep it free of backticks and dollar-brace sequences.)
      if (k === 'org') return __topLevelKeys.has('org')
        ? (slug) => __makeClient([...orgPath, String(slug)])
        : () => { throw new Error('CrossOrgAccessDenied: cross-org access is not available on this connection. Use the unscoped /mcp endpoint with an OAuth session, or reconnect to the target workspace.'); };
      if (__topLevelKeys.has(k)) return __dispatchCall(k, orgPath);
      if (__namespaceKeys.has(k)) return __makeNamespaceProxy(k, orgPath);
      if (__hiddenNamespaceKeys.has(k)) return __makeHiddenNamespaceProxy(k);
      return undefined;
    },
    has: (_, k) => typeof k === 'string' && allKeys.has(k),
    ownKeys: () => Array.from(allKeys),
    getOwnPropertyDescriptor: (_, k) => typeof k === 'string' && allKeys.has(k)
      ? { enumerable: true, configurable: true, writable: false, value: undefined }
      : undefined,
  });
}

return {
  client: __makeClient([]),
  takeErrorToken(error) {
    const trusted = __readTrustedError(error);
    __forgetTrustedError(error);
	return trusted;
  },
};
})();

let __console_enabled = true;
function __emitConsole(level, args) {
  if (!__console_enabled) return;
  try {
    const accepted = __console_call.applySync(undefined, [level, args.map(String).join(' ')]);
    if (accepted === false) __console_enabled = false;
  } catch (e) {}
}
const console = {
  log: (...a) => __emitConsole('log', a),
  warn: (...a) => __emitConsole('warn', a),
  error: (...a) => __emitConsole('error', a),
};

const module = { exports: {} };
const exports = module.exports;
`;
}

function guestRunner(errorTokenReader: string): string {
	return `
(async () => {
  try {
  const __entry = module.exports.default
    ?? (typeof module.exports === 'function' ? module.exports : null);
  if (typeof __entry !== 'function') {
    throw new Error('Script must \`export default\` an async function');
  }
  const __extra = JSON.parse(__extra_args_json);
  const __result = await __entry(ctx, client, ...__extra);
    return JSON.stringify({
      __lobu_script_result: 1,
      ok: true,
	  has_value: __result !== undefined,
      value: __result === undefined ? null : __result,
    });
  } catch (error) {
	const __safeErrorField = (key, fallback) => {
	  try {
		const value = error?.[key];
		if (typeof value === 'string') return value;
		if (value == null) return fallback;
		try { return String(value); } catch { return fallback; }
	  } catch { return fallback; }
	};
	const __safeErrorDetails = () => {
	  try {
		if (error?.details === undefined) return undefined;
		return JSON.parse(JSON.stringify(error.details));
	  } catch { return undefined; }
	};
	const __safeThrownValue = () => {
	  try { return String(error); } catch { return 'Unknown error'; }
	};
	const __details = __safeErrorDetails();
	const __classificationToken = ${errorTokenReader}(error);
    return JSON.stringify({
      __lobu_script_result: 1,
      ok: false,
      error: {
		name: __safeErrorField('name', 'Error'),
		message: __safeErrorField('message', __safeThrownValue()),
		stack: __safeErrorField('stack', undefined),
		...(__details === undefined ? {} : { details: __details }),
		...(__classificationToken === undefined
		  ? {}
		  : { classificationToken: __classificationToken }),
      },
    });
  }
})()
`;
}

// Read a named export instead of invoking the handler — the module top-level
// runs (constructing exports), then we serialize the requested export. `__name`
// is host-injected via jail, never interpolated into source.
const EXTRACT_RUNNER = `
(async () => {
  const __v = module.exports[__extract_name];
  if (__extract_name === 'default') {
    return typeof __v === 'function' ? '{"__valid":true}' : null;
  }
  return __v === undefined || __v === null ? null : JSON.stringify(__v);
})()
`;

/**
 * Compiled-output memo, keyed by a hash of the source text. Insertion-ordered
 * `Map` used as an LRU: a hit re-inserts, an overflow evicts the oldest key.
 *
 * Bounded by bytes as well as by entries, because an entry is a whole bundle:
 * ~1 KB for an import-free script but ~530 KB for one importing `npm:zod`
 * (measured), so an entry-only cap would let 256 heavy scripts pin >100 MB.
 */
const compiledSourceCache = new Map<string, { code: string; bytes: number }>();
const COMPILED_SOURCE_CACHE_MAX_ENTRIES = 256;
const COMPILED_SOURCE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
let compiledSourceCacheBytes = 0;

export async function runScript(
	options: RunScriptOptions,
): Promise<RunScriptResult> {
	const started = Date.now();
	const limits = clampLimits(options.limits);
	const sdkMode: SDKMode = options.sdkMode ?? "full";
	const allowCrossOrg = options.allowCrossOrg ?? false;
	const manifest = enumerateSDKManifest(sdkMode, {
		allowCrossOrg,
		maxAccessLevel: options.maxAccessLevel,
	});

	// Host-side mirror of the manifest's dispatchable paths. `__sdk_dispatch` is a
	// guest-visible global, so a malicious script can call it with an un-manifested
	// method directly — the guest-side Proxy filter is the friendly path, this is
	// the security backstop. `org` is a guest-side construct (re-walks `orgPath`),
	// never a dispatch path, so it isn't in this set.
	const allowedDispatchPaths = new Set<string>(["log", "query"]);
	for (const [ns, methods] of Object.entries(manifest.byNamespace)) {
		for (const method of methods) allowedDispatchPaths.add(`${ns}.${method}`);
	}
	const FORBIDDEN_ORG_SLUGS = new Set([
		"__proto__",
		"constructor",
		"prototype",
	]);

	// Wall-clock timeout. Each dispatch races the abort signal so the script
	// returns promptly; upstream DB/HTTP itself doesn't cancel today.
	const abortController = new AbortController();
	const abortTimer = setTimeout(() => {
		abortController.abort(
			new Error(
				`TimeoutError: script exceeded ${limits.timeoutMs}ms wall-clock budget`,
			),
		);
	}, limits.timeoutMs);

	// Resolve the SDK lazily so callers that pass a builder receive the
	// wall-clock signal — opted-in handlers race their work against it to
	// unblock the awaiting caller on timeout.
	const baseSdk: ClientSDK =
		typeof options.sdk === "function"
			? options.sdk(abortController.signal)
			: options.sdk;

	const logs: LogEntry[] = [];
	const sdkCallTrace: SdkCallTraceEntry[] = [];
	const sideEffectPreview: SdkCallTraceEntry[] = [];
	/**
	 * Change-capable dispatches by path, kept outside the byte-capped trace so a
	 * long run's early writes survive its oldest-first eviction.
	 */
	const startedSideEffects = new Map<string, { access: MethodAccess; count: number }>();
	const requiredMcpScopes = new Set<"mcp:admin">();
	const trustedErrorClassifications = new Map<
		string,
		TrustedErrorClassification
	>();
	const trustErrorClassification = (code: ToolErrorCode): string => {
		const token = randomUUID();
		trustedErrorClassifications.set(token, {
			code,
			retryable: isRetryable(code),
		});
		return token;
	};
	let sdkCalls = 0;
	// Total calls skipped under dry-run, independent of preview retention so a
	// truncated preview never undercounts the dry-run surface.
	let skippedCalls = 0;
	// Captured console budget. Messages past it are dropped, never a failure.
	let logBytesUsed = 0;
	let logFull = false;
	// Terminal bridge failures dispose the isolate so the guest cannot keep
	// crossing traffic after a message, call, or log budget is exhausted.
	// Hoisted because `isolate` is assigned inside the try block below.
	let isolate: import("isolated-vm").Isolate | null = null;
	const terminalState = { name: "", message: "" };
	let terminated = false;

	const quotaMessage = `QuotaExceeded: SDK call quota of ${limits.sdkCallQuota} reached`;
	const oversizeMessage = `OutputSizeExceeded: a single bridge message exceeded ${limits.messageBytes} bytes (SDK call payload/result or return value)`;
	const consoleFloodMessage = `OutputSizeExceeded: console output continued after the ${limits.logBytes}-byte log cap`;
	const terminalEnvelope = () =>
		terminated
			? JSON.stringify({
					__lobu_sdk_dispatch: 1,
					ok: false,
					error: {
						name: terminalState.name,
						message: terminalState.message,
					},
				})
			: null;

	/**
	 * Terminal failure: the guest sent an oversized single message, exhausted
	 * call quota, or bypassed a saturated console bridge. A thrown error would
	 * not help — the guest can catch it and loop, and every loop iteration still
	 * crosses a payload. Disposing the isolate makes the failure uncatchable.
	 */
	function terminateRun(name: string, message: string): void {
		if (terminated) return;
		terminalState.name = name;
		terminalState.message = message;
		terminated = true;
		try {
			if (isolate && !isolate.isDisposed) {
				// A guest parked on `await __sdk_dispatch` is NOT executing, so
				// terminateExecution() no-ops there. Disposing the isolate rejects
				// the pending run instead — the only way to stop a guest that
				// would otherwise keep crossing payloads until the wall-clock
				// timeout.
				isolate.dispose();
			}
		} catch {
			// Isolate already finished; the terminal state carries the failure.
		}
	}

	/** True when the single message fits the per-message cap; otherwise the run is terminated. */
	function guardMessage(json: string): boolean {
		if (Buffer.byteLength(json, "utf8") <= limits.messageBytes) return true;
		terminateRun("OutputSizeExceeded", oversizeMessage);
		return false;
	}

	/**
	 * Bounded trace appender: keeps a strict serialized-byte budget on a trace
	 * array by dropping the OLDEST entries (failures are at the tail) and
	 * counting what it drops. Brackets and commas are included so the retained
	 * array can never serialize beyond the budget. A single entry that does not
	 * fit even alone is dropped and counted.
	 */
	function makeTraceAppender(budget: number) {
		let used = 2; // JSON array brackets
		let dropped = 0;
		return {
			dropped: () => dropped,
			append(target: SdkCallTraceEntry[], entry: SdkCallTraceEntry): void {
				const entryBytes = jsonBytes(entry);
				if (entryBytes + 2 > budget) {
					dropped++;
					return;
				}
				target.push(entry);
				used += entryBytes + (target.length > 1 ? 1 : 0); // comma
				while (used > budget && target.length > 0) {
					const removed = target.shift()!;
					used -= jsonBytes(removed) + (target.length > 0 ? 1 : 0);
					dropped++;
				}
			},
		};
	}
	const appendTrace = makeTraceAppender(limits.traceBytes);
	const appendPreview = makeTraceAppender(limits.traceBytes);

	const ivm = await loadIsolatedVm();
	if (!ivm) {
		clearTimeout(abortTimer);
		return {
			success: false,
			logs: [],
			error: {
				name: "RuntimeUnavailable",
				message:
					"isolated-vm is not installed for this platform. Install with `bun install` on a supported Node version (22–24 with prebuilt binaries, or any version with python3 + build-essential available).",
			},
			durationMs: Date.now() - started,
			sdkCalls: 0,
			skippedCalls: 0,
			traceDropped: 0,
			sdkCallTrace,
			startedSideEffects: [...startedSideEffects.entries()].map(
				([path, { access, count }]) => ({ path, access, count }),
			),
			requiredMcpScopes: [...requiredMcpScopes],
			sideEffectPreview,
		};
	}

	let compiled: string;
	let SourceCompileErrorClass:
		| typeof import("../utils/compiler-core").SourceCompileError
		| undefined;
	try {
		// Deferred: `compiler-core` pulls in esbuild and resolves the connector
		// SDK entry at module scope, neither of which a run-free process needs.
		const {
			compileSource,
			computeCodeHash,
			ISOLATE_LANE_BUILD_OPTIONS,
			SourceCompileError,
		} = await import("../utils/compiler-core");
		SourceCompileErrorClass = SourceCompileError;
		// Compilation is `mkdtemp` + `writeFile` + a full esbuild bundle + read
		// back — filesystem I/O and a bundler per call. Measured locally, a cold
		// `runScript` costs 6–25ms end to end where a memo hit costs ~3ms, so
		// compilation, not the isolate, is the bulk of a short run. That was
		// affordable while the only callers were automation reactions (once per
		// window) and `sdk_run` (once per agent turn); anything that runs per
		// entity write would pay it on every write.
		//
		// Source text is the whole compile input, so its hash is a total cache
		// key. Process-local by design: this memoizes a pure function, it does
		// not hold shared state, so replicas diverging is not a correctness
		// concern (cf. AGENTS.md on Postgres-mediated state).
		const cacheKey = computeCodeHash(options.source);
		const cached = compiledSourceCache.get(cacheKey);
		if (cached !== undefined) {
			// Refresh LRU recency.
			compiledSourceCache.delete(cacheKey);
			compiledSourceCache.set(cacheKey, cached);
			compiled = cached.code;
		} else {
			const result = await compileSource(options.source, {
				tmpPrefix: ".execute-compile-",
				label: "ExecuteCompiler",
				buildOptions: ISOLATE_LANE_BUILD_OPTIONS,
			});
			compiled = result.compiledCode;
			const bytes = Buffer.byteLength(compiled, "utf8");
			// Two concurrent runs of one new source both compile and both land
			// here; without discounting the entry the loser already stored, the
			// byte counter would over-count permanently and eventually evict on
			// every insert.
			compiledSourceCacheBytes -=
				compiledSourceCache.get(cacheKey)?.bytes ?? 0;
			compiledSourceCache.set(cacheKey, { code: compiled, bytes });
			compiledSourceCacheBytes += bytes;
			while (
				compiledSourceCache.size > COMPILED_SOURCE_CACHE_MAX_ENTRIES ||
				compiledSourceCacheBytes > COMPILED_SOURCE_CACHE_MAX_BYTES
			) {
				const oldest = compiledSourceCache.entries().next();
				if (oldest.done) break;
				compiledSourceCache.delete(oldest.value[0]);
				compiledSourceCacheBytes -= oldest.value[1].bytes;
			}
		}
	} catch (err) {
		clearTimeout(abortTimer);
		const isSourceCompileFailure =
			SourceCompileErrorClass !== undefined &&
			err instanceof SourceCompileErrorClass;
		const loc = isSourceCompileFailure
			? err.diagnostics[0]?.location
			: undefined;
		const message = boundScriptErrorText(
			err instanceof Error ? err.message : err,
			MAX_SCRIPT_ERROR_MESSAGE_BYTES,
		);
		return {
			success: false,
			logs,
			error: {
				name: isSourceCompileFailure ? "ValidationError" : "CompileError",
				message,
				code: isSourceCompileFailure ? "VALIDATION" : "INTERNAL",
				retryable: false,
				line: loc?.line,
				column: loc?.column,
			},
			durationMs: Date.now() - started,
			sdkCalls: 0,
			skippedCalls: 0,
			traceDropped: 0,
			sdkCallTrace,
			startedSideEffects: [...startedSideEffects.entries()].map(
				([path, { access, count }]) => ({ path, access, count }),
			),
			requiredMcpScopes: [...requiredMcpScopes],
			sideEffectPreview,
		};
	}

	try {
		isolate = new ivm.Isolate({ memoryLimit: limits.memoryMb });
		const context = await isolate.createContext();
		const jail = context.global;
		await jail.set("global", jail.derefInto());

		await jail.set(
			"__sdk_dispatch",
			new ivm.Reference(async (path: string, payloadJson: string) => {
				// Once terminated, don't run any more SDK work (DB/HTTP).
				if (terminated) {
					return terminalEnvelope();
				}
				sdkCalls++;
				if (sdkCalls > limits.sdkCallQuota) {
					// Quota exhaustion is terminal (uncatchable) so a guest cannot
					// catch the error and keep crossing payloads.
					terminateRun("QuotaExceeded", quotaMessage);
					return terminalEnvelope();
				}
				if (abortController.signal.aborted) {
					throw new Error(
						`TimeoutError: script exceeded ${limits.timeoutMs}ms wall-clock budget`,
					);
				}
				if (!guardMessage(payloadJson)) {
					return terminalEnvelope();
				}

				const { args, orgPath } = JSON.parse(payloadJson) as {
					args: unknown[];
					orgPath: string[];
				};

				// Re-enforce the manifest on the host: reject any method the manifest
				// wouldn't advertise, regardless of run mode (dry-run only skips writes
				// for the modes that have it — it is not an authorization gate).
				if (!allowedDispatchPaths.has(path)) {
					throw new Error(`Unknown SDK method: '${path}'`);
				}
				// Cross-org access is gated here too, not just by the manifest omitting
				// `org` from `topLevel`.
				if (!allowCrossOrg && orgPath.length > 0) {
					throw new Error(
						"CrossOrgAccessDenied: cross-org access is not available here.",
					);
				}

				let target: ClientSDK = baseSdk;
				for (const slug of orgPath) {
					if (
						typeof slug !== "string" ||
						FORBIDDEN_ORG_SLUGS.has(slug) ||
						!Object.hasOwn(target, "org")
					) {
						throw new Error(`Invalid org slug: '${String(slug)}'`);
					}
					target = await target.org(slug);
				}

				const dispatchPromise: Promise<unknown> = (async () => {
					if (path === "log") {
						target.log(
							args[0] as string,
							args[1] as Record<string, unknown> | undefined,
						);
						appendTrace.append(sdkCallTrace, {
							path,
							orgPath,
							access: METHOD_METADATA[path]?.access ?? "unknown",
							args: traceArgs(args),
							skipped: false,
						});
						return undefined;
					}
					if (path === "query") {
						appendTrace.append(sdkCallTrace, {
							path,
							orgPath,
							access: METHOD_METADATA[path]?.access ?? "unknown",
							args: traceArgs(args),
							skipped: false,
						});
						return target.query(args[0] as string, args[1] as Parameters<ClientSDK["query"]>[1]);
					}
					const [ns, method] = path.split(".");
					// `__sdk_dispatch` is a guest-visible global, so a malicious script
					// could call it directly with an inherited path like `entities.constructor`.
					// Restrict to own enumerable namespaces and own methods; the guest-side
					// manifest filter is the friendly path, this is the security backstop.
					if (!ns || !method || !Object.hasOwn(target, ns)) {
						throw new Error(`Unknown SDK namespace: '${ns}'`);
					}
					const namespace = (
						target as unknown as Record<
							string,
							Record<string, (...a: unknown[]) => unknown>
						>
					)[ns];
					if (
						!namespace ||
						typeof namespace !== "object" ||
						!Object.hasOwn(namespace, method) ||
						typeof namespace[method] !== "function"
					) {
						throw new Error(`Unknown SDK method: '${path}'`);
					}
					const access = METHOD_METADATA[path]?.access ?? "unknown";
					// Belt-and-suspenders: in read mode the guest-side manifest already
					// drops non-read methods, but enforce it here too so a future
					// namespace refactor (e.g. class instances) can't silently re-expose
					// the write surface to a read-only script.
					if (sdkMode === "read" && access !== "read") {
						throw new Error(
							`Forbidden: SDK method '${path}' is not allowed in read mode`,
						);
					}
					const trace: SdkCallTraceEntry = {
						path,
						orgPath,
						access,
						args: traceArgs(args),
						skipped: isSkippedUnderDryRun({
							dryRun: options.dryRun,
							dryRunDispatchPaths: options.dryRunDispatchPaths,
							access,
							path,
						}),
					};
					// Skipped (dry-run) calls live only in `side_effect_preview`;
					// dispatched calls only in `sdk_call_trace` — no double shipping.
					if (trace.skipped) {
						const preflight = getSdkPreflight(namespace[method]);
						if (!preflight) throw new Error(`Missing SDK preflight adapter: '${path}'`);
						const result = await preflight(...args);
						const preview = {
							...trace,
							args: traceArgs(result.args),
							required_access: result.required_access,
							authorization_status: result.authorization_status,
						};
						skippedCalls++;
						appendPreview.append(sideEffectPreview, preview);
						return { dry_run: true, skipped_call: path, access };
					}
					// Count change-capable dispatches separately from the trace. The
					// trace is a byte-capped ring that evicts OLDEST entries, so a
					// long run's early writes disappear from it — exactly the runs
					// most likely to time out. This tally is unbounded (one small
					// entry per distinct path, no arguments) so the public
					// started-side-effect summary cannot silently lose them.
					if (access === "write" || access === "external" || access === "admin") {
						startedSideEffects.set(path, {
							access,
							count: (startedSideEffects.get(path)?.count ?? 0) + 1,
						});
					}
					appendTrace.append(sdkCallTrace, trace);
					return namespace[method](...args);
				})();

				let result: unknown;
				try {
					result = await raceAgainstAbort(
						dispatchPromise,
						abortController.signal,
					);
				} catch (error) {
					if (error instanceof McpScopeRequiredError) {
						requiredMcpScopes.add(error.requiredScope);
						const json = JSON.stringify({
							__lobu_sdk_dispatch: 1,
							ok: false,
								error: {
									name: error.name,
									message: error.message,
									classificationToken:
										trustErrorClassification("PERMISSION"),
							},
						});
						return guardMessage(json) ? json : terminalEnvelope();
					}
					if (error instanceof ClientSdkActionError) {
						const code = classifyClientSdkActionResult(error.result);
						const json = JSON.stringify({
							__lobu_sdk_dispatch: 1,
							ok: false,
							error: {
									name: error.name,
									message: error.message,
									details: safeErrorDetails(error.result),
									classificationToken: trustErrorClassification(code),
							},
						});
						return guardMessage(json) ? json : terminalEnvelope();
					}
					if (error instanceof ToolUserError) {
						const code = classifyToolUserError(error);
						const json = JSON.stringify({
							__lobu_sdk_dispatch: 1,
							ok: false,
							error: {
									name: error.name,
									message: error.message,
									classificationToken: trustErrorClassification(code),
							},
						});
						return guardMessage(json) ? json : terminalEnvelope();
					}
					if (isToolError(error)) {
						const json = JSON.stringify({
							__lobu_sdk_dispatch: 1,
							ok: false,
							error: {
									name: error.name,
									message: error.message,
									classificationToken:
										trustErrorClassification(error.code),
							},
						});
						return guardMessage(json) ? json : terminalEnvelope();
					}
					throw error;
				}
				const json = JSON.stringify({
					__lobu_sdk_dispatch: 1,
					ok: true,
					has_value: result !== undefined,
					...(result === undefined ? {} : { value: result }),
				});
				return guardMessage(json) ? json : terminalEnvelope();
			}),
		);

		await jail.set(
			"__console_call",
			new ivm.Reference((level: "log" | "warn" | "error", message: string) => {
				// A single pathological message crosses the whole string; terminate.
				if (!guardMessage(message)) return false;
				if (logFull) {
					// The normal guest console disables itself on the first false return.
					// Reaching the host again means the script bypassed that latch.
					terminateRun("OutputSizeExceeded", consoleFloodMessage);
					return false;
				}
				const bytes = Buffer.byteLength(message, "utf8");
				if (logBytesUsed + bytes > limits.logBytes) {
					logFull = true;
					logs.push({
						level: "warn",
						message: `[console output truncated: exceeded ${limits.logBytes} bytes]`,
						ts: Date.now(),
					});
					return false;
				}
				logBytesUsed += bytes;
				logs.push({ level, message, ts: Date.now() });
				return true;
			}),
		);

		await jail.set(
			"__sleep",
			new ivm.Reference(async (ms: number) => {
				await sleepAgainstAbort(ms, abortController.signal);
			}),
		);

		await jail.set("__ctx_json", JSON.stringify(options.context ?? {}));
		await jail.set(
			"__extra_args_json",
			JSON.stringify(options.extraArgs ?? []),
		);
		await jail.set("__sdk_manifest_json", JSON.stringify(manifest));
		if (options.extractExport) {
			await jail.set("__extract_name", options.extractExport);
		}

		const errorTokenReader = `__lobu_take_error_token_${randomUUID().replaceAll("-", "")}`;
		const script = await isolate.compileScript(
			`${guestPreamble(errorTokenReader)}\n${compiled}\n${options.extractExport ? EXTRACT_RUNNER : guestRunner(errorTokenReader)}`,
		);
		const returnJson = (await withTimeout(
			script.run(context, {
				timeout: limits.timeoutMs,
				promise: true,
				copy: true,
			}) as Promise<string | null>,
			limits.timeoutMs,
		)) as string | null;
		if (terminated) {
			throw new Error(terminalState.message);
		}
		if (returnJson) {
			const envelopeBytes = Buffer.byteLength(returnJson, "utf8");
			// `extractExport` reads a JSON Schema; a partially-cut schema would
			// parse as a valid-but-wrong contract, so that path keeps hard-fail.
			if (options.extractExport && envelopeBytes > limits.outputBytes) {
				throw new Error(
					`OutputSizeExceeded: extracted export exceeded ${limits.outputBytes} bytes`,
				);
			}
			// An interactive return crosses the whole envelope to the host before
			// previewing, so bound that copy BEFORE parsing: a huge return can
			// otherwise force an arbitrarily large host JSON.parse.
			if (!options.extractExport && envelopeBytes > limits.messageBytes) {
				throw new Error(oversizeMessage);
			}
		}
		const parsedResult = returnJson ? JSON.parse(returnJson) : null;
		if (!options.extractExport) {
			if (
				!parsedResult ||
				typeof parsedResult !== "object" ||
				parsedResult.__lobu_script_result !== 1
			) {
				throw new Error("InvalidScriptResultEnvelope");
			}
			if (parsedResult.ok !== true) {
				const scriptError = parsedResult.error as
					| {
							name?: string;
							message?: string;
							stack?: string;
							details?: unknown;
							classificationToken?: string;
					  }
					| undefined;
				return {
					success: false,
					logs,
					error: classifyRuntimeError(
						scriptError ?? {},
						trustedErrorClassifications,
					),
					durationMs: Date.now() - started,
					sdkCalls,
					skippedCalls,
					traceDropped: appendTrace.dropped() + appendPreview.dropped(),
					sdkCallTrace,
					startedSideEffects: [...startedSideEffects.entries()].map(
						([path, { access, count }]) => ({ path, access, count }),
					),
					requiredMcpScopes: [...requiredMcpScopes],
					sideEffectPreview,
				};
			}
		}
		const returnValue = options.extractExport
			? parsedResult
			: parsedResult.value;

		// An oversized interactive return becomes a bounded preview, never the
		// value: the model reads the head to decide what to query, and the
		// `returnTruncated` report tells it the data is partial (query it, don't
		// re-dump). extractExport keeps the full value (already hard-failed above).
		let returnValuePreview: string | undefined;
		let returnTruncated: ReturnPreviewInfo | undefined;
		if (!options.extractExport) {
			const valueJson = JSON.stringify(returnValue);
			if (valueJson !== undefined) {
				const totalBytes = Buffer.byteLength(valueJson, "utf8");
				if (totalBytes > limits.outputBytes) {
					const built = buildReturnPreview(
						valueJson,
						totalBytes,
						Math.min(MAX_RETURN_PREVIEW_BYTES, limits.outputBytes),
					);
					returnValuePreview = built.preview;
					returnTruncated = built.info;
				}
			}
		}

		return {
			success: true,
			...(!options.extractExport
				? { didReturnValue: parsedResult.has_value === true }
				: {}),
			...(returnValuePreview !== undefined
				? { returnValuePreview, returnTruncated }
				: { returnValue }),
			logs,
			durationMs: Date.now() - started,
			sdkCalls,
			skippedCalls,
			traceDropped: appendTrace.dropped() + appendPreview.dropped(),
			sdkCallTrace,
			startedSideEffects: [...startedSideEffects.entries()].map(
				([path, { access, count }]) => ({ path, access, count }),
			),
			requiredMcpScopes: [...requiredMcpScopes],
			sideEffectPreview,
		};
	} catch (err) {
		// A terminal failure disposes the isolate, which rejects with a raw
		// termination error — report the terminal reason instead.
		const e = (terminated ? new Error(terminalState.message) : err) as Error;
		return {
			success: false,
			logs,
			error: classifyRuntimeError(e),
			durationMs: Date.now() - started,
			sdkCalls,
			skippedCalls,
			traceDropped: appendTrace.dropped() + appendPreview.dropped(),
			sdkCallTrace,
			startedSideEffects: [...startedSideEffects.entries()].map(
				([path, { access, count }]) => ({ path, access, count }),
			),
			requiredMcpScopes: [...requiredMcpScopes],
			sideEffectPreview,
		};
	} finally {
		clearTimeout(abortTimer);
		if (isolate && !isolate.isDisposed) {
			isolate.dispose();
		}
	}
}
