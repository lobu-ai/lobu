/**
 * GitHub connector identity namespaces and normalization.
 *
 * Single source of truth for github_login / github_user_id / github_repo_* rules
 * and the connection's token precedence. The connector, app-webhook actor
 * resolution, repo ACL graph and sync, and server entity-link ingestion all
 * import from here — not from connector-sdk.
 */

import type {
  AccessMember,
  AccessResource,
  AclSourceDef,
} from '@lobu/connector-sdk';
import type { ConnectorIdentityModule } from './connector-identity-module.js';

/** Connector-owned identity namespaces (not SDK-global). */
export const GITHUB_IDENTITY = {
  USER_ID: 'github_user_id',
  LOGIN: 'github_login',
  REPO_ID: 'github_repo_id',
  REPO_FULL_NAME: 'github_repo_full_name',
} as const;

export type GithubIdentityNamespace =
  (typeof GITHUB_IDENTITY)[keyof typeof GITHUB_IDENTITY];

export function normalizeGithubLogin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeNumericId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return trimmed.replace(/^0+(?=\d)/, '');
}

export function normalizeGithubRepoFullName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  const githubName = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
  if (!githubName.test(owner) || !githubName.test(repo)) return null;
  return `${owner}/${repo}`;
}

/**
 * Normalize a GitHub identity namespace value. Returns `undefined` when the
 * namespace is not GitHub-owned (caller should fall back to generic hygiene).
 */
export function normalizeGithubIdentityValue(
  namespace: string,
  raw: string,
): string | null | undefined {
  switch (namespace) {
    case GITHUB_IDENTITY.LOGIN:
      return normalizeGithubLogin(raw);
    case GITHUB_IDENTITY.USER_ID:
    case GITHUB_IDENTITY.REPO_ID:
      return normalizeNumericId(raw);
    case GITHUB_IDENTITY.REPO_FULL_NAME:
      return normalizeGithubRepoFullName(raw);
    default:
      return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * The token a GitHub connection authorizes: the resolved OAuth / App access
 * token first, then a configured `GITHUB_TOKEN` PAT. The connector runtime and
 * the server's repo ACL sync both resolve through this, so they spend the same
 * authority.
 */
export function resolveGithubToken(
  accessToken: string | undefined,
  config: { env_overrides?: Record<string, unknown> },
): string | null {
  const fields = config as Record<string, unknown>;
  return (
    nonEmptyString(accessToken) ??
    nonEmptyString(config.env_overrides?.GITHUB_TOKEN) ??
    nonEmptyString(fields.GITHUB_TOKEN) ??
    nonEmptyString(fields.github_token) ??
    null
  );
}

/** Stable `github_user_id:ID` / `github_login:login` key used by poll + webhooks. */
export function githubUserIdentityKey(params: {
  userId?: string | number | null;
  login: string;
}): string {
  const normalizedLogin =
    normalizeGithubLogin(params.login) ?? params.login.toLowerCase();
  if (params.userId != null && String(params.userId).length > 0) {
    return `${GITHUB_IDENTITY.USER_ID}:${params.userId}`;
  }
  return `${GITHUB_IDENTITY.LOGIN}:${normalizedLogin}`;
}

/** Sanitize an identity key for inclusion in `origin_id` (connector + webhook). */
export function githubKeyForOriginId(key: string): string {
  return key.replace(/[^a-z0-9]+/gi, '_');
}

/** The GitHub connector's contribution to the server identity wiring. */
export const githubIdentityModule: ConnectorIdentityModule = {
  key: 'github',
  // github_login + github_user_id are recall-indexed
  // (idx_events_metadata_github_login / _github_user_id). The repo_* namespaces
  // are ACL resource keys, not event-recall namespaces.
  recallNamespaces: [GITHUB_IDENTITY.LOGIN, GITHUB_IDENTITY.USER_ID],
  normalize: normalizeGithubIdentityValue,
};

// ── ACL source ────────────────────────────────────────────────────────────
//
// A repo's read audience is its COLLABORATORS. Each repo becomes a `repo`
// entity keyed on its normalized `github_repo_full_name` (`owner/repo`) — the
// same key the connector stamps on ingested data — so the resource gate joins
// an event's repo to these member_of edges. Each collaborator resolves
// identity-first on github_user_id (+ github_login).

/** A repo collaborator as the GitHub collaborators API reports it. */
export interface GithubRepoCollaborator {
  login: string;
  id?: number;
}

/** A repository and the collaborators who may read it. */
export interface GithubRepoInput {
  /** `owner/repo`. */
  fullName: string;
  collaborators: GithubRepoCollaborator[];
}

/** The GitHub connector's ACL-source descriptor. */
export const githubAclSource: AclSourceDef = {
  key: 'github',
  resourceNamespace: GITHUB_IDENTITY.REPO_FULL_NAME,
  memberIdentities: [
    { namespace: GITHUB_IDENTITY.USER_ID, primary: true },
    { namespace: GITHUB_IDENTITY.LOGIN },
  ],
};

/**
 * Normalize GitHub repos + collaborators into engine resources. Each repo keyed
 * on its normalized `owner/repo`; each collaborator claims github_user_id (+
 * github_login). Repos with an unparseable full name, and collaborators with no
 * valid identity, are dropped.
 */
export function githubReposToResources(repos: GithubRepoInput[]): AccessResource[] {
  const resources: AccessResource[] = [];
  for (const repo of repos) {
    const key = normalizeGithubRepoFullName(repo.fullName);
    if (!key) continue;
    const members: AccessMember[] = [];
    for (const c of repo.collaborators) {
      const login = normalizeGithubLogin(c.login);
      const idValue = c.id != null ? normalizeNumericId(String(c.id)) : null;
      const identities: { namespace: string; value: string }[] = [];
      if (idValue) identities.push({ namespace: GITHUB_IDENTITY.USER_ID, value: idValue });
      if (login) identities.push({ namespace: GITHUB_IDENTITY.LOGIN, value: login });
      if (identities.length === 0) continue;
      members.push({ key: idValue ?? (login as string), name: c.login, identities });
    }
    resources.push({ key, name: repo.fullName, members });
  }
  return resources;
}