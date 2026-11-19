/**
 * Installation token providers — gateway-side minting of tenant-scoped
 * credentials for {@link AppInstallationRow} installs (GitHub App, Slack app,
 * Jira site, …).
 *
 * Worker-creds invariant (AGENTS.md): the private key, the App JWT, and the
 * provider token exchange ALL stay gateway-side. A connector/worker never
 * receives the App private key or the JWT — only the freshly-minted short-lived
 * installation token, resolved at credential-resolution time (the same seam
 * OAuth access tokens already flow through). Each provider mints + caches its
 * own tokens; the registry is the single per-pod lookup point.
 *
 * Multi-replica: every provider's token cache is per-pod, best-effort, and
 * re-minted on miss/expiry — never shared in-memory across pods (see the
 * `InMemoryInstallationTokenCache` note). Two replicas minting for the same
 * install just produce two valid tokens; nothing requires them to agree.
 */

import type { AppInstallationRow } from "../../lobu/stores/app-installation-store.js";

/**
 * A minted, tenant-scoped credential plus its absolute expiry (ISO-8601). The
 * `token` is the value injected at egress; `expiresAt` drives proactive refresh.
 */
export interface MintedInstallationToken {
  token: string;
  /** ISO-8601 absolute expiry, e.g. GitHub's `expires_at` (~1h out). */
  expiresAt: string;
}

/**
 * Per-provider minting strategy. One implementation per `provider`
 * (`'github'`, `'slack'`, …); registered in an {@link InstallationTokenRegistry}.
 */
export interface InstallationTokenProvider {
  /** Provider key this strategy mints for, e.g. `'github'`. */
  readonly provider: string;
  /**
   * Mint (or return a cached, still-valid) tenant-scoped token for an install.
   *
   * Implementations MUST keep the private key + token exchange gateway-side and
   * SHOULD cache per install id with proactive refresh. Throws a
   * {@link InstallationTokenError} on mint failure (caller surfaces it as a
   * connection error rather than crashing).
   */
  mintToken(
    install: AppInstallationRow,
    options?: MintTokenOptions
  ): Promise<MintedInstallationToken>;
}

/**
 * Raised when an install token cannot be minted: missing App config, a
 * revoked/suspended install, or a failed provider exchange. Carries a stable
 * `reason` the connection-error surface can branch on without string matching.
 */
export type InstallationTokenFailureReason =
  | "missing_app_config"
  | "install_inactive"
  | "exchange_failed"
  | "provider_unsupported";

export class InstallationTokenError extends Error {
  readonly reason: InstallationTokenFailureReason;
  /** HTTP status from the provider exchange, when the failure was a bad response. */
  readonly status?: number;

  constructor(
    reason: InstallationTokenFailureReason,
    message: string,
    options?: { status?: number; cause?: unknown }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "InstallationTokenError";
    this.reason = reason;
    this.status = options?.status;
  }
}

/**
 * Statuses for which we refuse to mint. A `revoked`/`suspended`/`error`/`pending`
 * install has no usable credential, so minting short-circuits with
 * `install_inactive` instead of hitting the provider.
 */
function isMintableStatus(status: AppInstallationRow["status"]): boolean {
  return status === "active";
}

/** Per-call minting constraints. */
export interface MintTokenOptions {
  /**
   * Reject a cached token with less than this much life left, forcing a fresh
   * mint. Used by the credential-lease path, whose token is baked into a
   * sandbox at startup and cannot be refreshed in place.
   */
  minTtlMs?: number;
}

/**
 * Per-pod, in-memory token cache shared by provider implementations.
 *
 * Per-pod by design (mirrors `secret-proxy`'s `PlaceholderCache`): a token
 * minted on pod A is never read by pod B — each replica self-serves. No
 * cross-pod coordination, so it holds under N replicas behind ClientIP
 * affinity. Entries refresh proactively `refreshSkewMs` before the provider's
 * stated expiry so an in-flight request never races the boundary.
 */
export class InMemoryInstallationTokenCache {
  private readonly entries = new Map<string, MintedInstallationToken>();
  private readonly refreshSkewMs: number;

  constructor(options?: { refreshSkewMs?: number }) {
    // Default 60s skew: GitHub tokens last ~1h, so re-minting a minute early
    // is cheap insurance against clock skew + in-flight latency.
    this.refreshSkewMs = options?.refreshSkewMs ?? 60_000;
  }

  /**
   * Cached token for `key` if present AND not within the refresh window; else
   * null.
   *
   * `minTtlMs` lets a caller demand a longer runway than the default skew.
   * A credential LEASE needs this: it is baked into a sandbox that reads its
   * env once at startup, so handing back a token with two minutes left means
   * the sandbox is born nearly dead. Callers that re-read the token per
   * request (the egress proxy) are fine with the default.
   */
  get(key: string, minTtlMs?: number): MintedInstallationToken | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const expMs = Date.parse(entry.expiresAt);
    const now = Date.now();
    // An unparseable expiry is treated as already-stale: re-mint rather than
    // trust a token we can't reason about the lifetime of. Only the default
    // skew evicts, because that is the point past which the entry is useless
    // to every caller.
    if (!Number.isFinite(expMs) || expMs - this.refreshSkewMs <= now) {
      this.entries.delete(key);
      return null;
    }
    // A caller demanding a longer runway than the default just misses: the
    // entry is still perfectly serviceable to per-request callers, so evicting
    // it here would make one lease mint invalidate the egress proxy's token.
    if (minTtlMs != null && expMs - minTtlMs <= now) return null;
    return entry;
  }

  set(key: string, token: MintedInstallationToken): void {
    this.entries.set(key, token);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

/**
 * Per-pod registry of {@link InstallationTokenProvider}s keyed by `provider`.
 * The single lookup point for credential resolution: given an install row, pick
 * the provider and mint. Refuses to mint for a non-active install up front so a
 * revoked/suspended row never reaches a provider exchange.
 */
export class InstallationTokenRegistry {
  private readonly providers = new Map<string, InstallationTokenProvider>();
  private fallback: InstallationTokenProvider | null = null;

  register(provider: InstallationTokenProvider): void {
    this.providers.set(provider.provider, provider);
  }

  /**
   * The provider used when no provider-keyed strategy is registered: the
   * generic declared-method renewal, which itself refuses installs whose
   * connector declares no renewable method (`provider_unsupported`).
   */
  registerFallback(provider: InstallationTokenProvider): void {
    this.fallback = provider;
  }

  get(provider: string): InstallationTokenProvider | undefined {
    return this.providers.get(provider);
  }

  /**
   * Mint a token for `install` via its registered provider. Throws
   * {@link InstallationTokenError} when no provider is registered for the
   * install's `provider` (`provider_unsupported`) or the install is not active
   * (`install_inactive`); otherwise delegates to the provider's `mintToken`.
   */
  async mintFor(
    install: AppInstallationRow,
    options?: MintTokenOptions
  ): Promise<MintedInstallationToken> {
    if (!isMintableStatus(install.status)) {
      throw new InstallationTokenError(
        "install_inactive",
        `App installation ${install.id} is '${install.status}', not 'active' — no token can be minted`
      );
    }
    const provider = this.providers.get(install.provider) ?? this.fallback;
    if (!provider) {
      throw new InstallationTokenError(
        "provider_unsupported",
        `No InstallationTokenProvider registered for provider '${install.provider}'`
      );
    }
    return provider.mintToken(install, options);
  }
}
