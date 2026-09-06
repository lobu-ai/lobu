/**
 * Lobu Gateway — embedded initialization
 *
 * Initializes the in-process Lobu gateway (now living under ../gateway/) using
 * PostgreSQL-backed stores and bridging Lobu's Better Auth sessions to
 * Lobu's settings auth.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { Hono as HonoApp } from "hono";
import { createAuth } from "../auth";
import { authenticatePat, extractPatBearer } from "../auth/pat-auth";
import { getDb } from "../db/client";
import { ApiPlatform } from "../gateway/api/platform";
import { createGatewayApp } from "../gateway/cli/gateway";
import {
	primeAppInstallationMethods,
	primeBundledIntegrationConnectors,
} from "../gateway/installation/app-install-credentials";
import { buildGatewayConfig } from "../gateway/config/index";
import {
	getConfiguredPublicOrigin,
	resolvePublicGatewayUrl,
} from "../utils/public-origin";
import { ChatInstanceManager } from "../gateway/connections/chat-instance-manager";
import { ChatResponseBridge } from "../gateway/connections/chat-response-bridge";
import { Gateway } from "../gateway/gateway-main";
import type { AgentTurnShadowDeps } from "../gateway/orchestration/agent-turn-shadow";
import { Orchestrator } from "../gateway/orchestration/index";
import {
	startFilteringProxy,
	stopFilteringProxy,
	wireProxyEgressStores,
} from "../gateway/proxy/proxy-manager";
import { SecretStoreRegistry } from "../gateway/secrets/index";
import type { CoreServices } from "../gateway/services/core-services";
import type { Env } from "../index";
import { BootConfigError } from "../utils/errors";
import logger from "../utils/logger";

import {
	getMembershipRole,
	getOrgBySlug,
} from "../workspace/multi-tenant";
import { orgContext } from "./stores/org-context";
import { PostgresSecretStore } from "./stores/postgres-secret-store";
import {
	createPostgresAgentConfigStore,
	createPostgresAgentConnectionStore,
} from "./stores/postgres-stores";
import { getErrorMessage } from "@lobu/core";
import { resolveSession } from '../auth/resolve-session';

// Cache of (userId → orgId) lookups. Keyed by userId; users only see their
// own row swap when they leave/join orgs, which doesn't happen often. The
// 60s TTL is deliberately short — first-load cost is one indexed query.
const DEFAULT_ORG_TTL_MS = 60_000;
const defaultOrgCache = new Map<
	string,
	{ orgId: string | null; expiresAt: number }
>();

export async function resolveDefaultOrgId(
	userId: string,
): Promise<string | null> {
	const cached = defaultOrgCache.get(userId);
	if (cached && cached.expiresAt > Date.now()) return cached.orgId;

	try {
		const sql = getDb();
		const rows = await sql`
      SELECT m."organizationId" AS organization_id
      FROM "member" m
      WHERE m."userId" = ${userId}
      ORDER BY m."createdAt" ASC
      LIMIT 1
    `;
		const orgId = (rows[0]?.organization_id as string | undefined) ?? null;
		if (orgId) {
			defaultOrgCache.set(userId, {
				orgId,
				expiresAt: Date.now() + DEFAULT_ORG_TTL_MS,
			});
		}
		return orgId;
	} catch (err) {
		// The DB may not be reachable yet at request time (e.g. boot races).
		// Do not cache that transient miss; callers decide how to surface it.
		logger.warn(
			{ err: getErrorMessage(err) },
			"[Lobu] resolveDefaultOrgId: lookup failed",
		);
		throw err;
	}
}

type EmbeddedSettingsSession = {
	userId: string;
	platform: string;
	exp: number;
	email?: string;
	name?: string;
	settingsMode?: "admin" | "user";
	isAdmin?: boolean;
};

let gateway: any = null;
let lobuApp: any = null;
let chatInstanceManager: any = null;
let coreServices: any = null;
let orchestrator: any = null;
let filteringProxyStarted = false;

function ensureEmbeddedWorkerLauncher(): void {
	const shimDir = path.resolve("scripts/runtime-shims");
	const bunShim = path.join(shimDir, "bun");
	if (!fs.existsSync(bunShim)) return;

	const currentPath = process.env.PATH || "";
	const pathSegments = currentPath.split(":").filter(Boolean);
	if (!pathSegments.includes(shimDir)) {
		process.env.PATH = [shimDir, ...pathSegments].join(":");
		logger.info(
			{ shimDir },
			"[Lobu] Prepended embedded worker launcher shim to PATH",
		);
	}
}

function ensureEmbeddedGatewaySecrets(): void {
	if (!process.env.ENCRYPTION_KEY) {
		if (process.env.LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY === "1") {
			process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
			logger.warn(
				"[Lobu] Generated ephemeral ENCRYPTION_KEY because LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1",
			);
		} else {
			throw new BootConfigError(
				[
					"",
					"  Lobu needs an encryption key to store secrets (provider keys, tokens).",
					"",
					"  The easiest fix — scaffold the project, which generates the key for you:",
					"    lobu init",
					"",
					"  Or generate a key, then add `ENCRYPTION_KEY=<output>` to your .env:",
					"    openssl rand -base64 32",
					"",
					"  Or, for a throwaway local run (stored secrets become unreadable after restart):",
					"    LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1 lobu run",
					"",
				].join("\n"),
			);
		}
	}
}

/**
 * Auth bridge middleware for the embedded Lobu app.
 *
 * Wires three identity sources into the (user, session, organizationId)
 * context that downstream `authProvider` reads:
 *
 *   1. Better Auth session (cookie or bearer session-token) — original path.
 *   2. Personal Access Token (`Authorization: Bearer owl_pat_*`) — needed so
 *      `lobu chat` / device-flow PATs reach `/lobu/api/v1/agents/*`. Verified
 *      via the shared `authenticatePat` (also used by the managed-connector
 *      connection-token router), which enforces the tenant-membership check (a
 *      PAT for org A must verify the user is still a member of org A).
 *
 * PAT validation runs BEFORE Better Auth so a stale/invalid PAT in the
 * `Authorization` header cannot be silently masked by a still-valid session
 * cookie. If the header carries an `owl_pat_*` value, that path is
 * authoritative — invalid PAT short-circuits with 401 regardless of cookie.
 *
 * Exported for tests; production wires it via `lobuApp.use('*', …)`.
 */
