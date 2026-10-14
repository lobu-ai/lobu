import type { EventChangeKind } from "../utils/insert-event";
import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import { type DbClient, getDb } from "../db/client";

/**
 * Platform-derived connector activation: the events table is the bus, and the
 * connector's declared `eventKinds` are the subscribable catalog. When a feed
 * sync lands a new event, the platform builds the Automation trigger signal
 * itself instead of the connector hand-writing `automation_signals`.
 *
 * Convention (default-on, no per-connector declaration needed):
 *  - `event_type` is the feed's declared kind slug.
 *  - Only `change === 'inserted'` activates. A re-scraped row that supersedes
 *    the current head (e.g. an X tweet whose engagement metrics moved) is not
 *    a new source item and does not re-fire — that is what a listener wants.
 *
 * Feed scoping is deliberately NOT exposed: events dedupe by
 * (connection_id, origin_id), so an origin first observed by one feed (e.g. an
 * X tweet seen by the `tweets` search feed) is `unchanged` when another feed
 * (`home_feed`) later observes it — a `match: { feed_key }` subscription would
 * silently miss it. A `feed_key` attribute belongs on the signal only once a
 * durable per-feed first-seen record keyed by (feed_id, origin_id) exists.
 *
 * Safety bounds:
 *  - Ingestion only activates once the feed has a prior successful non-dry
 *    sync; a cold-start backfill would flood subscribers with every first-seen
 *    row. A live `record` delivery skips only this gate: a verified provider
 *    push is steady-state by definition, and it never counts as a poll.
 *  - Only kinds the feed declares are activatable, so a trigger a user could
 *    never author (the picker reads the same catalog) can never fire.
 */

export interface ConnectorDeriveFeedContext {
	connectorKey: string;
	/** A prior successful, non-dry poll sync exists for this feed, or the page is a live record. */
	feedPreviouslySynced: boolean;
	/** Declared eventKinds for this feed, or null when the connector declares none. */
	eventKinds: Record<string, unknown> | null;
}

export interface ConnectorDeriveEventInput {
	connectionId: number | null;
	originId: string;
	kind: string;
	title: string | null;
	payloadText: string | null;
	sourceUrl: string | null;
	occurredAt: Date | string;
	metadata: Record<string, unknown> | undefined;
}

/**
 * Load the per-feed context a batch of events shares (once per sync, not per
 * row). A feed/definition that resolves to no activation surface returns a
 * no-op context (no kinds, not previously synced) rather than throwing — only
 * a genuine query failure propagates, fail-closed, to the caller.
 */
export async function loadConnectorDeriveFeedContext(
	args: {
		organizationId: string;
		connectorKey: string;
		feedKey: string;
		feedId: number;
		/** A verified live provider record, which is never a cold-start backfill. */
		liveRecord?: boolean;
	},
	db?: DbClient,
): Promise<ConnectorDeriveFeedContext> {
	const sql = db ?? getDb();
	const rows = await sql<{
		event_kinds: unknown;
		feed_previously_synced: boolean;
	}>`
		SELECT
			d.feeds_schema -> ${args.feedKey} -> 'eventKinds' AS event_kinds,
			EXISTS (
				SELECT 1
				FROM runs r
				WHERE r.feed_id = f.id
				  AND r.run_type = 'sync'
				  AND r.status = 'completed'
				  AND NOT r.dry_run
			) AS feed_previously_synced
		FROM feeds f
		JOIN connections c
		  ON c.id = f.connection_id
		 AND c.organization_id = f.organization_id
		-- LEFT: a feed whose connector has no active definition (test harnesses,
		-- device manifests, org overrides removed) has no activation surface —
		-- that is a deterministic state, not an activation failure. Only a real
		-- query error below propagates (fail-closed); a missing definition just
		-- yields no eventKinds and therefore no activation.
		LEFT JOIN connector_definitions d
		  ON d.organization_id = f.organization_id
		 AND d.key = c.connector_key
		 AND d.status = 'active'
		WHERE f.id = ${args.feedId}
		  AND f.organization_id = ${args.organizationId}
		  AND f.feed_key = ${args.feedKey}
		  AND f.deleted_at IS NULL
		  AND c.connector_key = ${args.connectorKey}
		  AND c.deleted_at IS NULL
		LIMIT 1
	`;
	const row = rows[0];
	if (!row) {
		// The feed (or its connection) is not present — a sync referencing a
		// feed that no longer exists has no activation surface. Return a no-op
		// context so the batch ingests without activation; only a real query
		// failure aborts (fail-closed in the caller).
		return {
			connectorKey: args.connectorKey,
			feedPreviouslySynced: false,
			eventKinds: null,
		};
	}
	const eventKinds =
		row.event_kinds && typeof row.event_kinds === "object"
			? (row.event_kinds as Record<string, unknown>)
			: null;
	return {
		connectorKey: args.connectorKey,
		feedPreviouslySynced: args.liveRecord === true || row.feed_previously_synced,
		eventKinds,
	};
}

