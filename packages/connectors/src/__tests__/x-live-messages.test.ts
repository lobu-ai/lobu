import { beforeAll, describe, expect, mock, test } from "bun:test";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { xDirectMessagesProgram } from "../x-dm-adapter.js";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let XConnector: any;
beforeAll(async () => {
	XConnector = (await import("../x")).default;
});

const SELF = "1000";
const PEER = "2000";
const DM = `${SELF}-${PEER}`;
const GROUP = "3000";
const STRANGER = "8000";
const REQUEST = `${SELF}-${STRANGER}`;

interface FakeMessage {
	id: string;
	conversation_id: string;
	sender_id: string;
	text: string;
	time: number;
	request_id?: string;
	urls?: Array<{ url: string; expanded_url: string }>;
	attachment?: Record<string, unknown>;
}

/** A synthetic x.com DM API, answering the same-origin paths the page calls. */
function fakeX(
	transform: (body: Record<string, unknown>) => Record<string, unknown> = (
		body,
	) => body,
) {
	const messages: FakeMessage[] = [];
	const requests: Array<{ path: string; init?: RequestInit }> = [];
	let delivered = 0;
	let stampRequestIds = true;
	let hideSends = false;
	const users = {
		[SELF]: {
			id_str: SELF,
			screen_name: "synthetic_bot",
			name: "Synthetic Bot",
		},
		[PEER]: {
			id_str: PEER,
			screen_name: "synthetic_peer",
			name: "Synthetic Peer",
		},
	};
	const conversations = {
		[DM]: { conversation_id: DM, type: "ONE_TO_ONE", trusted: true },
		// A message request: someone the account does not follow wrote first.
		[REQUEST]: { conversation_id: REQUEST, type: "ONE_TO_ONE", trusted: false },
		[GROUP]: {
			conversation_id: GROUP,
			type: "GROUP_DM",
			name: "Synthetic group",
		},
	};
	const entry = (message: FakeMessage) => ({
		message: {
			id: message.id,
			time: String(message.time),
			conversation_id: message.conversation_id,
			...(message.request_id ? { request_id: message.request_id } : {}),
			message_data: {
				id: message.id,
				time: String(message.time),
				sender_id: message.sender_id,
				text: message.text,
				entities: { urls: message.urls ?? [] },
				...(message.attachment ? { attachment: message.attachment } : {}),
			},
		},
	});
	const ok = (body: Record<string, unknown>) => ({
		ok: true,
		status: 200,
		json: async () => transform(body),
	});
	async function fetch(path: string, init?: RequestInit) {
		requests.push({ path, init });
		const url = new URL(path, "https://x.com");
		const headers = (init?.headers ?? {}) as Record<string, string>;
		if (headers["x-csrf-token"] !== "synthetic-csrf") {
			return {
				ok: false,
				status: 403,
				json: async () => ({ errors: [{ code: 353 }] }),
			};
		}
		if (url.pathname === "/i/api/1.1/dm/inbox_initial_state.json") {
			return ok({
				inbox_initial_state: {
					cursor: `cursor-${messages.length}`,
					entries: messages.map(entry),
					users,
					conversations,
				},
			});
		}
		if (url.pathname === "/i/api/1.1/dm/user_updates.json") {
			const from = Number(url.searchParams.get("cursor")?.split("-")[1]);
			const fresh = messages.slice(from);
			return ok({
				user_events: {
					cursor: `cursor-${messages.length}`,
					entries: fresh.map(entry),
					users,
					conversations,
				},
			});
		}
		const conversation =
			/^\/i\/api\/1\.1\/dm\/conversation\/([^/]+)\.json$/.exec(url.pathname);
		if (conversation) {
			const id = conversation[1];
			if (!(id in conversations)) {
				return {
					ok: false,
					status: 404,
					json: async () => ({ errors: [{ code: 279 }] }),
				};
			}
			const maxId = url.searchParams.get("max_id");
			const visible = messages
				.filter((message) => message.conversation_id === id)
				.filter((message) => !hideSends || message.sender_id !== SELF)
				.filter((message) => !maxId || BigInt(message.id) < BigInt(maxId))
				.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
			const page = visible.slice(0, 2);
			return ok({
				conversation_timeline: {
					status: visible.length > 2 ? "HAS_MORE" : "AT_END",
					min_entry_id: page.at(-1)?.id,
					entries: page.map(entry),
					users,
					conversations,
				},
			});
		}
		if (url.pathname === "/i/api/1.1/dm/new2.json") {
			const body = JSON.parse(String(init?.body));
			delivered++;
			const message: FakeMessage = {
				id: String(9000 + delivered),
				conversation_id: body.conversation_id,
				sender_id: SELF,
				text: body.text,
				time: Date.now(),
				...(stampRequestIds ? { request_id: body.request_id } : {}),
			};
			messages.push(message);
			return ok({ entries: [entry(message)], users });
		}
		return { ok: false, status: 404, json: async () => ({}) };
	}
	return {
		messages,
		requests,
		fetch,
		sends: () => requests.filter((r) => r.path.includes("/new2.json")),
		withoutRequestIds: () => {
			stampRequestIds = false;
		},
		hidingSends: () => {
			hideSends = true;
		},
	};
}

