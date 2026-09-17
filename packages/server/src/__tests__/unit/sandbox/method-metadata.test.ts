import { describe, expect, it } from "bun:test";
import {
	BANNED_PATHS,
	METHOD_METADATA,
	type MethodAccess,
} from "../../../sandbox/method-metadata";
import { SDK_FIELD_ALIASES } from "../../../sandbox/sdk-aliases";
import { buildClientSDK } from "../../../sandbox/client-sdk";
import { getSdkPreflight } from "../../../sandbox/sdk-preflight";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";

const testEnv: Env = { ENVIRONMENT: "test" } as Env;
const testCtx: ToolContext = {
	organizationId: "test-org",
	userId: "test-user",
	memberRole: "owner",
	isAuthenticated: true,
	tokenType: "oauth",
	scopedToOrg: false,
	allowCrossOrg: true,
};

function enumerateSdkMethods(): {
	namespaceMethods: string[];
	topLevelMethods: string[];
} {
	const sdk = buildClientSDK(testCtx, testEnv);
	const namespaceMethods: string[] = [];
	const topLevelMethods: string[] = [];

	for (const [name, value] of Object.entries(sdk)) {
		if (typeof value === "function") {
			topLevelMethods.push(name);
			continue;
		}
		if (!value || typeof value !== "object") continue;
		for (const method of Object.keys(value)) {
			namespaceMethods.push(`${name}.${method}`);
		}
	}

	return { namespaceMethods, topLevelMethods };
}

