import { createLogger } from "@lobu/core";
import { channelResourceIdentity } from "../../authz/channel-about.js";
import { getDb } from "../../db/client.js";
import { getPlatformDescriptor } from "../connections/platforms/index.js";

const logger = createLogger("conversations-store");

/** A conversation's origin class, mirroring how the listing partitions ids. */
export type ConversationKind = "owned" | "platform";

/** Automation conversation id shape: `{agentId}_automation_{id}_run_{runId}`. These
 *  stay derived from `agent_transcript_snapshot` (one sidebar entry per AUTOMATION,
 *  not per run) and must NEVER get a `conversations` row. */
const AUTOMATION_CONVERSATION_ID = /_automation_\d+_run_\d+$/;

export function isAutomationConversationId(conversationId: string): boolean {
	return AUTOMATION_CONVERSATION_ID.test(conversationId);
}

/**
 * Derive a conversation's stored (kind, platform) from the EXPLICIT dispatch
 * platform — never by parsing the id string. The app's own threads dispatch with
 * `platform: "api"` (the marker the whole gateway already gates on, e.g.
 * interactions.ts:57, unified-thread-consumer.ts:391) and are stored as
 * ('owned', 'web'); every other platform is a real external channel stored as
 * ('platform', <platform>). Returning both from one place keeps kind and the
 * stored platform from drifting apart at the call site. Automation ids are filtered
 * out BEFORE this by {@link isAutomationConversationId}.
 */
export function classifyConversation(platform: string): {
	kind: ConversationKind;
	storedPlatform: string;
} {
	// Lowercase-canonicalize the stored platform. platform is part of the
	// conversations PK, so a connector that ever emitted, say, 'Slack' would
	// otherwise land a duplicate row alongside a 'slack' one.
	const p = platform.toLowerCase();
	return p === "api"
		? { kind: "owned", storedPlatform: "web" }
		: { kind: "platform", storedPlatform: p };
}

export interface ConversationUpsert {
	organizationId: string;
	agentId: string;
	platform: string;
	conversationId: string;
	/**
	 * Web route segment for an owned conversation. Platform conversations and
	 * owned ids without a web thread suffix store null.
	 */
	threadId: string | null;
	kind: ConversationKind;
	userId?: string | null;
	title?: string | null;
	locationLabel?: string | null;
	/**
	 * Platform rows only: true for a 1:1 DM with the bot, false for a group
	 * channel. Null = unknown (the inbound carried no hint, or the row predates
	 * the column) and stays fail-closed in the read gate. Never derived from the
	 * conversation id — no platform encodes DM-ness portably.
	 */
	isDirect?: boolean | null;
	lastActivityAt: Date;
}

/**
 * Materialize (or refresh) the `conversations` row for a turn. Called on every
 * dispatch that starts a turn — the row is the single listing source. Idempotent:
 * the first turn INSERTs, later turns bump `last_activity_at` and fill in a
 * newly-known `title`/`user_id`/`thread_id` without clobbering earlier non-null
 * values.
 * Failures are swallowed — a listing-materialization hiccup must never fail a
 * live turn.
 */
