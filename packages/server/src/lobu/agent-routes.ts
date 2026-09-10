/**
 * Agent CRUD routes for the embedded Lobu gateway.
 *
 * All routes are org-scoped via mcpAuth middleware and orgContext.
 */

import {
	type AgentInlineGuardrail,
	type AuthProfile,
	isSdkCompat,
} from "@lobu/core";
import { SkillsConfigSchema } from "@lobu/core/contracts/agent-settings";
import {
	type ManageAutomationsArgs,
	normalizeAutomationUpdatePatch,
} from "@lobu/core/contracts/tools/manage-automations";
import { Value } from "@sinclair/typebox/value";
import { Hono } from "hono";
import { mcpAuth } from "../auth/middleware";
import { resolveNewAgentProvisioningDefaults } from "../auth/system-provider-resolution";
import { resolveAutomationTriggerWrite } from "../automations/triggers";
import { getDb } from "../db/client";
import { grantStrategyFor } from "../gateway/auth/oauth/grant-strategy";
import {
	getOAuthProviderConfig,
	getOAuthProviderConfigs,
	type OAuthProviderConfig,
} from "../gateway/auth/oauth/providers";
import { buildProviderCatalog } from "../gateway/auth/provider-catalog";
import { resolveSystemJudgeTarget } from "../gateway/inference/system-judge-target";
import {
	egressGuardrailsToPolicyBundle,
	findSuppressedJudgedDomains,
} from "../gateway/permissions/policy-store";
import { isUnrestrictedMode } from "@lobu/connector-sdk/egress-policy";
import { loadAllowedDomains } from "../gateway/config/network-allowlist";
import { createAuthProfileLabel } from "../gateway/auth/settings/auth-profiles-manager";
import { orgBucketAgentId } from "../gateway/auth/settings/user-auth-profile-store";
import { validateModelRefsAgainstOrg } from "./model-config";
import {
	ProviderRegistryService,
	resolveProviderRegistryPath,
} from "../gateway/services/provider-registry-service";
import type { Env } from "../index";
import { promoteEvalCase, setEvalCaseJudgeModel } from "../runs/eval-cases";
import { readEvalResults, runEvalSuite } from "../runs/eval-suite";
import { getApplyContext } from "../utils/apply-context";
import { recordConfigChangeEvent } from "../utils/insert-event";
import logger from "../utils/logger";
import { generateCodeVerifier } from "../utils/pkce";
import { countRuntimeMessagingClientsByAgent } from "./client-routes";
import { getLobuCoreServices } from "./gateway";
import { orgContext } from "./stores/org-context";
import {
	AGENT_ID_PATTERN,
	createPostgresAgentConfigStore,
} from "./stores/postgres-stores";
import {
	createInferenceProvider,
	ensureOAuthInferenceProvider,
	type InferenceCapabilities,
	type InferenceCapabilityBlock,
	isInferenceModality,
	isValidInferenceProviderSlug,
	listInferenceProviders,
	rotateInferenceProviderKey,
	setInferenceProviderDefault,
	softDeleteInferenceProvider,
	updateInferenceProviderCapabilities,
	updateInferenceProviderCoreFields,
	validateCapabilityBlock,
} from "./stores/provider-secrets";

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

