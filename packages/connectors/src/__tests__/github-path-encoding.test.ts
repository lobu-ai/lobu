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
 *
 * Also drives the read-only actions (`get_pull_request_status`,
 * `get_branch_head`, `get_submodule_pointer`) through `execute()` against
 * real `Response` objects:
 * their paths, GitHub's review-decision dedupe per reviewer, the 50-reviewer
 * and 100-listed-run caps with their truncation flags, check-run paging and
 * counts, the default-branch fallback, the submodule-only gitlink read with
 * per-segment path encoding, and 404 / 403 handling classified from the
 * status and rate-limit headers.
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

type Route = { status?: number; headers?: Record<string, string>; body: unknown };

/** Serve `connector.http.raw` from a URL -> response table, recording each call. */
function buildReadConnector(routes: Record<string, Route | (() => Route)>) {
	const connector = new GitHubConnector();
	const calls: Array<{ url: string; auth: string | undefined }> = [];
	connector.http = {
		raw: async (url: string, init?: { headers?: Record<string, string> }) => {
			calls.push({ url, auth: init?.headers?.Authorization });
			const entry = routes[url];
			if (!entry) return new Response('{"message":"Not Found"}', { status: 404 });
			const route = typeof entry === 'function' ? entry() : entry;
			return new Response(JSON.stringify(route.body), {
				status: route.status ?? 200,
				headers: route.headers,
			});
		},
	};
	return { connector, calls };
}

function runRead(
	connector: unknown,
	actionKey: string,
	input: Record<string, unknown>,
) {
	// biome-ignore lint/suspicious/noExplicitAny: mocked connector instance
	return (connector as any).execute({
		actionKey,
		config: { repo_owner: OWNER, repo_name: REPO },
		input,
		credentials: { provider: "github", accessToken: "token" },
	});
}

const HEAD_SHA = "abc/123?x";
const ENCODED_SHA = "abc%2F123%3Fx";

function pullRoutes(overrides: Record<string, Route | (() => Route)> = {}) {
	return {
		[`${REPO_API}/pulls/12`]: {
			body: {
				number: 12,
				state: "open",
				draft: false,
				mergeable_state: "blocked",
				head: { sha: HEAD_SHA, ref: "feature" },
				base: { sha: "base-sha", ref: "main" },
			},
		},
		[`${REPO_API}/pulls/12/reviews?per_page=100&page=1`]: { body: [] },
		[`${REPO_API}/commits/${ENCODED_SHA}/check-runs?per_page=100&page=1`]: {
			body: { total_count: 0, check_runs: [] },
		},
		[`${REPO_API}/commits/${ENCODED_SHA}/status?per_page=100`]: {
			body: { state: "success", statuses: [] },
		},
		...overrides,
	};
}

function review(login: string, state: string, minute: number) {
	return {
		user: { login },
		state,
		submitted_at: new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString(),
	};
}

