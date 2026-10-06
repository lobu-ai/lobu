/**
 * Feeds over a Google `*.list` method, driven by its Discovery description.
 *
 * Discovery supplies the URL, the page-size parameter, the items array and
 * whether the method supports `syncToken`; a feed declares only what Google
 * cannot know — which filters a full traversal uses, how an item becomes an
 * event, and what invalidates the checkpoint.
 *
 * The syncToken strategy (Calendar events/calendarList/acl/settings, People
 * connections/otherContacts/contactGroups) follows Google's documented
 * protocol:
 *  - A full traversal applies the feed's filters; Google forbids most of them
 *    alongside a `syncToken`, so an incremental traversal sends only the token.
 *  - `nextSyncToken` arrives on the LAST page only, so the feed cannot go
 *    incremental until a traversal reaches it.
 *  - Every page commits with a parked checkpoint (its continuation and the
 *    exact query that minted it); a page token is valid only against that query.
 *  - A rejected token (410 GONE, or a scope-insufficient 403 from a token
 *    minted under a previous grant) drops both tokens and re-traverses once.
 *    Stable `origin_id`s make the replay a supersede, not a duplicate.
 */
import type {
  EventEnvelope,
  FeedReadContext,
  FeedReadResult,
  HttpClient,
  SyncContext,
  SyncResult,
} from '@lobu/connector-sdk';
import { buildGoogleRequest, type DiscoveryDocument, type DiscoveryMethod, findMethod } from './discovery';
import { classifyGoogleError, type GoogleErrorCode } from './errors';

type Params = Record<string, string>;
type Item = Record<string, unknown>;

export interface ListMethod {
  doc: DiscoveryDocument;
  method: DiscoveryMethod;
  /** Response property holding the page's records, e.g. `items`, `connections`. */
  itemsKey: string;
  /** `maxResults` or `pageSize`, whichever the method takes. */
  pageSizeParam: string;
  supportsSyncToken: boolean;
}

/**
 * Resolve a list method's shape from Discovery. The items array is `items`
 * when the response has one (Calendar's `Events` also has a `defaultReminders`
 * array, which is not the page), otherwise its only array of records. Two
 * candidates and no `items` is refused rather than guessed.
 */
export function listMethod(doc: DiscoveryDocument, methodId: string): ListMethod {
  const method = findMethod(doc, methodId);
  const response = method.response ? doc.schemas?.[method.response.$ref] : undefined;
  const recordArrays = Object.entries(response?.properties ?? {}).filter(
    ([, p]) => p.type === 'array' && p.items?.$ref !== undefined
  );
  const itemsKey = recordArrays.some(([name]) => name === 'items')
    ? 'items'
    : recordArrays.length === 1
      ? recordArrays[0][0]
      : undefined;
  if (!itemsKey) {
    throw new Error(
      `${methodId} has ${recordArrays.length} record arrays in its response; declare which one is the page`
    );
  }
  const params = method.parameters ?? {};
  const pageSizeParam = 'maxResults' in params ? 'maxResults' : 'pageSize';
  if (!(pageSizeParam in params) || !('pageToken' in params)) {
    throw new Error(`${methodId} is not a paginated list method`);
  }
  return {
    doc,
    method,
    itemsKey,
    pageSizeParam,
    supportsSyncToken: 'syncToken' in params || 'requestSyncToken' in params,
  };
}

export interface SyncTokenFeed<F> {
  list: ListMethod;
  /** Path parameters, e.g. `{ calendarId }`. */
  path(config: F): Record<string, string>;
  /** Filters for a full traversal. */
  bootstrap(config: F, now: Date): Params;
  /** Parameters sent alongside the syncToken (must be ones Google allows there). */
  incremental?(config: F): Params;
  /** Page size requested from Google. */
  pageSize: number;
  /** A change discards the stored cursors and re-runs the bootstrap. */
  scope(config: F): unknown[];
  /** Records one bootstrap run collects before yielding `more`. */
  budget(config: F): number;
  /** Fail closed when a traversal ends without a replacement token. */
  requireSyncToken?: boolean;
  toEnvelope(item: Item): EventEnvelope | null;
}

interface SyncTokenCheckpoint {
  scope?: string;
  sync_token?: string;
  last_sync_at?: string;
  pending?: { params: string; page_token: string };
}

/** Error codes meaning "the stored token is unusable", not "the request is wrong". */
const TOKEN_REJECTIONS: GoogleErrorCode[] = ['cursor_expired', 'scope_insufficient'];
const MAX_SYNC_PAGES = 200;

