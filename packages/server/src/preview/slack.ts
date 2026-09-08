import { createHash, randomInt } from "node:crypto";
import { slugify } from "@lobu/core";
import type { Context } from "hono";
import { getDb } from "../db/client";
import { maybeSendSlackWorkspaceWelcome } from "../gateway/connections/slack-connection-coordinator";
import { parseJsonBody } from "../gateway/routes/shared/helpers";
import { SecretStoreRegistry } from "../gateway/secrets";
import { PostgresSecretStore } from "../lobu/stores/postgres-secret-store";
import type { Env } from "../index";
import { runtimeConnectionIdToSlug } from "../lobu/stores/connections-projection";
import { errorMessage } from "../utils/errors";
import logger from "../utils/logger";
import { getConfiguredPublicOrigin } from "../utils/public-origin";
import { requireOrgUser } from "../utils/require-org-user";
import { MANAGED_CHAT_PLATFORMS_SET } from "./managed-platforms";
import { AutomationSubscriptionService } from "../gateway/channels/automation-subscription-service";
import { canLinkChatOrganizations } from "../gateway/channels/chat-link-authorization";
import { formatChatCommand } from "../gateway/commands/command-spelling";

// Slack Preview lets people trying Lobu locally talk to their agent through the
// hosted "Lobu Developer" Slack workspace before they have their own bot token.
// There is no Slack-Preview-specific schema or transport:
//   * The link code lives in `oauth_states` (scope `slack-preview-claim`).
//   * The hosted "Lobu Developer" workspace is just an ordinary Slack
//     `connections` row (no env var, no relay service).
//   * `/lobu link <code>` in that workspace consumes the claim and writes a normal
//     message-created Automation trigger — so inbound messages
//     route through the exact same Chat SDK adapter path every other platform
//     connection uses.

// Slack DM channel ids start with `D`; the canonical binding key is `slack:<id>`.
const SLACK_PLATFORM = "slack";
const CLAIM_SCOPE = "slack-preview-claim";
const DEFAULT_TTL_MINUTES = 15;
const MAX_TTL_MINUTES = 60;
const SURFACES = new Set(["dm", "channel"]);

// Hosted preview bots — the platforms a `preview.<platform>` block / claim mint
// is allowed for (currently Slack and Telegram), and the default join links.
// Both Slack and Telegram route through the same Chat SDK adapter path.
const PREVIEW_PLATFORMS = MANAGED_CHAT_PLATFORMS_SET;
const PREVIEW_JOIN_DEFAULTS: Record<string, string> = {
	slack: "https://lobu.ai/slack",
	telegram: "https://t.me/lobuaibot",
};

type SurfaceType = "dm" | "channel";

// Slack and Google Chat expose a native `/lobu` wrapper; other chat platforms
// use bare command spellings.
function tryCommand(platform: string): string {
	return formatChatCommand(platform, "try");
}
function listCommand(platform: string): string {
	return formatChatCommand(platform, "agents");
}
function linkCommand(platform: string): string {
	return formatChatCommand(platform, "link");
}

interface ClaimPayload {
	organizationId: string;
	agentId: string;
	/** Unified chat connection this code may be redeemed through. Omitted only
	 * for the hosted cross-org preview bot flow used by `lobu run`. */
	connectionId?: number;
	/** Freeze installation ownership so moving it invalidates outstanding codes. */
	connectionOrganizationId?: string;
	createdBy: string | null;
	allowedSurfaces: SurfaceType[];
	createdAt: number;
}

function codeHash(code: string): string {
	return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}

// Uppercase letters + digits — readable, no ambiguous punctuation, and a fixed
// length (the old base64url-then-strip approach could yield < 6 chars when the
// random bytes happened to land on `-`/`_`).
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomCodeSuffix(): string {
	let out = "";
	for (let i = 0; i < 6; i++)
		out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
	return out;
}

function normalizeSurfaces(input: unknown): SurfaceType[] {
	if (!Array.isArray(input) || input.length === 0) return ["dm"];
	const values = input
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.filter((value): value is SurfaceType => SURFACES.has(value));
	return Array.from(new Set(values.length > 0 ? values : ["dm"]));
}

