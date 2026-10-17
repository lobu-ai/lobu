/**
 * MCP Proxy Client
 *
 * Manages sessions and JSON-RPC communication with upstream MCP servers.
 * Sessions are stored in-memory (per-connection, not serializable).
 * Tool discovery cache is stored in-process with a short TTL.
 */

import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import {
  isReservedIp,
  stripIpv6Brackets,
} from '@lobu/connector-sdk/ip-reachability';
import {
  fetchCredentialedPublicUrl,
  fetchPublicUrl,
} from '@lobu/connector-worker/egress';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { TtlCache } from '../utils/ttl-cache';
import {
  type ResolvedCredentials,
  resolveCredentialsByConnectionId,
} from './credential-resolver';
import {
  assertRequestBodySize,
  createMcpAbortScope,
  getMcpAbortReason,
  isMcpToolCallRequest,
  inspectMcpJsonRpcBody,
  MCP_REQUEST_BODY_LIMIT,
  MCP_RESPONSE_BODY_LIMIT,
  isMcpSessionError,
  logMcpTerminalOutcome,
  newMcpCallId,
  McpTransportError,
  normalizeMcpAbortError,
  parseJsonRpcResponse,
  readResponseBody,
} from './http-response';
import type {
  DiscoveredTool,
  JsonRpcResponse,
  McpOAuthClientRegistration,
  McpOAuthMetadata,
  McpProxyConfig,
} from './types';

const FETCH_TIMEOUT_INIT_MS = 10_000;
const FETCH_TIMEOUT_TOOL_MS = 30_000;
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

async function fetchMcpResponse(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Response> {
  const callId = newMcpCallId();
  const requestBytes = typeof init.body === 'string' ? new TextEncoder().encode(init.body).byteLength : 0;
  const startedAt = Date.now();
  let responseStatus: number | null = null;
  let responseBytes = 0;
  let diagnosticPreview: string | undefined;
  let jsonRpcStatus: 'success' | 'error' | 'unknown' = 'unknown';
  let failure: unknown;
  const scope = createMcpAbortScope({
    timeoutMs,
    callerSignal,
    upstreamSignal: init.signal ?? undefined,
  });
  try {
    if (typeof init.body === 'string') assertRequestBodySize(init.body);
    const fetchUrl = new Headers(init.headers).has('Authorization')
      ? fetchCredentialedPublicUrl
      : fetchPublicUrl;
    const response = await fetchUrl(url, { ...init, signal: scope.signal });
    responseStatus = response.status;
    const responseHadBody = response.body !== null;
    const bounded = await readResponseBody(response, {
      signal: scope.signal,
      limit: MCP_RESPONSE_BODY_LIMIT,
    });
    responseBytes = bounded.byteLength;
    diagnosticPreview = bounded.preview;
    jsonRpcStatus = inspectMcpJsonRpcBody(
      bounded.bytes,
      response.headers.get('content-type')
    ).status;
    return new Response(responseHadBody ? bounded.bytes : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    const normalized = normalizeMcpAbortError(error, scope.signal);
    failure = normalized;
    if (
      normalized instanceof McpTransportError &&
      normalized.kind !== 'oversized_request'
    ) {
      responseBytes = normalized.bytes ?? responseBytes;
      diagnosticPreview = normalized.preview ?? diagnosticPreview;
    }
    throw normalized;
  } finally {
    const normalized =
      failure instanceof McpTransportError
        ? failure
        : scope.signal.reason instanceof McpTransportError
          ? scope.signal.reason
          : undefined;
    const abortReason = getMcpAbortReason(normalized, scope.signal);
    logMcpTerminalOutcome(logger, {
      call_id: callId,
      request_bytes: requestBytes,
      response_bytes: responseBytes,
      request_limit: MCP_REQUEST_BODY_LIMIT,
      response_limit: MCP_RESPONSE_BODY_LIMIT,
      duration_ms: Date.now() - startedAt,
      http_status: responseStatus,
      jsonrpc_status: jsonRpcStatus,
      truncated: normalized?.kind === 'oversized_response' || normalized?.kind === 'oversized_request',
      aborted: abortReason !== null,
      abort_reason: abortReason,
      retryable: false,
      ambiguous_execution: typeof init.body === 'string' && isMcpToolCallRequest(init.body),
      ...(diagnosticPreview && (failure || responseStatus === null || responseStatus >= 400)
        ? { diagnostic_preview: diagnosticPreview }
        : {}),
    });
    scope.cleanup();
  }
}

export const __mcpClientTestOnly = { fetchMcpResponse };

/**
 * In-memory session store. Sessions include connectionId whenever the caller
 * targets a specific connection so two accounts on the same connector never
 * reuse each other's authenticated MCP session; only connection-less
 * (unauthenticated) discovery uses the connector-wide key.
 */
type McpSessionState = { sessionId: string; protocolVersion: string };
const sessions = new TtlCache<McpSessionState>(SESSION_TTL_MS);

class McpOAuthRequiredError extends Error {
  constructor(readonly metadata: McpOAuthMetadata) {
    super('MCP server requires OAuth authorization');
    this.name = 'McpOAuthRequiredError';
  }
}

/**
 * The upstream rejected the credentials we sent (HTTP 401). Unlike a session
 * rejection this MAY be a dead/revoked access token whose stored expiry still
 * looks valid, so the caller re-resolves against the exact rejected token and
 * retries once.
 */
class McpAuthRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAuthRejectedError';
  }
}

