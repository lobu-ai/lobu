class CliError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class ValidationError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "ValidationError";
  }
}

export class ApiError extends CliError {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message, 3);
    this.name = "ApiError";
  }
}

/**
 * True when an already-printed tool result payload reports failure, so the
 * command can exit non-zero without changing its stdout contract (the JSON
 * still parses — `gh`/`kubectl -o json` semantics, not curl's). Three shapes:
 * - MCP `tools/call` failures, marked `isError` at the protocol boundary;
 * - `run_sdk` script failures, reported as data (`success` is a required
 *   field of the script result) — the tool ran fine, the script did not;
 * - REST-proxy soft failures, a top-level `error` string. This mirrors the
 *   server's `isSoftErrorResult` (server/src/tools/execute.ts); kept as a
 *   local predicate so the CLI never imports server sources.
 */
export function isFailedToolPayload(
  tool: string | undefined,
  result: unknown
): boolean {
  if (typeof result !== "object" || result === null) return false;
  const payload = result as {
    isError?: unknown;
    success?: unknown;
    error?: unknown;
  };
  if (payload.isError === true) return true;
  if (tool === "run_sdk" && payload.success === false) return true;
  return typeof payload.error === "string" && payload.error.length > 0;
}

/**
 * Parse `raw` as a JSON object, throwing {@link ValidationError} when it is not
 * valid JSON or not a top-level object (arrays and primitives are rejected).
 * `label` names the source for the error messages, e.g. `"on stdin"` or
 * `` `in ${path}` ``.
 */
export function parseJsonObject(
  raw: string,
  label: string
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(`Invalid JSON ${label}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError(
      `JSON ${label} must be a top-level object (got array or primitive).`
    );
  }
  return parsed as Record<string, unknown>;
}