function normalizeTtlMinutes(input: unknown): number {
	const parsed = typeof input === "number" ? input : Number(input);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MINUTES;
	return Math.min(Math.trunc(parsed), MAX_TTL_MINUTES);
}

// "Join the hosted workspace" link for a preview platform — overridable per
// platform via `LOBU_PREVIEW_<PLATFORM>_URL` on the deployment.
function previewJoinUrl(platform: string): string {
	return (
		process.env[`LOBU_PREVIEW_${platform.toUpperCase()}_URL`] ||
		PREVIEW_JOIN_DEFAULTS[platform] ||
		""
	);
}

/** The slash command to send to the hosted bot to redeem a code. */
function previewLinkCommand(platform: string, code: string): string {
	return `${formatChatCommand(platform, "link")} ${code}`;
}

/**
 * Chat Automation projections expose Slack channels in the canonical
 * `slack:<id>` form that the message-handler bridge looks up via `getBinding`
 * (`thread.channelId`). The `/lobu link` slash command hands us the bare Slack
 * channel id (`D…` / `C…`), so prefix it; a value that already carries a
 * transport prefix is left as-is.
 */
export function canonicalSlackChannelId(channelId: string): string {
	return /^[a-z]+:/i.test(channelId)
		? channelId
		: `${SLACK_PLATFORM}:${channelId}`;
}

/** The link endpoint must not widen the bearer credential's workspace grant. */
function credentialAllowsChatLink(
	c: Context<{ Bindings: Env }>,
	organizationId: string,
): boolean {
	if (c.var.authSource === "session") return Boolean(c.var.session);
	const token = c.var.mcpAuthInfo;
	if (!token) return false;
	if (c.var.authSource === "pat" && token.tokenType === "pat") {
		return token.organizationId == null || token.organizationId === organizationId;
	}
	return c.var.authSource === "oauth" &&
		(token.grantedOrganizationIds ?? []).includes(organizationId);
}

/**
 * POST /api/:orgSlug/preview/claims — called by `lobu run` (mcpAuth) to mint a
 * short-lived link code for a hosted preview bot or a selected installation.
 * Cross-organization installations require both a credential grant and current
 * admin authority in both workspaces.
 * Body: `{ agent_id, platform, connection_id?, surfaces?, ttl_minutes? }`.
 */
