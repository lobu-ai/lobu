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
	function fixture() {
		let pressed = "false";
		let clicks = 0;
		const like = { getAttribute: () => pressed, click: () => { pressed = pressed === "true" ? "false" : "true"; clicks++; } };
		const editor = { getClientRects: () => [1], textContent: "My existing draft" };
		const card = { querySelector: (selector: string) => {
			if (selector.startsWith('a[href=')) return {};
			if (selector === '[data-e2e="video-desc"]') return { textContent: post.desc };
			if (selector === '[data-e2e="like-icon"]') return like;
			return null;
		} };
		const document = {
			querySelector: (selector: string) => selector === "#__UNIVERSAL_DATA_FOR_REHYDRATION__" ? { textContent: JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": { user: { uid: "7000000000000000003", uniqueId: "example_account" } }, "webapp.video-detail": { itemInfo: { itemStruct: post } } } }) } : card,
			querySelectorAll: () => [editor],
		};
		const url = "https://www.tiktok.com/@example_creator/video/7000000000000000001";
		const location = new URL(url);
		const run = new Function("document", "location", "command", "args", `return (${tiktokPage.toString()})(command,args)`);
		return { run: (command: string, args: Record<string, unknown> = {}) => run(document, location, command, { url, ...args }), clicks: () => clicks };
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

	test("preserves text already in the user's comment composer", async () => {
		await expect(fixture().run("open_comment")).rejects.toThrow("preserving the user's draft");
	});
});

describe("TikTok source reads", () => {
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
		const { dispatcher } = browser(action => action === "navigate" ? { tab_id: 7 } : action === "evaluate" ? { value: { items: [post, post] } } : {});
		const result = await new TikTokConnector().read(context(dispatcher));
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.origin_id).toBe(post.id);
		expect(result.hasMore).toBe(false);
		expect(result.nextCursor).toBeUndefined();
		expect(result.total).toBeUndefined();
	});

	test("accepts the platform's default page size while bounding the browser snapshot", async () => {
		const { dispatcher } = browser(action => action === "navigate" ? { tab_id: 7 } : action === "evaluate" ? { value: { items: [post] } } : {});
		expect((await new TikTokConnector().read(context(dispatcher, { limit: 50 }))).rows).toHaveLength(1);
	});

	test("rejects truncated Following data and stops capture before closing", async () => {
		const { dispatcher, calls } = browser(action => {
			if (action === "navigate") return { tab_id: 7 };
			if (action === "network_intercept_start") return { session_id: "synthetic-session" };
			if (action === "network_intercept_drain") return { responses: [{ status: 200, truncated: true, body: JSON.stringify({ status_code: 0, itemList: [post] }) }] };
			return {};
		});
		await expect(new TikTokConnector().read(context(dispatcher, { feedKey: "following" }))).rejects.toThrow("truncated");
		expect(calls.slice(-2).map(call => call.action)).toEqual(["network_intercept_stop", "close_tab"]);
	});

	test("reads Following through captured source records", async () => {
		const { dispatcher } = browser(action => {
			if (action === "navigate") return { tab_id: 7 };
			if (action === "network_intercept_start") return { session_id: "synthetic-session" };
			if (action === "network_intercept_drain") return { responses: [{ status: 200, body: JSON.stringify({ status_code: 0, itemList: [post] }) }] };
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
});