export async function validateModelsUpdate(params: {
	models: unknown;
	organizationId: string;
	agentId: string;
	c: any;
}): Promise<Record<string, unknown> | null> {
	// The shape/slug validation is shared with the MCP `manage_agents` path via
	// the context-free core; this wrapper only maps the structured error onto the
	// route's JSON envelope and enriches the not-connected case with request-
	// derived proxy/settings URLs (which need the Hono context).
	const error = await validateModelRefsAgainstOrg(
		params.models,
		params.organizationId
	);
	if (!error) return null;
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
 * owner's stale admin token stays denied. The eval routes
 * (`POST /evals/cases`, `POST /automations/:automationId/evals/run`) are out
 * of this gate's scope: they keep the weaker session-or-admin-PAT tier, so a
 * plain member can still run them. So are the deployment routes, whose POST
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
 * binding `recordConfigChangeEvent` (fire-and-forget, redacts internally) to
 * the request's apply/actor context.
 */
function emitConfigChange(
	c: any,
	params: {
		resourceKind: Parameters<typeof recordConfigChangeEvent>[0]["resourceKind"];
		resourceId: string | number;
		op: "created" | "updated" | "deleted";
		summary: string;
		state: Record<string, unknown> | null;
		changedFields?: string[];
	}
): void {
	const applyCtx = getApplyContext(c);
	recordConfigChangeEvent({
		organizationId: c.get("organizationId") as string,
		...params,
		applyId: applyCtx.applyId,
		actorSource: applyCtx.actorSource,
		createdBy: applyCtx.createdBy,
		clientId: applyCtx.clientId,
	});
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

	// Atomic create + auto-inject. Two concurrent `lobu apply` runs from the
	// same operator can both reach this endpoint with the same agentId. The
	// previous version did INSERT-then-saveSettings as two separate writes:
	// a "loser" returning 200 in the idempotent branch could see the row
	// before the winner's saveSettings landed, then immediately PATCH it with
	// operator config — only for the winner's deferred saveSettings to clobber
	// it moments later. Folding `pre_approved_tools` into the same INSERT
	// statement closes that gap: the row + auto-injected pre-approvals land
	// atomically and the loser's idempotent 200 already reflects
	// fully-initialized state. The `lobu-memory` MCP server itself is no longer
	// stored per-agent — it's derived at worker startup by McpConfigService.
	const sql = getDb();
	const now = new Date();
	// Fresh-agent provisioning defaults from the shared helper — the SAME source
	// the boot provisioning paths and the manage_agents create tool use. `models`
	// is baked in here because the run path's org-default tail reads an
	// `inference_providers` row that environment API keys never create; an agent
	// left model-less on an env-key-only deployment resolves no model at all.
	const provisioning = await resolveNewAgentProvisioningDefaults(orgId);
	const inserted = await sql`
    INSERT INTO agents (
      id, organization_id, name, description, owner_platform, owner_user_id,
      models, pre_approved_tools, created_at, updated_at
    )
    VALUES (
      ${agentId}, ${orgId}, ${name}, ${description ?? null},
      'lobu', ${user.id},
      ${sql.json(provisioning.models)},
      ${sql.json(provisioning.preApprovedTools)}, ${now}, ${now}
    )
    ON CONFLICT (organization_id, id) DO NOTHING
    RETURNING id
  `;

	if (inserted.length === 0) {
		// Another writer (or a previous apply cycle) already owns this id in
		// *this* org. Return idempotent 200 with the existing row's metadata.
		// Cross-org collisions are no longer possible — the PK is per-org now.
		const existing = await configStore.getMetadata(agentId);
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

	emitConfigChange(c, {
		resourceKind: "agent",
		resourceId: agentId,
		op: "created",
		summary: `Agent '${name}' created`,
		state: { agentId, name, description: description ?? null },
	});

	return c.json({ agentId, name, description }, 201);
});

// ── Org-scoped inference-provider routes ─────────────────────────────────────
// Registered BEFORE any `/:agentId` route so these literal paths win the match
// (Hono would otherwise treat 'inference-providers' as an :agentId → 404).
// Helpers (requireOrgId, validateCapabilitiesMap) are hoisted fn declarations
// defined lower in this file.

routes.get("/inference-providers", async (c) => {
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	await ensureVisibleOAuthProvidersForUser(c, orgId);
	const providers = await listInferenceProviders(orgId);
	return c.json({ providers });
});

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

async function ensureVisibleOAuthProvidersForUser(
	c: any,
	orgId: string
): Promise<void> {
	const user = c.get("user") as { id: string } | undefined;
	if (!user?.id) return;
	const authProfilesManager = getLobuCoreServices()?.getAuthProfilesManager?.();
	if (!authProfilesManager) return;

	for (const config of Object.values(getOAuthProviderConfigs())) {
		const profiles = await orgContext.run({ organizationId: orgId }, () =>
			authProfilesManager.getProviderProfiles(
				orgBucketAgentId(orgId),
				config.id,
				user.id
			)
		);
		if (profiles.length === 0) continue;
		await ensureOAuthInferenceProvider({
			organizationId: orgId,
			slug: config.id,
			kind: config.id,
			displayName: config.name,
			defaultModel: config.defaultModel,
			createdBy: user.id,
		});
	}
}

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
		});

		const provider = await ensureOAuthInferenceProvider({
			organizationId: orgId,
			slug: config.id,
			kind: config.id,
			displayName: config.name,
			defaultModel: config.defaultModel,
			createdBy: user.id,
		});
		emitConfigChange(c, {
			resourceKind: "inference-provider",
			resourceId: provider.slug,
			op: "created",
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

routes.post("/inference-providers", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;

	let body: {
		slug?: unknown;
		kind?: unknown;
		displayName?: unknown;
		apiKey?: unknown;
		capabilities?: unknown;
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}

	const slug = typeof body.slug === "string" ? body.slug.trim() : "";
	const kind = typeof body.kind === "string" ? body.kind.trim() : "";
	const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
	if (!slug) return c.json({ error: "Body must include a `slug` string" }, 400);
	if (!isValidInferenceProviderSlug(slug)) {
		return c.json(
			{
				error:
					"`slug` must be lowercase alphanumeric + hyphen, 1-63 chars, no leading/trailing hyphen",
			},
			400
		);
	}
	if (!kind) return c.json({ error: "Body must include a `kind` string" }, 400);
	if (!apiKey) {
		return c.json(
			{ error: "Body must include a non-empty `apiKey` string" },
			400
		);
	}
	const capErr = validateCapabilitiesMap(body.capabilities);
	if (capErr) return c.json({ error: capErr }, 400);

	// Known catalog kinds must accept API keys AND speak a routable wire
	// protocol — a subscription kind can speak one and still have nothing an API
	// key may reach. Unknown kinds pass because custom endpoints are synthesized
	// as OpenAI-compatible providers. Read the default from configs because the
	// catalog contains only provider modules registered in this process.
	let catalogDefaultModel: string | undefined;
	// The upstream this `kind` already resolves to. An alias row (slug !== kind)
	// with no base_url of its own is synthesized against it, so its presence is
	// what decides whether such a row will route.
	let catalogBaseUrl: string | undefined;
	try {
		const registry = new ProviderRegistryService(resolveProviderRegistryPath());
		const configs = await registry.getProviderConfigs();
		const catalog = buildProviderCatalog(configs);
		const entry = catalog.find((e) => e.slug === kind);
		if (
			entry &&
			(!entry.supportedAuthTypes.includes("api-key") ||
				!isSdkCompat(entry.sdkCompat))
		) {
			return c.json(
				{
					error: `Provider '${kind}' can't be added with an API key — it signs in instead.`,
				},
				400
			);
		}
		catalogDefaultModel = configs[kind]?.defaultModel ?? undefined;
		// The EXACT expression `getModelPolicy` evaluates — argless
		// `buildProviderCatalog()`, then the same auth-method and `sdkCompat`
		// gates. These two must agree: a text model is what
		// `promoteOldestRunnableProvider` keys on, so a row seeded as routable and
		// then dropped at routing becomes the org DEFAULT and breaks every
		// allow-all agent in the org.
		//
		// `configs[kind].upstreamBaseUrl` looks equivalent and is not. It gives
		// `claude` a URL, but claude registers as an OAuth module rather than an
		// ApiKeyProviderModule, so the catalog reports "" and synthesis refuses
		// it — trusting providers.json would seed exactly that unroutable row.
		const catalogEntry = buildProviderCatalog().find((e) => e.slug === kind);
		catalogBaseUrl =
			catalogEntry?.supportedAuthTypes.includes("api-key") &&
			isSdkCompat(catalogEntry.sdkCompat)
				? catalogEntry.baseUrl || undefined
				: undefined;
	} catch (err) {
		// Fail open on catalog-load errors: don't block creation on a metadata
		// read. The synthesize path still gates routing downstream.
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"[inference-providers POST] catalog gate check failed; allowing"
		);
	}

	const createdBy = c.get("user")?.id ?? null;

	// Seed the curated model so each API caller need not duplicate catalog
	// defaults — and so a row cannot be born unroutable.
	//
	// `resolveInferenceProviderConfig` selects `capabilities -> <modality>` and
	// returns null when the block is absent, so `resolveUrlInvariant` answers
	// `no-custom-upstream` and the row's own org key is NEVER read. With no
	// deployment env key that resolves to no credential at all: the provider is
	// dropped from routing and the model goes upstream with its slug prefix
	// intact, surfacing as an opaque "400 invalid model ID".
	//
	// Merge into the caller's text block rather than replacing it — dropping a
	// tenant `base_url` would silently re-point the org at the catalog URL.
	//
	// Seed ONLY a row that will actually route. A text model is also the
	// predicate `promoteOldestRunnableProvider` uses to choose the org default,
	// so seeding an unroutable row would promote it to default and break every
	// allow-all agent in the org. `getModelPolicy` keys its module map by the
	// row's SLUG, so the row resolves to a module only when one of:
	//   - slug === kind    → the catalog's own static module answers to it,
	//   - a text base_url  → `synthesizeOrgProviderModule` routes there, or
	//   - the kind has a catalog upstream → synthesis falls back to it, which is
	//     what makes an alias slug (slug=my-gemini, kind=gemini) routable.
	// Only a kind the catalog does not know at all matches none of these; such a
	// row is dropped by the policy and must not look configured.
	const requestedCapabilities =
		(body.capabilities as InferenceCapabilities) ?? {};
	const hasTextModel = !!requestedCapabilities.text?.model?.trim();
	const wouldRoute =
		slug === kind ||
		!!requestedCapabilities.text?.base_url?.trim() ||
		!!catalogBaseUrl;
	const capabilities =
		hasTextModel || !catalogDefaultModel || !wouldRoute
			? requestedCapabilities
			: {
					...requestedCapabilities,
					text: {
						...requestedCapabilities.text,
						model: catalogDefaultModel,
					},
				};
	if (!capabilities.text?.model) {
		// Nothing seeded: unknown kind, no catalog default, or a kind with no
		// upstream to fall back to. Say so at creation — otherwise the row's only
		// symptom is a far-away 400 naming a different provider.
		logger.warn(
			{ slug, kind, wouldRoute },
			"[inference-providers POST] created with no text model — this provider will not route until `capabilities.text.model` is set (a row whose `kind` is not in the catalog also needs `capabilities.text.base_url`)"
		);
	}

	const result = await createInferenceProvider({
		organizationId: orgId,
		slug,
		kind,
		displayName: typeof body.displayName === "string" ? body.displayName : null,
		apiKey,
		capabilities,
		createdBy,
	});
	if ("error" in result) {
		return c.json(
			{ error: `A provider with slug '${result.slug}' already exists` },
			409
		);
	}
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: result.slug,
		op: "created",
		summary: `Inference provider '${result.slug}' created`,
		state: {
			slug: result.slug,
			kind: result.kind,
			displayName: result.displayName,
			capabilities: result.capabilities,
			hasCustomUpstream: result.hasCustomUpstream,
			status: result.status,
			isDefault: result.isDefault,
		},
	});

	// Never echo the key or the api_key_ref back to the caller.
	// `isDefault` is load-bearing: the first runnable provider is auto-promoted,
	// so a caller cannot infer it from its own request.
	return c.json(
		{
			provider: {
				id: result.id,
				slug: result.slug,
				kind: result.kind,
				displayName: result.displayName,
				capabilities: result.capabilities,
				hasCustomUpstream: result.hasCustomUpstream,
				status: result.status,
				createdAt: result.createdAt,
				isDefault: result.isDefault,
			},
		},
		201
	);
});