export async function createPreviewClaim(c: Context<{ Bindings: Env }>) {
	const auth = requireOrgUser(c);
	if (!auth) return c.json({ error: "Unauthorized" }, 401);

	const body = await parseJsonBody<Record<string, unknown>>(
		c,
		"Invalid or missing JSON body",
	);
	if (body instanceof Response) return body;

	const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
	if (!agentId) return c.json({ error: "agent_id is required" }, 400);

	const platform =
		typeof body.platform === "string" ? body.platform.trim().toLowerCase() : "";
	if (!platform) return c.json({ error: "platform is required" }, 400);

	const surfaces = normalizeSurfaces(body.surfaces);
	const ttlMinutes = normalizeTtlMinutes(body.ttl_minutes);
	const codePrefix = slugify(agentId, { maxLength: 32 }) || "agent";
	const sql = getDb();
	const requestedConnectionId = Number(body.connection_id);
	let connectionId: number | undefined;
	let connectionOrganizationId: string | undefined;
	if (Number.isFinite(requestedConnectionId) && requestedConnectionId > 0) {
		const rows = (await sql`
			SELECT id, connector_key, organization_id
			FROM connections
			WHERE id = ${requestedConnectionId}
				AND credential_mode IS NOT NULL
				AND status = 'active'
				AND deleted_at IS NULL
			LIMIT 1
		`) as Array<{ id: number; connector_key: string; organization_id: string }>;
		const connection = rows[0];
		if (!connection || (
			connection.organization_id !== auth.organizationId && (
				!credentialAllowsChatLink(c, auth.organizationId) ||
				!credentialAllowsChatLink(c, connection.organization_id) ||
				!(await canLinkChatOrganizations(sql, auth.userId, auth.organizationId, connection.organization_id))
			)
		)) return c.json({ error: "Active chat connection not found" }, 404);
		if (connection.connector_key !== platform) {
			return c.json({ error: "Connection platform does not match" }, 400);
		}
		connectionId = connection.id;
		connectionOrganizationId = connection.organization_id;
	} else if (!PREVIEW_PLATFORMS.has(platform)) {
		return c.json(
			{
				error: "Unsupported preview platform",
				message: `A connection_id is required for ${platform}`,
			},
			400,
		);
	}

	const agentRows = await sql<{ id: string }>`
    SELECT id
    FROM agents
    WHERE id = ${agentId}
      AND organization_id = ${auth.organizationId}
    LIMIT 1
  `;
	if (agentRows.length === 0) {
		return c.json(
			{
				error: "Agent not found",
				message:
					"Run `lobu apply` first so the preview bot can bind to this agent in Lobu Cloud.",
			},
			404,
		);
	}

	const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

	for (let attempt = 0; attempt < 5; attempt++) {
		const code = `${codePrefix}-${randomCodeSuffix()}`;
		const payload: ClaimPayload = {
			organizationId: auth.organizationId,
			agentId,
			...(connectionId ? { connectionId, connectionOrganizationId } : {}),
			createdBy: auth.userId,
			allowedSurfaces: surfaces,
			createdAt: Date.now(),
		};
		try {
			await sql`
        INSERT INTO oauth_states (id, scope, payload, expires_at)
        VALUES (${codeHash(code)}, ${CLAIM_SCOPE}, ${sql.json(payload)}, ${expiresAt})
      `;
			return c.json({
				provider: connectionId ? platform : `lobu-public-${platform}`,
				platform,
				code,
				command: previewLinkCommand(platform, code),
				join_url: connectionId ? "" : previewJoinUrl(platform),
				expires_at: expiresAt.toISOString(),
				allowed_surfaces: surfaces,
			});
		} catch (err: unknown) {
			if ((err as { code?: string }).code === "23505") continue;
			logger.error(
				{ err: errorMessage(err), platform },
				"[preview] create claim failed",
			);
			return c.json({ error: errorMessage(err) }, 500);
		}
	}

	return c.json({ error: "Could not allocate a unique preview code" }, 500);
}

type ConsumeClaimResult =
	| { status: "bound"; agentId: string; organizationId: string }
	| { status: "not_found" }
	| { status: "connection_mismatch" }
	| { status: "link_authority_revoked" }
	| { status: "surface_not_allowed"; surfaceType: SurfaceType };

// Create/update the tagged chat-link Automation for this concrete connection and
// channel. `tx` keeps claim consumption + subscription creation atomic.
async function upsertBinding(
	tx: ReturnType<typeof getDb>,
	platform: string,
	channelId: string,
	teamId: string | undefined,
	agentId: string,
	organizationId: string,
	connectionId: number,
	configuredBy?: string | null,
	requireAuthorizedAuthor = false,
): Promise<boolean> {
	return new AutomationSubscriptionService().createChatAutomation(
		agentId,
		platform,
		channelId,
		teamId,
		{
			organizationId,
			connectionId,
			configuredBy: configuredBy ?? undefined,
			requireAuthorizedAuthor,
			sql: tx,
		},
	);
}

/**
 * Consume a `/lobu link` (a.k.a. `/link`) code and bind the originating chat to
 * the agent the code was minted for. One-time use; last link for a surface wins
 * (re-linking just rebinds — there's no separate unlink step). Called from the
 * `link` chat command, so it never touches HTTP.
 *
 * Platform-agnostic: the caller supplies the `platform`, the canonical
 * `channelId` form that platform's message handler looks bindings up by (for
 * Slack: `canonicalSlackChannelId`), the workspace/`teamId` if the platform has
 * one, and the resolved `surfaceType` (dm vs channel).
 */
