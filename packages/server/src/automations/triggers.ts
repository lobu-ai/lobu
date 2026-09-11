import { isDeepStrictEqual } from "node:util";
import {
	normalizeWorkspaceEventTrigger,
	resolvedEventExecution,
	type AutomationEventTrigger,
	type AutomationScheduleTrigger,
	type AutomationTrigger,
	type AutomationWorkspaceEventTrigger,
} from "@lobu/core/contracts/tools/manage-automations";
import type { DbClient } from "../db/client";
import { listCatalogEntries } from "../catalog/load";
import { validateSchedule, validateTimezone } from "../utils/cron";
import { ToolUserError } from "../utils/errors";
import {
	platformEventKinds,
	withPlatformAutomationEvents,
} from "./platform-event-catalog";
import { resolveAutomationEventCatalog } from "./connector-derived";

export interface AutomationTriggerProjection {
	triggers: AutomationTrigger[];
	schedule: string | null;
	timezone: string | null;
}

interface AutomationEventDefinition {
	key: string;
	label?: string;
	capabilities?: {
		steering?: boolean;
		replyToSource?: boolean;
	};
}

interface ConnectorAutomationEventCatalog {
	name: string;
	events: AutomationEventDefinition[];
	/** Events the CONNECTOR itself declares, before platform events are merged
	 * in. `events` always has at least `feed.auto_paused`, so it can never be
	 * empty and cannot answer "can this connector drive a trigger at all". */
	declaredCount: number;
	/** Feeds the connector declares. `feed.auto_paused` only ever fires for a
	 * connector that HAS a feed to pause, so zero declared events plus zero
	 * feeds means no event can reach this Automation. */
	feedCount: number;
}

/** `feeds_schema` is an object keyed by feed key (`{}` for connectors that
 * declare none — non-null but empty, so a null check alone under-counts). */
function countDeclaredFeeds(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	return Object.keys(value).length;
}

async function getConnectorAutomationEventCatalog(
	sql: DbClient,
	organizationId: string,
	connectorKey: string
): Promise<ConnectorAutomationEventCatalog> {
	const rows = await sql`
		SELECT d.name, d.automation_events, d.feeds_schema,
		       cv.organization_id AS version_org_id
		FROM connector_definitions d
		LEFT JOIN LATERAL (
			SELECT organization_id
			FROM connector_versions
			WHERE connector_key = d.key AND version = d.version
			  AND (organization_id = d.organization_id OR organization_id IS NULL)
			ORDER BY organization_id NULLS LAST
			LIMIT 1
		) cv ON TRUE
		WHERE d.organization_id = ${organizationId}
		  AND d.key = ${connectorKey}
		  AND d.status = 'active'
		ORDER BY d.updated_at DESC
		LIMIT 1
	`;
	const row = rows[0] as
		| {
				name: string;
				automation_events: unknown;
				feeds_schema: unknown;
				version_org_id: string | null;
		  }
		| undefined;

	// Precedence: persisted declaration > bundled immutable catalog > default-on
	// derivation from eventKinds — shared with the UI picker so both surfaces
	// agree. The bundled fallback requires provenance: no installed row at all
	// (pure catalog entry), or an active version resolved from the SHARED
	// connector_versions row (organization_id NULL — a bundled install). An
	// org-scoped override never falls back to the bundled curated catalog, and
	// its feed count counts only its OWN feeds_schema (an override with no feeds
	// cannot pause a feed, so feed.auto_paused must not be accepted).
	const catalog = (await listCatalogEntries(["connectors"])).connectors.find(
		(entry) => entry.id === connectorKey
	);
	const useBundledFallback = row == null || row.version_org_id == null;
	const resolved = resolveAutomationEventCatalog({
		persistedEvents: row?.automation_events,
		feedsSchema: row?.feeds_schema,
		bundled: catalog?.detail,
		useBundledFallback,
	}) as AutomationEventDefinition[];
	const feedsForCount = useBundledFallback
		? row?.feeds_schema ?? catalog?.detail.feeds_schema
		: row?.feeds_schema;
	return {
		name: row?.name ?? catalog?.name ?? connectorKey,
		events: withPlatformAutomationEvents(
			resolved,
		) as AutomationEventDefinition[],
		declaredCount: resolved.length,
		feedCount: countDeclaredFeeds(feedsForCount),
	};
}

