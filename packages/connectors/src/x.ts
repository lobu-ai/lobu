/**
 * X (Twitter) Connector
 *
 * Supports two auth modes:
 * - OAuth 2.0 user context against the X API v2 (preferred when a token is
 *   available — the ToS-compliant path).
 * - The paired Owletto Chrome extension (fallback). Mirrors the LinkedIn
 *   connector: we attach the CDP Network domain in the user's signed-in
 *   x.com tab via the extension's `chrome.*` action dispatcher, drive scroll
 *   pagination, and parse the GraphQL responses the page emits. No Playwright,
 *   no cookie cache, no `--remote-debugging-port` plumbing.
 *
 * Auth is implicit on the extension path: the user is already signed into
 * x.com in the paired Chrome. There is no fallback path — if no online
 * Owletto extension is reachable in the connection's org, the sync fails fast
 * with a clear "no paired Owletto extension" error.
 *
 * Feeds:
 *   - tweets:        search by query or track a handle (API v2 or extension search)
 *   - my_tweets:     authenticated user's posts and replies (API v2 or extension)
 *   - liked_tweets:  posts the user has liked (API v2 or signed-in extension backfill)
 *   - bookmarks:        posts the user has bookmarked (API v2 or extension)
 *   - direct_messages:  1:1 and group DMs (OAuth API; extension fallback on /messages)
 *   - home_feed:        personalized x.com home timeline (extension only — there
 *                    is no public API for the "For you" / "Following" timeline;
 *                    read via content-script scrape because CDP network capture
 *                    blocks the feed from rendering, same as LinkedIn home_feed)
 */

import {
	type ActionContext,
	type ActionResult,
	type ChromeActionDispatcher,
	type RuntimeConnectorDefinition,
	type EventAttributionRule,
	type EventAttributionTargetSpec,
	type EntityTraitSpec,
	ConnectorRuntime,
	calculateEngagementScore,
	createHttpClient,
	type EventEnvelope,
	extensionDomScrape,
	extensionNetworkSync,
	HttpStatusError,
	type HttpClient,
	paginateByCursor,
	type SyncContext,
	type SyncResult,
} from "@lobu/connector-sdk";
import { X_IDENTITY, normalizeXHandle } from "./x-identity.js";

/** OAuth scopes needed per feed for the API path (not used to pause browser-capable feeds). */
const X_OAUTH_FEED_SCOPES: Record<string, readonly string[]> = {
	tweets: ["tweet.read", "users.read"],
	my_tweets: ["tweet.read", "users.read"],
	liked_tweets: ["like.read", "tweet.read", "users.read"],
	bookmarks: ["bookmark.read", "tweet.read", "users.read"],
	direct_messages: ["dm.read", "tweet.read", "users.read"],
};

// ── Types ──────────────────────────────────────────────────────

interface XCheckpoint {
	last_tweet_id?: string;
	last_timestamp?: Date | string;
	last_dm_event_id?: string;
	likes_backfill_cursor?: string;
	likes_backfill_status?: XLikesBackfillStatus;
	likes_backfill_pages?: number;
	likes_oldest_tweet_id?: string;
	likes_oldest_timestamp?: Date | string;
	likes_backfill_completed_at?: Date | string;
}

type XLikesBackfillStatus = "in_progress" | "complete";

interface XMediaAttachment {
	kind: "image" | "video" | "animated_gif";
	url: string;
	preview_url?: string;
	mime_type?: string;
	alt_text?: string;
	width?: number;
	height?: number;
	duration_ms?: number;
	media_key?: string;
	variants?: Array<{
		url: string;
		mime_type?: string;
		bitrate?: number;
	}>;
}

interface XExpandedUrl {
	url: string;
	expanded_url?: string;
	display_url?: string;
}

interface XTweet {
	id: string;
	text: string;
	username: string;
	authorId?: string;
	authorDisplayName?: string;
	likes: number;
	retweets: number;
	replies: number;
	quotes: number;
	publishedAt: Date;
	isRetweet: boolean;
	isReply: boolean;
	isQuote: boolean;
	conversationId?: string;
	inReplyToId?: string;
	quotedTweetId?: string;
	repostedTweetId?: string;
	attachments?: XMediaAttachment[];
	urls?: XExpandedUrl[];
	likedByUserId?: string;
	likedByHandle?: string;
	likedByDisplayName?: string;
	/** True for promoted/ad tweets — dropped before emit, like LinkedIn's "Promoted" filter. */
	promoted?: boolean;
}

interface XDmMessage {
	id: string;
	text: string;
	senderId: string;
	senderHandle: string;
	senderName?: string;
	conversationId: string;
	isGroup: boolean;
	fromMe: boolean;
	participantId?: string;
	participantHandle?: string;
	participantName?: string;
	publishedAt: Date;
}

interface XApiTweetRecord {
	id: string;
	text?: string;
	author_id?: string;
	created_at?: string;
	conversation_id?: string;
	public_metrics?: {
		like_count?: number;
		retweet_count?: number;
		reply_count?: number;
		quote_count?: number;
	};
	referenced_tweets?: Array<{ type?: string; id?: string }>;
}

interface XApiUserRecord {
	id: string;
	username?: string;
	name?: string;
}

interface XApiListResponse {
	data?: XApiTweetRecord[];
	includes?: {
		users?: XApiUserRecord[];
	};
	meta?: {
		next_token?: string;
		result_count?: number;
	};
	errors?: Array<{ detail?: string; message?: string }>;
}

interface XTimelinePage {
	tweets: XTweet[];
	bottomCursor?: string;
	recognized: boolean;
	owner?: {
		id?: string;
		handle?: string;
		displayName?: string;
	};
	errors: string[];
}

interface XApiDmEventRecord {
	id: string;
	text?: string;
	created_at?: string;
	sender_id?: string;
	dm_conversation_id?: string;
	event_type?: string;
}

interface XApiDmListResponse {
	data?: XApiDmEventRecord[];
	includes?: {
		users?: XApiUserRecord[];
	};
	meta?: {
		next_token?: string;
		result_count?: number;
	};
	errors?: Array<{ detail?: string; message?: string }>;
}

/** x.com origins the dispatched chrome actions are allowed to touch. */
const X_ALLOWED_ORIGINS = ["x.com", "*.x.com", "twitter.com", "*.twitter.com"];
const X_LIKES_INTERCEPT_PATTERN = "/i/api/graphql/[^/]+/[^?]*Like";
const X_RESPONSE_SHAPE_MAX_PATHS = 20;
const X_RESPONSE_SHAPE_MAX_DEPTH = 6;
const X_RESPONSE_SHAPE_MAX_SAMPLES = 3;

/**
 * Link tweet-like X events to `person` rows via immutable `x_user_id` + `x_handle`.
 * Match-only by default (like Gmail): identities accrete onto existing contacts,
 * but we do not mint a person per random timeline author.
 */
const X_PERSON_AUTHOR_TARGET: EventAttributionTargetSpec = {
	entityType: "person",
	titlePath: "metadata.author_name",
	identities: [
		{
			namespace: X_IDENTITY.USER_ID,
			eventPath: "metadata.author_id",
			primary: true,
		},
		{ namespace: X_IDENTITY.HANDLE, eventPath: "metadata.author_handle" },
	],
};

const X_PERSON_AUTHOR_TRAITS: Record<string, EntityTraitSpec> = {
	x_handle: {
		eventPath: "metadata.author_handle",
		mergeStrategy: "prefer_non_empty",
	},
	x_display_name: {
		eventPath: "metadata.author_name",
		mergeStrategy: "prefer_non_empty",
	},
	last_x_interaction_at: {
		eventPath: "occurred_at",
		mergeStrategy: "overwrite",
	},
};

/** Mint/link the 1:1 DM counterparty (never the connected account itself). */
const X_PERSON_DM_COUNTERPARTY_TARGET: EventAttributionTargetSpec = {
	entityType: "person",
	createWhen: { path: "metadata.is_group", equals: false },
	titlePath: "metadata.participant_name",
	identities: [
		{
			namespace: X_IDENTITY.USER_ID,
			eventPath: "metadata.participant_id",
			primary: true,
		},
		{
			namespace: X_IDENTITY.HANDLE,
			eventPath: "metadata.participant_handle",
		},
	],
};

const X_PERSON_DM_COUNTERPARTY_TRAITS: Record<string, EntityTraitSpec> = {
	x_handle: {
		eventPath: "metadata.participant_handle",
		mergeStrategy: "prefer_non_empty",
	},
	x_display_name: {
		eventPath: "metadata.participant_name",
		mergeStrategy: "prefer_non_empty",
	},
	last_x_dm_at: {
		eventPath: "occurred_at",
		mergeStrategy: "overwrite",
	},
};

const X_TWEET_AUTHOR_ATTRIBUTIONS: EventAttributionRule[] = [
	{
		role: "authored_by",
		autoCreate: false,
		target: X_PERSON_AUTHOR_TARGET,
		traits: X_PERSON_AUTHOR_TRAITS,
	},
];

/**
 * A liked post has two people with different roles: the connected account that
 * performed the interaction, and the post author. Both are resolved into the
 * event's people graph inputs. Likes deliberately auto-create authors: this
 * feed is an explicit personal signal, not a random home-timeline impression.
 * A direct person-to-person edge is deliberately not declared here because a
 * bundled connector cannot require a workspace-specific relationship type.
 */
const X_LIKED_POST_ATTRIBUTIONS: EventAttributionRule[] = [
	{
		// Author first: the current flat read-time identity slot should keep the
		// content author, while the named resolver still retains both roles for
		// relationship materialization.
		name: "author",
		role: "authored_by",
		autoCreate: true,
		target: X_PERSON_AUTHOR_TARGET,
		traits: X_PERSON_AUTHOR_TRAITS,
	},
	{
		name: "liker",
		role: "performed_by",
		autoCreate: true,
		target: {
			entityType: "person",
			titlePath: "metadata.liked_by_name",
			identities: [
				{
					namespace: X_IDENTITY.USER_ID,
					eventPath: "metadata.liked_by_id",
					primary: true,
				},
				{
					namespace: X_IDENTITY.HANDLE,
					eventPath: "metadata.liked_by_handle",
				},
			],
		},
		traits: {
			x_handle: {
				eventPath: "metadata.liked_by_handle",
				mergeStrategy: "prefer_non_empty",
			},
			x_display_name: {
				eventPath: "metadata.liked_by_name",
				mergeStrategy: "prefer_non_empty",
			},
		},
	},
];

const X_DM_COUNTERPARTY_ATTRIBUTIONS: EventAttributionRule[] = [
	{
		role: "authored_by",
		autoCreate: false,
		target: {
			entityType: "person",
			titlePath: "metadata.sender_name",
			identities: [
				{ namespace: X_IDENTITY.USER_ID, eventPath: "metadata.sender_id", primary: true },
				{ namespace: X_IDENTITY.HANDLE, eventPath: "metadata.sender_handle", matchOnly: true },
			],
		},
		traits: {
			x_handle: { eventPath: "metadata.sender_handle", mergeStrategy: "prefer_non_empty" },
			// Same trait key as X_PERSON_AUTHOR_TRAITS / DM counterparty — keep
			// person metadata vocabulary consistent across X attribution paths.
			x_display_name: {
				eventPath: "metadata.sender_name",
				mergeStrategy: "prefer_non_empty",
			},
		},
	},
	{
		role: "about",
		autoCreate: true,
		target: X_PERSON_DM_COUNTERPARTY_TARGET,
		traits: X_PERSON_DM_COUNTERPARTY_TRAITS,
	},
];

// ── Home-feed content-script scrape contract ────────────────────
//
// The personalized home timeline is the ONE feed that can't be read via
// network capture: attaching the CDP debugger stops the feed from rendering,
// so the GraphQL responses never arrive. Instead we drive the extension's
// `cs_scrape` op (a content script, no debugger) with a declarative selector
// config defined here.

/** A row produced by the extension's cs_scrape from HOME_FEED_SCRAPE_CONFIG. */
interface HomeFeedRow {
	id?: string;
	body?: string;
	author?: string;
	status_path?: string;
	published_at?: string;
}

/**
 * Selectors for the virtualized x.com/home DOM. These live here, not in the
 * extension — the scrape engine is site-agnostic.
 */
const HOME_FEED_SCRAPE_CONFIG = {
	scroll: { max: 8, stall: 3, waitMs: 1500 },
	loggedOutWhen: { pathRegex: "/(login|i/flow/login)\\b" },
	rowSelector: 'article[data-testid="tweet"]',
	id: {
		source: "field",
		field: "status_path",
		regex: "/status/(\\d+)",
		group: 1,
	},
	requireFields: ["body", "status_path"],
	fields: {
		body: { selector: '[data-testid="tweetText"]', take: "text" },
		author: {
			selector: '[data-testid="User-Name"]',
			take: "text",
			firstLine: true,
		},
		status_path: {
			selector: 'a[href*="/status/"]',
			take: "attr",
			attr: "href",
		},
		published_at: {
			selector: "time[datetime]",
			take: "attr",
			attr: "datetime",
		},
	},
} as const;

