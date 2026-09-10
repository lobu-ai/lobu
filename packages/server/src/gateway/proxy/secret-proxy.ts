import { randomUUID } from "node:crypto";
import type { AgentTurnInput } from "@lobu/connector-worker/agent-turn";
import { CREDENTIAL_PLACEHOLDER_PREFIX } from "@lobu/connector-worker/egress";
import { createLogger, type SecretRef, verifyWorkerToken } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { resolveUrlInvariant } from "../auth/inference-invariant.js";
import { extractJwtAccountId } from "../auth/oauth/client.js";
import type { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";
import type { ProviderCredentialContext } from "../embedded.js";
import type { ProviderUpstreamConfig } from "../modules/module-system.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import {
  clearInferenceProviderError,
  markInferenceProviderUnhealthy,
  readOrgSharedProviderApiKey,
} from "../../lobu/stores/provider-secrets.js";
import {
  clearTurnProviderFailed,
  markTurnProviderFailed,
} from "../orchestration/turn-liveness.js";
import type { SecretStore } from "../secrets/index.js";
import { getClientIp } from "../utils/rate-limiter.js";
import { classifyProviderHealthStatus } from "./provider-health-status.js";

/**
 * Caller-supplied resolver: agentId → orgId of the agent's owning org.
 *
 * The proxy needs an independent source of the caller's org to compare
 * against `SecretMapping.organizationId` — without it the org-scoping
 * guard on `lookupPlaceholderMapping` has nothing to enforce against and
 * collapses to dead code. The deployment manager wires a DB-backed
 * resolver with a small TTL cache at boot.
 */
type AgentOrgResolver = (agentId: string) => Promise<string | null>;

const logger = createLogger("secret-proxy");

function captureInferencePath(api: AgentTurnInput["provider"]["api"]): string {
  switch (api) {
    case "anthropic-messages":
      return "/v1/messages";
    case "openai-completions":
      return "/chat/completions";
    case "openai-responses":
      return "/responses";
    case "openai-codex-responses":
      return "/codex/responses";
  }
}

/**
 * Default TTL for orphaned placeholder→secret mappings. Mappings are
 * cascade-deleted on deployment teardown (`deleteSecretMappings`); this TTL
 * only bounds how long a mapping survives if teardown never runs (worker pod
 * crash, agent deleted mid-day). 24h instead of the old ~7 days narrows the
 * window an orphaned `lobu_secret_<uuid>` stays live. Configurable via
 * `SECRET_PLACEHOLDER_TTL_MS`.
 */