/**
 * Build the Automation trigger signals for one connector-ingested event, or `[]`
 * when the event must not activate. Pure: the caller already holds the durable
 * row inside the ingest transaction.
 */
export function deriveConnectorActivationSignals(
	ctx: ConnectorDeriveFeedContext,
	event: ConnectorDeriveEventInput,
	change: EventChangeKind,
	eventId: number,
): ConnectorTriggerSignal[] {
	if (change !== "inserted") return [];
	if (event.connectionId == null) return [];
	if (!ctx.feedPreviouslySynced) return [];
	if (ctx.eventKinds == null) return [];
	const kind = normalizeEventKind(event.kind);
	// An overlong kind has no activatable surface (same rule as the catalog).
	if (kind.length === 0 || ctx.eventKinds[kind] == null) return [];

	const occurred = new Date(event.occurredAt);
	const occurredAt = Number.isFinite(occurred.getTime())
		? occurred.toISOString()
		: new Date().toISOString();

	// Normalize to ConnectorAutomationSignalDraftSchema limits — the signal rides
	// the same persisted contract, and an oversized field (e.g. a huge
	// payload_text) would produce an invalid run input. Capped at the draft
	// schema maxima: input_text 32,000, label 300, url 2,000, resource_ref 500,
	// resource_type 100, attribute keys 100, string attribute values 1,000.
	const label = (
		event.title && event.title.trim().length > 0
			? event.title
			: `${ctx.connectorKey} ${event.kind}`
	).slice(0, 300);
	const inputText = (
		event.payloadText && event.payloadText.trim().length > 0
			? event.payloadText
			: event.title && event.title.trim().length > 0
				? event.title
				: `${ctx.connectorKey} ${event.kind}: ${event.originId}`
	).slice(0, 32_000);

	// `match` runs exact-equality over signal attributes; surface the row's
	// scalar metadata so connectors get matchable fields for free. null is a
	// valid match value (TriggerAttributeValueSchema includes Null), so it is
	// preserved; undefined and non-scalar object/array values are dropped.
	// Reserved provenance keys win: connector metadata must not be able to
	// rewrite the change attribute and route activation to the wrong kind.
	const attributes: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(event.metadata ?? {})) {
		if (key === "change" || key.length > 100 || value === undefined) continue;
		if (value === null) {
			attributes[key] = null;
		} else if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			attributes[key] =
				typeof value === "string" && value.length > 1_000
					? value.slice(0, 1_000)
					: value;
		}
	}
	attributes.change = change;

	// Omit resource_ref for an overlong origin_id rather than truncating it —
	// truncation could collide two distinct source identities.
	const resourceRef =
		event.originId.length <= 500 ? event.originId : undefined;

	// delivery_id is keyed on the persisted events.id, NOT the unbounded
	// origin_id: the idempotency_key built from it lives under a btree unique
	// index, and an overlong origin_id (e.g. a user-controlled postgres text
	// PK) would blow the index row-size limit and permanently block ingestion.
	// The event id is bounded, stable for dedupe (a re-emitted origin is
	// 'unchanged' and never derives), and matches the legacy signal path.
	return [
		{
			connector_key: ctx.connectorKey,
			connection_id: event.connectionId,
			resource_type: kind,
			...(resourceRef ? { resource_ref: resourceRef } : {}),
			event_type: kind,
			delivery_id: `derived:${ctx.connectorKey}:${event.connectionId}:event:${eventId}`,
			label,
			input_text: inputText,
			...(event.sourceUrl ? { url: event.sourceUrl.slice(0, 2_000) } : {}),
			occurred_at: occurredAt,
			attributes,
		},
	];
}

