/**
 * Linear Connector (V1 runtime)
 *
 * Reads Linear issues via GraphQL and can sync them into events.
 * Real-time Issue/Comment deliveries arrive via app webhooks; raw deliveries
 * land downstream (extract-load).
 */

import { randomBytes } from 'node:crypto';
import {
  ConnectorRuntime,
  type EventEnvelope,
  type FeedReadContext,
  type FeedReadResult,
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

interface LinearConfig {
  /** Optional team filter (Linear team key, e.g. "ENG"). */
  team_key?: string;
  /**
   * Optional free-text scope for direct source reads (`config.query`).
   * Combined with the caller's `ctx.query` as containsIgnoreCase on
   * title/description.
   */
  query?: string;
  lookback_days?: number;
  /** Optional cap on issues returned by one direct source read. */
  max_results?: number;
}

interface LinearCheckpoint {
  /** When the last complete traversal began; the next one fetches issues updated since. */
  last_sync_at?: string;
  /**
   * A traversal that stopped at the per-run page cap. `since`/`started_at`
   * are the fixed bounds it walks and `cursor` the `endCursor` of the last page
   * stored, so the next run continues past it instead of re-reading the newest
   * issues and never reaching the rest.
   */
  pending?: { since?: string; started_at: string; cursor: string };
}

interface LinearUser {
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

interface LinearWorkflowState {
  name?: string | null;
  type?: string | null;
}

interface LinearIssueNode {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  state?: LinearWorkflowState | null;
  assignee?: LinearUser | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

const GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

/** Stable column set returned by direct source reads. */
const LINEAR_ISSUE_COLUMNS = [
  { name: 'id', type: 'string' },
  { name: 'identifier', type: 'string' },
  { name: 'title', type: 'string' },
  { name: 'state', type: 'string' },
  { name: 'state_type', type: 'string' },
  { name: 'assignee', type: 'string' },
  { name: 'created_at', type: 'string' },
  { name: 'updated_at', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'url', type: 'string' },
] as const;

const ISSUE_NODE_SELECTION = `
  id
  identifier
  title
  description
  url
  state { name type }
  assignee { name displayName email }
  createdAt
  updatedAt
`;

function actorName(user: LinearUser | null | undefined): string | undefined {
  return user?.displayName ?? user?.name ?? user?.email ?? undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Build a Linear GraphQL `IssueFilter` as a serialized object literal.
 * Bounds live reads to a lookback window so we never scan the full workspace.
 */
function buildLinearIssueFilter(args: {
  teamKey?: string;
  textTerms?: string[];
  updatedAfterIso?: string;
  updatedBeforeIso?: string;
}): string {
  const parts: string[] = [];
  if (args.teamKey) {
    parts.push(`{ team: { key: { eq: ${JSON.stringify(args.teamKey)} } } }`);
  }
  if (args.updatedAfterIso) {
    parts.push(`{ updatedAt: { gte: ${JSON.stringify(args.updatedAfterIso)} } }`);
  }
  if (args.updatedBeforeIso) {
    parts.push(`{ updatedAt: { lt: ${JSON.stringify(args.updatedBeforeIso)} } }`);
  }
  const terms = (args.textTerms ?? []).map((t) => t.trim()).filter(Boolean);
  for (const term of terms) {
    // Title OR description contains each term (AND across terms).
    parts.push(
      `{ or: [ { title: { containsIgnoreCase: ${JSON.stringify(term)} } }, { description: { containsIgnoreCase: ${JSON.stringify(term)} } } ] }`,
    );
  }
  if (parts.length === 0) return '';
  if (parts.length === 1) return `, filter: ${parts[0]}`;
  return `, filter: { and: [ ${parts.join(', ')} ] }`;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class LinearConnector extends ConnectorRuntime<LinearCheckpoint, LinearConfig> {
  readonly definition: RuntimeConnectorDefinition<LinearCheckpoint, LinearConfig> = {
    key: 'linear',
    name: 'Linear',
    description:
      'Syncs and live-reads Linear issues via GraphQL, and receives real-time issue/comment webhooks.',
    version: '1.1.1',
    faviconDomain: 'linear.app',
    webhook: {
      signatureHeader: 'linear-signature',
      algorithm: 'sha256',
      // Linear signs the raw body with HMAC-SHA256 and sends a bare hex digest
      // (no `sha256=` prefix). It does not send a stable delivery id header, so
      // dedupe falls back to a body hash (no `dedupeHeader`).
      // App-installation delivery: one webhook configured ONCE on the Linear app;
      // every delivery carries the workspace `organizationId` — that's the tenant.
      delivery: 'app_installation',
      routingKeyPath: 'organizationId',
    },
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'linear',
          requiredScopes: ['read'],
          optionalScopes: ['write'],
          authorizationUrl: 'https://linear.app/oauth/authorize',
          tokenUrl: 'https://api.linear.app/oauth/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          clientIdKey: 'LINEAR_CLIENT_ID',
          clientSecretKey: 'LINEAR_CLIENT_SECRET',
          required: true,
          description: 'Linear OAuth enables reading issues and registering webhooks.',
          setupInstructions:
            'Create an OAuth application in Linear Settings > API > OAuth applications. Set the redirect URL to {{redirect_uri}}, then copy the client ID and client secret below.',
        },
      ],
    },
    feeds: {
      issues: {
        key: 'issues',
        name: 'Issues',
        description:
          'Linear issues can sync into memory and be read directly from Linear.',
        sync: (ctx) => this.syncFeed(ctx),
        read: (ctx) => this.readFeed(ctx),
        readWindowAxis: 'updated_at',
        configSchema: {
          type: 'object',
          properties: {
            team_key: {
              type: 'string',
              description: 'Optional Linear team key filter (e.g. "ENG").',
            },
            query: {
              type: 'string',
              description:
                'Optional free-text scope for sync and source reads (title/description contains).',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 90,
              description: 'Live-read lookback window (updatedAt). Default 90 days.',
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
            description: 'A Linear issue',
            metadataSchema: {
              type: 'object',
              properties: {
                identifier: { type: 'string' },
                state: { type: 'string' },
                state_type: { type: 'string' },
                assignee: { type: 'string' },
                updated_at: { type: 'string' },
              },
            },
          },
          comment: {
            description: 'A comment on a Linear issue',
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

  private readonly PAGE_SIZE = 50;
  private readonly MAX_PAGES = 50;

  // -------------------------------------------------------------------------
  // Direct source read — read-only, never persisted.
  // -------------------------------------------------------------------------

  private async readFeed(ctx: FeedReadContext<LinearConfig>): Promise<FeedReadResult> {
    if (!ctx.credentials?.accessToken) {
      throw new Error('Linear source reads require Linear OAuth credentials.');
    }
    if (ctx.sort) {
      throw new Error(
        'Linear source read does not support caller-defined sort; issues are ordered by updatedAt.',
      );
    }

    const textTerms = [asString(ctx.config.query) ?? '', asString(ctx.query) ?? ''].filter(Boolean);

    const lookbackDays = Math.min(Math.max(ctx.config.lookback_days ?? 90, 1), 730);
    const updatedAfter = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

    const filter = buildLinearIssueFilter({
      teamKey: asString(ctx.config.team_key),
      textTerms,
      updatedAfterIso: ctx.window?.start ?? updatedAfter,
      updatedBeforeIso: ctx.window?.end,
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
        'Linear source reads paginate with the returned cursor, not an offset.',
      );
    }

    const after = ctx.cursor ? `, after: ${JSON.stringify(ctx.cursor)}` : '';
    const gql = `
      query {
        issues(first: ${Math.min(this.PAGE_SIZE, limit)}${after}, orderBy: updatedAt${filter}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${ISSUE_NODE_SELECTION} }
        }
      }
    `;
    const response: {
      issues?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: LinearIssueNode[];
      };
    } = await this.graphql(ctx.credentials, gql, undefined, { idempotent: true });

    const rows = (response.issues?.nodes ?? [])
      .map((node) => this.issueRow(node))
      .filter((row) => row !== null);
    const pageInfo = response.issues?.pageInfo;
    if (!Array.isArray(response.issues?.nodes) || typeof pageInfo?.hasNextPage !== 'boolean' || (pageInfo.hasNextPage && !pageInfo.endCursor)) {
      throw new Error('Linear did not return a valid page cursor/exhaustion state.');
    }
    if (ctx.window && (rows.length !== response.issues!.nodes!.length || rows.some((row) => !Number.isFinite(Date.parse(String(row.updated_at ?? '')))))) {
      throw new Error('Linear returned malformed issue identity or updated timestamp.');
    }
    const nextCursor = pageInfo.hasNextPage ? pageInfo.endCursor ?? undefined : undefined;
    return {
      rows,
      columns: [...LINEAR_ISSUE_COLUMNS],
      ...(ctx.window ? { window: { ...ctx.window, axis: 'updated_at' } } : {}),
      nextCursor,
      hasMore: Boolean(nextCursor),
    };
  }

  // -------------------------------------------------------------------------
  // Sync into local memory.
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext<LinearCheckpoint, LinearConfig>): Promise<SyncResult> {
    const checkpoint = ctx.checkpoint ?? {};
    // Fixed per traversal: issues updated after the last complete traversal
    // began (none on the first), walked until the listing ends. An issue edited
    // while the walk runs is re-reported by the next traversal, and `origin_id`
    // makes that a supersede, not a duplicate.
    const since = checkpoint.pending ? checkpoint.pending.since : checkpoint.last_sync_at;
    const startedAt = checkpoint.pending?.started_at ?? new Date().toISOString();
    let cursor: string | null = checkpoint.pending?.cursor ?? null;

    const filter = buildLinearIssueFilter({
      teamKey: asString(ctx.config.team_key),
      updatedAfterIso: since,
      updatedBeforeIso: startedAt,
    });

    let found = 0;
    for (let pages = 0; pages < this.MAX_PAGES; pages++) {
      const after: string = cursor ? `, after: ${JSON.stringify(cursor)}` : '';
      const query: string = `
        query {
          issues(first: ${this.PAGE_SIZE}${after}, orderBy: updatedAt${filter}) {
            pageInfo { hasNextPage endCursor }
            nodes { ${ISSUE_NODE_SELECTION} }
          }
        }
      `;

      const response = await this.graphql<{
        issues?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: LinearIssueNode[];
        };
      }>(ctx.credentials, query, undefined, { idempotent: true });

      const nodes = response.issues?.nodes;
      const pageInfo = response.issues?.pageInfo;
      if (
        !Array.isArray(nodes) ||
        typeof pageInfo?.hasNextPage !== 'boolean' ||
        (pageInfo.hasNextPage && !pageInfo.endCursor)
      ) {
        throw new Error('Linear did not return a valid page cursor/exhaustion state.');
      }
      const events: EventEnvelope[] = [];
      for (const node of nodes) {
        const event = this.issueEvent(node);
        if (event) events.push(event);
      }
      found += events.length;

      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
        await ctx.commit(events, { last_sync_at: startedAt });
        return { status: 'complete', metadata: { items_found: found } };
      }
      cursor = pageInfo.endCursor;
      await ctx.commit(events, {
        ...(checkpoint.last_sync_at ? { last_sync_at: checkpoint.last_sync_at } : {}),
        pending: { ...(since ? { since } : {}), started_at: startedAt, cursor },
      });
    }
    // The page cap stopped the walk; its committed cursor resumes it next run.
    return { status: 'more', metadata: { items_found: found } };
  }

  // -------------------------------------------------------------------------
  // Webhooks (subscription lifecycle — raw deliveries land downstream)
  // -------------------------------------------------------------------------

  async registerWebhook(
    ctx: WebhookRegistrationContext<LinearConfig>
  ): Promise<WebhookRegistration> {
    const secret = randomBytes(32).toString('hex');
    const mutation = `
      mutation {
        webhookCreate(input: {
          url: ${JSON.stringify(ctx.callbackUrl)},
          resourceTypes: ["Issue", "Comment"],
          secret: ${JSON.stringify(secret)},
          enabled: true
        }) {
          success
          webhook { id }
        }
      }
    `;

    const response = await this.graphql<{
      webhookCreate?: { success?: boolean; webhook?: { id?: string } };
    }>(ctx.credentials, mutation);

    const id = response.webhookCreate?.webhook?.id;
    if (!id) {
      throw new Error('Linear webhookCreate did not return a webhook id.');
    }

    return { externalId: id, secret };
  }

  async unregisterWebhook(ctx: WebhookRegistrationContext<LinearConfig>): Promise<void> {
    const externalId = ctx.externalId;
    if (!externalId) return;

    const mutation = `
      mutation {
        webhookDelete(id: ${JSON.stringify(externalId)}) { success }
      }
    `;

    await this.graphql<{ webhookDelete?: { success?: boolean } }>(ctx.credentials, mutation);
  }

  // -------------------------------------------------------------------------
  // Mapping helpers
  // -------------------------------------------------------------------------

  private issueRow(node: LinearIssueNode | null): Record<string, unknown> | null {
    if (!node?.id) return null;
    return {
      id: node.id,
      identifier: node.identifier ?? null,
      title: node.title ?? null,
      state: node.state?.name ?? null,
      state_type: node.state?.type ?? null,
      assignee: actorName(node.assignee) ?? null,
      created_at: node.createdAt ?? null,
      updated_at: node.updatedAt ?? null,
      description: (node.description ?? '').trim() || null,
      url: node.url ?? null,
    };
  }

  private issueEvent(node: LinearIssueNode | null): EventEnvelope | null {
    if (!node?.id) return null;
    const createdAt = new Date(node.createdAt ?? node.updatedAt ?? Date.now());
    if (Number.isNaN(createdAt.getTime())) return null;

    return {
      origin_id: `linear_issue_${node.id}`,
      title: node.title ?? node.identifier ?? undefined,
      payload_text: (node.description ?? '').trim(),
      author_name: actorName(node.assignee),
      source_url: node.url ?? undefined,
      occurred_at: createdAt,
      origin_type: 'issue',
      metadata: {
        identifier: node.identifier ?? null,
        state: node.state?.name ?? null,
        state_type: node.state?.type ?? null,
        assignee: actorName(node.assignee) ?? null,
        updated_at: node.updatedAt ?? null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // GraphQL transport
  // -------------------------------------------------------------------------

  /**
   * `idempotent` marks a read: a GraphQL query goes out as POST, so without it
   * the client never repeats the request on a 5xx. Leave it off for mutations —
   * a 5xx does not say whether the webhook was already created.
   */
  private async graphql<T>(
    credentials: SyncCredentials | null,
    query: string,
    variables?: Record<string, unknown>,
    options: { idempotent?: boolean } = {}
  ): Promise<T> {
    const http = requireBearerClient(credentials, {
      errorPrefix: 'Linear API',
      label: 'Linear',
    });
    const response = await http.json<{ data?: T; errors?: Array<{ message?: string }> }>(
      GRAPHQL_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: variables ?? {} }),
        idempotent: options.idempotent,
      }
    );

    if (response.errors?.length) {
      throw new Error(`Linear GraphQL error: ${response.errors.map((e) => e.message).join('; ')}`);
    }
    return (response.data ?? {}) as T;
  }
}