export function createLobuAuthBridge() {
	return async (c: any, next: any) => {
		c.set("user", null);
		c.set("session", null);

		// 1. PAT path — authoritative when the Authorization header carries
		//    `Bearer owl_pat_*`. Validate first so an invalid PAT cannot fall
		//    through to a cooked Better Auth cookie: invalid PAT short-circuits
		//    here rather than masking the failure with a still-valid session
		//    cookie. Shared with the connection-token router via `authenticatePat`.
		const bearerValue = extractPatBearer(c.req.header("Authorization"));
		if (bearerValue) {
			const result = await authenticatePat(getDb(), bearerValue);
			if (!result.ok) {
				return c.json(
					{ error: result.error, error_description: result.error_description },
					result.status,
				);
			}

			const { user, patInfo, organizationId } = result;
			const expiresAt =
				patInfo.expiresAt === Number.MAX_SAFE_INTEGER
					? new Date(Date.now() + 86_400_000)
					: new Date(patInfo.expiresAt * 1000);
			c.set("user", {
				id: user.id,
				name: user.name,
				email: user.email,
				emailVerified: user.emailVerified,
			});
			c.set("session", {
				id: `pat:${patInfo.clientId}`,
				userId: user.id,
				token: bearerValue,
				expiresAt,
				activeOrganizationId: organizationId,
			});
			c.set("organizationId", organizationId);

			await next();
			return;
		}

		// 2. Better Auth path — cookie or Better-Auth bearer session-token.
		//    Only runs when the request did NOT present an owl_pat_* bearer.
		try {
			const auth = await createAuth(c.env, c.req.raw);
			const session = await resolveSession(auth, c.req.raw.headers);
			if (session?.user && session.session) {
				c.set("user", session.user);
				c.set("session", session.session);
			}
		} catch {
			// Lobu auth routes fall back to their own unauthenticated handling.
		}

		await next();
	};
}

