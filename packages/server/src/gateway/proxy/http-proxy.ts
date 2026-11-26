import type { LookupAddress } from "node:dns";
import * as http from "node:http";
import * as net from "node:net";
import type { WorkerTokenData } from "@lobu/core";
import { createLogger, verifyEgressProxyToken } from "@lobu/core";
import {
  canonicalizeHostname,
  decideEgress,
  type EgressDecision,
  isUnrestrictedMode,
} from "@lobu/connector-sdk/egress-policy";
import {
  normalizeIpLiteral,
  stripIpv6Brackets,
} from "@lobu/connector-sdk/ip-reachability";
import {
  DnsResolutionError,
  MalformedHostError,
  PrivateAddressError,
  resolveEgressAddresses,
} from "@lobu/connector-worker/egress";
import { constantTimeEqual } from "../../utils/constant-time-equal.js";
import {
  loadAllowedDomains,
  loadDisallowedDomains,
} from "../config/network-allowlist.js";
import type { RevokedTokenStore } from "../auth/revoked-token-store.js";
import { getRevokedTokenStore } from "../auth/revoked-token-store.js";
import type { GrantStore } from "../permissions/grant-store.js";

const logger = createLogger("http-proxy");

/**
 * The worker network allow/deny config for one proxy server, resolved once from
 * the environment when the server starts. It is an immutable snapshot threaded
 * through the request handlers — there is deliberately NO process-wide mutable
 * cache. A lazily-populated module global (the previous design) read `process.env`
 * at whatever moment the first request happened to fire and then froze that value
 * for the life of the process, which made initialization order-dependent (and,
 * in the test runner where the module + env are shared across files, leaked one
 * file's env into another's). Resolving per-server removes that coupling entirely.
 */
export interface ResolvedNetworkConfig {
  allowedDomains: string[];
  deniedDomains: string[];
}

/**
 * Resolve the worker network allow/deny config from the current environment.
 * Called once per {@link startHttpProxy}. The pattern lists are pre-lowercased
 * here so the per-request matcher never re-lowercases on the hot path.
 */
export function resolveNetworkConfig(): ResolvedNetworkConfig {
  return {
    allowedDomains: loadAllowedDomains().map((d) => d.toLowerCase()),
    deniedDomains: loadDisallowedDomains().map((d) => d.toLowerCase()),
  };
}

interface TargetResolutionResult {
  ok: boolean;
  resolvedIp?: string;
  statusCode?: number;
  clientMessage?: string;
  reason?: string;
}

// Module-level grant store reference for domain grant checks
let proxyGrantStore: GrantStore | null = null;

// Injectable revoked-token store. Defaults to the process-wide singleton (the
// only DB-backed instance in prod). Tests inject a store so they can exercise
// the cross-replica revocation path — a jti revoked on "pod A" (a separate
// store instance writing the shared `revoked_tokens` table) must be denied by
// the proxy even though it was never seen by this pod's in-memory cache.
let proxyRevokedTokenStore: RevokedTokenStore | null = null;

function getProxyRevokedTokenStore(): RevokedTokenStore {
  return proxyRevokedTokenStore ?? getRevokedTokenStore();
}

/**
 * Override the revoked-token store the proxy consults. Production leaves this
 * null (uses the singleton); tests inject a store backed by an isolated cache
 * so they can simulate a revoke that happened on another replica.
 */
export function setProxyRevokedTokenStore(
  store: RevokedTokenStore | null
): void {
  proxyRevokedTokenStore = store;
}

/**
 * Set the grant store the proxy consults when resolving per-agent
 * allow/deny grants. Production wires this from `CoreServices`; tests use
 * it to install a mock or a fresh DB-backed store so the cross-org leakage
 * fixed in this PR can be exercised end-to-end.
 */
export function setProxyGrantStore(store: GrantStore): void {
  proxyGrantStore = store;
}

/**
 * Domain access check for one proxied request. The decision order itself —
 * global denylist → per-agent deny grant → global allowlist → per-agent allow
 * grant → deny — is `decideEgress` in
 * `@lobu/connector-sdk/egress-policy`, shared with every other egress
 * enforcement point. This function only binds the proxy's stores to it.
 */