/** Pull @handle from a status permalink like `/alice/status/123`. */
export function parseUsernameFromStatusPath(statusPath: string): string {
	if (!statusPath) return "";
	const match = statusPath.match(/\/([^/]+)\/status\//);
	return match?.[1] ?? "";
}

/**
 * The home feed mixes in ads and suggestion noise. Drop them before emitting.
 */
export function isHomeFeedNoise(body: string): boolean {
	if (!body || body.trim().length < 5) return true;
	if (/\bPromoted\b/i.test(body.slice(0, 80))) return true;
	return false;
}

/** Map cs_scrape home-feed rows to XTweet objects for finalizeSyncResult. */
export function buildHomeFeedTweets(rows: HomeFeedRow[]): XTweet[] {
	const seen = new Set<string>();
	const tweets: XTweet[] = [];
	for (const row of rows) {
		if (!row?.id || !row.body || seen.has(row.id)) continue;
		if (isHomeFeedNoise(row.body)) continue;
		seen.add(row.id);
		const username =
			parseUsernameFromStatusPath(row.status_path ?? "") ||
			(row.author ?? "").replace(/^@+/, "").trim();
		const publishedAt = row.published_at
			? new Date(row.published_at)
			: new Date();
		tweets.push({
			id: row.id,
			text: row.body,
			username,
			likes: 0,
			retweets: 0,
			replies: 0,
			quotes: 0,
			publishedAt,
			isRetweet: false,
			isReply: false,
			isQuote: false,
		});
	}
	return tweets;
}

// ── Helpers ────────────────────────────────────────────────────

function normalizeHandle(input: string | undefined): string | null {
	if (!input) return null;
	const trimmed = input.trim().replace(/^@+/, "");
	if (!trimmed) return null;
	const match = trimmed.match(/^[A-Za-z0-9_]{1,15}/);
	return match?.[0] ?? null;
}

function buildSearchQuery(config: Record<string, unknown>): string {
	const explicitSearchQuery =
		typeof config.search_query === "string" ? config.search_query.trim() : "";
	if (explicitSearchQuery.length > 0) {
		return explicitSearchQuery;
	}

	const accountHandle = normalizeHandle(
		typeof config.account_handle === "string"
			? config.account_handle
			: undefined,
	);
	if (!accountHandle) {
		throw new Error("search_query or account_handle is required");
	}

	return `from:${accountHandle}`;
}

function normalizeMediaKind(
	type: string | undefined,
): XMediaAttachment["kind"] {
	if (type === "video" || type === "animated_gif") return type;
	return "image";
}

function buildApiTweet(
	tweet: XApiTweetRecord,
	usernameById: Map<string, string>,
	defaultUsername?: string,
): XTweet | null {
	if (!tweet.id || !tweet.text || !tweet.created_at) return null;

	const referenced = tweet.referenced_tweets ?? [];
	const publicMetrics = tweet.public_metrics ?? {};
	const inReplyToId = referenced.find((ref) => ref.type === "replied_to")?.id;
	const quotedTweetId = referenced.find((ref) => ref.type === "quoted")?.id;
	const repostedTweetId = referenced.find(
		(ref) => ref.type === "retweeted",
	)?.id;

	const authorId = tweet.author_id;
	const username =
		usernameById.get(authorId ?? "") ?? defaultUsername ?? "";

	return {
		id: tweet.id,
		text: tweet.text,
		username,
		authorId,
		likes: publicMetrics.like_count ?? 0,
		retweets: publicMetrics.retweet_count ?? 0,
		replies: publicMetrics.reply_count ?? 0,
		quotes: publicMetrics.quote_count ?? 0,
		publishedAt: new Date(tweet.created_at),
		isRetweet: referenced.some((ref) => ref.type === "retweeted"),
		isReply: Boolean(inReplyToId),
		isQuote: referenced.some((ref) => ref.type === "quoted"),
		conversationId: tweet.conversation_id,
		inReplyToId,
		quotedTweetId,
		repostedTweetId,
	};
}

function parseApiListResponse(
	json: XApiListResponse,
	defaultUsername?: string,
): XTweet[] {
	const users = json.includes?.users ?? [];
	const usernameById = new Map(
		users.map((user) => [user.id, user.username ?? ""]),
	);

	return (json.data ?? [])
		.map((tweet) => buildApiTweet(tweet, usernameById, defaultUsername))
		.filter((tweet): tweet is XTweet => tweet !== null);
}

function unwrapGraphqlTweetResult(result: any): any {
	return result?.__typename === "TweetWithVisibilityResults"
		? result.tweet
		: result;
}

function graphqlReferencedTweetId(result: any): string | undefined {
	const tweet = unwrapGraphqlTweetResult(result);
	const id = tweet?.rest_id ?? tweet?.legacy?.id_str;
	return id ? String(id) : undefined;
}

function extractGraphqlMedia(legacy: any): XMediaAttachment[] {
	const rows =
		legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((row: any) => {
		const rawVariants = Array.isArray(row?.video_info?.variants)
			? row.video_info.variants
			: [];
		const variants = rawVariants
			.filter(
				(variant: any) =>
					typeof variant?.url === "string" && variant.url.length > 0,
			)
			.map((variant: any) => ({
				url: variant.url,
				...(typeof variant.content_type === "string"
					? { mime_type: variant.content_type }
					: {}),
				...(typeof variant.bitrate === "number"
					? { bitrate: variant.bitrate }
					: {}),
			}));
		const playable = [...variants]
			.filter((variant) => variant.mime_type !== "application/x-mpegURL")
			.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url;
		const preview = row?.media_url_https ?? row?.media_url;
		const url = playable ?? preview;
		if (!url) return [];
		const original = row?.original_info;
		return [
			{
				kind: normalizeMediaKind(row?.type),
				url,
				...(preview ? { preview_url: preview } : {}),
				...(typeof row?.ext_alt_text === "string" && row.ext_alt_text
					? { alt_text: row.ext_alt_text }
					: {}),
				...(typeof original?.width === "number"
					? { width: original.width }
					: {}),
				...(typeof original?.height === "number"
					? { height: original.height }
					: {}),
				...(typeof row?.video_info?.duration_millis === "number"
					? { duration_ms: row.video_info.duration_millis }
					: {}),
				...(typeof row?.media_key === "string"
					? { media_key: row.media_key }
					: {}),
				...(variants.length > 0 ? { variants } : {}),
			},
		];
	});
}

function extractGraphqlUrls(legacy: any): XExpandedUrl[] {
	const rows = legacy?.entities?.urls;
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((row: any) => {
		if (typeof row?.url !== "string" || row.url.length === 0) return [];
		return [
			{
				url: row.url,
				...(typeof row.expanded_url === "string"
					? { expanded_url: row.expanded_url }
					: {}),
				...(typeof row.display_url === "string"
					? { display_url: row.display_url }
					: {}),
			},
		];
	});
}

/**
 * Extract one tweet from an x.com GraphQL `tweet_results.result` object.
 * Shared by the search and home-timeline parsers so both handle the same edge
 * cases: `TweetWithVisibilityResults` (limits on a tweet → nested `.tweet`),
 * the legacy/core nesting, and promoted-tweet detection.
 */
function extractTweetFromGraphqlResult(result: any): XTweet | null {
	if (!result || typeof result !== "object") return null;

	// TweetWithVisibilityResults wraps the real tweet under `.tweet`.
	const tweetNode = unwrapGraphqlTweetResult(result);
	const legacy = tweetNode?.legacy ?? result.legacy;
	const noteText =
		tweetNode?.note_tweet?.note_tweet_results?.result?.text ??
		result?.note_tweet?.note_tweet_results?.result?.text;
	const text = noteText ?? legacy?.full_text;
	if (!text) return null;

	const restId = legacy.id_str ?? tweetNode?.rest_id ?? result.rest_id;
	if (!restId) return null;

	const userResult =
		tweetNode?.core?.user_results?.result ?? result.core?.user_results?.result;
	const screenName =
		userResult?.core?.screen_name ?? userResult?.legacy?.screen_name ?? "";
	const authorId = userResult?.rest_id ?? userResult?.id;
	const authorDisplayName =
		userResult?.core?.name ?? userResult?.legacy?.name ?? undefined;

	return {
		id: restId,
		text,
		username: screenName,
		authorId: authorId ? String(authorId) : undefined,
		authorDisplayName,
		likes: legacy.favorite_count ?? 0,
		retweets: legacy.retweet_count ?? 0,
		replies: legacy.reply_count ?? 0,
		quotes: legacy.quote_count ?? 0,
		publishedAt: new Date(legacy.created_at),
		isRetweet: !!legacy.retweeted_status_result,
		isReply: !!legacy.in_reply_to_status_id_str,
		isQuote: !!legacy.is_quote_status,
		conversationId: legacy.conversation_id_str,
		inReplyToId: legacy.in_reply_to_status_id_str,
		quotedTweetId: graphqlReferencedTweetId(
			tweetNode?.quoted_status_result?.result ??
				result?.quoted_status_result?.result,
		),
		repostedTweetId: graphqlReferencedTweetId(
			legacy?.retweeted_status_result?.result ??
				tweetNode?.retweeted_status_result?.result,
		),
		attachments: extractGraphqlMedia(legacy),
		urls: extractGraphqlUrls(legacy),
		promoted: Boolean(result.promotedMetadata ?? tweetNode?.promotedMetadata),
	};
}

/**
 * Iterate the `instructions[].entries[]` shape shared by x.com's GraphQL
 * timelines (search + home). Entries may be tweet items, conversation modules
 * (a root + its threaded replies), or cursors — we only want tweet items, and
 * recurse one level into module items. Promoted entries are dropped.
 */
export function extractTweetsFromInstructions(instructions: any[]): XTweet[] {
	const tweets: XTweet[] = [];
	if (!Array.isArray(instructions)) return tweets;

	for (const instruction of instructions) {
		const entries = instruction.entries ?? instruction.moduleItems ?? [];
		for (const entry of entries) {
			// Skip promoted entries by entryId prefix (promoted-tweet-…, promotedTweet-…).
			const entryId: string = entry?.entryId ?? "";
			if (/^promoted/i.test(entryId)) continue;

			// A single tweet item.
			const itemResult =
				entry?.content?.itemContent?.tweet_results?.result ??
				entry?.item?.itemContent?.tweet_results?.result;
			if (itemResult) {
				const tweet = extractTweetFromGraphqlResult(itemResult);
				if (tweet && !tweet.promoted) tweets.push(tweet);
				continue;
			}

			// A conversation module: a root tweet + threaded replies, each under
			// its own `item.itemContent.tweet_results.result`.
			const moduleItems = entry?.content?.items ?? entry?.items ?? [];
			if (Array.isArray(moduleItems)) {
				for (const modItem of moduleItems) {
					const modResult =
						modItem?.item?.itemContent?.tweet_results?.result ??
						modItem?.itemContent?.tweet_results?.result;
					const tweet = modResult && extractTweetFromGraphqlResult(modResult);
					if (tweet && !tweet.promoted) tweets.push(tweet);
				}
			}
		}
	}

	return tweets;
}

/** Parse x.com GraphQL SearchTimeline responses. */
export function parseBrowserSearchResponse(
	_url: string,
	json: unknown,
): XTweet[] {
	const data = json as any;
	const instructions =
		data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ??
		[];
	return extractTweetsFromInstructions(instructions);
}

function timelineInstructionCandidates(data: any): unknown[] {
	return [
		data?.data?.user?.result?.timeline_v2?.timeline?.instructions,
		data?.data?.user?.result?.timeline?.timeline?.instructions,
		data?.data?.bookmark_timeline_v2?.timeline?.instructions,
		data?.data?.bookmarks_timeline?.timeline?.instructions,
		data?.data?.viewer?.bookmarks_timeline?.timeline?.instructions,
	];
}

/**
 * Return bounded JSON key paths for diagnostics without retaining response
 * values. X response bodies can contain private timeline text, so parser
 * failures may report structure only — never values or the raw body.
 */
function summarizeXResponseShape(json: unknown): string {
	const paths: string[] = [];
	const seen = new Set<object>();

	const visit = (value: unknown, path: string, depth: number): void => {
		if (
			paths.length >= X_RESPONSE_SHAPE_MAX_PATHS ||
			depth >= X_RESPONSE_SHAPE_MAX_DEPTH ||
			value === null ||
			typeof value !== "object"
		) {
			return;
		}
		if (seen.has(value)) return;
		seen.add(value);

		if (Array.isArray(value)) {
			const arrayPath = `${path}[]`;
			paths.push(arrayPath);
			if (value.length > 0) visit(value[0], arrayPath, depth + 1);
			return;
		}

		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) continue;
			const nextPath = path ? `${path}.${key}` : key;
			paths.push(nextPath);
			if (paths.length >= X_RESPONSE_SHAPE_MAX_PATHS) return;
			visit((value as Record<string, unknown>)[key], nextPath, depth + 1);
		}
	};

	visit(json, "", 0);
	return paths.length > 0 ? paths.join(",") : "empty";
}

export function extractBottomCursor(instructions: any[]): string | undefined {
	if (!Array.isArray(instructions)) return undefined;
	for (const instruction of instructions) {
		const entries = [
			...(Array.isArray(instruction?.entries) ? instruction.entries : []),
			...(instruction?.entry ? [instruction.entry] : []),
			...(Array.isArray(instruction?.moduleItems)
				? instruction.moduleItems
				: []),
		];
		for (const entry of entries) {
			const content = entry?.content ?? entry?.item?.content ?? entry;
			const cursorType = content?.cursorType ?? content?.cursor_type;
			const value = content?.value ?? content?.cursorValue;
			if (
				typeof value === "string" &&
				value.length > 0 &&
				typeof cursorType === "string" &&
				cursorType.toLowerCase() === "bottom"
			) {
				return value;
			}
		}
	}
	return undefined;
}

