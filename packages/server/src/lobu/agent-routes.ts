/**
 * Agent CRUD routes for the embedded Lobu gateway.
 *
 * All routes are org-scoped via mcpAuth middleware and orgContext.
 */

import type { AuthProfile } from "@lobu/core";
import {
	type ManageAutomationsArgs,
	normalizeAutomationUpdatePatch,
} from "@lobu/core/contracts/tools/manage-automations";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Type, type TObject } from "@sinclair/typebox";
import {
  CreateInferenceProviderAction, DeleteInferenceProviderAction, ListInferenceProvidersAction,
  RotateInferenceProviderKeyAction, SetDefaultInferenceProviderAction,
  SetInferenceProviderCapabilityAction, UpdateInferenceProviderAction,
  type ManageInferenceProvidersArgs,
} from "@lobu/core/contracts/tools/manage-inference-providers";
import { manageInferenceProviders, providerAuditTransaction } from "../tools/admin/manage_inference_providers";
import { extractAuthContext, toToolContext } from "../tools/execute";
import { validateToolArgs } from "../tools/validate-args";
import { ToolUserError } from "../utils/errors";
import { mcpAuth } from "../auth/middleware";
import { resolveAutomationTriggerWrite } from "../automations/triggers";
import { type DbClient, getDb } from "../db/client";
import { grantStrategyFor } from "../gateway/auth/oauth/grant-strategy";
import { UserAuthProfileStore } from "../gateway/auth/settings/user-auth-profile-store";
import {
	getOAuthProviderConfig,
	type OAuthProviderConfig,
} from "../gateway/auth/oauth/providers";
import { buildProviderCatalog } from "../gateway/auth/provider-catalog";
import { createAuthProfileLabel } from "../gateway/auth/settings/auth-profiles-manager";
import { orgBucketAgentId } from "../gateway/auth/settings/user-auth-profile-store";
import {
	deleteAgentConfig,
	insertAgentConfig,
	persistAgentMetadataPatch,
	persistAgentSettingsPatch,
	validateAgentSettingsUpdate,
} from "./agent-settings";
import type { ModelValidationError } from "./model-config";
import {
	ProviderRegistryService,
	resolveProviderRegistryPath,
} from "../gateway/services/provider-registry-service";
import type { Env } from "../index";
import { getApplyContext } from "../utils/apply-context";
import { insertConfigChangeEventInTransaction } from "../utils/insert-event";
import logger from "../utils/logger";
import { generateCodeVerifier } from "../utils/pkce";
import { lockOrganizationForRelationshipClaims } from "../utils/relationship-claims";
import { countRuntimeMessagingClientsByAgent } from "./client-routes";
import { getLobuCoreServices } from "./gateway";
import { orgContext } from "./stores/org-context";
import {
	AGENT_ID_PATTERN,
	createPostgresAgentConfigStore,
} from "./stores/postgres-stores";
import { PostgresSecretStore } from "./stores/postgres-secret-store";
import { ensureOAuthInferenceProvider, getOrgDefaultModel } from "./stores/provider-secrets";

const routes = new Hono<{ Bindings: Env }>();

/**
 * Coerce an `array_agg` result into a real `string[]`. With the `::text` cast
 * the driver returns a JS array, but if some schema still hands back a raw
 * Postgres array literal (`'{telegram,slack}'`) we parse it rather than letting
 * a string leak to the UI, where `.map` would throw.
 */
function toStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String);
	if (typeof value === "string") {
		const inner = value.replace(/^\{/, "").replace(/\}$/, "").trim();
		if (!inner) return [];
		return inner.split(",").map((s) => s.replace(/^"|"$/g, "").trim());
	}
	return [];
}

const configStore = createPostgresAgentConfigStore();

function buildRequestBaseUrls(c: any, agentId: string, providerId: string) {
	const url = new URL(c.req.url);
	const apiIndex = url.pathname.indexOf("/api/");
	const mountPath = apiIndex >= 0 ? url.pathname.slice(0, apiIndex) : "";
	const origin = url.origin;
	const orgSlug = c.req.param("orgSlug") as string | undefined;
	const encodedAgent = encodeURIComponent(agentId);
	return {
		proxyBaseUrl: `${origin}${mountPath}/api/proxy`,
		expectedProxyUrl: `${origin}${mountPath}/api/proxy/${providerId}/a/${encodedAgent}`,
		settingsUrl: orgSlug
			? `${origin}${mountPath}/${encodeURIComponent(orgSlug)}/agents/${encodedAgent}/settings`
			: `${origin}${mountPath}/agents/${encodedAgent}/settings`,
	};
}

/**
 * Validate a PATCHed `models` list. Every entry must be an explicit
 * `<slug>/<model>` ref (no bare model ids, no `auto` in either position) whose
 * slug resolves at the ORG level: a registry provider module OR one of the
 * org's `inference_providers` rows. Validating against the org-level set (not
 * the agent's own list) is what makes the write atomic — an entry can never
 * dangle on "the agent hasn't installed that provider yet", because the list
 * being written IS the install.
 *
 * Returns `{ error }` JSON on the first invalid entry, or null when valid.
 */
/**
 * Legacy agent-settings model fields removed in the atomic cutover. A PATCH
 * carrying any of these is rejected (see the config route) rather than silently
 * dropped — silently dropping would reset a RESTRICTED agent to `models = NULL`
 * (allow-all), widening access. Exported for the route guard + its test.
 */
export const LEGACY_MODEL_FIELDS = [
	"defaultModel",
	"installedProviders",
] as const;

/**
 * Map a structured `models` validation error onto the route's JSON envelope.
 * The shape/slug validation itself is shared with the MCP `manage_agents` path
 * (`validateAgentSettingsUpdate`); this only enriches the not-connected case
 * with request-derived proxy/settings URLs, which need the Hono context.
 */
export function modelValidationResponse(
	error: ModelValidationError,
	params: { c: any; agentId: string }
) {
	if (error.kind === "invalid_models") {
		return { error: "invalid_models", error_description: error.message };
	}
	if (error.kind === "invalid_model_ref") {
		return {
			error: "invalid_model_ref",
			error_description: error.message,
			model: error.model,
		};
	}
	const urls = buildRequestBaseUrls(params.c, params.agentId, error.provider);
	return {
		error: "model_provider_not_connected",
		error_description: `${error.message} Expected gateway proxy URL after setup: ${urls.expectedProxyUrl}`,
		model: error.model,
		provider: error.provider,
		settingsUrl: urls.settingsUrl,
		expectedProxyUrl: urls.expectedProxyUrl,
	};
}

