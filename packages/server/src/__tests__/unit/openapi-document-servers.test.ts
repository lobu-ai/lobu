import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createGatewayApp } from "../../gateway/cli/gateway";
import type { Env } from "../../index";
import { app as mainApp } from "../../index";
import { buildWrapperApp } from "../../server-lifecycle";

/**
 * The published OpenAPI document has to resolve to routes that exist, in the
 * app that actually owns them.
 *
 * The gateway app is served at the origin standalone and under `/lobu` when
 * embedded, while the dispatch-tool half of the same document is served by the
 * main app at the origin in both. A document that names one hardcoded base
 * therefore aims consumers at a path the owning app never answers: bare
 * `/api/v1/agents` reaches the main app's `/api/:orgSlug/*` instead, which
 * parses `v1` as a workspace and replies `Organization 'v1' not found`.
 *
 * So this guard enumerates the class rather than naming a file: for EVERY
 * operation in the served document it resolves the base that document declares
 * and asserts the owning app has a route there, in both topologies.
 */

/**
 * `createGatewayApp` mounts the Agent API only when it has core services. No
 * handler runs here — the document and the routing table are both built at
 * registration time — so a stub answering every getter with `null` registers
 * the routes without a database.
 */
const stubCoreServices = new Proxy({}, { get: () => () => null });

function buildGateway() {
	return createGatewayApp({
		secretProxy: null,
		workerGateway: null,
		mcpProxy: null,
		coreServices: stubCoreServices,
	} as unknown as Parameters<typeof createGatewayApp>[0]);
}

interface RegisteredRoute {
	method: string;
	pattern: RegExp;
}

/**
 * The concrete request paths an app answers, relative to its own root.
 * Middleware (`app.use`) is dropped: it is registered on `/*` and would make
 * every assertion below vacuous.
 */
function registeredRoutes(app: {
	routes: { method: string; path: string }[];
}): RegisteredRoute[] {
	return app.routes
		.filter((route) => route.path !== "*" && route.path !== "/*")
		.map((route) => ({
			method: route.method.toUpperCase(),
			pattern: honoPathToRegExp(route.path),
		}));
}

