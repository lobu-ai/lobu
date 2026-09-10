import { randomUUID } from "node:crypto";
import {
	type AdapterPostableMessage,
	type CardElement,
} from "chat";
import { loadConfiguredAutomationDeliveryTarget } from "../automations/delivery-target";
import {
	type DbClient,
	getDb,
	parsePgNumberArray,
	pgBigintArray,
	pgTextArray,
} from "../db/client";
import { resolveBoundChannelRows } from "../gateway/channels/bound-channels";
import { getChatInstanceManager, isLobuGatewayRunning } from "../lobu/gateway";
import type { McpActivityAttribution } from "../lobu/stores/mcp-client-conversations";
import { resolveSlackUserIdForUser } from "../lobu/stores/chat-identity.js";
import { resolveEventKindDefinition } from "../utils/event-kind-validation";
import { insertEvent } from "../utils/insert-event";
import { toAbsolutePermalink } from "../utils/url-builder";
import logger from "../utils/logger";
import { isUniqueViolation } from "../utils/pg-errors";
import { buildKindCard } from "./template-card";
import {
	addActionOrigin,
	actionResolutionText,
	type ActionOrigin,
	type ActionResolution,
	isCard,
	settleActionCard,
} from "./action-card-state";

interface CreateNotificationParams {
	organizationId: string;
	type:
		| "action_approval_needed"
		| "connection_permission_request"
		| "invitation_received"
		| "browser_auth_expired"
		| "generic"
		| "agent_message";
	title: string;
	body?: string | null;
	/**
	 * Event semantic type (kind) for the notification's content. When set, the
	 * event carries THIS semantic_type with an `empty` payload type, so the event-kind
	 * render tail synthesizes the render template from the kind's `jsonTemplate`
	 * (the same path every other `empty` event takes), and chat delivery builds
	 * its card from the same kind's `metadataSchema`. Omit for the default
	 * `notification` semantic type + plain text body.
	 *
	 * Setting this does not cost a notification its `notification` marker or its
	 * interaction supersede chain. Notification identity is row presence in
	 * `notification_targets`, not `semantic_type` (see content-search/params),
	 * and the interaction chain lives on the separate pending-approval event —
	 * this event carries no interaction fields at all.
	 */
	semanticType?: string;
	/** Structured payload bound to the event kind's render template. */
	payloadData?: Record<string, unknown>;
	/**
	 * Run this notification's card may decide, rendering Approve/Reject on the
	 * chat card. The click is authorized in the interaction bridge against a
	 * chat identity that maps to an org admin/owner — setting this does not by
	 * itself grant anyone the decision.
	 */
	decisionRunId?: number | null;
	resourceType?: string | null;
	resourceId?: string | null;
	resourceUrl?: string | null;
	browserUrl?: string | null;
	/** Page-activated action run that makes browserUrl actionable. */
	browserRunId?: number | null;
	/** Stable producer key used to collapse retried notification sends. */
	idempotencyKey?: string | null;
	/** When set, deliver only through this specific bot connection */
	connectionId?: string | null;
	/** When set, deliver only to this Automation-subscribed channel. */
	channelId?: string | null;
	/** Optional workspace/team guard for channel-scoped delivery. */
	teamId?: string | null;
	/**
	 * Who the chat fan-out may reach when no explicit target resolves.
	 *
	 * `"org"` (the default) keeps the org-wide broadcast every informational
	 * notification relies on: with no target, post into every channel any of the
	 * org's agents is bound to. `"targeted"` fails CLOSED — an unresolved target
	 * delivers to NO channel rather than everywhere.
	 *
	 * Approvals are `"targeted"`. An approval is a decision exactly one human
	 * makes, and `notification_targets` already addresses precisely the org's
	 * admins, so the durable inbox loses nothing when chat delivery is skipped —
	 * the run stays pending behind its approval URL either way. Broadcasting the
	 * operation name and a review link into every bound channel is pure noise
	 * plus needless disclosure.
	 */
	deliveryScope?: "targeted" | "org";
	/**
	 * Lobu user whose Slack DM is the first chat destination — the owner of the
	 * change under review (field-change approvals), or the requester of an
	 * approval that has no chat origin. When set, bot delivery tries their DM
	 * FIRST — resolved via
	 * the owner's workspace-scoped Slack identity — and only falls back
	 * to the configured-target/org-wide channel chain when the owner has no
	 * Slack identity or the DM fails. In-app inbox targeting is unaffected.
	 */
	ownerUserId?: string | null;
	/**
	 * Optional rich card (`chat` `CardElement`) for bot-connection delivery. When
	 * set, the bound channel gets this card instead of the markdown body; the
	 * in-app inbox entry still uses title/body.
	 */
	card?: CardElement | null;
	/**
	 * Optional entity ids to anchor the notification event to (e.g. an automation's
	 * source run, so the notification remains causally threaded). Stamped onto
	 * the notification event's `entity_ids`.
	 */
	entityIds?: number[];
	/** Exact MCP conversation or transport session that caused this notification. */
	mcpActivity?: McpActivityAttribution | null;
	/** Verified source shown on interactive cards and persisted for later edits. */
	actionOrigin?: ActionOrigin | null;
	/**
	 * The Automation run that emitted this notification, when one did.
	 *
	 * These MUST come from server-set context (`ctx.actingAutomationId` /
	 * `actingRunId`, stamped by the reaction executor), never from a caller-
	 * supplied `automation_source`. `automation_id` drives window self-exclusion, so
	 * an id a caller could choose would let one Automation hide rows from another
	 * Automation's input.
	 *
	 * Before this existed, a notification was written with no run and no
	 * Automation at all — prod notification 4858497 had `run_id` NULL while every
	 * sibling output of the same run carried 880183 — so the thing a user
	 * actually clicks could not be traced back to the run that sent it.
	 */
	automationId?: number | null;
	automationVersionId?: number | null;
	runId?: number | null;
}

/**
 * Forward a notification to the org's active chat-bot connections so it lands
 * in the bound channel — e.g. an automation digest posting to #leads.
 *
 * Resolves connections + their Automation subscriptions straight from Postgres and
 * posts in-process via the chat manager. Every app pod loads every active
 * connection at boot, so the locally-held instance can post regardless of
 * which pod fired the notification — correct under N>1 replicas, no cross-pod
 * routing needed.
 *
 * Best-effort: a connection with no live instance or no binding is skipped
 * without failing the others. A connection bound to several channels posts to
 * each.
 */
interface BotDeliveryTarget {
	connectionId: string;
	platform: string;
	/** Platform-prefixed channel id ready for `chat.channel()`, e.g. "slack:C0123ABCD". */
	channelKey: string;
	/** Workspace/team id from the subscription — keys the owner-DM identity lookup. */
	teamId: string | null;
}