describe("method-metadata", () => {
	it("has metadata for every namespace method", () => {
		const { namespaceMethods } = enumerateSdkMethods();
		const missing = namespaceMethods.filter(
			(path) => !(path in METHOD_METADATA)
		);
		expect(missing).toEqual([]);
	});

	it("has a runtime method for every namespace metadata entry (no phantom docs)", () => {
		// The reverse direction: a METHOD_METADATA key without a runtime method is
		// dead documentation that search_sdk advertises but the sandbox rejects.
		const { namespaceMethods, topLevelMethods } = enumerateSdkMethods();
		const runtime = new Set([...namespaceMethods, ...topLevelMethods]);
		const phantom = Object.keys(METHOD_METADATA).filter(
			(path) => !runtime.has(path)
		);
		expect(phantom).toEqual([]);
	});

	it("has entries for top-level methods", () => {
		const { topLevelMethods } = enumerateSdkMethods();
		for (const m of topLevelMethods) {
			expect(METHOD_METADATA).toHaveProperty(m);
		}
	});

	it("has valid access levels on every entry", () => {
		const valid: MethodAccess[] = ["read", "write", "external", "admin"];
		for (const [path, meta] of Object.entries(METHOD_METADATA)) {
			expect(valid).toContain(meta.access);
			expect(meta.summary.length).toBeGreaterThan(0);
			if (meta.example) {
				expect(meta.example).toContain("client.");
			}
			void path;
		}
	});

	it("gives every non-read namespace method a schema-backed dry-run preflight", () => {
		const sdk = buildClientSDK(testCtx, testEnv) as unknown as Record<
			string,
			Record<string, unknown>
		>;
		const missing = Object.entries(METHOD_METADATA)
			.filter(([, metadata]) => metadata.access !== "read")
			.filter(([path]) => path.includes("."))
			.filter(([path]) => {
				const [namespace, method] = path.split(".");
				return !getSdkPreflight(sdk[namespace]?.[method]);
			})
			.map(([path]) => path);

		expect(missing).toEqual([]);
	});

	it("uses dotted path keys", () => {
		for (const path of Object.keys(METHOD_METADATA)) {
			expect(path).toMatch(/^[a-zA-Z]+(\.[a-zA-Z]+)?$/);
		}
	});

	it("never exposes banned paths", () => {
		for (const banned of BANNED_PATHS) {
			expect(METHOD_METADATA).not.toHaveProperty(banned);
		}
	});

	it("classifies external side-effects correctly for known methods", () => {
		expect(METHOD_METADATA["operations.execute"].access).toBe("external");
		expect(METHOD_METADATA["feeds.trigger"].access).toBe("external");
		expect(METHOD_METADATA["automations.trigger"].access).toBe("external");
		expect(METHOD_METADATA["connections.test"].access).toBe("external");
		expect(METHOD_METADATA["authProfiles.test"].access).toBe("external");
	});

	it("classifies reads correctly for known methods", () => {
		expect(METHOD_METADATA["entities.list"].access).toBe("read");
		expect(METHOD_METADATA["automations.list"].access).toBe("read");
		expect(METHOD_METADATA["organizations.list"].access).toBe("read");
	});

	it("exposes org-read admin lists in read mode (agents.list/get)", () => {
		// These are org-read-gated at runtime (requireOrgReadAccess / org-scoped
		// query) but were tagged access:"admin", so query_sdk read mode dropped the
		// whole namespace → opaque "Cannot read properties of undefined". Reclassify
		// ONLY the reads; the mutating siblings must stay admin.
		expect(METHOD_METADATA["agents.list"].access).toBe("read");
		expect(METHOD_METADATA["agents.get"].access).toBe("read");
		// Mutations stay admin-gated — reclassifying reads must not leak writes.
		expect(METHOD_METADATA["agents.create"].access).toBe("admin");
		expect(METHOD_METADATA["agents.update"].access).toBe("admin");
		expect(METHOD_METADATA["agents.delete"].access).toBe("admin");
	});

	it("schedules.* discovery matches the enforced manage_schedules tier (all admin)", () => {
		// manage_schedules is owner-admin for every action (schedule rows carry
		// agent prompts and delivery context), enforced via the explicit
		// OWNER_ADMIN_ACTIONS entry and pinned by the tool-access matrix. The SDK
		// metadata must say the same: a method that advertises read-safe but is
		// denied at runtime is discovery-vs-enforcement drift (#2607), so
		// `schedules.list` is admin — not read.
		expect(METHOD_METADATA["schedules.list"].access).toBe("admin");
		expect(METHOD_METADATA["schedules.create"].access).toBe("admin");
		expect(METHOD_METADATA["schedules.update"].access).toBe("admin");
		expect(METHOD_METADATA["schedules.pause"].access).toBe("admin");
		expect(METHOD_METADATA["schedules.cancel"].access).toBe("admin");
	});

	it("spells the runtime-enforced enums into entities.link / entities.listLinks signatures", () => {
		// The enums are validated at runtime (contract manage-entity.ts) but weren't
		// in the search_sdk signatures, so a client had no way to discover the legal
		// values before a call rejected.
		const linkSig = METHOD_METADATA["entities.link"].signature ?? "";
		expect(linkSig).toContain("source?: 'ui' | 'llm' | 'feed' | 'api'");
		const listLinksSig = METHOD_METADATA["entities.listLinks"].signature ?? "";
		expect(listLinksSig).toContain(
			"direction?: 'outbound' | 'inbound' | 'both'",
		);
	});

	it("does not claim SQL positional parameters in the query example", () => {
		const example = METHOD_METADATA.query.example ?? "";
		expect(example).not.toMatch(/\$\d+/);
	});

	it("documents object signatures for named id methods", () => {
		const objectSignatureMethods = [
			"entities.get",
			"entities.delete",
			"feeds.get",
			"feeds.trigger",
			"feeds.delete",
			"classifiers.delete",
			"schedules.cancel",
			"automations.get",
			"automations.claimNextWindow",
			"automations.trigger",
			"automations.delete",
			"entitySchema.deleteType",
			"entitySchema.deleteRelType",
			"entitySchema.listRules",
		];

		for (const path of objectSignatureMethods) {
			expect(METHOD_METADATA[path]?.example, path).toMatch(/\(\{/);
		}
	});

	it("teaches the two-hop create-type-first pattern with the right constructors", () => {
		// entities.create must point at entitySchema.createType (the type must
		// exist first) — the multi-step precondition agents otherwise miss.
		const create = METHOD_METADATA["entities.create"];
		expect(create.summary).toContain("entitySchema.createType");
		expect(create.usageExample ?? "").toContain("entitySchema.createType");
		// The documented error contract must be REAL: run_sdk surfaces the
		// unknown-type ToolUserError as a ValidationError. `EntityTypeNotFound`
		// is not a public error — recovery keyed to it could never fire.
		expect(create.throws ?? []).toContain("ValidationError");
		expect(create.throws ?? []).not.toContain("EntityTypeNotFound");
		expect(create.summary).not.toContain("EntityTypeNotFound");
		// The ensure step tolerates only the coded duplicate 409 (multi-replica
		// race), so a concurrent caller doesn't abort the advertised flow.
		expect(create.usageExample ?? "").toContain("entity_type_exists");

		// entities.link must name entitySchema.createRelType as the relationship-
		// type constructor. addRule does NOT create a type (it only restricts the
		// allowed source/target pairs), so it must never be presented as the
		// constructor — that was a factual error the guidance is meant to prevent.
		const link = METHOD_METADATA["entities.link"];
		expect(link.summary).toContain("entitySchema.createRelType");
		expect(link.summary).not.toMatch(
			/call `?entitySchema\.addRule`? first|addRule.*\(or createRelType\)/
		);
		// The copy-paste usage example must embody the full two-hop flow (ensure
		// the rel-type, then link) — not just mention it — so a pasted example
		// can't reproduce the missing-type stall it's meant to prevent.
		const linkExample = link.usageExample ?? "";
		expect(linkExample).toContain("listRelTypes");
		expect(linkExample).toContain("createRelType");
		expect(linkExample).toContain("entities.link");
		// Same multi-replica race safety as entities.create: tolerate only the
		// coded relationship_type_exists 409, don't swallow every error.
		expect(linkExample).toContain("relationship_type_exists");
	});

	it("teaches the connect→feed two-hop so setup actually collects data", () => {
		// connections.connect alone syncs nothing — the agent must then create a
		// feed on the returned connection_id. This is the connect-website eval gap:
		// agents discover the connector but stall before the feed. Both entries
		// must name the sibling call and thread connection_id.
		const connect = METHOD_METADATA["connections.connect"];
		expect(connect.summary).toContain("connection_id");
		expect(connect.summary).toMatch(/create a feed|feeds\.create/);
		// connect() does NOT always return a usable connection_id: for the
		// setup_required continuation the field is OPTIONAL. The summary must
		// describe it as outcome-dependent (not promise an id unconditionally,
		// and not claim setup_required NEVER has one), so an agent waits for a
		// real id before calling feeds.create.
		expect(connect.summary).toContain("setup_required");
		expect(connect.summary).toMatch(/optional/i);
		expect(connect.summary).not.toMatch(/NO connection exists/i);
		const connectExample = connect.usageExample ?? "";
		expect(connectExample).toContain("connections.connect");
		expect(connectExample).toContain("feeds.create");
		expect(connectExample).toContain("connection_id");
		expect(connectExample).toContain("feed_key");
		// The example must reference a connector that EXISTS in the catalog:
		// 'website' does not (there is no packages/connectors/src/website.ts), so
		// an agent copying the doc got "unknown connector". rss is auth-none with
		// the 'articles' feed whose config requires feed_urls — assert the
		// executable expression passes the real keys, not just prose mentions.
		expect(connect.example ?? "").toContain("'rss'");
		expect(connectExample).toContain("connector_key: 'rss'");
		expect(connectExample).toContain("feed_key: 'articles'");
		expect(connectExample).toMatch(/config:\s*\{\s*feed_urls:\s*\[/);
		expect(connect.summary).not.toContain("website");
		expect(connectExample).not.toContain("'website'");

		// feeds.create must document the connection_id + feed_key it needs and
		// point at how to discover the config shape — not leave the agent guessing.
		const feed = METHOD_METADATA["feeds.create"];
		expect(feed.summary).toContain("connection_id");
		expect(feed.summary).toContain("feed_key");
		expect(feed.summary).not.toContain("website");
		expect(feed.signature ?? "").toContain("connection_id");
		expect(feed.example ?? "").toContain("feed_key");
		expect(feed.example ?? "").toContain("'articles'");
	});

	it("documents the schedules.create payload contract (discriminated union)", () => {
		// The live failure: the summary alone ("Create a one-shot or recurring
		// schedule") gives an MCP client no way to discover the required
		// description/run_at fields or the payload discriminant, so every first
		// call 400s. The signature must spell out both payload variants.
		const create = METHOD_METADATA["schedules.create"];
		const sig = create.signature ?? "";
		expect(sig).toContain("description: string");
		expect(sig).toContain("run_at: string");
		expect(sig).toContain("cron?: string");
		expect(sig).toContain("type: 'send_notification'");
		expect(sig).toContain("title: string");
		expect(sig).toContain("recipients?");
		expect(sig).toContain("resource_url?");
		expect(sig).toContain("type: 'wake_agent'");
		expect(sig).toContain("agent_id: string");
		expect(sig).toContain("prompt: string");
		expect(sig).toContain("thread_id?");
		expect(create.example ?? "").toContain("payload");
		expect(create.usageExample ?? "").toContain("send_notification");
	});

	it("documents that automations.create sources[] entries require name AND query", () => {
		// A create call whose sources lack `name` fails validation, but the doc
		// only described sources[].query — the client had no way to recover.
		const create = METHOD_METADATA["automations.create"];
		expect(create.summary).toMatch(/sources\[\] entry requires `name`/);
		expect(create.summary).toContain("`query`");
		expect(create.example ?? "").toContain("name: 'content'");
	});

	it("enumerates the valid catalog.listCatalog kinds", () => {
		// {kind: 'connector'} and {kinds: ['connector']} both failed live with
		// errors that never named the valid (plural) values.
		const list = METHOD_METADATA["catalog.listCatalog"];
		const sig = list.signature ?? "";
		expect(sig).toContain("'connectors'");
		expect(sig).toContain("'skills'");
		expect(sig).toContain("'automations'");
		expect(list.summary).toContain("'connectors'");
		expect(list.summary).toContain("'automations'");
	});

	it("documents knowledge.read's content_ids (array) arg — the shape save_memory's exact_read hint points at", () => {
		const read = METHOD_METADATA["knowledge.read"];
		expect(read.summary).toContain("content_ids");
		expect(read.example ?? "").toContain("content_ids: [");
	});

	it("documents destructive event-kind replacement and structured-event rendering", () => {
		expect(METHOD_METADATA["entitySchema.createType"].access).toBe("admin");
		expect(METHOD_METADATA["entitySchema.createType"].summary).toContain(
			"workspace write policy",
		);
		expect(METHOD_METADATA["entitySchema.updateType"].summary).toContain(
			"replaces the entire registry",
		);
		expect(METHOD_METADATA["knowledge.save"].summary).toContain(
			"payload_type: 'empty'",
		);
	});

	it("documents the nullable payload of both entitySchema getters", () => {
		// Unlike entities.get, agents.get and conversations.get — which throw 404
		// when the row is missing — these two report "not found" as a null payload
		// field. The wrapper itself is always truthy, so `if (await getType(slug))`
		// silently reports every missing type as present.
		const nullable: Array<[string, string, string]> = [
			["entitySchema.getType", "entity_type", "'company'"],
			["entitySchema.getRelType", "relationship_type", "'works-at'"],
		];
		for (const [path, field, slug] of nullable) {
			const meta = METHOD_METADATA[path];
			expect(meta.summary, path).toContain(`nullable \`${field}\` field`);
			expect(meta.summary, path).toContain("do not truth-test the wrapper");
			expect(meta.example ?? "", path).toContain(`const { ${field} }`);
			expect(meta.example ?? "", path).toContain(`${path}(${slug})`);
			expect(meta.example ?? "", path).toContain("null when absent");
		}
	});

	it("documents the exact positional signature AND the accepted object form for every positional-id method", () => {
		// #2046: these methods take a positional id at runtime but were described
		// like named-object methods, so discovery and runtime disagreed. Every one
		// must now document `path(field: type)` and the `{ field }` object form the
		// runtime also accepts.
		const positional: Array<[string, string]> = [
			["connections.get", "connection_id"],
			["connections.test", "connection_id"],
			["connections.delete", "connection_id"],
			["connections.reauthenticate", "connection_id"],
			["agents.get", "agent_id"],
			["agents.delete", "agent_id"],
			["entitySchema.getType", "slug"],
			["entitySchema.getRelType", "slug"],
			["entitySchema.auditType", "slug"],
			["operations.getRun", "run_id"],
			["automations.getVersions", "automation_id"],
			["authProfiles.get", "auth_profile_slug"],
			["authProfiles.test", "auth_profile_slug"],
			["authProfiles.delete", "auth_profile_slug"],
			["notifications.markRead", "notification_id"],
		];
		for (const [path, field] of positional) {
			const sig = METHOD_METADATA[path]?.signature ?? "";
			expect(sig, path).toStartWith(`${path}(${field}:`);
			expect(sig, path).toContain(`{ ${field} }`);
		}
	});

	it("documents the exact runtime field names for the #2046 wrong-field mismatches", () => {
		const expectations: Array<[string, string[]]> = [
			["schedules.update", ["id: string"]],
			["schedules.pause", ["id: string"]],
			["schedules.cancel", ["id: string"]],
			["views.remove", ["key: string"]],
			["automations.setReactionScript", ["reaction_script: string"]],
			[
				"notifications.send",
				[
					"title: string",
					"body?: string",
					"'admins' | 'all' | string[]",
					"input_schema?: object",
					"run_id?: number",
				],
			],
			[
				"connections.update",
				[
					"display_name?: string",
					"device_worker_id?: string | null",
					"replace_config?: boolean",
				],
			],
			[
				"automations.create",
				["device_worker_id?: string | null", "'agy' | null"],
			],
			["classifiers.classify", ["classifier_slug: string", "'llm' | 'user'"]],
			[
				"classifiers.create",
				["automation_id?: string", "attribute_values", "examples: string[]"],
			],
		];
		for (const [path, fragments] of expectations) {
			const sig = METHOD_METADATA[path]?.signature ?? "";
			for (const fragment of fragments) {
				expect(sig, `${path} signature documents ${fragment}`).toContain(
					fragment,
				);
			}
		}
	});

	it("documents that view attach lines live in the module (no attach verbs)", () => {
		expect(METHOD_METADATA["views.set"].summary).toContain(
			"attach",
		);
	});

	it("advertises authProfiles.get at the tier manage_auth_profiles enforces (read)", () => {
		expect(METHOD_METADATA["authProfiles.get"].access).toBe("read");
		// Credential-bearing siblings stay gated.
		expect(METHOD_METADATA["authProfiles.create"].access).toBe("write");
		expect(METHOD_METADATA["authProfiles.update"].access).toBe("write");
		expect(METHOD_METADATA["authProfiles.test"].access).toBe("external");
	});

	it("keeps the alias registry aligned with runtime methods and their docs", () => {
		const { namespaceMethods } = enumerateSdkMethods();
		for (const [path, aliases] of Object.entries(SDK_FIELD_ALIASES)) {
			expect(namespaceMethods, path).toContain(path);
			const meta = METHOD_METADATA[path];
			expect(meta, path).toBeDefined();
			const doc = `${meta?.signature ?? ""} ${meta?.example ?? ""}`;
			for (const [alias, canonical] of Object.entries(aliases)) {
				// an alias that equals its canonical field is a registry bug
				expect(alias, path).not.toBe(canonical);
				expect(doc, `${path} documents canonical field ${canonical}`).toContain(
					canonical,
				);
			}
		}
	});
});