describe("GitHub read-only status actions", () => {
	test("get_pull_request_status encodes every path and returns the contract shape", async () => {
		const { connector, calls } = buildReadConnector(
			pullRoutes({
				[`${REPO_API}/commits/${ENCODED_SHA}/status?per_page=100`]: {
					body: {
						state: "pending",
						statuses: [{ context: "deploy", state: "pending", target_url: "x" }],
					},
				},
			}),
		);

		const result = await runRead(connector, "get_pull_request_status", { pull_number: 12 });

		expect(result.error).toBeUndefined();
		expect(calls.map((call) => call.url)).toEqual([
			`${REPO_API}/pulls/12`,
			`${REPO_API}/pulls/12/reviews?per_page=100&page=1`,
			`${REPO_API}/commits/${ENCODED_SHA}/check-runs?per_page=100&page=1`,
			`${REPO_API}/commits/${ENCODED_SHA}/status?per_page=100`,
		]);
		expect(calls.every((call) => call.auth === "Bearer token")).toBe(true);
		expect(result.output).toEqual({
			pull_number: 12,
			state: "open",
			draft: false,
			head_sha: HEAD_SHA,
			base_ref: "main",
			base_sha: "base-sha",
			mergeable_state: "blocked",
			reviews: [],
			reviews_truncated: false,
			checks: { counts: {}, runs: [], total_count: 0, truncated: false },
			commit_status: { state: "pending", contexts: [{ context: "deploy", state: "pending" }] },
		});
	});

	test("keeps each reviewer's decision the way GitHub does, across pages", async () => {
		const firstPage = [
			review("alice", "APPROVED", 1),
			review("bob", "COMMENTED", 2),
			...Array.from({ length: 98 }, (_, i) => review("carol", "COMMENTED", 3 + (i % 10))),
		];
		const secondPage = [
			review("alice", "CHANGES_REQUESTED", 30),
			{ user: { login: "bob" }, state: "PENDING" },
			// A later comment never replaces an approval or a dismissal.
			review("dave", "APPROVED", 20),
			review("dave", "COMMENTED", 40),
			review("erin", "DISMISSED", 6),
			review("erin", "COMMENTED", 50),
		];
		const { connector, calls } = buildReadConnector(
			pullRoutes({
				[`${REPO_API}/pulls/12/reviews?per_page=100&page=1`]: { body: firstPage },
				[`${REPO_API}/pulls/12/reviews?per_page=100&page=2`]: { body: secondPage },
			}),
		);

		const result = await runRead(connector, "get_pull_request_status", { pull_number: 12 });

		expect(calls.map((call) => call.url)).toContain(
			`${REPO_API}/pulls/12/reviews?per_page=100&page=2`,
		);
		// State-bearing decisions first, then comment-only reviewers; newest first.
		expect(result.output.reviews).toEqual([
			{ user: "alice", state: "CHANGES_REQUESTED", submitted_at: review("a", "x", 30).submitted_at },
			{ user: "dave", state: "APPROVED", submitted_at: review("a", "x", 20).submitted_at },
			{ user: "erin", state: "DISMISSED", submitted_at: review("a", "x", 6).submitted_at },
			{ user: "carol", state: "COMMENTED", submitted_at: review("a", "x", 12).submitted_at },
			{ user: "bob", state: "COMMENTED", submitted_at: review("a", "x", 2).submitted_at },
		]);
		expect(result.output.reviews_truncated).toBe(false);
	});

	test("caps reviewers at 50 and pages check runs, counting every run and listing non-green first", async () => {
		const reviews = Array.from({ length: 60 }, (_, i) => review(`user-${i}`, "APPROVED", i));
		const shard = (i: number) => ({
			name: `shard-${i}`,
			status: "completed",
			conclusion: "success",
			details_url: `https://ci/s${i}`,
		});
		const pageOne = Array.from({ length: 100 }, (_, i) => shard(i));
		const pageTwo = [
			{ name: "e2e", status: "in_progress", conclusion: null, details_url: null },
			{ name: "lint", status: "completed", conclusion: "failure", details_url: "https://ci/lint" },
			...Array.from({ length: 28 }, (_, i) => shard(100 + i)),
		];
		const checkRunsUrl = (page: number) =>
			`${REPO_API}/commits/${ENCODED_SHA}/check-runs?per_page=100&page=${page}`;
		const { connector } = buildReadConnector(
			pullRoutes({
				[`${REPO_API}/pulls/12/reviews?per_page=100&page=1`]: { body: reviews },
				[checkRunsUrl(1)]: { body: { total_count: 130, check_runs: pageOne } },
				[checkRunsUrl(2)]: { body: { total_count: 130, check_runs: pageTwo } },
			}),
		);

		const result = await runRead(connector, "get_pull_request_status", { pull_number: 12 });

		expect(result.output.reviews).toHaveLength(50);
		expect(result.output.reviews[0].user).toBe("user-59");
		expect(result.output.reviews.map((r: { user: string }) => r.user)).not.toContain("user-9");
		expect(result.output.reviews_truncated).toBe(true);
		const { checks } = result.output;
		expect(checks.counts).toEqual({ success: 128, failure: 1, in_progress: 1 });
		expect(checks.total_count).toBe(130);
		expect(checks.truncated).toBe(false);
		expect(checks.runs).toHaveLength(100);
		// The failing and running checks from page 2 lead the listed runs.
		expect(checks.runs.slice(0, 2)).toEqual([
			{ name: "e2e", status: "in_progress", conclusion: null, details_url: null },
			{ name: "lint", status: "completed", conclusion: "failure", details_url: "https://ci/lint" },
		]);
	});

	test("stops paging check runs after 3 pages and flags the counts as truncated", async () => {
		const full = (page: number) =>
			Array.from({ length: 100 }, (_, i) => ({
				name: `p${page}-${i}`,
				status: "completed",
				conclusion: "success",
				details_url: null,
			}));
		const checkRunsUrl = (page: number) =>
			`${REPO_API}/commits/${ENCODED_SHA}/check-runs?per_page=100&page=${page}`;
		const { connector, calls } = buildReadConnector(
			pullRoutes({
				[checkRunsUrl(1)]: { body: { total_count: 350, check_runs: full(1) } },
				[checkRunsUrl(2)]: { body: { total_count: 350, check_runs: full(2) } },
				[checkRunsUrl(3)]: { body: { total_count: 350, check_runs: full(3) } },
			}),
		);

		const result = await runRead(connector, "get_pull_request_status", { pull_number: 12 });

		expect(calls.map((call) => call.url)).not.toContain(checkRunsUrl(4));
		expect(result.output.checks.counts).toEqual({ success: 300 });
		expect(result.output.checks.total_count).toBe(350);
		expect(result.output.checks.truncated).toBe(true);
		expect(result.output.checks.runs).toHaveLength(100);
	});

	test("get_branch_head falls back to the default branch and encodes the branch", async () => {
		const branchBody = {
			name: "trunk",
			commit: { sha: "head-sha", commit: { committer: { date: "2026-11-09T19:38:00Z" } } },
		};
		const fallback = buildReadConnector({
			[REPO_API]: { body: { default_branch: "trunk" } },
			[`${REPO_API}/branches/trunk`]: { body: branchBody },
		});
		const defaulted = await runRead(fallback.connector, "get_branch_head", {});
		expect(fallback.calls.map((call) => call.url)).toEqual([REPO_API, `${REPO_API}/branches/trunk`]);
		expect(defaulted.output).toEqual({
			branch: "trunk",
			sha: "head-sha",
			committed_at: "2026-11-09T19:38:00Z",
		});

		const named = buildReadConnector({
			[`${REPO_API}/branches/feat%2Fx%3Fy`]: { body: { ...branchBody, name: "feat/x?y" } },
		});
		const explicit = await runRead(named.connector, "get_branch_head", { branch: "feat/x?y" });
		expect(named.calls.map((call) => call.url)).toEqual([`${REPO_API}/branches/feat%2Fx%3Fy`]);
		expect(explicit.output.branch).toBe("feat/x?y");
	});

	test("get_submodule_pointer reads the gitlink SHA, encoding each path segment and the ref", async () => {
		const SUBMODULE_PATH = "packages/own letto?x";
		const ENCODED_PATH = "packages/own%20letto%3Fx";
		const gitlink = {
			type: "submodule",
			name: "own letto?x",
			path: SUBMODULE_PATH,
			sha: "gitlink-sha",
			submodule_git_url: "https://github.com/acme/owletto.git",
		};
		const fallback = buildReadConnector({
			[REPO_API]: { body: { default_branch: "trunk" } },
			[`${REPO_API}/contents/${ENCODED_PATH}?ref=trunk`]: { body: gitlink },
		});
		const defaulted = await runRead(fallback.connector, "get_submodule_pointer", { path: SUBMODULE_PATH });
		expect(defaulted.error).toBeUndefined();
		expect(fallback.calls.map((call) => call.url)).toEqual([
			REPO_API,
			`${REPO_API}/contents/${ENCODED_PATH}?ref=trunk`,
		]);
		expect(fallback.calls.every((call) => call.auth === "Bearer token")).toBe(true);
		expect(defaulted.output).toEqual({ path: SUBMODULE_PATH, sha: "gitlink-sha", ref: "trunk" });

		const named = buildReadConnector({
			[`${REPO_API}/contents/${ENCODED_PATH}?ref=feat%2Fx%26y%3D1`]: { body: gitlink },
		});
		const explicit = await runRead(named.connector, "get_submodule_pointer", {
			path: SUBMODULE_PATH,
			ref: "feat/x&y=1",
		});
		expect(named.calls.map((call) => call.url)).toEqual([
			`${REPO_API}/contents/${ENCODED_PATH}?ref=feat%2Fx%26y%3D1`,
		]);
		expect(explicit.output).toEqual({ path: SUBMODULE_PATH, sha: "gitlink-sha", ref: "feat/x&y=1" });
	});

	test("get_submodule_pointer refuses a path that is not a submodule instead of returning its SHA", async () => {
		const cases: Array<[string, unknown, string]> = [
			["package.json", { type: "file", path: "package.json", sha: "blob-sha" }, "file"],
			["packages", [{ type: "dir", path: "packages/a", sha: "tree-sha" }], "dir"],
			["link", { type: "symlink", path: "link", sha: "link-sha", target: "x" }, "symlink"],
		];
		for (const [path, body, kind] of cases) {
			const { connector } = buildReadConnector({
				[`${REPO_API}/contents/${path}?ref=main`]: { body },
			});
			const result = await runRead(connector, "get_submodule_pointer", { path, ref: "main" });
			expect(result.success, path).toBe(false);
			expect(result.output, path).toBeUndefined();
			expect(result.error, path).toContain("GitHub not_submodule");
			expect(result.error, path).toContain(kind);
			expect(result.error, path).not.toMatch(/blob-sha|tree-sha|link-sha/);
		}
	});

	test("get_submodule_pointer rejects traversal and empty path segments before any request", async () => {
		for (const path of ["packages/../../user", "./x", "packages//owletto", "/packages", "packages/", ""]) {
			const { connector, calls } = buildReadConnector({});
			const result = await runRead(connector, "get_submodule_pointer", { path, ref: "main" });
			expect(result.success, path).toBe(false);
			expect(calls, path).toHaveLength(0);
		}
	});

	test("get_submodule_pointer types a missing path and a denial from the status", async () => {
		const missing = buildReadConnector({});
		const notFound = await runRead(missing.connector, "get_submodule_pointer", { path: "nope/x", ref: "main" });
		expect(notFound.success).toBe(false);
		expect(notFound.error).toContain("not_found (HTTP 404)");

		const denied = buildReadConnector({
			[`${REPO_API}/contents/a/b?ref=main`]: {
				status: 403,
				headers: { "x-ratelimit-remaining": "10" },
				body: { message: "Resource not accessible" },
			},
		});
		const forbidden = await runRead(denied.connector, "get_submodule_pointer", { path: "a/b", ref: "main" });
		expect(forbidden.error).toContain("forbidden (HTTP 403)");
	});

	test("reports 404 and 403 from the status and rate-limit headers, not the body text", async () => {
		const missing = buildReadConnector({});
		const notFound = await runRead(missing.connector, "get_pull_request_status", { pull_number: 404 });
		expect(notFound.success).toBe(false);
		expect(notFound.error).toContain("not_found (HTTP 404)");
		expect(missing.calls).toHaveLength(1);

		const limited = buildReadConnector({
			[`${REPO_API}/pulls/12`]: {
				status: 403,
				headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794340800" },
				body: { message: "Forbidden" },
			},
		});
		const rateLimited = await runRead(limited.connector, "get_pull_request_status", { pull_number: 12 });
		expect(rateLimited.success).toBe(false);
		expect(rateLimited.error).toContain("rate_limited (HTTP 403)");
		expect(rateLimited.error).toContain(new Date(1794340800 * 1000).toISOString());

		// A body that SAYS "rate limit" with remaining quota is a permission denial.
		const denied = buildReadConnector({
			[REPO_API]: {
				status: 403,
				headers: { "x-ratelimit-remaining": "4999" },
				body: { message: "API rate limit exceeded" },
			},
		});
		const forbidden = await runRead(denied.connector, "get_branch_head", {});
		expect(forbidden.success).toBe(false);
		expect(forbidden.error).toContain("forbidden (HTTP 403)");
		expect(forbidden.error).not.toContain("rate_limited");
	});
});
