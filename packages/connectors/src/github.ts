/**
 * GitHub Connector (V1 runtime)
 *
 * Syncs GitHub repository content and executes write actions. Also subscribes
 * to real-time issue/PR/comment deliveries via inbound webhooks (registered at
 * connect time); the raw deliveries are landed downstream (extract-load), so
 * this connector only owns the subscription lifecycle here.
 */

import { randomBytes } from 'node:crypto';
import {
  ACL_RESOURCE_TYPE_SLUG,
  type ActionContext,
  type ActionResult,
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  createHttpClient,
  type EventAttributionRule,
  type EventEnvelope,
  paginateByOffset,
  SubscriptionCandidateSchema,
  type SyncContext,
  type SyncResult,
  type WebhookRegistration,
  type WebhookRegistrationContext,
} from '@lobu/connector-sdk';
import {
  GITHUB_AUTOMATION_EVENTS,
  githubAutomationSignalDrafts,
  githubPullRequestSubscribable,
  githubSyncShouldEmitAutomationSignals,
} from './github-automation-events.js';
import {
  GITHUB_IDENTITY,
  githubKeyForOriginId,
  githubUserIdentityKey,
  normalizeGithubLogin,
  normalizeGithubRepoFullName,
} from './github-identity.js';

type GitHubContentType =
  | 'issues'
  | 'pull_requests'
  | 'issue_comments'
  | 'pr_comments'
  | 'discussions'
  | 'discussion_comments'
  | 'commits'
  | 'stargazers';

interface GitHubConfig {
  repo_owner?: string;
  repo_name?: string;
  /**
   * Org login for org-wide ingestion. When set, webhook registration creates a
   * single ORGANIZATION webhook (`POST /orgs/{org}/hooks`, scope
   * `admin:org_hook`) that delivers events from every repo in the org — instead
   * of a per-repo hook (`admin:repo_hook`). Takes precedence over repo_owner/name.
   */
  org?: string;
  /** Webhook event subscription; defaults to `['*']` (every event type). */
  webhook_events?: string[];
  content_type?: GitHubContentType;
  lookback_days?: number;
  labels_filter?: string[];
  env_overrides?: Record<string, unknown>;
  /**
   * `app_installations.id` when this connection is backed by the Lobu GitHub
   * App (written by the install callback). Its presence — NOT the connector's
   * static `webhook.delivery` — is what marks a connection as app-installation
   * auth: webhook deliveries for those arrive on the shared App-level endpoint,
   * so per-connection registerWebhook/unregisterWebhook are no-ops. OAuth/PAT
   * connections carry no `installation_ref` and DO register per connection.
   */
  installation_ref?: number | string;
}

interface GitHubCheckpoint {
  last_sync_at?: string;
  stargazers?: GitHubStargazerCheckpoint[];
}

interface GitHubStargazerCheckpoint {
  key: string;
  login: string;
  starred_at?: string;
  user_id?: number | null;
  user_type?: string | null;
  html_url?: string | null;
  profile_fetched_at?: string | null;
}

interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * Percent-encode one REST path segment. `encodeURIComponent` passes `.` and
 * `..` through unchanged and URL parsing then resolves them away, so an
 * unchecked `..` still walks the request onto an unrelated endpoint
 * (`/repos/../../user` -> `/user`) — reject those two outright.
 */
function encodeGitHubPathSegment(value: string, label: string): string {
  if (value === '.' || value === '..') {
    throw new Error(`GitHub ${label} is not a valid path segment: "${value}"`);
  }
  return encodeURIComponent(value);
}

function githubRepoApiUrl(repo: RepoRef, suffix = ''): string {
  const owner = encodeGitHubPathSegment(repo.owner, 'repository owner');
  const name = encodeGitHubPathSegment(repo.repo, 'repository name');
  return `https://api.github.com/repos/${owner}/${name}${suffix}`;
}

interface GitHubMutationResponse {
  id: number;
  number: number;
  html_url: string;
  state: string;
  draft?: boolean;
}

interface GitHubRepositoryLike {
  id?: number;
  full_name?: string;
  html_url?: string;
}

interface GitHubIssueLike {
  id: number;
  number: number;
  title: string;
  body: string | null;
  user?: { login?: string; id?: number };
  html_url: string;
  created_at: string;
  updated_at: string;
  state: string;
  labels?: Array<{ name?: string }>;
  comments?: number;
  reactions?: { '+1'?: number; '-1'?: number; total_count?: number };
  pull_request?: Record<string, unknown>;
}

interface GitHubCommentLike {
  id: number;
  body: string;
  user?: { login?: string; id?: number };
  html_url: string;
  issue_url?: string;
  pull_request_url?: string;
  created_at: string;
  updated_at: string;
  reactions?: { '+1'?: number; '-1'?: number; total_count?: number };
}

interface GitHubCommitLike {
  sha: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { name?: string; email?: string; date?: string };
  };
  /** Linked GitHub account for the author — null when the commit email isn't tied to one. */
  author?: { login?: string; id?: number } | null;
  committer?: { login?: string; id?: number } | null;
}

interface GraphQLDiscussionNode {
  id: string;
  number: number;
  title: string;
  body: string;
  author?: { login?: string; databaseId?: number };
  url: string;
  createdAt: string;
  updatedAt: string;
  category?: { name?: string };
  comments?: { totalCount?: number };
  reactions?: { totalCount?: number };
}

interface GraphQLDiscussionCommentNode {
  id: string;
  body: string;
  author?: { login?: string; databaseId?: number };
  url: string;
  createdAt: string;
  updatedAt: string;
  reactions?: { totalCount?: number };
  discussion?: { number?: number };
}

interface GitHubStargazerLike {
  starred_at?: string;
  user?: {
    id?: number;
    login?: string;
    html_url?: string;
    type?: string;
    site_admin?: boolean;
    avatar_url?: string;
  };
  login?: string;
  html_url?: string;
  id?: number;
  type?: string;
  site_admin?: boolean;
  avatar_url?: string;
}

