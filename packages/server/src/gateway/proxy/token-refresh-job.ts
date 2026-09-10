import { createLogger } from "@lobu/core";
import { type DbClient, getDb } from "../../db/client.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import type { OAuthCredentials } from "../auth/oauth/credentials.js";
import type { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";
import {
  isOrgBucketAgentId,
  REFRESHABLE_AUTH_TYPES,
} from "../auth/settings/user-auth-profile-store.js";

const logger = createLogger("token-refresh-job");

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh tokens expiring within 5 minutes

/**
 * Anything that can swap a refresh token for fresh credentials. Both the
 * Claude `OAuthClient` (authorization-code flow) and the ChatGPT
 * `ChatGPTDeviceCodeClient` (device-code flow) implement this, so both can be
 * registered as refreshable providers.
 */
export interface TokenRefresher {
  refreshToken(refreshToken: string): Promise<OAuthCredentials>;
}

interface RefreshableProvider {
  providerId: string;
  refresher: TokenRefresher;
}

/**
 * Postgres advisory-lock namespace for OAuth-profile refresh serialization.
 * `pg_advisory_xact_lock(hashtext($1))` derives the int8 key from a per-profile
 * string, so the lock is automatically released when the wrapping transaction
 * ends. Cross-replica safe: a refresh in flight on pod A blocks pod B until A
 * commits, at which point B re-reads the now-rotated expiry and no-ops instead
 * of persisting a token A already rotated away (the lost-update race fixed here).
 */
function refreshLockTag(profileId: string): string {
  return `oauth_token_refresh:${profileId}`;
}

/**
 * Proactive OAuth token refresher.
 *
 * Wired as a periodic task via TaskScheduler (see `scheduled/jobs.ts`).
 * On each invocation:
 * 1. Scans `UserAuthProfileStore` for `(userId, agentId)` pairs holding OAuth profiles.
 * 2. Refreshes any token expiring within `EXPIRY_BUFFER_MS` via its provider's OAuth client.
 * 3. Writes the rotated credentials back through `AuthProfilesManager.upsertProfile`.
 *
 * Each per-profile refresh runs under a Postgres advisory lock keyed on the
 * profile id, with the expiry RE-READ inside the lock — so concurrent refreshes
 * across replicas serialize and the loser no-ops instead of overwriting a
 * freshly-rotated refresh token with a stale one.
 */
export class TokenRefreshJob {
  constructor(
    private authProfilesManager: AuthProfilesManager,
    private refreshableProviders: RefreshableProvider[],
    // Lazy db accessor; injectable so tests can drive the advisory-lock control
    // flow with a fake DbClient instead of mock.module'ing the db/client module
    // (which leaks process-globally across the bun:test gateway suite).
    private getDbFn: () => DbClient = getDb
  ) {}

  /** One-shot scan + refresh of every OAuth profile. Invoked by the
   *  TaskScheduler as the every-30min safety net for users who haven't
   *  exercised any token-using path recently — the lazy at-use-time
   *  refresh handles everyone else. */
  async runOnce(): Promise<void> {
    const userAuthProfiles = this.authProfilesManager.getUserAuthProfileStore();
    for await (const {
      userId,
      agentId,
      organizationId,
    } of userAuthProfiles.scanAllOAuth()) {
      // Isolate per-(user, agent) failures so one bad row (expired refresh
      // token, DB hiccup, provider 5xx) doesn't abort the entire scan and
      // strand every later user's tokens until the next 30-min tick.
      try {
        await orgContext.run({ organizationId }, () =>
          this.doRefresh(userId, agentId)
        );
      } catch (err) {
        logger.warn(
          { userId, agentId, organizationId, err: String(err) },
          "Token refresh failed for user/agent — continuing scan"
        );
      }
    }
  }

  /**
   * Refresh tokens for a single (userId, agentId). Public so the
   * `refresh-token-for-user-agent` task and AuthProfilesManager's at-use-time
   * lazy path can both call it. Concurrent calls — in this process or across
   * replicas — serialize per profile via the Postgres advisory lock in
   * `doRefresh`.
   *
   * Looks up the agent's org and establishes an `orgContext` scope before
   * delegating, so `PostgresSecretStore` reads/writes resolve against the
   * correct tenant bucket. Both call paths (scheduler-spawned task at
   * `scheduled/jobs.ts:89` and direct invocation from
   * `AuthProfilesManager.refreshNow`) lose the original request's
   * AsyncLocalStorage scope by the time they land here.
   */
  async refreshForUserAgent(userId: string, agentId: string): Promise<void> {
    const organizationId = await this.lookupAgentOrg(userId, agentId);
    if (organizationId === null) {
      logger.warn(
        { userId, agentId },
        "Skipping token refresh — agent has no org row (deleted?)"
      );
      return;
    }
    return orgContext.run({ organizationId }, () =>
      this.doRefresh(userId, agentId)
    );
  }

  /** Org-bucket agentIds (`__org_oauth__:<orgId>`, from an org-page sign-in)
   *  have no `agents` row — their org lives on the `user_auth_profiles` row's
   *  `organization_id` column (set at upsert). Read it from the store for those;
   *  ordinary per-agent ids resolve via the agents table. */
  private async lookupAgentOrg(
    userId: string,
    agentId: string
  ): Promise<string | null> {
    if (isOrgBucketAgentId(agentId)) {
      return this.authProfilesManager
        .getUserAuthProfileStore()
        .getOrganizationId(userId, agentId);
    }
    const sql = this.getDbFn();
    const rows = await sql<{ organization_id: string }>`
      SELECT organization_id FROM agents WHERE id = ${agentId} LIMIT 1
    `;
    return rows[0]?.organization_id ?? null;
  }

  private async doRefresh(userId: string, agentId: string): Promise<void> {
    for (const { providerId, refresher } of this.refreshableProviders) {
      const profiles = await this.authProfilesManager.getStoredProviderProfiles(
        agentId,
        providerId,
        userId
      );
      const oauthProfile = profiles.find(
        (profile) =>
          REFRESHABLE_AUTH_TYPES.has(profile.authType) &&
          !!profile.metadata?.refreshToken
      );

      if (!oauthProfile?.metadata?.refreshToken) continue;

      // Cheap pre-check outside the lock: skip the lock + re-read entirely for
      // the overwhelming majority of profiles that aren't near expiry.
      const expiresAt = oauthProfile.metadata.expiresAt || 0;
      if (expiresAt > Date.now() + EXPIRY_BUFFER_MS) continue;

      try {
        await this.refreshProfileUnderLock(
          userId,
          agentId,
          providerId,
          refresher,
          oauthProfile.id
        );
      } catch (error) {
        logger.error(
          `Failed to refresh ${providerId} token for user ${userId} agent ${agentId}`,
          { error }
        );
      }
    }
  }

  /**
   * Acquire the per-profile advisory lock, RE-READ the profile's expiry inside
   * the lock, and only then refresh + persist. The transaction holds the lock
   * until it returns, so a concurrent refresh on another replica blocks here;
   * once it wins and commits its rotated token, the loser re-reads the now-future
   * expiry and no-ops rather than overwriting the freshly-rotated refresh token.
   */
  private async refreshProfileUnderLock(
    userId: string,
    agentId: string,
    providerId: string,
    refresher: TokenRefresher,
    profileId: string
  ): Promise<void> {
    const sql = this.getDbFn();
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        refreshLockTag(profileId),
      ]);

      // Re-read under the lock — another replica may have rotated this profile
      // while we waited to acquire it.
      const profiles = await this.authProfilesManager.getStoredProviderProfiles(
        agentId,
        providerId,
        userId
      );
      const oauthProfile = profiles.find((profile) => profile.id === profileId);
      if (
        !oauthProfile ||
        !REFRESHABLE_AUTH_TYPES.has(oauthProfile.authType) ||
        !oauthProfile.metadata?.refreshToken
      ) {
        return;
      }

      const expiresAt = oauthProfile.metadata.expiresAt || 0;
      if (expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
        logger.debug(
          `Skipping ${providerId} refresh because another worker already rotated it`,
          { expiresAt: new Date(expiresAt).toISOString() }
        );
        return;
      }

      logger.info(
        `Refreshing ${providerId} token for user ${userId} agent ${agentId}`,
        { expiresAt: new Date(expiresAt).toISOString() }
      );

      const newCredentials = await refresher.refreshToken(
        oauthProfile.metadata.refreshToken
      );

      await this.authProfilesManager.upsertProfile({
        agentId,
        userId,
        id: oauthProfile.id,
        provider: oauthProfile.provider,
        credential: newCredentials.accessToken,
        authType: oauthProfile.authType,
        label: oauthProfile.label,
        model: oauthProfile.model,
        metadata: {
          ...oauthProfile.metadata,
          refreshToken: newCredentials.refreshToken,
          expiresAt: newCredentials.expiresAt,
        },
        makePrimary: false,
      });

      logger.info(
        `Token refreshed for user ${userId} agent ${agentId} (${providerId})`
      );
    });
  }
}
