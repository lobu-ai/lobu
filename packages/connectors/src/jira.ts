/**
 * Jira Connector (V1 runtime)
 *
 * Reads Jira Cloud issues via JQL and can sync them into events. Real-time
 * issue/comment deliveries can arrive through the app-level webhook path; raw
 * deliveries land downstream (extract-load).
 */

import { randomBytes } from 'node:crypto';
import {
  ConnectorRuntime,
  type EventEnvelope,
  type FeedReadContext,
  type FeedReadResult,
  paginateByCursor,
  requireBearerClient,
  type RuntimeConnectorDefinition,
  type SyncContext,
  type SyncCredentials,
  type SyncResult,
  type WebhookRegistration,
  type WebhookRegistrationContext,
} from '@lobu/connector-sdk';

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
  last_sync_at?: string;
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

/** Stable column set returned by direct source reads. */
const JIRA_ISSUE_COLUMNS = [
  { name: 'id', type: 'string' },
  { name: 'key', type: 'string' },
  { name: 'summary', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'assignee', type: 'string' },
  { name: 'reporter', type: 'string' },
  { name: 'priority', type: 'string' },
  { name: 'project_key', type: 'string' },
  { name: 'project_name', type: 'string' },
  { name: 'labels', type: 'string' },
  { name: 'created_at', type: 'string' },
  { name: 'updated_at', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'url', type: 'string' },
] as const;

const ISSUE_FIELDS =
  'summary,description,status,assignee,reporter,priority,project,labels,created,updated';

/** Sort columns the live path can honor by rewriting ORDER BY. */
const SORT_COLUMNS: Record<string, string> = {
  updated: 'updated',
  updated_at: 'updated',
  created: 'created',
  created_at: 'created',
  key: 'key',
  priority: 'priority',
  status: 'status',
};

const ADF_BLOCK_TYPES = new Set([
  'blockquote',
  'bulletList',
  'codeBlock',
  'heading',
  'listItem',
  'orderedList',
  'paragraph',
  'rule',
  'table',
  'tableCell',
  'tableHeader',
  'tableRow',
]);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function actorName(user: JiraUser | null | undefined): string | undefined {
  return user?.displayName ?? user?.emailAddress ?? undefined;
}

/**
 * Jira v3 descriptions/comment bodies use the Atlassian Document Format (ADF) —
 * a nested JSON node tree. Flatten its text nodes to plain text. Strings (older
 * payloads) pass through unchanged.
 */
function adfToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as { type?: string; text?: string; content?: unknown[] };
  // Soft line break inside a paragraph (not a block boundary).
  if (node.type === 'hardBreak') return '\n';
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) {
    let out = '';
    for (const child of node.content) {
      const text = adfToText(child);
      if (!text) continue;
      const childType =
        child && typeof child === 'object' ? (child as { type?: string }).type : undefined;
      // hardBreak already contributes '\n' as its text; don't insert a second.
      if (out && childType && ADF_BLOCK_TYPES.has(childType)) out += '\n';
      out += text;
    }
    return out.trim();
  }
  return '';
}

/**
 * Peel a trailing `ORDER BY …` so caller JQL can be AND-composed without
 * wrapping the sort clause.
 */
function splitTrailingOrderBy(jql: string): { body: string; orderBy: string | null } {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < jql.length; i += 1) {
    const char = jql[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      depth === 0 &&
      (i === 0 || /\s/.test(jql[i - 1])) &&
      /^order\s+by\b/i.test(jql.slice(i))
    ) {
      return { body: jql.slice(0, i).trim(), orderBy: jql.slice(i).trim() };
    }
  }
  return { body: jql.trim(), orderBy: null };
}

