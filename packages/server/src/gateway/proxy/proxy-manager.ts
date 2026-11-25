import type { Server } from "node:http";
import { createLogger } from "@lobu/core";
import type { GrantStore } from "../permissions/grant-store.js";
import type { PolicyStore } from "../permissions/policy-store.js";
import {
  setProxyGrantStore,
  setProxyPolicyStore,
  startHttpProxy,
  stopHttpProxy,
} from "./http-proxy.js";

const logger = createLogger("proxy-manager");

let proxyServer: Server | null = null;

/**
 * Wire the grant + policy stores into the HTTP egress proxy, which READS them
 * per request (both are Postgres-backed: grants rows and the workspace
 * guardrail library). Without this the proxy's
 * `proxyGrantStore`/`proxyPolicyStore` stay null and `checkDomainAccess`
 * silently skips per-agent grants and the LLM egress judge, leaving only the
 * global `WORKER_ALLOWED_DOMAINS` allowlist in force. (This wiring was dropped
 * in #672's dead-code sweep when the proxy stores still looked unused;
 * `startFilteringProxy()` was re-added at the gateway boot site but these two
 * calls were not.) `setProxyPolicyStore` also lazily constructs the real
 * `EgressJudge`, so judged-domain rules become enforceable.
 *
 * Lives here (not in `lobu/gateway.ts`) so it can be unit-tested without pulling
 * in the heavyweight, route-test-mocked gateway module — the regression slipped
 * through precisely because every proxy test injects these stores itself, so
 * nothing covered the boot path.
 */
export function wireProxyEgressStores(services: {
  getGrantStore(): GrantStore | undefined;
  getPolicyStore(): PolicyStore | undefined;
}): void {
  const grantStore = services.getGrantStore();
  if (grantStore) {
    setProxyGrantStore(grantStore);
  }
  const policyStore = services.getPolicyStore();
  if (policyStore) {
    setProxyPolicyStore(policyStore);
  }
}

/**
 * Start filtering HTTP proxy for worker network isolation. Workers can
 * only reach the internet through this proxy, which enforces domain
 * allowlist/blocklist + LLM egress judge.
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
