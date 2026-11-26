/**
 * Bounded reply sync for social timeline feeds.
 *
 * Feeds that store posts can also store a bounded slice of each post's reply
 * tree in the same sync. Each reply is mapped exactly like the connector's
 * own comment feeds map it (same origin_id, same `origin_parent_id` = the
 * immediate parent: the post for a top-level reply, the comment it answers
 * otherwise), so a comment synced by two feeds is one unchanged row.
 *
 * Timelines are large (a Reddit home feed brings thousands of posts a day), so
 * every knob here is a cap: how many posts per sync get replies, how many
 * top-level and nested replies per post, how deep, and when an already-fetched
 * post is worth fetching again. The checkpoint remembers each fetched post's
 * comment count so an unchanged thread is never re-read.
 *
 * Replies are optional: every reply request is bounded by a timeout and the
 * reply phase's budget, and a failed or slow thread is skipped so it can never
 * block or fail the sync of the posts themselves.
 */

export interface ReplySyncLimits {
  postsPerSync: number;
  maxTopLevel: number;
  maxNested: number;
  maxDepth: number;
  refreshMinNewComments: number;
}

const REPLY_SYNC_FIELDS = {
  postsPerSync: {
    key: 'reply_posts_per_sync',
    minimum: 0,
    maximum: 25,
    default: 5,
    description:
      'Fetch replies for at most this many posts per sync, most-commented posts first; posts never fetched before go ahead of re-fetches. 0 turns reply sync off.',
  },
  maxTopLevel: {
    key: 'max_top_level_replies',
    minimum: 1,
    maximum: 50,
    default: 10,
    description: 'Keep at most this many top-level replies per post.',
  },
  maxNested: {
    key: 'max_nested_replies',
    minimum: 0,
    maximum: 10,
    default: 2,
    description: 'Keep at most this many direct replies under each kept reply.',
  },
  maxDepth: {
    key: 'max_reply_depth',
    minimum: 1,
    maximum: 3,
    default: 2,
    description:
      'Reply levels to keep: 1 keeps only top-level replies, 2 adds their direct replies, 3 one level more.',
  },
  refreshMinNewComments: {
    key: 'reply_refresh_min_new_comments',
    minimum: 1,
    maximum: 10_000,
    default: 50,
    description:
      'Fetch a post whose replies are already stored again only once its comment count has grown by at least this much.',
  },
} as const satisfies Record<
  keyof ReplySyncLimits,
  { key: string; minimum: number; maximum: number; default: number; description: string }
>;

/** Feed `configSchema.properties` entries for the reply caps, with their defaults. */
export const replySyncConfigProperties: Record<string, Record<string, unknown>> =
  Object.fromEntries(
    Object.values(REPLY_SYNC_FIELDS).map(({ key, ...field }) => [
      key,
      { type: 'integer', ...field },
    ])
  );