// ── Route-level middleware ───────────────────────────────────────────────────
//
// Every agent route is org-scoped: it requires a valid auth context (`mcpAuth`)
// and runs inside an `orgContext` keyed on the caller's organization. Both used
// to be repeated per handler (`routes.get('/', mcpAuth, …)` plus a
// `withOrg(c, …)` wrapper); they're applied once here. Registered before any
// route handler below so they wrap all of them.

routes.use("*", mcpAuth);

routes.use("*", async (c, next) => {
	const orgId = c.get("organizationId");
	if (!orgId) return c.json({ error: "Organization required" }, 401);
	return orgContext.run({ organizationId: orgId }, next);
});

/**
 * Admin-tier auth gate.
 *
 * Admin-tier routes (agent CRUD, connection mutations, anything called by
 * `lobu apply`) accept either:
 *   - a better-auth session (`authSource === 'session'`), or
 *   - a PAT/OAuth bearer that carries the `mcp:admin` scope.
 *
 * Read-only routes (list, get) keep using `mcpAuth` alone — a `mcp:read` PAT
 * is fine for those.
 *
 * Returns a Response when the request must be rejected; returns null when the
 * caller should proceed.
 */
export function requireSessionOrAdminPat(c: any): Response | null {
	const authSource = c.get("authSource") as "session" | "pat" | "oauth" | null;

	if (authSource === "session") {
		return null;
	}

	if (authSource === "pat" || authSource === "oauth") {
		const authInfo = c.get("mcpAuthInfo");
		const scopes: string[] = Array.isArray(authInfo?.scopes)
			? authInfo.scopes
			: [];
		if (scopes.includes("mcp:admin")) {
			return null;
		}
		return c.json(
			{
				error: "forbidden",
				error_description:
					"This route requires a web session or a token with mcp:admin scope.",
			},
			403
		);
	}

	return c.json({ error: "Authentication required" }, 401);
}

/**
 * Gate agent management mutations (create/update/delete/config), every
 * inference-provider mutation (create/update/key/default/capabilities/
 * delete/OAuth) and every sandbox mutation (create/credential/delete) to org
 * owner/admin. Inference providers and sandboxes are both ORG-level
 * credentials shared by every agent, so they sit on the same admin tier as
 * agent administration (`manage_agents` in auth/tool-access.ts).
 * `requireSessionOrAdminPat` alone only proves an authenticated caller — any
 * org MEMBER passes it, so a member could create agents, rewrite or delete
 * another member's agent (or change its soulMd, guardrails or tool surface)
 * via POST/PATCH/DELETE, or add/rotate/delete the org's provider
 * credentials. On top of that session-or-admin-scope check, the caller's
 * member role must be owner/admin for EVERY auth source — mirroring index.ts
 * `requireOrganizationSettingsAdmin` and the manage_agents tool's admin
 * tier, both of which treat the role check as non-authorizable: an
 * `mcp:admin` scope alone never elevates a plain member, and a demoted
 * owner's stale admin token stays denied. The deployment routes are outside
 * this gate's scope: their POST
 * already runs a finer-grained check of its own (a member may file a
 * non-authorizing `blocked` report but not a `succeeded` baseline).
 */
export function requireManageAgentAccess(c: any): Response | null {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;

	const memberRole = c.get("memberRole") as string | null | undefined;
	if (memberRole !== "owner" && memberRole !== "admin") {
		return c.json(
			{
				error: "forbidden",
				error_description:
					"Agent, inference-provider and sandbox management requires owner or admin access.",
			},
			403
		);
	}
	return null;
}

/**
 * Emit a config-audit event for a mutation handled in this file. Thin wrapper
 * binding the transactional, redacting writer to
 * the request's apply/actor context.
 */
function emitConfigChange(
	c: any,
	params: {
		resourceKind: Parameters<typeof insertConfigChangeEventInTransaction>[0]["resourceKind"];
		resourceId: string | number;
		op: "created" | "updated" | "deleted";
		summary: string;
		state: Record<string, unknown> | null;
		changedFields?: string[];
		before?: Record<string, unknown> | null;
	},
  transaction: DbClient
): Promise<unknown> {
	const applyCtx = getApplyContext(c);
	const event = {
		organizationId: c.get("organizationId") as string,
		...params,
		applyId: applyCtx.applyId,
		actorSource: applyCtx.actorSource,
		createdBy: applyCtx.createdBy,
		clientId: applyCtx.clientId,
	};
  return insertConfigChangeEventInTransaction(event, transaction);
}

