import { describe, expect, it } from "bun:test";
import type { ToolContext } from "../../../tools/registry";
import { isSdkOnlyDiscoveryQuery, sdkSearch } from "../../../tools/sdk_search";

const stubEnv = {} as never;

const readCtx: ToolContext = {
	organizationId: "org",
	userId: "user",
	memberRole: "member",
	isAuthenticated: true,
	tokenType: "oauth",
	scopes: ["mcp:read"],
	scopedToOrg: true,
	allowCrossOrg: false,
};

const writeCtx: ToolContext = {
	...readCtx,
	scopes: ["mcp:read", "mcp:write"],
};

const ownerWriteCtx: ToolContext = {
	...writeCtx,
	memberRole: "owner",
};

const adminCtx: ToolContext = {
	...readCtx,
	memberRole: "owner",
	scopes: ["mcp:read", "mcp:write", "mcp:admin"],
};

describe("sdkSearch", () => {
	it.each([
		"agents",
		"entitySchema",
		"AUTHprofiles",
		"client.feeds",
		"feeds.create",
	])("treats exact SDK query %s as method-only discovery", (query) => {
		expect(isSdkOnlyDiscoveryQuery(query)).toBe(true);
	});

	it.each([
		"google.calendar",
		"website",
		"connections sync run",
	])("still allows connector discovery for %s", (query) => {
		expect(isSdkOnlyDiscoveryQuery(query)).toBe(false);
	});

	it("returns drill-down for an exact path", async () => {
		const result = await sdkSearch(
			{ query: "automations.list" },
			stubEnv,
			readCtx,
		);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("automations.list");
		expect(result.results[0]).toContain("access:");
	});

	it("returns independent drill-downs for whitespace-separated method paths", async () => {
		const result = await sdkSearch(
			{ query: "entities.get entities.create entities.link" },
			stubEnv,
			writeCtx,
		);

		expect(result.match_count).toBe(3);
		expect(result.results).toHaveLength(3);
		for (const path of ["entities.get", "entities.create", "entities.link"]) {
			const rendered = result.results.find((entry) => entry.startsWith(path));
			expect(rendered).toContain("access:");
			expect(rendered).toContain("example:");
		}
	});

	it("keeps exact and partial terms independent in one query", async () => {
		const result = await sdkSearch(
			{ query: "entities.get operations.execu" },
			stubEnv,
			writeCtx,
		);

		expect(result.match_count).toBe(2);
		expect(result.results[0]).toContain("entities.get\n");
		expect(result.results[0]).toContain("access:");
		expect(result.results[1]).toStartWith("operations.execute —");
	});

	it("discovers top-level methods with the client prefix callers use", async () => {
		const result = await sdkSearch({ query: "client.org" }, stubEnv, readCtx);

		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("org");
		expect(result.results[0]).toContain("client.org('acme')");
	});

	it.each([
		[
			"operations.execute",
			"client.operations.execute({ connection_id: 42, operation_key: 'create_issue'",
		],
		[
			"entitySchema.listRules",
			"client.entitySchema.listRules({ slug: 'works-at' })",
		],
		[
			"entitySchema.deleteType",
			"client.entitySchema.deleteType({ slug: 'widget' })",
		],
		[
			"entitySchema.deleteRelType",
			"client.entitySchema.deleteRelType({ slug: 'works-at' })",
		],
		["feeds.trigger", "client.feeds.trigger({ feed_id: 42 })"],
		["feeds.delete", "client.feeds.delete({ feed_id: 42 })"],
		["classifiers.delete", "client.classifiers.delete({ classifier_id: 42 })"],
		["schedules.cancel", "client.schedules.cancel({ id: 'schedule-id' })"],
		["automations.get", "client.automations.get({ automation_id: '42' })"],
		[
			"automations.trigger",
			"client.automations.trigger({ automation_id: '42' })",
		],
		[
			"automations.delete",
			"client.automations.delete({ automation_ids: ['42'] })",
		],
	])("renders the current %s signature in exact drill-down", async (path, snippet) => {
		const result = await sdkSearch({ query: path }, stubEnv, adminCtx);

		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("example:");
		expect(result.results[0]).toContain(snippet);
	});

	it("documents the bounded ctx.sleep polling helper", async () => {
		const result = await sdkSearch(
			{ query: "ctx.sleep", mode: "read" },
			stubEnv,
			readCtx,
		);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("ctx.sleep");
		expect(result.results[0]).toContain("30000");
		expect(result.results[0]).toContain("await ctx.sleep");
	});

	it("returns namespace listing for a top-level namespace at write tier", async () => {
		const result = await sdkSearch({ query: "automations" }, stubEnv, writeCtx);
		expect(result.match_count).toBeGreaterThan(2);
		const joined = result.results.join("\n");
		expect(joined).toContain("automations.list");
		expect(joined).toContain("automations.create");
	});

	it("read mode hides write methods from namespace listing", async () => {
		const result = await sdkSearch(
			{ query: "automations", mode: "read" },
			stubEnv,
			writeCtx,
		);
		const joined = result.results.join("\n");
		expect(joined).toContain("automations.list");
		expect(joined).not.toContain("automations.create");
		expect(result.notes).toContain("query_sdk-safe");
	});

	it("hides admin methods from write-tier callers", async () => {
		// agents.delete stays admin (a mutation); a write-tier caller must
		// not see it. (agents.list/get are now `read` and intentionally visible —
		// see the read-mode test below.)
		const result = await sdkSearch(
			{ query: "agents.delete" },
			stubEnv,
			writeCtx,
		);
		expect(result.match_count).toBe(0);
		expect(result.notes).toMatch(/ask a workspace owner\/admin/i);
		expect(result.notes).toMatch(/cannot elevate/i);
	});

	it("shows personal account connection setup at write tier", async () => {
		const result = await sdkSearch(
			{ query: "connections.connect" },
			stubEnv,
			ownerWriteCtx,
		);

		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("connections.connect");
		expect(result.results[0]).toContain("access: operate (mcp:write)");
	});

	it("keeps exact read-mode misses caller-aware", async () => {
		const owner = await sdkSearch(
			{ query: "connections.connect", mode: "read" },
			stubEnv,
			ownerWriteCtx,
		);
		expect(owner.notes).toMatch(/requires run_sdk/i);
		expect(owner.notes).not.toMatch(/progressively authorizable|OAuth challenge/i);
		expect(owner.notes).toContain("mcp:write");

		const member = await sdkSearch(
			{ query: "connections.connect", mode: "read" },
			stubEnv,
			writeCtx,
		);
		expect(member.notes).toMatch(/requires run_sdk/i);
		expect(member.notes).not.toMatch(/ask a workspace owner\/admin/i);
	});

	it("keeps hidden admin namespaces role-aware without suggesting run_sdk", async () => {
		const member = await sdkSearch({ query: "schedules" }, stubEnv, writeCtx);
		expect(member.match_count).toBe(0);
		expect(member.notes).toMatch(/ask a workspace owner\/admin/i);
		expect(member.notes).not.toMatch(/call via run_sdk/i);

		const owner = await sdkSearch(
			{ query: "schedules" },
			stubEnv,
			ownerWriteCtx,
		);
		expect(owner.match_count).toBeGreaterThan(0);
		expect(owner.results.join("\n")).toContain("schedules.list");
	});

	it("shows progressively authorizable admin methods to an owner at write tier", async () => {
		const result = await sdkSearch(
			{ query: "agents.delete" },
			stubEnv,
			ownerWriteCtx,
		);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("agents.delete");
		expect(result.results[0]).toContain("access: administer");
	});

	it("shows the reclassified org-read agent lists in read mode", async () => {
		// agents.list/get were mistagged admin, so query_sdk read mode dropped the
		// whole `agents` namespace → opaque "Cannot read properties of undefined".
		// They are org-read-gated at runtime, so read mode must surface them.
		const result = await sdkSearch(
			{ query: "agents", mode: "read" },
			stubEnv,
			readCtx,
		);
		const joined = result.results.join("\n");
		expect(joined).toContain("agents.list");
		expect(joined).toContain("agents.get");
		// The mutating siblings stay hidden in read mode.
		expect(joined).not.toContain("agents.create");
		expect(joined).not.toContain("agents.delete");
	});

	it("lists a camelCase namespace from a lowercased query without a false hidden note", async () => {
		// The hidden-namespace hint must never fire when the namespace's methods
		// ARE visible — 'entityschema' matches entitySchema.* case-insensitively.
		const result = await sdkSearch(
			{ query: "entityschema" },
			stubEnv,
			writeCtx,
		);
		expect(result.match_count).toBeGreaterThan(0);
		const joined = result.results.join("\n");
		expect(joined).toContain("entitySchema.listTypes");
		expect(result.notes ?? "").not.toContain("none are visible");
	});

	it("discovers notifications.list in read mode and guides mutation elevation", async () => {
		const listed = await sdkSearch(
			{ query: "notifications", mode: "read" },
			stubEnv,
			readCtx,
		);
		expect(listed.match_count).toBeGreaterThan(0);
		const joined = listed.results.join("\n");
		expect(joined).toContain("notifications.list");
		expect(joined).not.toContain("notifications.markRead");
		expect(joined).not.toContain("notifications.send");

		const markRead = await sdkSearch(
			{ query: "notifications.markRead", mode: "read" },
			stubEnv,
			readCtx,
		);
		expect(markRead.match_count).toBe(0);
		expect(markRead.notes ?? "").toContain("operate access (mcp:write)");
		expect(markRead.notes ?? "").toMatch(/reconnect|reauthorize/i);
		expect(markRead.notes ?? "").not.toMatch(/call via run_sdk/i);
	});

	it("shows admin methods to admin-tier callers", async () => {
		const result = await sdkSearch({ query: "agents.list" }, stubEnv, adminCtx);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("agents.list");
	});

	it("renders public access tiers with their matching MCP scopes", async () => {
		const operate = await sdkSearch(
			{ query: "operations.execute" },
			stubEnv,
			writeCtx,
		);
		expect(operate.results[0]).toContain("access: operate (mcp:write)");

		const administer = await sdkSearch(
			{ query: "agents.delete" },
			stubEnv,
			adminCtx,
		);
		expect(administer.results[0]).toContain(
			"access: administer (workspace owner/admin + mcp:admin)",
		);
	});

	it("substring-matches across paths and summaries", async () => {
		// "run-result" appears in automations.create's summary, not its path.
		// automations.create is admin-tier (matches manage_automations.create being
		// owner-admin), so only an admin-tier caller discovers it.
		const result = await sdkSearch({ query: "run-result" }, stubEnv, adminCtx);
		expect(result.match_count).toBeGreaterThan(0);
	});

	it("preserves phrase matching for free-text queries", async () => {
		const result = await sdkSearch(
			{ query: "connector action" },
			stubEnv,
			writeCtx,
		);

		// Phrase match on the method summary must still surface operations.execute.
		// When DATABASE_URL is available, live-connector hits may also match the
		// free-text query and prepend — so don't require match_count === 1.
		const methodHit = result.results.find((line) =>
			line.startsWith("operations.execute —"),
		);
		expect(methodHit).toBeDefined();
		expect(methodHit).toContain("Execute a connector action");
	});

	it("recovers useful methods from natural multi-word queries", async () => {
		const result = await sdkSearch(
			{ query: "connections sync run", mode: "read" },
			stubEnv,
			readCtx,
		);

		expect(result.match_count).toBeGreaterThan(0);
		expect(
			result.results.some((line) => line.startsWith("operations.listRuns —")),
		).toBe(true);
	});

	it("returns empty + helpful note for unknown queries", async () => {
		const result = await sdkSearch(
			{ query: "definitelyNotAMethod" },
			stubEnv,
			readCtx,
		);
		expect(result.match_count).toBe(0);
		expect(result.notes).toBeDefined();
	});

	it("respects the limit parameter", async () => {
		const result = await sdkSearch(
			{ query: "automations", limit: 2 },
			stubEnv,
			writeCtx,
		);
		expect(result.results.length).toBeLessThanOrEqual(2);
		expect(result.notes).toContain("more matches");
	});

	it("shows exact list signatures instead of implying uniform pagination", async () => {
		const paginated = await sdkSearch(
			{ query: "entities.list" },
			stubEnv,
			readCtx,
		);
		expect(paginated.results[0]).toContain("limit?: number");

		const unpaginated = await sdkSearch(
			{ query: "metrics.list" },
			stubEnv,
			readCtx,
		);
		expect(unpaginated.results[0]).toContain("not paginated");
	});

	it("shows object signatures for id-targeted methods", async () => {
		for (const path of [
			"entities.get",
			"feeds.get",
			"feeds.trigger",
			"classifiers.delete",
			"schedules.cancel",
			"automations.get",
			"automations.trigger",
		]) {
			const result = await sdkSearch({ query: path }, stubEnv, adminCtx);
			expect(result.match_count, path).toBe(1);
			expect(result.results[0], path).toContain("client.");
			expect(result.results[0], path).toMatch(/\(\{/);
		}
	});

	it("documents the external Automation trigger completion handoff", async () => {
		const result = await sdkSearch(
			{ query: "automations.trigger" },
			stubEnv,
			adminCtx,
		);
		const rendered = result.results[0];

		expect(rendered).toContain("Promise<AutomationTriggerResult>");
		expect(rendered).toContain("external_client");
		expect(rendered).toContain("created is false");
		expect(rendered).toContain("resume_claim");
		expect(rendered).toContain("another_caller");
		expect(rendered).toContain("client.automations.claimNextWindow");
		expect(rendered).toContain("run.execution.next_action.read.input");
		expect(rendered).toContain("client.automations.completeWindow");
	});

	it.each([
		["feeds.get", ["feed_id: number", "without querying its source"]],
		["feeds.readMany", ["reads: Array", "cursor?: string"]],
		[
			"feeds.create",
			[
				"entity_ids?: number[]",
				"timezone?: string",
				"connector-declared operations",
				"has no cron unless `schedule` is set",
				"feeds.trigger",
			],
		],
		[
			"feeds.update",
			[
				"replace_config?: boolean",
				"schedule?: string | null",
				"timezone?: string | null",
			],
		],
	])("documents the complete public %s contract", async (path, fields) => {
		const result = await sdkSearch({ query: path }, stubEnv, adminCtx);
		expect(result.match_count).toBe(1);
		for (const field of fields) {
			expect(result.results[0], path).toContain(field);
		}
	});

	it.each([
		[
			"operations.getRun",
			"operations.getRun(run_id: number)",
			"client.operations.getRun(123)",
		],
		[
			"connections.reauthenticate",
			"connections.reauthenticate(connection_id: number, options?: { requested_scopes?: string[] })",
			"client.connections.reauthenticate(42)",
		],
		[
			"authProfiles.get",
			"authProfiles.get(auth_profile_slug: string)",
			"client.authProfiles.get('google-calendar-account')",
		],
		["authProfiles.update", "reconnect?: boolean", "reconnect: true"],
		[
			"agents.get",
			"agents.get(agent_id: string)",
			"client.agents.get('builder')",
		],
		[
			"entitySchema.getType",
			"entitySchema.getType(slug: string)",
			"client.entitySchema.getType('company')",
		],
		[
			"automations.getVersions",
			"automations.getVersions(automation_id: string)",
			"client.automations.getVersions('42')",
		],
	])("documents the exact %s call shape", async (path, signature, example) => {
		const result = await sdkSearch({ query: path }, stubEnv, adminCtx);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain(signature);
		expect(result.results[0]).toContain(example);
	});

	it("renders accepted aliases from the runtime alias registry (one source)", async () => {
		const entitiesGet = await sdkSearch(
			{ query: "entities.get" },
			stubEnv,
			readCtx,
		);
		expect(entitiesGet.results[0]).toContain(
			"accepted aliases: id → entity_id",
		);
		const send = await sdkSearch(
			{ query: "notifications.send" },
			stubEnv,
			writeCtx,
		);
		expect(send.results[0]).toContain("accepted aliases: message → body");
	});

	it("discovers the complete question contract for notifications.send", async () => {
		const result = await sdkSearch(
			{ query: "notifications.send" },
			stubEnv,
			writeCtx,
		);

		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("input_schema?: object");
		expect(result.results[0]).toContain("run_id?: number");
		expect(result.results[0]).toContain("operations.getRun");
	});

	it("advertises authProfiles.get to a read-tier caller", async () => {
		const result = await sdkSearch(
			{ query: "authProfiles.get", mode: "read" },
			stubEnv,
			readCtx,
		);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("authProfiles.get");
	});
	// A miss that filtered NOTHING must not be explained as an access problem —
	// that sends the caller after elevation when the fix is rephrasing. The
	// `client.` prefix keeps this on the SDK-only path so connector discovery
	// (which needs a live env) stays out of this unit test.
	it("blames wording, not access tier, when nothing was hidden", async () => {
		const result = await sdkSearch(
			{ query: "client.zzznosuchmethod" },
			stubEnv,
			adminCtx,
		);

		expect(result.match_count).toBe(0);
		expect(result.notes).toContain("No method or runtime-helper name matches");
		expect(result.notes).not.toContain("No matches at your access tier");
		// An admin in mode='full' has nothing left to widen to.
		expect(result.notes).not.toContain("mode='full'");
	});

	it("points a read-mode miss at mode='full', never back at mode='read'", async () => {
		const result = await sdkSearch(
			{ query: "client.zzznosuchmethod", mode: "read" },
			stubEnv,
			readCtx,
		);

		expect(result.match_count).toBe(0);
		expect(result.notes).toContain("pass mode='full'");
		expect(result.notes).not.toContain("mode='read' for query_sdk");
	});
});
