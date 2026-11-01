/**
 * Contract tests for the shared server lifecycle spine.
 *
 * The point of these tests is to lock the invariants that drift between
 * `server.ts` (Postgres) and `start-local.ts` (embedded Postgres) used to break (issue
 * #948 + the #943 7-hygiene catch-up):
 *
 *   1. Middleware ordering on the Hono wrapper:
 *      peer-address stash → env-inject → HTTP span → request logger → structured-5xx-capture → onError
 *   2. Route mounts: `/lobu` mounted only when lobuApp is non-null; `/` always.
 *   3. Shutdown drains in-flight requests before gateway/db teardown.
 *   4. `serializeBootError` walks nested cause chains and never returns `{}`.
 *
 * The wrapper-app and serializer assertions exercise real code paths, and the
 * live-drain case boots the real lifecycle against an ephemeral HTTP server.
 */

import http from "node:http";
import net from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createSpan, currentTraceLogFields, initTracing, runInSpanContext, shutdownTracing, SpanKind, SpanStatusCode } from "@lobu/core";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";

// This suite replaces the wrapper's collaborators. Other integration suites
// import the real wrapper, so its cached module must not cross this boundary.
vi.hoisted(() => vi.resetModules());
afterAll(() => vi.resetModules());

// --- heavy collaborators of createServerLifecycle, replaced so the spine
// --- boots in-process against a real ephemeral HTTP server.
// Spread the real module: this mock leaks into other files sharing the worker,
// and a hand-listed shape silently drops any export db/client later gains —
// which surfaces far away as `No "<export>" export is defined on the mock`
// inside whichever module happens to load under it. db/client has no
// import-time side effects (the pool is created lazily by getDb), so keeping
// the real exports costs nothing.
vi.mock("../db/client", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	closeDbSingleton: vi.fn(async () => {}),
}));
vi.mock("../dev-vite", () => ({ mountViteDev: vi.fn(async () => null) }));
vi.mock("../workspace", () => ({
	initWorkspaceProvider: vi.fn(async () => undefined),
}));
// initLobuGateway must return the SAME app instance the test wires routes
// onto — Hono's `.route()` copies the sub-app's routes at mount time, so a
// late-built app would silently 404.
const gwAppSlot = vi.hoisted(() => ({ app: null as unknown }));
vi.mock("../lobu/gateway", () => ({
	initLobuGateway: vi.fn(async () => gwAppSlot.app),
	stopLobuGateway: vi.fn(async () => {}),
	getLobuCoreServices: vi.fn(() => ({ getQueue: vi.fn(() => ({})) })),
}));
vi.mock("../scheduled/check-stalled-executions", () => ({
	startStaleRunReaper: vi.fn(() => vi.fn()),
}));
vi.mock("../scheduled/jobs", () => ({
	bootTaskScheduler: vi.fn(async () => ({ stop: vi.fn(async () => {}) })),
}));
vi.mock("../connectors/webhook-delivery", () => ({
	startConnectorRecordWorker: vi.fn(async () => {}),
}));
vi.mock("../scheduled/embedded-connector-worker", () => ({
	startEmbeddedConnectorWorker: vi.fn(() => null),
}));

vi.mock("../utils/logger", () => {
	// Recursive `child` is required because several modules (e.g.
	// auth/subject-identities.ts) call `logger.child(...)` at module-load
	// time. Match pino's interface so any caller's `.info / .warn / .error /
	// .child` works without instrumentation.
	const make = (): Record<string, unknown> => {
		const self: Record<string, unknown> = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			trace: vi.fn(),
			fatal: vi.fn(),
		};
		self.child = vi.fn(() => self);
		return self;
	};
	const logger = make();
	return { default: logger };
});

// The wrapper imports `mainApp` from `./index` to mount at `/`. The real
// module pulls in ~1370 lines of routes + auth + connector graphs we don't
// need here, and forces a Postgres connection at load time. Replace it with
// a real Hono app constructed via async `Hono` import inside the factory so
// the mock matches the same shape the wrapper expects (Hono with `.fetch`).
vi.mock("../index", async () => {
	const { Hono } = await import("hono");
	const app = new Hono();
	app.get("/health", (c) => c.text("main-ok"));
	return {
		app,
		setViteDev: vi.fn(),
		isAuthorizationReadOnlyToolName: () => false,
	};
});