async function refreshRejectedCredentials(
  connectionId: number,
  orgId: string,
  credentials: ResolvedCredentials | null
): Promise<ResolvedCredentials | null> {
  if (!credentials?.accessToken) return null;
  try {
    return await resolveCredentialsByConnectionId(connectionId, orgId, {
      rejectedAccessToken: credentials.accessToken,
    });
  } catch (error) {
    logger.warn(
      { connectionId, orgId, error: errorMessage(error) },
      '[McpProxy] Credential refresh after 401 failed'
    );
    return null;
  }
}

function sessionKey(orgId: string, connectorKey: string, connectionId?: number): string {
  return connectionId === undefined
    ? `${orgId}:${connectorKey}`
    : `${orgId}:${connectorKey}:connection:${connectionId}`;
}

// ---------------------------------------------------------------------------
const toolCache = new TtlCache<DiscoveredTool[]>(TOOL_CACHE_TTL_MS);

// ---------------------------------------------------------------------------
// Upstream communication
// ---------------------------------------------------------------------------

/**
 * Build headers for an upstream MCP request.
 */
function buildHeaders(
  credentials: ResolvedCredentials | null,
  session: McpSessionState | null
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  if (session) {
    headers['Mcp-Session-Id'] = session.sessionId;
    headers['MCP-Protocol-Version'] = session.protocolVersion;
  }

  if (credentials?.accessToken) {
    headers.Authorization = `${credentials.tokenType || 'Bearer'} ${credentials.accessToken}`;
  }

  return headers;
}

/**
 * Send a JSON-RPC request to an upstream MCP server.
 * Tracks Mcp-Session-Id from responses.
 */
async function sendRequest(
  upstreamUrl: string,
  credentials: ResolvedCredentials | null,
  orgId: string,
  connectorKey: string,
  body: string,
  timeoutMs: number = FETCH_TIMEOUT_TOOL_MS,
  connectionId?: number,
  callerSignal?: AbortSignal
): Promise<JsonRpcResponse> {
  // Re-validate on every outbound fetch — config may have been edited/imported
  // after the creation-time probe, so "validated at write time" is not enough.
  assertSafeUrl(upstreamUrl);
  const key = sessionKey(orgId, connectorKey, connectionId);
  const session = sessions.get(key) ?? null;
  const headers = buildHeaders(credentials, session);

  const response = await fetchMcpResponse(
    upstreamUrl,
    { method: 'POST', headers, body },
    timeoutMs,
    callerSignal
  );

  // Track session ID from response
  const newSessionId = response.headers.get('Mcp-Session-Id');
  if (newSessionId) {
    sessions.set(key, {
      sessionId: newSessionId,
      protocolVersion: session?.protocolVersion ?? MCP_PROTOCOL_VERSION,
    });
  }

  if (!response.ok) {
    const text = new TextDecoder().decode((await readResponseBody(response)).bytes);
    if (response.status === 404 && session) {
      sessions.delete(key);
      throw new Error(`Upstream MCP returned 404: ${text}`);
    }
    if (response.status === 401) {
      throw new McpAuthRejectedError(`Upstream MCP returned 401: ${text}`);
    }
    throw new Error(`Upstream MCP returned ${response.status}: ${text}`);
  }

  const request = JSON.parse(body) as { id?: unknown };
  const expectedId = Object.hasOwn(request, 'id') ? request.id : undefined;
  const parsed = (await parseJsonRpcResponse(response, expectedId)) as JsonRpcResponse;
  if (isMcpSessionError(parsed.error?.message)) sessions.delete(key);
  return parsed;
}

