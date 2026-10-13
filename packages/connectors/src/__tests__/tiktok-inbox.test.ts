import { expect, mock, test } from "bun:test";
import type { ChromeActionDispatcher, FeedReadContext, FeedReadResult } from "@lobu/connector-sdk";
import { connectorSdkMock } from "./connector-sdk.mock";
import { tiktokInboxPage } from "../tiktok-inbox-page.js";

mock.module("@lobu/connector-sdk", connectorSdkMock);
const { default: TikTokConnector } = await import("../tiktok_web");

const accountId = "7000000000000000001";
const message = (id: string, text: string) => ({ serverId: id, conversationId: "100", content: JSON.stringify({ text, token: "must-not-leak" }), sender: "200", isFromMe: false, type: 7, createdAt: new Date("2026-01-01T12:00:00Z") });

function fixture(options: { activity?: boolean; incomplete?: boolean } = {}) {
	let owner = accountId;
	let tick = 0;
	let loads = 0;
	const newer = message("102", "New message");
	const older = message("101", "Older message");
	const loaded = [newer];
	const thread = { id: "100", hasMoreMessages: true, isPullingMessages: false, getMessageList: () => loaded };
	const threads = [thread];
	const api = {
		stateStore: { isInitSucceeded: true, isInitLoadDone: true },
		instance: {
			ctx: { option: { userId: accountId } },
			getConversationList: () => threads,
			getMessagesByConversation: async () => {
				loads++;
				loaded.push(older);
				thread.hasMoreMessages = false;
				return { messages: [older], hasMore: false };
			},
		},
	};
	const notice = { nid_str: "900", create_time: 1767268800, has_read: false, type: 41 };
	const activity = {
		item: { notice_list: [] as typeof notice[], loading: false, has_more: 1, min_time: 0, max_time: 0 },
		onHitBottom: async () => {
			loads++;
			if (!options.incomplete) {
				activity.item.notice_list = [notice];
				activity.item.has_more = 0;
				activity.item.min_time = notice.create_time;
			}
		},
	};
	const node = (props: unknown = {}) => ({ getClientRects: () => [1], __reactFiber$test: { memoizedProps: props } });
	const row = { ...node({ item: notice }), innerText: "Example liked your comment", querySelectorAll: () => [{ href: "https://www.tiktok.com/@example/video/7000000000000000003?tracking=1" }] };
	const panel = { ...node(activity), querySelectorAll: () => [row] };
	const list = { ...node(), querySelectorAll: () => [], __reactFiber$test: { memoizedState: { memoizedState: { current: { value: api } } } } };
	const button = { ...node(), getAttribute: () => "true", click: () => {} };
	const document = {
		querySelector: (selector: string) => selector === "#captcha-verify-container-main-page" ? null : selector === "#__UNIVERSAL_DATA_FOR_REHYDRATION__" ? { textContent: JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": { user: { uid: owner } } } }) } : list,
		querySelectorAll: (selector: string) => selector === '[data-e2e="inbox-list"]' ? [panel] : [button],
	};
	class Clock extends Date { static now() { return tick; } }
	const run = new Function("document", "location", "Date", "setTimeout", "input", `return (${tiktokInboxPage.toString()})(input)`);
	return {
		read: (input: Record<string, unknown> = {}) => run(document, { origin: "https://www.tiktok.com" }, Clock, (callback: () => void) => { tick += 100; callback(); }, { feed: options.activity ? "activity" : "messages", ...input }),
		setOwner: (value: string) => { owner = value; },
		loads: () => loads,
		thread,
		threads,
	};
}

test("inbox reads reject unsupported bounds before dispatch and unverifiable pages after it", async () => {
	const calls: string[] = [];
	let value: unknown;
	const browser: ChromeActionDispatcher = {
		dispatch: async (action) => {
			calls.push(action);
			return action === "navigate" ? { tab_id: 7 } : action === "evaluate" ? { value } : {};
		},
	};
	const read = (overrides: Partial<FeedReadContext> = {}) => new TikTokConnector().read({ browser, credentials: null, config: {}, feedKey: "messages", ...overrides });
	for (const unsupported of [{ offset: 1 }, { query: "x" }, { limit: 0 }, { feedKey: "activity", sort: { column: "occurred_at", order: "asc" } }] as Partial<FeedReadContext>[]) {
		await expect(read(unsupported)).rejects.toThrow();
	}
	expect(calls).toEqual([]);
	value = { rows: [], hasMore: true };
	await expect(read()).rejects.toThrow("no verifiable page");
	expect(calls.at(-1)).toBe("close_tab");
	value = { rows: [{ id: "1" }], hasMore: true, nextCursor: "c" };
	expect(await read({ feedKey: "activity" })).toEqual(value as FeedReadResult);
});

test("message continuation loads older records without duplicating the first page", async () => {
	const f = fixture();
	const first = await f.read({ limit: 1 });
	expect(first.rows.map((row: { id: string }) => row.id)).toEqual(["102"]);
	expect(first.hasMore).toBe(true);
	const second = await f.read({ cursor: first.nextCursor, limit: 1 });
	expect(second.rows.map((row: { id: string }) => row.id)).toEqual(["101"]);
	expect(second.hasMore).toBe(false);
	expect(f.loads()).toBe(1);
	expect(JSON.stringify([first, second])).not.toContain("must-not-leak");
});

test("cursors cannot cross accounts or feeds", async () => {
	const f = fixture();
	const first = await f.read({ limit: 1 });
	await expect(f.read({ feed: "activity", cursor: first.nextCursor })).rejects.toThrow("different source or account");
	f.setOwner("7000000000000000099");
	await expect(f.read({ cursor: first.nextCursor })).rejects.toThrow("different source or account");
	expect(f.loads()).toBe(0);
});

test("activity loads its initial placeholder and preserves the string source id", async () => {
	const f = fixture({ activity: true });
	const read = await f.read();
	expect(f.loads()).toBe(1);
	expect(read).toMatchObject({ hasMore: false, rows: [{ id: "900", origin_id: "900", text: "Example liked your comment", source_url: "https://www.tiktok.com/@example/video/7000000000000000003" }] });
});

test("an empty activity placeholder that never loads is a failure, not an empty inbox", async () => {
	await expect(fixture({ activity: true, incomplete: true }).read()).rejects.toThrow("did not finish loading");
});

test("unsupported read bounds fail before loading source data", async () => {
	const f = fixture();
	await expect(f.read({ limit: 101 })).rejects.toThrow("limit");
	await expect(f.read({ cursor: "{}" })).rejects.toThrow("different source or account");
	expect(f.loads()).toBe(0);
});


test("conversation continuation survives inbox recency reordering", async () => {
	const f = fixture();
	f.thread.hasMoreMessages = false;
	f.threads.push({ ...f.thread, id: "200", getMessageList: () => [{ ...message("201", "Second conversation"), conversationId: "200" }] });
	const first = await f.read();
	expect(first.rows.map((row: { id: string }) => row.id)).toEqual(["102"]);
	f.threads.reverse();
	const second = await f.read({ cursor: first.nextCursor });
	expect(second.rows.map((row: { id: string }) => row.id)).toEqual(["201"]);
	expect(second.hasMore).toBe(false);
});