/** A stub x.com page that evaluates expressions the way the bridge's `evaluate` does. */
function page(
	x: ReturnType<typeof fakeX>,
	cookie = `twid=u%3D${SELF}; ct0=synthetic-csrf`,
) {
	const globals: Record<string, unknown> = {};
	const replies = new Set<(event: unknown) => void>();
	const posts: Array<Record<string, any>> = [];
	const timers: Array<() => void | Promise<void>> = [];
	const window = {
		postMessage: (data: Record<string, any>) => posts.push(data),
		addEventListener: (_kind: string, fn: (event: unknown) => void) =>
			replies.add(fn),
		removeEventListener: (_kind: string, fn: (event: unknown) => void) =>
			replies.delete(fn),
	};
	const scope = {
		globalThis: globals,
		window,
		document: { cookie },
		location: { origin: "https://x.com" },
		fetch: x.fetch,
		crypto: webcrypto,
		TextEncoder,
		AbortSignal,
		setTimeout: (fn: () => void | Promise<void>) => {
			timers.push(fn);
			return timers.length;
		},
		clearTimeout: () => undefined,
	};
	const evaluate = (expression: string) =>
		new Function(...Object.keys(scope), `"use strict"; return ${expression};`)(
			...Object.values(scope),
		);
	const dispatcher = {
		dispatch: async (action: string, input: Record<string, any>) => {
			if (action === "navigate") return { tab_id: 7, current_url: input.url };
			if (action === "feed_listen") {
				return {
					bridge_id: "synthetic-bridge",
					token: "synthetic-token",
					listening: true,
					subscription: { scope_key: "synthetic-scope" },
				};
			}
			if (action === "evaluate") {
				try {
					return { value: await evaluate(input.expression) };
				} catch (error) {
					return { exception: { description: String(error) } };
				}
			}
			throw new Error(`unexpected dispatch ${action}`);
		},
	};
	const ack = (ok = true) => {
		const last = posts.at(-1)!;
		for (const fn of [...replies]) {
			fn({
				source: window,
				origin: "https://x.com",
				data: {
					type: "lobu-feed-record:ack",
					token: last.token,
					sequence: last.sequence,
					ok,
				},
			});
		}
	};
	const tick = async () => {
		const due = timers.splice(0);
		// Poll callbacks return promises that include the asynchronous batch digest.
		await Promise.all(due.map((fn) => fn()));
	};
	return {
		dispatcher,
		posts,
		ack,
		tick,
		setAccount: (id: string) => {
			scope.document.cookie = `twid=u%3D${id}; ct0=synthetic-csrf`;
		},
	};
}