/**
 * Initialize an MCP session with the upstream server.
 * Sends initialize + notifications/initialized handshake.
 */
async function initializeSession(
  upstreamUrl: string,
  credentials: ResolvedCredentials | null,
  orgId: string,
  connectorKey: string,
  connectionId?: number,
  callerSignal?: AbortSignal,
  timeoutMs: number = FETCH_TIMEOUT_INIT_MS
): Promise<Record<string, unknown>> {
  // Clear existing session
  const key = sessionKey(orgId, connectorKey, connectionId);
  sessions.delete(key);

  // Send initialize
  const initResponse = await sendRequest(
    upstreamUrl,
    credentials,
    orgId,
    connectorKey,
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'lobu-mcp-proxy', version: '1.0.0' },
      },
      id: 0,
    }),
    timeoutMs,
    connectionId,
    callerSignal
  );

  if (initResponse.error) {
    throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
  }

  const protocolVersion = initResponse.result?.protocolVersion;
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    throw new Error('MCP initialize response omitted protocolVersion');
  }
  const initializedSession = sessions.get(key);
  if (initializedSession) {
    sessions.set(key, { ...initializedSession, protocolVersion });
  }

  // Send initialized notification
  try {
    await sendRequest(
      upstreamUrl,
      credentials,
      orgId,
      connectorKey,
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
      timeoutMs,
      connectionId,
      callerSignal
    );
  } catch {
    // Notification delivery is best-effort
  }

  return initResponse.result?.capabilities ?? {};
}

/**
 * Discover tools from an upstream MCP server.
 * Returns tools with the tool_prefix applied to names.
 */
export async function discoverTools(
  connectorKey: string,
  config: McpProxyConfig,
  orgId: string,
  connectionId?: number
): Promise<DiscoveredTool[]> {
  // Key the cache by org AND connection — two orgs can each define a connector
  // with the same key but different upstream URLs / tool sets, and two
  // connections in one org can hold different accounts whose upstream exposes
  // different tools; sharing either cache leaks one catalog to the other.
  const cacheKey = sessionKey(orgId, connectorKey, connectionId);
  const cached = toolCache.get(cacheKey) ?? null;
  if (cached) return cached;

  let credentials =
    connectionId === undefined
      ? null
      : await resolveCredentialsByConnectionId(connectionId, orgId);

  let canRefreshAfter401 = connectionId !== undefined;
  while (true) {
    try {
      // Initialize session first
      const capabilities = await initializeSession(
        config.upstream_url,
        credentials,
        orgId,
        connectorKey,
        connectionId
      );

      // A server that does not advertise tools is legitimately toolless. Once it
      // advertises the capability, however, tools/list is part of the negotiated
      // contract and discovery failures must fail the install instead of silently
      // persisting a connector with zero operations.
      if (!Object.hasOwn(capabilities, 'tools')) {
        toolCache.set(cacheKey, []);
        return [];
      }

      // Fetch tools/list
      const response = await sendRequest(
        config.upstream_url,
        credentials,
        orgId,
        connectorKey,
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
          id: 1,
        }),
        FETCH_TIMEOUT_TOOL_MS,
        connectionId
      );

      if (response.error) {
        throw new Error(`MCP tools/list failed: ${response.error.message}`);
      }

      const rawTools = response.result?.tools;
      if (!Array.isArray(rawTools)) {
        throw new Error('MCP tools/list response omitted tools');
      }
      const prefix = config.tool_prefix;

      const tools: DiscoveredTool[] = rawTools.map((t) => ({
        name: `${prefix}__${t.name}`,
        originalName: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        annotations: t.annotations,
        connectorKey,
        upstreamUrl: config.upstream_url,
      }));

      toolCache.set(cacheKey, tools);

      logger.info(
        { connectorKey, toolCount: tools.length, prefix },
        '[McpProxy] Discovered tools from upstream MCP'
      );

      return tools;
    } catch (error) {
      if (
        canRefreshAfter401 &&
        error instanceof McpAuthRejectedError &&
        connectionId !== undefined
      ) {
        canRefreshAfter401 = false;
        logger.info(
          { connectorKey, url: config.upstream_url, connectionId },
          '[McpProxy] Tool discovery rejected (401); refreshing and retrying once'
        );
        const refreshed = await refreshRejectedCredentials(
          connectionId,
          orgId,
          credentials
        );
        if (refreshed?.accessToken) {
          credentials = refreshed;
          sessions.delete(cacheKey);
          toolCache.delete(cacheKey);
          continue;
        }
      }

      logger.error(
        { connectorKey, url: config.upstream_url, error: errorMessage(error) },
        '[McpProxy] Tool discovery failed'
      );
      throw error;
    }
  }
}