/**
 * Resolve where a notification should be posted.
 *
 * Two branches, UNIONed:
 *
 *   (A) The org's OWN active chat connections JOINed to their subscriptions,
 *       scoped to (org, agent) — the multi-tenant default. A connection with no
 *       subscription has no target; several subscribed channels yield one
 *       target each.
 *
 *   (B) Hosted-preview cross-org delivery. The hosted preview bot is ONE
 *       connection living in its OWN org under a placeholder agent, that fans
 *       out to agents across MANY orgs — a `/lobu link <code>` writes the
 *       subscription under the claim's org, never the connection's. So branch (A)'s
 *       `(org, agent)` JOIN misses it on BOTH columns and proactive
 *       notifications silently drop. This branch resolves the org's bindings
 *       through the shared preview connection, mirroring the inbound
 *       concrete-connection routing. It is gated HARD to the single previewMode
 *       connection per platform and, when that connection is workspace-scoped,
 *       to bindings from the same workspace. It is NOT joined on `agent_id`, so
 *       the hosted connection's placeholder agent does not hide tenant bindings.
 *
 * A legacy tenantless hosted connection can serve all of its bindings. A
 * workspace-scoped hosted connection serves only bindings carrying that same
 * team id, so channel ids cannot collide across workspaces.
 *
 * Exported for testing the delivery path against a real DB.
 */
export async function resolveBotDeliveryTargets(
	organizationId: string,
	opts?:
		| string
		| null
		| {
				connectionId?: string | null;
				channelId?: string | null;
				teamId?: string | null;
		  },
): Promise<BotDeliveryTarget[]> {
	const connectionId =
		typeof opts === "string" || opts === null ? opts : opts?.connectionId;
	const channelId =
		typeof opts === "object" && opts !== null ? opts.channelId : null;
	const teamId = typeof opts === "object" && opts !== null ? opts.teamId : null;
	// Org-wide (no agentId): every channel any of the org's agents is bound to,
	// resolved through the right connection. Shared resolver = one home for the
	// cross-org preview invariant (see bound-channels.ts).
	const rows = await resolveBoundChannelRows(getDb(), {
		organizationId,
		connectionId,
	});

	const normalizedChannelId = channelId
		? channelId.includes(":")
			? channelId
			: null
		: null;

	return rows
		.filter((row) => {
			if (teamId && row.team_id !== teamId) return false;
			if (!channelId) return true;
			const rowChannelKey = row.channel_id.includes(":")
				? row.channel_id
				: `${row.platform}:${row.channel_id}`;
			const requestedChannelKey =
				normalizedChannelId ?? `${row.platform}:${channelId}`;
			return (
				row.channel_id === channelId || rowChannelKey === requestedChannelKey
			);
		})
		.map((row) => ({
			connectionId: row.id,
			platform: row.platform,
			// Bindings store the platform-prefixed id ("slack:C0123ABCD"); older rows
			// may hold the bare id, so prefix defensively.
			channelKey: row.channel_id.includes(":")
				? row.channel_id
				: `${row.platform}:${row.channel_id}`,
			teamId: row.team_id,
		}));
}

export async function resolveNotificationDeliveryPlan(params: {
	organizationId: string;
	automationId?: number | null;
	connectionId?: string | null;
	channelId?: string | null;
	teamId?: string | null;
	/** See `CreateNotificationParams.deliveryScope`. Defaults to `"org"`. */
	deliveryScope?: "targeted" | "org";
}): Promise<{ strictAutomationTarget: boolean; targets: BotDeliveryTarget[] }> {
	const configuredAutomationTarget =
		params.automationId == null
			? { configured: false, target: null }
			: await loadConfiguredAutomationDeliveryTarget(
					getDb(),
					params.organizationId,
					params.automationId,
				);
	if (configuredAutomationTarget.configured) {
		if (!configuredAutomationTarget.target) {
			return { strictAutomationTarget: true, targets: [] };
		}
		return {
			strictAutomationTarget: true,
			targets: await resolveBotDeliveryTargets(params.organizationId, {
				connectionId: configuredAutomationTarget.target.connectionId,
				channelId: configuredAutomationTarget.target.channelId,
				teamId: configuredAutomationTarget.target.teamId,
			}),
		};
	}

	const targeted = params.deliveryScope === "targeted";
	const hasExplicitTarget = Boolean(
		params.connectionId || params.channelId || params.teamId,
	);
	// Targeted with nothing to target: skip the resolve entirely. Calling the
	// org-wide resolver here and discarding the rows would read as an oversight
	// the next time someone edits this branch.
	if (targeted && !hasExplicitTarget) {
		return { strictAutomationTarget: false, targets: [] };
	}

	let targets = await resolveBotDeliveryTargets(params.organizationId, {
		connectionId: params.connectionId,
		channelId: params.channelId,
		teamId: params.teamId,
	});
	if (targets.length === 0 && hasExplicitTarget) {
		if (targeted) {
			// A stale/unbound target on a targeted notification means "nobody",
			// never "everybody" — the org-wide fallback below would turn a
			// deleted channel into an org-wide broadcast of an approval.
			logger.warn(
				{
					organizationId: params.organizationId,
					connectionId: params.connectionId,
					channelId: params.channelId,
					teamId: params.teamId,
				},
				"[Notifications] Targeted delivery resolved to no bound channels — skipping chat delivery",
			);
			return { strictAutomationTarget: false, targets: [] };
		}
		logger.warn(
			{
				organizationId: params.organizationId,
				connectionId: params.connectionId,
				channelId: params.channelId,
				teamId: params.teamId,
			},
			"[Notifications] Configured delivery target resolved to no bound channels — falling back to org-wide delivery",
		);
		targets = await resolveBotDeliveryTargets(params.organizationId, null);
	}
	return { strictAutomationTarget: false, targets };
}

/**
 * Owner-routed delivery target: the Slack identity of `ownerUserId` in a
 * workspace one of the org's bot connections lives in. Reverse-looks-up
 * the workspace-scoped Slack identity on the owner's `$member` (team matching
 * the connection's binding team) per candidate connection, most-recently-bound first via
 * resolveBotDeliveryTargets order. Null when the owner has no Slack identity in
 * any connected workspace — the caller falls back to channel delivery.
 * Exported for testing the tier-selection logic against a real DB.
 */
