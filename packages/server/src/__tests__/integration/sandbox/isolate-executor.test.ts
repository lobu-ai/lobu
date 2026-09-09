/**
 * Connector isolate lane: `IsolateExecutor` end to end.
 *
 *  1. EVERY bundled connector passes the executor's init path (the eligibility
 *     check, then module init and construction in the host bridge). Any that
 *     cannot is rejected with the offending Node builtin named, and the pinned
 *     set of those is empty;
 *  2. hackernews syncs against the live Algolia API, producing events and a
 *     checkpoint via the hooks, and `executeCompiledConnector` -- the entry
 *     point the server actually calls -- agrees with a directly constructed
 *     `IsolateExecutor` on the same config. There is one lane; what this pins
 *     is that executor selection wires options, hooks and env through
 *     unchanged;
 *  3. a fixture connector exercises each boundary: chunked emit, checkpoint
 *     hooks, chrome dispatch, auth artifacts/signals, domain-restricted fetch,
 *     bodies streamed chunk by chunk (with abort and cancel), the body cap,
 *     wall-clock and heap limits, error shape parity, redaction;
 *  4. the guest's URL / URLSearchParams / TextEncoder / TextDecoder / atob /
 *     btoa are compared against Node's over 100+ inputs each. The host computes
 *     them for the guest, so this checks the bridge wiring (typed arrays, error
 *     names and codes across the boundary), not a reimplementation.
 *
 * Runs under Node (vitest). Like `run-script-runtime.test.ts` it FAILS rather
 * than skips when `isolated-vm` cannot load: a silent skip is how the lane
 * would rot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolateConnectorCompiler } from "@lobu/connector-worker/compile";
import type { ExecutionHooks, ExecutorJob, ExecutorResult } from "@lobu/connector-worker/executor/interface";
import {
	IsolateExecutor,
	type IsolateExecutorOptions,
	type IsolateLogLevel,
} from "@lobu/connector-worker/executor/isolate";
import { executeCompiledConnector } from "@lobu/connector-worker/executor/runtime";
import {
	assertIsolateEligible,
	IsolateHost,
	IsolateLaneIneligibleError,
	type IsolatedVm,
	loadIsolatedVm,
} from "@lobu/connector-worker/isolate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "../../../../..");
const CONNECTORS_DIR = join(PACKAGES_DIR, "connectors/src");
const FIXTURE_PATH = join(HERE, "fixtures/isolate-fixture-connector.ts");

/**
 * Bundled connectors the isolate cannot load, by the Node builtins their bundle
 * still requires. EMPTY on purpose: a connector listed here is one the gateway
 * silently drops from the catalog. Mirrors the pin in
 * `connector-isolate-lane.test.ts`; both are edited by hand.
 */
const ISOLATE_INELIGIBLE_CONNECTORS: Record<string, string[]> = {};

function listBundledConnectors(): string[] {
	return readdirSync(CONNECTORS_DIR)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.filter((f) => /export default (class|defineConnector)/.test(readFileSync(join(CONNECTORS_DIR, f), "utf8")))
		.sort();
}

interface LaneError extends Error {
	exitReason?: string;
	httpStatus?: number;
	outputTail?: string;
}

interface Captured {
	result: ExecutorResult;
	events: Record<string, unknown>[];
	chunks: number[];
	checkpoints: (Record<string, unknown> | null)[];
	logs: { level: IsolateLogLevel; line: string }[];
	artifacts: Record<string, unknown>[];
	dispatches: { actionKey: string; input: Record<string, unknown> }[];
}

function syncJob(config: Record<string, unknown>, env: Record<string, string> = {}): ExecutorJob {
	return {
		mode: "sync",
		feedKey: "scenario",
		feedId: 7,
		config,
		checkpoint: null,
		entityIds: [],
		credentials: null,
		sessionState: null,
		env,
	};
}

function captureHooks(captured: Omit<Captured, "result">): ExecutionHooks {
	return {
		onEventChunk: async (chunk) => {
			captured.chunks.push(chunk.length);
			captured.events.push(...(chunk as unknown as Record<string, unknown>[]));
		},
		onCheckpointUpdate: async (checkpoint) => {
			captured.checkpoints.push(checkpoint);
		},
		onAuthArtifact: async (artifact) => {
			captured.artifacts.push(artifact);
		},
		onAwaitAuthSignal: async (name, options) => ({ code: "4242", name, timeoutMs: options?.timeoutMs ?? null }),
		onChromeDispatch: async (actionKey, input) => {
			captured.dispatches.push({ actionKey, input });
			return { actionKey, echoed: input, tabs: [{ id: 1 }, { id: 2 }] };
		},
	};
}

function emptyCapture(): Omit<Captured, "result"> {
	return { events: [], chunks: [], checkpoints: [], logs: [], artifacts: [], dispatches: [] };
}

let ivm: IsolatedVm;
let fixtureIsolateCode: string;
let server: Server;
let baseUrl: string;
let port: number;
/** Requests the fixture server has answered: a denied fetch must not move it. */
let hits = 0;
/** `/sse` writes its next chunk only when `/ack` releases it; `acks` counts the releases. */
let releaseSse: (() => void) | null = null;
let acks = 0;
/** `/drip` responses the client closed before the server ended them. */
let dripClosed = 0;

/** The `/sse` body: a multi-byte character split across the first two chunks, then a second event. */
const SSE_CHUNKS = [
	Buffer.concat([Buffer.from("data: caf", "utf8"), Buffer.from([0xc3])]),
	Buffer.concat([Buffer.from([0xa9]), Buffer.from("\n\ndata: second\n\n", "utf8")]),
];
const SSE_TEXT = "data: café\n\ndata: second\n\n";

async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function runIsolate(
	code: string,
	job: ExecutorJob,
	options: Partial<IsolateExecutorOptions> = {},
): Promise<Captured> {
	const captured = emptyCapture();
	const executor = new IsolateExecutor({
		timeoutMs: 60_000,
		logSink: (level, line) => captured.logs.push({ level, line }),
		...options,
	});
	const result = await executor.execute(code, job, captureHooks(captured));
	return { ...captured, result };
}

async function failIsolate(
	code: string,
	job: ExecutorJob,
	options: Partial<IsolateExecutorOptions> = {},
): Promise<LaneError> {
	const failure = await runIsolate(code, job, options).then(
		() => null,
		(error: unknown) => error as LaneError,
	);
	if (!failure) throw new Error("expected the isolate run to fail");
	return failure;
}

/**
 * Runs through `executeCompiledConnector`, the facade the server calls, which
 * selects the executor itself. Paired with `runIsolate` (a directly built
 * `IsolateExecutor`) so a divergence in option plumbing shows up as a diff.
 */
async function runViaRuntime(code: string, job: ExecutorJob, options: { allowedDomains?: readonly string[] } = {}): Promise<Captured> {
	const captured = emptyCapture();
	const result = await executeCompiledConnector({
		compiledCode: code,
		job,
		hooks: captureHooks(captured),
		timeoutMs: 120_000,
		allowedDomains: options.allowedDomains,
	});
	return { ...captured, result };
}

async function failViaRuntime(code: string, job: ExecutorJob): Promise<LaneError> {
	const failure = await runViaRuntime(code, job).then(
		() => null,
		(error: unknown) => error as LaneError,
	);
	if (!failure) throw new Error("expected the run to fail");
	return failure;
}