/**
 * Call a tool on an upstream MCP server.
 * Establishes a session before dispatch and only refreshes a rejected credential
 * before one retry; ambiguous tool outcomes are never replayed.
 */
export async function callTool(
  connectorKey: string,
  config: McpProxyConfig,
  orgId: string,
  originalToolName: string,
  args: Record<string, unknown>,
  connectionId: number,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<{ content: unknown[]; isError: boolean }> {
  let credentials = await resolveCredentialsByConnectionId(connectionId, orgId);
  let canRefreshAfter401 = true;

  const key = sessionKey(orgId, connectorKey, connectionId);

  // Establish a session before the action call. A transport failure after a
  // tools/call is ambiguous — the upstream may have executed the action before
  // the response was lost — so it must never be interpreted as permission to
  // initialize and replay a potentially destructive call.
  if (!sessions.get(key)) {
    try {
      await initializeSession(
        config.upstream_url,
        credentials,
        orgId,
        connectorKey,
        connectionId,
        options?.signal,
        options?.timeoutMs
      );
    } catch (error) {
      if (!(error instanceof McpAuthRejectedError)) throw error;
      const refreshed = await refreshRejectedCredentials(connectionId, orgId, credentials);
      if (!refreshed?.accessToken) throw error;
      canRefreshAfter401 = false;
      credentials = refreshed;
      await initializeSession(
        config.upstream_url,
        credentials,
        orgId,
        connectorKey,
        connectionId,
        options?.signal,
        options?.timeoutMs
      );
    }
  }

  const jsonRpcBody = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: originalToolName, arguments: args },
    id: 1,
  });

  const send = (): Promise<JsonRpcResponse> =>
    sendRequest(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey,
      jsonRpcBody,
      options?.timeoutMs ?? FETCH_TIMEOUT_TOOL_MS,
      connectionId,
      options?.signal
    );

  // Only a credential rejection is retried: it is rejected before dispatch.
  // A 404/session error, timeout, abort, 5xx, or any other post-dispatch
  // failure is ambiguous for tools/call and must never replay the action.
  let response: JsonRpcResponse;
  try {
    response = await send();
  } catch (error) {
    if (!(canRefreshAfter401 && error instanceof McpAuthRejectedError)) throw error;
    canRefreshAfter401 = false;
    logger.info(
      { connectorKey, originalToolName, connectionId },
      '[McpProxy] Upstream rejected access token; refreshing and retrying once'
    );
    const refreshed = await refreshRejectedCredentials(connectionId, orgId, credentials);
    if (!refreshed?.accessToken) throw error;
    credentials = refreshed;
    sessions.delete(sessionKey(orgId, connectorKey, connectionId));
    await initializeSession(
      config.upstream_url,
      credentials,
      orgId,
      connectorKey,
      connectionId
    );
    response = await send();
  }

  if (response.error) {
    return {
      content: [{ type: 'text', text: response.error.message || 'Upstream MCP error' }],
      isError: true,
    };
  }

  return {
    content: response.result?.content ?? [],
    isError: response.result?.isError ?? false,
  };
}

