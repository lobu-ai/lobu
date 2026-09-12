/**
 * Google Drive Connector (V1 runtime)
 *
 * Syncs Drive file metadata — and, for text-shaped files, the text itself —
 * via the Drive API v3, and exposes a read action that returns one file's
 * content on demand.
 *
 * Two Drive-specific facts shape this connector:
 *
 * 1. **Google-native files have no bytes.** A Doc/Sheet/Slide is not stored as
 *    a file; `files.get?alt=media` fails on them with a 403. They must go
 *    through `files.export` with a target MIME type, and Google caps an export
 *    at 10 MB. Everything else (PDF, CSV, images, archives) downloads directly.
 *    `EXPORT_MIME_TYPES` is the whole of that branch.
 *
 * 2. **`changes.list` is the incremental axis, and its page token is durable.**
 *    Unlike Calendar's syncToken — handed back at the END of a traversal —
 *    Drive mints the token UP FRONT via `changes.getStartPageToken`. So a full
 *    sync must take the token BEFORE listing, or every file created during the
 *    traversal is missed forever. See `syncFeed`.
 */

import {
  type ActionContext,
  type ActionResult,
  ConnectorRuntime,
  createHttpClient,
  type EventEnvelope,
  type HttpClient,
  paginateByCursor,
  type FeedReadContext,
  type FeedReadResult,
  type RuntimeConnectorDefinition,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Drive API types
// ---------------------------------------------------------------------------

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  description?: string;
  webViewLink?: string;
  /** int64 as a decimal string — absent for Google-native files, which have no byte size. */
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  trashed?: boolean;
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
  lastModifyingUser?: { emailAddress?: string; displayName?: string };
  parents?: string[];
}

interface DriveFileListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
  incompleteSearch?: boolean;
}

interface DriveChange {
  fileId?: string;
  removed?: boolean;
  time?: string;
  file?: DriveFile;
}

interface DriveChangeListResponse {
  changes?: DriveChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

interface DriveStartPageTokenResponse {
  startPageToken?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint + config
// ---------------------------------------------------------------------------

interface DriveCheckpoint {
  /** `changes.list` page token. Its absence forces a full re-list. */
  page_token?: string;
  last_sync_at?: string;
  /**
   * Resumable-bootstrap state.
   *
   * A Drive larger than `max_results` cannot be listed in one run, and the
   * change token must NOT take over until the listing has actually finished:
   * `changes.list` only reports files that change, so anything never reached by
   * the traversal would never arrive at all. So the token minted at the start of
   * the bootstrap is parked in `pending_page_token` while `list_page_token`
   * walks the remaining pages; only when the walk exhausts is the parked token
   * promoted to `page_token` and the feed allowed to go incremental.
   */
  pending_page_token?: string;
  /** `files.list` cursor for the next bootstrap slice. Absent once complete. */
  list_page_token?: string;
}

interface DriveConfig extends Record<string, unknown> {
  query?: string;
  folder_id?: string;
  include_trashed?: boolean;
  include_content?: boolean;
  max_results?: number;
}

/**
 * Google-native MIME type -> the export format we ask for.
 *
 * Text targets on purpose: this connector's job is to make a file's CONTENT
 * searchable and countable, not to reproduce its formatting. A Sheet exports
 * to CSV because rows are the meaningful unit; a Doc to text/plain because
 * paragraphs are.
 *
 * Types deliberately absent (folder, shortcut, form, map, site) have no
 * useful text export — `exportMimeTypeFor` returns undefined and the sync
 * records metadata only.
 */
const EXPORT_MIME_TYPES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
};

/** MIME types we will inline as `payload_text` when they are not Google-native. */
const TEXTUAL_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/sql',
  'application/x-sh',
]);

/**
 * Cap on text inlined into `payload_text`.
 *
 * This is NOT the artifact limit — it is an embedding-cost limit. Every event's
 * payload is chunked and embedded, so a 10 MB CSV inlined here would produce
 * hundreds of vectors of almost no retrieval value. Files above the cap sync as
 * metadata and their content is fetched on demand through `get_file_content`.
 */
const MAX_INLINE_TEXT_BYTES = 256 * 1024;

/**
 * Grace window subtracted from `last_sync_at` before deciding a file's content
 * is unchanged.
 *
 * `modifiedTime` comes from Google's clock and `last_sync_at` from ours. Only a
 * file modified strictly BEFORE the previous sync can be safely skipped, and a
 * few minutes of skew in the wrong direction would otherwise make a genuinely
 * edited file look old and get skipped. Erring by this much only costs a
 * redundant fetch; erring the other way loses an edit.
 */
const CONTENT_SKEW_GRACE_MS = 5 * 60 * 1000;

/** Google's own hard cap on `files.export`. Requesting more returns a 403. */
const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

/** Field mask for files.list / changes.list. Drive v3 returns almost nothing without it. */
const FILE_FIELDS =
  'id,name,mimeType,description,webViewLink,size,createdTime,modifiedTime,trashed,owners(emailAddress,displayName),lastModifyingUser(emailAddress,displayName),parents';