/** Whitelist profile metadata down to the non-secret fields (email, expiresAt, accountId). */
function sanitizeClientProfileMetadata(
	metadata: AuthProfile["metadata"]
): AuthProfile["metadata"] | undefined {
	if (!metadata) return undefined;
	const next = {
		...(metadata.email ? { email: metadata.email } : {}),
		...(typeof metadata.expiresAt === "number"
			? { expiresAt: metadata.expiresAt }
			: {}),
		...(metadata.accountId ? { accountId: metadata.accountId } : {}),
	};
	return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Strip secret material from a stored auth profile before returning it to the
 * web client. `user_auth_profiles` only ever holds refs (not plaintext), but
 * we still drop `credentialRef` / `metadata.*Ref` so the UI never sees them.
 * `credential` is surfaced as an empty string to match the client type — the
 * UI uses it only as "is a key already saved?" signal, never reads its value.
 */
function sanitizeAuthProfileForClient(profile: AuthProfile) {
	const metadata = sanitizeClientProfileMetadata(profile.metadata);
	return {
		id: profile.id,
		provider: profile.provider,
		model: profile.model,
		credential: "",
		label: profile.label,
		authType: profile.authType,
		...(metadata ? { metadata } : {}),
		createdAt: profile.createdAt,
	};
}

/**
 * Reconcile the user-scoped auth profiles for `(userId, agentId)` against the
 * list the web client just submitted in a `PATCH /config` body.
 *
 *   - entries in `desired` that carry a non-empty `credential` are upserted
 *     first (the secret is written to the secret store, the ref to the profile
 *     JSON) — done before any removal so a failed write can't leave the user
 *     with fewer credentials than they started with.
 *   - profiles in the store but absent from `desired` are then removed (with
 *     their secrets), so deleting a provider row in the UI actually deletes it.
 *   - entries with an empty/absent `credential` are unchanged rows the client
 *     round-tripped — left as-is so the stored secret is preserved.
 *
 * Throws if the auth-profiles manager is unavailable; the caller surfaces that
 * rather than reporting a save that was dropped.
 */
async function reconcileAgentAuthProfiles(
	agentId: string,
	userId: string,
	desired: AuthProfile[]
): Promise<void> {
	const manager = getLobuCoreServices()?.getAuthProfilesManager?.();
	if (!manager) {
		throw new Error(
			"Auth profile store is not available — retry once startup completes"
		);
	}
	const store = manager.getUserAuthProfileStore();
	for (const profile of desired) {
		const credential =
			typeof profile.credential === "string" ? profile.credential.trim() : "";
		if (!credential) continue;
		const metadata = sanitizeClientProfileMetadata(profile.metadata);
		await manager.upsertProfile({
			userId,
			agentId,
			id: profile.id,
			provider: profile.provider,
			credential,
			authType: profile.authType,
			label: profile.label,
			model: profile.model,
			...(metadata ? { metadata } : {}),
			makePrimary: true,
		});
	}
	const desiredIds = new Set(
		desired.map((profile) => profile.id).filter(Boolean)
	);
	const current = await store.list(userId, agentId);
	for (const existing of current) {
		if (!desiredIds.has(existing.id)) {
			await store.remove(userId, agentId, {
				provider: existing.provider,
				profileId: existing.id,
			});
		}
	}
}

/** True if the submitted profile list contains at least one fresh credential. */
function hasFreshCredential(profiles: AuthProfile[]): boolean {
	return profiles.some(
		(profile) =>
			typeof profile.credential === "string" &&
			profile.credential.trim().length > 0
	);
}

// ── List agents ──────────────────────────────────────────────────────────────

routes.get("/", async (c) => {
	const agents = await configStore.listAgents();

	// Count connections per agent
	const sql = getDb();
	const orgId = c.get("organizationId")!;
	const connCounts = await sql`
    SELECT c.agent_id,
      count(*)::int as count,
      count(*) FILTER (WHERE c.status = 'active')::int as active_count
    FROM connections c
    JOIN agents a ON a.id = c.agent_id AND a.organization_id = c.organization_id
    WHERE c.organization_id = ${orgId}
      AND c.credential_mode IS NOT NULL
      AND c.deleted_at IS NULL
    GROUP BY c.agent_id
  `;
	const countMap = new Map(connCounts.map((r: any) => [r.agent_id, r.count]));
	const activeCountMap = new Map(
		connCounts.map((r: any) => [r.agent_id, r.active_count])
	);

	const [
		systemRows,
		runtimeClientCounts,
		automationCounts,
		userCounts,
		platformRows,
		providerRows,
	] = await Promise.all([
		sql<{ system_agent_id: string | null }>`
			SELECT system_agent_id FROM organization WHERE id = ${orgId} LIMIT 1
		`,
		countRuntimeMessagingClientsByAgent(orgId),
		// Automations owned by each agent (active only).
		sql`
        SELECT managed_agent_id, count(*)::int as count
        FROM automations
        WHERE organization_id = ${orgId} AND status = 'active' AND managed_agent_id IS NOT NULL
        GROUP BY managed_agent_id
      `,
		// Distinct end-users per agent across messaging platforms.
		sql`
        SELECT u.agent_id, count(DISTINCT (u.platform, u.user_id))::int as count
        FROM agent_users u
        JOIN agents a ON a.id = u.agent_id
        WHERE a.organization_id = ${orgId}
        GROUP BY u.agent_id
      `,
		// Distinct connection platforms per agent. Cast to text so the driver always
		// returns a JS array — array_agg over an enum/varchar column can come back as
		// a raw `'{telegram,slack}'` string when postgres.js has no array parser for
		// the element OID, which then blows up `.map` in the UI.
		sql`
        SELECT c.agent_id, array_agg(DISTINCT c.connector_key::text) as platforms
        FROM connections c
        JOIN agents a ON a.id = c.agent_id AND a.organization_id = c.organization_id
        WHERE c.organization_id = ${orgId}
          AND c.credential_mode IS NOT NULL
          AND c.deleted_at IS NULL
        GROUP BY c.agent_id
      `,
		// Provider ids per agent, derived from the `models` list's slug prefixes.
		sql`
        SELECT id, models
        FROM agents
        WHERE organization_id = ${orgId}
      `,
	]);
	const systemAgentId = systemRows[0]?.system_agent_id ?? null;

	const clientCountMap = new Map<string, Set<string>>();
	for (const [agentId, runtimeIds] of runtimeClientCounts.entries()) {
		let ids = clientCountMap.get(agentId);
		if (!ids) {
			ids = new Set<string>();
			clientCountMap.set(agentId, ids);
		}
		for (const clientId of runtimeIds) ids.add(clientId);
	}
	const automationCountMap = new Map(
		automationCounts.map((r: any) => [r.managed_agent_id, r.count])
	);
	const userCountMap = new Map(
		userCounts.map((r: any) => [r.agent_id, r.count])
	);
	const platformsMap = new Map(
		platformRows.map((r: any) => [r.agent_id, toStringArray(r.platforms)])
	);
	const providersMap = new Map<string, string[]>();
	for (const r of providerRows) {
		const set = new Set<string>();
		for (const ref of ((r as any).models ?? []) as unknown[]) {
			if (typeof ref !== "string") continue;
			const slash = ref.indexOf("/");
			if (slash > 0) set.add(ref.slice(0, slash));
		}
		providersMap.set((r as any).id, [...set]);
	}

	return c.json({
		agents: agents.map((a) => ({
			...a,
			system: a.agentId === systemAgentId,
			connectionCount: countMap.get(a.agentId) ?? 0,
			activeConnectionCount: activeCountMap.get(a.agentId) ?? 0,
			clientCount: clientCountMap.get(a.agentId)?.size ?? 0,
			automationCount: automationCountMap.get(a.agentId) ?? 0,
			userCount: userCountMap.get(a.agentId) ?? 0,
			platforms: platformsMap.get(a.agentId) ?? [],
			providers: providersMap.get(a.agentId) ?? [],
			status: (activeCountMap.get(a.agentId) ?? 0) > 0 ? "active" : "idle",
		})),
	});
});

// ── Create agent ─────────────────────────────────────────────────────────────

routes.post("/", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const body = await c.req.json<{
		agentId: string;
		name: string;
		description?: string;
	}>();
	const user = c.get("user");
	if (!user) return c.json({ error: "Authentication required" }, 401);

	const { agentId, name, description } = body;
	if (!agentId || !name)
		return c.json({ error: "agentId and name are required" }, 400);

	// Validate agentId format
	if (!AGENT_ID_PATTERN.test(agentId)) {
		return c.json(
			{
				error:
					"agentId must be 3-60 lowercase alphanumeric chars with hyphens, starting with a letter",
			},
			400
		);
	}

	const orgId = c.get("organizationId") as string;

	const sql = getDb();
	// Seed provisioning defaults in the INSERT so concurrent idempotent creates
	// cannot observe a partially initialized row or overwrite operator settings.
	return sql.begin(async (tx) => {
	const inserted = await insertAgentConfig(tx,
		{ agent_id: agentId, name, description }, { platform: "lobu", userId: user.id },
		undefined, { organizationId: orgId, ...getApplyContext(c) });

	if (!inserted) {
		// Another writer (or a previous apply cycle) already owns this id in
		// *this* org. Return idempotent 200 with the existing row's metadata.
		// Cross-org collisions are no longer possible — the PK is per-org now.
		const existing = await createPostgresAgentConfigStore(tx).getMetadata(agentId);
		if (!existing) {
			return c.json({ error: "Agent metadata missing" }, 500);
		}
		return c.json(
			{
				agentId,
				name: existing.name,
				description: existing.description,
			},
			200
		);
	}

	return c.json({ agentId, name, description }, 201);
  });
});

