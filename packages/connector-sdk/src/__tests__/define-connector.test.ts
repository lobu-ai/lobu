import { describe, expect, test } from "bun:test";
import { ConnectorRuntime } from "../connector-runtime.js";
import { defineConnector } from "../define-connector.js";

// Mirrors the isolate guest runner in connector-worker/src/executor/isolate.ts: a
// connector is detected by a constructor whose prototype has sync() + execute().
// If this passes, an esbuild-bundled `export default defineConnector(...)` is
// picked up by the worker unchanged.
function isConnectorRuntimeClass(val: unknown): boolean {
	return (
		typeof val === "function" &&
		!!(val as { prototype?: { sync?: unknown } }).prototype?.sync &&
		!!(val as { prototype?: { execute?: unknown } }).prototype?.execute
	);
}

const Github = defineConnector({
	key: "github",
	name: "GitHub",
	version: "1.0.0",
	feeds: {
		stars: {
			name: "Stars",
			read: async (ctx) => ({ rows: [{ query: ctx.query ?? null }] }),
			sync: async (ctx) => {
				await ctx.commit([
					{
						origin_id: ctx.feedKey,
						payload_text: "star",
						occurred_at: new Date(),
					},
				], { seen: 1 });
				return { status: "complete" };
			},
		},
	},
	actions: {
		star_repo: {
			name: "Star repo",
			kind: "write",
			requiredScopes: ["public_repo"],
			execute: async (ctx) => ({
				success: true,
				output: { repo: ctx.input.repo },
			}),
		},
	},
});

describe("defineConnector", () => {
	test("returns a ConnectorRuntime subclass the worker can detect", () => {
		expect(isConnectorRuntimeClass(Github)).toBe(true);
		expect(new Github()).toBeInstanceOf(ConnectorRuntime);
	});

	test("lowers the spec to a ConnectorDefinition with keys from the record keys", () => {
		const { definition } = new Github();
		expect(definition.key).toBe("github");
		expect(definition.version).toBe("1.0.0");
		expect(definition.feeds?.stars?.key).toBe("stars");
		expect(definition.feeds?.stars?.name).toBe("Stars");
		expect(definition.actions?.star_repo?.key).toBe("star_repo");
		// requiresApproval defaults to false
		expect(definition.actions?.star_repo?.requiresApproval).toBe(false);
		// Semantic policy inputs must survive lowering, else a defineConnector()
		// action bypasses the read/write classification and the scope gate.
		expect(definition.actions?.star_repo?.kind).toBe("write");
		expect(definition.actions?.star_repo?.requiredScopes).toEqual([
			"public_repo",
		]);
		// Runtime feed definitions retain handlers; metadata extraction owns the
		// serialization boundary and derives operations from them.
		expect(typeof definition.feeds?.stars?.sync).toBe("function");
		expect(typeof definition.feeds?.stars?.read).toBe("function");
		expect(
			(definition.actions?.star_repo as Record<string, unknown>).execute,
		).toBeUndefined();
	});

	test("sync dispatches to the matching feed handler", async () => {
		const commits: Array<{ events: unknown[]; checkpoint: unknown }> = [];
		const res = await new Github().sync({
			feedKey: "stars",
			config: {},
			checkpoint: null,
			credentials: null,
			entityIds: [],
			commit: async (events, checkpoint) => {
				commits.push({ events, checkpoint });
			},
		});
		expect(res.status).toBe("complete");
		expect(commits).toHaveLength(1);
		expect(commits[0]?.events).toHaveLength(1);
		expect(commits[0]?.checkpoint).toEqual({ seen: 1 });
	});

	test("sync throws for an unknown feed", async () => {
		await expect(
			new Github().sync({
				feedKey: "nope",
				config: {},
				checkpoint: null,
				credentials: null,
				entityIds: [],
				commit: async () => {},
			}),
		).rejects.toThrow(/feed 'nope' does not support sync/);
	});

	test("the same feed dispatches source reads independently of sync", async () => {
		const res = await new Github().read({
			feedKey: "stars",
			config: {},
			query: "lobu",
			credentials: null,
		});
		expect(res.rows).toEqual([{ query: "lobu" }]);
	});

	test("execute dispatches to the matching action handler", async () => {
		const res = await new Github().execute({
			actionKey: "star_repo",
			input: { repo: "lobu-ai/lobu" },
			credentials: null,
			config: {},
		});
		expect(res).toEqual({ success: true, output: { repo: "lobu-ai/lobu" } });
	});

	test("execute returns an error result for an unknown action", async () => {
		const res = await new Github().execute({
			actionKey: "nope",
			input: {},
			credentials: null,
			config: {},
		});
		expect(res.success).toBe(false);
		expect(res.error).toMatch(/no action handler/);
	});

	test("a feeds-only connector still satisfies the worker contract", () => {
		const ReadOnly = defineConnector({
			key: "ro",
			name: "ReadOnly",
			version: "0.0.1",
			feeds: {
				items: {
					name: "Items",
					sync: async (ctx) => {
						await ctx.commit([], null);
						return { status: "complete" };
					},
				},
			},
		});
		expect(isConnectorRuntimeClass(ReadOnly)).toBe(true);
		expect(new ReadOnly().definition.actions).toBeUndefined();
	});

	const authCtx = () => ({
		config: {},
		previousCredentials: null,
		emit: async () => {},
		awaitSignal: async () => ({}),
		signal: new AbortController().signal,
	});

	test("authenticate dispatches to the spec handler when provided", async () => {
		const WithAuth = defineConnector({
			key: "wa",
			name: "WithAuth",
			version: "0.0.1",
			feeds: {
				f: {
					name: "F",
					sync: async (ctx) => {
						await ctx.commit([], null);
						return { status: "complete" };
					},
				},
			},
			authenticate: async () => ({ credentials: { token: "t" } }),
		});
		await expect(new WithAuth().authenticate(authCtx())).resolves.toEqual({
			credentials: { token: "t" },
		});
	});

	test("authenticate throws by default when no handler is provided", () => {
		expect(new Github().authenticate(authCtx())).rejects.toThrow(
			/interactive authentication/,
		);
	});
});
