import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeConversationId } from "@lobu/core";
import { filterChannelsForRequester } from "../../authz/channel-visibility.js";
import { type DbClient, getDb } from "../../db/client.js";
import {
	resolveBoundChannelRows,
	stripPlatformPrefix,
} from "../channels/bound-channels.js";
import { buildApiConversationId } from "./api-conversation-id.js";
import { listConversations } from "./conversations-store.js";
import { paginateSessionMessages } from "./session-message-page.js";
import { readSnapshotJsonl } from "./transcript-snapshot.js";

const SAFE_AGENT_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_THREAD_ID = /^[a-zA-Z0-9_-]+$/;

function isSafeAgentId(id: string): boolean {
	return SAFE_AGENT_ID.test(id);
}

function isSafeThreadId(id: string): boolean {
	return SAFE_THREAD_ID.test(id);
}

export interface AgentThreadSummary {
	/** Routing key: a thread id for web conversations (chattable), or the raw
	 *  conversation id for platform conversations (read-only). */
	id: string;
	title: string;
	locationLabel?: string | null;
	createdAt: number;
	updatedAt: number;
	/** "web" for the app's own threads; "automation" for automation activity; otherwise
	 *  the source platform derived from the conversation id prefix (slack, …). */
	platform: string;
	/** Raw conversation id — used to read a platform conversation read-only. */
	conversationId: string;
	/** Set on `platform: "automation"` entries — routes to the automation's page. */
	automationId?: number;
}

/** `{platform}:{team}:{channel}` — team-scoped so the same channel id in two
 *  Slack workspaces never collides. `team` is "" for platforms without one. */
function channelVisibilityKey(
	platform: string,
	teamId: string | null,
	bareChannelId: string,
): string {
	return `${platform.toLowerCase()}:${teamId ?? ""}:${bareChannelId}`;
}

export interface ChannelVisibility {
	/** Team-scoped keys the requester may read (per-agent fence ∩ per-user ACL). */
	visibleKeys: Set<string>;
	/** `{platform}:{channel}` → the team ids the AGENT is bound to it in. A
	 *  channel bound in >1 team can't be disambiguated from a conversation id
	 *  alone, so it fails closed. */
	channelTeams: Map<string, Set<string>>;
}

/**
 * Which channels may THIS requester read for THIS agent — the per-agent channel
 * fence (the agent's bound channels) INTERSECTED with the per-user channel ACL
 * gate ({@link filterChannelsForRequester}), team-scoped. A platform conversation
 * is visible iff {@link isConversationVisible}. Mirrors recall's membership
 * gate and its connection-owner fallback when source permissions are unknown.
 */
export async function resolveChannelVisibility(
	sql: DbClient,
	args: {
		organizationId: string;
		agentId: string;
		userId: string | null;
	},
): Promise<ChannelVisibility> {
	const bound = await resolveBoundChannelRows(sql, {
		organizationId: args.organizationId,
		agentId: args.agentId,
	});
	const channelTeams = new Map<string, Set<string>>();
	for (const c of bound) {
		const bare = stripPlatformPrefix(c.platform, c.channel_id);
		const pc = `${c.platform.toLowerCase()}:${bare}`;
		const set = channelTeams.get(pc) ?? new Set<string>();
		set.add(c.team_id ?? "");
		channelTeams.set(pc, set);
	}
	const visible = await filterChannelsForRequester(sql, {
		organizationId: args.organizationId,
		userId: args.userId,
		rows: bound,
	});
	const visibleKeys = new Set(
		visible.map((c) =>
			channelVisibilityKey(
				c.platform,
				c.team_id,
				stripPlatformPrefix(c.platform, c.channel_id),
			),
		),
	);
	return { visibleKeys, channelTeams };
}

/** Can the requester read this platform conversation (`{platform}:{channel}:{thread}`)?
 *  Fail-closed: unbound, or a channel bound in ≥2 DISTINCT REAL workspaces (can't
 *  tie the conversation to a single team), is not visible.
 *
 *  A NULL/"" team is a WILDCARD ("workspace unknown yet" — a binding written
 *  before its workspace healed from the first inbound event), NOT a distinct
 *  workspace. `team_id` is now guaranteed to be a real workspace or NULL (never a
 *  Grid enterprise id), so the gate needs zero connector knowledge: it counts
 *  distinct non-null teams and only fails closed on genuine cross-workspace
 *  ambiguity (2+ real teams). One real team + any number of NULLs resolves to
 *  that team; all-NULL resolves via the wildcard visible key. */