async function checkDomainAccess(
  config: ResolvedNetworkConfig,
  hostname: string,
  agentId: string | undefined,
  organizationId: string | undefined
): Promise<EgressDecision> {
  // Pass `organizationId` explicitly — `GrantStore` falls back to the ALS
  // org context when omitted, but the raw Node HTTP proxy never sets ALS
  // and the WHERE clause would drop its `organization_id` predicate,
  // leaking grants/denies across tenants that share an agent id.
  const grantStore = proxyGrantStore;
  const tenant =
    grantStore && agentId
      ? {
          isDenied: async (host: string) => {
            const denied = await grantStore.isDenied(
              agentId,
              host,
              organizationId
            );
            if (denied) {
              logger.debug(`Domain ${host} denied via grant (agent: ${agentId})`);
            }
            return denied;
          },
          hasGrant: async (host: string) => {
            const granted = await grantStore.hasGrant(
              agentId,
              host,
              organizationId
            );
            if (granted) {
              logger.debug(`Domain ${host} allowed via grant (agent: ${agentId})`);
            }
            return granted;
          },
        }
      : undefined;

  return decideEgress({ hostname, global: config, tenant });
}

interface ProxyCredentials {
  deploymentName: string;
  token: string;
}

type DnsLookupAllFn = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<LookupAddress[]>;

let dnsLookupOverride: DnsLookupAllFn | null = null;
let upstreamRequestTimeoutMs = 30_000;

export const __testOnly = {
  checkDomainAccess,
  canonicalizeHostname,
  /**
   * Clear the explicitly-injected test doubles (stores + DNS override) so one
   * test file's injection doesn't leak into another. Network config is NOT here:
   * it's no longer a module global — each {@link startHttpProxy} resolves its own
   * immutable snapshot, and direct {@link checkDomainAccess} callers pass one in.
   */
  reset: () => {
    proxyGrantStore = null;
    proxyRevokedTokenStore = null;
    dnsLookupOverride = null;
    upstreamRequestTimeoutMs = 30_000;
  },
  setDnsLookup(fn: DnsLookupAllFn | null): void {
    dnsLookupOverride = fn;
  },
  setUpstreamRequestTimeoutMs(timeoutMs: number | null): void {
    upstreamRequestTimeoutMs =
      timeoutMs !== null && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : 30_000;
  },
};

/**
 * Resolve the tunnel target through the shared egress transport
 * (`@lobu/connector-worker/egress`): IP literals are normalized and checked,
 * names are resolved once and the WHOLE answer set must be public, and the
 * caller dials the exact address returned — never re-resolving, so a resolver
 * that flips between a public and an internal answer (DNS rebinding) cannot
 * slip past the blocklist. This function only maps the transport's typed
 * errors onto the proxy's status lines.
 *
 * Adopting the transport also adopts its pre-DNS name rules: `localhost` and
 * the internal suffixes (`.localhost`, `.local`, `.internal`, `.intranet`,
 * `.corp`, `.lan`, `.home`) are refused before a lookup instead of being
 * resolved and then blocked on the answer. Same 403, one round trip earlier,
 * and an internal name that happens to resolve publicly no longer gets through.
 */
async function resolveAndValidateTarget(
  rawHostname: string
): Promise<TargetResolutionResult> {
  const override = dnsLookupOverride;
  try {
    const addresses = await resolveEgressAddresses(rawHostname, {
      lookup: override
        ? (hostname) => override(hostname, { all: true, verbatim: true })
        : undefined,
    });
    return { ok: true, resolvedIp: addresses[0]?.address };
  } catch (error) {
    if (error instanceof MalformedHostError) {
      return {
        ok: false,
        statusCode: 403,
        clientMessage: `403 Forbidden - Malformed target host: ${rawHostname}`,
        reason: error.message,
      };
    }
    if (error instanceof PrivateAddressError) {
      const literal =
        normalizeIpLiteral(stripIpv6Brackets(rawHostname)).kind !== "not-ip";
      return {
        ok: false,
        statusCode: 403,
        clientMessage: literal
          ? `403 Forbidden - Target IP not allowed: ${rawHostname}`
          : `403 Forbidden - Target resolves to local/private IP: ${rawHostname}`,
        reason: error.message,
      };
    }
    if (error instanceof DnsResolutionError) {
      return {
        ok: false,
        statusCode: 502,
        clientMessage: `Bad Gateway: Could not resolve target host ${rawHostname}`,
        reason: error.message,
      };
    }
    throw error;
  }
}