export async function resolveOwnerDmTarget(
	organizationId: string,
	ownerUserId: string,
	connectionId?: string | null,
): Promise<{ connectionId: string; slackUserId: string } | null> {
	const targets = await resolveBotDeliveryTargets(
		organizationId,
		connectionId ?? null,
	);
	const seen = new Set<string>();
	for (const target of targets) {
		if (target.platform !== "slack" || target.teamId == null) continue;
		const key = `${target.connectionId}:${target.teamId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const slackUserId = await resolveSlackUserIdForUser(
			ownerUserId,
			target.teamId,
		);
		if (slackUserId) {
			return { connectionId: target.connectionId, slackUserId };
		}
	}
	return null;
}

/**
 * The org's URL slug, for building a permalink to a notification.
 *
 * Shared by the trigger fan-out and the `notify` tool so both link into the
 * same place; `buildResourcePermalink` returns undefined without it.
 */
export async function getOrgSlug(
	organizationId: string,
): Promise<string | null> {
	const sql = getDb();
	const rows = await sql<{ slug: string }>`
    SELECT slug FROM "organization" WHERE id = ${organizationId} LIMIT 1
  `;
	return rows[0]?.slug ?? null;
}

/**
 * Resolve the notification event a producer key already claimed, if any.
 *
 * Reads the partial unique index `idx_events_org_idempotency_key` directly, so
 * it is the same key the insert races on — no second notion of "already sent".
 * Exported for the `notify` tool, which must resolve a repeat BEFORE queueing
 * an ask's pending run — after the fact, the orphan run is already durable.
 */
export async function findNotificationByIdempotencyKey(
	organizationId: string,
	idempotencyKey: string,
): Promise<number | null> {
	const sql = getDb();
	const rows = (await sql`
    SELECT id
    FROM events
    WHERE organization_id = ${organizationId}
      AND metadata ? '_lobu_idempotency_key'
      AND metadata->>'_lobu_idempotency_key' = ${idempotencyKey}
    LIMIT 1
  `) as unknown as Array<{ id: number }>;
	const id = rows[0]?.id;
	return id === undefined ? null : Number(id);
}

/**
 * Where one copy of a notification physically landed on a chat platform.
 *
 * Recorded so a later state change can EDIT that message in place
 * (`ChatInstanceManager.editMessage` addresses a message by
 * `(threadId, messageId)`) and so an agent's follow-up can reply into the same
 * thread. Both need the ids the post returned, and nothing else persists them —
 * `channel_messages` is keyed on the platform message id with no link back to
 * the notification, so it cannot answer "where did notification N go?".
 *
 * Durable rather than in-memory on purpose: the pod that edits or replies is
 * frequently not the pod that posted.
 */
interface NotificationDeliveryRecord {
	connectionId: string;
	/** Platform-prefixed channel id, or `dm` for the owner-routed tier. */
	channelKey: string;
	/** Trusted flat conversation id; present for conversation-scoped delivery. */
	conversationId?: string;
	messageId: string;
	threadId: string;
}

/**
 * Delivery metadata read back from `events`. Readers validate only the
 * addressing triple because every consumer can address the message without a
 * channel key; preserve `channelKey` when the stored JSON includes it.
 */
type PersistedNotificationDeliveryRecord = Omit<
	NotificationDeliveryRecord,
	"channelKey"
> & {
	channelKey?: string;
};

/**
 * Stamp where the notification was delivered onto the event that represents it.
 *
 * Post-hoc metadata UPDATE, matching the routing stamp in
 * `gateway/routes/internal/interactions.ts`: `events` is append-only for
 * DELETE, and this touches delivery metadata only — never payload. It has to
 * run after the fan-out because the platform ids do not exist until the post
 * returns, and the durable notification write must not block on a best-effort
 * chat post.
 *
 * Best-effort by default: losing the record costs a later in-place edit, not
 * the notification itself. `present_event` opts into required persistence
 * because the pointer drives in-place refresh and deduplicates later calls.
 */
async function persistDeliveryMetadata(
	eventId: number,
	deliveries: PersistedNotificationDeliveryRecord[],
	card?: CardElement,
	options?: { db?: DbClient; required?: boolean },
): Promise<void> {
	// A record exists to be addressed later, and `editMessage(threadId, messageId)`
	// cannot address an empty id — an adapter that returned no message id has
	// given us nothing to point at. Dropping it here rather than at each caller
	// keeps the one rule in the one place that writes the record.
	const addressable = deliveries.filter((entry) => entry.messageId !== "");
	if (addressable.length === 0) {
		if (options?.required) {
			throw new Error("Delivery did not return an addressable message id");
		}
		return;
	}
	const db = options?.db ?? getDb();
	try {
		const deliveryMetadata = {
			delivery: addressable,
			...(card ? { card } : {}),
		};
		const updated = await db<{ id: number }>`
      UPDATE events
      SET metadata = coalesce(metadata, '{}'::jsonb)
        || ${db.json(deliveryMetadata)}::jsonb
      WHERE id = ${eventId}
      RETURNING id
    `;
		if (options?.required && updated.length === 0) {
			throw new Error(
				`Event ${eventId} vanished before delivery metadata persisted`,
			);
		}
	} catch (err) {
		if (options?.required) throw err;
		logger.warn(
			{ err, eventId },
			"[Notifications] Failed to record delivery targets",
		);
	}
}

type StoredEventPresentationResult =
	| {
			ok: true;
			messageId: string;
			threadId: string;
			fallbackText: string;
	  }
	| {
			ok: false;
			reason: "not_found" | "not_renderable" | "gateway_unavailable";
	  };

interface StoredEventPresentationParams {
	organizationId: string;
	eventId: number;
	connectionId: string;
	platform: string;
	channelId: string;
	channelKey: string;
	conversationId: string;
	threadId?: string;
}

/**
 * Render one already-persisted event into the conversation that invoked the
 * current agent turn.
 *
 * The event is the authority: the worker supplies only its id, while the
 * server re-reads the tenant-scoped row, resolves the linked entity kind, and
 * derives the native card from that kind's json_template. The worker never
 * supplies a template, executable handler, action id, actor id, or platform
 * destination. The destination coordinates are signed worker-token claims.
 *
 * Persisting the platform message pointer on the SAME event gives the durable
 * interactive-card refresh task the routing data used for in-place updates.
 */
export async function presentStoredEventToConversation(
	params: StoredEventPresentationParams,
): Promise<StoredEventPresentationResult> {
	return getDb().begin((sql) =>
		presentStoredEventToConversationLocked(params, sql),
	);
}

async function presentStoredEventToConversationLocked(
	params: StoredEventPresentationParams,
	sql: DbClient,
): Promise<StoredEventPresentationResult> {
	const [row] = await sql<{
		title: string | null;
		entity_ids: unknown;
		semantic_type: string;
		payload_text: string | null;
		payload_data: unknown;
		metadata: unknown;
		source_url: string | null;
		superseded_by: number | null;
	}>`
    SELECT title, entity_ids, semantic_type, payload_text, payload_data,
           metadata, source_url, superseded_by
    FROM events
    WHERE id = ${params.eventId}
      AND organization_id = ${params.organizationId}
    LIMIT 1
    FOR UPDATE
  `;
	if (!row || row.superseded_by !== null) {
		return { ok: false, reason: "not_found" };
	}

	const metadata = jsonRecord(row.metadata);
	const fallbackText = row.payload_text
		? `${row.title ?? row.semantic_type}\n\n${row.payload_text}`
		: row.title ?? row.semantic_type;
	// The row lock serializes concurrent retries across replicas. A completed
	// presentation already has everything a retry needs, so replay it before
	// resolving a template that may have changed since the original post.
	const existingDelivery = deliveryRecords(metadata).find(
		(delivery) =>
			delivery.connectionId === params.connectionId &&
			delivery.channelKey === params.channelKey &&
			delivery.conversationId === params.conversationId,
	);
	if (existingDelivery) {
		return {
			ok: true,
			messageId: existingDelivery.messageId,
			threadId: existingDelivery.threadId,
			fallbackText,
		};
	}

	const kind = await resolveEventKindDefinition(
		row.semantic_type,
		params.organizationId,
		parsePgNumberArray(row.entity_ids),
	);
	// `present_event` is deliberately narrower than the ordinary Activity view:
	// only an explicitly authored portable template may become an unsolicited
	// native chat card. A schema-derived fallback is useful in the web UI, but it
	// is not an authored chat presentation contract.
	if (!kind?.jsonTemplate) return { ok: false, reason: "not_renderable" };

	const data =
		typeof metadata.notification_type === "string"
			? jsonRecord(row.payload_data)
			: metadata;
	const card = buildKindCard({
		metadataSchema: kind.metadataSchema,
		jsonTemplate: kind.jsonTemplate,
		data,
		title: row.title ?? row.semantic_type,
		body: row.payload_text ?? undefined,
		url: toAbsolutePermalink(
			typeof metadata.resource_url === "string"
				? metadata.resource_url
				: row.source_url ?? undefined,
		),
		sourceEventId: params.eventId,
		interactions: kind.interactions,
	});
	if (!card) return { ok: false, reason: "not_renderable" };

	const manager = getChatInstanceManager();
	if (!manager) return { ok: false, reason: "gateway_unavailable" };
	const sent = await manager.postToConversation(params.connectionId, {
		platform: params.platform,
		channelKey: params.channelKey,
		channelId: params.channelId,
		threadId: params.threadId,
		content: { card, fallbackText },
		subscribe: true,
	});
	await persistDeliveryMetadata(
		params.eventId,
		[
			...deliveryRecords(metadata),
			{
				connectionId: params.connectionId,
				channelKey: params.channelKey,
				conversationId: params.conversationId,
				messageId: sent.messageId,
				threadId: sent.threadId,
			},
		],
		card,
		{ db: sql, required: true },
	);
	return {
		ok: true,
		messageId: sent.messageId,
		threadId: sent.threadId,
		fallbackText,
	};
}

async function recordDeliveryError(
	eventId: number,
	code: "automation_target_unavailable" | "automation_target_post_failed",
): Promise<void> {
	try {
		const sql = getDb();
		await sql`
      UPDATE events
      SET metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object(
          'delivery_error',
          jsonb_build_object('code', ${code}, 'recorded_at', NOW())
        )
      WHERE id = ${eventId}
    `;
	} catch (err) {
		logger.warn(
			{ err, eventId, code },
			"[Notifications] Failed to record delivery error",
		);
	}
}

function jsonRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function deliveryRecords(
	metadata: Record<string, unknown>,
): PersistedNotificationDeliveryRecord[] {
	return (Array.isArray(metadata.delivery) ? metadata.delivery : []).flatMap(
		(entry) => {
			const row = jsonRecord(entry);
			const connectionId = row.connectionId;
			const channelKey = row.channelKey;
			const conversationId = row.conversationId;
			const messageId = row.messageId;
			const threadId = row.threadId;
			return typeof connectionId === "string" &&
				typeof messageId === "string" &&
				messageId !== "" &&
				typeof threadId === "string"
				? [{
						connectionId,
						...(typeof channelKey === "string" ? { channelKey } : {}),
						...(typeof conversationId === "string" ? { conversationId } : {}),
						messageId,
						threadId,
					}]
				: [];
		},
	);
}

type StoredApprovalNotification = {
	run_id: number;
	title: string;
	metadata: unknown;
	approval_status: string;
	resolved_at: string | Date | null;
	decision_metadata: unknown;
};

/**
 * Edit every persisted chat copy of a resolved approval. This runs after the
 * shared durable manage_operations transition, so a decision made in Slack,
 * the web app, or MCP settles the same original card on every platform.
 */
export async function refreshApprovalNotificationCards(
	organizationId: string,
	runIds: number[],
): Promise<void> {
	const ids = [
		...new Set(runIds.filter((id) => Number.isSafeInteger(id) && id > 0)),
	];
	if (ids.length === 0) return;
	const manager = getChatInstanceManager();
	if (!manager) return;
	const rows = await getDb()<StoredApprovalNotification>`
		SELECT
			r.id AS run_id,
			n.title,
			n.metadata,
			r.approval_status,
			COALESCE(
				decision.metadata->>'reviewed_at',
				decision.occurred_at::text,
				r.completed_at::text
			) AS resolved_at,
			decision.metadata AS decision_metadata
		FROM runs r
		JOIN events proposal
		  ON proposal.organization_id = r.organization_id
		 AND proposal.run_id = r.id
		 AND proposal.interaction_type = 'approval'
		JOIN events n
		  ON n.organization_id = r.organization_id
		 AND COALESCE(n.metadata->>'notification_type', 'generic') = 'action_approval_needed'
		 AND n.metadata->>'resource_type' = 'event'
		 AND n.metadata->>'resource_id' = proposal.id::text
		LEFT JOIN LATERAL (
			SELECT d.occurred_at, d.metadata
			FROM current_event_records d
			WHERE d.organization_id = r.organization_id
			  AND d.run_id = r.id
			  AND d.interaction_type = 'approval'
			ORDER BY d.occurred_at DESC, d.id DESC
			LIMIT 1
		) decision ON true
		WHERE r.organization_id = ${organizationId}
		  AND r.id = ANY(${pgBigintArray(ids)}::bigint[])
		  AND r.approval_status IN ('approved', 'rejected', 'expired')
	`;

	const edits: Promise<void>[] = [];
	for (const row of rows) {
		const metadata = jsonRecord(row.metadata);
		if (!isCard(metadata.card)) continue;
		const decisionMetadata = jsonRecord(row.decision_metadata);
		const expiredDetail =
			typeof decisionMetadata.expiry_reason === "string"
				? decisionMetadata.expiry_reason
				: typeof decisionMetadata.reason === "string"
					? decisionMetadata.reason
					: null;
		const resolution: ActionResolution = {
			status:
				row.approval_status === "approved"
					? "approved"
					: row.approval_status === "expired"
						? "expired"
						: "rejected",
			actorName:
				typeof decisionMetadata.reviewed_by_name === "string"
					? decisionMetadata.reviewed_by_name
					: null,
			resolvedAt: row.resolved_at,
			detail: row.approval_status === "expired" ? expiredDetail : null,
		};
		const settled = settleActionCard(metadata.card, resolution);
		const content: AdapterPostableMessage = {
			card: settled,
			fallbackText: `${row.title}\n${actionResolutionText(resolution)}`,
		};
		for (const delivery of deliveryRecords(metadata)) {
			edits.push(
				manager
					.editMessageContent(delivery.connectionId, {
						threadId: delivery.threadId,
						messageId: delivery.messageId,
						content,
					})
					.catch((err: unknown) => {
						logger.warn(
							{
								err,
								runId: row.run_id,
								connectionId: delivery.connectionId,
							},
							"[Notifications] Failed to settle approval card",
						);
					}),
			);
		}
	}
	await Promise.all(edits);
}

/** Best-effort post-commit refresh used by every approval terminalizer. */
export function queueApprovalNotificationCardRefresh(
	organizationId: string,
	runIds: number[],
): void {
	void refreshApprovalNotificationCards(organizationId, runIds).catch((err) =>
		logger.warn(
			{ err, organizationId, runIds },
			"[Notifications] Failed to settle approval cards",
		),
	);
}

export interface InteractiveEventCardRefreshTaskPayload {
	organizationId: string;
	replacementEventId: number;
}

/**
 * Refresh every persisted copy of an interactive event at the newest live
 * successor in its chain.
 *
 * Tasks commit atomically with successor events. The advisory lock serializes
 * old/new tasks across pods, and each task resolves the live head only after it
 * acquires that lock. An older delayed task can therefore repeat the newest
 * edit, but cannot move a card back to stale controls. Gateway, edit, and
 * metadata failures throw so the shared runs queue retries them.
 */
export async function refreshInteractiveEventCardTask(
	payload: InteractiveEventCardRefreshTaskPayload,
): Promise<void> {
	if (
		typeof payload.organizationId !== "string" ||
		payload.organizationId === "" ||
		!Number.isSafeInteger(payload.replacementEventId) ||
		payload.replacementEventId <= 0
	) {
		throw new Error("Invalid interactive event card refresh task payload");
	}
	const manager = getChatInstanceManager();
	if (!manager) throw new Error("Chat gateway is unavailable");
	await getDb().begin(async (sql) => {
		const [root] = await sql<{ id: number }>`
      WITH RECURSIVE ancestry AS (
        SELECT id, supersedes_event_id
        FROM events
        WHERE id = ${payload.replacementEventId}
          AND organization_id = ${payload.organizationId}
        UNION ALL
        SELECT parent.id, parent.supersedes_event_id
        FROM events parent
        JOIN ancestry child ON child.supersedes_event_id = parent.id
        WHERE parent.organization_id = ${payload.organizationId}
      )
      SELECT id FROM ancestry
      WHERE supersedes_event_id IS NULL
      LIMIT 1
    `;
		if (!root) return;
		await sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`interactive-event-card:${payload.organizationId}:${root.id}`}, 0)
      )
    `;
		const chain = await sql<{
			id: number;
			title: string | null;
			entity_ids: unknown;
			semantic_type: string;
			payload_text: string | null;
			payload_data: unknown;
			metadata: unknown;
			supersedes_event_id: number | null;
		}>`
      WITH RECURSIVE event_chain AS (
        SELECT id, supersedes_event_id, title, entity_ids,
               semantic_type, payload_text, payload_data, metadata, 0 AS depth
        FROM events
        WHERE id = ${root.id}
          AND organization_id = ${payload.organizationId}
        UNION ALL
        SELECT successor.id, successor.supersedes_event_id, successor.title,
               successor.entity_ids, successor.semantic_type,
               successor.payload_text, successor.payload_data,
               successor.metadata, event_chain.depth + 1
        FROM events successor
        JOIN event_chain ON successor.supersedes_event_id = event_chain.id
        WHERE successor.organization_id = ${payload.organizationId}
      )
      SELECT id, supersedes_event_id, title, entity_ids,
             semantic_type, payload_text, payload_data, metadata
      FROM event_chain
      ORDER BY depth
  `;
		const row = chain.at(-1);
		if (!row) return;
		const deliveredSource = chain.find(
			(event) => deliveryRecords(jsonRecord(event.metadata)).length > 0,
		);
		if (!deliveredSource) return;
		const sourceMetadata = jsonRecord(deliveredSource.metadata);
		const deliveries = [
			...new Map(
				chain.flatMap((event) =>
					deliveryRecords(jsonRecord(event.metadata)).map((delivery) => [
						`${delivery.connectionId}\u0000${delivery.threadId}\u0000${delivery.messageId}`,
						delivery,
					] as const),
				),
			).values(),
		];
		if (deliveries.length === 0) return;
		const sourceKind = await resolveEventKindDefinition(
			deliveredSource.semantic_type,
			payload.organizationId,
			parsePgNumberArray(deliveredSource.entity_ids),
		);
		if (
			!sourceKind?.interactions ||
			Object.keys(sourceKind.interactions).length === 0
		) {
			return;
		}

		const entityIds = parsePgNumberArray(row.entity_ids);
		const kind = await resolveEventKindDefinition(
			row.semantic_type,
			payload.organizationId,
			entityIds,
		);
		if (!kind) {
			throw new Error(`Event kind ${row.semantic_type} is unavailable`);
		}
		const metadata = jsonRecord(row.metadata);
		const data =
			typeof metadata.notification_type === "string"
				? jsonRecord(row.payload_data)
				: metadata;
		const card = buildKindCard({
			metadataSchema: kind.metadataSchema,
			jsonTemplate: kind.jsonTemplate,
			data,
			title: row.title ?? row.semantic_type,
			body: row.payload_text ?? undefined,
			url: toAbsolutePermalink(
				typeof metadata.resource_url === "string"
					? metadata.resource_url
					: typeof sourceMetadata.resource_url === "string"
						? sourceMetadata.resource_url
						: undefined,
			),
			sourceEventId: row.id,
			interactions: kind.interactions,
		});
		if (!card) throw new Error(`Event ${row.id} is not renderable`);
		const content: AdapterPostableMessage = {
			card,
			fallbackText: row.payload_text
				? `${row.title ?? row.semantic_type}\n\n${row.payload_text}`
				: row.title ?? row.semantic_type,
		};
		await Promise.all(
			deliveries.map((delivery) =>
				manager.editMessageContent(delivery.connectionId, {
					threadId: delivery.threadId,
					messageId: delivery.messageId,
					content,
				}),
			),
		);
		// Carry the delivery pointer to an interactive successor for observability
		// and presentation retries. A terminal successor has no future refresh hop.
		if (kind.interactions && Object.keys(kind.interactions).length > 0) {
			await persistDeliveryMetadata(row.id, deliveries, card, {
				db: sql,
				required: true,
			});
		}
	});
}