export async function syncTokenSync<F>(
  feed: SyncTokenFeed<F>,
  ctx: SyncContext<Record<string, unknown>, F>,
  http: HttpClient
): Promise<SyncResult> {
  const { list } = feed;
  const checkpoint = (ctx.checkpoint ?? {}) as SyncTokenCheckpoint;
  const scope = JSON.stringify(feed.scope(ctx.config));
  const resumable = checkpoint.scope === scope;
  const syncToken = resumable ? checkpoint.sync_token : undefined;
  const pending = resumable ? checkpoint.pending : undefined;
  const pageSize = { [list.pageSizeParam]: String(feed.pageSize) };

  const params = pending
    ? new URLSearchParams(pending.params)
    : new URLSearchParams(
        syncToken
          ? { ...pageSize, syncToken, ...feed.incremental?.(ctx.config) }
          : { ...pageSize, ...feed.bootstrap(ctx.config, new Date()) }
      );
  const baseParams = params.toString();
  const baseUrl = buildGoogleRequest(list.doc, list.method, feed.path(ctx.config)).url;

  const parked = (token: string): SyncTokenCheckpoint => ({
    scope,
    ...(syncToken ? { sync_token: syncToken, last_sync_at: checkpoint.last_sync_at } : {}),
    pending: { params: baseParams, page_token: token },
  });

  let collected = 0;
  let pageToken = pending?.page_token;
  const seenTokens = new Set<string>();
  for (let page = 0; ; page++) {
    if (pageToken) {
      seenTokens.add(pageToken);
      params.set('pageToken', pageToken);
    }
    const response = await http.raw(`${baseUrl}?${params.toString()}`);
    if (!response.ok) {
      const body = await response.text();
      if (syncToken && TOKEN_REJECTIONS.includes(classifyGoogleError(response.status, body).code)) {
        // Bounded to one retry: the recursive call carries no token, so a
        // genuinely missing scope fails the full traversal and propagates.
        return syncTokenSync(feed, { ...ctx, checkpoint: { scope } }, http);
      }
      throw new Error(`${list.method.id} error (${response.status}): ${body}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const items = (data[list.itemsKey] as Item[] | undefined) ?? [];
    // A provider page is atomic: the budget bounds how much a run STARTS,
    // never how much of a fetched page is stored.
    const events = items.map(feed.toEnvelope).filter((e): e is EventEnvelope => e !== null);
    const next = data.nextPageToken as string | undefined;

    if (!next) {
      const token = data.nextSyncToken as string | undefined;
      if (feed.requireSyncToken && !token) {
        throw new Error(`${list.method.id} traversal completed without a durable sync token.`);
      }
      await ctx.commit(events, {
        ...(token ? { sync_token: token } : {}),
        last_sync_at: new Date().toISOString(),
        scope,
      } as Record<string, unknown>);
      return { status: 'complete' };
    }
    if (seenTokens.has(next)) throw new Error(`${list.method.id} returned a repeated page token.`);
    pageToken = next;
    await ctx.commit(events, parked(pageToken) as Record<string, unknown>);
    collected += events.length;
    if ((!syncToken && collected >= feed.budget(ctx.config)) || items.length === 0 || page + 1 >= MAX_SYNC_PAGES) {
      return { status: 'more' };
    }
  }
}

export interface ListRead<F> {
  list: ListMethod;
  path(config: F): Record<string, string>;
  /** Query parameters for this read; validate the caller's sort/offset here. */
  params(ctx: FeedReadContext<F>): Params;
  /** Upper bound on the page size Google accepts. */
  maxPageSize: number;
  toRow(item: Item): Record<string, unknown> | null;
  columns: Array<{ name: string; type: string }>;
}

/** One live page of a list method. Nothing is persisted. */
export async function listRead<F>(
  read: ListRead<F>,
  ctx: FeedReadContext<F>,
  http: HttpClient
): Promise<FeedReadResult> {
  const { list } = read;
  const params = new URLSearchParams({
    [list.pageSizeParam]: String(Math.min(read.maxPageSize, Math.max(1, Math.trunc(ctx.limit ?? 50)))),
    ...read.params(ctx),
  });
  if (ctx.cursor) params.set('pageToken', ctx.cursor);
  const url = `${buildGoogleRequest(list.doc, list.method, read.path(ctx.config)).url}?${params.toString()}`;
  const response = await http.raw(url);
  if (!response.ok) {
    throw new Error(`${list.method.id} error (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const rows = ((data[list.itemsKey] as Item[] | undefined) ?? [])
    .map(read.toRow)
    .filter((row): row is Record<string, unknown> => row !== null);
  const next = data.nextPageToken as string | undefined;
  return { rows, columns: read.columns, nextCursor: next, hasMore: Boolean(next) };
}