function normalizedEventTrigger(
	trigger: AutomationEventTrigger
): AutomationEventTrigger {
	const execution = resolvedEventExecution(trigger);
	const activeRun = trigger.active_run ?? "queue";
	const output = trigger.output ?? "silent";
	if (execution === "window" && activeRun === "steer") {
		throw new ToolUserError(
			"Window execution does not support steering; use queue or coalesce."
		);
	}
	if (execution === "window" && output === "reply_to_source") {
		throw new ToolUserError(
			"Window execution cannot reply to the source; use turn execution or silent output."
		);
	}
	if (activeRun === "steer" && output !== "reply_to_source") {
		throw new ToolUserError(
			"Steering requires a turn that replies to the source; use queue or coalesce for silent output."
		);
	}
	// Unchecked UI checkboxes serialize as false. For opt-in filters like
	// mention_only, false means "no filter" — not "invert the condition". Drop
	// those keys so stored match objects stay sparse and exact-equality matching
	// cannot invert semantics.
	let match = trigger.match;
	if (match && Object.keys(match).length > 0) {
		const cleaned: Record<string, string | number | boolean | null> = {};
		for (const [key, value] of Object.entries(match)) {
			if (key === "mention_only" && value === false) continue;
			cleaned[key] = value;
		}
		match = Object.keys(cleaned).length > 0 ? cleaned : undefined;
	} else {
		match = undefined;
	}
	return {
		...trigger,
		source: "connector",
		event_types: Array.from(new Set(trigger.event_types)),
		match,
		execution,
		active_run: activeRun,
		output,
		skip_if_unchanged: trigger.skip_if_unchanged ?? true,
	};
}

function normalizedScheduleTrigger(
	trigger: AutomationScheduleTrigger
): AutomationScheduleTrigger {
	const scheduleError = validateSchedule(trigger.cron);
	if (scheduleError) throw new ToolUserError(scheduleError);
	if (trigger.timezone) {
		const timezoneError = validateTimezone(trigger.timezone);
		if (timezoneError) throw new ToolUserError(timezoneError);
	}
	return {
		kind: "schedule",
		cron: trigger.cron.trim(),
		timezone: trigger.timezone ?? null,
		execution: "window",
		active_run: "coalesce",
		skip_if_unchanged: trigger.skip_if_unchanged ?? true,
	};
}

export function normalizeAutomationTriggers(
	triggers: AutomationTrigger[]
): AutomationTrigger[] {
	let scheduleCount = 0;
	return triggers.map((trigger) => {
		if (trigger.kind === "schedule") {
			scheduleCount++;
			if (scheduleCount > 1) {
				throw new ToolUserError(
					"An Automation can have at most one schedule trigger."
				);
			}
			return normalizedScheduleTrigger(trigger);
		}
		if (trigger.kind === "event" && trigger.source === "workspace") {
			return normalizeWorkspaceEventTrigger(trigger);
		}
		return normalizedEventTrigger(trigger);
	});
}

/** Compare trigger contracts after applying their canonical defaults. */
export function automationTriggersEqual(
	left: AutomationTrigger[],
	right: AutomationTrigger[]
): boolean {
	return isDeepStrictEqual(
		normalizeAutomationTriggers(left),
		normalizeAutomationTriggers(right)
	);
}

/**
 * Resolve the canonical trigger array and its indexed schedule projection.
 * Triggers are the only writable activation contract; schedule/timezone columns
 * are derived projections used by the scheduler.
 */
