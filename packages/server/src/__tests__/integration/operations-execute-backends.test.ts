import GoogleCalendarConnector from "@lobu/connectors/google_calendar";
import { fileInputSchema } from "@lobu/connector-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_PROTOCOL_VERSION, REDACTED_SENTINEL } from "@lobu/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../../index";
import * as dbClient from "../../db/client";
import { createAutomationRun } from "../../runs/queue-service";
import { BROWSER_GROUP_TITLE_PREFIX } from "../../worker-api/browser-action-context";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createAuthProfile } from "../../utils/auth-profiles";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestConnection,
	createTestConnectorDefinition,
	createTestUser,
	seedOwnerContext,
} from "../setup/test-fixtures";
import * as gateway from "../../lobu/gateway";
import { ArtifactStore } from "../../gateway/files/artifact-store";
import { ingestInputFiles } from "../../gateway/files/input-files";

const LOCAL = "demo.ops.backend.local";
const MCP = "demo.ops.backend.mcp";
const HTTP = "demo.ops.backend.http";
const GOOGLE_CALENDAR_DELETE_ACTION = new GoogleCalendarConnector().definition
	.actions?.delete_event;

if (!GOOGLE_CALENDAR_DELETE_ACTION) {
	throw new Error("Google Calendar delete_event action is missing");
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("operations.execute backend lifecycle", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;
	let localConnectionId: number;
	let mcpConnectionId: number;
	let secondMcpConnectionId: number;
	let httpConnectionId: number;
	let automationId: number;
	let sourceRunId: number;
	let failedTransportCallCount = 0;
	let failDiscoveryConnectionId: number | null = null;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const {
			org,
			user,
			ctx: ownerCtx,
		} = await seedOwnerContext({
			orgName: "Operation Backends Org",
		});
		ownerCtx.baseUrl = "https://gateway.test/lobu";
		orgId = org.id;
		userId = user.id;
		ctx = ownerCtx;
		const automationAgent = await createTestAgent({
			organizationId: orgId,
			ownerUserId: userId,
		});

		for (const [key, name] of [
			[LOCAL, "Local backend"],
			[MCP, "MCP backend"],
			[HTTP, "HTTP backend"],
		] as const) {
			await createTestConnectorDefinition({
				key,
				name,
				organization_id: orgId,
				auth_schema: { methods: [{ type: "oauth", provider: "test" }] },
			});
		}

		const sql = getTestDb();
		const [automation] = await sql`
			WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
			INSERT INTO automations (
				id, automation_group_id, organization_id, managed_agent_id, created_by, name, slug
			)
			SELECT id, id, ${orgId}, ${automationAgent.agentId}, ${userId},
				'Operation provenance automation', 'operation-provenance-automation'
			FROM next_id
			RETURNING id
		`;
		automationId = Number(automation.id);
		const sourceRun = await createAutomationRun({
			organizationId: orgId,
			automationId,
			agentId: automationAgent.agentId,
			windowStart: "2026-08-10T00:00:00.000Z",
			windowEnd: "2026-08-10T01:00:00.000Z",
			dispatchSource: "manual",
		}, sql);
		sourceRunId = sourceRun.runId;
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({
				echo: {
					name: "Echo",
					kind: "write",
					input_schema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					},
				},
				needs_approval: {
					name: "Needs approval",
					kind: "write",
					requiresApproval: true,
				},
				delete_event: GOOGLE_CALENDAR_DELETE_ACTION,
				stage_browser: {
					name: "Stage browser",
					kind: "write",
					input_schema: {
						type: "object",
						properties: { browser_connection_id: { type: "integer" } },
						required: ["browser_connection_id"],
					},
				},
			})}
			WHERE organization_id = ${orgId} AND key = ${LOCAL}
		`;
		await sql`
			UPDATE connector_versions
			SET compiled_code = ${`
				class ConnectorRuntime {
					async sync() { return { items: [] }; }
					async execute(ctx) {
						if (ctx.input.value === 'nul-output') {
							return { success: true, output: { backend: 'local_action', tail: 'before\\u0000after' } };
						}
						if (ctx.input.value === 'nul-error') {
							throw new Error('local\\u0000boom');
						}
						if (ctx.actionKey === 'stage_browser') {
							await ctx.sessionState.chrome_dispatcher.dispatch('navigate', {
								url: 'https://example.test/',
								target_browser_connection_id: ctx.input.browser_connection_id,
							});
						}
						return { success: true, output: { backend: 'local_action', value: ctx.input.value ?? null } };
					}
				}
				module.exports = { ConnectorRuntime };
			`}
			WHERE connector_key = ${LOCAL}
		`;
		await sql`
			UPDATE connector_definitions
			SET mcp_config = ${sql.json({ upstream_url: "https://mcp.example.test/mcp" })}
			WHERE organization_id = ${orgId} AND key = ${MCP}
		`;
		await sql`
			UPDATE connector_definitions
			SET openapi_config = ${sql.json({
				// Suite-specific URL: connector-operations caches specs by URL in
				// a module-level map, and vitest shares that module across files.
				specUrl: "https://api.example.test/openapi-execute-backends.json",
				serverUrl: "https://api.example.test",
			})}
			WHERE organization_id = ${orgId} AND key = ${HTTP}
		`;

		const local = await createTestConnection({
			organization_id: orgId,
			connector_key: LOCAL,
			created_by: userId,
			visibility: "private",
		});
		const mcp = await createTestConnection({
			organization_id: orgId,
			connector_key: MCP,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { remote_echo: "auto" } },
		});
		const secondMcp = await createTestConnection({
			organization_id: orgId,
			connector_key: MCP,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { remote_echo: "auto" } },
		});
		const http = await createTestConnection({
			organization_id: orgId,
			connector_key: HTTP,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { create_item: "auto" } },
		});
		localConnectionId = local.id;
		mcpConnectionId = mcp.id;
		secondMcpConnectionId = secondMcp.id;
		httpConnectionId = http.id;
		for (const [connectorKey, connectionId] of [
			[LOCAL, local.id],
			[MCP, mcp.id],
			[MCP, secondMcp.id],
			[HTTP, http.id],
		] as const) {
			const accountId = `acct_${connectionId}_${connectorKey}`;
			await sql`
				INSERT INTO "account" (
				  id, "accountId", "providerId", "userId",
				  "accessToken", "accessTokenExpiresAt", scope,
				  "createdAt", "updatedAt"
				) VALUES (
				  ${accountId}, ${accountId}, 'test', ${userId},
				  ${`backend-test-token-${connectionId}`}, ${new Date(Date.now() + 60 * 60 * 1000).toISOString()}, 'read write',
				  NOW(), NOW()
				)
			`;
			const profile = await createAuthProfile({
				organizationId: orgId,
				connectorKey,
				displayName: `${connectorKey} test OAuth`,
				profileKind: "oauth_account",
				provider: "test",
				accountId,
				status: "active",
				createdBy: userId,
			});
			await sql`
				UPDATE connections
				SET auth_profile_id = ${profile.id}
				WHERE id = ${connectionId}
			`;
		}

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://api.example.test/openapi-execute-backends.json") {
					return jsonResponse({
						openapi: "3.0.0",
						servers: [{ url: "https://api.example.test" }],
						paths: {
							"/items": {
								post: {
									operationId: "create_item",
									requestBody: {
										content: {
											"application/json": {
												schema: { type: "object", properties: { image: fileInputSchema({ maxBytes: 1024 }) } },
											},
										},
									},
									responses: { "200": { description: "ok" } },
								},
							},
							"/items/{id}": {
								delete: {
									operationId: "delete_item",
									parameters: [
										{
											name: "id",
											in: "path",
											required: true,
											schema: { type: "string" },
										},
									],
									responses: { "204": { description: "deleted" } },
								},
							},
						},
					});
				}
				if (url === "https://api.example.test/items") {
					const body = JSON.parse(String(init?.body)) as { value?: string };
					if (body.value === "nul-success") {
						return new Response('{"nul\\u0000key":"value\\u0000with-nul"}', {
							status: 200,
							headers: { "content-type": "application/json" },
						});
					}
					if (body.value === "nul-failure") {
						return new Response("upstream\u0000failed", { status: 500 });
					}
					if (
						body.value === "wait-for-abort" ||
						body.value === "wait-for-timeout"
					) {
						const signal = init?.signal;
						if (!signal)
							throw new Error("HTTP operation request has no abort signal");
						if (signal.aborted) throw signal.reason;
						return await new Promise<Response>((_resolve, reject) => {
							signal.addEventListener("abort", () => reject(signal.reason), {
								once: true,
							});
						});
					}
					return jsonResponse({ created: true, body });
				}
				if (url === "https://mcp.example.test/mcp") {
					const request = JSON.parse(String(init?.body)) as {
						id?: number;
						method: string;
						params?: Record<string, unknown>;
					};
					if (request.method === "initialize") {
						return new Response(
							JSON.stringify({
								jsonrpc: "2.0",
								id: request.id,
								result: {
									protocolVersion: MCP_PROTOCOL_VERSION,
									capabilities: { tools: {} },
								},
							}),
							{
								status: 200,
								headers: {
									"content-type": "application/json",
									"mcp-session-id": "operations-backend-session",
								},
							},
						);
					}
					if (request.method === "tools/list") {
						const authorization = new Headers(init?.headers).get("authorization");
						if (
							failDiscoveryConnectionId != null &&
							authorization ===
								`Bearer backend-test-token-${failDiscoveryConnectionId}`
						) {
							return new Response("discovery unavailable", { status: 503 });
						}
						expect(new Headers(init?.headers).get("mcp-protocol-version")).toBe(
							MCP_PROTOCOL_VERSION,
						);
						return jsonResponse({
							jsonrpc: "2.0",
							id: request.id,
							result: {
								tools: [
									{
										name: "remote_echo",
										description: "Echo through MCP",
										inputSchema: { type: "object" },
										annotations: { readOnlyHint: true },
									},
								],
							},
						});
					}
					if (request.method === "tools/call") {
						if (
							(request.params?.arguments as Record<string, unknown> | undefined)
								?.value === "nul-output"
						) {
							return jsonResponse({
								jsonrpc: "2.0",
								id: request.id,
								result: {
									content: [{ type: "text", text: "remote\u0000echo" }],
									isError: false,
								},
							});
						}
						if (
							(request.params?.arguments as Record<string, unknown> | undefined)
								?.fail_transport === true
						) {
							failedTransportCallCount++;
							throw new Error("upstream transport failed");
						}
						const authorization = new Headers(init?.headers).get(
							"authorization",
						);
						return jsonResponse({
							jsonrpc: "2.0",
							id: request.id,
							result: {
								content: [{ type: "text", text: authorization }],
								isError: false,
							},
						});
					}
					return jsonResponse({ jsonrpc: "2.0", id: request.id, result: {} });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
	});

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	it("executes a server-side local action inline without a worker claim wait", async () => {
		const started = Date.now();
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "echo",
				input: { value: "local-ok" },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "completed",
			output: { backend: "local_action", value: "local-ok" },
		});
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("executes an inline action without rereading its run metadata", async () => {
		const metadataReads: string[] = [];
		const sql = getTestDb();
		const trackedSql = new Proxy(sql, {
			apply(target, thisArg, args) {
				if (Array.isArray(args[0])) {
					const query = args[0].join("?").replace(/\s+/g, " ").trim();
					if (/^SELECT run_metadata FROM runs WHERE id =/i.test(query)) {
						metadataReads.push(query);
					}
				}
				return Reflect.apply(target, thisArg, args);
			},
		});
		const getDb = vi.spyOn(dbClient, "getDb").mockReturnValue(trackedSql);
		try {
			const result = await manageOperations({
				action: "execute", connection_id: localConnectionId,
				operation_key: "echo", input: { value: "no-metadata-reread" },
			}, {} as Env, ctx);
			expect(result).toMatchObject({ status: "completed" });
			expect(metadataReads).toEqual([]);
		} finally {
			getDb.mockRestore();
		}
	});

	it.each(["auto", "approval", "substituted", "removed"])("preserves file authorization through %s inline execution", async (mode) => {
		const directory = await mkdtemp(join(tmpdir(), "lobu-inline-files-test-"));
		const store = new ArtifactStore(directory);
		const services = vi.spyOn(gateway, "getLobuCoreServices").mockReturnValue({ getArtifactStore: () => store });
		const sql = getTestDb();
		const [{ config }] = await sql`SELECT config FROM connections WHERE id = ${httpConnectionId}`;
		try {
			const files = await ingestInputFiles([
				{ name: "photo.png", mimeType: "image/png", data: Buffer.from("photo") },
				{ name: "other.png", mimeType: "image/png", data: Buffer.from("other") },
			], ctx, store, "https://gateway.test/lobu");
			if (mode !== "auto") {
				await sql`UPDATE connections SET config = ${sql.json({ ...config, action_modes: { create_item: "approval" } })} WHERE id = ${httpConnectionId}`;
			}
			const queued = await manageOperations({
				action: "execute", connection_id: httpConnectionId, operation_key: "create_item",
				input: { body: { image: files[0] } },
			}, {} as Env, ctx) as { status: string; run_id: number };
			if (mode !== "auto") {
				expect(queued.status).toBe("pending_approval");
				await manageOperations({
					action: "approve", run_id: queued.run_id,
					...(mode === "substituted" ? { input: { body: { image: files[1] } } } : {}),
					...(mode === "removed" ? { input: { body: {} } } : {}),
				}, {} as Env, ctx);
			}
			const [run] = await sql`SELECT status, action_output, error_message FROM runs WHERE id = ${queued.run_id}`;
			if (mode === "removed" || mode === "substituted") {
				expect(run).toMatchObject({ status: "failed", error_message: expect.stringContaining("changed after authorization") });
			} else {
				expect(run).toMatchObject({ status: "completed", action_output: { body: { body: { image: {
					base64: Buffer.from("photo").toString("base64"), filename: "photo.png", content_type: "image/png",
				} } } } });
			}
		} finally {
			services.mockRestore();
			await sql`UPDATE connections SET config = ${sql.json(config)} WHERE id = ${httpConnectionId}`;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("carries one SDK invocation owner through real sandbox calls without sharing across invocations", async () => {
		// Import after fixtures: loading this handler eagerly leaves undefined MCP
		// registry entries when Vitest 4 runs this suite before the handoff/audit suites.
		const { runSdkScript } = await import("../../tools/sdk_run");
		const script = `export default async (ctx, client) => {
			return await Promise.all(['first', 'second'].map(value => client.operations.execute({
				connection_id: ${localConnectionId}, operation_key: 'echo',
				input: { value: 'synthetic-sdk-owner-' + value }
			})));
		}`;
		for (let i = 0; i < 2; i++) {
			await runSdkScript({ script, title: "Check notifications" }, {} as Env, ctx);
		}
		const sql = getTestDb();
		const rows = await sql`
			SELECT run_metadata FROM runs
			WHERE organization_id = ${orgId}
				AND action_input->>'value' IN ('synthetic-sdk-owner-first', 'synthetic-sdk-owner-second')
			ORDER BY id
		`;
		expect(rows).toHaveLength(4);
		const owners = rows.map((row) => row.run_metadata.browser_context);
		expect(owners[0]).toEqual(owners[1]);
		expect(owners[2]).toEqual(owners[3]);
		expect(owners[0].flow_id).not.toBe(owners[2].flow_id);
		expect(owners[0].title).toMatch(
			new RegExp(
				`^${BROWSER_GROUP_TITLE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · Check notifications · [a-f0-9]{12}$`,
			),
		);
	});

	it("replays a completed action instead of executing an idempotency key twice", async () => {
		const execute = () =>
			manageOperations(
				{
					action: "execute",
					connection_id: localConnectionId,
					operation_key: "echo",
					input: { value: "durable-once" },
					idempotency_key: "operation-backend-test:durable-once",
				},
				{} as Env,
				ctx,
			);

		const first = (await execute()) as { run_id: number; status: string };
		const retry = (await execute()) as { run_id: number; status: string };

		expect(first.status).toBe("completed");
		expect(retry).toMatchObject({ status: "completed", run_id: first.run_id });
		const runs = await getTestDb()`
			SELECT id FROM runs
			WHERE organization_id = ${orgId}
			  AND run_type = 'action'
			  AND action_idempotency_key = 'operation-backend-test:durable-once'
		`;
		expect(runs).toHaveLength(1);
	});

	it("binds an action and its feedback record to the trusted Automation window", async () => {
		const execute = () =>
			manageOperations(
				{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "echo",
				input: { value: "automation-provenance" },
				idempotency_key: "operation-backend-test:automation-provenance",
				},
				{} as Env,
				{ ...ctx, actingAutomationId: automationId, actingRunId: sourceRunId },
			);
		const result = (await execute()) as { run_id: number; status: string };
		const replay = (await execute()) as { run_id: number; status: string };

		expect(result).toMatchObject({ status: "completed" });
		expect(replay.run_id).toBe(result.run_id);
		const sql = getTestDb();
		const [run] = await sql`
			SELECT automation_id, parent_run_id, run_metadata
			FROM runs WHERE id = ${result.run_id}
		`;
		expect(Number(run.automation_id)).toBe(automationId);
		expect(Number(run.parent_run_id)).toBe(sourceRunId);
		expect(run.run_metadata).toEqual({
			browser_context: {
				id: `automation:${sourceRunId}`,
				title: `${BROWSER_GROUP_TITLE_PREFIX} · Automation ${automationId} · Run ${sourceRunId}`,
				flow_id: String(sourceRunId),
				kind: "automation",
			},
		});
		const reactions = await sql`
			SELECT run_id FROM automation_reactions
			WHERE automation_id = ${automationId}
			  AND source_run_id = ${sourceRunId}
			  AND run_id = ${result.run_id}
		`;
		expect(reactions).toHaveLength(1);
		expect(Number(reactions[0]?.run_id)).toBe(result.run_id);
	});

	it("lets a headless Automation execute through its author's private connection", async () => {
		const result = (await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "echo",
				input: { value: "automation-private-connection" },
				idempotency_key: "operation-backend-test:automation-private-connection",
			},
			{} as Env,
			{
				...ctx,
				userId: null,
				memberRole: null,
				actingAutomationId: automationId,
				actingRunId: sourceRunId,
				sourceContext: { source: "automation-run" },
			},
		)) as { run_id: number; status: string };

		expect(result.status).toBe("completed");
		const [run] = await getTestDb()`
			SELECT created_by_user_id, automation_id, parent_run_id
			FROM runs
			WHERE id = ${result.run_id}
		`;
		expect(run.created_by_user_id).toBeNull();
		expect(Number(run.automation_id)).toBe(automationId);
		expect(Number(run.parent_run_id)).toBe(sourceRunId);
	});

	it("lets a headless Automation discover its author's private operation target", async () => {
		const otherUser = await createTestUser();
		await addUserToOrganization(otherUser.id, orgId);
		const otherPrivate = await createTestConnection({
			organization_id: orgId,
			connector_key: LOCAL,
			created_by: otherUser.id,
			visibility: "private",
		});
		const result = (await manageOperations(
			{
				action: "list_available",
				connector_key: LOCAL,
			},
			{} as Env,
			{
				...ctx,
				userId: null,
				memberRole: null,
				actingAutomationId: automationId,
				actingRunId: sourceRunId,
				sourceContext: { source: "automation-run" },
			},
		)) as {
			operations: Array<{
				operation_key: string;
				execution_targets: Array<{ connection_id: number }>;
			}>;
		};

		const echo = result.operations.find(
			(operation) => operation.operation_key === "echo",
		);
		expect(echo?.execution_targets.map((target) => target.connection_id)).toContain(
			localConnectionId,
		);
		expect(echo?.execution_targets.map((target) => target.connection_id)).not.toContain(
			otherPrivate.id,
		);
	});

	it("carries the Automation author through private browser target authorization", async () => {
		const sql = getTestDb();
		const [worker] = await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, capabilities, label,
				organization_id, last_seen_at
			) VALUES (
				${userId}, 'automation-private-browser', 'chrome-extension',
				${sql.json(["browser.tabs", "browser.debugger"])}, 'Automation Browser',
				${orgId}, NOW() - INTERVAL '1 day'
			)
			RETURNING id
		`;
		const [browserConnection] = await sql`
			INSERT INTO connections (
				organization_id, connector_key, slug, display_name, status,
				created_by, visibility, device_worker_id, created_at, updated_at
			) VALUES (
				${orgId}, 'chrome', 'automation-private-browser', 'Automation Browser', 'active',
				${userId}, 'private', ${worker.id}::uuid, NOW(), NOW()
			)
			RETURNING id
		`;

		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "stage_browser",
				input: { browser_connection_id: Number(browserConnection.id) },
			},
			{} as Env,
			{
				...ctx,
				userId: null,
				memberRole: null,
				actingAutomationId: automationId,
				actingRunId: sourceRunId,
				sourceContext: { source: "automation-run" },
			},
		);

		expect(result).toMatchObject({
			status: "failed",
			error_message: expect.stringContaining(
				"The browser this action is set to open in is offline",
			),
		});
	});

	it("does not let an Automation use another member's private connection", async () => {
		const otherUser = await createTestUser();
		await addUserToOrganization(otherUser.id, orgId);
		const otherPrivate = await createTestConnection({
			organization_id: orgId,
			connector_key: LOCAL,
			created_by: otherUser.id,
			visibility: "private",
		});

		const result = await manageOperations(
			{
				action: "execute",
				connection_id: otherPrivate.id,
				operation_key: "echo",
				input: { value: "must-not-run" },
			},
			{} as Env,
			{
				...ctx,
				userId: null,
				memberRole: null,
				actingAutomationId: automationId,
				actingRunId: sourceRunId,
				sourceContext: { source: "automation-run" },
			},
		);

		expect(result).toEqual({ error: "Connection not found or not visible." });
	});

	it("keeps organization-visible operations available to a headless Automation", async () => {
		const orgConnection = await createTestConnection({
			organization_id: orgId,
			connector_key: LOCAL,
			visibility: "org",
		});

		const result = await manageOperations(
			{
				action: "execute",
				connection_id: orgConnection.id,
				operation_key: "echo",
				input: { value: "automation-org-connection" },
			},
			{} as Env,
			{
				...ctx,
				userId: null,
				memberRole: null,
				actingAutomationId: automationId,
				actingRunId: sourceRunId,
				sourceContext: { source: "automation-run" },
			},
		);

		expect(result).toMatchObject({
			status: "completed",
			output: { backend: "local_action", value: "automation-org-connection" },
		});
	});

	it("fails closed when the stamped Automation no longer exists", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "echo",
				input: { value: "must-not-run" },
			},
			{} as Env,
			{
				...ctx,
				userId: null,
				memberRole: null,
				actingAutomationId: 2_147_483_647,
				actingRunId: sourceRunId,
				sourceContext: { source: "automation-run" },
			},
		);

		expect(result).toEqual({ error: "Connection not found or not visible." });
	});

	it("repairs a failed feedback link without stranding or repeating an inline action", async () => {
		const sql = getTestDb();
		await sql.unsafe(`
			CREATE SEQUENCE operation_reaction_failure_seq;
			CREATE FUNCTION fail_first_operation_reaction() RETURNS trigger AS $$
			BEGIN
				IF NEW.automation_id = ${automationId}
					AND NEW.tool_name = 'manage_operations'
					AND nextval('operation_reaction_failure_seq') = 1 THEN
					RAISE EXCEPTION 'forced operation reaction failure';
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER fail_first_operation_reaction_trigger
				BEFORE INSERT ON automation_reactions
				FOR EACH ROW EXECUTE FUNCTION fail_first_operation_reaction();
		`);

		const execute = () =>
			manageOperations(
				{
					action: "execute",
					connection_id: localConnectionId,
					operation_key: "echo",
					input: { value: "repair-feedback" },
					idempotency_key: "operation-backend-test:repair-feedback",
				},
				{} as Env,
				{ ...ctx, actingAutomationId: automationId, actingRunId: sourceRunId },
			);

		try {
			await expect(execute()).rejects.toThrow(
				"forced operation reaction failure",
			);
			const [persisted] = await sql`
				SELECT id, status, action_output FROM runs
				WHERE organization_id = ${orgId}
				  AND action_idempotency_key = 'operation-backend-test:repair-feedback'
			`;
			expect(persisted.status).toBe("completed");
			expect(persisted.action_output).toMatchObject({
				backend: "local_action",
				value: "repair-feedback",
			});

			const replay = (await execute()) as { run_id: number; status: string };
			expect(replay).toMatchObject({
				run_id: Number(persisted.id),
				status: "completed",
			});
			const runs = await sql`
				SELECT id FROM runs
				WHERE organization_id = ${orgId}
				  AND action_idempotency_key = 'operation-backend-test:repair-feedback'
			`;
			expect(runs).toHaveLength(1);
			const reactions = await sql`
				SELECT run_id FROM automation_reactions
				WHERE automation_id = ${automationId}
				  AND source_run_id = ${sourceRunId}
				  AND run_id = ${Number(persisted.id)}
			`;
			expect(reactions).toHaveLength(1);
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS fail_first_operation_reaction_trigger ON automation_reactions;
				DROP FUNCTION IF EXISTS fail_first_operation_reaction();
				DROP SEQUENCE IF EXISTS operation_reaction_failure_seq;
			`);
		}
	});

	it("concurrent action retries converge and mismatched key reuse fails closed", async () => {
		const key = "operation-backend-test:concurrent";
		const execute = (value: string) =>
			manageOperations(
				{
					action: "execute",
					connection_id: localConnectionId,
					operation_key: "echo",
					input: { value },
					idempotency_key: key,
				},
				{} as Env,
				ctx,
			);

		const results = (await Promise.all(
			Array.from({ length: 4 }, () => execute("same-request")),
		)) as Array<{ run_id: number; status: string }>;
		expect(new Set(results.map((result) => result.run_id)).size).toBe(1);
		expect(results.some((result) => result.status === "completed")).toBe(true);
		expect(
			results.every((result) =>
				["completed", "in_progress"].includes(result.status),
			),
		).toBe(true);

		await expect(execute("different-request")).rejects.toMatchObject({
			httpStatus: 409,
		});
	});

	it("replays one pending approval and does not create another approval event", async () => {
		const execute = () =>
			manageOperations(
				{
					action: "execute",
					connection_id: localConnectionId,
					operation_key: "needs_approval",
					input: {},
					idempotency_key: "operation-backend-test:approval",
				},
				{} as Env,
				ctx,
			);
		const first = (await execute()) as {
			run_id: number;
			event_id: number;
			status: string;
		};
		const retry = (await execute()) as {
			run_id: number;
			event_id: number;
			status: string;
		};

		expect(retry).toMatchObject({
			status: "pending_approval",
			run_id: first.run_id,
			event_id: first.event_id,
		});
		const events = await getTestDb()`
			SELECT id FROM events
			WHERE organization_id = ${orgId}
			  AND run_id = ${first.run_id}
			  AND interaction_type = 'approval'
		`;
		expect(events).toHaveLength(1);
	});

	it("does not equate required approval with high impact", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "needs_approval",
				input: {},
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "pending_approval",
		});
		expect(result).toHaveProperty("approval_url");
		const [approval] = await getTestDb()`
			SELECT metadata->'approval_context' AS approval_context,
			       metadata->'review_fields' AS review_fields
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND run_id = ${result.run_id}
			  AND interaction_type = 'approval'
		`;
		expect(approval.approval_context).toEqual({
			kind: "connector",
			impact: { level: "normal" },
		});
		expect(approval.review_fields).toEqual([
			{ key: "resource", value: "Connector operation" },
			{ key: "connection", value: `Test Connection ${LOCAL}` },
			{ key: "operation", value: "Needs approval" },
		]);
	});

	it("keeps connector inputs that collide with review headers visible", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "needs_approval",
				input: {
					resource: "customer-record",
					input_resource: "already-prefixed-customer-record",
					connection: "input-connection",
					operation: "preview",
					issue: "synthetic-issue-001",
				},
			},
			{} as Env,
			ctx,
		);
		const [approval] = await getTestDb()`
			SELECT metadata->'review_fields' AS review_fields
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND run_id = ${result.run_id}
			  AND interaction_type = 'approval'
		`;
		expect(approval.review_fields).toEqual([
			{ key: "resource", value: "Connector operation" },
			{ key: "connection", value: `Test Connection ${LOCAL}` },
			{ key: "operation", value: "Needs approval" },
			{ key: "input_resource", value: "customer-record" },
			{
				key: "input_input_resource",
				value: "already-prefixed-customer-record",
			},
			{ key: "input_connection", value: "input-connection" },
			{ key: "input_operation", value: "preview" },
			{ key: "input_issue", value: "synthetic-issue-001" },
		]);
	});

	it("redacts connector credentials before prefixing approval review keys", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "needs_approval",
				input: {
					authorization: "Bearer plaintext-authorization",
					cookie: "session=plaintext-cookie",
					database_url: "postgres://user:plaintext-password@db.example/app",
					settings: {
						client_secret: "plaintext-nested-secret",
						region: "eu-west-1",
					},
				},
			},
			{} as Env,
			ctx,
		);
		const [approval] = await getTestDb()`
			SELECT metadata->'review_fields' AS review_fields
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND run_id = ${result.run_id}
			  AND interaction_type = 'approval'
		`;
		expect(approval.review_fields).toEqual([
			{ key: "resource", value: "Connector operation" },
			{ key: "connection", value: `Test Connection ${LOCAL}` },
			{ key: "operation", value: "Needs approval" },
			{ key: "input_authorization", value: REDACTED_SENTINEL },
			{ key: "input_cookie", value: REDACTED_SENTINEL },
			{ key: "input_database_url", value: REDACTED_SENTINEL },
			{
				key: "input_settings",
				value: {
					client_secret: REDACTED_SENTINEL,
					region: "eu-west-1",
				},
			},
		]);
	});

	it("marks a real destructive connector action as high impact", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "delete_event",
				input: { event_id: "calendar-event-123" },
			},
			{} as Env,
			ctx,
		);
		const [approval] = await getTestDb()`
			SELECT metadata->'approval_context' AS approval_context
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND run_id = ${result.run_id}
			  AND interaction_type = 'approval'
		`;
		expect(approval.approval_context).toEqual({
			kind: "connector",
			impact: {
				level: "high",
				reason:
					"This action can remove or irreversibly change data in the connected service.",
				consequences: ["Lobu may not be able to undo the external change."],
			},
		});
	});

	it("surfaces MCP discovery failure for an explicit connection", async () => {
		failDiscoveryConnectionId = mcpConnectionId;
		try {
			await expect(
				manageOperations(
					{ action: "list_available", connection_id: mcpConnectionId },
					{} as Env,
					ctx,
				),
			).rejects.toThrow(/503.*discovery unavailable/);
		} finally {
			failDiscoveryConnectionId = null;
		}
	});

	it("executes an upstream MCP tool with the selected connection's credentials and session", async () => {
		const listed = await manageOperations(
			{ action: "list_available", connection_id: mcpConnectionId },
			{} as Env,
			ctx,
		);
		expect(listed).toMatchObject({
			action: "list_available",
			operations: [
				expect.objectContaining({
					operation_key: "remote_echo",
					backend: "mcp_tool",
				}),
			],
		});
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: mcpConnectionId,
				operation_key: "remote_echo",
				input: { value: "mcp" },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "completed",
			output: {
				content: [
					{
						type: "text",
						text: `Bearer backend-test-token-${mcpConnectionId}`,
					},
				],
			},
		});

		const secondResult = await manageOperations(
			{
				action: "execute",
				connection_id: secondMcpConnectionId,
				operation_key: "remote_echo",
				input: { value: "second-account" },
			},
			{} as Env,
			ctx,
		);
		expect(secondResult).toMatchObject({
			action: "execute",
			status: "completed",
			output: {
				content: [
					{
						type: "text",
						text: `Bearer backend-test-token-${secondMcpConnectionId}`,
					},
				],
			},
		});
	});

	it("finalizes an upstream MCP run as failed when transport setup throws", async () => {
		failedTransportCallCount = 0;
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: mcpConnectionId,
				operation_key: "remote_echo",
				input: { fail_transport: true },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "failed",
			error_message: "upstream transport failed",
		});
		const [run] = await getTestDb()`
			SELECT status, error_message
			FROM runs
			WHERE id = ${(result as { run_id: number }).run_id}
		`;
		expect(run).toMatchObject({
			status: "failed",
			error_message: "upstream transport failed",
		});
		// A transport exception is ambiguous: the upstream may have executed the
		// destructive action before the response was lost. Never retry it here.
		expect(failedTransportCallCount).toBe(1);
	});

	it("discovers and executes an OpenAPI HTTP operation", async () => {
		const listed = await manageOperations(
			{ action: "list_available", connection_id: httpConnectionId },
			{} as Env,
			ctx,
		);
		expect(listed).toMatchObject({
			action: "list_available",
			operations: expect.arrayContaining([
				expect.objectContaining({
					operation_key: "create_item",
					backend: "http_operation",
				}),
				expect.objectContaining({
					operation_key: "delete_item",
					backend: "http_operation",
					annotations: expect.objectContaining({ destructiveHint: true }),
				}),
			]),
		});
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: httpConnectionId,
				operation_key: "create_item",
				input: { body: { value: "http-ok" } },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "completed",
			output: {
				body: { created: true, body: { value: "http-ok" } },
			},
		});
	});

	it("marks an OpenAPI DELETE approval as high impact", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: httpConnectionId,
				operation_key: "delete_item",
				input: { path: { id: "item-123" } },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "pending_approval",
		});
		const [approval] = await getTestDb()`
			SELECT metadata->'approval_context' AS approval_context
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND run_id = ${result.run_id}
			  AND interaction_type = 'approval'
		`;
		expect(approval.approval_context).toEqual({
			kind: "connector",
			impact: {
				level: "high",
				reason:
					"This action can remove or irreversibly change data in the connected service.",
				consequences: ["Lobu may not be able to undo the external change."],
			},
		});
	});

	it("strips NUL from local action output", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "echo",
				input: { value: "nul-output" },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "completed",
			output: { backend: "local_action", tail: "beforeafter" },
		});
		const [run] = await getTestDb()`
			SELECT action_output FROM runs
			WHERE id = ${(result as { run_id: number }).run_id}
		`;
		expect(run.action_output).toEqual({
			backend: "local_action",
			tail: "beforeafter",
		});
	});

	it("strips NUL from a local action failure message", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: localConnectionId,
				operation_key: "echo",
				input: { value: "nul-error" },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "failed",
			error_message: "localboom",
		});
		const [run] = await getTestDb()`
			SELECT error_message FROM runs
			WHERE id = ${(result as { run_id: number }).run_id}
		`;
		expect(run.error_message).toBe("localboom");
	});

	it("strips NUL from upstream MCP tool output", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: mcpConnectionId,
				operation_key: "remote_echo",
				input: { value: "nul-output" },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "completed",
			output: { content: [{ type: "text", text: "remoteecho" }] },
		});
		const [run] = await getTestDb()`
			SELECT action_output FROM runs
			WHERE id = ${(result as { run_id: number }).run_id}
		`;
		expect(run.action_output).toEqual({
			content: [{ type: "text", text: "remoteecho" }],
		});
	});

	it("strips NUL from successful HTTP operation output", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: httpConnectionId,
				operation_key: "create_item",
				input: { body: { value: "nul-success" } },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "completed",
			output: { body: { nulkey: "valuewith-nul" } },
		});
		const [run] = await getTestDb()`
			SELECT action_output FROM runs
			WHERE id = ${(result as { run_id: number }).run_id}
		`;
		expect(run.action_output).toEqual({ body: { nulkey: "valuewith-nul" } });
	});

	it("strips NUL from failed HTTP operation output and error", async () => {
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: httpConnectionId,
				operation_key: "create_item",
				input: { body: { value: "nul-failure" } },
			},
			{} as Env,
			ctx,
		);
		expect(result).toMatchObject({
			action: "execute",
			status: "failed",
			error_message: "upstreamfailed",
		});
		const [run] = await getTestDb()`
			SELECT action_output, error_message FROM runs
			WHERE id = ${(result as { run_id: number }).run_id}
		`;
		expect(run).toMatchObject({
			action_output: { body: "upstreamfailed" },
			error_message: "upstreamfailed",
		});
	});

	it("finalizes the run when HTTP credentials are missing", async () => {
		const sql = getTestDb();
		const [connection] = await sql<{ auth_profile_id: string }>`
			SELECT auth_profile_id FROM connections WHERE id = ${httpConnectionId}
		`;
		await sql`UPDATE connections SET auth_profile_id = NULL WHERE id = ${httpConnectionId}`;

		try {
			const result = await manageOperations(
				{
					action: "execute",
					connection_id: httpConnectionId,
					operation_key: "create_item",
					input: { body: { value: "missing-credentials" } },
				},
				{} as Env,
				ctx,
			);
			expect(result).toMatchObject({
				action: "execute",
				status: "failed",
			});
			const [run] = await sql<{ status: string; completed_at: Date | null }>`
				SELECT status, completed_at FROM runs
				WHERE id = ${(result as { run_id: number }).run_id}
			`;
			expect(run.status).toBe("failed");
			expect(run.completed_at).not.toBeNull();
		} finally {
			await sql`
				UPDATE connections SET auth_profile_id = ${connection.auth_profile_id}
				WHERE id = ${httpConnectionId}
			`;
		}
	});

	it("propagates caller cancellation to an HTTP operation and finalizes the run", async () => {
		const controller = new AbortController();
		const pending = manageOperations(
			{
				action: "execute",
				connection_id: httpConnectionId,
				operation_key: "create_item",
				input: { body: { value: "wait-for-abort" } },
			},
			{} as Env,
			{ ...ctx, abortSignal: controller.signal },
		);
		setTimeout(() => controller.abort(new Error("cancelled by test")), 10);

		const result = await pending;
		expect(result).toMatchObject({
			action: "execute",
			status: "failed",
			error_message: "cancelled by test",
		});
		const [run] = await getTestDb()<{
			status: string;
			completed_at: Date | null;
		}>`
			SELECT status, completed_at FROM runs
			WHERE id = ${(result as { run_id: number }).run_id}
		`;
		expect(run.status).toBe("failed");
		expect(run.completed_at).not.toBeNull();
	});

	it("times out a stalled HTTP operation and finalizes the run", async () => {
		const previousTimeout = process.env.HTTP_OPERATION_FETCH_TIMEOUT_MS;
		process.env.HTTP_OPERATION_FETCH_TIMEOUT_MS = "10";
		try {
			const result = await manageOperations(
				{
					action: "execute",
					connection_id: httpConnectionId,
					operation_key: "create_item",
					input: { body: { value: "wait-for-timeout" } },
				},
				{} as Env,
				ctx,
			);
			expect(result).toMatchObject({
				action: "execute",
				status: "failed",
				error_message: "HTTP operation timed out after 10ms",
			});
			const [run] = await getTestDb()<{
				status: string;
				completed_at: Date | null;
			}>`
				SELECT status, completed_at FROM runs
				WHERE id = ${(result as { run_id: number }).run_id}
			`;
			expect(run.status).toBe("failed");
			expect(run.completed_at).not.toBeNull();
		} finally {
			if (previousTimeout === undefined) {
				delete process.env.HTTP_OPERATION_FETCH_TIMEOUT_MS;
			} else {
				process.env.HTTP_OPERATION_FETCH_TIMEOUT_MS = previousTimeout;
			}
		}
	});
});
