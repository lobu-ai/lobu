import type { Server } from "node:http";
import { createLogger } from "@lobu/core";
import type { GrantStore } from "../permissions/grant-store.js";
import {
  setProxyGrantStore,
  startHttpProxy,
  stopHttpProxy,
} from "./http-proxy.js";

const logger = createLogger("proxy-manager");

let proxyServer: Server | null = null;

/**
 * Wire the grant store into the HTTP egress proxy, which READS it per request
 * (Postgres-backed grants rows). Without this the proxy's `proxyGrantStore`
 * stays null and `checkDomainAccess` silently skips per-agent grants, leaving
 * only the global `WORKER_ALLOWED_DOMAINS` allowlist in force. (This wiring
 * was dropped in #672's dead-code sweep when the proxy store still looked
 * unused; `startFilteringProxy()` was re-added at the gateway boot site but
 * this call was not.)
 *
 * Lives here (not in `lobu/gateway.ts`) so it can be unit-tested without pulling
 * in the heavyweight, route-test-mocked gateway module — the regression slipped
 * through precisely because every proxy test injects the store itself, so
 * nothing covered the boot path.
 */
export function wireProxyEgressStores(services: {
  getGrantStore(): GrantStore | undefined;
}): void {
  const grantStore = services.getGrantStore();
  if (grantStore) {
    setProxyGrantStore(grantStore);
  }
}

/**
 * Start filtering HTTP proxy for worker network isolation. Workers can
 * only reach the internet through this proxy, which enforces domain
 * allowlist/blocklist and per-agent grants.
 *
 * Automation based on environment configuration:
 * - Empty/unset: Deny all (complete isolation)
 * - WORKER_ALLOWED_DOMAINS=*: Allow all (unrestricted)
 * - WORKER_ALLOWED_DOMAINS=domains: Allowlist mode
 * - WORKER_DISALLOWED_DOMAINS=domains: Blocklist mode
 * - Both set: Allowlist with exceptions
 */
export async function startFilteringProxy(): Promise<void> {
  if (proxyServer) {
    return;
  }

  const parsedPort = Number.parseInt(
    process.env.WORKER_PROXY_PORT || "8118",
    10
  );
  const port = Number.isFinite(parsedPort) ? parsedPort : 8118;
  // Bind to localhost only — workers run as subprocesses on the same host
  // and connect via 127.0.0.1.
  const host = "127.0.0.1";

  try {
    proxyServer = await startHttpProxy(port, host);
    logger.debug(`HTTP proxy started on ${host}:${port}`);
  } catch (error) {
    logger.error("Failed to start HTTP proxy:", error);
    throw error;
  }

  process.on("SIGTERM", async () => {
    await stopFilteringProxy();
  });

  process.on("SIGINT", async () => {
    await stopFilteringProxy();
  });
}

/**
 * Stop filtering proxy (cleanup on shutdown)
 */
export async function stopFilteringProxy(): Promise<void> {
  if (proxyServer) {
    logger.info("Stopping HTTP proxy...");
    await stopHttpProxy(proxyServer);
    proxyServer = null;
  }
}