export function resolveAutomationTriggerWrite(args: {
	triggers?: AutomationTrigger[];
	currentTriggers?: AutomationTrigger[];
}): AutomationTriggerProjection {
	const current = normalizeAutomationTriggers(args.currentTriggers ?? []);
	const triggers =
		args.triggers !== undefined
			? normalizeAutomationTriggers(args.triggers)
			: [...current];

	const scheduleTrigger = triggers.find(
		(trigger): trigger is AutomationScheduleTrigger => trigger.kind === "schedule"
	);

	return {
		triggers,
		schedule: scheduleTrigger?.cron ?? null,
		timezone: scheduleTrigger?.timezone ?? null,
	};
}

/**
 * Whether this trigger set runs on stored instructions alone. An event trigger
 * executing as "turn" carries its own content — the incoming message/event is
 * the input, and the built-in default instruction applies when the Automation
 * has none. Schedule triggers, event triggers with execution "window", and an
 * empty trigger set (manual runs) have no such content, so they need an
 * instruction source.
 */
export function automationRequiresInstructions(
	triggers: AutomationTrigger[]
): boolean {
	if (triggers.length === 0) return true;
	return triggers.some(
		(trigger) =>
			trigger.kind === "schedule" ||
			(trigger.kind === "event" && resolvedEventExecution(trigger) === "window")
	);
}

/**
 * Declared outputs are finalized by complete_window. A turn execution is a
 * conversational agent turn and never enters that pipeline, so accepting both
 * on one Automation would silently ignore its output contract for some firings.
 */
export function assertAutomationOutputsUseWindowExecution(
	triggers: AutomationTrigger[],
	outputs: Record<string, unknown> | null | undefined
): void {
	if (!outputs || Object.keys(outputs).length === 0) return;
	const turnTrigger = triggers.find(
		(trigger) =>
			trigger.kind === "event" && resolvedEventExecution(trigger) === "turn"
	);
	if (!turnTrigger) return;
	throw new ToolUserError(
		"Declared outputs require window execution. Change every event trigger to execution 'window', or put turn triggers in a separate Automation."
	);
}

/**
 * Enforce the instruction-presence rule on a complete trigger + instruction
 * pair before either side is stored. Callers must pass the *final* resolved
 * values (inherited prompt/skills when omitted, resolved triggers after
 * write-merge).
 *
 * Any one of the three sources satisfies the requirement on its own. Pinned
 * skills remain separate from the stored prompt, while a reaction script
 * supplies the extraction contract through its exported `input` schema or the
 * free-form fallback. Dispatch provides the built-in extraction instruction
 * when a reaction-only Automation has no authored prompt.
 */
export function assertAutomationInstructions(
	triggers: AutomationTrigger[],
	instructions: string | null | undefined,
	skills?: ReadonlyArray<{ name: string; content: string }> | null,
	reactionScript?: string | null,
	executorSource?: string | null,
): void {
	if (!automationRequiresInstructions(triggers)) return;
	if (instructions?.trim()) return;
	if (skills?.some((skill) => skill.content.trim())) return;
	if (reactionScript?.trim()) return;
	if (executorSource?.trim()) return;
	throw new ToolUserError(
		"This Automation runs from a schedule, an analysis window, or manual runs, so it needs instructions: attach at least one skill, provide instruction text, or set a reaction script. Only event triggers with execution 'turn' may omit all three."
	);
}