/**
 * Extract deployment name and token from Proxy-Authorization Basic auth header.
 * Workers send: HTTP_PROXY=http://<deploymentName>:<token>@gateway:8118
 * This creates a Basic auth header with username=deploymentName, password=token
 */
function extractProxyCredentials(
  req: http.IncomingMessage
): ProxyCredentials | null {
  const authHeader = req.headers["proxy-authorization"];
  if (!authHeader || typeof authHeader !== "string") {
    return null;
  }

  // Parse Basic auth without a backtracking expression over an untrusted
  // header. RFC 7235 requires at least one space between scheme and token, so
  // trimming must actually consume something.
  const credentialPart = authHeader.slice(5);
  const encodedCredentials = credentialPart.trimStart();
  const hasSchemeSeparator = encodedCredentials.length < credentialPart.length;
  if (
    authHeader.slice(0, 5).toLowerCase() !== "basic" ||
    !hasSchemeSeparator ||
    !encodedCredentials
  ) {
    return null;
  }

  try {
    const decoded = Buffer.from(encodedCredentials, "base64").toString("utf-8");
    const colonIndex = decoded.indexOf(":");
    if (colonIndex === -1) {
      return null;
    }
    const deploymentName = decoded.substring(0, colonIndex);
    const token = decoded.substring(colonIndex + 1);
    if (!deploymentName || !token) {
      return null;
    }
    return { deploymentName, token };
  } catch {
    return null;
  }
}

interface ValidatedProxy {
  deploymentName: string;
  tokenData: WorkerTokenData;
}

/**
 * Validate proxy authentication using the egress-only token exposed through
 * HTTP_PROXY, then cross-check the claimed deployment name. Worker-facing
 * gateway routes reject this token kind.
 *
 * Revocation is checked against the synchronous in-memory cache only, so the DB
 * never blocks egress. Under N>1 replicas a token revoked on pod A is initially
 * invisible to pod B's cache; on a cache miss we fire a background DB refresh
 * (fire-and-forget) that pulls the revoke into the cache, so the next request
 * for that jti is denied — closing the cross-pod gap within one request rather
 * than waiting out the cache TTL.
 */
async function validateProxyAuth(
  req: http.IncomingMessage
): Promise<ValidatedProxy | null> {
  const creds = extractProxyCredentials(req);
  if (!creds) {
    return null;
  }

  const tokenData = verifyEgressProxyToken(creds.token);
  if (!tokenData) {
    logger.warn(
      `Proxy auth failed: invalid token (claimed deployment: ${creds.deploymentName})`
    );
    return null;
  }

  // Revocation check. The hot path is the synchronous in-memory cache so a
  // slow/unavailable DB never blocks egress. On a cache miss we allow this
  // request (the pre-existing semantics) but kick off a background DB refresh, so
  // a jti revoked on ANOTHER replica is pulled into this pod's cache and denied
  // on the next request — closing the cross-pod gap within one request instead of
  // waiting out the cache TTL (or the token's lifetime). `isRevoked` fails open
  // on a DB error and swallows its own rejections.
  if (tokenData.jti) {
    const store = getProxyRevokedTokenStore();
    if (store.isRevokedCached(tokenData.jti)) {
      logger.warn(
        `Proxy auth failed: revoked jti (claimed deployment: ${creds.deploymentName})`
      );
      return null;
    }
    void store.isRevoked(tokenData.jti).catch(() => {});
  }

  const deploymentMatch = constantTimeEqual(
    tokenData.deploymentName,
    creds.deploymentName
  );
  if (!deploymentMatch) {
    logger.warn(
      `Proxy auth failed: deployment mismatch (claimed: ${creds.deploymentName}, token: ${tokenData.deploymentName})`
    );
    return null;
  }

  return { deploymentName: creds.deploymentName, tokenData };
}

/**
 * Structured audit log for every access decision. We keep the shape stable
 * (one log record per request) so operators can grep / index on it. We do
 * NOT log request bodies or headers — the proxy is a trust boundary and
 * the audit log must not become a secondary leak surface.
 */
