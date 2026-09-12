/**
 * Workspace attention feed — shared by manage_operations.list_activity,
 * Home UI, and first-turn agent ephemeral context.
 *
 * Multi-replica safe: pure SQL reads + deterministic collapse (no in-memory
 * shared state).
 */

import { getDb, pgTextArray } from "../../../db/client";
import { listNotifications } from "../../../notifications/service";
import { buildResourcePermalink } from "../../../utils/url-builder";
import { AGENT_ASK_ACTION_KEY } from "../../../notifications/ask";
import { resolveAskAffordance } from "../../../notifications/ask-schema";
import { ENTITY_CHANGE_ACTION_KEYS } from "../entity-field-approval";

/**
 * Approval families a human may settle straight from a feed row, without
 * opening the review page first.
 *
 * A SAFETY policy, deliberately narrow — not a rendering hint. Entity changes
 * qualify because the card carries the whole diff. An agent ask qualifies
 * because the answer IS the outcome; nothing is applied unseen. An Automation or
 * agent definition write does NOT: approving it from a row would commit a
 * config change the reviewer never looked at.
 *
 * Lazy, NOT a top-level const: reading `ENTITY_CHANGE_ACTION_KEYS` during module
 * init hits the temporal dead zone under the circular graph
 * activity-feed → entity-field-approval → … → manage_operations → activity-feed,
 * and the server dies at boot with "Cannot access … before initialization".
 * Same trap and same fix as `getBuilderApprovalHandlers`. Typecheck and the
 * integration suite both stayed green through it — only booting caught it.
 */
let inlineDecidableActionKeys: readonly string[] | null = null;
function getInlineDecidableActionKeys(): readonly string[] {
	if (!inlineDecidableActionKeys) {
		inlineDecidableActionKeys = [
			...ENTITY_CHANGE_ACTION_KEYS,
			AGENT_ASK_ACTION_KEY,
		];
	}
	return inlineDecidableActionKeys;
}

const USER_FACING_RUN_TYPES = ["automation", "sync", "action", "internal"] as const;

export type ActivityCard = {
	id: string;
	kind: string;
	title: string;
	body: string | null;
	at: string;
	status: string | null;
	count: number;
	href: string | null;
	unread?: boolean;
	notification_id?: number;
	browser_url?: string;
	browser_handoff?: {
		run_id: number | null;
		state: "ready" | "expired" | "completed";
		expires_at: string | null;
		error_message: string | null;
	};
	run_id?: number;
	/**
	 * Kind of pending interaction behind this notification (events
	 * `interaction_type` vocabulary — 'approval' today). Clients pick the UI
	 * for the type; new interaction kinds extend this value, not the card shape.
	 */
	interaction_type?: string;
	/**
	 * LIVE interaction state, resolved from the interaction's authoritative
	 * per-type source — for 'approval' that is runs.approval_status
	 * ('pending' | 'approved' | 'rejected'), NOT the proposal event's own
	 * interaction_status, which stays 'pending' forever because the events
	 * chain supersedes instead of mutating. A decided interaction therefore
	 * stops rendering as actionable everywhere.
	 */
	interaction_status?: string;
	/**
	 * This interaction can be settled in one click from the feed — its schema
	 * needs no typed input. False/absent means it needs a form, so the row
	 * offers a review CTA instead of controls that would discard the answer.
	 */
	interaction_inline?: boolean;
	/**
	 * For a one-click decision with more than two outcomes: the options to
	 * render as buttons, and the schema field their value answers. Absent for a
	 * plain approve/reject. Answer with `{ [interaction_choice_field]: value }`.
	 */
	interaction_choice_field?: string;
	interaction_choices?: Array<{ value: string; label: string }>;
	member_run_ids?: number[];
	platform?: string;
	connection_id?: number;
	connection_name?: string;
	feed_id?: number;
	feed_key?: string;
	feed_name?: string;
	automation_id?: number;
	automation_name?: string;
	agent_id?: string;
	agent_name?: string;
	client_id?: string;
	client_name?: string;
	device_worker_id?: string;
	device_label?: string;
	device_platform?: string;
};