const DRIVE_FILE_COLUMNS = [
  { name: 'id', type: 'text' },
  { name: 'name', type: 'text' },
  { name: 'mime_type', type: 'text' },
  { name: 'size_bytes', type: 'number' },
  { name: 'owner', type: 'text' },
  { name: 'last_modified_by', type: 'text' },
  { name: 'created_at', type: 'text' },
  { name: 'modified_at', type: 'text' },
  { name: 'trashed', type: 'boolean' },
  { name: 'url', type: 'text' },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Does this `changes.list` failure mean "the stored page token is unusable"
 * rather than "your credentials are wrong"?
 *
 * Drive answers a dead token with 404 NOT FOUND (Calendar uses 410 for the
 * same condition — see `google_calendar.ts`). 410 is accepted here too because
 * Drive documents it for a token that has aged out of the change log, and the
 * recovery is identical either way: drop the token and re-list once.
 *
 * Deliberately NOT matched: 401/403. Those are credential or scope problems,
 * and treating them as a stale token would turn a missing-scope install into an
 * unbounded full-resync loop.
 */
function isPageTokenRejection(status: number): boolean {
  return status === 404 || status === 410;
}

/**
 * Truncate encoded UTF-8 to at most `maxBytes` WITHOUT splitting a character.
 *
 * A plain `slice(0, maxBytes)` can cut mid-sequence, and the decoder turns the
 * orphaned bytes into U+FFFD — a garbage character that then gets stored and
 * embedded. Back off up to three bytes (the longest UTF-8 tail) until the slice
 * decodes cleanly, so a legitimate U+FFFD already in the source is preserved
 * while a manufactured one is impossible.
 */
function decodeTruncated(encoded: Uint8Array, maxBytes: number): string {
  const strict = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end > maxBytes - 4 && end >= 0; end--) {
    try {
      return strict.decode(encoded.slice(0, end));
    } catch {
      // Slice ended mid-sequence — drop a byte and retry.
    }
  }
  // Unreachable: `encoded` always comes from TextEncoder, so one of the four
  // slices above lands on a character boundary. Returning lossily here would
  // manufacture the very U+FFFD this function exists to prevent.
  return '';
}

function exportMimeTypeFor(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  return EXPORT_MIME_TYPES[mimeType];
}

function isGoogleNative(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.startsWith('application/vnd.google-apps.'));
}

function isTextualMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  return TEXTUAL_MIME_TYPES.has(base) || base.startsWith('text/');
}

