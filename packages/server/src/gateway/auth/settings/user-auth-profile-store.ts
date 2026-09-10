import {
	type AuthProfile,
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import { getDb } from "../../../db/client.js";
import {
  deleteSecretsByPrefix,
  type WritableSecretStore,
} from "../../secrets/index.js";

const logger = createLogger("user-auth-profile-store");

/**
 * Prefix for the per-user ORG BUCKET agentId. One subscription sign-in on the
 * org inference-providers page is stored under `(userId, orgBucketAgentId(org))`
 * and covers every one of that user's agents in the org (merged at resolution
 * time by `AuthProfilesManager`). The discriminator is the organization id — the
 * same value the routes read from `c.get('organizationId')` and the resolver
 * reads from `resolveAgentOrgId`, so no slug→id lookup is needed on either path.
 */
export const ORG_BUCKET_AGENT_PREFIX = "__org_oauth__:";

export function orgBucketAgentId(organizationId: string): string {
  return `${ORG_BUCKET_AGENT_PREFIX}${organizationId}`;
}

export function isOrgBucketAgentId(agentId: string): boolean {
  return agentId.startsWith(ORG_BUCKET_AGENT_PREFIX);
}

/**
 * Profile auth types that carry a refresh token we can rotate. "oauth" =
 * Claude (authorization-code), "device-code" = ChatGPT/Codex; "api-key" is the
 * only non-member. Lives here rather than beside the refresh job because both
 * the job and `AuthProfilesManager`'s at-use-time lazy refresh gate on it — a
 * second copy of these literals would break refresh for already-signed-in
 * users ~1h later, invisibly. The refresh-eligibility regression test asserts
 * both literals are still selected after the OAuth-flow consolidation.
 */
export const REFRESHABLE_AUTH_TYPES: ReadonlySet<string> = new Set([
  "oauth",
  "device-code",
]);

function buildSecretName(
  userId: string,
  agentId: string,
  profileId: string,
  kind: "credential" | "refresh-token"
): string {
  return `users/${userId}/agents/${agentId}/auth-profiles/${profileId}/${kind}`;
}

function buildAgentSecretPrefix(userId: string, agentId: string): string {
  return `users/${userId}/agents/${agentId}/auth-profiles/`;
}

function buildProfileSecretPrefix(
  userId: string,
  agentId: string,
  profileId: string
): string {
  return `users/${userId}/agents/${agentId}/auth-profiles/${profileId}/`;
}

interface UserAgentRef {
  userId: string;
  agentId: string;
  organizationId: string;
}

/**
 * Per-user auth profile storage.
 *
 * Keyed by `(userId, agentId)`. Holds OAuth tokens, refresh tokens, and
 * BYOK credentials owned by a specific user for a specific agent.
 *
 * Sensitive values (credential / refresh token) are persisted to the
 * secret store and replaced inline with their refs before the profile
 * list is written to `public.user_auth_profiles`.
 */
export class UserAuthProfileStore {
  constructor(private readonly secretStore: WritableSecretStore) {}

  async list(userId: string, agentId: string): Promise<AuthProfile[]> {
    if (!userId || !agentId) return [];
    const sql = getDb();
    try {
      const rows = await sql`
        SELECT profiles
        FROM user_auth_profiles
        WHERE user_id = ${userId} AND agent_id = ${agentId}
      `;
      if (rows.length === 0) return [];
      const profiles = rows[0].profiles as unknown;
      if (!Array.isArray(profiles)) return [];
      return profiles as AuthProfile[];
    } catch (error) {
      logger.warn("Failed to read user auth profiles", {
        userId,
        agentId,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  /**
   * Insert or update a profile. The supplied profile is normalized through
   * the secret store: any plaintext credential/refreshToken is moved into
   * the secret store and replaced with a ref before persistence.
   *
   * The stored ordering follows the same convention as
   * `AuthProfilesManager.upsertProfile`: when `makePrimary === false` the
   * profile is appended after sibling provider profiles; otherwise it is
   * placed at the front of its provider group.
   */
  async upsert(
    userId: string,
    agentId: string,
    profile: AuthProfile,
    options: { makePrimary?: boolean; organizationId?: string } = {}
  ): Promise<AuthProfile> {
    const persisted = await this.persistSecrets(userId, agentId, profile);
    const current = await this.list(userId, agentId);

    let preservedCreatedAt = persisted.createdAt;
    const filtered = current.filter((existing) => {
      if (existing.id === persisted.id) {
        preservedCreatedAt = existing.createdAt;
        return false;
      }
      if (
        existing.provider === persisted.provider &&
        existing.model === persisted.model
      ) {
        preservedCreatedAt = existing.createdAt;
        return false;
      }
      return true;
    });
    const next: AuthProfile = { ...persisted, createdAt: preservedCreatedAt };

    const sameProvider: AuthProfile[] = [];
    const others: AuthProfile[] = [];
    for (const entry of filtered) {
      if (entry.provider === next.provider) {
        sameProvider.push(entry);
      } else {
        others.push(entry);
      }
    }

    const ordered =
      options.makePrimary === false
        ? [...sameProvider, next, ...others]
        : [next, ...sameProvider, ...others];

    // `organization_id` is only set for org-bucket rows (agent_id
    // `__org_oauth__:<slug>`, which has no agents row to derive org from). Pass
    // undefined for ordinary per-agent rows so the column stays NULL and org is
    // derived via the agents join in `scanAllOAuth`. COALESCE keeps an already
    // stored org id if a later upsert omits it.
    const organizationId = options.organizationId ?? null;
    const sql = getDb();
    await sql`
      INSERT INTO user_auth_profiles (user_id, agent_id, profiles, organization_id, updated_at)
      VALUES (${userId}, ${agentId}, ${sql.json(ordered)}, ${organizationId}, now())
      ON CONFLICT (user_id, agent_id) DO UPDATE SET
        profiles = EXCLUDED.profiles,
        organization_id = COALESCE(EXCLUDED.organization_id, user_auth_profiles.organization_id),
        updated_at = now()
    `;
    return next;
  }

  async remove(
    userId: string,
    agentId: string,
    options: { provider: string; profileId?: string }
  ): Promise<{ removed: AuthProfile[]; secretsDeleted: number }> {
    const current = await this.list(userId, agentId);
    if (current.length === 0) {
      return { removed: [], secretsDeleted: 0 };
    }

    const removed = current.filter((profile) => {
      if (profile.provider !== options.provider) return false;
      if (options.profileId && profile.id !== options.profileId) return false;
      return true;
    });
    const remaining = current.filter((profile) => !removed.includes(profile));

    const sql = getDb();
    if (remaining.length > 0) {
      await sql`
        INSERT INTO user_auth_profiles (user_id, agent_id, profiles, updated_at)
        VALUES (${userId}, ${agentId}, ${sql.json(remaining)}, now())
        ON CONFLICT (user_id, agent_id) DO UPDATE SET
          profiles = EXCLUDED.profiles,
          updated_at = now()
      `;
    } else {
      await sql`
        DELETE FROM user_auth_profiles
        WHERE user_id = ${userId} AND agent_id = ${agentId}
      `;
    }

    let secretsDeleted = 0;
    for (const profile of removed) {
      secretsDeleted += await deleteSecretsByPrefix(
        this.secretStore,
        buildProfileSecretPrefix(userId, agentId, profile.id)
      );
    }

    return { removed, secretsDeleted };
  }

  /**
   * Cascade-delete every profile and secret for a `(userId, agentId)`.
   * Used when an agent is deleted entirely.
   */
  async dropAgent(userId: string, agentId: string): Promise<void> {
    const sql = getDb();
    await sql`
      DELETE FROM user_auth_profiles
      WHERE user_id = ${userId} AND agent_id = ${agentId}
    `;
    await deleteSecretsByPrefix(
      this.secretStore,
      buildAgentSecretPrefix(userId, agentId)
    );
  }

  /**
   * Yield every `(userId, agentId, organizationId)` triple for which OAuth
   * profiles exist. Used by `TokenRefreshJob` to scan refreshable tokens —
   * the org id is needed so the refresh path can establish org context
   * before reading/writing org-scoped secrets via PostgresSecretStore.
   *
   * LEFT JOIN (not INNER) so org-bucket rows — `agent_id =
   * '__org_oauth__:<slug>'`, which have no `agents` row — are NOT dropped: their
   * org comes from the row's own `organization_id` column. `COALESCE(a.org,
   * uap.org)` derives per-agent rows from the join and org-bucket rows from the
   * column. The WHERE guards against orphan rows carrying neither (an agent
   * deleted out from under a plain row with a NULL column) — those are skipped.
   */
  async *scanAllOAuth(): AsyncIterable<UserAgentRef> {
    const sql = getDb();
    const rows = await sql`
      SELECT uap.user_id,
             uap.agent_id,
             COALESCE(a.organization_id, uap.organization_id) AS organization_id
      FROM user_auth_profiles uap
      LEFT JOIN agents a ON a.id = uap.agent_id
      WHERE COALESCE(a.organization_id, uap.organization_id) IS NOT NULL
    `;
    for (const row of rows as Array<Record<string, any>>) {
      yield {
        userId: row.user_id as string,
        agentId: row.agent_id as string,
        organizationId: row.organization_id as string,
      };
    }
  }

  /**
   * The `organization_id` stored on a `(userId, agentId)` row, or null. Used by
   * the token-refresh job's direct entrypoint for org-bucket agentIds
   * (`__org_oauth__:<slug>`), which have no `agents` row to look the org up in —
   * the column is the only source of org context for that path.
   */
  async getOrganizationId(
    userId: string,
    agentId: string
  ): Promise<string | null> {
    if (!userId || !agentId) return null;
    const sql = getDb();
    try {
      const rows = await sql`
        SELECT organization_id
        FROM user_auth_profiles
        WHERE user_id = ${userId} AND agent_id = ${agentId}
        LIMIT 1
      `;
      return (rows[0]?.organization_id as string | null) ?? null;
    } catch (error) {
      logger.warn("Failed to read org id for user auth profile row", {
        userId,
        agentId,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  private async persistSecrets(
    userId: string,
    agentId: string,
    profile: AuthProfile
  ): Promise<AuthProfile> {
    const next: AuthProfile = { ...profile };
    const metadata = profile.metadata ? { ...profile.metadata } : undefined;

    if (profile.credential) {
      next.credentialRef = await this.secretStore.put(
        buildSecretName(userId, agentId, profile.id, "credential"),
        profile.credential
      );
    }
    delete next.credential;

    if (metadata) {
      if (metadata.refreshToken) {
        metadata.refreshTokenRef = await this.secretStore.put(
          buildSecretName(userId, agentId, profile.id, "refresh-token"),
          metadata.refreshToken
        );
      }
      delete metadata.refreshToken;
      next.metadata = metadata;
    }

    return next;
  }
}
