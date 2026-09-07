import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { isPublicReadable } from "../../../auth/tool-access";
import {
	REST_TOOL_GET_ROUTES,
	fixedActionArgs,
	resolveRestToolGetRoute,
} from "../../../http/rest-tool-routes";

describe("REST proxy route declarations", () => {
	it("declares only pairs the tool door already serves publicly", () => {
		// Keep this table limited to routes intentionally eligible for anonymous
		// public-org reads.
		for (const route of REST_TOOL_GET_ROUTES) {
			expect({
				route: route.routePath,
				public: isPublicReadable(route.tool, { action: route.action }),
			}).toEqual({ route: route.routePath, public: true });
		}
	});

	it("covers the routes that were 401 over REST and 200 over the tool door", () => {
		expect(REST_TOOL_GET_ROUTES.map((r) => r.routePath).sort()).toEqual([
			"/api/:orgSlug/actions/available",
			"/api/:orgSlug/connections",
			"/api/:orgSlug/connections/:id",
			"/api/:orgSlug/runs",
		]);
	});

	it("has no duplicate route paths", () => {
		const paths = REST_TOOL_GET_ROUTES.map((r) => r.routePath);
		expect(new Set(paths).size).toBe(paths.length);
	});
});

describe("route resolution seam", () => {
	/**
	 * Production has global `/*` middleware and a final SPA catch-all. The auth
	 * handler must use its current route: the last matched route is the catch-all.
	 */
	async function resolveThroughMiddleware(
		path: string
	): Promise<string | undefined> {
		const app = new Hono();
		let declared: string | undefined;
		app.use("/*", async (_c, next) => next());
		const auth = async (
			c: Parameters<Parameters<typeof app.get>[1]>[0],
			next: () => Promise<void>
		) => {
			declared = resolveRestToolGetRoute(c)?.action;
			await next();
		};
		for (const route of REST_TOOL_GET_ROUTES) {
			app.get(route.routePath, auth, (c) => c.text("ok"));
		}
		app.get("/api/:orgSlug/agents", auth, (c) => c.text("ok"));
		app.post("/api/:orgSlug/:toolName", auth, (c) => c.text("ok"));
		app.get("*", (c) => c.text("catch-all"));
		await app.request(path);
		return declared;
	}

	it("distinguishes the connection list from the connection detail route", async () => {
		await expect(
			resolveThroughMiddleware("/api/market/connections")
		).resolves.toBe("list");
		await expect(
			resolveThroughMiddleware("/api/market/connections/7")
		).resolves.toBe("get");
	});

	it("resolves the remaining declared proxies", async () => {
		await expect(resolveThroughMiddleware("/api/market/runs")).resolves.toBe(
			"list_runs"
		);
		await expect(
			resolveThroughMiddleware("/api/market/actions/available")
		).resolves.toBe("list_available");
	});

	it("resolves nothing for an undeclared or unmatched route", async () => {
		await expect(
			resolveThroughMiddleware("/api/market/agents")
		).resolves.toBeUndefined();
		await expect(
			resolveThroughMiddleware("/api/market/nope")
		).resolves.toBeUndefined();
	});
});

describe("declared arg extraction", () => {
	async function argsFor(
		routePathPattern: string,
		url: string
	): Promise<Record<string, unknown> | undefined> {
		const route = REST_TOOL_GET_ROUTES.find(
			(candidate) => candidate.routePath === routePathPattern
		);
		if (!route) throw new Error(`undeclared: ${routePathPattern}`);
		const app = new Hono();
		let extracted: Record<string, unknown> | undefined;
		app.get(route.routePath, (c) => {
			extracted = route.args(c);
			return c.text("ok");
		});
		await app.request(url);
		return extracted;
	}

	it("passes query params through for list routes", async () => {
		await expect(
			argsFor("/api/:orgSlug/connections", "/api/market/connections?limit=5")
		).resolves.toEqual({ limit: "5" });
	});

	it("reads the path param for the detail route", async () => {
		await expect(
			argsFor("/api/:orgSlug/connections/:id", "/api/market/connections/42")
		).resolves.toEqual({ connection_id: 42 });
	});

	it("never supplies its own action — restToolAction pins it", async () => {
		const args = await argsFor(
			"/api/:orgSlug/runs",
			"/api/market/runs?action=delete"
		);
		// The caller's forged `action` survives extraction and is overwritten
		// downstream by `fixedActionArgs`, which spreads it BEFORE the fixed one.
		expect(args).toEqual({ action: "delete" });
	});
});

