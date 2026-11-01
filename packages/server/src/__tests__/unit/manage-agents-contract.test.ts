/**
 * `manage_agents` is a union of per-action variants, so the schema — not the
 * handler — decides what each action requires and accepts. These pin what the
 * flat contract could not express: `agent_id` and `name` are required where
 * they matter rather than checked by hand, a field that belongs to another
 * action is an error on this one instead of a silent no-op (the flat object
 * accepted `name` on `delete`), the editable-field annotation the field engine
 * loops over survives the move onto per-variant `Type.Optional` properties,
 * and the registry's per-action access filtering — which only ever applied to
 * union variants — now keeps owner-admin writes out of a read-scope client's
 * listing.
 */
import { describe, expect, it } from "bun:test";
import { collectLobuFields } from "@lobu/core/contracts/field-engine";
import {
	CreateAgentAction,
	ManageAgentsSchema,
	UpdateAgentAction,
} from "@lobu/core/contracts/tools/manage-agents";
import { getAllTools } from "../../tools/registry";
import { validateToolArgs } from "../../tools/validate-args";
import { ToolUserError } from "../../utils/errors";

const validate = (args: unknown) =>
	validateToolArgs("manage_agents", ManageAgentsSchema, args);

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(ToolUserError);
		return (err as ToolUserError).message;
	}
	throw new Error("expected validation to throw");
}

describe("manage_agents union contract", () => {
	it("requires agent_id for get/update/delete and name for create, at the schema", () => {
		for (const action of ["get", "update", "delete"]) {
			expect(messageOf(() => validate({ action }))).toMatch(/agent_id/);
		}
		expect(messageOf(() => validate({ action: "create", agent_id: "researcher" }))).toMatch(
			/name/,
		);
	});

	it("rejects a field another action takes instead of ignoring it", () => {
		const list = messageOf(() => validate({ action: "list", agent_id: "researcher" }));
		expect(list).toMatch(/unknown argument\(s\): agent_id/);
		expect(list).toMatch(/valid arguments for action 'list' are: action$/);

		const del = messageOf(() =>
			validate({ action: "delete", agent_id: "researcher", expected_revision: "original-agent-revision", name: "Researcher" }),
		);
		expect(del).toMatch(/unknown argument\(s\): name/);
		expect(del).toMatch(/valid arguments for action 'delete' are: action, agent_id, expected_revision$/);
	});

	it("accepts each action's full field set", () => {
		expect(validate({ action: "list" })).toEqual({ action: "list" });
		expect(validate({ action: "get", agent_id: "researcher" })).toEqual({
			action: "get",
			agent_id: "researcher",
		});
		expect(
			validate({
				action: "create",
				agent_id: "researcher",
				name: "Researcher",
				description: "Digs",
				identity_md: "# You research",
				default_model: "anthropic/claude-sonnet-5",
			}),
		).toMatchObject({ name: "Researcher", default_model: "anthropic/claude-sonnet-5" });
		expect(
			validate({ action: "update", agent_id: "researcher", expected_revision: "original-agent-revision", default_model: "" }),
		).toEqual({ action: "update", agent_id: "researcher", expected_revision: "original-agent-revision", default_model: "" });
		expect(validate({ action: "delete", agent_id: "researcher", expected_revision: "original-agent-revision" })).toEqual({
			action: "delete",
			agent_id: "researcher",
			expected_revision: "original-agent-revision",
		});
	});

	it("keeps the x-lobu-field annotation on both write variants", () => {
		const editable = ["name", "description", "identity_md", "default_model"];
		expect(collectLobuFields(UpdateAgentAction).map((f) => f.key)).toEqual(editable);
		expect(collectLobuFields(CreateAgentAction).map((f) => f.key)).toEqual(editable);
		expect(collectLobuFields(UpdateAgentAction).map((f) => f.meta)).toEqual([
			{ store: "column" },
			{ store: "column" },
			{ store: "column" },
			{ store: "model", emptyClears: true },
		]);
	});
});

/**
 * What an MCP client actually sees: the union is flattened to one object
 * (hosts reject a top-level `anyOf`), so per-action requirements survive only
 * as prose on the `action` enum.
 */
describe("manage_agents wire schema", () => {
	const listedFor = (maxAccessLevel: "read" | "admin") =>
		getAllTools({ publicOnly: false, maxAccessLevel }).find(
			(tool) => tool.name === "manage_agents",
		);

	it("hides owner-admin writes from a read-scope listing", () => {
		expect(listedFor("read")?.inputSchema.properties.action.enum).toEqual(["list", "get"]);
		expect(listedFor("admin")?.inputSchema.properties.action.enum).toEqual([
			"list",
			"get",
			"create",
			"update",
			"delete",
		]);
	});

	it("names each action's required fields on the flattened enum", () => {
		const description: string =
			listedFor("admin")?.inputSchema.properties.action.description ?? "";
		const lineFor = (action: string) =>
			description.split("\n").find((line) => line.startsWith(`- ${action}:`));
		expect(lineFor("list")).not.toContain("Required:");
		expect(lineFor("get")).toContain("Required: agent_id.");
		expect(lineFor("create")).toContain("Required: agent_id, name.");
		expect(lineFor("update")).toContain("Required: agent_id.");
		expect(lineFor("delete")).toContain("Required: agent_id.");
	});
});
