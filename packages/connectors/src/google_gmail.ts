/**
 * Gmail Connector (V1 runtime)
 *
 * Syncs email threads from Gmail and supports sending emails
 * via the Gmail API v1.
 */

import {
  type ActionContext,
  type ActionResult,
  ConnectorRuntime,
  createHttpClient,
  type EventEnvelope,
  type HttpClient,
  type FeedReadContext,
  type FeedReadResult,
  type RuntimeConnectorDefinition,
  sleep,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Gmail API types
// ---------------------------------------------------------------------------

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet: string;
  payload: GmailMessagePayload;
  internalDate: string;
}

interface GmailMessagePayload {
  /** Present on the top-level payload; nested MIME parts may omit it. */
  headers?: GmailHeader[];
  mimeType: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePayload[];
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailThreadListResponse {
  threads?: Array<{ id: string; historyId: string; snippet: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailThreadGetResponse {
  id: string;
  historyId: string;
  messages: GmailMessage[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GmailCheckpoint {
  /** Bumped when the shape below changes; a mismatch re-runs the lookback. */
  schema_version?: number;
  /** Serialized search + person filter the two fields below were produced under. */
  scope?: string;
  last_sync_at?: string;
  /** Set while a window is only part-walked: the run hit `max_results`, or a page came back empty with a cursor. */
  pending?: {
    query: string;
    started_at: string;
    page_token: string;
  };
}

interface GmailConfig {
  /**
   * Gmail search scope shared by sync and direct source reads. Takes precedence
   * over `labels` and `label` when set.
   */
  query?: string;
  label?: string;
  /** Non-empty labels to union in the sync query. Overrides `label`. */
  labels?: string[];
  max_results?: number;
  lookback_days?: number;
  /**
   * Only emit person-relevant threads: replied non-role counterparties or
   * unreplied senders/recipients that pass the human-address heuristic. Drives
   * person minting/merging from a narrow subset of the mailbox while everything
   * else remains available only through direct source reads.
   */
  human_senders_only?: boolean;
}

/** Stable column set returned by direct source reads. */
const GMAIL_SEARCH_COLUMNS = [
  { name: 'id', type: 'string' },
  { name: 'thread_id', type: 'string' },
  { name: 'subject', type: 'string' },
  { name: 'from', type: 'string' },
  { name: 'from_name', type: 'string' },
  { name: 'from_email', type: 'string' },
  { name: 'date', type: 'string' },
  { name: 'snippet', type: 'string' },
  { name: 'url', type: 'string' },
];

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class GmailConnector extends ConnectorRuntime<GmailCheckpoint, GmailConfig> {
  readonly definition: RuntimeConnectorDefinition<GmailCheckpoint, GmailConfig> = {
    key: 'google.gmail',
    name: 'Gmail',
    description:
      'Syncs Gmail threads, live-reads matching messages, and supports sending, drafts, and replies.',
    version: '1.0.5',
    faviconDomain: 'mail.google.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'google',
          requiredScopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            // compose covers drafts.create AND messages.send, so it is the single
            // write scope for create_draft/reply/send_email. It must be required
            // (not optional) — optional scopes are only requested when the caller
            // explicitly asks for them, so an unadorned connect() would omit it
            // and every write op would 403 insufficient-scope.
            'https://www.googleapis.com/auth/gmail.compose',
          ],
          loginScopes: ['openid', 'email', 'profile'],
          clientIdKey: 'GOOGLE_CLIENT_ID',
          clientSecretKey: 'GOOGLE_CLIENT_SECRET',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          loginProvisioning: {
            autoCreateConnection: true,
          },
        },
      ],
    },
    feeds: {
      threads: {
        key: 'threads',
        name: 'Threads',
        requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        description:
          'Gmail threads can sync into memory for attribution and Automations, and be read directly from Gmail.',
        sync: (ctx) => this.syncFeed(ctx),
        read: (ctx) => this.readFeed(ctx),
        configSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Optional Gmail search scope for sync and source reads, e.g. "label:INBOX newer_than:30d". Takes precedence over `labels` and `label`.',
            },
            label: {
              type: 'string',
              default: 'INBOX',
              description: 'Gmail label to sync (e.g. "INBOX", "SENT", "STARRED").',
            },
            labels: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Non-empty labels to union in the sync query, e.g. ["INBOX", "SENT"]. Overrides `label` so outbound-initiated threads are covered; ignored when `query` is set.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              default: 50,
              description: 'Maximum threads per sync or source-read page.',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 365,
              default: 30,
              description: 'Number of days to look back on initial sync.',
            },
            human_senders_only: {
              type: 'boolean',
              default: false,
              description:
                'Emit only person-relevant threads for person building: replied non-role counterparties or unreplied senders/recipients that pass the human-address heuristic.',
            },
          },
        },
        eventKinds: {
          thread: {
            description: 'A Gmail email thread',
            metadataSchema: {
              type: 'object',
              properties: {
                message_count: { type: 'number' },
                label_ids: { type: 'array', items: { type: 'string' } },
                snippet: { type: 'string' },
                from_email: { type: 'string' },
                from_name: { type: 'string' },
                replied: {
                  type: 'boolean',
                  description:
                    'True when the thread contains both a non-self counterparty message and a mailbox-authored SENT-labeled message.',
                },
                person_relevant: {
                  type: 'boolean',
                  description:
                    'True when the selected counterparty qualifies for person minting under the feed mode.',
                },
              },
            },
            attributions: [
              {
                role: 'authored_by',
                // Promote on interaction, never on receipt alone. Every from-address
                // is a sender — overwhelmingly brands, newsletters, and no-reply
                // system addresses, all of which carry a from_name — so receipt
                // alone must not mint a contact. The gate is `person_relevant`,
                // computed by the connector: it is `replied` by default; the
                // human_senders_only mode additionally admits human-looking
                // unreplied counterparties and rejects role/list/broadcast noise.
                // Only person-relevant senders materialize a `person`; everything
                // else still links to an existing contact on identity match.
                autoCreate: true,
                target: {
                  entityType: 'person',
                  createWhen: { path: 'metadata.person_relevant', equals: true },
                  titlePath: 'metadata.from_name',
                  identities: [{ namespace: 'email', eventPath: 'metadata.from_email' }],
                },
                traits: {
                  from_name: {
                    eventPath: 'metadata.from_name',
                    mergeStrategy: 'prefer_non_empty',
                  },
                  last_email_at: {
                    eventPath: 'occurred_at',
                    mergeStrategy: 'overwrite',
                  },
                },
              },
              {
                role: 'authored_by',
                // Legacy gate for v1.0.3 run payloads, which carry `replied` but
                // not `person_relevant`. Keep it until old in-flight runs/caches
                // drain: the server loads the current definition by connector key,
                // so a rolling deploy would otherwise silently skip person creation
                // for a pre-refresh event. Both rules share the email identity, so
                // the pipeline's first-writer-wins dedupes them for new payloads.
                autoCreate: true,
                target: {
                  entityType: 'person',
                  createWhen: { path: 'metadata.replied', equals: true },
                  titlePath: 'metadata.from_name',
                  identities: [{ namespace: 'email', eventPath: 'metadata.from_email' }],
                },
                traits: {
                  from_name: {
                    eventPath: 'metadata.from_name',
                    mergeStrategy: 'prefer_non_empty',
                  },
                  last_email_at: {
                    eventPath: 'occurred_at',
                    mergeStrategy: 'overwrite',
                  },
                },
              },
            ],
          },
        },
      },
    },
    actions: {
      send_email: {
        key: 'send_email',
        name: 'Send Email',
        description: 'Send an email via Gmail.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['to', 'subject', 'body'],
          properties: {
            to: { type: 'string', description: 'Recipient email address.' },
            subject: { type: 'string', description: 'Email subject line.' },
            body: { type: 'string', description: 'Email body (plain text).' },
            cc: { type: 'string', description: 'CC recipients (comma-separated).' },
            bcc: { type: 'string', description: 'BCC recipients (comma-separated).' },
          },
        },
      },
      create_draft: {
        key: 'create_draft',
        name: 'Create Draft',
        description: 'Create a draft email in Gmail.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['to', 'subject', 'body'],
          properties: {
            to: { type: 'string', description: 'Recipient email address.' },
            subject: { type: 'string', description: 'Email subject line.' },
            body: { type: 'string', description: 'Email body (plain text).' },
            cc: { type: 'string', description: 'CC recipients (comma-separated).' },
            bcc: { type: 'string', description: 'BCC recipients (comma-separated).' },
            thread_id: {
              type: 'string',
              description: 'Thread ID to attach the draft to (for replies).',
            },
          },
        },
      },
      reply: {
        key: 'reply',
        name: 'Reply to Thread',
        description: 'Send a reply to an existing email thread.',
        requiresApproval: true,
        inputSchema: {
          type: 'object',
          required: ['thread_id', 'body'],
          properties: {
            thread_id: { type: 'string', description: 'Thread ID to reply to.' },
            body: { type: 'string', description: 'Reply body (plain text).' },
            to: {
              type: 'string',
              description: 'Override recipient (defaults to original sender).',
            },
            cc: { type: 'string', description: 'CC recipients (comma-separated).' },
          },
        },
      },
      search: {
        key: 'search',
		kind: 'read',
        name: 'Search Emails',
        description: 'Search emails by query.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: {
              type: 'string',
              description: "Gmail search query e.g. 'from:someone subject:hello'.",
            },
            max_results: {
              type: 'integer',
              description: 'Maximum number of results to return (default 10).',
            },
          },
        },
      },
      get_thread: {
        key: 'get_thread',
		kind: 'read',
        name: 'Get Thread',
        description: 'Read full thread content.',
        requiresApproval: false,
        inputSchema: {
          type: 'object',
          required: ['thread_id'],
          properties: {
            thread_id: { type: 'string', description: 'Thread ID to read.' },
          },
        },
      },
    },
  };

  private readonly BASE_URL = 'https://www.googleapis.com/gmail/v1/users/me';
  private readonly RATE_LIMIT_MS = 100;

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext<GmailCheckpoint, GmailConfig>): Promise<SyncResult<GmailCheckpoint>> {
    const syncStartedAt = new Date();
    const token = ctx.credentials?.accessToken;
    if (!token) {
      throw new Error('Gmail requires Google OAuth credentials.');
    }

    const label = ctx.config.label || 'INBOX';
    const labels = Array.isArray(ctx.config.labels)
      ? ctx.config.labels
          .filter((l) => typeof l === 'string' && l.trim().length > 0)
          .map((l) => l.trim())
      : [];
    const maxResults = Math.min(ctx.config.max_results ?? 50, 500);
    const lookbackDays = ctx.config.lookback_days ?? 30;
    const humanSendersOnly = ctx.config.human_senders_only === true;

    const checkpoint = ctx.checkpoint ?? {};
    const scope = ctx.config.query?.trim() || (labels.length > 0
      ? `{${labels.map((l) => `label:${l}`).join(' ')}}`
      : `label:${label}`);
    // Old checkpoints describe snippet-only input. Revisit the configured
    // lookback once when upgrading or changing the source filter, preserving
    // thread origin IDs so ingestion supersedes rather than duplicates rows.
    const scopeKey = JSON.stringify([scope, humanSendersOnly]);
    const resumable = checkpoint.schema_version === 2 && checkpoint.scope === scopeKey;
    const pending = resumable ? checkpoint.pending : undefined;
    const windowStart = pending?.started_at ?? syncStartedAt.toISOString();
    const afterDate = resumable && checkpoint.last_sync_at
      ? new Date(checkpoint.last_sync_at)
      : new Date(syncStartedAt.getTime() - lookbackDays * 24 * 60 * 60_000);
    // Keep the search window fixed across capped runs. Its second-level overlap
    // covers messages arriving on the boundary; origin_id makes that replay safe.
    const after = Math.floor(afterDate.getTime() / 1000) - 1;
    const before = Math.ceil(Date.parse(windowStart) / 1000);
    const query = pending?.query ?? `after:${after} before:${before} (${scope})`;
    let pageToken = pending?.page_token;
    // A stored cursor outlives the run that issued it and Gmail may retire it.
    // Rejecting it forever would wedge the feed behind a checkpoint only a human
    // could clear, so the first request of the run — the only one using a cursor
    // from a previous run — may fall back to re-walking the same window from its
    // first page. `origin_id` makes that replay a supersede, not a duplicate.
    let staleCursorRecoverable = pageToken !== undefined;
    const http = this.createClient(token);
    const events: EventEnvelope[] = [];
    // Bounds the threads FETCHED per run (each costs at least one API call),
    // independent of how many survive the person filter — a narrow feed must not
    // scan the whole window just because most threads are rejected. It also sizes
    // each list page, so a page can never push the run past the cap.
    let inspected = 0;

    for (;;) {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.min(100, maxResults - inspected)),
      });
      if (pageToken) params.set('pageToken', pageToken);
      const listResponse = await http.raw(`${this.BASE_URL}/threads?${params.toString()}`);
      if (!listResponse.ok) {
        const detail = await listResponse.text();
        // Retry a stored cursor once on 400/404. Auth, quota and server errors
        // must still fail the run without restarting pagination.
        if (staleCursorRecoverable && (listResponse.status === 400 || listResponse.status === 404)) {
          staleCursorRecoverable = false;
          pageToken = undefined;
          continue;
        }
        throw new Error(`Gmail threads.list error (${listResponse.status}): ${detail}`);
      }
      staleCursorRecoverable = false;
      const listData = (await listResponse.json()) as GmailThreadListResponse;
      const threads = listData.threads ?? [];
      for (const threadStub of threads) {
        inspected++;
        try {
          const response = await http.raw(`${this.BASE_URL}/threads/${threadStub.id}?format=full`);
          // A thread deleted between list and get has nothing left to sync.
          // Other failures must fail the run so the same window is retried
          // rather than checkpointed as complete.
          if (response.status === 404) continue;
          if (!response.ok) {
            throw new Error(`Gmail threads.get error (${response.status}): ${await response.text()}`);
          }
          const thread = (await response.json()) as GmailThreadGetResponse;
          if (!thread.messages?.length) throw new Error('Gmail returned a thread without messages');
          const messages = [...thread.messages].sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
          const firstMessage = messages[0];
          const latestMessage = messages[messages.length - 1];
          const occurredAt = new Date(Number(latestMessage.internalDate));
          if (Number.isNaN(occurredAt.getTime())) throw new Error('Gmail returned an invalid message date');
          const attribution = this.resolvePersonAttribution(messages, humanSendersOnly);
          if (humanSendersOnly && !attribution.personRelevant) continue;
          const messageTexts: string[] = [];
          for (const message of messages) {
            const body = await this.extractBody(message.payload, http, message.id) || message.snippet || '';
            messageTexts.push([
              `Message: ${message.id}`,
              `From: ${this.getHeader(message, 'From') || 'Unknown'}`,
              `To: ${this.getHeader(message, 'To') || ''}`,
              `Date: ${this.getHeader(message, 'Date') || new Date(Number(message.internalDate)).toISOString()}`,
              '', body,
            ].join('\n'));
          }
          events.push({
            origin_id: thread.id,
            title: this.getHeader(firstMessage, 'Subject') || '(no subject)',
            payload_text: messageTexts.join('\n\n---\n\n'),
            author_name: attribution.from,
            source_url: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`,
            occurred_at: occurredAt,
            origin_type: 'thread',
            metadata: {
              message_count: messages.length,
              label_ids: [...new Set(messages.flatMap((message) => message.labelIds ?? []))],
              snippet: latestMessage.snippet,
              replied: attribution.replied,
              person_relevant: attribution.personRelevant,
              ...(attribution.fromEmail ? { from_email: attribution.fromEmail } : {}),
              ...(attribution.fromName ? { from_name: attribution.fromName } : {}),
            },
          });
        } finally {
          await sleep(this.RATE_LIMIT_MS);
        }
      }
      if (listData.nextPageToken && listData.nextPageToken === pageToken) {
        throw new Error('Gmail returned a repeated page token');
      }
      pageToken = listData.nextPageToken;
      // An empty page with a cursor is still incomplete. Persist its cursor
      // rather than advance the window or spin on empty provider responses.
      if (threads.length === 0) break;
      if (!pageToken || inspected >= maxResults) break;
    }

    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
    // A part-walked window keeps the previous `last_sync_at`: it may not advance
    // until the whole window has been walked, or the unread tail is skipped.
    const newCheckpoint: GmailCheckpoint = pageToken
      ? {
          schema_version: 2,
          scope: scopeKey,
          ...(resumable && checkpoint.last_sync_at ? { last_sync_at: checkpoint.last_sync_at } : {}),
          pending: { query, started_at: windowStart, page_token: pageToken },
        }
      : { schema_version: 2, scope: scopeKey, last_sync_at: windowStart };

    return {
      events,
      checkpoint: newCheckpoint,
      metadata: {
        items_found: events.length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      const token = ctx.credentials?.accessToken;
      if (!token) {
        return { success: false, error: 'Gmail actions require Google OAuth credentials.' };
      }

      const http = this.createClient(token);

      switch (ctx.actionKey) {
        case 'send_email':
          return await this.sendEmail(http, ctx.input);
        case 'create_draft':
          return await this.createDraft(http, ctx.input);
        case 'reply':
          return await this.replyToThread(http, ctx.input);
        case 'search':
          return await this.searchEmails(http, ctx.input);
        case 'get_thread':
          return await this.getThread(http, ctx.input);
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
  // Direct source read — read-only, never persisted.
  // -------------------------------------------------------------------------

  /**
   * Shared live read: build a Gmail `q` from the base predicate plus optional
   * keyword terms, list matching messages, then fetch each message's metadata
   * (Subject/From/Date) + snippet. Returns rows + a stable column set.
   */
  private async readFeed(ctx: FeedReadContext<GmailConfig>): Promise<FeedReadResult> {
    const token = ctx.credentials?.accessToken;
    if (!token) {
      throw new Error('Gmail source reads require Google OAuth credentials.');
    }

    // Gmail's `q` is space-separated = AND. Compose the feed's optional scope
    // (config.query) with the caller's terms as raw Gmail search syntax — each
    // feed read owns its query semantics; we do not escape Gmail operators here.
    // An empty string means no `q` filter — list the authenticated mailbox.
    const parts = [ctx.config.query, ctx.query].map((part) => part?.trim()).filter(Boolean);
    const q = parts.join(' ');

    // Gmail search has no arbitrary sort — results are always reverse-chronological
    // (newest first). Reject a sort we can't honor rather than silently ignore it.
    if (ctx.sort && !(ctx.sort.column === 'date' && ctx.sort.order === 'desc')) {
      throw new Error(
        `Gmail source reads only support sort {column:'date', order:'desc'} (newest first); got ${JSON.stringify(ctx.sort)}.`
      );
    }

    const limit = Math.min(Math.max(Math.trunc(ctx.limit ?? ctx.config.max_results ?? 25), 1), 100);
    const offset = Math.max(Math.trunc(ctx.offset ?? 0), 0);
    if (offset > 0) {
      throw new Error('Gmail source reads paginate with the returned cursor, not an offset.');
    }

    const http = this.createClient(token);
    const page = await this.listMessagePage(http, q, limit, ctx.cursor);
    const rows = await this.fetchMessageRows(http, page.messages);

    // No `total`: Gmail's list endpoint returns no reliable match count, and
    // `resultSizeEstimate` is a coarse estimate — reporting the page length as a
    // total would be wrong. Callers page until a short page.
    return {
      rows,
      columns: GMAIL_SEARCH_COLUMNS,
      nextCursor: page.nextPageToken,
      hasMore: Boolean(page.nextPageToken),
    };
  }

  private async listMessagePage(
    http: HttpClient,
    q: string,
    limit: number,
    pageToken?: string
  ): Promise<{
    messages: Array<{ id: string; threadId: string }>;
    nextPageToken?: string;
  }> {
    const params = new URLSearchParams({ maxResults: String(Math.min(100, limit)) });
    if (q) params.set('q', q);
    if (pageToken) params.set('pageToken', pageToken);
    const res = await http.raw(`${this.BASE_URL}/messages?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Gmail messages.list error (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
    };
    return { messages: data.messages ?? [], nextPageToken: data.nextPageToken };
  }

  private async fetchMessageRows(
    http: HttpClient,
    ids: Array<{ id: string; threadId: string }>
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (const m of ids) {
      const url = `${this.BASE_URL}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
      const res = await http.raw(url);
      if (!res.ok) continue; // skip a single unreachable message, keep the batch reliable
      const msg = (await res.json()) as GmailMessage;
      const rawFrom = this.getHeader(msg, 'From') || 'Unknown';
      const { name, email } = this.parseFromHeader(rawFrom);
      rows.push({
        id: msg.id,
        thread_id: msg.threadId,
        subject: this.getHeader(msg, 'Subject') || '(no subject)',
        from: rawFrom,
        from_name: name,
        from_email: email,
        date: this.getHeader(msg, 'Date') || '',
        snippet: msg.snippet || '',
        url: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
      });
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async sendEmail(http: HttpClient, input: Record<string, unknown>): Promise<ActionResult> {
    const to = input.to as string;
    const subject = input.subject as string;
    const body = input.body as string;
    const cc = input.cc as string | undefined;
    const bcc = input.bcc as string | undefined;

    if (!to || !subject || !body) {
      return { success: false, error: 'to, subject, and body are required.' };
    }

    // Build RFC 2822 message
    const messageParts: string[] = [`To: ${to}`, `Subject: ${subject}`];
    if (cc) messageParts.push(`Cc: ${cc}`);
    if (bcc) messageParts.push(`Bcc: ${bcc}`);
    messageParts.push('Content-Type: text/plain; charset=utf-8');
    messageParts.push('');
    messageParts.push(body);

    const rawMessage = messageParts.join('\r\n');
    const encoded = this.base64UrlEncode(rawMessage);

    const sendUrl = `${this.BASE_URL}/messages/send`;
    const response = await http.raw(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Gmail send error (${response.status}): ${errText}` };
    }

    const result = (await response.json()) as { id: string; threadId: string; labelIds: string[] };

    return {
      success: true,
      output: {
        message_id: result.id,
        thread_id: result.threadId,
        url: `https://mail.google.com/mail/u/0/#inbox/${result.threadId}`,
      },
    };
  }

  private async createDraft(
    http: HttpClient,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const to = input.to as string;
    const subject = input.subject as string;
    const body = input.body as string;
    const cc = input.cc as string | undefined;
    const bcc = input.bcc as string | undefined;
    const threadId = input.thread_id as string | undefined;

    if (!to || !subject || !body) {
      return { success: false, error: 'to, subject, and body are required.' };
    }

    const messageParts: string[] = [`To: ${to}`, `Subject: ${subject}`];
    if (cc) messageParts.push(`Cc: ${cc}`);
    if (bcc) messageParts.push(`Bcc: ${bcc}`);
    messageParts.push('Content-Type: text/plain; charset=utf-8', '', body);

    const raw = this.base64UrlEncode(messageParts.join('\r\n'));
    const draftBody: { message: { raw: string; threadId?: string } } = { message: { raw } };
    if (threadId) draftBody.message.threadId = threadId;

    const response = await http.raw(`${this.BASE_URL}/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draftBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Gmail draft error (${response.status}): ${errText}` };
    }

    const result = (await response.json()) as {
      id: string;
      message: { id: string; threadId: string };
    };
    return {
      success: true,
      output: {
        draft_id: result.id,
        message_id: result.message.id,
        thread_id: result.message.threadId,
        url: `https://mail.google.com/mail/u/0/#drafts/${result.message.id}`,
      },
    };
  }

  private async replyToThread(
    http: HttpClient,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const threadId = input.thread_id as string;
    const body = input.body as string;
    const cc = input.cc as string | undefined;

    if (!threadId || !body) {
      return { success: false, error: 'thread_id and body are required.' };
    }

    // Fetch the thread to get the last message's headers
    const threadRes = await http.raw(
      `${this.BASE_URL}/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID`
    );
    if (!threadRes.ok) {
      return {
        success: false,
        error: `Failed to fetch thread (${threadRes.status}): ${await threadRes.text()}`,
      };
    }

    const thread = (await threadRes.json()) as { messages: GmailMessage[] };
    const lastMsg = thread.messages[thread.messages.length - 1];
    const subject = this.getHeader(lastMsg, 'Subject') || '';
    const from = this.getHeader(lastMsg, 'From') || '';
    const messageId = this.getHeader(lastMsg, 'Message-ID') || '';
    const to = (input.to as string) || from;

    const messageParts: string[] = [
      `To: ${to}`,
      `Subject: ${subject.startsWith('Re:') ? subject : `Re: ${subject}`}`,
      `In-Reply-To: ${messageId}`,
      `References: ${messageId}`,
    ];
    if (cc) messageParts.push(`Cc: ${cc}`);
    messageParts.push('Content-Type: text/plain; charset=utf-8', '', body);

    const raw = this.base64UrlEncode(messageParts.join('\r\n'));

    const response = await http.raw(`${this.BASE_URL}/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, threadId }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Gmail reply error (${response.status}): ${errText}` };
    }

    const result = (await response.json()) as { id: string; threadId: string };
    return {
      success: true,
      output: {
        message_id: result.id,
        thread_id: result.threadId,
        url: `https://mail.google.com/mail/u/0/#inbox/${result.threadId}`,
      },
    };
  }

  private async searchEmails(
    http: HttpClient,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const query = input.query as string;
    const maxResults = (input.max_results as number) || 10;

    if (!query) {
      return { success: false, error: 'query is required.' };
    }

    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });
    const listUrl = `${this.BASE_URL}/messages?${params.toString()}`;
    const listResponse = await http.raw(listUrl);

    if (!listResponse.ok) {
      const errText = await listResponse.text();
      return { success: false, error: `Gmail search error (${listResponse.status}): ${errText}` };
    }

    const listData = (await listResponse.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
    };

    if (!listData.messages || listData.messages.length === 0) {
      return { success: true, output: { messages: [] } };
    }

    const messages: Array<{
      id: string;
      thread_id: string;
      subject: string;
      from: string;
      date: string;
      url: string;
    }> = [];

    for (const msg of listData.messages) {
      const msgUrl = `${this.BASE_URL}/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
      const msgResponse = await http.raw(msgUrl);
      if (!msgResponse.ok) continue;

      const msgData = (await msgResponse.json()) as GmailMessage;
      messages.push({
        id: msgData.id,
        thread_id: msgData.threadId,
        subject: this.getHeader(msgData, 'Subject') || '(no subject)',
        from: this.getHeader(msgData, 'From') || 'Unknown',
        date: this.getHeader(msgData, 'Date') || '',
        url: `https://mail.google.com/mail/u/0/#inbox/${msgData.threadId}`,
      });
    }

    return { success: true, output: { messages } };
  }

  private async getThread(http: HttpClient, input: Record<string, unknown>): Promise<ActionResult> {
    const threadId = input.thread_id as string;

    if (!threadId) {
      return { success: false, error: 'thread_id is required.' };
    }

    const url = `${this.BASE_URL}/threads/${threadId}?format=full`;
    const response = await http.raw(url);

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Gmail thread error (${response.status}): ${errText}` };
    }

    const thread = (await response.json()) as GmailThreadGetResponse;
    const subject =
      thread.messages.length > 0
        ? this.getHeader(thread.messages[0], 'Subject') || '(no subject)'
        : '(no subject)';

    const messages = [];
    for (const msg of thread.messages) {
      messages.push({
        id: msg.id,
        from: this.getHeader(msg, 'From') || 'Unknown',
        date: this.getHeader(msg, 'Date') || '',
        snippet: msg.snippet,
        body: await this.extractBody(msg.payload, http, msg.id),
      });
    }

    return {
      success: true,
      output: {
        thread_id: thread.id,
        subject,
        messages,
        url: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private resolvePersonAttribution(
    messages: GmailMessage[],
    humanSendersOnly: boolean
  ): {
    replied: boolean;
    personRelevant: boolean;
    from: string;
    fromName: string | null;
    fromEmail: string | null;
  } {
    const sentMessages = messages.filter(isSentMessage);
    const draftMessages = messages.filter(isDraftMessage);
    const selfMessages = [...sentMessages, ...draftMessages];
    const selfAddresses = new Set(
      selfMessages
        .map((message) =>
          normalizeSelfEmail(this.parseFromHeader(this.getHeader(message, 'From') ?? '').email)
        )
        .filter(Boolean)
    );
    const isSelf = (email: string): boolean =>
      selfAddresses.has(normalizeSelfEmail(email));
    const inbound = messages
      // DRAFTs are self-authored (unsent) — never inbound counterparties.
      .filter((message) => !isSentMessage(message) && !isDraftMessage(message))
      .flatMap((message) => {
        const from = this.getHeader(message, 'From') ?? 'Unknown';
        const parsed = this.parseFromHeader(from);
        return parsed.email ? [{ from, name: parsed.name, email: parsed.email }] : [];
      })
      .filter((sender) => !isSelf(sender.email));

    // A SENT message with no parseable From leaves self-vs-counterparty
    // unknowable. It may still be stored in default mode, but must not drive
    // person creation or count a mailbox copy as a reply.
    const hasKnownSelf = sentMessages.length === 0 || selfAddresses.size > 0;
    const replied = sentMessages.length > 0 && hasKnownSelf && inbound.length > 0;
    let selected = humanSendersOnly
      ? inbound.find((sender) => isPersonRelevantSender(sender.email, sender.name, replied))
      : inbound[0];

    // Outbound-only fallback: no plausible human inbound sender, so look for a
    // plausible human RECIPIENT across every sent message's To+Cc — the first
    // sent message may target a role address while a human sits in Cc or on a
    // later sent message. `selectedSentMessage` remembers which message carried
    // the recipient so the broadcast-cap check counts that message, not the
    // first sent one.
    let selectedSentMessage: GmailMessage | undefined;
    if (!selected && humanSendersOnly && hasKnownSelf) {
      for (const sentMessage of sentMessages) {
        const recipient = this.parseAddressList(
          `${this.getHeader(sentMessage, 'To') ?? ''}, ${this.getHeader(sentMessage, 'Cc') ?? ''}`
        ).find(
          (sender) =>
            !isSelf(sender.email) &&
            isPersonRelevantSender(sender.email, sender.name, false)
        );
        if (recipient) {
          selected = recipient;
          selectedSentMessage = sentMessage;
          break;
        }
      }
    }

    const fromEmail = selected?.email ?? null;
    const fromName = selected?.name ?? null;
    const personRelevant = humanSendersOnly
      ? !!selected &&
        hasKnownSelf &&
        !this.isListThread(messages) &&
        (replied ||
          this.externalRecipientCount(selectedSentMessage, isSelf) <= BROADCAST_RECIPIENT_CAP)
      : replied;

    return {
      replied,
      personRelevant,
      from: selected?.from ?? 'Unknown',
      fromName,
      fromEmail,
    };
  }

  private isListThread(messages: GmailMessage[]): boolean {
    return messages.some((message) => {
      if ((this.getHeader(message, 'List-Id') ?? '').trim()) return true;
      const precedence = (this.getHeader(message, 'Precedence') ?? '').trim().toLowerCase();
      return BULK_PRECEDENCE.has(precedence);
    });
  }

  private externalRecipientCount(
    message: GmailMessage | undefined,
    isSelf: (email: string) => boolean
  ): number {
    if (!message) return 0;
    const recipients = [
      ...this.parseAddressList(this.getHeader(message, 'To')),
      ...this.parseAddressList(this.getHeader(message, 'Cc')),
    ];
    return new Set(
      recipients
        .map((recipient) => normalizeEmail(recipient.email))
        .filter((email) => email && !isSelf(email))
    ).size;
  }

  /** Split an RFC 5322 address list without splitting quoted display names. */
  private parseAddressList(
    raw: string | undefined
  ): Array<{ from: string; name: string | null; email: string }> {
    if (!raw?.trim()) return [];
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    let inAngle = false;
    for (const char of raw) {
      if (char === '"') inQuotes = !inQuotes;
      else if (char === '<' && !inQuotes) inAngle = true;
      else if (char === '>' && !inQuotes) inAngle = false;
      if (char === ',' && !inQuotes && !inAngle) {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    parts.push(current);
    return parts.flatMap((part) => {
      const from = part.trim();
      const parsed = this.parseFromHeader(from);
      return parsed.email ? [{ from, name: parsed.name, email: parsed.email }] : [];
    });
  }

  private getHeader(message: GmailMessage, name: string): string | undefined {
    const header = message.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return header?.value;
  }

  /**
   * Parse an RFC 5322 From header into display name and email address.
   * Accepts: "Name <addr@host>", "<addr@host>", "addr@host", or quoted names.
   */
  private parseFromHeader(raw: string): { name: string | null; email: string | null } {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'Unknown') return { name: null, email: null };

    const angleMatch = trimmed.match(/^(.*?)<([^>]+)>\s*$/);
    if (angleMatch) {
      const name = angleMatch[1].trim().replace(/^"|"$/g, '').trim();
      const email = angleMatch[2].trim();
      return { name: name || null, email: email || null };
    }

    if (trimmed.includes('@') && !trimmed.includes(' ')) {
      return { name: null, email: trimmed };
    }

    return { name: trimmed, email: null };
  }

  private async extractBody(
    payload: GmailMessagePayload,
    http: HttpClient,
    messageId: string
  ): Promise<string> {
    const disposition = payload.headers?.find((h) => h.name.toLowerCase() === 'content-disposition')
      ?.value.split(';', 1)[0].trim().toLowerCase();
    // Explicit inline parts can have filenames. Other declared dispositions
    // (including extensions) are attachments; otherwise use the filename hint.
    if (disposition !== 'inline' && (disposition || payload.filename)) return '';
    const mimeType = payload.mimeType.toLowerCase();
    if (payload.parts?.length) {
      // Only multipart/alternative contains equivalent versions. Mixed parts
      // are separate sections and must all be retained in their original order.
      const isAlternative = mimeType === 'multipart/alternative';
      const parts = isAlternative
        ? [
            ...payload.parts.filter((part) => part.mimeType.toLowerCase() === 'text/plain'),
            ...payload.parts.filter((part) => part.mimeType.toLowerCase() !== 'text/plain'),
          ]
        : payload.parts;
      const sections: string[] = [];
      for (const part of parts) {
        const text = await this.extractBody(part, http, messageId);
        if (!text) continue;
        if (isAlternative) return text;
        sections.push(text);
      }
      return sections.join('\n\n');
    }
    if (mimeType !== 'text/plain' && mimeType !== 'text/html') return '';
    let text = '';
    if (payload.body?.data) {
      text = this.base64UrlDecode(payload.body.data, payload);
    } else if (payload.body?.attachmentId) {
      // Gmail may externalize the body itself, even under format=full. A
      // failed fetch must not silently replace that body with its alternative.
      const response = await http.raw(`${this.BASE_URL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(payload.body.attachmentId)}`);
      if (!response.ok) throw new Error(`Gmail message body error (${response.status}): ${await response.text()}`);
      const body = (await response.json()) as { data?: string };
      if (typeof body.data !== 'string') throw new Error('Gmail returned a message body without data');
      text = this.base64UrlDecode(body.data, payload);
    }
    if (!text && payload.body?.size) throw new Error('Gmail returned a nonempty message body without data');
    // An empty plain-text alternative must not hide a readable HTML body.
    return text.trim() ? text : '';
  }

  private base64UrlDecode(data: string, payload: GmailMessagePayload): string {
    const padded = data.replace(/-/g, '+').replace(/_/g, '/');
    const contentType = payload.headers?.find((header) => header.name.toLowerCase() === 'content-type')?.value;
    const charset = contentType?.match(/;\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i);
    const encoding = (charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? 'utf-8').trim();
    // MIME bodies contain bytes in the part's declared charset. Invalid bytes
    // or unsupported labels must fail the read instead of persisting corruption.
    return new TextDecoder(encoding, { fatal: true }).decode(Buffer.from(padded, 'base64'));
  }

  private base64UrlEncode(str: string): string {
    const encoded = Buffer.from(str, 'utf-8').toString('base64');
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private createClient(token: string): HttpClient {
    return createHttpClient({ token, errorPrefix: 'Gmail API' });
  }
}

// ---------------------------------------------------------------------------
// Person-relevance heuristic
// ---------------------------------------------------------------------------

const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);
const BROADCAST_RECIPIENT_CAP = 3;
const isSentMessage = (message: GmailMessage): boolean =>
  (message.labelIds ?? []).includes('SENT');
const isDraftMessage = (message: GmailMessage): boolean =>
  (message.labelIds ?? []).includes('DRAFT');
const normalizeEmail = (email: string | null | undefined): string =>
  (email ?? '').trim().toLowerCase();
/**
 * Canonicalize an address for SELF-detection (the mailbox owner): lowercase
 * plus Gmail/Workspace `+tag` removal, so `me+archive@example.com` counts as
 * the same mailbox as `me@example.com`. Only for self-vs-counterparty
 * comparison — the event's from_email identity is kept verbatim.
 */
const normalizeSelfEmail = (email: string | null | undefined): string => {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return normalized;
  const local = normalized.slice(0, at).split('+', 1)[0];
  return `${local}@${normalized.slice(at + 1)}`;
};

/**
 * Local-parts that are almost never a human counterparty: automated/system
 * addresses (no-reply, bounce, mailer-daemon) and shared brand inboxes
 * (info@, marketing@, support@, hello@, …). Matched against the lowercased
 * local part of the From address.
 */
const AUTOMATED_LOCAL_PARTS = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|donotreply|noreply|no\.reply|bounce|mailer[._-]?daemon|postmaster|abuse|notif(?:ications?|y)?|alert(?:s)?|support|team|info|news(?:letter)?s?|market(?:ing)?s?|contact(?:s)?|update(?:s)?|jobs|careers|press|media|event(?:s)?|webmaster|automated|robot|hello|sales|billing|accounts|security|admin|root)$/;

/**
 * Consumer mail providers — a bare address here is overwhelmingly a personal
 * mailbox even without a display name or a replied thread.
 */
const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'ymail.com',
  'proton.me',
  'protonmail.com',
  'fastmail.com',
  'zoho.com',
  'mail.com',
  'aol.com',
]);

/**
 * A display name that looks like a person's name: two or more capitalized
 * words ("John Smith", "Ana-Maria O'Brien"). Single-word brands ("LinkedIn",
 * "Spotify") and lowercase handles fail this, so a non-consumer corporate
 * sender needs a human-looking name to clear the bar.
 */
const HUMAN_NAME_RE = /^[A-ZÀ-Ý][a-zà-ÿ]+(?:[ '\u2019-][A-ZÀ-Ý][a-zà-ÿ]+)+$/;

/**
 * Whether a thread's counterparty is eligible for person minting under
 * `human_senders_only`. Role/system mailboxes never qualify. A replied
 * non-role address qualifies directly; an unreplied address additionally needs
 * a consumer-mail domain or a human-looking display name.
 */
export function isPersonRelevantSender(
  email: string | null | undefined,
  name: string | null | undefined,
  replied: boolean
): boolean {
  if (!email) return false;
  if (email.indexOf('@') !== email.lastIndexOf('@')) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const local = email.slice(0, at).trim().toLowerCase();
  const domain = email.slice(at + 1).trim().toLowerCase();
  const baseLocal = local.split('+', 1)[0];
  if (!local || !domain || AUTOMATED_LOCAL_PARTS.test(baseLocal)) return false;
  if (replied) return true;
  if (CONSUMER_MAIL_DOMAINS.has(domain)) return true;
  if (!name) return false;
  return HUMAN_NAME_RE.test(name.trim());
}