export async function upsertConversation(
	row: ConversationUpsert,
): Promise<void> {
	// getDb() inside the try: it throws when DATABASE_URL is unset (or the pool
	// can't init), and a listing-materialization hiccup must never fail a live
	// turn — so the swallow below must cover the client acquisition too, not just
	// the query.
	try {
		const sql = getDb();
		await sql`
      INSERT INTO public.conversations (
        organization_id, agent_id, platform, conversation_id, thread_id,
        kind, user_id, title, is_direct, location_label, last_activity_at
      ) VALUES (
        ${row.organizationId}, ${row.agentId}, ${row.platform},
        ${row.conversationId}, ${row.threadId}, ${row.kind},
        ${row.userId ?? null}, ${row.title ?? null}, ${row.isDirect ?? null}, ${row.locationLabel ?? null},
        ${row.lastActivityAt}
      )
      ON CONFLICT (organization_id, agent_id, platform, conversation_id)
      DO UPDATE SET
        last_activity_at = GREATEST(
          public.conversations.last_activity_at, EXCLUDED.last_activity_at
        ),
        -- keep the earliest known non-null title/user/thread; don't clobber with null
        title = COALESCE(public.conversations.title, EXCLUDED.title),
        user_id = COALESCE(public.conversations.user_id, EXCLUDED.user_id),
        thread_id = COALESCE(public.conversations.thread_id, EXCLUDED.thread_id),
        -- Same rule: a conversation does not change between DM and group, so the
        -- first turn that knows wins. This is what backfills rows written before
        -- the column existed — they fill in on their next inbound message.
        is_direct = COALESCE(public.conversations.is_direct, EXCLUDED.is_direct),
        -- Opposite rule from is_direct: a channel CAN be renamed, and the label is
        -- re-resolved every turn, so the freshly resolved name wins. Falls back to
        -- the stored label only when this turn could not resolve one.
        location_label = COALESCE(EXCLUDED.location_label, public.conversations.location_label),
        updated_at = now()
    `;
	} catch (err) {
		logger.warn(
			{
				err,
				organizationId: row.organizationId,
				agentId: row.agentId,
				conversationId: row.conversationId,
			},
			"upsertConversation failed — listing row not materialized for this turn",
		);
	}
}

export interface ConversationListRow {
	platform: string;
	conversationId: string;
	/**
	 * Web route segment for an owned conversation. Platform rows route by
	 * `conversationId`; an owned row with null here is not listable.
	 */
	threadId: string | null;
	kind: ConversationKind;
	userId: string | null;
	title: string | null;
	locationLabel: string | null;
	/**
	 * Platform rows: true = 1:1 DM with the bot, false = group channel, null =
	 * unknown. A known DM may use the owner/admin bypass; otherwise the read path
	 * retains its channel-membership fence. Unknown stays fail-closed.
	 */
	isDirect: boolean | null;
	lastActivityAt: Date;
	createdAt: Date;
}

/**
 * Where this turn happened, as a human reads it: `#launch-room` for a channel,
 * the correspondent's name for a DM. Resolved from the channel's graphed
 * `$resource` entity — the SAME identity the ACL gate keys on — so the label is
 * connector-owned rather than parsed out of the conversation id. Null when the
 * channel has no graphed entity (never synced) or its name carries no
 * information; callers keep the previously stored label in that case.
 */
export async function resolveConversationLocationLabel(args: {
	organizationId: string;
	platform: string;
	teamId?: string | null;
	channelId: string;
	isDirect: boolean | null;
	senderDisplayName?: string | null;
}): Promise<string | null> {
	if (args.isDirect) return args.senderDisplayName?.trim() || null;
	const { namespace, key } = channelResourceIdentity(
		args.platform,
		args.teamId,
		args.channelId,
	);
	const sql = getDb();
	const rows = await sql<{ name: string | null }>`
    SELECT e.name FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id AND e.organization_id = ei.organization_id
    WHERE ei.organization_id = ${args.organizationId} AND ei.namespace = ${namespace}
      AND ei.identifier = ${key} AND ei.scope_key IS NULL
      AND ei.deleted_at IS NULL AND e.deleted_at IS NULL LIMIT 1
  `;
	const name = rows[0]?.name?.trim();
	if (!name) return null;
	// A channel entity graphed before its display name was known is named after
	// its own identifier (`resource_name: r.name ?? r.key` in access-graph,
	// `displayName ?? key` in ensureChannelResourceEntity). `#T0ABC:C0XYZ` is not
	// a location — treat an identifier-only name as unresolved so the row keeps
	// whatever label an earlier turn resolved.
	const upperKey = key.toUpperCase();
	const identifiers = new Set([upperKey, ...upperKey.split(":")]);
	if (identifiers.has(name.toUpperCase())) return null;
	return getPlatformDescriptor(args.platform)?.formatChannelLabel?.(name) ?? name;
}