/**
 * Build the chat card for a notification from its event kind.
 *
 * Only kind-bearing notifications qualify: without a `semanticType` there is no
 * kind to resolve, which is exactly the plain-text case. Resolution failure is
 * never fatal — the caller falls back to the markdown body, so a missing kind
 * costs formatting, never delivery.
 */
export async function resolveNotificationKindCard(
	params: Omit<CreateNotificationParams, "userId">,
	eventId: number,
): Promise<CardElement | null> {
	if (!params.semanticType) return null;
	try {
		const kind = await resolveEventKindDefinition(
			params.semanticType,
			params.organizationId,
			params.entityIds,
		);
		if (!kind) return null;
		return buildKindCard({
			metadataSchema: kind.metadataSchema,
			jsonTemplate: kind.jsonTemplate,
			data: params.payloadData ?? {},
			title: params.title,
			body: params.body ?? undefined,
			// Chat has no origin to resolve against, and Slack answers a relative
			// button url with `invalid_blocks` — dropping the entire message, not
			// just the button. The stored `resource_url` stays relative for the
			// inbox; only the card gets the absolute form.
			url: toAbsolutePermalink(params.resourceUrl),
			decisionRunId: params.decisionRunId,
			sourceEventId: eventId,
			interactions: kind.interactions,
		});
	} catch (err) {
		logger.warn(
			{ err, semanticType: params.semanticType, orgId: params.organizationId },
			"[Notifications] Could not build the event kind card for chat — falling back to text",
		);
		return null;
	}
}

