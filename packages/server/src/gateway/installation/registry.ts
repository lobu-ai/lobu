/**
 * Process-wide (per-pod) {@link InstallationTokenRegistry} singleton + the
 * default provider wiring.
 *
 * Per-pod by design (AGENTS.md multi-replica rule): the registry holds the
 * GitHub provider's in-memory token cache, which must NOT be shared across pods.
 * Each replica builds its own registry on first use and self-serves token
 * minting; two replicas minting for the same install just produce two valid
 * tokens — nothing requires cross-pod agreement.
 */

import { GitHubInstallationTokenProvider } from "./github-installation-token-provider.js";
import { InstallationTokenRegistry } from "./installation-token-provider.js";
import { RefreshTokenInstallationTokenProvider } from "./refresh-token-installation-token-provider.js";

let registry: InstallationTokenRegistry | null = null;

/**
 * The per-pod registry, built lazily with the default providers registered.
 */
export function getInstallationTokenRegistry(): InstallationTokenRegistry {
  if (!registry) {
    registry = new InstallationTokenRegistry();
    registry.register(new GitHubInstallationTokenProvider());
    // Any connector declaring a tenant-scoped oauth-code-exchange method renews
    // through the one generic refresh-token provider — no provider literal.
    registry.registerFallback(new RefreshTokenInstallationTokenProvider());
  }
  return registry;
}

/** Test-only: drop the singleton so a test can install its own providers. */
export function __resetInstallationTokenRegistryForTests(): void {
  registry = null;
}