/**
 * Validate that a URL is safe for server-side fetching (SSRF prevention).
 *
 * This is the early syntactic check for the operator-supplied upstream URL.
 * `fetchPublicUrl` performs the load-bearing DNS validation and pins the socket
 * to the validated address; this check rejects obvious literals at the trust
 * boundary before any request setup begins.
 */
export function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  // WHATWG URL keeps IPv6 hostnames bracketed (`[::1]`). Strip brackets so the
  // shared guard sees the bare literal.
  const hostname = stripIpv6Brackets(parsed.hostname.toLowerCase());

  // IP literals (in any spelling) go through the canonical SSRF guard — the
  // same `isReservedIp` the gateway egress proxy uses. This closes the gap the
  // previous hand-rolled regex variant left open: NAT64 (`64:ff9b::7f00:1`) and
  // hex-form IPv4-mapped IPv6 (`::ffff:7f00:1`) were not matched here. A value
  // that looks like an IP literal but won't parse fails closed (blocked).
  if (isReservedIp(hostname)) {
    throw new Error(`URL points to a private/internal address: ${hostname}`);
  }

  // Hostname forms the IP guard can't see (these never reach `net.isIP`):
  // bare `localhost` and the `.local` / `.internal` private DNS suffixes.
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error(`URL points to a private/internal address: ${hostname}`);
  }
}

function normalizeUrlForComparison(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.toString();
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function readResourceMetadataUrl(header: string | null): string | null {
  if (!header) return null;
  const match = /(?:^|[,\s])resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  return match?.[1] ?? null;
}

function readChallengeScopes(header: string | null): string[] {
  if (!header) return [];
  const match = /\bscope\s*=\s*"([^"]*)"/i.exec(header);
  if (!match?.[1]) return [];
  return match[1].split(/\s+/).filter(Boolean);
}