export function parseBrowserTimelinePage(
	_url: string,
	json: unknown,
): XTimelinePage {
	const data = json as any;
	const candidates = timelineInstructionCandidates(data);
	const instructions = (candidates.find(
		(candidate) => Array.isArray(candidate) && candidate.length > 0,
	) ?? candidates.find(Array.isArray)) as any[] | undefined;
	const ownerResult = data?.data?.user?.result;
	const owner = ownerResult
		? {
				...(ownerResult.rest_id ? { id: String(ownerResult.rest_id) } : {}),
				...(ownerResult?.core?.screen_name || ownerResult?.legacy?.screen_name
					? {
							handle:
								ownerResult?.core?.screen_name ??
								ownerResult?.legacy?.screen_name,
						}
					: {}),
				...(ownerResult?.core?.name || ownerResult?.legacy?.name
					? {
							displayName: ownerResult?.core?.name ?? ownerResult?.legacy?.name,
						}
					: {}),
			}
		: undefined;
	const errors = Array.isArray(data?.errors)
		? data.errors.flatMap((error: any) => {
				const message = error?.message ?? error?.detail;
				return typeof message === "string" && message ? [message] : [];
			})
		: [];
	return {
		tweets: instructions ? extractTweetsFromInstructions(instructions) : [],
		bottomCursor: instructions ? extractBottomCursor(instructions) : undefined,
		recognized: instructions !== undefined,
		owner,
		errors,
	};
}

/**
 * Parse x.com GraphQL timeline responses (profile tweets, likes, bookmarks).
 * Tries the common instruction-array shapes emitted by UserTweets, Likes, and
 * BookmarkTimeline endpoints.
 */
export function parseBrowserTimelineResponse(
	url: string,
	json: unknown,
): XTweet[] {
	return parseBrowserTimelinePage(url, json).tweets;
}

const TWEET_FIELDS =
	"author_id,conversation_id,created_at,public_metrics,referenced_tweets";

function tweetToEvent(tweet: XTweet, originType?: string): EventEnvelope {
	const engagementData = {
		reply_count: tweet.replies,
		upvotes: tweet.likes,
		score: tweet.retweets * 2 + tweet.likes,
	};

	return {
		origin_id: tweet.id,
		payload_text: tweet.text,
		...(tweet.attachments?.length ? { attachments: tweet.attachments } : {}),
		author_name: tweet.username ? `@${tweet.username}` : undefined,
		occurred_at: tweet.publishedAt,
		origin_type: originType ?? (tweet.isReply ? "reply" : "tweet"),
		score: calculateEngagementScore("x", engagementData),
		source_url: `https://x.com/${tweet.username || "i"}/status/${tweet.id}`,
		origin_parent_id: tweet.inReplyToId || undefined,
		metadata: {
			...engagementData,
			retweet_count: tweet.retweets,
			quote_count: tweet.quotes,
			is_retweet: tweet.isRetweet,
			is_reply: tweet.isReply,
			is_quote: tweet.isQuote,
			...(tweet.authorId ? { author_id: tweet.authorId } : {}),
			...(tweet.username
				? { author_handle: normalizeXHandle(tweet.username) ?? tweet.username }
				: {}),
			...(tweet.authorDisplayName ||
			(originType === "liked_tweet" && tweet.username)
				? { author_name: tweet.authorDisplayName ?? `@${tweet.username}` }
				: {}),
			...(tweet.conversationId
				? { conversation_id: tweet.conversationId }
				: {}),
			...(tweet.inReplyToId ? { in_reply_to_id: tweet.inReplyToId } : {}),
			...(tweet.quotedTweetId ? { quoted_tweet_id: tweet.quotedTweetId } : {}),
			...(tweet.repostedTweetId
				? { reposted_tweet_id: tweet.repostedTweetId }
				: {}),
			...(tweet.urls && tweet.urls.length > 0
				? { expanded_urls: tweet.urls }
				: {}),
			...(tweet.likedByUserId ? { liked_by_id: tweet.likedByUserId } : {}),
			...(tweet.likedByHandle
				? {
						liked_by_handle:
							normalizeXHandle(tweet.likedByHandle) ?? tweet.likedByHandle,
					}
				: {}),
			...(tweet.likedByDisplayName || tweet.likedByHandle
				? {
						liked_by_name:
							tweet.likedByDisplayName ?? `@${tweet.likedByHandle}`,
					}
				: {}),
		},
	};
}

function dmConversationIsGroup(conversationId: string): boolean {
	return !conversationId.includes("-");
}

function resolveDmCounterparty(
	conversationId: string,
	authUserId: string,
	senderId: string,
	usernameById: Map<string, string>,
	nameById: Map<string, string>,
): {
	participantId?: string;
	participantHandle?: string;
	participantName?: string;
} {
	if (dmConversationIsGroup(conversationId)) {
		return {};
	}

	const parts = conversationId.split("-").filter(Boolean);
	if (parts.length !== 2) {
		return {};
	}

	const participantId = parts.find((id) => id !== authUserId) ?? senderId;
	if (!participantId || participantId === authUserId) {
		return {};
	}

	return {
		participantId,
		participantHandle: usernameById.get(participantId),
		participantName: nameById.get(participantId),
	};
}

function buildDmMessage(
	event: XApiDmEventRecord,
	authUserId: string,
	usernameById: Map<string, string>,
	nameById: Map<string, string>,
): XDmMessage | null {
	if (event.event_type && event.event_type !== "MessageCreate") return null;
	if (!event.id || !event.text || !event.created_at || !event.sender_id) {
		return null;
	}
	if (!event.dm_conversation_id) return null;

	const senderId = event.sender_id;
	const conversationId = event.dm_conversation_id;
	const isGroup = dmConversationIsGroup(conversationId);
	const fromMe = senderId === authUserId;
	const counterparty = resolveDmCounterparty(
		conversationId,
		authUserId,
		senderId,
		usernameById,
		nameById,
	);

	return {
		id: event.id,
		text: event.text,
		senderId,
		senderHandle: usernameById.get(senderId) ?? "",
		senderName: nameById.get(senderId),
		conversationId,
		isGroup,
		fromMe,
		participantId: counterparty.participantId,
		participantHandle: counterparty.participantHandle,
		participantName: counterparty.participantName,
		publishedAt: new Date(event.created_at),
	};
}

function dmToEvent(message: XDmMessage): EventEnvelope {
	return {
		origin_id: message.id,
		payload_text: message.text,
		author_name: message.senderHandle ? `@${message.senderHandle}` : undefined,
		occurred_at: message.publishedAt,
		origin_type: "dm_message",
		origin_parent_id: message.conversationId,
		metadata: {
			sender_id: message.senderId,
			sender_handle: message.senderHandle,
			...(message.senderName ? { sender_name: message.senderName } : {}),
			from_me: message.fromMe,
			is_group: message.isGroup,
			dm_conversation_id: message.conversationId,
			...(message.participantId
				? { participant_id: message.participantId }
				: {}),
			...(message.participantHandle
				? { participant_handle: message.participantHandle }
				: {}),
			...(message.participantName
				? { participant_name: message.participantName }
				: {}),
		},
	};
}

export function finalizeDmSyncResult(
	messages: XDmMessage[],
	checkpoint: XCheckpoint,
	metadata: Record<string, unknown>,
): SyncResult {
	const seenIds = new Set<string>();
	const deduped = messages.filter((message) => {
		if (!message.id || !message.text || seenIds.has(message.id)) return false;
		seenIds.add(message.id);
		if (
			checkpoint.last_dm_event_id &&
			message.id === checkpoint.last_dm_event_id
		) {
			return false;
		}
		return true;
	});

	const events: EventEnvelope[] = deduped.map(dmToEvent);
	events.sort(
		(a, b) =>
			new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
	);

	const newestId =
		events.length > 0 ? events[0].origin_id : checkpoint.last_dm_event_id;
	const newCheckpoint: XCheckpoint = {
		...checkpoint,
		last_dm_event_id: newestId,
	};

	return {
		events,
		checkpoint: newCheckpoint as unknown as Record<string, unknown>,
		metadata: {
			items_found: events.length,
			items_skipped: messages.length - deduped.length,
			...metadata,
		},
	};
}

export function finalizeSyncResult(
	tweets: XTweet[],
	checkpoint: XCheckpoint,
	metadata: Record<string, unknown>,
	options?: { originType?: string },
): SyncResult {
	const seenIds = new Set<string>();
	const deduped = tweets.filter((tweet) => {
		if (!tweet.id || !tweet.text || seenIds.has(tweet.id)) return false;
		seenIds.add(tweet.id);
		if (checkpoint.last_tweet_id && tweet.id === checkpoint.last_tweet_id)
			return false;
		return true;
	});

	const events: EventEnvelope[] = deduped.map((tweet) =>
		tweetToEvent(tweet, options?.originType),
	);
	events.sort(
		(a, b) =>
			new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
	);

	const newestTweetId =
		events.length > 0 ? events[0].origin_id : checkpoint.last_tweet_id;
	const newCheckpoint: XCheckpoint = {
		last_tweet_id: newestTweetId,
		last_timestamp:
			events.length > 0 ? events[0].occurred_at : checkpoint.last_timestamp,
	};

	return {
		events,
		checkpoint: newCheckpoint as unknown as Record<string, unknown>,
		metadata: {
			items_found: events.length,
			items_skipped: tweets.length - deduped.length,
			...metadata,
		},
	};
}

export function finalizeLikedTweetsResult(
	tweets: XTweet[],
	checkpoint: XCheckpoint,
	metadata: Record<string, unknown>,
	backfill: {
		status: XLikesBackfillStatus;
		nextCursor?: string;
		pagesRead: number;
		historicalItemsRead: number;
	},
): SyncResult {
	// A browser backfill intentionally re-observes the newest page on every run.
	// Do not drop the old boundary: deterministic origin ids let ingestion update
	// metrics/media without creating a second canonical event.
	const result = finalizeSyncResult(tweets, {}, metadata, {
		originType: "liked_tweet",
	});
	const events = result.events;
	const newest = events[0];
	const oldest = [...events].sort(
		(a, b) =>
			new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
	)[0];
	const previousOldest = checkpoint.likes_oldest_timestamp
		? new Date(checkpoint.likes_oldest_timestamp)
		: null;
	const nextOldest =
		oldest &&
		(!previousOldest ||
			new Date(oldest.occurred_at).getTime() < previousOldest.getTime())
			? oldest
			: null;
	const status =
		backfill.status === "complete" &&
		(events.length > 0 ||
			checkpoint.likes_oldest_tweet_id ||
			checkpoint.likes_backfill_completed_at)
			? "complete"
			: "in_progress";
	const completedAt =
		status === "complete"
			? (checkpoint.likes_backfill_completed_at ?? new Date())
			: undefined;

	const nextCheckpoint: XCheckpoint = {
		...checkpoint,
		last_tweet_id: newest?.origin_id ?? checkpoint.last_tweet_id,
		last_timestamp: newest?.occurred_at ?? checkpoint.last_timestamp,
		likes_backfill_status: status,
		likes_backfill_pages:
			(checkpoint.likes_backfill_pages ?? 0) + backfill.pagesRead,
		likes_oldest_tweet_id:
			nextOldest?.origin_id ?? checkpoint.likes_oldest_tweet_id,
		likes_oldest_timestamp:
			nextOldest?.occurred_at ?? checkpoint.likes_oldest_timestamp,
		...(backfill.nextCursor
			? { likes_backfill_cursor: backfill.nextCursor }
			: {}),
		...(completedAt ? { likes_backfill_completed_at: completedAt } : {}),
	};
	if (status === "complete") delete nextCheckpoint.likes_backfill_cursor;
	else delete nextCheckpoint.likes_backfill_completed_at;

	return {
		...result,
		checkpoint: nextCheckpoint as unknown as Record<string, unknown>,
		metadata: {
			...result.metadata,
			collection_status: status,
			backfill_pages_this_run: backfill.pagesRead,
			backfill_pages_total: nextCheckpoint.likes_backfill_pages,
			backfill_items_this_run: backfill.historicalItemsRead,
			backfill_next_cursor:
				status === "in_progress"
					? (nextCheckpoint.likes_backfill_cursor ?? null)
					: null,
		},
	};
}

// ── Extension dispatcher ───────────────────────────────────────
//
// Pulled from sessionState — the connector-worker host splices a live
// `chrome_dispatcher` onto the sessionState of every sync AND every action run;
// the dispatcher's `dispatch()` rides a host capability up to the gateway's
// /api/workers/dispatch-chrome-action bridge and out to the paired Owletto
// extension. When no extension is online in the connection's org, the bridge
// returns `failed` and the dispatcher throws — we surface that verbatim.
//
// Structurally typed rather than taking SyncContext, so `execute()` can pass an
// ActionContext without either context type having to know about the other.
function requireExtensionDispatcher(ctx: {
	sessionState?: Record<string, unknown> | null;
}): ChromeActionDispatcher {
	const handle = ctx.sessionState?.chrome_dispatcher as
		| ChromeActionDispatcher
		| undefined;
	if (!handle || typeof handle.dispatch !== "function") {
		throw new Error(
			"X connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — re-run on a connector-worker that has the dispatcher bridge.",
		);
	}
	return handle;
}

// ── Sync paths ─────────────────────────────────────────────────