// Edit a provider's core fields. Only displayName is mutable — slug (agents
// reference it) and kind (catalog linkage) are immutable. Key rotation and
// per-modality capability edits keep their dedicated routes below; the Edit UI
// calls whichever it needs.
routes.put("/inference-providers/:slug", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	const { slug } = c.req.param();

	let body: { displayName?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}

	// Empty / whitespace-only name means "leave unchanged" (pass undefined).
	const rawName = typeof body.displayName === "string" ? body.displayName : "";
	const displayName = rawName.trim() ? rawName.trim() : undefined;

	const updated = await updateInferenceProviderCoreFields(orgId, slug, {
		displayName,
	});
	if (!updated) return c.json({ error: "Provider not found" }, 404);
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: updated.slug,
		op: "updated",
		summary: `Inference provider '${updated.slug}' renamed`,
		state: {
			slug: updated.slug,
			kind: updated.kind,
			displayName: updated.displayName,
			capabilities: updated.capabilities,
			hasCustomUpstream: updated.hasCustomUpstream,
			status: updated.status,
		},
		changedFields: ["displayName"],
	});
	return c.json({
		provider: {
			id: updated.id,
			slug: updated.slug,
			kind: updated.kind,
			displayName: updated.displayName,
			capabilities: updated.capabilities,
			hasCustomUpstream: updated.hasCustomUpstream,
			status: updated.status,
			createdAt: updated.createdAt,
		},
	});
});

