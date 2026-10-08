import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { Type } from "@sinclair/typebox";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import { withValidatedArgs } from "../../../tools/validate-args";

const calls: Array<{ action: string; input?: Record<string, unknown> }> = [];
const automationGets: Array<Record<string, unknown>> = [];

const captureAction = withValidatedArgs(
	"capture_action",
	Type.Object({}, { additionalProperties: true }),
	async (input: Record<string, unknown>) => {
		const { action, ...rest } = input;
		calls.push({ action: String(action), input: rest });
		return input;
	},
);

mock.module("../../../tools/admin/manage_entity", () => ({
	manageEntity: captureAction,
}));
mock.module("../../../tools/admin/manage_feeds", () => ({
	manageFeeds: captureAction,
}));
mock.module("../../../tools/admin/manage_classifiers", () => ({
	manageClassifiers: captureAction,
}));
mock.module("../../../tools/admin/manage_schedules", () => ({
	manageSchedules: captureAction,
}));
mock.module("../../../tools/admin/manage_entity_schema", () => ({
	manageEntitySchema: captureAction,
}));
mock.module("../../../tools/admin/manage_connections", () => ({
	manageConnections: captureAction,
}));
mock.module("../../../tools/admin/manage_auth_profiles", () => ({
	manageAuthProfiles: captureAction,
}));
mock.module("../../../tools/admin/manage_agents", () => ({
	manageAgents: captureAction,
}));
mock.module("../../../tools/admin/manage_operations", () => ({
	manageOperations: captureAction,
}));
mock.module("../../../tools/admin/notify", () => ({
	notify: captureAction,
}));

mock.module("../../../tools/get_automation", () => ({
	getAutomation: async (input: Record<string, unknown>) => {
		automationGets.push(input);
		return input;
	},
}));

mock.module("../../../tools/admin/manage_automations", () => ({
	manageAutomations: captureAction,
}));

const ctx = {} as ToolContext;
const env = {} as Env;

