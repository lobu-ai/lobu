/**
 * GitHub connector empty-body guard (item 5c, #2033).
 *
 * Bug: the list sync paths did `const items = await this.requestJson(...)`
 * then `items.length` / `for (const x of items)`. `requestJson` → `http.json()`
 * returns `await response.json()`, which is `null`/`undefined` for an empty-body
 * 200 (GitHub occasionally serves these). A bare null then threw
 * `Cannot read properties of undefined (reading 'length')` and crashed the whole
 * sync (the connector never recovered — every subsequent run hit the same repo
 * and re-threw).
 *
 * Fix: coerce a non-array/undefined response to [] before .length / iteration.
 *
 * Red (pre-fix): sync throws `reading 'length'`. Green (post-fix): sync returns
 * an empty event list.
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

const CONFIG = { repo_owner: "lobu-ai", repo_name: "lobu" };
const CREDS = { provider: "github", accessToken: "tok" };

/** Build a connector whose requestJson returns `body` for the FIRST list call
 *  (the empty-body case under test), then [] for any later page. */
function buildConnector(body: unknown) {
	const connector = new GitHubConnector();
	let call = 0;
	connector.requestJson = async () => {
		call += 1;
		return call === 1 ? body : [];
	};
	return connector;
}

describe("GitHub empty-body guard (#2033)", () => {
	for (const [label, feedKey] of [
		["commits", "commits"],
		["issues", "issues"],
		["issue comments", "issue_comments"],
		["pr comments", "pr_comments"],
	] as const) {
		test(`${label}: null body returns [] instead of throwing`, async () => {
			const connector = buildConnector(null);
			const result = await runSync(connector, {
				config: CONFIG,
				feedKey,
				checkpoint: null,
				credentials: CREDS,
				entityIds: [],
			});
			expect(result.events).toEqual([]);
		});

		test(`${label}: undefined body returns [] instead of throwing`, async () => {
			const connector = buildConnector(undefined);
			const result = await runSync(connector, {
				config: CONFIG,
				feedKey,
				checkpoint: null,
				credentials: CREDS,
				entityIds: [],
			});
			expect(result.events).toEqual([]);
		});
	}
});
