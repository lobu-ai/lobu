import { beforeAll, describe, expect, mock, test } from "bun:test";
import { webcrypto } from "node:crypto";
import { connectorSdkMock } from "./connector-sdk.mock";
import { runSync } from "./sync-harness";

mock.module("@lobu/connector-sdk", connectorSdkMock);
let XConnector: any;
beforeAll(async () => {
	XConnector = (await import("../x")).default;
});

function listing(ids = ["one", "two"], cursor: string | null = "older") {
	return {
		globalObjects: {
			users: {},
			tweets: {},
			notifications: Object.fromEntries(
				ids.map((id) => [
					id,
					{
						id,
						timestampMs: "1700000000000",
						icon: { id: "heart" },
						message: { text: "Private source notification" },
					},
				]),
			),
		},
		timeline: {
			instructions: [
				{
					addEntries: {
						entries: [
							...ids.map((id) => ({
								entryId: `notification-${id}`,
								content: {
									item: {
										content: {
											notification: {
												id,
												fromUsers: ["2000"],
												targetTweets: ["3000"],
												url: { url: "https://x.com/i/status/3000" },
											},
										},
									},
								},
							})),
							...(cursor
								? [
										{
											entryId: "cursor-bottom",
											content: {
												operation: {
													cursor: { cursorType: "Bottom", value: cursor },
												},
											},
										},
									]
								: []),
						],
					},
				},
			],
		},
	};
}

function browser(response: (url: URL) => unknown = () => listing()) {
	let cookie = "twid=u%3D1000; ct0=synthetic-csrf";
	const requests: URL[] = [];
	const paths: string[] = [];
	const scope = {
		globalThis: {},
		window: { addEventListener() {}, removeEventListener() {} },
		document: {
			get cookie() {
				return cookie;
			},
		},
		location: { origin: "https://x.com" },
		crypto: webcrypto,
		TextEncoder,
		AbortSignal,
		URL,
		URLSearchParams,
		btoa,
		atob,
		setTimeout,
		clearTimeout,
		fetch: async (path: string, init: RequestInit) => {
			expect(init.method ?? "GET").toBe("GET");
			const url = new URL(path, "https://x.com");
			requests.push(url);
			expect(Number(url.searchParams.get("count"))).toBeLessThanOrEqual(50);
			const body = response(url);
			return body instanceof Response ? body : Response.json(body);
		},
	};
	const dispatcher = {
		dispatch: async (action: string, input: any) => {
			if (action === "navigate") {
				paths.push(input.url);
				return { tab_id: 7, current_url: input.url };
			}
			if (action === "evaluate") {
				try {
					return {
						value: await new Function(
							...Object.keys(scope),
							`return ${input.expression}`,
						)(...Object.values(scope)),
					};
				} catch (error) {
					return { exception: { description: String(error) } };
				}
			}
			throw new Error(`Unexpected action ${action}`);
		},
	};
	return {
		dispatcher,
		requests,
		paths,
		changeAccount() {
			cookie = "twid=u%3D9000; ct0=synthetic-csrf";
		},
	};
}

const readOptions = (b: ReturnType<typeof browser>, extra = {}) => ({
	feedKey: "notifications",
	config: {},
	credentials: {},
	browser: b.dispatcher,
	limit: 25,
	...extra,
});

