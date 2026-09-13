/**
 * Shared server lifecycle spine.
 *
 * `server.ts` is the single entry for both backends (external Postgres and
 * local embedded Postgres); it calls into `createServerLifecycle()` so
 * middleware ordering, route mounts,
 * httpServer timeouts, shutdown sequence, and signal wiring stay identical
 * by construction. Drift between the two modes was the root cause of #948;
 * the only way to express a per-mode difference now is the four named hooks
 * on `ServerLifecycleConfig`.
 *
 * Do not add `new Hono`, `app.use`, `app.route`, `http.createServer`, or
 * `process.on('SIGTERM' | 'SIGINT', …)` to either entry — they belong here.
 */

import http from "node:http";
import v8 from "node:v8";
import { getRequestListener } from "@hono/node-server";
import * as Sentry from "@sentry/node";
import { Hono } from "hono";
import { pinoLogger } from "hono-pino";
import { closeDbSingleton } from "./db/client";
import { mountViteDev } from "./dev-vite";
import { mountPublicApps } from "./http/api-route-mounts";
import { markShuttingDown } from "./lifecycle-state";
import type { Env } from "./index";
import { app as mainApp } from "./index";
import {
	getLobuCoreServices,
	initLobuGateway,
	stopLobuGateway,
} from "./lobu/gateway";
import { startStaleRunReaper } from "./scheduled/check-stalled-executions";
import { startEmbeddedConnectorWorker } from "./scheduled/embedded-connector-worker";
import { bootTaskScheduler } from "./scheduled/jobs";
import { isSentryReported, markSentryReported } from "./sentry";
import { BootConfigError } from "./utils/errors";
import logger from "./utils/logger";
import { initWorkspaceProvider } from "./workspace";

type ServerMode = "postgres" | "embedded-postgres";

interface ServerLifecycleConfig {
	mode: ServerMode;
	env: Env;
	host: string;
	port: number;
	/**
	 * Runs before workspace/gateway init. External Postgres asserts the
	 * migrations ledger matches the bundled migrations dir; the embedded
	 * backend runs them.
	 */
	databaseReadiness: () => Promise<void>;
	/**
	 * Runs after gateway + scheduler boot, before `httpServer.listen()`.
	 * Both `lobu run` backends use this for `ensureInstallOperator`
	 * (embedded always; external only with LOBU_RUN_OWNS_DB=1 — see
	 * local-bootstrap.ts).
	 */
	preListenHooks?: Array<() => Promise<void> | void>;
	/**
	 * Runs synchronously inside the `httpServer.listen()` callback, after the
	 * listener is live but before the embedded connector worker starts.
	 * Postgres uses this for the connector external-deps resolvability check.
	 */
	postListenHooks?: Array<() => void>;
	/**
	 * Runs during shutdown after the HTTP listener stops accepting work and
	 * after Lobu gateway and database-pool teardown, in declared order. The
	 * embedded backend uses this to kill the embeddings child and stop the
	 * embedded Postgres.
	 */
	extraTeardown?: Array<() => Promise<void> | void>;
}

interface ServerLifecycleHandles {
	/** Starts the listener and registers signal handlers. Resolves once listening. */
	start: () => Promise<void>;
}

/**
 * Defensive error → plain-object serializer for the top-level boot catch.
 *
 * pino's logger registers `err` / `error` serializers, but
 * `JSON.stringify(new Error('boom'))` returns `{}` because Error's own
 * properties are non-enumerable. If anything drops the pino serializer
 * config (older image, bundler tree-shake, etc.), Docker users see only
 * `"error":{}` with zero signal — exactly what #766 reported. Walk the
 * error manually so the log line always carries message + stack regardless
 * of pino config, ZodError `issues`, AggregateError children, or wrapped
 * `cause` chains.
 */
export function serializeBootError(err: unknown): Record<string, unknown> {
	if (err === null || err === undefined) return { value: String(err) };
	if (typeof err !== "object") return { value: String(err), type: typeof err };
	const e = err as Error & {
		code?: unknown;
		cause?: unknown;
		issues?: unknown;
		errors?: unknown;
	};
	const out: Record<string, unknown> = {
		type: e?.constructor?.name ?? "Error",
		message: typeof e.message === "string" ? e.message : String(e),
	};
	if (typeof e.stack === "string") out.stack = e.stack;
	if (e.code !== undefined) out.code = e.code;
	if (Array.isArray(e.issues)) out.issues = e.issues;
	if (Array.isArray(e.errors)) {
		out.errors = e.errors.map((child) => serializeBootError(child));
	}
	if (e.cause !== undefined && e.cause !== err) {
		out.cause = serializeBootError(e.cause);
	}
	return out;
}