type RawCard = ActivityCard & {
	collapseKey: string | null;
	itemsCollected: number | null;
	atMs: number;
};

function isFailedStatus(status: string | null | undefined): boolean {
	return (
		status === "failed" || status === "timeout" || status === "error"
	);
}

/**
 * Build an attention card from a notification row (listNotifications shape).
 * Shared by the recent-window feed and the attention fetch.
 * Returns null when the row has no usable id.
 */
function buildNotificationCard(
	ownerSlug: string,
	n: Record<string, unknown>,
): RawCard | null {
	const id = Number(n.id);
	if (!Number.isSafeInteger(id) || id <= 0) return null;
	const type = String(n.type ?? "generic");
	const created = String(n.created_at ?? new Date().toISOString());
	const atMs = new Date(created).getTime();
	const approvalRunId = n.approval_run_id != null ? Number(n.approval_run_id) : NaN;
	const interactionType =
		typeof n.interaction_type === "string" && n.interaction_type !== ""
			? n.interaction_type
			: undefined;
	// Per-type live-state resolution: 'approval' reads the run's state
	// machine. A future interaction kind plugs its own source in here —
	// the card contract (interaction_*) does not change.
	const interactionStatus =
		interactionType === "authorization" && typeof n.interaction_status === "string"
			? n.interaction_status
			: interactionType === "approval" &&
		typeof n.approval_status === "string" &&
		n.approval_status !== ""
			? n.approval_status
			: undefined;
	// Settling from a row needs TWO independent things to be true, and
	// conflating them is a security bug in one direction and a dead
	// control in the other:
	//
	//   1. POLICY — is this family safe to decide without opening the
	//      review page? Entity changes are (the diff is in the card);
	//      an Automation definition write deliberately is NOT. An ask is,
	//      because the answer IS the outcome — there is no held
	//      mutation being applied sight-unseen.
	//   2. SHAPE — can the answer be given without typing? That is a
	//      question about the schema, not the family.
	//
	// A form-shaped ask in a one-click family still must not render
	// buttons (they would discard the input), and a schemaless write in
	// an unsafe family still must not (it would apply blind).
	const familyAllowsInline = getInlineDecidableActionKeys().includes(
		String(n.approval_action_key ?? ""),
	);
	const affordance =
		interactionType === "approval" && interactionStatus != null
			? resolveAskAffordance(
					n.interaction_input_schema as Record<string, unknown> | null,
				)
			: null;
	const interactionInline =
		familyAllowsInline && affordance != null && affordance.kind !== "form";
	const rawBrowserHandoff =
		n.browser_handoff && typeof n.browser_handoff === "object"
			? (n.browser_handoff as Record<string, unknown>)
			: null;
	let browserHandoff: ActivityCard["browser_handoff"];
	if (
		rawBrowserHandoff &&
		(rawBrowserHandoff.state === "ready" ||
			rawBrowserHandoff.state === "expired" ||
			rawBrowserHandoff.state === "completed")
	) {
		browserHandoff = {
			run_id:
				typeof rawBrowserHandoff.run_id === "number"
					? rawBrowserHandoff.run_id
					: null,
			state: rawBrowserHandoff.state,
			expires_at:
				typeof rawBrowserHandoff.expires_at === "string"
					? rawBrowserHandoff.expires_at
					: null,
			error_message:
				typeof rawBrowserHandoff.error_message === "string"
					? rawBrowserHandoff.error_message
					: null,
		};
	}
	return {
		id: `n:${id}`,
		kind: "notification",
		title: String(n.title ?? "Notification"),
		body: n.body != null ? String(n.body) : null,
		at: created,
		atMs: Number.isFinite(atMs) ? atMs : 0,
		status: type,
		count: 1,
		href: resolveNotifHref(ownerSlug, n),
		unread: n.is_read === false || n.is_read === "f",
		notification_id: id,
		browser_url:
			typeof n.browser_url === "string" ? n.browser_url : undefined,
		browser_handoff: browserHandoff,
		platform: typeof n.platform === "string" ? n.platform : undefined,
		connection_id:
			typeof n.connection_id === "number" ? n.connection_id : undefined,
		connection_name:
			typeof n.connection_name === "string"
				? n.connection_name
				: undefined,
		feed_id: typeof n.feed_id === "number" ? n.feed_id : undefined,
		feed_key: typeof n.feed_key === "string" ? n.feed_key : undefined,
		feed_name: typeof n.feed_name === "string" ? n.feed_name : undefined,
		automation_id:
			typeof n.automation_id === "number" ? n.automation_id : undefined,
		automation_name:
			typeof n.automation_name === "string" ? n.automation_name : undefined,
		agent_id: typeof n.agent_id === "string" ? n.agent_id : undefined,
		agent_name:
			typeof n.agent_name === "string" ? n.agent_name : undefined,
		client_id: typeof n.client_id === "string" ? n.client_id : undefined,
		client_name:
			typeof n.client_name === "string" ? n.client_name : undefined,
		device_worker_id:
			typeof n.device_worker_id === "string"
				? n.device_worker_id
				: undefined,
		device_label:
			typeof n.device_label === "string" ? n.device_label : undefined,
		device_platform:
			typeof n.device_platform === "string"
				? n.device_platform
				: undefined,
		run_id: Number.isFinite(approvalRunId) ? approvalRunId : undefined,
		interaction_type: interactionStatus != null ? interactionType : undefined,
		interaction_status: interactionStatus,
		interaction_inline: interactionInline || undefined,
		// Present only for a one-click multi-option decision. The field
		// name travels with the options so the caller can send back
		// `{ [field]: value }` without re-reading the schema.
		interaction_choice_field:
			affordance?.kind === "choice" ? affordance.field : undefined,
		interaction_choices:
			affordance?.kind === "choice" ? affordance.choices : undefined,
		collapseKey: null,
		itemsCollected: null,
	};
}