function defaultPlaceholderTtlSeconds(): number {
  const raw = process.env.SECRET_PLACEHOLDER_TTL_MS;
  if (raw) {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return 24 * 60 * 60;
}

/**
 * Per-source cap on *failed* placeholder resolutions. A compromised worker can
 * probe the proxy with bogus `lobu_secret_<uuid>` tokens; without a cap each
 * miss is logged, so it doubles as a log-spam vector. Once a source exceeds
 * the threshold within the window, further resolutions hard-fail and we log
 * the throttle once instead of per-attempt. Only failures count — legitimate
 * high-throughput valid lookups are never throttled.
 */
const RESOLVE_FAILURE_THRESHOLD = 20;
const RESOLVE_FAILURE_WINDOW_MS = 5 * 60 * 1000;

interface FailureBucket {
  count: number;
  windowStartMs: number;
  throttledLogged: boolean;
}

class ResolutionFailureLimiter {
  private readonly buckets = new Map<string, FailureBucket>();

  /** Returns true if the source is currently throttled (over threshold). */
  isThrottled(source: string): boolean {
    const bucket = this.buckets.get(source);
    if (!bucket) return false;
    if (Date.now() - bucket.windowStartMs >= RESOLVE_FAILURE_WINDOW_MS) {
      this.buckets.delete(source);
      return false;
    }
    return bucket.count >= RESOLVE_FAILURE_THRESHOLD;
  }

  /**
   * Record a failed resolution for a source. Returns whether the caller
   * should log this particular failure (true the first time the threshold is
   * crossed — the "source throttled" line — and for every failure below it;
   * false once we've already logged the throttle for this window).
   */
  recordFailure(source: string): { shouldLog: boolean; nowThrottled: boolean } {
    const now = Date.now();
    let bucket = this.buckets.get(source);
    if (!bucket || now - bucket.windowStartMs >= RESOLVE_FAILURE_WINDOW_MS) {
      bucket = { count: 0, windowStartMs: now, throttledLogged: false };
      this.buckets.set(source, bucket);
    }
    bucket.count += 1;
    const nowThrottled = bucket.count >= RESOLVE_FAILURE_THRESHOLD;
    if (nowThrottled) {
      if (bucket.throttledLogged) return { shouldLog: false, nowThrottled };
      bucket.throttledLogged = true;
      return { shouldLog: true, nowThrottled };
    }
    return { shouldLog: true, nowThrottled };
  }

  /** Record a successful resolution — clears the source's failure bucket. */
  recordSuccess(source: string): void {
    this.buckets.delete(source);
  }

  reset(): void {
    this.buckets.clear();
  }
}

const resolutionFailureLimiter = new ResolutionFailureLimiter();

/**
 * Legacy in-process placeholder→SecretMapping cache. Native agent turns use
 * their signed turn credential instead; they do not depend on this pod-local
 * mapping.
 */
interface CacheEntry {
  mapping: SecretMapping;
  expiresAt: number;
}

class PlaceholderCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Last full sweep (ms). Lazy GC: sweep on writes when stale enough. */
  private lastSweepMs = 0;
  private static readonly SWEEP_INTERVAL_MS = 60_000;

  get(uuid: string): SecretMapping | null {
    const entry = this.entries.get(uuid);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(uuid);
      return null;
    }
    return entry.mapping;
  }

  set(uuid: string, mapping: SecretMapping, ttlSeconds: number): void {
    this.entries.set(uuid, {
      mapping,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    this.maybeSweep();
  }

  delete(uuid: string): void {
    this.entries.delete(uuid);
  }

  /** Drop every mapping pinned to a deployment (cascade on teardown). */
  deleteByDeployment(deploymentName: string): number {
    let removed = 0;
    for (const [uuid, entry] of this.entries) {
      if (entry.mapping.deploymentName === deploymentName) {
        this.entries.delete(uuid);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  private maybeSweep(): void {
    const now = Date.now();
    if (now - this.lastSweepMs < PlaceholderCache.SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    for (const [uuid, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(uuid);
    }
  }
}

/** Module-level singleton: gateway has one secret proxy and one mapping cache. */
const placeholderCache = new PlaceholderCache();

/**
 * Resolve a placeholder string (`lobu_secret_<uuid>` or a prefixed variant)
 * to its stored {@link SecretMapping}. Returns `null` if the placeholder is
 * malformed, expired, missing, or — when `expectedOrganizationId` is supplied
 * — pinned to a different tenant.
 *
 * Exported for tests so the org-scoping guard can be exercised without
 * spinning up the full HTTP proxy.
 */
export function lookupPlaceholderMapping(
  placeholder: string,
  expectedOrganizationId?: string
): SecretMapping | null {
  const prefixIdx = placeholder.indexOf(CREDENTIAL_PLACEHOLDER_PREFIX);
  if (prefixIdx === -1) return null;
  const uuid = placeholder.slice(prefixIdx + CREDENTIAL_PLACEHOLDER_PREFIX.length);
  const mapping = placeholderCache.get(uuid);
  if (!mapping) return null;
  if (
    expectedOrganizationId !== undefined &&
    mapping.organizationId !== expectedOrganizationId
  ) {
    // Force the check whenever the caller supplied an expected org.
    // Pre-fix this also gated on `mapping.organizationId` being set,
    // which let a legacy mapping (minted before the org-id pivot) sail
    // through whenever the caller's URL named any org — a worker from
    // org B could resolve a legacy unscoped mapping owned by org A under
    // org B's request. Now: if the caller has an org expectation, the
    // mapping must match it, including refusing to match `undefined`.
    logger.warn(
      {
        mappingAgentId: mapping.agentId,
        mappingOrg: mapping.organizationId,
        expectedOrg: expectedOrganizationId,
      },
      "Placeholder mapping rejected: organization mismatch"
    );
    return null;
  }
  // Surface every legacy unscoped access so the deprecation can be
  // planned. A mapping with no `organizationId` is from before the pivot
  // and should disappear once all in-flight placeholders rotate.
  if (!mapping.organizationId) {
    logger.warn(
      {
        mappingAgentId: mapping.agentId,
        expectedOrg: expectedOrganizationId,
      },
      "Placeholder mapping accessed without organizationId — legacy row, schedule rotation"
    );
  }
  return mapping;
}

function safeDecodePathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse the token out of a `Bearer <token>` authorization header. Returns the
 * token (possibly empty string for `"Bearer "`) when the header is a
 * well-formed two-part bearer, else null. Case-insensitive on the scheme.
 */
function parseBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
    return parts[1] ?? null;
  }
  return null;
}

/**
 * Walk the documented provider-credential resolution chain
 * (provider-secrets.ts) at the egress proxy:
 *   1. per-user auth profile credential (resolved by the caller)
 *   2. org-shared `agent_secrets` key written by `lobu apply`
 *   3. deployment-wide system key (env)
 *
 * Run dispatch admits a run when `hasSystemKey() || hasCredentials()` passes
 * (base-provider-module.ts), and `hasCredentials` covers tiers 1–2 — so the
 * proxy MUST resolve the same tiers. Skipping tier 2 here meant an
 * apply-provisioned org dispatched its agent only to 401 at the first
 * provider call — found live by the Sentry red-test (LOBU-BACKEND-W).
 *
 * Exported for tests; dependencies are injected so the tier ORDER is testable
 * without a database or upstream.
 */
/**
 * How a resolved credential must be presented to the upstream. `"oauth"`
 * credentials always use `Authorization: Bearer`; `"api-key"` credentials honor
 * the provider's declared `apiKeyHeader` (Bearer for OpenAI-compatible APIs,
 * `x-api-key` for Anthropic). Determined at resolution time — never inferred
 * from the credential string.
 */
export type CredentialKind = "oauth" | "api-key";

/** A system (env) key plus its kind, returned by the system-key resolver. */
export interface SystemKeyResult {
  value: string;
  kind: CredentialKind;
}

export interface ResolvedProviderCredential {
  value: string;
  kind: CredentialKind;
}

export async function resolveProviderCredential(params: {
  profileCredential: string | null;
  /** Auth profile's type, used to classify a profile-sourced credential. */
  profileAuthType?: string;
  providerId: string;
  organizationId: string | undefined;
  readOrgSharedKey: (
    providerId: string,
    organizationId: string
  ) => Promise<string | null>;
  systemKeyResolver?: (providerId: string) => SystemKeyResult | undefined;
}): Promise<ResolvedProviderCredential | null> {
  if (params.profileCredential) {
    return {
      value: params.profileCredential,
      // Only an explicit OAuth profile yields a Bearer-only credential; every
      // other profile type (api-key, device-code) is presented as an API key.
      kind: params.profileAuthType === "oauth" ? "oauth" : "api-key",
    };
  }
  if (params.organizationId) {
    const orgKey = await params.readOrgSharedKey(
      params.providerId,
      params.organizationId
    );
    // Org-shared keys are written by `lobu apply` as API keys.
    if (orgKey) return { value: orgKey, kind: "api-key" };
  }
  return params.systemKeyResolver?.(params.providerId) ?? null;
}

export interface SecretMapping {
  agentId: string;
  /**
   * Owning organization of the agent the placeholder was minted for.
   * `lookupPlaceholderMapping()` rejects the lookup when the caller's
   * org doesn't match — defense-in-depth against a compromised worker
   * presenting another tenant's placeholder. Optional only because
   * older mappings minted before the org-id pivot can still be in
   * flight; production-minted mappings always set it.
   */
  organizationId?: string;
  envVarName: string;
  secretRef: SecretRef;
  deploymentName: string;
}

interface SecretProxyConfig {
  defaultUpstreamUrl: string;
  providerUpstreams?: ProviderUpstreamConfig[];
}

/**
 * Generic secret injection proxy.
 *
 * Workers receive random placeholder tokens instead of real secrets.
 * This proxy intercepts requests, swaps placeholders back to real values
 * in auth headers, and forwards to the upstream API.
 *
 * Zero provider-specific logic — works for any API that uses
 * X-Api-Key or Authorization: Bearer headers.
 */
export class SecretProxy {
  private app: Hono;
  private config: SecretProxyConfig;
  private slugMap: Map<string, string>;
  private slugToProviderId: Map<string, string> = new Map();
  /**
   * Per-provider header scheme for presenting an API-KEY credential upstream.
   * Defaults to Bearer; Anthropic registers `"x-api-key"`. See
   * `applyCredentialHeader`.
   */
  private slugToApiKeyHeader: Map<string, "authorization" | "x-api-key"> =
    new Map();
  private authProfilesManager?: AuthProfilesManager;
  private readonly secretStore: SecretStore;
  private systemKeyResolver?: (
    providerId: string
  ) => SystemKeyResult | undefined;
  private agentOrgResolver?: AgentOrgResolver;

  constructor(config: SecretProxyConfig, secretStore: SecretStore) {
    this.config = config;
    this.secretStore = secretStore;
    this.slugMap = new Map();
    for (const upstream of config.providerUpstreams ?? []) {
      this.slugMap.set(upstream.slug, upstream.upstreamBaseUrl);
      logger.debug(
        `Registered provider upstream: ${upstream.slug} -> ${upstream.upstreamBaseUrl}`
      );
    }
    this.app = new Hono();
    this.setupRoutes();
  }

  setAuthProfilesManager(manager: AuthProfilesManager): void {
    this.authProfilesManager = manager;
  }

  /**
   * Set a callback that resolves system-level keys for a provider, with the
   * credential's kind so the proxy can pick the right auth header. Used as
   * fallback when no per-agent auth profile exists.
   */
  setSystemKeyResolver(
    resolver: (providerId: string) => SystemKeyResult | undefined
  ): void {
    this.systemKeyResolver = resolver;
  }

  /**
   * Wire in a resolver that maps a URL-encoded agentId to its owning org
   * id. Used to compute the `expectedOrganizationId` we hand to
   * `lookupPlaceholderMapping` — without it the org-scoping guard has no
   * independent source of truth and can't enforce anything.
   */
  setAgentOrgResolver(resolver: AgentOrgResolver): void {
    this.agentOrgResolver = resolver;
  }

  /**
   * Register a provider upstream for slug-based routing.
   * Called after provider modules are initialized.
   */
  registerUpstream(
    upstream: ProviderUpstreamConfig,
    providerId?: string
  ): void {
    this.slugMap.set(upstream.slug, upstream.upstreamBaseUrl);
    if (providerId) {
      this.slugToProviderId.set(upstream.slug, providerId);
    }
    if (upstream.apiKeyHeader) {
      this.slugToApiKeyHeader.set(upstream.slug, upstream.apiKeyHeader);
    }
    logger.debug(
      `Registered provider upstream: ${upstream.slug} -> ${upstream.upstreamBaseUrl}${providerId ? ` (providerId: ${providerId})` : ""}`
    );
  }

  getApp(): Hono {
    return this.app;
  }

  /**
   * Attach a resolved provider credential to the outgoing headers using the
   * correct scheme. Most providers are OpenAI-compatible and take the key as
   * `Authorization: Bearer`. Anthropic is the exception: it registers
   * `apiKeyHeader: "x-api-key"` and returns 401 ("invalid bearer token") when an
   * `sk-ant` API key arrives as a Bearer token. OAuth credentials always use
   * Bearer regardless — so the x-api-key scheme applies only to `api-key`
   * credentials. The `kind` is determined at resolution time (auth-profile type,
   * org-shared key, or the system-key resolver), never sniffed from the
   * credential string. Exactly one of the two headers is set so the upstream
   * never sees a conflicting pair.
   */
  private applyCredentialHeader(
    headers: Record<string, string>,
    slug: string,
    credential: string,
    kind: CredentialKind
  ): void {
    if (this.slugToApiKeyHeader.get(slug) === "x-api-key" && kind !== "oauth") {
      delete headers.authorization;
      headers["x-api-key"] = credential;
    } else {
      delete headers["x-api-key"];
      headers.authorization = `Bearer ${credential}`;
    }
  }

  private setupRoutes(): void {
    this.app.get("/health", (c) =>
      c.json({
        service: "secret-proxy",
        status: "enabled",
        timestamp: new Date().toISOString(),
      })
    );

    this.app.all("/*", (c) => this.handleRequest(c));
  }

  private async handleRequest(c: Context): Promise<Response> {
    try {
      return await this.forward(c);
    } catch (error) {
      // JSON.stringify(Error) renders `{}` (Error has no enumerable props),
      // which hid the real failure behind "Secret proxy error: {}" (#1176).
      // Extract the fields explicitly (same { err } shape as
      // packages/core/src/worker/auth.ts), including `cause` — undici wraps
      // the underlying dispatch error there.
      logger.error(
        {
          err:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : error,
          cause: (error as { cause?: unknown })?.cause
            ? String((error as { cause?: unknown }).cause)
            : undefined,
        },
        "Secret proxy error"
      );
      return c.json({ error: "Internal proxy error" }, 500);
    }
  }

  /**
   * Resolve a placeholder token to its real value via the in-memory cache.
   * Handles both plain (`lobu_secret_<uuid>`) and prefixed
   * (`sk-ant-oat01-lobu_secret_<uuid>`) placeholders.
   *
   * `expectedOrganizationId` is forwarded to {@link lookupPlaceholderMapping}
   * so a worker carrying another tenant's placeholder cannot resolve it
   * even on the legacy header-swap path.
   */
  private async resolveSecret(
    placeholder: string,
    expectedOrganizationId?: string
  ): Promise<string | null> {
    const mapping = this.lookupPlaceholderMapping(
      placeholder,
      expectedOrganizationId
    );
    if (!mapping) return null;
    return this.secretStore.get(mapping.secretRef);
  }

  /**
   * Look up just the SecretMapping (without resolving the secret value)
   * for a placeholder. Used to verify the calling worker's bound agentId
   * matches the agentId in the request URL.
   *
   * If `expectedOrganizationId` is supplied and the stored mapping is
   * tagged with a different org, treat it the same as a missing mapping —
   * log and return null. This is defense-in-depth on top of the existing
   * `mapping.agentId === urlAgentId` check: if a future code path
   * resolves placeholders under a different tenant's context (e.g.
   * cross-tenant header forwarding), the mismatch here blocks it.
   */
  private lookupPlaceholderMapping(
    placeholder: string,
    expectedOrganizationId?: string
  ): SecretMapping | null {
    return lookupPlaceholderMapping(placeholder, expectedOrganizationId);
  }

  /**
   * The dedicated worker-token string: `x-lobu-worker-token` header (either
   * casing) or the `worker_token` query param (used by SSE callers that can't
   * set headers). Returns undefined when neither is present.
   */
  private getWorkerTokenString(c: Context): string | undefined {
    const header =
      c.req.header("x-lobu-worker-token") ||
      c.req.header("X-Lobu-Worker-Token");
    return header || c.req.query("worker_token") || undefined;
  }

  /**
   * Verified worker-token claims in resolution order: the dedicated
   * worker-token first, then the `authorization: Bearer` and `x-api-key`
   * credentials WHEN they aren't `lobu_secret_<uuid>` placeholders (those
   * headers normally carry a placeholder, but legacy callers pass the worker
   * JWT directly, and a native capture turn presents its signed credential in
   * whichever header the provider protocol uses). Each entry is the decoded
   * payload; callers read the first that carries the field they need,
   * preserving the original per-field fallback precedence.
   */
  private verifiedWorkerClaims(
    c: Context
  ): Array<NonNullable<ReturnType<typeof verifyWorkerToken>>> {
    const out: Array<NonNullable<ReturnType<typeof verifyWorkerToken>>> = [];
    const candidate = this.getWorkerTokenString(c);
    if (candidate) {
      const data = verifyWorkerToken(candidate);
      if (data) out.push(data);
    }
    for (const tok of [parseBearer(c.req.header("authorization")), c.req.header("x-api-key")]) {
      if (tok && !tok.includes(CREDENTIAL_PLACEHOLDER_PREFIX)) {
        const data = verifyWorkerToken(tok);
        if (data) out.push(data);
      }
    }
    return out;
  }

  /**
   * Stable, non-spoofable identity for abuse-tracking, taken from the SIGNED
   * worker token (agentId, else deployment). Returns undefined when no valid
   * token is present so the caller can fall back to a weaker signal.
   */
  private extractWorkerTokenIdentity(c: Context): string | undefined {
    for (const data of this.verifiedWorkerClaims(c)) {
      const id = data.agentId ?? data.deploymentName ?? undefined;
      if (id) return id;
    }
    return undefined;
  }

  /**
   * The `organizationId` bound into the SIGNED worker token. Returns undefined
   * when no verifiable token carries one — the caller then relies on
   * `agentOrgResolver` (DB lookup keyed by URL agentId) to fill in the
   * expected org.
   */
  private extractWorkerTokenOrg(c: Context): string | undefined {
    for (const data of this.verifiedWorkerClaims(c)) {
      if (data.organizationId) return data.organizationId;
    }
    return undefined;
  }

  /**
   * The `deploymentName` bound into the SIGNED worker token — the key
   * turn-liveness markers are stored under. Taken from the token rather than the
   * URL because it decides whether a turn keeps renewing its deadline, and the
   * URL carries only agent/org/user.
   */
  private extractWorkerTokenDeployment(c: Context): string | undefined {
    for (const data of this.verifiedWorkerClaims(c)) {
      if (data.deploymentName) return data.deploymentName;
    }
    return undefined;
  }

  /**
   * Extract the bearer/api-key value the caller used to authenticate.
   * Returns the raw token string, or null if no auth header is present.
   */
  private extractCallerToken(c: Context): string | null {
    const apiKey = c.req.header("x-api-key");
    if (apiKey) return apiKey;
    const auth = c.req.header("authorization");
    if (!auth) return null;
    return parseBearer(auth) ?? auth;
  }

  /**
   * If the value contains a UUID placeholder prefix, resolve the real secret.
   * Returns the value unchanged if it's not a recognized pattern.
   *
   * `source` identifies the caller (best available identity: bound agentId or
   * remote address) for per-source failed-resolution rate limiting.
   */
  private async swap(
    value: string,
    source: string,
    expectedOrganizationId?: string
  ): Promise<string> {
    if (value.includes(CREDENTIAL_PLACEHOLDER_PREFIX)) {
      if (resolutionFailureLimiter.isThrottled(source)) {
        // Source has burned through its failure budget — hard-fail without
        // touching the cache or logging another line.
        return "";
      }
      const resolved = await this.resolveSecret(value, expectedOrganizationId);
      if (!resolved) {
        // Fail closed: forwarding the literal placeholder upstream would
        // surface it in the provider's error response (and thus in worker
        // logs / user-facing messages), giving an attacker a stable handle
        // to enumerate. An empty string fails the auth check upstream
        // without exposing the ref.
        const { shouldLog, nowThrottled } =
          resolutionFailureLimiter.recordFailure(source);
        if (shouldLog) {
          if (nowThrottled) {
            logger.warn(
              { source },
              "Throttling placeholder resolution for source after repeated failures"
            );
          } else {
            logger.warn({ source }, "Failed to resolve secret placeholder");
          }
        }
        return "";
      }
      resolutionFailureLimiter.recordSuccess(source);
      return resolved;
    }

    return value;
  }

  private async forward(c: Context): Promise<Response> {
    // Build upstream URL — strip the proxy mount prefix and resolve provider slug.
    // Handles the case where the gateway is mounted as a sub-app under a prefix
    // (e.g. /lobu/api/proxy/...) by stripping everything up to and including
    // /api/proxy rather than requiring it at the start.
    const url = new URL(c.req.url);
    const proxyIdx = url.pathname.indexOf("/api/proxy");
    const rawPath =
      proxyIdx >= 0
        ? url.pathname.slice(proxyIdx + "/api/proxy".length)
        : url.pathname;

    const capture = this.verifiedWorkerClaims(c).find((claims) => claims.executionMode === "capture");
    if (capture && capture.automationRunId === undefined) {
      // Exact admitted inference path: no files, batches, media or other provider.
      const [row] = await getDb()`
        SELECT action_input->'turn'->'provider' AS provider FROM runs
        WHERE id = ${capture.runId ?? null} AND organization_id = ${capture.organizationId ?? null}
          AND run_type = 'agent_turn' AND status IN ('pending', 'running')
          AND action_input->'turn'->>'agent_id' = ${capture.agentId ?? null}
          AND action_input->'turn'->>'conversation_id' = ${capture.conversationId}
      `;
      const provider = row?.provider;
      const suffix = provider?.api === "anthropic-messages"
        || provider?.api === "openai-completions"
        || provider?.api === "openai-responses"
        || provider?.api === "openai-codex-responses"
        ? captureInferencePath(provider.api)
        : null;
      const expected = suffix && typeof provider?.base_url === "string"
        ? new URL(provider.base_url.replace(/\/$/, "") + suffix) : null;
      if (!expected || c.req.method !== "POST" || url.pathname !== expected.pathname || url.search) {
        return c.json({ error: "Provider endpoint unavailable during capture" }, 403);
      }
    }

    // Try slug-based routing: /api/proxy/{slug}/rest/of/path
    let upstreamBaseUrl = this.config.defaultUpstreamUrl;
    let forwardPath = rawPath;
    let resolvedSlug: string | undefined;
    let urlAgentId: string | undefined;
    let providerContext: ProviderCredentialContext | undefined;
    const slugMatch = rawPath.match(/^\/([^/]+)(\/.*)?$/);
    if (slugMatch) {
      const candidateSlug = slugMatch[1]!;
      const resolved = this.slugMap.get(candidateSlug);
      if (resolved) {
        upstreamBaseUrl = resolved;
        forwardPath = slugMatch[2] || "";
        resolvedSlug = candidateSlug;

        // Extract agent/org/user scope from the provider proxy path if present.
        // URL format: /api/proxy/{slug}/a/{agentId}/o/{organizationId}/u/{userId}/v1/chat/completions
        // Legacy callers may omit /o/{organizationId} and/or /u/{userId}.
        const agentMatch = forwardPath.match(
          /^\/a\/([^/]+)(?:\/o\/([^/]+))?(?:\/u\/([^/]+))?(\/.*)?$/
        );
        if (agentMatch) {
          urlAgentId = safeDecodePathSegment(agentMatch[1]);
          const organizationId = safeDecodePathSegment(agentMatch[2]);
          const userId = safeDecodePathSegment(agentMatch[3]);
          forwardPath = agentMatch[4] || "";
          providerContext = {
            ...(organizationId ? { organizationId } : {}),
            ...(userId ? { userId } : {}),
          };
        }
      }
    }

    // Static default upstream (providers.json slugMap). A custom org upstream,
    // if configured, overrides `upstreamBaseUrl` below — resolved together with
    // the org-only credential from a single row read so the URL the key is
    // consented for and the URL we POST to cannot diverge.
    let resolvedUpstreamBaseUrl = upstreamBaseUrl;

    // Copy request body for non-GET/HEAD
    const method = c.req.method;
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await c.req.text();
    }

    // Derive the caller's expected org from the verified worker token
    // (preferred — it's signed) and fall back to a DB lookup keyed by the
    // URL agentId. Either source becomes the `expectedOrganizationId`
    // we hand to placeholder + secret lookups so a worker bearing org A's
    // placeholder cannot resolve it under org B's URL.
    const callerToken = this.extractCallerToken(c);
    const workerTokenOrganizationId = this.extractWorkerTokenOrg(c);
    // Trust the URL-carried org only for placeholder-authenticated workers: the
    // placeholder mapping is itself org-tagged and is checked against this value
    // immediately below. Legacy non-placeholder callers keep using the signed
    // worker-token org or DB resolver so a spoofed /o/{org} segment can't spend
    // another tenant's org-shared provider key.
    const pathOrganizationId = callerToken?.includes(CREDENTIAL_PLACEHOLDER_PREFIX)
      ? providerContext?.organizationId
      : undefined;
    let expectedOrganizationId: string | undefined =
      workerTokenOrganizationId || pathOrganizationId;
    if (!expectedOrganizationId && urlAgentId && this.agentOrgResolver) {
      try {
        const orgId = await this.agentOrgResolver(urlAgentId);
        if (orgId) expectedOrganizationId = orgId;
      } catch (err) {
        // Fail closed. Falling through with `expectedOrganizationId =
        // undefined` on a transient DB error downgrades the placeholder /
        // secret-lookup org checks for the entire request — a window where
        // a worker bound to org A could resolve a placeholder pointed at
        // org B's URL because the binding step lost its expected-org
        // anchor. The isolation invariant matters more than the brief
        // 503 window during a DB hiccup.
        logger.error(
          { urlAgentId, err: String(err) },
          "agentOrgResolver failed — rejecting request to preserve org isolation"
        );
        return c.json(
          { error: "Service Unavailable: failed to resolve agent organization" },
          503
        );
      }
    }

    // Bind the calling worker (identified by its placeholder credential) to
    // the agentId in the URL. Without this, anyone with network access to the
    // gateway could harvest another agent's credentials by changing the URL
    // segment. We accept that legacy callers without a placeholder are not
    // bound (logged as a warning) but reject any request whose placeholder
    // resolves to a different agent than the URL claims.
    if (urlAgentId) {
      if (callerToken?.includes(CREDENTIAL_PLACEHOLDER_PREFIX)) {
        const mapping = this.lookupPlaceholderMapping(
          callerToken,
          expectedOrganizationId
        );
        if (!mapping) {
          logger.warn(
            { urlAgentId },
            "Rejecting proxy request: placeholder did not resolve"
          );
          return c.json({ error: "Unauthorized" }, 401);
        }
        if (mapping.agentId !== urlAgentId) {
          logger.warn(
            { urlAgentId, mappingAgentId: mapping.agentId },
            "Rejecting proxy request: placeholder agentId does not match URL"
          );
          return c.json({ error: "Forbidden" }, 403);
        }
      } else if (callerToken) {
        // A non-placeholder caller authenticates with a worker JWT. Bind it to
        // the URL agentId exactly like the placeholder path above: a worker
        // minted for agent A must not spend agent B's provider credentials by
        // rewriting the `/a/{agentId}/` URL segment (these requests reach the
        // provider-credential path below, which injects the URL agent's real
        // key). The token already carries the agentId it was minted for.
        const workerTokenStr =
          this.getWorkerTokenString(c) ||
          (!callerToken.includes(CREDENTIAL_PLACEHOLDER_PREFIX)
            ? callerToken
            : undefined);
        const tokenData = workerTokenStr
          ? verifyWorkerToken(workerTokenStr)
          : null;
        // Bind ONLY when the token verifies AND carries an agentId. We do NOT
        // reject a non-verifying token here: embedded/local worker→proxy auth
        // legitimately reaches this branch with a token verifyWorkerToken can't
        // decode (different credential shape), and rejecting it 401s real chat
        // turns (caught by cli-smoke / sdk-e2e / integration). The provider
        // credential lookup below is still org-scoped via expectedOrganizationId.
        if (tokenData?.agentId && tokenData.agentId !== urlAgentId) {
          logger.warn(
            { urlAgentId, tokenAgentId: tokenData.agentId },
            "Rejecting proxy request: worker token agentId does not match URL"
          );
          return c.json({ error: "Forbidden" }, 403);
        }
        if (!tokenData?.agentId) {
          // Token didn't verify, or verified without an agentId (internal/
          // preflight tokens minted before agent resolution) — agentId binding
          // is skipped; org scoping still applies via expectedOrganizationId.
          logger.debug(
            { urlAgentId },
            "Proxy request: non-placeholder token without bindable agentId; agentId binding skipped"
          );
        }
      } else {
        // No auth header at all but the URL names an agent — refuse rather than
        // forward upstream using that agent's credential. An unauthenticated
        // caller must never be able to spend another agent's provider quota.
        logger.warn(
          { urlAgentId },
          "Rejecting proxy request: names an agent but carries no auth header"
        );
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    // Build headers, swapping placeholder secrets in auth headers
    const headers: Record<string, string> = {};

    // Forward provider headers, excluding ingress routing and inbound auth.
    // We always set our own Authorization below, so the caller's Authorization
    // (which carries an opaque placeholder) must never reach the upstream.
    const skip = new Set([
      "host",
      "connection",
      "transfer-encoding",
      // Never forward the inbound content-length: fetch recomputes it from the
      // body we pass. Forwarding it breaks when a foreign undici global
      // dispatcher is installed (pi-ai's http-proxy side-effect) and the
      // dispatching undici is >= 7.27 — it throws
      // `InvalidArgumentError: invalid content-length header` before any
      // network I/O, turning EVERY LLM call into a 500 (#1176).
      "content-length",
      // Hop-by-hop headers undici hard-rejects on egress.
      "expect",
      "keep-alive",
      "upgrade",
      "authorization",
      "x-api-key",
      "x-lobu-worker-token",
      // Ingress routing metadata (these, plus the `cf-*` / `x-forwarded-*`
      // prefixes matched in `shouldSkipHeader`). They describe the hop INTO
      // Lobu, not our request to the provider: ChatGPT answers an egress
      // request that relays Cloudflare ingress metadata with an HTML 403,
      // before it ever reaches the Codex API.
      "forwarded",
      "x-real-ip",
      "true-client-ip",
      "via",
      "cdn-loop",
    ]);
    const shouldSkipHeader = (name: string): boolean =>
      skip.has(name) || name.startsWith("cf-") || name.startsWith("x-forwarded-");
    for (const [key, val] of Object.entries(c.req.header())) {
      if (val && !shouldSkipHeader(key.toLowerCase())) {
        headers[key] = val;
      }
    }

    // Resolve credentials: prefer URL-based agentId (no header parsing needed),
    // fall back to marker/placeholder swap for backward compatibility.
    if (urlAgentId && resolvedSlug && this.authProfilesManager) {
      const providerId = this.slugToProviderId.get(resolvedSlug);
      if (providerId) {
        // Run the credential lookup under the caller's expected org context
        // when we have one. Without this wrapper, `AuthProfilesManager`
        // calls its OWN `agentOrgResolver` to derive the org — and on a
        // transient DB error that resolver logs a warning and returns
        // undefined, then falls through to unscoped credential reads
        // (`auth-profiles-manager.ts:251-275`). Wrapping here makes the
        // org explicit so the resolver short-circuits and a DB hiccup
        // cannot downgrade scoping for a request whose org we already
        // know from the worker token / URL.
        const runWithOrg = <T>(fn: () => Promise<T>): Promise<T> =>
          expectedOrganizationId
            ? orgContext.run({ organizationId: expectedOrganizationId }, fn)
            : fn();
        // URL invariant (see inference-invariant.ts): if this org configured a
        // custom upstream for the provider, the request is bound for a
        // tenant-defined URL and ONLY the org row's own key may be sent there —
        // never a per-user profile or a deployment env key. The row is read
        // once (base_url + key together), so the base_url can't be flipped
        // between this gate and the fetch below.
        const invariant = await runWithOrg(() =>
          resolveUrlInvariant(resolvedSlug, expectedOrganizationId)
        );

        let resolvedCredential: ResolvedProviderCredential | null;
        if (invariant.kind === "org-only") {
          resolvedCredential = { value: invariant.credential, kind: "api-key" };
          // Route to the tenant-defined URL from the SAME row read as the key.
          resolvedUpstreamBaseUrl = invariant.baseUrl;
        } else if (invariant.kind === "org-credential") {
          // The org row owns the credential but keeps the trusted catalog URL.
          resolvedCredential = { value: invariant.credential, kind: "api-key" };
        } else if (invariant.kind === "org-only-unavailable") {
          // Custom upstream but no usable org key: fail CLOSED, never fall
          // through to a profile/env key bound for a tenant URL.
          resolvedCredential = null;
        } else {
          const authProfilesManager = this.authProfilesManager;
          const profile = await runWithOrg(() =>
            authProfilesManager.getBestProfile(
              urlAgentId,
              providerId,
              undefined,
              providerContext
            )
          );
          const userIdForRefresh = providerContext?.userId;
          const credential = profile && userIdForRefresh
            ? await runWithOrg(() =>
                authProfilesManager.ensureFreshCredential(profile, {
                  userId: userIdForRefresh,
                  agentId: urlAgentId,
                })
              )
            : profile?.credential;
          resolvedCredential = await resolveProviderCredential({
            profileCredential: credential ?? null,
            profileAuthType: profile?.authType,
            providerId,
            organizationId: expectedOrganizationId,
            readOrgSharedKey: readOrgSharedProviderApiKey,
            systemKeyResolver: this.systemKeyResolver,
          });
        }
        if (resolvedCredential) {
          this.applyCredentialHeader(
            headers,
            resolvedSlug,
            resolvedCredential.value,
            resolvedCredential.kind
          );
          if (providerId === "chatgpt") {
            // Codex binds requests to the stored OAuth account, never a guest
            // header or the adapter's non-secret account placeholder.
            const accountId = extractJwtAccountId(
              resolvedCredential.value,
              "https://api.openai.com/auth"
            );
            // Same envelope as the no-credentials refusal below: pi-ai reads
            // `error.message` off the body, so a bare string would surface to
            // the user as raw JSON.
            if (!accountId) {
              return c.json(
                {
                  error: {
                    message:
                      "The stored ChatGPT credential carries no account identity. Sign in again to reconnect the subscription.",
                    type: "authentication_error",
                    code: "no_account_identity",
                  },
                },
                401
              );
            }
            headers["chatgpt-account-id"] = accountId;
          }
        } else {
          logger.warn(
            `No auth profile, org-shared key, or system key for agent ${urlAgentId}, provider ${providerId}`
          );
          return c.json(
            {
              error: {
                message:
                  "No provider credentials configured. End-user provider setup is not available in chat yet. Ask an admin to connect a provider for the base agent.",
                type: "authentication_error",
                code: "no_credentials",
              },
            },
            401
          );
        }
      } else {
        logger.warn(`No providerId mapping for slug "${resolvedSlug}"`);
      }
    } else {
      // Legacy path: swap UUID placeholders in auth headers (non-provider secrets).
      // Read the originals from the request because we strip them from the
      // forwarded headers map above.
      // Throttle key, most-trustworthy first: the validated URL agentId, then
      // the SIGNED worker-token identity (a worker can't forge it), and only as
      // a last resort the client-controlled forwarding headers. Keying on the
      // headers alone let a compromised worker rotate `x-forwarded-for` to dodge
      // the placeholder-enumeration throttle.
      const source =
        urlAgentId ??
        this.extractWorkerTokenIdentity(c) ??
        getClientIp({
          forwardedFor: c.req.header("x-forwarded-for"),
          realIp: c.req.header("x-real-ip"),
        });
      const apiKey = c.req.header("x-api-key");
      if (apiKey) {
        headers["x-api-key"] = await this.swap(
          apiKey,
          source,
          expectedOrganizationId
        );
      }

      const auth = c.req.header("authorization");
      if (auth) {
        const bearer = parseBearer(auth);
        if (bearer !== null) {
          const swapped = await this.swap(
            bearer,
            source,
            expectedOrganizationId
          );
          headers.authorization = `Bearer ${swapped}`;
        }
      }
    }

    // Build the final upstream from the resolved base (static slugMap, or the
    // org custom upstream set by the URL invariant) + the forwarded path. The
    // forwarded path must be an absolute path segment ("/…") so it can only
    // extend the resolved base, never replace its host: a protocol-relative
    // "//evil" or an absolute "http://evil" as forwardPath would otherwise let
    // a worker-supplied suffix escape the resolved host. (Pre-existing gap —
    // forward() built `${base}${forwardPath}` from an unvalidated suffix.)
    const forwardPathOk =
      forwardPath === "" ||
      forwardPath === "/" ||
      (/^\/[^/\\]/.test(forwardPath) && !forwardPath.includes("\\"));
    if (!forwardPathOk) {
      logger.warn(
        `Rejected proxy request: forwarded path "${forwardPath}" is not a plain absolute path segment`
      );
      return c.json(
        {
          error: {
            message: "Invalid upstream path.",
            type: "invalid_request_error",
            code: "invalid_path",
          },
        },
        400
      );
    }
    const upstream = `${resolvedUpstreamBaseUrl}${forwardPath}${url.search}`;

    logger.info(`Forwarding to upstream: ${method} ${upstream}`);

    const response = await fetch(upstream, { method, headers, body });

    if (!response.ok) {
      // Log upstream failure without echoing the body — error responses from
      // some providers include the (rejected) credential or other sensitive
      // values that we don't want in our logs.
      logger.warn(
        `Upstream returned ${response.status} for ${method} ${upstream}`
      );
    }

    // Provider health is decided HERE, on the HTTP status, because this is the
    // only place that still HAS one. The worker runtime (`pi-ai`) collapses a
    // provider failure to `new Error(message)` before any of our code sees it —
    // status, `error.code`, and `error.type` are gone — which is why the
    // previous message-matching classifier silently missed OpenAI's "no credits
    // remaining" and Alibaba's "quota has been exhausted" and left the health
    // row untouched in prod. A status code needs no vocabulary.
    await this.recordProviderHealth(
      expectedOrganizationId,
      resolvedSlug,
      response,
      this.extractWorkerTokenDeployment(c)
    );

    // Build response headers (skip hop-by-hop)
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (
        ![
          "transfer-encoding",
          "connection",
          "upgrade",
          "content-encoding",
        ].includes(key.toLowerCase())
      ) {
        responseHeaders.set(key, value);
      }
    });

    // Stream SSE / chunked responses directly
    if (
      response.headers.get("content-type")?.includes("text/event-stream") ||
      response.headers.get("transfer-encoding") === "chunked"
    ) {
      responseHeaders.set("Cache-Control", "no-cache");
      responseHeaders.set("Connection", "keep-alive");
      if (response.body) {
        return new Response(response.body as ReadableStream, {
          status: response.status,
          headers: responseHeaders,
        });
      }
      return c.json({ error: "No response body from upstream" }, 502);
    }

    // Regular response pass-through
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: responseHeaders,
    });
  }

  /**
   * Record provider health from the upstream HTTP status.
   *
   * The status→verdict mapping lives in `classifyProviderHealthStatus`; see
   * there for why it is status-only and why it is narrow.
   *
   * Deliberately fires for EVERY proxied request of the slug — including
   * non-chat calls like `/v1/models` probes, not only served completions as
   * the retired terminal-row mechanism did: the same credential serves them
   * all, so a 429 on a probe proves the quota wall exactly like one on a
   * completion, and a probe 200 proves the credential works.
   *
   * Best-effort by design: `status` is a display signal plus a routing
   * PREFERENCE (`resolveDispatchModel` prefers a healthy sibling among the refs
   * an agent already lists), never a gate — so a failure to write can only cost
   * that preference, and must not fail the user's inference call. That is why
   * this swallows its own errors rather than propagating — the "fail closed on
   * durable dispatch state" rule governs delivery decisions, and this is an
   * observation, not a decision.
   */
  private async recordProviderHealth(
    organizationId: string | undefined,
    slug: string | undefined,
    response: Response,
    deploymentName?: string
  ): Promise<void> {
    if (!organizationId || !slug) return;
    try {
      if (response.ok) {
        await clearInferenceProviderError(organizationId, slug);
        // The same success re-arms deadline extension for this deployment's
        // turns: an SDK retry that recovers must not leave the turn flagged and
        // waiting to be swept. Keyed on deployment, so it only ever unblocks
        // turns whose own worker just proved the provider works.
        if (deploymentName) await clearTurnProviderFailed(deploymentName);
        return;
      }
      const code = classifyProviderHealthStatus(response.status);
      if (!code) return;
      // `Retry-After` is the provider's own answer to "when does this clear",
      // in seconds or as an HTTP date — a structured horizon that needs no
      // date parsing out of a sentence. Absent on a balance wall, which is
      // exactly the signal that it will not self-heal.
      const retryAfter = response.headers.get("retry-after");
      await markInferenceProviderUnhealthy(
        organizationId,
        slug,
        `HTTP ${response.status}${retryAfter ? ` (retry-after: ${retryAfter})` : ""} — ${code}`
      );
      // Withdraw this deployment's deadline EXTENSION (not the turn itself).
      // The worker keeps heartbeating after a terminal provider answer even
      // though the turn will never produce a reply, and that heartbeat was
      // renewing the turn's own liveness deadline forever. Dropping the
      // extension lets the existing deadline lapse so the sweep fails the turn
      // (WORKER_UNRESPONSIVE; the provider reason is kept on the marker for
      // diagnosis), while the SDK's own retries can still recover and clear the
      // flag on the next 2xx.
      if (deploymentName) {
        await markTurnProviderFailed(
          deploymentName,
          code,
          `${slug}: HTTP ${response.status} — ${code}`
        );
      }
    } catch (err) {
      logger.warn(
        `Failed to record provider health for ${slug}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// ============================================================================
// Utility: store / delete placeholder mappings (in-memory, per-process)
// ============================================================================

/**
 * Store a secret placeholder mapping in the in-process cache.
 * Called by the deployment manager when generating env vars.
 */
export function storeSecretMapping(
  uuid: string,
  mapping: SecretMapping,
  ttlSeconds: number = defaultPlaceholderTtlSeconds()
): void {
  placeholderCache.set(uuid, mapping, ttlSeconds);
}

/**
 * Delete all secret placeholder mappings for a given deployment.
 * Called during deployment teardown.
 */
export function deleteSecretMappings(deploymentName: string): number {
  return placeholderCache.deleteByDeployment(deploymentName);
}

/**
 * Generate a UUID placeholder token and store its mapping.
 * Returns the placeholder string to pass to the worker.
 * Used for non-provider secrets (custom env vars with _KEY/_TOKEN/_SECRET patterns).
 */
export function generatePlaceholder(
  agentId: string,
  envVarName: string,
  secretRef: SecretRef,
  deploymentName: string,
  options?: { ttlSeconds?: number; organizationId?: string }
): string {
  const uuid = randomUUID();
  storeSecretMapping(
    uuid,
    {
      agentId,
      envVarName,
      secretRef,
      deploymentName,
      organizationId: options?.organizationId,
    },
    options?.ttlSeconds
  );
  return `${CREDENTIAL_PLACEHOLDER_PREFIX}${uuid}`;
}

/** Test-only: drop every placeholder and reset the failure limiter. */
export function __resetPlaceholderCacheForTests(): void {
  (placeholderCache as unknown as { entries: Map<string, unknown> }).entries.clear();
  resolutionFailureLimiter.reset();
}