async function deliverToBotConnections(
	params: Omit<CreateNotificationParams, "userId">,
	eventId: number,
): Promise<void> {
	if (!isLobuGatewayRunning()) return;
	const manager = getChatInstanceManager();
	if (!manager) return;

	const text = params.body ? `${params.title}\n\n${params.body}` : params.title;
	// Card precedence, richest first:
	//   1. an explicit `card` — the caller built it, so it wins outright;
	//   2. the notification's own event kind, whose render template gives chat
	//      the same content the Memory view shows. This is what stops a caller
	//      authoring its content twice (`payloadData` for web, a hand-built card
	//      for chat) and drifting between them;
	//   3. the markdown body.
	const baseCard = params.card ?? (await resolveNotificationKindCard(params, eventId));
	const card = baseCard ? addActionOrigin(baseCard, params.actionOrigin) : null;
	const content = card ? { card } : { markdown: text };
	const deliveryPlan = await resolveNotificationDeliveryPlan({
		organizationId: params.organizationId,
		automationId: params.automationId,
		connectionId: params.connectionId,
		channelId: params.channelId,
		teamId: params.teamId,
		deliveryScope: params.deliveryScope,
	});
	if (deliveryPlan.strictAutomationTarget && deliveryPlan.targets.length === 0) {
		logger.error(
			{
				organizationId: params.organizationId,
				automationId: params.automationId,
			},
			"[Notifications] Automation delivery target is unavailable — refusing org-wide fallback",
		);
		await recordDeliveryError(eventId, "automation_target_unavailable");
		return;
	}

	// Owner-routed tier: an approval whose gated fields have ONE human owner
	// goes to that owner's Slack DM first (same card, same approve/reject
	// buttons — the interaction bridge is connection-scoped, so clicks route
	// identically). Any miss — no identity row, DM open/post failure — logs and
	// falls through to the configured-target/org-wide chain unchanged.
	if (params.ownerUserId && !deliveryPlan.strictAutomationTarget) {
		try {
			const dm = await resolveOwnerDmTarget(
				params.organizationId,
				params.ownerUserId,
				params.connectionId,
			);
			if (dm) {
				const sent = await manager.postDirectMessage(
					dm.connectionId,
					dm.slackUserId,
					content,
				);
				await persistDeliveryMetadata(
					eventId,
					[
						{
							connectionId: dm.connectionId,
							channelKey: "dm",
							messageId: sent.messageId,
							threadId: sent.threadId,
						},
					],
					card ?? undefined,
				);
				return;
			}
			logger.warn(
				{ organizationId: params.organizationId, ownerUserId: params.ownerUserId },
				"[Notifications] Approval owner has no Slack identity in a connected workspace — falling back to channel delivery",
			);
		} catch (err) {
			logger.warn(
				{
					err,
					organizationId: params.organizationId,
					ownerUserId: params.ownerUserId,
				},
				"[Notifications] Owner DM delivery failed — falling back to channel delivery",
			);
		}
	}

	try {
		const targets = deliveryPlan.targets;
		if (targets.length === 0) return;

		const posted = await Promise.allSettled(
			targets.map(
				async ({
					connectionId,
					channelKey,
				}): Promise<NotificationDeliveryRecord> => {
					const sent = await manager.postMessageToChannel(
						connectionId,
						channelKey,
						content,
					);
					return {
						connectionId,
						channelKey,
						messageId: sent.messageId,
						threadId: sent.threadId,
					};
				},
			),
		);
		const delivered: NotificationDeliveryRecord[] = [];
		posted.forEach((result, index) => {
			if (result.status === "fulfilled") {
				delivered.push(result.value);
				return;
			}
			logger.warn(
				{
					err: result.reason,
					connectionId: targets[index]?.connectionId,
					channelKey: targets[index]?.channelKey,
				},
				"[Notifications] Failed to post to bot connection channel",
			);
		});
		await persistDeliveryMetadata(eventId, delivered, card ?? undefined);
		if (deliveryPlan.strictAutomationTarget && delivered.length === 0) {
			await recordDeliveryError(eventId, "automation_target_post_failed");
		}
	} catch (err) {
		logger.warn(
			{ err },
			"[Notifications] Failed to deliver to bot connections",
		);
	}
}

