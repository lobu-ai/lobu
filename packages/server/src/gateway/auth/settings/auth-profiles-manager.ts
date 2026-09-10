import {
	type AuthProfile,
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import { orgContext, tryGetOrgId } from "../../../lobu/stores/org-context.js";
import type {
  ProviderCredentialContext,
  RuntimeProviderCredentialResolver,
} from "../../embedded.js";
import type { WritableSecretStore } from "../../secrets/index.js";
import type { DeclaredAgentRegistry } from "../../services/declared-agent-registry.js";
import type { EphemeralAuthProfileRegistry } from "./agent-settings-store.js";
import {
  orgBucketAgentId,
  REFRESHABLE_AUTH_TYPES,
  type UserAuthProfileStore,
} from "./user-auth-profile-store.js";

const logger = createLogger("auth-profiles-manager");

const ANY_MODEL_SCOPE = "*";

// Gateway-local provenance travels with the resolved object, never in JSON or
// worker credentials. Refresh must target the persisted owner/bucket row, not
// the synthetic principal that is executing the Automation.
const PROFILE_SOURCE = Symbol("auth-profile-source");
type ProfileSource = {
  userId: string;
  agentId: string;
  organizationId?: string;
};
type SourcedAuthProfile = AuthProfile & {
  [PROFILE_SOURCE]?: ProfileSource;
};

/** The storage row a resolved profile was read from, if any. Merged ephemeral
 *  and declared profiles have no row and so are never refresh targets. */
function profileSource(profile: AuthProfile): ProfileSource | undefined {
  return (profile as SourcedAuthProfile)[PROFILE_SOURCE];
}

/** Refresh tokens that expire within this window from now. */
const LAZY_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Hooks the AuthProfilesManager calls when a profile read encounters a token
 * that's near or past expiry. Wired by boot after the TaskScheduler is up;
 * before that point, lazy refresh is a no-op and the periodic safety-net task
 * handles everything.
 */
interface LazyRefreshHooks {
  /** Fire-and-forget — used when the token is still valid but expiring soon.
   *  Implementation should dedup across pods (idempotency-keyed scheduler spawn). */
  triggerAsync: (userId: string, agentId: string) => Promise<void>;
  /** Inline refresh — used when the token is already expired and the caller
   *  is about to use it. Awaits completion. Per-pod dedup expected. */
  refreshNow: (userId: string, agentId: string) => Promise<void>;
}

interface UpsertAuthProfileInput {
  agentId: string;
  /** Owning user. Required for persistent writes. */
  userId?: string;
  provider: string;
  credential?: string;
  credentialRef?: string;
  authType: AuthProfile["authType"];
  label: string;
  model?: string;
  metadata?: AuthProfile["metadata"];
  makePrimary?: boolean;
  id?: string;
  /**
   * Set ONLY for org-bucket writes (`agentId = "__org_oauth__:<orgId>"`), which
   * have no `agents` row to derive the org from. Threads into the
   * `user_auth_profiles.organization_id` column so the token-refresh scan keeps
   * these profiles alive. Omit for ordinary per-agent writes (column stays NULL,
   * org derived via the agents join).
   */
  organizationId?: string;
}

interface AuthProfilesManagerOptions {
  ephemeralProfiles: EphemeralAuthProfileRegistry;
  declaredAgents: DeclaredAgentRegistry;
  userAuthProfiles: UserAuthProfileStore;
  secretStore: WritableSecretStore;
  runtimeCredentialResolver?: RuntimeProviderCredentialResolver;
  /**
   * Resolve an agent's owning user id. Agent runs execute as a synthetic /
   * platform user (web panel, Telegram, automation), not the operator who
   * connected a provider in the agent settings UI — so credential lookups
   * fall back to the owner's user-scoped profiles via this resolver.
   */
  agentOwnerResolver?: (agentId: string) => Promise<string | undefined>;
  /**
   * Resolve an agent's organization id. Credentials are stored in the
   * org-partitioned secret store (`PostgresSecretStore`, keyed by
   * AsyncLocalStorage org context). Agent runs triggered by a chat-platform
   * webhook reach this manager with no org context established (the webhook
   * route has no `:orgSlug`), so without this resolver the credential-ref read
   * falls back to the global partition and misses the org-scoped value. When
   * no org context is set, `listProfiles` wraps the read in this agent's org.
   */
  agentOrgResolver?: (agentId: string) => Promise<string | undefined>;
}

/**
 * Resolve and write auth profiles by merging three sources:
 *
 * 1. **Runtime resolver** — SDK host can plug in a synchronous credential
 *    resolver that wins over everything else (ProviderCredentialContext).
 * 2. **User-scoped profiles** — durable per-user profiles keyed by
 *    `(userId, agentId)` in `UserAuthProfileStore`.
 * 3. **Declared credentials** — read-only credentials shipped with the
 *    agent's declared config (lobu.config.ts / SDK GatewayConfig.agents),
 *    surfaced via `DeclaredAgentRegistry`.
 *
 * Callers pass `ProviderCredentialContext.userId` when they have one
 * (worker proxy, OAuth route, agent-config route). The agent-owner fallback
 * comes from `agentOwnerResolver` (the agent's own `agents` row), so it
 * resolves even when the requesting principal is synthetic or absent.
 */
export class AuthProfilesManager {
  private readonly ephemeralProfiles: EphemeralAuthProfileRegistry;
  private readonly declaredAgents: DeclaredAgentRegistry;
  private readonly userAuthProfiles: UserAuthProfileStore;
  private readonly secretStore: WritableSecretStore;
  private readonly runtimeCredentialResolver?: RuntimeProviderCredentialResolver;
  private readonly agentOwnerResolver?: (
    agentId: string
  ) => Promise<string | undefined>;
  private readonly agentOrgResolver?: (
    agentId: string
  ) => Promise<string | undefined>;
  /** Short-lived `(orgId, agentId) → ownerUserId` cache — owner lookups happen
   *  on the credential hot path (per proxy request), the owner rarely changes.
   *  Keyed by org too because the `agents` PK is `(organization_id, id)`. */
  private readonly agentOwnerCache = new Map<
    string,
    { ownerUserId: string | undefined; expiresAt: number }
  >();
  /** Short-lived `agentId → organizationId` cache — same hot path as the owner
   *  cache; an agent doesn't change org. */
  private readonly agentOrgCache = new Map<
    string,
    { organizationId: string | undefined; expiresAt: number }
  >();
  private static readonly AGENT_OWNER_CACHE_TTL_MS = 60_000;
  private static readonly AGENT_ORG_CACHE_TTL_MS = 60_000;
  /** Hard cap on either cache to bound retention if many distinct agents are
   *  looked up but never re-queried. When set() crosses this, the oldest
   *  insertion is evicted (Maps iterate in insertion order). */
  private static readonly AGENT_CACHE_MAX_ENTRIES = 1024;
  private cacheSet<V>(cache: Map<string, V>, key: string, value: V): void {
    if (cache.size >= AuthProfilesManager.AGENT_CACHE_MAX_ENTRIES && !cache.has(key)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }
  private lazyRefreshHooks?: LazyRefreshHooks;

  constructor(options: AuthProfilesManagerOptions) {
    this.ephemeralProfiles = options.ephemeralProfiles;
    this.declaredAgents = options.declaredAgents;
    this.userAuthProfiles = options.userAuthProfiles;
    this.secretStore = options.secretStore;
    this.runtimeCredentialResolver = options.runtimeCredentialResolver;
    this.agentOwnerResolver = options.agentOwnerResolver;
    this.agentOrgResolver = options.agentOrgResolver;
  }

  /** Wired by boot after TaskScheduler is up. Until then, lazy refresh is a
   *  no-op (the periodic safety-net handles everything). */
  setLazyRefreshHooks(hooks: LazyRefreshHooks): void {
    this.lazyRefreshHooks = hooks;
  }

  /**
   * Returns a credential guaranteed valid right now for the given profile.
   * Three paths:
   *  - Token has > 5min until expiry, or the profile carries no rotatable
   *    refresh grant (`REFRESHABLE_AUTH_TYPES`): returns `profile.credential`
   *    immediately (fast path).
   *  - Token expires within 5min but is still valid: fires a fire-and-forget
   *    refresh task (idempotency-keyed) and returns the current credential
   *    (still valid for the buffer window).
   *  - Token has already expired: blocks on inline refresh, re-reads the
   *    profile, returns the new credential.
   *
   * If LazyRefreshHooks aren't wired (boot order, tests), returns
   * `profile.credential` unchanged — periodic safety-net catches it later.
   *
   * Refresh targets the row the profile was READ from, not `ctx`. Under the
   * agent-owner fallback `ctx` is the synthetic run principal, which owns no
   * stored profile and so has nothing to refresh.
   */
  async ensureFreshCredential(
    profile: AuthProfile,
    ctx: { userId: string; agentId: string },
  ): Promise<string | undefined> {
    const credential = profile.credential;
    if (!credential) return credential;
    if (!REFRESHABLE_AUTH_TYPES.has(profile.authType)) return credential;
    if (!this.lazyRefreshHooks) return credential;

    const expiresAt = profile.metadata?.expiresAt ?? 0;
    if (!expiresAt) return credential; // no expiry tracked

    const now = Date.now();
    if (expiresAt > now + LAZY_REFRESH_BUFFER_MS) return credential;

    const source = profileSource(profile);
    // The refresh job rewrites the stored row and the re-read below resolves
    // secret refs, both through the org-partitioned secret store. Callers hand
    // us a profile after the org scope that produced it has unwound, so
    // re-enter that partition instead of the caller's ambient scope. Placed
    // after the fast-path returns above so the common per-request read never
    // pays for an extra AsyncLocalStorage scope.
    if (source?.organizationId && tryGetOrgId() !== source.organizationId) {
      return orgContext.run({ organizationId: source.organizationId }, () =>
        this.ensureFreshCredential(profile, ctx)
      );
    }
    const refreshContext = source ?? ctx;

    if (expiresAt > now) {
      // Soon-expiring: fire async, return current credential.
      this.lazyRefreshHooks
        .triggerAsync(refreshContext.userId, refreshContext.agentId)
        .catch((err) =>
          logger.warn(
            {
              err,
              profileId: profile.id,
              userId: refreshContext.userId,
              agentId: refreshContext.agentId,
            },
            "[lazy-refresh] async trigger failed; periodic task will retry",
          ),
        );
      return credential;
    }

    // Already expired: inline refresh + re-read.
    try {
      await this.lazyRefreshHooks.refreshNow(
        refreshContext.userId,
        refreshContext.agentId
      );
      const rows = source
        ? await this.listStoredProfiles(source.userId, source.agentId)
        : await this.getProviderProfiles(
            ctx.agentId,
            profile.provider,
            ctx.userId
          );
      const row = rows.find((p) => p.id === profile.id);
      if (!row) return credential;
      // `listStoredProfiles` hands back stored rows; only the
      // `getProviderProfiles` path has already resolved credential refs.
      const fresh = source ? await this.resolveProfile(row) : row;
      return fresh.credential ?? credential;
    } catch (err) {
      logger.error(
        {
          err,
          profileId: profile.id,
          userId: refreshContext.userId,
          agentId: refreshContext.agentId,
        },
        "[lazy-refresh] inline refresh failed; returning stale credential",
      );
      return credential;
    }
  }

  getDeclaredAgents(): DeclaredAgentRegistry {
    return this.declaredAgents;
  }

  getUserAuthProfileStore(): UserAuthProfileStore {
    return this.userAuthProfiles;
  }

  /**
   * Return every profile known for `(agentId, userId?)`, with secret refs
   * resolved to plaintext. Intended for admin/agent-config surfaces.
   *
   * Order:
   *   1. requesting user's user-scoped profiles (most authoritative)
   *   2. agent owner's user-scoped profiles (run-time fallback)
   *   3. ephemeral profiles registered by SDK host
   *   4. declared credentials from registry (synthesized as `api-key`)
   */
  /** User-scoped profiles owned by the agent's owner (empty when the owner is
   *  the requesting user or no owner resolver is wired). */
  private async resolveAgentOwnerUserId(
    agentId: string
  ): Promise<string | undefined> {
    if (!this.agentOwnerResolver) return undefined;
    // The resolver reads `agents` behind a cross-tenant guard that returns null
    // without org context, so the answer is per (org, agent) — an agentId-only
    // key would let one scope's miss serve another's hit for the TTL.
    const cacheKey = JSON.stringify([tryGetOrgId(), agentId]);
    const cached = this.agentOwnerCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.ownerUserId;
    let ownerUserId: string | undefined;
    try {
      ownerUserId = await this.agentOwnerResolver(agentId);
    } catch (error) {
      logger.warn(
        {
          agentId,
          error: getErrorMessage(error),
        },
        "agent owner resolver failed; skipping owner credential fallback"
      );
      return undefined;
    }
    this.cacheSet(this.agentOwnerCache, cacheKey, {
      ownerUserId,
      expiresAt: Date.now() + AuthProfilesManager.AGENT_OWNER_CACHE_TTL_MS,
    });
    return ownerUserId;
  }

  private async resolveAgentOrgId(
    agentId: string
  ): Promise<string | undefined> {
    if (!this.agentOrgResolver) return undefined;
    const cached = this.agentOrgCache.get(agentId);
    if (cached && cached.expiresAt > Date.now()) return cached.organizationId;
    let organizationId: string | undefined;
    try {
      organizationId = await this.agentOrgResolver(agentId);
    } catch (error) {
      logger.warn(
        {
          agentId,
          error: getErrorMessage(error),
        },
        "agent org resolver failed; credential reads run without org context"
      );
      return undefined;
    }
    this.cacheSet(this.agentOrgCache, agentId, {
      organizationId,
      expiresAt: Date.now() + AuthProfilesManager.AGENT_ORG_CACHE_TTL_MS,
    });
    return organizationId;
  }

  private async listAgentOwnerProfiles(
    agentId: string,
    requestingUserId?: string
  ): Promise<AuthProfile[]> {
    const ownerUserId = await this.resolveAgentOwnerUserId(agentId);
    if (!ownerUserId || ownerUserId === requestingUserId) return [];
    const ownerProfiles = await this.listStoredProfiles(ownerUserId, agentId);
    // The owner's org-bucket sign-in covers every agent in the org, so an
    // Automation running as a synthetic user reaches it through the owner too.
    // Reach is the same one the API-key fallback already had: ANY non-owner
    // principal permitted to run this agent — synthetic or human — resolves the
    // owner's credential, subscription sign-ins now included.
    const organizationId = tryGetOrgId();
    const bucketProfiles = organizationId
      ? await this.listStoredProfiles(
          ownerUserId,
          orgBucketAgentId(organizationId)
        )
      : [];
    return [...ownerProfiles, ...bucketProfiles];
  }

  /** Read one `(userId, agentId)` storage row set, stamping each profile with
   *  the row it came from so a later refresh targets that row rather than the
   *  principal that happened to request it. */
  private async listStoredProfiles(
    userId: string,
    agentId: string
  ): Promise<AuthProfile[]> {
    const profiles = await this.userAuthProfiles.list(userId, agentId);
    const organizationId = tryGetOrgId() ?? undefined;
    return this.normalizeProfiles(profiles).map(
      (profile): SourcedAuthProfile => ({
        ...profile,
        [PROFILE_SOURCE]: { userId, agentId, organizationId },
      })
    );
  }

  async listProfiles(agentId: string, userId?: string): Promise<AuthProfile[]> {
    // Credential refs resolve through the org-partitioned secret store. If the
    // caller already established an org context (HTTP route, token-refresh job),
    // honor it. Otherwise — chat-platform webhook → worker-session-prep, which
    // has none — run the lookup inside this agent's org so the org-scoped
    // credential is found instead of falling back to the global partition.
    if (tryGetOrgId()) {
      return this.listProfilesInOrgContext(agentId, userId);
    }
    const organizationId = await this.resolveAgentOrgId(agentId);
    return organizationId
      ? orgContext.run({ organizationId }, () =>
          this.listProfilesInOrgContext(agentId, userId)
        )
      : this.listProfilesInOrgContext(agentId, userId);
  }

  private async listProfilesInOrgContext(
    agentId: string,
    userId?: string
  ): Promise<AuthProfile[]> {
    const userProfiles = userId
      ? await this.listStoredProfiles(userId, agentId)
      : [];

    // Org bucket: one subscription sign-in on the org inference-providers page
    // is stored under `(userId, "__org_oauth__:<orgId>")` and covers all of
    // this user's agents in the org. Merge it in at LOWER precedence than the
    // agent-specific user profile (an explicit per-agent sign-in still wins) but
    // ABOVE owner-fallback / ephemeral / declared. The org id is the ambient
    // context (this method runs inside the agent's org scope), so no slug lookup.
    const orgId = tryGetOrgId();
    const orgBucketProfiles =
      userId && orgId
        ? await this.listStoredProfiles(userId, orgBucketAgentId(orgId))
        : [];

    // Agent runs execute as a synthetic/platform user, not the operator who
    // connected the provider in the agent settings UI. Fall back to the agent
    // owner's user-scoped profiles so a UI-connected provider actually resolves
    // for chat/automation/Telegram runs. (`dedupeByScope` keeps the run user's
    // own profile when both exist.)
    const ownerProfiles = await this.listAgentOwnerProfiles(agentId, userId);

    const ephemeral = this.ephemeralProfiles.get(agentId) || [];
    const declared = this.synthesizeDeclaredProfiles(agentId);

    const merged = this.dedupeByScope([
      ...userProfiles,
      ...orgBucketProfiles,
      ...ownerProfiles,
      ...this.normalizeProfiles(ephemeral),
      ...declared,
    ]);

    return this.resolveProfiles(agentId, merged);
  }

  /**
   * Profiles physically stored under `(userId, agentId)` — no owner-, org-bucket-,
   * ephemeral-, or declared-source merging. The token-refresh job rotates a
   * profile and writes it back to the `(userId, agentId)` it was scanning, so it
   * must read only that row: resolving through `listProfiles` would let a merged
   * fallback profile be persisted into a row that never owned its refresh grant.
   *
   * Unlike `listProfiles`, this does NOT establish org context — the caller must
   * already be inside the row's org scope so credential refs resolve against the
   * right secret-store partition (`TokenRefreshJob` wraps both call sites).
   */
  async getStoredProviderProfiles(
    agentId: string,
    provider: string,
    userId: string
  ): Promise<AuthProfile[]> {
    const stored = await this.listStoredProfiles(userId, agentId);
    return this.resolveProfiles(
      agentId,
      stored.filter((profile) => profile.provider === provider)
    );
  }

  private async resolveProfiles(
    agentId: string,
    profiles: AuthProfile[]
  ): Promise<AuthProfile[]> {
    const resolved = await Promise.all(
      profiles.map(async (profile) => {
        try {
          return await this.resolveProfile(profile);
        } catch (error) {
          logger.warn(
            {
              agentId,
              profileId: profile.id,
              provider: profile.provider,
              error: getErrorMessage(error),
            },
            "Dropping auth profile with unresolvable secret ref"
          );
          return null;
        }
      })
    );

    return resolved.filter((p): p is AuthProfile => p !== null);
  }

  async hasProviderProfiles(
    agentId: string,
    provider: string,
    context?: ProviderCredentialContext
  ): Promise<boolean> {
    if (
      await this.resolveRuntimeProfile(agentId, provider, undefined, context)
    ) {
      return true;
    }
    const profiles = await this.listProfiles(agentId, context?.userId);
    return profiles.some((profile) => profile.provider === provider);
  }

  async getProviderProfiles(
    agentId: string,
    provider: string,
    userId?: string
  ): Promise<AuthProfile[]> {
    const profiles = await this.listProfiles(agentId, userId);
    return profiles.filter((profile) => profile.provider === provider);
  }

  async getBestProfile(
    agentId: string,
    provider: string,
    model?: string,
    context?: ProviderCredentialContext
  ): Promise<AuthProfile | null> {
    const runtimeProfile = await this.resolveRuntimeProfile(
      agentId,
      provider,
      model,
      context
    );
    if (runtimeProfile) {
      return runtimeProfile;
    }

    let providerProfiles = await this.getProviderProfiles(
      agentId,
      provider,
      context?.userId
    );
    if (providerProfiles.length === 0) {
      return null;
    }

    // A stored profile whose token has already lapsed still holds a refresh
    // grant. Rotate it BEFORE the expiry filter below, or that filter drops it
    // and no run — scheduled or interactive — can ever recover the sign-in.
    if (this.lazyRefreshHooks) {
      const lapsedAt = Date.now();
      let rotated = false;
      for (const profile of providerProfiles) {
        const source = profileSource(profile);
        const expiresAt = profile.metadata?.expiresAt;
        if (!source || !expiresAt || expiresAt > lapsedAt) continue;
        if (!REFRESHABLE_AUTH_TYPES.has(profile.authType)) continue;
        await this.ensureFreshCredential(profile, source);
        rotated = true;
      }
      if (rotated) {
        providerProfiles = await this.getProviderProfiles(
          agentId,
          provider,
          context?.userId
        );
      }
    }

    const now = Date.now();
    const validProfiles = providerProfiles.filter((profile) => {
      const expiresAt = profile.metadata?.expiresAt;
      return !expiresAt || expiresAt > now;
    });

    if (validProfiles.length === 0) {
      logger.warn(
        { agentId, provider, profileCount: providerProfiles.length },
        "All auth profiles for provider are expired"
      );
      return null;
    }

    if (!model) {
      return validProfiles[0] || null;
    }

    const exact = validProfiles.find((profile) => profile.model === model);
    if (exact) return exact;

    const wildcard = validProfiles.find(
      (profile) => profile.model === ANY_MODEL_SCOPE
    );
    return wildcard || validProfiles[0] || null;
  }

  /**
   * Insert or update a persistent profile.
   *
   * Requires `userId` — declared agents cannot be mutated through this
   * path. Runtime UI/sandbox agents that aren't owned by a single user
   * should pass a synthetic principal (`$ADMIN`) chosen by the caller.
   */
  async upsertProfile(input: UpsertAuthProfileInput): Promise<AuthProfile> {
    if (!input.userId) {
      throw new Error(
        "upsertProfile requires userId — declared agents cannot be mutated; " +
          "runtime agents must specify the owning principal"
      );
    }

    const modelScope = input.model?.trim() || ANY_MODEL_SCOPE;
    const profile: AuthProfile = {
      id: input.id || crypto.randomUUID(),
      provider: input.provider,
      ...(input.credential ? { credential: input.credential } : {}),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      authType: input.authType,
      label: input.label,
      model: modelScope,
      metadata: input.metadata,
      createdAt: Date.now(),
    };

    const stored = await this.userAuthProfiles.upsert(
      input.userId,
      input.agentId,
      profile,
      {
        makePrimary: input.makePrimary,
        ...(input.organizationId
          ? { organizationId: input.organizationId }
          : {}),
      }
    );

    logger.info(
      {
        agentId: input.agentId,
        userId: input.userId,
        provider: input.provider,
        profileId: stored.id,
      },
      "Saved auth profile"
    );

    return stored;
  }

  registerEphemeralProfile(input: UpsertAuthProfileInput): AuthProfile {
    const modelScope = input.model?.trim() || ANY_MODEL_SCOPE;
    const nextProfile: AuthProfile = {
      id: input.id || crypto.randomUUID(),
      provider: input.provider,
      ...(input.credential ? { credential: input.credential } : {}),
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      authType: input.authType,
      label: input.label,
      model: modelScope,
      metadata: input.metadata,
      createdAt: Date.now(),
    };

    const current = this.ephemeralProfiles.get(input.agentId) || [];
    const withoutSameScope = current.filter(
      (profile) =>
        !(
          profile.provider === input.provider &&
          profile.model === modelScope &&
          (!input.id || profile.id !== input.id)
        )
    );

    const providerProfiles: AuthProfile[] = [];
    const otherProfiles: AuthProfile[] = [];
    for (const profile of withoutSameScope) {
      if (profile.provider === input.provider) {
        providerProfiles.push(profile);
      } else {
        otherProfiles.push(profile);
      }
    }

    const nextProfiles =
      input.makePrimary !== false
        ? [nextProfile, ...providerProfiles, ...otherProfiles]
        : [...providerProfiles, nextProfile, ...otherProfiles];

    this.ephemeralProfiles.set(input.agentId, nextProfiles);
    return nextProfile;
  }

  async deleteProviderProfiles(
    agentId: string,
    provider: string,
    options: { userId?: string; profileId?: string } = {}
  ): Promise<void> {
    if (options.userId) {
      await this.userAuthProfiles.remove(options.userId, agentId, {
        provider,
        ...(options.profileId ? { profileId: options.profileId } : {}),
      });
    }

    const ephemeral = this.ephemeralProfiles.get(agentId);
    if (ephemeral) {
      const filtered = ephemeral.filter((profile) => {
        if (profile.provider !== provider) return true;
        if (!options.profileId) return false;
        return profile.id !== options.profileId;
      });
      if (filtered.length > 0) {
        this.ephemeralProfiles.set(agentId, filtered);
      } else {
        this.ephemeralProfiles.delete(agentId);
      }
    }

    logger.info(
      {
        agentId,
        provider,
        userId: options.userId || null,
        profileId: options.profileId || "all",
      },
      "Deleted auth profiles"
    );
  }

  private synthesizeDeclaredProfiles(agentId: string): AuthProfile[] {
    const entry = this.declaredAgents.get(agentId);
    if (!entry || entry.credentials.length === 0) return [];

    const now = Date.now();
    return entry.credentials.map<AuthProfile>((cred) => ({
      id: `declared:${agentId}:${cred.provider}`,
      provider: cred.provider,
      ...(cred.key ? { credential: cred.key } : {}),
      ...(cred.secretRef ? { credentialRef: cred.secretRef } : {}),
      authType: "api-key",
      label: `${cred.provider} (declared)`,
      model: ANY_MODEL_SCOPE,
      createdAt: now,
    }));
  }

  private normalizeProfiles(
    profiles: AuthProfile[] | undefined
  ): AuthProfile[] {
    if (!Array.isArray(profiles)) return [];
    return profiles.filter(
      (profile) =>
        typeof profile?.id === "string" &&
        typeof profile?.provider === "string" &&
        (typeof profile?.credential === "string" ||
          typeof profile?.credentialRef === "string") &&
        typeof profile?.authType === "string"
    );
  }

  /**
   * Merge profile lists, preferring whichever came first in the input
   * when two profiles cover the same (provider, model) scope. Callers
   * pass user profiles before ephemeral and declared so the persisted
   * per-user choice always wins.
   *
   * Within a scope, a non-expired profile beats an expired one regardless
   * of order — this keeps a stale user OAuth token from masking a valid
   * declared/ephemeral fallback for the same scope.
   */
  private dedupeByScope(profiles: AuthProfile[]): AuthProfile[] {
    const now = Date.now();
    const isExpired = (profile: AuthProfile) =>
      !!profile.metadata?.expiresAt && profile.metadata.expiresAt <= now;

    const scopeOrder: string[] = [];
    const chosen = new Map<string, AuthProfile>();
    for (const profile of profiles) {
      const scope = `${profile.provider}:${profile.model ?? ANY_MODEL_SCOPE}`;
      const existing = chosen.get(scope);
      if (!existing) {
        chosen.set(scope, profile);
        scopeOrder.push(scope);
        continue;
      }
      if (existing.id === profile.id) continue;
      if (isExpired(existing) && !isExpired(profile)) {
        chosen.set(scope, profile);
      }
    }
    return scopeOrder.map((scope) => chosen.get(scope)!);
  }

  private async resolveProfile(profile: AuthProfile): Promise<AuthProfile> {
    let credential = profile.credential;
    let credentialResolvedFromRef = false;
    if (!credential && profile.credentialRef) {
      const resolved = await this.secretStore.get(profile.credentialRef);
      if (!resolved) {
        throw new Error(
          `Unresolved credential secret ref: ${profile.credentialRef}`
        );
      }
      credential = resolved;
      credentialResolvedFromRef = true;
    }

    let refreshToken = profile.metadata?.refreshToken;
    let refreshTokenResolvedFromRef = false;
    if (!refreshToken && profile.metadata?.refreshTokenRef) {
      const resolved = await this.secretStore.get(
        profile.metadata.refreshTokenRef
      );
      if (!resolved) {
        throw new Error(
          `Unresolved refreshToken secret ref: ${profile.metadata.refreshTokenRef}`
        );
      }
      refreshToken = resolved;
      refreshTokenResolvedFromRef = true;
    }

    const next: AuthProfile = { ...profile };
    if (credentialResolvedFromRef) {
      next.credential = credential;
      delete next.credentialRef;
    } else if (credential) {
      next.credential = credential;
    }

    if (profile.metadata) {
      const metadata = { ...profile.metadata };
      if (refreshTokenResolvedFromRef) {
        metadata.refreshToken = refreshToken;
        delete metadata.refreshTokenRef;
      } else if (refreshToken) {
        metadata.refreshToken = refreshToken;
      }
      next.metadata = metadata;
    }

    return next;
  }

  private async resolveRuntimeProfile(
    agentId: string,
    provider: string,
    model?: string,
    context?: ProviderCredentialContext
  ): Promise<AuthProfile | null> {
    if (!this.runtimeCredentialResolver) {
      return null;
    }

    let resolved: Awaited<ReturnType<RuntimeProviderCredentialResolver>>;
    try {
      resolved = await this.runtimeCredentialResolver({
        ...context,
        agentId,
        provider,
        model,
      });
    } catch (error) {
      logger.warn("Runtime credential resolver threw", {
        agentId,
        provider,
        model,
        error: getErrorMessage(error),
      });
      return null;
    }

    if (!resolved || (!resolved.credential && !resolved.credentialRef)) {
      return null;
    }

    if (resolved.credential && resolved.credentialRef) {
      logger.warn(
        "Runtime credential resolver returned both credential and credentialRef; preferring credential",
        { agentId, provider, model }
      );
    }

    try {
      const profile = await this.resolveProfile({
        id: `runtime:${agentId}:${provider}:${model ?? "*"}`,
        provider,
        ...(resolved.credential
          ? { credential: resolved.credential }
          : { credentialRef: resolved.credentialRef }),
        authType: resolved.authType ?? "api-key",
        label: resolved.label ?? `${provider} (runtime resolver)`,
        model: model?.trim() || ANY_MODEL_SCOPE,
        metadata: resolved.metadata,
        createdAt: Date.now(),
      });

      if (!profile.credential && !profile.credentialRef) {
        return null;
      }

      return profile;
    } catch (error) {
      logger.warn("Failed to resolve runtime credential profile", {
        agentId,
        provider,
        model,
        error: getErrorMessage(error),
      });
      return null;
    }
  }
}

export function createAuthProfileLabel(
  providerDisplayName: string,
  credential: string,
  accountHint?: string
): string {
  if (accountHint?.trim()) {
    return accountHint.trim();
  }

  const trimmed = credential.trim();
  if (trimmed.length <= 8) {
    return `${providerDisplayName} key`;
  }

  return `${providerDisplayName} ${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
