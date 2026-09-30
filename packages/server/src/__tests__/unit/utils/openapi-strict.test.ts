import { beforeAll, describe, expect, it } from "bun:test";
import type { RawDispatchTool } from "../../../tools/registry";
import { getRawDispatchTools } from "../../../tools/registry";
import {
	generateOpenAPISpec,
	generateStrictToolPaths,
} from "../../../utils/openapi-generator";

describe("generateOpenAPISpec", () => {
	it("uses public Automation terminology throughout ChatGPT metadata", () => {
		const spec = generateOpenAPISpec("https://example.test");
		// MCP App tools are never REST-dispatched, so they get no OpenAPI path.
		expect(spec.paths["/api/{orgSlug}/get_approval"]).toBeUndefined();
		expect(spec.paths["/api/{orgSlug}/resolve_approval"]).toBeUndefined();
		const saveMemory =
			spec.paths["/api/{orgSlug}/save_memory"]?.post?.requestBody?.content?.[
				"application/json"
			]?.schema;
		expect(
			saveMemory?.properties?.automation_source?.properties?.automation_id,
		).toBeDefined();
		expect(spec.servers[0]?.description).toContain("Automations");
	});
});

/**
 * The strict projection is the single TypeBox source rendered for the typed
 * first-party client. These guards keep it faithful: every dispatch tool gets a
 * path, output schemas survive, discriminated unions are NOT flattened, and
 * server-internal input fields never reach the client.
 */
describe("generateStrictToolPaths", () => {
	// Compute in `beforeAll`, NOT at describe-body evaluation: walking the tool
	// registry at module-load time races the registry's own circular-import
	// initialization (ALL_DISPATCH_TOOLS is still in its TDZ), which throws and
	// poisons the shared module for other suites. Production only ever calls these
	// at request time, well after modules settle.
	let paths: Record<string, any>;
	let tools: RawDispatchTool[];
	beforeAll(() => {
		paths = generateStrictToolPaths();
		tools = getRawDispatchTools();
	});

	it("emits one POST /api/{orgSlug}/<tool> path per dispatch tool", () => {
		const emitted = Object.keys(paths).sort();
		const expected = tools.map((t) => `/api/{orgSlug}/${t.name}`).sort();
		expect(emitted).toEqual(expected);
		for (const [path, ops] of Object.entries(paths)) {
			expect(path).toMatch(/^\/api\/\{orgSlug\}\//);
			expect(ops.post).toBeDefined();
			expect(ops.post.operationId).toBe(path.split("/").pop());
			const orgParam = ops.post.parameters?.[0];
			expect(orgParam?.name).toBe("orgSlug");
			expect(orgParam?.in).toBe("path");
			expect(orgParam?.required).toBe(true);
		}
	});

	it("renders each tool's real output schema as the 200 response", () => {
		for (const tool of tools) {
			if (!tool.outputSchema) continue;
			const schema =
				paths[`/api/{orgSlug}/${tool.name}`].post.responses["200"].content[
					"application/json"
				].schema;
			// Not the permissive `{ additionalProperties: true }` fallback: a real
			// TypeBox result carries structure (object properties or a union).
			const hasShape =
				schema.anyOf !== undefined ||
				schema.oneOf !== undefined ||
				schema.properties !== undefined;
			expect(hasShape, `${tool.name} 200 should carry a typed shape`).toBe(
				true,
			);
		}
	});

	it("preserves discriminated-union request bodies (no flattening)", () => {
		// manage_connections is a Type.Union of per-action variants; the strict
		// projection must keep the union so hey-api emits a discriminated type.
		const body =
			paths["/api/{orgSlug}/manage_connections"].post.requestBody.content[
				"application/json"
			].schema;
		expect(body.anyOf ?? body.oneOf, "union must survive").toBeDefined();
	});

	it("keeps the connector install workflow in the generated-client description", () => {
		const description =
			paths["/api/{orgSlug}/manage_connections"].post.description;
		expect(description).toContain("manage_catalog");
		expect(description.length).toBeLessThanOrEqual(300);
	});

	it("drops server-internal input fields via the public schema", () => {
		const body =
			paths["/api/{orgSlug}/search_memory"].post.requestBody.content[
				"application/json"
			].schema;
		expect(body.properties?.query_embedding).toBeUndefined();
		expect(body.properties?.agent_id).toBeUndefined();

		const readBody =
			paths["/api/{orgSlug}/read_knowledge"].post.requestBody.content[
				"application/json"
			].schema;
		expect(readBody.properties?.client_ids).toBeDefined();
		expect(readBody.properties?.mcp_activity_id).toBeUndefined();
	});

	it("strips TypeBox internal $id/static keys", () => {
		const json = JSON.stringify(paths);
		expect(json).not.toContain('"$id"');
		expect(json).not.toContain('"static"');
	});
});