export async function consumePreviewClaim(args: {
	code: string;
	platform: string;
	/** Workspace id for platforms that have one (Slack); undefined otherwise. */
	teamId?: string;
	channelId: string;
	surfaceType: SurfaceType;
	/** Runtime connection id handling the command. Required for a
	 * connection-scoped claim; hosted preview claims intentionally omit it. */
	connectionId?: string;
	/** Organization that owns the runtime connection handling redemption. */
	connectionOrganizationId?: string;
}): Promise<ConsumeClaimResult> {
	const {
		code,
		platform,
		teamId,
		channelId,
		surfaceType,
		connectionId,
		connectionOrganizationId,
	} = args;
	const sql = getDb();

	const result = await sql.begin(async (tx) => {
		const claims = await tx<{ payload: ClaimPayload }>`
			SELECT payload FROM oauth_states
			WHERE id = ${codeHash(code)}
				AND scope = ${CLAIM_SCOPE}
				AND expires_at > now()
			FOR UPDATE
		`;
		const claim = claims[0]?.payload;
		if (!claim) return { status: "not_found" as const };
		let bindingConnectionId = claim.connectionId;
		if (bindingConnectionId != null) {
			if (!connectionId) return { status: "connection_mismatch" as const };
			const claimedConnectionOrg = claim.connectionOrganizationId ?? claim.organizationId;
			const matched = await tx`
				SELECT 1 FROM connections
				WHERE id = ${claim.connectionId}
					AND organization_id = ${claimedConnectionOrg}
					AND slug = ${runtimeConnectionIdToSlug(connectionId)}
					AND connector_key = ${platform}
					AND credential_mode IS NOT NULL
					AND status = 'active'
					AND deleted_at IS NULL
				LIMIT 1
			`;
			if (matched.length === 0 ||
				(connectionOrganizationId && connectionOrganizationId !== claimedConnectionOrg) ||
				(claimedConnectionOrg !== claim.organizationId &&
					!(await canLinkChatOrganizations(tx, claim.createdBy, claim.organizationId, claimedConnectionOrg)))
			) return { status: "connection_mismatch" as const };
		} else {
			// A hosted claim may cross organizations only through the deliberately
			// shared preview connection for the workspace handling the command. A normal
			// managed/BYO installation must belong to the claimed agent's org: a hosted
			// code has no grant for a specific foreign installation. That requires an
			// explicitly connection-scoped code minted with authority over both orgs.
			if (!connectionId) return { status: "connection_mismatch" as const };
			const matched = await tx<{ id: number }>`
				SELECT id FROM connections
				WHERE slug = ${runtimeConnectionIdToSlug(connectionId)}
					AND connector_key = ${platform}
					AND credential_mode IS NOT NULL
					AND status = 'active'
					AND deleted_at IS NULL
					AND (
						organization_id = ${claim.organizationId}
						OR (
							config->'settings'->'previewMode' = 'true'::jsonb
							AND (
								external_tenant_id IS NULL
								OR external_tenant_id = ${teamId ?? null}
							)
						)
					)
					${connectionOrganizationId ? tx`AND organization_id = ${connectionOrganizationId}` : tx``}
				LIMIT 2
			`;
			if (matched.length !== 1)
				return { status: "connection_mismatch" as const };
			bindingConnectionId = matched[0].id;
		}
		if (!claim.allowedSurfaces.includes(surfaceType)) {
			return { status: "surface_not_allowed" as const, surfaceType };
		}
		const linked = await upsertBinding(
			tx,
			platform,
			channelId,
			teamId,
			claim.agentId,
			claim.organizationId,
			bindingConnectionId,
			claim.createdBy,
			claim.connectionOrganizationId != null && claim.connectionOrganizationId !== claim.organizationId,
		);
		if (!linked) return { status: "link_authority_revoked" as const };
		await tx`
			DELETE FROM oauth_states
			WHERE id = ${codeHash(code)} AND scope = ${CLAIM_SCOPE}
		`;

		// Redemption binds the chat and NOTHING ELSE — deliberately no
		// chat-platform → Lobu-user identity. A claim code is paste-able and does
		// not prove the redeemer is the minter, while a chat-user identity
		// row authorizes Slack approval clicks (`interaction-bridge`
		// resolveSlackActionReviewer). Identity is established only by the Slack
		// install claim (slack-claim.ts), which links identities proven via Slack
		// sign-in.
		return {
			status: "bound" as const,
			agentId: claim.agentId,
			organizationId: claim.organizationId,
		};
	});

	// Post-commit, best-effort: a `/lobu link` inside the installer's OWN claimed
	// Slack workspace is that workspace's first-agent mapping — fire the one-time
	// installer welcome DM. No-op for the hosted-preview team (no active
	// `app_installations` row) or when already sent; the coordinator's atomic
	// marker decides. Runs only after the binding actually committed.
	if (result.status === "bound" && platform === SLACK_PLATFORM && teamId) {
		const pg = new PostgresSecretStore();
		await maybeSendSlackWorkspaceWelcome({
			teamId,
			secretStore: new SecretStoreRegistry(pg, { secret: pg }),
		}).catch((error) => {
			logger.warn(
				{ teamId, error: errorMessage(error) },
				"[preview] slack welcome DM after link-bind failed",
			);
		});
	}

	return result;
}