function resolveNotifHref(
	ownerSlug: string,
	n: {
		type?: unknown;
		resource_url?: unknown;
		resource_id?: unknown;
	},
): string | null {
	const explicit =
		typeof n.resource_url === "string" ? n.resource_url.trim() : "";
	if (explicit) {
		// Invitation: never land on /members
		if (
			n.type === "invitation_received" &&
			(explicit.endsWith("/members") || explicit.includes("/members?"))
		) {
			const id =
				typeof n.resource_id === "string" ? n.resource_id.trim() : "";
			if (id) {
				return `/auth/accept-invitation?invitationId=${encodeURIComponent(id)}`;
			}
		}
		// Weak dumps for auth types → connectors index
		if (
			(n.type === "browser_auth_expired" ||
				n.type === "connection_permission_request") &&
			(explicit.endsWith("/infrastructure") ||
				explicit.endsWith("/connectors") ||
				explicit.endsWith("/connectors/"))
		) {
			// Keep explicit if it already has connector/id depth
			if (!/\/connectors\/[^/]+\/\d+/.test(explicit)) {
				return `/${ownerSlug}/connectors`;
			}
		}
		return explicit;
	}
	if (n.type === "invitation_received" && typeof n.resource_id === "string") {
		return `/auth/accept-invitation?invitationId=${encodeURIComponent(n.resource_id.trim())}`;
	}
	if (
		n.type === "connection_permission_request" ||
		n.type === "browser_auth_expired"
	) {
		return `/${ownerSlug}/connectors`;
	}
	return `/${ownerSlug}/memory`;
}