// ── Org-scoped inference-provider routes ─────────────────────────────────────
// Registered BEFORE any `/:agentId` route so these literal paths win the match
// (Hono would otherwise treat 'inference-providers' as an :agentId → 404).
// The requireOrgId helper is a hoisted function declaration
// defined lower in this file.

/** Adapt the existing REST shapes to the same validated action runner as MCP/SDK. */
async function inferenceProviderRequest(c: Context<{ Bindings: Env }>, schema: TObject, params: Record<string, string> = {}) {
  if (schema.properties.action.const !== "list") {
    const denied = requireManageAgentAccess(c);
    if (denied) return denied;
  }
  const orgId = requireOrgId(c);
  if (typeof orgId !== "string") return orgId;
  try {
    let body: unknown = {};
    if (c.req.raw.body) {
      try { body = await c.req.json(); }
      catch { throw new ToolUserError("Invalid or missing JSON body", 400); }
    }
    // URL selectors and action cannot be supplied or retargeted by the body.
    const validated = validateToolArgs("manage_inference_providers", Type.Omit(schema, ["action", ...Object.keys(params)]), body) as object;
    const args = { ...validated, ...params, action: schema.properties.action.const } as ManageInferenceProvidersArgs;
    const result = await manageInferenceProviders(args, c.env, toToolContext(extractAuthContext(c)));
    return c.json(result, args.action === "create" ? 201 : 200);
  } catch (error) {
    if (error instanceof ToolUserError) return c.json({ error: error.message }, error.httpStatus as ContentfulStatusCode);
    throw error;
  }
}

routes.get("/inference-providers", c => inferenceProviderRequest(c, ListInferenceProvidersAction));

// Bundled provider catalog (PUBLIC metadata only — no secrets). Renders the
// default "Available" add-cards on the inference-providers page; each entry
// carries enough pre-fill data that adopting a bundled provider needs only an
// API key. Registered before any `/:agentId` route so the literal path matches.
routes.get("/inference-providers/catalog", async (c) => {
	try {
		const registry = new ProviderRegistryService(resolveProviderRegistryPath());
		const configs = await registry.getProviderConfigs();
		// Built from the module registry (not just providers.json) so Claude /
		// ChatGPT (OAuth modules) appear too, each carrying its auth metadata.
		const catalog = buildProviderCatalog(configs);
		return c.json({ catalog });
	} catch (err) {
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"[inference-providers/catalog] failed to load bundled provider catalog"
		);
		return c.json({ catalog: [] });
	}
});

// ── Org-scoped LLM-provider OAuth (subscription login) ───────────────────────
//
// Generic start/complete for every providers.json entry with an `oauth` block.
// Profiles land in the per-user ORG BUCKET so one sign-in covers all of this
// user's agents in the org. Grant handling is dispatched by config.grant via
// grantStrategyFor.
//
// Auth: interactive session only.

/** Resolve the OAuth provider config, or a 400 Response if unknown. */
function resolveOAuthProvider(
	c: any,
	providerId: unknown
): OAuthProviderConfig | Response {
	const id = typeof providerId === "string" ? providerId : "";
	const config = getOAuthProviderConfig(id);
	if (!config) {
		return c.json(
			{ error: `Provider '${id}' does not support OAuth sign-in` },
			400
		);
	}
	return config;
}

/**
 * Interactive-session guard for OAuth. OAuth providers require a real user to
 * complete the browser round-trip; a headless PAT/OAuth-bearer caller cannot.
 * Returns the session user, or a Response (403 headless, 401 unauthenticated).
 */
function requireInteractiveUser(c: any): { id: string } | Response {
	const user = c.get("user") as { id: string } | undefined;
	const authSource = c.get("authSource") as string | null;
	if (authSource !== "session" || !user) {
		return c.json(
			{ error: "OAuth providers require interactive sign-in" },
			403
		);
	}
	return user;
}

