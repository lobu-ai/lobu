/**
 * Auth-aware HTTP client for connectors.
 *
 * Small fetch-based helper that centralizes the boilerplate every API-backed
 * connector hand-rolls: `Authorization: Bearer` headers, `withHttpRetry`
 * wrapping (exponential backoff with jitter), bounded honoring of 429
 * `Retry-After`, and descriptive errors that include the status code and a
 * truncated response body.
 */

import type { SyncCredentials } from './connector-types.js';
import { isTransientStatus, withHttpRetry } from './retry.js';
import { sleep } from './sleep.js';

/** Methods RFC 9110 §9.2.2 defines as idempotent: repeating one has the effect of sending it once. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']);

const BODY_PREVIEW_CHARS = 500;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

/** Error thrown for non-2xx responses. Message: `<prefix> <METHOD> <url> failed (<status>): <truncated body>`. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly method: string;
  /** Response body, truncated to the first 500 characters. */
  readonly bodyText: string;

  constructor(params: {
    prefix: string;
    method: string;
    url: string;
    status: number;
    statusText: string;
    bodyText: string;
  }) {
    super(
      `${params.prefix} ${params.method} ${params.url} failed (${params.status}): ${params.bodyText}`
    );
    this.name = 'HttpStatusError';
    this.status = params.status;
    this.statusText = params.statusText;
    this.url = params.url;
    this.method = params.method;
    this.bodyText = params.bodyText;
  }
}

interface HttpClientRetryOptions {
  operation?: string;
  context?: Record<string, any>;
  onRetry?: (error: Error, attempt: number) => void;
}

/** `RequestInit` plus the one hint retrying needs from the caller. */
export interface HttpRequestInit extends RequestInit {
  /**
   * The request is safe to repeat although its method is not idempotent — a
   * GraphQL query or a search sent as POST. Without it a POST/PATCH is retried
   * only on a 429, never on a 5xx or a dropped connection, because those do not
   * say whether the server already acted on it (a sent email, a created issue).
   */
  idempotent?: boolean;
}

export interface CreateHttpClientOptions {
  /**
   * Static bearer token shorthand: sent as `Authorization: Bearer <token>`
   * (unless the request already sets one). Use this when the token never
   * changes for the client's lifetime; for refresh/rotation use
   * `getAccessToken`. Ignored when `getAccessToken` is also set.
   */
  token?: string;
  /**
   * Called once per request; a truthy return value is sent as
   * `Authorization: Bearer <token>` (unless the request already sets one).
   */
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Static headers applied to every request (per-request headers win). */
  headers?: Record<string, string>;
  /** `withHttpRetry` options, or `false` to disable retrying entirely. */
  retry?: HttpClientRetryOptions | false;
  /** Prefix for error messages, e.g. `'Spotify API'`. Default `'HTTP'`. */
  errorPrefix?: string;
  /** Upper bound when honoring a 429 `Retry-After` header. Default 30s. */
  maxRetryAfterMs?: number;
}

export interface HttpClient {
  /**
   * Fetch with auth + retry, resolving with the raw `Response` for non-2xx
   * statuses so callers can keep their own `response.ok` handling. Transient
   * statuses (408, 429, 5xx — see `classifyToolError`) still throw to drive the
   * retry loop, so they surface as a thrown `HttpStatusError` once retries are
   * exhausted.
   */
  raw(url: string, init?: HttpRequestInit): Promise<Response>;
  /** Fetch with auth + retry; throws `HttpStatusError` on any non-2xx status. */
  request(url: string, init?: HttpRequestInit): Promise<Response>;
  /** `request()` + parse the response body as JSON (any method via `init`). */
  json<T>(url: string, init?: HttpRequestInit): Promise<T>;
  /** GET returning parsed JSON. */
  get<T>(url: string, init?: HttpRequestInit): Promise<T>;
  /** POST `body` as JSON (unless a Content-Type is supplied) returning parsed JSON. */
  post<T>(url: string, body?: unknown, init?: HttpRequestInit): Promise<T>;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? seconds * 1000 : null;
  }
  const deltaMs = Date.parse(value) - Date.now();
  return Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : null;
}