export function runHref(
	ownerSlug: string,
	row: {
		id: number;
		run_type: string;
		automation_id: number | null;
		connection_id: number | null;
		connector_key: string | null;
		approval_status: string | null;
		managed_agent_id: string | null;
	},
): string | null {
	if (row.run_type === "automation" && row.automation_id != null) {
		return `/${ownerSlug}/automations/${row.automation_id}`;
	}
	if (
		(row.run_type === "sync" || row.run_type === "action") &&
		row.connection_id != null &&
		row.connector_key
	) {
		if (
			row.run_type === "action" &&
			(row.approval_status === "pending" ||
				row.approval_status === "pending_approval")
		) {
			return (
				buildResourcePermalink(ownerSlug, {
					kind: "run",
					runId: row.id,
				}) ?? null
			);
		}
		return `/${ownerSlug}/connectors/${row.connector_key}/${row.connection_id}`;
	}
	return (
		buildResourcePermalink(ownerSlug, { kind: "run", runId: row.id }) ?? null
	);
}

function runTitle(row: {
	run_type: string;
	automation_name: string | null;
	automation_id: number | null;
	feed_display_name: string | null;
	feed_key: string | null;
	connection_display_name: string | null;
	operation_key: string | null;
	connector_key: string | null;
	id: number;
}): string {
	if (row.run_type === "automation") {
		return (
			row.automation_name ??
			(row.automation_id != null
				? `Automation #${row.automation_id}`
				: `Run #${row.id}`)
		);
	}
	if (row.run_type === "sync") {
		return (
			row.feed_display_name ??
			row.feed_key ??
			row.connection_display_name ??
			`Feed sync #${row.id}`
		);
	}
	if (row.operation_key) {
		const last = row.operation_key.includes(".")
			? (row.operation_key.split(".").pop() ?? row.operation_key)
			: row.operation_key;
		const pretty = last.replace(/[_-]+/g, " ");
		return row.connection_display_name
			? `${pretty} · ${row.connection_display_name}`
			: pretty;
	}
	return (
		row.connection_display_name ??
		row.connector_key ??
		`Run #${row.id}`
	);
}

function collapseKeyForRun(row: {
	run_type: string;
	connection_id: number | null;
	automation_id: number | null;
	connector_key: string | null;
	feed_id: number | null;
}): string | null {
	if (row.run_type === "sync" || row.run_type === "action") {
		if (row.connection_id != null) return `conn:${row.connection_id}`;
		if (row.connector_key && row.feed_id != null) {
			return `feed:${row.connector_key}:${row.feed_id}`;
		}
		return null;
	}
	if (row.run_type === "automation" && row.automation_id != null) {
		return `automation:${row.automation_id}`;
	}
	return null;
}

/**
 * Does this card still need the reader to do something?
 *
 * One definition, applied twice: here, to decide what gets pinned past the
 * recent-activity window, and in Owletto's attention lens (`attention-inbox.tsx`,
 * `cardNeedsAttention`) to decide what it renders. They must agree — a card the
 * server pins but the client hides is an invisible slot, and a card the client
 * wants but the server drops is the badge/lens mismatch this pin exists to fix.
 * `listNotifications`'s `attentionOnly` predicate is the same rule expressed in
 * SQL, so the LIMIT is spent on cards that survive this filter.
 *
 * A browser-handoff draft qualifies only while it is still openable. `completed`
 * (already activated) and `expired` (can never be activated) have nothing left
 * to do; pinning those made month-old dead drafts outrank live work.
 */
function cardNeedsAttention(card: RawCard): boolean {
	if (card.interaction_type === "authorization") return card.interaction_status === "pending";
	return Boolean(card.unread) || cardHasPendingDecision(card);
}

function cardHasPendingDecision(card: RawCard): boolean {
	return (
		card.interaction_status === "pending" ||
		card.browser_handoff?.state === "ready"
	);
}

