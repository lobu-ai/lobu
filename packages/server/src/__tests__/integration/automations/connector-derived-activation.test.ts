import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	deriveConnectorActivationSignals,
	type ConnectorDeriveEventInput,
	type ConnectorDeriveFeedContext,
} from "../../../automations/connector-derived";
import { activateAutomationSignal } from "../../../automations/activation";
import { listOrgInstalled } from "../../../catalog/installed";
import type { Env } from "../../../index";
import { MAX_ORIGIN_ID_BYTES } from "../../../worker-api/run-lifecycle";
import { manageAutomations } from "../../../tools/admin/manage_automations";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { post } from "../../setup/test-helpers";
import {
	createTestAgent,
	createTestConnection,
	seedOwnerContext,
} from "../../setup/test-fixtures";

describe("platform-derived connector activation", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it.each(["declared", "derived"])("queues thread.updated on a reply supersede with a %s catalog", async (catalog) => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
		const connectorKey = "test_derived_updates";
		const connection = await createTestConnection({
			organization_id: org.id, connector_key: connectorKey,
			slug: "test-thread-updates", created_by: user.id,
		});
		const db = getTestDb();
		// The declared variant isolates activation from catalog validation: an
		// accepted subscription alone does not prove ingestion emits the reply.
		const declared = catalog === "declared"
			? ["thread", "thread.updated", "note"].map((key) => ({ key, label: key }))
			: null;
		await db`
			INSERT INTO connector_definitions (organization_id, key, name, feeds_schema, automation_events, status)
			VALUES (${org.id}, ${connectorKey}, 'Test updates', ${db.json({
				threads: { eventKinds: { thread: { updatedEvent: true }, note: {} } },
			})}, ${declared ? db.json(declared) : null}, 'active')
		`;
		const installed = await listOrgInstalled(org.id, ["connectors"], ctx);
		const entry = installed.connectors?.items.find((item) => item.id === connectorKey);
		expect(entry?.detail.feeds_schema).toMatchObject({ threads: { eventKinds: { thread: { updatedEvent: true } } } });
		expect(entry?.detail.automation_events).toEqual(expect.arrayContaining([
			expect.objectContaining({ key: "thread" }),
			expect.objectContaining({ key: "thread.updated" }),
		]));
		const [feed] = await db`
			INSERT INTO feeds (organization_id, connection_id, feed_key, status)
			VALUES (${org.id}, ${connection.id}, 'threads', 'active') RETURNING id
		`;
		const feedId = Number(feed.id);
		await db`
			INSERT INTO runs (organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, approval_status)
			VALUES (${org.id}, 'sync', ${feedId}, ${connection.id}, ${connectorKey}, '1.0.0', 'completed', 'auto')
		`;
		const [sync] = await db`
			INSERT INTO runs (organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, approval_status)
			VALUES (${org.id}, 'sync', ${feedId}, ${connection.id}, ${connectorKey}, '1.0.0', 'running', 'auto') RETURNING id
		`;
		const subscribe = async (kind: string) => {
			const created = await manageAutomations({
				action: "create", slug: `listen-${kind.replaceAll(".", "-")}`,
				name: `Listen ${kind}`, prompt: "Read the source activity.",
				managed_agent_id: agent.agentId,
				triggers: [{ kind: "event", source: "connector", connector_key: connectorKey,
					connection_id: connection.id, event_types: [kind], execution: "turn",
					active_run: "queue", output: "silent", skip_if_unchanged: true }],
			}, {} as Env, ctx);
			expect(created).toHaveProperty("automation_id");
			if (!("automation_id" in created)) throw new Error("Subscription was rejected");
			return Number(created.automation_id);
		};
		const insertedId = await subscribe("thread");
		const updatedId = await subscribe("thread.updated");
		const noteId = await subscribe("note");
		const runsFor = (id: number) => db`
			SELECT approved_input FROM runs WHERE automation_id = ${id} ORDER BY id
		`;
		const stream = async (item: Record<string, unknown>) => {
			const res = await post("/api/workers/stream", {
				body: { type: "batch", run_id: Number(sync.id), items: [item] },
			});
			expect(res.status).toBe(200);
			return db`
				SELECT id, supersedes_event_id, superseded_by FROM events
				WHERE connection_id = ${connection.id} AND origin_id = ${String(item.id)} ORDER BY id
			`;
		};
		const initial = { id: "test-thread-1", origin_type: "thread", title: "Test thread",
			payload_text: "Original message", occurred_at: "2026-08-11T09:00:00.000Z",
			metadata: { message_count: 1 } };
		const first = await stream(initial);
		expect(first).toHaveLength(1);
		expect(await runsFor(insertedId)).toHaveLength(1);
		expect(await runsFor(updatedId)).toHaveLength(0);
		const reply = { ...initial, payload_text: "Original message\nNew reply",
			occurred_at: "2026-08-11T10:00:00.000Z", metadata: { message_count: 2 } };
		const second = await stream(reply);
		expect(second).toHaveLength(2);
		expect(Number(second[1].supersedes_event_id)).toBe(Number(first[0].id));
		expect(Number(second[0].superseded_by)).toBe(Number(second[1].id));
		expect(await runsFor(insertedId)).toHaveLength(1);
		const updates = await runsFor(updatedId);
		expect(updates).toHaveLength(1);
		expect(updates[0].approved_input).toMatchObject({
			delivery_ids: [`derived:${connectorKey}:${connection.id}:event:${second[1].id}`],
		});
		expect(JSON.stringify(updates[0].approved_input)).toContain("New reply");
		expect(await stream(reply)).toHaveLength(2); // unchanged replay
		const counters = { ...reply, metadata: { ...reply.metadata, reply_count: 9 } };
		expect(await stream(counters)).toHaveLength(2); // volatile-only state_updated
		expect(await stream({ ...counters, payload_text: "Reformatted original and reply" })).toHaveLength(3);
		expect(await runsFor(updatedId)).toHaveLength(1); // same activity time
		expect(await runsFor(insertedId)).toHaveLength(1);
		const note = { ...initial, id: "test-note-1", origin_type: "note" };
		await stream(note);
		expect(await stream({ ...note, payload_text: "Edited note", occurred_at: reply.occurred_at })).toHaveLength(2);
		expect(await runsFor(noteId)).toHaveLength(1); // no opt-in: inserts only
		expect(await runsFor(updatedId)).toHaveLength(1);
		// A literal kind in another feed owns its slug across this connector.
		await db`
			UPDATE connector_definitions SET feeds_schema = ${db.json({
				threads: { eventKinds: { thread: { updatedEvent: true }, note: {} } },
				literal: { eventKinds: { "thread.updated": {} } },
			})} WHERE organization_id = ${org.id} AND key = ${connectorKey}
		`;
		expect(await stream({ ...reply, payload_text: "Another reply", occurred_at: "2026-08-11T11:00:00.000Z" })).toHaveLength(4);
		expect(await runsFor(updatedId)).toHaveLength(1);
	});

	it("creates a trigger for a derived kind and queues a run when a new feed event lands", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "x",
			slug: "xconn-derived",
			created_by: user.id,
		});

		// A timeline-listener trigger on the derived kind `tweet`. Creation
		// proves the connector's automation_events catalog was derived from its
		// eventKinds (X declares none by hand).
		const created = await manageAutomations(
			{
				action: "create",
				slug: "x-home-listener",
				name: "X home listener",
				prompt: "Draft a reply worth making.",
				managed_agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						source: "connector",
						connector_key: "x",
						connection_id: connection.id,
						event_types: ["tweet"],
						execution: "turn",
						active_run: "queue",
						output: "silent",
						skip_if_unchanged: true,
					},
				],
			},
			{} as Env,
			ctx,
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);

		const deriveContext: ConnectorDeriveFeedContext = {
			connectorKey: "x",
			feedPreviouslySynced: true,
			eventKinds: {
				tweet: { description: "A tweet from your home timeline" },
			},
		};
		const event: ConnectorDeriveEventInput = {
			connectionId: connection.id,
			originId: "2083959735481716957",
			kind: "tweet",
			title: "someone: hello",
			payloadText: "hello from the home timeline",
			sourceUrl: "https://x.com/someone/status/2083959735481716957",
			occurredAt: "2026-08-11T10:00:00.000Z",
			metadata: { author_handle: "someone" },
		};

		const [signal] = deriveConnectorActivationSignals(
			deriveContext,
			event,
			"inserted",
			123,
		);
		expect(signal).toBeDefined();
		const activations = await activateAutomationSignal({
			organizationId: org.id,
			signal,
		});
		expect(activations).toMatchObject([
			{ automationId, created: true, disposition: "queued" },
		]);

		const sql = getTestDb();
		const runs = await sql`
			SELECT approved_input
			FROM runs
			WHERE automation_id = ${automationId}
			ORDER BY id ASC
		`;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.approved_input).toMatchObject({
			dispatch_source: "event",
			trigger_execution: "turn",
			delivery_ids: [`derived:x:${connection.id}:event:123`],
		});
	});

	it("queues nothing on the first sync before any successful run (backfill)", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "x",
			slug: "xconn-coldstart",
			created_by: user.id,
		});
		const db = getTestDb();
		await db`
			INSERT INTO connector_definitions (organization_id, key, name, feeds_schema, status)
			VALUES (${org.id}, 'x', 'X', ${db.json({
				home_feed: { eventKinds: { tweet: {} } },
			})}, 'active')
		`;
		const [feed] = await db`
			INSERT INTO feeds (organization_id, connection_id, feed_key, status, created_at, updated_at)
			VALUES (${org.id}, ${connection.id}, 'home_feed', 'active', NOW(), NOW())
			RETURNING id
		`;
		const feedId = Number((feed as { id: number }).id);
		// No prior completed sync — this is the cold-start backfill.
		const [run] = await db`
			INSERT INTO runs
				(organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, approval_status, created_at)
			VALUES
				(${org.id}, 'sync', ${feedId}, ${connection.id}, 'x', '1.0.0', 'running', 'auto', current_timestamp)
			RETURNING id
		`;
		const runId = Number((run as { id: number }).id);
		const created = await manageAutomations(
			{
				action: "create",
				slug: "x-cold-listener",
				name: "X cold listener",
				prompt: "Draft a reply worth making.",
				managed_agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						source: "connector",
						connector_key: "x",
						connection_id: connection.id,
						event_types: ["tweet"],
						execution: "turn",
						active_run: "queue",
						output: "silent",
						skip_if_unchanged: true,
					},
				],
			},
			{} as Env,
			ctx,
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);

		const res = await post("/api/workers/stream", {
			body: {
				type: "batch",
				run_id: runId,
				items: [
					{
						id: "1",
						origin_type: "tweet",
						title: "someone: hello",
						payload_text: "hello",
						occurred_at: "2026-08-11T10:00:00.000Z",
					},
				],
			},
		});
		expect(res.status).toBe(200);

		const runs = await db`
			SELECT id FROM runs WHERE automation_id = ${automationId}
		`;
		expect(runs).toHaveLength(0);
	});

	it("queues a run through the real ingest seam (connector definition → feed → stream)", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "x",
			slug: "xconn-stream",
			created_by: user.id,
		});
		const db = getTestDb();

		// Install the connector definition so the derive seam can resolve the
		// feed's eventKinds and read its activation context.
		await db`
			INSERT INTO connector_definitions (organization_id, key, name, feeds_schema, status)
			VALUES (${org.id}, 'x', 'X', ${db.json({
				home_feed: { eventKinds: { tweet: { description: "A tweet" } } },
			})}, 'active')
		`;
		const [feed] = await db`
			INSERT INTO feeds (organization_id, connection_id, feed_key, status, created_at, updated_at)
			VALUES (${org.id}, ${connection.id}, 'home_feed', 'active', NOW(), NOW())
			RETURNING id
		`;
		const feedId = Number((feed as { id: number }).id);
		// A prior successful sync puts the feed in steady state (backfill done).
		await db`
			INSERT INTO runs
				(organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, approval_status, created_at)
			VALUES
				(${org.id}, 'sync', ${feedId}, ${connection.id}, 'x', '1.0.0', 'completed', 'auto', current_timestamp)
		`;
		const [run] = await db`
			INSERT INTO runs
				(organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, approval_status, created_at)
			VALUES
				(${org.id}, 'sync', ${feedId}, ${connection.id}, 'x', '1.0.0', 'running', 'auto', current_timestamp)
			RETURNING id
		`;
		const runId = Number((run as { id: number }).id);

		const created = await manageAutomations(
			{
				action: "create",
				slug: "x-stream-listener",
				name: "X stream listener",
				prompt: "Draft a reply worth making.",
				managed_agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						source: "connector",
						connector_key: "x",
						connection_id: connection.id,
						event_types: ["tweet"],
						execution: "turn",
						active_run: "queue",
						output: "silent",
						skip_if_unchanged: true,
					},
				],
			},
			{} as Env,
			ctx,
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);

		const res = await post("/api/workers/stream", {
			body: {
				type: "batch",
				run_id: runId,
				items: [
					{
						id: "2083959735481716957",
						origin_type: "tweet",
						title: "someone: hello",
						payload_text: "hello from the home timeline",
						occurred_at: "2026-08-11T10:00:00.000Z",
					},
				],
			},
		});
		expect(res.status).toBe(200);

		const runs = await db`
			SELECT approved_input
			FROM runs
			WHERE automation_id = ${automationId}
			ORDER BY id ASC
		`;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.approved_input).toMatchObject({
			dispatch_source: "event",
			trigger_execution: "turn",
			delivery_ids: [expect.stringMatching(new RegExp(`^derived:x:${connection.id}:event:\\d+$`))],
		});
	});

	it("queues nothing for a deleted feed even if a late batch arrives", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "x",
			slug: "xconn-deleted",
			created_by: user.id,
		});
		const db = getTestDb();
		await db`
			INSERT INTO connector_definitions (organization_id, key, name, feeds_schema, status)
			VALUES (${org.id}, 'x', 'X', ${db.json({
				home_feed: { eventKinds: { tweet: {} } },
			})}, 'active')
		`;
		const [feed] = await db`
			INSERT INTO feeds (organization_id, connection_id, feed_key, status, deleted_at, created_at, updated_at)
			VALUES (${org.id}, ${connection.id}, 'home_feed', 'active', NOW(), NOW(), NOW())
			RETURNING id
		`;
		const feedId = Number((feed as { id: number }).id);
		// A prior completed sync puts the feed past cold start, so the deleted_at
		// guard — not the backfill gate — is what must suppress the late batch.
		await db`
			INSERT INTO runs
				(organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, approval_status, created_at)
			VALUES
				(${org.id}, 'sync', ${feedId}, ${connection.id}, 'x', '1.0.0', 'completed', 'auto', current_timestamp)
		`;
		const [run] = await db`
			INSERT INTO runs
				(organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, approval_status, created_at)
			VALUES
				(${org.id}, 'sync', ${feedId}, ${connection.id}, 'x', '1.0.0', 'running', 'auto', current_timestamp)
			RETURNING id
		`;
		const runId = Number((run as { id: number }).id);
		const created = await manageAutomations(
			{
				action: "create",
				slug: "x-deleted-listener",
				name: "X deleted listener",
				prompt: "Draft a reply worth making.",
				managed_agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						source: "connector",
						connector_key: "x",
						connection_id: connection.id,
						event_types: ["tweet"],
						execution: "turn",
						active_run: "queue",
						output: "silent",
						skip_if_unchanged: true,
					},
				],
			},
			{} as Env,
			ctx,
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);

		const res = await post("/api/workers/stream", {
			body: {
				type: "batch",
				run_id: runId,
				items: [
					{
						id: "1",
						origin_type: "tweet",
						title: "someone: hello",
						payload_text: "hello",
						occurred_at: "2026-08-11T10:00:00.000Z",
					},
				],
			},
		});
		// The page is refused whole: a deleted feed accepts no events, so there
		// is nothing an Automation could be activated by.
		expect(res.status).toBe(409);
		const events = await db`
			SELECT id FROM events WHERE connection_id = ${connection.id}
		`;
		expect(events).toHaveLength(0);

		const runs = await db`
			SELECT id FROM runs WHERE automation_id = ${automationId}
		`;
		expect(runs).toHaveLength(0);
	});

	it("derives a bounded delivery_id from an origin_id at the ingest limit", async () => {
		// The stream bounds origin_id, but derived delivery identity must still
		// use the persisted event id rather than copying the source key.
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "x",
			slug: "xconn-overlong",
			created_by: user.id,
		});
		const db = getTestDb();
		await db`
			INSERT INTO connector_definitions (organization_id, key, name, feeds_schema, status)
			VALUES (${org.id}, 'x', 'X', ${db.json({
				home_feed: { eventKinds: { tweet: {} } },
			})}, 'active')
		`;
		const [feed] = await db`
			INSERT INTO feeds (organization_id, connection_id, feed_key, status, created_at, updated_at)
			VALUES (${org.id}, ${connection.id}, 'home_feed', 'active', NOW(), NOW())
			RETURNING id
		`;
		const feedId = Number((feed as { id: number }).id);
		await db`
			INSERT INTO runs
				(organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, approval_status, created_at)
			VALUES
				(${org.id}, 'sync', ${feedId}, ${connection.id}, 'x', '1.0.0', 'completed', 'auto', current_timestamp)
		`;
		const [run] = await db`
			INSERT INTO runs
				(organization_id, run_type, feed_id, connection_id, connector_key, connector_version, status, approval_status, created_at)
			VALUES
				(${org.id}, 'sync', ${feedId}, ${connection.id}, 'x', '1.0.0', 'running', 'auto', current_timestamp)
			RETURNING id
		`;
		const runId = Number((run as { id: number }).id);
		const created = await manageAutomations(
			{
				action: "create",
				slug: "x-overlong-listener",
				name: "X overlong listener",
				prompt: "Draft a reply worth making.",
				managed_agent_id: agent.agentId,
				triggers: [
					{
						kind: "event",
						source: "connector",
						connector_key: "x",
						connection_id: connection.id,
						event_types: ["tweet"],
						execution: "turn",
						active_run: "queue",
						output: "silent",
						skip_if_unchanged: true,
					},
				],
			},
			{} as Env,
			ctx,
		);
		if (created.action !== "create" || !("automation_id" in created)) {
			throw new Error("Automation creation did not complete");
		}
		const automationId = Number(created.automation_id);

		const res = await post("/api/workers/stream", {
			body: {
				type: "batch",
				run_id: runId,
				items: [
					{
						id: "k".repeat(MAX_ORIGIN_ID_BYTES),
						origin_type: "tweet",
						title: "someone: hello",
						payload_text: "hello",
						occurred_at: "2026-08-11T10:00:00.000Z",
					},
				],
			},
		});
		expect(res.status).toBe(200);

		const runs = await db`
			SELECT approved_input
			FROM runs
			WHERE automation_id = ${automationId}
			ORDER BY id ASC
		`;
		expect(runs).toHaveLength(1);
		expect(
			(runs[0]?.approved_input as { delivery_ids?: string[] }).delivery_ids?.[0],
		).toMatch(new RegExp(`^derived:x:${connection.id}:event:\\d+$`));
	});
});
