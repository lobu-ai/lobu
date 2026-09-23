/**
 * A gateway-inline operation run must stay alive while it executes.
 *
 * The inline claim stamps `last_heartbeat_at` once. The stale-run reaper
 * judges any heartbeating `action` run on that column against
 * `runsReaperStaleAfterSeconds`, so an inline execution that outlived the
 * threshold was reaped as `timeout` while the external call was still in
 * flight. The call then succeeded, the lease-fenced terminal write matched no
 * row, and the caller was told the run failed — inviting a retry that mutates
 * twice. The executor now refreshes the heartbeat, fenced on its own lease,
 * for as long as it executes.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../../index";
import { LOST_LEASE_MESSAGE } from "../../runs/run-lease";
import { reapStaleRuns } from "../../scheduled/check-stalled-executions";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createAuthProfile } from "../../utils/auth-profiles";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

const HTTP = "demo.ops.inline.heartbeat";
const SPEC_URL = "https://api.example.test/openapi-inline-heartbeat.json";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("gateway-inline run heartbeat", () => {
	let orgId: string;
	let ctx: ToolContext;
	let connectionId: number;
	let releaseUpstream: (() => void) | null = null;
	let upstreamCalled: Promise<void>;
	let markUpstreamCalled: () => void = () => {};
	const previousThreshold = process.env.RUNS_REAPER_STALE_AFTER_SECONDS;

	beforeAll(async () => {
		// A 1s reaper threshold keeps the test fast; the heartbeat cadence is
		// derived from it, so both scale together exactly as in production.
		process.env.RUNS_REAPER_STALE_AFTER_SECONDS = "1";
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user, ctx: ownerCtx } = await seedOwnerContext({
			orgName: "Inline Heartbeat Org",
		});
		ownerCtx.baseUrl = "https://gateway.test/lobu";
		orgId = org.id;
		ctx = ownerCtx;

		await createTestConnectorDefinition({
			key: HTTP,
			name: "Inline heartbeat HTTP",
			organization_id: orgId,
			auth_schema: { methods: [{ type: "oauth", provider: "test" }] },
		});
		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET openapi_config = ${sql.json({
				specUrl: SPEC_URL,
				serverUrl: "https://api.example.test",
			})}
			WHERE organization_id = ${orgId} AND key = ${HTTP}
		`;
		const connection = await createTestConnection({
			organization_id: orgId,
			connector_key: HTTP,
			created_by: user.id,
			visibility: "private",
			config: { action_modes: { create_item: "auto" } },
		});
		connectionId = connection.id;
		const accountId = `acct_${connectionId}_inline_heartbeat`;
		await sql`
			INSERT INTO "account" (
			  id, "accountId", "providerId", "userId",
			  "accessToken", "accessTokenExpiresAt", scope,
			  "createdAt", "updatedAt"
			) VALUES (
			  ${accountId}, ${accountId}, 'test', ${user.id},
			  'inline-heartbeat-token', ${new Date(Date.now() + 60 * 60 * 1000).toISOString()}, 'read write',
			  NOW(), NOW()
			)
		`;
		const profile = await createAuthProfile({
			organizationId: orgId,
			connectorKey: HTTP,
			displayName: "inline heartbeat OAuth",
			profileKind: "oauth_account",
			provider: "test",
			accountId,
			status: "active",
			createdBy: user.id,
		});
		await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${connectionId}`;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url === SPEC_URL) {
					return jsonResponse({
						openapi: "3.0.0",
						servers: [{ url: "https://api.example.test" }],
						paths: {
							"/items": {
								post: {
									operationId: "create_item",
									responses: { "200": { description: "ok" } },
								},
							},
						},
					});
				}
				if (url === "https://api.example.test/items") {
					markUpstreamCalled();
					// Hold the external mutation open until the test releases it,
					// standing in for a call that outlives the reaper threshold.
					await new Promise<void>((resolve) => {
						releaseUpstream = resolve;
					});
					return jsonResponse({ created: true });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
	});

	afterAll(() => {
		vi.unstubAllGlobals();
		if (previousThreshold === undefined) {
			delete process.env.RUNS_REAPER_STALE_AFTER_SECONDS;
		} else {
			process.env.RUNS_REAPER_STALE_AFTER_SECONDS = previousThreshold;
		}
	});

	it("is not reaped while its external call is still in flight", async () => {
		const sql = getTestDb();
		upstreamCalled = new Promise<void>((resolve) => {
			markUpstreamCalled = resolve;
		});
		const execution = manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "create_item",
				input: { body: { value: "slow" } },
			},
			{} as Env,
			ctx,
		) as Promise<{ status: string; run_id: number; error_message?: string }>;
		await upstreamCalled;

		const [claimed] = await sql<{ id: number; claimed_by: string | null }>`
			SELECT id, claimed_by FROM runs
			WHERE connection_id = ${connectionId} AND run_type = 'action' AND status = 'running'
			ORDER BY id DESC LIMIT 1
		`;
		expect(claimed.claimed_by).toMatch(/^gateway-inline-/);
		const runId = Number(claimed.id);

		// The claim's single heartbeat is now far past the reaper threshold, as
		// it is for any inline call that runs longer than 120s in production.
		await sql`
			UPDATE runs
			SET claimed_at = NOW() - INTERVAL '200 seconds',
			    last_heartbeat_at = NOW() - INTERVAL '200 seconds'
			WHERE id = ${runId}
		`;
		// Longer than two heartbeat periods at the 1s threshold.
		await new Promise((resolve) => setTimeout(resolve, 700));

		const reap = await reapStaleRuns();
		expect(reap.acquired).toBe(true);
		const [midFlight] = await sql<{ status: string }>`
			SELECT status FROM runs WHERE id = ${runId}
		`;
		expect(midFlight.status).toBe("running");

		releaseUpstream?.();
		const result = await execution;
		expect(result.error_message).not.toBe(LOST_LEASE_MESSAGE);
		expect(result.status).toBe("completed");
		const [finalRow] = await sql<{
			status: string;
			action_output: Record<string, unknown> | null;
		}>`SELECT status, action_output FROM runs WHERE id = ${runId}`;
		expect(finalRow.status).toBe("completed");
		expect(finalRow.action_output).toMatchObject({ body: { created: true } });
	});

	it("stops refreshing once the run's lease is lost, so the reaper still wins", async () => {
		const sql = getTestDb();
		upstreamCalled = new Promise<void>((resolve) => {
			markUpstreamCalled = resolve;
		});
		const execution = manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "create_item",
				input: { body: { value: "stolen" } },
			},
			{} as Env,
			ctx,
		) as Promise<{ status: string; run_id: number; error_message?: string }>;
		await upstreamCalled;
		const [claimed] = await sql<{ id: number }>`
			SELECT id FROM runs
			WHERE connection_id = ${connectionId} AND run_type = 'action' AND status = 'running'
			ORDER BY id DESC LIMIT 1
		`;
		const runId = Number(claimed.id);
		// Another holder takes the run: the refresher is fenced on the owner it
		// claimed under and must not keep someone else's run alive.
		await sql`
			UPDATE runs
			SET claimed_by = 'some-other-replica',
			    last_heartbeat_at = NOW() - INTERVAL '200 seconds'
			WHERE id = ${runId}
		`;
		await new Promise((resolve) => setTimeout(resolve, 700));
		const [row] = await sql<{ stale: boolean }>`
			SELECT last_heartbeat_at < NOW() - INTERVAL '100 seconds' AS stale
			FROM runs WHERE id = ${runId}
		`;
		expect(row.stale).toBe(true);
		const reap = await reapStaleRuns();
		expect(reap.acquired).toBe(true);
		expect(reap.reaped).toBe(1);
		const [reaped] = await sql<{ status: string }>`
			SELECT status FROM runs WHERE id = ${runId}
		`;
		expect(reaped.status).toBe("timeout");

		releaseUpstream?.();
		const result = await execution;
		expect(result.status).toBe("failed");
		expect(result.error_message).toBe(LOST_LEASE_MESSAGE);
	});
});
