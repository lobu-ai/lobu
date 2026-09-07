/**
 * UserContent MCP Server - Main Entry Point
 *
 * This is the main MCP server that exposes tools to LLM agents via the
 * Model Context Protocol over Streamable HTTP transport.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "@lobu/connector-sdk";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { LOBU_LOGO_PNG_BASE64 } from "./assets/logo";
import { createAuth } from "./auth";
import { resolveBaseUrl } from "./auth/base-url";
import { getAuthConfig as getAuthConfigFromEnv } from "./auth/config";
import { mcpAuth } from "./auth/middleware";
import { oauthRoutes } from "./auth/oauth/routes";
import { findExistingPersonalOrg } from "./auth/personal-org-provisioning";
import { credentialRoutes } from "./auth/routes";
import { convergeResponseCookieScope } from "./auth/session-cookie-scope";
import { compareWorkerToken } from "./auth/worker-token";
import {
	deleteEntityApprovalPolicy,
	type EntityApprovalPolicy,
	type EntityMutationMode,
	isEntityMutationMode,
	isWriteResourceClass,
	listEntityApprovalPolicies,
	upsertEntityApprovalPolicy,
} from "./authz/entity-policy";
import { listOperations } from "./operations/connector-operations";
import { qualifiedOperationKey } from "./tools/admin/manage_operations";
import {
	isLegalActionEffect,
	type WriteAction,
} from "./authz/write-action-manifest";
import { globalCatalogRoutes, orgInstalledRoutes } from "./catalog/routes";
import { connectionTokenRoutes } from "./connect/connection-token-route";
import { connectRoutes } from "./connect/routes";
import {
	restGetAuthProfileForRun,
	restGetFeedForRun,
} from "./connector-run/routes";
import { getDb } from "./db/client";
import * as invalidationEmitter from "./events/emitter";
import { streamInvalidationEvents } from "./events/sse";
import { invalidationSseAuth } from "./events/sse-invalidation-auth";
import {
	type ClaimEligibleOrg,
	type ClaimEngineDeps,
	type ClaimProvider,
	claimHttpStatus,
	claimPendingConnection,
	resolveClaimContext,
} from "./gateway/connections/connection-claim";
import { slackClaimProvider } from "./gateway/connections/slack-claim";
import { resolveClaimingUserSlackIdentities } from "./gateway/connections/slack-claim-identities";
import { createSlackWebApi } from "./gateway/connections/slack-web";
import {
	getMaxReservedLocks,
	getReservedLockCount,
} from "./gateway/orchestration/deployment-manager";
import { REST_TOOL_GET_ROUTES } from "./http/rest-tool-routes";
import { isExcludedSpaPath } from "./http/spa-route-filter";
import { isShuttingDown } from "./lifecycle-state";
import { agentRoutes } from "./lobu/agent-routes";
import { clientRoutes } from "./lobu/client-routes";
import { clientActivityScopeRoutes } from "./lobu/client-activity-scope-routes";
import { deploymentRoutes } from "./lobu/deployment-routes";
import { sandboxRoutes } from "./lobu/sandbox-routes";
import {
	getLobuCoreServices,
	isLobuGatewayRunning,
} from "./lobu/gateway";
import {
	claimSlackPendingInstall,
	resolveSlackActiveBindingElsewhere,
	resolveSlackPendingByTenant,
} from "./lobu/stores/slack-installations";
import { handleMcp, MCP_APP_DIRS } from "./mcp-handler";
import {
	restDeleteNotification,
	restGetUnreadCount,
	restListNotifications,
	restMarkAllAsRead,
	restMarkAsRead,
	restRecreateBrowserHandoff,
} from "./notifications/routes";
import { createPreviewClaim } from "./preview/slack";
import {
	buildPublicPageModel,
	buildRobotsTxt,
	buildSitemapEntries,
	buildSitemapXml,
	PUBLIC_XML_CACHE,
	injectRuntimeConfig,
	renderPublicPageTemplate,
} from "./public-pages";
import {
	publicRestEventsStream,
	publicRestGetConnector,
	publicRestGetOrganization,
	publicRestGetAutomations,
	publicRestListClassifiers,
	publicRestListConnectors,
	publicRestSearchKnowledge,
	restGetAutomations,
	restHealth,
	restInvokeEventAction,
	restListTools,
	restSearchKnowledge,
	restToolAction,
	restToolProxy,
	restUpdateContentClassification,
} from "./rest-api";
import { getSchedulerHealth } from "./scheduled/scheduler-health";
import { isCloudMode } from "./utils/cloud-mode";
import { entityLinkMatchSql } from "./utils/content-search";
import {
	getOwnedOwlettoExtensionIds,
	isAllowedCorsOrigin,
} from "./utils/cors-origin";
import { isValidFrameAncestor } from "./utils/csp";
import { errorMessage } from "./utils/errors";
import logger from "./utils/logger";
import { readMcpAppAsset, renderMcpAppTemplate } from "./utils/mcp-app-bundle";
import { generateOpenAPISpec } from "./utils/openapi-generator";
import {
	extractSubdomainOrg,
	getCanonicalRedirectUrl,
	getConfiguredPublicOrigin,
	getSubdomainZone,
	resolvePublicOrigin,
} from "./utils/public-origin";
import {
	getClientIP,
	getRateLimiter,
	RateLimitPresets,
} from "./utils/rate-limiter";
import { getRuntimeInfo } from "./utils/runtime-info";
import { getWorkspaceProvider } from "./workspace";
import { joinPublicOrganization } from "./workspace/join-public";

export type { Env };

const STATIC_TEXT_CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
};

const STATIC_BINARY_CONTENT_TYPES: Record<string, string> = {
	".avif": "image/avif",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

const APP_ROOT = path.resolve(
	fileURLToPath(new URL(".", import.meta.url)),
	"..",
);

let webDistDirectoryCache: string | null | undefined;

async function resolveWebDistDirectory(): Promise<string | null> {
	if (webDistDirectoryCache !== undefined) {
		return webDistDirectoryCache;
	}

	const candidates = [
		process.env.WEB_DIST_DIR?.trim(),
		path.resolve(APP_ROOT, "packages/owletto/dist"),
		path.resolve(APP_ROOT, "../owletto/dist"),
		path.resolve(process.cwd(), "packages/owletto/dist"),
		path.resolve(process.cwd(), "../owletto/dist"),
	].filter((candidate): candidate is string => Boolean(candidate));

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(path.join(candidate, "index.html"));
			if (stat.isFile()) {
				webDistDirectoryCache = candidate;
				return webDistDirectoryCache;
			}
		} catch {
			// Try next candidate.
		}
	}

	webDistDirectoryCache = null;
	return webDistDirectoryCache;
}

async function loadSpaHtmlTemplate(): Promise<string | null> {
	if (viteDev) {
		return fs.readFile(
			path.resolve(viteDev.config.root, "index.html"),
			"utf-8",
		);
	}

	const webDistDirectory = await resolveWebDistDirectory();
	if (!webDistDirectory) return null;

	const spaEntry = resolveStaticFilePath(webDistDirectory, "/index.html");
	if (!spaEntry) return null;

	return fs.readFile(spaEntry, "utf-8");
}

async function loadFallbackSpaHtmlTemplate(): Promise<string | null> {
	// APP_ROOT is the server package dir (packages/server). The sibling
	// candidate must walk one level up first to land in `packages/`, then
	// into `owletto/`. The previous `../packages/owletto/...` form here and
	// in resolveWebDistDirectory was a copy-paste from when this file was
	// working from a different anchor — it resolves to
	// `packages/packages/owletto/...` and silently misses every time.
	// Same story for `../web/...` which was left over from the
	// packages/web → packages/owletto rename (#817).
	const candidates = [
		path.resolve(APP_ROOT, "packages/owletto/index.html"),
		path.resolve(APP_ROOT, "../owletto/index.html"),
		path.resolve(process.cwd(), "packages/owletto/index.html"),
		path.resolve(process.cwd(), "../owletto/index.html"),
	];

	for (const candidate of candidates) {
		try {
			return await fs.readFile(candidate, "utf-8");
		} catch {
			// Try next candidate.
		}
	}

	return null;
}

async function loadAnySpaHtmlTemplate(): Promise<string | null> {
	return (await loadSpaHtmlTemplate()) ?? (await loadFallbackSpaHtmlTemplate());
}

function getContentTypeForStaticFile(filePath: string): string {
	const extension = path.extname(filePath).toLowerCase();
	return (
		STATIC_TEXT_CONTENT_TYPES[extension] ||
		STATIC_BINARY_CONTENT_TYPES[extension] ||
		"application/octet-stream"
	);
}

function hasBetterAuthSessionCookie(
	cookieHeader: string | null | undefined,
): boolean {
	return (cookieHeader ?? "").includes("better-auth.session_token=");
}

function resolveStaticFilePath(
	distDir: string,
	requestPath: string,
): string | null {
	const normalizedPath = path.posix.normalize(requestPath || "/");
	if (normalizedPath.includes("..")) {
		return null;
	}

	const relativePath =
		normalizedPath === "/" ? "index.html" : normalizedPath.replace(/^\/+/, "");
	const resolved = path.resolve(distDir, relativePath);
	const relativeToDist = path.relative(distDir, resolved);
	if (relativeToDist.startsWith("..") || path.isAbsolute(relativeToDist)) {
		return null;
	}
	return resolved;
}

async function serveStaticFile(
	c: Context<{ Bindings: Env }>,
	filePath: string,
) {
	const stat = await fs.stat(filePath);
	if (!stat.isFile()) {
		return null;
	}

	const body = await fs.readFile(filePath);
	const extension = path.extname(filePath).toLowerCase();
	const isHtml = extension === ".html";

	c.header("Content-Type", getContentTypeForStaticFile(filePath));
	c.header(
		"Cache-Control",
		isHtml
			? "public, max-age=0, s-maxage=60, stale-while-revalidate=300"
			: "public, max-age=31536000, immutable",
	);
	if (isHtml) {
		return c.html(injectRuntimeConfig(body.toString("utf-8")));
	}
	// Hono's Data type expects Uint8Array<ArrayBuffer>; copy into a fresh
	// ArrayBuffer since fs.readFile returns Buffer<ArrayBufferLike>.
	const ab = new ArrayBuffer(body.byteLength);
	new Uint8Array(ab).set(body);
	return c.body(new Uint8Array(ab));
}

const app = new Hono<{ Bindings: Env }>();
app.use("/*", compress({ threshold: 1024 }));

// Browser-origin validation is a security boundary for Streamable HTTP MCP.
// Generic CORS middleware only omits the allow-origin response header for a
// hostile Origin, which still lets the authenticated request execute. Reject
// it before auth/tool dispatch. Requests without Origin remain valid for
// native MCP clients.
const rejectUntrustedMcpOrigin = async (
	c: Context<{ Bindings: Env }>,
	next: Next,
) => {
	const origin = c.req.header("Origin");
	if (origin && !isAllowedCorsOrigin(origin, c.env, c.req.url)) {
		return c.json({ error: "forbidden", message: "Untrusted MCP Origin" }, 403);
	}
	return next();
};
app.use("/mcp", rejectUntrustedMcpOrigin);
app.use("/mcp/*", rejectUntrustedMcpOrigin);

// Enable CORS for MCP clients and frontend
app.use(
	"/*",
	cors({
		origin: (origin, c) => {
			if (!origin)
				return getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
			return isAllowedCorsOrigin(origin, c.env, c.req.url) ? origin : undefined;
		},
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		// X-Lobu-Client is the CSRF gate on /api/local-init; the SPA's local-install
		// auto-sign-in sends it, so it must survive a cross-origin preflight (Vite
		// dev origin → gateway, or the extension iframe).
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"X-MCP-Format",
			"X-Lobu-Client",
			"Mcp-Session-Id",
			"MCP-Protocol-Version",
			"Last-Event-ID",
		],
		exposeHeaders: [
			"Content-Type",
			"Mcp-Session-Id",
			"MCP-Protocol-Version",
			"WWW-Authenticate",
		],
		credentials: true, // Required for better-auth cookies
	}),
);

// Add security headers for ChatGPT connector safety
app.use("/*", async (c, next) => {
	await next();

	// Security headers required for safe API access
	c.header("X-Content-Type-Options", "nosniff");
	// Changed from DENY to SAMEORIGIN to allow ChatGPT connector validation
	c.header("X-Frame-Options", "SAMEORIGIN");
	c.header("X-XSS-Protection", "1; mode=block");
	c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

	// For HTML responses (SPA entrypoints), add a CSP frame-ancestors directive
	// that allows the lobu.ai landing page to embed the app. Modern browsers
	// prefer frame-ancestors over X-Frame-Options when both are present, so this
	// effectively loosens the SAMEORIGIN restriction for our own properties while
	// still blocking third-party clickjacking. JSON/API responses keep the
	// stricter header and no CSP, preserving ChatGPT connector validation.
	const contentType = c.res.headers.get("content-type") ?? "";
	if (contentType.startsWith("text/html")) {
		const rawFrameAncestors = c.env.FRAME_ANCESTORS?.trim();
		const frameAncestors = rawFrameAncestors
			? rawFrameAncestors
					.split(/[\s,]+/)
					.map((entry) => entry.trim())
					.filter((entry) => isValidFrameAncestor(entry))
					.join(" ")
			: "https://lobu.ai https://*.lobu.ai";
		// Owletto for Chrome embeds the whole app in its sidepanel iframe —
		// not just a stub route, the same UI users get in a regular tab. To
		// allow that without opening clickjacking risk to every extension on
		// the user's machine, we narrow the allow to OUR extension IDs (see
		// getOwnedOwlettoExtensionIds — same list the CORS allowlist uses).
		const extensionAllowed = getOwnedOwlettoExtensionIds(c.env)
			.map((id) => ` chrome-extension://${id}`)
			.join("");
		c.header(
			"Content-Security-Policy",
			`frame-ancestors 'self' ${frameAncestors}${extensionAllowed}`,
		);
	}

	c.header("Referrer-Policy", "strict-origin-when-cross-origin");
	// Minimal permissions policy to prevent FLoC without blocking ChatGPT validation
	c.header("Permissions-Policy", "interest-cohort=()");
});

/**
 * Subdomain org extraction middleware
 * Parses Host header for {org}.{zone} pattern and sets subdomainOrg.
 * The zone is AUTH_COOKIE_DOMAIN when set (so per-org hosts like `acme.lobu.ai`
 * resolve even though PUBLIC_GATEWAY_URL is `app.lobu.ai`), otherwise the
 * PUBLIC_GATEWAY_URL hostname. Reserved subdomains (www, api, app, admin, etc.)
 * are not treated as orgs.
 */
