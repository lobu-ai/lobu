/**
 * Google API failures, classified from the structured error body.
 *
 * Google answers several unrelated conditions with the same HTTP status — a
 * 403 is a quota hit, a missing OAuth scope, a disabled API in the client's
 * GCP project, or a genuine permission denial — and each needs a different
 * recovery (back off, ask for consent, fix the project, give up). The body
 * carries typed reasons (`error.details[].reason`, legacy `error.errors[].reason`),
 * so the distinction is read from those enums once, here, and passed on as a
 * code; nothing downstream re-matches message text.
 */

export type GoogleErrorCode =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'scope_insufficient'
  | 'api_disabled'
  | 'auth_expired'
  | 'permission_denied'
  | 'not_found'
  | 'cursor_expired'
  | 'invalid_request'
  | 'server_error'
  | 'unknown';

export interface GoogleError {
  code: GoogleErrorCode;
  status: number;
  message: string;
  retryable: boolean;
  /** Reasons as Google sent them, for logs. */
  reasons: string[];
}

interface GoogleErrorBody {
  error?: {
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string }>;
    details?: Array<{ reason?: string }>;
  } | string;
  error_description?: string;
}

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
]);
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const SCOPE_REASONS = new Set(['ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions']);
const DISABLED_REASONS = new Set(['SERVICE_DISABLED', 'accessNotConfigured', 'API_DISABLED']);

export function classifyGoogleError(status: number, bodyText: string): GoogleError {
  let body: GoogleErrorBody = {};
  try {
    body = (JSON.parse(bodyText) ?? {}) as GoogleErrorBody;
  } catch {
    // Not JSON (an HTML 502 page from a load balancer): status alone decides.
  }
  const error = typeof body.error === 'object' ? body.error : undefined;
  const reasons = [
    ...(error?.details ?? []).map((d) => d.reason),
    ...(error?.errors ?? []).map((e) => e.reason),
    typeof body.error === 'string' ? body.error : undefined,
  ].filter((r): r is string => typeof r === 'string');
  const message = error?.message ?? body.error_description ?? bodyText.slice(0, 500);
  const has = (set: Set<string>) => reasons.some((r) => set.has(r));
  const result = (code: GoogleErrorCode, retryable = false): GoogleError => ({
    code,
    status,
    message,
    retryable,
    reasons,
  });

  // Order matters: a 403 can carry both a generic and a specific reason.
  if (has(DISABLED_REASONS)) return result('api_disabled');
  if (has(SCOPE_REASONS)) return result('scope_insufficient');
  if (has(QUOTA_REASONS)) return result('quota_exhausted');
  if (status === 429 || has(RATE_LIMIT_REASONS)) return result('rate_limited', true);
  if (status === 401 || reasons.includes('invalid_grant') || reasons.includes('authError')) {
    return result('auth_expired');
  }
  if (status === 410) return result('cursor_expired');
  if (status === 404) return result('not_found');
  if (status === 403) return result('permission_denied');
  if (status === 400) return result('invalid_request');
  if (status >= 500) return result('server_error', true);
  return result('unknown');
}
