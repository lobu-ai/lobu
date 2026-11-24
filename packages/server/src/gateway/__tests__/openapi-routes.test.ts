/**
 * Doc-projection regression tests for the defineRoute registry.
 *
 * The merged OpenAPI document is assembled from three `paths` groups
 * (dispatch tools, openapi-auto walk, defineRoute registry). The merge must be
 * method-wise: the registry documenting POST /api/v1/agents must NOT drop
 * openapi-auto's GET on the same path (the whole-path-spread bug the review
 * caught). Also pins the SSE endpoint's `text/event-stream` declaration.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { Hono } from "hono";
import {
	buildRoutePaths,
	defineRoute,
	getValidated,
	mergeOpenApiPaths,
	type RouteSpec,
} from "../routes/shared/define-route.js";
import { createAgentApi } from "../routes/public/agent.js";
import {
	createInstallRoutes,
	type InstallEngineIntegration,
	oauthInstallBrowserPaths,
} from "../routes/public/app-install.js";
import { registerAutoOpenApiRoutes } from "../routes/openapi-auto.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Type } from "@sinclair/typebox";

describe("mergeOpenApiPaths", () => {
	test("merges per method — sibling operations on the same path survive", () => {
		const auto = {
			"/api/v1/agents": { get: { operationId: "listAgents" } },
			"/api/v1/agents/{agentId}": {
				patch: { operationId: "updateAgent" },
			},
		};
		const registry = {
			"/api/v1/agents": { post: { operationId: "createAgent" } },
			"/api/v1/agents/{agentId}": {
				get: { operationId: "getAgent" },
				delete: { operationId: "deleteAgent" },
			},
		};
		const merged = mergeOpenApiPaths(auto, registry) as Record<
			string,
			Record<string, { operationId: string }>
		>;
		expect(Object.keys(merged["/api/v1/agents"]).sort()).toEqual([
			"get",
			"post",
		]);
		expect(Object.keys(merged["/api/v1/agents/{agentId}"]).sort()).toEqual([
			"delete",
			"get",
			"patch",
		]);
	});

	test("later group wins per conflicting method", () => {
		const merged = mergeOpenApiPaths(
			{ "/x": { get: { operationId: "stub" } } },
			{ "/x": { get: { operationId: "rich" } } },
		) as Record<string, Record<string, { operationId: string }>>;
		expect(merged["/x"].get.operationId).toBe("rich");
	});
});

describe("buildRoutePaths", () => {
	test("agent routes document both methods on /api/v1/agents/{agentId} and SSE media type", () => {
		// Registering the real agent API populates the route registry.
		createAgentApi({
			queueProducer: {} as never,
			sessionManager: {} as never,
			sseManager: {} as never,
			publicGatewayUrl: "http://localhost:8787",
		} as never);

		const paths = buildRoutePaths() as Record<
			string,
			Record<string, { responses: Record<string, unknown> }>
		>;

		expect(paths["/api/v1/agents"]?.post).toBeDefined();
		expect(paths["/api/v1/agents/{agentId}"]?.get).toBeDefined();
		expect(paths["/api/v1/agents/{agentId}"]?.delete).toBeDefined();

		const sse = paths["/api/v1/agents/{agentId}/events"]?.get as {
			responses: Record<string, { content?: Record<string, unknown> }>;
		};
		expect(sse).toBeDefined();
		expect(Object.keys(sse.responses["200"].content ?? {})).toEqual([
			"text/event-stream",
		]);
	});

	test("JSON bodies validate STRICTLY — scalar coercion is rejected", async () => {
		const app = new Hono();
		defineRoute(
			app,
			{
				method: "post",
				path: "/strict",
				request: {
					body: Type.Object({ content: Type.String() }),
				},
				responses: { 200: { description: "ok" } },
			},
			(c) => c.json({ ok: true }),
		);
		// {content: 123} must be a 400, not silently coerced to "123".
		const bad = await app.request("/strict", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: 123 }),
		});
		expect(bad.status).toBe(400);
		const good = await app.request("/strict", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "hi" }),
		});
		expect(good.status).toBe(200);
	});

	test("path/query params coerce from their string form", async () => {
		const app = new Hono();
		let seen: unknown;
		defineRoute(
			app,
			{
				method: "get",
				path: "/things/{thingId}",
				request: {
					params: Type.Object({ thingId: Type.String() }),
					query: Type.Object({ limit: Type.Integer({ minimum: 1 }) }),
				},
				responses: { 200: { description: "ok" } },
			},
			(c) => {
				seen = getValidated(c).query;
				return c.json({ ok: true });
			},
		);
		const res = await app.request("/things/t1?limit=5");
		expect(res.status).toBe(200);
		expect(seen).toEqual({ limit: 5 });
		const bad = await app.request("/things/t1?limit=zero");
		expect(bad.status).toBe(400);
	});

	test("custom mediaType and {param} doc form are preserved", () => {
		const spec: RouteSpec = {
			method: "get",
			path: "/api/v1/things/{thingId}/stream",
			responses: {
				200: {
					description: "stream",
					schema: Type.String(),
					mediaType: "text/event-stream",
				},
			},
		};
		defineRoute(new Hono(), spec, () => new Response(null));
		const paths = buildRoutePaths();
		expect(paths["/api/v1/things/{thingId}/stream"]).toBeDefined();
	});
});

describe("POST /api/v1/agents/:id/messages — strict JSON on the REAL route", () => {
	// The send-message route sets `skipBodyValidation` (multipart OR JSON) and
	// validates the JSON branch by hand — the synthetic defineRoute tests above
	// do not exercise that path, so drive the real handler. A worker token whose
	// agentId matches the path passes the ownership gate without a DB.
	const TEST_KEY =
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	let savedKey: string | undefined;
	beforeEach(() => {
		savedKey = process.env.ENCRYPTION_KEY;
		process.env.ENCRYPTION_KEY = TEST_KEY;
	});
	afterEach(() => {
		if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
		else process.env.ENCRYPTION_KEY = savedKey;
	});

	const send = async (body: unknown): Promise<Response> => {
		const app = createAgentApi({
			queueProducer: {} as never,
			sessionManager: { async getSession() { return null; } } as never,
			sseManager: {} as never,
			publicGatewayUrl: "http://localhost:8787",
			artifactStore: {} as never,
		} as never);
		const token = generateWorkerToken("agent-x", "conv-1", "dep-1", {
			channelId: "chan-1",
			agentId: "agent-x",
			organizationId: "org-1",
		});
		return app.request("/api/v1/agents/agent-x/messages", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	};

	test("numeric content is rejected with a field-level 400", async () => {
		const res = await send({ content: 123 });
		expect(res.status).toBe(400);
		const data = (await res.json()) as { error: string };
		expect(data.error).toMatch(/content/);
	});

	test("valid content gets PAST body validation", async () => {
		const res = await send({ content: "hello" });
		expect(res.status).not.toBe(400);
	});
});

describe("optional request bodies", () => {
	test("a bodyless POST to an all-optional-body route validates as {}", async () => {
		const app = new Hono();
		let seen: unknown;
		defineRoute(
			app,
			{
				method: "post",
				path: "/optional-body",
				request: { body: Type.Object({ note: Type.Optional(Type.String()) }) },
				responses: { 200: { description: "ok" } },
			},
			(c) => {
				seen = getValidated(c).json;
				return c.json({ ok: true });
			},
		);
		const res = await app.request("/optional-body", { method: "POST" });
		expect(res.status).toBe(200);
		expect(seen).toEqual({});
	});

	test("a bodyless POST to a required-body route fails field-level", async () => {
		const app = new Hono();
		defineRoute(
			app,
			{
				method: "post",
				path: "/required-body",
				request: { body: Type.Object({ name: Type.String() }) },
				responses: { 200: { description: "ok" } },
			},
			(c) => c.json({ ok: true }),
		);
		const res = await app.request("/required-body", { method: "POST" });
		expect(res.status).toBe(400);
	});

	test("doc `requestBody.required` mirrors the schema", () => {
		// Registered by the tests above (registry is module-global).
		const paths = buildRoutePaths() as Record<
			string,
			Record<string, { requestBody?: { required: boolean } }>
		>;
		expect(paths["/optional-body"].post.requestBody?.required).toBe(false);
		expect(paths["/required-body"].post.requestBody?.required).toBe(true);
		// The real create-agent route is all-optional → optional body.
		expect(paths["/api/v1/agents"].post.requestBody?.required).toBe(false);
	});
});

describe("hosted-app install routes in the document", () => {
	test("the engine's browser redirects are left out; GitHub's documented routes stay", () => {
		const integrations: InstallEngineIntegration[] = [
			{
				connectorKey: "examplechat",
				provider: "examplechat",
				deliveryKind: "chat",
				method: {
					type: "app_installation",
					provider: "examplechat",
					installShape: "oauth-code-exchange",
					authorizeUrl: "https://chat.example.test/oauth/authorize",
				},
			},
			{
				connectorKey: "github",
				provider: "github",
				method: { type: "app_installation", provider: "github", installShape: "github-app" },
			},
		];
		const app = new OpenAPIHono();
		app.route(
			"",
			createInstallRoutes({
				installationStore: {} as never,
				resolveInstallOrgId: async () => null,
				verifyInstallOrgAccess: async () => false,
				verifyInstallOrgAdminAccess: async () => false,
				integrations,
				completeChatPendingInstall: async () => null,
			}),
		);
		registerAutoOpenApiRoutes(app, oauthInstallBrowserPaths(integrations));

		const mounted = app.routes.map((route) => route.path);
		expect(mounted).toContain("/examplechat/install");
		expect(mounted).toContain("/examplechat/oauth_callback");
		const documented = Object.keys(
			app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "1" } }).paths ?? {},
		);
		expect(documented).not.toContain("/examplechat/install");
		expect(documented).not.toContain("/examplechat/oauth_callback");
		expect(documented).toContain("/github/app/install");
		expect(documented).toContain("/github/app/install/callback");
	});
});
