import { MCP_PROTOCOL_VERSION } from "@lobu/core";
import { extractApiError } from "../../../internal/http.js";
import { ApiError } from "./errors.js";
import {
  getUsableToken,
  orgFromMcpUrl,
  resolveServerUrl,
} from "./memory-auth.js";

const JSON_MCP_ACCEPT = "application/json";

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function getMcpUrlCandidates(rawUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [rawUrl];
  }

  const candidates = [parsed.toString()];
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
    const ipv4 = new URL(parsed.toString());
    ipv4.hostname = "127.0.0.1";
    candidates.push(ipv4.toString());

    const dockerHost = new URL(parsed.toString());
    dockerHost.hostname = "host.docker.internal";
    candidates.push(dockerHost.toString());
  }

  return uniqueStrings(candidates);
}

function formatNetworkErrorMessage(
  error: unknown,
  triedUrls: string[]
): string {
  const baseMessage = error instanceof Error ? error.message : String(error);
  return `MCP fetch failed (${baseMessage}). Tried: ${triedUrls.join(", ")}`;
}

async function fetchMcpWithFallback(
  mcpUrl: string,
  init: RequestInit
): Promise<{ response: Response; usedUrl: string }> {
  const candidates = getMcpUrlCandidates(mcpUrl);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, init);
      return { response, usedUrl: candidate };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(formatNetworkErrorMessage(lastError, candidates));
}

type JsonRpcError = { message: string; code: number };
type JsonRpcResponse<T = unknown> = {
  result?: T;
  error?: JsonRpcError;
};

/**
 * Resolve the MCP endpoint URL.
 * Priority: explicit config > LOBU_MEMORY_URL env > saved memory server > default cloud server.
 */
export async function resolveMcpEndpoint(config?: {
  mcpUrl?: unknown;
  url?: unknown;
  apiUrl?: unknown;
}): Promise<string | null> {
  // Explicit config should win over ambient auth/session state so callers can
  // deterministically target a specific server.
  if (config) {
    if (typeof config.mcpUrl === "string" && config.mcpUrl.trim().length > 0) {
      return config.mcpUrl;
    }
    if (typeof config.url === "string" && config.url.trim().length > 0) {
      const url = config.url as string;
      return url.includes("/mcp") ? url : `${url.replace(/\/+$/, "")}/mcp`;
    }
    if (typeof config.apiUrl === "string" && config.apiUrl.trim().length > 0) {
      return `${(config.apiUrl as string).replace(/\/+$/, "")}/mcp`;
    }
  }

  // Fall back to auth store / env when no explicit target was provided.
  return resolveServerUrl();
}

async function mcpFetch(
  mcpUrl: string,
  body: Record<string, unknown>,
  sessionId?: string,
  protocolVersion?: string,
  contextName?: string
): Promise<{ data: JsonRpcResponse; usedUrl: string; response: Response }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const tokenResult = await getUsableToken(mcpUrl, contextName);
  if (tokenResult) {
    headers.Authorization = `Bearer ${tokenResult.token}`;
  }
  headers.Accept = JSON_MCP_ACCEPT;
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["MCP-Protocol-Version"] = protocolVersion ?? MCP_PROTOCOL_VERSION;
  }

  const { response: res, usedUrl } = await fetchMcpWithFallback(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const authContext = tokenResult
      ? ` using context "${tokenResult.contextName}"`
      : " without an access token";
    const hint =
      res.status === 401
        ? `${authContext}. Try --context <name> or run \`lobu context use <name>\`.`
        : authContext;
    throw new ApiError(
      `MCP request failed via ${usedUrl}: ${res.status} ${res.statusText}${hint}`,
      res.status
    );
  }

  const raw = await res.text();
  const data = raw.length > 0 ? (JSON.parse(raw) as JsonRpcResponse) : {};
  return { data, usedUrl, response: res };
}