export function readReplySyncLimits(config: Record<string, unknown>): ReplySyncLimits {
  const limits = {} as ReplySyncLimits;
  for (const [name, field] of Object.entries(REPLY_SYNC_FIELDS) as Array<
    [keyof ReplySyncLimits, (typeof REPLY_SYNC_FIELDS)[keyof ReplySyncLimits]]
  >) {
    const raw = config[field.key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : field.default;
    limits[name] = Math.min(field.maximum, Math.max(field.minimum, value));
  }
  return limits;
}

/** Upper bound on replies kept for one post under `limits`. */
export function maxRepliesPerPost(limits: ReplySyncLimits): number {
  let total = 0;
  let level = limits.maxTopLevel;
  for (let depth = 1; depth <= limits.maxDepth; depth++) {
    total += level;
    level *= limits.maxNested;
  }
  return total;
}

/** Comment count per post origin_id at its last reply fetch. */
export type ReplyCounts = Record<string, number>;

const REPLY_COUNTS_KEY = 'reply_counts';
// Bounds the checkpoint even if a listing grows without limit.
const MAX_TRACKED_POSTS = 500;

export function readReplyCounts(checkpoint: Record<string, unknown> | null | undefined): ReplyCounts {
  const raw = checkpoint?.[REPLY_COUNTS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const counts: ReplyCounts = {};
  for (const [originId, count] of Object.entries(raw)) {
    if (typeof count === 'number' && Number.isFinite(count)) counts[originId] = count;
  }
  return counts;
}

/**
 * The checkpoint entry after a sync: posts still in the listing keep their
 * count, posts fetched this run record the count they were fetched at, and
 * posts that left the listing are forgotten.
 */
export function replyCountsCheckpoint(
  previous: ReplyCounts,
  listedOriginIds: Iterable<string>,
  fetched: ReplyCounts
): Record<string, ReplyCounts> {
  const next: ReplyCounts = { ...fetched };
  let tracked = Object.keys(next).length;
  for (const originId of listedOriginIds) {
    if (tracked >= MAX_TRACKED_POSTS) break;
    if (!(originId in next) && originId in previous) {
      next[originId] = previous[originId];
      tracked++;
    }
  }
  return { [REPLY_COUNTS_KEY]: next };
}

export interface ReplyCandidate {
  originId: string;
  commentCount: number;
}

/**
 * Pick the posts whose replies this sync fetches: posts never fetched before,
 * most-commented first, then posts whose comment count grew by at least
 * `refreshMinNewComments`, largest growth first — capped at `postsPerSync`.
 */
export function selectReplyPosts<T extends ReplyCandidate>(
  posts: T[],
  stored: ReplyCounts,
  limits: ReplySyncLimits
): T[] {
  if (limits.postsPerSync === 0) return [];
  const fresh: T[] = [];
  const refresh: T[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    if (post.commentCount <= 0 || seen.has(post.originId)) continue;
    seen.add(post.originId);
    const prior = stored[post.originId];
    if (prior === undefined) fresh.push(post);
    else if (post.commentCount - prior >= limits.refreshMinNewComments) refresh.push(post);
  }
  fresh.sort((a, b) => b.commentCount - a.commentCount);
  const growth = (post: T) => post.commentCount - (stored[post.originId] ?? 0);
  refresh.sort((a, b) => growth(b) - growth(a));
  return [...fresh, ...refresh].slice(0, limits.postsPerSync);
}

/**
 * Walk a ranked reply tree keeping at most `maxTopLevel` top-level replies,
 * `maxNested` replies under each kept reply, down to `maxDepth` levels, in
 * pre-order. `children` must return a node's replies in the order to keep
 * them; a reply that fails `keep` (deleted, removed) is skipped with its subtree.
 */
export function boundedReplyTree<T>(
  roots: T[],
  limits: ReplySyncLimits,
  children: (node: T) => T[],
  keep: (node: T) => boolean
): T[] {
  const kept: T[] = [];
  const visit = (nodes: T[], depth: number) => {
    const cap = depth === 1 ? limits.maxTopLevel : limits.maxNested;
    let count = 0;
    for (const node of nodes) {
      if (count >= cap) break;
      if (!keep(node)) continue;
      count++;
      kept.push(node);
      if (depth < limits.maxDepth) visit(children(node), depth + 1);
    }
  };
  visit(roots, 1);
  return kept;
}

// The whole reply phase of one sync, and any single reply request in it.
const REPLY_PHASE_BUDGET_MS = 60_000;
const REPLY_REQUEST_TIMEOUT_MS = 10_000;

/** When the reply phase starting now must end, never past the sync's own deadline. */
export function replyPhaseDeadline({
  syncDeadline = Number.POSITIVE_INFINITY,
  budgetMs = REPLY_PHASE_BUDGET_MS,
}: { syncDeadline?: number; budgetMs?: number } = {}): number {
  return Math.min(syncDeadline, Date.now() + budgetMs);
}

/**
 * Run one reply request — fetch and body read — under a timeout of
 * min(per-request cap, time left until `deadline`). The signal aborts the
 * request; the race guarantees the caller moves on even if the transport
 * ignores the signal. Rejects on timeout, or at once when no time is left.
 */
export async function withinReplyBudget<T>(
  deadline: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = Math.min(REPLY_REQUEST_TIMEOUT_MS, deadline - Date.now());
  if (timeoutMs <= 0) throw new Error('Reply sync budget exhausted');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Reply request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