routes.post("/inference-providers/oauth/start", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const config = resolveOAuthProvider(c, await readProviderId(c));
	if (config instanceof Response) return config;
	const user = requireInteractiveUser(c);
	if (user instanceof Response) return user;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;

	const strategy = grantStrategyFor(config);
	const bucketAgentId = orgBucketAgentId(orgId);

	if ((config.grant ?? "authorization-code") === "authorization-code") {
		const oauthStateStore = getLobuCoreServices()?.getOAuthStateStore?.();
		if (!oauthStateStore) {
			return c.json({ error: "Embedded Lobu auth is not available" }, 503);
		}
		// Mint the PKCE verifier + state row FIRST, then build the authorize URL
		// around that exact state so `complete` can validate it and recover the
		// verifier. The bucket agentId rides the state so complete stores to the
		// same org bucket even though no agents row exists for it.
		const codeVerifier = generateCodeVerifier();
		const stateToken = await oauthStateStore.create({
			userId: user.id,
			agentId: bucketAgentId,
			codeVerifier,
			context: { platform: "web", channelId: bucketAgentId },
		});
		const result = await strategy.start(
			config,
			{ kind: "org", slug: orgId, organizationId: orgId, userId: user.id },
			{ stateToken, codeVerifier }
		);
		return c.json(result);
	}

	// device-code (ChatGPT): no state store — deviceAuthId + userCode round-trip
	// directly through the client on poll.
	const result = await strategy.start(config, {
		kind: "org",
		slug: orgId,
		organizationId: orgId,
		userId: user.id,
	});
	return c.json(result);
});

routes.post("/inference-providers/oauth/complete", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const body = (await c.req.json().catch(() => ({}))) as {
		providerId?: unknown;
		code?: unknown;
		deviceAuthId?: unknown;
		userCode?: unknown;
	};
	const config = resolveOAuthProvider(c, body.providerId);
	if (config instanceof Response) return config;
	const user = requireInteractiveUser(c);
	if (user instanceof Response) return user;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;

	const authProfilesManager = getLobuCoreServices()?.getAuthProfilesManager?.();
	if (!authProfilesManager) {
		return c.json({ error: "Embedded Lobu auth is not available" }, 503);
	}

	const strategy = grantStrategyFor(config);
	const scope = {
		kind: "org" as const,
		slug: orgId,
		organizationId: orgId,
		userId: user.id,
	};
	const bucketAgentId = orgBucketAgentId(orgId);

	try {
		let stored: Awaited<ReturnType<typeof strategy.complete>>;
		if ((config.grant ?? "authorization-code") === "authorization-code") {
			const input = typeof body.code === "string" ? body.code.trim() : "";
			if (!input) return c.json({ error: "Missing OAuth code" }, 400);
			const parts = input.split("#");
			if (parts.length !== 2 || !parts[0] || !parts[1]) {
				return c.json(
					{ error: "OAuth code must be in code#state format" },
					400
				);
			}
			const oauthStateStore = getLobuCoreServices()?.getOAuthStateStore?.();
			if (!oauthStateStore) {
				return c.json({ error: "Embedded Lobu auth is not available" }, 503);
			}
			const stateData = await oauthStateStore.consume(parts[1].trim());
			if (!stateData) {
				return c.json({ error: "OAuth state expired or is invalid" }, 400);
			}
			if (stateData.userId !== user.id || stateData.agentId !== bucketAgentId) {
				return c.json(
					{ error: "OAuth state does not match this session" },
					403
				);
			}
			stored = await strategy.complete(config, scope, {
				mode: "redirect",
				code: parts[0].trim(),
				state: parts[1].trim(),
				codeVerifier: stateData.codeVerifier,
			});
		} else {
			const deviceAuthId =
				typeof body.deviceAuthId === "string" ? body.deviceAuthId.trim() : "";
			const userCode =
				typeof body.userCode === "string" ? body.userCode.trim() : "";
			if (!deviceAuthId || !userCode) {
				return c.json({ error: "Missing deviceAuthId or userCode" }, 400);
			}
			stored = await strategy.complete(config, scope, {
				mode: "device",
				deviceAuthId,
				userCode,
			});
			if (!stored) return c.json({ status: "pending" });
		}

		// authorization-code never returns null (it either exchanges or throws); the
		// device branch already handled its pending case. This guards the type.
		if (!stored) return c.json({ status: "pending" });

		// Persist to the org bucket. `organizationId` on the row is what keeps these
		// tokens refreshing (scanAllOAuth COALESCE + refreshForUserAgent branch);
		// the profile's providerId must be the config id so the refresh job's
		// `doRefresh` matches it to the right refresher.
		await providerAuditTransaction(toToolContext(extractAuthContext(c)), config.id, async (tx, before) => {
		await authProfilesManager.upsertProfile({
			agentId: bucketAgentId,
			userId: user.id,
			provider: config.id,
			credential: stored.accessToken,
			authType: stored.authType,
			label: createAuthProfileLabel(
				config.name,
				stored.accessToken,
				stored.accountId
			),
			metadata: {
				...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {}),
				expiresAt: stored.expiresAt,
				...(stored.accountId ? { accountId: stored.accountId } : {}),
			},
			makePrimary: true,
			organizationId: orgId,
		}, { userAuthProfiles: new UserAuthProfileStore(new PostgresSecretStore(tx), tx) });

		const provider = await ensureOAuthInferenceProvider({
			organizationId: orgId,
			slug: config.id,
			kind: config.id,
			displayName: config.name,
			defaultModel: config.defaultModel,
			createdBy: user.id,
		}, tx);
		await emitConfigChange(c, {
      before,
			resourceKind: "inference-provider",
			resourceId: provider.slug,
			op: before ? "updated" : "created",
			summary: `Inference provider '${provider.slug}' connected`,
			state: {
				slug: provider.slug,
				kind: provider.kind,
				displayName: provider.displayName,
				capabilities: provider.capabilities,
				hasCustomUpstream: provider.hasCustomUpstream,
				status: provider.status,
				isDefault: provider.isDefault,
			},
		}, tx);
    });

		return c.json({ status: "success" });
	} catch (error) {
		return c.json(
			{
				error: error instanceof Error ? error.message : "OAuth exchange failed",
			},
			400
		);
	}
});

/** Read `providerId` from the JSON body (start route). Kept tiny so the two
 *  OAuth handlers share the parse without duplicating the try/catch. */
async function readProviderId(c: any): Promise<unknown> {
	const body = (await c.req.json().catch(() => ({}))) as {
		providerId?: unknown;
	};
	return body.providerId;
}

