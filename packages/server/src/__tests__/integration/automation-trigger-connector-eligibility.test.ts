/**
 * The event-trigger eligibility guard in `assertAutomationTriggerConnections`.
 *
 * `withPlatformAutomationEvents` merges `feed.auto_paused` into EVERY connector's
 * catalog, so the original `catalog.events.length === 0` test could never be
 * true and the guard never fired — a connector that can drive nothing was
 * accepted. The replacement asks whether any event could actually reach the
 * Automation: a connector with no declared events is still legitimate IF it has a
 * feed to pause, and only becomes ineligible when it has neither.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { AutomationTrigger } from "@lobu/core/contracts/tools/manage-automations";
import { assertAutomationTriggerConnections } from "../../automations/triggers";
import { listCatalogEntries } from "../../catalog/load";
import { ensureMemberEntityType } from "../../utils/member-entity-type";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestOrganization } from "../setup/test-fixtures";

describe("event-trigger connector eligibility", () => {
	let orgId: string;
	let chatOrgId: string;

	async function defineConnector(
		key: string,
		opts: {
			events: Array<{ key: string }>;
			feeds: Record<string, unknown>;
		},
	): Promise<void> {
		// sql.json, not a raw string: postgres.js JSON-encodes a bare JS string,
		// so `${"[]"}::jsonb` lands as the jsonb STRING "[]" and trips
		// connector_definitions_automation_events_array_check.
		const sql = getTestDb();
		await sql`
			INSERT INTO connector_definitions
				(organization_id, key, name, version, auth_schema, feeds_schema,
				 automation_events, status)
			VALUES (${orgId}, ${key}, ${key}, '1.0.0',
				${sql.json({ methods: [{ type: "app_installation" }] })},
				${sql.json(opts.feeds)},
				${sql.json(opts.events)},
				'active')
			ON CONFLICT DO NOTHING
		`;
	}

	const eventTrigger = (
		connectorKey: string,
		eventType: string,
	): AutomationTrigger[] => [
		{
			kind: "event",
			connector_key: connectorKey,
			event_types: [eventType],
		},
	];

	beforeAll(async () => {
		await cleanupTestDatabase();
		orgId = (await createTestOrganization({ name: "Trigger Eligibility Org" }))
			.id;
		chatOrgId = (await createTestOrganization({ name: "Chat Catalog Org" })).id;
		const sql = getTestDb();
		await ensureMemberEntityType(orgId);
		await sql`
			INSERT INTO entity_types
			  (organization_id, slug, name, event_kinds)
			VALUES
			  (${orgId}, 'account', 'Account',
			   ${sql.json({ risk_detected: { description: "Risk detected" } })})
		`;
		await sql`
			UPDATE entity_types
			SET event_kinds = COALESCE(event_kinds, '{}'::jsonb) ||
				${sql.json({ org_wide_signal: { description: "Org-wide signal" } })}::jsonb
			WHERE organization_id = ${orgId}
			  AND slug = '$member'
		`;

		// No declared events, no feeds → nothing can ever fire.
		await defineConnector("elig-barren", { events: [], feeds: {} });
		// No declared events, but HAS a feed → feed.auto_paused is reachable.
		await defineConnector("elig-feeds-only", {
			events: [],
			feeds: { inbox: { type: "object" } },
		});
		// Declares a real event.
		await defineConnector("elig-rich", {
			events: [{ key: "message.created" }],
			feeds: {},
		});
	});

	it.each(["slack", "whatsapp", "telegram", "discord", "teams", "gchat"])(
		"accepts the bundled %s message trigger with its existing chat reply policy",
		async (connectorKey) => {
			// Exercise the same catalog and capability guard used to save an
			// Automation, rather than testing a detached metadata constant.
			const entry = (await listCatalogEntries(["connectors"])).connectors.find(
				(connector) => connector.id === connectorKey,
			);
			const event = entry?.detail.automation_events?.find(
				(candidate) => candidate.key === "message.created",
			);
			expect(event?.defaults).toEqual({
				execution: "turn",
				activeRun: "steer",
				output: "reply_to_source",
			});
			await expect(
				assertAutomationTriggerConnections(getTestDb(), chatOrgId, [{
					kind: "event",
					connector_key: connectorKey,
					event_types: ["message.created"],
					execution: "turn",
					active_run: "steer",
					output: "reply_to_source",
					match: { channel_id: "synthetic-conversation", mention_only: true },
				}]),
			).resolves.toBeUndefined();
		},
	);

	it("rejects a connector with no declared events AND no feeds", async () => {
		const sql = getTestDb();
		await expect(
			assertAutomationTriggerConnections(
				sql,
				orgId,
				eventTrigger("elig-barren", "feed.auto_paused"),
			),
		).rejects.toThrow(/cannot drive an event trigger/);
	});

	it("ACCEPTS a feeds-only connector on the platform feed.auto_paused event", async () => {
		// The capability this guard must not remove: "tell me when this feed
		// breaks" is legitimate for any connector that actually has a feed, even
		// though it declares no events of its own.
		const sql = getTestDb();
		await expect(
			assertAutomationTriggerConnections(
				sql,
				orgId,
				eventTrigger("elig-feeds-only", "feed.auto_paused"),
			),
		).resolves.toBeUndefined();
	});

	it("accepts a connector that declares a real event", async () => {
		const sql = getTestDb();
		await expect(
			assertAutomationTriggerConnections(
				sql,
				orgId,
				eventTrigger("elig-rich", "message.created"),
			),
		).resolves.toBeUndefined();
	});

	it("validates workspace-event types against the organization's event catalog", async () => {
		const sql = getTestDb();
		await expect(
			assertAutomationTriggerConnections(sql, orgId, [
				{
					kind: "event",
					source: "workspace",
					event_types: ["risk_detected"],
				},
			]),
		).resolves.toBeUndefined();

		await expect(
			assertAutomationTriggerConnections(sql, orgId, [
				{
					kind: "event",
					source: "workspace",
					entity_type: "account",
					event_types: ["org_wide_signal"],
				},
			]),
		).resolves.toBeUndefined();

		await expect(
			assertAutomationTriggerConnections(sql, orgId, [
				{
					kind: "event",
					source: "workspace",
					entity_type: "account",
					event_types: ["risk_detected"],
				},
			]),
		).resolves.toBeUndefined();

		await expect(
			assertAutomationTriggerConnections(sql, orgId, [
				{
					kind: "event",
					source: "workspace",
					entity_type: "missing-type",
					event_types: ["risk_detected"],
				},
			]),
		).rejects.toThrow(/entity type 'missing-type' was not found/i);

		await expect(
			assertAutomationTriggerConnections(sql, orgId, [
				{
					kind: "event",
					source: "workspace",
					entity_type: "account",
					event_types: ["undeclared_kind"],
				},
			]),
		).rejects.toThrow(/does not declare workspace event 'undeclared_kind'/i);
	});

	it("keeps the bundled curated catalog for a legacy bundled connector with NULL automation_events", async () => {
		// A legacy bundled install predates the persisted automation_events column:
		// the row has NULL automation_events and a feeds_schema matching the
		// bundled artifact. Its curated catalog (`pull_request.created` etc.)
		// must win over the default-on derivation, so a live trigger keeps
		// matching instead of being rejected against derived kind slugs.
		const sql = getTestDb();
		const githubBundled = (await listCatalogEntries(["connectors"])).connectors.find(
			(entry) => entry.id === "github",
		);
		await sql`
			INSERT INTO connector_definitions
				(organization_id, key, name, version, auth_schema, feeds_schema,
				 automation_events, status)
			VALUES (${orgId}, 'github', 'GitHub', '3.11.0',
				${sql.json({ methods: [{ type: "app_installation" }] })},
				${sql.json(githubBundled?.detail.feeds_schema ?? {})},
				NULL,
				'active')
			ON CONFLICT DO NOTHING
		`;

		await expect(
			assertAutomationTriggerConnections(
				sql,
				orgId,
				eventTrigger("github", "pull_request.created"),
			),
		).resolves.toBeUndefined();
	});

	it("derives from an org-scoped override's own eventKinds, not the bundled catalog", async () => {
		// An org-scoped connector that shares the bundled 'slack' key but
		// declares its OWN eventKinds (and omits automationEvents) must never be
		// resolved against the bundled curated catalog — even when it reuses the
		// bundled feedsSchema — because its code emits kind slugs, not curated
		// keys, and a catalog advertising the latter accepts Automations that never
		// fire. Provenance: the active version is org-scoped.
		const sql = getTestDb();
		await sql`
			INSERT INTO connector_definitions
				(organization_id, key, name, version, auth_schema, feeds_schema,
				 automation_events, status)
			VALUES (${orgId}, 'slack', 'Custom Slack', '9.9.9',
				${sql.json({ methods: [{ type: "app_installation" }] })},
				${sql.json({ incidents: { eventKinds: { incident: {} } } })},
				NULL,
				'active')
			ON CONFLICT DO NOTHING
		`;
		await sql`
			INSERT INTO connector_versions
				(organization_id, connector_key, version, created_at)
			VALUES (${orgId}, 'slack', '9.9.9', NOW())
			ON CONFLICT DO NOTHING
		`;

		// The override's derived kind is authorable…
		await expect(
			assertAutomationTriggerConnections(
				sql,
				orgId,
				eventTrigger("slack", "incident"),
			),
		).resolves.toBeUndefined();

		// …but a bundled curated type the override's code cannot emit is not.
		await expect(
			assertAutomationTriggerConnections(
				sql,
				orgId,
				eventTrigger("slack", "message.created"),
			),
		).rejects.toThrow(/does not support Automation event/i);
	});

	it("rejects feed.auto_paused for an org-scoped override with no feeds of its own", async () => {
		// A bundled-key override with automation_events=[] and a NULL feeds_schema
		// must not inherit the bundled feeds for the eligibility count — it has
		// no feed to pause, so feed.auto_paused cannot reach it.
		const sql = getTestDb();
		await sql`
			INSERT INTO connector_definitions
				(organization_id, key, name, version, auth_schema, feeds_schema,
				 automation_events, status)
			VALUES (${orgId}, 'linkedin', 'Empty LinkedIn Override', '8.8.8',
				${sql.json({ methods: [{ type: "app_installation" }] })},
				NULL,
				${sql.json([])},
				'active')
			ON CONFLICT DO NOTHING
		`;
		await sql`
			INSERT INTO connector_versions
				(organization_id, connector_key, version, created_at)
			VALUES (${orgId}, 'linkedin', '8.8.8', NOW())
			ON CONFLICT DO NOTHING
		`;

		await expect(
			assertAutomationTriggerConnections(
				sql,
				orgId,
				eventTrigger("linkedin", "feed.auto_paused"),
			),
		).rejects.toThrow(/cannot drive an event trigger/i);
	});
});