/** Adjacent collapse — same rules as Owletto client (oldest→newest input). */
export function collapseAdjacentActivityCards(items: RawCard[]): RawCard[] {
	if (items.length <= 1) return items;
	const out: RawCard[] = [];
	let i = 0;
	while (i < items.length) {
		const head = items[i]!;
		if (
			head.kind === "notification" ||
			!head.collapseKey ||
			!head.status ||
			isFailedStatus(head.status)
		) {
			out.push(head);
			i += 1;
			continue;
		}
		let j = i + 1;
		let itemsSum =
			typeof head.itemsCollected === "number" ? head.itemsCollected : null;
		const memberIds = head.run_id != null ? [head.run_id] : [];
		while (j < items.length) {
			const next = items[j]!;
			if (
				next.kind === "notification" ||
				next.collapseKey !== head.collapseKey ||
				next.status !== head.status ||
				isFailedStatus(next.status)
			) {
				break;
			}
			if (typeof next.itemsCollected === "number") {
				itemsSum = (itemsSum ?? 0) + next.itemsCollected;
			} else if (itemsSum != null) {
				itemsSum = null;
			}
			if (next.run_id != null) memberIds.push(next.run_id);
			j += 1;
		}
		const count = j - i;
		if (count === 1) {
			out.push(head);
		} else {
			const latest = items[j - 1]!;
			const status = latest.status ?? "run";
			const body =
				itemsSum != null
					? `${count}× ${status} · ${itemsSum} items total`
					: `${count}× ${status}`;
			out.push({
				...latest,
				id: `group:${head.collapseKey}:${latest.id}`,
				kind:
					latest.kind === "sync"
						? "sync_group"
						: latest.kind === "automation_run"
							? "automation_run_group"
							: `${latest.kind}_group`,
				body,
				count,
				member_run_ids: memberIds,
			});
		}
		i = j;
	}
	return out;
}

