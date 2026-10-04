/**
 * Security-hardening tests for the worker network proxy and egress judge.
 *
 * Covers edge cases that the existing test suite does not reach:
 *   - IP-address blocking (ranges, IPv4-mapped IPv6, zone IDs, IPv6 variants)
 *   - Domain-pattern matching bypasses (wildcard boundary, case, CONNECT IPv6)
 *   - CRLF injection via judge reason → HTTP response splitting
 *   - Circuit-breaker state transitions (including success-resets-counter)
 *   - VerdictCache key independence and policy-hash invalidation
 *   - PolicyStore resolve edge cases (exact > wildcard, longer wildcard > shorter,
 *     agentId isolation, missing judge name)
 *
 * NOTE: Per-call judge timeout (judgeTimeoutMs / EGRESS_JUDGE_TIMEOUT_MS) is
 * documented in AGENTS.md and was present in an earlier version of EgressJudge
 * but the current implementation directly awaits this.client.judge() with no
 * deadline. Tests for timeout semantics are omitted until the feature is re-added.
 *
 * NOTE: NAT64 address translation (64:ff9b::/96 prefix) IS handled. The IP
 * normalization + reserved-range matcher live in the shared
 * `@lobu/connector-sdk/ip-reachability` (`isReservedIp`), which the proxy
 * reaches through the shared `@lobu/connector-worker/egress` transport. A
 * 64:ff9b::7f00:1 literal decodes to 127.0.0.1 and is blocked — see
 * http-proxy.test.ts and ip-reachability-matcher.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import type * as http from "node:http";
import * as net from "node:net";
import {
  __resetEncryptionKeyCacheForTests,
  generateWorkerTokenPair,
} from "@lobu/core";
import { isReservedIp } from "@lobu/connector-sdk/ip-reachability";
import { PolicyStore } from "../permissions/policy-store.js";
import { CircuitBreaker } from "../proxy/egress-judge/circuit-breaker.js";
import { EgressJudge } from "../proxy/egress-judge/judge.js";
import type { ResolvedJudgeRule } from "../permissions/policy-store.js";
import type { JudgeClient, JudgeVerdict } from "../proxy/egress-judge/types.js";
import { VerdictCache } from "../proxy/egress-judge/cache.js";
import { withFreePortRetry } from "../../__tests__/setup/free-port.js";
import {
  __testOnly,
  type ResolvedNetworkConfig,
  resolveNetworkConfig,
  setProxyEgressJudge,
  setProxyPolicyStore,
  setProxyRevokedTokenStore,
  startHttpProxy,
  stopHttpProxy,
} from "../proxy/http-proxy.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

function makeBasicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function createToken(
  deploymentName: string,
  agentId?: string,
  organizationId: string = "org-1"
): string {
  return generateWorkerTokenPair("test-user", "test-conv", deploymentName, {
    channelId: "test-channel",
    platform: "test",
    ...(agentId ? { agentId } : {}),
    organizationId,
  }).egressProxyToken;
}

function rawProxyRequest(
  proxyPort: number,
  targetUrl: string,
  proxyAuth: string
): Promise<{ statusCode: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.connect(proxyPort, "127.0.0.1", () => {
      const u = new URL(targetUrl);
      const req =
        `GET ${targetUrl} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        `Proxy-Authorization: ${proxyAuth}\r\n` +
        `Connection: close\r\n\r\n`;
      socket.write(req);
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    socket.on("end", () => {
      const firstLine = data.substring(0, data.indexOf("\r\n"));
      const match = firstLine.match(/HTTP\/\d\.\d (\d+)/);
      const statusCode = match ? parseInt(match[1]!, 10) : 0;
      const headerEnd = data.indexOf("\r\n\r\n");
      const headers = headerEnd !== -1 ? data.substring(0, headerEnd) : data;
      const body = headerEnd !== -1 ? data.substring(headerEnd + 4) : "";
      resolve({ statusCode, headers, body });
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
  });
}

function connectRequest(
  proxyPort: number,
  host: string,
  port: number,
  proxyAuth: string
): Promise<{ statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.connect(proxyPort, "127.0.0.1", () => {
      const req =
        `CONNECT ${host}:${port} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Proxy-Authorization: ${proxyAuth}\r\n\r\n`;
      socket.write(req);
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      const lineEnd = data.indexOf("\r\n");
      if (lineEnd !== -1) {
        socket.destroy();
        resolve({ statusLine: data.substring(0, lineEnd) });
      }
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
  });
}

function rule(overrides: Partial<ResolvedJudgeRule> = {}): ResolvedJudgeRule {
  return {
    judgeName: "default",
    policy: "allow only trusted sources",
    policyHash: "test-policy-hash",
    ...overrides,
  };
}

// The proxy consults a DB-backed revoked-token store on cache miss (F1). The
// proxy-server describes below run without a reachable DB, so they inject this
// fast stub (nothing revoked) in their beforeEach. The real cross-replica
// revocation path is covered by http-proxy.test.ts.
const NOOP_REVOKED_STORE = {
  isRevoked: async () => false,
  isRevokedCached: () => false,
} as unknown as Parameters<typeof setProxyRevokedTokenStore>[0];

// ─── isReservedIp — unit tests ─────────────────────────────────────────

describe("isReservedIp — unit coverage", () => {
  // ── Private IPv4 ranges ────────────────────────────────────────────────

  test("blocks 0.0.0.0 (unspecified IPv4 / 0.0.0.0/8)", () => {
    expect(isReservedIp("0.0.0.0")).toBe(true);
  });

  test("blocks 127.0.0.1 (loopback / 127.0.0.0/8)", () => {
    expect(isReservedIp("127.0.0.1")).toBe(true);
  });

  test("blocks 127.255.255.254 (within loopback /8)", () => {
    expect(isReservedIp("127.255.255.254")).toBe(true);
  });

  test("blocks 10.0.0.1 (RFC-1918 10.0.0.0/8)", () => {
    expect(isReservedIp("10.0.0.1")).toBe(true);
  });

  test("blocks 192.168.1.1 (RFC-1918 192.168.0.0/16)", () => {
    expect(isReservedIp("192.168.1.1")).toBe(true);
  });

  test("blocks 172.16.0.1 (RFC-1918 172.16.0.0/12 lower boundary)", () => {
    expect(isReservedIp("172.16.0.1")).toBe(true);
  });

  test("blocks 172.31.255.255 (RFC-1918 172.16.0.0/12 upper boundary)", () => {
    expect(isReservedIp("172.31.255.255")).toBe(true);
  });

  test("allows 172.32.0.1 (just outside 172.16.0.0/12 range)", () => {
    expect(isReservedIp("172.32.0.1")).toBe(false);
  });

  test("blocks 169.254.0.1 (link-local / 169.254.0.0/16)", () => {
    expect(isReservedIp("169.254.0.1")).toBe(true);
  });

  test("blocks 100.64.0.1 (CGNAT / 100.64.0.0/10)", () => {
    expect(isReservedIp("100.64.0.1")).toBe(true);
  });

  test("does not block a public IPv4 (8.8.8.8)", () => {
    expect(isReservedIp("8.8.8.8")).toBe(false);
  });

  // ── IPv6 ranges ────────────────────────────────────────────────────────

  test("blocks ::1 (IPv6 loopback)", () => {
    expect(isReservedIp("::1")).toBe(true);
  });

  test("blocks :: (IPv6 unspecified)", () => {
    expect(isReservedIp("::")).toBe(true);
  });

  test("blocks fe80::1 (IPv6 link-local / fe80::/10)", () => {
    expect(isReservedIp("fe80::1")).toBe(true);
  });

  test("blocks fc00::1 (IPv6 unique-local / fc00::/7)", () => {
    expect(isReservedIp("fc00::1")).toBe(true);
  });

  test("blocks ff01::1 (IPv6 multicast / ff00::/8)", () => {
    expect(isReservedIp("ff01::1")).toBe(true);
  });

  test("does not block a public IPv6 (2606:4700:4700::1111)", () => {
    expect(isReservedIp("2606:4700:4700::1111")).toBe(false);
  });

  // ── IPv4-mapped IPv6 — dotted form ─────────────────────────────────────

  test("blocks ::ffff:127.0.0.1 (IPv4-mapped loopback — dotted form)", () => {
    expect(isReservedIp("::ffff:127.0.0.1")).toBe(true);
  });

  test("blocks ::ffff:192.168.1.1 (IPv4-mapped private — dotted form)", () => {
    expect(isReservedIp("::ffff:192.168.1.1")).toBe(true);
  });

  test("allows ::ffff:8.8.8.8 (IPv4-mapped public — dotted form)", () => {
    expect(isReservedIp("::ffff:8.8.8.8")).toBe(false);
  });

  // ── IPv4-mapped IPv6 — hex form ─────────────────────────────────────────
  // The proxy's parseMappedIpv4HexAddress converts ::ffff:hhhh:hhhh → IPv4.

  test("blocks ::ffff:7f00:1 (IPv4-mapped loopback 127.0.0.1 — hex form)", () => {
    expect(isReservedIp("::ffff:7f00:1")).toBe(true);
  });

  test("blocks ::ffff:c0a8:101 (IPv4-mapped 192.168.1.1 — hex form)", () => {
    expect(isReservedIp("::ffff:c0a8:101")).toBe(true);
  });

  test("allows ::ffff:808:808 (IPv4-mapped 8.8.8.8 — hex form)", () => {
    expect(isReservedIp("::ffff:808:808")).toBe(false);
  });

  // ── Zone IDs ───────────────────────────────────────────────────────────
  // The proxy strips zone IDs via ip.split("%", 1)[0] before checking.

  test("blocks ::1%lo (loopback with zone ID)", () => {
    expect(isReservedIp("::1%lo")).toBe(true);
  });

  test("blocks fe80::1%eth0 (link-local with zone ID)", () => {
    expect(isReservedIp("fe80::1%eth0")).toBe(true);
  });

  // ── Non-IP literals fall through to DNS ───────────────────────────────

  test("returns false for a hostname (not an IP literal — falls through to DNS)", () => {
    expect(isReservedIp("example.com")).toBe(false);
  });

  // NAT64 well-known prefix (64:ff9b::/96) translates to IPv4 destinations.
  // `isReservedIp` decodes the trailing 32 bits and runs them
  // through the IPv4 blocklist, so a synthesised loopback address must be
  // blocked the same way `127.0.0.1` is.

  test("NAT64: 64:ff9b::7f00:1 (→127.0.0.1) is blocked", () => {
    expect(isReservedIp("64:ff9b::7f00:1")).toBe(true);
  });

  test("NAT64: expanded form 64:ff9b:0:0:0:0:7f00:1 is blocked", () => {
    expect(isReservedIp("64:ff9b:0:0:0:0:7f00:1")).toBe(true);
  });
});

// ─── Domain filtering — security edge cases (proxy integration) ───────────────
// These tests spin up a proxy per describe-group with a shared global config.
// "blocks" tests use a DNS mock that returns a public IP (no hang).
// "allows" tests rely on the domain check returning 403; the upstream connection
// is never attempted for deny results.

describe("HTTP Proxy — domain blocking edge cases", () => {
  // A single proxy server for the whole group — avoid restart overhead.
  let proxyServer: http.Server;
  let proxyPort: number;
  const deploymentName = "pattern-test-worker";
  let savedEncryptionKey: string | undefined;
  let savedAllowedDomains: string | undefined;
  let savedDisallowedDomains: string | undefined;

  beforeEach(() => {
    savedEncryptionKey = process.env.ENCRYPTION_KEY;
    savedAllowedDomains = process.env.WORKER_ALLOWED_DOMAINS;
    savedDisallowedDomains = process.env.WORKER_DISALLOWED_DOMAINS;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    __resetEncryptionKeyCacheForTests();
    __testOnly.reset();
    setProxyRevokedTokenStore(NOOP_REVOKED_STORE);
    // DNS mock: all names resolve to a globally reachable address.
    __testOnly.setDnsLookup(async () => [{ address: "8.8.8.8", family: 4 }]);
  });

  afterEach(async () => {
    __testOnly.setDnsLookup(null);
    await stopHttpProxy(proxyServer);
    if (savedEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedEncryptionKey;
    __resetEncryptionKeyCacheForTests();
    if (savedAllowedDomains === undefined) delete process.env.WORKER_ALLOWED_DOMAINS;
    else process.env.WORKER_ALLOWED_DOMAINS = savedAllowedDomains;
    if (savedDisallowedDomains === undefined) {
      delete process.env.WORKER_DISALLOWED_DOMAINS;
    } else {
      process.env.WORKER_DISALLOWED_DOMAINS = savedDisallowedDomains;
    }
    __testOnly.reset();
  });

  async function startProxy(): Promise<void> {
    // Ask the OS for a free port and retry on collision instead of gambling on a
    // random high port — concurrent test load otherwise races to EADDRINUSE (#976).
    proxyServer = await withFreePortRetry(async (port) => {
      const server = await startHttpProxy(port, "127.0.0.1");
      proxyPort = port;
      return server;
    });
  }

  function auth(): string {
    return makeBasicAuth(deploymentName, createToken(deploymentName));
  }

  // ── Wildcard boundary ──────────────────────────────────────────────────

  test("wildcard .example.com does NOT match evilexample.com (boundary bypass)", async () => {
    // SECURITY: 'evilexample.com' ends in 'example.com' but not '.example.com'
    process.env.WORKER_ALLOWED_DOMAINS = ".example.com";
    await startProxy();

    const res = await rawProxyRequest(
      proxyPort,
      "http://evilexample.com/",
      auth()
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("not allowed");
  });

  test("wildcard .example.com does NOT match subevil.EXAMPLE.com (case + boundary)", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = ".example.com";
    await startProxy();

    const res = await rawProxyRequest(
      proxyPort,
      "http://subevileXAMPLE.com/",
      auth()
    );
    expect(res.statusCode).toBe(403);
  });

  test("exact allowlist entry does NOT match subdomains", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "example.com";
    await startProxy();

    const res = await rawProxyRequest(
      proxyPort,
      "http://sub.example.com/",
      auth()
    );
    expect(res.statusCode).toBe(403);
  });

  // ── Isolation mode ─────────────────────────────────────────────────────

  test("empty WORKER_ALLOWED_DOMAINS blocks all requests (complete isolation)", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "";
    await startProxy();

    const res = await rawProxyRequest(proxyPort, "http://example.com/", auth());
    expect(res.statusCode).toBe(403);
  });

  test("allowlist mode blocks domains not in the list", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "example.com";
    await startProxy();

    const res = await rawProxyRequest(
      proxyPort,
      "http://notallowed.com/",
      auth()
    );
    expect(res.statusCode).toBe(403);
  });

  // ── Blocklist in unrestricted mode ────────────────────────────────────

  test("blocklist in unrestricted mode blocks a matching domain", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    process.env.WORKER_DISALLOWED_DOMAINS = "blocked.com";
    await startProxy();

    const res = await rawProxyRequest(
      proxyPort,
      "http://blocked.com/",
      auth()
    );
    expect(res.statusCode).toBe(403);
  });

  test("wildcard blocklist .blocked.com blocks subdomain in unrestricted mode", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    process.env.WORKER_DISALLOWED_DOMAINS = ".blocked.com";
    await startProxy();

    const res = await rawProxyRequest(
      proxyPort,
      "http://api.blocked.com/",
      auth()
    );
    expect(res.statusCode).toBe(403);
  });

  // ── CONNECT to IP literals ─────────────────────────────────────────────

  test("CONNECT to 127.0.0.1 literal is blocked in unrestricted mode", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    await startProxy();

    const res = await connectRequest(proxyPort, "127.0.0.1", 443, auth());
    expect(res.statusLine).toContain("403");
  });

  test("CONNECT to 0.0.0.0 literal is blocked", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    await startProxy();

    const res = await connectRequest(proxyPort, "0.0.0.0", 443, auth());
    expect(res.statusLine).toContain("403");
  });

  test("CONNECT to 192.168.1.1 (RFC-1918) literal is blocked", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    await startProxy();

    const res = await connectRequest(proxyPort, "192.168.1.1", 443, auth());
    expect(res.statusLine).toContain("403");
  });

  test("HTTP request to private IP literal 10.0.0.1 is blocked", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    await startProxy();

    const res = await rawProxyRequest(proxyPort, "http://10.0.0.1/", auth());
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Target IP not allowed");
  });

  test("CONNECT to localhost resolves to loopback — blocked", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    await startProxy();
    // Override mock to simulate localhost → loopback
    __testOnly.setDnsLookup(async (hostname) => {
      if (hostname === "localhost") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      return [{ address: "8.8.8.8", family: 4 }];
    });

    const res = await connectRequest(proxyPort, "localhost", 443, auth());
    expect(res.statusLine).toContain("403");
  });

  test("CONNECT to an internal-suffix name is blocked even when DNS answers public", async () => {
    // The shared transport refuses `localhost`/`.localhost`/`.local`/
    // `.internal` before it resolves them, so an internal name whose resolver
    // hands back a public address no longer tunnels. Pin that: this DNS mock
    // returns 8.8.8.8, which the answer-set check alone would let through.
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    await startProxy();
    __testOnly.setDnsLookup(async () => [{ address: "8.8.8.8", family: 4 }]);

    const res = await connectRequest(
      proxyPort,
      "metadata.internal",
      443,
      auth()
    );
    expect(res.statusLine).toContain("403");
  });

  test("CONNECT to [::1] (bracketed IPv6 literal) is blocked", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    await startProxy();

    const res = await connectRequest(proxyPort, "[::1]", 443, auth());
    expect(res.statusLine).toContain("403");
  });

  test("DNS rebinding: mix of public and loopback IPs is blocked", async () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    await startProxy();
    // Return a mix — any loopback in the list should block the request
    __testOnly.setDnsLookup(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    const res = await rawProxyRequest(
      proxyPort,
      "http://rebind.test/",
      auth()
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("local/private IP");
  });
});

// ─── CRLF injection via judge reason ─────────────────────────────────────────
// `escapeHeaderValue()` strips CRLF from the HTTP status-line message. The raw
// reason still ends up in the response body — that's acceptable for a forward
// proxy. What we must NOT see is the injected text breaking out into a separate
// HTTP header line.

describe("CRLF injection prevention in judge-provided reason", () => {
  let proxyServer: http.Server;
  let proxyPort: number;
  const policyStore = new PolicyStore();
  const deploymentName = "crlf-test-worker";

  class InjectingJudgeClient implements JudgeClient {
    async judge(): Promise<JudgeVerdict> {
      return {
        verdict: "deny",
        // Attempt header injection via CRLF in the reason
        reason: "bad\r\nX-Injected: pwned",
      };
    }
  }

  let savedEncryptionKeyCrlf: string | undefined;
  let savedAllowedDomainsCrlf: string | undefined;

  beforeEach(async () => {
    savedEncryptionKeyCrlf = process.env.ENCRYPTION_KEY;
    savedAllowedDomainsCrlf = process.env.WORKER_ALLOWED_DOMAINS;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    __resetEncryptionKeyCacheForTests();
    process.env.WORKER_ALLOWED_DOMAINS = "";
    __testOnly.reset();
    setProxyRevokedTokenStore(NOOP_REVOKED_STORE);

    policyStore.set("org-1", "agent-crlf", {
      judgedDomains: [{ domain: "example.com" }],
      judges: { default: "test policy" },
    });

    setProxyPolicyStore(policyStore);
    setProxyEgressJudge(
      new EgressJudge({
        client: new InjectingJudgeClient(),
        resolveOrgDefaultModel: async () => "judge-test-model",
      })
    );

    // Ask the OS for a free port and retry on collision instead of gambling on
    // a random high port — concurrent test load otherwise races to EADDRINUSE
    // (#976).
    proxyServer = await withFreePortRetry(async (port) => {
      const server = await startHttpProxy(port, "127.0.0.1");
      proxyPort = port;
      return server;
    });
  });

  afterEach(async () => {
    await stopHttpProxy(proxyServer);
    if (savedEncryptionKeyCrlf === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedEncryptionKeyCrlf;
    __resetEncryptionKeyCacheForTests();
    if (savedAllowedDomainsCrlf === undefined) {
      delete process.env.WORKER_ALLOWED_DOMAINS;
    } else {
      process.env.WORKER_ALLOWED_DOMAINS = savedAllowedDomainsCrlf;
    }
    __testOnly.reset();
  });

  function rawBytesRequest(
    targetUrl: string,
    proxyAuth: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.connect(proxyPort, "127.0.0.1", () => {
        const u = new URL(targetUrl);
        const req =
          `GET ${targetUrl} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          `Proxy-Authorization: ${proxyAuth}\r\n` +
          `Connection: close\r\n\r\n`;
        socket.write(req);
      });
      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        resolve(data);
      });
    });
  }

  test("CRLF in judge reason does NOT create extra HTTP header lines", async () => {
    const token = createToken(deploymentName, "agent-crlf");
    const proxyAuth = makeBasicAuth(deploymentName, token);

    const raw = await rawBytesRequest("http://example.com/", proxyAuth);

    // The response must be 403
    expect(raw).toContain("HTTP/1.1 403");

    // Split the raw bytes into the header section (before \r\n\r\n)
    const headerSection = raw.split("\r\n\r\n")[0] ?? "";
    const headerLines = headerSection.split("\r\n");

    // The injected "X-Injected: pwned" must NOT appear as a standalone header line
    const injectedLine = headerLines.find((l) =>
      l.toLowerCase().startsWith("x-injected:")
    );
    expect(injectedLine).toBeUndefined();
  });

  test("CRLF in judge reason does not split the HTTP status-line", async () => {
    const token = createToken(deploymentName, "agent-crlf");
    const proxyAuth = makeBasicAuth(deploymentName, token);

    const raw = await rawBytesRequest("http://example.com/", proxyAuth);

    // The status line (first line) is terminated by the first CRLF we see.
    // It must not contain embedded newlines — that would indicate the CRLF
    // in the reason was NOT sanitised and the status line has been split.
    const firstLine = raw.substring(0, raw.indexOf("\r\n"));
    expect(firstLine).toContain("HTTP/1.1 403");
    // What must NOT happen is a raw LF character inside the first line, which
    // would mean the CRLF was passed through unsanitised. Bun may preserve the
    // standard reason phrase ("Forbidden"), so do not assert custom reason text.
    expect(firstLine).not.toMatch(/\n/);
  });
});

// ─── VerdictCache — key independence and policy-hash invalidation ─────────────

describe("VerdictCache — key independence", () => {
  test("different methods produce different cache keys", () => {
    const a = VerdictCache.key({
      orgId: "org-1",
      policyHash: "h",
      hostname: "example.com",
      method: "GET",
      path: "/foo",
    });
    const b = VerdictCache.key({
      orgId: "org-1",
      policyHash: "h",
      hostname: "example.com",
      method: "POST",
      path: "/foo",
    });
    expect(a).not.toBe(b);
  });

  test("different paths produce different cache keys", () => {
    const a = VerdictCache.key({
      orgId: "org-1",
      policyHash: "h",
      hostname: "example.com",
      method: "GET",
      path: "/foo",
    });
    const b = VerdictCache.key({
      orgId: "org-1",
      policyHash: "h",
      hostname: "example.com",
      method: "GET",
      path: "/bar",
    });
    expect(a).not.toBe(b);
  });

  test("CONNECT (no method/path) and GET / produce different cache keys", () => {
    const connect = VerdictCache.key({
      orgId: "org-1",
      policyHash: "h",
      hostname: "example.com",
    });
    const get = VerdictCache.key({
      orgId: "org-1",
      policyHash: "h",
      hostname: "example.com",
      method: "GET",
      path: "/",
    });
    expect(connect).not.toBe(get);
  });

  test("changing policyHash invalidates previously-set entry", () => {
    const cache = new VerdictCache(60_000, 100);
    const key1 = VerdictCache.key({ orgId: "org-1", policyHash: "old-hash", hostname: "x.com" });
    const key2 = VerdictCache.key({ orgId: "org-1", policyHash: "new-hash", hostname: "x.com" });

    cache.set(key1, { verdict: "allow", reason: "ok" });
    // key2 (new policy hash) must miss — cache isolates by policyHash
    expect(cache.get(key2)).toBeUndefined();
    // key1 still hits
    expect(cache.get(key1)).toBeDefined();
  });

  test("editing the judge policy text changes the composed text and its hash", () => {
    // PolicyStore computes the hash at set() time. Editing the policy changes
    // the composed text → different hash → old cache entries are invalidated
    // automatically because the key changes.
    const store = new PolicyStore();

    store.set("org-1", "agent-x", {
      judgedDomains: [{ domain: "example.com" }],
      judges: { default: "allow reads" },
    });
    const before = store.resolve("org-1", "agent-x","example.com");

    store.set("org-1", "agent-x", {
      judgedDomains: [{ domain: "example.com" }],
      judges: { default: "allow reads. Never send PII" },
    });
    const after = store.resolve("org-1", "agent-x","example.com");

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(before!.policyHash).not.toBe(after!.policyHash);
  });

  test("same policy text in two agents produces different policyHash (no cross-agent cache collision)", () => {
    // policyHash includes agentId → identical policies in different agents
    // yield different hashes → independent cache slots, no cross-agent leakage.
    const store = new PolicyStore();
    const samePolicy = "allow all reads";

    store.set("org-1", "agent-a", {
      judgedDomains: [{ domain: "example.com" }],
      judges: { default: samePolicy },
    });
    store.set("org-1", "agent-b", {
      judgedDomains: [{ domain: "example.com" }],
      judges: { default: samePolicy },
    });

    const a = store.resolve("org-1", "agent-a", "example.com");
    const b = store.resolve("org-1", "agent-b", "example.com");

    expect(a?.policyHash).toBeDefined();
    expect(b?.policyHash).toBeDefined();
    expect(a!.policyHash).not.toBe(b!.policyHash);
  });
});

// ─── CircuitBreaker — additional state transition coverage ───────────────────

describe("CircuitBreaker — state transitions", () => {
  test("success resets consecutive-failure count so threshold is relative to last success", () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.onFailure("p");
    breaker.onFailure("p");
    expect(breaker.canProceed("p")).toBe(true);
    // Success clears state entirely
    breaker.onSuccess("p");
    // Two more failures — counter starts from zero, should not trip at threshold 3
    breaker.onFailure("p");
    breaker.onFailure("p");
    expect(breaker.canProceed("p")).toBe(true);
    expect(breaker.isOpen("p")).toBe(false);
  });

  test("re-trips after reaching threshold again following a success-based reset", () => {
    const breaker = new CircuitBreaker(2, 1000);
    breaker.onFailure("p");
    breaker.onFailure("p");
    breaker.onSuccess("p"); // close
    breaker.onFailure("p");
    breaker.onFailure("p"); // should re-open
    expect(breaker.isOpen("p")).toBe(true);
  });

  test("different policy hashes have independent failure counts", () => {
    const breaker = new CircuitBreaker(2, 1000);
    breaker.onFailure("policy-a");
    breaker.onFailure("policy-a");
    expect(breaker.isOpen("policy-a")).toBe(true);
    expect(breaker.canProceed("policy-b")).toBe(true);
    expect(breaker.isOpen("policy-b")).toBe(false);
  });

  test("canProceed returns true for an unknown policy hash (closed by default)", () => {
    const breaker = new CircuitBreaker(3, 1000);
    expect(breaker.canProceed("never-seen")).toBe(true);
  });

  test("isOpen returns false for an unknown policy hash", () => {
    const breaker = new CircuitBreaker(3, 1000);
    expect(breaker.isOpen("never-seen")).toBe(false);
  });

  test("half-open allows exactly one probe while another is in-flight", async () => {
    const breaker = new CircuitBreaker(1, 15);
    breaker.onFailure("p");
    await new Promise((r) => setTimeout(r, 25)); // wait for cooldown
    expect(breaker.canProceed("p")).toBe(true); // probe allowed
    expect(breaker.canProceed("p")).toBe(false); // blocked: probe in flight
    expect(breaker.canProceed("p")).toBe(false); // still blocked
  });
});

// ─── PolicyStore — resolve edge cases ────────────────────────────────────────

describe("PolicyStore.resolve — edge cases", () => {
  test("exact match takes precedence over a wildcard", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-a", {
      judgedDomains: [
        { domain: "api.example.com", judge: "exact-judge" },
        { domain: ".example.com", judge: "wildcard-judge" },
      ],
      judges: {
        "exact-judge": "exact policy",
        "wildcard-judge": "wildcard policy",
      },
    });

    const resolved = store.resolve("org-1", "agent-a", "api.example.com");
    expect(resolved?.judgeName).toBe("exact-judge");
  });

  test("longer wildcard takes precedence over a shorter wildcard", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-a", {
      judgedDomains: [
        { domain: ".api.example.com", judge: "long-judge" },
        { domain: ".example.com", judge: "short-judge" },
      ],
      judges: {
        "long-judge": "longer policy",
        "short-judge": "shorter policy",
      },
    });

    const resolved = store.resolve("org-1", "agent-a", "v2.api.example.com");
    expect(resolved?.judgeName).toBe("long-judge");
  });

  test("unmatched hostname returns undefined", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-a", {
      judgedDomains: [{ domain: "example.com" }],
      judges: { default: "test" },
    });

    expect(store.resolve("org-1", "agent-a", "other.com")).toBeUndefined();
  });

  test("agentId isolation: agent-a rules do not leak to agent-b", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-a", {
      judgedDomains: [{ domain: "example.com" }],
      judges: { default: "agent-a policy" },
    });

    expect(store.resolve("org-1", "agent-b", "example.com")).toBeUndefined();
  });

  test("agent with no bundle returns undefined for all hostnames", () => {
    const store = new PolicyStore();
    expect(store.resolve("org-1", "no-such-agent", "example.com")).toBeUndefined();
  });

  test("rule without explicit judge name resolves to the 'default' judge", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-a", {
      judgedDomains: [{ domain: "example.com" }], // no `judge` field
      judges: { default: "default policy text" },
    });

    const resolved = store.resolve("org-1", "agent-a", "example.com");
    expect(resolved?.judgeName).toBe("default");
    expect(resolved?.policy).toContain("default policy text");
  });

  test("rule referencing a missing judge name returns undefined (fail closed)", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-a", {
      judgedDomains: [{ domain: "example.com", judge: "nonexistent" }],
      judges: { default: "default policy" },
    });

    // 'nonexistent' not in judges map → fails closed (returns undefined)
    expect(store.resolve("org-1", "agent-a", "example.com")).toBeUndefined();
  });

  test("clear removes the agent's bundle so resolve returns undefined", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-a", {
      judgedDomains: [{ domain: "example.com" }],
      judges: { default: "policy" },
    });
    store.clear("org-1", "agent-a");
    expect(store.resolve("org-1", "agent-a", "example.com")).toBeUndefined();
  });

  test("wildcard .example.com matches example.com itself (root domain)", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-a", {
      judgedDomains: [{ domain: ".example.com" }],
      judges: { default: "policy" },
    });

    expect(store.resolve("org-1", "agent-a", "example.com")).toBeDefined();
  });

  test("wildcard .example.com does NOT match evilexample.com", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-a", {
      judgedDomains: [{ domain: ".example.com" }],
      judges: { default: "policy" },
    });

    expect(store.resolve("org-1", "agent-a", "evilexample.com")).toBeUndefined();
  });

  test("resolve is case-insensitive for hostname", () => {
    const store = new PolicyStore();
    store.set("org-1", "agent-a", {
      judgedDomains: [{ domain: "example.com" }],
      judges: { default: "policy" },
    });

    expect(store.resolve("org-1", "agent-a", "EXAMPLE.COM")).toBeDefined();
  });
});

// ─── EgressJudge — additional policy coverage ────────────────────────────

describe("EgressJudge — additional policy coverage", () => {
  test("uses the configured default model when no per-rule override is set", async () => {
    let capturedModel = "";
    const client: JudgeClient = {
      async judge(args) {
        capturedModel = args.model;
        return { verdict: "allow", reason: "ok" };
      },
    };

    const judge = new EgressJudge({ client, resolveOrgDefaultModel: async () => "configured-default" });
    await judge.decide(
      { agentId: "a", organizationId: "org-1", hostname: "example.com" },
      rule({ policyHash: "unique-model-1" })
    );
    expect(capturedModel).toBe("configured-default");
  });

  test("fails closed without calling the client when no model is configured", async () => {
    let calls = 0;
    const client: JudgeClient = {
      async judge() {
        calls++;
        return { verdict: "allow", reason: "ok" };
      },
    };
    // No defaultModel and no per-rule judgeModel: there is no judge model to
    // call, so the judge must deny rather than guess one.
    const judge = new EgressJudge({ client });
    const d = await judge.decide(
      { agentId: "a", organizationId: "org-1", hostname: "example.com" },
      rule({ policyHash: "no-model-1" })
    );
    expect(calls).toBe(0);
    expect(d.verdict).toBe("deny");
    expect(d.source).toBe("judge-error");
  });

  test("per-rule judgeModel overrides the default model", async () => {
    let capturedModel = "";
    const client: JudgeClient = {
      async judge(args) {
        capturedModel = args.model;
        return { verdict: "allow", reason: "ok" };
      },
    };

    const judge = new EgressJudge({ client, resolveOrgDefaultModel: async () => "default-model" });
    await judge.decide(
      { agentId: "a", organizationId: "org-1", hostname: "example.com" },
      rule({ policyHash: "unique-model-2", judgeModel: "override-model" })
    );
    expect(capturedModel).toBe("override-model");
  });

  test("open circuit returns deny without calling the client", async () => {
    let calls = 0;
    const client: JudgeClient = {
      async judge() {
        calls++;
        throw new Error("fail");
      },
    };
    const judge = new EgressJudge({
      client,
      resolveOrgDefaultModel: async () => "judge-test-model",
      breakerFailureThreshold: 1,
      breakerCooldownMs: 60_000,
    });

    // Trip the breaker — threshold=1, one failure suffices
    await judge.decide(
      { agentId: "a", organizationId: "org-1", hostname: "h1.example.com" },
      rule({ policyHash: "brk-coverage" })
    );
    expect(calls).toBe(1);

    // Next request: circuit open → short-circuit
    const d = await judge.decide(
      { agentId: "a", organizationId: "org-1", hostname: "h2.example.com" },
      rule({ policyHash: "brk-coverage" })
    );
    expect(calls).toBe(1); // no extra call
    expect(d.verdict).toBe("deny");
    expect(d.source).toBe("circuit-open");
  });

  test("policyHash and judgeName are present on a cached decision", async () => {
    const client: JudgeClient = {
      async judge() {
        return { verdict: "allow", reason: "ok" };
      },
    };
    const judge = new EgressJudge({ client, resolveOrgDefaultModel: async () => "judge-test-model" });
    const req = { agentId: "a", organizationId: "org-1", hostname: "example.com" };
    const r = rule({ policyHash: "p-cache-meta", judgeName: "my-judge" });

    await judge.decide(req, r);
    const cached = await judge.decide(req, r);

    expect(cached.source).toBe("cache");
    expect(cached.policyHash).toBe("p-cache-meta");
    expect(cached.judgeName).toBe("my-judge");
    expect(cached.latencyMs).toBe(0);
  });

  test("a single judge failure does not open the circuit (source is judge-error)", async () => {
    const client: JudgeClient = {
      async judge() {
        throw new Error("transient");
      },
    };
    // High threshold — one failure must not trip the breaker
    const judge = new EgressJudge({
      client,
      resolveOrgDefaultModel: async () => "judge-test-model",
      breakerFailureThreshold: 5,
    });

    const d = await judge.decide(
      { agentId: "a", organizationId: "org-1", hostname: "x.com" },
      rule({ policyHash: "single-fail-coverage" })
    );
    expect(d.verdict).toBe("deny");
    expect(d.source).toBe("judge-error"); // not "circuit-open"
  });
});

// Regression: in unrestricted+blocklist mode (WORKER_ALLOWED_DOMAINS=* with a
// WORKER_DISALLOWED_DOMAINS list), a trailing-dot FQDN (`pastebin.com.`) used to
// slip past the denylist — it matched neither the exact nor the `.suffix`
// pattern — while `pastebin.com` was correctly blocked. DNS resolves both
// identically, so this defeated the operator egress control. checkDomainAccess
// now canonicalizes the hostname (strips trailing dots) before matching.
describe("egress denylist — trailing-dot FQDN canonicalization", () => {
  const prevAllowed = process.env.WORKER_ALLOWED_DOMAINS;
  const prevDisallowed = process.env.WORKER_DISALLOWED_DOMAINS;

  // Config snapshot for this block — built from the env set in beforeEach and
  // passed into each checkDomainAccess call, so the assertions don't depend on
  // any shared module state.
  let config: ResolvedNetworkConfig;

  beforeEach(() => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    process.env.WORKER_DISALLOWED_DOMAINS = "pastebin.com";
    config = resolveNetworkConfig();
  });

  afterEach(() => {
    if (prevAllowed === undefined) delete process.env.WORKER_ALLOWED_DOMAINS;
    else process.env.WORKER_ALLOWED_DOMAINS = prevAllowed;
    if (prevDisallowed === undefined) delete process.env.WORKER_DISALLOWED_DOMAINS;
    else process.env.WORKER_DISALLOWED_DOMAINS = prevDisallowed;
  });

  test("blocks a denylisted host written with a trailing dot", async () => {
    expect(
      (await __testOnly.checkDomainAccess(config, "pastebin.com", undefined, undefined))
        .allowed
    ).toBe(false);
    // The bug: this returned allowed:true before the canonicalization fix.
    expect(
      (await __testOnly.checkDomainAccess(config, "pastebin.com.", undefined, undefined))
        .allowed
    ).toBe(false);
    expect(
      (await __testOnly.checkDomainAccess(config, "pastebin.com..", undefined, undefined))
        .allowed
    ).toBe(false);
  });

  test("still allows a non-denylisted host (trailing dot or not) in unrestricted mode", async () => {
    expect(
      (await __testOnly.checkDomainAccess(config, "example.com", undefined, undefined))
        .allowed
    ).toBe(true);
    expect(
      (await __testOnly.checkDomainAccess(config, "example.com.", undefined, undefined))
        .allowed
    ).toBe(true);
  });
});