const RESERVED_SUBDOMAINS = new Set([
	"www",
	"api",
	"app",
	"admin",
	"auth",
	"mcp",
	"static",
	"assets",
	"cdn",
	"docs",
	"mail",
]);

app.use("/*", async (c, next) => {
	const zone = getSubdomainZone();
	const sub = extractSubdomainOrg(
		c.req.header("host"),
		zone,
		RESERVED_SUBDOMAINS,
	);
	c.set("subdomainOrg", sub);

	// On a subdomain host, redirect HTML GETs that carry a redundant `/{sub}`
	// prefix to the stripped path so direct/bookmarked links normalize to the
	// SPA's expected URL. Scoped to HTML so API clients are unaffected.
	if (
		sub &&
		c.req.method === "GET" &&
		c.req.header("accept")?.includes("text/html")
	) {
		const prefix = `/${sub}`;
		const path = c.req.path;
		if (path === prefix || path.startsWith(`${prefix}/`)) {
			const stripped = path.slice(prefix.length) || "/";
			const url = new URL(c.req.url);
			return c.redirect(`${stripped}${url.search}`, 301);
		}
	}

	return next();
});

app.use("/*", async (c, next) => {
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		return next();
	}

	const pathname = new URL(c.req.url).pathname;
	const shouldSkipRedirect = isExcludedSpaPath(pathname);

	if (shouldSkipRedirect) {
		return next();
	}

	const redirectUrl = getCanonicalRedirectUrl(c.req.url);
	if (redirectUrl) {
		return c.redirect(redirectUrl, 302);
	}

	return next();
});

/**
 * Liveness probe — process is up. Cheap, dependency-free; failing this
 * signals "restart the pod." Don't add DB or downstream checks here, or a
 * transient pooler hiccup will cause a CrashLoop.
 */
app.get("/health", (c) => {
	return c.json({
		status: "ok",
		service: "lobu-api",
		timestamp: new Date().toISOString(),
		...getRuntimeInfo(c.env),
	});
});

/**
 * Readiness probe — process is up AND can talk to the database. Failing
 * this drops the pod from the Service's endpoint set without restarting
 * it, which is the right semantic for transient DB unavailability.
 */
app.get("/health/ready", async (c) => {
	// Once shutdown has begun, report unready so the LB drains this pod's
	// endpoint before teardown severs in-flight connections (see lifecycle-state.ts).
	if (isShuttingDown()) {
		return c.json({ status: "draining", service: "lobu-api" }, 503);
	}
	try {
		const sql = getDb();
		await sql`SELECT 1`;
		return c.json({ status: "ok", service: "lobu-api" });
	} catch (error) {
		return c.json(
			{ status: "unready", service: "lobu-api", error: errorMessage(error) },
			503,
		);
	}
});

/**
 * Orchestrator health / metric endpoint.
 *
 * Exposes the live count of `sql.reserve()` connections held by
 * `acquireConversationLock` (snapshot-mode per-conversation locks) so an
 * operator can spot pool pressure before it manifests as gateway query
 * starvation. Returns `near_cap: true` once the count crosses 80% of the
 * configured cap. Default cap is derived from DB_POOL_MAX so it can't
 * exceed available pool slots — operators override with
 * LOBU_MAX_RESERVED_LOCKS. The endpoint is cheap and dependency-free;
 * safe to scrape every few seconds.
 */
app.get("/health/orchestrator", (c) => {
	const count = getReservedLockCount();
	const cap = getMaxReservedLocks();
	const nearCap = cap > 0 && count >= Math.ceil(cap * 0.8);
	return c.json({
		status: "ok",
		reserved_conversation_locks: count,
		reserved_conversation_locks_cap: cap,
		near_cap: nearCap,
	});
});

/**
 * Scheduler health check endpoint
 * Returns detailed metrics about the feed scheduling system
 */
app.get("/health/scheduler", async (c) => {
	try {
		const health = await getSchedulerHealth(c.env);
		return c.json(health, health.healthy ? 200 : 503);
	} catch (error) {
		return c.json(
			{
				healthy: false,
				issues: ["Failed to check scheduler health"],
				error: errorMessage(error),
			},
			500,
		);
	}
});

/**
 * Better-Auth routes
 * Handles all authentication requests: OAuth, magic link, phone OTP, sessions.
 *
 * Single-user-mode enforcement (`LOBU_SINGLE_USER=1`) lives at
 * `databaseHooks.user.create.before` (auth/index.tsx), not here. The DB hook
 * sees every account-creation path — sign-up/email, magic-link verify, OAuth
 * callback — and refuses a second user with a structured `APIError`. A prior
 * path-based fast-fail at this layer also blocked the *first* `/sign-up`,
 * which made fresh local-first installs unable to register; that guard has
 * been removed in favour of the always-correct DB-hook chokepoint.
 */
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
	const auth = await createAuth(c.env, c.req.raw);
	// better-call crashes with "Unexpected end of JSON input" when a POST has
	// Content-Type: application/json but an empty body. Ensure a valid body.
	let request = c.req.raw;
	if (c.req.method === "POST") {
		const ct = c.req.header("content-type") || "";
		if (
			ct.includes("application/json") &&
			c.req.header("content-length") === "0"
		) {
			request = new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: "{}",
			});
		}
	}
	// Better Auth reads the raw jar and takes the FIRST session cookie, so a
	// browser carrying a stale twin gets `null` from /api/auth/get-session — the
	// call the web app uses to ask whether it is signed in. Hand it a jar already
	// reduced to the live cookie. Why: auth/resolve-session.ts.
	const collapsed = await collapseSessionCookies(auth, request.headers);
	if (collapsed !== request.headers) {
		request = new Request(request.url, {
			method: request.method,
			headers: collapsed,
			body: request.method === "GET" || request.method === "HEAD"
				? undefined
				: await request.blob(),
		});
	}
	const response = await auth.handler(request);
	// Collapse the cookie jar back to a single scope, so sign-in is authoritative
	// for every auth method at once. Why: auth/session-cookie-scope.ts.
	return convergeResponseCookieScope(response, {
		cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
		isHttps: resolveBaseUrl({ request: c.req.raw }).startsWith("https://"),
	});
});

/**
 * Credential management routes
 * Handles linking OAuth accounts to connections
 */
app.route("/api", credentialRoutes);

/**
 * OAuth 2.1 Authorization Server routes
 * Provides MCP authentication for HTTP clients (Claude.ai, ChatGPT)
 * Endpoints: /.well-known/*, /oauth/*
 */
app.route("/", oauthRoutes);
// Serve OAuth discovery relative to MCP path (Gemini CLI fetches /.well-known/* relative to transport URL)
app.route("/mcp", oauthRoutes);

/**
 * Connect Link routes (unauthenticated, token-gated)
 * Used by MCP clients to complete OAuth/env_keys auth for connections
 */
app.route("/connect", connectRoutes);

/**
 * Managed-connector connection-token route — PAT-gated. A managed connector
 * lives in a PUBLIC org with a managed `oauth_app`; a user joins it and
 * connects normally (a connection owned by them). Their LOCAL Lobu fetches a
 * fresh access token for its OWN user's connection via POST
 * /oauth/connection-token, authenticating with the user's cloud PAT. The
 * managed client secret + refresh token never leave the cloud.
 */
app.route("/", connectionTokenRoutes);

/**
 * Logo endpoint for MCP/OAuth client metadata.
 */
app.get("/logo.png", (c) => {
	const body = Buffer.from(LOBU_LOGO_PNG_BASE64, "base64");

	c.header("Content-Type", "image/png");
	c.header("Cache-Control", "public, max-age=31536000, immutable");
	return c.body(body);
});

/**
 * Legal/Terms endpoint for ChatGPT connector validation
 */