// ── Public-preview "try a demo agent" ────────────────────────────────────────
//
// A `previewMode` connection (the hosted "Lobu" workspace bot) exposes every
// agent in *its own org* as a self-serve demo: `/lobu try <agentId>` binds the
// chat to that agent — no claim code, no ownership check, no CLI. "The org" is
// whatever org owns the preview connection's agent; drop your demo agents in it
// (via `lobu apply` / the agents UI) and they show up here automatically. The
// connection's own placeholder/concierge agent is excluded from the list.

interface PreviewAgent {
	agentId: string;
	name: string;
	description: string | null;
}

/**
 * Resolve the org a preview connection's demo agents live in (the org of its
 * owning agent), plus that owning agent's id (excluded from the demo list).
 * Returns null when the connection or its owning agent can't be resolved.
 */
async function resolvePreviewConnectionOrg(connectionId: string): Promise<{
	organizationId: string;
	owningAgentId: string;
	connectionDatabaseId: number;
} | null> {
	const sql = getDb();
	const rows = (await sql`
    SELECT id, organization_id, agent_id
    FROM connections
    WHERE slug = ${runtimeConnectionIdToSlug(connectionId)}
      AND credential_mode IS NOT NULL
      AND deleted_at IS NULL
    LIMIT 1
  `) as Array<{
		id: number;
		organization_id: string | null;
		agent_id: string | null;
	}>;
	const row = rows[0];
	if (!row?.organization_id || !row.agent_id) return null;
	return {
		organizationId: row.organization_id,
		owningAgentId: row.agent_id,
		connectionDatabaseId: row.id,
	};
}

/**
 * Demo agents reachable via `/lobu try` through this preview connection. Best
 * effort: returns `[]` (and logs) on any DB error rather than throwing — this
 * runs on the hot path of every unlinked message and the worst case is a
 * fallback notice instead of the menu.
 */
export async function listPreviewAgents(
	connectionId: string,
): Promise<PreviewAgent[]> {
	try {
		const org = await resolvePreviewConnectionOrg(connectionId);
		if (!org) return [];
		const sql = getDb();
		const rows = (await sql`
      SELECT id, name, description
      FROM agents
      WHERE organization_id = ${org.organizationId}
        AND id <> ${org.owningAgentId}
      ORDER BY name NULLS LAST, id
    `) as Array<{
			id: string;
			name: string | null;
			description: string | null;
		}>;
		return rows.map((r) => ({
			agentId: r.id,
			name: r.name ?? r.id,
			description: r.description ?? null,
		}));
	} catch (err) {
		logger.warn(
			{ err: errorMessage(err), connectionId },
			"[preview] listPreviewAgents failed",
		);
		return [];
	}
}

