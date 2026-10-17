/**
 * Jira Connector (V1 runtime)
 *
 * Reads Jira Cloud issues via JQL and can sync them into events. App-level
 * webhook deliveries are verified and routed to the owning install, but the
 * connector declares no webhook event type, so they trigger nothing yet.
 */

import { randomBytes } from 'node:crypto';
import {
  ConnectorRuntime,
  type EventEnvelope,
  type FeedReadContext,
  type FeedReadResult,
  HttpStatusError,
  requireBearerClient,
  type RuntimeConnectorDefinition,
  type SyncContext,
  type SyncCredentials,
  type SyncResult,
  type WebhookRegistration,
  type WebhookRegistrationContext,
} from '@lobu/connector-sdk';
import {
  adfToText,
  buildJiraJql,
  JIRA_ISSUE_COLUMNS,
  JIRA_ISSUE_FIELDS,
  jiraActorName,
  jiraAsString,
  mapJiraIssueToRow,
} from './jira-helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JiraConfig {
  /**
   * Atlassian Cloud id for the target site. REST base is
   * `https://api.atlassian.com/ex/jira/{cloudId}/…`.
   *
   * Auto-stamped onto **connection.config** after OAuth when the grant resolves
   * to one Jira site. Virtual reads merge connection.config (same as sync/poll),
   * so single-site feeds usually need no cloud_id. Fallbacks, in order:
   * `config.cloud_id` → `sessionState.cloud_id` → live accessible-resources lookup
   * with the OAuth access token when it identifies one Jira site.
   */
  cloud_id?: string;
  /** Site URL from OAuth discovery (informational; not required for REST). */
  site_url?: string;
  /**
   * Cloud id that `site_url` / `site_name` were discovered for. Browse links
   * only use site_url when this matches the effective `cloud_id` (guards a
   * feed-level cloud_id override inheriting the wrong site host).
   */
  site_cloud_id?: string;
  /** Site display name from OAuth discovery. */
  site_name?: string;
  /**
   * Base JQL scope for direct source reads (`config.query`).
   * Empty defaults to `updated >= -90d` to keep omitted scopes bounded.
   */
  query?: string;
  /**
   * Legacy / sync JQL filter. Virtual reads prefer `query`, then `jql`.
   * Defaults to `updated >= -{lookback_days}d` on collected sync.
   */
  jql?: string;
  lookback_days?: number;
  /** Optional cap on issues returned by one direct source read. */
  max_results?: number;
}

interface JiraCheckpoint {
  /** When the last complete traversal began; the next one fetches issues updated since. */
  last_sync_at?: string;
  /**
   * A traversal that stopped at the per-run page cap: the fixed `updated`
   * window it walks and the `nextPageToken` of the first page not yet stored,
   * so the next run continues instead of re-reading the newest issues and
   * never reaching the rest.
   */
  pending?: { window: { start: string; end: string }; page_token: string };
}

interface JiraUser {
  displayName?: string | null;
  emailAddress?: string | null;
  accountId?: string | null;
}

interface JiraIssueFields {
  summary?: string | null;
  description?: unknown;
  status?: { name?: string | null } | null;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  priority?: { name?: string | null } | null;
  project?: { key?: string | null; name?: string | null } | null;
  labels?: string[] | null;
  created?: string | null;
  updated?: string | null;
}

