import { describe, expect, mock, test } from "bun:test";
import type { ChromeActionDispatcher, FeedReadContext } from "@lobu/connector-sdk";
import { connectorSdkMock } from "./connector-sdk.mock";
import { tiktokPage } from "../tiktok-web-page.js";

mock.module("@lobu/connector-sdk", connectorSdkMock);
const {
	default: TikTokConnector,
	normalizeTikTokPost,
	normalizeTikTokPostUrl,
} = await import("../tiktok_web");

const post = {
	id: "7000000000000000001",
	desc: "An example video",
	createTime: 1700000000,
	author: { id: "7000000000000000002", uniqueId: "example_creator", nickname: "Example" },
	video: { duration: 20, width: 1080, height: 1920 },
	stats: { diggCount: 12, commentCount: 3 },
	digged: false,
};

function browser(handler: (action: string, input: Record<string, unknown>) => unknown) {
	const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
	const dispatcher: ChromeActionDispatcher = {
		dispatch: async (action, input) => {
			calls.push({ action, input });
			return await handler(action, input) as never;
		},
	};
	return { dispatcher, calls };
}

function context(dispatcher: ChromeActionDispatcher, overrides: Partial<FeedReadContext> = {}): FeedReadContext {
	return { browser: dispatcher, credentials: null, config: {}, feedKey: "for_you", ...overrides };
}