describe("ClientSDK object signature contract", () => {
	let builders: {
		entities: typeof import("../../../sandbox/namespaces/entities").buildEntitiesNamespace;
		feeds: typeof import("../../../sandbox/namespaces/feeds").buildFeedsNamespace;
		classifiers: typeof import("../../../sandbox/namespaces/classifiers").buildClassifiersNamespace;
		schedules: typeof import("../../../sandbox/namespaces/schedules").buildSchedulesNamespace;
		automations: typeof import("../../../sandbox/namespaces/automations").buildAutomationsNamespace;
		entitySchema: typeof import("../../../sandbox/namespaces/entity-schema").buildEntitySchemaNamespace;
		connections: typeof import("../../../sandbox/namespaces/connections").buildConnectionsNamespace;
		authProfiles: typeof import("../../../sandbox/namespaces/auth-profiles").buildAuthProfilesNamespace;
		agents: typeof import("../../../sandbox/namespaces/agents").buildAgentsNamespace;
		operations: typeof import("../../../sandbox/namespaces/operations").buildOperationsNamespace;
		notifications: typeof import("../../../sandbox/namespaces/notifications").buildNotificationsNamespace;
	};

	beforeAll(async () => {
		const [
			entities,
			feeds,
			classifiers,
			schedules,
			automations,
			entitySchema,
			connections,
			authProfiles,
			agents,
			operations,
			notifications,
		] = await Promise.all([
			import("../../../sandbox/namespaces/entities"),
			import("../../../sandbox/namespaces/feeds"),
			import("../../../sandbox/namespaces/classifiers"),
			import("../../../sandbox/namespaces/schedules"),
			import("../../../sandbox/namespaces/automations"),
			import("../../../sandbox/namespaces/entity-schema"),
			import("../../../sandbox/namespaces/connections"),
			import("../../../sandbox/namespaces/auth-profiles"),
			import("../../../sandbox/namespaces/agents"),
			import("../../../sandbox/namespaces/operations"),
			import("../../../sandbox/namespaces/notifications"),
		]);
		builders = {
			entities: entities.buildEntitiesNamespace,
			feeds: feeds.buildFeedsNamespace,
			classifiers: classifiers.buildClassifiersNamespace,
			schedules: schedules.buildSchedulesNamespace,
			automations: automations.buildAutomationsNamespace,
			entitySchema: entitySchema.buildEntitySchemaNamespace,
			connections: connections.buildConnectionsNamespace,
			authProfiles: authProfiles.buildAuthProfilesNamespace,
			agents: agents.buildAgentsNamespace,
			operations: operations.buildOperationsNamespace,
			notifications: notifications.buildNotificationsNamespace,
		};
	});

	beforeEach(() => {
		calls.length = 0;
		automationGets.length = 0;
	});

	it("exposes exactly the ten named entity methods", () => {
		expect(Object.keys(builders.entities(ctx, env)).sort()).toEqual([
			"create", "delete", "discoverDuplicates", "get", "link", "list",
			"listLinks", "unlink", "update", "updateLink",
		]);
	});

	it("forwards named id objects instead of treating them as positional ids", async () => {
		const entities = builders.entities(ctx, env);
		const feeds = builders.feeds(ctx, env);
		const classifiers = builders.classifiers(ctx, env);
		const schedules = builders.schedules(ctx, env);
		const automations = builders.automations(ctx, env);
		type ClaimResult = Awaited<ReturnType<typeof automations.claimNextWindow>>;
		const assertTypedClaim = (claim: ClaimResult) => {
			const windowToken: string = claim.context.window_token;
			const nextCursor: { occurred_at: string; id: number } | undefined =
				claim.context.page.next_cursor;
			return { windowToken, nextCursor };
		};
		void assertTypedClaim;
		const entitySchema = builders.entitySchema(ctx, env);

		await entities.get({ entity_id: 11 });
		await entities.delete({ entity_id: 12, force_delete_tree: true });
		await feeds.get({ feed_id: 21 });
		await feeds.trigger({ feed_id: 22 });
		await feeds.delete({ feed_id: 23 });
		await classifiers.delete({ classifier_id: 31 });
		await schedules.cancel({ id: "schedule-41" });
		await automations.get({ automation_id: "51" });
		await automations.claimNextWindow({ automation_id: "51", lease_seconds: 300 });
		await automations.trigger({ automation_id: "52" });
		await automations.delete({ automation_ids: ["53", "54"] });
		await entitySchema.deleteType({ slug: "company" });
		await entitySchema.deleteRelType({ slug: "works-at" });
		await entitySchema.listRules({ slug: "works-at" });

		expect(automationGets).toEqual([{ automation_id: "51" }]);
		expect(calls).toEqual([
			{ action: "get", input: { entity_id: 11 } },
			{
				action: "delete",
				input: { entity_id: 12, force_delete_tree: true },
			},
			{
				action: "read_feed",
				input: { feed_id: 21 },
			},
			{ action: "trigger_feed", input: { feed_id: 22 } },
			{ action: "delete_feed", input: { feed_id: 23 } },
			{ action: "delete", input: { classifier_id: 31 } },
			{ action: "cancel", input: { id: "schedule-41" } },
			{
				action: "claim_next_window",
				input: { automation_id: "51", lease_seconds: 300 },
			},
			{ action: "trigger", input: { automation_id: "52" } },
			{ action: "delete", input: { automation_ids: ["53", "54"] } },
			{
				action: "delete",
				input: { schema_type: "entity_type", slug: "company" },
			},
			{
				action: "delete",
				input: { schema_type: "relationship_type", slug: "works-at" },
			},
			{
				action: "list_rules",
				input: { schema_type: "relationship_type", slug: "works-at" },
			},
		]);
	});

	it("normalizes both connector uninstall argument forms before dispatch", async () => {
		const connections = builders.connections(ctx, env);
		await connections.uninstallConnector("fixture.connector");
		await connections.uninstallConnector({ connector_key: "fixture.connector" } as never);
		expect(calls).toEqual([
			{ action: "uninstall_connector", input: { connector_key: "fixture.connector" } },
			{ action: "uninstall_connector", input: { connector_key: "fixture.connector" } },
		]);
	});

	it("rejects malformed connector uninstall arguments before dispatch", async () => {
		const connections = builders.connections(ctx, env);
		const invalid: unknown[] = [
			undefined, null, 3, {}, [],
			{ connector_key: 3 },
			{ connector_key: "fixture.connector", force: true },
		];
		for (const input of invalid) {
			await expect(
				Promise.resolve().then(() => connections.uninstallConnector(input as never)),
			).rejects.toThrow("connections.uninstallConnector expects the connector_key");
		}
		expect(calls).toEqual([]);
	});

	it("pins both entity-schema discriminators against caller input", async () => {
		const entitySchema = builders.entitySchema(ctx, env);

		await entitySchema.listTypes({
			action: "delete",
			schema_type: "relationship_type",
		} as never);
		await entitySchema.listRelTypes({
			action: "delete",
			schema_type: "entity_type",
		} as never);

		expect(calls).toEqual([
			{ action: "list", input: { schema_type: "entity_type" } },
			{ action: "list", input: { schema_type: "relationship_type" } },
		]);
	});

	it("rewrites documented field aliases to the canonical runtime fields", async () => {
		const feeds = builders.feeds(ctx, env);
		const schedules = builders.schedules(ctx, env);
		const automations = builders.automations(ctx, env);
		const connections = builders.connections(ctx, env);
		const notifications = builders.notifications(ctx, env);

		await feeds.get({ id: 21 } as never);
		await schedules.update({ schedule_id: "s-1", description: "d" } as never);
		await schedules.pause({ schedule_id: "s-2" } as never);
		await schedules.cancel({ schedule_id: "s-3" } as never);
		await automations.setReactionScript({
			automation_id: "42",
			script: "export default async () => {};",
		} as never);
		await connections.update({ connection_id: 9, name: "Renamed" } as never);
		await notifications.send({ title: "T", message: "hello" } as never);

		expect(calls).toEqual([
			{ action: "read_feed", input: { feed_id: 21 } },
			{ action: "update", input: { id: "s-1", description: "d" } },
			{ action: "pause", input: { id: "s-2" } },
			{ action: "cancel", input: { id: "s-3" } },
			{
				action: "set_reaction_script",
				input: {
					automation_id: "42",
					reaction_script: "export default async () => {};",
				},
			},
			{ action: "update", input: { connection_id: 9, display_name: "Renamed" } },
			{ action: "send", input: { title: "T", body: "hello" } },
		]);
	});

	it("lets the canonical field win when both alias and canonical are supplied", async () => {
		const feeds = builders.feeds(ctx, env);
		await feeds.get({ id: 99, feed_id: 11 } as never);
		expect(calls).toEqual([{ action: "read_feed", input: { feed_id: 11 } }]);
	});

	it("accepts the canonical single-field object form on positional methods", async () => {
		const connections = builders.connections(ctx, env);
		const authProfiles = builders.authProfiles(ctx, env);
		const agents = builders.agents(ctx, env);
		const entitySchema = builders.entitySchema(ctx, env);
		const operations = builders.operations(ctx, env);
		const automations = builders.automations(ctx, env);

		await connections.get({ connection_id: 418 } as never);
		await connections.test({ connection_id: 419 } as never);
		await connections.delete({ connection_id: 420 } as never);
		await connections.reauthenticate({ connection_id: 421 } as never);
		await authProfiles.get({ auth_profile_slug: "acct" } as never);
		await agents.get({ agent_id: "builder" } as never);
		await agents.delete({ agent_id: "builder" } as never);
		await entitySchema.getType({ slug: "company" } as never);
		await entitySchema.getRelType({ slug: "works-at" } as never);
		await entitySchema.auditType({ slug: "company" } as never);
		await operations.getRun({ run_id: 7 } as never);
		await automations.getVersions({ automation_id: "42" } as never);

		expect(calls).toEqual([
			{ action: "get", input: { connection_id: 418 } },
			{ action: "test", input: { connection_id: 419 } },
			{ action: "delete", input: { connection_id: 420 } },
			{ action: "reauthenticate", input: { connection_id: 421 } },
			{ action: "get_auth_profile", input: { auth_profile_slug: "acct" } },
			{ action: "get", input: { agent_id: "builder" } },
			{ action: "delete", input: { agent_id: "builder" } },
			{ action: "get", input: { schema_type: "entity_type", slug: "company" } },
			{
				action: "get",
				input: { schema_type: "relationship_type", slug: "works-at" },
			},
			{ action: "audit", input: { schema_type: "entity_type", slug: "company" } },
			{ action: "get_run", input: { run_id: 7 } },
			{ action: "get_versions", input: { automation_id: "42" } },
		]);
	});

	it("still accepts the positional form on those methods", async () => {
		const connections = builders.connections(ctx, env);
		const agents = builders.agents(ctx, env);
		const entitySchema = builders.entitySchema(ctx, env);
		const operations = builders.operations(ctx, env);
		const automations = builders.automations(ctx, env);

		await connections.get(1);
		await agents.get("builder");
		await entitySchema.getType("company");
		await operations.getRun(7);
		await automations.getVersions("42");

		expect(calls).toEqual([
			{ action: "get", input: { connection_id: 1 } },
			{ action: "get", input: { agent_id: "builder" } },
			{ action: "get", input: { schema_type: "entity_type", slug: "company" } },
			{ action: "get_run", input: { run_id: 7 } },
			{ action: "get_versions", input: { automation_id: "42" } },
		]);
	});

	it("rejects unrecognized shapes with guidance naming both accepted forms", async () => {
		const connections = builders.connections(ctx, env);
		const authProfiles = builders.authProfiles(ctx, env);

		// Placeholders are neutral (`<connection_id>`), NOT real-looking ids — a
		// fresh agent must not copy a fabricated id verbatim.
		await expect(connections.get(true as never)).rejects.toThrow(
			"connections.get expects the connection_id. Call client.connections.get(<connection_id>) or client.connections.get({ connection_id: <connection_id> }).",
		);
		// A wrong field name inside the object form still fails with the guidance.
		await expect(
			connections.reauthenticate({ id: 418 } as never),
		).rejects.toThrow("client.connections.reauthenticate({ connection_id:");
		// Extra keys in the object form are rejected, never silently dropped.
		await expect(
			authProfiles.get({
				auth_profile_slug: "acct",
				verbose: true,
			} as never),
		).rejects.toThrow("client.authProfiles.get({ auth_profile_slug:");
		expect(calls).toEqual([]);
	});
});