describe("serializeBootError", () => {
	it("returns message + stack for a plain Error", async () => {
		const { serializeBootError } = await import("../server-lifecycle");
		const err = new Error("boom");
		const out = serializeBootError(err);
		expect(out.type).toBe("Error");
		expect(out.message).toBe("boom");
		expect(typeof out.stack).toBe("string");
	});

	it("walks nested cause chains", async () => {
		const { serializeBootError } = await import("../server-lifecycle");
		const inner = new Error("inner");
		const outer = new Error("outer", { cause: inner });
		const out = serializeBootError(outer);
		expect(out.message).toBe("outer");
		const cause = out.cause as Record<string, unknown> | undefined;
		expect(cause?.message).toBe("inner");
	});

	it("preserves ZodError-shaped issues array", async () => {
		const { serializeBootError } = await import("../server-lifecycle");
		const err = Object.assign(new Error("validation failed"), {
			issues: [{ path: ["DATABASE_URL"], message: "required" }],
		});
		const out = serializeBootError(err);
		expect(out.issues).toEqual([
			{ path: ["DATABASE_URL"], message: "required" },
		]);
	});

	it("handles non-object values without throwing", async () => {
		const { serializeBootError } = await import("../server-lifecycle");
		expect(serializeBootError("a string")).toEqual({
			value: "a string",
			type: "string",
		});
		expect(serializeBootError(null)).toEqual({ value: "null" });
		expect(serializeBootError(undefined)).toEqual({ value: "undefined" });
	});
});

describe("reportBootFailure", () => {
	function captureStderr(fn: () => void): string {
		let out = "";
		const write = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((chunk: string | Uint8Array) => {
				out += typeof chunk === "string" ? chunk : chunk.toString();
				return true;
			});
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((() => {
				throw new Error("__exit__");
			}) as never);
		try {
			fn();
		} catch (e) {
			if ((e as Error).message !== "__exit__") throw e;
		} finally {
			write.mockRestore();
			exit.mockRestore();
		}
		return out;
	}

	it("prints a BootConfigError cleanly — no prefix, no stack", async () => {
		const { reportBootFailure } = await import("../server-lifecycle");
		const { BootConfigError } = await import("../utils/errors");
		const { default: logger } = await import("../utils/logger");
		const error = logger.error as ReturnType<typeof vi.fn>;
		error.mockClear();
		const out = captureStderr(() =>
			reportBootFailure(new BootConfigError("run `lobu init` first")),
		);
		expect(out).toContain("run `lobu init` first");
		expect(out).not.toContain("Failed to start server:");
		expect(out).not.toMatch(/\n\s+at /);
		expect(error).not.toHaveBeenCalled();
	});

	it("prints a plain Error with the crash prefix and stack", async () => {
		const { reportBootFailure } = await import("../server-lifecycle");
		const { default: logger } = await import("../utils/logger");
		const error = logger.error as ReturnType<typeof vi.fn>;
		error.mockClear();
		const out = captureStderr(() => reportBootFailure(new Error("kaboom")));
		expect(out).toContain("Failed to start server:");
		expect(out).toContain("kaboom");
		expect(out).toMatch(/\n\s+at /);
		expect(error).toHaveBeenCalledOnce();
	});
});