/**
 * Run from each entry's `main().catch(...)`. Prints expected configuration
 * failures cleanly; logs unexpected failures with a plain-text fallback.
 * Exits with status 1 and never returns.
 */
export function reportBootFailure(err: unknown): never {
	// Expected setup gates should not be logged or reported to Sentry as crashes.
	if (err instanceof BootConfigError) {
		process.stderr.write(`${err.message}\n`);
		process.exit(1);
	}
	const serialized = serializeBootError(err);
	logger.error(
		{ err: serialized, error: serialized },
		"Failed to start server",
	);
	process.stderr.write(
		`Failed to start server: ${serialized.type ?? "Error"}: ${serialized.message ?? ""}\n`,
	);
	if (typeof serialized.stack === "string") {
		process.stderr.write(`${serialized.stack}\n`);
	}
	process.exit(1);
}

/**
 * Build a Hono wrapper app with the canonical middleware stack and route
 * mounts. Extracted so the contract test can assert middleware ordering
 * without standing up the full lifecycle.
 *
 * Middleware order (locked):
 *   1. peer-remote-address stash  (read `c.env.incoming.socket.remoteAddress`
 *      BEFORE the env-inject middleware replaces shared fields)
 *   2. env-inject                (`Object.assign(c.env, env)` — preserves
 *      `c.env.incoming` so the Node adapter's `getConnInfo` keeps working)
 *   3. request logger             (covers both `/lobu` and the main app)
 *   4. sentry 5xx response capture (for inner-catch returns that never throw)
 *   5. `app.onError` for thrown exceptions
 *
 * Route mounts:
 *   - `/lobu` → `lobuApp` (only when non-null)
 *   - `/`     → `mainApp`
 */