/**
 * Notifications are events + per-user targets.
 *
 * The `events` table stores the notification's content (org-wide visibility,
 * searchable, addressable from the knowledge view); `notification_targets`
 * scopes inbox / read-state to the addressed users. "Send to admins" inserts
 * ONE event + N targets; "mark read" updates a target row; "unread count"
 * counts target rows without `read_at`.
 *
 * The legacy public.notifications table was migrated into events and dropped;
 * that migration is now folded into the baseline schema.
 */
export async function createNotificationForUsers(
	userIds: string[],
	params: Omit<CreateNotificationParams, "userId">,
): Promise<{ created: boolean; eventId: number | null }> {
	if (userIds.length === 0) return { created: false, eventId: null };
	const sql = getDb();

	const metadata: Record<string, unknown> = {
		notification_type: params.type,
		resource_type: params.resourceType ?? null,
		resource_id: params.resourceId ?? null,
		resource_url: params.resourceUrl ?? null,
		browser_url: params.browserUrl ?? null,
		browser_handoff_run_id: params.browserRunId ?? null,
		// Persisted, not just handed to the fan-out: the card IS the notification's
		// rendered form, and a connection that was offline at send time (or a
		// surface that renders it later) has no other way to recover it.
		...(params.card ? { card: params.card } : {}),
		...(params.idempotencyKey
			? { _lobu_idempotency_key: params.idempotencyKey }
			: {}),
		...(params.mcpActivity?.transportSessionId
			? { mcp_session_id: params.mcpActivity.transportSessionId }
			: {}),
		...(params.mcpActivity?.hostConversationId
			? { mcp_conversation_id: params.mcpActivity.hostConversationId }
			: {}),
	};

	// Idempotent repeat: hand back the durable event the first send landed, so a
	// retry still resolves to a usable id/url instead of an empty success.
	// Preflight read + unique-index catch below, exactly as save_content does —
	// `insertEvent` has no ON CONFLICT of its own.
	if (params.idempotencyKey) {
		const prior = await findNotificationByIdempotencyKey(
			params.organizationId,
			params.idempotencyKey,
		);
		if (prior !== null) return { created: false, eventId: prior };
	}

	let eventId: number;
	try {
		eventId = (await sql.begin(async (tx) => {
			const event = await insertEvent(
				{
					entityIds: params.entityIds ?? [],
					organizationId: params.organizationId,
					// Notifications are minted here, not synced from a source, so there
					// is no upstream identity to carry. A fresh uuid gives every
					// notification the stable identity the events contract expects
					// without pretending the producer key is a source id.
					originId: randomUUID(),
					title: params.title,
					content: params.body ?? null,
					semanticType: params.semanticType ?? "notification",
					payloadType: params.semanticType ? "empty" : "text",
					payloadData: params.semanticType ? params.payloadData : undefined,
					metadata,
					clientId: params.mcpActivity?.clientId ?? null,
					runId: params.runId ?? null,
					automationId: params.automationId ?? null,
					automationVersionId: params.automationVersionId ?? null,
				},
				{ sql: tx },
			);

			await tx`
      INSERT INTO notification_targets (event_id, user_id, browser_url, browser_run_id)
      SELECT ${event.id}, uid, ${params.browserUrl ?? null}, ${params.browserRunId ?? null}
      FROM unnest(${pgTextArray(userIds)}::text[]) AS u(uid)
      ON CONFLICT DO NOTHING
    `;
			return event.id;
		})) as number;
	} catch (error) {
		// Two replicas may race past the preflight read. The unique index is the
		// lock; the loser resolves and returns the winner's durable event.
		if (
			params.idempotencyKey &&
			isUniqueViolation(error, "idx_events_org_idempotency_key")
		) {
			const winner = await findNotificationByIdempotencyKey(
				params.organizationId,
				params.idempotencyKey,
			);
			if (winner === null) throw error;
			return { created: false, eventId: winner };
		}
		throw error;
	}

	// Deliver to bot connections (fire-and-forget). The bot delivery targets
	// the org's connection default channels and is identical for every user in
	// this call, so fan it out once — not once per user.
	deliverToBotConnections(params, eventId).catch((err) =>
		logger.warn(
			{ err },
			"[Notifications] Failed to deliver to bot connections",
		),
	);
	return { created: true, eventId };
}