/** Audience a conversation listing is built for. See {@link listConversations}. */
type ConversationListScope = "user" | "shared" | "admin";

/**
 * Look up a conversation by its STORED id, without knowing its platform.
 *
 * The read path addresses a conversation by the id the listing handed out, and
 * that id alone does not say which platform it belongs to — only the row does.
 * Callers use the returned `kind`/`userId` to apply the right fence: an owned
 * conversation is its owner's, a platform one is gated on channel visibility.
 * Deriving those facts by parsing the id string is what made owned
 * conversations unreadable in the first place.
 */
export async function findConversationById(args: {
	organizationId: string;
	agentId: string;
	conversationId: string;
}): Promise<ConversationListRow | null> {
	const { organizationId, agentId, conversationId } = args;
	const sql = getDb();
	const rows = await sql<{
		platform: string;
		conversation_id: string;
		thread_id: string | null;
		kind: ConversationKind;
		user_id: string | null;
		title: string | null;
		location_label: string | null;
		is_direct: boolean | null;
		last_activity_at: Date | null;
		created_at: Date;
	}>`
    SELECT platform, conversation_id, thread_id, kind, user_id, title, location_label,
           is_direct, last_activity_at, created_at
    FROM public.conversations
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND conversation_id = ${conversationId}
      AND archived_at IS NULL
    LIMIT 1
  `;
	const r = rows[0];
	if (!r) return null;
	return {
		platform: r.platform,
		conversationId: r.conversation_id,
		threadId: r.thread_id,
		kind: r.kind,
		userId: r.user_id,
		title: r.title,
		locationLabel: r.location_label,
		isDirect: r.is_direct,
		lastActivityAt: r.last_activity_at ?? r.created_at,
		createdAt: r.created_at,
	};
}

export async function getConversation(args: {
	organizationId: string;
	agentId: string;
	platform: string;
	conversationId: string;
}): Promise<ConversationListRow | null> {
	const { organizationId, agentId, platform, conversationId } = args;
	const sql = getDb();
	const rows = await sql<{
		platform: string;
		conversation_id: string;
		thread_id: string | null;
		kind: ConversationKind;
		user_id: string | null;
		title: string | null;
		location_label: string | null;
		is_direct: boolean | null;
		last_activity_at: Date | null;
		created_at: Date;
	}>`
    SELECT platform, conversation_id, thread_id, kind, user_id, title, location_label,
           is_direct, last_activity_at, created_at
    FROM public.conversations
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND platform = ${platform}
      AND conversation_id = ${conversationId}
      AND archived_at IS NULL
    LIMIT 1
  `;
	const r = rows[0];
	if (!r) return null;
	return {
		platform: r.platform,
		conversationId: r.conversation_id,
		threadId: r.thread_id,
		kind: r.kind,
		userId: r.user_id,
		title: r.title,
		locationLabel: r.location_label,
		isDirect: r.is_direct,
		lastActivityAt: r.last_activity_at ?? r.created_at,
		createdAt: r.created_at,
	};
}

/**
 * A turn's terminal outcome, read from the durable `runs` thread-response rows
 * the worker writes on completion. Cross-replica-safe (Postgres, not the
 * pod-local SSE buffer) — so `conversations.send({ wait: true })` can await a
 * reply without holding an SSE socket.
 */
export type ConversationReply =
	| { status: "complete"; text: string }
	| { status: "error"; error: string };

/**
 * Poll for the terminal outcome of a dispatched message. Matches the completion
 * row the worker writes to `public.runs` (queue_name='thread_response') whose
 * payload lists `messageId` in `processedMessageIds` (a turn can batch several).
 * Returns null while the turn is still in flight. `finalText` carries the full
 * assistant reply on the terminal row (see ThreadResponsePayload.finalText).
 */
