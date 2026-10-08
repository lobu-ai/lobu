import {
	ConnectorRuntime,
	requireBrowser,
	type ActionContext,
	type ActionResult,
	type ChromeActionDispatcher,
	type FeedReadContext,
	type FeedReadResult,
	type RuntimeConnectorDefinition,
} from "@lobu/connector-sdk";
import { tiktokPage } from "./tiktok-web-page.js";

const ORIGIN = "https://www.tiktok.com";
const ORIGINS = [ORIGIN];
const HANDLE = /^[A-Za-z0-9_.]{1,64}$/;
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};

export function normalizeTikTokPostUrl(value: unknown): string {
	if (typeof value !== "string") throw new Error("post_url is required");
	const url = new URL(value);
	if (url.origin !== ORIGIN || url.username || url.password || !/^\/@[A-Za-z0-9_.]{1,64}\/(video|photo)\/[0-9]+$/.test(url.pathname)) {
		throw new Error("Expected a canonical https://www.tiktok.com/@creator/video/id or /photo/id URL");
	}
	return `${ORIGIN}${url.pathname}`;
}

export function normalizeTikTokPost(value: unknown): RecordValue {
	const item = object(value);
	const author = object(item.author);
	if (typeof item.id !== "string" || !/^[0-9]+$/.test(item.id) || typeof author.uniqueId !== "string" || !HANDLE.test(author.uniqueId)) {
		throw new Error("TikTok returned a post without a valid source identity");
	}
	const video = object(item.video);
	const images = object(item.imagePost).images;
	const photo = Array.isArray(images) && images.length > 0;
	const stats = object(item.stats);
	const created = Number(item.createTime);
	return {
		origin_id: item.id,
		source_url: `${ORIGIN}/@${author.uniqueId}/${photo ? "photo" : "video"}/${item.id}`,
		text: typeof item.desc === "string" ? item.desc : "",
		author: { id: author.id, handle: author.uniqueId, name: author.nickname },
		...(Number.isFinite(created) && created > 0 && created < 8640000000000 ? { created_at: new Date(created * 1000).toISOString() } : {}),
		...(typeof item.digged === "boolean" ? { liked: item.digged } : {}),
		media: photo ? { type: "photos", count: images.length } : { type: "video", duration_seconds: video.duration, width: video.width, height: video.height },
		counts: { likes: stats.diggCount, comments: stats.commentCount, views: stats.playCount, shares: stats.shareCount },
	};
}

function expression(command: string, args: RecordValue = {}): string {
	return `(${tiktokPage.toString()})(${JSON.stringify(command)},${JSON.stringify(args)})`;
}

async function page(browser: ChromeActionDispatcher, tabId: number, command: string, args: RecordValue = {}): Promise<RecordValue> {
	const output = await browser.dispatch("evaluate", { tab_id: tabId, expression: expression(command, args), allowed_origins: ORIGINS });
	if (!output.value || typeof output.value !== "object") throw new Error("TikTok page returned no data");
	return object(output.value);
}

async function scratch<T>(browser: ChromeActionDispatcher, run: (tabId: number) => Promise<T>): Promise<T> {
	const nav = await browser.dispatch("navigate", { url: "about:blank", new_tab: true, allowed_origins: ORIGINS });
	if (typeof nav.tab_id !== "number") throw new Error("TikTok scratch tab was not created");
	try { return await run(nav.tab_id); }
	finally { await browser.dispatch("close_tab", { tab_id: nav.tab_id, allowed_origins: ORIGINS }); }
}

async function navigate(browser: ChromeActionDispatcher, tabId: number, url: string, focus = false): Promise<void> {
	await browser.dispatch("navigate", { tab_id: tabId, url, allowed_origins: ORIGINS });
	// TikTok's video page can remain blank in a fresh background tab. Its own
	// controls appeared immediately after focus in the live browser probe.
	if (focus) await browser.dispatch("focus_tab", { tab_id: tabId, draw_attention: false, allowed_origins: ORIGINS });
	await browser.dispatch("wait_for_selector", { tab_id: tabId, selector: '[data-e2e="nav-profile"]', timeout_ms: 15000, allowed_origins: ORIGINS });
}