interface XAuthenticatedUser {
	id: string;
	username: string;
}

function createOAuthHttpClient(accessToken: string): HttpClient {
	return createHttpClient({
		token: accessToken,
		headers: { "Content-Type": "application/json" },
		errorPrefix: "X API",
	});
}

/**
 * Resolve how many scroll/page iterations this run should perform.
 *
 * - `max_scrolls` (default 10): upper bound (also the fixed value when min is omitted).
 * - `min_scrolls` (optional): when set below max, pick uniformly in [min, max]
 *   each run so depth varies.
 */
function readScrollBudget(
	config: Record<string, unknown>,
	opts: { defaultMax?: number; cap?: number } = {},
): number {
	const defaultMax = opts.defaultMax ?? 10;
	const cap = opts.cap ?? 50;
	const max = Math.max(
		1,
		Math.min(cap, Number(config.max_scrolls ?? defaultMax) || defaultMax),
	);
	const minRaw = config.min_scrolls;
	if (minRaw === undefined || minRaw === null || minRaw === "") {
		return max;
	}
	const min = Math.max(1, Math.min(max, Number(minRaw) || 1));
	if (min >= max) return max;
	return min + Math.floor(Math.random() * (max - min + 1));
}

function readMaxPages(config: Record<string, unknown>, cap = 50): number {
	return readScrollBudget(config, { defaultMax: 10, cap });
}

function readPositiveInteger(
	value: unknown,
	fallback: number,
	cap: number,
): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(1, Math.min(cap, Math.floor(parsed)));
}

function readLikesBackfillPageBudget(config: Record<string, unknown>): number {
	return readPositiveInteger(config.backfill_pages_per_run, 20, 60);
}

function readLikesIncrementalPageBudget(
	config: Record<string, unknown>,
): number {
	return readPositiveInteger(config.incremental_pages, 2, 10);
}

export function readGraphqlCursor(requestUrl: string): string | undefined {
	try {
		const parsed = new URL(requestUrl);
		const raw = parsed.searchParams.get("variables");
		if (!raw) return undefined;
		const variables = JSON.parse(raw) as { cursor?: unknown };
		return typeof variables.cursor === "string" && variables.cursor
			? variables.cursor
			: undefined;
	} catch {
		return undefined;
	}
}

export function replaceGraphqlCursor(
	requestUrl: string,
	cursor: string,
): string {
	const parsed = new URL(requestUrl);
	if (!/(^|\.)(?:x|twitter)\.com$/i.test(parsed.hostname)) {
		throw new Error("X likes pagination refused a non-X request URL");
	}
	const raw = parsed.searchParams.get("variables");
	if (!raw) {
		throw new Error("X likes pagination response URL has no GraphQL variables");
	}
	const variables = JSON.parse(raw) as Record<string, unknown>;
	variables.cursor = cursor;
	parsed.searchParams.set("variables", JSON.stringify(variables));
	return parsed.toString();
}

class XLikesPageTracker {
	readonly historicalTweetIds = new Set<string>();
	recognizedResponses = 0;
	requestedPages = 0;
	respondedPages = 0;
	pagesRead = 0;
	nextCursor: string | undefined;

	private activeRequestedCursor: string | undefined;
	private latestRequestUrl: string | undefined;
	private readonly startedFromResume: boolean;
	private terminalSeen = false;

	constructor(
		private readonly backfill: boolean,
		resumeCursor: string | undefined,
	) {
		this.nextCursor = resumeCursor;
		this.startedFromResume = resumeCursor !== undefined;
	}

	recordPage(url: string, page: XTimelinePage): void {
		const isInitialPage = this.recognizedResponses === 0;
		this.recognizedResponses += 1;

		const responseCursor = readGraphqlCursor(url);
		const isRequestedPage =
			this.activeRequestedCursor !== undefined &&
			responseCursor === this.activeRequestedCursor;
		const advancesCursor =
			isRequestedPage || (isInitialPage && !this.startedFromResume);
		if (!this.latestRequestUrl || advancesCursor) this.latestRequestUrl = url;

		if (isRequestedPage) {
			this.respondedPages += 1;
			this.recordHistoricalPage(page.tweets);
			this.activeRequestedCursor = undefined;
		}

		if (this.backfill && isInitialPage && !this.startedFromResume) {
			this.recordHistoricalPage(page.tweets);
		}

		if (advancesCursor && page.bottomCursor) {
			this.nextCursor = page.bottomCursor;
		} else if (advancesCursor && page.tweets.length > 0) {
			this.nextCursor = undefined;
			this.terminalSeen = true;
		}
	}

	prepareReplay(): string | undefined {
		const cursor = this.nextCursor;
		if (!cursor || !this.latestRequestUrl) {
			return undefined;
		}

		if (this.activeRequestedCursor === undefined) this.requestedPages += 1;
		this.activeRequestedCursor = cursor;
		this.nextCursor = cursor;
		return replaceGraphqlCursor(this.latestRequestUrl, cursor);
	}

	get unconfirmedPages(): number {
		return this.requestedPages - this.respondedPages;
	}

	status(): XLikesBackfillStatus {
		return !this.backfill || this.terminalSeen ? "complete" : "in_progress";
	}

	private recordHistoricalPage(tweets: XTweet[]): void {
		if (!this.backfill) return;
		this.pagesRead += 1;
		for (const tweet of tweets) this.historicalTweetIds.add(tweet.id);
	}
}

type XSyncBackend = "oauth_api" | "extension";

function parseGrantedScopes(scope: string | null | undefined): Set<string> {
	if (!scope) return new Set();
	return new Set(
		scope
			.split(/\s+/)
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
}

function hasGrantedScopes(
	granted: Set<string>,
	required: readonly string[] | undefined,
): boolean {
	if (!required || required.length === 0) return true;
	return required.every((entry) => granted.has(entry));
}

function isTruthyConfigFlag(value: unknown): boolean {
	return value === true || value === "true" || value === 1 || value === "1";
}

function readSyncBackendPreference(
	config: Record<string, unknown>,
): XSyncBackend | null {
	if (isTruthyConfigFlag(config.use_extension)) return "extension";
	if (isTruthyConfigFlag(config.use_oauth)) return "oauth_api";
	return null;
}

/**
 * Browser-first: when OAuth exists but the token lacks feed scopes, use the
 * paired extension instead of failing against the API.
 */
function resolveSyncBackend(
	ctx: SyncContext,
	config: Record<string, unknown>,
	requiredScopes: readonly string[] | undefined,
): XSyncBackend {
	const preference = readSyncBackendPreference(config);
	if (preference === "extension") return "extension";
	if (preference === "oauth_api" && ctx.credentials?.accessToken) {
		return "oauth_api";
	}

	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) return "extension";

	const granted = parseGrantedScopes(ctx.credentials?.scope);
	if (!hasGrantedScopes(granted, requiredScopes)) return "extension";

	return "oauth_api";
}

function isOAuthScopeOrAuthError(error: unknown): boolean {
	return (
		error instanceof HttpStatusError &&
		(error.status === 401 || error.status === 403)
	);
}

/** OAuth lookup failures that should defer to the paired extension on browser-first feeds. */
function isOAuthLookupFallbackError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		error.message.startsWith("Could not resolve X user id for @") ||
		error.message.startsWith("Could not resolve authenticated X user") ||
		error.message === "OAuth access token missing for X connector"
	);
}

function shouldFallbackToExtension(error: unknown): boolean {
	return isOAuthScopeOrAuthError(error) || isOAuthLookupFallbackError(error);
}

async function syncWithOAuthFallback<T extends SyncResult>(
	oauthFn: () => Promise<T>,
	extensionFn: () => Promise<T>,
): Promise<T> {
	try {
		return await oauthFn();
	} catch (error) {
		if (!shouldFallbackToExtension(error)) throw error;
		return extensionFn();
	}
}

/** Browser-first feeds fall back to the extension unless `use_oauth` is set. */
async function syncOAuthWithOptionalFallback<T extends SyncResult>(
	config: Record<string, unknown>,
	oauthFn: () => Promise<T>,
	extensionFn: () => Promise<T>,
): Promise<T> {
	if (isTruthyConfigFlag(config.use_oauth)) return oauthFn();
	return syncWithOAuthFallback(oauthFn, extensionFn);
}

function extractViewerUserId(json: unknown): string | undefined {
	const data = json as Record<string, unknown>;
	const candidates = [
		(data?.data as Record<string, unknown> | undefined)?.viewer_v2,
		(data?.data as Record<string, unknown> | undefined)?.viewer,
		(data?.data as Record<string, unknown> | undefined)?.user_result,
	];
	for (const node of candidates) {
		const result = (node as { user_results?: { result?: { rest_id?: string } } })
			?.user_results?.result;
		if (result?.rest_id) return String(result.rest_id);
	}
	return undefined;
}

function buildBrowserDmMessage(
	messageNode: Record<string, unknown>,
	authUserId: string,
): XDmMessage | null {
	const messageData =
		(messageNode.message_data as Record<string, unknown> | undefined) ??
		(messageNode.legacy as Record<string, unknown> | undefined);
	if (!messageData) return null;

	const id = String(
		messageNode.id ??
			messageNode.message_id ??
			messageData.id ??
			messageData.message_id ??
			"",
	);
	const text = String(messageData.text ?? messageData.full_text ?? "").trim();
	const createdAt = String(
		messageData.time ?? messageData.created_at ?? messageData.timestamp ?? "",
	);
	const senderId = String(
		messageData.sender_id ?? messageNode.sender_id ?? "",
	);
	const conversationId = String(
		messageNode.conversation_id ??
			messageNode.conversationId ??
			messageData.conversation_id ??
			"",
	);
	if (!id || !text || !createdAt || !senderId || !conversationId) return null;

	const senderHandle = String(
		messageData.sender_screen_name ??
			messageData.sender_handle ??
			messageNode.sender_handle ??
			"",
	).replace(/^@+/, "");
	const senderName =
		typeof messageData.sender_name === "string"
			? messageData.sender_name
			: undefined;
	const isGroup = dmConversationIsGroup(conversationId);
	const fromMe = authUserId.length > 0 && senderId === authUserId;
	const usernameById = new Map<string, string>(
		senderHandle ? [[senderId, senderHandle]] : [],
	);
	const nameById = new Map<string, string>(
		senderName ? [[senderId, senderName]] : [],
	);
	const counterparty = resolveDmCounterparty(
		conversationId,
		authUserId,
		senderId,
		usernameById,
		nameById,
	);

	return {
		id,
		text,
		senderId,
		senderHandle,
		senderName,
		conversationId,
		isGroup,
		fromMe,
		participantId: counterparty.participantId,
		participantHandle: counterparty.participantHandle,
		participantName: counterparty.participantName,
		publishedAt: new Date(createdAt),
	};
}

function extractDmMessagesFromNode(
	node: unknown,
	authUserId: string,
	seen: Set<string>,
): XDmMessage[] {
	if (!node || typeof node !== "object") return [];

	const messages: XDmMessage[] = [];
	const record = node as Record<string, unknown>;

	if (record.message_data || record.legacy) {
		const message = buildBrowserDmMessage(record, authUserId);
		if (message && !seen.has(message.id)) {
			seen.add(message.id);
			messages.push(message);
		}
	}

	if (record.message && typeof record.message === "object") {
		messages.push(
			...extractDmMessagesFromNode(record.message, authUserId, seen),
		);
	}

	const content = record.content;
	if (content && typeof content === "object") {
		messages.push(
			...extractDmMessagesFromNode(content, authUserId, seen),
		);
	}

	const entries = record.entries;
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			messages.push(
				...extractDmMessagesFromNode(entry, authUserId, seen),
			);
		}
	}

	const instructions = record.instructions;
	if (Array.isArray(instructions)) {
		for (const instruction of instructions) {
			messages.push(
				...extractDmMessagesFromNode(instruction, authUserId, seen),
			);
		}
	}

	const conversations = record.conversations;
	if (conversations && typeof conversations === "object") {
		for (const conversation of Object.values(conversations)) {
			messages.push(
				...extractDmMessagesFromNode(conversation, authUserId, seen),
			);
		}
	}

	const nestedCandidates = [
		record.data,
		record.timeline,
		record.inbox_initial_state,
		record.inbox_timeline,
		record.user_events,
	];
	for (const candidate of nestedCandidates) {
		messages.push(
			...extractDmMessagesFromNode(candidate, authUserId, seen),
		);
	}

	return messages;
}

/** Parse x.com GraphQL DM inbox / conversation responses. */
export function parseBrowserDmResponse(
	_url: string,
	json: unknown,
	authUserId = "",
): XDmMessage[] {
	const seen = new Set<string>();
	const resolvedAuthUserId = authUserId || extractViewerUserId(json) || "";
	return extractDmMessagesFromNode(json, resolvedAuthUserId, seen);
}

async function resolveUserId(
	handle: string,
	http: HttpClient,
): Promise<string> {
	const url = new URL(
		`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`,
	);
	const json = await http.get<{ data?: { id?: string } }>(url.toString());
	const userId = json.data?.id;
	if (!userId) {
		throw new Error(`Could not resolve X user id for @${handle}`);
	}
	return userId;
}

async function resolveAuthenticatedUser(
	http: HttpClient,
): Promise<XAuthenticatedUser> {
	const json = await http.get<{ data?: { id?: string; username?: string } }>(
		"https://api.x.com/2/users/me?user.fields=username",
	);
	const id = json.data?.id;
	const username = json.data?.username;
	if (!id || !username) {
		throw new Error("Could not resolve authenticated X user via /2/users/me");
	}
	return { id, username };
}