// Mark one org inference provider as THE org default. Its `capabilities.text.model`
// becomes the org-default model — the tail of the layered fallback
// (automation → agent → org default). Exactly one live default per org (enforced
// by a partial unique index); setting a new one clears the prior in one txn.
routes.put("/inference-providers/:slug/default", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	const { slug } = c.req.param();

	const result = await setInferenceProviderDefault(orgId, slug);
	if (result === "not_found") {
		return c.json({ error: "Provider not found" }, 404);
	}
	// Both rejections mean "this row cannot hold the org default", but for
	// different reasons — and the fix differs, so the message must too.
	if (result === "no_text_model") {
		return c.json(
			{
				error:
					`Provider '${slug}' has no text model configured, so it cannot be ` +
					`the org default. Set one with: lobu providers set-capability ` +
					`${slug} text --model <model>`,
			},
			400
		);
	}
	if (result === "oauth_provider") {
		return c.json(
			{
				error:
					`Provider '${slug}' is signed in with OAuth, so its credential ` +
					`belongs to one user. An org default is inherited by every member ` +
					`and by headless Automation runs, which cannot read that token. Use ` +
					`a provider added with an API key instead.`,
			},
			400
		);
	}
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: slug,
		op: "updated",
		summary: `Inference provider '${slug}' set as org default`,
		state: { slug, isDefault: true },
		changedFields: ["isDefault"],
	});
	return c.json({ success: true, slug, isDefault: true });
});

routes.put("/inference-providers/:slug/capabilities/:modality", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	const { slug, modality } = c.req.param();

	if (!isInferenceModality(modality)) {
		return c.json(
			{ error: "modality must be one of: text, image, stt, tts" },
			400
		);
	}

	let body: { block?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}
	const block = body.block;
	const err = validateCapabilityBlock(modality, block);
	if (err) return c.json({ error: err }, 400);

	const updated = await updateInferenceProviderCapabilities(
		orgId,
		slug,
		modality,
		block as InferenceCapabilityBlock
	);
	if (!updated) return c.json({ error: "Provider not found" }, 404);
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: updated.slug,
		op: "updated",
		summary: `Inference provider '${updated.slug}' ${modality} capabilities updated`,
		state: {
			slug: updated.slug,
			kind: updated.kind,
			displayName: updated.displayName,
			capabilities: updated.capabilities,
			hasCustomUpstream: updated.hasCustomUpstream,
			status: updated.status,
		},
		changedFields: [`capabilities.${modality}`],
	});
	return c.json({
		provider: {
			id: updated.id,
			slug: updated.slug,
			kind: updated.kind,
			displayName: updated.displayName,
			capabilities: updated.capabilities,
			hasCustomUpstream: updated.hasCustomUpstream,
			status: updated.status,
			createdAt: updated.createdAt,
		},
	});
});

routes.put("/inference-providers/:slug/key", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	const { slug } = c.req.param();

	let body: { value?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}
	const value = typeof body.value === "string" ? body.value.trim() : "";
	if (!value) {
		return c.json(
			{ error: "Body must include a non-empty `value` string" },
			400
		);
	}

	const outcome = await rotateInferenceProviderKey(orgId, slug, value);
	if (outcome === "not_found") {
		return c.json({ error: "Provider not found" }, 404);
	}
	if (outcome === "oauth_provider") {
		return c.json(
			{
				error: `Provider '${slug}' signs in via OAuth — it has no API key to rotate`,
			},
			400
		);
	}
	// Metadata-only: key rotations are audited but the value is never snapshotted.
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: slug,
		op: "updated",
		summary: `Inference provider '${slug}' API key rotated`,
		state: null,
		changedFields: ["apiKey"],
	});
	return c.json({ success: true });
});

routes.delete("/inference-providers/:slug", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;
	const { slug } = c.req.param();

	const ok = await softDeleteInferenceProvider(orgId, slug);
	if (!ok) return c.json({ error: "Provider not found" }, 404);
	const user = c.get("user") as { id: string } | undefined;
	const oauthConfig = getOAuthProviderConfig(slug);
	const authProfilesManager = getLobuCoreServices()?.getAuthProfilesManager?.();
	// Only an interactive user can revoke their org-bucket OAuth profile. Admin
	// PAT callers may tombstone the visible row, but must not delete another
	// user's subscription credential.
	if (user?.id && oauthConfig && authProfilesManager) {
		await orgContext.run({ organizationId: orgId }, () =>
			authProfilesManager.deleteProviderProfiles(
				orgBucketAgentId(orgId),
				oauthConfig.id,
				{ userId: user.id }
			)
		);
	}
	emitConfigChange(c, {
		resourceKind: "inference-provider",
		resourceId: slug,
		op: "deleted",
		summary: `Inference provider '${slug}' deleted`,
		state: null,
	});
	return c.json({ success: true });
});