function logAccessDecision(
  method: string,
  hostname: string,
  deploymentName: string,
  agentId: string | undefined,
  decision: EgressDecision
): void {
  // Audit log only fires for non-trivial decisions — grant decisions and
  // every denial. Globally-allowed fast-path requests are
  // the common case on busy gateways and flooding the log with them turns
  // a useful audit stream into noise (and costs serialization per req).
  if (decision.allowed && decision.source === "global") {
    return;
  }
  logger.info("egress-decision", {
    method,
    hostname,
    deploymentName,
    agentId,
    allowed: decision.allowed,
    source: decision.source,
  });
}

/**
 * Strip CR/LF and trim to a safe length so a reason can't inject extra HTTP
 * response headers via the status line.
 */
function escapeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 300);
}

function parseConnectTarget(
  url: string
): { hostname: string; port: number } | null {
  const match =
    url.match(/^\[([^\]]+)\]:(\d+)$/) ?? url.match(/^([^:]+):(\d+)$/);
  const hostname = match?.[1];
  const portRaw = match?.[2];
  if (!hostname || !portRaw) return null;

  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { hostname, port };
}

/**
 * Handle HTTPS CONNECT tunneling with per-deployment network config
 */
async function handleConnect(
  config: ResolvedNetworkConfig,
  req: http.IncomingMessage,
  clientSocket: import("stream").Duplex,
  head: Buffer
): Promise<void> {
  const url = req.url || "";
  const target = parseConnectTarget(url);

  if (!target) {
    logger.warn(`Invalid CONNECT request: ${url}`);
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.end();
    return;
  }
  const { hostname, port } = target;

  let targetSocket: net.Socket | null = null;
  clientSocket.on("error", (err) => {
    // Clients commonly reset denied CONNECT tunnels after reading the 4xx
    // response. A Duplex socket with no error listener treats ECONNRESET as
    // process-fatal, so attach this handler before any early-return path can
    // write and close the socket.
    if ((err as NodeJS.ErrnoException).code === "ECONNRESET") {
      logger.debug(`Client disconnected for ${hostname} (ECONNRESET)`);
    } else {
      logger.debug(`Client connection error for ${hostname}: ${err.message}`);
    }
    try {
      targetSocket?.end();
    } catch {
      // Ignore errors while cleaning up an already-closed target socket.
    }
  });
  clientSocket.on("close", () => {
    try {
      targetSocket?.end();
    } catch {
      // Ignore errors while cleaning up an already-closed target socket.
    }
  });

  // Validate the egress-only proxy token.
  const auth = await validateProxyAuth(req);
  if (!auth) {
    logger.warn(`Proxy auth required for CONNECT to ${hostname}`);
    try {
      clientSocket.write(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="lobu-proxy"\r\n\r\n'
      );
      clientSocket.end();
    } catch {
      // Client may have already disconnected
    }
    return;
  }

  const { deploymentName, tokenData } = auth;

  // Check domain access: global config → grant store.
  const decision = await checkDomainAccess(
    config,
    hostname,
    tokenData.agentId,
    tokenData.organizationId
  );
  logAccessDecision(
    "CONNECT",
    hostname,
    deploymentName,
    tokenData.agentId,
    decision
  );
  if (!decision.allowed) {
    const reason = `Domain not allowed: ${hostname}`;
    logger.warn(
      `Blocked CONNECT to ${hostname} (deployment: ${deploymentName}) - ${reason}`
    );
    try {
      clientSocket.write(
        `HTTP/1.1 403 ${escapeHeaderValue(reason)}\r\nContent-Type: text/plain\r\n\r\n403 Forbidden - ${reason}. Network access is configured via lobu.config.ts, agent settings, or the gateway configuration APIs.\r\n`
      );
      clientSocket.end();
    } catch {
      // Client may have already disconnected
    }
    return;
  }

  const targetResolution = await resolveAndValidateTarget(hostname);
  if (!targetResolution.ok) {
    logger.warn(
      `Blocked CONNECT to ${hostname} (deployment: ${deploymentName}) - ${targetResolution.reason}`
    );
    try {
      clientSocket.write(
        `HTTP/1.1 ${targetResolution.statusCode} ${
          targetResolution.statusCode === 403 ? "Forbidden" : "Bad Gateway"
        }\r\nContent-Type: text/plain\r\n\r\n${targetResolution.clientMessage}\r\n`
      );
      clientSocket.end();
    } catch {
      // Client may have already disconnected
    }
    return;
  }

  const resolvedIp = targetResolution.resolvedIp;
  if (!resolvedIp) {
    clientSocket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    clientSocket.end();
    return;
  }

  logger.debug(`Allowing CONNECT to ${hostname} via ${resolvedIp}`);

  // Establish connection to target
  const tunnelSocket = net.connect(port, resolvedIp, () => {
    // Send success response to client
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // Pipe the connection bidirectionally
    tunnelSocket.write(head);
    tunnelSocket.pipe(clientSocket);
    clientSocket.pipe(tunnelSocket);
  });
  targetSocket = tunnelSocket;

  tunnelSocket.on("error", (err) => {
    logger.debug(`Target connection error for ${hostname}: ${err.message}`);
    try {
      clientSocket.end();
    } catch {
      // Ignore errors when closing already-closed socket
    }
  });

  // Handle close events to clean up
  tunnelSocket.on("close", () => {
    try {
      clientSocket.end();
    } catch {
      // Ignore
    }
  });
}

