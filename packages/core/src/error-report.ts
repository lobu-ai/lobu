/**
 * Error grouping for telemetry: one function decides which issue a failure
 * belongs to, for spans and log records alike.
 *
 * The fingerprint follows Sentry's grouping rules: hash the parts that identify
 * the defect and none that vary per occurrence. A stack groups by the names of
 * its in-app functions, never by line numbers, which move on every deploy. A
 * failure without a usable stack groups by where it was reported and its
 * message after every identifier, number and quoted value is replaced by a
 * placeholder, so one defect affecting many users or rows stays one issue.
 *
 * Raw messages can carry credentials or source data, so the report keeps only
 * the parameterized message and the stack's frame locations. Both pass through
 * the diagnostic scrubber first.
 */

import { createHash } from "node:crypto";
import { scrubDiagnosticValue } from "./utils/diagnostic-scrubber";

/** Bump when grouping changes, so old and new fingerprints are never compared. */
export const ERROR_GROUPING_VERSION = 1;

/**
 * Who has to act: `user` is an expected rejection of the caller's input or
 * access, `dependency` is a provider or upstream failing, `system` is ours.
 */
export type ErrorKind = "system" | "user" | "dependency";

export interface StackFrame {
  function: string | null;
  file: string;
  line: number | null;
  column: number | null;
  inApp: boolean;
}

export interface ErrorReport {
  type: string;
  code: string | null;
  kind: ErrorKind;
  /** Parameterized and scrubbed; safe to store. */
  message: string;
  /** Frame locations only, one per line; no message text. */
  stacktrace: string;
  fingerprint: string;
  /** The exact string that was hashed, for explaining a grouping decision. */
  grouping: string;
}

const MAX_MESSAGE_INPUT = 8192;
const MAX_MESSAGE_OUTPUT = 300;
const MAX_STACK_FRAMES = 30;
/**
 * A stack starts with the error's message, which can hold untrusted text of
 * any size. The frame patterns backtrack, so only a bounded prefix is read and
 * any line longer than a real frame is skipped before a pattern touches it.
 */
const MAX_STACK_INPUT = 64 * 1024;
const MAX_STACK_LINES = 200;
const MAX_FRAME_LINE = 512;
const GROUPING_FRAMES = 3;

/**
 * Ordered like Sentry's parameterizer (`grouping/parameterization.py`): the
 * more specific shapes run first so a URL is not half-eaten by the number rule.
 */