function followingPageBrowser(fetcher: (url: URL, signal: AbortSignal) => Response | Promise<Response>, timeoutMs?: number) {
	const state = { challenge: false, signedOut: false };
	const location = new URL("https://www.tiktok.com/following");
	const media = { muted: false };
	const requests: URL[] = [];
	const document = {
		querySelector: (selector: string) => selector === "#captcha-verify-container-main-page"
			? { getClientRects: () => state.challenge ? [1] : [] }
			: { textContent: JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": { user: state.signedOut ? null : { uid: post.id } } } }) },
		querySelectorAll: () => [media],
	};
	return { state, location, media, requests, run: (expression: string) => new Function("document", "location", "fetch", "setTimeout", "clearTimeout", `return ${expression}`)(
		document, location,
		(url: string, options: { credentials: string; signal: AbortSignal }) => {
			expect(options.credentials).toBe("include");
			requests.push(new URL(url));
			return fetcher(new URL(url), options.signal);
		},
		(callback: () => void, ms: number) => setTimeout(callback, timeoutMs ?? ms), clearTimeout,
	) };
}

describe("TikTok source records", () => {
	test("uses stable source identity and projects only post data", () => {
		const row = normalizeTikTokPost({ ...post, csrfToken: "never-return", unrelated: "private" });
		expect(row).toMatchObject({
			origin_id: post.id,
			source_url: "https://www.tiktok.com/@example_creator/video/7000000000000000001",
			text: post.desc,
			liked: false,
			media: { type: "video", duration_seconds: 20 },
		});
		expect(JSON.stringify(row)).not.toContain("never-return");
		expect(JSON.stringify(row)).not.toContain("private");
	});

	test("does not invent identities or canonical links for malformed records", () => {
		expect(() => normalizeTikTokPost({ ...post, id: undefined })).toThrow();
		expect(() => normalizeTikTokPost({ ...post, author: { uniqueId: "../../login" } })).toThrow();
	});

	test("validates action targets before browser dispatch", () => {
		expect(normalizeTikTokPostUrl("https://www.tiktok.com/@example_creator/video/7000000000000000001?share=1"))
			.toBe("https://www.tiktok.com/@example_creator/video/7000000000000000001");
		for (const url of ["https://evil.example/@x/video/1", "http://www.tiktok.com/@x/video/1", "https://www.tiktok.com/login", "https://user:pass@www.tiktok.com/@x/video/1"]) {
			expect(() => normalizeTikTokPostUrl(url)).toThrow();
		}
	});
});

describe("serialized TikTok page adapter", () => {
	function searchFixture(visibleAfter: number, challengeAfter = Infinity) {
		let polls = 0;
		const hidden = { href: "https://www.tiktok.com/@hidden/video/7000000000000000009", getClientRects: () => [], querySelector: () => null, innerText: "hidden" };
		const result = { href: "https://www.tiktok.com/@example_creator/video/7000000000000000001", getClientRects: () => polls >= visibleAfter ? [1] : [], querySelector: () => ({ alt: "Visible search caption" }) };
		const document = {
			querySelector: (selector: string) => selector === "#captcha-verify-container-main-page"
				? { getClientRects: () => polls >= challengeAfter ? [1] : [] }
				: { textContent: JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": { user: { uid: "7000000000000000003", uniqueId: "example_account" } } } }) },
			querySelectorAll: () => [hidden, result],
		};
		const run = new Function("document", "setTimeout", `return (${tiktokPage.toString()})("post_links")`);
		return { run: () => run(document, (callback: () => void) => { polls++; callback(); }), polls: () => polls };
	}

	test("waits for visible search results after hidden preload links appear", async () => {
		const f = searchFixture(3);
		expect(await f.run()).toEqual({ rows: [{ url: "https://www.tiktok.com/@example_creator/video/7000000000000000001", text: "Visible search caption" }] });
		expect(f.polls()).toBe(3);
	});

	test("bounds the search wait and rejects hidden-only results", async () => {
		const f = searchFixture(Infinity);
		await expect(f.run()).rejects.toThrow("TikTok page did not expose the requested content");
		expect(f.polls()).toBe(40);
	});

	test("stops when verification appears while search results load", async () => {
		const f = searchFixture(4, 2);
		await expect(f.run()).rejects.toThrow("TikTok verification required");
		expect(f.polls()).toBe(2);
	});

	test("guards timeline capture against challenge, sign-out, account switch, and navigation", async () => {
		for (const [feed, path] of [["following", "/following"], ["for_you", "/"]]) {
			for (const interrupt of ["none", "challenge", "sign-out", "account-switch", "navigation"]) {
				let polls = 0;
				const media = { muted: false };
				const location = new URL(`https://www.tiktok.com${path}`);
				const document = {
					querySelector: (selector: string) => selector === "#captcha-verify-container-main-page"
						? { getClientRects: () => polls > 0 && interrupt === "challenge" ? [1] : [] }
						: { textContent: JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": { user: polls > 0 && interrupt === "sign-out" ? null : { uid: polls > 0 && interrupt === "account-switch" ? "7000000000000000099" : post.id } } } }) },
					querySelectorAll: () => [media],
				};
				const run = new Function("document", "location", "setTimeout", `return (${tiktokPage.toString()})(${JSON.stringify(`${feed}_wait`)})`);
				const result = run(document, location, (callback: () => void) => {
					polls++;
					if (interrupt === "navigation") location.pathname = "/login";
					callback();
				});
				if (interrupt === "none") await expect(result).resolves.toEqual({ ready: true });
				else await expect(result).rejects.toThrow(interrupt === "challenge" ? "verification required" : interrupt === "sign-out" ? "sign-in" : interrupt === "account-switch" ? "account changed" : "page changed");
				expect(polls).toBe(1);
				expect(media.muted).toBe(true);
			}
		}
	});

	function fixture(cardIds = [post.id], verificationRequired = false) {
		const clickedPosts: string[] = [];
		const playedPosts: string[] = [];
		const editor = { getClientRects: () => [1], textContent: "My existing draft" };
		const cards = cardIds.map(id => {
			let pressed = "false";
			const like = { getAttribute: () => pressed, click: () => { pressed = pressed === "true" ? "false" : "true"; clickedPosts.push(id); } };
			const video = { muted: false, readyState: 2, duration: 20, currentTime: 0, seeking: false, play: async () => { playedPosts.push(id); }, pause: () => {}, scrollIntoView: () => {} };
			return { getClientRects: () => [1], querySelectorAll: () => [], querySelector: (selector: string) => {
			if (selector === '[data-e2e="more-menu-icon"]') return { getAttribute: (name: string) => name === "data-more-menu-item-id" ? id : null };
			if (selector.startsWith('a[href=')) return {};
			if (selector === '[data-e2e="video-desc"]') return { textContent: post.desc };
			if (selector === '[data-e2e="like-icon"]') return like;
			if (selector === "video") return video;
			return null;
			} };
		});
		const document = {
			querySelector: (selector: string) => selector === "#captcha-verify-container-main-page" ? (verificationRequired ? { getClientRects: () => [1] } : null) : selector === "#__UNIVERSAL_DATA_FOR_REHYDRATION__" ? { textContent: JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": { user: { uid: "7000000000000000003", uniqueId: "example_account" } }, "webapp.video-detail": { itemInfo: { itemStruct: post } } } }) } : cards[0],
			querySelectorAll: (selector: string) => selector === '[data-e2e="recommend-list-item-container"]' ? cards : [editor],
		};
		const url = "https://www.tiktok.com/@example_creator/video/7000000000000000001";
		const location = new URL(url);
		const run = new Function("document", "location", "command", "args", "setTimeout", `return (${tiktokPage.toString()})(command,args)`);
		return { run: (command: string, args: Record<string, unknown> = {}) => run(document, location, command, { url, ...args }, (callback: () => void) => callback()), location, clicks: () => clickedPosts.length, clickedPosts, playedPosts };
	}

	test("runs without module bindings, clicks once, and leaves a matching state alone", async () => {
		const f = fixture();
		expect(await f.run("identity")).toEqual({ accountId: "7000000000000000003", displayName: "example_account" });
		expect(await f.run("set_like", { liked: true })).toEqual({ liked: true, changed: true });
		expect(await f.run("set_like", { liked: true })).toEqual({ liked: true, changed: false });
		expect(f.clicks()).toBe(1);
	});

	test("refuses a changed source identity before touching Like", async () => {
		const f = fixture();
		await expect(f.run("set_like", { liked: true, source_item: { ...post, id: "7000000000000000099" } })).rejects.toThrow("different post");
		expect(f.clicks()).toBe(0);
	});

	test("refuses navigation while waiting for the target card before touching controls or media", async () => {
		for (const command of ["detail", "mute", "photo", "set_like", "frame", "open_comment", "comment_text"]) {
			const f = fixture();
			const pending = f.run(command, { source_item: post, liked: true, seconds: 5 });
			f.location.pathname = "/@example_creator/video/7000000000000000099";
			await expect(pending).rejects.toThrow("different post");
			expect(f.clickedPosts).toEqual([]);
			expect(f.playedPosts).toEqual([]);
		}
	});

	test("refuses navigation during control, playback, or composer waits", async () => {
		for (const command of ["set_like", "frame", "open_comment"]) {
			const f = fixture();
			const pending = f.run(command, { source_item: post, liked: true, seconds: 5 });
			await Promise.resolve();
			f.location.pathname = "/@example_creator/video/7000000000000000099";
			await expect(pending).rejects.toThrow("different post");
		}
	});

	test("binds controls and video frames to the DOM post ID without relying on a permalink", async () => {
		const f = fixture(["7000000000000000009", post.id]);
		await f.run("set_like", { liked: true });
		await f.run("frame", { seconds: 5 });
		expect(f.clickedPosts).toEqual([post.id]);
		expect(f.playedPosts).toEqual([post.id]);
	});

	test("reports verification before reading source data or touching controls and media", async () => {
		const f = fixture([post.id], true);
		for (const command of ["identity", "post_links", "following_status", "following_wait", "for_you_status", "for_you_wait", "detail", "set_like", "frame"]) {
			await expect(f.run(command, { liked: true, seconds: 5 })).rejects.toThrow("TikTok verification required");
		}
		expect(f.clickedPosts).toEqual([]);
		expect(f.playedPosts).toEqual([]);
	});

	test("refuses absent or ambiguous post identity before touching controls or media", async () => {
		for (const cardIds of [["7000000000000000009"], [post.id, post.id]]) {
			const f = fixture(cardIds);
			await expect(f.run("set_like", { liked: true })).rejects.toThrow();
			await expect(f.run("frame", { seconds: 5 })).rejects.toThrow();
			expect(f.clickedPosts).toEqual([]);
			expect(f.playedPosts).toEqual([]);
		}
	});

	test("preserves text already in the user's comment composer", async () => {
		await expect(fixture().run("open_comment")).rejects.toThrow("preserving the user's draft");
	});
});

function recommendationBrowser(items: unknown[] = [post], responseOverrides: Record<string, unknown> = {}, lateFailure = false) {
	let observations = 0;
	return browser(action => {
		if (action === "navigate") return { tab_id: 7 };
		if (action === "network_intercept_start") return { session_id: "synthetic-session" };
		if (action === "evaluate") {
			if (++observations === 2 && lateFailure) throw new Error("TikTok verification required");
			return { value: { ready: true } };
		}
		if (action === "network_intercept_drain") return { responses: [{ url: "https://www.tiktok.com/api/recommend/item_list/", status: 200, body: JSON.stringify({ status_code: 0, statusCode: 0, hasMore: true, itemList: items }), ...responseOverrides }] };
		return {};
	});
}

describe("TikTok source reads", () => {
	test("excludes non-post ad units but keeps canonical posts including promoted posts", async () => {
		const adUnit = { ...post, isAd: true, author: { ...post.author, uniqueId: "Synthetic Ad Brand" } };
		const promotedPost = { ...post, id: "7000000000000000009", isAd: true };
		const { dispatcher } = recommendationBrowser([adUnit, post, promotedPost]);
		const result = await new TikTokConnector().read(context(dispatcher));
		expect(result.rows.map(row => row.origin_id)).toEqual([post.id, promotedPost.id]);
		expect(result.rows.every(row => String(row.source_url).startsWith("https://www.tiktok.com/@example_creator/video/"))).toBe(true);
	});

	test("requires an explicit ad marker to exclude a non-post identity and never claims an ad-only feed is empty", async () => {
		for (const isAd of [false, undefined, "true", true]) {
			const { dispatcher, calls } = recommendationBrowser([{ ...post, isAd, author: { uniqueId: "Synthetic Ad Brand" } }]);
			await expect(new TikTokConnector().read(context(dispatcher))).rejects.toThrow(isAd === true ? "no verifiable posts" : "valid source identity");
			expect(calls.slice(-2).map(call => call.action)).toEqual(["network_intercept_stop", "close_tab"]);
		}
	});

	test("waits for the native For You recommendation response", async () => {
		let drains = 0;
		const { dispatcher, calls } = browser(action => {
			if (action === "navigate") return { tab_id: 7 };
			if (action === "network_intercept_start") return { session_id: "synthetic-session" };
			if (action === "evaluate") return { value: { ready: true } };
			if (action === "network_intercept_drain") return { responses: ++drains === 1 ? [] : [{ url: "https://www.tiktok.com/api/recommend/item_list/", status: 200, body: JSON.stringify({ status_code: 0, statusCode: 0, hasMore: true, itemList: [post, post] }) }] };
			return {};
		});
		const result = await new TikTokConnector().read(context(dispatcher, { limit: 30 }));
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.origin_id).toBe(post.id);
		expect(drains).toBe(2);
		expect(calls.find(call => call.action === "network_intercept_start")?.input.patterns).toEqual(["https://www.tiktok.com/api/recommend/item_list/**"]);
		expect(calls.slice(-2).map(call => call.action)).toEqual(["network_intercept_stop", "close_tab"]);
	});

	test("rejects unverified recommendation responses and stops capture before closing", async () => {
		for (const bad of [
			{ status: 403 }, { truncated: true }, { base64_encoded: true }, { body: "not json" },
			{ url: "https://example.com/api/recommend/item_list/" },
			{ url: "https://www.tiktok.com/api/following/item_list/" },
			{ url: "https://user@www.tiktok.com/api/recommend/item_list/" },
			{ body: JSON.stringify({ status_code: 0, statusCode: 1, hasMore: true, itemList: [post] }) },
			{ body: JSON.stringify({ status_code: 0, itemList: [post] }) },
			{ body: JSON.stringify({ status_code: 0, hasMore: false, itemList: [{ ...post, id: null }] }) },
		]) {
			const { dispatcher, calls } = recommendationBrowser([post], bad);
			await expect(new TikTokConnector().read(context(dispatcher))).rejects.toThrow();
			expect(calls.slice(-2).map(call => call.action)).toEqual(["network_intercept_stop", "close_tab"]);
		}
	});

	test("does not claim empty For You coverage or return rows after a late challenge", async () => {
		for (const [items, lateFailure] of [[[], false], [[post], true]] as const) {
			const { dispatcher, calls } = recommendationBrowser([...items], {}, lateFailure);
			await expect(new TikTokConnector().read(context(dispatcher))).rejects.toThrow(lateFailure ? "verification required" : "no verifiable posts");
			expect(calls.slice(-2).map(call => call.action)).toEqual(["network_intercept_stop", "close_tab"]);
		}
	});

	test("bounds an absent For You capture without inventing an empty feed", async () => {
		let drains = 0;
		const { dispatcher, calls } = browser(action => {
			if (action === "navigate") return { tab_id: 7 };
			if (action === "network_intercept_start") return { session_id: "synthetic-session" };
			if (action === "evaluate") return { value: { ready: true } };
			if (action === "network_intercept_drain") { drains++; return { responses: [] }; }
			return {};
		});
		await expect(new TikTokConnector().read(context(dispatcher))).rejects.toThrow("no verifiable posts");
		expect(drains).toBe(5);
		expect(calls.slice(-2).map(call => call.action)).toEqual(["network_intercept_stop", "close_tab"]);
	});

	test("follows source cursor and level beyond the repeated first page to collect 30 distinct posts", async () => {
		const posts = Array.from({ length: 35 }, (_, index) => ({ ...post, id: String(7000000000000000000n + BigInt(index)) }));
		const batches = [posts.slice(0, 8), posts.slice(6, 16), posts.slice(14, 24), posts.slice(22, 28), posts.slice(26, 35)];
		let batch = 0;
		const requestUrl = "https://www.tiktok.com/api/following/item_list/?count=9&cursor=0&level=1&pullType=1&opaque=preserved";
		const cursors = ["0", "1700000000000", "1699999000000", "1699998000", "1699997000"];
		const levels = [1, 2, 2, 3, 3];
		const page = followingPageBrowser(url => {
			expect(url.searchParams.get("cursor")).toBe(cursors[batch]);
			expect(url.searchParams.get("level")).toBe(String(levels[batch]));
			expect(url.searchParams.get("count")).toBe("30");
			expect(url.searchParams.get("pullType")).toBe("2");
			expect(url.searchParams.get("opaque")).toBe("preserved");
			batch++;
			return new Response(JSON.stringify({ status_code: 0, hasMore: true, cursor: cursors[batch], level: levels[batch], itemList: batches[batch] }));
		});
		const { dispatcher, calls } = browser((action, input) => {
			if (action === "navigate") return { tab_id: 7 };
			if (action === "network_intercept_start") return { session_id: "synthetic-session" };
			if (action === "evaluate") return page.run(String(input.expression)).then((value: unknown) => ({ value }));
			if (action === "network_intercept_drain") return { responses: [{ url: requestUrl, status: 200, body: JSON.stringify({ status_code: 0, hasMore: true, cursor: cursors[batch], level: levels[batch], itemList: batches[batch] }) }] };
			return {};
		});
		const result = await new TikTokConnector().read(context(dispatcher, { feedKey: "following", limit: 30 }));
		expect(result.rows.map(row => row.origin_id)).toEqual(posts.slice(0, 30).map(row => row.id));
		expect(batch).toBe(4);
		expect(result.hasMore).toBe(false);
		expect(result.nextCursor).toBeUndefined();
		expect(calls.slice(-2).map(call => call.action)).toEqual(["network_intercept_stop", "close_tab"]);
	});

	test("focuses each scratch snapshot before waiting for lazy-loaded content", async () => {
		for (const feedKey of ["for_you", "following", "search"]) {
			let focused = false;
			const { dispatcher, calls } = browser(action => {
				if (action === "navigate") return { tab_id: 7 };
				if (action === "focus_tab") focused = true;
				if (action === "wait_for_selector" && !focused) throw new Error("Background snapshot did not load");
				if (action === "network_intercept_start") return { session_id: "synthetic-session" };
				if (action === "network_intercept_drain") return { responses: [{ url: `https://www.tiktok.com/api/${feedKey === "following" ? "following" : "recommend"}/item_list/`, status: 200, body: JSON.stringify({ status_code: 0, hasMore: false, itemList: [post] }) }] };
				if (action === "evaluate") return { value: { rows: [{ url: `https://www.tiktok.com/@example_creator/video/${post.id}`, text: post.desc }] } };
				return {};
			});
			const result = await new TikTokConnector().read(context(dispatcher, { feedKey, ...(feedKey === "search" ? { query: "agent memory" } : {}) }));
			expect(result.rows).toHaveLength(1);
			expect(calls.find(call => call.action === "focus_tab")?.input).toMatchObject({ tab_id: 7, draw_attention: false });
			expect(calls.at(-1)?.action).toBe("close_tab");
		}
	});
	test("uses source reads without sync or embedded Automation decisions", () => {
		const definition = new TikTokConnector().definition;
		expect(definition.key).toBe("tiktok.web");
		expect(definition.browser?.origins).toEqual(["https://www.tiktok.com"]);
		for (const feed of Object.values(definition.feeds ?? {})) {
			expect(feed.read).toBeFunction();
			expect(feed.sync).toBeUndefined();
		}
		expect(definition.actions?.set_like.kind).toBe("write");
		expect(definition.actions?.inspect_post.kind).toBe("read");
		expect(definition.actions?.publish).toBeUndefined();
	});

	test("rejects unsupported history and pagination before touching the browser", async () => {
		const { dispatcher, calls } = browser(() => { throw new Error("must not dispatch"); });
		for (const unsupported of [{ cursor: "invented" }, { offset: 1 }, { sort: { column: "likes", order: "desc" as const } }, { window: { start: "2026-01-01", end: "2026-01-02" } }]) {
			await expect(new TikTokConnector().read(context(dispatcher, unsupported))).rejects.toThrow();
		}
		expect(calls).toHaveLength(0);
	});

	test("cleans up only its scratch tab when a page fails", async () => {
		const { dispatcher, calls } = browser((action) => {
			if (action === "navigate") return { tab_id: 7, current_url: "https://www.tiktok.com/" };
			if (action === "network_intercept_start") return { session_id: "synthetic-session" };
			if (action === "evaluate") throw new Error("TikTok page unavailable");
			return {};
		});
		await expect(new TikTokConnector().read(context(dispatcher))).rejects.toThrow("unavailable");
		expect(calls.filter(call => call.action === "close_tab").map(call => call.input.tab_id)).toEqual([7]);
		expect(calls.some(call => call.action === "close_user_tabs")).toBe(false);
	});

	test("deduplicates the source snapshot and never claims complete history", async () => {
		const { dispatcher } = recommendationBrowser([post, post]);
		const result = await new TikTokConnector().read(context(dispatcher));
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.origin_id).toBe(post.id);
		expect(result.hasMore).toBe(false);
		expect(result.nextCursor).toBeUndefined();
		expect(result.total).toBeUndefined();
	});

	test("accepts the platform's default page size while bounding the browser snapshot", async () => {
		const { dispatcher } = recommendationBrowser([post]);
		expect((await new TikTokConnector().read(context(dispatcher, { limit: 50 }))).rows).toHaveLength(1);
	});

	test("rejects truncated Following data and stops capture before closing", async () => {
		const { dispatcher, calls } = browser(action => {
			if (action === "navigate") return { tab_id: 7 };
			if (action === "network_intercept_start") return { session_id: "synthetic-session" };
			if (action === "evaluate") return { value: { ready: true } };
			if (action === "network_intercept_drain") return { responses: [{ url: "https://www.tiktok.com/api/following/item_list/", status: 200, truncated: true, body: JSON.stringify({ status_code: 0, itemList: [post] }) }] };
			return {};
		});
		await expect(new TikTokConnector().read(context(dispatcher, { feedKey: "following" }))).rejects.toThrow("truncated");
		expect(calls.slice(-2).map(call => call.action)).toEqual(["network_intercept_stop", "close_tab"]);
	});

	test("reads Following through captured source records", async () => {
		const { dispatcher } = browser(action => {
			if (action === "navigate") return { tab_id: 7 };
			if (action === "network_intercept_start") return { session_id: "synthetic-session" };
			if (action === "evaluate") return { value: { ready: true } };
			if (action === "network_intercept_drain") return { responses: [{ url: "https://www.tiktok.com/api/following/item_list/", status: 200, body: JSON.stringify({ status_code: 0, hasMore: false, itemList: [post] }) }] };
			return {};
		});
		const result = await new TikTokConnector().read(context(dispatcher, { feedKey: "following" }));
		expect(result.rows[0]?.origin_id).toBe(post.id);
	});

	test("passes search text as a URL parameter and preserves photo identity", async () => {
		const { dispatcher, calls } = browser(action => action === "navigate" ? { tab_id: 7 } : action === "evaluate" ? { value: { rows: [{ url: "https://www.tiktok.com/@example_creator/photo/7000000000000000001", text: "Photo caption" }] } } : {});
		const result = await new TikTokConnector().read(context(dispatcher, { feedKey: "search", query: "AI & tools/#" }));
		expect(calls.filter(call => call.action === "navigate")[1]?.input.url).toBe("https://www.tiktok.com/search?q=AI%20%26%20tools%2F%23");
		expect(result.rows[0]).toMatchObject({ origin_id: post.id, media: { type: "photos" } });
	});
});

describe("Following collection bounds and recovery", () => {
	const initial = { url: "https://www.tiktok.com/api/following/item_list/?count=9&cursor=0&level=1&pullType=1", cursor: "0", level: 1, seen_ids: [post.id], limit: 30 };
	const response = (items = [post], hasMore = true, cursor = "0") => new Response(JSON.stringify({ status_code: 0, hasMore, cursor, level: 1, itemList: items }));
	const run = (f: ReturnType<typeof followingPageBrowser>, args: Record<string, unknown> = {}) => f.run(`(${tiktokPage.toString()})("following_posts",${JSON.stringify({ ...initial, ...args })})`);

	test("stops without fetching once the requested limit is reached", async () => {
		const f = followingPageBrowser(() => { throw new Error("must not fetch"); });
		expect((await run(f, { limit: 1 })).items).toEqual([]);
		expect(f.requests).toHaveLength(0);
	});

	test("returns fewer posts only when the source explicitly ends", async () => {
		const f = followingPageBrowser(() => response([], false));
		expect((await run(f)).items).toEqual([]);
		expect(f.requests).toHaveLength(1);
	});

	test("bounds repeated cursors without treating duplicates as new posts", async () => {
		const f = followingPageBrowser(() => response());
		await expect(run(f)).rejects.toThrow("incomplete: collected 1 of 30");
		expect(f.requests).toHaveLength(1);
	});

	test("continues through duplicate-only pages when the source cursor advances", async () => {
		let attempt = 0;
		const f = followingPageBrowser(() => response([post], ++attempt < 3, String(attempt)));
		expect((await run(f)).items).toHaveLength(1);
		expect(f.requests).toHaveLength(3);
	});

	test("bounds continually growing feeds that never reach the requested limit", async () => {
		let attempt = 0;
		const f = followingPageBrowser(() => response([{ ...post, id: String(7000000000000000100n + BigInt(++attempt)) }], true, String(attempt)));
		await expect(run(f)).rejects.toThrow("incomplete");
		expect(f.requests).toHaveLength(12);
	});

	test("rejects invalid continuation and unexpected URLs before fetching", async () => {
		for (const args of [{ cursor: null }, { cursor: "" }, { cursor: "x".repeat(257) }, { level: 0 }, { level: 1.5 }, { url: "https://example.com/api/following/item_list/" }, { url: "https://www.tiktok.com/api/item/detail/" }, { url: "https://user@www.tiktok.com/api/following/item_list/" }]) {
			const f = followingPageBrowser(() => { throw new Error("must not fetch"); });
			await expect(run(f, args)).rejects.toThrow();
			expect(f.requests).toHaveLength(0);
		}
	});

	test("preserves an opaque source cursor as one query parameter", async () => {
		const cursor = "opaque +/&level=9";
		const f = followingPageBrowser(url => {
			expect(url.searchParams.get("cursor")).toBe(cursor);
			expect(url.searchParams.get("level")).toBe("1");
			return response([], false);
		});
		await run(f, { cursor });
	});

	test("aborts a stalled fetch within the collection budget", async () => {
		let aborted = false;
		const f = followingPageBrowser((_url, signal) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
		}), 1);
		await expect(run(f)).rejects.toThrow("aborted");
		expect(aborted).toBe(true);
	});

	test("does not return partial success after a failed response", async () => {
		for (const bad of [() => new Response("blocked", { status: 403 }), () => new Response("not json"), () => new Response('{"status_code":1,"itemList":[]}'), () => new Response('{"status_code":0,"statusCode":1,"hasMore":false,"itemList":[]}'), () => new Response('{"status_code":0,"hasMore":null,"itemList":[]}')]) {
			const f = followingPageBrowser(bad);
			await expect(run(f)).rejects.toThrow();
		}
	});

	test("stops on verification, sign-out, or navigation during a request", async () => {
		for (const interruption of ["challenge", "signedOut", "navigation"]) {
			const f = followingPageBrowser(() => {
				if (interruption === "navigation") f.location.pathname = "/login";
				else f.state[interruption as "challenge" | "signedOut"] = true;
				return response([post], false);
			});
			await expect(run(f)).rejects.toThrow(interruption === "challenge" ? "verification required" : interruption === "signedOut" ? "sign-in" : "page changed");
			expect(f.requests).toHaveLength(1);
		}
	});

	test("allows a delayed initial capture, then cleans up after success or continuation failure", async () => {
		for (const fail of [false, true]) {
			let drains = 0;
			const page = followingPageBrowser(() => fail ? new Response("blocked", { status: 403 }) : response([post], false));
			const { dispatcher, calls } = browser((action, input) => {
				if (action === "navigate") return { tab_id: 7 };
				if (action === "network_intercept_start") return { session_id: "synthetic-session" };
				if (action === "evaluate") return page.run(String(input.expression)).then((value: unknown) => ({ value }));
				if (action === "network_intercept_drain") return { responses: ++drains === 1 ? [] : [{ url: initial.url, status: 200, body: JSON.stringify({ status_code: 0, hasMore: true, cursor: "0", level: 1, itemList: [post] }) }] };
				return {};
			});
			const reading = new TikTokConnector().read(context(dispatcher, { feedKey: "following", limit: 30 }));
			if (fail) await expect(reading).rejects.toThrow("request failed");
			else expect((await reading).rows).toHaveLength(1);
			expect(drains).toBe(2);
			expect(calls.slice(-2).map(call => call.action)).toEqual(["network_intercept_stop", "close_tab"]);
		}
	});
});