interface GitHubUserProfile {
  id?: number;
  login?: string;
  name?: string | null;
  company?: string | null;
  blog?: string | null;
  location?: string | null;
  email?: string | null;
  bio?: string | null;
  twitter_username?: string | null;
  public_repos?: number;
  public_gists?: number;
  followers?: number;
  following?: number;
  html_url?: string;
  avatar_url?: string;
  type?: string;
  site_admin?: boolean;
  created_at?: string;
  updated_at?: string;
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Coerce a GitHub list response to an array. `http.json()` returns
 * `await response.json()`, which is `null`/`undefined` for an empty-body 200
 * (GitHub occasionally serves these). The list sync paths immediately read
 * `.length` / iterate, so a bare null threw
 * `Cannot read properties of undefined (reading 'length')` and crashed the
 * whole sync (#2033). Treat any non-array response as an empty page.
 */
function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function toIsoOrUndefined(value: unknown): string | undefined {
  const str = asString(value);
  if (!str) return undefined;
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

const REPO_PROPS = {
  repo_owner: { type: 'string', minLength: 1, description: 'Repository owner' },
  repo_name: { type: 'string', minLength: 1, description: 'Repository name' },
} as const;

const LOOKBACK_PROP = {
  lookback_days: {
    type: 'integer',
    minimum: 1,
    maximum: 730,
    default: 365,
    description: 'Initial sync lookback window',
  },
} as const;

const STARGAZER_PROFILE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const STARGAZER_PROFILE_FETCH_LIMIT = 25;

// Bound a single commits sync to 30 pages (3000 commits). Incremental `since`
// keeps steady-state runs tiny; the cap only matters on a cold backfill of a
// busy repo, where the remaining history rides subsequent runs.
const COMMITS_MAX_PAGES = 30;

const LABELS_PROP = {
  labels_filter: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional label filter',
  },
} as const;

/**
 * Person attribution for any authored GitHub event. Attribution is keyed
 * PRIMARY on the immutable numeric `github_user_id` (a renamed login still
 * resolves to the same person) and SECONDARY on `github_login` (the indexed
 * read-time namespace + the human-legible name on auto-create). The ingestion
 * attribution resolver extracts these
 * from `metadata.author_id` / `metadata.author_login` — both stamped by
 * `buildAuthorMetadata` — normalizes them, and looks them up / auto-creates a
 * `person` in the SAME organization (entity_identities are per-org, never
 * cross-tenant). `last_authored_at` tracks the most recent contribution.
 */
const GITHUB_PERSON_ATTRIBUTION: EventAttributionRule = {
  role: 'authored_by',
  autoCreate: true,
  target: {
    entityType: 'person',
    titlePath: 'metadata.author_login',
    identities: [
    // PRIMARY: the immutable numeric id is authoritative — when present it
    // governs resolution, so a renamed-then-reused login can't conflate a new
    // account into the old person (see event-attribution resolver resolution).
    { namespace: GITHUB_IDENTITY.USER_ID, eventPath: 'metadata.author_id', primary: true },
    { namespace: GITHUB_IDENTITY.LOGIN, eventPath: 'metadata.author_login' },
    ],
  },
  traits: {
    github_login: {
      eventPath: 'metadata.author_login',
      mergeStrategy: 'prefer_non_empty',
    },
    last_authored_at: {
      eventPath: 'occurred_at',
      mergeStrategy: 'overwrite',
    },
  },
};

// Link each repo-scoped event to the shared `$resource` entity it belongs to,
// so the authz resource gate can restrict recall to repos the requester is
// `member_of`. Keyed on `github_repo_full_name` to match entities
// `buildGithubRepoGraph` materializes — both sides resolve to ONE entity.
// The full name is stamped on every event in `sync()` (see stampRepoAttribution).
const GITHUB_REPO_ATTRIBUTION: EventAttributionRule = {
  role: 'belongs_to',
  autoCreate: true,
  target: {
    entityType: ACL_RESOURCE_TYPE_SLUG,
    titlePath: 'metadata.github_repo_full_name',
    identities: [
    {
      namespace: GITHUB_IDENTITY.REPO_FULL_NAME,
      eventPath: 'metadata.github_repo_full_name',
      primary: true,
    },
    ],
  },
};

export default class GitHubConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'github',
    name: 'GitHub',
    description: 'Collects GitHub issues/discussions and executes repo actions.',
    version: '1.3.0',
    automationEvents: GITHUB_AUTOMATION_EVENTS,
    faviconDomain: 'github.com',
    // A GitHub connection gives the agent's sandbox an authenticated `gh`.
    // GH_TOKEN is a LEASE: the App installation token is derived per deployment
    // and expires (~1h), so the real value may be injected without ever handing
    // the worker a durable credential. `gh` also shells out to `git` over HTTPS,
    // and both hosts are deny-by-default on the worker proxy without these grants.
    agentTooling: {
      nix: { packages: ['gh'] },
      env: [{ name: 'GH_TOKEN', credential: 'lease' }],
      domains: ['api.github.com', 'github.com'],
    },
    webhook: {
      signatureHeader: 'x-hub-signature-256',
      algorithm: 'sha256',
      signaturePrefix: 'sha256=',
      dedupeHeader: 'x-github-delivery',
      // App-installation delivery: one App-level webhook is configured ONCE on
      // the GitHub App (not per connection), and inbound deliveries route via
      // the shared `/api/v1/app-webhooks/github` endpoint keyed on
      // `installation.id`. In this mode registerWebhook/unregisterWebhook are
      // no-ops (see those methods); per-connection hook creation is the
      // OAuth/PAT fallback path's concern, gated by a configured repo/org target.
      delivery: 'app_installation',
      routingKeyPath: 'installation.id',
    },
    authSchema: {
      // Precedence (design §4.5): app_installation (primary, org-scoped GitHub
      // App) → oauth (user-scoped) → env_keys (deployment GITHUB_TOKEN fallback).
      // The per-org oauth_app-profile requirement no longer applies to GitHub
      // connect because app_installation is available — orgs install the App
      // instead of hand-creating an OAuth app profile.
      methods: [
        {
          type: 'app_installation',
          provider: 'github',
          providerInstance: 'cloud',
          // GitHub App installation handshake (installation_id + ownership
          // verification + repo/team provisioning + user-auth recovery). The
          // generic install engine dispatches on this shape to the github-app
          // route module — never on the `github` name.
          installShape: 'github-app',
          appIdKey: 'GITHUB_APP_ID',
          privateKeyKey: 'GITHUB_APP_PRIVATE_KEY',
          appSlugKey: 'GITHUB_APP_SLUG',
          // The App's OWN OAuth client (used for the user-authorization leg of
          // install / recovery), distinct from the user-login `oauth` method's
          // GITHUB_CLIENT_ID/SECRET below.
          clientIdKey: 'GITHUB_APP_CLIENT_ID',
          clientSecretKey: 'GITHUB_APP_CLIENT_SECRET',
          webhookSecretKey: 'GITHUB_APP_WEBHOOK_SECRET',
          // Install URL for the Lobu GitHub App. `{{app_slug}}` is substituted
          // by the install UI from the configured App slug; the user picks the
          // org/repos to grant during GitHub's install flow.
          installUrlTemplate: 'https://github.com/apps/{{app_slug}}/installations/new',
          // NOTE: this permissions array is METADATA ONLY (declares what the App
          // needs; it does not grant anything). 'members' (Organization → Members:
          // read) is required by the install-callback org-admin check
          // (GET /user/memberships/orgs/{org}). The LIVE GitHub App must ALSO be
          // granted Organization → Members → Read in its settings (out-of-band,
          // user action) or every real org admin's membership lookup 403s.
          permissions: ['issues', 'pull_requests', 'contents', 'metadata', 'discussions', 'members'],
          // Webhook subscriptions the live App must enable. Must cover every
          // event referenced by a feed's `webhook.events` above (push → commits,
          // star/watch → stargazers, pull_request_review_comment → pr_comments),
          // or those feeds get no deliveries and fall back to the schedule.
          events: [
            'issues',
            'pull_request',
            'issue_comment',
            'pull_request_review_comment',
            'discussion',
            'discussion_comment',
            'push',
            'star',
            'watch',
          ],
          required: false,
          description:
            'Install the Lobu GitHub App on your org to grant tenant-scoped access (no per-connection token). Repo/issue/PR reads and write actions flow through the App installation.',
        },
        {
          type: 'oauth',
          provider: 'github',
          requiredScopes: ['read:user'],
          // Webhook scopes are OPTIONAL and requested incrementally — only when
          // the user enables a live feed (repo) or org-wide ingestion (org), not
          // at first connect. `repo` covers reads of private repos.
          optionalScopes: ['repo', 'admin:repo_hook', 'admin:org_hook'],
          loginScopes: ['read:user', 'user:email'],
          clientIdKey: 'GITHUB_CLIENT_ID',
          clientSecretKey: 'GITHUB_CLIENT_SECRET',
          tokenUrl: 'https://github.com/login/oauth/access_token',
          tokenEndpointAuthMethod: 'client_secret_post',
          required: false,
          description:
            'GitHub OAuth enables repo access for this connection. Upgrade to the optional repo scope for private repositories and write actions.',
          loginProvisioning: {
            autoCreateConnection: true,
          },
          setupInstructions:
            'Create a GitHub OAuth App in GitHub Settings > Developer settings > OAuth Apps. Set the authorization callback URL to {{redirect_uri}}, then copy the client ID and client secret below.',
        },
        {
          type: 'env_keys',
          required: false,
          description: 'Optional fallback token for sync/action calls.',
          fields: [
            {
              key: 'GITHUB_TOKEN',
              label: 'GitHub Token',
              description: 'Personal access token used as fallback auth for API requests.',
              secret: true,
            },
          ],
        },
      ],
    },
    feeds: {
      issues: {
        key: 'issues',
        name: 'Issues',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: [],
        description: 'Sync GitHub issues from a repository.',
        displayNameTemplate: '{repo_owner}/{repo_name} issues',
        webhook: { events: ['issues'] },
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LABELS_PROP, ...LOOKBACK_PROP },
        },
        eventKinds: {
          issue: {
            description: 'A GitHub issue',
            metadataSchema: {
              type: 'object',
              properties: {
                number: { type: 'number' },
                state: { type: 'string' },
                labels: { type: 'array', items: { type: 'string' } },
                updated_at: { type: 'string' },
                reactions: { type: 'object' },
                comments: { type: 'number' },
                author_login: { type: 'string' },
                author_id: { type: 'string' },
              },
            },
            attributions: [GITHUB_PERSON_ATTRIBUTION, GITHUB_REPO_ATTRIBUTION],
          },
        },
      },
      pull_requests: {
        key: 'pull_requests',
        name: 'Pull Requests',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: [],
        description: 'Sync GitHub pull requests from a repository.',
        displayNameTemplate: '{repo_owner}/{repo_name} PRs',
        webhook: { events: ['pull_request'] },
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LABELS_PROP, ...LOOKBACK_PROP },
        },
        eventKinds: {
          pull_request: {
            description: 'A GitHub pull request',
            metadataSchema: {
              type: 'object',
              properties: {
                number: { type: 'number' },
                state: { type: 'string' },
                labels: { type: 'array', items: { type: 'string' } },
                updated_at: { type: 'string' },
                reactions: { type: 'object' },
                comments: { type: 'number' },
                author_login: { type: 'string' },
                author_id: { type: 'string' },
              },
            },
            attributions: [GITHUB_PERSON_ATTRIBUTION, GITHUB_REPO_ATTRIBUTION],
          },
        },
      },
      issue_comments: {
        key: 'issue_comments',
        name: 'Issue Comments',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: [],
        description: 'Sync comments on GitHub issues.',
        displayNameTemplate: '{repo_owner}/{repo_name} issue comments',
        webhook: { events: ['issue_comment'] },
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LOOKBACK_PROP },
        },
        eventKinds: {
          issue_comment: {
            description: 'A comment on a GitHub issue',
            metadataSchema: {
              type: 'object',
              properties: {
                updated_at: { type: 'string' },
                reactions: { type: 'object' },
                author_login: { type: 'string' },
                author_id: { type: 'string' },
              },
            },
            attributions: [GITHUB_PERSON_ATTRIBUTION, GITHUB_REPO_ATTRIBUTION],
          },
        },
      },
      pr_comments: {
        key: 'pr_comments',
        name: 'PR Comments',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: [],
        description: 'Sync comments on GitHub pull requests.',
        displayNameTemplate: '{repo_owner}/{repo_name} PR comments',
        webhook: { events: ['pull_request_review_comment'] },
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LOOKBACK_PROP },
        },
        eventKinds: {
          pr_comment: {
            description: 'A comment on a GitHub pull request',
            metadataSchema: {
              type: 'object',
              properties: {
                updated_at: { type: 'string' },
                reactions: { type: 'object' },
                author_login: { type: 'string' },
                author_id: { type: 'string' },
              },
            },
            attributions: [GITHUB_PERSON_ATTRIBUTION, GITHUB_REPO_ATTRIBUTION],
          },
        },
      },
      discussions: {
        key: 'discussions',
        name: 'Discussions',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: [],
        description: 'Sync GitHub discussions from a repository.',
        displayNameTemplate: '{repo_owner}/{repo_name} discussions',
        webhook: { events: ['discussion'] },
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LOOKBACK_PROP },
        },
        eventKinds: {
          discussion: {
            description: 'A GitHub discussion',
            metadataSchema: {
              type: 'object',
              properties: {
                number: { type: 'number' },
                category: { type: 'string' },
                updated_at: { type: 'string' },
                comments: { type: 'number' },
                reactions: { type: 'number' },
                author_login: { type: 'string' },
                author_id: { type: 'string' },
              },
            },
            attributions: [GITHUB_PERSON_ATTRIBUTION, GITHUB_REPO_ATTRIBUTION],
          },
        },
      },
      discussion_comments: {
        key: 'discussion_comments',
        name: 'Discussion Comments',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: [],
        description: 'Sync comments on GitHub discussions.',
        displayNameTemplate: '{repo_owner}/{repo_name} discussion comments',
        webhook: { events: ['discussion_comment'] },
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LOOKBACK_PROP },
        },
        eventKinds: {
          discussion_comment: {
            description: 'A comment on a GitHub discussion',
            metadataSchema: {
              type: 'object',
              properties: {
                discussion_number: { type: 'number' },
                updated_at: { type: 'string' },
                reactions: { type: 'number' },
                author_login: { type: 'string' },
                author_id: { type: 'string' },
              },
            },
            attributions: [GITHUB_PERSON_ATTRIBUTION, GITHUB_REPO_ATTRIBUTION],
          },
        },
      },
      commits: {
        key: 'commits',
        name: 'Commits',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: [],
        description: 'Sync commits pushed to a repository, attributed to their authors.',
        displayNameTemplate: '{repo_owner}/{repo_name} commits',
        webhook: { events: ['push'] },
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LOOKBACK_PROP },
        },
        eventKinds: {
          commit: {
            description: 'A commit was authored in the repository',
            metadataSchema: {
              type: 'object',
              properties: {
                sha: { type: 'string' },
                author_date: { type: 'string' },
                committed_at: { type: 'string' },
                author_email: { type: 'string' },
                author_login: { type: 'string' },
                author_id: { type: 'string' },
              },
            },
            attributions: [GITHUB_PERSON_ATTRIBUTION, GITHUB_REPO_ATTRIBUTION],
          },
        },
      },
      stargazers: {
        key: 'stargazers',
        name: 'Stargazers',
        sync: (ctx) => this.syncFeed(ctx),
        requiredScopes: [],
        description: 'Sync GitHub users who starred a repository.',
        displayNameTemplate: '{repo_owner}/{repo_name} stargazers',
        webhook: { events: ['star', 'watch'], mode: 'store' },
        configSchema: {
          type: 'object',
          required: ['repo_owner', 'repo_name'],
          properties: { ...REPO_PROPS, ...LOOKBACK_PROP },
        },
        eventKinds: {
          stargazer: {
            description: 'A GitHub user starred the repository',
            metadataSchema: {
              type: 'object',
              properties: {
                actor: { type: 'object' },
                target: { type: 'object' },
                action: { type: 'string' },
                starred_at: { type: 'string' },
                source: { type: 'string' },
                author_login: { type: 'string' },
                author_id: { type: 'string' },
              },
            },
            attributions: [GITHUB_PERSON_ATTRIBUTION, GITHUB_REPO_ATTRIBUTION],
          },
          stargazer_unstarred: {
            description: 'A GitHub user unstarred the repository',
            metadataSchema: {
              type: 'object',
              properties: {
                actor: { type: 'object' },
                target: { type: 'object' },
                action: { type: 'string' },
                starred_at: { type: 'string' },
                unstarred_at: { type: 'string' },
                unstarred_at_is_inferred: { type: 'boolean' },
                source: { type: 'string' },
              },
            },
            // Repo-scoped: link to the repo so the ACL gate treats it like every
            // other repo event (visible to collaborators) instead of dropping it
            // — these kinds have no person link of their own.
            attributions: [GITHUB_REPO_ATTRIBUTION],
          },
          stargazer_profile: {
            description: 'A public GitHub profile observation for a stargazer',
            metadataSchema: {
              type: 'object',
              properties: {
                public_identity_profile: { type: 'boolean' },
                provider: { type: 'string' },
                identities: { type: 'array' },
                account: { type: 'object' },
              },
            },
            attributions: [GITHUB_REPO_ATTRIBUTION],
          },
        },
      },
    },
    actions: {
      create_issue: {
        key: 'create_issue',
        name: 'Create Issue',
        description: 'Create a new issue in the configured repository.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            assignees: { type: 'array', items: { type: 'string' } },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
      add_issue_comment: {
        key: 'add_issue_comment',
        name: 'Add Issue Comment',
        description: 'Add a comment to an issue or pull request.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['issue_number', 'body'],
          properties: {
            issue_number: { type: 'integer' },
            body: { type: 'string' },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
      close_issue: {
        key: 'close_issue',
        name: 'Close Issue',
        description: 'Close an issue by number.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['issue_number'],
          properties: {
            issue_number: { type: 'integer' },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
      reopen_issue: {
        key: 'reopen_issue',
        name: 'Reopen Issue',
        description: 'Reopen an issue by number.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['issue_number'],
          properties: {
            issue_number: { type: 'integer' },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
      create_pull_request: {
        key: 'create_pull_request',
        name: 'Create Pull Request',
        description: 'Create a pull request from head to base branch.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['title', 'head', 'base'],
          properties: {
            title: { type: 'string' },
            head: { type: 'string' },
            base: { type: 'string' },
            body: { type: 'string' },
            draft: { type: 'boolean' },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
        outputSchema: {
          type: 'object',
          required: [
            'pull_request_id',
            'pull_number',
            'url',
            'state',
            'draft',
            'subscribable',
          ],
          properties: {
            pull_request_id: { type: 'integer' },
            pull_number: { type: 'integer' },
            url: { type: 'string' },
            state: { type: 'string' },
            draft: { type: 'boolean' },
            subscribable: SubscriptionCandidateSchema,
          },
        },
      },
      merge_pull_request: {
        key: 'merge_pull_request',
        name: 'Merge Pull Request',
        description: 'Merge a pull request by number.',
        requiresApproval: true,
        annotations: {
          destructiveHint: true,
        },
        inputSchema: {
          type: 'object',
          required: ['pull_number'],
          properties: {
            pull_number: { type: 'integer' },
            merge_method: {
              type: 'string',
              enum: ['merge', 'squash', 'rebase'],
            },
            commit_title: { type: 'string' },
            commit_message: { type: 'string' },
            repo_owner: { type: 'string' },
            repo_name: { type: 'string' },
          },
        },
      },
    },
  };

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as GitHubConfig;
    const repo = this.resolveRepo(config, {});
    const token = this.resolveToken(ctx.credentials?.accessToken, config);
    const contentType = (ctx.feedKey ?? 'issues') as GitHubContentType;
    // Cold start / checkpoint reset: resolveSince falls back to lookback_days
    // (default 365). Every PR in that window is first-seen and would flood
    // pull_request.created Automation activations. Only attach automation_signals
    // once a prior last_sync_at exists (steady-state delta).
    const attachAutomationSignals = githubSyncShouldEmitAutomationSignals(
      ctx.checkpoint as GitHubCheckpoint | null,
    );
    const sinceIso = this.resolveSince(ctx.checkpoint, config.lookback_days ?? 365);

    if (contentType === 'stargazers') {
      const result = await this.syncStargazers(repo, ctx.checkpoint, token);
      this.stampRepoAttribution(result.events, repo, { attachAutomationSignals });
      return {
        events: result.events,
        checkpoint: {
          last_sync_at: new Date().toISOString(),
          stargazers: result.currentStargazers,
        } as Record<string, unknown>,
        metadata: {
          items_found: result.events.length,
          current_stargazers: result.currentStargazers.length,
        },
      };
    }

    const events = await this.syncContent({
      repo,
      contentType,
      sinceIso,
      labelsFilter: config.labels_filter ?? [],
      token,
    });
    this.stampRepoAttribution(events, repo, { attachAutomationSignals });

    return {
      events,
      checkpoint: {
        last_sync_at: new Date().toISOString(),
      } as Record<string, unknown>,
      metadata: {
        items_found: events.length,
      },
    };
  }

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      const config = ctx.config as GitHubConfig;
      const repo = this.resolveRepo(config, ctx.input);
      const token = this.resolveToken(ctx.credentials?.accessToken, config);

      if (!token) {
        return { success: false, error: 'GitHub action requires OAuth or GITHUB_TOKEN.' };
      }

      switch (ctx.actionKey) {
        case 'create_issue':
          return await this.createIssue(repo, token, ctx.input);
        case 'add_issue_comment':
          return await this.addIssueComment(repo, token, ctx.input);
        case 'close_issue':
          return await this.updateIssueState(repo, token, ctx.input, 'closed');
        case 'reopen_issue':
          return await this.updateIssueState(repo, token, ctx.input, 'open');
        case 'create_pull_request':
          return await this.createPullRequest(repo, token, ctx.input);
        case 'merge_pull_request':
          return await this.mergePullRequest(repo, token, ctx.input);
        default:
          return { success: false, error: `Unknown action: ${ctx.actionKey}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Webhooks (subscription lifecycle — raw deliveries land downstream)
  // -------------------------------------------------------------------------

  /**
   * GitHub hooks collection URL for this config: an ORGANIZATION webhook
   * (`/orgs/{org}/hooks`, covers every repo, scope admin:org_hook) when `org`
   * is set, else a per-repo hook (`/repos/{owner}/{name}/hooks`, scope
   * admin:repo_hook). Null when neither target is configured.
   */
  private hooksApiUrl(config: GitHubConfig): string | null {
    if (config.org) {
      const org = encodeGitHubPathSegment(config.org, 'organization');
      return `https://api.github.com/orgs/${org}/hooks`;
    }
    if (config.repo_owner && config.repo_name) {
      return githubRepoApiUrl({ owner: config.repo_owner, repo: config.repo_name }, '/hooks');
    }
    return null;
  }

  /**
   * Whether THIS connection resolves to GitHub App-installation auth — i.e. it
   * was bound to an install row (`config.installation_ref`) or the gateway
   * stamped an installation context onto the registration call. Gating the
   * webhook no-op on this (not the connector's static `webhook.delivery`) is
   * what keeps per-connection webhook registration working for the OAuth/PAT
   * connections, which carry no installation_ref. App-backed connections get
   * deliveries on the shared App-level endpoint instead, so there's no
   * per-connection hook to create or tear down.
   */
  private isAppInstallationConnection(
    ctx: WebhookRegistrationContext<GitHubConfig>
  ): boolean {
    if (ctx.installation) return true;
    const ref = ctx.config?.installation_ref;
    if (typeof ref === 'number') return Number.isFinite(ref);
    if (typeof ref === 'string') return ref.trim().length > 0;
    return false;
  }

  async registerWebhook(
    ctx: WebhookRegistrationContext<GitHubConfig>
  ): Promise<WebhookRegistration> {
    // App-installation auth: the App-level webhook is provisioned once at install
    // time, not per connection — so register is a no-op FOR THIS CONNECTION. Gate
    // on the connection's resolved auth (installation_ref / installation ctx), NOT
    // the connector's static webhook.delivery, so OAuth/PAT connections still
    // register their own per-connection hook below.
    if (this.isAppInstallationConnection(ctx)) {
      return { externalId: '', metadata: { delivery: 'app_installation', noop: true } };
    }

    const token = this.resolveToken(ctx.credentials?.accessToken, ctx.config);
    if (!token) {
      throw new Error('GitHub webhook registration requires OAuth or GITHUB_TOKEN.');
    }

    const hooksUrl = this.hooksApiUrl(ctx.config);
    if (!hooksUrl) {
      throw new Error(
        'GitHub webhook registration requires `org` (org-wide) or repo_owner/repo_name (single repo) in config.',
      );
    }

    const secret = randomBytes(32).toString('hex');

    const hook = await this.requestJson<{ id: number }>({
      method: 'POST',
      url: hooksUrl,
      token,
      body: {
        name: 'web',
        active: true,
        // Subscribe to EVERY event type (extract-load: land it all raw, filter
        // downstream). Org-wide this captures pushes, PRs, issues, comments,
        // releases, CI runs, stars, membership changes, etc. across all repos.
        // Override with config.webhook_events for a narrower subscription.
        events: ctx.config.webhook_events ?? ['*'],
        config: {
          url: ctx.callbackUrl,
          content_type: 'json',
          secret,
        },
      },
    });

    return { externalId: String(hook.id), secret, metadata: { scope: ctx.config.org ? 'org' : 'repo' } };
  }

  async unregisterWebhook(ctx: WebhookRegistrationContext<GitHubConfig>): Promise<void> {
    // App-installation auth: nothing to tear down per connection — the App-level
    // webhook is removed when the org uninstalls the App, not here. Gate on this
    // connection's resolved auth, NOT the static webhook.delivery, so OAuth/PAT
    // connections still tear down their own per-connection hook below.
    if (this.isAppInstallationConnection(ctx)) return;

    const externalId = ctx.externalId;
    if (!externalId) return;

    const token = this.resolveToken(ctx.credentials?.accessToken, ctx.config);
    if (!token) return;

    const base = this.hooksApiUrl(ctx.config);
    if (!base) return;
    const hookUrl = `${base}/${encodeGitHubPathSegment(externalId, 'webhook id')}`;

    // DELETE returns 204 No Content — use request() (no JSON parse) so an empty
    // body doesn't throw.
    await this.http.request(hookUrl, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
      },
    });
  }

  private resolveRepo(config: GitHubConfig, input: Record<string, unknown>): RepoRef {
    const owner = asString(input.repo_owner) ?? config.repo_owner;
    const repo = asString(input.repo_name) ?? config.repo_name;

    if (!owner || !repo) {
      throw new Error(
        'Repository is not configured. Provide repo_owner/repo_name in connection config or action input.'
      );
    }

    return { owner, repo };
  }

  private resolveToken(oauthToken: string | undefined, config: GitHubConfig): string | null {
    if (oauthToken && oauthToken.trim().length > 0) {
      return oauthToken;
    }

    const envOverrides = config.env_overrides ?? {};
    const configuredToken =
      asString(envOverrides.GITHUB_TOKEN) ??
      asString((config as Record<string, unknown>).GITHUB_TOKEN) ??
      asString((config as Record<string, unknown>).github_token);

    return configuredToken ?? null;
  }

  private resolveSince(checkpoint: Record<string, unknown> | null, lookbackDays: number): string {
    const cp = (checkpoint ?? {}) as GitHubCheckpoint;
    const fromCheckpoint = toIsoOrUndefined(cp.last_sync_at);
    if (fromCheckpoint) return fromCheckpoint;

    const fallback = new Date();
    fallback.setDate(fallback.getDate() - lookbackDays);
    return fallback.toISOString();
  }

  /**
   * Stamp `metadata.github_repo_full_name` (lowercased `owner/repo`) on every
   * event so the authz resource gate can link it to its `repo` entity (via
   * GITHUB_REPO_ENTITY_LINK) and restrict recall to repos the requester belongs
   * to. Normalized to match the repo graph ACL keys.
   */
  private stampRepoAttribution(
    events: EventEnvelope[],
    repo: RepoRef,
    options?: { attachAutomationSignals?: boolean },
  ): void {
    const fullName =
      normalizeGithubRepoFullName(`${repo.owner}/${repo.repo}`) ??
      `${repo.owner}/${repo.repo}`.toLowerCase();
    const attachAutomationSignals = options?.attachAutomationSignals !== false;
    for (const event of events) {
      event.metadata = {
        ...(event.metadata ?? {}),
        github_repo_full_name: fullName,
      };
      if (!attachAutomationSignals) continue;
      const automationSignals = githubAutomationSignalDrafts(event);
      if (automationSignals.length > 0) event.automation_signals = automationSignals;
    }
  }

  private async syncContent(params: {
    repo: RepoRef;
    contentType: Exclude<GitHubContentType, 'stargazers'>;
    sinceIso: string;
    labelsFilter: string[];
    token: string | null;
  }): Promise<EventEnvelope[]> {
    const { repo, contentType, sinceIso, labelsFilter, token } = params;

    switch (contentType) {
      case 'issues':
      case 'pull_requests':
        return await this.syncIssuesAndPulls(repo, contentType, sinceIso, labelsFilter, token);
      case 'issue_comments':
        return await this.syncIssueComments(repo, sinceIso, token);
      case 'pr_comments':
        return await this.syncPullRequestComments(repo, sinceIso, token);
      case 'discussions':
        return await this.syncDiscussions(repo, sinceIso, token);
      case 'discussion_comments':
        return await this.syncDiscussionComments(repo, sinceIso, token);
      case 'commits':
        return await this.syncCommits(repo, sinceIso, token);
    }
  }

  private async syncCommits(
    repo: RepoRef,
    sinceIso: string,
    token: string | null
  ): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = [];

    // Commits are durable and fully queryable, so polling recovers the complete
    // "who committed when" history — no webhook dependency. `since` filters by
    // commit date for incremental syncs; pagination is bounded so one run can't
    // walk an unbounded history (deeper backfill rides subsequent runs).
    const pages = paginateByOffset<GitHubCommitLike>(
      async (offset, pageSize) => {
        const query = new URLSearchParams({
          per_page: String(pageSize),
          page: String(offset / pageSize + 1),
          since: sinceIso,
        });
        const url = `${githubRepoApiUrl(repo, '/commits')}?${query.toString()}`;
        const commits = asArray(
          await this.requestJson<GitHubCommitLike[]>({ url, token })
        );
        return { items: commits, hasMore: commits.length === pageSize };
      },
      { pageSize: 100, maxPages: COMMITS_MAX_PAGES }
    );

    for await (const commits of pages) {
      for (const commit of commits) {
        if (!commit.sha) continue;
        const authoredAtIso = commit.commit?.author?.date;
        const authoredAt = authoredAtIso ? new Date(authoredAtIso) : null;
        if (!authoredAt || Number.isNaN(authoredAt.getTime())) continue;

        const message = commit.commit?.message ?? '';
        const firstLine = message.split('\n', 1)[0].slice(0, 500);

        events.push({
          // Stable per-commit id (sha is globally unique) so re-syncs dedupe and
          // a webhook trigger that re-polls supersedes rather than duplicates.
          origin_id: `commit_${repo.owner}_${repo.repo}_${commit.sha}`,
          title: firstLine || commit.sha.slice(0, 7),
          payload_text: message.trim(),
          // Prefer the linked GitHub login; fall back to the git author name when
          // the commit email isn't tied to a GitHub account.
          author_name: commit.author?.login ?? commit.commit?.author?.name,
          source_url: commit.html_url,
          occurred_at: authoredAt,
          origin_type: 'commit',
          metadata: {
            sha: commit.sha,
            author_date: authoredAtIso,
            committed_at: commit.commit?.committer?.date ?? authoredAtIso,
            author_email: commit.commit?.author?.email ?? null,
            // Attribute to a person entity via the linked GitHub account (login +
            // immutable id). Absent for unlinked-email commits — author_name still
            // carries the git author.
            ...this.buildAuthorMetadata(commit.author),
          },
        });
      }
    }

    return events;
  }

  private async syncIssuesAndPulls(
    repo: RepoRef,
    contentType: 'issues' | 'pull_requests',
    sinceIso: string,
    labelsFilter: string[],
    token: string | null
  ): Promise<EventEnvelope[]> {
    const query = new URLSearchParams({
      state: 'all',
      per_page: '100',
      sort: 'updated',
      direction: 'desc',
      since: sinceIso,
    });
    if (labelsFilter.length > 0) {
      query.set('labels', labelsFilter.join(','));
    }

    const url = `${githubRepoApiUrl(repo, '/issues')}?${query.toString()}`;
    const items = asArray(await this.requestJson<GitHubIssueLike[]>({ url, token }));
    const events: EventEnvelope[] = [];

    for (const item of items) {
      const isPR = !!item.pull_request;
      if (contentType === 'issues' && isPR) continue;
      if (contentType === 'pull_requests' && !isPR) continue;

      const createdAt = new Date(item.created_at);
      if (Number.isNaN(createdAt.getTime())) continue;

      const score = toInt(item.reactions?.total_count, 0) + toInt(item.comments, 0);
      const labels = Array.isArray(item.labels)
        ? item.labels.map((label) => label.name).filter((v): v is string => !!v)
        : [];

      events.push({
        origin_id: `${isPR ? 'pr' : 'issue'}_${repo.owner}_${repo.repo}_${item.number}`,
        title: item.title,
        payload_text: (item.body ?? '').trim(),
        author_name: item.user?.login,
        source_url: item.html_url,
        occurred_at: createdAt,
        origin_type: isPR ? 'pull_request' : 'issue',
        score,
        metadata: {
          number: item.number,
          state: item.state,
          labels,
          updated_at: item.updated_at,
          reactions: item.reactions ?? {},
          comments: item.comments ?? 0,
          ...this.buildAuthorMetadata(item.user),
        },
      });
    }

    return events;
  }

  private async syncIssueComments(
    repo: RepoRef,
    sinceIso: string,
    token: string | null
  ): Promise<EventEnvelope[]> {
    const query = new URLSearchParams({
      per_page: '100',
      sort: 'updated',
      direction: 'desc',
      since: sinceIso,
    });
    const url = `${githubRepoApiUrl(repo, '/issues/comments')}?${query.toString()}`;
    const comments = asArray(
      await this.requestJson<GitHubCommentLike[]>({ url, token })
    );

    return comments
      .map((comment): EventEnvelope | null => {
        const createdAt = new Date(comment.created_at);
        if (Number.isNaN(createdAt.getTime())) return null;
        if (!comment.body) return null;

        const issueNumber = comment.issue_url?.match(/\/issues\/(\d+)$/)?.[1];
        return {
          origin_id: `issue_comment_${repo.owner}_${repo.repo}_${comment.id}`,
          payload_text: comment.body,
          author_name: comment.user?.login,
          source_url: comment.html_url,
          occurred_at: createdAt,
          origin_type: 'issue_comment',
          score: toInt(comment.reactions?.total_count, 0),
          origin_parent_id: issueNumber
            ? `issue_${repo.owner}_${repo.repo}_${issueNumber}`
            : undefined,
          metadata: {
            updated_at: comment.updated_at,
            reactions: comment.reactions ?? {},
            ...this.buildAuthorMetadata(comment.user),
          },
        };
      })
      .filter((value): value is EventEnvelope => value !== null);
  }

  private async syncPullRequestComments(
    repo: RepoRef,
    sinceIso: string,
    token: string | null
  ): Promise<EventEnvelope[]> {
    const query = new URLSearchParams({
      per_page: '100',
      sort: 'updated',
      direction: 'desc',
      since: sinceIso,
    });
    const url = `${githubRepoApiUrl(repo, '/pulls/comments')}?${query.toString()}`;
    const comments = asArray(
      await this.requestJson<GitHubCommentLike[]>({ url, token })
    );

    return comments
      .map((comment): EventEnvelope | null => {
        const createdAt = new Date(comment.created_at);
        if (Number.isNaN(createdAt.getTime())) return null;
        if (!comment.body) return null;

        const prNumber = comment.pull_request_url?.match(/\/pulls\/(\d+)$/)?.[1];
        return {
          origin_id: `pr_comment_${repo.owner}_${repo.repo}_${comment.id}`,
          payload_text: comment.body,
          author_name: comment.user?.login,
          source_url: comment.html_url,
          occurred_at: createdAt,
          origin_type: 'pr_comment',
          score: toInt(comment.reactions?.total_count, 0),
          origin_parent_id: prNumber ? `pr_${repo.owner}_${repo.repo}_${prNumber}` : undefined,
          metadata: {
            updated_at: comment.updated_at,
            reactions: comment.reactions ?? {},
            repository: `${repo.owner}/${repo.repo}`,
            pull_number: prNumber ? Number(prNumber) : undefined,
            ...this.buildAuthorMetadata(comment.user),
          },
        };
      })
      .filter((value): value is EventEnvelope => value !== null);
  }

  private async syncDiscussions(
    repo: RepoRef,
    sinceIso: string,
    token: string | null
  ): Promise<EventEnvelope[]> {
    const query = `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          discussions(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              id
              number
              title
              body
              author { login ... on User { databaseId } }
              url
              createdAt
              updatedAt
              category { name }
              comments { totalCount }
              reactions { totalCount }
            }
          }
        }
      }
    `;

    const response = await this.requestGraphQL<{
      data?: {
        repository?: {
          discussions?: { nodes?: GraphQLDiscussionNode[] };
        };
      };
    }>({
      token,
      query,
      variables: { owner: repo.owner, repo: repo.repo },
    });

    const discussions = response.data?.repository?.discussions?.nodes ?? [];
    const since = new Date(sinceIso).getTime();

    return discussions
      .map((discussion): EventEnvelope | null => {
        const createdAt = new Date(discussion.createdAt);
        const updatedAt = new Date(discussion.updatedAt).getTime();
        if (Number.isNaN(createdAt.getTime())) return null;
        if (!Number.isNaN(since) && updatedAt < since) return null;

        return {
          origin_id: `discussion_${repo.owner}_${repo.repo}_${discussion.number}`,
          title: discussion.title,
          payload_text: (discussion.body ?? '').trim(),
          author_name: discussion.author?.login,
          source_url: discussion.url,
          occurred_at: createdAt,
          origin_type: 'discussion',
          score:
            toInt(discussion.reactions?.totalCount, 0) + toInt(discussion.comments?.totalCount, 0),
          metadata: {
            number: discussion.number,
            category: discussion.category?.name ?? null,
            updated_at: discussion.updatedAt,
            comments: discussion.comments?.totalCount ?? 0,
            reactions: discussion.reactions?.totalCount ?? 0,
            ...this.buildGraphQLAuthorMetadata(discussion.author),
          },
        };
      })
      .filter((value): value is EventEnvelope => value !== null);
  }

  private async syncDiscussionComments(
    repo: RepoRef,
    sinceIso: string,
    token: string | null
  ): Promise<EventEnvelope[]> {
    const query = `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          discussions(first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              number
              comments(first: 50) {
                nodes {
                  id
                  body
                  url
                  createdAt
                  updatedAt
                  author { login ... on User { databaseId } }
                  reactions { totalCount }
                }
              }
            }
          }
        }
      }
    `;

    const response = await this.requestGraphQL<{
      data?: {
        repository?: {
          discussions?: {
            nodes?: Array<{
              number: number;
              comments?: { nodes?: Array<Omit<GraphQLDiscussionCommentNode, 'discussion'>> };
            }>;
          };
        };
      };
    }>({
      token,
      query,
      variables: { owner: repo.owner, repo: repo.repo },
    });

    const discussions = response.data?.repository?.discussions?.nodes ?? [];
    const since = new Date(sinceIso).getTime();
    const result: EventEnvelope[] = [];

    for (const discussion of discussions) {
      const comments = discussion.comments?.nodes ?? [];
      for (const comment of comments) {
        const createdAt = new Date(comment.createdAt);
        const updatedAt = new Date(comment.updatedAt).getTime();
        if (Number.isNaN(createdAt.getTime())) continue;
        if (!Number.isNaN(since) && updatedAt < since) continue;
        if (!comment.body?.trim()) continue;

        result.push({
          origin_id: `discussion_comment_${repo.owner}_${repo.repo}_${comment.id}`,
          payload_text: comment.body.trim(),
          author_name: comment.author?.login,
          source_url: comment.url,
          occurred_at: createdAt,
          origin_type: 'discussion_comment',
          score: toInt(comment.reactions?.totalCount, 0),
          origin_parent_id: `discussion_${repo.owner}_${repo.repo}_${discussion.number}`,
          metadata: {
            discussion_number: discussion.number,
            updated_at: comment.updatedAt,
            reactions: comment.reactions?.totalCount ?? 0,
            ...this.buildGraphQLAuthorMetadata(comment.author),
          },
        });
      }
    }

    return result;
  }

  private async syncStargazers(
    repo: RepoRef,
    checkpoint: Record<string, unknown> | null,
    token: string | null
  ): Promise<{ events: EventEnvelope[]; currentStargazers: GitHubStargazerCheckpoint[] }> {
    const previous = this.parseStargazerCheckpoint(checkpoint);
    const previousByKey = new Map(previous.map((stargazer) => [stargazer.key, stargazer]));
    const currentStargazers: GitHubStargazerCheckpoint[] = [];
    const events: EventEnvelope[] = [];
    const now = new Date();
    const repoInfo = await this.fetchRepository(repo, token);
    const target = this.buildRepoTarget(repo, repoInfo);
    let remainingProfileFetches = STARGAZER_PROFILE_FETCH_LIMIT;

    const pages = paginateByOffset<GitHubStargazerLike>(
      async (offset, pageSize) => {
        const query = new URLSearchParams({
          per_page: String(pageSize),
          page: String(offset / pageSize + 1),
        });
        const url = `${githubRepoApiUrl(repo, '/stargazers')}?${query.toString()}`;
        const stargazers = asArray(
          await this.requestJson<GitHubStargazerLike[]>({
            url,
            token,
            accept: 'application/vnd.github.star+json',
          })
        );
        return { items: stargazers, hasMore: stargazers.length === pageSize };
      },
      { pageSize: 100 }
    );

    for await (const stargazers of pages) {
      for (const stargazer of stargazers) {
        const user = stargazer.user ?? stargazer;
        const login = user.login;
        if (!login) continue;

        const key = githubUserIdentityKey({ userId: user.id, login });
        const starredAtIso = toIsoOrUndefined(stargazer.starred_at) ?? now.toISOString();
        const starredAt = new Date(starredAtIso);
        if (Number.isNaN(starredAt.getTime())) continue;

        const previousStargazer = previousByKey.get(key);
        const shouldRefreshProfile = this.shouldRefreshStargazerProfile(previousStargazer, now);
        const profileFetchedAt = shouldRefreshProfile && remainingProfileFetches > 0
          ? await this.enqueueStargazerProfileEvent({
              events,
              login,
              token,
              fallback: user,
              fetchedAt: now,
            })
          : (previousStargazer?.profile_fetched_at ?? null);
        if (shouldRefreshProfile && remainingProfileFetches > 0) remainingProfileFetches -= 1;

        currentStargazers.push({
          key,
          login,
          starred_at: starredAt.toISOString(),
          user_id: user.id ?? previousStargazer?.user_id ?? null,
          user_type: user.type ?? previousStargazer?.user_type ?? null,
          html_url: user.html_url ?? previousStargazer?.html_url ?? `https://github.com/${login}`,
          profile_fetched_at: profileFetchedAt,
        });

        if (!previousStargazer) {
          events.push({
            origin_id: `stargazer_${repo.owner}_${repo.repo}_${githubKeyForOriginId(key)}`,
            title: `${login} starred ${repo.owner}/${repo.repo}`,
            payload_text: `${login} starred ${repo.owner}/${repo.repo}.`,
            author_name: login,
            source_url: user.html_url ?? `https://github.com/${login}`,
            occurred_at: starredAt,
            origin_type: 'stargazer',
            score: 1,
            metadata: {
              actor: this.buildActor(user, login),
              target,
              action: 'starred',
              starred_at: starredAt.toISOString(),
              source: 'github_stargazers_snapshot',
              ...this.buildAuthorMetadata({ login, id: user.id }),
            },
          });
        }
      }
    }

    const currentKeys = new Set(currentStargazers.map((stargazer) => stargazer.key));
    for (const previousStargazer of previous) {
      if (currentKeys.has(previousStargazer.key)) continue;

      events.push({
        origin_id: `stargazer_unstarred_${repo.owner}_${repo.repo}_${githubKeyForOriginId(previousStargazer.key)}_${now.getTime()}`,
        title: `${previousStargazer.login} unstarred ${repo.owner}/${repo.repo}`,
        payload_text: `${previousStargazer.login} unstarred ${repo.owner}/${repo.repo}.`,
        author_name: previousStargazer.login,
        source_url: previousStargazer.html_url ?? `https://github.com/${previousStargazer.login}`,
        occurred_at: now,
        origin_type: 'stargazer_unstarred',
        score: 1,
        metadata: {
          actor: this.buildActorFromCheckpoint(previousStargazer),
          target,
          action: 'unstarred',
          starred_at: previousStargazer.starred_at ?? null,
          unstarred_at: now.toISOString(),
          unstarred_at_is_inferred: true,
          source: 'github_stargazers_snapshot_diff',
        },
      });
    }

    return { events, currentStargazers };
  }

  private shouldRefreshStargazerProfile(
    previous: GitHubStargazerCheckpoint | undefined,
    now: Date
  ): boolean {
    const fetchedAt = toIsoOrUndefined(previous?.profile_fetched_at);
    if (!fetchedAt) return true;
    return now.getTime() - new Date(fetchedAt).getTime() >= STARGAZER_PROFILE_REFRESH_MS;
  }

  private async enqueueStargazerProfileEvent(params: {
    events: EventEnvelope[];
    login: string;
    token: string | null;
    fallback: GitHubStargazerLike['user'] | GitHubStargazerLike;
    fetchedAt: Date;
  }): Promise<string> {
    const profile = await this.fetchUserProfile(params.login, params.token, params.fallback);
    const profileUrl = profile.html_url ?? `https://github.com/${params.login}`;
    const occurredAt = new Date(
      toIsoOrUndefined(profile.updated_at) ?? params.fetchedAt.toISOString()
    );
    const identities = this.githubUserIdentities(profile, params.login);

    params.events.push({
      origin_id: `stargazer_profile_${githubKeyForOriginId(githubUserIdentityKey({ userId: profile.id, login: params.login }))}`,
      title: profile.name || params.login,
      payload_text: profile.bio || `GitHub profile for ${params.login}.`,
      author_name: params.login,
      source_url: profileUrl,
      occurred_at: Number.isNaN(occurredAt.getTime()) ? params.fetchedAt : occurredAt,
      origin_type: 'stargazer_profile',
      score: toInt(profile.followers, 0),
      metadata: {
        public_identity_profile: true,
        provider: 'github',
        identities,
        account: {
          provider: 'github',
          provider_user_id: profile.id ? String(profile.id) : null,
          handle: params.login,
          url: profileUrl,
          avatar_url: profile.avatar_url ?? null,
          user_type: profile.type ?? null,
          site_admin: profile.site_admin ?? false,
          profile: {
            name: profile.name ?? null,
            company: profile.company ?? null,
            blog: profile.blog ?? null,
            location: profile.location ?? null,
            email: profile.email ?? null,
            bio: profile.bio ?? null,
            twitter_username: profile.twitter_username ?? null,
            public_repos: profile.public_repos ?? null,
            public_gists: profile.public_gists ?? null,
            followers: profile.followers ?? null,
            following: profile.following ?? null,
            github_created_at: profile.created_at ?? null,
            github_updated_at: profile.updated_at ?? null,
          },
          fetched_at: params.fetchedAt.toISOString(),
        },
      },
    });

    return params.fetchedAt.toISOString();
  }

  private async fetchUserProfile(
    login: string,
    token: string | null,
    fallback: GitHubStargazerLike['user'] | GitHubStargazerLike
  ): Promise<GitHubUserProfile> {
    try {
      return await this.requestJson<GitHubUserProfile>({
        url: `https://api.github.com/users/${encodeGitHubPathSegment(login, 'user login')}`,
        token,
      });
    } catch {
      return {
        id: fallback?.id,
        login,
        html_url: fallback?.html_url ?? `https://github.com/${login}`,
        avatar_url: fallback?.avatar_url,
        type: fallback?.type,
        site_admin: fallback?.site_admin,
      };
    }
  }

  private async fetchRepository(
    repo: RepoRef,
    token: string | null
  ): Promise<GitHubRepositoryLike> {
    try {
      return await this.requestJson<GitHubRepositoryLike>({
        url: githubRepoApiUrl(repo),
        token,
      });
    } catch {
      return {
        full_name: `${repo.owner}/${repo.repo}`,
        html_url: `https://github.com/${repo.owner}/${repo.repo}`,
      };
    }
  }

  private githubUserIdentities(
    user: Pick<GitHubUserProfile, 'id'>,
    login: string
  ): Array<{ namespace: string; identifier: string; verification_status: string }> {
    const identities: Array<{ namespace: string; identifier: string; verification_status: string }> = [];
    if (user.id) {
      identities.push({
        namespace: GITHUB_IDENTITY.USER_ID,
        identifier: String(user.id),
        verification_status: 'observed',
      });
    }
    const normalizedLogin = normalizeGithubLogin(login);
    if (normalizedLogin) {
      identities.push({
        namespace: GITHUB_IDENTITY.LOGIN,
        identifier: normalizedLogin,
        verification_status: 'observed',
      });
    }
    return identities;
  }

  /**
   * Canonical author identity slot for attributions. Stamps `author_login`
   * (the mutable handle, indexed for read-time attribution) and `author_id`
   * (the immutable numeric GitHub user id, the PRIMARY match/dedupe key) into
   * event metadata so the ingestion pipeline's `applyEventAttributions` resolves a
   * `person` from REST payloads. Omitted keys when absent — bots/ghost authors
   * may lack an id; the login still matches.
   */
  private buildAuthorMetadata(
    user: { login?: string; id?: number } | undefined | null
  ): Record<string, string> {
    const out: Record<string, string> = {};
    const login = normalizeGithubLogin(asString(user?.login));
    if (login) out.author_login = login;
    if (typeof user?.id === 'number' && Number.isFinite(user.id)) {
      out.author_id = String(user.id);
    }
    return out;
  }

  /** Same as {@link buildAuthorMetadata} but for GraphQL authors (`databaseId`). */
  private buildGraphQLAuthorMetadata(
    author: { login?: string; databaseId?: number } | undefined | null
  ): Record<string, string> {
    return this.buildAuthorMetadata(
      author ? { login: author.login, id: author.databaseId } : undefined
    );
  }

  private buildActor(user: GitHubStargazerLike['user'] | GitHubStargazerLike, login: string) {
    const normalizedLogin = normalizeGithubLogin(login) ?? login.toLowerCase();
    return {
      provider: 'github',
      identity: user?.id
        ? { namespace: GITHUB_IDENTITY.USER_ID, identifier: String(user.id) }
        : { namespace: GITHUB_IDENTITY.LOGIN, identifier: normalizedLogin },
      handle: { namespace: GITHUB_IDENTITY.LOGIN, identifier: normalizedLogin },
      profile_url: user?.html_url ?? `https://github.com/${login}`,
      user_type: user?.type ?? null,
    };
  }

  private buildActorFromCheckpoint(stargazer: GitHubStargazerCheckpoint) {
    const [namespace, ...identifierParts] = stargazer.key.split(':');
    const identifier = identifierParts.join(':');
    return {
      provider: 'github',
      identity: { namespace, identifier },
      handle: {
        namespace: GITHUB_IDENTITY.LOGIN,
        identifier: normalizeGithubLogin(stargazer.login) ?? stargazer.login.toLowerCase(),
      },
      profile_url: stargazer.html_url ?? `https://github.com/${stargazer.login}`,
      user_type: stargazer.user_type ?? null,
    };
  }

  private buildRepoTarget(repo: RepoRef, repoInfo: GitHubRepositoryLike) {
    const fullName =
      normalizeGithubRepoFullName(repoInfo.full_name ?? `${repo.owner}/${repo.repo}`) ??
      `${repo.owner}/${repo.repo}`.toLowerCase();
    return {
      provider: 'github',
      identity: repoInfo.id
        ? { namespace: GITHUB_IDENTITY.REPO_ID, identifier: String(repoInfo.id) }
        : { namespace: GITHUB_IDENTITY.REPO_FULL_NAME, identifier: fullName },
      handle: { namespace: GITHUB_IDENTITY.REPO_FULL_NAME, identifier: fullName },
      url: repoInfo.html_url ?? `https://github.com/${repo.owner}/${repo.repo}`,
    };
  }

  private parseStargazerCheckpoint(
    checkpoint: Record<string, unknown> | null
  ): GitHubStargazerCheckpoint[] {
    const raw = (checkpoint as GitHubCheckpoint | null)?.stargazers;
    if (!Array.isArray(raw)) return [];

    return raw
      .map((item): GitHubStargazerCheckpoint | null => {
        if (!item || typeof item !== 'object') return null;
        const value = item as unknown as Record<string, unknown>;
        const login = asString(value.login);
        if (!login) return null;
        const userId = typeof value.user_id === 'number' ? value.user_id : null;
        const normalizedLogin = normalizeGithubLogin(login) ?? login.toLowerCase();
        const key =
          asString(value.key) ??
          (userId
            ? `${GITHUB_IDENTITY.USER_ID}:${userId}`
            : `${GITHUB_IDENTITY.LOGIN}:${normalizedLogin}`);

        return {
          key,
          login,
          starred_at: asString(value.starred_at),
          user_id: userId,
          user_type: asString(value.user_type) ?? null,
          html_url: asString(value.html_url) ?? null,
          profile_fetched_at: asString(value.profile_fetched_at) ?? null,
        };
      })
      .filter((value): value is GitHubStargazerCheckpoint => value !== null);
  }

  private async createIssue(
    repo: RepoRef,
    token: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const title = asString(input.title);
    if (!title) return { success: false, error: 'title is required' };

    const body = asString(input.body);
    const labels = Array.isArray(input.labels)
      ? input.labels.filter((value): value is string => typeof value === 'string')
      : undefined;
    const assignees = Array.isArray(input.assignees)
      ? input.assignees.filter((value): value is string => typeof value === 'string')
      : undefined;

    const issue = await this.requestJson<GitHubMutationResponse>({
      method: 'POST',
      url: githubRepoApiUrl(repo, '/issues'),
      token,
      body: {
        title,
        body,
        labels,
        assignees,
      },
    });

    return {
      success: true,
      output: {
        issue_id: issue.id,
        issue_number: issue.number,
        url: issue.html_url,
        state: issue.state,
      },
    };
  }

  private async addIssueComment(
    repo: RepoRef,
    token: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const issueNumber = toInt(input.issue_number, 0);
    const body = asString(input.body);
    if (!issueNumber) return { success: false, error: 'issue_number is required' };
    if (!body) return { success: false, error: 'body is required' };

    const comment = await this.requestJson<{
      id: number;
      html_url: string;
    }>({
      method: 'POST',
      url: githubRepoApiUrl(repo, `/issues/${issueNumber}/comments`),
      token,
      body: { body },
    });

    return {
      success: true,
      output: {
        comment_id: comment.id,
        issue_number: issueNumber,
        url: comment.html_url,
      },
    };
  }

  private async updateIssueState(
    repo: RepoRef,
    token: string,
    input: Record<string, unknown>,
    state: 'open' | 'closed'
  ): Promise<ActionResult> {
    const issueNumber = toInt(input.issue_number, 0);
    if (!issueNumber) return { success: false, error: 'issue_number is required' };

    const issue = await this.requestJson<GitHubMutationResponse>({
      method: 'PATCH',
      url: githubRepoApiUrl(repo, `/issues/${issueNumber}`),
      token,
      body: { state },
    });

    return {
      success: true,
      output: {
        issue_id: issue.id,
        issue_number: issue.number,
        url: issue.html_url,
        state: issue.state,
      },
    };
  }

  private async createPullRequest(
    repo: RepoRef,
    token: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const title = asString(input.title);
    const head = asString(input.head);
    const base = asString(input.base);
    if (!title) return { success: false, error: 'title is required' };
    if (!head) return { success: false, error: 'head is required' };
    if (!base) return { success: false, error: 'base is required' };

    const body = asString(input.body);
    const draft = typeof input.draft === 'boolean' ? input.draft : undefined;

    const pr = await this.requestJson<GitHubMutationResponse>({
      method: 'POST',
      url: githubRepoApiUrl(repo, '/pulls'),
      token,
      body: {
        title,
        head,
        base,
        body,
        draft,
      },
    });

    return {
      success: true,
      output: {
        pull_request_id: pr.id,
        pull_number: pr.number,
        url: pr.html_url,
        state: pr.state,
        draft: pr.draft ?? false,
        subscribable: githubPullRequestSubscribable(
          `${repo.owner}/${repo.repo}`,
          pr.number
        ),
      },
    };
  }

  private async mergePullRequest(
    repo: RepoRef,
    token: string,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const pullNumber = toInt(input.pull_number, 0);
    if (!pullNumber) return { success: false, error: 'pull_number is required' };

    const mergeMethod = asString(input.merge_method);
    const commitTitle = asString(input.commit_title);
    const commitMessage = asString(input.commit_message);

    const merged = await this.requestJson<{
      sha: string;
      merged: boolean;
      message: string;
    }>({
      method: 'PUT',
      url: githubRepoApiUrl(repo, `/pulls/${pullNumber}/merge`),
      token,
      body: {
        merge_method:
          mergeMethod === 'merge' || mergeMethod === 'squash' || mergeMethod === 'rebase'
            ? mergeMethod
            : undefined,
        commit_title: commitTitle,
        commit_message: commitMessage,
      },
    });

    return {
      success: true,
      output: {
        pull_number: pullNumber,
        merged: !!merged.merged,
        message: merged.message,
        sha: merged.sha,
      },
    };
  }

  private async requestGraphQL<T>(params: {
    token: string | null;
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<T> {
    return await this.requestJson<T>({
      method: 'POST',
      url: 'https://api.github.com/graphql',
      token: params.token,
      body: {
        query: params.query,
        variables: params.variables ?? {},
      },
      // Every caller sends a query (discussion reads), which is safe to repeat
      // on a 5xx even though it goes out as POST. A mutation must not set this.
      idempotent: true,
    });
  }

  private readonly http = createHttpClient({ errorPrefix: 'GitHub API' });

  private async requestJson<T>(params: {
    url: string;
    method?: string;
    token: string | null;
    body?: Record<string, unknown>;
    accept?: string;
    idempotent?: boolean;
  }): Promise<T> {
    const headers: Record<string, string> = {
      Accept: params.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
    if (params.token) {
      headers.Authorization = `Bearer ${params.token}`;
    }

    return await this.http.json<T>(params.url, {
      method: params.method ?? 'GET',
      headers,
      body: params.body ? JSON.stringify(params.body) : undefined,
      idempotent: params.idempotent,
    });
  }
}