describe("fixed-action REST arg composition", () => {
	it("does not let a caller param replace the route's action", () => {
		const args = fixedActionArgs("list", {
			action: "delete",
			connection_id: "5",
		});

		expect(args.action).toBe("list");
		expect(args.connection_id).toBe("5");
	});

	it("still forwards the caller's other params untouched", () => {
		const args = fixedActionArgs("list_available", {
			connector_key: "slack",
			limit: "10",
		});

		expect(args).toEqual({
			connector_key: "slack",
			limit: "10",
			action: "list_available",
		});
	});

	it("works with no caller params", () => {
		expect(fixedActionArgs("get")).toEqual({ action: "get" });
	});
});

/** Guard route registrations against bypassing the tested composition. */
describe("fixed-action REST route registrations", () => {
	const indexSrc = readFileSync(join(__dirname, "../../../index.ts"), "utf8");
	const restApiSrc = readFileSync(join(__dirname, "../../../rest-api.ts"), "utf8");

	it("does not pass retired arguments through the strict Automation tool boundary", () => {
		expect(restApiSrc).not.toContain("include_template_details");
	});

	it("has no restToolProxy call that spreads caller params after an action", () => {
		const trailingSpread =
			/restToolProxy\([^)]*\{\s*action:\s*["'][a-z_]+["']\s*,\s*\.\.\./gs;
		const offenders = indexSrc.match(trailingSpread) ?? [];

		expect(offenders).toEqual([]);
	});

	it("routes every fixed-action REST wrapper through restToolAction", () => {
		// Generic dispatch and the actor-only read route do not pin an action.
		const bareProxyCalls = indexSrc.match(/restToolProxy\(/g) ?? [];
		expect(bareProxyCalls).toHaveLength(2);
		expect(indexSrc.match(/restToolProxy\(c, "read_knowledge"\)/g)).toHaveLength(1);

		expect(indexSrc.match(/restToolAction\(/g)).toHaveLength(3);
	});

	it("no longer registers the superseded window/execute REST routes", () => {
		// Both were replaced by the generic tool-dispatch surface
		// (`get_automation` via `/automations?automation_id=…` and the
		// `POST /:orgSlug/:toolName` proxy). Asserting the literals are gone
		// names exactly what was deleted and stops a re-introduction.
		expect(indexSrc).not.toContain("automations/windows/:windowId");
		expect(indexSrc).not.toContain("actions/execute");
	});

	it("registers read-only proxy GETs from the declaration table", () => {
		expect(indexSrc).toContain("for (const route of REST_TOOL_GET_ROUTES)");
	});

	it("declares no GET proxy inline, so the public-read check cannot drift", () => {
		// A GET registered with a literal tool name is invisible to
		// `canAccessPublicOrgRestRoute`, which resolves routes through
		// `REST_TOOL_GET_ROUTES`. Such a route would silently keep the old
		// "200 via the tool door, 401 via REST" split.
		const inlineGetProxies = indexSrc
			.split(/\bapp\.get\(/)
			.slice(1)
			.map((chunk) => chunk.split(/\bapp\.(get|post|put|patch|delete|route)\(/)[0])
			.filter((chunk) => /restToolAction\(\s*c,\s*["']/.test(chunk));

		expect(inlineGetProxies).toEqual([]);
	});
});