/** Drive reports size as a decimal string, and omits it entirely for native files. */
function parseSize(size: string | undefined): number | undefined {
  if (typeof size !== 'string' || size.length === 0) return undefined;
  const parsed = Number.parseInt(size, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function personLabel(
  person: { emailAddress?: string; displayName?: string } | undefined
): string | undefined {
  return person?.displayName || person?.emailAddress || undefined;
}

/**
 * Drive models a folder as a file with a reserved MIME type, so an unfiltered
 * `files.list` returns the directory tree interleaved with the documents. A
 * folder carries no content and no `size`, so every one of them lands as a
 * name-only event: on a real Drive that measured 8,258 of 9,200 rows — 90%
 * noise that costs an embedding each, dilutes search, and stretches the
 * bootstrap over ten times as many runs as the documents alone need.
 *
 * Excluded at the QUERY, not after the fetch, so the pages Drive returns are
 * documents and the per-run cap counts things worth storing.
 */
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/** Where the host kills a feed run, discarding its checkpoint with it. */
const HOST_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Wall-clock budget for one sync run, tested at page boundaries.
 *
 * A killed run persists NO checkpoint, so a traversal that overruns does not
 * merely stall: it throws away the work it just did, the next run repeats it
 * and overruns again — a bootstrap that can never finish. The item cap cannot
 * prevent that, because it cannot see what an item costs. Measured per item on
 * one real Drive: 0.61-0.86s when a content export is involved, 0.01-0.03s for
 * metadata only. A 30x spread means the same cap is either wasteful or fatal.
 *
 * The budget cannot stop a page already in flight, so the true worst case is
 * budget + one page. At the slowest rate observed and a 100-item content page
 * that is 240s + 86s = 326s, ~54% of the host limit, leaving the rest as
 * headroom for the client's 429/5xx backoff — which is unbounded in principle
 * and is why this keeps a wide margin rather than creeping toward the limit.
 */
const SYNC_TIME_BUDGET_MS = HOST_RUN_TIMEOUT_MS * 0.4;

/**
 * Escapes a value for a single-quoted Drive query literal.
 *
 * Backslashes go FIRST: escaping quotes first would then double-escape the
 * backslashes it just introduced. Escaping quotes ALONE is not enough — a value
 * ending in a backslash would escape its own closing quote and run on into
 * query syntax (`js/incomplete-sanitization`).
 */
function escapeQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Build the `q` for files.list.
 *
 * Always non-empty: the folder exclusion is unconditional. `trashed = false` is
 * applied on top unless the feed opts in, because a trashed file is still
 * returned by an unqualified query and would otherwise resurface on every full
 * sync as if it were live.
 */
function buildListQuery(config: DriveConfig): string {
  const clauses: string[] = [`mimeType != '${FOLDER_MIME_TYPE}'`];
  if (!config.include_trashed) clauses.push('trashed = false');
  if (typeof config.folder_id === 'string' && config.folder_id.trim()) {
    clauses.push(`'${escapeQueryLiteral(config.folder_id.trim())}' in parents`);
  }
  const raw = typeof config.query === 'string' ? config.query.trim() : '';
  if (raw) clauses.push(`(${raw})`);
  return clauses.join(' and ');
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class GoogleDriveConnector extends ConnectorRuntime<
  Record<string, unknown>,
  DriveConfig
> {
  private readonly BASE_URL = 'https://www.googleapis.com/drive/v3';

  readonly definition: RuntimeConnectorDefinition<Record<string, unknown>, DriveConfig> = {
    key: 'google.drive',
    name: 'Google Drive',
    description:
      'Syncs Google Drive file metadata and text content, and reads a file on demand.',
    version: '1.0.1',
    faviconDomain: 'drive.google.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'google',
          requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
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
      files: {
        key: 'files',
        name: 'Files',
        requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
        description:
          'Google Drive files can sync into memory and be read directly from Drive.',
        sync: (ctx) => this.syncFeed(ctx),
        read: (ctx) => this.readFeed(ctx),
        readWindowAxis: 'modified_at',
        configSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Optional Drive query in Google\'s `q` syntax, e.g. "mimeType = \'application/pdf\'". Combined with the feed\'s own filters using AND. Drive cannot apply a query to its change log, so a feed that sets one keeps re-listing instead of switching to incremental sync.',
            },
            folder_id: {
              type: 'string',
              description:
                'Restrict to files whose parent is this folder ID. Enforced on both the initial listing and every later change.',
            },
            include_trashed: {
              type: 'boolean',
              default: false,
              description: 'Include files in the trash.',
            },
            include_content: {
              type: 'boolean',
              default: true,
              description:
                'Fetch text content for text files and exportable Google Docs/Sheets/Slides. Disable for a metadata-only feed.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 2000,
              default: 500,
              description:
                'Files collected per run. Initial collection resumes across runs until the whole Drive is walked, so this bounds one run rather than the total.',
            },
          },
        },
        eventKinds: {
          drive_file: {
            description: 'A Google Drive file',
            metadataSchema: {
              type: 'object',
              properties: {
                mime_type: { type: 'string' },
                size_bytes: { type: 'number' },
                owner: { type: 'string' },
                last_modified_by: { type: 'string' },
                created_at: { type: 'string' },
                modified_at: { type: 'string' },
                trashed: { type: 'boolean' },
                content_included: { type: 'boolean' },
                content_truncated: { type: 'boolean' },
                content_error: { type: 'string' },
                change_type: { type: 'string' },
              },
            },
          },
        },
      },
    },
    actions: {
      get_file_content: {
        key: 'get_file_content',
        kind: 'read',
        requiresApproval: false,
        name: 'Get File Content',
        description:
          'Read one Drive file as text. Google Docs/Sheets/Slides are exported (text/plain, CSV); other files are downloaded as-is. Binary files are rejected rather than returned as mojibake.',
        requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
        inputSchema: {
          type: 'object',
          required: ['file_id'],
          properties: {
            file_id: { type: 'string', description: 'Drive file ID to read.' },
            max_bytes: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_EXPORT_BYTES,
              description:
                'Truncate the returned text to this many bytes (default 1048576).',
            },
          },
        },
      },
      get_file: {
        key: 'get_file',
        kind: 'read',
        requiresApproval: false,
        name: 'Get File Metadata',
        description: 'Get one Drive file\'s metadata without fetching its content.',
        requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
        inputSchema: {
          type: 'object',
          required: ['file_id'],
          properties: {
            file_id: { type: 'string', description: 'Drive file ID.' },
          },
        },
      },
    },
  };

  // -------------------------------------------------------------------------
  // read (live, non-persisting)
  // -------------------------------------------------------------------------

  private async readFeed(ctx: FeedReadContext<DriveConfig>): Promise<FeedReadResult> {
    const token = ctx.credentials?.accessToken;
    if (!token) {
      throw new Error('Google Drive requires Google OAuth credentials.');
    }

    const http = this.client(token);
    const config = (ctx.config ?? {}) as DriveConfig;

    if ((ctx.offset ?? 0) > 0) throw new Error('Drive source reads paginate with a cursor, not an offset.');
    if (ctx.sort && !(ctx.sort.column === 'modified_at' && ctx.sort.order === 'desc')) {
      throw new Error('Drive source reads support modified_at descending sort only.');
    }
    const query = [buildListQuery(config), ctx.query].filter(Boolean).map((q) => `(${q})`);
    if (ctx.window) query.push(`modifiedTime >= '${new Date(ctx.window.start).toISOString()}' AND modifiedTime < '${new Date(ctx.window.end).toISOString()}'`);
    const params = new URLSearchParams({
      // Nothing materialises configSchema defaults, so the fallback here is
      // what `max_results` actually defaults to and must match what the schema
      // advertises. 1000 is Drive's own pageSize ceiling.
      pageSize: String(Math.max(1, Math.min(ctx.limit ?? config.max_results ?? 500, 1000))),
      fields: `files(${FILE_FIELDS}),nextPageToken,incompleteSearch`,
      orderBy: 'modifiedTime desc',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      q: query.join(' AND '),
    });
    if (ctx.cursor) params.set('pageToken', ctx.cursor);

    const response = await http.raw(`${this.BASE_URL}/files?${params.toString()}`);
    if (!response.ok) {
      throw new Error(
        `Drive files.list error (${response.status}): ${await response.text()}`
      );
    }

    const data = (await response.json()) as DriveFileListResponse;
    if (data.incompleteSearch) throw new Error('Drive returned an incomplete search; the window was not processed.');
    if (ctx.window && (data.files ?? []).some((file) => !file.id || !Number.isFinite(Date.parse(file.modifiedTime ?? '')))) {
      throw new Error('Drive returned malformed file identity or modified timestamp.');
    }
    const rows = (data.files ?? []).map((file) => this.driveFileToRow(file));

    return {
      rows,
      columns: [...DRIVE_FILE_COLUMNS],
      ...(ctx.window ? { window: { ...ctx.window, axis: 'modified_at' } } : {}),
      nextCursor: data.nextPageToken,
      hasMore: Boolean(data.nextPageToken),
    };
  }

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
    const token = ctx.credentials?.accessToken;
    if (!token) {
      throw new Error('Google Drive requires Google OAuth credentials.');
    }

    const http = this.client(token);
    const config = (ctx.config ?? {}) as DriveConfig;
    const checkpoint = (ctx.checkpoint ?? {}) as DriveCheckpoint;

    // An unfinished bootstrap outranks everything: going incremental with pages
    // still unread would strand every file the traversal never reached.
    if (checkpoint.list_page_token && checkpoint.pending_page_token) {
      return this.fullSync(http, config, {
        startToken: checkpoint.pending_page_token,
        listPageToken: checkpoint.list_page_token,
        startedAt: checkpoint.last_sync_at,
      });
    }

    if (checkpoint.page_token) {
      const result = await this.syncWithPageToken(
        http,
        checkpoint.page_token,
        config,
        checkpoint.last_sync_at
      );
      if (result) {
        // A partial run must NOT advance `last_sync_at`. The view-churn guard
        // skips content for files modified before that stamp, so stamping now
        // would make the next run treat the unread backlog as already-stored
        // and drop its content on the floor.
        return this.buildResult(
          result.events,
          result.nextPageToken,
          result.partial ? checkpoint.last_sync_at : undefined,
          { changesPending: result.partial }
        );
      }
      // Token rejected (see isPageTokenRejection). Fall through to ONE full
      // re-list, exactly as the Calendar connector does — never a retry loop.
    }

    return this.fullSync(http, config);
  }

  /**
   * Full re-list.
   *
   * The start page token is taken BEFORE listing, not after. Drive's change log
   * is a moving cursor: a token minted after the traversal would silently skip
   * every file created or edited while the traversal ran. Taking it first can
   * only cause the next incremental run to re-report a file we already have,
   * and a re-report supersedes on `origin_id` rather than duplicating.
   */
  private async fullSync(
    http: HttpClient,
    config: DriveConfig,
    resume?: { startToken: string; listPageToken: string; startedAt?: string }
  ): Promise<SyncResult> {
    // A resumed bootstrap keeps the token minted when the traversal STARTED —
    // re-minting here would open a gap covering everything changed since.
    const startToken = resume?.startToken ?? (await this.fetchStartPageToken(http));

    // The whole bootstrap reflects Drive as of the moment it BEGAN, so every
    // slice carries that one timestamp. Stamping each slice with its own finish
    // time would push `last_sync_at` past edits made while the bootstrap ran,
    // and the view-churn guard would then skip re-fetching their content — the
    // edit would land as metadata with stale text behind it.
    const bootstrapStartedAt = resume?.startedAt ?? new Date().toISOString();

    const maxResults = Math.min(config.max_results ?? 500, 2000);
    const includeContent = config.include_content !== false;
    const q = buildListQuery(config);
    const events: EventEnvelope[] = [];

    // 1000 is Drive's max pageSize, so 200 pages is 200k files — far past any
    // configurable max_results. Defensive bound against a self-referential
    // page token, matching the Calendar connector's MAX_PAGES.
    const MAX_PAGES = 200;

    // Where the traversal stopped, so the next run can pick it up. `undefined`
    // once the listing is exhausted — that is what completes the bootstrap.
    let nextListPageToken: string | undefined;
    let searchIncomplete = false;

    const pages = paginateByCursor<DriveFile, string>(
      async (cursor) => {
        const params = new URLSearchParams({
          // Drive's list cursor addresses PAGES, not offsets: stopping
          // mid-page and resuming at the next cursor drops the rest of that
          // page permanently, because the change feed only ever replays what
          // changes after the bootstrap. So the page is the unit for BOTH the
          // item cap and the time budget, and its size tracks what an item
          // costs — a content-fetching run does real work per file and must
          // re-check the clock often; a metadata-only run does not.
          pageSize: String(Math.min(includeContent ? 100 : 1000, Math.max(1, maxResults))),
          fields: `files(${FILE_FIELDS}),nextPageToken,incompleteSearch`,
          orderBy: 'modifiedTime desc',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          q,
        });
        if (cursor) params.set('pageToken', cursor);

        const response = await http.raw(`${this.BASE_URL}/files?${params.toString()}`);
        if (!response.ok) {
          throw new Error(
            `Drive files.list error (${response.status}): ${await response.text()}`
          );
        }
        const data = (await response.json()) as DriveFileListResponse;
        nextListPageToken = data.nextPageToken;
        // Google sets this when an `allDrives` search could not reach every
        // corpus — the listing is then NOT authoritative, and files missing
        // from it are indistinguishable from files that do not exist. We list
        // across all drives, so this is reachable; record it rather than let a
        // partial traversal look like a complete one.
        if (data.incompleteSearch) searchIncomplete = true;
        return { items: data.files ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: MAX_PAGES, initialCursor: resume?.listPageToken ?? null }
    );

    const deadline = this.now() + SYNC_TIME_BUDGET_MS;
    for await (const items of pages) {
      for (const file of items) {
        events.push(await this.driveFileToEnvelope(http, file, includeContent, 'upserted'));
      }
      // Tested only BETWEEN pages: a page is consumed whole or not at all, so
      // `nextListPageToken` always addresses the first file we have not read.
      // Stopping on the clock parks a checkpoint; being killed on it does not.
      if (events.length >= maxResults || this.now() >= deadline) break;
    }

    // Unread pages mean the bootstrap is unfinished, and WHY it stopped is
    // irrelevant: the item cap, the clock, and the paginator's own MAX_PAGES
    // ceiling all leave files the change feed will never replay. Only Drive
    // withholding a nextPageToken proves the traversal exhausted, so that —
    // not the reason for stopping — is what may promote the change token.
    if (nextListPageToken) {
      return this.buildBootstrapResult(
        events,
        startToken,
        nextListPageToken,
        bootstrapStartedAt,
        searchIncomplete
      );
    }

    // A Drive `q` has no equivalent on `changes.list` and cannot be re-evaluated
    // client-side against a change record, so the only way to keep honouring it
    // is to keep listing. Withholding the token re-lists next run; promoting it
    // would silently widen the feed to every changed file in the Drive.
    const hasCustomQuery = typeof config.query === 'string' && config.query.trim() !== '';
    return this.buildResult(
      events,
      hasCustomQuery ? undefined : startToken,
      bootstrapStartedAt,
      { searchIncomplete }
    );
  }

  /**
   * Incremental pass over `changes.list`.
   *
   * Returns null when the stored token was rejected, so the caller can fall
   * through to one full re-list.
   */
  private async syncWithPageToken(
    http: HttpClient,
    pageToken: string,
    config: DriveConfig,
    lastSyncAt?: string
  ): Promise<{
    events: EventEnvelope[];
    nextPageToken?: string;
    partial: boolean;
  } | null> {
    const includeContent = config.include_content !== false;
    const includeTrashed = Boolean(config.include_trashed);
    const folderId =
      typeof config.folder_id === 'string' && config.folder_id.trim()
        ? config.folder_id.trim()
        : undefined;
    const maxResults = Math.min(config.max_results ?? 500, 2000);
    const events: EventEnvelope[] = [];
    let nextPageToken: string | undefined;
    // The cursor for the page AFTER the one just consumed. A run that stops
    // early persists this instead of dropping back to a full re-list — a
    // `changes.list` page token is a resumable position in the change stream,
    // so the next run continues from exactly where this one stopped.
    let resumeCursor: string | undefined;
    let rejected = false;

    const MAX_PAGES = 200;

    const pages = paginateByCursor<DriveChange, string>(
      async (cursor) => {
        const params = new URLSearchParams({
          pageToken: cursor ?? pageToken,
          // Aligned to the cap so a bounded run does not overshoot by most of
          // a 1000-change page, and capped tighter when each change carries a
          // content fetch so the time budget is re-checked often enough.
          pageSize: String(
            Math.min(includeContent ? 100 : 1000, Math.max(includeContent ? 1 : 100, maxResults))
          ),
          fields: `changes(fileId,removed,time,file(${FILE_FIELDS})),nextPageToken,newStartPageToken`,
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });

        const response = await http.raw(`${this.BASE_URL}/changes?${params.toString()}`);
        if (!response.ok) {
          if (isPageTokenRejection(response.status)) {
            rejected = true;
            return { items: [], nextCursor: undefined };
          }
          throw new Error(
            `Drive changes.list error (${response.status}): ${await response.text()}`
          );
        }

        const data = (await response.json()) as DriveChangeListResponse;
        // Drive returns newStartPageToken only on the final page. Capture it
        // whenever present so the trailing value is the one we persist.
        if (data.newStartPageToken) nextPageToken = data.newStartPageToken;
        resumeCursor = data.nextPageToken;
        return { items: data.changes ?? [], nextCursor: data.nextPageToken };
      },
      { maxPages: MAX_PAGES }
    );

    // Bounded at PAGE boundaries, never mid-page: `resumeCursor` addresses the
    // start of the next page, so stopping part-way through one would skip the
    // changes still in it.
    const deadline = this.now() + SYNC_TIME_BUDGET_MS;
    let stoppedEarly = false;
    for await (const items of pages) {
      for (const change of items) {
        const envelope = await this.changeToEnvelope(
          http,
          change,
          includeContent,
          includeTrashed,
          folderId,
          lastSyncAt
        );
        if (envelope) events.push(envelope);
      }
      if (rejected) break;
      if ((events.length >= maxResults || this.now() >= deadline) && resumeCursor) {
        stoppedEarly = true;
        break;
      }
    }

    if (rejected) return null;

    // Either we stopped on the cap, or the paginator ran out of pages with the
    // stream still open (MAX_PAGES). Both leave changes unread, and both must
    // hand back the cursor: discarding it would silently demote the next run to
    // a full re-list and restart the whole bootstrap.
    const unread = stoppedEarly || (!nextPageToken && Boolean(resumeCursor));
    if (unread && resumeCursor) {
      return { events, nextPageToken: resumeCursor, partial: true };
    }

    return { events, nextPageToken, partial: false };
  }

  private async fetchStartPageToken(http: HttpClient): Promise<string> {
    const params = new URLSearchParams({ supportsAllDrives: 'true' });
    const response = await http.raw(
      `${this.BASE_URL}/changes/startPageToken?${params.toString()}`
    );
    if (!response.ok) {
      throw new Error(
        `Drive changes.getStartPageToken error (${response.status}): ${await response.text()}`
      );
    }
    const data = (await response.json()) as DriveStartPageTokenResponse;
    // Failing here is the honest outcome: without a token the traversal cannot
    // hand off to the change stream, and reporting it as a finished bootstrap
    // would hide a broken feed behind a permanent full re-list.
    if (!data.startPageToken) {
      throw new Error('Drive changes.getStartPageToken returned no startPageToken.');
    }
    return data.startPageToken;
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      const token = ctx.credentials?.accessToken;
      if (!token) {
        return {
          success: false,
          error: 'Google Drive actions require Google OAuth credentials.',
        };
      }

      const http = this.client(token);

      switch (ctx.actionKey) {
        case 'get_file_content':
          return await this.getFileContent(http, ctx.input);
        case 'get_file':
          return await this.getFile(http, ctx.input);
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

  private async getFile(
    http: HttpClient,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const fileId = input.file_id as string;
    if (!fileId) return { success: false, error: 'file_id is required.' };

    const file = await this.fetchFileMetadata(http, fileId);
    if (!file) {
      return { success: false, error: `Drive file not found: ${fileId}` };
    }
    return { success: true, output: this.driveFileToRow(file) };
  }

  private async getFileContent(
    http: HttpClient,
    input: Record<string, unknown>
  ): Promise<ActionResult> {
    const fileId = input.file_id as string;
    if (!fileId) return { success: false, error: 'file_id is required.' };

    const maxBytes = Math.min(
      (input.max_bytes as number) ?? 1024 * 1024,
      MAX_EXPORT_BYTES
    );

    const file = await this.fetchFileMetadata(http, fileId);
    if (!file) {
      return { success: false, error: `Drive file not found: ${fileId}` };
    }

    const fetched = await this.fetchTextContent(http, file, maxBytes);
    if (!fetched.ok) {
      return { success: false, error: fetched.error };
    }

    return {
      success: true,
      output: {
        file_id: file.id,
        name: file.name ?? '',
        mime_type: file.mimeType ?? '',
        exported_as: fetched.exportedAs,
        truncated: fetched.truncated,
        byte_count: fetched.byteCount,
        line_count: fetched.text.length === 0 ? 0 : fetched.text.split('\n').length,
        content: fetched.text,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Content fetching
  // -------------------------------------------------------------------------

  /**
   * Fetch a file's text, choosing export vs. direct download by MIME type.
   *
   * Binary files are refused rather than decoded: running a PDF through
   * `response.text()` yields replacement characters that look like content to
   * a model and would be indistinguishable from a genuinely empty file.
   */
  private async fetchTextContent(
    http: HttpClient,
    file: DriveFile,
    maxBytes: number
  ): Promise<
    | {
        ok: true;
        text: string;
        truncated: boolean;
        byteCount: number;
        exportedAs?: string;
      }
    | { ok: false; error: string }
  > {
    const exportMime = exportMimeTypeFor(file.mimeType);

    if (isGoogleNative(file.mimeType) && !exportMime) {
      return {
        ok: false,
        error: `Google Drive item of type ${file.mimeType} has no text export (folders, shortcuts and forms carry no content).`,
      };
    }

    if (!exportMime && !isTextualMimeType(file.mimeType)) {
      return {
        ok: false,
        error: `File ${file.name ?? file.id} is binary (${file.mimeType ?? 'unknown type'}); its bytes are not text and were not decoded.`,
      };
    }

    const url = exportMime
      ? `${this.BASE_URL}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportMime)}`
      : `${this.BASE_URL}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;

    const response = await http.raw(url);
    if (!response.ok) {
      return {
        ok: false,
        error: `Drive ${exportMime ? 'files.export' : 'files.get'} error (${response.status}): ${await response.text()}`,
      };
    }

    const raw = await response.text();
    const encoded = new TextEncoder().encode(raw);
    const truncated = encoded.byteLength > maxBytes;
    const text = truncated ? decodeTruncated(encoded, maxBytes) : raw;

    return {
      ok: true,
      text,
      truncated,
      byteCount: encoded.byteLength,
      ...(exportMime ? { exportedAs: exportMime } : {}),
    };
  }

  private async fetchFileMetadata(
    http: HttpClient,
    fileId: string
  ): Promise<DriveFile | null> {
    const params = new URLSearchParams({
      fields: FILE_FIELDS,
      supportsAllDrives: 'true',
    });
    const response = await http.raw(
      `${this.BASE_URL}/files/${encodeURIComponent(fileId)}?${params.toString()}`
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Drive files.get error (${response.status}): ${await response.text()}`
      );
    }
    return (await response.json()) as DriveFile;
  }

  // -------------------------------------------------------------------------
  // Envelope construction
  // -------------------------------------------------------------------------

  private async changeToEnvelope(
    http: HttpClient,
    change: DriveChange,
    includeContent: boolean,
    includeTrashed: boolean,
    folderId: string | undefined,
    lastSyncAt?: string
  ): Promise<EventEnvelope | null> {
    const fileId = change.fileId ?? change.file?.id;
    if (!fileId) return null;

    // A removed file (deleted outright, or moved out of scope) has no metadata
    // in the change record. Emit a tombstone that supersedes the prior version
    // on origin_id rather than dropping it, so a deleted file stops looking
    // live in memory.
    //
    // Accepted noise: with no `file` on the change record, a removed FOLDER is
    // indistinguishable from a removed file, so deleting one writes a tombstone
    // for an origin_id we never stored. Suppressing it would need prior state
    // the connector cannot see. The row supersedes nothing and is bounded by
    // the deletion rate, which is why this is tolerated rather than guessed at.
    if (change.removed || !change.file) {
      const removedAt = change.time ? new Date(change.time) : new Date();
      return {
        origin_id: fileId,
        origin_type: 'drive_file',
        title: '(removed Drive file)',
        payload_text: '',
        occurred_at: Number.isNaN(removedAt.getTime()) ? new Date() : removedAt,
        metadata: { change_type: 'removed' },
      };
    }

    // `changes.list` has no query parameter, so the folder exclusion the
    // bootstrap applies at the listing has to be re-applied here or folders
    // would leak back in one edit at a time. Checked before the trashed
    // branch: a trashed folder is still a folder, and tombstoning one we
    // never stored would write a row for something that was never there.
    if (change.file.mimeType === FOLDER_MIME_TYPE) return null;

    // `changes.list` takes no `q`, so the feed's folder scope has to be
    // re-applied here or the feed widens to the whole Drive the moment the
    // bootstrap completes — quietly inlining the text of documents the
    // operator never scoped it to. `parents` is already in FILE_FIELDS.
    //
    // Dropped, never tombstoned: a change for a file that MOVED OUT of the
    // folder is indistinguishable from one that was never in it, so emitting a
    // tombstone would write a row for every changed file in the Drive and leak
    // the existence of out-of-scope files in the very corpus the scope exists
    // to bound.
    if (folderId && !change.file.parents?.includes(folderId)) return null;

    if (change.file.trashed && !includeTrashed) {
      const trashedAt = change.time ? new Date(change.time) : new Date();
      return {
        origin_id: fileId,
        origin_type: 'drive_file',
        title: change.file.name ?? '(trashed Drive file)',
        payload_text: '',
        occurred_at: Number.isNaN(trashedAt.getTime()) ? new Date() : trashedAt,
        metadata: { change_type: 'trashed', trashed: true },
      };
    }

    return this.driveFileToEnvelope(http, change.file, includeContent, 'upserted', lastSyncAt);
  }

  private async driveFileToEnvelope(
    http: HttpClient,
    file: DriveFile,
    includeContent: boolean,
    changeType: string,
    lastSyncAt?: string
  ): Promise<EventEnvelope> {
    const modified = file.modifiedTime || file.createdTime;
    const occurredAt = modified ? new Date(modified) : new Date();

    let payloadText = file.description ?? '';
    let contentIncluded = false;
    let contentTruncated = false;
    let contentError: string | undefined;

    // Content is best-effort: one unreadable file must not fail the whole sync,
    // so a failed fetch degrades to metadata-only rather than throwing.
    //
    // The failure is RECORDED rather than retried. A file that syncs once and
    // never changes again is never revisited, so a silent miss would be
    // permanent and indistinguishable from "this file has no text by design".
    // `content_error` makes the two tellable apart, and the `get_file_content`
    // action can still fetch on demand — which is the recovery path, not a
    // retry queue whose state would grow without bound.
    if (includeContent && this.shouldInlineContent(file, lastSyncAt)) {
      const fetched = await this.fetchTextContent(http, file, MAX_INLINE_TEXT_BYTES);
      if (fetched.ok) {
        payloadText = fetched.text;
        contentIncluded = true;
        contentTruncated = fetched.truncated;
      } else {
        contentError = fetched.error;
      }
    }

    const sizeBytes = parseSize(file.size);
    const owner = personLabel(file.owners?.[0]);
    const lastModifiedBy = personLabel(file.lastModifyingUser);

    return {
      origin_id: file.id,
      origin_type: 'drive_file',
      title: file.name ?? '(untitled)',
      payload_text: payloadText,
      author_name: owner,
      source_url: file.webViewLink,
      occurred_at: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
      metadata: {
        change_type: changeType,
        ...(file.mimeType ? { mime_type: file.mimeType } : {}),
        ...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}),
        ...(owner ? { owner } : {}),
        ...(lastModifiedBy ? { last_modified_by: lastModifiedBy } : {}),
        ...(file.createdTime ? { created_at: file.createdTime } : {}),
        ...(file.modifiedTime ? { modified_at: file.modifiedTime } : {}),
        trashed: Boolean(file.trashed),
        content_included: contentIncluded,
        content_truncated: contentTruncated,
        ...(contentError ? { content_error: contentError } : {}),
      },
    };
  }

  /**
   * Worth spending an HTTP round trip on this file's content?
   *
   * Size is checked against the byte cap for real files only — Google-native
   * files report no size at all, so an exportable Doc always qualifies and its
   * export is bounded by `fetchTextContent`'s own cap instead.
   */
  private shouldInlineContent(file: DriveFile, lastSyncAt?: string): boolean {
    // A file can appear in `changes.list` because somebody merely OPENED it —
    // that bumps `viewedByMeTime` and `version` while leaving `modifiedTime`
    // untouched (verified against the live API). Re-exporting a document on
    // every human view is pure waste, so when the file was last modified before
    // our previous sync, its content is already what we stored.
    if (lastSyncAt && file.modifiedTime) {
      const modified = Date.parse(file.modifiedTime);
      const since = Date.parse(lastSyncAt);
      if (
        Number.isFinite(modified) &&
        Number.isFinite(since) &&
        modified < since - CONTENT_SKEW_GRACE_MS
      ) {
        return false;
      }
    }
    if (exportMimeTypeFor(file.mimeType)) return true;
    if (isGoogleNative(file.mimeType)) return false;
    if (!isTextualMimeType(file.mimeType)) return false;
    const size = parseSize(file.size);
    return size === undefined || size <= MAX_INLINE_TEXT_BYTES;
  }

  private driveFileToRow(file: DriveFile): Record<string, unknown> {
    return {
      id: file.id,
      name: file.name ?? '',
      mime_type: file.mimeType ?? '',
      size_bytes: parseSize(file.size) ?? 0,
      owner: personLabel(file.owners?.[0]) ?? '',
      last_modified_by: personLabel(file.lastModifyingUser) ?? '',
      created_at: file.createdTime ?? '',
      modified_at: file.modifiedTime ?? '',
      trashed: Boolean(file.trashed),
      url: file.webViewLink ?? '',
    };
  }

  /**
   * Checkpoint for a bootstrap that stopped on `max_results` with pages left.
   *
   * `page_token` is deliberately absent: while it is missing the feed cannot go
   * incremental, which is exactly the property that keeps the unread files
   * reachable. `bootstrap_complete: false` is surfaced in metadata so an
   * operator can see the traversal is still catching up rather than guessing
   * from a suspiciously round item count.
   */
  private buildBootstrapResult(
    events: EventEnvelope[],
    pendingPageToken: string,
    listPageToken: string,
    startedAt: string,
    searchIncomplete = false
  ): SyncResult {
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    const checkpoint: DriveCheckpoint = {
      pending_page_token: pendingPageToken,
      list_page_token: listPageToken,
      last_sync_at: startedAt,
    };

    return {
      events,
      checkpoint: checkpoint as Record<string, unknown>,
      metadata: {
        items_found: events.length,
        bootstrap_complete: false,
        ...(searchIncomplete ? { search_incomplete: true } : {}),
      },
    };
  }

  private buildResult(
    events: EventEnvelope[],
    pageToken: string | undefined,
    /** Stamp to persist as-is; omit to advance `last_sync_at` to now. */
    keepLastSyncAt: string | undefined,
    flags: { changesPending?: boolean; searchIncomplete?: boolean } = {}
  ): SyncResult {
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    // Rebuilt rather than spread over the previous checkpoint so a run that
    // recovered from a rejected token cannot leave that token behind. Without a
    // new token the key is absent and the next run correctly re-lists.
    const newCheckpoint: DriveCheckpoint = {
      ...(pageToken ? { page_token: pageToken } : {}),
      last_sync_at: keepLastSyncAt ?? new Date().toISOString(),
    };

    return {
      events,
      checkpoint: newCheckpoint as Record<string, unknown>,
      metadata: {
        items_found: events.length,
        bootstrap_complete: true,
        ...(flags.changesPending ? { changes_pending: true } : {}),
        ...(flags.searchIncomplete ? { search_incomplete: true } : {}),
      },
    };
  }

  /** Overridable so a test can drive the time budget without sleeping. */
  protected now(): number {
    return Date.now();
  }

  // Auth-aware client (Bearer + retry/backoff on transient 429/5xx). Built per
  // token so each sync/action uses its own credentials. `.raw()` preserves the
  // status-code branching the page-token and export paths depend on.
  private client(token: string): HttpClient {
    return createHttpClient({ token, errorPrefix: 'Drive API' });
  }
}