const PARAMETERS: ReadonlyArray<readonly [string, RegExp]> = [
  // An HTTP credential in free text: the scrubber only knows keyed values.
  ["token", /\b(?:bearer|basic)\s+[\w.~+/-]+=*/gi],
  ["email", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ["url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi],
  ["traceparent", /\b[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}\b/gi],
  [
    "uuid",
    /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi,
  ],
  ["hash", /\b[0-9a-f]{32,64}\b/gi],
  [
    "date",
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  ],
  ["ip", /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g],
  ["hex", /\b0x[0-9a-f]+\b/gi],
  // Generated identifiers: run, conversation and token ids mix letters and
  // digits, so a 12+ character run with a digit is an id; requiring the digit
  // spares long ordinary words. Any 24+ character run is treated as an id too,
  // since secrets are not guaranteed to contain a digit and no word is that long.
  ["id", /\b(?:(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{12,}|[\w-]{24,})\b/gi],
  ["quoted", /"[^"\n]{0,200}"|'[^'\n]{0,200}'|`[^`\n]{0,200}`/g],
  ["num", /-?\b\d+(?:\.\d+)?/g],
];

/** Replace every per-occurrence value in a message with a named placeholder. */
export function parameterizeMessage(text: string): string {
  if (!text) return "";
  let out =
    text.length > MAX_MESSAGE_INPUT ? text.slice(0, MAX_MESSAGE_INPUT) : text;
  out = String(scrubDiagnosticValue(out));
  for (const [name, pattern] of PARAMETERS) {
    out = out.replace(pattern, `<${name}>`);
  }
  out = out.split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
  return out.length > MAX_MESSAGE_OUTPUT
    ? out.slice(0, MAX_MESSAGE_OUTPUT)
    : out;
}

const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const V8_FRAME_NO_POSITION = /^\s*at (?:(.+?) \()?([^():]+)\)?\s*$/;

/**
 * Make a frame's file portable: relative to the repo for workspace code, to
 * `node_modules/` for dependencies, and the bare file name for any other
 * absolute path, so no machine's checkout or home directory is recorded.
 */
function normalizeFile(raw: string): string {
  const file = raw.replace(/^file:\/\//, "");
  const dependency = file.lastIndexOf("/node_modules/");
  if (dependency >= 0) return file.slice(dependency + 1);
  const workspace = file.indexOf("/packages/");
  if (workspace >= 0) return file.slice(workspace + 1);
  if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) {
    return file.split(/[\\/]/).pop() || file;
  }
  return file;
}

function isInAppFile(file: string): boolean {
  return !(
    file.includes("node_modules/") ||
    file.startsWith("node:") ||
    file.startsWith("internal/") ||
    file === "native" ||
    file === "<anonymous>"
  );
}

function normalizeFunction(raw: string | undefined): string | null {
  if (!raw) return null;
  const fn = raw
    .replace(/^async /, "")
    .replace(/ \[as [^\]]+\]$/, "")
    .trim();
  return fn && fn !== "<anonymous>" ? fn : null;
}

/** Parse a V8/Bun stack into frames, outermost last. Message lines are skipped. */
export function parseStackFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const lines = stack.slice(0, MAX_STACK_INPUT).split("\n", MAX_STACK_LINES);
  for (const line of lines) {
    if (line.length > MAX_FRAME_LINE) continue;
    const match = V8_FRAME.exec(line);
    if (match) {
      const file = normalizeFile(match[2] ?? "");
      frames.push({
        function: normalizeFunction(match[1]),
        file,
        line: Number(match[3]),
        column: Number(match[4]),
        inApp: isInAppFile(file),
      });
    } else {
      const bare = V8_FRAME_NO_POSITION.exec(line);
      if (!bare) continue;
      const file = normalizeFile(bare[2] ?? "");
      frames.push({
        function: normalizeFunction(bare[1]),
        file,
        line: null,
        column: null,
        inApp: isInAppFile(file),
      });
    }
    if (frames.length >= MAX_STACK_FRAMES) break;
  }
  return frames;
}

function formatFrames(frames: StackFrame[]): string {
  return frames
    .map((frame) => {
      const position =
        frame.line == null
          ? frame.file
          : `${frame.file}:${frame.line}:${frame.column}`;
      return frame.function
        ? `at ${frame.function} (${position})`
        : `at ${position}`;
    })
    .join("\n");
}

/**
 * Frames that identify the defect: in-app, named, and not the error's own
 * constructor (`new ToolUserError`), which every throw site of a class shares.
 */
function groupingFrames(frames: StackFrame[]): string[] {
  return frames
    .filter(
      (frame) =>
        frame.inApp && frame.function && !frame.function.startsWith("new ")
    )
    .slice(0, GROUPING_FRAMES)
    .map((frame) => frame.function as string);
}

const USER_TOOL_CODES = new Set([
  "AUTH_MISSING",
  "BROWSER_INTERRUPTED",
  "NOT_FOUND",
  "VALIDATION",
  "PERMISSION",
  "MANUAL_EDIT_NOT_ALLOWED",
  "PRECONDITION_FAILED",
  "APPROVAL_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
]);
const DEPENDENCY_TOOL_CODES = new Set([
  "AUTH_INVALID",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_5XX",
  "NETWORK",
  "UPSTREAM_UNAVAILABLE",
]);

/** Derive the kind from structure only: a code or an HTTP status, never prose. */
export function classifyErrorKind(
  code: string | null,
  httpStatus: number | null
): ErrorKind {
  if (code) {
    if (USER_TOOL_CODES.has(code)) return "user";
    if (DEPENDENCY_TOOL_CODES.has(code) || code.startsWith("PROVIDER_"))
      return "dependency";
  }
  if (httpStatus != null) return httpStatus < 500 ? "user" : "system";
  return "system";
}

/**
 * A structured code: upper-case or numeric (`VALIDATION`, `ERR_X`, SQLSTATE
 * `23505`) or lower-case snake case. Digits are allowed only in the first form,
 * so a generated id or credential in a `code` field is never kept.
 */
function isErrorCode(value: string): boolean {
  return /^(?:[A-Z0-9][A-Z0-9_]{1,63}|[a-z][a-z_]{1,63})$/.test(value);
}

interface ErrorShape {
  name?: unknown;
  /** pino's `err` serializer writes the class name here instead of `name`. */
  type?: unknown;
  message?: unknown;
  stack?: unknown;
  code?: unknown;
  httpStatus?: unknown;
  statusCode?: unknown;
  status?: unknown;
}

function readStatus(shape: ErrorShape): number | null {
  for (const value of [shape.httpStatus, shape.statusCode, shape.status]) {
    if (typeof value === "number" && value >= 100 && value <= 599) return value;
  }
  return null;
}

export interface DescribeErrorOptions {
  /**
   * Where the failure was reported, e.g. `tool query_sql` or a logger's
   * service. Groups failures that carry no usable stack.
   */
  scope: string;
  /** Overrides the derived kind when the boundary knows better. */
  kind?: ErrorKind;
}

/** Build the stored report and fingerprint for a thrown value or error-shaped object. */
export function describeError(
  error: unknown,
  options: DescribeErrorOptions
): ErrorReport {
  const shape: ErrorShape =
    error && typeof error === "object"
      ? (error as ErrorShape)
      : { message: String(error) };
  const type =
    typeof shape.name === "string" && shape.name
      ? shape.name
      : typeof shape.type === "string" && shape.type
        ? shape.type
        : error instanceof Error
          ? error.constructor.name
          : typeof error === "string"
            ? "Message"
            : "UnknownError";
  const code =
    typeof shape.code === "string" && isErrorCode(shape.code)
      ? shape.code
      : null;
  const message = parameterizeMessage(
    typeof shape.message === "string" ? shape.message : ""
  );
  const frames =
    typeof shape.stack === "string" ? parseStackFrames(shape.stack) : [];
  const kind = options.kind ?? classifyErrorKind(code, readStatus(shape));

  const identity = groupingFrames(frames);
  const parts =
    identity.length > 0
      ? [
          `v${ERROR_GROUPING_VERSION}`,
          type,
          code ?? "",
          `frames:${identity.join(">")}`,
        ]
      : [
          `v${ERROR_GROUPING_VERSION}`,
          options.scope,
          type,
          code ?? "",
          `message:${message}`,
        ];
  const grouping = parts.join("|");
  return {
    type,
    code,
    kind,
    message,
    stacktrace: formatFrames(frames),
    fingerprint: createHash("sha256")
      .update(grouping)
      .digest("hex")
      .slice(0, 32),
    grouping,
  };
}

/** Span attributes for a report, using OpenTelemetry's exception conventions. */
export function errorReportAttributes(
  report: ErrorReport
): Record<string, string> {
  return {
    "exception.type": report.type,
    "exception.message": report.message,
    ...(report.stacktrace ? { "exception.stacktrace": report.stacktrace } : {}),
    ...(report.code ? { "error.code": report.code } : {}),
    "error.kind": report.kind,
    "error.fingerprint": report.fingerprint,
    "error.grouping": report.grouping,
  };
}

function isErrorShaped(value: unknown): value is ErrorShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const shape = value as ErrorShape;
  return (
    typeof shape.message === "string" &&
    (typeof shape.stack === "string" || typeof shape.name === "string")
  );
}