async function resolveAccountHandle(
	config: Record<string, unknown>,
	http?: HttpClient,
): Promise<string> {
	const configured = normalizeHandle(
		typeof config.account_handle === "string"
			? config.account_handle
			: undefined,
	);
	if (configured) return configured;
	if (!http) {
		throw new Error(
			"account_handle is required when OAuth is unavailable for this feed",
		);
	}
	const user = await resolveAuthenticatedUser(http);
	return user.username;
}

async function paginateTweetEndpoint(
	http: HttpClient,
	buildUrl: (nextToken?: string) => URL,
	maxPages: number,
	defaultUsername?: string,
): Promise<{ tweets: XTweet[]; pageCount: number }> {
	const tweets: XTweet[] = [];
	let pageCount = 0;

	const pages = paginateByCursor<XTweet, string>(
		async (nextToken) => {
			const url = buildUrl(nextToken ?? undefined);
			const json = await http.get<XApiListResponse>(url.toString());
			pageCount += 1;
			return {
				items: parseApiListResponse(json, defaultUsername),
				nextCursor: json.meta?.next_token,
			};
		},
		{ maxPages },
	);

	for await (const items of pages) {
		tweets.push(...items);
	}

	return { tweets, pageCount };
}

async function syncViaOAuthApi(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) {
		throw new Error("OAuth access token missing for X connector");
	}

	const http = createOAuthHttpClient(accessToken);
	const maxPages = readMaxPages(config);
	const accountHandle = normalizeHandle(
		typeof config.account_handle === "string"
			? config.account_handle
			: undefined,
	);
	const explicitSearchQuery =
		typeof config.search_query === "string" ? config.search_query.trim() : "";

	const tweets: XTweet[] = [];
	let pageCount = 0;

	if (explicitSearchQuery.length === 0 && accountHandle) {
		const userId = await resolveUserId(accountHandle, http);

		const pages = paginateByCursor<XTweet, string>(
			async (nextToken) => {
				const url = new URL(
					`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`,
				);
				url.searchParams.set("max_results", "100");
				url.searchParams.set("tweet.fields", TWEET_FIELDS);
				if (checkpoint.last_tweet_id) {
					url.searchParams.set("since_id", checkpoint.last_tweet_id);
				}
				if (nextToken) {
					url.searchParams.set("pagination_token", nextToken);
				}

				const json = await http.get<XApiListResponse>(url.toString());
				pageCount += 1;
				return {
					items: parseApiListResponse(json, accountHandle),
					nextCursor: json.meta?.next_token,
				};
			},
			{ maxPages },
		);

		for await (const items of pages) {
			tweets.push(...items);
		}
	} else {
		const searchQuery = buildSearchQuery(config);

		const pages = paginateByCursor<XTweet, string>(
			async (nextToken) => {
				const url = new URL("https://api.x.com/2/tweets/search/recent");
				url.searchParams.set("query", searchQuery);
				url.searchParams.set("max_results", "100");
				url.searchParams.set("tweet.fields", TWEET_FIELDS);
				url.searchParams.set("expansions", "author_id");
				url.searchParams.set("user.fields", "username");
				if (checkpoint.last_tweet_id) {
					url.searchParams.set("since_id", checkpoint.last_tweet_id);
				}
				if (nextToken) {
					url.searchParams.set("next_token", nextToken);
				}

				const json = await http.get<XApiListResponse>(url.toString());
				pageCount += 1;
				return {
					items: parseApiListResponse(json),
					nextCursor: json.meta?.next_token,
				};
			},
			{ maxPages },
		);

		for await (const items of pages) {
			tweets.push(...items);
		}
	}

	return finalizeSyncResult(tweets, checkpoint, {
		backend: "oauth_api",
		api_calls: pageCount,
	});
}

/**
 * Drive the paired extension's network intercept for x.com search, parsing
 * intercepted GraphQL SearchTimeline responses.
 */
async function syncViaExtension(args: {
	ctx: SyncContext;
	url: string;
	interceptPatterns: { regex: string; flags?: string }[];
	parseResponse: (url: string, json: unknown) => XTweet[];
	maxScrolls: number;
	checkpoint: XCheckpoint;
	/** Extra metadata to fold into the result (e.g. which timeline tab). */
	metadata?: Record<string, unknown>;
	originType?: string;
}): Promise<SyncResult> {
	const { ctx, url, interceptPatterns, parseResponse, maxScrolls, checkpoint } =
		args;
	const result = await extensionNetworkSync<XTweet>({
		dispatcher: requireExtensionDispatcher(ctx),
		config: {
			interceptPatterns,
			allowedOrigins: X_ALLOWED_ORIGINS,
			maxScrolls,
			scrollDelayMs: 2000,
			responseTimeoutMs: 5000,
		},
		url,
		parseResponse,
		checkAuth: (currentUrl) => !isXAuthWall(currentUrl),
	});

	return finalizeSyncResult(
		result.items,
		checkpoint,
		{
			backend: result.backend,
			api_calls: result.apiCallCount,
			...(args.metadata ?? {}),
		},
		args.originType ? { originType: args.originType } : undefined,
	);
}

async function syncSearchViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const searchQuery = buildSearchQuery(config);
	const maxScrolls = readMaxPages(config);
	const searchFilter = (config.search_filter as string) ?? "live";
	const searchUrl = `https://x.com/search?q=${encodeURIComponent(searchQuery)}&src=typed_query&f=${searchFilter}`;

	return syncViaExtension({
		ctx,
		url: searchUrl,
		interceptPatterns: [{ regex: "/i/api/graphql/\\w+/.*Search" }],
		parseResponse: parseBrowserSearchResponse,
		maxScrolls,
		checkpoint,
		metadata: { search_query: searchQuery, search_filter: searchFilter },
	});
}

async function syncMyTweetsViaOAuthApi(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) {
		throw new Error("OAuth access token missing for my_tweets feed");
	}

	const http = createOAuthHttpClient(accessToken);
	const maxPages = readMaxPages(config);
	const authUser = await resolveAuthenticatedUser(http);
	const accountHandle = await resolveAccountHandle(config, http);
	const userId =
		accountHandle === authUser.username
			? authUser.id
			: await resolveUserId(accountHandle, http);

	const { tweets, pageCount } = await paginateTweetEndpoint(
		http,
		(nextToken) => {
			const url = new URL(
				`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`,
			);
			url.searchParams.set("max_results", "100");
			url.searchParams.set("tweet.fields", TWEET_FIELDS);
			if (checkpoint.last_tweet_id) {
				url.searchParams.set("since_id", checkpoint.last_tweet_id);
			}
			if (nextToken) {
				url.searchParams.set("pagination_token", nextToken);
			}
			return url;
		},
		maxPages,
		accountHandle,
	);

	return finalizeSyncResult(tweets, checkpoint, {
		backend: "oauth_api",
		api_calls: pageCount,
		account_handle: accountHandle,
		feed: "my_tweets",
	});
}

async function syncMyTweetsViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accountHandle = await resolveAccountHandle(config);
	const maxScrolls = readMaxPages(config);
	const profileUrl = `https://x.com/${encodeURIComponent(accountHandle)}`;

	return syncViaExtension({
		ctx,
		url: profileUrl,
		interceptPatterns: [{ regex: "/i/api/graphql/\\w+/.*UserTweets" }],
		parseResponse: parseBrowserTimelineResponse,
		maxScrolls,
		checkpoint,
		metadata: { account_handle: accountHandle, feed: "my_tweets" },
	});
}

async function syncLikedTweetsViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accountHandle = await resolveAccountHandle(config);
	const likesUrl = `https://x.com/${encodeURIComponent(accountHandle)}/likes`;
	const dispatcher = requireExtensionDispatcher(ctx);
	const previouslyComplete = checkpoint.likes_backfill_status === "complete";
	const pageBudget = previouslyComplete
		? readLikesIncrementalPageBudget(config)
		: readLikesBackfillPageBudget(config);
	const startsAtFirstPage =
		!previouslyComplete && !checkpoint.likes_backfill_cursor;
	const pages = new XLikesPageTracker(
		!previouslyComplete,
		previouslyComplete ? undefined : checkpoint.likes_backfill_cursor,
	);
	let owner: XTimelinePage["owner"];
	const parserErrors: string[] = [];
	const responseShapes = new Set<string>();
	let parsedJsonResponses = 0;

	const parseResponse = (url: string, json: unknown): XTweet[] => {
		parsedJsonResponses += 1;
		if (responseShapes.size < X_RESPONSE_SHAPE_MAX_SAMPLES) {
			responseShapes.add(summarizeXResponseShape(json));
		}
		const page = parseBrowserTimelinePage(url, json);
		parserErrors.push(...page.errors);
		if (!page.recognized || page.errors.length > 0) {
			return [];
		}
		pages.recordPage(url, page);
		owner = page.owner ?? owner;

		return page.tweets.map((tweet) => ({
			...tweet,
			likedByUserId: owner?.id,
			likedByHandle: owner?.handle ?? accountHandle,
			likedByDisplayName:
				owner?.displayName ?? `@${owner?.handle ?? accountHandle}`,
		}));
	};

	const paginationRequests = Math.max(
		0,
		pageBudget - (startsAtFirstPage || previouslyComplete ? 1 : 0),
	);
	const result = await extensionNetworkSync<XTweet>({
		dispatcher,
		config: {
			interceptPatterns: [{ regex: X_LIKES_INTERCEPT_PATTERN }],
			allowedOrigins: X_ALLOWED_ORIGINS,
			maxScrolls: paginationRequests,
			scrollDelayMs: 750,
			responseTimeoutMs: 5000,
		},
		url: likesUrl,
		parseResponse,
		checkAuth: (currentUrl) => !isXAuthWall(currentUrl),
			triggerNextPage: async (_tabId, browserDispatcher, sessionId) => {
				let requestUrl: string | undefined;
				try {
					requestUrl = pages.prepareReplay();
				} catch {
					parserErrors.push("X likes cursor rewrite failed");
					return;
				}
				if (!requestUrl) return;
			let observation: { ok?: boolean; status?: number };
			try {
				observation = await browserDispatcher.dispatch<{
					ok?: boolean;
					status?: number;
				}>("network_intercept_replay", {
					session_id: sessionId,
					url: requestUrl,
					allowed_origins: X_ALLOWED_ORIGINS,
				});
			} catch {
				parserErrors.push("X likes cursor request failed (transport_error)");
				return;
			}
			if (observation.ok !== true) {
				parserErrors.push(
					`X likes cursor request failed (${observation.status ?? "unknown"})`,
				);
			}
		},
	});

	if (pages.recognizedResponses === 0) {
		if (result.apiCallCount === 0) {
			throw new Error(
				`X likes captured no matching GraphQL responses (pattern=${X_LIKES_INTERCEPT_PATTERN})`,
			);
		}
		if (parsedJsonResponses === 0) {
			throw new Error(
				`X likes captured ${result.apiCallCount} matching response(s), but none contained parseable JSON`,
			);
		}
		throw new Error(
			`X likes captured ${result.apiCallCount} matching response(s) and parsed ${parsedJsonResponses} JSON response(s), but found no recognizable timeline shape (keys=${Array.from(responseShapes).join("|")})${
				parserErrors.length > 0 ? `: ${parserErrors.join("; ")}` : ""
			}`,
		);
	}
	const status = pages.status();
	return finalizeLikedTweetsResult(
		result.items,
		checkpoint,
		{
			backend: result.backend,
			api_calls: result.apiCallCount,
			account_handle: accountHandle,
			feed: "liked_tweets",
			collection_scope: "x_browser_visible_history",
			pages_requested: pages.requestedPages,
			pages_received: pages.respondedPages,
			pages_unconfirmed: pages.unconfirmedPages,
			parser_errors: parserErrors,
		},
		{
			status,
			nextCursor: status === "in_progress" ? pages.nextCursor : undefined,
			pagesRead: pages.pagesRead,
			historicalItemsRead: pages.historicalTweetIds.size,
		},
	);
}

async function syncLikedTweetsViaOAuthApi(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) {
		throw new Error("OAuth access token missing for liked_tweets feed");
	}

	const http = createOAuthHttpClient(accessToken);
	const maxPages = readMaxPages(config);
	const authUser = await resolveAuthenticatedUser(http);
	const accountHandle = await resolveAccountHandle(config, http);
	const userId =
		accountHandle === authUser.username
			? authUser.id
			: await resolveUserId(accountHandle, http);

	const { tweets, pageCount } = await paginateTweetEndpoint(
		http,
		(nextToken) => {
			const url = new URL(
				`https://api.x.com/2/users/${encodeURIComponent(userId)}/liked_tweets`,
			);
			url.searchParams.set("max_results", "100");
			url.searchParams.set("tweet.fields", TWEET_FIELDS);
			url.searchParams.set("expansions", "author_id");
			url.searchParams.set("user.fields", "username");
			if (nextToken) {
				url.searchParams.set("pagination_token", nextToken);
			}
			return url;
		},
		maxPages,
	);

	// Stamp the liker on every row: the `liker` attribution reads
	// `metadata.liked_by_*`, so without this the OAuth backend would resolve
	// only the author and silently drop half the feed's declared people graph.
	const likedBy = tweets.map((tweet) => ({
		...tweet,
		likedByUserId: userId,
		likedByHandle: accountHandle,
		likedByDisplayName: `@${accountHandle}`,
	}));

	const result = finalizeSyncResult(
		likedBy,
		checkpoint,
		{
			backend: "oauth_api",
			api_calls: pageCount,
			account_handle: accountHandle,
			feed: "liked_tweets",
		},
		{ originType: "liked_tweet" },
	);

	// finalizeSyncResult only knows the shared tweet watermark. Carry the
	// extension backfill state forward untouched: a connection that switches
	// backends must not lose its resumable cursor and restart the whole backfill.
	return {
		...result,
		checkpoint: {
			...checkpoint,
			...result.checkpoint,
		} as unknown as Record<string, unknown>,
	};
}