// ── Evals ────────────────────────────────────────────────────────────────────
// Registered with the other literal-prefix routes, ahead of the `/:agentId`
// block below, so a future `/:agentId/...` route of the same shape can never
// shadow them.
//
// This is the surface the eval program was missing. `promoteEvalCase` and
// `replayEvalCase` shipped in #2584 with NO caller anywhere outside their own
// module — the whole flow was unreachable, so nothing could promote a case and
// nothing could read a result. Scores with no way to ask for them are not a
// feature.

/**
 * Promote a real Automation run into a reusable eval case.
 *
 * `expectation` is what the judge grades against; without one a case is still
 * useful (the code metrics run) but nothing measures whether the OUTPUT was
 * right. `judgeModel` is the per-case override — name a model different from
 * the one under eval to avoid a model grading its own work.
 */
routes.post("/evals/cases", async (c) => {
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;

	const body = (await c.req.json().catch(() => ({}))) as {
		runId?: unknown;
		caseKey?: unknown;
		expectation?: unknown;
		judgeModel?: unknown;
	};
	const runId = Number(body.runId);
	if (!Number.isSafeInteger(runId) || runId < 1) {
		return c.json({ error: "runId is required" }, 400);
	}

	const result = await promoteEvalCase({
		sourceRunId: runId,
		caseKey: typeof body.caseKey === "string" ? body.caseKey : "default",
		expectation:
			typeof body.expectation === "string" ? body.expectation : undefined,
		createdBy: (c.get("user") as { id?: string } | undefined)?.id ?? null,
		// Promote resolves the org from the RUN, so this is what stops a caller
		// creating a case inside another tenant's workspace by run id. It has to
		// be checked BEFORE the write, not after — see `promoteEvalCase`.
		organizationId: orgId,
	});

	if (!result.ok) {
		// `not_found` is the only 404 here — it also covers a run belonging to
		// another org. The other rejections mean the run exists but cannot be
		// replayed, which is a 422: the caller asked for something coherent that
		// this run cannot support.
		const status = result.reason === "not_found" ? 404 : 422;
		return c.json({ error: result.reason }, status);
	}

	if (typeof body.judgeModel === "string" && body.judgeModel.trim()) {
		await setEvalCaseJudgeModel(
			result.evalCase.entityId,
			orgId,
			body.judgeModel.trim(),
		);
	}

	return c.json(
		{
			case: {
				...result.evalCase,
				judgeModel:
					typeof body.judgeModel === "string" ? body.judgeModel.trim() : null,
			},
			created: result.created,
		},
		201,
	);
});

/**
 * Replay an Automation's active case suite under capture mode.
 *
 * Defaults to several trials per case because a single run is not a
 * measurement — our own research evals swung ±1 task on identical batteries.
 */
routes.post("/automations/:automationId/evals/run", async (c) => {
	// Admin-tier: each call queues up to cases × trials replays, and every one
	// of them spends inference budget.
	const denied = requireSessionOrAdminPat(c);
	if (denied) return denied;
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;

	const automationId = Number(c.req.param("automationId"));
	if (!Number.isSafeInteger(automationId) || automationId < 1) {
		return c.json({ error: "automationId must be a number" }, 400);
	}

	const body = (await c.req.json().catch(() => ({}))) as {
		caseIds?: unknown;
		trials?: unknown;
	};
	const caseIds = Array.isArray(body.caseIds)
		? body.caseIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
		: undefined;

	const result = await runEvalSuite({
		organizationId: orgId,
		automationId,
		caseIds: caseIds?.length ? caseIds : undefined,
		trials: typeof body.trials === "number" ? body.trials : undefined,
	});
	return c.json(result, 202);
});

/**
 * Read the suite's answer: per case latest vs previous, and which cases moved
 * by more than their own noise.
 *
 * Reads case ENTITIES only. Never aggregates `eval_score` events — the scorer
 * materializes each case's rolling window at write time precisely so this stays
 * a bounded config-table read.
 */
routes.get("/automations/:automationId/evals/results", async (c) => {
	const orgId = requireOrgId(c);
	if (typeof orgId !== "string") return orgId;

	const automationId = Number(c.req.param("automationId"));
	if (!Number.isSafeInteger(automationId) || automationId < 1) {
		return c.json({ error: "automationId must be a number" }, 400);
	}

	const trialsParam = Number(c.req.query("trials"));
	const results = await readEvalResults({
		organizationId: orgId,
		automationId,
		trials: Number.isFinite(trialsParam) ? trialsParam : undefined,
	});
	return c.json(results);
});

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

	await configStore.updateMetadata(agentId, body);
	// Snapshot the row as stored (post-merge), not the request body.
	const metadata = await configStore.getMetadata(agentId);
	emitConfigChange(c, {
		resourceKind: "agent",
		resourceId: agentId,
		op: "updated",
		summary: `Agent '${metadata?.name ?? agentId}' metadata updated`,
		state: metadata ? { ...metadata, agentId } : null,
		changedFields: Object.keys(body),
	});
	return c.json({ success: true });
});