export function buildWrapperApp(
	env: Env,
	lobuApp: Hono | null,
	mountedMainApp: Hono<{ Bindings: Env }> = mainApp,
): Hono<{ Bindings: Env }> {
	const wrapper = new Hono<{ Bindings: Env }>();

	// 1. peer remote address stash — must run BEFORE env injection because
	// env injection mutates `c.env` and could blow away the adapter field.
	// @hono/node-server hands the request's IncomingMessage via `c.env.incoming`
	// so `getConnInfo` can read `socket.remoteAddress`. Loopback-trust endpoints
	// (e.g. `/api/local-init`) need this peer address to enforce their boundary.
	wrapper.use("*", async (c, next) => {
		const incoming = (
			c.env as
				| { incoming?: { socket?: { remoteAddress?: string } } }
				| undefined
		)?.incoming;
		const peerRemoteAddress = incoming?.socket?.remoteAddress ?? null;
		if (peerRemoteAddress) c.set("peerRemoteAddress", peerRemoteAddress);
		return next();
	});

	// 2. Env injection — `Object.assign(c.env, env)` merges the app-wide
	// config into the Hono adapter's `c.env` WITHOUT dropping adapter-set
	// fields like `incoming`. The earlier replace-strategy
	// (`c.env = env as Env`) silently broke `getConnInfo` and any other
	// helper that read those fields. When `c.env` is undefined (only happens
	// outside the Node adapter — e.g. in unit tests via `app.request()`),
	// seed it with an empty object so the merge still works.
	wrapper.use("*", async (c, next) => {
		if (!c.env) c.env = {} as Env;
		Object.assign(c.env, env);
		return next();
	});

	// 3. Request logging belongs on the wrapper because `/lobu` and the main app
	// are sibling mounts. Putting it inside only one child silently drops the
	// other child's requests from the access log.
	wrapper.use("*", pinoLogger({ pino: logger }));

	// 4. Server-error capture. Two layers cover both shapes of failing route:
	//   (a) routes that throw — handled by `app.onError` below.
	//   (b) routes that try/catch internally and `return c.json(..., 500)` —
	//       the framework never sees the exception, so onError doesn't fire.
	//       This post-response middleware catches anything with status >= 500
	//       so silent 500s still reach Sentry.
	// Either layer marks the request reported so we don't double-count.
	// `Sentry.captureMessage` no-ops when `Sentry.init` was skipped (no DSN),
	// so this is safe to wire unconditionally.
	wrapper.use("*", async (c, next) => {
		await next();
		if (c.res.status >= 500 && !isSentryReported(c)) {
			let body: unknown = null;
			try {
				body = await c.res.clone().json();
			} catch {
				// response wasn't JSON; ignore
			}
			// Readiness probes intentionally 503 `{status:"draining"}` during the
			// graceful-shutdown drain (SHUTDOWN_READINESS_DRAIN_MS) — capturing
			// that turns every deploy rollover into a Sentry issue
			// (LOBU-BACKEND-X). Skip ONLY that exact shape: a health 5xx with any
			// other body (DB unreachable, crash) is a real incident and must
			// still report.
			if (
				c.req.path === "/health/ready" &&
				c.res.status === 503 &&
				body !== null &&
				typeof body === "object" &&
				(body as { status?: unknown }).status === "draining"
			) {
				return;
			}
			const message =
				(body &&
				typeof body === "object" &&
				"error" in body &&
				typeof (body as { error?: unknown }).error === "string"
					? (body as { error: string }).error
					: null) ?? `HTTP ${c.res.status} from ${c.req.method} ${c.req.path}`;
			Sentry.captureMessage(message, {
				level: "error",
				tags: {
					source: "http_response",
					http_method: c.req.method,
					http_status: String(c.res.status),
				},
				extra: {
					path: c.req.path,
					// `extra`, not `tags`: Host is client-supplied, so as an indexed
					// tag its value cardinality is unbounded by anything we control.
					host: c.req.header("host") ?? "unknown",
					response_body: body,
				},
			});
			markSentryReported(c);
		}
	});

	// 4. Catch-all error handler for thrown exceptions that bubble past route
	// catches. Preserves the original stack trace.
	wrapper.onError((err, c) => {
		if (!isSentryReported(c)) {
			Sentry.captureException(err, {
				tags: {
					source: "app_onError",
					http_method: c.req.method,
				},
				extra: {
					path: c.req.path,
					// See above: client-supplied, so never an indexed tag.
					host: c.req.header("host") ?? "unknown",
				},
			});
			markSentryReported(c);
		}
		// `sentryReported:true` tells the pino → Sentry forwarder in logger.ts
		// to skip — Sentry already has this exception via captureException above.
		logger.error(
			{ err, path: c.req.path, sentryReported: true },
			"Unhandled error in HTTP handler",
		);
		return c.json({ error: "Internal server error" }, 500);
	});

	// Public route precedence is isolated and regression-tested: /api/v1 must
	// reach the Agent API before /api/:orgSlug routes in the main app.
	mountPublicApps(wrapper, lobuApp, mountedMainApp);

	return wrapper;
}

/**
 * Optional SIGUSR2 → V8 heap snapshot wiring. Off by default because
 * snapshots contain in-memory secrets (DB URL, OAuth tokens, secret-proxy
 * cache). Operator opts in by setting `ALLOW_HEAP_SNAPSHOT=1`.
 *
 * Blocks the event loop for ~seconds (proportional to heap size) and
 * requires ~heap-size extra memory while writing. Single-flight + fixed
 * filename (`/tmp/lobu.heapsnapshot`) so a stuck-on flag can't fill tmpfs.
 */
function maybeWireHeapSnapshot(): void {
	if (process.env.ALLOW_HEAP_SNAPSHOT !== "1") return;
	const SNAPSHOT_PATH = "/tmp/lobu.heapsnapshot";
	let inProgress = false;
	process.on("SIGUSR2", () => {
		if (inProgress) {
			logger.warn("[heap] SIGUSR2 ignored — snapshot already in progress");
			return;
		}
		inProgress = true;
		logger.warn(
			{ path: SNAPSHOT_PATH },
			"[heap] SIGUSR2 received — writing heap snapshot (blocks event loop)",
		);
		try {
			v8.writeHeapSnapshot(SNAPSHOT_PATH);
			logger.warn({ path: SNAPSHOT_PATH }, "[heap] snapshot written");
		} catch (err) {
			logger.error({ err }, "[heap] writeHeapSnapshot failed");
		} finally {
			inProgress = false;
		}
	});
	logger.warn(
		"[heap] ALLOW_HEAP_SNAPSHOT=1 — SIGUSR2 will write heap dumps to " +
			SNAPSHOT_PATH +
			". Unset and roll the pod when done; snapshots contain secrets.",
	);
}