routes.post("/inference-providers", c => inferenceProviderRequest(c, CreateInferenceProviderAction));
routes.put("/inference-providers/:slug", c => inferenceProviderRequest(c, UpdateInferenceProviderAction, { slug: c.req.param("slug") }));
routes.put("/inference-providers/:slug/default", c => inferenceProviderRequest(c, SetDefaultInferenceProviderAction, { slug: c.req.param("slug") }));
routes.put("/inference-providers/:slug/capabilities/:modality", c => inferenceProviderRequest(c, SetInferenceProviderCapabilityAction, { slug: c.req.param("slug"), modality: c.req.param("modality") }));
routes.put("/inference-providers/:slug/key", c => inferenceProviderRequest(c, RotateInferenceProviderKeyAction, { slug: c.req.param("slug") }));
routes.delete("/inference-providers/:slug", c => inferenceProviderRequest(c, DeleteInferenceProviderAction, { slug: c.req.param("slug") }));

// ── Get agent detail ─────────────────────────────────────────────────────────

routes.get("/:agentId", async (c) => {
	const { agentId } = c.req.param();
	const metadata = await configStore.getMetadata(agentId);
	if (!metadata) return c.json({ error: "Agent not found" }, 404);

	const settings = await configStore.getSettings(agentId);
	const sql = getDb();
	const organizationId = c.get("organizationId") as string;
	const [connectionStats] = await sql`
    SELECT
      count(*)::int as connection_count,
      count(*) FILTER (WHERE status = 'active')::int as active_connection_count
    FROM connections
    WHERE agent_id = ${agentId} AND organization_id = ${organizationId}
      AND credential_mode IS NOT NULL AND deleted_at IS NULL
  `;
	const clientIds = new Set<string>();
	const runtimeClientCounts =
		await countRuntimeMessagingClientsByAgent(organizationId);
	for (const runtimeClientId of runtimeClientCounts.get(agentId) ?? []) {
		clientIds.add(runtimeClientId);
	}

	return c.json({
		...metadata,
		settings,
		connectionCount: connectionStats?.connection_count ?? 0,
		activeConnectionCount: connectionStats?.active_connection_count ?? 0,
		clientCount: clientIds.size,
		status:
			(connectionStats?.active_connection_count ?? 0) > 0 ? "active" : "idle",
	});
});

// ── Update agent metadata ────────────────────────────────────────────────────

routes.patch("/:agentId", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const { agentId } = c.req.param();
	const body = await c.req.json<{ name?: string; description?: string }>();

	if (!(await configStore.hasAgent(agentId))) {
		return c.json({ error: "Agent not found" }, 404);
	}

  return getDb().begin(async (tx) => {
    const orgId = c.get("organizationId") as string;
    await lockOrganizationForRelationshipClaims(tx, orgId);
    const locked = await tx`SELECT id FROM agents WHERE organization_id = ${orgId} AND id = ${agentId} FOR UPDATE`;
    if (!locked.length) return c.json({ error: "Agent not found" }, 404);
    await persistAgentMetadataPatch(tx, agentId, body, {
      organizationId: orgId, ...getApplyContext(c),
    });
	return c.json({ success: true });
  });
});

// ── Delete agent ─────────────────────────────────────────────────────────────

routes.delete("/:agentId", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const { agentId } = c.req.param();

	if (!(await configStore.hasAgent(agentId))) {
		return c.json({ error: "Agent not found" }, 404);
	}

  return getDb().begin(async (tx) => {
    const orgId = c.get("organizationId") as string;
    await lockOrganizationForRelationshipClaims(tx, orgId);
    const locked = await tx`SELECT id FROM agents WHERE organization_id = ${orgId} AND id = ${agentId} FOR UPDATE`;
    if (!locked.length) return c.json({ error: "Agent not found" }, 404);
    await deleteAgentConfig(tx, agentId, { organizationId: orgId, ...getApplyContext(c) });
	return c.json({ success: true });
  });
});

// ── Get agent config (settings) ──────────────────────────────────────────────

routes.get("/:agentId/config", async (c) => {
	const { agentId } = c.req.param();
	const settings = await configStore.getSettings(agentId);
	if (!settings) return c.json({ error: "Agent not found" }, 404);

	// `configStore` doesn't carry auth profiles (they live in
	// `user_auth_profiles`, keyed by the requesting user). Merge the caller's
	// sanitized profiles in so the agent settings UI can show which providers
	// already have a credential connected.
	const user = c.get("user");
	const authProfilesManager = getLobuCoreServices()?.getAuthProfilesManager?.();
	const authProfiles =
		user?.id && authProfilesManager
			? (
					await authProfilesManager
						.getUserAuthProfileStore()
						.list(user.id, agentId)
				).map(sanitizeAuthProfileForClient)
			: [];

	return c.json({ ...settings, authProfiles });
});

// ── Pending write-gate proposal (config-approval prefill) ────────────────────
//
// A config change an agent proposes (from Slack or elsewhere) is held as
// a pending internal run; the chat-history replay only surfaces its approval
// card in the EXACT originating conversation, so a web deep link to the config
// form never sees it. This conversation-agnostic read returns the held proposal
// by run_id so a prefilled deep link (`/agents/:agentId/settings?run_id=…`) can
// render the proposed change for review + approve. Org-scoped + Postgres-backed,
// so correct under N replicas.
//
// AuthZ: org-scoped by the middleware `organizationId`; the held proposal must
// also TARGET `:agentId`. Scoped to manage_agents update runs, whose proposal
// carries agent_id at the top level (manage_automations, whose proposal nests
// managed_agent_id under `args`, is excluded — see below).
routes.get("/:agentId/config/pending/:runId", async (c) => {
	const { agentId } = c.req.param();
	const organizationId = c.get("organizationId") as string;
	const runId = Number(c.req.param("runId"));
	if (!Number.isInteger(runId) || runId <= 0) {
		return c.json({ error: "Invalid run id" }, 400);
	}

	const rows = await getDb()<{
		action: string | null;
		proposal: Record<string, unknown> | null;
		current: Record<string, unknown> | null;
		tool: string | null;
	}>`
		SELECT e.metadata->>'action' AS action,
		       e.metadata->'proposal' AS proposal,
		       e.metadata->'current' AS current,
		       e.metadata->>'tool' AS tool
		FROM runs r
		JOIN current_event_records e
		  ON e.run_id = r.id
		 AND e.interaction_type = 'approval'
		 AND e.interaction_status = 'pending'
		WHERE r.id = ${runId}
		  AND r.organization_id = ${organizationId}
		  AND r.run_type = 'internal'
		  AND r.approval_status = 'pending'
		ORDER BY e.id DESC
		LIMIT 1
	`;
	const row = rows[0];
	if (!row) return c.json({ error: "No pending proposal for this run" }, 404);

	// Scoped to manage_agents UPDATE: this feeds the AGENT config form (name /
	// description / identity), which binds agent fields only and only makes sense
	// for an update. A create has no existing agent to render; a delete would show
	// ordinary config fields + a generic Approve that silently DELETES the agent —
	// so both 404 here (they keep the run-permalink review path). manage_automations
	// proposals (`{ args, actingAgentId, ... }`, automation-shaped, managed_agent_id in args)
	// belong to a separate automation review surface. Anything else 404s.
	const rawProposal = row.proposal ?? null;
	if (
		row.tool !== "manage_agents" ||
		row.action !== "update" ||
		!rawProposal ||
		typeof rawProposal !== "object"
	) {
		return c.json({ error: "No pending proposal for this run" }, 404);
	}

	// The held proposal must target the agent in the path (manage_agents keeps
	// agent_id top-level). Don't leak whether a run exists for another agent —
	// same 404 as "no pending proposal".
	const targetAgentId =
		(rawProposal as { agent_id?: unknown }).agent_id ?? null;
	if (targetAgentId !== agentId) {
		return c.json({ error: "No pending proposal for this run" }, 404);
	}

	return c.json({
		runId,
		resourceKind: "agent" as const,
		action: row.action,
		proposal: rawProposal,
		current: row.current ?? null,
	});
});

