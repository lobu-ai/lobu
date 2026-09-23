/**
 * GitHub `commits` feed: poll the commits API and emit one event per commit,
 * attributed to the author so "who committed when" lands in memory. Commits are
 * durable + queryable, so polling recovers the full history without depending on
 * webhook delivery.
 *
 * Proves:
 *   - a linked-account commit → stable per-sha origin_id, origin_type 'commit',
 *     author date as occurred_at, and author_login/author_id stamped for person
 *     attribution (the authored_by rule resolves these to a person),
 *   - an unlinked-email commit (author === null) → falls back to the git author
 *     name and carries no author_login/author_id (no false person link).
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

const COMMITS = [
	{
		sha: "abc123",
		html_url: "https://github.com/lobu-ai/lobu/commit/abc123",
		commit: {
			message: "fix: the thing\n\nlonger body text",
			author: { name: "Burak", email: "b@example.com", date: "2026-06-20T10:00:00Z" },
			committer: { date: "2026-06-20T10:05:00Z" },
		},
		author: { login: "buremba", id: 82745 },
	},
	{
		sha: "def456",
		html_url: "https://github.com/lobu-ai/lobu/commit/def456",
		commit: {
			message: "chore: bump deps",
			author: { name: "dependabot", email: "dep@example.com", date: "2026-06-19T08:00:00Z" },
		},
		author: null, // commit email not tied to a GitHub account
	},
];

function buildConnector(commits: unknown[]) {
	const connector = new GitHubConnector();
	const calls: Array<{ url: string }> = [];
	connector.requestJson = async (params: { url: string }) => {
		calls.push({ url: params.url });
		// First page returns the canned commits (< per_page=100 → pagination stops);
		// any later page is empty.
		return calls.length === 1 ? commits : [];
	};
	return { connector, calls };
}

describe("GitHub commits feed", () => {
	test("maps each commit to a per-sha event attributed to the linked author", async () => {
		const { connector, calls } = buildConnector(COMMITS);

		const result = await runSync(connector, {
			config: { repo_owner: "lobu-ai", repo_name: "lobu" },
			feedKey: "commits",
			checkpoint: null,
			credentials: { provider: "github", accessToken: "tok" },
			entityIds: [],
		});

		expect(calls[0].url).toContain("/repos/lobu-ai/lobu/commits");
		expect(result.events).toHaveLength(2);

		const linked = result.events[0];
		expect(linked.origin_id).toBe("commit_lobu-ai_lobu_abc123");
		expect(linked.origin_type).toBe("commit");
		expect(linked.title).toBe("fix: the thing");
		expect(linked.author_name).toBe("buremba");
		expect(linked.source_url).toBe("https://github.com/lobu-ai/lobu/commit/abc123");
		expect(new Date(linked.occurred_at).toISOString()).toBe("2026-06-20T10:00:00.000Z");
		expect(linked.metadata.sha).toBe("abc123");
		expect(linked.metadata.author_email).toBe("b@example.com");
		// Person attribution: login (mutable) + immutable id are both stamped.
		expect(linked.metadata.author_login).toBe("buremba");
		expect(linked.metadata.author_id).toBe("82745");
	});

	test("unlinked-email commit falls back to git author name, no false person link", async () => {
		const { connector } = buildConnector(COMMITS);

		const result = await runSync(connector, {
			config: { repo_owner: "lobu-ai", repo_name: "lobu" },
			feedKey: "commits",
			checkpoint: null,
			credentials: { provider: "github", accessToken: "tok" },
			entityIds: [],
		});

		const unlinked = result.events[1];
		expect(unlinked.origin_id).toBe("commit_lobu-ai_lobu_def456");
		expect(unlinked.author_name).toBe("dependabot"); // git author name fallback
		// No GitHub account → no author_login/author_id so attribution can't
		// mis-attribute the commit to a person.
		expect(unlinked.metadata.author_login).toBeUndefined();
		expect(unlinked.metadata.author_id).toBeUndefined();
	});

	test("every event is stamped with github_repo_full_name for repo-ACL attribution", async () => {
		const { connector } = buildConnector(COMMITS);

		const result = await runSync(connector, {
			config: { repo_owner: "Lobu-AI", repo_name: "Lobu" },
			feedKey: "commits",
			checkpoint: null,
			credentials: { provider: "github", accessToken: "tok" },
			entityIds: [],
		});

		// Lowercased to match normalizeGithubRepoFullName / the repo graph so the
		// repo entity GITHUB_REPO_ENTITY_LINK resolves to is the SAME one
		// buildGithubRepoGraph materializes from collaborators.
		for (const event of result.events) {
			expect(event.metadata.github_repo_full_name).toBe("lobu-ai/lobu");
		}
	});
});