app.get("/legal", (c) => {
	return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Legal Information - Lobu</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    p { color: #666; }
  </style>
</head>
<body>
  <h1>Lobu</h1>
  <p>Legal Information and Terms of Service</p>

  <h2>Service Description</h2>
  <p>This is an AI-powered MCP server for collecting customer content and building searchable workspace knowledge across multiple platforms including Reddit, Trustpilot, App Stores, Google Maps, GitHub, Hacker News, and more.</p>

  <h2>Data Collection</h2>
  <p>This service collects publicly available user events from various platforms. All data is collected in accordance with each platform's terms of service and API usage policies.</p>

  <h2>Privacy</h2>
  <p>We process publicly available content data. No personal information is collected beyond what is publicly visible on the source platforms.</p>

  <h2>Usage Terms</h2>
  <p>This service is provided as-is for research and intelligence purposes. Users are responsible for ensuring their use of insights complies with applicable laws and regulations.</p>

  <h2>Contact</h2>
  <p>For questions or concerns, please contact: support@example.com</p>

  <p style="margin-top: 40px; font-size: 0.9em; color: #999;">Last updated: ${new Date().toISOString().split("T")[0]}</p>
</body>
</html>`);
});

/**
 * REST API endpoints for ChatGPT Custom Actions and lightweight wrappers.
 * Agent and internal tools are exposed through the generic
 * /api/:orgSlug/:toolName proxy; MCP Apps presentation tools stay MCP-only.
 */
// Health check and worker endpoints must be before mcpAuth middleware
app.get("/api/health", restHealth);

import { createRuntimeRoutes } from "./gateway/routes/internal/runtime";
// Internal smoke-test dispatch. Authentication is a shared bearer
// (`SMOKE_TEST_TOKEN`) loaded into the pod via the deployment Secret —
// not exposed to public ingress consumers. Mounted before mcpAuth so the
// route handles its own auth without falling into the OAuth-bearer path.
import { createSmokeRoutes } from "./gateway/routes/internal/smoke";

app.route("/api/internal/smoke", createSmokeRoutes());
app.route("", createRuntimeRoutes());

import { createSkillRoutes } from "./gateway/routes/public/skill";
// The onboarding skill (same markdown as the `skill://lobu` MCP resource) as a
// plain HTTP GET — public, so a browser or a bash-only agent can fetch it.
app.route("/api", createSkillRoutes());

import {
	activatePageRun,
	completeActionRun,
	completeAgentTurnRun,
	completeAuthRun,
	completeEmbeddings,
	completeAutomationRun,
	completeDeviceChatRun,
	completeWorkerJob,
	createMyDeviceAuthProfile,
	createMyDeviceFeed,
	deleteDeviceWorker,
	deleteMyDeviceAuthProfile,
	deleteMyDeviceFeed,
	emitAuthArtifact,
	fetchEventsForEmbedding,
	getActiveAuthRun,
	getAuthRun,
	heartbeat,
	listDeviceWorkers,
	listMyDeviceAuthProfiles,
	listMyDeviceFeeds,
	mintDeviceChildToken,
	pollAuthSignal,
	pollWorkerJob,
	postAuthSignal,
	streamContent,
	triggerAutomationForDevice,
	updateDeviceWorkerOrg,
} from "./worker-api";

// Worker API authentication.
//
// Two ways to authenticate a request to /api/workers/*:
//
//   1. **Trusted worker** — `Authorization: Bearer ${WORKER_API_TOKEN}`. Shared
//      secret in the server env; used by server-side connector-worker fleets.
//      Full access to all orgs (existing model).
//
//   2. **User-scoped worker** — user OAuth bearer or PAT (Lobu for Mac
//      uses an OAuth bearer from the device-code flow). `/api/workers/*` carries
//      no org slug, so the token must resolve to an org on its own (PAT/OAuth
//      carry a bound org — a bare session cookie won't work here). The worker is
//      scoped to that bound org plus the user's personal org (where device
//      connectors auto-wire); poll filters on that set, and heartbeat/stream/
//      complete additionally re-check the run is theirs. It does NOT get the
//      user's other org memberships, so a token narrowly scoped to org A can't
//      reach into org B.
//
// In dev (no WORKER_API_TOKEN configured) and with no user auth, requests pass
// through unauthenticated — the existing local-dev access semantics.
app.use("/api/workers/*", async (c, next) => {
	const expected = c.env.WORKER_API_TOKEN;
	const provided = c.req.header("Authorization")?.replace("Bearer ", "");

	if (compareWorkerToken(provided, expected)) {
		c.set("workerAuthMode", "trusted");
		c.set("workerUserId", null);
		c.set("workerOrgIds", null);
		return next();
	}

	return mcpAuth(c, async () => {
		if (c.var.mcpIsAuthenticated && c.var.user?.id) {
			// A browser session is never a worker credential. The Owletto extension's
			// service-worker poll runs from a page Chrome treats as having host
			// permission, so Chrome attaches the gateway's Better Auth session cookie
			// to the request regardless of `credentials: "omit"` (verified: omit does
			// NOT suppress it for host-permission fetches). When the extension's
			// OAuth access token expires, the Bearer fails and mcpAuth falls back to
			// that cookie — authenticating the user but with no worker scopes. That
			// used to return 403 below, which the poller can't recover from (only 401
			// triggers tryRefreshToken). Returning 401 for any session-sourced auth
			// makes the expired token surface as the refreshable 401 it actually is.
			// Safe: real workers authenticate with a scoped PAT/OAuth token
			// (authSource 'pat'/'oauth') or the trusted WORKER_API_TOKEN (handled
			// above, never reaches here); a session has no worker scopes and would
			// have been rejected anyway — this only changes 403 → 401 for it.
			if (c.var.authSource === "session") {
				return c.json(
					{
						error: "invalid_token",
						error_description:
							"Worker endpoints require a worker token, not a browser session",
					},
					401,
				);
			}
			// User-scoped workers can only hit the endpoints needed to run a job
			// end-to-end. Auth-artifact / embeddings / repair-thread endpoints are
			// for server-side fleets and would leak across orgs without per-handler
			// scoping (which we haven't added). Block them at the door.
			const allowedPathsForUserWorker = new Set([
				"/api/workers/poll",
				"/api/workers/activate-page",
				"/api/workers/heartbeat",
				"/api/workers/stream",
				"/api/workers/complete",
				// Action runs (run_type='action') finalize via /complete-action,
				// which persists action_output. The handler still goes through
				// authorizeRunForWorker so a user worker can only finalize runs
				// it claimed. Required for chrome-extension action tools to
				// return their observation back to the gateway.
				"/api/workers/complete-action",
			]);
			const requestPath = new URL(c.req.url).pathname;
			const isAuthProfileSubpath = requestPath.startsWith(
				"/api/workers/me/auth-profiles",
			);
			const isFeedSubpath = requestPath.startsWith("/api/workers/me/feeds");
			// /api/workers/me/runs/<runId>/complete-automation — device-side Automation
			// completion endpoint added in #798. The handler does its own
			// `authorizeRunForWorker` claim-ownership check, so an org-scope
			// gate here would just block legitimate posts from the bound device.
			const isAutomationCompleteSubpath =
				/^\/api\/workers\/me\/runs\/\d+\/complete-automation$/.test(requestPath);
			// Device chat uses the same user-scoped daemon and performs exact run,
			// claimant, and pinned-device authorization in its handler.
			const isDeviceChatCompleteSubpath =
				/^\/api\/workers\/me\/runs\/\d+\/complete-chat$/.test(requestPath);
			// /api/workers/me/automations/<automation_id>/trigger — device-side manual
			// re-run endpoint. The handler does its own bound-workerId →
			// device_worker_id match, so the org-scope gate here would block
			// legitimate triggers from the pinned device.
			const isAutomationTriggerSubpath =
				/^\/api\/workers\/me\/automations\/\d+\/trigger$/.test(requestPath);
			if (
				!allowedPathsForUserWorker.has(requestPath) &&
				!isAuthProfileSubpath &&
				!isFeedSubpath &&
				!isAutomationCompleteSubpath &&
				!isDeviceChatCompleteSubpath &&
				!isAutomationTriggerSubpath
			) {
				return c.json(
					{ error: "Endpoint not available to user-scoped workers" },
					403,
				);
			}
			const scopes = c.var.mcpAuthInfo?.scopes ?? [];
			if (
				!scopes.includes("device_worker:run") &&
				!scopes.includes("mcp:write") &&
				!scopes.includes("mcp:admin")
			) {
				return c.json(
					{ error: "Worker token missing device_worker:run scope" },
					403,
				);
			}
			const userId = c.var.user.id;
			// A device worker is scoped to the org its token is bound to (if any —
			// mcpAuth verified membership) plus the user's personal org, the
			// auto-wire target. Device-code tokens (Lobu for Mac/iPhone) often aren't
			// bound to any org, so the personal org alone is a valid scope.
			const boundOrgId = c.var.organizationId;
			const personalOrg = await findExistingPersonalOrg(userId, getDb());
			const orgIds = Array.from(
				new Set(
					[boundOrgId, personalOrg?.id].filter((id): id is string => !!id),
				),
			);
			if (orgIds.length === 0) {
				return c.json(
					{ error: "No organization in scope for this worker token" },
					403,
				);
			}
			c.set("workerAuthMode", "user");
			c.set("workerUserId", userId);
			c.set("workerOrgIds", orgIds);
			return next();
		}

		if (expected) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		// Anonymous fallback is a local-dev convenience only. In cloud/prod mode
		// (LOBU_CLOUD_MODE=1) an operator who forgets to set WORKER_API_TOKEN must
		// NOT silently expose poll/heartbeat/stream/complete/dispatch to anonymous
		// callers — fail closed instead of opening the worker fleet API.
		if (isCloudMode()) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		c.set("workerAuthMode", "anonymous");
		c.set("workerUserId", null);
		c.set("workerOrgIds", null);
		return next();
	});
});

app.post("/api/workers/poll", pollWorkerJob);
app.post("/api/workers/activate-page", activatePageRun);
app.post("/api/workers/heartbeat", heartbeat);
app.post("/api/workers/stream", streamContent);
app.post("/api/workers/complete", completeWorkerJob);
app.post("/api/workers/complete-action", completeActionRun);
// Fleet-only, deliberately absent from `allowedPathsForUserWorker`: an agent
// turn carries the organization's provider proxy and never runs on a device.
app.post("/api/workers/complete-agent-turn", completeAgentTurnRun);

// Bridge that lets connector-worker fleets dispatch chrome connector actions
// against a paired Owletto extension. See dispatch-chrome-action.ts.
import { dispatchChromeAction } from "./worker-api/dispatch-chrome-action";
import { stampSlackIdentityForUser } from "./auth/subject-identities";
import { collapseSessionCookies, resolveSession } from './auth/resolve-session';

app.post("/api/workers/dispatch-chrome-action", dispatchChromeAction);
app.post("/api/workers/complete-embeddings", completeEmbeddings);
app.post("/api/workers/me/runs/:runId/complete-automation", completeAutomationRun);
app.post("/api/workers/me/runs/:runId/complete-chat", completeDeviceChatRun);
app.post(
	"/api/workers/me/automations/:automation_id/trigger",
	triggerAutomationForDevice,
);
app.post("/api/workers/fetch-events", fetchEventsForEmbedding);
app.post("/api/workers/emit-auth-artifact", emitAuthArtifact);
app.post("/api/workers/poll-auth-signal", pollAuthSignal);
app.post("/api/workers/complete-auth", completeAuthRun);
app.get("/api/workers/me/auth-profiles", listMyDeviceAuthProfiles);
app.post("/api/workers/me/auth-profiles", createMyDeviceAuthProfile);
app.delete("/api/workers/me/auth-profiles/:id", deleteMyDeviceAuthProfile);
app.get("/api/workers/me/feeds", listMyDeviceFeeds);
app.post("/api/workers/me/feeds", createMyDeviceFeed);
app.delete("/api/workers/me/feeds/:id", deleteMyDeviceFeed);
// Device worker registry. Authenticated (mcpAuth); returns the calling user's
// devices. Lives under /api/me/ so the workspace resolver treats it as
// user-scoped (no org slug in the URL).
app.get("/api/me/devices", mcpAuth, listDeviceWorkers);
app.patch("/api/me/devices/:id", mcpAuth, updateDeviceWorkerOrg);
app.delete("/api/me/devices/:id", mcpAuth, deleteDeviceWorker);
// Mint a child device-worker token for the caller — used by the Owletto Mac
// bridge's native-messaging host to auto-pair Owletto for Chrome.
app.post("/api/me/devices/mint-child-token", mcpAuth, mintDeviceChildToken);
// UI → worker signal channel. Separate path prefix so the worker API auth
// middleware above doesn't cover it (this one is hit from the web session).
app.get("/api/auth-runs/active", getActiveAuthRun);
app.get("/api/auth-runs/:id", getAuthRun);
app.post("/api/auth-runs/:id/signal", postAuthSignal);

/**
 * Auth configuration endpoint
 * Returns enabled authentication methods based on server env and connector_definitions
 */
app.get("/api/auth-config", async (c) => {
	return c.json(await getAuthConfigFromEnv(c.env, { request: c.req.raw }));
});

/**
 * Invitation preview endpoint (unauthenticated, rate-limited).
 *
 * Given an invitation ID, returns the minimum info needed to prefill the
 * login page: { email, organizationName }. Responds 404 for any non-pending
 * or expired invitation so we don't leak invitation state.
 *
 * Safe because invitation IDs are UUIDs (unguessable). Note: anyone holding
 * the emailed invite URL can learn the org name and invited email — no
 * additional disclosure beyond the URL itself.
 */
app.get("/api/invitation-preview", async (c) => {
	const rateLimiter = getRateLimiter();
	const clientIP = getClientIP(c.req.raw, c.var.peerRemoteAddress);
	const rateLimit = rateLimiter.checkLimit(
		`rate:invitation-preview:${clientIP}`,
		RateLimitPresets.INVITATION_PREVIEW_PER_IP_MINUTE,
	);
	if (!rateLimit.allowed) {
		return c.json({ error: rateLimit.errorMessage }, 429);
	}

	const invitationId = c.req.query("id");
	if (!invitationId) {
		return c.json({ error: "not_found" }, 404);
	}

	const sql = getDb();
	const rows = await sql<{ email: string; organization_name: string }>`
    SELECT i.email, o.name AS organization_name
    FROM invitation i
    JOIN "organization" o ON o.id = i."organizationId"
    WHERE i.id = ${invitationId}
      AND i.status = 'pending'
      AND i."expiresAt" > NOW()
    LIMIT 1
  `;

	const row = rows[0];
	if (!row) {
		return c.json({ error: "not_found" }, 404);
	}

	return c.json({
		email: row.email,
		organizationName: row.organization_name,
	});
});

app.get("/robots.txt", async (c) => {
	const origin = getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
	c.header("Content-Type", "text/plain; charset=utf-8");
	c.header("Cache-Control", PUBLIC_XML_CACHE);
	return c.body(buildRobotsTxt(origin));
});

app.get("/sitemap.xml", async (c) => {
	const origin = getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
	const entries = await buildSitemapEntries(origin);
	c.header("Content-Type", "application/xml; charset=utf-8");
	c.header("Cache-Control", PUBLIC_XML_CACHE);
	return c.body(buildSitemapXml(entries));
});

// Organizations endpoint — returns orgs the authenticated user belongs to
app.get("/api/organizations", async (c) => {
	const provider = getWorkspaceProvider();
	const search = c.req.query("search")?.toLowerCase().trim();

	let userId: string | null = null;
	try {
		const auth = await createAuth(c.env);
		const session = await resolveSession(auth, c.req.raw.headers);
		userId = session?.session?.userId || null;
	} catch {
		// No session
	}

	const orgs = await provider.listOrganizations(search, userId);
	return c.json({ organizations: orgs });
});

// Preview: mint a link code for an agent on a hosted preview bot (Slack,
// Telegram, …). The code is redeemed by DMing that bot — no relay endpoint here.
app.post("/api/:orgSlug/preview/claims", mcpAuth, createPreviewClaim);

// Notifications
app.get(
	"/api/:orgSlug/connector-run/auth-profile/:slug",
	mcpAuth,
	restGetAuthProfileForRun,
);
app.get("/api/:orgSlug/connector-run/feed/:id", mcpAuth, restGetFeedForRun);

app.get("/api/:orgSlug/notifications", mcpAuth, restListNotifications);
app.get(
	"/api/:orgSlug/notifications/unread-count",
	mcpAuth,
	restGetUnreadCount,
);
app.patch("/api/:orgSlug/notifications/:id/read", mcpAuth, restMarkAsRead);
app.post(
	"/api/:orgSlug/notifications/:id/browser-handoff/recreate",
	mcpAuth,
	restRecreateBrowserHandoff,
);
app.post(
	"/api/:orgSlug/notifications/mark-all-read",
	mcpAuth,
	restMarkAllAsRead,
);
app.delete("/api/:orgSlug/notifications/:id", mcpAuth, restDeleteNotification);
app.post(
	"/api/:orgSlug/events/:eventId/actions/:action",
	mcpAuth,
	restInvokeEventAction,
);

app.get("/api/:orgSlug/knowledge/search", mcpAuth, restSearchKnowledge);
app.get("/api/:orgSlug/public/knowledge/search", publicRestSearchKnowledge);
app.get("/api/:orgSlug/public/classifiers", publicRestListClassifiers);
app.get("/api/:orgSlug/public/connectors", publicRestListConnectors);
app.get(
	"/api/:orgSlug/public/connectors/:connectorKey",
	publicRestGetConnector,
);
app.get("/api/:orgSlug/public/organization", publicRestGetOrganization);
app.get("/api/:orgSlug/public/events", publicRestEventsStream);
app.patch(
	"/api/:orgSlug/content/:id/classifications/:classifier_slug",
	mcpAuth,
	restUpdateContentClassification,
);
app.get("/api/:orgSlug/automations", mcpAuth, restGetAutomations);
app.get("/api/:orgSlug/public/automations", publicRestGetAutomations);

async function handleContentDistribution(c: Context<{ Bindings: Env }>) {
	const sql = getDb();
	const entityId = Number(c.req.param("entityId"));
	const organizationId = c.var.organizationId;

	try {
		// Parse query parameters
		const connectionIdsParam = c.req.query("connection_ids");
		const connectionIds = connectionIdsParam
			? connectionIdsParam
					.split(",")
					.map((value) => Number(value.trim()))
					.filter((value) => Number.isInteger(value) && value > 0)
			: [];
		const groupByPlatform = c.req.query("group_by_platform") === "true";

		const connectionFilter =
			connectionIds.length > 0
				? `AND f.connection_id IN (${connectionIds.map((_, i) => `$${i + 3}`).join(", ")})`
				: "";
		const params: unknown[] = [entityId, organizationId, ...connectionIds];

		const platformSelect = groupByPlatform
			? ", f.connector_key as platform"
			: "";
		const platformGroupBy = groupByPlatform ? ", f.connector_key" : "";

		const distribution = await sql.unsafe(
			`
      SELECT
        TO_CHAR(DATE_TRUNC('day', COALESCE(f.occurred_at, f.created_at)), 'YYYY-MM-DD') as date
        ${platformSelect},
        CAST(COUNT(*) AS INTEGER) as count
      FROM current_event_records f
      WHERE ${entityLinkMatchSql("$1::bigint", "f")}
        AND EXISTS (SELECT 1 FROM entities e WHERE e.id = $1 AND e.organization_id = $2)
        ${connectionFilter}
      GROUP BY TO_CHAR(DATE_TRUNC('day', COALESCE(f.occurred_at, f.created_at)), 'YYYY-MM-DD')${platformGroupBy}
      ORDER BY date ASC
    `,
			params,
		);
		return c.json({ distribution });
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 500);
	}
}

app.get(
	"/api/:orgSlug/entities/:entityId/content-distribution",
	mcpAuth,
	handleContentDistribution,
);

// ============================================
// V1 Integration Platform REST Routes
// ============================================

// Read-only proxies (connections list/get, runs, available actions) are
// registered from `REST_TOOL_GET_ROUTES` so the `(tool, action)` the public-org
// middleware checks is the one the handler actually runs.
for (const route of REST_TOOL_GET_ROUTES) {
	app.get(route.routePath, mcpAuth, async (c) =>
		restToolAction(c, route.tool, route.action, route.args(c))
	);
}

// Connections
app.post("/api/:orgSlug/connections", mcpAuth, async (c) => {
	const body = await c.req.json();
	return restToolAction(c, "manage_connections", "create", body);
});
app.delete("/api/:orgSlug/connections/:id", mcpAuth, async (c) => {
	return restToolAction(c, "manage_connections", "delete", {
		connection_id: Number(c.req.param("id")),
	});
});

function serializeEntityApprovalPolicy(policy: EntityApprovalPolicy) {
	return {
		id: policy.id,
		organization_id: policy.organizationId,
		resource_class: policy.resourceClass,
		principal_kind: policy.principalKind,
		principal_id: policy.principalId,
		operation_key: policy.operationKey,
		target_agent_id: policy.targetAgentId,
		entity_type_slug: policy.entityTypeSlug,
		field_path: policy.fieldPath,
		entity_id: policy.entityId,
		create_mode: policy.createMode,
		update_mode: policy.updateMode,
		delete_mode: policy.deleteMode,
		// The full per-action effect map (incl. deny/disabled/execute), for the
		// agent Permissions UI which the create/update/delete triple can't express.
		effects: policy.effects,
		approval_connection_id: policy.deliveryTarget.connectionId,
		approval_channel_id: policy.deliveryTarget.channelId,
		approval_team_id: policy.deliveryTarget.teamId,
		approval_channel_name: policy.deliveryTarget.channelName,
	};
}

async function requireOrganizationSettingsAdmin(c: Context) {
	const organizationId = c.get("organizationId");
	const memberRole = c.get("memberRole");

	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}

	if (memberRole !== "owner" && memberRole !== "admin") {
		return c.json(
			{
				error: "forbidden",
				message: "Workspace settings require owner or admin access.",
			},
			403,
		);
	}

	const authSource = c.get("authSource");
	if (authSource === "pat") {
		return c.json(
			{
				error: "forbidden",
				message: "Use OAuth or a web session to change workspace settings.",
			},
			403,
		);
	}

	const scopes = c.get("mcpAuthInfo")?.scopes ?? [];
	if (authSource === "oauth" && !scopes.includes("mcp:admin")) {
		return c.json(
			{
				error: "forbidden",
				message: "Workspace settings changes require mcp:admin scope.",
			},
			403,
		);
	}

	return null;
}

// ---------------------------------------------------------------------------
// Agent permissions ("Guardrails" is the separate LLM-judge surface; this is the
// deterministic write-gate envelope). Returns the ORG FLOOR rows (principal_kind
// NULL) and THIS AGENT's rows across all three write classes, so the UI can show
// the floor as a non-loosenable baseline and the agent's overrides on top.
app.get("/api/:orgSlug/agent/:agentId/permissions", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}
	const agentId = c.req.param("agentId");
	const all = await listEntityApprovalPolicies(organizationId);
	// The matrix models ONLY blanket (null entity_type) and entity-type scopes.
	// Field-scoped (fieldPath) and single-entity (entityId) rows are finer than the
	// matrix can express: the client keys agent rows by (class, mode, type) alone,
	// so a field/entity row would be misrendered as type-wide and editing it would
	// silently widen it into a type policy. Exclude them from BOTH lists — they are
	// managed on the entity/field surfaces, not this agent matrix.
	const typeScoped = (p: EntityApprovalPolicy) =>
		p.fieldPath === null && p.entityId === null;
	// Floor = the non-loosenable baseline this agent inherits. TWO kinds of row bind
	// it (both fold into the write-gate for this agent via loadCandidatePolicies, and
	// neither is editable on THIS per-agent surface):
	//  - any-principal rows (principal_kind NULL) — the org-wide floor, and
	//  - KIND-WIDE agent rows (principal_kind 'agent', principal_id NULL) — an
	//    "all agents" policy that applies to every agent. Omitting these made the
	//    matrix show/permit values LOOSER than the resolver enforces.
	// Agent = rows pinned to THIS agent id (the editable overrides). An automation-kind
	// row is NOT the agent's envelope (automations inherit the agent envelope in
	// autonomous mode; they have no separate principal here).
	const floor = all.filter(
		(p) =>
			typeScoped(p) &&
			(p.principalKind === null ||
				(p.principalKind === "agent" && p.principalId === null)),
	);
	// Agent rows: this agent only.
	const agent = all.filter(
		(p) =>
			p.principalKind === "agent" &&
			p.principalId === agentId &&
			typeScoped(p),
	);
	// Types the org can create/update entities for: its own PLUS any public-catalog
	// org's (visibility='public') — the same local-or-public resolution entity
	// creation uses. The write gate keys on the slug, so a catalog-backed type
	// (e.g. `company`) must be offerable as a per-type exception. Dedupe by slug,
	// preferring the org-owned row. `$`-prefixed types are platform-managed
	// system types, so omit them from operator-authored entity mutation policies.
	const typeRows = await getDb()<{
		slug: string;
		name: string;
		icon: string | null;
	}>`
    SELECT slug, name, icon FROM (
      SELECT DISTINCT ON (et.slug) et.slug, et.name, et.icon
      FROM entity_types et
      LEFT JOIN organization o ON o.id = et.organization_id
      WHERE et.deleted_at IS NULL
        AND et.slug NOT LIKE '$%'
        AND (et.organization_id = ${organizationId} OR o.visibility = 'public')
      ORDER BY et.slug, (et.organization_id = ${organizationId}) DESC, et.id ASC
    ) t
    ORDER BY name ASC
  `;
	// Write ops for the connector exception picker (opt-in rows, not always expanded).
	// Only write ops — reads are not gated by agent connector_action policy
	// (MCP readOnlyHint / kind=read stay on connection action_modes alone).
	const opList = await listOperations({
		organizationId,
		kind: "write",
		includeInputSchema: false,
		includeOutputSchema: false,
		limit: Number.MAX_SAFE_INTEGER,
	});
	const seenOps = new Set<string>();
	const operations: Array<{
		operation_key: string;
		name: string;
		connector_key: string;
		connector_name: string;
		kind: "read" | "write";
		requires_approval: boolean;
		destructive: boolean;
	}> = [];
	for (const op of opList.operations) {
		const key = qualifiedOperationKey(op.connector_key, op.operation_key);
		if (seenOps.has(key)) continue;
		seenOps.add(key);
		operations.push({
			operation_key: key,
			name: op.name,
			connector_key: op.connector_key,
			connector_name: op.connector_name,
			kind: op.kind === "read" ? "read" : "write",
			requires_approval: op.requires_approval === true,
			destructive: op.annotations?.destructiveHint === true,
		});
	}
	// Agents in this org (for agent_config target exceptions). Exclude the agent
	// whose envelope we're editing so self-target rows aren't offered by default.
	const agentRows = await getDb()<{ id: string; name: string }>`
    SELECT id, name FROM agents
    WHERE organization_id = ${organizationId}
    ORDER BY name ASC, id ASC
  `;
	return c.json({
		floor: floor.map(serializeEntityApprovalPolicy),
		agent: agent.map(serializeEntityApprovalPolicy),
		entity_types: typeRows.map((r) => ({
			slug: r.slug,
			name: r.name,
			icon: r.icon,
		})),
		connector_operations: operations,
		agents: agentRows.map((a) => ({ id: a.id, name: a.name })),
	});
});