async function initializeMcpSession(
  mcpUrl: string,
  contextName?: string
): Promise<{ sessionId: string; protocolVersion: string; usedUrl: string }> {
  const { data, usedUrl, response } = await mcpFetch(
    mcpUrl,
    {
      jsonrpc: "2.0",
      id: "__init__",
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "lobu-memory", version: "1.0.0" },
      },
    },
    undefined,
    undefined,
    contextName
  );

  if (data.error) {
    throw new ApiError(
      `MCP error: ${data.error.message} (code ${data.error.code})`
    );
  }

  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new ApiError(
      `MCP initialize via ${usedUrl} did not return an mcp-session-id header`
    );
  }

  const protocolVersion = (
    data.result as { protocolVersion?: unknown } | undefined
  )?.protocolVersion;
  if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
    throw new ApiError(
      `MCP initialize via ${usedUrl} did not return a protocolVersion`
    );
  }

  await mcpFetch(
    mcpUrl,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    sessionId,
    protocolVersion,
    contextName
  );

  return { sessionId, protocolVersion, usedUrl };
}

export async function mcpRpc(
  mcpUrl: string,
  method: string,
  params?: Record<string, unknown>,
  contextName?: string
) {
  const { sessionId, protocolVersion } = await initializeMcpSession(
    mcpUrl,
    contextName
  );
  const { data } = await mcpFetch(
    mcpUrl,
    {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: params || {},
    },
    sessionId,
    protocolVersion,
    contextName
  );

  if (data.error) {
    throw new ApiError(
      `MCP error: ${data.error.message} (code ${data.error.code})`
    );
  }

  return data.result;
}

/**
 * Shared REST-proxy call against `{origin}/api/{orgSlug}/{path}`, reusing the
 * same auth resolution and localhost/docker-host fallback as `mcpRpc`. Returns
 * the raw handler result as parsed JSON (no MCP envelope). Throws `ApiError` on
 * non-2xx, surfacing the server's `{ error }` message when present.
 *
 * `restToolCall` is a thin POST wrapper used by the CLI call path.
 */
async function restCall<T>(
  mcpUrl: string,
  path: string,
  opts: {
    method: "GET" | "POST";
    body?: Record<string, unknown>;
    failureLabel: string;
    noOrgMessage: (mcpUrl: string) => string;
  },
  contextName?: string
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const tokenResult = await getUsableToken(mcpUrl, contextName);
  if (tokenResult) {
    headers.Authorization = `Bearer ${tokenResult.token}`;
  }

  // Prefer the org slug pinned in the URL (`/mcp/{slug}`). Fall back to the
  // session's bound org so callers using a bare `/mcp` URL still resolve.
  const orgSlug = orgFromMcpUrl(mcpUrl) ?? tokenResult?.session.org ?? null;
  if (!orgSlug) {
    throw new ApiError(opts.noOrgMessage(mcpUrl));
  }

  const baseUrl = new URL(mcpUrl).origin;
  const endpoint = `${baseUrl}/api/${orgSlug}/${path}`;

  const { response: res, usedUrl } = await fetchMcpWithFallback(endpoint, {
    method: opts.method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });

  const raw = await res.text();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    if (raw) {
      try {
        message = extractApiError(
          JSON.parse(raw),
          res.status,
          res.statusText
        ).message;
      } catch {
        message = raw;
      }
    }
    const authContext = tokenResult
      ? ` using context "${tokenResult.contextName}"`
      : " without an access token";
    const hint =
      res.status === 401
        ? `${authContext}. Try --context <name> or run \`lobu context use <name>\`.`
        : authContext;
    throw new ApiError(
      `${opts.failureLabel} failed via ${usedUrl}: ${message}${hint}`,
      res.status
    );
  }

  return (raw.length > 0 ? JSON.parse(raw) : {}) as T;
}

/**
 * Call a Lobu memory tool over the REST proxy at `POST /api/{orgSlug}/{toolName}`.
 */
export function restToolCall<T = unknown>(
  mcpUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  contextName?: string
): Promise<T> {
  return restCall<T>(
    mcpUrl,
    toolName,
    {
      method: "POST",
      body: args,
      failureLabel: toolName,
      noOrgMessage: (url) =>
        `Cannot call ${toolName}: no org slug on MCP URL ${url}. Use --org or run: lobu memory org set <org>`,
    },
    contextName
  );
}
