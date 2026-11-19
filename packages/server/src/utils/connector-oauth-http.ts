import { cancelResponseBody, readResponseTextWithLimit } from './bounded-response';

export const CONNECTOR_OAUTH_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_CONNECTOR_OAUTH_RESPONSE_BYTES = 1024 * 1024;

/** Keep the deadline active through both headers and response-body consumption. */
export async function withConnectorOAuthDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = CONNECTOR_OAUTH_REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(new Error(`Connector OAuth request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export function readConnectorOAuthResponse(response: Response): Promise<string> {
  return readResponseTextWithLimit(
    response,
    MAX_CONNECTOR_OAUTH_RESPONSE_BYTES,
    'Connector OAuth response too large'
  );
}

/**
 * Whether a failed token-endpoint response rejects the grant itself. Only the
 * RFC 6749 §5.2 `invalid_grant` code means the stored grant is dead and needs
 * new consent; other rejections (a bad client, a rate limit, an outage) leave
 * it usable. Only a 400/401 body carries the code; any other failure body is
 * cancelled unread. The body is never logged.
 */
export async function isOAuthGrantRejection(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 401) {
    await cancelResponseBody(response);
    return false;
  }
  try {
    const parsed = JSON.parse(await readConnectorOAuthResponse(response)) as { error?: unknown };
    return parsed?.error === 'invalid_grant';
  } catch {
    return false;
  }
}