// Upsert one agent policy row: a (class, entity_type?, mode?) scope with a full
// per-action effect map. Effects may be auto/approval/deny/disabled — the UI, not
// the create/update/delete triple, is the source of truth here.
app.put("/api/:orgSlug/agent/:agentId/permissions", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}
	const agentId = c.req.param("agentId");

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: "invalid_request", message: "Request body must be JSON." },
			400,
		);
	}
	// Valid JSON `null` / an array / a primitive parses without throwing but isn't a
	// policy body — dereferencing body.resource_class below would 500. Require a plain
	// object so we return the intended 400.
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return c.json(
			{ error: "invalid_request", message: "Request body must be a JSON object." },
			400,
		);
	}

	const resourceClass = isWriteResourceClass(body.resource_class)
			? body.resource_class
			: null;
	if (!resourceClass) {
		return c.json(
			{
				error: "invalid_request",
				message:
					"resource_class must be entity, agent_config, connector_action, or entity_schema.",
			},
			400,
		);
	}

	// The per-action effect map. This PUT REPLACES the row's whole child-effect set,
	// so a silently-dropped bad entry would ERASE an existing effect (e.g. a stale
	// client sending an entity `execute` could wipe a stored `delete=deny` back to
	// the auto default). REJECT the request on any invalid entry instead of filtering
	// or clamping — an unknown action, a non-effect value, or an (action,effect) pair
	// illegal for this class all 400.
	// Must be a plain OBJECT map. An ARRAY passes `typeof === "object"` but yields no
	// Object.entries → the replace-all upsert would wipe the row's stored effects
	// (erasing deny/approval). Reject arrays explicitly.
	const rawEffects =
		typeof body.effects === "object" &&
		body.effects !== null &&
		!Array.isArray(body.effects)
			? (body.effects as Record<string, unknown>)
			: null;
	if (!rawEffects) {
		return c.json(
			{ error: "invalid_request", message: "effects must be a JSON object." },
			400,
		);
	}
	const effects: Partial<Record<WriteAction, EntityMutationMode>> = {};
	for (const [action, effect] of Object.entries(rawEffects)) {
		if (
			!isEntityMutationMode(effect) ||
			!isLegalActionEffect(resourceClass, action as WriteAction, effect)
		) {
			return c.json(
				{
					error: "invalid_request",
					message: `Illegal effect for ${resourceClass}: '${action}' = '${String(effect)}'.`,
				},
				400,
			);
		}
		effects[action as WriteAction] = effect;
	}

	// entity_type_slug selects the per-type row (null = the blanket all-types row).
	// Only the `entity` class is type-scoped. A present-but-invalid slug (number,
	// whitespace) OR a slug on a NON-entity class must not silently coerce to null and
	// overwrite the broad blanket policy — 400.
	const slugPresent =
		body.entity_type_slug !== undefined && body.entity_type_slug !== null;
	if (slugPresent && resourceClass !== "entity") {
		return c.json(
			{
				error: "invalid_request",
				message: `entity_type_slug is only valid for resource_class 'entity', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (
		slugPresent &&
		(typeof body.entity_type_slug !== "string" ||
			body.entity_type_slug.trim() === "")
	) {
		return c.json(
			{
				error: "invalid_request",
				message: "entity_type_slug must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const entityTypeSlug =
		resourceClass === "entity" &&
		typeof body.entity_type_slug === "string" &&
		body.entity_type_slug.trim()
			? body.entity_type_slug.trim()
			: null;

	// operation_key selects the per-operation connector row (null = the blanket
	// execute row). Only `connector_action` is op-scoped. Same rules as
	// entity_type_slug: a present-but-invalid key, or a key on a non-connector class,
	// must 400 rather than silently coerce to null and overwrite the blanket rule.
	const opKeyPresent =
		body.operation_key !== undefined && body.operation_key !== null;
	if (opKeyPresent && resourceClass !== "connector_action") {
		return c.json(
			{
				error: "invalid_request",
				message: `operation_key is only valid for resource_class 'connector_action', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (
		opKeyPresent &&
		(typeof body.operation_key !== "string" ||
			body.operation_key.trim() === "")
	) {
		return c.json(
			{
				error: "invalid_request",
				message: "operation_key must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const operationKey =
		resourceClass === "connector_action" &&
		typeof body.operation_key === "string" &&
		body.operation_key.trim()
			? body.operation_key.trim()
			: null;
	// A per-op rule must name an operation the org actually exposes — else a typo
	// would create a dead row that gates nothing and clutters the matrix. The client
	// sends the CONNECTOR-QUALIFIED key (`connector_key::op`); validate against the
	// same qualified catalog the matrix renders.
	if (operationKey) {
		const known = await listOperations({
			organizationId,
			kind: "write",
			includeInputSchema: false,
			includeOutputSchema: false,
			limit: Number.MAX_SAFE_INTEGER,
		});
		const knownQualified = new Set(
			known.operations.map((op) =>
				qualifiedOperationKey(op.connector_key, op.operation_key),
			),
		);
		if (!knownQualified.has(operationKey)) {
			return c.json(
				{
					error: "invalid_request",
					message: `Unknown connector operation '${operationKey}' for this workspace.`,
				},
				400,
			);
		}
	}

	// target_agent_id: agent_config exception for read/update/delete of a specific agent.
	const targetPresent =
		body.target_agent_id !== undefined && body.target_agent_id !== null;
	if (targetPresent && resourceClass !== "agent_config") {
		return c.json(
			{
				error: "invalid_request",
				message: `target_agent_id is only valid for resource_class 'agent_config', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (
		targetPresent &&
		(typeof body.target_agent_id !== "string" ||
			body.target_agent_id.trim() === "")
	) {
		return c.json(
			{
				error: "invalid_request",
				message: "target_agent_id must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const targetAgentId =
		resourceClass === "agent_config" &&
		typeof body.target_agent_id === "string" &&
		body.target_agent_id.trim()
			? body.target_agent_id.trim()
			: null;
	if (targetAgentId) {
		const targetExists = await getDb()<{ id: string }>`
      SELECT id FROM agents
      WHERE id = ${targetAgentId} AND organization_id = ${organizationId}
      LIMIT 1
    `;
		if (!targetExists[0]) {
			return c.json(
				{
					error: "invalid_request",
					message: `Unknown target agent '${targetAgentId}' for this workspace.`,
				},
				400,
			);
		}
	}

	// The policy row targets this agent by id (a reusable slug). Confirm the agent
	// EXISTS in this org before persisting — else a stale/typo'd URL would leave an
	// orphan row that a future agent recreated with the same id silently inherits.
	const agentExists = await getDb()<{ id: string }>`
    SELECT id FROM agents
    WHERE id = ${agentId} AND organization_id = ${organizationId}
    LIMIT 1
  `;
	if (!agentExists[0]) {
		return c.json(
			{ error: "not_found", message: `Agent '${agentId}' not found in this workspace.` },
			404,
		);
	}

	const policy = await upsertEntityApprovalPolicy(organizationId, {
		resourceClass,
		principalKind: "agent",
		principalId: agentId,
		operationKey,
		targetAgentId,
		entityTypeSlug,
		effects,
		// Effect-only endpoint: keep any approval delivery target already on the row.
		preserveDelivery: true,
	});
	invalidationEmitter.emit(organizationId, {
		keys: ["write-permissions", "agent-permissions"],
	});
	return c.json({ policy: serializeEntityApprovalPolicy(policy) });
});

// Delete one agent override row (falls back to the floor / class default).
app.delete("/api/:orgSlug/agent/:agentId/permissions", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}
	const agentId = c.req.param("agentId");
	const resourceClassRaw = c.req.query("resource_class")?.trim();
	const resourceClass = isWriteResourceClass(resourceClassRaw)
			? resourceClassRaw
			: null;
	if (!resourceClass) {
		return c.json(
			{ error: "invalid_request", message: "resource_class is required." },
			400,
		);
	}
	// entity_type_slug picks WHICH row to delete (null = the blanket all-types row).
	// A present-but-empty slug, or a slug on a non-entity class, must NOT coerce to
	// null and delete the blanket policy instead of the intended per-type override.
	const slugRaw = c.req.query("entity_type_slug");
	if (slugRaw !== undefined && slugRaw !== "" && resourceClass !== "entity") {
		return c.json(
			{
				error: "invalid_request",
				message: `entity_type_slug is only valid for resource_class 'entity', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (slugRaw !== undefined && slugRaw.trim() === "") {
		return c.json(
			{
				error: "invalid_request",
				message: "entity_type_slug must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const entityTypeSlug =
		resourceClass === "entity" ? (slugRaw?.trim() ?? null) || null : null;
	// operation_key picks WHICH connector row to delete (null = the blanket execute
	// row). Same guard as entity_type_slug: a present-but-empty value, or a key on a
	// non-connector class, must NOT coerce to null and delete the blanket rule.
	const opKeyRaw = c.req.query("operation_key");
	if (
		opKeyRaw !== undefined &&
		opKeyRaw !== "" &&
		resourceClass !== "connector_action"
	) {
		return c.json(
			{
				error: "invalid_request",
				message: `operation_key is only valid for resource_class 'connector_action', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (opKeyRaw !== undefined && opKeyRaw.trim() === "") {
		return c.json(
			{
				error: "invalid_request",
				message: "operation_key must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const operationKey =
		resourceClass === "connector_action" ? (opKeyRaw?.trim() ?? null) || null : null;
	const targetRaw = c.req.query("target_agent_id");
	if (
		targetRaw !== undefined &&
		targetRaw !== "" &&
		resourceClass !== "agent_config"
	) {
		return c.json(
			{
				error: "invalid_request",
				message: `target_agent_id is only valid for resource_class 'agent_config', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (targetRaw !== undefined && targetRaw.trim() === "") {
		return c.json(
			{
				error: "invalid_request",
				message: "target_agent_id must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const targetAgentId =
		resourceClass === "agent_config" ? (targetRaw?.trim() ?? null) || null : null;
	const deleted = await deleteEntityApprovalPolicy({
		organizationId,
		resourceClass,
		principalKind: "agent",
		principalId: agentId,
		operationKey,
		targetAgentId,
		entityTypeSlug,
	});
	invalidationEmitter.emit(organizationId, {
		keys: ["write-permissions", "agent-permissions"],
	});
	return c.json({ deleted });
});

// ---------------------------------------------------------------------------
// Org write-permissions floor (principal_kind NULL). Same matrix shape as agent
// permissions, but the editable rows ARE the floor agents inherit (and can only
// tighten).
// ---------------------------------------------------------------------------
app.get("/api/:orgSlug/write-permissions", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}
	const all = await listEntityApprovalPolicies(organizationId);
	const typeScoped = (p: EntityApprovalPolicy) =>
		p.fieldPath === null && p.entityId === null;
	// Editable floor = any-principal rows. Kind-wide agent rows (principal_kind
	// agent, principal_id null) also bind as floor for agents but are rare; include
	// them so the matrix doesn't under-report the bound.
	const floor = all.filter(
		(p) =>
			typeScoped(p) &&
			(p.principalKind === null ||
				(p.principalKind === "agent" && p.principalId === null)),
	);
	const typeRows = await getDb()<{
		slug: string;
		name: string;
		icon: string | null;
	}>`
    SELECT slug, name, icon FROM (
      SELECT DISTINCT ON (et.slug) et.slug, et.name, et.icon
      FROM entity_types et
      LEFT JOIN organization o ON o.id = et.organization_id
      WHERE et.deleted_at IS NULL
        AND et.slug NOT LIKE '$%'
        AND (et.organization_id = ${organizationId} OR o.visibility = 'public')
      ORDER BY et.slug, (et.organization_id = ${organizationId}) DESC, et.id ASC
    ) t
    ORDER BY name ASC
  `;
	const opList = await listOperations({
		organizationId,
		kind: "write",
		includeInputSchema: false,
		includeOutputSchema: false,
		limit: Number.MAX_SAFE_INTEGER,
	});
	const seenOps = new Set<string>();
	const operations: Array<{
		operation_key: string;
		name: string;
		connector_key: string;
		connector_name: string;
		kind: "read" | "write";
		requires_approval: boolean;
		destructive: boolean;
	}> = [];
	for (const op of opList.operations) {
		const key = qualifiedOperationKey(op.connector_key, op.operation_key);
		if (seenOps.has(key)) continue;
		seenOps.add(key);
		operations.push({
			operation_key: key,
			name: op.name,
			connector_key: op.connector_key,
			connector_name: op.connector_name,
			kind: op.kind === "read" ? "read" : "write",
			requires_approval: op.requires_approval === true,
			destructive: op.annotations?.destructiveHint === true,
		});
	}
	const agentRows = await getDb()<{ id: string; name: string }>`
    SELECT id, name FROM agents
    WHERE organization_id = ${organizationId}
    ORDER BY name ASC, id ASC
  `;
	return c.json({
		// Matrix adapter: floor is empty (no parent bound); `agent` holds the
		// editable org-floor rows so the shared UI model can treat them as the
		// override layer with no floor-tightening bound.
		floor: [],
		agent: floor.map(serializeEntityApprovalPolicy),
		entity_types: typeRows.map((r) => ({
			slug: r.slug,
			name: r.name,
			icon: r.icon,
		})),
		connector_operations: operations,
		agents: agentRows.map((a) => ({ id: a.id, name: a.name })),
	});
});

app.put("/api/:orgSlug/write-permissions", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: "invalid_request", message: "Request body must be JSON." },
			400,
		);
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return c.json(
			{ error: "invalid_request", message: "Request body must be a JSON object." },
			400,
		);
	}

	const resourceClass = isWriteResourceClass(body.resource_class)
			? body.resource_class
			: null;
	if (!resourceClass) {
		return c.json(
			{
				error: "invalid_request",
				message:
					"resource_class must be entity, agent_config, connector_action, or entity_schema.",
			},
			400,
		);
	}

	const rawEffects =
		typeof body.effects === "object" &&
		body.effects !== null &&
		!Array.isArray(body.effects)
			? (body.effects as Record<string, unknown>)
			: null;
	if (!rawEffects) {
		return c.json(
			{ error: "invalid_request", message: "effects must be a JSON object." },
			400,
		);
	}
	const effects: Partial<Record<WriteAction, EntityMutationMode>> = {};
	for (const [action, effect] of Object.entries(rawEffects)) {
		if (
			!isEntityMutationMode(effect) ||
			!isLegalActionEffect(resourceClass, action as WriteAction, effect)
		) {
			return c.json(
				{
					error: "invalid_request",
					message: `Illegal effect for ${resourceClass}: '${action}' = '${String(effect)}'.`,
				},
				400,
			);
		}
		effects[action as WriteAction] = effect;
	}

	const slugPresent =
		body.entity_type_slug !== undefined && body.entity_type_slug !== null;
	if (slugPresent && resourceClass !== "entity") {
		return c.json(
			{
				error: "invalid_request",
				message: `entity_type_slug is only valid for resource_class 'entity', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (
		slugPresent &&
		(typeof body.entity_type_slug !== "string" ||
			body.entity_type_slug.trim() === "")
	) {
		return c.json(
			{
				error: "invalid_request",
				message: "entity_type_slug must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const entityTypeSlug =
		resourceClass === "entity" &&
		typeof body.entity_type_slug === "string" &&
		body.entity_type_slug.trim()
			? body.entity_type_slug.trim()
			: null;

	const opKeyPresent =
		body.operation_key !== undefined && body.operation_key !== null;
	if (opKeyPresent && resourceClass !== "connector_action") {
		return c.json(
			{
				error: "invalid_request",
				message: `operation_key is only valid for resource_class 'connector_action', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (
		opKeyPresent &&
		(typeof body.operation_key !== "string" ||
			body.operation_key.trim() === "")
	) {
		return c.json(
			{
				error: "invalid_request",
				message: "operation_key must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const operationKey =
		resourceClass === "connector_action" &&
		typeof body.operation_key === "string" &&
		body.operation_key.trim()
			? body.operation_key.trim()
			: null;
	if (operationKey) {
		const known = await listOperations({
			organizationId,
			kind: "write",
			includeInputSchema: false,
			includeOutputSchema: false,
			limit: Number.MAX_SAFE_INTEGER,
		});
		const knownQualified = new Set(
			known.operations.map((op) =>
				qualifiedOperationKey(op.connector_key, op.operation_key),
			),
		);
		if (!knownQualified.has(operationKey)) {
			return c.json(
				{
					error: "invalid_request",
					message: `Unknown connector operation '${operationKey}' for this workspace.`,
				},
				400,
			);
		}
	}

	const targetPresent =
		body.target_agent_id !== undefined && body.target_agent_id !== null;
	if (targetPresent && resourceClass !== "agent_config") {
		return c.json(
			{
				error: "invalid_request",
				message: `target_agent_id is only valid for resource_class 'agent_config', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (
		targetPresent &&
		(typeof body.target_agent_id !== "string" ||
			body.target_agent_id.trim() === "")
	) {
		return c.json(
			{
				error: "invalid_request",
				message: "target_agent_id must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const targetAgentId =
		resourceClass === "agent_config" &&
		typeof body.target_agent_id === "string" &&
		body.target_agent_id.trim()
			? body.target_agent_id.trim()
			: null;
	if (targetAgentId) {
		const targetExists = await getDb()<{ id: string }>`
      SELECT id FROM agents
      WHERE id = ${targetAgentId} AND organization_id = ${organizationId}
      LIMIT 1
    `;
		if (!targetExists[0]) {
			return c.json(
				{
					error: "invalid_request",
					message: `Unknown target agent '${targetAgentId}' for this workspace.`,
				},
				400,
			);
		}
	}

	const policy = await upsertEntityApprovalPolicy(organizationId, {
		resourceClass,
		principalKind: null,
		principalId: null,
		operationKey,
		targetAgentId,
		entityTypeSlug,
		effects,
		preserveDelivery: true,
	});
	invalidationEmitter.emit(organizationId, {
		keys: ["write-permissions", "agent-permissions"],
	});
	return c.json({ policy: serializeEntityApprovalPolicy(policy) });
});

app.delete("/api/:orgSlug/write-permissions", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}
	const resourceClassRaw = c.req.query("resource_class")?.trim();
	const resourceClass = isWriteResourceClass(resourceClassRaw)
			? resourceClassRaw
			: null;
	if (!resourceClass) {
		return c.json(
			{ error: "invalid_request", message: "resource_class is required." },
			400,
		);
	}
	const slugRaw = c.req.query("entity_type_slug");
	if (slugRaw !== undefined && slugRaw !== "" && resourceClass !== "entity") {
		return c.json(
			{
				error: "invalid_request",
				message: `entity_type_slug is only valid for resource_class 'entity', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (slugRaw !== undefined && slugRaw.trim() === "") {
		return c.json(
			{
				error: "invalid_request",
				message: "entity_type_slug must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const entityTypeSlug =
		resourceClass === "entity" ? (slugRaw?.trim() ?? null) || null : null;
	const opKeyRaw = c.req.query("operation_key");
	if (
		opKeyRaw !== undefined &&
		opKeyRaw !== "" &&
		resourceClass !== "connector_action"
	) {
		return c.json(
			{
				error: "invalid_request",
				message: `operation_key is only valid for resource_class 'connector_action', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (opKeyRaw !== undefined && opKeyRaw.trim() === "") {
		return c.json(
			{
				error: "invalid_request",
				message: "operation_key must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const operationKey =
		resourceClass === "connector_action" ? (opKeyRaw?.trim() ?? null) || null : null;
	const targetRaw = c.req.query("target_agent_id");
	if (
		targetRaw !== undefined &&
		targetRaw !== "" &&
		resourceClass !== "agent_config"
	) {
		return c.json(
			{
				error: "invalid_request",
				message: `target_agent_id is only valid for resource_class 'agent_config', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (targetRaw !== undefined && targetRaw.trim() === "") {
		return c.json(
			{
				error: "invalid_request",
				message: "target_agent_id must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const targetAgentId =
		resourceClass === "agent_config" ? (targetRaw?.trim() ?? null) || null : null;

	// Unscoped entity floor delete is blocked inside deleteEntityApprovalPolicy
	// (returns false). Blanket agent_config / connector_action floor rows may clear.
	const deleted = await deleteEntityApprovalPolicy({
		organizationId,
		resourceClass,
		principalKind: null,
		principalId: null,
		operationKey,
		targetAgentId,
		entityTypeSlug,
	});
	invalidationEmitter.emit(organizationId, {
		keys: ["write-permissions", "agent-permissions"],
	});
	return c.json({ deleted });
});

app.patch("/api/:orgSlug/organization/visibility", mcpAuth, async (c) => {
	const organizationId = c.get("organizationId");
	const memberRole = c.get("memberRole");

	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}

	if (memberRole !== "owner" && memberRole !== "admin") {
		return c.json(
			{
				error: "forbidden",
				message: "Workspace visibility requires owner or admin access.",
			},
			403,
		);
	}

	const authSource = c.get("authSource");
	if (authSource === "pat") {
		return c.json(
			{
				error: "forbidden",
				message: "Use OAuth or a web session to change workspace visibility.",
			},
			403,
		);
	}

	const scopes = c.get("mcpAuthInfo")?.scopes ?? [];
	if (authSource === "oauth" && !scopes.includes("mcp:admin")) {
		return c.json(
			{
				error: "forbidden",
				message: "Workspace visibility changes require mcp:admin scope.",
			},
			403,
		);
	}

	let body: { visibility?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: "invalid_request", message: "Request body must be JSON." },
			400,
		);
	}

	const visibility = body.visibility;
	if (visibility !== "public" && visibility !== "private") {
		return c.json(
			{
				error: "invalid_request",
				message: 'Visibility must be "public" or "private".',
			},
			400,
		);
	}

	const sql = getDb();
	const rows = await sql<{
		id: string;
		name: string;
		slug: string;
		logo: string | null;
		description: string | null;
		created_at: string;
		visibility: "public" | "private";
	}>`
    UPDATE "organization"
    SET visibility = ${visibility}
    WHERE id = ${organizationId}
    RETURNING id, name, slug, logo, description, "createdAt" AS created_at, visibility
  `;

	const org = rows[0];
	if (!org) {
		return c.json({ error: "not_found", message: "Workspace not found." }, 404);
	}

	invalidationEmitter.emit(org.id, {
		keys: ["organizations", "resolve-path"],
	});

	return c.json({ organization: { ...org, is_member: true } });
});

app.route("/catalog", globalCatalogRoutes);
app.route("/api/:orgSlug/installed", orgInstalledRoutes);
app.route("/api/:orgSlug/agents", agentRoutes);
app.route("/api/:orgSlug/deployments", deploymentRoutes);
app.route("/api/:orgSlug/sandboxes", sandboxRoutes);
app.route("/api/:orgSlug/clients/activity-scopes", clientActivityScopeRoutes);
app.route("/api/:orgSlug/clients", clientRoutes);

// ============================================
// SSE Invalidation Events (for frontend cache sync)
// ============================================
app.get("/api/:orgSlug/events", invalidationSseAuth, async (c) => {
	const orgId = c.get("organizationId");
	if (!orgId) return c.json({ error: "Organization context required" }, 401);

	return streamInvalidationEvents(c, String(orgId));
});

/**
 * Features endpoint — lets the frontend discover which capabilities are available.
 * Agents page is always shown (MCP setup works without Lobu runtime features).
 */
app.get("/api/features", (c) => {
	return c.json({
		agents: true,
		lobuEmbedded: isLobuGatewayRunning(),
	});
});

/**
 * Self-serve join a public organization. Authenticated session required.
 * Inserts a member row with role='member' and mirrors Better Auth's
 * afterAddMember side effects (see workspace/join-public.ts).
 */
app.post("/api/:orgSlug/join", async (c) => {
	const rateLimiter = getRateLimiter();
	const clientIP = getClientIP(c.req.raw, c.var.peerRemoteAddress);
	const rateLimit = rateLimiter.checkLimit(
		`rate:join-public-org:${clientIP}`,
		RateLimitPresets.JOIN_PUBLIC_ORG_PER_IP_HOUR,
	);
	if (!rateLimit.allowed) {
		return c.json({ error: rateLimit.errorMessage }, 429);
	}

	const auth = await createAuth(c.env);
	const session = await resolveSession(auth, c.req.raw.headers);
	const userId = session?.session?.userId;
	if (!userId) {
		return c.json(
			{
				error: "unauthorized",
				error_description: "Sign in to join a workspace.",
			},
			401,
		);
	}

	const orgSlug = c.req.param("orgSlug");
	if (!orgSlug) return c.json({ error: "invalid_request" }, 400);

	const result = await joinPublicOrganization({ userId, orgSlug });
	if (result.status === "not_found") {
		return c.json(
			{ error: "not_found", error_description: "Workspace not found." },
			404,
		);
	}
	if (result.status === "not_public") {
		return c.json(
			{
				error: "forbidden",
				error_description:
					"This workspace is private. Ask an owner for an invitation.",
			},
			403,
		);
	}

	return c.json({
		status: result.status,
		organizationId: result.organizationId,
		role: result.role,
	});
});

/**
 * The provider-agnostic connection "claim" routes bind a parked (pending)
 * provider install to the signed-in user's org after the provider's authority
 * check passes. Slack is the first consumer; other chat/data providers register
 * a `ClaimProvider` in `claimProviders` and get the same two routes for free. No
 * secret link token — authority is the provider's `authorize` verdict.
 *
 * Registered before the `/api/:orgSlug/:toolName` proxy so `connector`/`…`
 * doesn't get swallowed as an org tool call.
 */
// The main app doesn't run the Lobu auth bridge, so resolve the session here
// (same pattern as /api/:orgSlug/join). Cookie or Better-Auth bearer.
async function resolveClaimSessionUser(
	env: Env,
	req: Request,
): Promise<string | null> {
	try {
		const auth = await createAuth(env);
		const session = await resolveSession(auth, req.headers);
		return session?.user?.id ?? null;
	} catch {
		return null;
	}
}

// Wire the real org-resolution stores behind the injectable ClaimEngineDeps —
// provider-agnostic, shared by every claim provider.
function claimEngineDeps(): ClaimEngineDeps {
	return {
		resolveMemberOrgs: async (userId) =>
			(await getDb()`
				SELECT o.id, o.slug, o.name,
					(o.metadata::jsonb)->>'personal_org_for_user_id' IS NOT NULL
						AS "isPersonal"
				FROM "member" m JOIN "organization" o ON o.id = m."organizationId"
				WHERE m."userId" = ${userId}
				ORDER BY "isPersonal", o.name
			`) as ClaimEligibleOrg[],
		resolveOrgIfMember: async (userId, orgSlugOrId) => {
			const rows = (await getDb()`
				SELECT o.id
				FROM "organization" o
				JOIN "member" m ON m."organizationId" = o.id AND m."userId" = ${userId}
				WHERE o.slug = ${orgSlugOrId} OR o.id = ${orgSlugOrId}
				LIMIT 1
			`) as Array<{ id: string }>;
			return rows[0]?.id ?? null;
		},
		resolveOrgSlug: async (organizationId) => {
			const orgRows = (await getDb()`
				SELECT slug FROM "organization" WHERE id = ${organizationId} LIMIT 1
			`) as Array<{ slug: string }>;
			return orgRows[0]?.slug ?? null;
		},
	};
}

// Wire the Slack authority half (workspace-admin identity + usersInfo + bind)
// behind the ClaimProvider the engine consumes.
function buildSlackClaimProvider(): ClaimProvider {
	return slackClaimProvider({
		resolvePending: (t) => resolveSlackPendingByTenant(t),
		resolveActiveOrgSlug: async (team) => {
			const rows = (await getDb()`
				SELECT o.slug
				FROM app_installations ai
				JOIN "organization" o ON o.id = ai.organization_id
				WHERE ai.provider = 'slack'
					AND ai.external_tenant_id = ${team}
					AND ai.status = 'active'
				LIMIT 1
			`) as Array<{ slug: string }>;
			return rows[0]?.slug ?? null;
		},
		resolveActiveBindingElsewhere: async (
			team,
			enterpriseId,
			isEnterpriseInstall,
			targetOrganizationId,
		) => {
			const foreign = await resolveSlackActiveBindingElsewhere(
				team,
				enterpriseId,
				isEnterpriseInstall,
				targetOrganizationId,
			);
			return foreign
				? {
						orgSlug: foreign.orgSlug,
						orgName: foreign.orgName,
						matchKind: foreign.matchKind,
					}
				: null;
		},
		resolveClaimerSlackIdentities: resolveClaimingUserSlackIdentities,
		stampSlackIdentityForUser,
		usersInfo: (botToken, uid) => createSlackWebApi().usersInfo(botToken, uid),
		claim: async (pending, organizationId, confirmMove) => {
			const core = getLobuCoreServices();
			if (!core) throw new Error("Lobu core services unavailable");
			const result = await claimSlackPendingInstall(
				core.getAppInstallationStore(),
				core.getSecretStore(),
				pending,
				organizationId,
				confirmMove,
			);
			return result;
		},
	}) as ClaimProvider;
}

// Provider registry for the generic claim routes. Adding a claim provider is one
// entry here — the two routes below dispatch through it; unknown → 404.
const claimProviders = new Map<string, () => ClaimProvider>([
	["slack", buildSlackClaimProvider],
]);

// GET /api/connector/:connector/connection/claim-context?ref=… — the confirm
// step's data. Runs the provider's authority guards with NO write and returns
// the subject name + the claimer's orgs, so the SPA claim page can render
// "Connect <subject> to <org>" before binding. Surfaces `already_connected` for
// a subject already bound, so the UI links to it instead of erroring on a
// re-visited/spent link. Registered before the `/api/:orgSlug/:toolName` proxy.
app.get("/api/connector/:connector/connection/claim-context", async (c) => {
	const buildProvider = claimProviders.get(c.req.param("connector"));
	if (!buildProvider) return c.json({ error: "unknown_provider" }, 404);
	const provider = buildProvider();
	const userId = await resolveClaimSessionUser(c.env, c.req.raw);
	const ref = (c.req.query("ref") ?? "").trim();
	const ctx = await resolveClaimContext(provider, claimEngineDeps(), {
		userId,
		ref,
	});
	if (ctx.status === "ready") {
		return c.json({
			ok: true,
			subjectKind: provider.subjectKind,
			subjectName: ctx.subjectName,
			orgs: ctx.orgs,
		});
	}
	if (ctx.status === "already_connected") {
		return c.json({ ok: true, alreadyConnected: true, orgSlug: ctx.orgSlug });
	}
	if (ctx.status === "signin_required") {
		return c.json(
			{ error: ctx.status, signinProvider: ctx.signinProvider },
			claimHttpStatus(ctx.status),
		);
	}
	if (ctx.status === "not_authorized") {
		return c.json(
			{ error: ctx.status, code: ctx.code },
			claimHttpStatus(ctx.status),
		);
	}
	return c.json({ error: ctx.status }, claimHttpStatus(ctx.status));
});

app.post("/api/connector/:connector/connection/claim", async (c) => {
	const buildProvider = claimProviders.get(c.req.param("connector"));
	if (!buildProvider) return c.json({ error: "unknown_provider" }, 404);
	const provider = buildProvider();
	const userId = await resolveClaimSessionUser(c.env, c.req.raw);

	let body: { ref?: unknown; org?: unknown; confirmMove?: unknown };
	try {
		body = (await c.req.json()) as {
			ref?: unknown;
			org?: unknown;
			confirmMove?: unknown;
		};
	} catch {
		body = {};
	}
	const ref = typeof body.ref === "string" ? body.ref.trim() : "";
	// The org the user CONFIRMED on the claim page (slug or id). REQUIRED — an
	// org-less claim is rejected by the engine (`invalid_request`), never routed
	// to a default org. This flow creates a connection under an org from an
	// external OAuth request, so the destination must be an explicit human choice.
	const organizationId =
		typeof body.org === "string" && body.org.trim()
			? body.org.trim()
			: undefined;
	// Explicit opt-in to MOVE a workspace already active in another org into the
	// confirmed org. Without it the engine fences the second claim and returns
	// `already_connected_elsewhere` (deliberate move, never a silent duplicate).
	const confirmMove = body.confirmMove === true;

	// All branching lives in the injectable engine so it stays unit-testable;
	// the route only wires real deps + maps outcomes to HTTP.
	const result = await claimPendingConnection(provider, claimEngineDeps(), {
		userId,
		ref,
		organizationId,
		confirmMove,
	});

	if (result.status === "ok") {
		return c.json({
			ok: true,
			orgSlug: result.orgSlug,
			provider: provider.provider,
			alreadyConnected: result.alreadyConnected ?? false,
		});
	}
	if (
		result.status === "already_connected_elsewhere" ||
		result.status === "enterprise_scope_overlap"
	) {
		// Two DISTINCT 409 conflicts, kept distinguishable for the SPA via `error`:
		// already_connected_elsewhere (same workspace — re-POST confirmMove:true) vs
		// enterprise_scope_overlap (Grid org-wide/per-workspace routing collision —
		// NOT overridable, admin resolves out-of-band).
		// Not an error the user must fix — a decision. Surface the other org so the
		// SPA can prompt "already connected in <org>. Move it here?" and re-POST
		// with confirmMove:true. 409 (state conflict requiring explicit resolution).
		return c.json(
			{
				error: result.status,
				existing: result.existing,
				provider: provider.provider,
			},
			claimHttpStatus(result.status),
		);
	}
	if (result.status === "claim_failed") {
		logger.error(
			{ connector: provider.provider, ref, err: result.message },
			"Connection claim failed",
		);
		return c.json({ error: "claim_failed", message: result.message }, 500);
	}
	if (result.status === "signin_required") {
		return c.json(
			{ error: result.status, signinProvider: result.signinProvider },
			claimHttpStatus(result.status),
		);
	}
	if (result.status === "not_authorized") {
		return c.json(
			{ error: result.status, code: result.code },
			claimHttpStatus(result.status),
		);
	}
	return c.json({ error: result.status }, claimHttpStatus(result.status));
});

/**
 * GET /api/:orgSlug/tools
 * List admin REST tools available to the caller. Companion to the POST
 * proxy below — gives CLI/web callers a discovery surface without spinning
 * up an MCP session just to call tools/list.
 */
app.get("/api/:orgSlug/tools", mcpAuth, restListTools);

/**
 * Generic tool proxy for the REST dispatch tool surface.
 * POST /api/:orgSlug/:toolName with JSON body
 */
app.post("/api/:orgSlug/:toolName", mcpAuth, async (c) => {
	return restToolProxy(c);
});

/**
 * OpenAPI spec endpoint for ChatGPT
 * Dynamically generated from tool registry schemas
 */
// The tool registry is static after boot, so the generated spec only depends
// on the request origin (a tiny set in practice). Memoize per origin to turn
// this polled endpoint into a Map lookup instead of an O(tools × schema) walk.
const openApiSpecCache = new Map<string, object>();
app.get("/openapi.json", (c) => {
	const configuredOrigin = getConfiguredPublicOrigin();
	const serverUrl = configuredOrigin ?? new URL(c.req.url).origin;
	if (!configuredOrigin) {
		return c.json(generateOpenAPISpec(serverUrl));
	}
	let spec = openApiSpecCache.get(serverUrl);
	if (!spec) {
		spec = generateOpenAPISpec(serverUrl);
		openApiSpecCache.set(serverUrl, spec);
	}
	return c.json(spec);
});

// The pre-MCP ChatGPT plugin manifest is retired. Keep an explicit 404 so the
// generic discovery fallback below cannot masquerade as a valid manifest.
app.get("/.well-known/ai-plugin.json", (c) => c.notFound());

/**
 * Apply MCP authentication middleware and Streamable HTTP transport handler.
 * Supports GET (SSE stream), POST (JSON-RPC), and DELETE (session teardown).
 */
app.use("/mcp", mcpAuth);
app.use("/mcp/", mcpAuth);
app.use("/mcp/:orgSlug", mcpAuth);
app.use("/mcp/:orgSlug/", mcpAuth);
app.all("/mcp", handleMcp);
app.all("/mcp/", handleMcp);
app.all("/mcp/:orgSlug", handleMcp);
app.all("/mcp/:orgSlug/", handleMcp);

// MCP App public template. The same absolute origin and CSP contract is used by
// `resources/read`; its content-versioned asset URLs remain safe across mixed
// replica rollouts and downstream browser caches.
app.get("/mcp-apps/:app/index.html", async (c) => {
	const app_ = c.req.param("app");
	// Only serve a bundle the MCP App registry declares — never an arbitrary
	// path param.
	if (!MCP_APP_DIRS.has(app_)) return c.notFound();
	const html = await renderMcpAppTemplate(
		app_,
		resolvePublicOrigin(c.req.url),
	);
	if (html == null) return c.notFound();
	c.header("Content-Type", "text/html; charset=utf-8");
	c.header("Cache-Control", "no-cache");
	return c.body(html);
});

app.get("/mcp-apps/:app/assets/:asset", async (c) => {
	const app_ = c.req.param("app");
	if (!MCP_APP_DIRS.has(app_)) return c.notFound();
	const assetName = c.req.param("asset");
	const asset = await readMcpAppAsset(app_, `assets/${assetName}`);
	if (asset == null) return c.notFound();
	c.header(
		"Content-Type",
		assetName.endsWith(".js")
			? "text/javascript; charset=utf-8"
			: "text/css; charset=utf-8",
	);
	// The template pins every asset URL to a content digest, so honour it here.
	// A rolling deploy can land this request on a replica running a different
	// build than the one that served the caller's index.html; caching those
	// bytes under the *requested* digest would pin the mismatch in the host's
	// browser cache until the next deploy. Cache hard only on an exact match.
	// No ETag: neither branch can revalidate (no-store forbids it, and the
	// immutable branch never expires), so it would be an inert header.
	c.header(
		"Cache-Control",
		c.req.query("v") === asset.version
			? "public, max-age=31536000, immutable"
			: "no-store",
	);
	c.header("Access-Control-Allow-Origin", "*");
	c.header("Cross-Origin-Resource-Policy", "cross-origin");
	return c.body(Uint8Array.from(asset.bytes).buffer);
});

/**
 * Catch-all route
 * Dev: Vite middleware handles source files/HMR before reaching here.
 *      This catch-all serves SPA index.html via Vite's transformIndexHtml.
 * Prod: Serves static files from packages/owletto/dist with SPA fallback.
 */
app.get("*", async (c) => {
	const requestPath = c.req.path;
	const acceptHeader = c.req.header("accept") ?? "";
	const acceptsHtml = acceptHeader.includes("text/html");
	const acceptsGenericResponse = !acceptHeader || acceptHeader.includes("*/*");
	const hasSessionCookie = hasBetterAuthSessionCookie(c.req.header("cookie"));
	const hasFileExtension =
		/\.(?:js|css|html|json|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|txt|xml)$/i.test(
			requestPath,
		);
	const isSpaRoute = !hasFileExtension && !isExcludedSpaPath(requestPath);
	// Generic signed-in requests still need the SPA shell; otherwise they would fall through to the
	// JSON status response after skipping anonymous public SSR.
	const shouldServeSpaFallback =
		(acceptsHtml || (acceptsGenericResponse && hasSessionCookie)) && isSpaRoute;
	if (
		(acceptsHtml || acceptsGenericResponse) &&
		!hasSessionCookie &&
		isSpaRoute
	) {
		const publicPageModel = await buildPublicPageModel(
			requestPath,
			c.env,
			c.req.url,
			c.get("subdomainOrg"),
		);
		if (publicPageModel) {
			const template = await loadAnySpaHtmlTemplate();
			if (template) {
				const rendered = renderPublicPageTemplate(template, publicPageModel);
				const html = injectRuntimeConfig(
					viteDev
						? await viteDev.transformIndexHtml(c.req.path, rendered)
						: rendered,
				);
				c.header("Cache-Control", publicPageModel.cacheControl);
				c.header("Vary", "Accept, Cookie");
				return c.html(html, publicPageModel.status as 200 | 404);
			}
		}
	}

	// Dev: serve Vite-transformed index.html for SPA routes
	if (viteDev) {
		if (shouldServeSpaFallback) {
			const raw = await fs.readFile(
				path.resolve(viteDev.config.root, "index.html"),
				"utf-8",
			);
			const html = injectRuntimeConfig(
				await viteDev.transformIndexHtml(c.req.path, raw),
			);
			return c.html(html);
		}
		return c.notFound();
	}

	// Prod: serve static files
	const webDistDirectory = await resolveWebDistDirectory();
	if (webDistDirectory) {
		const filePath = resolveStaticFilePath(webDistDirectory, requestPath);
		if (filePath) {
			try {
				const staticResponse = await serveStaticFile(c, filePath);
				if (staticResponse) {
					return staticResponse;
				}
			} catch {
				// Fall through to SPA fallback and default response.
			}
		}

		if (shouldServeSpaFallback) {
			try {
				const spaEntry = resolveStaticFilePath(webDistDirectory, "/index.html");
				if (spaEntry) {
					const spaResponse = await serveStaticFile(c, spaEntry);
					if (spaResponse) {
						return spaResponse;
					}
				}
			} catch {
				// Fall through to default response.
			}
		}
	}

	const baseUrl = new URL(c.req.url).origin;
	// Unknown paths fall through to this discovery blob. Browsers hit it for
	// `/favicon.ico`, `/apple-touch-icon.png`, etc. before those assets exist —
	// without `no-store` a CDN caches the JSON for that path and keeps serving it
	// even after a deploy ships the real file. Don't let that happen.
	c.header("Cache-Control", "no-store");
	return c.json({
		status: "ok",
		mcp_endpoint: new URL("/mcp", baseUrl).toString(),
		health: "/health",
		openapi: "/openapi.json",
	});
});

// Vite dev server instance — set by server.ts in development for SPA index.html transforms
let viteDev: any = null;
export function setViteDev(v: any) {
	viteDev = v;
}

export { app };
