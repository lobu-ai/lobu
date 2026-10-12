/**
 * Platform-owned Automation event keys — the events Lobu itself emits, for
 * both trigger sources.
 *
 * `source: "<connector>"` — `withPlatformAutomationEvents` injects platform
 * keys into every connector's declared `automation_events`.
 * `source: "workspace"` — `platformEventKinds` supplies the audit funnel's
 * `<subject>.<op>` types, which no entity type declares and which were
 * therefore unsubscribable no matter what the activation path supported.
 *
 * Both halves live here because they are the same idea on two surfaces, and
 * the `<subject>.<op>` spelling is shared (`feed.auto_paused` alongside
 * `feed.deleted`). The two never collide: a trigger names one `source`, so the
 * catalogs are consulted independently.
 *
 * Kept free of activation / DB imports so catalog validation and unit tests
 * stay dependency-light.
 */

import {
	CONFIG_RESOURCE_KINDS,
	WORKSPACE_AUDIT_RESOURCE_KINDS,
} from "../utils/config-redaction";

/** Hard auto-pause after consecutive feed failures (feed-backoff). */
export const PLATFORM_EVENT_FEED_AUTO_PAUSED = "feed.auto_paused";

export interface PlatformAutomationEventDef {
	key: string;
	description?: string;
	capabilities?: {
		steering?: boolean;
		replyToSource?: boolean;
	};
}

/** Injected into every connector's automation_events catalog for trigger validation + UI. */
export const PLATFORM_AUTOMATION_EVENTS: PlatformAutomationEventDef[] = [
	{
		key: PLATFORM_EVENT_FEED_AUTO_PAUSED,
		description:
			"Fires once when Lobu hard-pauses a feed after too many consecutive sync failures.",
	},
];

/** Merge platform events into a connector's declared automation_events list. */
export function withPlatformAutomationEvents<T extends { key: string }>(
	events: T[],
): Array<T | PlatformAutomationEventDef> {
	const seen = new Set(events.map((event) => event.key));
	const merged: Array<T | PlatformAutomationEventDef> = [...events];
	for (const platform of PLATFORM_AUTOMATION_EVENTS) {
		if (!seen.has(platform.key)) merged.push(platform);
	}
	return merged;
}

// ============================================
// Workspace source: the audit funnel's vocabulary
// ============================================

/** Standard transitions for config- and lifecycle-shaped subjects. */
const CRUD_OPS = ["created", "updated", "deleted"] as const;

/**
 * Subjects `recordLifecycleEvent` reports on. Platform objects, NOT user-defined
 * entity types: a row in `entities` reports through the `entity` subject below,
 * narrowed by the trigger's `entity_type` field.
 *
 * The writer is typed against this union, so a subject that is emitted but not
 * listed here is a compile error rather than an event nothing can subscribe to.
 */
export const AUDIT_LIFECYCLE_SUBJECTS = [
	// Personal access tokens: minted (`created`) and revoked (`deleted`).
	"access_token",
	"agent",
	"automation",
	"client",
	"connection",
	"device",
	// Also a workspace audit subject, emitted by a different writer. Listing it
	// twice is harmless — the catalog dedupes by `<subject>.<op>` key — and the
	// type must carry it or `auth/index.tsx` cannot compile.
	"member",
] as const;

export type AuditLifecycleSubject = (typeof AUDIT_LIFECYCLE_SUBJECTS)[number];

/** Transitions `insertEdgeChangeEventInTransaction` reports, past-tense. */
export const EDGE_OPS = ["linked", "unlinked", "updated"] as const;

export type EdgeOp = (typeof EDGE_OPS)[number];

/**
 * Every `<subject>.<op>` the audit funnel can produce.
 *
 * Ops are listed per subject rather than crossed with every subject, so the
 * catalog names only pairs a writer actually emits: `relationship.linked` is
 * real, `relationship.created` is not, and offering the latter would be a
 * subscription that can never fire.
 */
function buildWorkspacePlatformEventTypes(): Map<string, string> {
	const types = new Map<string, string>();
	const add = (subject: string, ops: readonly string[], what: string) => {
		for (const op of ops) types.set(`${subject}.${op}`, `${what} ${op}`);
	};
	for (const subject of CONFIG_RESOURCE_KINDS) {
		add(subject, CRUD_OPS, `Workspace configuration — ${subject}`);
	}
	for (const subject of WORKSPACE_AUDIT_RESOURCE_KINDS) {
		add(subject, CRUD_OPS, `Workspace identity — ${subject}`);
	}
	for (const subject of AUDIT_LIFECYCLE_SUBJECTS) {
		add(
			subject,
			subject === "access_token" ? ["created", "deleted"] : CRUD_OPS,
			`Platform object — ${subject}`,
		);
	}
	// Entity rows report under one subject; `entity_type` on the trigger is what
	// narrows a subscription to invoices or tickets. Only `updated` is emitted —
	// the entity-row writer stamps updates alone; entity creates and deletes
	// carry no `<subject>.<op>` audit event at all.
	add("entity", ["updated"], "Entity record");
	add("relationship", EDGE_OPS, "Entity relationship");
	return types;
}

const WORKSPACE_PLATFORM_EVENT_TYPES = buildWorkspacePlatformEventTypes();

export interface WorkspacePlatformEventDef {
	description: string;
}

/**
 * The catalog in `entity_types.event_kinds` shape, so trigger validation and
 * the picker can union it with the declared catalogs instead of special-casing
 * platform events.
 *
 * Deliberately NOT merged into `$member.event_kinds`, which is the org-wide
 * registry for *savable content* kinds. That registry gates `save_content`, so
 * a platform type listed there would let a caller post
 * `semantic_type: "device.deleted"` as ordinary content and have it match real
 * subscriptions. Subscription validation unions the two; content validation
 * must not.
 */
export function platformEventKinds(): Record<string, WorkspacePlatformEventDef> {
	const kinds: Record<string, WorkspacePlatformEventDef> = {};
	for (const [eventType, description] of WORKSPACE_PLATFORM_EVENT_TYPES) {
		kinds[eventType] = { description };
	}
	return kinds;
}

/** True when the audit funnel can emit this `<subject>.<op>` type. */
export function isPlatformEventType(eventType: string): boolean {
	return WORKSPACE_PLATFORM_EVENT_TYPES.has(eventType);
}
