/**
 * GitHub REST path encoding: `repo_owner`, `repo_name`, `org`, and the webhook
 * id are connection config, not literals, so every one of them must be
 * percent-encoded before it is interpolated into a request path. Unencoded, a
 * `/` or `?` in any of them silently re-targets the call at a different GitHub
 * endpoint while still carrying this connection's token.
 *
 * Proves, per call site rather than per helper (the helper is one line; the
 * coverage is the point):
 *   - all five REST polling feeds, both repository reads, all six write
 *     actions, and both webhook lifecycle calls encode their path segments,
 *   - `.` and `..` are rejected outright — `encodeURIComponent` passes them
 *     through and URL parsing then resolves them away, so encoding alone still
 *     lets `/repos/../../user` reach `/user`.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";
import { runSync } from './sync-harness';

mock.module("@lobu/connector-sdk", connectorSdkMock);

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let GitHubConnector: any;

beforeAll(async () => {
	const mod = await import("../github");
	GitHubConnector = mod.default;
});

const OWNER = "acme/platform";
const REPO = "roadmap?draft=1";
const REPO_API = "https://api.github.com/repos/acme%2Fplatform/roadmap%3Fdraft%3D1";

function buildConnector() {
	const connector = new GitHubConnector();
	const jsonCalls: Array<Record<string, unknown>> = [];
	const requestCalls: Array<{ url: string }> = [];

	connector.requestJson = async (params: Record<string, unknown>) => {
		jsonCalls.push(params);
		const url = String(params.url);
		if (url.endsWith("/stargazers?per_page=100&page=1")) return [];
		if (url === REPO_API) {
			return {
				id: 1,
				full_name: `${OWNER}/${REPO}`,
				html_url: `https://github.com/${OWNER}/${REPO}`,
			};
		}
		return {
			id: 11,
			number: 12,
			html_url: "https://github.test/item/12",
			state: "open",
			draft: false,
			sha: "abc123",
			merged: true,
			message: "merged",
		};
	};
	connector.http = {
		request: async (url: string) => {
			requestCalls.push({ url });
			return new Response(null, { status: 204 });
		},
	};

	return { connector, jsonCalls, requestCalls };
}

describe("GitHub REST path encoding", () => {
	// The discussions/discussion_comments feeds are omitted: they POST to the
	// fixed /graphql endpoint with owner and repo as query variables, so they
	// have no path segment to encode.
	test("encodes repository path segments for every REST polling feed", async () => {
		const feedCases = [
			["issues", "/issues?"],
			["pull_requests", "/issues?"],
			["issue_comments", "/issues/comments?"],
			["pr_comments", "/pulls/comments?"],
			["commits", "/commits?"],
		] as const;

		for (const [feedKey, suffix] of feedCases) {
			const { connector, jsonCalls } = buildConnector();
			await runSync(connector, {
				config: { repo_owner: OWNER, repo_name: REPO },
				feedKey,
				checkpoint: null,
				credentials: { provider: "github", accessToken: "token" },
				entityIds: [],
			});

			expect(String(jsonCalls[0].url)).toStartWith(`${REPO_API}${suffix}`);
		}
	});

	test("encodes repository path segments for repository and stargazer reads", async () => {
		const { connector, jsonCalls } = buildConnector();

		await runSync(connector, {
			config: { repo_owner: OWNER, repo_name: REPO },
			feedKey: "stargazers",
			checkpoint: null,
			credentials: { provider: "github", accessToken: "token" },
			entityIds: [],
		});

		expect(jsonCalls.map((call) => call.url)).toEqual([
			REPO_API,
			`${REPO_API}/stargazers?per_page=100&page=1`,
		]);
	});

	test("encodes repository path segments for every write action", async () => {
		const actionCases = [
			["create_issue", { title: "Encoded path" }, "/issues"],
			[
				"add_issue_comment",
				{ issue_number: 12, body: "Encoded path" },
				"/issues/12/comments",
			],
			["close_issue", { issue_number: 12 }, "/issues/12"],
			["reopen_issue", { issue_number: 12 }, "/issues/12"],
			[
				"create_pull_request",
				{ title: "Encoded path", head: "feature", base: "main" },
				"/pulls",
			],
			["merge_pull_request", { pull_number: 12 }, "/pulls/12/merge"],
		] as const;

		for (const [actionKey, input, suffix] of actionCases) {
			const { connector, jsonCalls } = buildConnector();
			const result = await connector.execute({
				actionKey,
				config: { repo_owner: OWNER, repo_name: REPO },
				input,
				credentials: { provider: "github", accessToken: "token" },
			});

			expect(result.success).toBe(true);
			expect(jsonCalls[0].url).toBe(`${REPO_API}${suffix}`);
		}
	});

	test("encodes organization and repository webhook paths", async () => {
		const orgConnector = buildConnector();
		await orgConnector.connector.registerWebhook({
			config: { org: "acme/platform?admin=1" },
			credentials: { provider: "github", accessToken: "token" },
			callbackUrl: "https://gateway.test/webhooks/github",
		});
		await orgConnector.connector.unregisterWebhook({
			config: { org: "acme/platform?admin=1" },
			credentials: { provider: "github", accessToken: "token" },
			callbackUrl: "https://gateway.test/webhooks/github",
			externalId: "99/hooks?admin=1",
		});
		expect(orgConnector.jsonCalls[0].url).toBe(
			"https://api.github.com/orgs/acme%2Fplatform%3Fadmin%3D1/hooks",
		);
		expect(orgConnector.requestCalls[0].url).toBe(
			"https://api.github.com/orgs/acme%2Fplatform%3Fadmin%3D1/hooks/99%2Fhooks%3Fadmin%3D1",
		);

		const repoConnector = buildConnector();
		await repoConnector.connector.registerWebhook({
			config: { repo_owner: OWNER, repo_name: REPO },
			credentials: { provider: "github", accessToken: "token" },
			callbackUrl: "https://gateway.test/webhooks/github",
		});
		expect(repoConnector.jsonCalls[0].url).toBe(`${REPO_API}/hooks`);
	});

	test("rejects dot path segments instead of walking the request up", async () => {
		// URL parsing resolves `.`/`..` away after encoding, so `/repos/../../user`
		// would reach `/user` with the connection's token.
		for (const segment of [".", ".."]) {
			const { connector, jsonCalls } = buildConnector();
			const result = await connector.execute({
				actionKey: "create_issue",
				config: { repo_owner: segment, repo_name: REPO },
				input: { title: "Traversal" },
				credentials: { provider: "github", accessToken: "token" },
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("not a valid path segment");
			expect(jsonCalls).toHaveLength(0);
		}
	});
});