async function sourcePost(browser: ChromeActionDispatcher, tabId: number, url: string): Promise<RecordValue> {
	if (!url.includes("/photo/")) {
		await navigate(browser, tabId, url, true);
		return page(browser, tabId, "detail", { url });
	}
	const start = await browser.dispatch("network_intercept_start", { tab_id: tabId, patterns: [`${ORIGIN}/api/item/detail/**`], max_body_bytes: 2097152, max_buffer_responses: 5, allowed_origins: ORIGINS });
	if (typeof start.session_id !== "string") throw new Error("TikTok photo capture did not start");
	try {
		await navigate(browser, tabId, url);
		await browser.dispatch("wait_for_selector", { tab_id: tabId, selector: '[data-e2e="recommend-list-item-container"] .swiper', timeout_ms: 15000, allowed_origins: ORIGINS });
		const data = await browser.dispatch("network_intercept_drain", { session_id: start.session_id, allowed_origins: ORIGINS });
		for (const response of Array.isArray(data.responses) ? data.responses : []) {
			const r = object(response);
			if (r.status !== 200 || r.truncated || r.base64_encoded || typeof r.body !== "string") continue;
			const json = object(JSON.parse(r.body));
			const item = object(object(json.itemInfo).itemStruct);
			if (json.statusCode === 0 && item.id === url.split("/").pop()) return page(browser, tabId, "detail", { url, source_item: item });
		}
		throw new Error("TikTok did not expose the requested photo post's source record");
	} finally {
		await browser.dispatch("network_intercept_stop", { session_id: start.session_id, allowed_origins: ORIGINS });
	}
}

export async function readTikTokSnapshot(ctx: FeedReadContext): Promise<FeedReadResult> {
	if (ctx.cursor || ctx.offset || ctx.sort || ctx.window || ctx.match) throw new Error("TikTok snapshot feeds do not support pagination, sorting, time windows, or exact-match filters");
	if (ctx.query && ctx.feedKey !== "search") throw new Error("Use the TikTok search feed for queries");
	if (ctx.limit !== undefined && (!Number.isInteger(ctx.limit) || ctx.limit < 1)) throw new Error("limit must be a positive integer");
	const limit = Math.min(ctx.limit ?? 10, 30);
	let url = ORIGIN;
	if (ctx.feedKey === "following") url += "/following";
	else if (ctx.feedKey === "search") {
		const query = ctx.query?.trim() || (typeof ctx.config.query === "string" ? ctx.config.query.trim() : "");
		if (!query || query.length > 200) throw new Error("Search requires a query of 1 to 200 characters");
		url += `/search?q=${encodeURIComponent(query)}`;
	} else if (ctx.feedKey !== "for_you") throw new Error(`Unsupported TikTok feed: ${ctx.feedKey}`);
	const browser = requireBrowser(ctx);
	return scratch(browser, async tabId => {
		let sessionId: string | undefined;
		try {
			if (ctx.feedKey === "following") {
				const start = await browser.dispatch("network_intercept_start", { tab_id: tabId, patterns: [`${ORIGIN}/api/following/item_list/**`], max_body_bytes: 2097152, max_buffer_responses: 10, allowed_origins: ORIGINS });
				if (typeof start.session_id !== "string") throw new Error("TikTok feed capture did not start");
				sessionId = start.session_id;
			}
			await navigate(browser, tabId, url);
			let rows: RecordValue[] = [];
			if (ctx.feedKey === "following") {
				await browser.dispatch("wait_for_selector", { tab_id: tabId, selector: '[data-e2e="recommend-list-item-container"]', timeout_ms: 15000, allowed_origins: ORIGINS });
				const data = await browser.dispatch("network_intercept_drain", { session_id: sessionId, allowed_origins: ORIGINS });
				for (const response of Array.isArray(data.responses) ? data.responses : []) {
					const r = object(response);
					if (r.status !== 200 || r.truncated || r.base64_encoded || typeof r.body !== "string") throw new Error("TikTok Following response is unavailable or truncated");
					const json = object(JSON.parse(r.body));
					if (json.status_code !== 0 || !Array.isArray(json.itemList)) throw new Error("TikTok did not return a successful Following feed");
					rows.push(...json.itemList.map(normalizeTikTokPost));
				}
			} else if (ctx.feedKey === "search") {
				await browser.dispatch("wait_for_selector", { tab_id: tabId, selector: 'a[href*="/video/"],a[href*="/photo/"]', timeout_ms: 15000, allowed_origins: ORIGINS });
				const data = await page(browser, tabId, "post_links");
				rows = (Array.isArray(data.rows) ? data.rows : []).map(value => {
					const r = object(value);
					const sourceUrl = normalizeTikTokPostUrl(r.url);
					return { origin_id: sourceUrl.split("/").pop(), source_url: sourceUrl, text: r.text, media: { type: sourceUrl.includes("/photo/") ? "photos" : "video" } };
				});
			} else {
				const data = await page(browser, tabId, "snapshot");
				rows = (Array.isArray(data.items) ? data.items : []).map(normalizeTikTokPost);
			}
			if (!rows.length) throw new Error("TikTok returned no verifiable posts; this is not proof of an empty feed");
			const unique = [...new Map(rows.map(row => [row.origin_id, row])).values()];
			// End of this bounded snapshot, never a claim of complete source history.
			// Returning true would make the generic pager invent an unusable offset.
			return { rows: unique.slice(0, limit), hasMore: false };
		} finally {
			if (sessionId) await browser.dispatch("network_intercept_stop", { session_id: sessionId, allowed_origins: ORIGINS });
		}
	});
}