async function syncBookmarksViaOAuthApi(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) {
		throw new Error("OAuth access token missing for bookmarks feed");
	}

	const http = createOAuthHttpClient(accessToken);
	const maxPages = readMaxPages(config);
	const authUser = await resolveAuthenticatedUser(http);

	const { tweets, pageCount } = await paginateTweetEndpoint(
		http,
		(nextToken) => {
			const url = new URL(
				`https://api.x.com/2/users/${encodeURIComponent(authUser.id)}/bookmarks`,
			);
			url.searchParams.set("max_results", "100");
			url.searchParams.set("tweet.fields", TWEET_FIELDS);
			url.searchParams.set("expansions", "author_id");
			url.searchParams.set("user.fields", "username");
			if (nextToken) {
				url.searchParams.set("pagination_token", nextToken);
			}
			return url;
		},
		maxPages,
	);

	return finalizeSyncResult(tweets, checkpoint, {
		backend: "oauth_api",
		api_calls: pageCount,
		feed: "bookmarks",
	}, { originType: "bookmark" });
}

async function syncBookmarksViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const maxScrolls = readMaxPages(config);

	return syncViaExtension({
		ctx,
		url: "https://x.com/i/bookmarks",
		interceptPatterns: [{ regex: "/i/api/graphql/\\w+/.*Bookmark" }],
		parseResponse: parseBrowserTimelineResponse,
		maxScrolls,
		checkpoint,
		metadata: { feed: "bookmarks" },
		originType: "bookmark",
	});
}

function parseApiDmListResponse(
	json: XApiDmListResponse,
	authUserId: string,
): XDmMessage[] {
	const users = json.includes?.users ?? [];
	const usernameById = new Map(
		users.map((user) => [user.id, user.username ?? ""]),
	);
	const nameById = new Map(
		users.map((user) => [user.id, user.name ?? ""]),
	);

	return (json.data ?? [])
		.map((event) =>
			buildDmMessage(event, authUserId, usernameById, nameById),
		)
		.filter((message): message is XDmMessage => message !== null);
}

async function syncDirectMessagesViaOAuthApi(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const accessToken = ctx.credentials?.accessToken;
	if (!accessToken) {
		throw new Error(
			"OAuth access token missing for direct_messages feed (requires dm.read)",
		);
	}

	const http = createOAuthHttpClient(accessToken);
	const maxPages = readMaxPages(config);
	const authUser = await resolveAuthenticatedUser(http);
	const messages: XDmMessage[] = [];
	let pageCount = 0;

	const pages = paginateByCursor<XDmMessage, string>(
		async (nextToken) => {
			const url = new URL("https://api.x.com/2/dm_events");
			url.searchParams.set("max_results", "100");
			url.searchParams.set(
				"dm_event.fields",
				"id,text,created_at,sender_id,dm_conversation_id,event_type",
			);
			url.searchParams.set("event_types", "MessageCreate");
			url.searchParams.set("expansions", "sender_id,participant_ids");
			url.searchParams.set("user.fields", "username,name");
			if (nextToken) {
				url.searchParams.set("pagination_token", nextToken);
			}

			const json = await http.get<XApiDmListResponse>(url.toString());
			pageCount += 1;
			return {
				items: parseApiDmListResponse(json, authUser.id),
				nextCursor: json.meta?.next_token,
			};
		},
		{ maxPages },
	);

	for await (const items of pages) {
		messages.push(...items);
	}

	return finalizeDmSyncResult(messages, checkpoint, {
		backend: "oauth_api",
		api_calls: pageCount,
		feed: "direct_messages",
	});
}

async function syncDirectMessagesViaExtension(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const maxScrolls = readMaxPages(config);
	let authUserId =
		typeof config.account_user_id === "string"
			? config.account_user_id.trim()
			: "";

	const result = await extensionNetworkSync<XDmMessage>({
		dispatcher: requireExtensionDispatcher(ctx),
		config: {
			interceptPatterns: [
				{ regex: "/i/api/graphql/\\w+/.*DM" },
				{ regex: "/i/api/graphql/\\w+/.*Dm" },
				{ regex: "/i/api/graphql/\\w+/.*Message" },
				{ regex: "/i/api/graphql/\\w+/.*Inbox" },
			],
			allowedOrigins: X_ALLOWED_ORIGINS,
			maxScrolls,
			scrollDelayMs: 2000,
			responseTimeoutMs: 5000,
		},
		url: "https://x.com/messages",
		parseResponse: (_url, json) => {
			if (!authUserId) {
				authUserId = extractViewerUserId(json) ?? authUserId;
			}
			return parseBrowserDmResponse(_url, json, authUserId);
		},
		checkAuth: (currentUrl) => !isXAuthWall(currentUrl),
	});

	return finalizeDmSyncResult(result.items, checkpoint, {
		backend: result.backend,
		api_calls: result.apiCallCount,
		feed: "direct_messages",
	});
}

/**
 * Personalized home timeline via the extension's content-script scrape.
 * Network capture can't read it (the CDP debugger stops the feed rendering).
 */
async function syncHomeFeedViaDomScrape(
	ctx: SyncContext,
	config: Record<string, unknown>,
	checkpoint: XCheckpoint,
): Promise<SyncResult> {
	const maxScrolls = readScrollBudget(config, { defaultMax: 10, cap: 30 });
	const { items: rows, loggedIn } = await extensionDomScrape<HomeFeedRow>({
		dispatcher: requireExtensionDispatcher(ctx),
		url: "https://x.com/home",
		config: {
			...HOME_FEED_SCRAPE_CONFIG,
			scroll: { ...HOME_FEED_SCRAPE_CONFIG.scroll, max: maxScrolls },
		},
		parseRows: (raw) => raw as HomeFeedRow[],
		allowedOrigins: X_ALLOWED_ORIGINS,
	});

	if (!loggedIn) {
		throw new Error(
			"Not logged into X. Sign in to x.com in the paired Chrome profile, then re-run the sync.",
		);
	}

	const tweets = buildHomeFeedTweets(rows);
	return finalizeSyncResult(tweets, checkpoint, {
		backend: "extension-cs-scrape",
		items_scraped: rows.length,
		scrolls_this_run: maxScrolls,
		timeline: "home",
	});
}

// ── Config schemas ─────────────────────────────────────────────

const backendPreferenceProperties = {
	use_extension: {
		type: "boolean",
		default: false,
		description:
			"Force the paired Chrome extension even when OAuth is available.",
	},
	use_oauth: {
		type: "boolean",
		default: false,
		description:
			"Force the X API even when scopes are missing (will fail unless re-authorized).",
	},
} as const;

const scrollBudgetProperties = {
	max_scrolls: {
		type: "integer",
		minimum: 1,
		maximum: 50,
		default: 10,
		description:
			"Maximum scroll/page iterations this feed may perform (default: 10). With min_scrolls, this is the upper end of a per-run random range.",
	},
	min_scrolls: {
		type: "integer",
		minimum: 1,
		maximum: 50,
		description:
			"Optional lower bound. When set below max_scrolls, each sync picks a uniform random scroll count in [min_scrolls, max_scrolls].",
	},
} as const;

const searchConfigSchema = {
	type: "object",
	anyOf: [{ required: ["search_query"] }, { required: ["account_handle"] }],
	properties: {
		search_query: {
			type: "string",
			minLength: 1,
			description:
				'Search query for tweets (e.g., "nodejs", "#programming", "from:user")',
		},
		account_handle: {
			type: "string",
			minLength: 1,
			description:
				'Optional X handle to track directly (e.g. "openai" or "@openai"). Used when search_query is omitted.',
		},
		search_filter: {
			type: "string",
			enum: ["live", "top"],
			default: "live",
			description:
				'Search tab: "live" for Latest (chronological), "top" for Top (popular/algorithmic)',
		},
		...scrollBudgetProperties,
		...backendPreferenceProperties,
	},
};

const homeFeedConfigSchema = {
	type: "object",
	properties: {
		max_scrolls: {
			type: "integer",
			minimum: 1,
			maximum: 30,
			default: 10,
			description:
				"Maximum scroll iterations for the home timeline (default: 10). Upper end of the range when min_scrolls is set.",
		},
		min_scrolls: {
			type: "integer",
			minimum: 1,
			maximum: 30,
			description:
				"Optional lower bound. When set below max_scrolls, each sync picks a uniform random scroll count in [min_scrolls, max_scrolls].",
		},
	},
};

const accountTimelineConfigSchema = {
	type: "object",
	properties: {
		account_handle: {
			type: "string",
			minLength: 1,
			description:
				'Optional X handle (e.g. "example_account"). Defaults to the authenticated account when OAuth is available.',
		},
		...scrollBudgetProperties,
		...backendPreferenceProperties,
	},
};

const likedTweetsConfigSchema = {
	type: "object",
	properties: {
		account_handle: {
			type: "string",
			minLength: 1,
			description:
				'Optional X handle (e.g. "testuser"). Defaults to the authenticated account on OAuth; required for extension collection.',
		},
		...backendPreferenceProperties,
		backfill_pages_per_run: {
			type: "integer",
			minimum: 1,
			maximum: 60,
			default: 20,
			description:
				"Maximum cursor pages consumed by one historical browser backfill run. The next cursor is checkpointed so later runs resume exactly.",
		},
		incremental_pages: {
			type: "integer",
			minimum: 1,
			maximum: 10,
			default: 2,
			description:
				"Pages read from the newest likes after the historical backfill reaches the platform boundary.",
		},
	},
};

const bookmarksConfigSchema = {
	type: "object",
	properties: {
		account_handle: {
			type: "string",
			minLength: 1,
			description:
				'Optional X handle (e.g. "example_account") for DM counterparty resolution when the viewer id is unavailable.',
		},
		account_user_id: {
			type: "string",
			minLength: 1,
			description:
				"Optional numeric X user id for DM from_me / counterparty resolution on the extension path.",
		},
		...scrollBudgetProperties,
		...backendPreferenceProperties,
	},
};

const engagementMetadataSchema = {
	type: "object",
	properties: {
		reply_count: { type: "number" },
		upvotes: { type: "number", description: "Likes" },
		score: { type: "number" },
		retweet_count: { type: "number" },
		quote_count: { type: "number" },
		is_retweet: { type: "boolean" },
		is_reply: { type: "boolean" },
		is_quote: { type: "boolean" },
		conversation_id: { type: "string" },
		in_reply_to_id: { type: "string" },
		quoted_tweet_id: { type: "string" },
		reposted_tweet_id: { type: "string" },
		expanded_urls: { type: "array", items: { type: "object" } },
		author_id: { type: "string", description: "X numeric user id" },
		author_handle: { type: "string", description: "X @handle without @" },
		author_name: { type: "string", description: "Display name" },
		liked_by_id: { type: "string", description: "Connected X numeric user id" },
		liked_by_handle: {
			type: "string",
			description: "Connected X @handle without @",
		},
		liked_by_name: { type: "string", description: "Connected account name" },
	},
};

const dmMetadataSchema = {
	type: "object",
	properties: {
		sender_id: { type: "string" },
		sender_handle: { type: "string" },
		sender_name: { type: "string" },
		participant_id: { type: "string" },
		participant_handle: { type: "string" },
		participant_name: { type: "string" },
		from_me: { type: "boolean" },
		is_group: { type: "boolean" },
		dm_conversation_id: { type: "string" },
	},
};

// ── prepare_reply handoff (browser stage, human submits) ───────
//
// Mirrors `linkedin.prepare_comment`. There is deliberately no URL-based path:
// X ignores the `?text=` prefill parameter on /intent/post, /intent/tweet and
// /compose/post alike, with and without `in_reply_to` (verified 2026-08-02
// against the signed-in app). The only way to put text in X's composer is to
// type it, so this drives the paired Owletto Chrome and stops before submit.

