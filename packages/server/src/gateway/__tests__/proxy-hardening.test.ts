/**
 * Security-hardening tests for the worker network proxy.
 *
 * Covers edge cases that the existing test suite does not reach:
 *   - IP-address blocking (ranges, IPv4-mapped IPv6, zone IDs, IPv6 variants)
 *   - Domain-pattern matching bypasses (wildcard boundary, case, CONNECT IPv6)
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
import { withFreePortRetry } from "../../__tests__/setup/free-port.js";
import {
  __testOnly,
  type ResolvedNetworkConfig,
  resolveNetworkConfig,
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