type BindPreviewAgentResult =
	| { status: "bound"; agentId: string }
	| { status: "not_available" }
	| { status: "no_connection" };

/**
 * Bind a chat to a demo agent for a preview connection. The agent must live in
 * the connection's org — that's the allowlist; there's no per-caller ownership
 * check (that's the whole point: anyone in the hosted workspace can try them).
 * Last bind wins; re-running with another agent just rebinds.
 */
export async function bindChatToPreviewAgent(args: {
	connectionId: string;
	agentId: string;
	platform: string;
	/** Workspace id for platforms that have one (Slack); undefined otherwise. */
	teamId?: string;
	/** Canonical channel id the message handler looks bindings up by. */
	channelId: string;
}): Promise<BindPreviewAgentResult> {
	const org = await resolvePreviewConnectionOrg(args.connectionId);
	if (!org) return { status: "no_connection" };
	const sql = getDb();
	const agentRows = (await sql`
    SELECT id FROM agents
    WHERE id = ${args.agentId} AND organization_id = ${org.organizationId}
    LIMIT 1
  `) as Array<{ id: string }>;
	const target = agentRows[0];
	if (!target) return { status: "not_available" };

	const { platform, teamId, channelId } = args;
	// Org-scoped upsert (same dance as `upsertBinding`): another tenant's binding
	// for the same platform+channel is a different row and cannot be clobbered,
	// and `organization_id` is never reassigned, so a binding can't change owners.
	await upsertBinding(
		sql,
		platform,
		channelId,
		teamId,
		target.id,
		org.organizationId,
		org.connectionDatabaseId,
	);
	return { status: "bound", agentId: target.id };
}

/** The "pick a demo agent" menu — shown on `/lobu try` / `/lobu agents`. */
export function previewAgentMenu(
	platform: string,
	agents: PreviewAgent[],
): string {
	if (agents.length === 0) {
		return "No demo agents are available here yet.";
	}
	return [
		"Demo agents you can try here:",
		...agents.map(
			(a) =>
				`• \`${tryCommand(platform)} ${a.agentId}\` — ${a.description || a.name}`,
		),
		"",
		`Pick one, then just send a message. \`${listCommand(platform)}\` shows this list again.`,
	].join("\n");
}

/**
 * Reply for a `previewMode` connection when an unlinked chat arrives. If the
 * connection's org has demo agents, it's the `/lobu try` menu; otherwise it
 * falls back to "wire your own agent" instructions. Returns null only when
 * there's nothing useful to say (unknown platform).
 */
export async function previewUnlinkedNotice(
	platform: string,
	connectionId: string,
): Promise<string | null> {
	if (!PREVIEW_PLATFORMS.has(platform)) return null;
	const agents = await listPreviewAgents(connectionId);
	if (agents.length > 0) {
		return [
			`👋 Welcome! ${previewAgentMenu(platform, agents)}`,
			"",
			`(Building your own agent? Run \`lobu run\` and send the \`${linkCommand(platform)} <code>\` it prints.)`,
		].join("\n");
	}
	return [
		"👋 This chat isn't linked to a Lobu agent yet.",
		"",
		"New to Lobu? Scaffold a project with `npx @lobu/cli init`, then:",
		"`lobu apply` to sync it, and `lobu run` to get a " +
			`\`${linkCommand(platform)} <code>\` — paste that code here to link this chat.`,
	].join("\n");
}

/**
 * The org's agents + slug for building a link notice. Kept separate from
 * `listPreviewAgents` (which is preview-connection-scoped and excludes the
 * owning agent) — an OAuth-installed workspace has no owning agent, so every
 * agent in the org is a valid link target.
 */
async function listOrgAgentsForNotice(organizationId: string): Promise<{
	orgSlug: string | null;
	agents: Array<{ agentId: string; name: string }>;
}> {
	const sql = getDb();
	const [orgRow] = await sql<{ slug: string | null }>`
    SELECT slug FROM organization WHERE id = ${organizationId} LIMIT 1
  `;
	const rows = await sql<{ id: string; name: string | null }>`
    SELECT id, name
    FROM agents
    WHERE organization_id = ${organizationId}
    ORDER BY name NULLS LAST, id
  `;
	return {
		orgSlug: orgRow?.slug ?? null,
		agents: rows.map((r) => ({ agentId: r.id, name: r.name ?? r.id })),
	};
}

