import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../../index";
import { mountPublicApps } from "../../http/api-route-mounts";

function buildRoutingFixture() {
	const agentApi = new Hono();
	agentApi.get("/api/v1/agents", (c) => c.json({ route: "agent-api" }, 401));

	const mainApi = new Hono<{ Bindings: Env }>();
	mainApi.get("/api/:orgSlug/agents", (c) =>
		c.json({ route: "workspace-api", org: c.req.param("orgSlug") }, 404),
	);

	const wrapper = new Hono<{ Bindings: Env }>();
	mountPublicApps(wrapper, agentApi, mainApi);
	return wrapper;
}

describe("server lifecycle API route ownership", () => {
	it("routes the documented bare /api/v1 surface to the Agent API before workspace slug routes", async () => {
		const response = await buildRoutingFixture().request("/api/v1/agents", {
			headers: { accept: "application/json" },
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ route: "agent-api" });
	});

	it("keeps the legacy /lobu/api/v1 surface reachable", async () => {
		const response = await buildRoutingFixture().request("/lobu/api/v1/agents", {
			headers: { accept: "application/json" },
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ route: "agent-api" });
	});
});
