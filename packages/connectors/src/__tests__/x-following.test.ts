import { afterEach, describe, expect, mock, test } from "bun:test";
import type { FeedReadContext } from "@lobu/connector-sdk";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);
const { default: XConnector } = await import("../x");

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function context(overrides: Partial<FeedReadContext> = {}): FeedReadContext {
	return {
		feedKey: "following_timeline",
		config: { expected_account_handle: "example_brand", public_only: true },
		credentials: { accessToken: "synthetic-token", provider: "twitter" },
		limit: 25,
		...overrides,
	};
}

function serve(page: unknown, status = 200) {
	const urls: URL[] = [];
	globalThis.fetch = mock(async (input: string | URL | Request) => {
		const url = new URL(String(input));
		urls.push(url);
		return url.pathname === "/2/users/me"
			? Response.json({ data: { id: "1000000001", username: "example_brand" } })
			: Response.json(page, { status });
	}) as typeof fetch;
	return urls;
}

function page(protectedAuthor = false) {
	return {
		data: [
			{
				id: "2000000001",
				text: "A public product launch",
				author_id: "1000000002",
				created_at: "2026-01-02T12:00:00Z",
				entities: {
					urls: [
						{
							url: "https://t.co/example",
							expanded_url: "https://example.com/product",
						},
					],
				},
			},
		],
		includes: {
			users: [
				{
					id: "1000000002",
					username: "example_founder",
					protected: protectedAuthor,
				},
			],
		},
		meta: { result_count: 1, next_token: "source-page-2" },
	};
}

describe("X Following source reads", () => {
	test("reads the authenticated account without a sync handler and preserves pagination and evidence", async () => {
		const urls = serve(page());
		const connector = new XConnector();
		const result = await connector.read(context({ cursor: "source-page-1" }));
		expect(connector.definition.feeds?.following_timeline.sync).toBeUndefined();
		expect(urls[1].pathname).toBe(
			"/2/users/1000000001/timelines/reverse_chronological",
		);
		expect(urls[1].searchParams.get("pagination_token")).toBe("source-page-1");
		expect(urls[1].searchParams.get("max_results")).toBe("25");
		expect(urls[1].searchParams.get("user.fields")).toContain("protected");
		expect(result).toMatchObject({
			nextCursor: "source-page-2",
			hasMore: true,
			rows: [
				{
					origin_id: "2000000001",
					source_url: "https://x.com/example_founder/status/2000000001",
					metadata: {
						author_protected: false,
						expanded_urls: [{ expanded_url: "https://example.com/product" }],
					},
				},
			],
		});
	});

	test("refuses the wrong account before reading its timeline", async () => {
		const urls = serve(page());
		await expect(
			new XConnector().read(
				context({ config: { expected_account_handle: "other_brand" } }),
			),
		).rejects.toThrow("does not match");
		expect(urls).toHaveLength(1);
	});

	test("public-only reads exclude protected and unknown authors without losing the cursor", async () => {
		for (const response of [page(true), { ...page(), includes: {} }]) {
			serve(response);
			expect(await new XConnector().read(context())).toMatchObject({
				rows: [],
				hasMore: true,
				nextCursor: "source-page-2",
			});
		}
	});

	test("returns a genuine empty page as exhausted", async () => {
		serve({ meta: { result_count: 0 } });
		expect(await new XConnector().read(context())).toMatchObject({
			rows: [],
			hasMore: false,
		});
	});

	test("propagates provider failures and rejects partial or malformed successes", async () => {
		serve({ detail: "Forbidden" }, 403);
		await expect(new XConnector().read(context())).rejects.toMatchObject({
			status: 403,
		});
		for (const response of [
			{ errors: [{ detail: "Unavailable" }] },
			{},
			{
				...page(),
				data: [{ ...page().data[0], created_at: "invalid" }],
			},
		]) {
			serve(response);
			await expect(new XConnector().read(context())).rejects.toThrow();
		}
	});

	test("requires OAuth and rejects unsupported read semantics before accessing X", async () => {
		const urls = serve(page());
		for (const overrides of [
			{ credentials: null },
			{ query: "launches" },
			{ offset: 1 },
			{ sort: { column: "occurred_at", order: "asc" as const } },
			{
				window: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" },
			},
		]) {
			await expect(new XConnector().read(context(overrides))).rejects.toThrow();
		}
		expect(urls).toHaveLength(0);
	});
});