interface JiraIssue {
  id?: string;
  key?: string;
  self?: string;
  fields?: JiraIssueFields;
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
  /** Token-based pagination cursor for the /search/jql endpoint (absent on the last page). */
  nextPageToken?: string;
  isLast?: boolean;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class JiraConnector extends ConnectorRuntime<JiraCheckpoint, JiraConfig> {
  readonly definition: RuntimeConnectorDefinition<JiraCheckpoint, JiraConfig> = {
    key: 'jira',
    name: 'Jira',
    description:
      'Syncs and live-reads Jira Cloud issues via JQL.',
    version: '1.1.5',
    faviconDomain: 'atlassian.com',
    webhook: {
      // Jira Connect app webhooks HMAC-sign the raw body with the installation
      // secret and send `x-hub-signature: sha256=<hex>`. Jira does not send a
      // stable delivery id header, so dedupe falls back to a body hash
      // (no `dedupeHeader`).
      signatureHeader: 'x-hub-signature',
      algorithm: 'sha256',
      signaturePrefix: 'sha256=',
      // App-installation delivery: one webhook is configured ONCE on the Jira
      // Connect app; deliveries route via `/api/v1/app-webhooks/jira`. Jira
      // bodies don't carry the cloudId, but every entity exposes a REST `self`
      // URL on its site host — the tenant is that host (one install per site).
      delivery: 'app_installation',
      routingKeyPaths: [
        'self',
        'issue.self',
        'comment.self',
        'user.self',
        'project.self',
        'version.self',
      ],
      routingKeyTransform: 'url-host',
    },
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'jira',
          requiredScopes: [
            'read:jira-work',
            'read:jira-user',
            'manage:jira-webhook',
            'offline_access',
          ],
          // Granular scopes Jira checks before DELIVERING registered webhook
          // events (registration alone only needs manage:jira-webhook):
          // jira:issue_created/updated require read:issue-details:jira, and
          // comment_created requires the other ten — see the scope table under
          // "Registering a webhook via the REST API" in the Jira webhooks docs.
          // Optional rather than required because Atlassian fails the entire
          // authorize redirect when the app config doesn't have a requested
          // scope enabled, which would break JQL reads for existing apps.
          optionalScopes: [
            'read:issue-details:jira',
            'read:comment.property:jira',
            'read:comment:jira',
            'read:epic:jira-software',
            'read:group:jira',
            'read:issue.property:jira',
            'read:issue-type:jira',
            'read:project:jira',
            'read:project-role:jira',
            'read:status:jira',
            'read:user:jira',
          ],
          authorizationUrl: 'https://auth.atlassian.com/authorize',
          tokenUrl: 'https://auth.atlassian.com/oauth/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          authParams: { audience: 'api.atlassian.com', prompt: 'consent' },
          clientIdKey: 'JIRA_CLIENT_ID',
          clientSecretKey: 'JIRA_CLIENT_SECRET',
          required: true,
          description: 'Atlassian (Jira) 3LO OAuth enables reading issues and managing webhooks.',
          setupInstructions:
            'Create an OAuth 2.0 (3LO) app in the Atlassian Developer Console. Set the callback URL to {{redirect_uri}}, enable the Jira API scopes, then copy the client ID and secret below.',
        },
      ],
    },
    feeds: {
      issues: {
        key: 'issues',
        name: 'Issues',
        description:
          'Jira issues can sync into memory and be read directly from Jira via JQL.',
        sync: (ctx) => this.syncFeed(ctx),
        read: (ctx) => this.readFeed(ctx),
        readWindowAxis: 'updated_at',
        configSchema: {
          type: 'object',
          properties: {
            cloud_id: {
              type: 'string',
              description:
                'Atlassian Cloud id (usually auto-set on the connection after OAuth). Optional feed-level override for multi-site tokens.',
            },
            query: {
              type: 'string',
              description:
                'Base JQL for sync and source reads. Empty source reads default to updated >= -90d.',
            },
            jql: {
              type: 'string',
              description:
                'Legacy JQL filter (collected sync + fallback when query is unset). Defaults to recently-updated issues on sync.',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description: 'Collected-sync lookback window when jql/query is unset.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description:
                'Optional cap on issues returned per source-read page. The uncapped default request size is 50.',
            },
          },
        },
        eventKinds: {
          issue: {
            description: 'A Jira issue',
            metadataSchema: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                status: { type: 'string' },
                assignee: { type: 'string' },
                reporter: { type: 'string' },
                updated_at: { type: 'string' },
              },
            },
          },
          comment: {
            description: 'A comment on a Jira issue',
            metadataSchema: {
              type: 'object',
              properties: {
                updated_at: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  private readonly PAGE_SIZE = 100;
  private readonly MAX_PAGES = 50;

  // -------------------------------------------------------------------------
  // Direct source read — read-only, never persisted.
  // -------------------------------------------------------------------------

  /**
   * Shared live read against `/rest/api/3/search/jql`. Returns the stable issue
   * row shape; never persists events. Jira's opaque continuation token is
   * passed through the connector contract and wrapped by the platform.
   */
  private async readFeed(ctx: FeedReadContext<JiraConfig>): Promise<FeedReadResult> {
    if (!ctx.credentials?.accessToken) {
      throw new Error('Jira source reads require Atlassian OAuth credentials.');
    }

    const baseQuery = jiraAsString(ctx.config.query) ?? jiraAsString(ctx.config.jql) ?? '';

    const jql = buildJiraJql({
      baseQuery,
      query: jiraAsString(ctx.query),
      window: ctx.window,
      ...(ctx.window ? { defaultWhenEmpty: '' } : {}),
      sort: ctx.sort,
    });

    const requestedLimit = Math.min(Math.max(Math.trunc(ctx.limit ?? 50), 1), 500);
    const configuredMax =
      ctx.config.max_results == null
        ? 500
        : Math.min(Math.max(Math.trunc(ctx.config.max_results), 1), 100);
    const limit = Math.min(requestedLimit, configuredMax);
    const offset = Math.max(Math.trunc(ctx.offset ?? 0), 0);
    if (offset > 0) {
      throw new Error(
        'Jira source reads paginate with the returned cursor, not an offset.',
      );
    }

    const base = await this.restBase(ctx.config, ctx.sessionState, ctx.credentials);
    const http = this.client(ctx.credentials);

    const params = new URLSearchParams({
      jql,
      maxResults: String(Math.min(this.PAGE_SIZE, limit)),
      fields: JIRA_ISSUE_FIELDS,
    });
    if (ctx.cursor) params.set('nextPageToken', ctx.cursor);
    const data = await http.json<JiraSearchResponse>(
      `${base}/search/jql?${params.toString()}`,
      { method: 'GET', headers: { Accept: 'application/json' } },
    );
    if (!Array.isArray(data.issues) ||
        (ctx.window && typeof data.isLast !== 'boolean') ||
        (data.isLast === false && !data.nextPageToken) ||
        (ctx.window && data.isLast === true && Boolean(data.nextPageToken))) {
      throw new Error('Jira did not return a valid page cursor/exhaustion state.');
    }
    const rows = data.issues
      .map((issue) => this.issueRow(issue, ctx.config))
      .filter((row) => row !== null);

    if (ctx.window && (rows.length !== data.issues.length || rows.some((row) => !Number.isFinite(Date.parse(String(row.updated_at ?? '')))))) {
      throw new Error('Jira returned malformed issue identity or updated timestamp.');
    }

    // No reliable total from /search/jql — omit rather than lie with page length.
    return {
      rows,
      columns: [...JIRA_ISSUE_COLUMNS],
      ...(ctx.window ? { window: { ...ctx.window, axis: 'updated_at' } } : {}),
      nextCursor: data.nextPageToken,
      hasMore: Boolean(data.nextPageToken),
    };
  }

  // -------------------------------------------------------------------------
  // Sync into local memory.
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext<JiraCheckpoint, JiraConfig>): Promise<SyncResult> {
    const base = await this.restBase(ctx.config, ctx.sessionState, ctx.credentials);
    const http = this.client(ctx.credentials);
    const checkpoint = ctx.checkpoint ?? {};
    const lookbackDays = ctx.config.lookback_days ?? 365;
    // Fixed per traversal: issues updated since the last complete traversal
    // began, up to when this one began. An issue edited while the walk runs
    // falls in the next window, and `origin_id` makes a re-report a supersede.
    const window = checkpoint.pending?.window ?? {
      start: checkpoint.last_sync_at ?? new Date(0).toISOString(),
      end: new Date().toISOString(),
    };
    const jql = buildJiraJql({
      baseQuery: jiraAsString(ctx.config.query) ?? jiraAsString(ctx.config.jql) ?? '',
      defaultWhenEmpty: `updated >= -${lookbackDays}d`,
      window,
    });

    // `/rest/api/3/search` was removed by Atlassian (CHANGE-2046); the
    // replacement `/search/jql` paginates with an opaque nextPageToken and
    // returns no total — iterate until the token is absent.
    let pageToken = checkpoint.pending?.page_token;
    // A stored token may be retired between runs. The first request of the run
    // — the only one using a token from a previous run — may restart the same
    // window from its first page instead of wedging the feed.
    let staleCursorRecoverable = pageToken !== undefined;
    let found = 0;
    const seenTokens = new Set<string>();
    for (let page = 0; page < this.MAX_PAGES; page++) {
      const params = new URLSearchParams({
        jql,
        maxResults: String(this.PAGE_SIZE),
        fields: JIRA_ISSUE_FIELDS,
      });
      if (pageToken) {
        seenTokens.add(pageToken);
        params.set('nextPageToken', pageToken);
      }
      let data: JiraSearchResponse;
      try {
        data = await http.json<JiraSearchResponse>(
          `${base}/search/jql?${params.toString()}`,
          { method: 'GET', headers: { Accept: 'application/json' } },
        );
      } catch (error) {
        if (staleCursorRecoverable && error instanceof HttpStatusError && error.status === 400) {
          staleCursorRecoverable = false;
          pageToken = undefined;
          seenTokens.clear();
          page--;
          continue;
        }
        throw error;
      }
      staleCursorRecoverable = false;

      const issues = data.issues ?? [];
      const events: EventEnvelope[] = [];
      for (const issue of issues) {
        const event = this.issueEvent(issue, ctx.config);
        if (event) events.push(event);
      }
      found += events.length;

      if (!data.nextPageToken) {
        await ctx.commit(events, { last_sync_at: window.end });
        return { status: 'complete', metadata: { items_found: found } };
      }
      if (seenTokens.has(data.nextPageToken)) {
        throw new Error('Jira returned a repeated page token.');
      }
      pageToken = data.nextPageToken;
      await ctx.commit(events, {
        ...(checkpoint.last_sync_at ? { last_sync_at: checkpoint.last_sync_at } : {}),
        pending: { window, page_token: pageToken },
      });
      if (issues.length === 0) {
        return { status: 'more', metadata: { items_found: found } };
      }
    }
    // The page cap stopped the walk; its committed token resumes it next run.
    return { status: 'more', metadata: { items_found: found } };
  }

  // -------------------------------------------------------------------------
  // Webhooks (subscription lifecycle — per-connection deliveries are stored raw)
  // -------------------------------------------------------------------------

  async registerWebhook(
    ctx: WebhookRegistrationContext<JiraConfig>,
  ): Promise<WebhookRegistration> {
    const base = await this.restBase(ctx.config, ctx.sessionState, ctx.credentials);
    const http = this.client(ctx.credentials);
    const secret = randomBytes(32).toString('hex');
    const response = await http.json<{
      webhookRegistrationResult?: Array<{ createdWebhookId?: number; errors?: string[] }>;
    }>(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        url: ctx.callbackUrl,
        webhooks: [
          {
            // Dynamic webhooks accept only a strict subset of search JQL.
            // Empty is the documented all-issues filter; reusing query/jql here
            // breaks registration for valid search clauses such as `updated`.
            jqlFilter: '',
            events: ['jira:issue_created', 'jira:issue_updated', 'comment_created'],
          },
        ],
        // Jira HMAC-signs deliveries with this secret when supplied.
        secret,
      }),
    });

    const result = response.webhookRegistrationResult?.[0];
    const id = result?.createdWebhookId;
    if (id == null) {
      const errors = result?.errors?.join('; ') ?? 'no webhook id returned';
      throw new Error(`Jira webhook registration failed: ${errors}`);
    }

    return { externalId: String(id), secret };
  }

  async unregisterWebhook(ctx: WebhookRegistrationContext<JiraConfig>): Promise<void> {
    const externalId = ctx.externalId;
    if (!externalId) return;

    const base = await this.restBase(ctx.config, ctx.sessionState, ctx.credentials);
    const http = this.client(ctx.credentials);

    await http.request(`${base}/webhook`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ webhookIds: [Number(externalId)] }),
    });
  }

  // -------------------------------------------------------------------------
  // Mapping helpers
  // -------------------------------------------------------------------------

  private issueRow(
    issue: JiraIssue | undefined,
    config: JiraConfig,
  ): Record<string, unknown> | null {
    if (!issue?.id) return null;
    return mapJiraIssueToRow(
      issue,
      config as unknown as Record<string, unknown>,
    );
  }

  private issueEvent(issue: JiraIssue | undefined, config: JiraConfig): EventEnvelope | null {
    if (!issue?.id) return null;
    const fields = issue.fields ?? {};
    const createdAt = new Date(fields.created ?? fields.updated ?? Date.now());
    if (Number.isNaN(createdAt.getTime())) return null;

    return {
      origin_id: `jira_issue_${issue.id}`,
      title: fields.summary ?? issue.key ?? undefined,
      payload_text: adfToText(fields.description),
      author_name: jiraActorName(fields.reporter ?? fields.assignee),
      source_url: this.issueUrl(issue, config),
      occurred_at: createdAt,
      origin_type: 'issue',
      metadata: {
        key: issue.key ?? null,
        status: fields.status?.name ?? null,
        assignee: jiraActorName(fields.assignee) ?? null,
        reporter: jiraActorName(fields.reporter) ?? null,
        updated_at: fields.updated ?? null,
      },
    };
  }

  private issueUrl(issue: JiraIssue | undefined, config?: JiraConfig): string | undefined {
    const siteUrl = jiraAsString(config?.site_url);
    const key = jiraAsString(issue?.key);
    const cloudId = jiraAsString(config?.cloud_id);
    const siteCloudId = jiraAsString(config?.site_cloud_id);
    // Only rewrite to /browse when site_url was discovered for THIS cloud_id.
    // A feed-level cloud_id override must not inherit another site's host.
    if (siteUrl && key && cloudId && siteCloudId && cloudId === siteCloudId) {
      return `${siteUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`;
    }
    return issue?.self ?? undefined;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * Resolve REST base. Prefer config/session cloud_id (stamped at OAuth onto
   * connection.config and merged by the platform). If still missing, call
   * accessible-resources with the live access token — covers reconnects and
   * older connections that predate auto-stamp.
   */
  private async restBase(
    config: JiraConfig,
    sessionState: Record<string, unknown> | null | undefined,
    credentials: SyncCredentials | null | undefined,
  ): Promise<string> {
    const cloudId = await this.resolveCloudId(config, sessionState, credentials);
    return `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  }

  private async resolveCloudId(
    config: JiraConfig,
    sessionState: Record<string, unknown> | null | undefined,
    credentials: SyncCredentials | null | undefined,
  ): Promise<string> {
    const fromConfig = jiraAsString(config.cloud_id) ?? jiraAsString(sessionState?.cloud_id);
    if (fromConfig) return fromConfig;

    if (!credentials?.accessToken) {
      throw new Error(
        'Jira requires a cloud_id (auto-set on the connection after OAuth, or set config.cloud_id).',
      );
    }

    const http = this.client(credentials);
    const resources = await http.json<
      Array<{ id?: string; url?: string; name?: string; scopes?: string[] }>
    >('https://api.atlassian.com/oauth/token/accessible-resources', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!Array.isArray(resources) || resources.length === 0) {
      throw new Error(
        'Jira OAuth token has no accessible Atlassian Cloud sites. Reconnect and grant access to a Jira site.',
      );
    }

    const usable = resources.filter(
      (r): r is typeof r & { id: string } =>
        typeof r.id === 'string' && r.id.trim().length > 0,
    );
    const distinctUsable = [
      ...new Map(usable.map((resource) => [resource.id.trim(), resource])).values(),
    ];
    const jiraScoped = [
      ...new Map(
        usable
          .filter(
            (r) =>
              Array.isArray(r.scopes) &&
              r.scopes.some((s) => typeof s === 'string' && s.includes('jira')),
          )
          .map((resource) => [resource.id.trim(), resource]),
      ).values(),
    ];
    const site =
      jiraScoped.length === 1
        ? jiraScoped[0]
        : jiraScoped.length === 0 && distinctUsable.length === 1
          ? distinctUsable[0]
          : null;

    const id = jiraAsString(site?.id);
    if (!id) {
      if (jiraScoped.length > 1 || distinctUsable.length > 1) {
        throw new Error(
          'Jira OAuth token can access multiple Cloud sites; set config.cloud_id to the intended site.',
        );
      }
      throw new Error(
        'Jira accessible-resources returned no usable cloud id. Reconnect the Jira connection.',
      );
    }

    // Cache on this job's config so subsequent calls in the same run skip the hop.
    config.cloud_id = id;
    config.site_cloud_id = id;
    const siteUrl = jiraAsString(site?.url);
    const siteName = jiraAsString(site?.name);
    if (siteUrl) config.site_url = siteUrl;
    else delete config.site_url;
    if (siteName) config.site_name = siteName;
    else delete config.site_name;
    return id;
  }

  private client(credentials: SyncCredentials | null) {
    return requireBearerClient(credentials, {
      errorPrefix: 'Jira API',
      label: 'Jira',
    });
  }
}