function authorizationMetadataUrls(authorizationServer: string): string[] {
  const issuer = new URL(authorizationServer);
  const issuerPath = issuer.pathname.replace(/\/+$/, '');
  const candidates = [
    `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
    `${authorizationServer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`,
    `${authorizationServer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
  ];
  return candidates.filter((value, index) => candidates.indexOf(value) === index);
}

function assertSafeOAuthEndpoint(url: string): void {
  assertSafeUrl(url);
  if (new URL(url).protocol !== 'https:') {
    throw new Error('MCP OAuth metadata and authorization endpoints must use HTTPS');
  }
}

async function fetchJsonObject(url: string): Promise<Record<string, unknown> | null> {
  assertSafeOAuthEndpoint(url);
  const response = await fetchMcpResponse(
    url,
    { headers: { Accept: 'application/json' } },
    FETCH_TIMEOUT_INIT_MS
  );
  if (!response.ok) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode((await readResponseBody(response)).bytes));
  } catch {
    // A catch-all route that answers a well-known path with HTML is absent
    // metadata, not a malformed document.
    return null;
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * RFC 9728 well-known locations for a server that sent no `resource_metadata`
 * challenge, in MCP authorization-spec order: the path-specific document
 * first, then the origin root.
 */
function protectedResourceMetadataUrls(upstreamUrl: string): string[] {
  const upstream = new URL(upstreamUrl);
  const path = upstream.pathname === '/' ? '' : upstream.pathname;
  const root = `${upstream.origin}/.well-known/oauth-protected-resource`;
  return path || upstream.search ? [`${root}${path}${upstream.search}`, root] : [root];
}

async function discoverMcpOAuthMetadata(
  upstreamUrl: string,
  authenticateHeader: string | null
): Promise<McpOAuthMetadata | null> {
  const challengedMetadataUrl = readResourceMetadataUrl(authenticateHeader);
  let resourceMetadataUrl: string | null = null;
  let resourceMetadata: Record<string, unknown> | null = null;
  for (const candidateUrl of challengedMetadataUrl
    ? [challengedMetadataUrl]
    : protectedResourceMetadataUrls(upstreamUrl)) {
    resourceMetadata = await fetchJsonObject(candidateUrl);
    if (resourceMetadata) {
      resourceMetadataUrl = candidateUrl;
      break;
    }
  }
  if (!resourceMetadata || !resourceMetadataUrl) {
    if (challengedMetadataUrl) {
      throw new Error(`MCP OAuth resource metadata was unavailable: ${challengedMetadataUrl}`);
    }
    return null;
  }

  const resource =
    typeof resourceMetadata.resource === 'string' ? resourceMetadata.resource : null;
  if (!resource) throw new Error('MCP OAuth resource metadata omitted resource');
  if (normalizeUrlForComparison(resource) !== normalizeUrlForComparison(upstreamUrl)) {
    throw new Error('MCP OAuth resource metadata does not match the requested server URL');
  }

  const authorizationServers = readStringArray(resourceMetadata.authorization_servers);
  if (authorizationServers.length === 0) {
    throw new Error('MCP OAuth resource metadata omitted authorization_servers');
  }

  const authorizationServer = authorizationServers[0];
  assertSafeOAuthEndpoint(authorizationServer);
  let authorizationMetadata: Record<string, unknown> | null = null;
  for (const metadataUrl of authorizationMetadataUrls(authorizationServer)) {
    const candidate = await fetchJsonObject(metadataUrl);
    if (!candidate) continue;
    const issuer = typeof candidate.issuer === 'string' ? candidate.issuer : null;
    if (
      issuer &&
      normalizeUrlForComparison(issuer) !== normalizeUrlForComparison(authorizationServer)
    ) {
      continue;
    }
    authorizationMetadata = candidate;
    break;
  }
  if (!authorizationMetadata) {
    throw new Error(`MCP OAuth authorization metadata was unavailable: ${authorizationServer}`);
  }

  const authorizationUrl =
    typeof authorizationMetadata.authorization_endpoint === 'string'
      ? authorizationMetadata.authorization_endpoint
      : null;
  const tokenUrl =
    typeof authorizationMetadata.token_endpoint === 'string'
      ? authorizationMetadata.token_endpoint
      : null;
  if (!authorizationUrl || !tokenUrl) {
    throw new Error('MCP OAuth authorization metadata omitted required endpoints');
  }
  assertSafeOAuthEndpoint(authorizationUrl);
  assertSafeOAuthEndpoint(tokenUrl);

  const registrationUrl =
    typeof authorizationMetadata.registration_endpoint === 'string'
      ? authorizationMetadata.registration_endpoint
      : undefined;
  if (registrationUrl) assertSafeOAuthEndpoint(registrationUrl);
  const challengeScopes = readChallengeScopes(authenticateHeader);

  return {
    resource,
    resourceMetadataUrl,
    ...(typeof resourceMetadata.resource_documentation === 'string'
      ? { resourceDocumentation: resourceMetadata.resource_documentation }
      : {}),
    authorizationServer,
    authorizationUrl,
    tokenUrl,
    ...(registrationUrl ? { registrationUrl } : {}),
    ...(challengeScopes.length > 0
      ? { challengeScopes }
      : {}),
    scopesSupported: readStringArray(resourceMetadata.scopes_supported),
    tokenEndpointAuthMethodsSupported: readStringArray(
      authorizationMetadata.token_endpoint_auth_methods_supported
    ),
    codeChallengeMethodsSupported: readStringArray(
      authorizationMetadata.code_challenge_methods_supported
    ),
  };
}

export function getMcpOAuthRequestedScopes(metadata: McpOAuthMetadata): string[] {
  return metadata.challengeScopes && metadata.challengeScopes.length > 0
    ? metadata.challengeScopes
    : metadata.scopesSupported;
}

export function selectMcpOAuthClientAuthMethod(
  metadata: McpOAuthMetadata
): McpOAuthClientRegistration['tokenEndpointAuthMethod'] {
  const methods = metadata.tokenEndpointAuthMethodsSupported;
  if (methods.includes('none') && metadata.codeChallengeMethodsSupported.includes('S256')) {
    return 'none';
  }
  if (methods.includes('client_secret_basic')) return 'client_secret_basic';
  if (methods.includes('client_secret_post')) return 'client_secret_post';
  // RFC 8414 defaults an omitted token_endpoint_auth_methods_supported to
  // client_secret_basic.
  if (methods.length === 0) return 'client_secret_basic';
  throw new Error('MCP OAuth server has no supported dynamic-client authentication method');
}

function assertSafeOAuthRedirectUri(value: string): void {
  let redirectUri: URL;
  try {
    redirectUri = new URL(value);
  } catch {
    throw new Error(`Invalid OAuth callback URL: ${value}`);
  }

  if (redirectUri.protocol === 'https:') return;

  const hostname = stripIpv6Brackets(redirectUri.hostname.toLowerCase());
  const isLoopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (redirectUri.protocol !== 'http:' || !isLoopback) {
    throw new Error('OAuth callback URL must use HTTPS or HTTP on a loopback host');
  }
}

export async function registerMcpOAuthClient(params: {
  metadata: McpOAuthMetadata;
  redirectUris: string[];
  clientName: string;
}): Promise<McpOAuthClientRegistration | null> {
  const registrationUrl = params.metadata.registrationUrl;
  if (!registrationUrl) return null;
  const redirectUris = params.redirectUris.filter(
    (value, index, values) => value.length > 0 && values.indexOf(value) === index
  );
  if (redirectUris.length === 0) {
    throw new Error('MCP OAuth dynamic registration requires a callback URL');
  }
  for (const redirectUri of redirectUris) assertSafeOAuthRedirectUri(redirectUri);

  const requestedMethod = selectMcpOAuthClientAuthMethod(params.metadata);
  const response = await fetchMcpResponse(
    registrationUrl,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: params.clientName,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: requestedMethod,
        ...(getMcpOAuthRequestedScopes(params.metadata).length > 0
          ? { scope: getMcpOAuthRequestedScopes(params.metadata).join(' ') }
          : {}),
      }),
    },
    FETCH_TIMEOUT_INIT_MS
  );
  if (!response.ok) {
    const text = new TextDecoder().decode((await readResponseBody(response)).bytes);
    throw new Error(`MCP OAuth dynamic registration returned ${response.status}: ${text}`);
  }

  const body = JSON.parse(new TextDecoder().decode((await readResponseBody(response)).bytes)) as Record<string, unknown>;
  const clientId = typeof body.client_id === 'string' ? body.client_id : null;
  if (!clientId) throw new Error('MCP OAuth dynamic registration omitted client_id');
  const returnedMethod =
    body.token_endpoint_auth_method === 'none' ||
    body.token_endpoint_auth_method === 'client_secret_post' ||
    body.token_endpoint_auth_method === 'client_secret_basic'
      ? body.token_endpoint_auth_method
      : requestedMethod;
  const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : undefined;
  if (returnedMethod !== requestedMethod) {
    throw new Error('MCP OAuth dynamic registration changed the requested client auth method');
  }
  if (returnedMethod !== 'none' && !clientSecret) {
    throw new Error('MCP OAuth confidential client registration omitted client_secret');
  }

  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    tokenEndpointAuthMethod: returnedMethod,
  };
}