/**
 * Event-kind identity, kept verbatim and applied identically in the catalog and
 * at activation so a trigger the picker advertises always matches what the
 * signal emits. Kinds longer than the 100-char Automation-event bound are NOT
 * truncatable (two distinct long kinds sharing a prefix would collide into one
 * event_type) — they are skipped entirely on both surfaces: a connector that
 * declares an overlong kind simply gets no activatable surface for it.
 */
function normalizeEventKind(kind: string): string {
	return kind.length <= 100 ? kind : "";
}

/**
 * Under the default-on convention, every declared eventKind is a subscribable
 * Automation trigger type. Same-kind slugs across feeds aggregate into one entry
 * (the runtime fires `event_type = kind` for any feed). Returns `[]` when the
 * connector declares no eventKinds.
 */
export function deriveAutomationEventCatalogFromFeeds(
	feeds: unknown,
): Array<{ key: string; label: string }> {
	if (!feeds || typeof feeds !== "object") return [];
	const seen = new Set<string>();
	for (const feed of Object.values(feeds as Record<string, unknown>)) {
		if (!feed || typeof feed !== "object") continue;
		const eventKinds = (feed as Record<string, unknown>).eventKinds;
		if (!eventKinds || typeof eventKinds !== "object") continue;
		for (const kind of Object.keys(eventKinds as Record<string, unknown>)) {
			const normalized = normalizeEventKind(kind);
			if (normalized) seen.add(normalized);
		}
	}
	return [...seen].map((key) => ({
		key,
		label: key
			.split(/[._-]+/)
			.filter(Boolean)
			.map((part) => part[0]?.toUpperCase() + part.slice(1))
			.join(" "),
	}));
}

function parseDeclaredAutomationEvents(
	value: unknown,
): Array<Record<string, unknown> & { key: string }> {
	if (!Array.isArray(value)) return [];
	const out: Array<Record<string, unknown> & { key: string }> = [];
	for (const item of value) {
		if (
			typeof item === "object" &&
			item !== null &&
			typeof (item as { key?: unknown }).key === "string" &&
			(item as { key: string }).key.length > 0
		) {
			const entry = item as Record<string, unknown>;
			// Preserve every validated ConnectorAutomationEvent field — the UI
			// editor reads filterSchema/description/defaults/resourceType off
			// the catalog, not just key/label/capabilities.
			out.push({ ...entry, key: String(entry.key) });
		}
	}
	return out;
}

/** Bundled immutable catalog shape consumed by {@link resolveAutomationEventCatalog}. */
interface BundledAutomationCatalogEntry {
	automation_events?: unknown;
	feeds_schema?: unknown;
}

/**
 * Single source of truth for a connector's subscribable Automation event catalog,
 * shared by trigger validation and the UI picker so the two can never disagree.
 * Precedence: persisted declaration > bundled immutable catalog > default-on
 * derivation from eventKinds.
 *
 * The bundled catalog is used ONLY when provenance proves it: the active
 * definition resolves to the SHARED connector_versions row (organization_id
 * NULL — a bundled install), or the connector is not installed in this org at
 * all (pure catalog entry). An org-scoped override — even one that reuses the
 * bundled key and feedsSchema but omits automationEvents — must never resolve to
 * the bundled curated catalog, because its code emits kind slugs, not curated
 * keys, and a catalog that advertises the latter would accept Automations that
 * never fire.
 */
export function resolveAutomationEventCatalog(args: {
	persistedEvents: unknown;
	feedsSchema: unknown;
	bundled?: BundledAutomationCatalogEntry | null;
	/** Provenance: the resolved version is the shared (bundled) row, or not installed. */
	useBundledFallback: boolean;
}): Array<Record<string, unknown> & { key: string }> {
	const declared = parseDeclaredAutomationEvents(args.persistedEvents);
	if (declared.length > 0) return declared;

	const bundledDeclared = parseDeclaredAutomationEvents(args.bundled?.automation_events);
	if (args.useBundledFallback && bundledDeclared.length > 0) {
		return bundledDeclared;
	}

	// An org-scoped override, or a bundled install with no curated events:
	// derive from the feedsSchema of the definition's own code. An override
	// must NEVER fall back to the bundled feedsSchema (its code emits nothing
	// per its own schema); only a bundled-install resolution may borrow the
	// bundled feeds.
	return deriveAutomationEventCatalogFromFeeds(
		args.useBundledFallback
			? args.feedsSchema ?? args.bundled?.feeds_schema
			: args.feedsSchema,
	);
}