/**
 * Build the shared lifecycle. Returns a `start()` that boots the full stack
 * per the canonical ordering. Both entries call this with mode-specific
 * hooks; everything else is identical by construction.
 */
export function createServerLifecycle(
	config: ServerLifecycleConfig,
): ServerLifecycleHandles {
	const {
		mode,
		env,
		host,
		port,
		databaseReadiness,
		preListenHooks = [],
		postListenHooks = [],
		extraTeardown = [],
	} = config;

	const start = async (): Promise<void> => {
		// 1. Database readiness — external PG asserts schema; embedded runs migrations.
		await databaseReadiness();

		// 2. Workspace provider — required before gateway boot.
		await initWorkspaceProvider();

		// 3. Embedded Lobu gateway. Owns the public Agent API mounted at `/lobu`
		// by `buildWrapperApp`.
		const lobuApp = await initLobuGateway();

		// 4. Task scheduler. Every periodic platform-internal job — token
		// refresh, MCP DB cleanup, automation — runs as a row in
		// `public.runs` with cron-driven self-rescheduling.
		const taskScheduler = await bootTaskScheduler(getLobuCoreServices(), env);

		// 5. 30s connector-run heartbeat-lost reaper. Cross-pod coordinated
		// via advisory lock. This is the single reaper cadence — the
		// `check-stalled-executions` cron no longer calls reapStaleRuns().
		const stopReaper = startStaleRunReaper();

		// 6. Wrapper app + HTTP server. Timeouts are locked at 75/76s so SSE
		// streams (MCP) survive idle periods above the typical 60s LB timeout.
		const wrapper = buildWrapperApp(env, lobuApp);
		const honoListener = getRequestListener(wrapper.fetch);
		const httpServer = http.createServer();
		httpServer.keepAliveTimeout = 75_000;
		httpServer.headersTimeout = 76_000;

		// 7. Vite dev middleware in development; otherwise wire Hono directly.
		const vite = await mountViteDev(httpServer, honoListener);
		if (!vite) {
			httpServer.on("request", honoListener);
		}

		// 8. Pre-listen hooks (install-operator; embedded always, external with
		// LOBU_RUN_OWNS_DB=1).
		for (const hook of preListenHooks) {
			await hook();
		}

		// 9. Shutdown wiring — declared once, called from both SIGTERM and SIGINT.
		// Embedded worker handle is captured in the listen callback below.
		let embeddedWorker: ReturnType<typeof startEmbeddedConnectorWorker> = null;

		const shutdown = async (signal: string): Promise<void> => {
			logger.info(
				{ signal, mode },
				"Received shutdown signal, stopping gracefully...",
			);
			// Flip the readiness flag FIRST so `/health/ready` starts returning
			// 503 immediately. On k8s this lets kube-proxy drop the pod from the
			// Service endpoint set before we tear anything down. The optional
			// drain delay (SHUTDOWN_READINESS_DRAIN_MS, default 0 so local/dev
			// shutdown stays instant) holds teardown for one probe period so the
			// endpoint is actually removed before in-flight connections are cut.
			// Prod sets this (and a matching chart preStop / grace period).
			// SIGINT is interactive (no LB endpoint to drain) — skip the pause.
			markShuttingDown();
			const drainMs = Number(env.SHUTDOWN_READINESS_DRAIN_MS ?? 0);
			if (signal !== "SIGINT" && Number.isFinite(drainMs) && drainMs > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, drainMs));
			}
			// Each step is wrapped in try/catch so one failing teardown can't
			// block the rest — we still want the listener closed and the
			// process gone, even if (say) the gateway drain rejects. Catch +
			// log + continue.
			const safe = async (step: string, fn: () => Promise<void> | void) => {
				try {
					await fn();
				} catch (err) {
					logger.error({ err, step, mode }, "Shutdown step failed; continuing");
				}
			};
			// Order matters:
			//   a. Stop the embedded connector worker from polling and give its active
			//      job up to 15s to finish while the local HTTP API it uses for progress
			//      and completion reports is still reachable.
			if (embeddedWorker) {
				const worker = embeddedWorker;
				await safe("embeddedWorker.stop", async () => {
					worker.stop();
					await worker.wait(15_000);
				});
			}
			//   b. Stop accepting new HTTP work after the readiness drain above has
			//      let the LB drop this pod's endpoint.
			//      `close()` refuses new connections while letting in-flight
			//      requests finish. Await it before gateway and database teardown so
			//      accepted requests retain those dependencies while draining.
			//      `close()` alone never completes while non-idle sockets
			//      such as SSE streams are open, so it is bounded by
			//      HTTP_CLOSE_TIMEOUT_MS (default 10s). Requests still active after
			//      that budget may be interrupted by the remaining teardown. SIGINT
			//      is the interactive path (Ctrl-C in dev, Mac app quit), capped at
			//      1s so local shutdown stays snappy.
			await safe("httpServer.close", async () => {
				const configuredMs = Number(env.HTTP_CLOSE_TIMEOUT_MS ?? 10_000);
				const closeTimeoutMs =
					signal === "SIGINT" ? Math.min(configuredMs, 1_000) : configuredMs;
				await new Promise<void>((resolve) => {
					let settled = false;
					const done = () => {
						if (settled) return;
						settled = true;
						resolve();
					};
					httpServer.close(() => done());
					httpServer.closeIdleConnections();
					setTimeout(done, closeTimeoutMs).unref?.();
				});
			});
			//   c. Close Vite after the listener stops accepting new connections so
			//      dev-mode HMR sockets detach cleanly.
			await safe("vite.close", async () => {
				await vite?.close();
			});
			//   d. Stop the reaper poll loop.
			await safe("stopReaper", () => stopReaper());
			//   e. Stop the task scheduler dispatch loop.
			await safe("taskScheduler.stop", () => taskScheduler.stop());
			//   f. Drain MCP sessions / DB listeners / secret-proxy. Gateway
			//      holds postgres.js connections that must be released before
			//      mode-specific db teardown runs.
			await safe("stopLobuGateway", () => stopLobuGateway());
			//   g. Close the postgres.js singleton pool.
			await safe("closeDbSingleton", () => closeDbSingleton());
			//   h. Mode-specific teardown (embedded kills embeddings child, stops
			//      socket server, closes the in-process db).
			for (let i = 0; i < extraTeardown.length; i++) {
				await safe(`extraTeardown[${i}]`, extraTeardown[i]);
			}
			process.exit(0);
		};
		// Single-flight guard: SIGTERM+SIGINT or a double-tap on either must
		// not run shutdown concurrently — concurrent gateway-stop calls race
		// the secret-proxy close, and concurrent process.exit calls leak.
		let shutdownStarted = false;
		const onSignal = (signal: string) => {
			if (shutdownStarted) {
				logger.warn(
					{ signal, mode },
					"Shutdown already in progress; ignoring signal",
				);
				return;
			}
			shutdownStarted = true;
			void shutdown(signal);
		};
		process.on("SIGTERM", () => onSignal("SIGTERM"));
		process.on("SIGINT", () => onSignal("SIGINT"));

		// 10. Optional heap-snapshot wiring (gated on ALLOW_HEAP_SNAPSHOT=1).
		maybeWireHeapSnapshot();

		// 11. Listen. Post-listen hooks fire inside the callback so any
		// `require.resolve` walks they do (connector dep check) don't add to
		// cold-boot/readiness latency. The embedded connector daemon waits for
		// the listener because its boot-time health check hits `/api/health`.
		logger.info({ host, port, mode }, "Starting server");
		await new Promise<void>((resolve) => {
			httpServer.listen(port, host, () => {
				logger.info(
					{ host, port, mode },
					`Lobu running at http://${host}:${port}`,
				);
				for (const hook of postListenHooks) {
					hook();
				}
				const daemonHost = host === "0.0.0.0" ? "127.0.0.1" : host;
				embeddedWorker = startEmbeddedConnectorWorker(
					env,
					`http://${daemonHost}:${port}`,
				);
				resolve();
			});
		});
	};

	return { start };
}
