/**
 * GitHub repo-membership ACL SYNC — the production path that populates the repo
 * graph the resource gate reads, mirroring `./slack-acl-sync` for the second
 * source. Per GitHub connection: enumerate the repos it captures (from its
 * feeds), verify public visibility or fetch collaborators, and use `buildAccessGraph`
 * (which materializes the `member_of` edges, reconciles departures, and stamps
 * the connection `full`/`fresh`).
 *
 * Fail-closed on error, ATOMIC per connection: if ANY repo's metadata or
 * collaborator fetch throws (GitHub outage, token expiry, repo gone), we mark the connection's ACL
 * state `failed` rather than build a half-synced graph — but only DOWNGRADE an
 * existing row (a connection that has never been graphed stays on the legacy
 * fence). The external calls (repo list, visibility, collaborators) are injected so the
 * sync logic is tested with stubs and the live tick wires the real GitHub API.
 */

import { createLogger } from '@lobu/core';
import { IDENTITY, type AccessMember } from '@lobu/connector-sdk';
import { getDb } from '../db/client.js';
import { mergeExecutionConfig, resolveExecutionAuth } from '../utils/execution-context.js';
import {
  type GithubRepoCollaborator,
  githubAclSource,
  githubReposToResources,
  normalizeGithubRepoFullName,
  resolveGithubToken,
} from '@lobu/connectors/github-identity';
import {
  ACL_ERROR_MESSAGE_PREFIX,
  clearConnectionAclError,
  clearRetainedAclErrorMessage,
  markConnectionAclFailed,
} from './acl-observability.js';
import { buildAccessGraph } from './access-graph.js';
import { captureAclSyncFence } from './acl-generation.js';
import { withAclConnectionSyncLock } from './acl-sync-lock.js';

const logger = createLogger('github-acl-sync');

/** `owner/repo` split, as a repo is captured by a connection's feed. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
  /** All feeds for this repo were removed: retract its audience without fetching it. */
  retired?: boolean;
}

/** Injectable seams: tests drive the real graph build + gate with stubbed GitHub
 * calls; the live tick wires the real repo list + collaborator API. */
export interface GithubAclSyncDeps {
  /** The repos this connection captures (from its feeds' config). */
  listRepos: (params: { organizationId: string; connectionId: string }) => Promise<GithubRepoRef[]>;
  /** Verified public repo audience, or null to require collaborators. Never inferred from a 403. */
  fetchPublicMembers?: (params: {
    organizationId: string;
    connectionId: string;
    repo: GithubRepoRef;
  }) => Promise<AccessMember[] | null>;
  /** A repo's current collaborators. Throws on a GitHub-level error (fail-closed). */
  fetchCollaborators: (params: {
    organizationId: string;
    connectionId: string;
    repo: GithubRepoRef;
  }) => Promise<GithubRepoCollaborator[]>;
}

export interface GithubAclSyncResult {
  ok: boolean;
  /**
   * True when another sync already held this connection and this call published
   * nothing. Distinct from `ok: false`: a skip is not a failure and must NOT
   * mark the connection failed, but nothing was reconciled either.
   */
  skipped?: boolean;
  reposSynced: number;
}

/**
 * Sync ONE GitHub connection's repo-membership graph. Resolves its captured
 * repos, verifies public visibility or fetches collaborators per repo, and
 * builds the graph. See the file
 * header for the fail-closed contract.
 */
export async function syncGithubConnectionAcl(
  deps: GithubAclSyncDeps,
  params: { connectionId: string; organizationId: string },
): Promise<GithubAclSyncResult> {
  const outcome = await withAclConnectionSyncLock(params.connectionId, () =>
    syncGithubConnectionAclLocked(deps, params),
  );
  if (!outcome.ran) {
    logger.info('GitHub ACL sync skipped: another sync holds this connection', {
      organization_id: params.organizationId,
      connection_id: params.connectionId,
    });
    return { ok: false, skipped: true, reposSynced: 0 };
  }
  return outcome.value;
}