function checkpointOf(result: ExecutorResult): Record<string, unknown> {
	if (result.mode !== "sync") throw new Error(`expected a sync result, got ${result.mode}`);
	return (result.checkpoint ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
	const loaded = await loadIsolatedVm();
	if (!loaded) {
		throw new Error(`isolated-vm must load under Node ${process.versions.node} for the isolate lane suite`);
	}
	ivm = loaded;

	const isolateCompiler = createIsolateConnectorCompiler();
	fixtureIsolateCode = await isolateCompiler.compileConnectorForIsolateFromFile(FIXTURE_PATH);

	server = createServer((req, res) => {
		hits += 1;
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			switch (url.pathname) {
				case "/ok":
					res.writeHead(200, { "content-type": "text/plain" });
					res.end("hello from the fixture server");
					return;
				case "/echo":
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
					return;
				case "/big":
					res.writeHead(200, { "content-type": "application/octet-stream" });
					res.end("x".repeat(4096));
					return;
				case "/empty":
					res.writeHead(204);
					res.end();
					return;
				case "/sse": {
					// Each chunk after the first waits for the client to acknowledge
					// the previous one through /ack, so a client that has not READ a
					// chunk can never be sent the next; the body ends after the last
					// acknowledgement.
					res.writeHead(200, { "content-type": "text/event-stream" });
					let index = 0;
					const step = () => {
						if (index < SSE_CHUNKS.length) {
							res.write(SSE_CHUNKS[index]);
							index += 1;
							releaseSse = step;
						} else {
							releaseSse = null;
							res.end();
						}
					};
					step();
					return;
				}
				case "/ack":
					acks += 1;
					res.writeHead(200);
					res.end("ok");
					releaseSse?.();
					return;
				case "/drip":
					// One chunk, then the body stays open until the client goes away.
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.write("data: first\n\n");
					res.on("close", () => {
						dripClosed += 1;
					});
					return;
				case "/redirect":
					res.writeHead(302, { location: "/ok" });
					res.end();
					return;
				case "/redirect-elsewhere":
					// Same server, different host name: a hop the allowlist must judge on its own.
					res.writeHead(302, { location: `http://localhost:${port}/ok` });
					res.end();
					return;
				default:
					res.writeHead(404);
					res.end("nope");
			}
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	port = (server.address() as AddressInfo).port;
	baseUrl = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
	server?.closeAllConnections();
	await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
});

/**
 * The executor's init path without a job: find the exported runtime class the
 * way the guest runner does, construct it and report `definition.key`.
 */
const LOAD_PROBE = String.raw`
(function () {
  var mod = module.exports;
  var def = mod && typeof mod === 'object' ? mod.default : undefined;
  var values = mod && typeof mod === 'object' ? Object.values(mod) : [];
  var RuntimeClass = null;
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (typeof v === 'function' && v.prototype && v.prototype.sync && v.prototype.execute) { RuntimeClass = v; break; }
  }
  if (!RuntimeClass && typeof def === 'function' && def.prototype && def.prototype.sync && def.prototype.execute) RuntimeClass = def;
  if (!RuntimeClass) throw new Error('No ConnectorRuntime class found');
  var instance = new RuntimeClass();
  return instance && instance.definition && typeof instance.definition.key === 'string' ? instance.definition.key : null;
})()
`;

/** Eligibility check, then module init plus construction in a bare host. Rejects as the executor would. */
async function loadInIsolate(code: string): Promise<string | null> {
	assertIsolateEligible(code);
	const host = await IsolateHost.create({
		ivm,
		memoryMb: 512,
		messageBytes: 1 << 20,
		env: {},
		sync: { log: () => undefined, fatal: () => undefined, fetchAbort: () => undefined },
		async: {},
	});
	try {
		const key = await host.run(`${code}\n${LOAD_PROBE}`, { timeoutMs: 30_000 });
		return typeof key === "string" ? key : null;
	} finally {
		host.dispose();
	}
}

describe("isolate lane: bundled connectors", () => {
	it("loads every bundled connector at init, with no ineligible ones left", async () => {
		const compiler = createIsolateConnectorCompiler();
		const files = listBundledConnectors();
		expect(files.length).toBeGreaterThan(20);

		const ineligible: Record<string, string[]> = {};
		const loaded: string[] = [];
		for (const file of files) {
			const stem = file.replace(/\.ts$/, "");
			const bundle = await compiler.bundleConnectorForIsolate(join(CONNECTORS_DIR, file));
			if (bundle.builtins.length > 0) {
				ineligible[stem] = bundle.builtins;
				const failure = await loadInIsolate(bundle.code).then(
					() => null,
					(error: unknown) => error,
				);
				expect(failure, `${stem} must be rejected at init`).toBeInstanceOf(IsolateLaneIneligibleError);
				for (const builtin of bundle.builtins) {
					expect((failure as Error).message, `${stem} rejection names ${builtin}`).toContain(builtin);
				}
				await expect(compiler.compileConnectorForIsolateFromFile(join(CONNECTORS_DIR, file))).rejects.toBeInstanceOf(
					IsolateLaneIneligibleError,
				);
				continue;
			}
			let key: string | null;
			try {
				key = await loadInIsolate(bundle.code);
			} catch (error) {
				throw new Error(`${stem} failed to load in the isolate: ${(error as Error).message}`);
			}
			expect(key, `${stem} definition.key`).toEqual(expect.any(String));
			loaded.push(stem);
		}
		expect(ineligible).toEqual(ISOLATE_INELIGIBLE_CONNECTORS);
		expect(loaded.length).toBe(files.length - Object.keys(ISOLATE_INELIGIBLE_CONNECTORS).length);
		expect(loaded.length).toBeGreaterThan(15);
	}, 180_000);
});

describe("isolate lane: hackernews against the live API", () => {
	it("syncs stories live, and the runtime facade agrees with the executor built directly", async () => {
		const path = join(CONNECTORS_DIR, "hackernews.ts");
		const isolateCode = await createIsolateConnectorCompiler().compileConnectorForIsolateFromFile(path);
		const config = {
			search_query: "postgres",
			story_type: "story",
			lookback_days: 3,
			search_fields: ["title"],
			min_score: 0,
		};
		const job: ExecutorJob = { ...syncJob(config), feedKey: "stories" };
		const domains = ["hn.algolia.com", "news.ycombinator.com"];
		const [isolate, proc] = await Promise.all([
			runIsolate(isolateCode, job, { allowedDomains: domains }),
			runViaRuntime(isolateCode, job, { allowedDomains: domains }),
		]);

		expect(isolate.result.mode).toBe("sync");
		expect(isolate.events.length).toBeGreaterThan(0);
		expect(isolate.chunks.length).toBeGreaterThan(0);
		for (const event of isolate.events) {
			expect(["story", "ask_hn", "show_hn"]).toContain(event.origin_type);
			expect(typeof event.origin_id).toBe("string");
			expect(typeof event.title).toBe("string");
			expect(typeof event.occurred_at).toBe("string");
		}
		const checkpoint = checkpointOf(isolate.result);
		expect(typeof checkpoint.last_sync_at).toBe("string");
		expect(Number.isNaN(Date.parse(String(checkpoint.last_sync_at)))).toBe(false);
		if (isolate.result.mode === "sync") {
			expect(isolate.result.metadata?.items_found).toBe(isolate.events.length);
		}

		// Same connector, same config, same minute: the lanes must agree on what
		// a story is and, within the API's churn, on how many there were.
		const kinds = (c: Captured) => [...new Set(c.events.map((e) => e.origin_type))].sort();
		expect(kinds(isolate)).toEqual(kinds(proc));
		expect(Math.abs(isolate.events.length - proc.events.length)).toBeLessThanOrEqual(2);
		const isolateIds = new Set(isolate.events.map((e) => e.origin_id));
		const shared = proc.events.filter((e) => isolateIds.has(e.origin_id)).length;
		expect(shared).toBeGreaterThanOrEqual(Math.min(isolate.events.length, proc.events.length) - 2);
	}, 120_000);
});

describe("isolate lane: fixture connector", () => {
	it("refuses a run whose signal is already aborted, without running the guest", async () => {
		// `terminate` reaches the isolate through `host?.`, and `host` is assigned
		// only after `IsolateHost.create` resolves — an await away. An abort that
		// lands before that terminated nothing, so the guest ran to completion and
		// the run REPORTED SUCCESS for work the caller had already cancelled.
		const code = `
			class Runtime {
				async sync() { console.log("GUEST_RAN"); return { items: [] }; }
				async execute() { return { ok: true }; }
			}
			module.exports = { default: Runtime };
		`;
		const controller = new AbortController();
		controller.abort();

		const captured = emptyCapture();
		const executor = new IsolateExecutor({
			timeoutMs: 60_000,
			logSink: (level, line) => captured.logs.push({ level, line }),
		});
		const failure = await executor
			.execute(code, syncJob({}), { ...captureHooks(captured), signal: controller.signal })
			.then(
				() => null,
				(error: unknown) => error as LaneError,
			);

		// It fails, as the caller's cancellation asked.
		expect(failure).not.toBeNull();
		expect(String(failure?.message)).toContain("cancelled");
		// And the guest never ran at all — the point of cancelling before it starts.
		expect(captured.logs.some((entry) => entry.line.includes("GUEST_RAN"))).toBe(false);
	}, 120_000);

	it("cancels a run whose signal aborts while the isolate is still being built", async () => {
		// The same window, entered from the other side: the signal is live on
		// entry and fires during `IsolateHost.create`. The latch is what carries
		// that abort across the await to a host that can act on it.
		const code = `
			class Runtime {
				async sync() { console.log("GUEST_RAN"); return { items: [] }; }
				async execute() { return { ok: true }; }
			}
			module.exports = { default: Runtime };
		`;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 0);

		const captured = emptyCapture();
		const executor = new IsolateExecutor({
			timeoutMs: 60_000,
			logSink: (level, line) => captured.logs.push({ level, line }),
		});
		const failure = await executor
			.execute(code, syncJob({}), { ...captureHooks(captured), signal: controller.signal })
			.then(
				() => null,
				(error: unknown) => error as LaneError,
			);

		expect(failure).not.toBeNull();
		expect(String(failure?.message)).toContain("cancelled");
		expect(captured.logs.some((entry) => entry.line.includes("GUEST_RAN"))).toBe(false);
	}, 120_000);

	it("streams events in chunks of 100 and forwards checkpoint updates", async () => {
		const run = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "emit", count: 250 }));
		expect(run.chunks).toEqual([100, 100, 50, 1]);
		expect(run.events.length).toBe(251);
		expect(run.events[0]?.origin_id).toBe("fixture_0");
		expect(run.events[250]?.origin_id).toBe("fixture_250");
		expect(run.checkpoints).toEqual([{ cursor: 250 }]);
		expect(checkpointOf(run.result)).toEqual({ cursor: 251 });
		if (run.result.mode === "sync") expect(run.result.metadata?.items_found).toBe(251);
	});

	it("round-trips a chrome dispatch from an action and from a sync", async () => {
		const action = await runIsolate(fixtureIsolateCode, {
			mode: "action",
			actionKey: "dispatch",
			actionInput: { tab: 3 },
			config: {},
			credentials: null,
			sessionState: { cookies: "x" },
			env: {},
		});
		expect(action.dispatches).toEqual([{ actionKey: "tabs.list", input: { tab: 3 } }]);
		expect(action.result).toEqual({
			mode: "action",
			output: { observation: { actionKey: "tabs.list", echoed: { tab: 3 }, tabs: [{ id: 1 }, { id: 2 }] } },
		});

		const sync = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "dispatch" }));
		expect(sync.dispatches).toEqual([{ actionKey: "tabs.list", input: { from: "sync" } }]);
		expect(checkpointOf(sync.result)).toEqual({
			observation: { actionKey: "tabs.list", echoed: { from: "sync" }, tabs: [{ id: 1 }, { id: 2 }] },
		});
	});

	it("returns action output and surfaces a failed action as an error", async () => {
		const ok = await runIsolate(fixtureIsolateCode, {
			mode: "action",
			actionKey: "echo",
			actionInput: { a: 1, nested: { b: [1, 2] } },
			config: { k: "v" },
			credentials: null,
			sessionState: null,
			env: {},
		});
		expect(ok.result).toEqual({ mode: "action", output: { echoed: { a: 1, nested: { b: [1, 2] } }, configKeys: ["k"] } });

		const failed = await failIsolate(fixtureIsolateCode, {
			mode: "action",
			actionKey: "fail",
			actionInput: {},
			config: {},
			credentials: null,
			sessionState: null,
			env: {},
		});
		expect(failed.message).toContain("fixture action failed");
		expect(failed.exitReason).toBe("error_message");
	});

	it("runs authenticate with artifacts and signals over the hooks", async () => {
		const run = await runIsolate(fixtureIsolateCode, {
			mode: "authenticate",
			config: {},
			previousCredentials: null,
			env: {},
		});
		expect(run.artifacts).toEqual([{ type: "status", message: "fixture waiting for code" }]);
		expect(run.result).toEqual({
			mode: "authenticate",
			auth: {
				credentials: { provider: "fixture", accessToken: "tok_4242" },
				metadata: { signal: { code: "4242", name: "code", timeoutMs: 5000 } },
			},
		});
	});

	it("hands the guest a placeholder for its access token and spends the real token only in request headers", async () => {
		const realToken = "tok_real_9f3a";
		const job: ExecutorJob = {
			...syncJob({ scenario: "credential", url: `${baseUrl}/echo` }),
			credentials: { provider: "fixture", accessToken: realToken, expiresAt: "2030-01-01T00:00:00.000Z", scope: "read" },
		};
		const run = await runIsolate(fixtureIsolateCode, job, { allowedDomains: ["127.0.0.1"] });
		const cp = checkpointOf(run.result);
		// The guest holds a placeholder in the secret proxy's grammar and the
		// other bookkeeping fields; nothing else from the credential object.
		expect(cp.guestToken).toMatch(/^lobu_secret_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(cp.credentialKeys).toEqual(["accessToken", "expiresAt", "provider", "scope"]);
		// The upstream saw the real token, in both headers the guest put the placeholder in.
		expect(cp.upstreamAuthorization).toBe(`Bearer ${realToken}`);
		expect(cp.upstreamFixtureToken).toBe(realToken);
		// Nothing the guest can reach carries the real value: its context, the
		// config, `process.env`, or the literals the runner embeds in the source.
		expect(String(cp.visible)).toContain(String(cp.guestToken));
		expect(String(cp.visible)).not.toContain(realToken);
		// One audit line per credential per host, naming the first header it went into; never the value.
		const audit = run.logs.filter((l) => l.line.includes("spent on"));
		expect(audit).toHaveLength(1);
		expect(audit[0]).toEqual({ level: "info", line: `credential ${String(cp.guestToken).slice(-12)} spent on 127.0.0.1 in header authorization` });
		expect(run.logs.some((l) => l.line.includes(realToken))).toBe(false);
	});

	it("refuses a placeholder in the URL before the request leaves", async () => {
		const before = hits;
		const job: ExecutorJob = {
			...syncJob({ scenario: "credential_in_url", url: `${baseUrl}/echo` }),
			credentials: { provider: "fixture", accessToken: "tok_real_9f3a" },
		};
		const run = await runIsolate(fixtureIsolateCode, job, { allowedDomains: ["127.0.0.1"] });
		// The lane's egress refusal: named for the guest, logged once host-side.
		expect(checkpointOf(run.result).refused).toEqual({
			name: "EgressDenied",
			message: "EgressDenied: fetch to 127.0.0.1: a credential placeholder may only be sent in a request header, not in the URL",
		});
		expect(run.logs).toContainEqual({
			level: "warn",
			line: "egress denied: fetch to 127.0.0.1: a credential placeholder may only be sent in a request header, not in the URL",
		});
		expect(hits).toBe(before);
	});

	it("sends a credential in plaintext only to the run's own machine, never to a public name, even one the allowlist names exactly", async () => {
		const before = hits;
		// `api.example.test` is allowlisted exactly and resolves to the fixture
		// server, so the address policy admits it; the credential rule still
		// refuses plaintext because the name is not a loopback or reserved literal.
		const job: ExecutorJob = {
			...syncJob({ scenario: "credential", url: `http://api.example.test:${port}/echo` }),
			credentials: { provider: "fixture", accessToken: "tok_real_9f3a" },
		};
		const failed = await failIsolate(fixtureIsolateCode, job, {
			allowedDomains: ["api.example.test"],
			lookup: async () => [{ address: "127.0.0.1" }],
		});
		expect(failed.message).toContain("EgressDenied: fetch to api.example.test: Credential-bearing requests require HTTPS");
		expect(failed.message).not.toContain("tok_real_9f3a");
		expect(hits).toBe(before);
	});

	it("fetches through the host when the domain is allowed, following redirects", async () => {
		const ok = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `${baseUrl}/ok` }), {
			allowedDomains: ["127.0.0.1"],
		});
		expect(checkpointOf(ok.result)).toMatchObject({
			status: 200,
			ok: true,
			url: `${baseUrl}/ok`,
			redirected: false,
			contentType: "text/plain",
			text: "hello from the fixture server",
		});

		const redirected = await runIsolate(
			fixtureIsolateCode,
			syncJob({ scenario: "fetch", url: `${baseUrl}/redirect` }),
			{ allowedDomains: ["127.0.0.1"] },
		);
		expect(checkpointOf(redirected.result)).toMatchObject({ status: 200, url: `${baseUrl}/ok`, redirected: true });

		const posted = await runIsolate(
			fixtureIsolateCode,
			syncJob({ scenario: "fetch", url: `${baseUrl}/echo`, method: "POST", body: JSON.stringify({ hello: 1 }) }),
			{ allowedDomains: ["127.0.0.1"] },
		);
		const echo = JSON.parse(String(checkpointOf(posted.result).text)) as {
			method: string;
			headers: Record<string, string>;
			body: string;
		};
		expect(echo.method).toBe("POST");
		expect(echo.headers["x-fixture"]).toBe("yes");
		expect(echo.headers["content-type"]).toBe("application/json");
		expect(JSON.parse(echo.body)).toEqual({ hello: 1 });
	});

	it("honours an exact hostname entry at the address it resolves to, not only at the name", async () => {
		// `allowedDomains` documents that naming `localhost` is how a self-hosted
		// install reaches its own services. The egress transport must keep that
		// promise at the ADDRESS too: `localhost` resolves into loopback, which
		// is reserved, so the exact entry has to be the dispatcher's exemption,
		// not only a match for the name.
		const port = new URL(baseUrl).port;
		const named = await runIsolate(
			fixtureIsolateCode,
			syncJob({ scenario: "fetch", url: `http://localhost:${port}/ok` }),
			{ allowedDomains: ["localhost"] },
		);
		expect(checkpointOf(named.result)).toMatchObject({ status: 200, text: "hello from the fixture server" });
	});

	it("denies a fetch to an undeclared domain, on the first request and on a redirect hop", async () => {
		const direct = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `${baseUrl}/ok` }), {
			allowedDomains: ["example.com"],
		});
		expect(direct.message).toContain("fetch to 127.0.0.1 is not permitted");
		expect(direct.message).toContain("this run may reach: example.com");
		expect(direct.exitReason).toBe("error_message");

		const hop = await failIsolate(
			fixtureIsolateCode,
			syncJob({ scenario: "fetch", url: `${baseUrl}/redirect-elsewhere` }),
			{ allowedDomains: ["127.0.0.1"] },
		);
		expect(hop.message).toContain("fetch to localhost is not permitted");

		// An IP literal never matches as a "subdomain" of a shorter suffix. The
		// hermetic form of this rule, over public literals the fixture server
		// cannot host, is in isolate-executor-options.test.ts.
		const sub = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `${baseUrl}/ok` }), {
			allowedDomains: ["0.0.1"],
		});
		expect(sub.message).toContain("fetch to 127.0.0.1 is not permitted");
	});

	it("denies reserved address space whether or not an allowlist is supplied, before a request leaves", async () => {
		// The default allowlist is unrestricted (the deleted process lane had no
		// allowlist at all), but reserved space is never reachable unless an
		// exact entry names it — and the fixture server is on loopback, so the
		// default denies here for that reason. The address rule itself is the
		// egress transport's, pinned in
		// packages/connector-worker/src/__tests__/egress-transport.test.ts,
		// which needs no network.
		const before = hits;
		const byDefault = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `${baseUrl}/ok` }));
		expect(byDefault.message).toContain("fetch to 127.0.0.1 is not permitted");
		expect(byDefault.message).toContain("reserved and internal hosts are never reachable");
		expect(byDefault.exitReason).toBe("error_message");

		// An EMPTY list is deny-all in the shared grammar, the same as for every
		// other consumer: the allowlist refuses before the address is even asked.
		const explicit = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `${baseUrl}/ok` }), {
			allowedDomains: [],
		});
		expect(explicit.message).toContain("fetch to 127.0.0.1 is not permitted");
		expect(explicit.message).toContain("this run has no allowed domains");

		// A non-empty allowlist that does not name the host denies for the other
		// reason, and names what the run may reach.
		const restricted = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `${baseUrl}/ok` }), {
			allowedDomains: ["example.com"],
		});
		expect(restricted.message).toContain("this run may reach: example.com");
		expect(hits).toBe(before);
	});

	it("rejects a non-http(s) scheme before Node's fetch sees it, from the guest fetch and from the raw host bridge", async () => {
		const before = hits;
		const message = "only http: and https: URLs are supported on the isolate lane";
		const guest = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `ftp://127.0.0.1:${port}/ok` }), {
			allowedDomains: ["127.0.0.1"],
		});
		expect(guest.message).toContain(message);

		// 127.0.0.1 is allowlisted, so only the scheme check can deny this one.
		const ftp = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "raw_fetch", url: `ftp://127.0.0.1:${port}/ok` }), {
			allowedDomains: ["127.0.0.1"],
		});
		expect(checkpointOf(ftp.result)).toMatchObject({ outcome: "rejected", message: expect.stringContaining(message) });

		// A data: URL has no host for the allowlist to judge; without the scheme
		// check Node's fetch would resolve it locally.
		const data = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "raw_fetch", url: "data:text/plain,hello" }), {
			allowedDomains: ["127.0.0.1"],
		});
		expect(checkpointOf(data.result)).toMatchObject({ outcome: "rejected", message: expect.stringContaining(message) });
		expect(hits).toBe(before);
	});

	it("streams a response body to the guest chunk by chunk, decoding a character split across chunks", async () => {
		acks = 0;
		const streamed = await runIsolate(
			fixtureIsolateCode,
			syncJob({ scenario: "stream", url: `${baseUrl}/sse`, ackUrl: `${baseUrl}/ack` }),
			{ allowedDomains: ["127.0.0.1"], timeoutMs: 15_000 },
		);
		// Two chunks, each acknowledged before the server wrote the next: the
		// guest saw the first while the body was still open. The split `é`
		// (0xC3 in chunk one, 0xA9 in chunk two) comes out whole because the
		// guest's TextDecoder kept the partial sequence across the two decodes.
		expect(checkpointOf(streamed.result)).toEqual({
			chunks: ["data: caf", "é\n\ndata: second\n\n"],
			tail: "",
			text: SSE_TEXT,
			usedBeforeRead: false,
			usedAfterRead: true,
		});
		expect(acks).toBe(2);
	});

	it("aborting the signal after the headers errors the body stream and releases the upstream socket", async () => {
		const before = dripClosed;
		const aborted = await runIsolate(
			fixtureIsolateCode,
			syncJob({ scenario: "stream_abort", url: `${baseUrl}/drip`, afterUrl: `${baseUrl}/ok` }),
			{ allowedDomains: ["127.0.0.1"], timeoutMs: 15_000 },
		);
		expect(checkpointOf(aborted.result)).toEqual({
			first: "data: first\n\n",
			rejection: "AbortError",
			after: "hello from the fixture server",
		});
		await until(() => dripClosed === before + 1);
	});

	it("cancelling the body releases the upstream socket and leaves the run running", async () => {
		const before = dripClosed;
		const cancelled = await runIsolate(
			fixtureIsolateCode,
			syncJob({ scenario: "stream_cancel", url: `${baseUrl}/drip`, afterUrl: `${baseUrl}/ok` }),
			{ allowedDomains: ["127.0.0.1"], timeoutMs: 15_000 },
		);
		expect(checkpointOf(cancelled.result)).toEqual({
			first: "data: first\n\n",
			after: "hello from the fixture server",
			bodyUsed: true,
		});
		await until(() => dripClosed === before + 1);
	});

	it("gives a body-less response a null body and an empty text, and every other response a stream", async () => {
		const empty = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `${baseUrl}/empty` }), {
			allowedDomains: ["127.0.0.1"],
		});
		expect(checkpointOf(empty.result)).toMatchObject({ status: 204, hasBody: false, bytes: 0, text: "" });

		const full = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `${baseUrl}/ok` }), {
			allowedDomains: ["127.0.0.1"],
		});
		expect(checkpointOf(full.result)).toMatchObject({ status: 200, hasBody: true });
	});

	it("caps the response body", async () => {
		const failure = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `${baseUrl}/big` }), {
			allowedDomains: ["127.0.0.1"],
			fetchBodyBytes: 1024,
		});
		expect(failure.message).toMatch(/body/i);
		expect(failure.message).toContain("1024");
		expect(failure.exitReason).toBe("error_message");

		const fits = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "fetch", url: `${baseUrl}/big` }), {
			allowedDomains: ["127.0.0.1"],
			fetchBodyBytes: 8192,
		});
		expect(checkpointOf(fits.result).bytes).toBe(4096);

		// The cap is charged as the guest pulls, never for what it did not take:
		// `/drip` is unbounded, which no buffering lane could ever fit under a
		// cap, yet reading its first chunk and cancelling is fine at the minimum.
		const before = dripClosed;
		const partial = await runIsolate(
			fixtureIsolateCode,
			syncJob({ scenario: "stream_cancel", url: `${baseUrl}/drip`, afterUrl: `${baseUrl}/ok` }),
			{ allowedDomains: ["127.0.0.1"], fetchBodyBytes: 1024 },
		);
		expect(checkpointOf(partial.result)).toMatchObject({ first: "data: first\n\n" });
		await until(() => dripClosed === before + 1);
	});

	it("kills a synchronous infinite loop at the wall-clock budget", async () => {
		const started = Date.now();
		const failure = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "loop" }), { timeoutMs: 1500 });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(failure.message).toContain("Feed execution timed out after 1500ms");
		expect(failure.exitReason).toBe("timeout");
	});

	it("kills an infinite loop that starts after an await (wall clock, not V8's sync timeout)", async () => {
		const started = Date.now();
		const failure = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "loop_after_await" }), {
			timeoutMs: 1500,
		});
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(failure.message).toContain("Feed execution timed out after 1500ms");
		expect(failure.exitReason).toBe("timeout");
	});

	it("kills allocation past the memory limit", async () => {
		const failure = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "alloc" }), {
			memoryMb: 32,
			timeoutMs: 30_000,
		});
		expect(failure.exitReason).toBe("oom");
		expect(failure.message).toMatch(/out of memory/i);
		expect(failure.message).toContain("32 MB");
	});

	it("ends the run when a timer callback throws: the guest error arrives through `fatal` and keeps its name", async () => {
		const started = Date.now();
		const failure = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "timer_throw" }), { timeoutMs: 30_000 });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(failure.exitReason).toBe("error_message");
		expect(failure.name).toBe("RangeError");
		expect(failure.message).toContain("fixture timer exploded");
	});

	it("ends the run when an event hook rejects and surfaces the hook's own error", async () => {
		const executor = new IsolateExecutor({ timeoutMs: 30_000, logSink: () => undefined });
		const hooks: ExecutionHooks = {
			onEventChunk: async () => {
				throw new Error("event sink is down");
			},
		};
		const started = Date.now();
		const failure = await executor.execute(fixtureIsolateCode, syncJob({ scenario: "emit", count: 10 }), hooks).then(
			() => null,
			(error: unknown) => error as LaneError,
		);
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(failure?.message).toBe("event sink is down");
		expect(failure?.exitReason).toBeUndefined();
	});

	it("terminates when one bridge message exceeds the cap and reports it as a crash", async () => {
		const failure = await failIsolate(fixtureIsolateCode, syncJob({ scenario: "big_message", count: 65_536 }), {
			messageBytes: 4096,
			timeoutMs: 30_000,
		});
		expect(failure.exitReason).toBe("crash");
		expect(failure.message).toContain("a single bridge message exceeded 4096 bytes");

		const fits = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "big_message", count: 1024 }), {
			messageBytes: 4096,
		});
		expect(fits.checkpoints).toEqual([{ blob: "x".repeat(1024) }]);
	});

	it("reports a thrown connector error in the same shape through either entry point", async () => {
		const job = syncJob({ scenario: "throw" });
		const [isolate, proc] = await Promise.all([
			failIsolate(fixtureIsolateCode, job),
			failViaRuntime(fixtureIsolateCode, job),
		]);
		const shape = (e: LaneError) => ({
			name: e.name,
			message: e.message,
			exitReason: e.exitReason,
			httpStatus: e.httpStatus,
		});
		expect(shape(isolate)).toEqual(shape(proc));
		expect(isolate.message).toContain("fixture exploded");
		expect(isolate.httpStatus).toBe(418);
	});

	it("forwards console output through the redactor", async () => {
		const secret = "ghp_fixtureSecretTokenValue0123456789";
		const run = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "console", secret }));
		const text = run.logs.map((l) => l.line).join("\n");
		expect(text).not.toContain(secret);
		expect(text).toContain("Authorization: [REDACTED]");
		expect(text).toContain("Cookie: [REDACTED]");
		expect(run.logs.find((l) => l.level === "warn")?.line).toBe("plain warning");
		expect(run.logs.find((l) => l.level === "info")?.line).toBe("info line");
	});

	it("exposes only the job env to the guest and merges it into config, through either entry point", async () => {
		const job = syncJob({ scenario: "env" }, { FIXTURE_ENV: "from-job" });
		const [isolate, proc] = await Promise.all([runIsolate(fixtureIsolateCode, job), runViaRuntime(fixtureIsolateCode, job)]);
		expect(checkpointOf(isolate.result)).toEqual({ fixture_env: "from-job", config_fixture_env: "from-job" });
		expect(checkpointOf(isolate.result).config_fixture_env).toEqual(checkpointOf(proc.result).config_fixture_env);
	});

	it("orders timers, immediates and microtasks like Node", async () => {
		const run = await runIsolate(fixtureIsolateCode, syncJob({ scenario: "timers" }));
		const order = checkpointOf(run.result).order as string[];
		expect(order.slice(0, 3)).toEqual(["sync", "micro", "promise"]);
		expect(order).not.toContain("cancelled");
		expect(order.indexOf("t0")).toBeLessThan(order.indexOf("t10"));
		expect(order.indexOf("imm")).toBeLessThan(order.indexOf("t10"));
		expect(order.indexOf("iv1")).toBeLessThan(order.indexOf("iv2"));
		expect(order.filter((x) => x.startsWith("iv"))).toEqual(["iv1", "iv2"]);
		expect(order.at(-1)).toBe("t10");
	});

	it("prelude globals behave like Node's for the fixture's mixed probe", async () => {
		const job = syncJob({ scenario: "prelude" });
		const [isolate, proc] = await Promise.all([runIsolate(fixtureIsolateCode, job), runViaRuntime(fixtureIsolateCode, job)]);
		expect(checkpointOf(isolate.result)).toEqual(checkpointOf(proc.result));
		expect(checkpointOf(isolate.result)).toMatchObject({
			href: "https://example.com/a/c%20d?x=1&y=a%20b#frag%20ment",
			origin: "https://example.com",
			b64: "aGVsbG8sIGlzb2xhdGU=",
			fromB64: "hello, isolate",
			aborted: true,
			abortFired: true,
			abortReason: "AbortError",
			throwIfAbortedName: "AbortError",
			timeoutReason: "TimeoutError",
		});
	});
});

