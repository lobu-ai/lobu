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
	it("discovers activity polling for a read-only MCP client", async () => {
		const result = await sdkSearch({ query: "operations.listActivity" }, stubEnv, readCtx);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("automation_due");
	});
	it.each(["@lobu/views", "@lobu/views/components", "  @LOBU/VIEWS/COMPONENTS  "])(
		"discovers the view authoring contract from %s",
		async (query) => {
			const result = await sdkSearch({ query }, stubEnv, adminCtx);
			expect(result.query).toBe(query.trim());
			expect(result.match_count).toBe(1);
			expect(result.results[0]).toStartWith("views.set\n");
			expect(result.results[0]).toContain("@lobu/views/components");
			expect(result.results[0]).toContain("example:");
		},
	);

	it("discovers the component kit by a component name", async () => {
		const result = await sdkSearch({ query: "DataTable" }, stubEnv, adminCtx);
		const view = result.results.find((entry) => entry.startsWith("views.set"));
		expect(view).toContain("@lobu/views/components");
	});

	it("includes the component kit in direct view authoring discovery", async () => {
		const result = await sdkSearch({ query: "views.set" }, stubEnv, adminCtx);
		expect(result.results[0]).toContain("@lobu/views/components");
		expect(result.results[0]).toContain("DataTable");
	});

	it("keeps package discovery subject to read mode and caller permissions", async () => {
		const read = await sdkSearch(
			{ query: "@lobu/views/components", mode: "read" },
			stubEnv,
			adminCtx,
		);
		expect(read.results).toEqual([]);
		expect(read.notes).toContain("views.set");
		expect(read.notes).toContain("requires run_sdk");

		const member = await sdkSearch(
			{ query: "@lobu/views/components" },
			stubEnv,
			writeCtx,
		);
		expect(member.results).toEqual([]);
		expect(member.notes).toContain("views.set");
		expect(member.notes).toMatch(/owner/i);

		const owner = await sdkSearch(
			{ query: "@lobu/views/components", limit: 1 },
			stubEnv,
			ownerWriteCtx,
		);
		expect(owner.results).toHaveLength(1);
		expect(owner.results[0]).toStartWith("views.set\n");
	});

	it.each([
		"agents",
		"entitySchema",
		"AUTHprofiles",
		"client.feeds",
		"feeds.create",
		"@lobu/views",
		"@lobu/views/components",
	])("treats exact SDK query %s as method-only discovery", (query) => {
		expect(isSdkOnlyDiscoveryQuery(query)).toBe(true);
	});

	it.each([
		"google.calendar",
		"website",
		"connections sync run",
		"@acme/widgets",
		"@lobu/views/unknown",
	])("still allows connector discovery for %s", (query) => {
		expect(isSdkOnlyDiscoveryQuery(query)).toBe(false);
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

	it("read mode hides write methods from namespace listing", async () => {
		const result = await sdkSearch(
			{ query: "automations", mode: "read" },
			stubEnv,
			writeCtx,
		);
		const joined = result.results.join("\n");
		expect(joined).toContain("automations.list");
		expect(joined).not.toContain("automations.create");
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

	it("keeps hidden admin namespaces role-aware", async () => {
		const member = await sdkSearch({ query: "schedules" }, stubEnv, writeCtx);
		expect(member.match_count).toBe(0);

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

	it("discovers notifications.list in read mode and hides its mutations", async () => {
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
	});

	it("shows admin methods to admin-tier callers", async () => {
		const result = await sdkSearch({ query: "agents.list" }, stubEnv, adminCtx);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("agents.list");
	});

	it("respects the limit parameter", async () => {
		const result = await sdkSearch(
			{ query: "automations", limit: 2 },
			stubEnv,
			writeCtx,
		);
		expect(result.results.length).toBeLessThanOrEqual(2);
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
});