// GET /:agentId/automations/:automationId/pending/:runId — the Automation parity of the
// agent config-prefill endpoint above. A pending `manage_automations` update run is
// reviewed on the workspace Automation edit form, prefilled via `?run_id=`. The
// data endpoint remains agent-scoped to enforce ownership. Returns the held proposal
// so the form can render + approve it.
//
// AuthZ: org-scoped by middleware; the held proposal must target `:automationId`
// AND be owned by `:agentId`. A manage_automations proposal is `{ args, ... }` with
// automation_id / managed_agent_id nested INSIDE `args` (unlike manage_agents, top-level) —
// hence a separate endpoint rather than folding into the agent one.
routes.get("/:agentId/automations/:automationId/pending/:runId", async (c) => {
	const { agentId, automationId } = c.req.param();
	const organizationId = c.get("organizationId") as string;
	const runId = Number(c.req.param("runId"));
	if (!Number.isInteger(runId) || runId <= 0) {
		return c.json({ error: "Invalid run id" }, 400);
	}

	const rows = await getDb()<{
		action: string | null;
		proposal: Record<string, unknown> | null;
		current: Record<string, unknown> | null;
		tool: string | null;
	}>`
		SELECT e.metadata->>'action' AS action,
		       e.metadata->'proposal' AS proposal,
		       e.metadata->'current' AS current,
		       e.metadata->>'tool' AS tool
		FROM runs r
		JOIN current_event_records e
		  ON e.run_id = r.id
		 AND e.interaction_type = 'approval'
		 AND e.interaction_status = 'pending'
		WHERE r.id = ${runId}
		  AND r.organization_id = ${organizationId}
		  AND r.run_type = 'internal'
		  AND r.approval_status = 'pending'
		ORDER BY e.id DESC
		LIMIT 1
	`;
	const row = rows[0];
	if (!row) return c.json({ error: "No pending proposal for this run" }, 404);

	// Scoped to manage_automations UPDATE: the automation edit form reviews a single
	// existing automation's config. create / create_from_version / set_reaction_script
	// aren't a single-form review (they keep the run-permalink path), so 404 here.
	const rawProposal = row.proposal ?? null;
	if (
		row.tool !== "manage_automations" ||
		row.action !== "update" ||
		!rawProposal ||
		typeof rawProposal !== "object"
	) {
		return c.json({ error: "No pending proposal for this run" }, 404);
	}

	// manage_automations proposal nests the target under `args`. The held proposal
	// must target the automation in the path, and its owning agent (args.managed_agent_id ??
	// current owner) must be the agent in the path. Don't leak cross-target/agent
	// existence — same 404 as "no pending proposal".
	const args = (rawProposal as { args?: Record<string, unknown> }).args ?? null;
	if (!args || typeof args !== "object") {
		return c.json({ error: "No pending proposal for this run" }, 404);
	}
	const targetAutomationId = args.automation_id ?? null;
	if (String(targetAutomationId) !== String(automationId)) {
		return c.json({ error: "No pending proposal for this run" }, 404);
	}
	const current = row.current ?? null;
	const ownerAgentId =
		(args.managed_agent_id as string | null | undefined) ??
		(current?.managed_agent_id as string | null | undefined) ??
		null;
	if (ownerAgentId !== agentId) {
		return c.json({ error: "No pending proposal for this run" }, 404);
	}

	// `proposedAfter` = the STORED values this update will write, computed by the
	// SAME normalizer the apply handler (handleUpdate) uses. The review renders
	// current→proposedAfter directly, so "displayed == applied" needs no coercion
	// knowledge on the client and can't drift from the handler.
	const proposedAfter = normalizeAutomationUpdatePatch(
		args as ManageAutomationsArgs
	);
	if (args.triggers !== undefined) {
		proposedAfter.triggers = resolveAutomationTriggerWrite({
			triggers: args.triggers as ManageAutomationsArgs["triggers"],
		}).triggers;
	}

	return c.json({
		runId,
		resourceKind: "automation" as const,
		action: row.action,
		proposal: rawProposal,
		current,
		proposedAfter,
	});
});

