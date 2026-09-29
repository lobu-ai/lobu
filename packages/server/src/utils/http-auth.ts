import { fetchCredentialedPublicUrl } from '@lobu/connector-worker/egress';
import {
  CONNECTOR_HTTP_MAX_BYTES,
  ConnectorHttpRequestSchema,
  type ConnectorHttpRequest,
  type ConnectorHttpResponse,
} from '@lobu/core/contracts/worker/protocol';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../db/client';
import { getAuthProfileById, HTTP_AUTH_TRANSPORT_HEADERS, readHttpAuthBinding } from './auth-profiles';
import { resolveAuthCredentials } from './auth-credential-secrets';
import { cancelResponseBody, readResponseBytesWithLimit } from './bounded-response';

/** Called only after the caller has authorized the connection/run. Secrets never leave this gateway. */
export async function fetchConnectionHttp(params: {
  organizationId: string;
  connectionId: number;
  request: ConnectorHttpRequest;
  signal?: AbortSignal;
}): Promise<ConnectorHttpResponse> {
  if (!Value.Check(ConnectorHttpRequestSchema, params.request)) throw new Error('Invalid HTTP request');
  const sql = getDb();
  const [connection] = await sql`
    SELECT auth_profile_id FROM connections
    WHERE id = ${params.connectionId} AND organization_id = ${params.organizationId}
      AND deleted_at IS NULL AND status = 'active'
  `;
  const profile = await getAuthProfileById(params.organizationId, connection?.auth_profile_id ?? null);
  const binding = readHttpAuthBinding(profile?.metadata);
  if (!profile || profile.profile_kind !== 'env' || profile.status !== 'active' || !binding) {
    throw new Error('HTTP credential binding is unavailable');
  }
  const url = new URL(params.request.url);
  if (url.origin !== binding.origin || url.username || url.password) {
    throw new Error('HTTP request destination does not match the credential binding');
  }
  const method = params.request.method.toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
    throw new Error('Unsupported HTTP method');
  }
  const body = params.request.body === undefined ? undefined : Buffer.from(params.request.body, 'base64');
  if (body && (body.length > CONNECTOR_HTTP_MAX_BYTES || body.toString('base64') !== params.request.body)) {
    throw new Error('Invalid or oversized HTTP request body');
  }
  const headers = new Headers(params.request.headers);
  for (const name of HTTP_AUTH_TRANSPORT_HEADERS) {
    headers.delete(name);
  }
  const credentials = await resolveAuthCredentials({
    organizationId: params.organizationId,
    authProfileId: profile.id,
    authData: profile.auth_data,
    httpOrigin: binding.origin,
  });
  for (const [header, field] of Object.entries(binding.headers)) {
    if (!credentials[field]) throw new Error('HTTP credential field is missing');
    // The binding wins over guest-supplied headers, including case variants.
    try { headers.set(header, credentials[field]); } catch {
      // Headers' validation errors include the rejected value.
      throw new Error('Invalid HTTP credential header value');
    }
  }
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(params.signal ? [params.signal] : [])]);
  let response: Response;
  try {
    response = await fetchCredentialedPublicUrl(url, { method, headers, body, signal, redirect: 'manual' });
  } catch {
    // Transport diagnostics must not relay a credential-bearing Request to a worker.
    throw new Error('HTTP credential request failed');
  }
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    await cancelResponseBody(response);
    throw new Error('HTTP credential requests cannot follow redirects');
  }
  // HEAD and 304 may advertise the full representation size without sending a body.
  const bytes = response.body === null
    ? Buffer.alloc(0)
    : await readResponseBytesWithLimit(response, CONNECTOR_HTTP_MAX_BYTES, 'HTTP response too large');
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers),
    body: bytes.toString('base64'),
  };
}