export function isConversationVisible(
	conversationId: string,
	vis: ChannelVisibility,
): boolean {
	const parts = conversationId.split(":");
	const platform = (parts[0] ?? "").toLowerCase();
	const channel = parts[1] ?? "";
	const teams = vis.channelTeams.get(`${platform}:${channel}`);
	if (!teams || teams.size === 0) return false; // unbound
	const realTeams = [...teams].filter((t) => t !== "");
	if (realTeams.length > 1) return false; // genuine cross-workspace ambiguity
	// One real team (NULLs are wildcards that resolve to it), or all-NULL (a
	// teamless/unknown-yet binding — resolves via the "" wildcard visible key).
	const team = realTeams[0] ?? null;
	return vis.visibleKeys.has(channelVisibilityKey(platform, team, channel));
}

async function findConversationSessionFile(
	agentId: string,
	conversationId: string,
): Promise<string | null> {
	if (!isSafeAgentId(agentId)) return null;
	const workspacesRoot = resolve("workspaces");
	const workspaceDir = resolve(workspacesRoot, agentId);
	if (!workspaceDir.startsWith(`${workspacesRoot}/`)) return null;

	const sanitized = sanitizeConversationId(conversationId);
	const sessionPath = join(
		workspaceDir,
		sanitized,
		".lobu",
		"session.jsonl",
	);
	try {
		await stat(sessionPath);
		return sessionPath;
	} catch {
		return null;
	}
}

export async function listAgentThreads(args: {
	agentId: string;
	organizationId?: string;
	userId: string;
	/** "user" (default): only the requesting user's app threads. "all": every
	 *  conversation for the agent across platforms (Slack, Telegram, …). */
	scope?: "user" | "all";
	/**
	 * Does the requester have admin access to this agent/org? Only consulted for
	 * DM conversations that the normal channel-membership path cannot admit.
	 * Defaults to false so a caller that forgets to pass it fails closed.
	 */
	isAdmin?: boolean;
}): Promise<AgentThreadSummary[]> {
	const {
		agentId,
		organizationId,
		userId,
		scope = "user",
		isAdmin = false,
	} = args;
	// No org → no tenant scope → nothing to list from the (org-keyed) entity.
	if (!organizationId) return [];

	const byKey = new Map<string, AgentThreadSummary>();

	// Owned + platform conversations come from the `conversations` entity — the
	// single listing source. This replaces the old
	// `DISTINCT ON (conversation_id) FROM agent_transcript_snapshot` derive path
	// AND the workspace-directory scan.
	//
	// This is an end-user feed, so "all" means "mine plus the channels I may
	// read" — `shared`, never the store's `admin`. Admin listing is
	// `manage_conversations`, which checks a role first.
	const rows = await listConversations({
		organizationId,
		agentId,
		scope: scope === "all" ? "shared" : "user",
		userId,
	});

	// Group-channel conversations in "all" scope are ACL-gated: a conversation is only
	// listed if its channel is in the agent's bound channels AND the requester
	// has fresh channel membership or owns the ungraphed connection.
	let channelVis: ChannelVisibility | null = null;
	if (scope === "all") {
		channelVis = await resolveChannelVisibility(getDb(), {
			organizationId,
			agentId,
			userId,
		});
	}

	for (const row of rows) {
		const at = row.lastActivityAt.getTime();
		const createdAt = row.createdAt.getTime();
		if (row.kind === "owned") {
			// Routable id is STORED (`thread_id`), never re-parsed out of the id
			// string. The migration trigger also covers writes from an old server
			// between the pre-upgrade migration and deployment replacement.
			const threadId = row.threadId;
			if (!threadId || !isSafeThreadId(threadId) || byKey.has(threadId)) {
				continue;
			}
			byKey.set(threadId, {
				id: threadId,
				title: row.title ?? `Conversation ${byKey.size + 1}`,
				createdAt,
				updatedAt: at,
				platform: "web",
				conversationId: row.conversationId,
			});
		} else if (row.kind === "platform") {
			// One entry per conversationId — that's the whole identity of a platform
			// conversation (the connection that delivered it is routing, not identity;
			// a reconnect changes it without changing the conversation). The ACL and
			// transcript read address it by conversationId alone, consistent with this.
			//
			// isConversationVisible extracts platform:channel from the id, so an
			// opaque/no-colon platform id fails closed (unlisted) — same as the prior
			// path, which only ever listed `LIKE '%:%'` platform ids. Failing closed
			// is safe; the same-channel-across-two-workspaces (Grid) case is likewise
			// handled by isConversationVisible failing closed on team ambiguity.
			if (byKey.has(row.conversationId)) continue;
			// Some DMs are explicitly bound (for example Preview `/link`) and must
			// keep the existing channel-fence path. Admin access is the safe bypass
			// for an unbound DM, whose correspondent cannot be mapped portably to a
			// Lobu user. `isDirect` null (unknown) also keeps the channel fence and
			// stays fail-closed.
			if (
				!(row.isDirect === true && isAdmin) &&
				channelVis &&
				!isConversationVisible(row.conversationId, channelVis)
			) {
				continue;
			}
			byKey.set(row.conversationId, {
				id: row.conversationId,
				title: row.title ?? "Conversation",
				locationLabel: row.locationLabel,
				createdAt,
				updatedAt: at,
				// Label from the EXPLICIT stored platform, not by parsing the id — an
				// opaque/no-colon platform id (e.g. gchat spaces_A_threads_B) would
				// otherwise mislabel as "web".
				platform: row.platform,
				conversationId: row.conversationId,
			});
		}
	}

	// Automation activity comes from bounded `automations` config rather than
	// aggregating append-only transcript history. An Automation is not a conversation,
	// so it keeps the existing `automation_<id>` route key without a `conversations`
	// row. Reading status and name live also drops archived rows immediately.
	if (scope === "all") {
		const sql = getDb();
		const automationRows = await sql<{
			id: number;
			name: string | null;
			last_run_completed_at: Date;
		}>`
      SELECT id, name, last_run_completed_at
      FROM public.automations
      WHERE organization_id = ${organizationId}
        AND managed_agent_id = ${agentId}
        AND status = 'active'
        AND last_run_completed_at IS NOT NULL
      ORDER BY last_run_completed_at DESC
    `;
		for (const row of automationRows) {
			// `automation_<id>` is the key the panel has always rendered and routed on.
			const key = `automation_${row.id}`;
			const at = row.last_run_completed_at.getTime();
			byKey.set(key, {
				id: key,
				title: row.name ?? `Automation ${row.id}`,
				// Preserves the derived contract: an Automation entry represents latest
				// activity, so both timestamps track the last completed run.
				createdAt: at,
				updatedAt: at,
				platform: "automation",
				conversationId: key,
				automationId: row.id,
			});
		}
	}

	return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Read one conversation's messages by its RAW conversation id (e.g. a platform
 * thread `slack:{channel}:{ts}`). Read-only — used to render platform
 * conversations that aren't routable through the app chat composer.
 */