async function syncGithubConnectionAclLocked(
  deps: GithubAclSyncDeps,
  params: { connectionId: string; organizationId: string },
): Promise<GithubAclSyncResult> {
  const { connectionId, organizationId } = params;

  // Captured BEFORE any provider read. Capturing it inside `buildAccessGraph`
  // instead — after every collaborator fetch — would observe a generation that
  // an invalidation had already bumped while this snapshot was being taken, so
  // the stale snapshot would then satisfy its own fence. Slack captures its
  // fence in the same position, before its channel fetches.
  const syncFence = await captureAclSyncFence(organizationId);

  const repos = await deps.listRepos({ organizationId, connectionId });
  // Retired repos only retract; a connection with no live repo still fails closed.
  if (!repos.some((repo) => !repo.retired)) {
    const reason = 'GitHub ACL sync unavailable: no repository feeds configured';
    logger.error(
      `${reason} — downgrading any existing ACL graph`,
      { organization_id: organizationId, connection_id: connectionId },
    );
    await markConnectionAclFailed(organizationId, connectionId, reason);
    return { ok: false, reposSynced: 0 };
  }

  try {
    const resources = [];
    for (const repo of repos) {
      const params = { organizationId, connectionId, repo };
      const publicMembers = repo.retired ? [] : await deps.fetchPublicMembers?.(params);
      const fullName = `${repo.owner}/${repo.repo}`;
      const [resource] = githubReposToResources([{
        fullName,
        collaborators: publicMembers == null ? await deps.fetchCollaborators(params) : [],
      }]);
      if (!resource) {
        // An unparseable name was never graphed, so a retired one has nothing to retract.
        if (repo.retired) continue;
        throw new Error(`Invalid GitHub repository identity: ${fullName}`);
      }
      if (publicMembers != null) resource.members = publicMembers;
      resources.push(resource);
    }
    await buildAccessGraph({
      organizationId,
      connectionId,
      connectorKey: githubAclSource.key,
      resourceNamespace: githubAclSource.resourceNamespace,
      memberIdentities: [
        ...githubAclSource.memberIdentities,
        { namespace: IDENTITY.AUTH_USER_ID, primary: true },
      ],
      resources,
      syncFence,
    });
    await clearConnectionAclError(organizationId, connectionId);
    return { ok: true, reposSynced: resources.length };
  } catch (error) {
    logger.error(
      'GitHub ACL sync failed — marking connection fail-closed',
      { organization_id: organizationId, connection_id: connectionId, error: String(error) },
    );
    await markConnectionAclFailed(
      organizationId,
      connectionId,
      `GitHub ACL sync failed: ${String(error)}`,
    );
    return { ok: false, reposSynced: 0 };
  }
}

/** Parse `owner/repo` from a feed config (the GitHub connector stores
 * `repo_owner`/`repo_name`). Skips feeds without a fully-specified repo; a repo
 * whose every feed is deleted is returned `retired`. */
function repoRefsFromFeedConfigs(feeds: Array<{
  config: Record<string, unknown> | null;
  deleted_at: unknown;
}>): GithubRepoRef[] {
  const refs = new Map<string, GithubRepoRef>();
  for (const { config, deleted_at } of feeds) {
    const owner = typeof config?.repo_owner === 'string' ? config.repo_owner.trim() : '';
    const repo = typeof config?.repo_name === 'string' ? config.repo_name.trim() : '';
    if (!owner || !repo) continue;
    const key = `${owner}/${repo}`.toLowerCase();
    const existing = refs.get(key);
    if (existing && !existing.retired) continue;
    refs.set(key, { owner, repo, ...(deleted_at != null ? { retired: true } : {}) });
  }
  return [...refs.values()];
}

/** Repository metadata is the authority for public read access. An internal
 * repository, missing metadata, redirect, or provider error never means public. */
