import {
	createLogger,
	ErrorCode,
	extractTraceId,
	getErrorMessage,
	type MessagePayload,
	normalizeDomainPattern,
	OrchestratorError,
} from "@lobu/core";
import type { ProviderCredentialContext } from "../embedded.js";
import type { ModelProviderModule } from "../modules/module-system.js";
import type { GrantStore } from "../permissions/grant-store.js";
import { patternReaches } from "@lobu/connector-sdk/egress-policy";
import {
  egressGuardrailsToPolicyBundle,
  type PolicyStore,
} from "../permissions/policy-store.js";
import {
  deleteSecretMappings,
  generatePlaceholder,
} from "../proxy/secret-proxy.js";
import {
  deleteSecretsByPrefix,
  persistSecretValue,
  type WritableSecretStore,
} from "../secrets/index.js";
import {
  buildDeploymentInfoSummary,
  runInBatches,
} from "./deployment-utils.js";
import { CredentialLeaseRegistry } from "../agent-tooling/credential-lease.js";
import {
  EMPTY_AGENT_TOOLING,
  isReservedAgentToolingEnvName,
  resolveAgentTooling,
  resolveAgentToolingDeclaration,
  type ResolvedAgentTooling,
} from "../agent-tooling/resolver.js";
import { resolvePinnedSelection } from "../../lobu/stores/sandbox-store.js";
import { getInternalGatewayUrl } from "../config/index.js";
import {
  buildDeploymentTokenPair,
  detectProviderBaseUrlCollisions,
  isSecretEnvVar,
} from "./deployment-identity.js";

export { signalWorkerGroup, __resetCapabilityProbesForTests } from "./host-capabilities.js";
export {
  acquireConversationLock,
  getMaxReservedLocks,
  getReservedLockCount,
  resetReservedLockCountForTests,
  setReservedLockCountForTests,
} from "./conversation-locks.js";
export { nixPackageAttrRef } from "./worker-invocation.js";
export {
  buildCanonicalConversationKey,
  buildDeploymentWorkerToken,
  detectProviderBaseUrlCollisions,
  generateDeploymentName,
  type DeploymentIdentity,
} from "./deployment-identity.js";

const logger = createLogger("orchestrator");

/**
 * A tracked deployment slot. Nothing populates this map now that turns run in
 * the isolate lane — the worker claims its run over HTTP instead of being
 * spawned — so the lifecycle methods below report an empty set. The type and
 * the methods stay because `worker-gateway` and the shutdown drain still call
 * them, and an empty answer is the correct one.
 */
interface EmbeddedWorkerEntry {
  lastActivity: Date;
}

/**
 * TTL applied to non-provider secret env var placeholders. Mappings are
 * cascade-deleted on deployment teardown; this only bounds how long an
 * orphaned mapping (pod crash, agent deleted mid-day) survives. 24h default,
 * overridable via `SECRET_PLACEHOLDER_TTL_MS`.
 */
