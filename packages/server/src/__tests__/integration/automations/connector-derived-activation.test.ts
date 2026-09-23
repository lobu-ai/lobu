import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	deriveConnectorActivationSignals,
	type ConnectorDeriveEventInput,
	type ConnectorDeriveFeedContext,
} from "../../../automations/connector-derived";
import { activateAutomationSignal } from "../../../automations/activation";
import type { Env } from "../../../index";
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

	it("ingests an overlong origin_id without blowing the idempotency btree", async () => {
		// A user-controlled origin_id (e.g. a postgres text PK) can exceed the
		// btree row-size limit. The derived delivery_id must key on the bounded
		// persisted event id, not the origin_id, or the run INSERT fails inside
		// the event transaction and permanently blocks ingestion.
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
						id: "k".repeat(3_000),
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