function buildJiraJql(args: {
  baseQuery: string;
  query?: string;
  sort?: { column: string; order: 'asc' | 'desc' };
  defaultWhenEmpty?: string;
  window?: { start: string; end: string };
}): string {
  const trimmed = args.baseQuery.trim();
  // Keep an omitted scope bounded instead of scanning the whole site.
  const jql = trimmed.length > 0 ? trimmed : (args.defaultWhenEmpty ?? 'updated >= -90d');

  // If the base is only ORDER BY, treat the restriction as empty and keep sort.
  let { body, orderBy } = splitTrailingOrderBy(jql);
  if (!body && orderBy) {
    body = args.defaultWhenEmpty ?? 'updated >= -90d';
  }

  const callerQuery = args.query?.trim() ?? '';
  if (callerQuery) {
    const caller = splitTrailingOrderBy(callerQuery);
    if (caller.body) {
      body = body.length > 0 ? `(${body}) AND (${caller.body})` : caller.body;
    }
    if (caller.orderBy) {
      throw new Error(
        'Jira source read query cannot contain ORDER BY; use the separate sort field',
      );
    }
  }

  if (args.window) {
    const bounds = `updated >= ${Date.parse(args.window.start)} AND updated < ${Date.parse(args.window.end)}`;
    body = body ? `(${body}) AND (${bounds})` : bounds;
  }

  // `body` is non-empty from here on: an empty base fell back to
  // `defaultWhenEmpty`, and the caller query can further restrict it.
  if (orderBy) {
    if (args.sort) {
      throw new Error(
        'Jira source read: cannot apply sort when the base JQL already contains ORDER BY',
      );
    }
    return `${body} ${orderBy}`;
  }

  if (args.sort) {
    const field = SORT_COLUMNS[args.sort.column];
    if (!field) {
      throw new Error(
        `Jira source read sort column '${args.sort.column}' is unsupported; ` +
          `use one of: ${Object.keys(SORT_COLUMNS).join(', ')}`,
      );
    }
    const dir = args.sort.order === 'asc' ? 'ASC' : 'DESC';
    return `${body} ORDER BY ${field} ${dir}`;
  }

  return `${body} ORDER BY updated DESC`;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class JiraConnector extends ConnectorRuntime<JiraCheckpoint, JiraConfig> {
  readonly definition: RuntimeConnectorDefinition<JiraCheckpoint, JiraConfig> = {
    key: 'jira',
    name: 'Jira',
    description:
      'Syncs and live-reads Jira Cloud issues via JQL, and receives real-time issue/comment webhooks.',
    version: '1.1.4',
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

    const baseQuery = asString(ctx.config.query) ?? asString(ctx.config.jql) ?? '';

    const jql = buildJiraJql({
      baseQuery,
      query: asString(ctx.query),
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
      fields: ISSUE_FIELDS,
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

  private async syncFeed(ctx: SyncContext<JiraCheckpoint, JiraConfig>): Promise<SyncResult<JiraCheckpoint>> {
    const base = await this.restBase(ctx.config, ctx.sessionState, ctx.credentials);
    const http = this.client(ctx.credentials);
    const lookbackDays = ctx.config.lookback_days ?? 365;
    const jql = buildJiraJql({
      baseQuery: asString(ctx.config.query) ?? asString(ctx.config.jql) ?? '',
      defaultWhenEmpty: `updated >= -${lookbackDays}d`,
    });

    const events: EventEnvelope[] = [];

    // `/rest/api/3/search` was removed by Atlassian (CHANGE-2046); the
    // replacement `/search/jql` paginates with an opaque nextPageToken and
    // returns no total — iterate until the token is absent.
    const pages = paginateByCursor<JiraIssue, string>(
      async (nextPageToken) => {
        const params = new URLSearchParams({
          jql,
          maxResults: String(this.PAGE_SIZE),
          fields: ISSUE_FIELDS,
        });
        if (nextPageToken) params.set('nextPageToken', nextPageToken);
        const data = await http.json<JiraSearchResponse>(
          `${base}/search/jql?${params.toString()}`,
          { method: 'GET', headers: { Accept: 'application/json' } },
        );
        return { items: data.issues ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: this.MAX_PAGES },
    );

    for await (const issues of pages) {
      for (const issue of issues) {
        const event = this.issueEvent(issue, ctx.config);
        if (event) events.push(event);
      }
      // Preserve the original early-exit on an empty page even when a token is
      // returned — guards against a degenerate self-referential cursor.
      if (issues.length === 0) break;
    }

    return {
      events,
      checkpoint: { last_sync_at: new Date().toISOString() },
      metadata: { items_found: events.length },
    };
  }

  // -------------------------------------------------------------------------
  // Webhooks (subscription lifecycle — raw deliveries land downstream)
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
    const fields = issue.fields ?? {};
    const labels = Array.isArray(fields.labels) ? fields.labels.join(', ') : null;
    return {
      id: issue.id,
      key: issue.key ?? null,
      summary: fields.summary ?? null,
      status: fields.status?.name ?? null,
      assignee: actorName(fields.assignee) ?? null,
      reporter: actorName(fields.reporter) ?? null,
      priority: fields.priority?.name ?? null,
      project_key: fields.project?.key ?? null,
      project_name: fields.project?.name ?? null,
      labels,
      created_at: fields.created ?? null,
      updated_at: fields.updated ?? null,
      description: adfToText(fields.description) || null,
      url: this.issueUrl(issue, config) ?? null,
    };
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
      author_name: actorName(fields.reporter ?? fields.assignee),
      source_url: this.issueUrl(issue, config),
      occurred_at: createdAt,
      origin_type: 'issue',
      metadata: {
        key: issue.key ?? null,
        status: fields.status?.name ?? null,
        assignee: actorName(fields.assignee) ?? null,
        reporter: actorName(fields.reporter) ?? null,
        updated_at: fields.updated ?? null,
      },
    };
  }

  private issueUrl(issue: JiraIssue | undefined, config?: JiraConfig): string | undefined {
    const siteUrl = asString(config?.site_url);
    const key = asString(issue?.key);
    const cloudId = asString(config?.cloud_id);
    const siteCloudId = asString(config?.site_cloud_id);
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
    const fromConfig = asString(config.cloud_id) ?? asString(sessionState?.cloud_id);
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

    const id = asString(site?.id);
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
    const siteUrl = asString(site?.url);
    const siteName = asString(site?.name);
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