function honoPathToRegExp(honoPath: string): RegExp {
	const source = honoPath
		.split("/")
		.map((segment) => {
			if (segment === "*") return ".*";
			if (segment.startsWith(":")) return "[^/]+";
			return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("/");
	return new RegExp(`^${source}/?$`);
}

/** OpenAPI templating (`{agentId}`) → a concrete path segment. */
function concretePath(openApiPath: string): string {
	return openApiPath.replace(/\{[^}]+\}/g, "sample");
}

function joinBase(base: string, path: string): string {
	return base === "/" ? path : `${base.replace(/\/+$/, "")}${path}`;
}

function isRouted(
	routes: RegisteredRoute[],
	method: string,
	requestPath: string,
): boolean {
	const wanted = method.toUpperCase();
	return routes.some(
		(route) =>
			(route.method === wanted || route.method === "ALL") &&
			route.pattern.test(requestPath),
	);
}

const HTTP_METHODS = new Set([
	"get",
	"put",
	"post",
	"delete",
	"options",
	"head",
	"patch",
	"trace",
]);

type PathItem = Record<string, unknown> & { servers?: { url: string }[] };
interface OpenApiDocument {
	servers?: { url: string }[];
	paths?: Record<string, PathItem>;
}

interface DocumentedOperation {
	path: string;
	method: string;
	declaredBase: string;
	/** Gateway-owned paths carry their own `servers`; the rest are the origin's. */
	owner: "gateway" | "origin";
}

function documentedOperations(doc: OpenApiDocument): DocumentedOperation[] {
	const documentBase = doc.servers?.[0]?.url;
	expect(typeof documentBase).toBe("string");
	const operations: DocumentedOperation[] = [];
	for (const [path, item] of Object.entries(doc.paths ?? {})) {
		const own = item.servers?.[0]?.url;
		for (const method of Object.keys(item)) {
			if (!HTTP_METHODS.has(method)) continue;
			operations.push({
				path,
				method,
				declaredBase: own ?? (documentBase as string),
				owner: own ? "gateway" : "origin",
			});
		}
	}
	return operations;
}

async function fetchDocument(
	app: { request: (path: string) => Promise<Response> },
	docPath: string,
): Promise<OpenApiDocument> {
	const response = await app.request(docPath);
	expect(response.status).toBe(200);
	return (await response.json()) as OpenApiDocument;
}

/**
 * Resolve every documented operation against the routes of the app that owns
 * it, and return the ones that land nowhere. `gatewayMount` is where the
 * gateway app sits in this topology; `originRoutes` is null when the topology
 * runs no main app (standalone), which makes the origin half unassertable.
 */
function unresolvedOperations(
	operations: DocumentedOperation[],
	gatewayMount: string,
	gatewayRoutes: RegisteredRoute[],
	originRoutes: RegisteredRoute[] | null,
): DocumentedOperation[] {
	return operations.filter((op) => {
		const requestPath = joinBase(op.declaredBase, concretePath(op.path));
		if (op.owner === "gateway") {
			if (!requestPath.startsWith(`${gatewayMount}/`)) return true;
			return !isRouted(
				gatewayRoutes,
				op.method,
				requestPath.slice(gatewayMount.length),
			);
		}
		if (!originRoutes) return false;
		return !isRouted(originRoutes, op.method, requestPath);
	});
}

describe("published OpenAPI document base URLs", () => {
	test("every documented operation resolves to its owning app when embedded", async () => {
		const gateway = buildGateway();
		const lobuApp = new Hono();
		lobuApp.route("/", gateway);
		const wrapper = buildWrapperApp({} as Env, lobuApp, mainApp);

		const doc = await fetchDocument(wrapper, "/lobu/api/docs/openapi.json");
		const operations = documentedOperations(doc);

		// Non-vacuity: the document must describe both halves.
		expect(
			operations.some(
				(op) => op.owner === "gateway" && op.path.startsWith("/api/v1/agents"),
			),
		).toBe(true);
		expect(
			operations.some(
				(op) => op.owner === "origin" && op.path.startsWith("/api/{orgSlug}/"),
			),
		).toBe(true);

		expect(
			unresolvedOperations(
				operations,
				"/lobu",
				registeredRoutes(gateway),
				registeredRoutes(mainApp),
			),
		).toEqual([]);
	}, 120_000);

	test("every documented operation resolves to its owning app when standalone", async () => {
		const gateway = buildGateway();
		const doc = await fetchDocument(gateway, "/api/docs/openapi.json");
		const operations = documentedOperations(doc);

		expect(
			operations.some(
				(op) => op.owner === "gateway" && op.path.startsWith("/api/v1/agents"),
			),
		).toBe(true);

		// A standalone gateway runs no main app, so the origin half is documented
		// but not servable here; `unresolvedOperations` skips it.
		expect(
			unresolvedOperations(operations, "", registeredRoutes(gateway), null),
		).toEqual([]);
	}, 120_000);

	test("the embedded document declares /lobu for gateway paths and the origin for dispatch paths", async () => {
		const lobuApp = new Hono();
		lobuApp.route("/", buildGateway());
		const doc = await fetchDocument(
			buildWrapperApp({} as Env, lobuApp, mainApp),
			"/lobu/api/docs/openapi.json",
		);

		expect(doc.servers?.[0]?.url).toBe("/");
		expect(doc.paths?.["/api/v1/agents"]?.servers?.[0]?.url).toBe("/lobu");
		// The dispatch surface is the main app's, not the gateway's, so it must
		// NOT inherit the /lobu mount.
		expect(
			doc.paths?.["/api/{orgSlug}/search_memory"]?.servers,
		).toBeUndefined();
	}, 120_000);

	test("the Agent API stays mounted only under /lobu when embedded", async () => {
		const lobuApp = new Hono();
		lobuApp.route("/", buildGateway());
		const wrapper = buildWrapperApp({} as Env, lobuApp, mainApp);

		const agentApiMounts = wrapper.routes
			.map((route) => route.path)
			.filter((path) => path.includes("/api/v1/agents"));

		expect(agentApiMounts.length).toBeGreaterThan(0);
		// The document is what gets corrected; the API keeps exactly one public
		// mount. A second copy at the origin would be a new permanent route for
		// the same API, and would silently make the guard above pass either way.
		expect(agentApiMounts.filter((path) => !path.startsWith("/lobu/"))).toEqual(
			[],
		);
	}, 120_000);

	test("the gateway landing page points at its own mount", async () => {
		const lobuApp = new Hono();
		lobuApp.route("/", buildGateway());
		const wrapper = buildWrapperApp({} as Env, lobuApp, mainApp);

		const embedded = (await (await wrapper.request("/lobu")).json()) as {
			docs: string;
			health: string;
		};
		expect(embedded.docs).toBe("/lobu/api/docs");
		expect(embedded.health).toBe("/lobu/health");
		// Status alone proves nothing here: the origin answers `/api/docs` with an
		// unrelated 200 status blob, so a pointer that lands there looks healthy
		// and still never reaches the reference page.
		expect(await (await wrapper.request(embedded.docs)).text()).toContain(
			"Scalar API Reference",
		);
		expect(
			await (await wrapper.request(embedded.health)).json(),
		).toHaveProperty("capabilities");

		const standalone = (await (await buildGateway().request("/")).json()) as {
			docs: string;
			health: string;
		};
		expect(standalone.docs).toBe("/api/docs");
		expect(standalone.health).toBe("/health");
	}, 120_000);

	test("the reference page loads the document from its own mount", async () => {
		const lobuApp = new Hono();
		lobuApp.route("/", buildGateway());
		const embedded = await buildWrapperApp({} as Env, lobuApp, mainApp).request(
			"/lobu/api/docs",
		);
		expect(embedded.status).toBe(200);
		expect(await embedded.text()).toContain("/lobu/api/docs/openapi.json");

		const standalone = await buildGateway().request("/api/docs");
		expect(standalone.status).toBe(200);
		const html = await standalone.text();
		expect(html).toContain("/api/docs/openapi.json");
		expect(html).not.toContain("/lobu/api/docs/openapi.json");
	}, 120_000);
});