/**
 * Probe a remote MCP server to extract server info and available tools.
 * Uses a temporary session (no stored session or credentials).
 */
export async function probeMcpServer(upstreamUrl: string): Promise<{
  serverInfo: { name: string; version: string };
  instructions?: string;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  /** OAuth the server requires (401 challenge) or advertises beside anonymous access. */
  oauth?: McpOAuthMetadata;
  /** Initialize succeeded without credentials, so OAuth (if any) is optional. */
  anonymousAccess: boolean;
}> {
  assertSafeUrl(upstreamUrl);
  let mcpSessionId: string | null = null;
  let protocolVersion: string | null = null;

  const send = async (body: unknown): Promise<JsonRpcResponse> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (mcpSessionId) {
      headers['Mcp-Session-Id'] = mcpSessionId;
      headers['MCP-Protocol-Version'] = protocolVersion ?? MCP_PROTOCOL_VERSION;
    }

    const serializedBody = JSON.stringify(body);
    const response = await fetchMcpResponse(
      upstreamUrl,
      { method: 'POST', headers, body: serializedBody },
      FETCH_TIMEOUT_INIT_MS
    );

    const newSessionId = response.headers.get('Mcp-Session-Id');
    if (newSessionId) mcpSessionId = newSessionId;

    if (!response.ok) {
      if (response.status === 401) {
        const metadata = await discoverMcpOAuthMetadata(
          upstreamUrl,
          response.headers.get('WWW-Authenticate')
        );
        if (metadata) throw new McpOAuthRequiredError(metadata);
      }
      const text = new TextDecoder().decode((await readResponseBody(response)).bytes);
      throw new Error(`MCP server returned ${response.status}: ${text}`);
    }

    const request = body as { id?: unknown };
    const expectedId = Object.hasOwn(request, 'id') ? request.id : undefined;
    return (await parseJsonRpcResponse(response, expectedId)) as JsonRpcResponse;
  };

  // Initialize
  let initResponse: JsonRpcResponse;
  try {
    initResponse = await send({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'lobu-mcp-proxy', version: '1.0.0' },
      },
      id: 0,
    });
  } catch (error) {
    if (!(error instanceof McpOAuthRequiredError)) throw error;
    return {
      serverInfo: { name: new URL(upstreamUrl).hostname, version: '0.0.0' },
      ...(error.metadata.resourceDocumentation
        ? { instructions: `OAuth-protected remote MCP server. ${error.metadata.resourceDocumentation}` }
        : { instructions: 'OAuth-protected remote MCP server.' }),
      tools: [],
      oauth: error.metadata,
      anonymousAccess: false,
    };
  }

  if (initResponse.error) {
    throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
  }

  if (
    typeof initResponse.result?.protocolVersion !== 'string' ||
    initResponse.result.protocolVersion.length === 0
  ) {
    throw new Error('MCP initialize response omitted protocolVersion');
  }
  protocolVersion = initResponse.result.protocolVersion;

  const serverInfo = initResponse.result?.serverInfo ?? { name: 'unknown', version: '0.0.0' };
  const instructions = initResponse.result?.instructions;

  // Send initialized notification (best-effort)
  try {
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch {
    // best-effort
  }

  const capabilities = initResponse.result?.capabilities ?? {};
  if (!Object.hasOwn(capabilities, 'tools')) {
    return { serverInfo, instructions, tools: [], ...(await discoverAdvertisedOAuth(upstreamUrl)) };
  }

  // An advertised tools capability makes tools/list mandatory.
  const toolsResponse = await send({
    jsonrpc: '2.0',
    method: 'tools/list',
    params: {},
    id: 1,
  });
  if (toolsResponse.error) {
    throw new Error(`MCP tools/list failed: ${toolsResponse.error.message}`);
  }
  const tools = toolsResponse.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error('MCP tools/list response omitted tools');
  }
  const typedTools = tools as Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;

  return {
    serverInfo,
    instructions,
    tools: typedTools,
    ...(await discoverAdvertisedOAuth(upstreamUrl)),
  };
}

/**
 * A server that answered initialize anonymously may still publish RFC 9728
 * protected-resource metadata, offering signed-in access (an account's quota or
 * extra tools) beside its anonymous tier. Discovery is best-effort here: the
 * anonymous install is already usable, so unreachable or invalid metadata only
 * means no sign-in is offered.
 */
async function discoverAdvertisedOAuth(
  upstreamUrl: string
): Promise<{ oauth?: McpOAuthMetadata; anonymousAccess: true }> {
  try {
    const oauth = await discoverMcpOAuthMetadata(upstreamUrl, null);
    if (oauth) selectMcpOAuthClientAuthMethod(oauth);
    return oauth ? { oauth, anonymousAccess: true } : { anonymousAccess: true };
  } catch (error) {
    logger.warn(
      { upstream_url: upstreamUrl, error: errorMessage(error) },
      'Ignoring invalid OAuth metadata advertised by an anonymous MCP server'
    );
    return { anonymousAccess: true };
  }
}