function seed(x: ReturnType<typeof fakeX>) {
	x.messages.push(
		{
			id: "5001",
			conversation_id: DM,
			sender_id: PEER,
			text: "hello https://t.co/abc",
			urls: [
				{ url: "https://t.co/abc", expanded_url: "https://example.com/page" },
			],
			time: Date.parse("2026-10-01T10:00:00.000Z"),
		},
		{
			id: "5002",
			conversation_id: DM,
			sender_id: SELF,
			text: "hi back",
			time: Date.parse("2026-10-01T10:01:00.000Z"),
		},
		{
			id: "5003",
			conversation_id: GROUP,
			sender_id: PEER,
			text: "https://t.co/media",
			attachment: { photo: { url: "https://t.co/media" } },
			time: Date.parse("2026-10-01T10:02:00.000Z"),
		},
	);
}

function connector() {
	return new XConnector();
}

function read(dispatcher: unknown, extra: Record<string, unknown> = {}) {
	return connector().definition.feeds.live_messages.read({
		feedKey: "live_messages",
		config: {},
		credentials: null,
		browser: dispatcher,
		limit: 10,
		...extra,
	});
}

function send(dispatcher: unknown, input: Record<string, unknown>) {
	return connector().execute({
		actionKey: "send_message",
		input,
		credentials: null,
		config: {},
		browser: dispatcher,
	});
}

describe("X live_messages contract", () => {
	test("bumps the connector version", () => {
		expect(connector().definition.version).toBe("3.15.0");
	});

	test("declares message.created as a reply-to-source Automation event and keeps every feed kind", () => {
		const events = connector().definition.automationEvents;
		const created = events.find(
			(event: { key: string }) => event.key === "message.created",
		);
		expect(created).toMatchObject({
			resourceType: "message",
			capabilities: { replyToSource: true },
		});
		// Declaring automationEvents replaces the eventKinds-derived catalog,
		// so every kind the sync feeds emit must stay subscribable.
		const declared = new Set(events.map((event: { key: string }) => event.key));
		for (const feed of Object.values(connector().definition.feeds) as Array<{
			eventKinds?: Record<string, unknown>;
		}>) {
			for (const kind of Object.keys(feed.eventKinds ?? {})) {
				expect(declared.has(kind)).toBe(true);
			}
		}
	});

	test("live_messages reads and observes, triggering on message.created", () => {
		const feed = connector().definition.feeds.live_messages;
		expect(typeof feed.read).toBe("function");
		expect(typeof feed.observe).toBe("function");
		expect(feed.sync).toBeUndefined();
		expect(feed.webhook).toEqual({
			mode: "trigger",
			events: ["message.created"],
		});
	});

	test("send_message is a DM-only write that requires an idempotency key", () => {
		const action = connector().definition.actions.send_message;
		expect(action.kind).toBe("write");
		expect(action.inputSchema.required).toEqual([
			"conversation_id",
			"text",
			"idempotency_key",
		]);
		expect(action.description).toContain("prepare_reply");
		expect(action.annotations.idempotentHint).toBe(false);
	});
});

