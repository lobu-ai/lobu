import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../../index";
import {
	restGetAutomations,
	restInvokeEventAction,
	restSearchKnowledge,
	toRestPublicToolResult,
} from "../../rest-api";

describe("REST ToolUserError responses", () => {
	it("projects SDK tool results to the documented public shape", () => {
		const rich = {
			success: false,
			error: {
				name: "ScriptError",
				message: "boom",
				code: "INTERNAL",
				retryable: false,
				stack: "internal stack",
				details: { secret: true },
			},
			logs: [{ message: "internal log" }],
			duration_ms: 12,
			sdk_call_trace: [{ path: "knowledge.search" }],
			skipped_calls: 0,
			side_effect_preview: [],
			dry_run: false,
		};

		for (const toolName of ["query_sdk", "run_sdk"]) {
			const projected = toRestPublicToolResult(toolName, rich) as Record<
				string,
				unknown
			>;
			expect(projected.error).toEqual({
				name: "ScriptError",
				message: "boom",
				code: "INTERNAL",
				retryable: false,
			});
			expect(projected.logs).toBeUndefined();
			expect(projected.duration_ms).toBeUndefined();
			expect(projected.sdk_call_trace).toBeUndefined();
		}
		expect(toRestPublicToolResult("manage_operations", rich)).toBe(rich);
	});

	it("preserves the status thrown by the wrapped tool", async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.use("*", async (c, next) => {
			c.set("organizationId" as never, "test-org" as never);
			c.set("memberRole" as never, "owner" as never);
			c.set("mcpIsAuthenticated" as never, true as never);
			c.set(
				"mcpAuthInfo" as never,
				{
					tokenType: "access_token",
					organizationId: "test-org",
					userId: "test-user",
					scopes: [],
				} as never
			);
			await next();
		});
		app.get("/api/:orgSlug/knowledge/search", restSearchKnowledge);

		const response = await app.request(
			"/api/test-org/knowledge/search?query=customer+feedback"
		);

		expect(response.status).toBe(403);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("read_knowledge needs read access.");
		expect(body.error).toContain("'Read only' or a higher level");
	});

	it("rejects a malformed automation_id instead of partially parsing it", async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.get("/api/:orgSlug/automations", restGetAutomations);

		const response = await app.request("/api/test-org/automations?automation_id=71%29");

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "automation_id must be a positive integer",
		});
	});

	it("does not let a read-only token append a template interaction event", async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.use("*", async (c, next) => {
			c.set("organizationId" as never, "test-org" as never);
			c.set("memberRole" as never, "member" as never);
			c.set("mcpIsAuthenticated" as never, true as never);
			c.set(
				"mcpAuthInfo" as never,
				{
					tokenType: "access_token",
					organizationId: "test-org",
					userId: "test-user",
					scopes: ["mcp:read"],
				} as never,
			);
			await next();
		});
		app.post(
			"/api/:orgSlug/events/:eventId/actions/:action",
			restInvokeEventAction,
		);

		const response = await app.request(
			"/api/test-org/events/42/actions/vote",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: "A", interaction_id: "attempt-1" }),
			},
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "This interaction requires write access.",
		});
	});

	it("does not let an authenticated public reader append an interaction event", async () => {
		const app = new Hono<{ Bindings: Env }>();
		app.use("*", async (c, next) => {
			c.set("organizationId" as never, "test-org" as never);
			c.set("memberRole" as never, null as never);
			c.set("mcpIsAuthenticated" as never, true as never);
			c.set(
				"mcpAuthInfo" as never,
				{
					tokenType: "access_token",
					organizationId: "test-org",
					userId: "public-reader",
					scopes: ["mcp:read", "mcp:write"],
				} as never,
			);
			await next();
		});
		app.post(
			"/api/:orgSlug/events/:eventId/actions/:action",
			restInvokeEventAction,
		);

		const response = await app.request(
			"/api/test-org/events/42/actions/vote",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: "A", interaction_id: "attempt-2" }),
			},
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "This interaction requires write access.",
		});
	});
});