describe("buildWrapperApp", () => {
	it("isolates concurrent HTTP traces, parents async work, and exports only normalized request attributes", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { Hono } = await import("hono");
		const exporter = new InMemorySpanExporter();
		await shutdownTracing();
		initTracing({ serviceName: "wrapper-tracing-test", spanProcessors: [new SimpleSpanProcessor(exporter)] });
		try {
			const app = new Hono();
			app.get("/records/:id", async (c) => {
				const id = c.req.param("id");
				c.set("user", { id, email: "private@example.test", name: "Private", emailVerified: true });
				c.set("organizationId", `org-${id}`);
				await new Promise((resolve) => setTimeout(resolve, 2));
				const child = createSpan("async child");
				child?.end();
				return c.json(currentTraceLogFields());
			});
			const wrapper = buildWrapperApp({} as never, app, app as never);
			const ambient = createSpan("unrelated ambient work");
			const [first, second] = await runInSpanContext(ambient, () => Promise.all([
				wrapper.request("/lobu/records/synthetic-one?token=private-query", { headers: {
					traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
					"cf-ray": "a53b9d57c926253b-LHR", authorization: "Bearer private-token",
				} }),
				wrapper.request("/records/synthetic-two?email=private@example.test", { headers: {
					traceparent: "invalid-private-header", "cf-ray": "private@example.test",
				} }),
			]));
			ambient?.end();
			expect(first.status).toBe(200);
			expect(second.status).toBe(200);
			const spans = exporter.getFinishedSpans();
			const requests = spans.filter((span) => span.kind === SpanKind.SERVER);
			expect(requests).toHaveLength(2);
			for (const [id, response, route] of [["synthetic-one", first, "/lobu/records/:id"], ["synthetic-two", second, "/records/:id"]] as const) {
				const request = requests.find((span) => span.attributes["user.id"] === id)!;
				expect(request.attributes).toMatchObject({ "http.request.method": "GET", "http.route": route, "http.response.status_code": 200, "lobu.org_id": `org-${id}` });
				expect((await response.json()).trace_id).toBe(request.spanContext().traceId);
				expect(request.spanContext().traceId).not.toBe(ambient?.spanContext().traceId);
				expect(spans.filter((span) => span.name === "async child" && span.parentSpanContext?.spanId === request.spanContext().spanId)).toHaveLength(1);
				if (id === "synthetic-one") {
					expect(request.spanContext().traceId).toBe("11111111111111111111111111111111");
					expect(request.parentSpanContext?.spanId).toBe("2222222222222222");
					expect(request.attributes.cf_ray).toBe("a53b9d57c926253b");
				} else {
					expect(request.parentSpanContext).toBeUndefined();
					expect(request.attributes.cf_ray).toBeUndefined();
				}
			}
			expect(JSON.stringify(requests.map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })))).not.toMatch(/private-query|private-token|private@example|invalid-private-header/);
		} finally {
			await shutdownTracing();
		}
	});

	it("ends HTTP error spans for returned and thrown failures without exporting error text", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { Hono } = await import("hono");
		const exporter = new InMemorySpanExporter();
		await shutdownTracing();
		initTracing({ serviceName: "wrapper-failure-test", spanProcessors: [new SimpleSpanProcessor(exporter)] });
		try {
			const app = new Hono();
			app.get("/returned", (c) => c.json({ error: "private-returned-error" }, 500));
			app.get("/thrown", () => { throw new Error("private-thrown-error"); });
			const wrapper = buildWrapperApp({} as never, app);
			for (const path of ["returned", "thrown"]) expect((await wrapper.request(`/lobu/${path}`)).status).toBe(500);
			expect((await wrapper.request("/private-unmatched-path?token=private-query")).status).toBe(404);
			expect((await wrapper.request("/unknown", { method: "PRIVATE_METHOD" })).status).toBe(404);
			const requests = exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER);
			expect(requests).toHaveLength(4);
			expect(requests.filter((span) => span.attributes["http.response.status_code"] === 500).map((span) => span.status.code)).toEqual([SpanStatusCode.ERROR, SpanStatusCode.ERROR]);
			expect(requests.find((span) => span.attributes["http.response.status_code"] === 404)?.attributes["http.route"]).toBe("unmatched");
			expect(requests.at(-1)?.attributes["http.request.method"]).toBe("_OTHER");
			expect(JSON.stringify(requests.map((span) => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status })))).not.toMatch(/private-returned|private-thrown|private-unmatched|private-query|PRIVATE_METHOD/);
		} finally {
			await shutdownTracing();
		}
	});

	it("attributes verified settings callers without treating worker agent ids as users", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { Hono } = await import("hono");
		const exporter = new InMemorySpanExporter();
		await shutdownTracing();
		initTracing({ serviceName: "wrapper-principal-test", spanProcessors: [new SimpleSpanProcessor(exporter)] });
		try {
			const app = new Hono();
			app.get("/worker", (c) => {
				c.set("authContext", { via: "worker_token", userId: "synthetic-agent", organizationId: "synthetic-worker-org" });
				return c.text("ok");
			});
			app.get("/settings", (c) => {
				c.set("authContext", { via: "settings_session", userId: "synthetic-user", organizationId: "synthetic-settings-org" });
				return c.text("ok");
			});
			const wrapper = buildWrapperApp({} as never, app);
			await wrapper.request("/lobu/worker");
			await wrapper.request("/lobu/settings");
			const requests = exporter.getFinishedSpans();
			expect(requests.map((span) => span.attributes["user.id"])).toEqual([undefined, "synthetic-user"]);
			expect(requests.map((span) => span.attributes["lobu.org_id"])).toEqual(["synthetic-worker-org", "synthetic-settings-org"]);
		} finally {
			await shutdownTracing();
		}
		expect((await buildWrapperApp({} as never, null).request("/health")).status).toBe(200);
	});

	it("mounts mainApp at / and lobuApp at /lobu when present", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		lobuApp.get("/ping", (c) => c.text("lobu-pong"));
		const wrapper = buildWrapperApp({} as never, lobuApp);

		const lobuRes = await wrapper.request("/lobu/ping");
		expect(lobuRes.status).toBe(200);
		expect(await lobuRes.text()).toBe("lobu-pong");

		const mainRes = await wrapper.request("/health");
		expect(mainRes.status).toBe(200);
		expect(await mainRes.text()).toBe("main-ok");
	});

	it("skips the /lobu mount when lobuApp is null", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const wrapper = buildWrapperApp({} as never, null);

		const lobuRes = await wrapper.request("/lobu/ping");
		expect(lobuRes.status).toBe(404);
	});

	it("injects env onto c.env without dropping adapter fields", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		// Probe runs against the lobuApp so it sees the wrapper's middleware.
		lobuApp.get("/probe", (c) => {
			// env was merged: app secrets are visible
			const seenSecret = (c.env as { SECRET?: string }).SECRET;
			// adapter field was preserved: `incoming` still set when the runner
			// injects it (we set a fake below to prove Object.assign doesn't drop it)
			const incoming = (c.env as { incoming?: unknown }).incoming;
			return c.json({ seenSecret, hasIncoming: incoming !== undefined });
		});
		const wrapper = buildWrapperApp({ SECRET: "shh" } as never, lobuApp);

		// Hono's `request()` helper doesn't simulate the Node adapter's
		// `c.env.incoming`. Bind an `incoming` field via a one-shot middleware
		// BEFORE the wrapper's stack runs to mimic what @hono/node-server does.
		const outer = new Hono();
		outer.use("*", async (c, next) => {
			if (!c.env) c.env = {};
			(c.env as { incoming?: unknown }).incoming = {
				socket: { remoteAddress: "127.0.0.1" },
			};
			return next();
		});
		outer.route("/", wrapper);

		const res = await outer.request("/lobu/probe");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			seenSecret: string;
			hasIncoming: boolean;
		};
		expect(body.seenSecret).toBe("shh");
		expect(body.hasIncoming).toBe(true);
	});

	it("stashes peer remote address into c.var before env-inject runs", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		lobuApp.get("/peer", (c) => c.text(c.get("peerRemoteAddress") ?? "none"));
		const wrapper = buildWrapperApp({} as never, lobuApp);

		const outer = new Hono();
		outer.use("*", async (c, next) => {
			if (!c.env) c.env = {};
			(c.env as { incoming?: unknown }).incoming = {
				socket: { remoteAddress: "10.0.0.1" },
			};
			return next();
		});
		outer.route("/", wrapper);

		const res = await outer.request("/lobu/peer");
		expect(await res.text()).toBe("10.0.0.1");
	});

	it("suppresses ONLY the draining readiness 503; other health 5xx still report", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { default: logger } = await import("../utils/logger");
		const { Hono } = await import("hono");
		const captureMessage = logger.error as ReturnType<typeof vi.fn>;

		// Expected deploy-drain shape → suppressed (was LOBU-BACKEND-X noise).
		const draining = buildWrapperApp({} as never, new Hono());
		draining.get("/health/ready", (c) =>
			c.json({ status: "draining", service: "lobu-api" }, 503),
		);
		captureMessage.mockClear();
		const drainRes = await draining.request("/health/ready");
		expect(drainRes.status).toBe(503);
		expect(captureMessage).not.toHaveBeenCalled();

		// Same endpoint, non-draining body (e.g. DB unreachable) → still reports.
		const broken = buildWrapperApp({} as never, new Hono());
		broken.get("/health/ready", (c) =>
			c.json({ status: "error", error: "db unreachable" }, 503),
		);
		captureMessage.mockClear();
		const brokenRes = await broken.request("/health/ready");
		expect(brokenRes.status).toBe(503);
		expect(captureMessage).toHaveBeenCalled();
	});

	it("does NOT double-report when onError fires after post-response middleware", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { default: logger } = await import("../utils/logger");
		const { Hono } = await import("hono");
		const captureMessage = logger.error as ReturnType<typeof vi.fn>;
		captureMessage.mockClear();

		const lobuApp = new Hono();
		lobuApp.get("/boom", () => {
			throw new Error("thrown");
		});
		const wrapper = buildWrapperApp({} as never, lobuApp);

		await wrapper.request("/lobu/boom");
		// onError marks the request as reported via markErrorReported BEFORE
		// the post-response middleware runs; the latter must skip the 5xx path.
		const diagnostics = captureMessage.mock.calls.filter(([record]) =>
			record?.source === "app_onError" || record?.source === "http_response");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0][0].source).toBe("app_onError");
	});
});