describe("X live_messages read", () => {
	test("rejects a malformed inbox instead of returning an empty success", async () => {
		const x = fakeX((body) => {
			const state = body.inbox_initial_state as Record<string, unknown>;
			delete state.entries;
			return body;
		});
		await expect(read(page(x).dispatcher)).rejects.toThrow("entries");
	});

	test.each([
		{},
		{ query: `id:${DM}:5001` },
	])("rejects an account change during read %j", async (input) => {
		const x = fakeX((body) => {
			browser.setAccount(PEER);
			return body;
		});
		seed(x);
		const browser = page(x);
		await expect(read(browser.dispatcher, input)).rejects.toThrow(
			"account changed",
		);
	});
	test("reads recent inbox messages as normalized rows, newest first", async () => {
		const x = fakeX();
		seed(x);
		const result = await read(page(x).dispatcher);
		expect(result.rows.map((row: { id: string }) => row.id)).toEqual([
			`${GROUP}:5003`,
			`${DM}:5002`,
			`${DM}:5001`,
		]);
		expect(result.rows[2]).toEqual({
			id: `${DM}:5001`,
			message_id: "5001",
			conversation_id: DM,
			conversation_name: null,
			sender_id: PEER,
			sender_handle: "synthetic_peer",
			sender_name: "Synthetic Peer",
			from_me: false,
			is_group: false,
			is_request: false,
			text: "hello https://example.com/page",
			content_kind: "text",
			occurred_at: "2026-10-01T10:00:00.000Z",
		});
		expect(result.rows[1]).toMatchObject({
			from_me: true,
			sender_handle: "synthetic_bot",
		});
		expect(result.rows[0]).toMatchObject({
			is_group: true,
			conversation_name: "Synthetic group",
			text: "",
			content_kind: "media",
		});
		// Reading never opens /messages and never marks anything read.
		expect(x.requests.every((r) => !r.path.includes("mark_read"))).toBe(true);
	});

	test("marks a message request conversation and still reads it by id", async () => {
		const x = fakeX();
		x.messages.push({
			id: "7001",
			conversation_id: REQUEST,
			sender_id: STRANGER,
			text: "hi, can you help?",
			time: Date.parse("2026-10-01T11:00:00.000Z"),
		});
		const { dispatcher } = page(x);
		const recent = await read(dispatcher);
		expect(recent.rows[0]).toMatchObject({
			id: `${REQUEST}:7001`,
			is_request: true,
			is_group: false,
			from_me: false,
		});
		const exact = await read(dispatcher, { query: `id:${REQUEST}:7001` });
		expect(exact.rows[0]).toMatchObject({ is_request: true });
	});

	test.each([
		["https://t.co/media", "", ""],
		["https://example.com/photo", "", ""],
		[
			"https://t.co/media",
			"caption https://t.co/page ",
			"caption https://example.com/page",
		],
	])("removes attachment URL %s and preserves caption %s", async (mediaUrl, caption, expectedText) => {
		const x = fakeX();
		x.messages.push({
			id: "5001",
			conversation_id: DM,
			sender_id: PEER,
			text: `${caption}https://t.co/media`,
			urls: [
				{
					url: "https://t.co/media",
					expanded_url: "https://example.com/photo",
				},
				{ url: "https://t.co/page", expanded_url: "https://example.com/page" },
			],
			attachment: { photo: { url: mediaUrl } },
			time: Date.now(),
		});
		const result = await read(page(x).dispatcher);
		expect(result.rows[0]).toMatchObject({
			text: expectedText,
			content_kind: expectedText ? "text" : "media",
		});
	});

	test("pages the recent inbox with the returned cursor", async () => {
		const x = fakeX();
		seed(x);
		const { dispatcher } = page(x);
		const first = await read(dispatcher, { limit: 2 });
		expect(first.hasMore).toBe(true);
		const second = await read(dispatcher, {
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.rows.map((row: { id: string }) => row.id)).toEqual([
			`${DM}:5001`,
		]);
		expect(second.hasMore).toBe(false);
	});

	test("looks up id:<message id> in its exact conversation, paging back", async () => {
		const x = fakeX();
		seed(x);
		x.messages.push(
			{
				id: "5004",
				conversation_id: DM,
				sender_id: PEER,
				text: "newer",
				time: Date.parse("2026-10-01T10:03:00.000Z"),
			},
			{
				id: "5005",
				conversation_id: DM,
				sender_id: PEER,
				text: "newest",
				time: Date.parse("2026-10-01T10:04:00.000Z"),
			},
		);
		const result = await read(page(x).dispatcher, {
			query: `id:${DM}:5001`,
			limit: 1,
		});
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toMatchObject({
			id: `${DM}:5001`,
			text: "hello https://example.com/page",
		});
		expect(x.requests.some((r) => r.path.includes("max_id=5004"))).toBe(true);
	});

	test("reports an incomplete exact lookup when its page budget is exhausted", async () => {
		const x = fakeX();
		for (let index = 0; index < 11; index++) {
			x.messages.push({
				id: String(5001 + index),
				conversation_id: DM,
				sender_id: PEER,
				text: "message",
				time: Date.now() + index,
			});
		}
		await expect(
			read(page(x).dispatcher, { query: `id:${DM}:5001` }),
		).rejects.toThrow("lookup is incomplete");
	});

	test("reports an incomplete exact lookup when X omits the next page cursor", async () => {
		const x = fakeX((body) => {
			const timeline = body.conversation_timeline as
				| Record<string, unknown>
				| undefined;
			if (timeline) {
				timeline.status = "HAS_MORE";
				delete timeline.min_entry_id;
			}
			return body;
		});
		seed(x);
		await expect(
			read(page(x).dispatcher, { query: `id:${DM}:4999` }),
		).rejects.toThrow("lookup is incomplete");
	});

	test("returns no row when an exact lookup reaches the end of history", async () => {
		const x = fakeX();
		seed(x);
		const result = await read(page(x).dispatcher, { query: `id:${DM}:4999` });
		expect(result).toMatchObject({ rows: [], hasMore: false });
	});

	test("rejects free-text search", async () => {
		const x = fakeX();
		await expect(read(page(x).dispatcher, { query: "hello" })).rejects.toThrow(
			"Only id:<message id> queries are supported",
		);
	});

	test("requires the browser-authenticated connection", async () => {
		await expect(read(undefined)).rejects.toThrow("paired Chrome browser");
	});
});

describe("X live_messages observe", () => {
	test.each([
		Number.NaN,
		9e15,
	])("does not checkpoint past invalid timestamp %s", async (time) => {
		const x = fakeX();
		seed(x);
		x.messages[0].time = time;
		const browser = page(x);
		await expect(
			connector().definition.feeds.live_messages.observe({
				feedKey: "live_messages",
				config: {},
				credentials: null,
				checkpoint: {
					x_dm: { account: SELF, cursor: "cursor-0", started_at: 1 },
				},
				browser: browser.dispatcher,
			}),
		).rejects.toThrow("Unable to attach");
		expect(browser.posts.every((post) => !post.record.checkpoint)).toBe(true);
	});

	test("treats a quiet inbox update without entries as zero events and advances its cursor", async () => {
		// The exact shape x.com returns for user_updates when nothing arrived
		// (observed live): no `entries` key at all.
		const x = fakeX((body) =>
			body.user_events
				? {
						user_events: {
							cursor: "cursor-quiet",
							last_seen_event_id: "5003",
							trusted_last_seen_event_id: "5003",
							untrusted_last_seen_event_id: "5003",
						},
					}
				: body,
		);
		const browser = page(x);
		await connector().definition.feeds.live_messages.observe({
			feedKey: "live_messages",
			config: {},
			credentials: null,
			checkpoint: {
				x_dm: { account: SELF, cursor: "cursor-0", started_at: 1 },
			},
			browser: browser.dispatcher,
		});
		expect(browser.posts).toHaveLength(1);
		const record = browser.posts[0].record;
		expect(record.source_error).toBeUndefined();
		expect(record.events).toEqual([]);
		expect(record.checkpoint.next.x_dm).toMatchObject({
			account: SELF,
			cursor: "cursor-quiet",
		});
	});

	test("refuses updates missing cursor without advancing the checkpoint", async () => {
		const x = fakeX((body) => {
			const state = body.user_events as Record<string, unknown> | undefined;
			if (state) delete state.cursor;
			return body;
		});
		const browser = page(x);
		await expect(
			connector().definition.feeds.live_messages.observe({
				feedKey: "live_messages",
				config: {},
				credentials: null,
				checkpoint: {
					x_dm: { account: SELF, cursor: "cursor-0", started_at: 1 },
				},
				browser: browser.dispatcher,
			}),
		).rejects.toThrow("Unable to attach");
		expect(browser.posts.every((post) => !post.record.checkpoint)).toBe(true);
	});

	test("refuses to anchor a listener when the account changes", async () => {
		const x = fakeX((body) => {
			browser.setAccount(PEER);
			return body;
		});
		const browser = page(x);
		await expect(
			connector().definition.feeds.live_messages.observe({
				feedKey: "live_messages",
				config: {},
				credentials: null,
				checkpoint: null,
				browser: browser.dispatcher,
			}),
		).rejects.toThrow("Unable to attach");
		expect(browser.posts.every((post) => !post.record.checkpoint)).toBe(true);
	});
	test("anchors at the current inbox, then publishes new message references", async () => {
		const x = fakeX();
		seed(x);
		const browser = page(x);
		await connector().definition.feeds.live_messages.observe({
			feedKey: "live_messages",
			config: {},
			credentials: null,
			checkpoint: null,
			browser: browser.dispatcher,
		});
		// First pass: no history replay, only the starting position.
		expect(browser.posts).toHaveLength(1);
		const first = browser.posts[0].record;
		expect(first.events).toEqual([]);
		expect(first.checkpoint.previous).toBeNull();
		expect(first.checkpoint.next.x_dm).toMatchObject({
			account: SELF,
			cursor: "cursor-3",
		});
		browser.ack();

		x.messages.push({
			id: "6001",
			conversation_id: DM,
			sender_id: PEER,
			text: "are you there?",
			time: Date.parse("2026-10-02T09:00:00.000Z"),
		});
		await browser.tick();
		expect(browser.posts).toHaveLength(2);
		const second = browser.posts[1].record;
		expect(
			second.events.map(
				(event: { resource_ref: string }) => event.resource_ref,
			),
		).toEqual([`${DM}:6001`]);
		expect(second.events.at(-1)).toEqual({
			id: `${DM}:6001`,
			event_type: "message.created",
			resource_type: "message",
			resource_ref: `${DM}:6001`,
			occurred_at: "2026-10-02T09:00:00.000Z",
		});
		expect(second.checkpoint.previous).toEqual(first.checkpoint.next);
		expect(second.checkpoint.next.x_dm.cursor).toBe("cursor-4");
		// An unacknowledged batch is reposted unchanged, not recomputed.
		await browser.tick();
		expect(browser.posts[2].record).toEqual(second);
	});

	test("refuses a checkpoint from another account", async () => {
		const x = fakeX();
		const browser = page(x);
		await expect(
			connector().definition.feeds.live_messages.observe({
				feedKey: "live_messages",
				config: {},
				credentials: null,
				checkpoint: {
					x_dm: { account: "999", cursor: "cursor-0", started_at: 1 },
				},
				browser: browser.dispatcher,
			}),
		).rejects.toThrow("another account");
	});
});

describe("X send_message", () => {
	test("sends once into the exact conversation and verifies it landed", async () => {
		const x = fakeX();
		seed(x);
		const result = await send(page(x).dispatcher, {
			conversation_id: DM,
			text: "thanks for writing",
			idempotency_key: "synthetic-op-1",
		});
		expect(result).toMatchObject({
			success: true,
			output: {
				sent: true,
				deduplicated: false,
				conversation_id: DM,
				message_id: "9001",
				id: `${DM}:9001`,
			},
		});
		expect(x.sends()).toHaveLength(1);
		const body = JSON.parse(String(x.sends()[0].init?.body));
		expect(body).toMatchObject({
			conversation_id: DM,
			text: "thanks for writing",
		});
		expect(body.request_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	test("deduplicates a retry whose request id is still on the latest page", async () => {
		const x = fakeX();
		seed(x);
		const { dispatcher } = page(x);
		const input = {
			conversation_id: DM,
			text: "only once",
			idempotency_key: "synthetic-op-2",
		};
		await send(dispatcher, input);
		const retry = await send(dispatcher, input);
		expect(retry.output).toMatchObject({
			sent: true,
			deduplicated: true,
			message_id: "9001",
		});
		expect(x.sends()).toHaveLength(1);
		// A different key is a different send.
		await send(dispatcher, { ...input, idempotency_key: "synthetic-op-3" });
		expect(x.sends()).toHaveLength(2);
	});

	test("refuses to send after the preflight changes accounts", async () => {
		const x = fakeX((body) => {
			browser.setAccount(PEER);
			return body;
		});
		const browser = page(x);
		const result = await send(browser.dispatcher, {
			conversation_id: DM,
			text: "hi",
			idempotency_key: "synthetic-switched",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("account changed");
		expect(x.sends()).toHaveLength(0);
	});

	test("refuses to claim delivery from matching text without a request id", async () => {
		const x = fakeX();
		x.withoutRequestIds();
		const { dispatcher } = page(x);
		const input = {
			conversation_id: DM,
			text: "only once",
			idempotency_key: "synthetic-op-4",
		};
		await send(dispatcher, input);
		const retry = await send(dispatcher, input);
		expect(retry.success).toBe(false);
		expect(retry.error).toContain("cannot identify");
		expect(x.sends()).toHaveLength(1);
	});

	test("fails loudly when the sent message is not visible afterwards", async () => {
		const x = fakeX();
		x.hidingSends();
		const result = await send(page(x).dispatcher, {
			conversation_id: DM,
			text: "unseen",
			idempotency_key: "synthetic-op-5",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("not visible");
	});

	test("refuses a conversation that does not belong to the signed-in account", async () => {
		const x = fakeX();
		const result = await send(page(x).dispatcher, {
			conversation_id: "4000-5000",
			text: "hi",
			idempotency_key: "synthetic-op-6",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("does not belong");
		expect(x.sends()).toHaveLength(0);
	});

	test("refuses an unknown conversation without sending", async () => {
		const x = fakeX();
		const result = await send(page(x).dispatcher, {
			conversation_id: `${SELF}-7777`,
			text: "hi",
			idempotency_key: "synthetic-op-7",
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("HTTP 404");
		expect(x.sends()).toHaveLength(0);
	});

	test("requires an idempotency key", async () => {
		const x = fakeX();
		const result = await send(page(x).dispatcher, {
			conversation_id: DM,
			text: "hi",
		});
		expect(result.success).toBe(false);
		expect(x.sends()).toHaveLength(0);
	});

	test("keeps hostile text inert in the page expression", async () => {
		const x = fakeX();
		const text = '</script> "); globalThis.pwned = true; ("';
		const result = await send(page(x).dispatcher, {
			conversation_id: DM,
			text,
			idempotency_key: "synthetic-op-8",
		});
		expect(result.success).toBe(true);
		expect(JSON.parse(String(x.sends()[0].init?.body)).text).toBe(text);
	});
});

describe("xDirectMessagesProgram serialisation", () => {
	test("keeps every binding inside the function", () => {
		const file = readFileSync(
			new URL("../x-dm-adapter.js", import.meta.url),
			"utf8",
		);
		const topLevel = file
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split("\n")
			.filter((line) => line.length > 0 && !/^[\s\t]/.test(line))
			.filter((line) => !line.startsWith("//") && line !== "}");
		expect(topLevel).toEqual(["export function xDirectMessagesProgram() {"]);
		expect(xDirectMessagesProgram.toString()).not.toMatch(/\bimport\s*\(/);
	});
});