describe("X notifications source", () => {
	test("reads account-scoped references through a neutral route and preserves provider continuation", async () => {
		const b = browser();
		const page = await new XConnector().read(readOptions(b));
		expect(page.rows.map((r: any) => r.id)).toEqual([
			"1000:notification-one",
			"1000:notification-two",
		]);
		expect(page.rows[0]).toMatchObject({
			notification_id: "one",
			actor_ids: ["2000"],
			text: "Private source notification",
		});
		expect(page.nextCursor).toBeDefined();
		expect(b.paths).toEqual(["https://x.com/home"]);
		expect(b.requests[0].pathname).toBe("/i/api/2/notifications/all.json");
	});

	test("sync retains only metadata and resumes an unfinished history sweep", async () => {
		const b = browser((url) =>
			url.searchParams.get("cursor") ? listing(["older"], null) : listing(),
		);
		const result = await runSync(new XConnector(), {
			...readOptions(b),
			checkpoint: null,
		});
		expect(result.events.map((e) => e.origin_id)).toEqual([
			"x_notification_1000:notification-one",
			"x_notification_1000:notification-two",
			"x_notification_1000:notification-older",
		]);
		expect(JSON.stringify(result.events)).not.toContain(
			"Private source notification",
		);
		expect(result.status).toBe("complete");
	});

	test("reads follows without target posts and distinguishes post creation time", async () => {
		const body = listing(["follow"], null);
		const entry: any = body.timeline.instructions[0].addEntries.entries[0];
		delete entry.content.item.content.notification.targetTweets;
		body.globalObjects.notifications.follow.icon.id = "person_icon";
		(body.globalObjects.tweets as any)["4000"] = {
			user_id_str: "2000",
			created_at: "Tue Nov 14 22:13:20 +0000 2023",
			full_text: "Source post text",
		};
		body.timeline.instructions[0].addEntries.entries.push({
			entryId: "tweet-4000",
			content: { item: { content: { tweet: { id: "4000" } } } },
		} as any);
		const page = await new XConnector().read(readOptions(browser(() => body)));
		expect(page.rows[0]).toMatchObject({
			kind: "person_icon",
			tweet_ids: [],
			actor_ids: ["2000"],
			timestamp_basis: "notification",
		});
		expect(page.rows[1]).toMatchObject({
			kind: "post",
			tweet_ids: ["4000"],
			actor_ids: ["2000"],
			timestamp_basis: "post_created_at",
			text: "Source post text",
			url: "https://x.com/i/status/4000",
		});
	});

	test("does not skip rows when the source returns more than the requested read limit", async () => {
		const b = browser();
		const connector = new XConnector();
		const first = await connector.read(readOptions(b, { limit: 1 }));
		const second = await connector.read(
			readOptions(b, { limit: 1, cursor: first.nextCursor }),
		);
		expect(first.rows[0].id).not.toBe(second.rows[0].id);
		expect(JSON.parse(second.nextCursor).source).toBe("older");
	});

	test("rejects a read cursor and a completed sync checkpoint from another account", async () => {
		const b = browser();
		const connector = new XConnector();
		const first = await connector.read(readOptions(b));
		b.changeAccount();
		await expect(
			connector.read(readOptions(b, { cursor: first.nextCursor })),
		).rejects.toThrow(/another account/);
		await expect(
			runSync(connector, {
				...readOptions(b),
				checkpoint: {
					notifications_account: "1000",
					notifications_cursor: null,
				},
			}),
		).rejects.toThrow(/another account/);
	});

	test("retains provider continuation across an empty page", async () => {
		const b = browser((url) =>
			url.searchParams.get("cursor") === "older"
				? listing([], "last")
				: url.searchParams.get("cursor") === "last"
					? listing(["last"], null)
					: listing(),
		);
		const result = await runSync(new XConnector(), {
			...readOptions(b),
			checkpoint: null,
		});
		expect(result.events).toHaveLength(3);
		expect(b.requests.map((u) => u.searchParams.get("cursor"))).toEqual([
			null,
			"older",
			"last",
		]);
	});

	test("preserves capped scan progress and captures new head items before continuing history", async () => {
		let arrivals = false;
		const b = browser((url) => {
			const position = Number(url.searchParams.get("cursor") ?? 0);
			return listing(
				[...(position === 0 && arrivals ? ["new"] : []), `item${position}`],
				position < 12 ? String(position + 1) : null,
			);
		});
		const connector = new XConnector();
		const first = await runSync(connector, {
			...readOptions(b),
			checkpoint: null,
		});
		expect(first.status).toBe("more");
		arrivals = true;
		const second = await runSync(connector, {
			...readOptions(b),
			checkpoint: first.checkpoint,
		});
		expect(
			second.events.some((e) => e.origin_id.endsWith("notification-new")),
		).toBe(true);
		expect(
			second.events.some((e) => e.origin_id.endsWith("notification-item12")),
		).toBe(true);
		expect(second.status).toBe("complete");
	});

	test("keeps source identities and revisions stable on an unchanged rerun", async () => {
		const b = browser(() => listing(["one"], null));
		const connector = new XConnector();
		const first = await runSync(connector, {
			...readOptions(b),
			checkpoint: null,
		});
		const second = await runSync(connector, {
			...readOptions(b),
			checkpoint: first.checkpoint,
		});
		expect(second.events).toEqual(first.events);
	});

	test.each([
		400, 404,
	])("recovers only a retired source cursor on HTTP %s", async (status) => {
		const b = browser((url) =>
			url.searchParams.get("cursor") === "retired"
				? new Response("expired", { status })
				: url.searchParams.get("cursor")
					? listing(["older"], null)
					: listing(),
		);
		const cursor = JSON.stringify({
			v: 1,
			kind: "notifications",
			account: "1000",
			source: "retired",
			after: null,
		});
		const result = await runSync(new XConnector(), {
			...readOptions(b),
			checkpoint: {
				notifications_cursor: cursor,
				notifications_account: "1000",
			},
		});
		expect(result.metadata?.cursor_reset).toBe(true);
		expect(result.status).toBe("complete");
		expect(new Set(result.events.map((e) => e.origin_id)).size).toBe(3);
	});

	test.each([
		401, 403, 429, 500,
	])("does not commit when the source fails with HTTP %s", async (status) => {
		const b = browser(() => new Response("unavailable", { status }));
		let commits = 0;
		await expect(
			runSync(new XConnector(), {
				...readOptions(b),
				checkpoint: null,
				commit: async () => {
					commits++;
				},
			}),
		).rejects.toThrow(/request failed/);
		expect(commits).toBe(0);
	});

	test.each([
		{},
		{
			globalObjects: {},
			timeline: {
				instructions: [
					{
						addEntries: { entries: [{ entryId: "unsupported", content: {} }] },
					},
				],
			},
		},
	])("fails visibly on unavailable or unsupported notification structure", async (body) => {
		const b = browser(() => body);
		await expect(new XConnector().read(readOptions(b))).rejects.toThrow(
			/unavailable|unsupported/,
		);
	});

	test("fails a repeated nonempty provider page without committing", async () => {
		const b = browser();
		let commits = 0;
		await expect(
			runSync(new XConnector(), {
				...readOptions(b),
				checkpoint: null,
				commit: async () => {
					commits++;
				},
			}),
		).rejects.toThrow(/did not advance/);
		expect(commits).toBe(0);
	});
});
