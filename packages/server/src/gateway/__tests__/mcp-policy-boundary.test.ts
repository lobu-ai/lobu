import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { generateWorkerToken, MCP_PROTOCOL_VERSION, verifyGatewayMcpToken } from "@lobu/core";
import { McpConfigService } from "../auth/mcp/config-service";
import { McpProxy } from "../auth/mcp/proxy";
import { ensureDbForGatewayTests, seedAgentRow } from "./helpers/db-setup";

describe("internal MCP policy boundary", () => {
	const originalFetch = globalThis.fetch;
	let token: string;
	beforeAll(async () => {
		await ensureDbForGatewayTests();
		await seedAgentRow("policy-agent");
		token = generateWorkerToken("policy-user", "policy-conversation", "policy-deployment", {
			organizationId: "test-org", agentId: "policy-agent", channelId: "policy-channel",
			adminTools: ["manage_operations"], adminActorUserId: "policy-user",
		});
	});
	afterEach(() => { globalThis.fetch = originalFetch; });
	afterAll(() => { globalThis.fetch = originalFetch; });

	for (const transport of ["REST", "JSON-RPC"] as const) {
		for (const decision of ["auto", "pending_approval", "denied"] as const) {
			test(`${transport} preserves the operation's ${decision} response without a transport approval`, async () => {
				const service = new McpConfigService({ lobuMemory: { resolveOrgSlug: async () => "test-org" } });
				const proxy = new McpProxy(service, {});
				const operationResult = { status: decision, run_id: 123 };
				const calls: Array<{ method: string; token: string }> = [];
				globalThis.fetch = async (_input, init) => {
					const body = init?.body ? JSON.parse(String(init.body)) : {};
					const auth = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
					calls.push({ method: body.method, token: auth });
					const result = body.method === "initialize"
						? { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } }
						: body.method === "tools/list" ? { tools: [{ name: "run_sdk" }] }
						: { content: [{ type: "text", text: JSON.stringify(operationResult) }], isError: decision === "denied" };
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
						headers: { "Content-Type": "application/json", "Mcp-Session-Id": "policy-session" },
					});
				};
				const rpc = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_sdk", arguments: { code: "operation()" } } };
				const response = await proxy.getApp().request(transport === "REST" ? "/lobu-memory/tools/run_sdk" : "/lobu-memory", {
					method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify(transport === "REST" ? rpc.params.arguments : rpc),
				});
				expect(response.status).toBe(200);
				const body = await response.json();
				const result = transport === "REST" ? body : body.result;
				expect(JSON.parse(result.content[0].text)).toEqual(operationResult);
				expect(result.isError).toBe(decision === "denied");
				expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(1);
				expect(calls.some((call) => call.method === "tools/list")).toBe(false);
				const dispatched = calls.find((call) => call.method === "tools/call")!;
				expect(verifyGatewayMcpToken(dispatched.token)).toMatchObject({
					organizationId: "test-org", agentId: "policy-agent", conversationId: "policy-conversation",
					adminTools: ["manage_operations"], adminActorUserId: "policy-user",
				});
			});
		}

		test(`${transport} rejects unregistered external MCP servers before network access`, async () => {
			const service = new McpConfigService({ lobuMemory: { resolveOrgSlug: async () => "test-org" } });
			const proxy = new McpProxy(service, {});
			let networkCalls = 0;
			globalThis.fetch = async () => { networkCalls++; throw new Error("unexpected upstream request"); };
			const response = await proxy.getApp().request(transport === "REST" ? "/external/tools/send" : "/external", {
				method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify(transport === "REST" ? {} : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send", arguments: {} } }),
			});
			const body = await response.json();
			expect(transport === "REST" ? body.error : body.error.message).toContain("not found");
			expect(networkCalls).toBe(0);
		});
	}
});
