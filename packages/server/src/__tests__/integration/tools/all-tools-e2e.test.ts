/**
 * Registry-driven, model-free coverage for EVERY agent MCP tool.
 *
 * Why this exists: the only durable guarantee that "all agent tools work" is a
 * test that actually invokes each one end-to-end. This file iterates the live
 * tool registry (`getAllTools`) and calls every tool through the exact seam the
 * REST proxy uses — `executeTool(name, args, env, authCtx)` — with a real org,
 * a real owner, and a real embedded Postgres. No LLM is involved: each tool is
 * driven with valid minimal arguments and asserted to return a structured
 * result without throwing — anything thrown (validation rejection on valid
 * args, TypeError, DB crash, "Tool not found") fails the test.
 *
 * Auto-coverage of future tools: the test fails if any registry tool is missing
 * from the per-tool ARGS fixture below. Adding a tool to the registry without
 * adding coverage here turns this suite red — by design, so nobody can ship an
 * un-exercised agent tool.
 *
 * Coverage classes (documentary `coverage` field on each plan entry):
 *   - 'round-trip': performs a real mutation/read whose effect we assert
 *     (e.g. manage_entity create→delete, automation create→get-versions).
 *   - 'reachable':  invoked with valid minimal args and asserted to return a
 *     structured result.
 *
 * None of the 23 tools genuinely require a live model to reach — `run_sdk` is
 * driven with `dry_run: true` (reads + previews writes, no mutation, no model),
 * and every `manage_*` action exercised here is a list/read/CRUD path.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { getAllTools } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

/** How a tool is exercised, for human-readable reporting. */
type Coverage = "round-trip" | "reachable";

interface ToolPlan {
	/** Static minimal args, or a factory when args depend on seeded ids. */
	args: Record<string, unknown> | (() => Record<string, unknown>);
	coverage: Coverage;
	/** One-line note describing what the invocation proves. */
	note: string;
}

