/**
 * Contract tests for the shared server lifecycle spine.
 *
 * The point of these tests is to lock the invariants that drift between
 * `server.ts` (Postgres) and `start-local.ts` (embedded Postgres) used to break (issue
 * #948 + the #943 7-hygiene catch-up):
 *
 *   1. Middleware ordering on the Hono wrapper:
 *      peer-address stash → env-inject → request logger → sentry-5xx-capture → onError
 *   2. Route mounts: `/lobu` mounted only when lobuApp is non-null; `/` always.
 *   3. httpServer timeouts: keepAliveTimeout=75000, headersTimeout=76000.
 *   4. Shutdown ordering documented in createServerLifecycle().
 *   5. `serializeBootError` walks nested cause chains and never returns `{}`.
 *
 * The wrapper-app and serializer assertions exercise real code paths;
 * the lifecycle-shape assertions read the source so anything renaming the
 * shutdown step labels has to update the test in the same PR.
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

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
	getLobuCoreServices: vi.fn(() => ({})),
}));
vi.mock("../scheduled/check-stalled-executions", () => ({
	startStaleRunReaper: vi.fn(() => vi.fn()),
}));
vi.mock("../scheduled/jobs", () => ({
	bootTaskScheduler: vi.fn(async () => ({ stop: vi.fn(async () => {}) })),
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

vi.mock("../sentry", () => {
	const reported = new WeakSet<object>();
	return {
		captureServerError: vi.fn(),
		isSentryReported: vi.fn((c: { req: unknown }) =>
			reported.has(c.req as object),
		),
		markSentryReported: vi.fn((c: { req: unknown }) => {
			reported.add(c.req as object);
		}),
		trackMCPToolCall: vi.fn(
			async <T,>(
				_toolName: string,
				_args: unknown,
				handler: () => Promise<T>,
			) => handler(),
		),
	};
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
	};
});

const LIFECYCLE_SOURCE = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "..", "server-lifecycle.ts"),
	"utf8",
);

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
	it("logs requests handled by the /lobu mounted app", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { default: logger } = await import("../utils/logger");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		lobuApp.get("/ping", (c) => c.text("lobu-pong"));
		const info = logger.info as ReturnType<typeof vi.fn>;
		info.mockClear();

		const wrapper = buildWrapperApp({} as never, lobuApp);
		const response = await wrapper.request("/lobu/ping");

		expect(response.status).toBe(200);
		expect(info).toHaveBeenCalled();
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

	it("captures 5xx responses to Sentry via the post-response middleware", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const sentry = await import("@sentry/node");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		// Routes that try/catch internally and return c.json(..., 500) — the
		// framework never sees the exception, so onError doesn't fire. The
		// post-response middleware is the only thing that catches these.
		lobuApp.get("/silent-500", (c) => c.json({ error: "inner caught" }, 500));
		const wrapper = buildWrapperApp({} as never, lobuApp);

		const res = await wrapper.request("/lobu/silent-500");
		expect(res.status).toBe(500);
		expect(sentry.captureMessage).toHaveBeenCalled();
		const calls = (sentry.captureMessage as ReturnType<typeof vi.fn>).mock
			.calls;
		const lastCall = calls[calls.length - 1] ?? [];
		const [message, opts] = lastCall;
		expect(message).toBe("inner caught");
		expect(opts.level).toBe("error");
		expect(opts.tags.source).toBe("http_response");
	});

	it("suppresses ONLY the draining readiness 503; other health 5xx still report", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const sentry = await import("@sentry/node");
		const { Hono } = await import("hono");
		const captureMessage = sentry.captureMessage as ReturnType<typeof vi.fn>;

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

	it("routes thrown exceptions through onError + Sentry.captureException", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const sentry = await import("@sentry/node");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		lobuApp.get("/boom", () => {
			throw new Error("thrown from route");
		});
		const wrapper = buildWrapperApp({} as never, lobuApp);

		const res = await wrapper.request("/lobu/boom");
		expect(res.status).toBe(500);
		expect(sentry.captureException).toHaveBeenCalled();
		const calls = (sentry.captureException as ReturnType<typeof vi.fn>).mock
			.calls;
		const lastCall = calls[calls.length - 1] ?? [];
		const [errArg] = lastCall;
		expect((errArg as Error).message).toBe("thrown from route");
	});

	it("does NOT double-report when onError fires after post-response middleware", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const sentry = await import("@sentry/node");
		const { Hono } = await import("hono");
		const captureMessage = sentry.captureMessage as ReturnType<typeof vi.fn>;
		const captureException = sentry.captureException as ReturnType<
			typeof vi.fn
		>;
		captureMessage.mockClear();
		captureException.mockClear();

		const lobuApp = new Hono();
		lobuApp.get("/boom", () => {
			throw new Error("thrown");
		});
		const wrapper = buildWrapperApp({} as never, lobuApp);

		await wrapper.request("/lobu/boom");
		// onError marks the request as reported via markSentryReported BEFORE
		// the post-response middleware runs; the latter must skip the 5xx path.
		expect(captureException).toHaveBeenCalledTimes(1);
		expect(captureMessage).toHaveBeenCalledTimes(0);
	});
});

describe("createServerLifecycle (source-level contract)", () => {
	// These assertions read the source file. They exist so a code reviewer
	// (human or pi) can't silently reorder shutdown or drop a step without
	// updating the test in the same change. Relative ordering is enforced by
	// explicit source-position checks below.

	function indexOf(needle: string): number {
		const idx = LIFECYCLE_SOURCE.indexOf(needle);
		if (idx === -1) {
			throw new Error(
				`server-lifecycle.ts: expected substring not found: ${JSON.stringify(needle)}`,
			);
		}
		return idx;
	}

	it("locks httpServer keep-alive timeouts at 75/76s", () => {
		expect(LIFECYCLE_SOURCE).toContain("httpServer.keepAliveTimeout = 75_000");
		expect(LIFECYCLE_SOURCE).toContain("httpServer.headersTimeout = 76_000");
		// Header timeout MUST be strictly greater than keep-alive.
		expect(76_000).toBeGreaterThan(75_000);
	});

	it("runs databaseReadiness before workspace + gateway init", () => {
		const dbReady = indexOf("await databaseReadiness()");
		const workspace = indexOf("await initWorkspaceProvider()");
		const gateway = indexOf("await initLobuGateway()");
		expect(dbReady).toBeLessThan(workspace);
		expect(workspace).toBeLessThan(gateway);
	});

	it("runs preListenHooks before httpServer.listen", () => {
		const preHooks = indexOf("for (const hook of preListenHooks)");
		const listen = indexOf("httpServer.listen(port, host");
		expect(preHooks).toBeLessThan(listen);
	});

	it("starts the embedded connector worker inside the listen callback", () => {
		const listen = indexOf("httpServer.listen(port, host");
		const embedded = indexOf("embeddedWorker = startEmbeddedConnectorWorker");
		const postHooks = indexOf("for (const hook of postListenHooks)");
		expect(embedded).toBeGreaterThan(listen);
		expect(postHooks).toBeGreaterThan(listen);
		// postListenHooks fire BEFORE the embedded worker so any synchronous
		// dep-resolve check can fail-fast without leaving a worker registered.
		expect(postHooks).toBeLessThan(embedded);
	});

	it("shuts down in the documented order", () => {
		// Each step is wrapped in `safe("<step>", …)` so a failing teardown
		// can't block the rest. Order-check by the step label which is stable
		// across refactors of the wrapper.
		//
		// The embedded worker must get its bounded drain window while its local
		// HTTP API is still reachable. The listener then gives accepted requests
		// their close budget before gateway and database teardown.
		const close = indexOf('safe("httpServer.close"');
		const worker = indexOf('safe("embeddedWorker.stop"');
		const vite = indexOf('safe("vite.close"');
		const reaper = indexOf('safe("stopReaper"');
		const scheduler = indexOf('safe("taskScheduler.stop"');
		const gateway = indexOf('safe("stopLobuGateway"');
		const db = indexOf('safe("closeDbSingleton"');
		const extra = indexOf("safe(`extraTeardown[");

		expect(worker).toBeLessThan(close);
		expect(close).toBeLessThan(vite);
		expect(vite).toBeLessThan(reaper);
		expect(reaper).toBeLessThan(scheduler);
		expect(scheduler).toBeLessThan(gateway);
		expect(gateway).toBeLessThan(db);
		expect(db).toBeLessThan(extra);
	});

	it("wraps every shutdown step in a safe() helper (one failing step does not skip the rest)", () => {
		// The `safe()` wrapper is what guarantees that — for example — a
		// rejecting `stopLobuGateway()` doesn't leave the listener bound and
		// the process pinned. If a future refactor inlines a raw `await` for
		// any step, this assertion catches it.
		const safeCalls = LIFECYCLE_SOURCE.match(/safe\((`extraTeardown\[|")/g);
		expect(safeCalls?.length ?? 0).toBeGreaterThanOrEqual(7);
	});

	it("single-flights concurrent shutdown signals", () => {
		// SIGTERM and SIGINT can both arrive (or one can fire twice during a
		// supervisor restart). The guard short-circuits the second entry so
		// gateway-stop / extraTeardown / process.exit don't race.
		expect(LIFECYCLE_SOURCE).toContain("let shutdownStarted = false");
		expect(LIFECYCLE_SOURCE).toContain("if (shutdownStarted)");
		expect(LIFECYCLE_SOURCE).toContain("shutdownStarted = true");
	});

	it("registers SIGTERM and SIGINT handlers", () => {
		// Accept either quote style — biome may rewrite ' → " on save.
		expect(/process\.on\(['"]SIGTERM['"]/.test(LIFECYCLE_SOURCE)).toBe(true);
		expect(/process\.on\(['"]SIGINT['"]/.test(LIFECYCLE_SOURCE)).toBe(true);
	});
});

describe("shutdown ordering (live drain)", () => {
	it(
		"refuses new work and drains the in-flight request before gateway/db teardown",
		async () => {
			const events: string[] = [];
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
		},
		20_000,
	);
});