export async function listOrgActivity(opts: {
	organizationId: string;
	userId: string | null;
	ownerSlug: string;
	limit?: number;
	includeNotifications?: boolean;
	includeRuns?: boolean;
	aggregate?: boolean;
	kinds?: string[];
	/**
	 * Scope to one agent: filter runs to that agent's Automations and drop
	 * notifications (org/user-scoped, not attributable to an agent).
	 */
	agentId?: string;
}): Promise<{ items: ActivityCard[]; total: number; limit: number }> {
	const limit = Math.min(Math.max(opts.limit ?? 24, 1), 50);
	// Notifications are not agent-attributable, so an agent-scoped feed omits
	// them entirely and shows only that agent's runs.
	const includeNotifications =
		opts.includeNotifications !== false && !!opts.userId && !opts.agentId;
	const includeRuns = opts.includeRuns !== false;
	const aggregate = opts.aggregate !== false;
	const kindFilter = opts.kinds?.length ? new Set(opts.kinds) : null;

	const raw: RawCard[] = [];

	if (includeNotifications && opts.userId) {
		if (!kindFilter || kindFilter.has("notification")) {
			const { notifications } = await listNotifications({
				organizationId: opts.organizationId,
				userId: opts.userId,
				// Match the run window (60) so notifications can survive the
				// merge into the final chronological slice even at limit: 50.
				limit: 60,
			});
			for (const n of notifications) {
				const card = buildNotificationCard(opts.ownerSlug, n);
				if (card) raw.push(card);
			}
		}
	}

	if (includeRuns) {
		const runKinds = kindFilter
			? USER_FACING_RUN_TYPES.filter((k) => kindFilter.has(k) || kindFilter.has("run"))
			: [...USER_FACING_RUN_TYPES];
		if (runKinds.length > 0) {
			const sql = getDb();
			// When agent-scoped, restrict to that agent's Automation runs. The join to
			// `automations` already exposes `w.managed_agent_id`; a non-null agentId turns the
			// LEFT JOIN into an effective inner filter (runs with no automation, i.e.
			// bare syncs/actions, are dropped — they aren't agent-owned).
			const agentFilter = opts.agentId
				? sql`AND w.managed_agent_id = ${opts.agentId}`
				: sql``;
			const rows = (await sql`
        SELECT r.id, r.run_type, r.automation_id, r.connection_id, r.feed_id,
               r.connector_key, r.action_key AS operation_key,
               r.approval_status, r.status, r.error_message, r.items_collected,
               r.created_at, r.completed_at,
               f.feed_key, f.display_name AS feed_display_name,
               c.display_name AS connection_display_name,
               w.name AS automation_name, w.managed_agent_id
        FROM runs r
        LEFT JOIN feeds f ON f.id = r.feed_id
        LEFT JOIN connections c ON c.id = r.connection_id
        LEFT JOIN automations w ON w.id = r.automation_id
        WHERE r.organization_id = ${opts.organizationId}
          AND r.run_type = ANY(${pgTextArray(runKinds)}::text[])
          ${agentFilter}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 60
      `) as unknown as Array<{
				id: number;
				run_type: string;
				automation_id: number | null;
				connection_id: number | null;
				feed_id: number | null;
				connector_key: string | null;
				operation_key: string | null;
				approval_status: string | null;
				status: string;
				error_message: string | null;
				items_collected: number | null;
				created_at: string | Date;
				feed_key: string | null;
				feed_display_name: string | null;
				connection_display_name: string | null;
				automation_name: string | null;
				managed_agent_id: string | null;
			}>;

			for (const r of rows) {
				const created =
					r.created_at instanceof Date
						? r.created_at.toISOString()
						: String(r.created_at);
				const atMs = new Date(created).getTime();
				const kind =
					r.run_type === "automation"
						? "automation_run"
						: r.run_type === "sync"
							? "sync"
							: "run";
				const body = r.error_message
					? r.error_message.slice(0, 120)
					: r.items_collected != null
						? `${r.status} · ${r.items_collected} items`
						: r.status;
				raw.push({
					id: `r:${r.id}`,
					kind,
					title: runTitle(r),
					body,
					at: created,
					atMs: Number.isFinite(atMs) ? atMs : 0,
					status: r.status,
					count: 1,
					href: runHref(opts.ownerSlug, r),
					run_id: r.id,
					connection_id: r.connection_id ?? undefined,
					automation_id: r.automation_id ?? undefined,
					collapseKey: collapseKeyForRun(r),
					itemsCollected: r.items_collected,
				});
			}
		}
	}

	// Newest window → chronological → optional adjacent collapse → cap.
	raw.sort((a, b) => b.atMs - a.atMs);
	const windowed = raw.slice(0, 60);
	windowed.reverse();

	// Anything that still needs the reader must stay reachable regardless of how
	// many newer cards arrived. Without this the attention lens is a filter over
	// the newest N activity cards, so an unread notification or an undecided
	// approval older than the window vanishes from it while the unread badge
	// keeps counting — the badge said 3 and the lens could show 1.
	//
	// Fetch the attention set — only when the kind filter permits notifications
	// — merge it chronologically, and pin it so the cap below evicts settled
	// cards instead. Bounded, read-only, multi-replica safe.
	let collapsed: RawCard[];
	const pinnedAttentionIds = new Set<number>();
	if (
		includeNotifications &&
		opts.userId &&
		(!kindFilter || kindFilter.has("notification"))
	) {
		const { notifications: attentionNotifications } = await listNotifications({
			organizationId: opts.organizationId,
			userId: opts.userId,
			limit: 50,
			attentionOnly: true,
		});
		const merged = [...windowed];
		const present = new Set(
			merged.flatMap((c) =>
				c.notification_id != null ? [Number(c.notification_id)] : [],
			),
		);
		for (const n of attentionNotifications) {
			const card = buildNotificationCard(opts.ownerSlug, n);
			if (!card || card.notification_id == null) continue;
			// Keep the pinned set aligned with the client-visible card state.
			if (!cardNeedsAttention(card)) continue;
			// Pin by id regardless of whether this card is already in the merge
			// window: an item inside the 60-card window but outside the final
			// limit would otherwise be sliced away un-pinned.
			pinnedAttentionIds.add(card.notification_id);
			if (present.has(card.notification_id)) continue;
			merged.push(card);
			present.add(card.notification_id);
		}
		merged.sort((a, b) => a.atMs - b.atMs);
		collapsed = aggregate ? collapseAdjacentActivityCards(merged) : merged;
	} else {
		collapsed = aggregate
			? collapseAdjacentActivityCards(windowed)
			: windowed;
	}

	// Keep every pinned card and fill the rest of the budget with the newest
	// settled cards, then project to the public ActivityCard shape (dropping the
	// RawCard-only fields).
	let items: ActivityCard[];
	if (pinnedAttentionIds.size > 0) {
		const attentionCards = collapsed
			.filter(
				(c) =>
					c.notification_id != null &&
					pinnedAttentionIds.has(c.notification_id),
			)
			// Preserve SQL's decision-first priority even when the caller asks
			// for fewer cards than the attention query's budget.
			.sort((a, b) =>
				Number(cardHasPendingDecision(a)) - Number(cardHasPendingDecision(b)) ||
				a.atMs - b.atMs,
			)
			.slice(-limit);
		const otherCards = collapsed.filter(
			(c) =>
				c.notification_id == null ||
				!pinnedAttentionIds.has(c.notification_id),
		);
		const fillCount = Math.max(0, limit - attentionCards.length);
		const fill = fillCount > 0 ? otherCards.slice(-fillCount) : [];
		items = [...attentionCards, ...fill]
			.sort((a, b) => a.atMs - b.atMs)
			.map(({ collapseKey, itemsCollected, atMs, ...card }) => card);
	} else {
		items = collapsed
			.slice(-limit)
			.map(({ collapseKey, itemsCollected, atMs, ...card }) => card);
	}

	return { items, total: items.length, limit };
}