export async function listNotifications(opts: {
	organizationId: string;
	userId: string;
	cursor?: number | null;
	limit?: number;
	unreadOnly?: boolean;
	clientIds?: string[];
	mcpActivityId?: string | null;
	/**
	 * Return only notifications carrying a `browser_url` (a browser-handoff
	 * draft staged in the user's browser). Used by the attention feed to keep
	 * undismissed drafts visible regardless of the recent-activity window.
	 */
	browserUrlOnly?: boolean;
}): Promise<{
	notifications: Record<string, unknown>[];
	nextCursor: number | null;
}> {
	const sql = getDb();
	const limit = Math.min(opts.limit ?? 20, 50);
	const cursor = opts.cursor ?? null;
	const unreadOnly = opts.unreadOnly ?? false;
	const clientIds = opts.clientIds?.length ? opts.clientIds : null;
	const mcpActivityId = opts.mcpActivityId?.trim() || null;
	const browserUrlOnly = opts.browserUrlOnly ?? false;

	const rows = (await sql`
    SELECT
      e.id,
      e.organization_id,
      t.user_id,
      COALESCE(e.metadata->>'notification_type', 'generic') AS type,
      e.title,
      e.payload_text AS body,
      e.metadata->>'resource_type' AS resource_type,
      e.metadata->>'resource_id' AS resource_id,
      e.metadata->>'resource_url' AS resource_url,
      t.browser_url AS browser_url,
      CASE
        WHEN t.browser_url IS NULL THEN NULL
        -- No linked run: nothing to recreate from, so the message must not
        -- promise a retry the recreate endpoint would answer with 404.
        WHEN browser_run.id IS NULL THEN jsonb_build_object(
          'run_id', NULL,
          'state', 'expired',
          'expires_at', NULL,
          'error_message', 'This browser handoff is no longer linked to a draft. Open the page yourself, or ask for a fresh draft.'
        )
        WHEN browser_run.status IN ('failed', 'timeout') THEN
          jsonb_build_object(
            'run_id', browser_run.id,
            'state', 'expired',
            'expires_at', browser_run.expires_at,
            'error_message', COALESCE(
              browser_run.error_message,
              'The browser draft could not be populated. Recreate it to try again.'
            )
          )
        WHEN browser_run.status = 'completed' OR browser_run.activated_at IS NOT NULL THEN
          jsonb_build_object(
            'run_id', browser_run.id,
            'state', 'completed',
            'expires_at', browser_run.expires_at,
            'error_message', NULL
          )
        -- A target stored without exact query/fragment identity can never be
        -- activated again (worker-api/page-activation.ts rejects it), so the
        -- card must explain the lost target instead of promising a page visit.
        WHEN browser_run.activation_kind = 'page_visit'
          AND browser_run.run_metadata->>'page_activation_identity' IS DISTINCT FROM 'exact' THEN
          jsonb_build_object(
            'run_id', browser_run.id,
            'state', 'expired',
            'expires_at', browser_run.expires_at,
            'error_message', 'The original page target was lost. Create a new draft with its full URL.'
          )
        WHEN browser_run.status = 'pending'
          AND browser_run.approval_status = 'auto'
          AND browser_run.activation_kind = 'page_visit'
          AND browser_run.expires_at > current_timestamp THEN
          jsonb_build_object(
            'run_id', browser_run.id,
            'state', 'ready',
            'expires_at', browser_run.expires_at,
            'error_message', NULL
          )
        ELSE jsonb_build_object(
          'run_id', browser_run.id,
          'state', 'expired',
          'expires_at', browser_run.expires_at,
          'error_message', COALESCE(
            browser_run.error_message,
            'This draft expired before the page was opened. Recreate it to continue.'
          )
        )
      END AS browser_handoff,
      e.connector_key AS platform,
      e.connection_id,
      source_connection.display_name AS connection_name,
      e.feed_id,
      e.feed_key,
      fd.display_name AS feed_name,
      e.automation_id,
      COALESCE(wv.name, 'Automation #' || e.automation_id) AS automation_name,
      COALESCE(
        NULLIF(e.metadata->>'agent_id', ''),
        NULLIF(source_run.approved_input->>'agent_id', '')
      ) AS agent_id,
      agent.name AS agent_name,
      e.client_id,
      oauth_client.client_name,
      COALESCE(
        NULLIF(e.metadata->>'device_worker_id', ''),
        NULLIF(source_run.approved_input->>'device_worker_id', '')
      ) AS device_worker_id,
      device_worker.label AS device_label,
      device_worker.platform AS device_platform,
      pe.interaction_type AS interaction_type,
      -- Whether the decision needs FIELDS or is a bare yes/no. Consumers pick
      -- the affordance from this, not from a list of known action keys.
      pe.interaction_input_schema AS interaction_input_schema,
      ar.id AS approval_run_id,
      -- A pending approval whose review card is unreachable — the proposal
      -- event's connection is soft-deleted (or gone), so the card is invisible
      -- to every content read (connection-visibility predicate) and
      -- approve/reject would be blind — resolves terminal ('expired'), never
      -- as an actionable pending approval.
      CASE
        WHEN ar.approval_status = 'pending'
         AND pe.connection_id IS NOT NULL
         AND pc.id IS NULL
        THEN 'expired'
        ELSE ar.approval_status
      END AS approval_status,
      ar.action_key AS approval_action_key,
      (t.read_at IS NOT NULL) AS is_read,
      t.delivered_at AS created_at
    FROM notification_targets t
    JOIN events e ON e.id = t.event_id
    LEFT JOIN feeds fd ON fd.id = e.feed_id
    LEFT JOIN automation_versions wv ON wv.id = e.automation_version_id
    LEFT JOIN connections source_connection
      ON source_connection.id = e.connection_id
     AND source_connection.organization_id = e.organization_id
    LEFT JOIN runs source_run
      ON source_run.id = e.run_id
     AND source_run.organization_id = e.organization_id
    LEFT JOIN runs browser_run
      ON browser_run.id = t.browser_run_id
     AND browser_run.organization_id = e.organization_id
    LEFT JOIN agents agent
      ON agent.id = COALESCE(
        NULLIF(e.metadata->>'agent_id', ''),
        NULLIF(source_run.approved_input->>'agent_id', '')
      )
     AND agent.organization_id = e.organization_id
    LEFT JOIN oauth_clients oauth_client ON oauth_client.id = e.client_id
    LEFT JOIN device_workers device_worker
      ON device_worker.id::text = COALESCE(
        NULLIF(e.metadata->>'device_worker_id', ''),
        NULLIF(source_run.approved_input->>'device_worker_id', '')
      )
     AND device_worker.organization_id = e.organization_id
    -- Approval notifications point at proposal events; resolve the run here so
    -- consumers see its current approval state rather than an emitted snapshot.
    LEFT JOIN events pe
      ON COALESCE(e.metadata->>'notification_type', 'generic') = 'action_approval_needed'
     AND e.metadata->>'resource_type' = 'event'
     AND e.metadata->>'resource_id' ~ '^[0-9]+$'
     AND pe.id = (e.metadata->>'resource_id')::bigint
     AND pe.organization_id = e.organization_id
     AND pe.interaction_type = 'approval'
    LEFT JOIN runs ar
      ON ar.organization_id = e.organization_id
     AND ar.id = pe.run_id
    -- Mirrors the connection-visibility predicate every content read applies
    -- (compileConnectionFkVisibility): the card counts as reviewable only when
    -- its connection is live, org-visible, and (for private) owned by the
    -- reader. A deleted or invisible connection means the card can never be
    -- opened, so the approval is undecidable.
    LEFT JOIN connections pc
      ON pc.id = pe.connection_id
     AND pc.organization_id = e.organization_id
     AND pc.deleted_at IS NULL
     AND (
       pc.visibility = 'org'
       OR (${opts.userId}::text IS NOT NULL AND pc.created_by = ${opts.userId}::text)
     )
    WHERE e.organization_id = ${opts.organizationId}
      AND t.user_id = ${opts.userId}
      AND (${cursor}::bigint IS NULL OR e.id < ${cursor})
      AND (${!unreadOnly} OR t.read_at IS NULL)
      ${browserUrlOnly ? sql`AND t.browser_url IS NOT NULL` : sql``}
			${clientIds
				? sql`AND e.client_id = ANY(${pgTextArray(clientIds)}::text[])`
				: sql``}
			${mcpActivityId
				? sql`AND COALESCE(
					e.metadata->>'mcp_conversation_id',
					e.metadata->>'mcp_session_id'
				) = ${mcpActivityId}`
				: sql``}
    -- Order strictly by e.id so the (e.id < cursor) keyset pagination is
    -- consistent. delivered_at would tie-break for concurrent inserts but
    -- doesn't match the cursor — using it as the primary key risked
    -- skipping notifications when delivered_at and e.id disagreed.
    ORDER BY e.id DESC
    LIMIT ${limit + 1}
  `) as unknown as Array<{ id: number } & Record<string, unknown>>;

	const hasMore = rows.length > limit;
	const notifications = hasMore ? rows.slice(0, limit) : rows;
	const nextCursor = hasMore
		? (notifications[notifications.length - 1]?.id ?? null)
		: null;

	return { notifications, nextCursor };
}