export async function readConversationMessages(args: {
	agentId: string;
	organizationId: string;
	conversationId: string;
	cursor: string;
	limit: number;
}) {
	const { agentId, organizationId, conversationId, cursor, limit } = args;
	const jsonl = await readSnapshotJsonl({
		agentId,
		organizationId,
		conversationId,
	});
	if (jsonl === null) {
		return {
			messages: [],
			nextCursor: null,
			hasMore: false,
			sessionId: conversationId,
			threadId: conversationId,
		};
	}
	return {
		...paginateSessionMessages(jsonl, cursor, limit, {
			excludeVerbose: true,
			sessionIdFallback: conversationId,
		}),
		threadId: conversationId,
	};
}

export async function loadConversationTranscriptJsonl(
	agentId: string,
	organizationId: string | undefined,
	conversationId: string,
): Promise<string | null> {
	const fromDb = await readSnapshotJsonl({
		agentId,
		organizationId,
		conversationId,
	});
	if (fromDb !== null) return fromDb;

	const sessionPath = await findConversationSessionFile(
		agentId,
		conversationId,
	);
	if (!sessionPath) return null;
	return readFile(sessionPath, "utf-8");
}

export async function readThreadMessages(args: {
	agentId: string;
	threadId: string;
	cursor: string;
	limit: number;
	organizationId?: string;
	userId: string;
}) {
	const { agentId, threadId, cursor, limit, organizationId, userId } = args;
	const conversationId = buildApiConversationId({
		agentId,
		userId,
		organizationId,
		threadId,
	});

	const content = await loadConversationTranscriptJsonl(
		agentId,
		organizationId,
		conversationId,
	);
	if (content === null) {
		return {
			messages: [],
			nextCursor: null,
			hasMore: false,
			sessionId: conversationId,
			threadId,
		};
	}

	return {
		...paginateSessionMessages(content, cursor, limit, {
			excludeVerbose: true,
			sessionIdFallback: conversationId,
		}),
		threadId,
	};
}