const SECRET_PLACEHOLDER_TTL_SECONDS = (() => {
  const raw = process.env.SECRET_PLACEHOLDER_TTL_MS;
  if (raw) {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return 24 * 60 * 60;
})();

/**
 * Maximum number of agents tracked in the grant-sync LRU. Oldest entry is
 * evicted when the cache grows past this bound, which prevents unbounded
 * memory growth for long-running gateways that see a large agent churn.
 */
const GRANT_SYNC_CACHE_MAX = 1000;

/**
 * Stand-in used when no lease registry is wired. Registering nothing means
 * `mintFor` always returns null, so agent tooling still contributes its
 * packages and domains while every lease var is omitted.
 */
const EMPTY_LEASE_REGISTRY = new CredentialLeaseRegistry();

/**
 * Nix binary-cache hosts auto-allowed while an agent has a Nix environment
 * configured. Config-derived like `networkConfig` domains: granted by the
 * sync while `nixConfig` is present, reconciled away when it is removed.
 */
const NIX_CACHE_DOMAINS = [
  "cache.nixos.org",
  "channels.nixos.org",
  "releases.nixos.org",
];

/**
 * npm registry hosts auto-granted at deploy time when CLI-backend providers
 * are configured (see `generateEnvironmentVariables`). Not derivable from
 * the message payload, so the domain reconcile must never revoke them.
 */
const NPM_REGISTRY_DOMAINS = ["registry.npmjs.org", "registry.npmmirror.com"];

// Type for module environment variable builder function
export type ModuleEnvVarsBuilder = (
  agentId: string,
  envVars: Record<string, string>,
  context?: ProviderCredentialContext
) => Promise<Record<string, string>>;

/** Pod-local probe for the worker's authenticated SSE registration. */
type DeploymentReadinessProbe = (deploymentName: string) => boolean;

// Orchestrator configuration
export interface OrchestratorConfig {
  queues: {
    retryLimit: number;
    retryDelay: number;
    expireInSeconds: number;
  };
  worker: {
    /**
     * Absolute path to the worker TypeScript entrypoint. Callers compute
     * this once at boot — the gateway never probes cwd or reads env at
     * deployment time.
     */
    entryPoint?: string;
    /**
     * Extra PATH entries prepended when spawning worker processes (e.g.
     * workspace-local `.bin` directories for `tsx`, `bun`). Callers supply
     * absolute paths; the manager uses them verbatim.
     */
    binPathEntries?: string[];
    startupTimeoutSeconds?: number;
    idleCleanupMinutes: number;
    maxDeployments: number;
    env?: Record<string, string | number | boolean>;
  };
  cleanup: {
    initialDelayMs: number;
    intervalMs: number;
    veryOldDays: number;
  };
}

export interface DeploymentInfo {
  deploymentName: string;
  lastActivity: Date;
  minutesIdle: number;
  daysSinceActivity: number;
  replicas: number;
  isIdle: boolean;
  isVeryOld: boolean;
}

/**
 * Manages worker deployments for the embedded gateway: spawns each worker as a
 * `child_process` subprocess (wrapped in `systemd-run --scope` + `nix-shell`
 * when available), assembles the worker environment, syncs per-agent grants and
 * egress policy, and reaps idle/old workers.
 */
export class DeploymentManager {
  protected config: OrchestratorConfig;
  protected moduleEnvVarsBuilder?: ModuleEnvVarsBuilder;
  protected providerModules: ModelProviderModule[];
  protected providerCatalogService?: import("../auth/provider-catalog.js").ProviderCatalogService;
  /**
   * Set by `setSecretStore` during `Orchestrator.injectCoreServices`.
   * `generateEnvironmentVariables` asserts this is present before use.
   */
  protected secretStore?: WritableSecretStore;
  protected grantStore?: GrantStore;
  protected policyStore?: PolicyStore;
  /**
   * Mints credential leases for connector-contributed agent tooling.
   * Unset (tests, or a gateway with no lease providers wired) means connections
   * contribute their packages and domains but no credentials.
   */
  protected leaseRegistry?: CredentialLeaseRegistry;
  /**
   * Authenticated worker-connection probe, wired at the composition root once
   * WorkerGateway exists. A spawned child is not ready merely because spawn()
   * returned: it must establish its SSE stream before its durable queue can be
   * consumed.
   */
  private readinessProbe?: DeploymentReadinessProbe;
  /**
   * Per-(org, agent) cache of the last-synced `preApprovedTools` patterns,
   * used to diff tool grants/revokes (domains reconcile against Postgres
   * instead — see syncNetworkConfigGrants). Keyed by `org|agent` — agent
   * ids are only unique within an organization, and grants are org-scoped
   * rows, so an agent-id-only key would let org A's sync suppress org B's
   * writes.
   */
  private grantSyncCache = new Map<string, Set<string>>();

  /**
   * Earliest connector-lease expiry per deployment, recorded at env-build time.
   *
   * Pod-local by design, and NOT the multi-replica trap: the entry describes a
   * worker THIS pod spawned, and dispatch to that worker happens only on this
   * pod (its `thread_message_*` queue is registered by the pod it SSE-connects
   * to), so the pod that reads this state is always the pod that wrote it. A
   * different replica serving the same conversation spawns its own worker and
   * mints its own lease — nothing here is shared state.
   */
  private leaseExpiryByDeployment = new Map<string, Date>();

  /**
   * How long before a lease's stated expiry the deployment stops being
   * reusable. A turn that starts inside this window could still be running when
   * the credential dies, so recycle early rather than hand the sandbox a token
   * that expires mid-command.
   */
  private static readonly LEASE_RECYCLE_MARGIN_MS = 5 * 60 * 1000;

  /**
   * Normal minimum age for a newly built deployment. The effective floor is
   * capped at the lease's actual expiry: a short-lived credential gets its full
   * usable life without causing per-turn rebuilds, then renews when it expires
   * instead of leaving the sandbox unauthenticated until this whole interval
   * elapses.
   */
  private static readonly MIN_DEPLOYMENT_AGE_BEFORE_RECYCLE_MS = 10 * 60 * 1000;

  /**
   * Tooling fingerprint each deployment was BORN with, so the dispatch gate
   * can tell that the org's connections changed underneath a warm worker.
   */
  private toolingFingerprintByDeployment = new Map<string, string>();

  /** When each deployment's lease was minted — see the recycle age floor. */
  private leaseMintedAtByDeployment = new Map<string, Date>();

  /**
   * True when a warm deployment holds a connector lease that has expired or is
   * about to. The caller tears the deployment down so the normal create path
   * re-mints — a worker reads its env once at process start, so refreshing the
   * credential in place is not possible.
   */
  hasExpiringLease(deploymentName: string, now: Date = new Date()): boolean {
    const expiresAt = this.leaseExpiryByDeployment.get(deploymentName);
    if (!expiresAt) return false;

    // A deployment built moments ago holds the freshest credential the provider
    // will give us. If that is ALREADY inside the margin, rebuilding on every
    // turn cannot improve it. Suppress recycling until the earlier of the
    // normal age floor and the credential's own expiry: this prevents per-turn
    // churn without keeping an already-expired token for the remainder of a
    // ten-minute floor.
    const builtAt = this.leaseMintedAtByDeployment.get(deploymentName);
    if (
      builtAt &&
      now.getTime() <
        Math.min(
          builtAt.getTime() +
            DeploymentManager.MIN_DEPLOYMENT_AGE_BEFORE_RECYCLE_MS,
          expiresAt.getTime()
        )
    ) {
      return false;
    }

    return (
      expiresAt.getTime() - now.getTime() <=
      DeploymentManager.LEASE_RECYCLE_MARGIN_MS
    );
  }

  /**
   * True when a job's enqueue-time fingerprint stamp differs from the one this
   * deployment was built with. A mismatch is a SIGNAL, not a verdict: the
   * stamp may simply predate the deployment's (re)build, so the dispatch gate
   * confirms via {@link hasToolingDrifted} before acting on it.
   *
   * Same root cause as {@link hasExpiringLease}: env is read once at process
   * start. Without this, connecting GitHub mid-conversation leaves the agent
   * with no `gh` and no GH_TOKEN until something else recycles it, and
   * switching installations keeps it acting as the previous identity.
   *
   * Unknown deployment → false. A deployment this pod did not build is not
   * evidence of a change, and recycling on every unknown name would tear down
   * healthy workers after a pod restart.
   */
  hasToolingStampMismatch(deploymentName: string, fingerprint: string): boolean {
    const known = this.toolingFingerprintByDeployment.get(deploymentName);
    if (known === undefined) return false;
    return known !== fingerprint;
  }

  /**
   * DB-truth confirmation for a stamp mismatch: has the org's tooling ACTUALLY
   * drifted from what this deployment was built with?
   *
   * A mismatching stamp alone cannot be acted on, and no chronology proxy can
   * rescue it: `runs.id` order is not processing order (message claims run
   * concurrently across replicas), so a job with a LOWER runId can carry a
   * NEWER observation. Instead of ordering observations, re-read the truth:
   * resolve the org's current declaration digest — the same mint-free resolver
   * the enqueue-side stamp uses — and compare it against the deployment's born
   * fingerprint. current == born means the stamp is merely outdated (deliver);
   * current != born means the worker is genuinely stale (recycle). The rebuild
   * records the current digest as the new born value, so outdated stamps can
   * never churn a fresh worker and a recycle loop cannot form.
   *
   * Resolution failures propagate (fail closed — an error is not evidence of
   * freshness). Unknown deployment → false, mirroring the stamp check.
   */
  async hasToolingDrifted(
    deploymentName: string,
    payload: MessagePayload
  ): Promise<boolean> {
    const born = this.toolingFingerprintByDeployment.get(deploymentName);
    if (born === undefined) return false;
    const current = await resolveAgentToolingDeclaration({
      organizationId: payload.organizationId,
    });
    return current.fingerprint !== born;
  }

  /** Drop connector-tooling state for a deployment that no longer exists. */
  protected forgetDeploymentTooling(deploymentName: string): void {
    this.leaseExpiryByDeployment.delete(deploymentName);
    this.leaseMintedAtByDeployment.delete(deploymentName);
    this.toolingFingerprintByDeployment.delete(deploymentName);
  }

  private workers: Map<string, EmbeddedWorkerEntry> = new Map();
  /** Conversation-lock releases started by child exit handlers. */
  private conversationLockReleases = new Map<string, Promise<void>>();

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder,
    providerModules: ModelProviderModule[] = []
  ) {
    this.config = config;
    this.moduleEnvVarsBuilder = moduleEnvVarsBuilder;
    this.providerModules = providerModules;
  }

  setSecretStore(secretStore: WritableSecretStore): void {
    this.secretStore = secretStore;
  }

  /**
   * Refresh provider modules after module registry initialization.
   */
  setProviderModules(providerModules: ModelProviderModule[]): void {
    this.providerModules = providerModules;
  }

  setProviderCatalogService(
    service: import("../auth/provider-catalog.js").ProviderCatalogService
  ): void {
    this.providerCatalogService = service;
  }

  /**
   * The provider-catalog service, when wired. Exposed so the message consumer
   * can enforce the exact-model allow-list at ENQUEUE time (before the payload
   * is persisted to the queue) — the deployment-time enforcement is too late
   * for warm/resumed workers that never re-run createWorkerDeployment.
   */
  getProviderCatalogService():
    | import("../auth/provider-catalog.js").ProviderCatalogService
    | undefined {
    return this.providerCatalogService;
  }

  /**
   * Inject grant store for auto-adding domain grants at deployment time.
   */
  setGrantStore(store: GrantStore): void {
    this.grantStore = store;
  }

  /**
   * Inject policy store for syncing per-agent egress judge rules.
   */
  setPolicyStore(store: PolicyStore): void {
    this.policyStore = store;
  }

  /**
   * Inject the credential-lease registry used to mint credentials for
   * connector-contributed agent tooling.
   */
  setCredentialLeaseRegistry(registry: CredentialLeaseRegistry): void {
    this.leaseRegistry = registry;
  }

  setDeploymentReadinessProbe(probe: DeploymentReadinessProbe): void {
    this.readinessProbe = probe;
  }

  /**
   * Wait until a newly spawned/scaled worker has authenticated and registered
   * its SSE stream. When the watchdog lapses, tear the child down under the
   * same deployment name before throwing: MessageConsumer's existing retry
   * loop can then create a genuinely fresh process instead of repeatedly
   * accepting the same live-but-never-connected child from `workers`.
   *
   * A missing probe is a deliberate no-op for SDK hosts that construct the
   * orchestrator without WorkerGateway. The embedded server activates its
   * probe after the local HTTP listener is live.
   */
  private async requireDeploymentReady(deploymentName: string): Promise<void> {
    const probe = this.readinessProbe;
    if (!probe) return;

    const timeoutMs = Math.max(
      1,
      Math.round((this.config.worker.startupTimeoutSeconds ?? 10) * 1000),
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (probe(deploymentName)) return;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))),
      );
    }
    if (probe(deploymentName)) return;

    logger.warn(
      { deploymentName, timeoutMs },
      "Worker did not establish its authenticated SSE connection before the startup deadline; recycling",
    );
    try {
      await this.deleteWorkerDeployment(deploymentName);
    } catch (error) {
      logger.error(
        { deploymentName, error: getErrorMessage(error) },
        "Failed to tear down worker after startup-readiness timeout",
      );
    }
    throw new OrchestratorError(
      ErrorCode.DEPLOYMENT_CREATE_FAILED,
      `Worker ${deploymentName} did not connect within ${timeoutMs}ms`,
      { deploymentName, timeoutMs },
      true,
    );
  }

  protected getDispatcherHost(): string {
    // Match the systemd-run scope's IPAddressAllow=127.0.0.1 — IPv6 ::1
    // resolution would be blocked under the hardened scope.
    return "127.0.0.1";
  }

  /**
   * Embedded gateway is served by `@lobu/server` at the `/lobu`
   * mount on the configured PORT (default 8787). The worker needs the
   * mounted URL or it would 404 on every dispatch and provider-proxy call.
   */
  protected getDispatcherUrl(): string {
    return getInternalGatewayUrl();
  }

  private validateMessageData(
    deploymentName: string,
    messageData?: MessagePayload
  ): MessagePayload {
    if (!messageData) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "Message data is required for worker deployment",
        { deploymentName },
        true
      );
    }

    const { conversationId, channelId } = messageData;
    if (!conversationId || !channelId) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "conversationId and channelId are required in message data",
        {
          deploymentName,
          hasConversationId: !!conversationId,
          hasChannelId: !!channelId,
        },
        true
      );
    }

    return messageData;
  }

  /**
   * Sync per-agent egress judge policies into the policy store so the HTTP
   * proxy can resolve them at request time. The source is the agent's
   * `egress`-stage inline guardrails — each contributes a named judge (its
   * `policy` + optional `model`) and routes its `domains` through it.
   */
  private syncEgressPolicy(
    messageData: MessagePayload,
    deploymentName?: string
  ): string[] {
    const agentId = messageData.agentId;
    const organizationId = messageData.organizationId;
    // PolicyStore is keyed by `(orgId, agentId)` to prevent cross-tenant
    // policy clobbering — refuse to sync without an org id rather than
    // collapsing into a shared bucket.
    if (!this.policyStore || !agentId || !organizationId) {
      if (!organizationId && agentId) {
        logger.warn(
          { agentId, deploymentName },
          "Skipping egress policy sync — message has no organizationId"
        );
      }
      return [];
    }

    const egressGuardrails = (messageData.guardrailsInline ?? []).filter(
      (g) => g.stage === "egress" && g.enabled
    );
    const bundle = egressGuardrailsToPolicyBundle(egressGuardrails);
    if (bundle) {
      this.policyStore.set(organizationId, agentId, bundle);
      if (deploymentName) {
        logger.info(
          `Synced egress judge policy for ${deploymentName}: ${bundle.judgedDomains.length} rule(s), ${Object.keys(bundle.judges).length} judge(s)`
        );
      } else {
        logger.debug("Synced egress judge policy", {
          organizationId,
          agentId,
          rules: bundle.judgedDomains.length,
          judges: Object.keys(bundle.judges).length,
        });
      }
      return bundle.judgedDomains.map((r) => r.domain);
    }
    this.policyStore.clear(organizationId, agentId);
    return [];
  }

  /**
   * Sync per-agent grants (network domains + Nix cache domains +
   * pre-approved MCP tool patterns) to the grant store. Called on worker
   * create AND on every message so config changes pick up without
   * redeploying. Also refreshes the in-memory egress judge policy store,
   * which is read by the shared HTTP proxy rather than by the worker
   * process.
   *
   * Domains reconcile against Postgres UNCONDITIONALLY — the pod-local
   * cache is never trusted for them. Non-expiring domain rows are written
   * only by this sync (allow, deny, nix), so the active rows ARE the
   * previous state: rows outside the current config are revoked, expected
   * domains whose row is missing or has a flipped allow/deny flag are
   * (re-)granted. A cache-based skip is multi-replica-unsafe here (an
   * X→Y→X config sequence across two replicas leaves Y's rows active on
   * the replica whose warm cache still says X).
   *
   * MCP tool patterns stay cache-diffed: user "always" tool approvals share
   * the store and are indistinguishable from operator `preApprovedTools`,
   * so a durable reconcile would wrongly revoke them.
   */
  async syncNetworkConfigGrants(messageData: MessagePayload): Promise<void> {
    const agentId = messageData.agentId;
    if (!agentId) return;

    const judgedDomains = this.syncEgressPolicy(messageData);

    if (!this.grantStore) return;

    const orgId = messageData.organizationId;

    // ── Domains: PG-reconciled ──────────────────────────────────────────
    // pattern → denied flag, keyed in NORMALIZED form so alias spellings
    // ("*.example.com" vs ".example.com") collapse to the single grant row
    // they share. Denies are added last so a domain listed on both sides
    // collapses to deny (matching the proxy's deny precedence).
    //
    // A domain the egress judge governs is SKIPPED on the allow side — config
    // domains and Nix cache domains alike. An allow grant outranks the judge
    // in `checkDomainAccess`, so granting a judged domain makes its judge
    // permanently inert — and the dispatch payload can hold such a domain
    // without anyone having typed it into agent config, because
    // `foldConnectorTooling` unions connector `agentTooling` domains into
    // `allowedDomains` AFTER the write-time guard has run. Skipping also
    // HEALS an agent already in that state: the stale row is absent from
    // `expectedDomains`, so the reconcile below revokes it. Denies are
    // unaffected — a deny grant outranks the judge by design.
    const expectedDomains = new Map<string, boolean>();
    const expectAllowUnlessJudged = (pattern: string) => {
      if (judgedDomains.some((j) => patternReaches(j, pattern))) return;
      expectedDomains.set(pattern, false);
    };
    for (const domain of messageData.networkConfig?.allowedDomains ?? []) {
      expectAllowUnlessJudged(normalizeDomainPattern(domain));
    }
    if (
      messageData.nixConfig?.packages?.length ||
      messageData.nixConfig?.flakeUrl
    ) {
      for (const domain of NIX_CACHE_DOMAINS) {
        expectAllowUnlessJudged(domain);
      }
    }
    for (const domain of messageData.networkConfig?.deniedDomains ?? []) {
      expectedDomains.set(normalizeDomainPattern(domain), true);
    }

    const activeDomains = new Map<string, boolean>();
    for (const row of await this.grantStore.listGrants(agentId, orgId)) {
      if (row.kind !== "domain" || row.expiresAt !== null) continue;
      activeDomains.set(row.pattern, row.denied === true);
    }

    for (const [pattern, denied] of activeDomains) {
      if (expectedDomains.has(pattern)) continue;
      // Deploy-time infra ALLOW grants (npm registries for CLI backends) are
      // not derivable from the payload — exempt them. A denied row is never
      // exempt: a config-removed deny must be reconciled away or it becomes
      // unremovable (the deploy-time grant skips denied domains).
      if (!denied && NPM_REGISTRY_DOMAINS.includes(pattern)) continue;
      await this.grantStore.revoke(agentId, pattern, orgId);
    }
    for (const [pattern, denied] of expectedDomains) {
      if (activeDomains.get(pattern) !== denied) {
        await this.grantStore.grant(agentId, pattern, null, denied, orgId);
      }
    }

    // ── MCP tool patterns: cache-diffed ─────────────────────────────────
    const nextTools = new Set(messageData.preApprovedTools ?? []);
    const cacheKey = `${orgId ?? ""}|${agentId}`;
    const previousTools = this.grantSyncCache.get(cacheKey);

    for (const pattern of previousTools ?? []) {
      if (!nextTools.has(pattern)) {
        await this.grantStore.revoke(agentId, pattern, orgId);
      }
    }
    for (const pattern of nextTools) {
      if (!previousTools?.has(pattern)) {
        await this.grantStore.grant(agentId, pattern, null, undefined, orgId);
      }
    }

    // LRU touch: delete + re-insert so the agent becomes the newest key.
    this.grantSyncCache.delete(cacheKey);
    this.grantSyncCache.set(cacheKey, nextTools);

    // Evict the oldest entry if we've exceeded the cap.
    if (this.grantSyncCache.size > GRANT_SYNC_CACHE_MAX) {
      const oldest = this.grantSyncCache.keys().next().value;
      if (oldest !== undefined) {
        this.grantSyncCache.delete(oldest);
      }
    }
  }

  /**
   * Clear the grant sync cache for an agent. Call this when the agent's
   * networkConfig or preApprovedTools change (deployment teardown, config
   * reload) so the next message re-syncs grants.
   */
  invalidateGrantSyncCache(agentId: string): void {
    // Keys are `org|agent`; drop the agent's entry across every org.
    const suffix = `|${agentId}`;
    for (const key of this.grantSyncCache.keys()) {
      if (key.endsWith(suffix)) {
        this.grantSyncCache.delete(key);
      }
    }
  }

  /** Clear the entire grant sync cache. Call on whole-config reload. */
  clearAllGrantSyncCaches(): void {
    this.grantSyncCache.clear();
  }

  /**
   * Build proxy URL with deployment identification via Basic auth.
   */
  private buildProxyUrl(
    deploymentName: string,
    workerToken: string,
    dispatcherHost: string
  ): string {
    const parsedProxyPort = Number.parseInt(
      process.env.WORKER_PROXY_PORT || "8118",
      10
    );
    const proxyPort = Number.isFinite(parsedProxyPort) ? parsedProxyPort : 8118;
    return `http://${deploymentName}:${workerToken}@${dispatcherHost}:${proxyPort}`;
  }

  /**
   * Assemble the base environment variables map for a worker deployment.
   */
  private assembleBaseEnv(
    username: string,
    userId: string,
    deploymentName: string,
    workerToken: string,
    messageData: MessagePayload,
    traceId: string | undefined,
    proxyUrl: string,
    dispatcherHost: string
  ): Record<string, string> {
    const { conversationId, channelId, platformMetadata } = messageData;

    const envVars: Record<string, string> = {
      USER_ID: userId,
      USERNAME: username,
      DEPLOYMENT_NAME: deploymentName,
      CHANNEL_ID: channelId,
      ORIGINAL_MESSAGE_TS:
        (typeof platformMetadata?.originalMessageTs === "string"
          ? platformMetadata.originalMessageTs
          : "") ||
        messageData.messageId ||
        "",
      LOG_LEVEL: "info",
      WORKSPACE_DIR: "/workspace",
      CONVERSATION_ID: conversationId,
      WORKER_TOKEN: workerToken,
      DISPATCHER_URL: this.getDispatcherUrl(),
      NODE_ENV: process.env.NODE_ENV || "production",
      DEBUG: "1",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: `${dispatcherHost},gateway,localhost,127.0.0.1`,
      // Pin HOME inside the persistent workspace so per-tool caches
      // (~/.npm, ~/.cache, ~/.config, ~/.local/share) survive worker restarts
      // without leaking into the gateway host home directory.
      HOME: "/workspace",
      // Route temporary files and cache to persistent workspace storage.
      TMPDIR: "/workspace/.tmp",
      TMP: "/workspace/.tmp",
      TEMP: "/workspace/.tmp",
      XDG_CACHE_HOME: "/workspace/.cache",
    };

    if (typeof platformMetadata?.botResponseTs === "string") {
      envVars.BOT_RESPONSE_TS = platformMetadata.botResponseTs;
    }

    if (traceId) {
      envVars.TRACE_ID = traceId;
    }

    // Forward Sentry config so the worker subprocess can report provider/model
    // failures to Sentry Issues (core/sentry.ts initSentry() is DSN-gated and
    // no-ops without SENTRY_DSN). The app process owns the DSN via envFrom in
    // prod; without this forwarding the worker is entirely unmonitored.
    //
    // EGRESS: the worker reaches Sentry THROUGH the gateway proxy (HTTP_PROXY),
    // NOT directly. We deliberately do NOT add the Sentry host to NO_PROXY:
    // under Linux prod the worker runs in a systemd scope with
    // `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1/::1`, so a direct
    // connection to Sentry's public IP would be dropped by the kernel. Routing
    // via the proxy (loopback, allowed) works in both prod and dev. The proxy's
    // allowlist is widened to admit the Sentry ingest host in
    // network-allowlist.ts (loadAllowedDomains), gated on SENTRY_DSN.
    if (process.env.SENTRY_DSN) {
      envVars.SENTRY_DSN = process.env.SENTRY_DSN;
    }
    if (process.env.ENVIRONMENT) {
      envVars.ENVIRONMENT = process.env.ENVIRONMENT;
    }
    if (process.env.SENTRY_RELEASE) {
      envVars.SENTRY_RELEASE = process.env.SENTRY_RELEASE;
    }
    // APP_GIT_SHA is baked into the prod image and used as the Sentry `release`
    // fallback (core/sentry.ts) when SENTRY_RELEASE is unset.
    if (process.env.APP_GIT_SHA) {
      envVars.APP_GIT_SHA = process.env.APP_GIT_SHA;
    }

    // Add OTLP endpoint for distributed tracing
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (otlpEndpoint) {
      envVars.OTEL_EXPORTER_OTLP_ENDPOINT = otlpEndpoint;
      try {
        const otlpUrl = new URL(otlpEndpoint);
        envVars.NO_PROXY = `${envVars.NO_PROXY},${otlpUrl.hostname}`;
      } catch {
        envVars.NO_PROXY = `${envVars.NO_PROXY},tempo`;
      }
    }

    // Forward WORKER_ENV_* vars to workers with prefix stripped
    const WORKER_ENV_PREFIX = "WORKER_ENV_";
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(WORKER_ENV_PREFIX)) {
        const stripped = key.slice(WORKER_ENV_PREFIX.length);
        const value = process.env[key];
        if (stripped && value !== undefined) {
          envVars[stripped] = value;
        }
      }
    }

    // Nix config
    if (messageData.nixConfig) {
      const { flakeUrl, packages } = messageData.nixConfig;
      if (flakeUrl) envVars.NIX_FLAKE_URL = flakeUrl;
      if (packages && packages.length > 0)
        envVars.NIX_PACKAGES = packages.join(",");
      logger.debug(
        `Nix config for ${deploymentName}: flakeUrl=${flakeUrl || "none"}, packages=${packages?.length || 0}`
      );
    }

    return envVars;
  }

  /**
   * Replace secret env var values with opaque placeholders before passing to workers.
   *
   * Provider credential env vars are set to `"lobu-proxy"` — the proxy resolves
   * the real credential at request time using agentId from the URL path
   * (`/a/{agentId}`) and the provider slug.
   *
   * Non-provider secrets use UUID placeholders stored in the secret-proxy.
   *
   * `preMaterializedSecrets` contains connector-tooling values that are already
   * safe for the worker: short-lived credential leases that expire on their own.
   * The value comparison matters because an operator override with the same env
   * name is still a durable secret and must go through normal placeholder
   * injection.
   */
  private async injectSecretPlaceholders(
    envVars: Record<string, string>,
    agentId: string,
    deploymentName: string,
    context?: ProviderCredentialContext,
    preMaterializedSecrets?: Readonly<Record<string, string>>
  ): Promise<Record<string, string>> {
    // Tests that exercise deployment lifecycle without a secret store can
    // skip placeholder injection (no secrets to swap).
    if (!this.secretStore) return envVars;
    const secretStore = this.secretStore;

    // Collect credential env var names from all providers
    const providerCredentialVars = new Set<string>();
    for (const provider of this.providerModules) {
      providerCredentialVars.add(provider.getCredentialEnvVarName());
    }

    let hasSecrets = false;
    const workerToken = envVars.WORKER_TOKEN;
    for (const [key, value] of Object.entries(envVars)) {
      if (!value || !isSecretEnvVar(key, this.providerModules)) continue;
      if (key === "WORKER_TOKEN") continue;
      if (preMaterializedSecrets?.[key] === value) continue;
      // Some providers (e.g. Bedrock) authenticate workers by JWT and
      // legitimately put the worker's own WORKER_TOKEN into the credential
      // env var — the gateway verifies it on the incoming request. In that
      // case we must not swap the value for a placeholder; the worker needs
      // the real JWT to call the gateway route.
      if (workerToken && value === workerToken) continue;

      if (providerCredentialVars.has(key)) {
        // Provider credentials use a proxy placeholder. The worker never
        // sees real credentials. The proxy resolves the real credential
        // using agentId from the URL path (/a/{agentId}) and the provider
        // slug, then overrides the Authorization header before forwarding.
        const ownerProvider = this.providerModules.find(
          (p) => p.getCredentialEnvVarName() === key
        );
        if (ownerProvider?.buildCredentialPlaceholder) {
          envVars[key] = await ownerProvider.buildCredentialPlaceholder(
            agentId,
            context
          );
        } else {
          envVars[key] = "lobu-proxy";
        }
        hasSecrets = true;
      } else {
        // Custom env var secrets (non-provider): move the value into the
        // secret store and hand the worker an opaque UUID placeholder.
        try {
          const secretRef = await persistSecretValue(
            secretStore,
            `deployments/${deploymentName}/${agentId}/${key}`,
            value,
            { ttlSeconds: SECRET_PLACEHOLDER_TTL_SECONDS }
          );
          if (!secretRef) continue;
          const placeholder = generatePlaceholder(
            agentId,
            key,
            secretRef,
            deploymentName,
            {
              ttlSeconds: SECRET_PLACEHOLDER_TTL_SECONDS,
              organizationId: context?.organizationId,
            }
          );
          envVars[key] = placeholder;
          hasSecrets = true;
        } catch (error) {
          logger.warn(`Failed to generate placeholder for ${key}:`, error);
        }
      }
    }

    if (hasSecrets) {
      logger.info(
        `🔐 Generated secret placeholders for ${deploymentName}, routing through proxy`
      );
    }

    return envVars;
  }

  /**
   * Resolve what the org's connections contribute to this agent's sandbox.
   *
   * Infrastructure failures propagate. The fingerprint becomes durable
   * dispatch state: treating a failed DB lookup as "no contribution" would
   * build an untracked worker that the claim-side gate then mistakes for fresh.
   * Malformed declarations and provider mint failures still resolve as an
   * absent contribution/credential inside the resolver.
   *
   * A payload with no agent/org is not such a failure — connections are scoped
   * by org, so with no org there are provably zero contributing rows and the
   * empty contribution (zero-row fingerprint included) is the *known* answer,
   * identical to what the enqueue-side stamp digests. The deployment stays
   * tracked, so the dispatch gate still compares a real fingerprint instead of
   * mistaking an untracked worker for fresh.
   */
  private async resolveConnectorAgentTooling(
    messageData: MessagePayload,
    deploymentName: string
  ): Promise<ResolvedAgentTooling> {
    const { agentId, organizationId } = messageData;
    if (!agentId || !organizationId) return EMPTY_AGENT_TOOLING;
    return resolveAgentTooling({
      agentId,
      organizationId,
      deploymentName,
      // No registry wired (tests, or a gateway with no lease providers) still
      // contributes packages and domains — an empty registry mints nothing,
      // so lease vars are simply absent rather than the whole contribution.
      leaseRegistry: this.leaseRegistry ?? EMPTY_LEASE_REGISTRY,
      runId: messageData.runId,
    });
  }

  /**
   * Generate environment variables common to all deployment types.
   * Orchestrates the focused helpers above.
   */
  protected async generateEnvironmentVariables(
    username: string,
    userId: string,
    deploymentName: string,
    messageData?: MessagePayload,
    includeSecrets: boolean = true
  ): Promise<Record<string, string>> {
    const validated = this.validateMessageData(deploymentName, messageData);
    const { conversationId, channelId, platformMetadata, agentId, platform } =
      validated;
    const teamId =
      validated.teamId ||
      (typeof platformMetadata?.teamId === "string"
        ? platformMetadata.teamId
        : undefined);
    const traceId = extractTraceId(validated);
    const providerContext: ProviderCredentialContext = {
      userId,
      conversationId,
      channelId,
      deploymentName,
      platform,
      connectionId:
        typeof platformMetadata?.connectionId === "string"
          ? platformMetadata.connectionId
          : undefined,
      organizationId: validated.organizationId,
    };

    // Resolve THIS CONVERSATION's pinned runtime provider (frozen on its first
    // turn) for the deployment token claim, so the generic runtime route picks
    // the provider. Reading the pin (not the agent's current env) is what makes
    // an agent repoint never move an existing conversation's sandbox. Undefined →
    // local just-bash.
    const runtimeSelection =
      agentId && validated.organizationId
        ? await resolvePinnedSelection({
            organizationId: validated.organizationId,
            agentId,
            platform,
            conversationId,
          })
        : {};

    const dispatcherHost = this.getDispatcherHost();

    // Connector-contributed agent tooling: an active connection whose connector
    // declares `agentTooling` puts its CLI on PATH, its credential in the env,
    // and its hosts on the egress allowlist. Resolved BEFORE the grant sync and
    // folded into `networkConfig.allowedDomains` — that sync reconciles domains
    // against Postgres and revokes anything outside the expected set, so a
    // domain granted after it would be revoked on the very next message.
    const agentTooling = await this.resolveConnectorAgentTooling(
      validated,
      deploymentName
    );
    if (agentTooling.domains.length > 0) {
      validated.networkConfig = {
        ...validated.networkConfig,
        allowedDomains: [
          ...new Set([
            ...(validated.networkConfig?.allowedDomains ?? []),
            ...agentTooling.domains,
          ]),
        ],
      };
    }
    if (agentTooling.packages.length > 0) {
      // Union, never replace: the agent's own packages and connector-contributed
      // packages are hard requirements of code that will run in the same
      // sandbox.
      validated.nixConfig = {
        ...validated.nixConfig,
        packages: [
          ...new Set([
            ...(validated.nixConfig?.packages ?? []),
            ...agentTooling.packages,
          ]),
        ],
      };
    }

    const deploymentTokenArgs = {
      userId,
      conversationId,
      deploymentName,
      channelId,
      teamId,
      platform,
      agentId,
      organizationId: validated.organizationId,
      platformMetadata,
      traceId,
      runtimeProviderId: runtimeSelection.runtimeProviderId,
      sandboxId: runtimeSelection.sandboxId,
      // Same allowlist synced to the grant store / JUST_BASH_ALLOWED_DOMAINS — so
      // the runtime route reads it off the signed token, not the worker's body.
      allowedDomains: validated.networkConfig?.allowedDomains,
      deniedDomains: validated.networkConfig?.deniedDomains,
      // Same package union the local nix-shell spawn uses below — signed here so
      // a REMOTE runtime provisions the same set instead of running without it.
      nixPackages: validated.nixConfig?.packages,
    };
    const { workerToken, egressProxyToken } =
      buildDeploymentTokenPair(deploymentTokenArgs);
    // Agent subprocesses can read HTTP_PROXY. Give the proxy a separately
    // typed credential that carries the same egress-policy claims but is
    // rejected by every worker-facing gateway auth path.

    // Sync network domains (allow + deny + nix caches), pre-approved MCP
    // tool patterns, and the egress judge policy — single-sourced with the
    // per-message refresh path so create and update can never diverge.
    await this.syncNetworkConfigGrants(validated);

    const proxyUrl = this.buildProxyUrl(
      deploymentName,
      egressProxyToken,
      dispatcherHost
    );

    let envVars = this.assembleBaseEnv(
      username,
      userId,
      deploymentName,
      workerToken,
      validated,
      traceId,
      proxyUrl,
      dispatcherHost
    );

    // Connector-contributed credentials. Set before the module/config layers so
    // an operator-configured value for the same name still wins — an explicit
    // override must beat an implicit contribution.
    //
    // The reserved-name check is defense in depth: the resolver already drops
    // these, but this merge writes over an ALREADY-BUILT base env, so a name
    // that slipped through would replace gateway-owned runtime state
    // (WORKER_TOKEN, the proxy vars, PATH…) rather than merely add to it.
    for (const [key, value] of Object.entries(agentTooling.env)) {
      if (isReservedAgentToolingEnvName(key)) {
        logger.error(
          { agentId, deploymentName, env_name: key },
          "Refusing to overwrite a reserved worker env var with connector-contributed tooling"
        );
        delete agentTooling.env[key];
        continue;
      }
      envVars[key] = value;
    }

    // Remember when this deployment's credential dies. A worker reads its env
    // once at process start, so the only way to hand it a fresh token is to
    // recycle it — `hasExpiringLease` lets the dispatch gate do that on the
    // turn BEFORE the credential lapses instead of serving a sandbox whose
    // `gh` has started 401ing.
    if (agentTooling.leaseExpiresAt) {
      this.leaseExpiryByDeployment.set(
        deploymentName,
        agentTooling.leaseExpiresAt
      );
      this.leaseMintedAtByDeployment.set(deploymentName, new Date());
    } else {
      this.leaseExpiryByDeployment.delete(deploymentName);
      this.leaseMintedAtByDeployment.delete(deploymentName);
    }
    // Remember WHICH connections built this sandbox, so a later turn can tell
    // that one was added, removed, or repointed at a different installation.
    this.toolingFingerprintByDeployment.set(
      deploymentName,
      agentTooling.fingerprint
    );

    // Include host-provided secret references when requested.
    if (includeSecrets && this.moduleEnvVarsBuilder) {
      try {
        envVars = await this.moduleEnvVarsBuilder(
          agentId,
          envVars,
          providerContext
        );
      } catch (error) {
        logger.warn("Failed to build module environment variables:", error);
      }
    }

    // Add worker environment variables from configuration
    if (this.config.worker.env) {
      for (const [key, value] of Object.entries(this.config.worker.env)) {
        envVars[key] = String(value);
      }
    }

    // EXACT-MODEL GATE + module resolution (defense-in-depth backstop for the
    // COLD path — the authoritative gate is at enqueue time in the message
    // consumer, which the warm path also passes). Use the SHARED
    // `resolveDispatchModel` so this backstop agrees with the enqueue gate and
    // session-context on the effective (allow-listed, non-sentinel, ROUTABLE)
    // model. A sentinel-only / nothing-routable list yields undefined → fail
    // closed. Modules come from the same policy resolution.
    const requestedModel = validated.agentOptions?.model as string | undefined;
    let effectiveProviders: ModelProviderModule[];
    let allowedRefs: string[] | null = null;
    let agentModel: string | undefined = requestedModel;
    if (this.providerCatalogService) {
      const resolved = await this.providerCatalogService.resolveDispatchModel(
        agentId,
        validated.organizationId,
        requestedModel,
        userId
      );
      effectiveProviders = resolved.modules;
      allowedRefs = resolved.allowedRefs;
      agentModel = resolved.model;
      if (resolved.replaced && validated.agentOptions) {
        logger.warn(
          {
            agentId,
            organizationId: validated.organizationId,
            requestedModel,
            allowedRefs,
            effectiveModel: agentModel ?? null,
          },
          "Deployment backstop: requested model not routable under the agent's models list — enforcing fail-closed gate"
        );
        if (agentModel) validated.agentOptions.model = agentModel;
        else delete validated.agentOptions.model;
      }
    } else {
      effectiveProviders = this.providerModules;
    }

    for (const provider of effectiveProviders) {
      envVars = provider.injectSystemKeyFallback(envVars);
    }

    envVars = await this.injectSecretPlaceholders(
      envVars,
      agentId,
      deploymentName,
      providerContext,
      agentTooling.env
    );

    // Inject provider metadata into agentOptions so the worker can configure
    // the SDK generically without hardcoded provider checks.
    // Determine primary provider from the (now gate-checked) model.
    let primaryProvider: ModelProviderModule | undefined;

    if (
      agentModel &&
      effectiveProviders.length > 0 &&
      this.providerCatalogService
    ) {
      primaryProvider = await this.providerCatalogService.findProviderForModel(
        agentModel,
        effectiveProviders
      );
    }

    // When no explicit model is set (auto mode), detect the primary provider
    // from installed providers order (first with credentials = primary).
    if (!primaryProvider && effectiveProviders.length > 0) {
      for (const candidate of effectiveProviders) {
        if (
          candidate.hasSystemKey() ||
          (await candidate.hasCredentials(agentId, providerContext))
        ) {
          primaryProvider = candidate;
          break;
        }
      }
    }

    if (primaryProvider) {
      logger.info(
        {
          agentId,
          primaryProviderId: primaryProvider.providerId,
          slug: primaryProvider.getUpstreamConfig?.()?.slug,
        },
        "Selected primary provider"
      );

      const proxyBaseUrl = `${this.getDispatcherUrl()}/api/proxy`;
      const mappings = primaryProvider.getProxyBaseUrlMappings(
        proxyBaseUrl,
        agentId,
        providerContext
      );
      const providerBaseUrl = Object.values(mappings)[0];
      if (providerBaseUrl) {
        validated.agentOptions = {
          ...validated.agentOptions,
          providerBaseUrl,
        };
      }

      // The default provider and per-provider credential placeholders are
      // delivered dynamically via the session context endpoint instead of
      // static process environment.
    }

    // Build full provider base URL mappings for all installed providers
    const proxyBaseUrl = `${this.getDispatcherUrl()}/api/proxy`;
    const perProvider = effectiveProviders.map((provider) => ({
      providerId: provider.providerId,
      mappings: provider.getProxyBaseUrlMappings(
        proxyBaseUrl,
        agentId,
        providerContext
      ),
    }));
    // Guard against two providers claiming the same base-URL env key with
    // different values: the later one silently clobbers the earlier and
    // mis-routes (this is exactly how an `openai/<model>` call once egressed to
    // the codex backend). Surface it loudly instead of hiding it.
    for (const c of detectProviderBaseUrlCollisions(perProvider)) {
      logger.warn(
        { agentId, ...c },
        "[deployment-manager] provider base-URL env key collision — two providers map the same key to different URLs; the later one wins and may mis-route. Each provider must use a distinct baseUrlEnvVarName."
      );
    }
    const providerBaseUrlMappings: Record<string, string> = {};
    for (const { mappings } of perProvider) {
      Object.assign(providerBaseUrlMappings, mappings);
    }
    if (Object.keys(providerBaseUrlMappings).length > 0) {
      validated.agentOptions = {
        ...validated.agentOptions,
        providerBaseUrlMappings,
      };
    }

    // CLI_BACKENDS is now delivered dynamically via session context.
    // Still need to auto-add npm registry domains for npx at deploy time.
    const hasCliBackendProviders = effectiveProviders.some((p) =>
      p.getCliBackendConfig?.()
    );
    if (hasCliBackendProviders && this.grantStore && agentId) {
      const orgId = validated.organizationId;
      for (const domain of NPM_REGISTRY_DOMAINS) {
        // An explicit deny (config deniedDomains) wins over the infra
        // convenience grant — the upsert would otherwise flip the row to
        // allowed and the warm sync cache would never restore the deny.
        if (await this.grantStore.isDenied(agentId, domain, orgId)) continue;
        await this.grantStore.grant(agentId, domain, null, undefined, orgId);
      }
      logger.info(
        `Added npm registry domains as grants for ${deploymentName}: ${NPM_REGISTRY_DOMAINS.join(", ")}`
      );
    }

    return envVars;
  }

  /**
   * Delete a worker deployment and associated resources
   */
  async deleteWorkerDeployment(deploymentName: string): Promise<void> {
    try {
      // Clean up secret placeholder mappings
      deleteSecretMappings(deploymentName);

      // Cascade-delete the underlying non-provider secrets written by
      // `injectSecretPlaceholders` under `deployments/{deploymentName}/`.
      // Without this, the placeholder mappings are gone but the backing
      // secret entries linger until their TTL expires (and AWS SM
      // entries would leak forever).
      if (this.secretStore) {
        try {
          const cleared = await deleteSecretsByPrefix(
            this.secretStore,
            `deployments/${deploymentName}/`
          );
          if (cleared > 0) {
            logger.debug(
              `Cleared ${cleared} deployment secret(s) for ${deploymentName}`
            );
          }
        } catch (error) {
          logger.warn(
            `Failed to clear deployment secrets for ${deploymentName}:`,
            error
          );
        }
      }

      await this.deleteDeployment(deploymentName);
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_DELETE_FAILED,
        `Failed to delete deployment for ${deploymentName}: ${getErrorMessage(error)}`,
        { deploymentName, error },
        true
      );
    }
  }

  /**
   * Reconcile deployments: unified method for cleanup and resource management.
   */
  async reconcileDeployments(): Promise<void> {
    try {
      const maxDeployments = this.config.worker.maxDeployments;

      logger.debug("Running deployment cleanup...");

      // Get all worker deployments from the backend
      const activeDeployments = await this.listDeployments();

      if (activeDeployments.length === 0) {
        return;
      }

      // Sort deployments by last activity (oldest first)
      const sortedDeployments = [...activeDeployments].sort(
        (a, b) => a.lastActivity.getTime() - b.lastActivity.getTime()
      );

      let processedCount = 0;
      const BATCH_SIZE = 10; // Process up to 10 deletions in parallel

      // Collect actions to perform
      const toDelete: string[] = [];
      const toScaleDown: string[] = [];

      for (const analysis of sortedDeployments) {
        const { deploymentName, replicas, isIdle, isVeryOld } = analysis;

        if (isVeryOld) {
          toDelete.push(deploymentName);
        } else if (isIdle && replicas > 0) {
          toScaleDown.push(deploymentName);
        }
      }

      // Check if we exceed max deployments
      const remainingDeployments = sortedDeployments.filter(
        (d) => !d.isVeryOld
      );
      if (remainingDeployments.length > maxDeployments) {
        const excessCount = remainingDeployments.length - maxDeployments;
        const deploymentsToDelete = remainingDeployments.slice(0, excessCount);
        for (const { deploymentName } of deploymentsToDelete) {
          if (!toDelete.includes(deploymentName)) {
            toDelete.push(deploymentName);
          }
        }
      }

      // Process deletions in parallel batches
      processedCount += await runInBatches(
        toDelete,
        BATCH_SIZE,
        (name) => this.deleteWorkerDeployment(name),
        (name, reason) => {
          logger.error(`❌ Failed to delete deployment ${name}:`, reason);
        }
      );

      // Process scale-downs in parallel batches
      processedCount += await runInBatches(
        toScaleDown,
        BATCH_SIZE,
        (name) => this.scaleDeployment(name, 0),
        (name, reason) => {
          logger.error(`❌ Failed to scale down deployment ${name}:`, reason);
        }
      );

      if (processedCount > 0) {
        logger.info(
          `✅ Cleanup completed: processed ${processedCount} deployment(s)`
        );
      }
    } catch (error) {
      logger.error(
        "Error during deployment reconciliation:",
        getErrorMessage(error)
      );
    }
  }

  async scaleDeployment(
    deploymentName: string,
    replicas: number
  ): Promise<void> {
    const entry = this.workers.get(deploymentName);

    if (replicas === 0 && entry) {
      this.workers.delete(deploymentName);
      logger.info(`Stopped embedded worker ${deploymentName}`);
    } else if (replicas === 1 && entry) {
      // A live child is not necessarily a usable worker. Every scale-up path
      // (new message, lock handoff, warm resume) must wait for its authenticated
      // SSE registration or recycle it so the caller can create a fresh child.
      await this.requireDeploymentReady(deploymentName);
    } else if (replicas === 1 && !entry) {
      // The worker process is gone (crashed, or exited between a stale
      // listDeployments() snapshot and this call). Throwing here lets the
      // MessageConsumer's catch path re-create the deployment so the message
      // already queued for it actually gets drained — silently no-op'ing would
      // strand that message forever (no worker, no error, no retry).
      throw new Error(
        `Embedded worker ${deploymentName} is not running — must re-create`
      );
    }
  }

  async deleteDeployment(deploymentName: string): Promise<void> {
    this.forgetDeploymentTooling(deploymentName);
    const entry = this.workers.get(deploymentName);
    if (entry) {
      this.workers.delete(deploymentName);
      // Wait for the exit handler's conversation-lock release to COMPLETE, not
      // just start. A recycle re-creates this deployment immediately under the
      // same name; if the session-level advisory lock were still held by the
      // old child's reserved connection, the create would read its own
      // teardown as "conversation owned elsewhere" and silently drop the
      // spawn.
      await this.conversationLockReleases.get(deploymentName);
      logger.info(`Stopped embedded worker: ${deploymentName}`);
    }
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    const now = Date.now();
    const idleThresholdMinutes = this.config.worker.idleCleanupMinutes;
    const veryOldDays = this.config.cleanup?.veryOldDays ?? 7;

    const results: DeploymentInfo[] = [];
    for (const [deploymentName, entry] of this.workers) {
      results.push(
        buildDeploymentInfoSummary({
          deploymentName,
          lastActivity: entry.lastActivity,
          now,
          idleThresholdMinutes,
          veryOldDays,
          replicas: 1,
        })
      );
    }
    return results;
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    const entry = this.workers.get(deploymentName);
    if (entry) {
      entry.lastActivity = new Date();
    }
  }

}