// ---------------------------------------------------------------------------
// Prelude differential: guest vs Node over 100+ inputs each
// ---------------------------------------------------------------------------

/** Deterministic PRNG so a failure names a reproducible input. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)] as T;
}

/** Runs `probeSource` (a function expression) in a fresh guest with `input`, returning its JSON result. */
async function probeGuest<T>(probeSource: string, input: unknown): Promise<T> {
	const host = await IsolateHost.create({
		ivm,
		memoryMb: 128,
		messageBytes: 16 * 1024 * 1024,
		env: {},
		sync: { log: () => undefined, fatal: () => undefined, fetchAbort: () => undefined },
		async: { sleep: async (ms: unknown) => new Promise((r) => setTimeout(r, Number(ms))) },
	});
	try {
		const literal = JSON.stringify(JSON.stringify(input)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
		const raw = await host.run(`JSON.stringify((${probeSource})(JSON.parse(${literal})))`, { timeoutMs: 30_000 });
		return JSON.parse(String(raw)) as T;
	} finally {
		host.dispose();
	}
}

/** The same probe evaluated by Node itself. */
function probeNode<T>(probeSource: string, input: unknown): T {
	// biome-ignore lint/security/noGlobalEval: differential oracle over Node's own globals
	const fn = (0, eval)(`(${probeSource})`) as (input: unknown) => unknown;
	return JSON.parse(JSON.stringify(fn(input))) as T;
}

async function differential(name: string, probeSource: string, input: unknown): Promise<void> {
	const [guest, node] = await Promise.all([probeGuest<unknown[]>(probeSource, input), probeNode<unknown[]>(probeSource, input)]);
	const inputs = input as unknown[];
	expect(guest.length, `${name}: result count`).toBe(node.length);
	for (let i = 0; i < node.length; i += 1) {
		expect(guest[i], `${name}[${i}] for ${JSON.stringify(inputs[i])}`).toEqual(node[i]);
	}
}

const URL_PROBE = String.raw`function (cases) {
  return cases.map(function (c) {
    var input = c[0], base = c[1];
    var canParse = base === undefined ? URL.canParse(input) : URL.canParse(input, base);
    try {
      var u = base === undefined ? new URL(input) : new URL(input, base);
      var sp = []; u.searchParams.forEach(function (v, k) { sp.push([k, v]); });
      return { href: u.href, origin: u.origin, protocol: u.protocol, username: u.username, password: u.password,
        host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
        toString: String(u), json: u.toJSON(), searchParams: sp, canParse: canParse };
    } catch (e) {
      return { error: e.constructor.name, canParse: canParse };
    }
  });
}`;

const URL_SETTER_PROBE = String.raw`function (cases) {
  return cases.map(function (c) {
    try {
      var u = new URL(c.start);
      Object.keys(c.set).forEach(function (k) { u[k] = c.set[k]; });
      var sp = []; u.searchParams.forEach(function (v, k) { sp.push([k, v]); });
      return { href: u.href, host: u.host, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
        username: u.username, password: u.password, protocol: u.protocol, origin: u.origin, searchParams: sp };
    } catch (e) { return { error: e.constructor.name }; }
  });
}`;

const PARAMS_PROBE = String.raw`function (inputs) {
  return inputs.map(function (input) {
    var p = new URLSearchParams(input);
    var entries = []; p.forEach(function (v, k) { entries.push([k, v]); });
    var sorted = new URLSearchParams(input); sorted.sort();
    var mutated = new URLSearchParams(input);
    mutated.append('zz', 'a b&c'); mutated.set('a', 'set'); mutated.delete('b');
    return { entries: entries, str: p.toString(), sorted: sorted.toString(), size: p.size,
      getA: p.get('a'), getAllA: p.getAll('a'), hasA: p.has('a'), hasAv: p.has('a', '1'),
      keys: Array.from(p.keys()), values: Array.from(p.values()), spread: Array.from(p), mutated: mutated.toString() };
  });
}`;

const TEXT_PROBE = String.raw`function (input) {
  var enc = new TextEncoder(), dec = new TextDecoder(), fatal = new TextDecoder('utf-8', { fatal: true });
  var ignoreBom = new TextDecoder('utf-8', { ignoreBOM: true });
  var out = [];
  input.strings.forEach(function (s) {
    var buf = new Uint8Array(6); var r = enc.encodeInto(s, buf);
    out.push({ encoded: Array.from(enc.encode(s)), roundTrip: dec.decode(enc.encode(s)), encodeInto: [r.read, r.written, Array.from(buf)] });
  });
  input.bytes.forEach(function (b) {
    var arr = new Uint8Array(b);
    var f; try { f = fatal.decode(arr); } catch (e) { f = 'ERR:' + e.constructor.name; }
    out.push({ decoded: dec.decode(arr), fatal: f, ignoreBom: ignoreBom.decode(arr), viaBuffer: dec.decode(arr.buffer), viaDataView: dec.decode(new DataView(arr.buffer)) });
  });
  out.push({ labels: [new TextDecoder().encoding, new TextDecoder('UTF-8').encoding, new TextDecoder('unicode-1-1-utf-8').encoding, new TextEncoder().encoding] });
  return out;
}`;

const BASE64_PROBE = String.raw`function (input) {
  var out = [];
  input.plain.forEach(function (s) { try { out.push(btoa(s)); } catch (e) { out.push('ERR:' + e.name); } });
  input.encoded.forEach(function (s) { try { out.push(atob(s)); } catch (e) { out.push('ERR:' + e.name); } });
  return out;
}`;

function urlCases(): [string, string?][] {
	// Parsing is the host's (Node's own URL), so this is a wiring check, not a
	// parser conformance suite: components, errors, IDNA, relative resolution.
	const absolute = [
		"http://example.com",
		"HTTP://EXAMPLE.com:80/A/./B/../C?Q=1#F",
		"https://user:p%40ss@example.com:8443/x y?a=1&a=2#h",
		"http://us er@example.com/",
		"http://example.com/a^b?c^d#e^f",
		"http://example.com/€?€#€",
		"http://example.com/%zz/%2e%2E/..",
		"http://exämple.com/",
		"http://例え.jp/",
		"http://xn--r8jz45g.jp/",
		"http://[::1]:8080/",
		"http://[::ffff:1.2.3.4]/",
		"http://0x7f.1/",
		"http://4294967296/",
		"http://1.2.3.4:5/",
		"file:///C:/Windows/../x",
		"file://host/share",
		"ftp://example.com:21/",
		"ws://example.com:80/",
		"foo://bar/baz?q#h",
		"foo:bar baz",
		"mailto:a@b.com",
		"data:text/plain,hello world",
		"javascript:alert(1)",
		"blob:https://example.com/uuid",
		"  http://example.com/  ",
		"\thttp://exam\nple.com/\r",
		"http://",
		"http:",
		"http:/example.com",
		"http:///example.com",
		"not a url",
		"",
		"//example.com/x",
		"/x",
		"?q",
		"#h",
	];
	const base = "http://example.com/a/b?q#f";
	const relative: [string, string][] = [
		["", base],
		[".", base],
		["..", base],
		["../..", base],
		["c", base],
		["/c", base],
		["//other.com/c", base],
		["?x", base],
		["#y", base],
		["https:c", base],
		["\\c", base],
		["%2e%2e/c", base],
		["a b", base],
		["c", "foo:opaque"],
		["#f", "foo:opaque"],
		["//h/c", "file:///x/y"],
		["x", "not a url"],
	];
	return [...absolute.map((u): [string, string?] => [u]), ...relative];
}

function paramsInputs(): string[] {
	const fixed = [
		"",
		"a=1",
		"a=1&b=2&a=3",
		"?a=1",
		"a",
		"a&b",
		"a=&b",
		"=x",
		"=",
		"&",
		"&&a=1&&",
		"a=b=c",
		"a%20b=c%20d",
		"a+b=c+d",
		"a=%2B",
		"a=%zz",
		"a=%",
		"a=%2",
		"a=é",
		"a=%C3%A9",
		"a=€&b=𝄞",
		"a=%E2%82%AC",
		"a=%E2%82",
		"a=%FF",
		"a=%00",
		"a=1&A=2",
		"b=2&a=1&c=3&a=0",
		"a[]=1&a[]=2",
		"a=1;b=2",
		"a=1&b=2#frag",
		"a=1&&b=2&",
		"a==1",
		"a=1=2=3",
		"a=+",
		"+=+",
		"%20=%20",
		"a=~!*()'",
		'a="quoted"',
		"a=<b>",
		"a=a/b",
		"a=a?b",
		"a=a&b=b&c=c&d=d&e=e&f=f",
		"z=1&y=2&x=3&w=4",
		"a=%D8%00",
		"a=%ED%A0%80",
	];
	const rand = mulberry32(7);
	// No raw non-ASCII here: Node's own parser truncates such code points to
	// Latin-1 when a `%` is present in the same input (a known quirk), so those
	// mixed inputs have no oracle. Non-ASCII without `%` is in the fixed list.
	const alphabet = ["a", "b", "=", "&", "+", "%", "2", "0", " ", "%20", "%2B", "%26", "%3D", "z", "%C3%A9"];
	const generated: string[] = [];
	for (let i = 0; i < 80; i += 1) {
		let s = "";
		const len = 1 + Math.floor(rand() * 12);
		for (let j = 0; j < len; j += 1) s += pick(rand, alphabet);
		generated.push(s);
	}
	return [...fixed, ...generated];
}

function textInputs(): { strings: string[]; bytes: number[][] } {
	const strings = [
		"",
		"a",
		"abc",
		"héllo",
		"€",
		"𝄞",
		"\uD800",
		"\uDC00",
		"a\uD800",
		"\uD800b",
		"a\uDC00b",
		"\uD83D\uDE00",
		"ab\uD83Dc",
		"\uDE00\uD83D",
		"\uFEFFx",
		"\u0000",
		"\u007F\u0080\u00FF",
		"\u07FF\u0800\uFFFF",
		"\u{10000}\u{10FFFF}",
		"mixed é € 𝄞 \uD800 end",
		"\t\n\r ",
	];
	const bytes: number[][] = [
		[],
		[0x61],
		[0xc3, 0xa9],
		[0xe2, 0x82, 0xac],
		[0xf0, 0x9d, 0x84, 0x9e],
		[0xc0, 0x80],
		[0xc1, 0xbf],
		[0xe0, 0x80, 0x80],
		[0xe0, 0x9f, 0xbf],
		[0xed, 0xa0, 0x80],
		[0xed, 0xbf, 0xbf],
		[0xf0, 0x8f, 0xbf, 0xbf],
		[0xf4, 0x90, 0x80, 0x80],
		[0xf5, 0x80, 0x80, 0x80],
		[0xf8, 0x88, 0x80, 0x80, 0x80],
		[0xfe],
		[0xff],
		[0x80],
		[0xbf],
		[0xc2],
		[0xe2, 0x82],
		[0xf0, 0x9f, 0x98],
		[0x61, 0xe2, 0x82],
		[0x61, 0xe2, 0x82, 0x62],
		[0xe2, 0x61],
		[0xf0, 0x9f, 0x61],
		[0xef, 0xbb, 0xbf],
		[0xef, 0xbb, 0xbf, 0x61],
		[0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61],
		[0x61, 0xef, 0xbb, 0xbf],
		[0xf0, 0x90, 0x80, 0x80],
		[0xf4, 0x8f, 0xbf, 0xbf],
		[0xdf, 0xbf],
		[0xef, 0xbf, 0xbf],
		[0xef, 0xbf, 0xbd],
		[0x00],
		[0x7f],
		[0xc3, 0xa9, 0xc3],
		[0xe2, 0x82, 0xac, 0xe2, 0x82],
	];
	const rand = mulberry32(11);
	const pool = [
		0x61,
		0x7a,
		0x20,
		0xe9,
		0x20ac,
		0x1d11e,
		0x1f600,
		0xd800,
		0xdbff,
		0xdc00,
		0xdfff,
		0xfeff,
		0x00,
		0x7ff,
		0x800,
		0xffff,
		0x10ffff,
	];
	for (let i = 0; i < 90; i += 1) {
		let s = "";
		const len = Math.floor(rand() * 8);
		for (let j = 0; j < len; j += 1) s += String.fromCodePoint(pick(rand, pool));
		strings.push(s);
	}
	for (let i = 0; i < 90; i += 1) {
		const len = Math.floor(rand() * 9);
		const arr: number[] = [];
		for (let j = 0; j < len; j += 1) arr.push(Math.floor(rand() * 256));
		bytes.push(arr);
	}
	for (const s of strings.slice(0, 20)) bytes.push(Array.from(Buffer.from(s, "utf8")));
	return { strings, bytes };
}

function base64Inputs(): { plain: string[]; encoded: string[] } {
	const plain = ["", "a", "ab", "abc", "abcd", "hello, isolate", "\u0000\u00ff", "é", "€", "\uD800", "a€b", "\u0100"];
	const encoded = [
		"",
		"A",
		"AA",
		"AAA",
		"AAAA",
		"AA==",
		"AA=",
		"AAA=",
		"A===",
		"====",
		"QQ==",
		"QQ",
		"QQ ==",
		"Q\nQ==",
		"Q\tQ\r\n==",
		" QUJD ",
		"QUJD\f",
		"QUJD\u00a0",
		"QU=JD",
		"QUJD=",
		"QUJD==",
		"QUJ=D",
		"Q-JD",
		"Q_JD",
		"QUJD!",
		"QUJD*",
		"QUJDRA",
		"QUJDRA=",
		"QUJDRA==",
		"QUJDRA===",
		"QUJDRQ",
		"QUJDRQ=",
		"QUJDRQ==",
		"QUJDRQ===",
		"aGVsbG8sIGlzb2xhdGU=",
		"aGVsbG8sIGlzb2xhdGU",
		"aGVsbG8sIGlz b2xhdGU=",
		"/w==",
		"//8=",
		"////",
		"+/+/",
		"AB==",
		"AC==",
		"AR==",
		"AQ==",
		"Ag==",
	];
	const rand = mulberry32(23);
	for (let i = 0; i < 100; i += 1) {
		let s = "";
		const len = Math.floor(rand() * 16);
		for (let j = 0; j < len; j += 1) s += String.fromCharCode(Math.floor(rand() * 256));
		plain.push(s);
		let enc = Buffer.from(s, "latin1").toString("base64");
		const twist = rand();
		if (twist < 0.2) enc = enc.replace(/=+$/, "");
		else if (twist < 0.35) enc = `${enc.slice(0, Math.floor(enc.length / 2))} \n${enc.slice(Math.floor(enc.length / 2))}`;
		else if (twist < 0.45) enc = `${enc}=`;
		else if (twist < 0.55) enc = enc.replace(/[A-Za-z]/, "*");
		encoded.push(enc);
	}
	for (let i = 0; i < 10; i += 1) plain.push(`x${String.fromCharCode(256 + Math.floor(rand() * 1000))}`);
	return { plain, encoded };
}

describe("isolate lane: prelude differential against Node", () => {
	it("URL: parsing, serialization and relative resolution agree with Node, which parses for the guest", async () => {
		const cases = urlCases();
		expect(cases.length).toBeGreaterThanOrEqual(40);
		await differential("URL", URL_PROBE, cases);
	});


	it("URL: property setters", async () => {
		const cases = [
			{ start: "http://example.com/a?b#c", set: { pathname: "x/y z", search: "q=1 2", hash: "h h" } },
			{ start: "http://example.com/", set: { protocol: "https", port: "443" } },
			{ start: "http://example.com/", set: { protocol: "https:", port: "8443" } },
			{ start: "http://example.com/", set: { protocol: "foo" } },
			{ start: "foo://example.com/", set: { protocol: "http" } },
			{ start: "http://example.com/", set: { host: "other.org:81" } },
			{ start: "http://example.com/", set: { hostname: "other.org", port: "0" } },
			{ start: "http://example.com:81/", set: { port: "" } },
			{ start: "http://example.com/", set: { port: "abc" } },
			{ start: "http://example.com/", set: { port: "80" } },
			{ start: "http://example.com/", set: { username: "u s", password: "p:w@" } },
			{ start: "http://example.com/a/b", set: { pathname: "" } },
			{ start: "http://example.com/a/b", set: { pathname: "/../x" } },
			{ start: "http://example.com/a/b", set: { search: "" } },
			{ start: "http://example.com/a/b?q", set: { search: "?" } },
			// searchParams must follow a setter that changes the query, and survive one that does not.
			{ start: "http://example.com/?a=1", set: { search: "b=2&c=3" } },
			{ start: "http://example.com/?a=1", set: { href: "http://other.org/?z=9&z=8" } },
			{ start: "http://example.com/?a=1", set: { pathname: "/p", hash: "#h" } },
			{ start: "http://example.com/a/b#f", set: { hash: "" } },
			{ start: "http://example.com/a/b", set: { hash: "#" } },
			{ start: "http://example.com/a/b", set: { href: "https://x.y/z" } },
			{ start: "http://example.com/a/b", set: { href: "nope" } },
			{ start: "foo:opaque path", set: { pathname: "changed", hash: "h", search: "s" } },
			{ start: "file:///a/b", set: { host: "h", port: "1" } },
			{ start: "http://example.com/", set: { hostname: "[::1]" } },
			{ start: "http://example.com/", set: { hostname: "1.2.3.4" } },
			{ start: "http://example.com/", set: { hostname: "" } },
			{ start: "http://example.com/", set: { host: "" } },
			{ start: "http://example.com/", set: { hostname: "ex ample.com" } },
		];
		await differential("URL setters", URL_SETTER_PROBE, cases);
	});

	it("URLSearchParams over 120+ inputs", async () => {
		const inputs = paramsInputs();
		expect(inputs.length).toBeGreaterThanOrEqual(120);
		await differential("URLSearchParams", PARAMS_PROBE, inputs);
	});

	it("TextEncoder / TextDecoder over 100+ strings and 100+ byte sequences", async () => {
		const input = textInputs();
		expect(input.strings.length).toBeGreaterThanOrEqual(100);
		expect(input.bytes.length).toBeGreaterThanOrEqual(100);
		const [guest, node] = await Promise.all([
			probeGuest<unknown[]>(TEXT_PROBE, input),
			probeNode<unknown[]>(TEXT_PROBE, input),
		]);
		expect(guest.length).toBe(node.length);
		const labels = [...input.strings.map((s) => `string ${JSON.stringify(s)}`), ...input.bytes.map((b) => `bytes ${JSON.stringify(b)}`), "labels"];
		for (let i = 0; i < node.length; i += 1) expect(guest[i], labels[i]).toEqual(node[i]);
	});

	it("atob / btoa over 100+ inputs each", async () => {
		const input = base64Inputs();
		expect(input.plain.length).toBeGreaterThanOrEqual(100);
		expect(input.encoded.length).toBeGreaterThanOrEqual(100);
		const [guest, node] = await Promise.all([
			probeGuest<unknown[]>(BASE64_PROBE, input),
			probeNode<unknown[]>(BASE64_PROBE, input),
		]);
		expect(guest.length).toBe(node.length);
		const labels = [...input.plain.map((s) => `btoa ${JSON.stringify(s)}`), ...input.encoded.map((s) => `atob ${JSON.stringify(s)}`)];
		for (let i = 0; i < node.length; i += 1) expect(guest[i], labels[i]).toEqual(node[i]);
	});

});