/**
 * Handle regular HTTP proxy requests with per-deployment network config
 */
async function handleProxyRequest(
  config: ResolvedNetworkConfig,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (req.method === "CONNECT") {
    await handleConnectRequestFallback(config, req, res);
    return;
  }

  const targetUrl = req.url;

  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request: No URL provided\n");
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request: Invalid URL\n");
    return;
  }

  const hostname = parsedUrl.hostname;

  // Validate the egress-only proxy token.
  const auth = await validateProxyAuth(req);
  if (!auth) {
    logger.warn(`Proxy auth required for ${req.method} ${hostname}`);
    res.writeHead(407, {
      "Content-Type": "text/plain",
      "Proxy-Authenticate": 'Basic realm="lobu-proxy"',
    });
    res.end("407 Proxy Authentication Required\n");
    return;
  }

  const { deploymentName, tokenData } = auth;

  // Check domain access: global config → grant store.
  const decision = await checkDomainAccess(
    config,
    hostname,
    tokenData.agentId,
    tokenData.organizationId
  );
  logAccessDecision(
    req.method ?? "?",
    hostname,
    deploymentName,
    tokenData.agentId,
    decision
  );
  if (!decision.allowed) {
    const reason = `Domain not allowed: ${hostname}`;
    const safeReason = escapeHeaderValue(reason);
    logger.warn(
      `Blocked request to ${hostname} (deployment: ${deploymentName}) - ${reason}`
    );
    res.statusMessage = safeReason;
    res.writeHead(403, {
      "Content-Type": "text/plain",
    });
    res.end(
      `403 Forbidden - ${reason}. Network access is configured via lobu.config.ts, agent settings, or the gateway configuration APIs.\n`
    );
    return;
  }

  const targetResolution = await resolveAndValidateTarget(hostname);
  if (!targetResolution.ok) {
    logger.warn(
      `Blocked request to ${hostname} (deployment: ${deploymentName}) - ${targetResolution.reason}`
    );
    res.writeHead(targetResolution.statusCode ?? 502, {
      "Content-Type": "text/plain",
    });
    res.end(`${targetResolution.clientMessage}\n`);
    return;
  }

  const resolvedIp = targetResolution.resolvedIp;
  if (!resolvedIp) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal proxy error\n");
    return;
  }

  logger.debug(
    `Proxying ${req.method} ${hostname}${parsedUrl.pathname} via ${resolvedIp}`
  );

  // Remove proxy-authorization header before forwarding
  const forwardHeaders = { ...req.headers };
  delete forwardHeaders["proxy-authorization"];

  // Forward the request
  const options: http.RequestOptions = {
    hostname: resolvedIp,
    port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: req.method,
    headers: forwardHeaders,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Redirects (3xx + Location) are forwarded verbatim and NOT followed
    // here. This is a forward proxy: the client sees the 3xx, issues a brand
    // new request for the Location URL, and that request re-enters this proxy
    // and goes through `checkDomainAccess` + `resolveAndValidateTarget`
    // again. So a redirect to an internal address can't bypass the guards —
    // the follow-up request is independently re-validated. (If this code ever
    // grows redirect-following, the redirect target MUST be re-validated.)
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    // Stream response body
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    logger.error(`Proxy request error for ${hostname}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway: Could not reach target server\n");
    } else {
      res.end();
    }
  });
  const upstreamTimer = setTimeout(() => {
    proxyReq.destroy(new Error("Upstream request timed out"));
  }, upstreamRequestTimeoutMs);
  proxyReq.on("close", () => clearTimeout(upstreamTimer));

  // Stream request body
  req.pipe(proxyReq);
}

async function handleConnectRequestFallback(
  config: ResolvedNetworkConfig,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const target = parseConnectTarget(req.url || "");
  if (!target) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request: Invalid CONNECT target\n");
    return;
  }

  const { hostname } = target;
  const auth = await validateProxyAuth(req);
  if (!auth) {
    res.writeHead(407, {
      "Content-Type": "text/plain",
      "Proxy-Authenticate": 'Basic realm="lobu-proxy"',
    });
    res.end("407 Proxy Authentication Required\n");
    return;
  }

  const { deploymentName, tokenData } = auth;
  const decision = await checkDomainAccess(
    config,
    hostname,
    tokenData.agentId,
    tokenData.organizationId
  );
  logAccessDecision(
    "CONNECT",
    hostname,
    deploymentName,
    tokenData.agentId,
    decision
  );
  if (!decision.allowed) {
    const reason = `Domain not allowed: ${hostname}`;
    const safeReason = escapeHeaderValue(reason);
    res.statusMessage = safeReason;
    res.writeHead(403, {
      "Content-Type": "text/plain",
    });
    res.end(
      `403 Forbidden - ${reason}. Network access is configured via lobu.config.ts, agent settings, or the gateway configuration APIs.\n`
    );
    return;
  }

  const targetResolution = await resolveAndValidateTarget(hostname);
  if (!targetResolution.ok) {
    res.writeHead(targetResolution.statusCode ?? 502, {
      "Content-Type": "text/plain",
    });
    res.end(`${targetResolution.clientMessage}\n`);
    return;
  }

  res.writeHead(200, "Connection Established");
  res.end();
}

/**
 * Start HTTP proxy server with per-deployment network config support.
 *
 * Workers identify themselves via Proxy-Authorization Basic auth:
 *   HTTP_PROXY=http://<deploymentName>:<token>@gateway:8118
 *
 * The proxy validates the encrypted egress token, cross-checks the
 * claimed deployment name, and looks up per-deployment network config.
 * Returns 407 if authentication fails.
 *
 * @param port - Port to listen on (default 8118)
 * @param host - Bind address (default "::" for all interfaces)
 * @param config - Network allow/deny config for this server. Defaults to a fresh
 *   snapshot resolved from the environment; tests pass one explicitly so the
 *   server's result is fully determined by its arguments, not ambient state.
 * @returns Promise that resolves with the server once listening, or rejects on error
 */
export function startHttpProxy(
  port: number = 8118,
  host: string = "::",
  config: ResolvedNetworkConfig = resolveNetworkConfig()
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const global = config;

    const server = http.createServer((req, res) => {
      handleProxyRequest(config, req, res).catch((err) => {
        logger.error("Error handling proxy request:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal proxy error\n");
        }
      });
    });

    // Handle CONNECT method for HTTPS tunneling
    server.on("connect", (req, clientSocket, head) => {
      handleConnect(config, req, clientSocket, head).catch((err) => {
        logger.error("Error handling CONNECT:", err);
        try {
          clientSocket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
          clientSocket.end();
        } catch {
          // Ignore
        }
      });
    });

    server.on("error", (err) => {
      logger.error("HTTP proxy server error:", err);
      reject(err);
    });

    server.listen(port, host, () => {
      // Remove the startup error listener so it doesn't reject later operational errors
      server.removeAllListeners("error");
      server.on("error", (err) => {
        logger.error("HTTP proxy server error:", err);
      });

      let mode: string;
      if (isUnrestrictedMode(global.allowedDomains)) {
        mode = "unrestricted";
      } else if (global.allowedDomains.length > 0) {
        mode = "allowlist";
      } else {
        mode = "complete-isolation";
      }

      logger.debug(
        `HTTP proxy started on ${host}:${port} (mode=${mode}, allowed=${global.allowedDomains.length}, denied=${global.deniedDomains.length})`
      );
      resolve(server);
    });
  });
}

/**
 * Stop HTTP proxy server
 */
export function stopHttpProxy(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        if (err.message === "Server is not running") {
          resolve();
          return;
        }
        logger.error("Error stopping HTTP proxy:", err);
        reject(err);
      } else {
        logger.info("HTTP proxy stopped");
        resolve();
      }
    });
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}