/** Validate connection-scoped triggers against the owning organization. */
export async function assertAutomationTriggerConnections(
	sql: DbClient,
	organizationId: string,
	triggers: AutomationTrigger[]
): Promise<void> {
	const eventTriggers = triggers.filter(
		(trigger): trigger is AutomationEventTrigger =>
			trigger.kind === "event" && trigger.source !== "workspace"
	);
	const catalogs = new Map<string, ConnectorAutomationEventCatalog>();
	for (const trigger of eventTriggers) {
		if (trigger.connection_id) {
			const rows = await sql`
				SELECT connector_key
				FROM connections
				WHERE id = ${trigger.connection_id}
				  AND organization_id = ${organizationId}
				  AND deleted_at IS NULL
				LIMIT 1
			`;
			if (rows.length === 0) {
				throw new ToolUserError(
					`Connection ${trigger.connection_id} was not found in this organization.`
				);
			}
			if (String(rows[0]?.connector_key) !== trigger.connector_key) {
				throw new ToolUserError(
					`Connection ${trigger.connection_id} is not a ${trigger.connector_key} connection.`
				);
			}
		}

		let catalog = catalogs.get(trigger.connector_key);
		if (!catalog) {
			catalog = await getConnectorAutomationEventCatalog(
				sql,
				organizationId,
				trigger.connector_key
			);
			catalogs.set(trigger.connector_key, catalog);
		}
		// `catalog.events` ALWAYS carries the merged platform events, so the old
		// `events.length === 0` test could never be true and this guard never
		// fired. Ask the question that actually matters: can any event reach this
		// Automation? A connector with no declared events can still legitimately
		// trigger on `feed.auto_paused` — but only if it has a feed to pause.
		// Zero declared events AND zero feeds means nothing can ever fire.
		if (catalog.declaredCount === 0 && catalog.feedCount === 0) {
			throw new ToolUserError(
				`${catalog.name} cannot drive an event trigger: it declares no Automation events and has no feeds, so no event could ever fire.`
			);
		}
		const eventsByKey = new Map(
			catalog.events.map((event) => [event.key, event])
		);
		for (const eventType of trigger.event_types) {
			const event = eventsByKey.get(eventType);
			if (!event) {
				throw new ToolUserError(
					`${catalog.name} does not support Automation event '${eventType}'.`
				);
			}
			if (trigger.active_run === "steer" && !event.capabilities?.steering) {
				throw new ToolUserError(
					`${catalog.name} event '${eventType}' does not support steering.`
				);
			}
			if (
				trigger.output === "reply_to_source" &&
				!event.capabilities?.replyToSource
			) {
				throw new ToolUserError(
					`${catalog.name} event '${eventType}' does not support replying to the source.`
				);
			}
		}
	}

	const workspaceTriggers = triggers.filter(
		(trigger): trigger is AutomationWorkspaceEventTrigger =>
			trigger.kind === "event" && trigger.source === "workspace"
	);
	const eventKindsByEntityType = new Map<
		string,
		{ name: string; eventKinds: Record<string, unknown> }
	>();
	for (const trigger of workspaceTriggers) {
		const entityTypeSlug = trigger.entity_type;
		const catalogKey = entityTypeSlug ?? "*";
		let catalog = eventKindsByEntityType.get(catalogKey);
		if (!catalog) {
			const rows = await sql`
				SELECT slug, name, event_kinds
				FROM entity_types
				WHERE organization_id = ${organizationId}
				  AND deleted_at IS NULL
				  AND (
					${entityTypeSlug ?? null}::text IS NULL
					OR slug IN (${entityTypeSlug ?? null}, '$member')
				  )
				ORDER BY (slug = '$member') DESC, slug ASC
			`;
			const requestedType = entityTypeSlug
				? rows.find((row) => row.slug === entityTypeSlug)
				: undefined;
			if (entityTypeSlug && !requestedType) {
				throw new ToolUserError(
					`Workspace event trigger entity type '${entityTypeSlug}' was not found in this organization.`
				);
			}
			// Platform events union in on both branches. Without an entity type the
			// catalog is the whole workspace; WITH one, `entity.updated` narrowed by
			// `entity_type` is exactly how an Automation subscribes to "an invoice
			// changed", so dropping the union there would break the common case.
			const eventKinds = Object.assign(
				{},
				platformEventKinds(),
				...rows.map((row) =>
					row.event_kinds && typeof row.event_kinds === "object"
						? row.event_kinds
						: {}
				)
			);
			catalog = {
				name: entityTypeSlug
					? String(requestedType?.name ?? entityTypeSlug)
					: "Workspace",
				eventKinds,
			};
			eventKindsByEntityType.set(catalogKey, catalog);
		}
		for (const eventType of trigger.event_types) {
			if (!(eventType in catalog.eventKinds)) {
				throw new ToolUserError(
					`${catalog.name} does not declare workspace event '${eventType}'.`
				);
			}
		}
	}
}