/** Cap the explanation shown in the in-page banner. Mirrors linkedin. */
export function truncateHandoffReason(
	reason: string | undefined | null,
	maxLen = 120,
): string | undefined {
	if (reason == null) return undefined;
	const t = reason.replace(/\s+/g, " ").trim();
	if (!t) return undefined;
	if (t.length <= maxLen) return t;
	return `${t.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

/**
 * JS expression: inject a small Lobu handoff banner above X's reply composer,
 * carrying the reason this post was worth answering.
 *
 * Without it the staged page is context-free — you get a draft in a box with no
 * record of why the agent thought this post mattered, which is most of what you
 * need in order to accept, edit, or bin it. Same banner as
 * `linkedin.prepare_comment`, adapted for X: its own composer selectors, no
 * side-panel footer line.
 *
 * Best-effort: X re-renders aggressively and may drop the node. Never fatal —
 * the draft is already staged by the time this runs.
 */
export function buildInjectHandoffBannerExpression(opts: {
	reason?: string;
}): string {
	const reason = truncateHandoffReason(opts.reason);
	const titleLit = JSON.stringify("Lobu staged this reply");
	const reasonLit = JSON.stringify(reason ?? null);
	return `(async()=>{
  const TITLE = ${titleLit};
  const REASON = ${reasonLit};
  const ID = 'lobu-handoff-banner';
  try {
    const prev = document.getElementById(ID);
    if (prev) prev.remove();
  } catch (_) {}

  const root = document.createElement('div');
  root.id = ID;
  root.setAttribute('role', 'status');
  root.setAttribute('data-lobu', 'handoff-banner');
  root.style.cssText = [
    'position:fixed',
    'top:12px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:2147483646',
    'max-width:min(520px,calc(100vw - 24px))',
    'font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif',
    'color:#0f172a',
    'background:#fff',
    'border:1px solid #cbd5e1',
    'border-left:4px solid #0ea5e9',
    'border-radius:10px',
    'box-shadow:0 8px 28px rgba(15,23,42,.18)',
    'padding:10px 12px',
    'display:flex',
    'gap:10px',
    'align-items:flex-start',
    'pointer-events:auto',
  ].join(';');

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0';

  const head = document.createElement('div');
  head.style.cssText = 'font-weight:600;margin:0 0 2px;color:#0c4a6e';
  head.textContent = TITLE;

  const line = document.createElement('div');
  line.style.cssText = 'color:#334155;margin:0 0 2px';
  line.textContent = 'Review the draft and click Reply yourself — Lobu did not submit.';

  body.appendChild(head);
  body.appendChild(line);

  if (REASON) {
    const why = document.createElement('div');
    why.style.cssText = 'color:#64748b;margin:4px 0 0;font-size:12px';
    why.textContent = 'Why: ' + REASON;
    body.appendChild(why);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '\\u00d7';
  close.style.cssText = [
    'flex:none',
    'border:0',
    'background:transparent',
    'color:#64748b',
    'font:20px/1 sans-serif',
    'cursor:pointer',
    'padding:0 2px',
  ].join(';');
  close.onclick = function () { try { root.remove(); } catch (_) {} };

  root.appendChild(body);
  root.appendChild(close);

  // Anchor above the reply composer when we can find it, so the reason sits
  // next to the draft instead of floating over unrelated timeline content.
  let anchored = false;
  try {
    const composer =
      document.querySelector('[data-testid="tweetTextarea_0"]') ||
      document.querySelector('div[role="textbox"][contenteditable="true"]');
    if (composer) {
      const host = composer.closest('form') || composer.parentElement;
      if (host && host.parentElement) {
        root.style.position = 'relative';
        root.style.top = '0';
        root.style.left = '0';
        root.style.transform = 'none';
        root.style.margin = '8px 0 12px';
        root.style.maxWidth = '100%';
        host.parentElement.insertBefore(root, host);
        anchored = true;
      }
    }
  } catch (_) {}

  if (!anchored) {
    (document.body || document.documentElement).appendChild(root);
  }

  // No auto-dismiss: the draft lives in the user's page, so its context should
  // still be present when the user returns later. The dismiss button remains.

  return { ok: true, anchored: anchored };
})()`;
}

export interface PrepareReplyResult {
	prepared: boolean;
	tab_id?: number;
	tweet_url: string;
	body: string;
	method: "type_ref";
	staged_text?: string;
	submitted: false;
	/** X's own Reply button was disabled — it will not accept the draft as written. */
	submit_blocked: boolean;
	/** Whether the in-page handoff banner was injected. */
	banner_shown?: boolean;
	/** Truncated reason shown on the banner (if any). */
	reason_preview?: string;
	message: string;
}

/**
 * Normalize a tweet reference into an x.com status permalink. Accepts a full
 * x.com/twitter.com status URL, a bare numeric tweet id, or the `i/web/status`
 * form. Returns null when nothing addressable can be derived — callers must
 * treat that as an error rather than navigating somewhere arbitrary.
 */
export function normalizeXPostUrl(raw: string): string | null {
	const value = raw.trim();
	if (!value) return null;

	if (/^\d{6,}$/.test(value)) {
		return `https://x.com/i/web/status/${value}`;
	}

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	const host = parsed.hostname.replace(/^www\./, "");
	if (host !== "x.com" && host !== "twitter.com") return null;

	const statusId = parsed.pathname.match(/\/status(?:es)?\/(\d{6,})/);
	if (!statusId) return null;
	// Preserve the handle when present — x.com/i/web/status/<id> redirects, and
	// the canonical form is friendlier in the handoff banner and logs.
	const handle = parsed.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status/);
	return handle
		? `https://x.com/${handle[1]}/status/${statusId[1]}`
		: `https://x.com/i/web/status/${statusId[1]}`;
}

/**
 * URLs X bounces signed-out sessions to: /login, /i/flow/login, /i/flow/signup
 * and /account/access.
 *
 * Matched on the path with a segment boundary, not as a substring: an X handle
 * may start with "login" (e.g. @LoginRadius), and a bare `includes("/login")`
 * reads https://x.com/loginradius/status/123 as an auth wall and kills the run
 * on a perfectly signed-in page.
 */
export function isXAuthWall(url: string | undefined): boolean {
	if (!url) return false;
	let path: string;
	try {
		path = new URL(url).pathname.toLowerCase();
	} catch {
		return false;
	}
	return ["/login", "/i/flow/login", "/i/flow/signup", "/account/access"].some(
		(wall) => path === wall || path.startsWith(`${wall}/`),
	);
}

/** Labels that would *submit* a reply. prepare_reply must never click these. */
export function isReplySubmitLabel(name: string | undefined | null): boolean {
	if (!name) return false;
	const n = name.replace(/\s+/g, " ").trim();
	return /^(reply|post|post all|tweet|send)$/i.test(n);
}

interface XA11yNode {
	ref_id: number;
	role?: string;
	name?: string;
}

/**
 * Read back what actually landed in the composer, so the caller can fail loudly
 * instead of reporting a staged draft that is not there.
 *
 * `submit_enabled` is X's own verdict on the draft. We never click the button —
 * we read its `aria-disabled` because X disables it when the draft breaks a rule
 * it enforces and we deliberately do not model, above all its weighted character
 * count (URLs = 23 each, CJK/emoji = 2). With non-empty text in the box, a
 * disabled button means X will not accept this draft as written.
 */
function buildReadComposerExpression(): string {
	return `(async () => {
  const box = document.querySelector('[data-testid="tweetTextarea_0"]');
  const btn = document.querySelector('[data-testid="tweetButtonInline"]')
    || document.querySelector('[data-testid="tweetButton"]');
  return {
    staged_text: box ? box.innerText.replace(/\\n+$/, "") : null,
    submit_enabled: btn ? btn.getAttribute("aria-disabled") !== "true" : null,
  };
})()`;
}

/**
 * Stage a reply draft on an X post in the paired Chrome: navigate → focus the
 * reply composer → type the draft. Then stop.
 *
 * HARD RULE — never auto-post:
 *  - never click Reply / Post / Send
 *  - never press Enter / Cmd+Enter after typing
 *  - only focus the composer and type
 * The human must click Reply themselves.
 */
export async function prepareXReply(
	dispatcher: ChromeActionDispatcher,
	opts: {
		tweetUrl: string;
		body: string;
		/** Short explanation for the in-page banner — why this post is worth a reply. */
		reason?: string;
		/** Inject the in-page handoff banner (default true). */
		banner?: boolean;
	},
): Promise<PrepareReplyResult> {
	const body = opts.body.trim();
	if (!body) {
		throw new Error("prepare_reply: body must be non-empty");
	}
	// No length check here on purpose. X does not count UTF-16 code units: every
	// URL counts as 23 regardless of its real length, CJK and emoji count 2, and
	// the text is NFC-normalized first. A naive `body.length > 280` rejects
	// drafts X would happily accept — one link is enough to blow past 280 code
	// units while weighing 23. Rather than reimplement that spec (or vendor
	// twitter-text) we let X's own composer be the authority and report back
	// whether it will accept the draft, via `submit_blocked` below.
	const tweetUrl = normalizeXPostUrl(opts.tweetUrl);
	if (!tweetUrl) {
		throw new Error(
			`prepare_reply: invalid tweet_url / tweet_id: ${JSON.stringify(opts.tweetUrl)}`,
		);
	}

	// Single chokepoint for every dispatch this action makes: it refuses submit
	// clicks and strips the private guard token before dispatch.
	const safeDispatch: ChromeActionDispatcher = {
		dispatch: async (action_key, action_input) => {
			if (action_key === "click_ref") {
				if (action_input.allowed_click !== "reply_open") {
					throw new Error(
						"prepare_reply: blocked click_ref — only focusing the reply composer is allowed (never Reply/Post)",
					);
				}
			}
			const input = { ...action_input };
			delete input.allowed_click;
			return dispatcher.dispatch(action_key, input);
		},
	};

	const nav = await safeDispatch.dispatch<{
		tab_id?: number;
		current_url?: string;
	}>("navigate", {
		url: tweetUrl,
		require_page_activation: true,
		allowed_origins: X_ALLOWED_ORIGINS,
	});
	const tabId = nav.tab_id;
	if (typeof tabId !== "number") {
		throw new Error("prepare_reply: navigate did not return tab_id");
	}
	if (isXAuthWall(nav.current_url)) {
		throw new Error(
			`Not logged into X (landed on ${nav.current_url}). Sign in in the paired Chrome profile, then retry.`,
		);
	}

	// `wait_for_load` fires long before the SPA paints — the document reports
	// readyState "complete" with an empty body. Wait on the composer itself.
	await safeDispatch.dispatch("wait_for_selector", {
		tab_id: tabId,
		selector: '[data-testid="tweetTextarea_0"]',
		timeout_ms: 15000,
		allowed_origins: X_ALLOWED_ORIGINS,
	});

	// The a11y walker keeps only what is inside the viewport
	// (accessibility-tree.js `keepElement` → `inViewport`), and X pushes the
	// reply composer below the fold whenever the post is tall — one image is
	// enough (measured 2026-08-03 on a photo post: innerHeight 779, composer
	// top 830). Without this scroll the extraction below finds no textbox at
	// all and the run dies with "could not locate the reply composer" on a page
	// that plainly has one.
	//
	// `behavior: "instant"` rather than the default: a smooth scroll (X sets
	// scroll-behavior in places, and the default resolves to the page's CSS)
	// returns before the scroll finishes, so the a11y snapshot below could still
	// be taken with the composer off-screen — the exact failure this scroll is
	// here to prevent.
	await safeDispatch.dispatch("evaluate", {
		tab_id: tabId,
		expression:
			'document.querySelector(\'[data-testid="tweetTextarea_0"]\')?.scrollIntoView({ block: "center", behavior: "instant" })',
		allowed_origins: X_ALLOWED_ORIGINS,
	});

	// Both click_ref and type_ref reject an accessibility ref after X re-renders
	// the document. Re-extract and retry the whole focus-and-type sequence once;
	// a second stale ref still fails loudly.
	const stageDraftOnce = async () => {
		const tree = await safeDispatch.dispatch<{
			tree?: XA11yNode[];
			document_epoch?: number;
		}>("get_accessibility_tree", {
			tab_id: tabId,
			filter: "interactive",
			allowed_origins: X_ALLOWED_ORIGINS,
		});
		const nodes = Array.isArray(tree.tree) ? tree.tree : [];
		// X labels the reply box "Post text" today. Prefer that, but fall back to
		// the first textbox so a relabel degrades instead of breaking — the
		// submit-label check below is what keeps the fallback safe.
		const textboxes = nodes.filter((n) => n.role === "textbox");
		const composer =
			textboxes.find((n) => /post text/i.test(n.name ?? "")) ?? textboxes[0];
		if (!composer || typeof tree.document_epoch !== "number") {
			throw new Error(
				"prepare_reply: could not locate the reply composer in the accessibility tree",
			);
		}
		// Belt and braces: the a11y name is X's, not ours. If a relabelled node
		// ever matches the textbox lookup, refuse rather than click a submit
		// control.
		if (isReplySubmitLabel(composer.name)) {
			throw new Error(
				`prepare_reply: refusing to click "${composer.name}" — that is a submit control, not the composer`,
			);
		}
		const ref = {
			ref_id: composer.ref_id,
			document_epoch: tree.document_epoch,
		};
		await safeDispatch.dispatch("click_ref", {
			tab_id: tabId,
			ref,
			allowed_click: "reply_open",
			allowed_origins: X_ALLOWED_ORIGINS,
		});
		await safeDispatch.dispatch("type_ref", {
			tab_id: tabId,
			ref,
			text: body,
			clear_first: true,
			allowed_origins: X_ALLOWED_ORIGINS,
		});
	};
	try {
		await stageDraftOnce();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/^(?:click_ref|type_ref): stale ref \(epoch \d+\)$/.test(message)) {
			throw error;
		}
		await stageDraftOnce();
	}

	const read = await safeDispatch.dispatch<{
		value?: {
			staged_text?: string | null;
			submit_enabled?: boolean | null;
		};
	}>("evaluate", {
		tab_id: tabId,
		expression: buildReadComposerExpression(),
		await_promise: true,
		allowed_origins: X_ALLOWED_ORIGINS,
	});
	const staged = read.value?.staged_text?.trim() ?? "";
	// Compare in NFC: X normalizes the composer content, so a draft handed to us
	// in NFD comes back re-composed and would fail a raw `!==` even though it is
	// staged exactly as asked.
	if (staged.normalize("NFC") !== body.normalize("NFC")) {
		throw new Error(
			`prepare_reply: composer content does not match the draft (staged ${staged.length} chars, expected ${body.length}). Nothing was submitted.`,
		);
	}

	// Banner AFTER the match check: if the draft did not land we throw above, and
	// a banner claiming "Lobu staged this reply" would be a lie on a page that
	// has no draft on it.
	const reasonPreview = truncateHandoffReason(opts.reason);
	let bannerShown = false;
	if (opts.banner !== false) {
		try {
			const bannerOut = await safeDispatch.dispatch<{
				value?: { ok?: boolean; anchored?: boolean };
				exception?: string;
			}>("evaluate", {
				tab_id: tabId,
				expression: buildInjectHandoffBannerExpression({
					reason: reasonPreview,
				}),
				await_promise: true,
				allowed_origins: X_ALLOWED_ORIGINS,
			});
			bannerShown = bannerOut.value?.ok === true && !bannerOut.exception;
		} catch {
			// Banner is best-effort; the draft is already staged.
		}
	}

	// X's own verdict, not ours. Still `prepared: true` — the draft IS in the
	// composer and the human is about to look at it, so trimming it there beats
	// throwing away work over a limit we cannot compute correctly.
	const submitBlocked = read.value?.submit_enabled === false;

	return {
		prepared: true,
		tab_id: tabId,
		tweet_url: tweetUrl,
		body,
		method: "type_ref",
		staged_text: staged,
		banner_shown: bannerShown,
		...(reasonPreview ? { reason_preview: reasonPreview } : {}),
		submitted: false,
		submit_blocked: submitBlocked,
		message: submitBlocked
			? `Reply draft staged on ${tweetUrl}, but X has Reply disabled — most likely over its weighted character limit (URLs count 23, CJK/emoji count 2). Trim it in the tab, then click Reply yourself.`
			: `Reply draft staged on ${tweetUrl}. Review and click Reply yourself — Lobu never submits.`,
	};
}