async function isPublicRepository(token: string, repo: GithubRepoRef): Promise<boolean> {
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`,
    {
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'lobu',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!res.ok) throw new Error(`GitHub repository ${repo.owner}/${repo.repo} returned ${res.status}`);
  const body = await res.json() as { full_name?: string; private?: boolean; visibility?: string } | null;
  const expected = normalizeGithubRepoFullName(`${repo.owner}/${repo.repo}`);
  if (!expected || !body || typeof body.private !== 'boolean'
    || normalizeGithubRepoFullName(body.full_name) !== expected) {
    throw new Error(`Invalid GitHub repository metadata for ${repo.owner}/${repo.repo}`);
  }
  return body.private === false && body.visibility === 'public';
}

/** Compose the existing resource/member graph with verified workspace members.
 * These identities come from sign-in, never from provider text or feed config.
 * Connection visibility is still enforced separately on every read. */
async function publicRepositoryMembers(organizationId: string): Promise<AccessMember[]> {
  const rows = await getDb()<{ user_id: string }>`
    SELECT ei.identifier AS user_id
    FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id AND e.organization_id = ei.organization_id
    JOIN entity_types et ON et.id = e.entity_type_id AND et.organization_id = e.organization_id
    JOIN "member" m ON m."organizationId" = ei.organization_id AND m."userId" = ei.identifier
    WHERE ei.organization_id = ${organizationId}
      AND ei.namespace = ${IDENTITY.AUTH_USER_ID} AND ei.source_connector = 'auth:signup'
      AND ei.scope_key IS NULL AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL AND et.deleted_at IS NULL AND et.slug = '$member'
  `;
  return rows.map(({ user_id }) => ({
    key: `${IDENTITY.AUTH_USER_ID}:${user_id}`,
    identities: [{ namespace: IDENTITY.AUTH_USER_ID, value: user_id }],
  }));
}

/** GitHub `/repos/{owner}/{repo}/collaborators`, paginated, bare `{login,id}`.
 * Throws on a non-OK response so the sync treats it fail-closed. */
async function fetchRepoCollaborators(
  token: string,
  repo: GithubRepoRef,
): Promise<GithubRepoCollaborator[]> {
  const collaborators: GithubRepoCollaborator[] = [];
  const perPage = 100;
  for (let page = 1; page <= 100; page++) {
    const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/collaborators?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'lobu',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub collaborators ${repo.owner}/${repo.repo} returned ${res.status}`);
    }
    const body = (await res.json()) as Array<{ login?: string; id?: number }>;
    const items = Array.isArray(body) ? body : [];
    for (const c of items) {
      if (typeof c.login === 'string' && c.login) {
        collaborators.push({ login: c.login, id: typeof c.id === 'number' ? c.id : undefined });
      }
    }
    if (items.length < perPage) break;
  }
  return collaborators;
}

/**
 * The periodic production caller (registered via `./acl-sync`). Re-syncs every
 * active GitHub connection's repo-membership graph so collaborator changes
 * converge within the cadence and the gate's freshness window keeps a stalled
 * connection fail-closed. Runs on one replica per tick (the runs-queue claim).
 *
 * NOTE: the live collaborator API needs an authorized connection to verify end
 * to end; the sync LOGIC is covered by `__tests__/.../github-acl-sync` driving
 * {@link syncGithubConnectionAcl} with stubbed deps, and the per-connection
 * credential wiring by `__tests__/.../github-acl-connection-auth`.
 */
