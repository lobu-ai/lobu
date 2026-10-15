/**
 * Test Helpers
 *
 * HTTP client helpers for testing the Hono app directly (without starting a server).
 * Also includes MCP-specific helpers for JSON-RPC requests.
 *
 * MCP calls perform proper protocol initialization per session (keyed by token).
 */

import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { app, type Env } from '../../index';
import { initWorkspaceProvider } from '../../workspace';

let workspaceReady: Promise<void> | null = null;

function ensureWorkspaceProvider(): Promise<void> {
  if (!workspaceReady) {
    workspaceReady = initWorkspaceProvider().then(() => {});
  }
  return workspaceReady;
}

// ============================================
// Test Environment
// ============================================

/**
 * Default test environment variables
 */
const testEnv: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  MAX_CONSECUTIVE_FAILURES: '3',
  RATE_LIMIT_ENABLED: 'false', // Disable rate limiting in tests
  // Forward embeddings config when set in the host process (benchmark runs set these);
  // without this, content-search.ts sees env?.EMBEDDINGS_SERVICE_URL as undefined and
  // silently falls back to text-only ranking, even if embeddings are written to the DB.
  EMBEDDINGS_SERVICE_URL: process.env.EMBEDDINGS_SERVICE_URL,
  EMBEDDINGS_SERVICE_TOKEN: process.env.EMBEDDINGS_SERVICE_TOKEN,
  EMBEDDINGS_TIMEOUT_MS: process.env.EMBEDDINGS_TIMEOUT_MS,
};

// ============================================
// HTTP Client
// ============================================

interface TestResponse {
  status: number;
  headers: Headers;
  json: () => Promise<any>;
  text: () => Promise<string>;
}

/**
 * Make a request to the Hono app directly (no HTTP server needed)
 */
export async function testRequest(
  method: string,
  path: string,
  options?: {
    body?: any;
    /** Sent verbatim instead of JSON-encoding `body`; pass its content-type in `headers`. */
    rawBody?: string;
    headers?: Record<string, string>;
    token?: string;
    cookie?: string;
    env?: Partial<Env>;
  }
): Promise<TestResponse> {
  await ensureWorkspaceProvider();
  const url = `http://localhost${path}`;
  const headers: Record<string, string> = {
    ...(options?.rawBody === undefined && { 'Content-Type': 'application/json' }),
    ...options?.headers,
  };

  if (options?.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  if (options?.cookie) {
    headers.Cookie = options.cookie;
  }

  const request = new Request(url, {
    method,
    headers,
    body: options?.rawBody ?? (options?.body ? JSON.stringify(options.body) : undefined),
  });

  // Merge test env with any overrides
  const env = { ...testEnv, ...options?.env };

  // Execute against Hono app with test environment
  const response = await app.fetch(request, env);

  return {
    status: response.status,
    headers: response.headers,
    json: () => response.json(),
    text: () => response.text(),
  };
}

// Convenience methods
export const get = (path: string, options?: Omit<Parameters<typeof testRequest>[2], 'body'>) =>
  testRequest('GET', path, options);

export const post = (path: string, options?: Parameters<typeof testRequest>[2]) =>
  testRequest('POST', path, options);

export const del = (path: string, options?: Omit<Parameters<typeof testRequest>[2], 'body'>) =>
  testRequest('DELETE', path, options);

/**
 * POST an `application/x-www-form-urlencoded` body — what a browser <form>
 * submit sends. Exercises routes that read via `c.req.parseBody()` (e.g. the
 * extension-bootstrap → /api/exchange-token handoff), which JSON bodies don't.
 */
export async function postForm(
  path: string,
  form: Record<string, string>,
  options?: { cookie?: string; env?: Partial<Env> }
): Promise<TestResponse> {
  await ensureWorkspaceProvider();
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (options?.cookie) headers.Cookie = options.cookie;
  const request = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(form).toString(),
  });
  const env = { ...testEnv, ...options?.env };
  const response = await app.fetch(request, env);
  return {
    status: response.status,
    headers: response.headers,
    json: () => response.json(),
    text: () => response.text(),
  };
}

// ============================================
// MCP Session Management
// ============================================

import { mcpSessions } from './mcp-session-cache';

/**
 * Get or create an initialized MCP session for the given auth token.
 * Sends the proper initialize + notifications/initialized handshake
 * and caches the resulting session ID for subsequent requests.
 */