/** Drop the query string + fragment from a deep-link (absolute or relative).
 * Notification hrefs can carry OAuth authorization codes and invitation ids as
 * query params; those must never reach worker context. Kept out of the UI path
 * on purpose: listOrgActivity still returns full hrefs for the trusted client. */
function stripUrlParams(url: string): string {
	const cut = url.search(/[?#]/);
	return cut >= 0 ? url.slice(0, cut) : url;
}

/** Redact query strings from any URL embedded in free-form body text, so a
 * notification body like "re-auth here: https://…?code=…" cannot smuggle a
 * credential into worker context. */
function redactBodyUrls(text: string): string {
	return text.replace(/(https?:\/\/[^\s?#]+)[^\s]*/g, "$1");
}

/**
 * Compact prompt block for first-turn agent context (≤ ~2k chars).
 *
 * This feeds worker `ephemeralContext`, an untrusted-prompt surface, so it
 * emits an allowlisted, worker-safe projection only: query params are stripped
 * from links and body URLs (OAuth codes, invitation ids), and titles, errors,
 * and names are forwarded solely as sanitized untrusted text.
 */
export function formatActivityAttentionBlock(
	items: ActivityCard[],
	maxLines = 10,
): string {
	if (items.length === 0) return "";
	const lines: string[] = ["## Workspace attention"];
	const slice = items.slice(-maxLines);
	for (const it of slice) {
		const status = it.status ? ` [${it.status}]` : "";
		const count = it.count > 1 ? ` ×${it.count}` : "";
		const body = it.body
			? ` — ${redactBodyUrls(it.body).replace(/\s+/g, " ").slice(0, 120)}`
			: "";
		const href = it.href ? ` (${stripUrlParams(it.href)})` : "";
		let line = `- ${it.title}${count}${status}${body}${href}`;
		// Sanitize control chars like buildRunContextBlock
		line = [...line]
			.map((ch) => {
				const code = ch.codePointAt(0) ?? 0;
				return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
			})
			.join("")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 280);
		if (line.length > 2) lines.push(line);
	}
	const block = lines.join("\n");
	return block.length > 2000 ? block.slice(0, 2000) : block;
}