export async function runGithubAclSyncTick(): Promise<void> {
  const sql = getDb();
  // Residue release, BEFORE the sweep below. The exclusion stops NEW failures but
  // cannot undo old ones: `clearConnectionAclError` only clears behind a
  // `fresh` state, which an excluded row can never reach, so a failure written
  // by an earlier tick (or by any tick before this exclusion existed) would sit
  // on a healthy connection forever. Keyed on the residue itself, not on "an
  // ACL state row exists": a consent-only connection can legitimately hold a
  // `fresh` or `stale` enforcement row, and that row is what keeps its
  // already-synced events fenced. Matches only rows that actually carry
  // residue, so the steady state does no work.
  const stale = await sql<{ id: string; organization_id: string }>`
		SELECT c.id::text AS id, c.organization_id
		FROM connections c
		WHERE c.connector_key = 'github'
		  AND c.deleted_at IS NULL
		  AND c.config->>'consent_only' = 'true'
		  AND left(c.error_message, ${ACL_ERROR_MESSAGE_PREFIX.length}) = ${ACL_ERROR_MESSAGE_PREFIX}
	`;
  for (const row of stale) {
    await clearRetainedAclErrorMessage(sql, {
      organizationId: row.organization_id,
      connectionId: row.id,
    });
  }

  // Consent-only grant-holders are EXCLUDED, not swept and failed: they exist
  // solely to hold an OAuth grant for delegation, and `manage_feeds` refuses
  // feeds on them by construction, so `listRepos` is empty for them on every
  // tick. Sweeping them would mark a healthy row `failed` forever (the reason
  // only clears on a successful sync, which can never happen), turning the
  // ACL-failure signal into permanent noise. A NORMAL connection that has no
  // feeds still fails closed below — the skip is scoped to consent-only.
  const connections = await sql<{ id: string; organization_id: string }>`
		SELECT id::text AS id, organization_id
		FROM connections
		WHERE connector_key = 'github' AND status = 'active' AND deleted_at IS NULL
		  AND config->>'consent_only' IS DISTINCT FROM 'true'
	`;
  if (connections.length === 0) return;

  // One credential resolution per connection, not per repo: a managed grant or
  // App mint is a network round trip.
  const tokens = new Map<string, Promise<string | null>>();
  const connectionToken = async (organizationId: string, connectionId: string): Promise<string> => {
    let token = tokens.get(connectionId);
    if (!token) {
      token = resolveGithubConnectionToken(organizationId, connectionId);
      tokens.set(connectionId, token);
    }
    const resolved = await token;
    if (!resolved) throw new Error(`No GitHub credential for connection ${connectionId}`);
    return resolved;
  };
  const deps: GithubAclSyncDeps = {
    listRepos: async ({ organizationId, connectionId }) => {
      // Deleted feeds stay listed (as retired repos) so their old graph claims
      // are retracted. Merely omitting a resource leaves its previous grants
      // live whenever another repository refreshes the same connection.
      const rows = await sql<{ config: Record<string, unknown> | null; deleted_at: unknown }>`
				SELECT config, deleted_at FROM feeds
        WHERE organization_id = ${organizationId} AND connection_id = ${Number(connectionId)}
			`;
      return repoRefsFromFeedConfigs(rows);
    },
    fetchPublicMembers: async ({ organizationId, connectionId, repo }) => {
      const token = await connectionToken(organizationId, connectionId);
      return await isPublicRepository(token, repo) ? publicRepositoryMembers(organizationId) : null;
    },
    fetchCollaborators: async ({ organizationId, connectionId, repo }) => {
      return fetchRepoCollaborators(await connectionToken(organizationId, connectionId), repo);
    },
  };

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const conn of connections) {
    const result = await syncGithubConnectionAcl(deps, {
      connectionId: conn.id,
      organizationId: conn.organization_id,
    });
    if (result.ok) ok += 1;
    // A skip means another sync of this connection is in flight and will
    // publish; counting it as failed would make an overlapping tick look like
    // an outage.
    else if (result.skipped) skipped += 1;
    else failed += 1;
  }
  logger.info('GitHub ACL sync tick complete', {
    connections: connections.length,
    ok,
    failed,
    skipped,
  });
}

/** ACL reads spend the SAME connection authority as feed reads — never an
 * arbitrary org App installation, which would ignore OAuth/PAT connections and
 * could carry a different installation's repository scope. The shared resolver
 * keeps App precedence, refresh, managed grants and tenant binding in one place. */
async function resolveGithubConnectionToken(
  organizationId: string,
  connectionId: string,
): Promise<string | null> {
  const sql = getDb();
  const [connection] = await sql<{
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
    config: Record<string, unknown> | null;
  }>`
    SELECT auth_profile_id, app_auth_profile_id, config FROM connections
    WHERE id = ${Number(connectionId)} AND organization_id = ${organizationId}
      AND connector_key = 'github' AND status = 'active' AND deleted_at IS NULL
  `;
  if (!connection) return null;
  const { credentials, connectionCredentials } = await resolveExecutionAuth({
    organizationId,
    connectionId: Number(connectionId),
    authProfileId: connection.auth_profile_id,
    appAuthProfileId: connection.app_auth_profile_id,
    credentialDb: sql,
    logMessage: 'Failed to resolve GitHub ACL credentials',
  });
  return resolveGithubToken(
    credentials?.accessToken,
    mergeExecutionConfig(connection.config, connectionCredentials),
  );
}