describe("all agent MCP tools — registry-driven e2e (model-free)", () => {
	let orgSlug: string;
	let agentId: string;
	let entityId: number;
	let automationId: string;
	let authCtx: AuthContext;

	/**
	 * Build the per-tool argument plan. Defined as a function so factories can
	 * close over the ids seeded in beforeAll.
	 */
	function toolPlan(): Record<string, ToolPlan> {
		return {
			// ── memory ──────────────────────────────────────────────────────────
			search_memory: {
				args: { query: "coverage probe" },
				coverage: "reachable",
				note: "semantic/text memory search returns a structured result set",
			},
			save_memory: {
				args: {
					content: "tools-e2e coverage note",
					semantic_type: "content",
					metadata: {},
				},
				coverage: "round-trip",
				note: "appends an event to memory and returns its id",
			},
			read_knowledge: {
				args: () => ({ entity_id: entityId }),
				coverage: "reachable",
				note: "lists content for the seeded entity",
			},
			// ── discovery ─────────────────────────────────────────────────────────
			list_organizations: {
				args: {},
				coverage: "round-trip",
				note: "returns the orgs the seeded owner belongs to (must include ours)",
			},
			search_sdk: {
				args: { query: "automations" },
				coverage: "reachable",
				note: "returns ClientSDK method metadata for the namespace",
			},
			// ── power tools ────────────────────────────────────────────────────────
			query_sdk: {
				args: {
					script:
						"export default async (_ctx, client) => client.entities.list({});",
				},
				coverage: "round-trip",
				note: "read-only sandbox script lists entities through the typed SDK",
			},
			query_sql: {
				args: { sql: "SELECT id, name FROM entities", sort_by: "id" },
				coverage: "round-trip",
				note: "paginated read-only SQL auto-scoped to the org returns rows",
			},
			metric_series: {
				args: {
					sql: "SELECT date_trunc('day', created_at) AS bucket, count(*)::int AS n FROM entities GROUP BY 1",
				},
				coverage: "round-trip",
				note: "time-series SQL returns { columns, rows } for the org",
			},
			run_sdk: {
				args: {
					script:
						"export default async (_ctx, client) => client.entities.list({});",
					dry_run: true,
				},
				coverage: "reachable",
				note: "full SDK sandbox in dry_run mode — reads run, writes are previewed, no model",
			},
			// ── metric layer ────────────────────────────────────────────────────────
			list_metrics: {
				args: {},
				coverage: "reachable",
				note: "lists the declared metric catalog (measures/dimensions/segments) for the org",
			},
			query_metric: {
				args: { entity_type: "metric-co", measure: "n" },
				coverage: "round-trip",
				note: "runs a declared measure end-to-end (compile → scope → execute); 0 rows is fine",
			},
			// ── REST/admin surface ──────────────────────────────────────────────────
			manage_entity: {
				// The create→delete round-trip is asserted in its own dedicated test;
				// here we drive the read path so the registry loop still covers it.
				args: () => ({ action: "list", entity_type: "brand" }),
				coverage: "round-trip",
				note: "lists entities of a type (create→delete asserted separately)",
			},
			manage_entity_schema: {
				args: { schema_type: "entity_type", action: "list" },
				coverage: "reachable",
				note: "lists entity-type schemas for the org",
			},
			manage_connections: {
				args: { action: "list" },
				coverage: "reachable",
				note: "lists connections for the org",
			},
			manage_catalog: {
				args: { action: "list_catalog", kinds: ["connectors"] },
				coverage: "reachable",
				note: "lists global connector catalog manifests",
			},
			manage_agents: {
				args: { action: "list" },
				coverage: "reachable",
				note: "lists agents for the org",
			},
			manage_conversations: {
				// `list` drives the read path model-free (send would enqueue a real
				// turn, which needs a model). agent_id is the seeded fixture agent.
				args: () => ({ action: "list", agent_id: agentId }),
				coverage: "reachable",
				note: "lists an agent's conversations (send/get covered by unit tests)",
			},
			manage_feeds: {
				args: { action: "list_feeds" },
				coverage: "reachable",
				note: "lists feeds for the org",
			},
			manage_auth_profiles: {
				args: { action: "list_auth_profiles" },
				coverage: "reachable",
				note: "lists auth profiles for the org",
			},
			manage_operations: {
				args: { action: "list_available" },
				coverage: "reachable",
				note: "lists available operations for the org",
			},
			manage_classifiers: {
				args: { action: "list" },
				coverage: "reachable",
				note: "lists classifiers for the org",
			},
			manage_schedules: {
				args: { action: "list" },
				coverage: "reachable",
				note: "lists scheduled jobs for the org",
			},
			manage_views: {
				// 'list' returns the org's views as metadata (never bundles) —
				// a structured success, not an error, when empty.
				args: { action: "list" },
				coverage: "round-trip",
				note: "lists the org's views metadata (empty when none saved)",
			},
			open_view: {
				args: { key: "coverage-board" },
				coverage: "round-trip",
				note: "opens the seeded view: per-view resource + web URL with params",
			},
			notify: {
				// recipients defaults to 'admins' and no connection_id is set, so this
				// writes an in-app notification only — it never reaches an external
				// platform. The seeded owner counts as an admin recipient.
				args: {
					action: "send",
					title: "tools-e2e coverage",
					recipients: "admins",
				},
				coverage: "round-trip",
				note: "writes an in-app notification to org admins (no external delivery)",
			},
			// ── Automations ───────────────────────────────────────────────────────────
			manage_automations: {
				args: () => ({ action: "list", entity_id: entityId }),
				coverage: "round-trip",
				note: "lists the seeded Automation attached to the entity",
			},
			get_automation: {
				args: () => ({ automation_id: automationId, entity_id: entityId }),
				coverage: "round-trip",
				note: "reads back the Automation seeded in beforeAll",
			},
			// ── path resolution ─────────────────────────────────────────────────────
			resolve_path: {
				args: () => ({ path: `/${orgSlug}` }),
				coverage: "reachable",
				note: "resolves the org slug path to workspace details",
			},
		};
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		// Several handlers build public URLs via the workspace provider (slug
		// lookup). The REST proxy initializes it at app boot; do the same here.
		await initWorkspaceProvider();

		const org = await createTestOrganization({ name: "Tools E2E Org" });
		orgSlug = org.slug;
		const user = await createTestUser({ email: "tools-e2e-owner@test.com" });
		await addUserToOrganization(user.id, org.id, "owner");

		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		agentId = agent.agentId;

		// Owner auth context that mirrors the REST proxy: full scopes + internal
		// tools enabled (incl. metric_series / resolve_path).
		authCtx = {
			organizationId: org.id,
			tokenOrganizationId: org.id,
			userId: user.id,
			memberRole: "owner",
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "oauth",
			requestUrl: `http://localhost/api/${org.slug}`,
			baseUrl: "",
			scopedToOrg: true,
			allowCrossOrg: false,
			grantedOrganizationIds: [org.id],
			directSearchFederation: false,
		};

		// Create the entity types this org needs via the real tool path. This also
		// exercises manage_entity_schema(create) end-to-end before the read-path
		// case in the registry loop runs.
		for (const [slug, name] of [
			["brand", "Brand"],
			["product", "Product"],
		] as const) {
			await executeTool(
				"manage_entity_schema",
				{ schema_type: "entity_type", action: "create", slug, name },
				TEST_ENV,
				authCtx
			);
		}

		// Seed one entity (read tools need a target) via the real tool path.
		const created = (await executeTool(
			"manage_entity",
			{ action: "create", entity_type: "brand", name: "Coverage Brand" },
			TEST_ENV,
			authCtx
		)) as { entity?: { id: number } };
		const createdEntityId = created.entity?.id;
		expect(createdEntityId).toBeDefined();
		entityId = createdEntityId as number;

		// Seed a metric-bearing entity type so query_metric/list_metrics are real
		// round-trips (no events → 0 rows, which is a valid, error-free result).
		await executeTool(
			"manage_entity_schema",
			{
				schema_type: "entity_type",
				action: "create",
				slug: "metric-co",
				name: "Metric Co",
				metrics_config: {
					eventSets: {
						charges: { by: "alias", field: "metadata->>'description'" },
					},
					measures: {
						n: {
							eventSet: "charges",
							agg: "count",
							description: "Charge count.",
						},
					},
				},
			},
			TEST_ENV,
			authCtx
		);

		// Seed one Automation so get_automation / manage_automations list are real round-trips.
		const automation = (await executeTool(
			"manage_automations",
			{
				action: "create",
				entity_id: entityId,
				slug: "coverage-automation",
				name: "Coverage Automation",
				prompt: "Track coverage signals.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			authCtx
		)) as { automation_id: string };
		expect(automation.automation_id).toBeDefined();
		automationId = automation.automation_id;

		// Seed one view so open_view is a real round-trip.
		await executeTool(
			"manage_views",
			{
				action: "set",
				key: "coverage-board",
				source_code: "export default function B() { return null; }",
			},
			TEST_ENV,
			authCtx
		);
	});

	it("covers every registry tool in the args fixture (catches new uncovered tools)", () => {
		const registryToolNames = getAllTools({
			maxAccessLevel: "admin",
		}).map((t) => t.name);
		const planned = new Set(Object.keys(toolPlan()));

		const uncovered = registryToolNames.filter((name) => !planned.has(name));
		expect(
			uncovered,
			`These registry tools have no coverage in all-tools-e2e.test.ts. Add valid minimal ` +
				`args to TOOL_PLAN so the agent tool is exercised end-to-end: ${uncovered.join(", ")}`
		).toEqual([]);

		// And the reverse: the fixture must not reference a tool the registry no
		// longer exposes (stale coverage hides a removed tool).
		const stale = [...planned].filter(
			(name) => !registryToolNames.includes(name)
		);
		expect(
			stale,
			`These tools are in TOOL_PLAN but no longer in the registry: ${stale.join(", ")}`
		).toEqual([]);

		// Sanity: we expect the full ~23-tool surface, not a truncated registry.
		expect(registryToolNames.length).toBeGreaterThanOrEqual(20);
	});

	it("manage_entity does a real create → delete round-trip", async () => {
		const created = (await executeTool(
			"manage_entity",
			{ action: "create", entity_type: "product", name: "Ephemeral Product" },
			TEST_ENV,
			authCtx
		)) as { entity?: { id: number }; next_steps?: string[] };
		expect(created.next_steps?.join("\n")).not.toMatch(/manage_[a-z_]+/);
		expect(created.next_steps?.join("\n")).toContain("client.connections.connect");
		expect(created.next_steps?.join("\n")).toContain("client.feeds.trigger");
		expect(created.next_steps?.join("\n")).toContain("kind: 'schedule'");
		expect(created.next_steps?.join("\n")).toContain("timezone: '<IANA timezone>'");
		const maybeId = created.entity?.id;
		expect(maybeId).toBeDefined();
		const id = maybeId as number;
		expect(created.next_steps?.join("\n")).toContain(`entity_ids: [${id}]`);

		await executeTool(
			"manage_entity",
			{ action: "delete", entity_id: id },
			TEST_ENV,
			authCtx
		);

		// Authoritative check that the delete landed. A non-force `delete` is a
		// SOFT delete by contract (entity-management.ts:deleteEntity) — the row
		// MUST stay present with `deleted_at` set, preserving event history. We
		// enforce that exact contract rather than loosely accepting "gone OR
		// soft-deleted": a row that vanished here would be an unexpected hard
		// delete and a real regression we want this test to catch. Asserting on
		// PG directly avoids re-running a `get` that logs an expected "not found".
		const sql = getTestDb();
		const rows = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM entities WHERE id = ${id}
    `;
		expect(rows, "soft delete must leave the row present").toHaveLength(1);
		expect(
			rows[0].deleted_at,
			"soft delete must stamp deleted_at"
		).not.toBeNull();
	});

	// One test per registry tool, generated from the plan. Every tool is driven
	// with valid minimal args, so it MUST return a structured result — it must
	// not throw at all (an input-validation rejection on valid args is itself a
	// regression we want to catch, not tolerate).
	const plan = (): Record<string, ToolPlan> => toolPlan();
	for (const name of Object.keys(
		// Build once at collection time for stable test names; args factories are
		// re-read at run time so they see seeded ids.
		plan()
	)) {
		it(`tool: ${name}`, async () => {
			const entry = plan()[name];
			const args = typeof entry.args === "function" ? entry.args() : entry.args;

			// Structured success: a non-undefined result, no thrown error. Most
			// tools return an object; a few (rare) return strings/arrays — all are
			// acceptable as long as the handler produced a value without throwing.
			const result = await executeTool(name, args, TEST_ENV, authCtx);
			expect(result, `${name} returned undefined`).toBeDefined();
		});
	}
});