describe("TikTok actions", () => {
	const postUrl = "https://www.tiktok.com/@example_creator/video/7000000000000000001";
	const action = (dispatcher: ChromeActionDispatcher, actionKey: string, input: Record<string, unknown>) => new TikTokConnector().execute({ browser: dispatcher, actionKey, input: { post_url: postUrl, ...input }, config: {}, credentials: null });

	test("rejects invalid state and excessive media requests before dispatch", async () => {
		const { dispatcher, calls } = browser(() => { throw new Error("must not dispatch"); });
		expect((await action(dispatcher, "set_like", { liked: "true" })).success).toBe(false);
		expect((await action(dispatcher, "inspect_post", { frame_times: [NaN] })).success).toBe(false);
		expect((await action(dispatcher, "inspect_post", { photo_indices: [1.5] })).success).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("reports an already-matching like without reloading", async () => {
		const outputs = [{ item: post, liked: true }, { liked: true, changed: false }];
		const { dispatcher, calls } = browser(action => action === "navigate" ? { tab_id: 7 } : action === "evaluate" ? { value: outputs.shift() } : {});
		expect(await action(dispatcher, "set_like", { liked: true })).toMatchObject({ success: true, output: { liked: true, changed: false } });
		expect(calls.filter(call => call.action === "navigate")).toHaveLength(2);
		expect(calls.findIndex(call => call.action === "focus_tab")).toBeLessThan(calls.findIndex(call => call.action === "wait_for_selector"));
	});

	test("does not claim a successful like when the state reverts after reload", async () => {
		const outputs = [{ item: post, liked: false }, { liked: true, changed: true }, { item: post, liked: false }];
		const { dispatcher, calls } = browser(action => action === "navigate" ? { tab_id: 7 } : action === "evaluate" ? { value: outputs.shift() } : {});
		expect(await action(dispatcher, "set_like", { liked: true })).toMatchObject({ success: false, error: "TikTok like state did not persist after reload" });
		expect(calls.at(-1)?.action).toBe("close_tab");
	});

	test("returns image attachments with video times and no audio claim", async () => {
		const outputs = [{ item: post, liked: false }, { muted: true }, { seconds: 5, duration_seconds: 20 }];
		const attachment = { kind: "image", mime_type: "image/png", artifact_id: "synthetic-artifact" };
		const { dispatcher, calls } = browser(action => {
			if (action === "navigate") return { tab_id: 7 };
			if (action === "evaluate") return { value: outputs.shift() };
			if (action === "screenshot") return { attachments: [attachment] };
			return {};
		});
		expect(await action(dispatcher, "inspect_post", { frame_times: [5] })).toMatchObject({ success: true, output: { attachments: [attachment], frames: [{ seconds: 5, attachment_index: 0 }], audio_inspected: false } });
		expect(calls.at(-1)?.action).toBe("close_tab");
	});

	test("comment drafts require page activation and never submit or close the user's tab", async () => {
		const outputs = [{ opened: true }, { text: "Example draft" }];
		const { dispatcher, calls } = browser(action => {
			if (action === "navigate") return { tab_id: 7 };
			if (action === "evaluate") return { value: outputs.shift() };
			if (action === "get_accessibility_tree") return { document_epoch: 1, tree: [{ role: "textbox", ref_id: 4 }, { role: "button", name: "Post", ref_id: 5 }] };
			return {};
		});
		expect(await action(dispatcher, "prepare_comment", { body: "Example draft" })).toMatchObject({ success: true, output: { prepared: true, submitted: false } });
		expect(calls[0]?.input.require_page_activation).toBe(true);
		expect(calls.some(call => ["click_ref", "press_key", "close_tab", "focus_tab"].includes(call.action))).toBe(false);
		expect(calls.find(call => call.action === "type_ref")?.input).toMatchObject({ ref: { ref_id: 4 }, clear_first: false });
	});

	test("does not type into ambiguous comment composers", async () => {
		const { dispatcher, calls } = browser(action => {
			if (action === "navigate") return { tab_id: 7 };
			if (action === "evaluate") return { value: { opened: true } };
			if (action === "get_accessibility_tree") return { document_epoch: 1, tree: [{ role: "textbox", ref_id: 4 }, { role: "textbox", ref_id: 6 }] };
			return {};
		});
		expect((await action(dispatcher, "prepare_comment", { body: "Example draft" })).success).toBe(false);
		expect(calls.some(call => call.action === "type_ref")).toBe(false);
	});

	test("preserves the exact page-activation URL for comment drafts", async () => {
		for (const suffix of ["?share=1&tag=a&tag=b", "#comments", "?share=1#comments"]) {
			const activatedUrl = `${postUrl}${suffix}`;
			const outputs = [{ opened: true }, { text: "Example draft" }];
			const { dispatcher } = browser((action, input) => {
				if (action === "navigate") {
					if (input.url !== activatedUrl) throw new Error("Activated URL does not match");
					return { tab_id: 7 };
				}
				if (action === "evaluate") return { value: outputs.shift() };
				if (action === "get_accessibility_tree") return { document_epoch: 1, tree: [{ role: "textbox", ref_id: 4 }] };
				return {};
			});
			expect(await action(dispatcher, "prepare_comment", { post_url: activatedUrl, body: "Example draft" }))
				.toMatchObject({ success: true, output: { prepared: true, submitted: false, post_url: activatedUrl } });
		}
	});
});


describe("typed browser interruption transport", () => {
  test("preserves a late challenge while the account probe is waiting", async () => {
    let challenge = false;
    const document = { querySelector: (selector: string) => selector === "#captcha-verify-container-main-page"
      ? { getClientRects: () => challenge ? [1] : [] } : { textContent: '{"__DEFAULT_SCOPE__":{}}' } };
    const expression = new TikTokConnector().definition.browser!.accountProbe!.expression;
    const run = new Function("document", "setTimeout", `return ${expression}`);
    expect(await run(document, (fn: () => void) => { challenge = true; fn(); })).toMatchObject({
      __lobu_browser_interruption: { reason: "challenge_required" },
    });
  });
  test("keeps loading failure distinct from visible verification", async () => {
    const document = { querySelector: (selector: string) => selector === "#captcha-verify-container-main-page" ? null
      : { textContent: JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": { user: { uid: "123" } } } }) }, querySelectorAll: () => [] };
    const run = new Function("document", "setTimeout", `return (${tiktokPage.toString()})("post_links")`);
    await expect(run(document, (fn: () => void) => fn())).rejects.toMatchObject({ browser_interruption: "loading_failure" });
  });
});


test("a selector failure inspects the owned page before classifying recovery", async () => {
  const b = browser((action, input) => {
    if (action === "navigate") return { tab_id: 77 };
    if (action === "wait_for_selector") throw new Error("Synthetic selector timeout");
    if (action === "evaluate") {
      expect(input.expression).toContain('"read_failure"');
      return { value: { __lobu_browser_interruption: { reason: "challenge_required", message: "Synthetic visible verification" } } };
    }
    return {};
  });
  await expect(new TikTokConnector().read(context(b.dispatcher))).rejects.toThrow("Synthetic visible verification");
  expect(b.calls.at(-1)?.action).toBe("close_tab");
});