// ── Delete agent ─────────────────────────────────────────────────────────────

routes.delete("/:agentId", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const { agentId } = c.req.param();

	if (!(await configStore.hasAgent(agentId))) {
		return c.json({ error: "Agent not found" }, 404);
	}

	// Cascade handled by FK ON DELETE CASCADE
	await configStore.deleteMetadata(agentId);
	emitConfigChange(c, {
		resourceKind: "agent",
		resourceId: agentId,
		op: "deleted",
		summary: `Agent '${agentId}' deleted`,
		state: null,
	});
	return c.json({ success: true });
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
// Custom guardrails are LLM judges. There is no hardcoded judge model: the
// operator sets one via `EGRESS_JUDGE_MODEL`. The create/edit UI uses this to
// either show the configured default (model optional) or require a per-guardrail
// model (when unset). Returns null when no gateway default is configured.
routes.get("/:agentId/guardrail-judge-default", async (c) => {
	return c.json({
		defaultModel: process.env.EGRESS_JUDGE_MODEL?.trim() || null,
	});
});

// ── Update agent config (settings) ───────────────────────────────────────────

const GUARDRAIL_STAGES = new Set(["input", "output", "pre-tool", "egress"]);

/**
 * Validate a `guardrailsInline` payload before it is persisted to agent
 * settings. Returns a human-readable error string on the first invalid entry,
 * or `null` when the payload is absent or fully valid. Persisting an entry with
 * an invalid `stage` would crash the guardrail aggregator at message time, so
 * we reject malformed input at the write boundary instead.
 */
export function validateGuardrailsInline(value: unknown): string | null {
	if (value === undefined) return null;
	if (!Array.isArray(value)) return "guardrailsInline must be an array";
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		if (typeof entry !== "object" || entry === null) {
			return `guardrailsInline[${i}] must be an object`;
		}
		const g = entry as Record<string, unknown>;
		if (typeof g.name !== "string" || g.name.trim() === "") {
			return `guardrailsInline[${i}].name must be a non-empty string`;
		}
		if (typeof g.enabled !== "boolean") {
			return `guardrailsInline[${i}].enabled must be a boolean`;
		}
		if (typeof g.stage !== "string" || !GUARDRAIL_STAGES.has(g.stage)) {
			return `guardrailsInline[${i}].stage must be one of: input, output, pre-tool, egress`;
		}
		// Only `undefined` defaults to "judge" (backward compatible with rows
		// written before `kind` existed). `null` is not a valid value in the
		// Core `AgentInlineGuardrailSchema`, so reject it rather than coercing.
		if (
			g.kind !== undefined &&
			g.kind !== "judge" &&
			g.kind !== "require-tool"
		) {
			return `guardrailsInline[${i}].kind must be "judge" or "require-tool"`;
		}
		const kind = g.kind === undefined ? "judge" : g.kind;
		// Common optional fields are typed the same way for every kind in the
		// Core schema, so validate them whenever present regardless of kind.
		// Otherwise a malformed `require-tool` row (e.g. `model: 42`) would be
		// persisted here yet rejected by `AgentInlineGuardrailSchema`.
		if (g.model !== undefined && typeof g.model !== "string") {
			return `guardrailsInline[${i}].model must be a string`;
		}
		if (
			g.domains !== undefined &&
			(!Array.isArray(g.domains) ||
				g.domains.some((d) => typeof d !== "string"))
		) {
			return `guardrailsInline[${i}].domains must be an array of strings`;
		}
		if (kind === "require-tool") {
			if (g.stage !== "output") {
				return `guardrailsInline[${i}]: require-tool only supports stage "output"`;
			}
			if (
				!Array.isArray(g.tools) ||
				g.tools.length === 0 ||
				g.tools.some((t) => typeof t !== "string" || t.trim() === "")
			) {
				return `guardrailsInline[${i}].tools must be a non-empty array of tool names for require-tool`;
			}
			// `policy` is ignored for require-tool, but must still match the
			// schema's type when the operator supplies it.
			if (g.policy !== undefined && typeof g.policy !== "string") {
				return `guardrailsInline[${i}].policy must be a string`;
			}
		} else {
			// judge (default)
			if (typeof g.policy !== "string" || g.policy.trim() === "") {
				return `guardrailsInline[${i}].policy must be a non-empty string`;
			}
			if (
				g.tools !== undefined &&
				(!Array.isArray(g.tools) || g.tools.some((t) => typeof t !== "string"))
			) {
				return `guardrailsInline[${i}].tools must be an array of strings`;
			}
		}
	}
	return null;
}

/**
 * Write-boundary validation for `skillsConfig`, the sibling of
 * {@link validateGuardrailsInline}.
 *
 * The PATCH route spreads settings through untouched, so without this a
 * malformed payload persists and is then read back as a trusted `SkillConfig`.
 * Two concrete failures: a non-array `skills` throws at the first `.filter()`
 * downstream, and a non-boolean `enabled` diverges from the runtime, which
 * gates on truthiness (`s.enabled && …`) — so `"yes"` would enable a skill that
 * no write-time check ever saw as enabled.
 *
 * Checked against `SkillsConfigSchema` in core rather than a hand-rolled shape,
 * so the write boundary cannot drift from the type the readers rely on. The
 * schema is the only definition of a skill entry; it no longer carries
 * guardrails (those are operator-owned and live on `guardrailsInline`), so this
 * validates the current contract without reintroducing skill-declared ones.
 *
 * `Type.Object` admits unknown keys by design: rows written before a field was
 * dropped still round-trip through the editor's `_original` spread, and
 * rejecting them would fail a payload the server simply ignores.
 */