export async function readConversationReply(args: {
	organizationId: string;
	conversationId: string;
	messageId: string;
}): Promise<ConversationReply | null> {
	const { organizationId, conversationId, messageId } = args;
	const sql = getDb();
	const rows = await sql<{ payload: Record<string, unknown> | null }>`
    WITH response_rows AS (
      SELECT id,
             CASE
               WHEN jsonb_typeof(action_input) = 'string'
                 THEN (action_input #>> '{}')::jsonb
               ELSE action_input
             END AS payload
      FROM public.runs
      WHERE organization_id = ${organizationId}
        AND run_type = 'chat_message'
        AND queue_name = 'thread_response'
        AND status IN ('completed', 'failed')
        AND action_input IS NOT NULL
    )
    SELECT payload
    FROM response_rows
    WHERE payload->>'conversationId' = ${conversationId}
      AND (
        payload->>'messageId' = ${messageId}
        OR payload->'processedMessageIds' ? ${messageId}
      )
      AND (payload ? 'error' OR payload ? 'processedMessageIds')
    ORDER BY id DESC
    LIMIT 1
  `;
	const payload = rows[0]?.payload;
	if (!payload || typeof payload !== "object") return null;
	if (typeof payload.error === "string" && payload.error.length > 0) {
		return { status: "error", error: payload.error };
	}
	const finalText =
		typeof payload.finalText === "string" ? payload.finalText : "";
	return { status: "complete", text: finalText };
}

/**
 * List an agent's conversations for the sidebar, newest-first. The single
 * listing source: reads the materialized entity instead of deriving from
 * `DISTINCT ON (conversation_id) FROM agent_transcript_snapshot`.
 *
 * Returns owned + platform rows; the caller layers on per-conversation
 * visibility (platform ACL) and stitches in the derived automation entries.
 */
export async function listConversations(args: {
	organizationId: string;
	agentId: string;
	/**
	 * Who the listing is for — NOT merely which kinds to include:
	 * - `"user"`: only this user's owned conversations.
	 * - `"shared"`: this user's owned conversations plus platform ones. Widening
	 *   to a channel is not widening to another person's private thread.
	 * - `"admin"`: every conversation in the org, including other users' owned
	 *   ones. Only for a caller whose admin/owner role has ALREADY been checked.
	 *
	 * `"shared"` and `"admin"` return the same platform rows and differ only on
	 * other users' owned rows, so the two must stay separate names: one label
	 * covering both is what let an authorization decision be made by a default.
	 */
	scope: ConversationListScope;
	userId: string;
}): Promise<ConversationListRow[]> {
	const { organizationId, agentId, scope, userId } = args;
	const sql = getDb();
	const rows = await sql<{
		platform: string;
		conversation_id: string;
		thread_id: string | null;
		kind: ConversationKind;
		user_id: string | null;
		title: string | null;
		location_label: string | null;
		is_direct: boolean | null;
		last_activity_at: Date | null;
		created_at: Date;
	}>`
    SELECT platform, conversation_id, thread_id, kind, user_id, title, location_label,
           is_direct, last_activity_at, created_at
    FROM public.conversations
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND archived_at IS NULL
      ${
				scope === "user"
					? sql`AND kind = 'owned' AND user_id = ${userId}`
					: scope === "shared"
						? // `shared` widens to platform conversations, NOT to other users'
							// private ones. An owned conversation belongs to whoever started
							// it; its title is message text, and the read path now addresses
							// a conversation by its stored id, so listing someone else's here
							// would hand out an id that is readable.
							sql`AND (kind <> 'owned' OR user_id = ${userId})`
						: // `admin`: no owner predicate at all. Reaching here means the
							// caller's admin/owner role was checked upstream.
							sql``
			}
    ORDER BY last_activity_at DESC NULLS LAST, created_at DESC
  `;
	return rows.map((r) => ({
		platform: r.platform,
		conversationId: r.conversation_id,
		threadId: r.thread_id,
		kind: r.kind,
		userId: r.user_id,
		title: r.title,
		locationLabel: r.location_label,
		isDirect: r.is_direct,
		lastActivityAt: r.last_activity_at ?? r.created_at,
		createdAt: r.created_at,
	}));
}