export async function ensureMcpSession(options?: {
  token?: string;
  env?: Partial<Env>;
  agentId?: string;
  orgSlug?: string;
  cookie?: string;
}): Promise<string> {
  const cookieKey = options?.cookie ? options.cookie.slice(0, 24) : '__no_cookie__';
  const cacheKey = `${options?.token ?? '__anonymous__'}:${options?.agentId ?? '__no_agent__'}:${options?.orgSlug ?? '__unscoped__'}:${cookieKey}`;

  const existing = mcpSessions.get(cacheKey);
  if (existing) return existing;

  // The unscoped `/mcp` endpoint never derives org context from an OAuth
  // token alone; pin to `/mcp/{orgSlug}` so the auth middleware sets
  // `c.var.organizationId`, matching what production MCP clients do.
  const mcpPath = options?.orgSlug ? `/mcp/${options.orgSlug}` : '/mcp';

  // 1. Send initialize
  const initResponse = await post(mcpPath, {
    body: {
      jsonrpc: '2.0',
      id: '__test_init__',
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'lobu-test',
          version: '1.0',
          ...(options?.agentId ? { agentId: options.agentId } : {}),
        },
      },
    },
    token: options?.token,
    cookie: options?.cookie,
    env: options?.env,
  });

  const sessionId = initResponse.headers.get('mcp-session-id');
  if (!sessionId) {
    const body = await initResponse.json();
    throw new Error(
      `MCP initialize did not return session ID (status=${initResponse.status}): ${JSON.stringify(body)}`
    );
  }

  // 2. Send notifications/initialized
  await post(mcpPath, {
    body: {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    },
    headers: {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    },
    token: options?.token,
    cookie: options?.cookie,
    env: options?.env,
  });

  mcpSessions.set(cacheKey, sessionId);
  return sessionId;
}


// ============================================
// MCP JSON-RPC Helpers
// ============================================

interface MCPResponse<T = any> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: any };
}

/**
 * Make an MCP JSON-RPC request (with proper session initialization)
 */
export async function mcpRequest<T = any>(
  method: string,
  params?: any,
  options?: {
    token?: string;
    env?: Partial<Env>;
    agentId?: string;
    orgSlug?: string;
    cookie?: string;
  }
): Promise<MCPResponse<T>> {
  const sessionId = await ensureMcpSession(options);
  const mcpPath = options?.orgSlug ? `/mcp/${options.orgSlug}` : '/mcp';

  const response = await post(mcpPath, {
    body: {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: params || {},
    },
    headers: {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    },
    token: options?.token,
    cookie: options?.cookie,
    env: options?.env,
  });

  return response.json();
}

/**
 * Make an MCP tools/call request with JSON format for raw results.
 *
 * Admin flat tools are omitted from MCP `tools/list` but remain dispatchable
 * by name here and via REST. Prefer `query_sdk` / `run_sdk` for new agent tests.
 */
export async function mcpToolsCall<T = any>(
  toolName: string,
  args: any,
  options?: { token?: string; env?: Partial<Env>; agentId?: string; orgSlug?: string }
): Promise<T> {
  const sessionId = await ensureMcpSession(options);
  const mcpPath = options?.orgSlug ? `/mcp/${options.orgSlug}` : '/mcp';

  const response = await post(mcpPath, {
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    },
    headers: {
      'X-MCP-Format': 'json',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    },
    token: options?.token,
    env: options?.env,
  });

  const json = await response.json();

  if (json.error) {
    throw new Error(`MCP Error [${json.error.code}]: ${json.error.message}`);
  }

  // Tool-level errors: MCP returns isError on the result, not at JSON-RPC level
  if (json.result?.isError) {
    const errText = json.result.content?.[0]?.text ?? 'Tool execution failed';
    throw new Error(errText);
  }

  // Parse the text content which contains JSON
  const textContent = json.result?.content?.[0]?.text;
  if (textContent) {
    try {
      return JSON.parse(textContent);
    } catch {
      // Not JSON — return raw text (e.g. plain string results)
      return textContent as T;
    }
  }

  return json.result;
}

/**
 * List all available MCP tools
 */
export async function mcpListTools(options?: {
  token?: string;
  env?: Partial<Env>;
  agentId?: string;
  orgSlug?: string;
  cookie?: string;
}): Promise<{ tools: Array<{ name: string; description: string }> }> {
  const response = await mcpRequest('tools/list', {}, options);

  if (response.error) {
    throw new Error(`MCP Error: ${response.error.message}`);
  }

  return response.result;
}