// ── Recent guardrail trips ───────────────────────────────────────────────────
//
// Read-only audit feed for the agent's Guardrails tab. Each `guardrail-trip`
// event row is one stage a guardrail short-circuited (written by
// `recordGuardrailTrip`). The rows are append-only and never superseded, so we
// read `events` directly rather than the `current_event_records` view, which
// would force an expensive `event_embeddings` join. Org-scoped + Postgres-backed
// and therefore correct under N replicas (any pod can serve it).
routes.get("/:agentId/guardrail-trips", async (c) => {
	const { agentId } = c.req.param();
	const organizationId = c.get("organizationId") as string;

	// Clamp to a sane window — the UI asks for 50; cap so a hand-crafted query
	// can't ask for an unbounded scan.
	const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const limit = Number.isFinite(limitRaw)
		? Math.min(Math.max(limitRaw, 1), 200)
		: 50;

	// Optional narrowing to a single guardrail — the per-guardrail detail view
	// asks for just that guardrail's catches.
	const guardrail = c.req.query("guardrail");

	// Optional narrowing to one conversation — the chat view asks for just the
	// trips that fired during this conversation so it can flag the affected turn.
	const conversationId = c.req.query("conversationId");

	const sql = getDb();
	// `recordGuardrailTrip` writes `created_at` (default now()) but leaves
	// `occurred_at` null, so coalesce to `created_at` — otherwise the UI shows
	// "null" for the timestamp of every real trip.
	const rows = await sql`
    SELECT id, COALESCE(occurred_at, created_at) AS occurred_at, metadata
      FROM events
     WHERE organization_id = ${organizationId}
       AND semantic_type = 'guardrail-trip'
       AND metadata->>'agent_id' = ${agentId}
       ${guardrail ? sql`AND metadata->>'guardrail' = ${guardrail}` : sql``}
       ${conversationId ? sql`AND metadata->>'conversation_id' = ${conversationId}` : sql``}
     ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC
     LIMIT ${limit}
  `;

	const agentName = (await configStore.getMetadata(agentId))?.name;

	const trips = rows.map((row) => {
		const metadata = (row.metadata ?? {}) as {
			stage?: string;
			guardrail?: string;
			reason?: string | null;
			conversation_id?: string | null;
		};
		const occurredAt =
			row.occurred_at instanceof Date
				? row.occurred_at.toISOString()
				: row.occurred_at
					? String(row.occurred_at)
					: "";
		return {
			id: Number(row.id),
			occurredAt,
			agentId,
			...(agentName ? { agentName } : {}),
			stage: metadata.stage,
			guardrailName: metadata.guardrail,
			...(metadata.reason ? { reason: metadata.reason } : {}),
			...(metadata.conversation_id
				? { conversationId: metadata.conversation_id }
				: {}),
		};
	});

	return c.json({ trips });
});

// ── Judge model default (for custom guardrail authoring) ─────────────────────
//
// Custom guardrails are LLM judges. There is no deployment-wide judge model:
// a guardrail names its own, else the org's default provider model applies.
// The create/edit UI uses this to either show that default (model optional) or
// require a per-guardrail model (when the org has none). Returns null when the
// org has no default model.
routes.get("/:agentId/guardrail-judge-default", async (c) => {
	const orgId = c.get("organizationId") as string;
	return c.json({
		defaultModel: (await getOrgDefaultModel(orgId).catch(() => null)) || null,
	});
});

// ── Update agent config (settings) ───────────────────────────────────────────

routes.patch("/:agentId/config", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const { agentId } = c.req.param();
	const updates = await c.req.json();

	if (!(await configStore.hasAgent(agentId))) {
		return c.json({ error: "Agent not found" }, 404);
	}

  return getDb().begin(async (tx) => {
    const orgId = c.get("organizationId") as string;
    await lockOrganizationForRelationshipClaims(tx, orgId);
    const locked = await tx`SELECT id FROM agents WHERE organization_id = ${orgId} AND id = ${agentId} FOR UPDATE`;
    if (!locked.length) return c.json({ error: "Agent not found" }, 404);
    const transactionStore = createPostgresAgentConfigStore(tx);
    const before = await transactionStore.getSettings(agentId);
    const validationError = await validateAgentSettingsUpdate(updates, before, orgId, agentId);
    if (validationError) {
      if ("modelError" in validationError) {
        return c.json(modelValidationResponse(validationError.modelError, { c, agentId }), 400);
      }
      return c.json(validationError, validationError.error === "models_validation_failed" ? 503 : 400);
    }

	// Auth profiles aren't part of the agent settings row — they're
	// user-scoped and live in `user_auth_profiles` with secrets in the secret
	// store. Pull them out of the settings patch and persist them through the
	// proper path; otherwise an api-key typed into the UI is silently dropped.
	const { authProfiles, ...settingsUpdates } = updates as {
		authProfiles?: AuthProfile[];
	} & Record<string, unknown>;

	// Atomic cutover: the legacy model fields are GONE. An old client (pre-PR4
	// CLI, stale web build) that still sends them would have its restricted
	// declaration silently dropped to `models = NULL` = allow-all — a silent
	// access widening. Reject loudly so the operator upgrades instead.
	for (const legacyField of LEGACY_MODEL_FIELDS) {
		if (legacyField in settingsUpdates) {
			return c.json(
				{
					error: "legacy_model_field",
					error_description: `This server no longer accepts "${legacyField}". The agent's model configuration is now a single ordered "models" list of explicit "<provider>/<model>" refs. Upgrade your client (CLI / web) and send "models" instead.`,
					field: legacyField,
				},
				400
			);
		}
	}

	if (Array.isArray(authProfiles)) {
		const user = c.get("user");
		if (!user?.id) {
			// Admin-PAT callers (`lobu apply`) manage declared-agent credentials
			// out of band; reject only if they actually tried to set one here.
			if (hasFreshCredential(authProfiles)) {
				return c.json(
					{ error: "Setting agent auth profiles requires a web session" },
					403
				);
			}
		} else {
			try {
				await reconcileAgentAuthProfiles(agentId, user.id, authProfiles);
			} catch (error) {
				return c.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Failed to persist auth profiles",
					},
					503
				);
			}
		}
	}

  await persistAgentSettingsPatch(tx, agentId, settingsUpdates, before, {
    organizationId: orgId,
    ...getApplyContext(c),
  });
	return c.json({ success: true });
  });
});

// ============================================================
// ── Inference providers (org-owned per-modality custom upstreams) ─────────────
//
// Org-scoped credential rows in `inference_providers` (slug-referenced by
// agents). ONE api key per row; a row with any custom base_url is
// org-key-only across every modality. `capabilities` is per-modality config
// `{ "<modality>": { base_url?, model?, models_endpoint? } }`. The org comes
// from the router-level orgContext middleware (`c.get('organizationId')`); the
// `:agentId`-free paths keep these purely org-scoped. Reads use `mcpAuth`
// alone; mutations require the session/admin-PAT gate.

function requireOrgId(c: any): string | Response {
	const orgId = c.get("organizationId") as string | undefined;
	if (!orgId)
		return c.json({ error: "Organization context not available" }, 500);
	return orgId;
}

export { routes as agentRoutes };