export async function getUnreadCount(
	organizationId: string,
	userId: string,
): Promise<number> {
	const sql = getDb();
	const rows = (await sql`
    SELECT COUNT(*)::int AS count
    FROM notification_targets t
    JOIN events e ON e.id = t.event_id
    WHERE e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
      AND t.read_at IS NULL
  `) as unknown as Array<{ count: number }>;
	return rows[0].count;
}

export async function markAsRead(
	organizationId: string,
	userId: string,
	notificationId: number,
): Promise<boolean> {
	const sql = getDb();
	const rows = (await sql`
    UPDATE notification_targets t
    SET read_at = now()
    FROM events e
    WHERE t.event_id = e.id
      AND e.id = ${notificationId}
      AND e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
      AND t.read_at IS NULL
    RETURNING t.event_id
  `) as unknown as Array<{ event_id: number }>;
	return rows.length > 0;
}

export async function markAllAsRead(
	organizationId: string,
	userId: string,
): Promise<number> {
	const sql = getDb();
	const rows = (await sql`
    UPDATE notification_targets t
    SET read_at = now()
    FROM events e
    WHERE t.event_id = e.id
      AND e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
      AND t.read_at IS NULL
    RETURNING t.event_id
  `) as unknown as Array<{ event_id: number }>;
	return rows.length;
}

/**
 * "Deleting" a notification is a per-user concern — the event stays in the
 * org-wide knowledge stream. We just drop the target row so it disappears
 * from this user's inbox.
 */
export async function deleteNotification(
	organizationId: string,
	userId: string,
	notificationId: number,
): Promise<boolean> {
	const sql = getDb();
	const rows = (await sql`
    DELETE FROM notification_targets t
    USING events e
    WHERE t.event_id = e.id
      AND e.id = ${notificationId}
      AND e.organization_id = ${organizationId}
      AND t.user_id = ${userId}
    RETURNING t.event_id
  `) as unknown as Array<{ event_id: number }>;
	return rows.length > 0;
}
