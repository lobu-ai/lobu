import { describe, expect, mock, test } from "bun:test";
import {
	connectorSdkMock,
	HttpStatusError,
} from "./connector-sdk.mock";
import { runSync } from './sync-harness';

mock.module("@lobu/connector-sdk", () => ({
	...connectorSdkMock(),
	createHttpClient: () => ({
		get: async () => {
			throw new HttpStatusError({ status: 403, message: "Forbidden" });
		},
		json: async () => {
			throw new HttpStatusError({ status: 403, message: "Forbidden" });
		},
		request: async () => {
			throw new HttpStatusError({ status: 403, message: "Forbidden" });
		},
	}),
}));

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
