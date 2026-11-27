import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";
import { runSync } from './sync-harness';

// The shared mock's createHttpClient goes over global fetch, so the 403 is
// stubbed there. Overriding createHttpClient in mock.module would leak into
// every later connector test in the run (bun shares the mock registry).
mock.module("@lobu/connector-sdk", connectorSdkMock);

const realFetch = globalThis.fetch;
beforeEach(() => {
	globalThis.fetch = (async () =>
		new Response("Forbidden", { status: 403, statusText: "Forbidden" })) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const { default: XConnector } = await import("../x");

describe("XConnector forced OAuth", () => {
	test.each([
		"tweets",
		"my_tweets",
		"liked_tweets",
		"bookmarks",
		"direct_messages",
	])("preserves %s OAuth errors when no browser fallback is available", async (feedKey) => {
		const commit = mock(async () => {});
		await expect(
			runSync(new XConnector(), {
				feedKey,
				config: { account_handle: "testuser" },
				checkpoint: {},
				entityIds: [],
				commit,
				credentials: {
					provider: "twitter",
					accessToken: "oauth-token",
					scope: "users.read tweet.read offline.access",
				},
			}),
		).rejects.toMatchObject({ status: 403 });
		expect(commit).not.toHaveBeenCalled();
	});

	test("use_oauth does not fall back to extension on 403", async () => {
		const extensionCalls: Array<{ action: string; input: Record<string, unknown> }> =
			[];
		const dispatcher = {
			dispatch: async (action: string, input: Record<string, unknown>) => {
				extensionCalls.push({ action, input });
				return { result: { responses: [] } };
			},
		};

		const connector = new XConnector();
		await expect(
			runSync(connector, {
				feedKey: "my_tweets",
				config: { use_oauth: true },
				checkpoint: {},
				credentials: {
					provider: "twitter",
					accessToken: "token-with-full-scope",
					scope: "users.read tweet.read offline.access",
				},
				entityIds: [],
				browser: dispatcher,
			}),
		).rejects.toMatchObject({ status: 403 });

		expect(extensionCalls).toHaveLength(0);
	});
});