/**
 * Org-context middleware for the embedded Lobu app.
 *
 * Resolves the organization a request runs under and wraps the rest of the
 * request in `orgContext.run()` so Postgres-backed stores (which read the org
 * id from AsyncLocalStorage via `getOrgId()`) work for routes that don't carry
 * an explicit org slug in the path — `POST /api/v1/agents` in particular, which
 * auto-provisions ephemeral agents and needs the user's existing agents to
 * inherit runtime agent options. (The mainApp's `workspace/multi-tenant.ts` already
 * handles `/api/:orgSlug/*`; this is the equivalent for the lobu-app's unscoped
 * routes.)
 *
 * Resolution precedence:
 *   1. `x-lobu-org` header (sent by `lobu chat --org <slug>`) — a per-request
 *      override of the user's default org, honored ONLY after re-verifying the
 *      authenticated user is a member of that org (unknown slug → 404,
 *      non-member → 403). Under PAT auth the header cannot select a different
 *      org than the PAT's pin (→ 403; naming the pinned org is a no-op) — the
 *      same rule as the MCP's query_sql, so an org-bound credential never
 *      widens into the holder's other orgs.
 *   2. The PAT-bound org (`organizationId` set by `createLobuAuthBridge`).
 *   3. The user's default org membership.
 *
 * Exported for tests; production wires it via `lobuApp.use('*', …)`.
 */
export function createLobuOrgContextMiddleware() {
	return async (c: any, next: any) => {
		const user = c.get("user") as { id?: string } | null;
		if (!user?.id) {
			await next();
			return;
		}

		const orgHeader = c.req.header("x-lobu-org")?.trim();
		if (orgHeader) {
			let resolvedOrg: { id: string } | null;
			try {
				resolvedOrg = await getOrgBySlug(orgHeader);
			} catch {
				return c.json({ error: "Unable to resolve organization" }, 503);
			}
			if (!resolvedOrg) {
				return c.json({ error: `Unknown organization "${orgHeader}"` }, 404);
			}

			// A PAT stays pinned to the org it was minted for — same rule as the
			// MCP's query_sql, which rejects org overrides under PAT auth. A header
			// naming the pinned org is a harmless no-op (the CLI auto-sends the
			// context's activeOrg), but a different org is rejected even when the
			// user is a member: minting an org-bound credential is an intentional
			// scope decision, and a stolen PAT must not widen into every org its
			// owner belongs to.
			const session = c.get("session") as { id?: string } | null;
			const isPat =
				typeof session?.id === "string" && session.id.startsWith("pat:");
			if (isPat && resolvedOrg.id !== c.get("organizationId")) {
				return c.json(
					{
						error:
							`x-lobu-org "${orgHeader}" is not allowed with PAT auth: the token stays pinned to the organization it was minted for. ` +
							"Mint a PAT for the target organization, or sign in with `lobu login`.",
					},
					403,
				);
			}

			const role = await getMembershipRole(resolvedOrg.id, user.id);
			if (!role) {
				return c.json(
					{ error: `Not a member of organization "${orgHeader}"` },
					403,
				);
			}
			c.set("organizationId", resolvedOrg.id);
			await orgContext.run({ organizationId: resolvedOrg.id }, () => next());
			return;
		}

		// PAT-hydration middleware above sets `organizationId` when the PAT is
		// bound to one. Honor that pin first so the org-scoped stores see the same
		// tenant the PAT was minted for; only fall back to the user's default
		// membership when no pin exists.
		let orgId: string | null =
			(c.get("organizationId") as string | null) ?? null;
		if (!orgId) {
			try {
				orgId = await resolveDefaultOrgId(user.id);
			} catch {
				return c.json(
					{ error: "Unable to resolve organization membership" },
					503,
				);
			}
			if (!orgId) {
				return c.json({ error: "No organization membership found" }, 404);
			}
			c.set("organizationId", orgId);
		}
		await orgContext.run({ organizationId: orgId }, () => next());
	};
}

/**
 * Initialize the embedded Lobu gateway.
 * Returns the Hono app to mount, or null if DATABASE_URL is not configured.
 */