export default class TikTokConnector extends ConnectorRuntime {
	readonly definition: RuntimeConnectorDefinition = {
		key: "tiktok.web", name: "TikTok", version: "1.0.2", faviconDomain: "tiktok.com",
		description: "Read TikTok through your signed-in paired browser, inspect post visuals, set likes, and prepare comments for human submission. Automations decide what to read and act on.",
		browser: { origins: ORIGINS, authMethods: ["browser"], accountProbe: { url: ORIGIN, expression: expression("identity") } },
		authSchema: { methods: [{ type: "browser", mode: "live" }] },
		feeds: {
			for_you: { key: "for_you", name: "For You", description: "Initial personalized timeline snapshot. No history coverage or continuation; repeat reads can overlap.", read: readTikTokSnapshot },
			following: { key: "following", name: "Following", description: "Initial browser Following snapshot. No history coverage or continuation; repeat reads can overlap.", read: readTikTokSnapshot },
			search: { key: "search", name: "Search", description: "Browser search results for videos and photo posts. Use query when reading. Initial snapshot without continuation.", read: readTikTokSnapshot, configSchema: { type: "object", properties: { query: { type: "string", maxLength: 200 } }, additionalProperties: false } },
		},
		actions: {
			set_like: { key: "set_like", name: "Set like", kind: "write", description: "Set a post's liked state and verify it after reload. Already-matching posts are left unchanged. May focus a scratch tab to load the post. Selection and budgets belong in Automations.", annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true }, inputSchema: { type: "object", required: ["post_url", "liked"], additionalProperties: false, properties: { post_url: { type: "string", format: "uri" }, liked: { type: "boolean" } } } },
			inspect_post: { key: "inspect_post", name: "Inspect post visuals", kind: "read", description: "Return post metadata and real screenshots at requested video times or photo indices. Images are visual samples, not full video or audio understanding. May focus a scratch tab to load media.", annotations: { readOnlyHint: true, openWorldHint: true }, inputSchema: { type: "object", required: ["post_url"], additionalProperties: false, properties: { post_url: { type: "string", format: "uri" }, frame_times: { type: "array", minItems: 1, maxItems: 6, items: { type: "number", minimum: 0 }, default: [0] }, photo_indices: { type: "array", minItems: 1, maxItems: 10, items: { type: "integer", minimum: 0 }, description: "Zero-based photos to capture; defaults to the first photo." } } } },
			prepare_comment: { key: "prepare_comment", name: "Prepare comment", kind: "write", description: "Prepare a video comment for human submission. Call operations.execute with activation: { kind: 'page_visit', urls: [post_url] }. After the user opens that exact post, fills its empty composer. The user must click Post. Fails without page activation; never submits or overwrites a draft. Photo comments are not supported.", annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }, inputSchema: { type: "object", required: ["post_url", "body"], additionalProperties: false, properties: { post_url: { type: "string", format: "uri" }, body: { type: "string", minLength: 1 } } } },
		},
	};

	async execute(ctx: ActionContext): Promise<ActionResult> {
		try {
			const url = normalizeTikTokPostUrl(ctx.input.post_url);
			const browser = requireBrowser(ctx);
			if (ctx.actionKey === "prepare_comment") {
				if (url.includes("/photo/")) throw new Error("Photo comment drafts are not supported yet");
				const body = ctx.input.body;
				if (typeof body !== "string" || !body.trim()) throw new Error("Comment body is required");
				const nav = await browser.dispatch("navigate", { url, require_page_activation: true, allowed_origins: ORIGINS });
				if (typeof nav.tab_id !== "number") throw new Error("User-owned post tab is not active");
				await page(browser, nav.tab_id, "open_comment", { url });
				const tree = await browser.dispatch("get_accessibility_tree", { tab_id: nav.tab_id, filter: "interactive", allowed_origins: ORIGINS });
				const editors = (Array.isArray(tree.tree) ? tree.tree : []).map(object).filter(node => node.role === "textbox");
				if (editors.length !== 1 || typeof tree.document_epoch !== "number" || typeof editors[0]?.ref_id !== "number") throw new Error("TikTok comment textbox is ambiguous");
				await browser.dispatch("type_ref", { tab_id: nav.tab_id, ref: { document_epoch: tree.document_epoch, ref_id: editors[0].ref_id }, text: body, clear_first: false, allowed_origins: ORIGINS });
				const staged = await page(browser, nav.tab_id, "comment_text", { url });
				if (staged.text !== body) throw new Error("TikTok comment draft did not match the requested text; review it in the browser");
				return { success: true, output: { prepared: true, submitted: false, post_url: url, tab_id: nav.tab_id, body } };
			}
			if (ctx.actionKey !== "set_like" && ctx.actionKey !== "inspect_post") throw new Error("Unsupported TikTok action");
			if (ctx.actionKey === "set_like" && typeof ctx.input.liked !== "boolean") throw new Error("liked must be a boolean");
			if (ctx.actionKey === "inspect_post" && (url.includes("/photo/") ? ctx.input.frame_times !== undefined : ctx.input.photo_indices !== undefined)) throw new Error("Use photo_indices for photos and frame_times for videos");
			const times = ctx.input.frame_times ?? [0];
			const photoIndices = ctx.input.photo_indices ?? [0];
			if (ctx.actionKey === "inspect_post" && (!Array.isArray(times) || !times.length || times.length > 6 || times.some(t => typeof t !== "number" || !Number.isFinite(t) || t < 0))) throw new Error("frame_times must contain 1 to 6 nonnegative seconds");
			if (ctx.actionKey === "inspect_post" && (!Array.isArray(photoIndices) || !photoIndices.length || photoIndices.length > 10 || photoIndices.some(t => typeof t !== "number" || !Number.isInteger(t) || t < 0))) throw new Error("photo_indices must contain 1 to 10 nonnegative integers");
			const output = await scratch(browser, async tabId => {
				const detail = await sourcePost(browser, tabId, url);
				const args = { url, source_item: detail.item };
				const post = { ...normalizeTikTokPost(detail.item), liked: detail.liked };
				if (ctx.actionKey === "set_like") {
					const effect = await page(browser, tabId, "set_like", { ...args, liked: ctx.input.liked });
					if (effect.liked !== ctx.input.liked) throw new Error("TikTok like state was not confirmed");
					if (effect.changed === true) {
						const persisted = await sourcePost(browser, tabId, url);
						if (persisted.liked !== ctx.input.liked) throw new Error("TikTok like state did not persist after reload");
					}
					return { post_url: url, ...effect };
				}
				await page(browser, tabId, "mute", args);
				await browser.dispatch("focus_tab", { tab_id: tabId, draw_attention: false, allowed_origins: ORIGINS });
				const attachments: unknown[] = [];
				const frames: RecordValue[] = [];
				const photos = url.includes("/photo/");
				for (const position of (photos ? photoIndices : times) as number[]) {
					const frame = await page(browser, tabId, photos ? "photo" : "frame", { ...args, ...(photos ? { index: position } : { seconds: position }) });
					const shot = await browser.dispatch("screenshot", { tab_id: tabId, allowed_origins: ORIGINS });
					if (!Array.isArray(shot.attachments) || !shot.attachments.length) throw new Error("TikTok screenshot returned no image attachments");
					frames.push({ ...frame, attachment_index: attachments.length });
					attachments.push(...shot.attachments);
				}
				return { post, frames, attachments, audio_inspected: false };
			});
			return { success: true, output };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
}