/** First error-shaped value in a log record's conventional slots, depth-bounded. */
function findLoggedError(value: unknown, depth = 0): ErrorShape | null {
  if (depth > 3 || !value || typeof value !== "object") return null;
  if (isErrorShaped(value)) return value;
  const candidates = Array.isArray(value)
    ? value
    : ["err", "error", "data", "cause"].map(
        (key) => (value as Record<string, unknown>)[key]
      );
  for (const candidate of candidates) {
    const found = findLoggedError(candidate, depth + 1);
    if (found) return found;
  }
  return null;
}

const ERROR_LEVELS = new Set(["error", "fatal"]);

/**
 * Stamp an error-level log record with its issue fingerprint. Both server
 * loggers call this on the final record, so a failure logged through either
 * groups the same way as the span that recorded it.
 */
export function annotateErrorLogRecord(record: Record<string, unknown>): void {
  if (typeof record.level !== "string" || !ERROR_LEVELS.has(record.level))
    return;
  // A writer that already described its error (with the scope of the span it
  // fails in) keeps that grouping instead of the generic log-line one.
  if (typeof record.error_fingerprint === "string") return;
  const service =
    typeof record.service === "string" ? record.service : "unknown";
  const logged = findLoggedError(record);
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.msg === "string"
        ? record.msg
        : "";
  const report = describeError(logged ?? { name: "LoggedError", message }, {
    scope: `log ${service}`,
  });
  Object.assign(record, errorReportLogFields(report));
}

/**
 * The log-record fields for one report: the same safe fields a span carries,
 * so a consumer of the log never needs the raw message to title or explain
 * the issue. A writer that stamps these keeps them through the annotator.
 */
export function errorReportLogFields(
  report: ErrorReport
): Record<string, string> {
  return {
    error_fingerprint: report.fingerprint,
    error_type: report.type,
    error_kind: report.kind,
    error_message: report.message,
    error_grouping: report.grouping,
    ...(report.code ? { error_code: report.code } : {}),
  };
}