export function validateSkillsConfig(value: unknown): string | null {
	if (value === undefined) return null;
	if (Value.Check(SkillsConfigSchema, value)) return null;
	const first = Value.Errors(SkillsConfigSchema, value).First();
	if (!first) return "skillsConfig is invalid";
	return `skillsConfig${first.path}: ${first.message}`;
}

routes.patch("/:agentId/config", async (c) => {
	const denied = requireManageAgentAccess(c);
	if (denied) return denied;
	const { agentId } = c.req.param();
	const updates = await c.req.json();

	if (!(await configStore.hasAgent(agentId))) {
		return c.json({ error: "Agent not found" }, 404);
	}

	// Validate inline guardrail shape before it is persisted. An invalid `stage`
	// (or missing name/policy) would otherwise be written verbatim and then crash
	// the guardrail aggregator mid-message (it indexes `seen[stage]`).
	const guardrailError = validateGuardrailsInline(
		(updates as { guardrailsInline?: unknown }).guardrailsInline
	);
	if (guardrailError) {
		return c.json(
			{ error: "invalid_guardrail", error_description: guardrailError },
			400
		);
	}

	// Structural check on skillsConfig — the settings spread below persists it
	// verbatim, and the runtime reads it back as a trusted SkillConfig.
	const skillsConfigError = validateSkillsConfig(
		(updates as { skillsConfig?: unknown }).skillsConfig
	);
	if (skillsConfigError) {
		return c.json(
			{ error: "invalid_skills_config", error_description: skillsConfigError },
			400
		);
	}

	// Read once and reuse: both the judge-model grandfathering below and the
	// grant-shadowing check after it need the CURRENT settings, because a PATCH
	// may carry only one of `guardrailsInline` / `networkConfig`.
	const storedSettings = await configStore.getSettings(agentId);

	// Judge-kind custom guardrails need a model. With no gateway default
	// (`EGRESS_JUDGE_MODEL` unset), every judge entry must carry its own
	// `model` — otherwise it would fail closed at runtime with no model to call.
	// require-tool entries never call a model.
	const judgeDefault = process.env.EGRESS_JUDGE_MODEL?.trim();
	if (
		Array.isArray((updates as { guardrailsInline?: unknown }).guardrailsInline)
	) {
		const inline = (
			updates as {
				guardrailsInline: Array<{
					name?: string;
					model?: string;
					kind?: string;
				}>;
			}
		).guardrailsInline;
		if (!judgeDefault) {
			const missing = inline.find((g) => {
				if (g?.kind === "require-tool") return false;
				return typeof g?.model !== "string" || g.model.trim() === "";
			});
			if (missing) {
				return c.json(
					{
						error: "guardrail_model_required",
						error_description: `Custom guardrail "${missing.name ?? "(unnamed)"}" needs a model: the gateway has no default judge model (EGRESS_JUDGE_MODEL is unset).`,
					},
					400
				);
			}
		}

		// A judge model that cannot resolve is worse than a missing one: the
		// guardrail SAVES, then denies every request it covers at runtime with
		// only a log line to say why. Resolve it here, through the exact
		// function the judge uses, so write-time acceptance and runtime
		// resolution cannot drift. Applies whether or not a default exists —
		// an explicitly named bad model is bad either way.
		//
		// Only NEW or CHANGED models are checked. Rejecting an already-stored
		// value would lock the agent out of its own config: every PATCH carries
		// the full `guardrailsInline` array, so an agent holding a
		// now-unrunnable model could not be edited at all — not even to remove
		// the offending guardrail. Grandfathering the stored value keeps the
		// repair path open while still refusing to accept a new bad one.
		const storedModels = new Map<string, string>();
		const storedInline = (storedSettings as {
			guardrailsInline?: Array<{ name?: string; model?: string }>;
		} | null)?.guardrailsInline;
		if (Array.isArray(storedInline)) {
			for (const g of storedInline) {
				if (g?.name && typeof g.model === "string") {
					storedModels.set(g.name, g.model.trim());
				}
			}
		}

		for (const g of inline) {
			if (g?.kind === "require-tool") continue;
			const model = g?.model?.trim();
			if (!model) continue;
			if (g?.name && storedModels.get(g.name) === model) continue;
			const resolved = await resolveSystemJudgeTarget(model);
			if (!resolved.ok) {
				return c.json(
					{
						error: "guardrail_model_unresolvable",
						error_description: `Custom guardrail "${g?.name ?? "(unnamed)"}" names judge model "${model}", which this deployment cannot run: ${resolved.detail}. Use a "<provider>/<model>" ref whose provider has a system key and speaks the OpenAI-compatible protocol.`,
					},
					400
				);
			}
		}
	}

	// An allow grant BEATS the egress judge. `checkDomainAccess` (proxy/
	// http-proxy.ts) checks per-agent allow grants (step 4) before consulting
	// the judge (step 5), so a domain that is both judged and allow-granted
	// returns `source: "grant"` and its judge never runs. That failure is
	// invisible from the outside — the request succeeds, just for the wrong
	// reason — so refuse the config instead of saving a control that cannot fire.
	//
	// Validate the MERGE, not the patch: a PATCH may carry `guardrailsInline`
	// alone, `networkConfig` alone, or both, and the hole only exists in the
	// combination. Only run when the patch actually touches one of them, so an
	// unrelated edit to an agent that is already in this state still saves (and
	// so removing either side is always a valid repair).
	const touchesGuardrails = "guardrailsInline" in (updates as object);
	const touchesNetwork = "networkConfig" in (updates as object);
	if (touchesGuardrails || touchesNetwork) {
		const stored = storedSettings as {
			guardrailsInline?: AgentInlineGuardrail[];
			networkConfig?: { allowedDomains?: string[] };
		} | null;
		const effectiveGuardrails = touchesGuardrails
			? ((updates as { guardrailsInline?: AgentInlineGuardrail[] })
					.guardrailsInline ?? [])
			: (stored?.guardrailsInline ?? []);
		const effectiveAllowed = touchesNetwork
			? ((updates as { networkConfig?: { allowedDomains?: string[] } })
					.networkConfig?.allowedDomains ?? [])
			: (stored?.networkConfig?.allowedDomains ?? []);

		const shadowed = findSuppressedJudgedDomains(
			effectiveGuardrails,
			effectiveAllowed
		);
		if (shadowed[0]) {
			const { domain, judge, grant } = shadowed[0];
			return c.json(
				{
					error: "guardrail_domain_shadowed_by_grant",
					error_description: `Guardrail "${judge}" judges "${domain}", but this agent's networkConfig.allowedDomains grants "${grant}", which the proxy matches FIRST — the judge would never run. A judged domain must not be allow-listed: remove "${grant}" from allowedDomains (a judged domain is reachable through its judge, so it needs no grant), or drop "${domain}" from the guardrail.`,
				},
				400
			);
		}

		// The GLOBAL allowlist shadows judges the same way (`checkDomainAccess`
		// step 3), but it is `WORKER_ALLOWED_DOMAINS` — operator config the
		// tenant editing this agent cannot fix. Warn rather than reject, so
		// the signal reaches whoever can act on it without blocking a save
		// nobody in this request can make valid. Only consult the allowlist
		// when there is a judge to shadow: `loadAllowedDomains` logs on every
		// call in isolation mode.
		const judgedCount =
			egressGuardrailsToPolicyBundle(effectiveGuardrails)?.judgedDomains
				.length ?? 0;
		if (judgedCount > 0) {
			const globalAllowed = loadAllowedDomains();
			const unrestricted = isUnrestrictedMode(globalAllowed);
			// Unrestricted mode allows every host, so it shadows every judged
			// domain without any of them appearing in a list to match against.
			// The global matcher's `.suffix` also covers the root host, unlike a
			// per-agent grant.
			if (
				unrestricted ||
				findSuppressedJudgedDomains(effectiveGuardrails, globalAllowed, {
					wildcardCoversRoot: true,
				}).length > 0
			) {
				logger.warn(
					`[agent-config] agent "${agentId}" has egress judge guardrails whose domains are covered by WORKER_ALLOWED_DOMAINS${
						unrestricted ? " (unrestricted, '*')" : ""
					}. The global allowlist is matched before the judge, so those judges will not run.`
				);
			}
		}
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

	// ATOMICITY (#7): validate the `models` allow-list BEFORE mutating anything
	// else (auth profiles, settings row). A models-validation failure must leave
	// the PATCH a true no-op — reconciling auth profiles first and THEN 503-ing
	// on models would persist a credential change while claiming "nothing saved".
	if (settingsUpdates.models !== undefined) {
		const organizationId = c.get("organizationId") as string;
		let error: Record<string, unknown> | null;
		try {
			error = await validateModelsUpdate({
				models: settingsUpdates.models,
				organizationId,
				agentId,
				c,
			});
		} catch (err) {
			// FAIL CLOSED: the `models` list is an access gate, so a lookup/infra
			// failure while validating it must REJECT the write — never persist an
			// unvalidated allow-list (that could silently widen or misconfigure
			// access). Nothing has been mutated yet, so this is a true no-op.
			logger.warn(
				{ agentId, err },
				"Failed to validate models list before saving agent settings — rejecting"
			);
			return c.json(
				{
					error: "models_validation_failed",
					error_description:
						"Could not validate the models list against the organization's providers. No change was saved; please retry.",
				},
				503
			);
		}
		if (error) return c.json(error, 400);
		// Persist the trimmed refs, not the raw client payload.
		settingsUpdates.models = (settingsUpdates.models as string[]).map((m) =>
			m.trim()
		);
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

	await configStore.updateSettings(agentId, settingsUpdates);
	// Snapshot the merged settings row as stored (the store merges partial
	// patches server-side), so the audit state reflects what took effect.
	const merged = await configStore.getSettings(agentId);
	emitConfigChange(c, {
		resourceKind: "agent-settings",
		resourceId: agentId,
		op: "updated",
		summary: `Agent '${agentId}' settings updated`,
		state: merged ? { ...merged } : null,
		changedFields: Object.keys(settingsUpdates),
	});
	return c.json({ success: true });
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

/**
 * Validate a full `capabilities` map ({ modality: block, … }). Returns an
 * error string on the first invalid modality/block, or null when valid.
 */
function validateCapabilitiesMap(value: unknown): string | null {
	if (value === undefined) return null;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "capabilities must be an object";
	}
	for (const [modality, block] of Object.entries(value)) {
		const err = validateCapabilityBlock(modality, block);
		if (err) return err;
	}
	return null;
}

export { routes as agentRoutes };