export function createHttpClient(options: CreateHttpClientOptions = {}): HttpClient {
  const errorPrefix = options.errorPrefix ?? 'HTTP';
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const retryEnabled = options.retry !== false;
  const retryOptions = options.retry === false ? undefined : options.retry;

  async function buildHeaders(init?: HttpRequestInit): Promise<Headers> {
    const headers = new Headers(options.headers);
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    if (!headers.has('authorization')) {
      const token = options.getAccessToken ? await options.getAccessToken() : options.token;
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    return headers;
  }

  async function statusError(
    response: Response,
    method: string,
    url: string
  ): Promise<HttpStatusError> {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      /* body unavailable — keep the status-only message */
    }
    if (bodyText.length > BODY_PREVIEW_CHARS) {
      bodyText = `${bodyText.slice(0, BODY_PREVIEW_CHARS)}…`;
    }
    return new HttpStatusError({
      prefix: errorPrefix,
      method,
      url,
      status: response.status,
      statusText: response.statusText,
      bodyText,
    });
  }

  async function attempt(
    url: string,
    init: HttpRequestInit | undefined,
    throwOnAnyError: boolean
  ): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = await buildHeaders(init);
    const { idempotent: _idempotent, ...fetchInit } = init ?? {};
    const response = await fetch(url, { ...fetchInit, headers });
    if (response.ok) return response;

    if (isTransientStatus(response.status)) {
      const error = await statusError(response, method, url);
      if (response.status === 429 && retryEnabled) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
        if (retryAfterMs) await sleep(Math.min(retryAfterMs, maxRetryAfterMs));
      }
      throw error;
    }

    if (throwOnAnyError) throw await statusError(response, method, url);
    return response;
  }

  function withRetry(
    init: HttpRequestInit | undefined,
    fn: () => Promise<Response>
  ): Promise<Response> {
    if (!retryEnabled) return fn();
    const method = (init?.method ?? 'GET').toUpperCase();
    return withHttpRetry(fn, {
      operation: `${errorPrefix} request`,
      ...retryOptions,
      repeatable: IDEMPOTENT_METHODS.has(method) || init?.idempotent === true,
    });
  }

  const raw = (url: string, init?: HttpRequestInit) =>
    withRetry(init, () => attempt(url, init, false));
  const request = (url: string, init?: HttpRequestInit) =>
    withRetry(init, () => attempt(url, init, true));

  const json = async <T>(url: string, init?: HttpRequestInit): Promise<T> => {
    const response = await request(url, init);
    return (await response.json()) as T;
  };

  const get = <T>(url: string, init?: HttpRequestInit): Promise<T> =>
    json<T>(url, { ...init, method: 'GET' });

  const post = <T>(url: string, body?: unknown, init: HttpRequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('Content-Type', 'application/json');
    return json<T>(url, {
      ...init,
      method: 'POST',
      headers,
      body: body === undefined ? init.body : JSON.stringify(body),
    });
  };

  return { raw, request, json, get, post };
}

export interface RequireBearerClientOptions {
  /** Prefix for error messages, e.g. `'Spotify API'`. Default `'HTTP'`. */
  errorPrefix?: string;
  /**
   * Human-readable connector name for the missing-auth error message
   * (`'<label> requires OAuth authentication.'`). Defaults to `errorPrefix`.
   */
  label?: string;
  /** Static headers applied to every request (per-request headers win). */
  headers?: Record<string, string>;
}

/**
 * Resolve a connector's OAuth bearer token and build an auth-aware
 * `HttpClient` for it. Throws if `credentials.accessToken` is missing — the
 * preamble every OAuth-backed connector hand-rolls. For connectors that fall
 * back to an app-only token or an API key, keep the custom resolution and call
 * `createHttpClient({ token })` directly.
 */
export function requireBearerClient(
  credentials: SyncCredentials | null,
  options: RequireBearerClientOptions = {}
): HttpClient {
  const accessToken = credentials?.accessToken;
  if (!accessToken) {
    const label = options.label ?? options.errorPrefix ?? 'This connector';
    throw new Error(`${label} requires OAuth authentication.`);
  }
  return createHttpClient({
    token: accessToken,
    errorPrefix: options.errorPrefix,
    headers: options.headers,
  });
}