export async function initLobuGateway(): Promise<Hono | null> {
	if (!process.env.DATABASE_URL) {
		logger.info("[Lobu] DATABASE_URL not set — embedded gateway disabled");
		return null;
	}
	ensureEmbeddedGatewaySecrets();
	ensureEmbeddedWorkerLauncher();
	try {
		const publicWebUrl =
			getConfiguredPublicOrigin() ||
			`http://localhost:${process.env.PORT || "8787"}`;
		const env = process.env as unknown as Env;

		// Embedded gateway shares the process with the app's OIDC provider — pass
		// that issuer explicitly instead of overloading MEMORY_URL. LOBU memory MCP
		// endpoints are resolved separately per organization/agent.
		const gatewayConfig = buildGatewayConfig({
			mcp: { publicGatewayUrl: resolvePublicGatewayUrl() },
			auth: { issuerUrl: publicWebUrl },
		});

		await startFilteringProxy();
		filteringProxyStarted = true;
		logger.info("[Lobu] Embedded worker egress proxy started");

		logger.info("[Lobu] Starting embedded orchestrator");
		orchestrator = new Orchestrator(gatewayConfig.orchestration);
		await orchestrator.start();
		logger.info("[Lobu] Embedded orchestrator started");

		// Create PostgreSQL-backed stores
		const configStore = createPostgresAgentConfigStore();
		const connectionStore = createPostgresAgentConnectionStore();
		const postgresSecretStore = new PostgresSecretStore();
		const secretStore = new SecretStoreRegistry(postgresSecretStore, {
			secret: postgresSecretStore,
		});

		gateway = new Gateway(gatewayConfig, {
			configStore,
			connectionStore,
			secretStore,
		});

		// Register API platform
		gateway.registerPlatform(new ApiPlatform());

		// Start the gateway (initializes CoreServices, platforms, consumer)
		await gateway.start();

		coreServices = gateway.getCoreServices();
		await orchestrator.injectCoreServices(
			coreServices.getSecretStore(),
			coreServices.getProviderCatalogService(),
			coreServices.getGrantStore() ?? undefined,
			coreServices.getPolicyStore() ?? undefined,
			coreServices.getGuardrailRegistry() ?? undefined,
			coreServices.getAgentSettingsStore() ?? undefined,
			agentTurnMcpDeps(coreServices),
			coreServices.getArtifactStore(),
		);
		logger.info("[Lobu] Embedded orchestrator injected core services");

		wireProxyEgressStores(coreServices);
		logger.info("[Lobu] Egress grant + policy stores wired into HTTP proxy");

		// Wire the deployment manager's idle clock into the worker gateway so every
		// worker-driven HTTP response (delta / status_update / ACK / terminal reply)
		// refreshes the deployment's lastActivity. Without this the idle reaper can
		// scale a worker running one long turn to 0 mid-turn (its lastActivity stays
		// frozen at last dispatch). Both objects exist here; they are built
		// separately so the wiring lives at the composition root.
		//
		// Claim-side recycle gate: the job router (dispatch chokepoint) consults
		// the deployment manager's pod-local lease/fingerprint state before
		// delivering a claimed turn, and recycles a stale worker in place. Wired
		// here for the same reason as the tracker above — the gateway and the
		// orchestrator are built separately.
		//
		// All three integrations are announced, and their absence is announced louder.
		// Each only takes effect when a worker gateway exists, and all features are
		// invisible when they silently do not: a missing tracker shows up as a
		// worker killed mid-turn, and a missing recycle gate shows up as 401s an
		// hour into a warm conversation. Neither symptom points back here, and
		// there is no other way to answer "is the gate live on this pod?" — so
		// the skip is logged rather than swallowed by the optional chain.
		const workerGatewayToWire = coreServices.getWorkerGateway();
		if (workerGatewayToWire) {
			const deploymentManager = orchestrator.getDeploymentManager();
			workerGatewayToWire.setDeploymentActivityTracker(
				deploymentManager,
			);
			workerGatewayToWire.setDispatchRecycler(
				deploymentManager,
			);
			logger.info(
				"[Lobu] Worker idle-clock tracker and claim-side recycle gate wired; readiness watchdog awaiting HTTP listener startup",
			);
		} else {
			logger.warn(
				"[Lobu] No worker gateway on this pod — the readiness watchdog, idle-clock tracker, and claim-side recycle gate are ALL inactive; workers can be reported ready before connecting, and warm workers will not be recycled when their connector lease or tooling goes stale",
			);
		}

		// Initialize Chat SDK connection manager for platform connections
		chatInstanceManager = new ChatInstanceManager();
		try {
			await chatInstanceManager.initialize(coreServices);

			for (const adapter of chatInstanceManager.createPlatformAdapters()) {
				gateway.registerPlatform(adapter);
			}

			// Wire ChatResponseBridge into unified thread consumer
			const unifiedConsumer = gateway.getUnifiedConsumer();
			if (unifiedConsumer) {
				const bridge = new ChatResponseBridge(chatInstanceManager);
				bridge.setGuardrails(
					coreServices.getGuardrailRegistry(),
					coreServices.getAgentSettingsStore(),
				);
				bridge.setInteractionService(coreServices.getInteractionService());
				unifiedConsumer.setChatResponseBridge(bridge);
				// Cross-pod fan-out for chat-platform interaction cards (ask_user,
				// tool-approval, link-button, status). The worker posts a card into
				// its own pod's InteractionService; under N>1 replicas that pod
				// rarely owns the connection's bridge, so the card must ride the
				// thread_response queue to the owning pod. The local-warm check skips
				// the queue when this pod already renders the card in-process.
				const manager = chatInstanceManager;
				unifiedConsumer.setInteractionService(
					coreServices.getInteractionService(),
					(connectionId: string) => manager.has(connectionId),
				);
			}
		} catch (error) {
			logger.warn(
				{ error: String(error) },
				"[Lobu] ChatInstanceManager init failed — connections disabled",
			);
		}

		// Auth bridge: translate Lobu's Better Auth session → Lobu's SettingsTokenPayload
		const authProvider = (c: any): EmbeddedSettingsSession | null => {
			const user = c.get("user");
			const session = c.get("session");
			if (!user || !session) return null;
			const adminIds = (env.PLATFORM_ADMIN_USER_IDS || "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const platformAdmin = adminIds.includes(user.id);

			return {
				userId: user.id,
				platform: "external",
				exp:
					session.expiresAt instanceof Date
						? session.expiresAt.getTime()
						: Date.now() + 86400000,
				email: user.email,
				name: user.name,
				settingsMode: platformAdmin ? "admin" : "user",
				isAdmin: platformAdmin,
			};
		};

		const workerGateway = coreServices.getWorkerGateway();
		logger.info(
			{ hasWorkerGateway: !!workerGateway, hasGetApp: !!workerGateway?.getApp },
			"[Lobu] Worker gateway check",
		);

		// Prime the bundled app-installation methods so the org-less gateway wiring
		// (app-webhook provider registration in createGatewayApp) can read each
		// connector's declared credential env-var names synchronously instead of
		// hardcoding `process.env.GITHUB_APP_ID` literals. Env-var names are
		// deployment-wide constants, so one resolve per (connector, provider) at
		// boot is correct; per-org routes read the per-org DB declaration instead.
		await primeAppInstallationMethods([
			{ connectorKey: "github", provider: "github" },
			{ connectorKey: "slack", provider: "slack" },
		]);

		// Discover every bundled connector that receives app-level webhook
		// deliveries (`webhook.delivery: 'app_installation'`) so the gateway can
		// register ONE generic app-webhook provider per declaration — no hardcoded
		// github/slack/jira/linear list. Best-effort: a discovery failure leaves the
		// list empty (no app-webhook providers) rather than blocking boot.
		const bundledIntegrationConnectors =
			await primeBundledIntegrationConnectors().catch(() => []);

		const rawLobuApp = createGatewayApp({
			secretProxy: coreServices.getSecretProxy(),
			workerGateway,
			mcpProxy: coreServices.getMcpProxy(),
			interactionService: coreServices.getInteractionService(),
			platformRegistry: gateway.getPlatformRegistry(),
			coreServices,
			chatInstanceManager,
			authProvider,
			bundledIntegrationConnectors,
		});

		// Mount worker gateway routes before wrapping in lobuApp (createGatewayApp
		// doesn't include these — they're only mounted in the standalone CLI gateway)

		// Embedded Lobu auth routes need the Lobu Better Auth session, but they are mounted
		// outside the main app's auth middleware. Hydrate the shared user/session context here.
		lobuApp = new HonoApp<{ Bindings: Env }>();
		lobuApp.use("*", createLobuAuthBridge());

		// Resolve the request's org (x-lobu-org override > PAT pin > default
		// membership) and wrap the rest of the request in orgContext.run(). See
		// createLobuOrgContextMiddleware for the precedence + membership invariant.
		lobuApp.use("*", createLobuOrgContextMiddleware());

		// Worker gateway routes must be mounted first (before rawLobuApp's catch-all)
		if (workerGateway?.getApp) {
			lobuApp.route("/worker", workerGateway.getApp());
			logger.info("[Lobu] Worker gateway routes mounted at /lobu/worker/*");
		}
		lobuApp.route("/", rawLobuApp);

		logger.info("[Lobu] Embedded gateway initialized");
		return lobuApp;
	} catch (error) {
		if (orchestrator) {
			try {
				await orchestrator.stop();
			} catch (stopError) {
				logger.warn(
					{ error: String(stopError) },
					"[Lobu] Failed to stop orchestrator after init",
				);
			}
			orchestrator = null;
		}
		if (filteringProxyStarted) {
			try {
				await stopFilteringProxy();
			} catch (stopError) {
				logger.warn(
					{ error: String(stopError) },
					"[Lobu] Failed to stop proxy after init",
				);
			}
			filteringProxyStarted = false;
		}
		logger.error(
			{ error: String(error) },
			"[Lobu] Failed to initialize embedded gateway",
		);
		return null;
	}
}

/**
 * Activate worker connection checks only after the local HTTP listener is live.
 * The orchestrator consumes persisted turns during gateway initialization; if
 * this probe were armed then, a boot-recovered worker could not reach its SSE
 * route yet and would be recycled as though it were wedged.
 */
export function activateLobuWorkerReadinessWatchdog(): void {
	const workerGateway = coreServices?.getWorkerGateway();
	if (!workerGateway || !orchestrator) return;
	const workerConnectionManager = workerGateway.getConnectionManager();
	orchestrator
		.getDeploymentManager()
		.setDeploymentReadinessProbe((deploymentName: string) =>
			workerConnectionManager.isConnected(deploymentName),
		);
	logger.info(
		"[Lobu] Worker readiness watchdog activated after HTTP listener startup",
	);
}

/**
 * Stop the embedded Lobu gateway (for graceful shutdown).
 */
export async function stopLobuGateway(): Promise<void> {
	try {
		if (chatInstanceManager) {
			await chatInstanceManager.shutdown();
		}
		if (gateway) {
			await gateway.stop();
		}
		if (orchestrator) {
			await orchestrator.stop();
		}
		if (filteringProxyStarted) {
			await stopFilteringProxy();
			filteringProxyStarted = false;
		}
		orchestrator = null;
		gateway = null;
		chatInstanceManager = null;
		lobuApp = null;
		coreServices = null;
		logger.info("[Lobu] Embedded gateway stopped");
	} catch (error) {
		logger.warn(
			{ error: String(error) },
			"[Lobu] Error during gateway shutdown",
		);
	}
}

/**
 * Check if the embedded Lobu gateway is running.
 */
export function isLobuGatewayRunning(): boolean {
	return gateway !== null && lobuApp !== null;
}

/**
 * Get the ChatInstanceManager (for connection CRUD in API routes).
 */
export function getChatInstanceManager(): any {
	return chatInstanceManager;
}

/**
 * Test-only seam: inject a ChatInstanceManager without full gateway startup
 * (the integration suite runs `isolate:false`, where vi.mock on shared
 * singletons is unreliable — see app-installation-credential.test.ts).
 */
export function __setChatInstanceManagerForTests(manager: unknown): void {
	chatInstanceManager = manager;
}

export function getLobuCoreServices(): any {
	return coreServices;
}

export { ensureEmbeddedGatewaySecrets };

/**
 * The MCP surface the isolate-lane shadow producer reads tools through — both
 * halves or neither, since a proxy without its config service (or vice versa)
 * cannot list a single tool.
 */
function agentTurnMcpDeps(
	coreServices: CoreServices,
): AgentTurnShadowDeps["mcp"] {
	const configService = coreServices.getMcpConfigService();
	const proxy = coreServices.getMcpProxy();
	return configService && proxy ? { configService, proxy } : undefined;
}