describe("shutdown ordering (live drain)", () => {
	// The integration suite shares one module graph (`isolate: false`), so a
	// real SIGTERM here would leave the process-wide shutdown flag and the
	// `process.exit` spy in place for every later file in the shard. A leaked
	// flag makes `/api/workers/poll` stop holding and answer
	// `next_poll_seconds: 10`, turning each device action in a later browser
	// test into a ~10s wait.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it(
		"refuses new work and drains the in-flight request before gateway/db teardown",
		async () => {
			const events: string[] = [];
			const lifecycleState = await import("../lifecycle-state");
			let shuttingDown = false;
			vi.spyOn(lifecycleState, "markShuttingDown").mockImplementation(() => {
				shuttingDown = true;
			});
			vi.spyOn(lifecycleState, "isShuttingDown").mockImplementation(
				() => shuttingDown,
			);
			const { closeDbSingleton } = await import("../db/client");
			const { stopLobuGateway } = await import("../lobu/gateway");
			vi.mocked(closeDbSingleton).mockImplementation(async () => {
				events.push("db-closed");
			});
			vi.mocked(stopLobuGateway).mockImplementation(async () => {
				events.push("gateway-stopped");
			});

			const exited = new Promise<number | undefined>((resolveExit) => {
				vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
					events.push("exit");
					resolveExit(code);
					return undefined as never;
				}) as never);
			});

			const sigListenersBefore = {
				SIGTERM: process.listeners("SIGTERM"),
				SIGINT: process.listeners("SIGINT"),
			};

			const { Hono } = await import("hono");
			const lobuApp = new Hono();
			gwAppSlot.app = lobuApp;
			const slowHandler = (c: {
				json: (body: Record<string, string>) => unknown;
			}) => {
				events.push("inflight-start");
				return new Promise<{ ok: string }>((resolve) =>
					setTimeout(() => resolve({ ok: "slow" }), 700),
				).then((body) => {
					events.push("inflight-done");
					return c.json(body);
				});
			};
			lobuApp.get("/slow", slowHandler);
			lobuApp.post("/slow", slowHandler);

			const { createServerLifecycle } = await import("../server-lifecycle");
			// Claim a free loopback port first: the spine logs its configured
			// port, not the bound one, so port 0 can't be discovered afterwards.
			const freePort = await new Promise<number>((resolve, reject) => {
				const scout = net.createServer();
				scout.unref();
				scout.on("error", reject);
				scout.listen(0, "127.0.0.1", () => {
					const { port } = scout.address() as net.AddressInfo;
					scout.close(() => resolve(port));
				});
			});
			const lifecycle = createServerLifecycle({
				mode: "postgres",
				env: {} as never,
				host: "127.0.0.1",
				port: freePort,
				databaseReadiness: async () => {},
				extraTeardown: [
					async () => {
						events.push("extra-teardown");
					},
				],
			});
			await lifecycle.start();
			const port = freePort;

			let inflightError: unknown = null;
			const inflight = new Promise<{ status: number }>((resolveInflight) => {
				const req = http.request(
					{ host: "127.0.0.1", port, path: "/lobu/slow", method: "GET" },
					(res) => {
						res.resume();
						res.on("end", () => resolveInflight({ status: res.statusCode ?? 0 }));
					},
				);
				req.on("error", (err: NodeJS.ErrnoException) => {
					inflightError = err;
					resolveInflight({ status: 599 });
				});
				req.end();
			});
			// Wait until THIS request is being handled before signalling — no
			// other traffic has run, so "inflight-start" can only be ours.
			await vi.waitFor(
				() => expect(events).toContain("inflight-start"),
				{ timeout: 3_000 },
			);

			process.emit("SIGTERM");

			// A brand-new connection must be refused once the listener closed —
			// and crucially BEFORE db teardown severs the dependency it would
			// have needed (the drain-phase CONNECTION_ENDED 500 regression).
			const probeOnce = (): Promise<string> =>
				new Promise((resolve) => {
					const socket = net.connect({ port, host: "127.0.0.1" });
					const timer = setTimeout(() => {
						socket.destroy();
						resolve("timeout");
					}, 250);
					socket.on("connect", () => {
						clearTimeout(timer);
						socket.destroy();
						resolve("connected");
					});
					socket.on("error", (err: NodeJS.ErrnoException) => {
						clearTimeout(timer);
						resolve(err.code ?? "error");
					});
				});
			let refusal = "still-accepting";
			for (let i = 0; i < 200 && !events.includes("exit"); i++) {
				refusal = await probeOnce();
				if (refusal !== "connected") break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			events.push(`new-conn:${refusal}`);
			expect(refusal).not.toBe("connected");

			const inflightRes = await inflight;
			expect(
				inflightRes.status,
				JSON.stringify({
					events,
					err: inflightError
						? {
								msg: (inflightError as Error).message,
								code: (inflightError as NodeJS.ErrnoException).code,
							}
						: null,
				}),
			).toBe(200);
			await exited;

			for (const signal of ["SIGTERM", "SIGINT"] as const) {
				for (const listener of process.listeners(signal)) {
					if (!sigListenersBefore[signal].includes(listener)) {
						process.removeListener(signal, listener);
					}
				}
			}

			const indexOfEvent = (name: string): number => {
				const idx = events.findIndex(
					(event) => event === name || event.startsWith(`${name}:`),
				);
				expect(idx >= 0, `missing ${name} in ${JSON.stringify(events)}`).toBe(
					true,
				);
				return idx;
			};
			// The in-flight request finished on its own terms, then — and only
			// then — the dependency teardown ran; nothing was served after the
			// dependencies were gone.
			expect(indexOfEvent("inflight-done")).toBeLessThan(
				indexOfEvent("gateway-stopped"),
			);
			expect(indexOfEvent("new-conn")).toBeLessThan(
				indexOfEvent("db-closed"),
			);
			expect(indexOfEvent("gateway-stopped")).toBeLessThan(
				indexOfEvent("db-closed"),
			);
			expect(indexOfEvent("db-closed")).toBeLessThan(
				indexOfEvent("extra-teardown"),
			);
			expect(events[events.length - 1]).toBe("exit");
			expect(shuttingDown).toBe(true);
			vi.restoreAllMocks();
			expect(lifecycleState.isShuttingDown()).toBe(false);
		},
		20_000,
	);
});