/**
 * Escape the Slack mrkdwn chars that break an inline `<url|label>` link label.
 * Agent names are user-controlled; a `>`, `<`, or `&` in a name would otherwise
 * terminate/mangle the link (Slack reads `text` as mrkdwn, and `&` is the entity
 * escape prefix). Mirrors the private `escapeMrkdwn` in slack-platform-bridge.ts;
 * kept local because preview and gateway/connections are separate modules.
 */
function escapeMrkdwnLabel(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Reply for a tenant's own workspace bot (a connection with no owning agent)
 * when a non-command message arrives in a chat that isn't bound to one of the
 * tenant's agents yet. Unlike a preview connection there are no demo agents to
 * offer — the tenant links their own agents.
 *
 * Slack: lists the org's agents and, when the public origin is configured,
 * deep-links each to its Automations page (where a channel is added as a Listen
 * source); also gives the CLI `lobu run` / `/lobu link <code>` path.
 *
 * Every other platform (Telegram, …) gets a generic dashboard+CLI notice —
 * there is no workspace/team concept to deep-link, and dropping silently left
 * the user with no signal at all (#2230).
 */
export async function workspaceUnlinkedNotice(
	platform: string,
	organizationId: string,
	channel?: {
		channelId: string;
		teamId?: string;
		channelName?: string;
		connectionId?: string;
	},
): Promise<string> {
	// Non-Slack platforms have no workspace/team deep links, so the notice is
	// generic: the dashboard path plus the platform's own link command.
	// Deliberately static — no DB/origin lookups whose failure could turn the
	// reply back into a dead drop.
	if (platform !== "slack") {
		return [
			"👋 This chat isn't linked to a Lobu agent yet.",
			"",
			"Link it two ways:",
			"• In the dashboard — create an Automation for an agent and add this chat as a Listen source.",
			`• From the CLI — run \`lobu run\`, then paste the \`${linkCommand(platform)} <code>\` it prints here.`,
		].join("\n");
	}

	const header =
		"👋 Thanks for adding Lobu! This channel isn't linked to one of your agents yet.";
	const cliLine = `From the CLI — run \`lobu run\`, then paste the \`${linkCommand(platform)} <code>\` it prints here.`;

	let agents: Array<{ agentId: string; name: string }> = [];
	let orgSlug: string | null = null;
	try {
		({ agents, orgSlug } = await listOrgAgentsForNotice(organizationId));
	} catch (err) {
		// Never let a lookup failure turn the notice into a dead drop — fall back
		// to the CLI-only path below.
		logger.warn(
			{ err: errorMessage(err), organizationId },
			"[slack] workspaceUnlinkedNotice: agent lookup failed",
		);
	}

	const origin = getConfiguredPublicOrigin()?.replace(/\/+$/, "");
	// Deep-link each agent to the workspace Automation "new" step with THIS channel prefilled,
	// so the canonical event trigger is selected without a separate subscription
	// workflow. `channelId` remains canonical `slack:C…`; the editor converts it to
	// the provider-native filter value. The agent is always prefilled so every named
	// link remains specific to the agent even without channel context.
	const canLink = Boolean(origin && orgSlug);
	const automationsUrl = (agentId: string): string => {
		const params = new URLSearchParams({
			agent: agentId,
		});
		if (channel?.channelId) {
			params.set("listen", channel.channelId);
			params.set("platform", "slack");
			if (channel.teamId) params.set("team", channel.teamId);
			if (channel.connectionId)
				params.set("connection", channel.connectionId);
			// Friendly channel name → the editor subtitle. Prefixed with `#` so it reads
			// as a channel.
			if (channel.channelName) params.set("label", `#${channel.channelName}`);
		}
		return `${origin}/${orgSlug}/automations/new?${params.toString()}`;
	};
	// Render each agent as a Slack mrkdwn inline link (`<url|label>`). The notice
	// is posted via thread.post(string) → chat.postMessage({ text }), which Slack
	// always interprets as mrkdwn; with unfurl_links disabled a bare URL renders
	// as flat text, but `<url|label>` renders as a clickable link. The adapter's
	// plain-text path only rewrites @mentions, so the `<>` survive intact. The
	// label is escaped because agent names are user-controlled and a raw `>`/`<`/`&`
	// would terminate or corrupt the inline link.
	const agentLines = agents.map((a) =>
		canLink
			? `   • <${automationsUrl(a.agentId)}|${escapeMrkdwnLabel(a.name)}>`
			: `   • ${a.name}`,
	);

	if (agentLines.length > 0) {
		return [
			header,
			"",
			"Link it to an agent two ways:",
			canLink
				? "• In the dashboard — create an Automation for an agent and add this channel as a Listen source:"
				: "• In the dashboard — create an Automation for an agent and add this channel as a Listen source. Your agents:",
			...agentLines,
			`• ${cliLine}`,
		].join("\n");
	}

	// No agents yet (or the lookup failed) — CLI path only.
	return [header, "", cliLine].join("\n");
}

type BindForOwnerResult = { status: "bound" } | { status: "forbidden" } | { status: "link_authority_revoked" };

/**
 * Re-bind a chat to one of the caller's agents by id, without a code — only
 * works with a verified chat identity and an unambiguous agent in the caller's
 * organizations. Non-preview installations also require admin authority in
 * both workspaces when linking across organizations.
 */
export async function bindChatToAgentForOwner(args: {
	platform: string;
	teamId?: string;
	channelId: string;
	agentId: string;
	lobuUserId: string;
	connectionId: string;
	connectionOrganizationId?: string;
}): Promise<BindForOwnerResult> {
	const { platform, teamId, channelId, agentId, lobuUserId } = args;
	const sql = getDb();
	// `agents` is keyed on (organization_id, id), so one agent id can name a
	// different agent in each org the caller belongs to. Refuse rather than let
	// an arbitrary row decide which organization the chat is bound to.
	const owned = await sql<{ organization_id: string }>`
    SELECT a.organization_id
    FROM agents a
    JOIN "member" m ON m."organizationId" = a.organization_id
    WHERE a.id = ${agentId} AND m."userId" = ${lobuUserId}
    LIMIT 2
  `;
	if (owned.length !== 1) return { status: "forbidden" };
	const organizationId = owned[0].organization_id;
	const connections = await sql<{ id: number; organization_id: string; is_preview: boolean }>`
		SELECT id, organization_id,
			COALESCE(config->'settings'->'previewMode' = 'true'::jsonb, false) AS is_preview
		FROM connections
		WHERE slug = ${runtimeConnectionIdToSlug(args.connectionId)}
			AND connector_key = ${platform}
			AND status = 'active'
			AND credential_mode IS NOT NULL
			AND deleted_at IS NULL
			${args.connectionOrganizationId ? sql`AND organization_id = ${args.connectionOrganizationId}` : sql``}
		LIMIT 2
	`;
	if (connections.length !== 1) return { status: "forbidden" };
	const requiresInstallationAuthority = connections[0].organization_id !== organizationId && !connections[0].is_preview;
	if (requiresInstallationAuthority) {
		// Codeless identity currently comes from verified Slack workspace identity.
		// Platforms without that identity adapter use connection-scoped codes.
		if (!teamId) return { status: "forbidden" };
		if (!(await canLinkChatOrganizations(sql, lobuUserId, organizationId, connections[0].organization_id))) {
			return { status: "forbidden" };
		}
	}
	const linked = await sql.begin((tx) =>
		upsertBinding(
			tx,
			platform,
			channelId,
			teamId,
			agentId,
			organizationId,
			connections[0].id,
			lobuUserId,
			requiresInstallationAuthority,
		),
	);
	return { status: linked ? "bound" : "link_authority_revoked" };
}