// ── Connector ──────────────────────────────────────────────────

export default class XConnector extends ConnectorRuntime {
	readonly definition: RuntimeConnectorDefinition = {
		key: "x",
		name: "X (Twitter)",
		description:
			"Fetches tweets, browser-visible like history, bookmarks, and DMs through the X API v2 or the paired Owletto Chrome extension. Links social actors into the person graph.",
		version: "3.13.7",
		faviconDomain: "x.com",
		authSchema: {
			methods: [
				{
					type: "oauth",
					provider: "twitter",
					requiredScopes: ["tweet.read", "users.read", "offline.access"],
					optionalScopes: [
						"users.email",
						"follows.read",
						"like.read",
						"bookmark.read",
						"dm.read",
					],
					loginScopes: [
						"users.read",
						"tweet.read",
						"like.read",
						"bookmark.read",
						"dm.read",
						"offline.access",
						"users.email",
					],
					authorizationUrl: "https://x.com/i/oauth2/authorize",
					tokenUrl: "https://api.x.com/2/oauth2/token",
					userinfoUrl: "https://api.x.com/2/users/me?user.fields=username",
					tokenEndpointAuthMethod: "client_secret_basic",
					usePkce: true,
					clientIdKey: "TWITTER_CLIENT_ID",
					clientSecretKey: "TWITTER_CLIENT_SECRET",
					description:
						"Preferred auth mode. Uses the X OAuth 2.0 API for server-side syncs and login.",
					setupInstructions:
						"Create an X OAuth 2.0 app, add {{redirect_uri}} as the callback URL, then paste the client ID and client secret below.",
					loginProvisioning: {
						autoCreateConnection: true,
					},
				},
				{
					type: "none",
					label: "Paired Chrome extension",
				},
			],
		},
		feeds: {
			tweets: {
				key: "tweets",
				name: "Tweets",
				sync: (ctx) => this.syncFeed(ctx),
				description:
					"Search and sync tweets matching a query or a specific account handle.",
				configSchema: searchConfigSchema,
				eventKinds: {
					tweet: {
						description: "A tweet (original post)",
						metadataSchema: engagementMetadataSchema,
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
					reply: {
						description: "A reply to a tweet",
						metadataSchema: engagementMetadataSchema,
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
				},
			},
			my_tweets: {
				key: "my_tweets",
				name: "My Posts",
				sync: (ctx) => this.syncFeed(ctx),
				description:
					"Posts and replies authored by the connected account. Uses the X API when OAuth is available, otherwise the paired Chrome extension.",
				configSchema: accountTimelineConfigSchema,
				eventKinds: {
					tweet: {
						description: "An original post by the connected account",
						metadataSchema: engagementMetadataSchema,
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
					reply: {
						description: "A reply posted by the connected account",
						metadataSchema: engagementMetadataSchema,
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
				},
			},
			liked_tweets: {
				key: "liked_tweets",
				name: "Liked Posts",
				sync: (ctx) => this.syncFeed(ctx),
				description:
					"Posts the connected account has liked. OAuth remains available for API-backed feeds; the paired signed-in Chrome extension performs resumable cursor backfill and incremental collection.",
				configSchema: likedTweetsConfigSchema,
				eventKinds: {
					liked_tweet: {
						description: "A post liked by the connected account",
						metadataSchema: engagementMetadataSchema,
						attributions: X_LIKED_POST_ATTRIBUTIONS,
					},
				},
			},
			bookmarks: {
				key: "bookmarks",
				name: "Bookmarks",
				sync: (ctx) => this.syncFeed(ctx),
				description:
					"Posts bookmarked by the connected account. Uses the X API when OAuth is available, otherwise the paired Chrome extension.",
				configSchema: bookmarksConfigSchema,
				eventKinds: {
					bookmark: {
						description: "A post bookmarked by the connected account",
						metadataSchema: engagementMetadataSchema,
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
				},
			},
			direct_messages: {
				key: "direct_messages",
				name: "Direct Messages",
				sync: (ctx) => this.syncFeed(ctx),
				description:
					"Direct message events across all conversations. Uses the X API when dm.read is granted, otherwise the paired Chrome extension on /messages. Auto-creates person entities for 1:1 counterparts.",
				configSchema: bookmarksConfigSchema,
				eventKinds: {
					dm_message: {
						description: "A direct message in a 1:1 or group conversation",
						metadataSchema: dmMetadataSchema,
						attributions: X_DM_COUNTERPARTY_ATTRIBUTIONS,
					},
				},
			},
			home_feed: {
				key: "home_feed",
				name: "Home Timeline",
				sync: (ctx) => this.syncFeed(ctx),
				description:
					"Your personalized x.com home timeline (For you + Following). Extension-only via content-script scrape — there is no public API for the home timeline.",
				configSchema: homeFeedConfigSchema,
				eventKinds: {
					tweet: {
						description: "A tweet from your personalized home timeline",
						metadataSchema: engagementMetadataSchema,
						attributions: X_TWEET_AUTHOR_ATTRIBUTIONS,
					},
				},
			},
		},
		actions: {
			prepare_reply: {
				key: "prepare_reply",
				kind: "write",
				name: "Prepare reply",
				description:
					"Stage a reply draft after the user opens the exact X post (fill the reply composer). NEVER opens a tab or submits — the human must click Reply. No auto-post path exists.",
				annotations: {
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true,
				},
				inputSchema: {
					type: "object",
					required: ["body"],
					anyOf: [{ required: ["tweet_url"] }, { required: ["tweet_id"] }],
					properties: {
						body: {
							type: "string",
							minLength: 1,
							description:
								"Draft reply text, left in the composer for the user to edit/send. Deliberately uncapped: X counts URLs as 23 and CJK/emoji as 2, so a code-unit cap here would reject drafts X accepts. The action reports X's own verdict as submit_blocked.",
						},
						tweet_url: {
							type: "string",
							description:
								'Post URL, e.g. "https://x.com/someone/status/2083959735481716957". twitter.com URLs are accepted.',
						},
						tweet_id: {
							type: "string",
							description:
								"Numeric post id when tweet_url is omitted (this is the `origin_id` on X timeline events).",
						},
						reason: {
							type: "string",
							description:
								"Why this post is worth replying to. Shown on an in-page banner above the composer so the draft arrives with its context instead of as a bare box of text (truncated to 120 chars).",
						},
						banner: {
							type: "boolean",
							description:
								"Inject the in-page Lobu handoff banner carrying `reason` (default true).",
						},
					},
				},
				outputSchema: {
					type: "object",
					properties: {
						body: { type: "string" },
						method: { type: "string" },
						tab_id: { type: "integer" },
						message: { type: "string" },
						prepared: { type: "boolean" },
						submitted: { type: "boolean" },
						tweet_url: { type: "string" },
						staged_text: { type: "string" },
						submit_blocked: { type: "boolean" },
						banner_shown: { type: "boolean" },
						reason_preview: { type: "string" },
					},
				},
				// NOT gated on Lobu approval, deliberately. The irreversible step is
				// publishing, and X's own Reply button already guards it — a human
				// must click it, and this action structurally cannot (safeDispatch
				// rejects every click_ref except focusing the composer). A Lobu gate
				// here would only guard "fills an already-open X page", while forcing
				// the user to approve a draft BEFORE they can see it in context. The
				// user-opened page is the approval. `linkedin.prepare_comment` is ungated for
				// the same reason.
				requiresApproval: false,
			},
		},
	};

	async execute(ctx: ActionContext): Promise<ActionResult> {
		try {
			if (ctx.actionKey !== "prepare_reply") {
				return { success: false, error: `Unknown action: ${ctx.actionKey}` };
			}
			const body =
				typeof ctx.input.body === "string" ? ctx.input.body.trim() : "";
			if (!body) {
				return { success: false, error: "body is required" };
			}
			const tweetRef =
				(typeof ctx.input.tweet_url === "string" &&
					ctx.input.tweet_url.trim()) ||
				(typeof ctx.input.tweet_id === "string" && ctx.input.tweet_id.trim()) ||
				"";
			if (!tweetRef) {
				return { success: false, error: "tweet_url or tweet_id is required" };
			}
			const output = await prepareXReply(requireExtensionDispatcher(ctx), {
				tweetUrl: tweetRef,
				body,
				banner: ctx.input.banner !== false,
				...(typeof ctx.input.reason === "string"
					? { reason: ctx.input.reason }
					: {}),
			});
			return { success: true, output: { ...output } };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async syncFeed(ctx: SyncContext): Promise<SyncResult> {
		const config = ctx.config as Record<string, unknown>;
		const checkpoint = (ctx.checkpoint ?? {}) as XCheckpoint;
		const feedKey = ctx.feedKey ?? "tweets";
		const oauthScopes = X_OAUTH_FEED_SCOPES[feedKey];

		// The home timeline has no public API — it is always served by the
		// extension, regardless of whether an OAuth token is present.
		if (feedKey === "home_feed") {
			return syncHomeFeedViaDomScrape(ctx, config, checkpoint);
		}

		if (feedKey === "my_tweets") {
			if (
				resolveSyncBackend(ctx, config, oauthScopes) === "oauth_api"
			) {
				return syncOAuthWithOptionalFallback(
					config,
					() => syncMyTweetsViaOAuthApi(ctx, config, checkpoint),
					() => syncMyTweetsViaExtension(ctx, config, checkpoint),
				);
			}
			return syncMyTweetsViaExtension(ctx, config, checkpoint);
		}

		if (feedKey === "liked_tweets") {
			if (
				resolveSyncBackend(ctx, config, oauthScopes) === "oauth_api"
			) {
				return syncOAuthWithOptionalFallback(
					config,
					() => syncLikedTweetsViaOAuthApi(ctx, config, checkpoint),
					() => syncLikedTweetsViaExtension(ctx, config, checkpoint),
				);
			}
			return syncLikedTweetsViaExtension(ctx, config, checkpoint);
		}

		if (feedKey === "bookmarks") {
			if (
				resolveSyncBackend(ctx, config, oauthScopes) === "oauth_api"
			) {
				return syncOAuthWithOptionalFallback(
					config,
					() => syncBookmarksViaOAuthApi(ctx, config, checkpoint),
					() => syncBookmarksViaExtension(ctx, config, checkpoint),
				);
			}
			return syncBookmarksViaExtension(ctx, config, checkpoint);
		}

		if (feedKey === "direct_messages") {
			if (
				resolveSyncBackend(ctx, config, oauthScopes) === "oauth_api"
			) {
				return syncOAuthWithOptionalFallback(
					config,
					() => syncDirectMessagesViaOAuthApi(ctx, config, checkpoint),
					() => syncDirectMessagesViaExtension(ctx, config, checkpoint),
				);
			}
			return syncDirectMessagesViaExtension(ctx, config, checkpoint);
		}

		// `tweets` feed: prefer the official API when scopes are sufficient,
		// otherwise the extension's signed-in search.
		if (
			resolveSyncBackend(ctx, config, oauthScopes) === "oauth_api"
		) {
			return syncOAuthWithOptionalFallback(
				config,
				() => syncViaOAuthApi(ctx, config, checkpoint),
				() => syncSearchViaExtension(ctx, config, checkpoint),
			);
		}

		return syncSearchViaExtension(ctx, config, checkpoint);
	}
}
