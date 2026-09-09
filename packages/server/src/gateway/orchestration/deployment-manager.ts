import {
	createLogger,
	type MessagePayload,
	normalizeDomainPattern,
} from "@lobu/core";
import type { ModelProviderModule } from "../modules/module-system.js";
import type { GrantStore } from "../permissions/grant-store.js";
import { patternReaches } from "@lobu/connector-sdk/egress-policy";
import {
  egressGuardrailsToPolicyBundle,
  type PolicyStore,
} from "../permissions/policy-store.js";
import type { WritableSecretStore } from "../secrets/index.js";
import type { CredentialLeaseRegistry } from "../agent-tooling/credential-lease.js";
import { resolveAgentToolingDeclaration } from "../agent-tooling/resolver.js";
import { getInternalGatewayUrl } from "../config/index.js";

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
 * Maximum number of agents tracked in the grant-sync LRU. Oldest entry is
 * evicted when the cache grows past this bound, which prevents unbounded
 * memory growth for long-running gateways that see a large agent churn.
 */
const GRANT_SYNC_CACHE_MAX = 1000;

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
 * npm registry hosts an operator may have granted out of band. Not derivable
 * from the message payload, so the domain reconcile must never revoke them.
 */
const NPM_REGISTRY_DOMAINS = ["registry.npmjs.org", "registry.npmmirror.com"];

/** Pod-local probe for the worker's authenticated SSE registration. */

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
 * Per-agent gateway state for the isolate lane: mints the signed worker token
 * pair, syncs per-agent egress grants and judge policies into the stores the
 * HTTP proxy reads at request time, and tracks the connector-tooling
 * fingerprint that decides whether a warm worker must be recycled.
 *
 * It no longer runs workers. A turn is claimed over HTTP by a worker the
 * gateway never spawns, so the deployment-lifecycle methods are no-ops kept
 * for their remaining callers (see the group at the bottom of the class).
 */
export class DeploymentManager {
  protected config: OrchestratorConfig;
  protected providerModules: ModelProviderModule[];
  protected providerCatalogService?: import("../auth/provider-catalog.js").ProviderCatalogService;
  /**
   * Set by `setSecretStore` during `Orchestrator.injectCoreServices`.
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

  constructor(
    config: OrchestratorConfig,
    providerModules: ModelProviderModule[] = []
  ) {
    this.config = config;
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
   * Deployment lifecycle is a no-op in the isolate lane: a turn is claimed
   * over HTTP by a worker the gateway never spawns, so there is no child
   * process to track, scale down, or reap. These stay because the shutdown
   * drain (`orchestration/index.ts`) and `worker-gateway` still call them,
   * and "nothing running" is the correct answer.
   */
  async reconcileDeployments(): Promise<void> {}

  async deleteDeployment(deploymentName: string): Promise<void> {
    this.forgetDeploymentTooling(deploymentName);
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    return [];
  }

  async updateDeploymentActivity(_deploymentName: string): Promise<void> {}
}
