/**
 * Shared HTTP transport for every CLI client (Agent API, `lobu apply`, the
 * memory MCP REST proxy). Centralizes three things that used to
 * be hand-rolled per client:
 *
 *   1. a default request timeout (`AbortSignal.timeout`) so a hung server never
 *      wedges the CLI forever;
 *   2. a small bounded retry on transient network errors / 5xx for *idempotent*
 *      GETs only;
 *   3. JSON response parsing + a single superset error extractor.
 *
 * Each caller keeps its own error class (`ApiClientError` / `ApiError` / plain
 * `Error`) and response shape — this module only owns the wire layer.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const IDEMPOTENT_GET_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Perform a fetch with a default timeout and a bounded retry on transient
 * failures. Retries apply only to `GET` (idempotent) and only for network
 * errors or 5xx responses — 4xx and non-GET methods surface on the first try.
 *
 * A caller-supplied `signal` (or `init.signal`) is respected; we only inject a
 * timeout signal when none was provided, so explicit cancellation still works.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    retries?: number;
  } = {}
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const method = (init.method ?? "GET").toUpperCase();
  const retries =
    options.retries ?? (method === "GET" ? IDEMPOTENT_GET_RETRIES : 0);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const requestInit: RequestInit = init.signal
      ? init
      : { ...init, signal: AbortSignal.timeout(timeoutMs) };
    try {
      const response = await fetchImpl(url, requestInit);
      // Retry only transient 5xx on GET; everything else is the caller's to map.
      if (response.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Read a response body as JSON. Returns `undefined` for 204 / empty bodies.
 * On a parse failure of a *successful* response, calls `onInvalidJson` (so each
 * client throws its own error type); for a failed response it returns
 * `{ error: raw }` so the error extractor can still surface the raw text.
 */
export async function parseJsonResponse(
  response: Response,
  url: string,
  onInvalidJson: (message: string) => never
): Promise<unknown> {
  if (response.status === 204) return undefined;
  const raw = await response.text();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (!response.ok) return { error: raw };
    onInvalidJson(`Invalid JSON from ${url}: ${raw.slice(0, 500)}`);
  }
}

function pickString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

/**
 * Single superset error extractor for every CLI client. Pulls a message (and
 * optional code) out of the common server error envelopes:
 *   - `{ error: "msg" }` (+ optional `error_description` / `message` / `code`)
 *   - `{ error: { message, code } }`
 *   - `{ message }`
 *   - `{ error_description }`
 * Falls back to `HTTP <status> <statusText>`.
 */
export function extractApiError(
  parsed: unknown,
  status: number,
  statusText: string
): { message: string; code?: string } {
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (typeof record.error === "string") {
      return {
        message:
          pickString(record, "error_description") ??
          pickString(record, "message") ??
          record.error,
        code: pickString(record, "code") ?? record.error,
      };
    }
    if (record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>;
      return {
        message: pickString(error, "message") ?? `HTTP ${status} ${statusText}`,
        code: pickString(error, "code"),
      };
    }
    if (typeof record.message === "string") {
      return { message: record.message, code: pickString(record, "code") };
    }
    if (typeof record.error_description === "string") {
      return {
        message: record.error_description,
        code: pickString(record, "error"),
      };
    }
  }
  return { message: `HTTP ${status} ${statusText}` };
}
