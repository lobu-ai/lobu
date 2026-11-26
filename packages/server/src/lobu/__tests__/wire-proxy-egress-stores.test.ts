/**
 * Regression guard for the gateway boot wiring of the HTTP egress proxy.
 *
 * The proxy READS per-agent grants from a module-level store that must be
 * injected at boot (`setProxyGrantStore`). #672's dead-code sweep deleted that
 * boot call (it kept `startFilteringProxy()`), so at runtime the proxy silently
 * skipped grants — only the global `WORKER_ALLOWED_DOMAINS` allowlist stayed in
 * force. Every proxy test injects the store itself, so nothing covered the boot
 * path and the regression shipped.
 *
 * `wireProxyEgressStores` is the extracted boot step. These tests prove, in the
 * red→green sense, that:
 *   - WITHOUT it, a per-agent grant has no effect (the exact regression); and
 *   - WITH it, the grant is honored.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { GrantStore } from "../../gateway/permissions/grant-store.js";
import {
  __testOnly,
  resolveNetworkConfig,
} from "../../gateway/proxy/http-proxy.js";
import { wireProxyEgressStores } from "../../gateway/proxy/proxy-manager.js";

// Deny-all global config so every decision falls through to the per-agent grant
// store — the layer the boot wiring is responsible for.
function denyAllConfig() {
  const prev = process.env.WORKER_ALLOWED_DOMAINS;
  process.env.WORKER_ALLOWED_DOMAINS = "";
  const config = resolveNetworkConfig();
  if (prev === undefined) delete process.env.WORKER_ALLOWED_DOMAINS;
  else process.env.WORKER_ALLOWED_DOMAINS = prev;
  return config;
}

function grantStoreAllowing(
  agentId: string,
  hostname: string,
  orgId: string
): GrantStore {
  return {
    async hasGrant(a: string, h: string, o?: string): Promise<boolean> {
      return a === agentId && h === hostname && o === orgId;
    },
    async isDenied(): Promise<boolean> {
      return false;
    },
  } as unknown as GrantStore;
}

describe("wireProxyEgressStores — boot wiring of the HTTP egress proxy", () => {
  beforeEach(() => {
    // Start from the unwired runtime state — the regression baseline.
    __testOnly.reset();
  });

  test("UNWIRED: a per-agent grant has no effect (regression baseline)", async () => {
    const config = denyAllConfig();
    const decision = await __testOnly.checkDomainAccess(
      config,
      "github.com",
      "agent-a",
      "org-1"
    );
    // No grant store wired → grant path skipped → blocked by global deny-all.
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("global");
  });

  test("WIRED: the grant store is connected so a per-agent grant is honored", async () => {
    wireProxyEgressStores({
      getGrantStore: () => grantStoreAllowing("agent-a", "github.com", "org-1"),
    });

    const config = denyAllConfig();
    const decision = await __testOnly.checkDomainAccess(
      config,
      "github.com",
      "agent-a",
      "org-1"
    );
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe("grant");
  });
});
