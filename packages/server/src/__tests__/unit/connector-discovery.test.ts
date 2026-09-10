import { describe, expect, it } from "bun:test";
import type { Env } from "../../index";
import type { AccountToolContext, ToolContext } from "../../tools/registry";
import type { ConnectionSetupOptions } from "@lobu/core/contracts/tools/manage-connections";
import {
	type ConnectorDiscoveryDeps,
	searchLiveConnectors,
} from "../../tools/connector-discovery";

// Fixture mirrors the audit's Website-installed-but-unconfigured production
// shape: website is INSTALLED with a `pages` feed schema, NOT in the configured
// connections, and NOT in the global catalog (an org-installed connector). RSS
// is also installed as a decoy alternative. Injected via the `deps` param — no
// mock.module (process-global in Bun; it corrupts sibling suites).
const installedResult = {
	installed: {
		connectors: {
			items: [
				{
					id: "website",
					name: "Website",
					detail: {
						description:
							"Scrapes JS-rendered pages via Playwright; supports sitemap.xml",
						// SECRET-looking fields that must NOT surface:
						auth_schema: { api_key: { type: "string" } },
						default_connection_config: { token: "sekret" },
						feeds_schema: { pages: { config: { urls: {}, max_pages: {} } } },
					},
				},
				{
					id: "rss",
					name: "RSS",
					detail: { description: "RSS reader", feeds_schema: { articles: {} } },
				},
			],
		},
	},
};

const catalogResult = {
	catalogs: {
		connectors: {
			entries: [
				{ id: "slack", name: "Slack", description: "Slack workspace sync" },
				{ id: "webhook", name: "Webhook", description: "Inbound push" },
			],
		},
	},
};


function makeDeps(over?: {
	installed?: unknown;
	catalog?: unknown;
	// Connections keyed by connector_key — the tool queries connections FILTERED
	// by connector_key, so the mock returns only the matching key's rows (models
	// the real filter and proves an active connection is found regardless of how
	// many other connections exist).
	connectionsByKey?: Record<string, Array<{ status: string }>>;
	organizations?: Array<Record<string, unknown>>;
	liveGrantedOrganizationIds?: string[];
	// Setup discovery reaches the configured cloud in production; the default
	// stub returns "nothing offered here" so the base lifecycle assertions stay
	// about the managed-offer path.
	setupByKey?: Record<string, ConnectionSetupOptions>;
}): ConnectorDiscoveryDeps {
	return {
		manageCatalog: (async (args: { action: string }) =>
			args.action === "list_catalog"
				? (over?.catalog ?? catalogResult)
				: (over?.installed ?? installedResult)) as never,
		manageConnections: (async (args: { connector_key?: string; status?: string }) => {
			// Model the real handler: connector_key AND optional status filter.
			const all = over?.connectionsByKey?.[args.connector_key ?? ""] ?? [];
			const rows = args.status ? all.filter((c) => c.status === args.status) : all;
			return { connections: rows };
		}) as never,
		setupOptions: async ({ connector_key }) =>
			over?.setupByKey?.[connector_key] ?? {
				action: "setup_options",
				connector_key,
				cloud_status: "not_configured",
				options: [],
			},
		listPublicOrganizations: async () => (over?.organizations ?? []) as never,
		listOrganizations: async () => (over?.organizations ?? []) as never,
		listLiveGrantedOrganizations: async () =>
			(over?.liveGrantedOrganizationIds ?? []).map((id) => ({ id, slug: id, name: id, role: "member", personal: false })),
	};
}

const env = {} as Env;
const ctx = {
	organizationId: "org-1",
	userId: "u1",
	memberRole: "admin",
	scopes: ["mcp:read", "mcp:write", "mcp:admin"],
} as ToolContext;

const ownerWriteCtx = {
	...ctx,
	memberRole: "owner",
	scopes: ["mcp:read", "mcp:write"],
} as ToolContext;

const memberCtx = {
	...ctx,
	memberRole: "member",
	scopes: ["mcp:read", "mcp:write", "mcp:admin"],
} as ToolContext;

describe("searchLiveConnectors (search_sdk connector intent search)", () => {
	it("discovers only live granted inventories without a default workspace", async () => {
		const visited: string[] = [];
		const deps = makeDeps({ liveGrantedOrganizationIds: ["alpha", "beta"] });
		const catalog = deps.manageCatalog;
		deps.manageCatalog = (async (args: never, env: Env, context: ToolContext) => {
			visited.push(context.organizationId);
			expect(context.memberRole).toBe("member");
			return catalog(args, env, context);
		}) as typeof catalog;
		const account = { ...ctx, organizationId: null, memberRole: null,
			allowCrossOrg: true, grantedOrganizationIds: ["alpha", "beta", "revoked"] } as AccountToolContext;
		const hits = await searchLiveConnectors("website", env, account, deps);
		expect(hits).toHaveLength(2);
		expect(hits[0]).toContain('client.org("alpha")');
		expect(hits[1]).toContain('client.org("beta")');
		expect(new Set(visited)).toEqual(new Set(["alpha", "beta"]));
		expect(JSON.stringify(hits)).not.toContain("revoked");
	});

	it("surfaces an installed-but-unconfigured connector with feed key + connect lifecycle", async () => {
		const hits = await searchLiveConnectors("website", env, ctx, makeDeps());
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatch(/website/);
		expect(hits[0]).toMatch(/not yet configured/);
		expect(hits[0]).toMatch(/feed_key: 'pages'/);
		expect(hits[0]).toMatch(/connections\.connect/);
		expect(hits[0]).toMatch(/feeds\.trigger/);
	});

	it("shows owner/admin callers at mcp:write the lifecycle plus progressive admin authorization", async () => {
		const hits = await searchLiveConnectors(
			"website",
			env,
			ownerWriteCtx,
			makeDeps(),
		);

		expect(hits[0]).toContain("client.connections.connect");
		expect(hits[0]).toMatch(/client\.feeds\.(create|trigger)/);
		expect(hits[0]).toMatch(/progressively authorizable|OAuth challenge/i);
		expect(hits[0]).toContain("mcp:admin");
	});

	it("gives regular members an owner/admin handoff without impossible elevation", async () => {
		const hits = await searchLiveConnectors(
			"website",
			env,
			memberCtx,
			makeDeps(),
		);

		expect(hits[0]).toMatch(/ask a workspace owner\/admin/i);
		expect(hits[0]).toMatch(/cannot elevate/i);
		expect(hits[0]).not.toMatch(/reconnect|reauthorize/i);
		expect(hits[0]).not.toMatch(/client\.connections\.connect|client\.feeds\.(create|trigger)/);
	});

	it("matches a MULTI-WORD intent phrase via tokens, not just the bare name", async () => {
		// The failure the eval exposed: "website connect source" / "crawl a web
		// page" returned nothing because the whole phrase was matched as one
		// substring. Token matching must still find the connector.
		for (const q of ["website connect source", "crawl a web page", "ingest a website"]) {
			const hits = await searchLiveConnectors(q, env, ctx, makeDeps());
			expect(hits.some((h) => h.includes("'website'"))).toBe(true);
		}
	});

	it("reports an active connection as CONNECTED (add feed / read, don't re-connect)", async () => {
		const deps = makeDeps({ connectionsByKey: { website: [{ status: "active" }] } });
		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits[0]).toMatch(/CONNECTED/);
		expect(hits[0]).toMatch(/feeds\.create/);
		expect(hits[0]).not.toMatch(/not yet configured/);
		expect(hits[0]).not.toMatch(/reauthenticate/i);
	});

	it("tells the agent to REPAIR a revoked/error connection, not create a feed on it", async () => {
		// The review-caught bug: a revoked connection was labeled 'already
		// CONFIGURED' and told to create feeds, which would silently never sync.
		const deps = makeDeps({ connectionsByKey: { website: [{ status: "revoked" }] } });
		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits[0]).toMatch(/needs attention/);
		expect(hits[0]).toMatch(/status: revoked/);
		expect(hits[0]).toMatch(/reauthenticate|repair|reconnect/i);
		expect(hits[0]).not.toMatch(/CONNECTED \(active/);
	});

	it("prefers an ACTIVE connection when a connector has several (active + revoked)", async () => {
		const deps = makeDeps({
			connectionsByKey: { website: [{ status: "revoked" }, { status: "active" }] },
		});
		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits[0]).toMatch(/CONNECTED/);
		expect(hits[0]).not.toMatch(/needs attention/);
	});

	it("finds an ACTIVE connection even behind many newer non-active ones (status probe, not one page)", async () => {
		// The review-caught bug: an older active connection hidden behind 200 newer
		// revoked rows was reported as 'needs repair'. The tool probes status=active
		// (filtered) first, so it's found regardless of ordering/volume.
		const many = [
			...Array.from({ length: 200 }, () => ({ status: "revoked" })),
			{ status: "active" }, // older, would be on page 2 of an unfiltered scan
		];
		const deps = makeDeps({ connectionsByKey: { website: many } });
		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits[0]).toMatch(/CONNECTED/);
		expect(hits[0]).not.toMatch(/needs attention/);
	});

	it("does NOT tell the agent to create a feed on a feedless connector (Slack-style)", async () => {
		// The review-caught bug: a connector with feeds_schema=null (an action/chat
		// connector) was sent down the feeds.create lifecycle, which is invalid. It
		// must be pointed at operations instead.
		const deps = makeDeps({
			installed: {
				installed: {
					connectors: {
						items: [
							{
								id: "slack",
								name: "Slack",
								detail: { description: "Chat", feeds_schema: null },
							},
						],
					},
				},
			},
		});
		const notConnected = await searchLiveConnectors("slack", env, ctx, deps);
		expect(notConnected[0]).not.toMatch(/feeds\.create/);
		expect(notConnected[0]).toMatch(/no data feeds|operations/i);
		expect(notConnected[0]).toMatch(/operations\.listAvailable/);

		// Same when already connected: add-feed guidance must not appear.
		const connectedDeps = makeDeps({
			installed: {
				installed: {
					connectors: {
						items: [{ id: "slack", name: "Slack", detail: { feeds_schema: null } }],
					},
				},
			},
			connectionsByKey: { slack: [{ status: "active" }] },
		});
		const connected = await searchLiveConnectors("slack", env, ctx, connectedDeps);
		expect(connected[0]).toMatch(/CONNECTED/);
		expect(connected[0]).not.toMatch(/feeds\.create/);
		expect(connected[0]).toMatch(/operations/i);
	});

	it("surfaces a global-catalog connector as installable when not installed", async () => {
		const hits = await searchLiveConnectors("slack", env, ctx, makeDeps());
		expect(hits.some((h) => h.includes("'slack'") && /CATALOG/.test(h))).toBe(true);
		expect(hits.some((h) => /installConnector/.test(h))).toBe(true);
	});

	it("surfaces the exact managed-auth org and local-data lifecycle for a matching connector", async () => {
		const deps = makeDeps({
			catalog: {
				catalogs: {
					connectors: {
						entries: [
							{ id: "google.gmail", name: "Gmail", description: "Email search and sync" },
						],
					},
				},
			},
			organizations: [
				{
					id: "managed-org",
					slug: "lobu-cloud",
					name: "Lobu Cloud",
					is_member: false,
					visibility: "public",
					managed_auth: {
						credential_mode: "managed",
						requires_user_login: true,
						requires_user_consent: true,
						join_required: true,
						connect_method: "connections.connectManaged",
						local_bootstrap_command: "lobu init --from-org lobu-cloud",
						connectors: [
							{
								connector_key: "google.gmail",
								provider: "google",
								managed_by_org: "lobu-cloud",
							},
						],
					},
				},
			],
		});

		const hits = await searchLiveConnectors("gmail", env, ctx, deps);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toContain("public org 'lobu-cloud'");
		expect(hits[0]).toContain("connections.connectManaged");
		expect(hits[0]).toContain("lobu init --from-org lobu-cloud");
		expect(hits[0]).toContain("provider data stays local");
		expect(hits[0].indexOf("connections.connectManaged")).toBeLessThan(hits[0].indexOf("connections.installConnector"));
		expect(hits[0]).toContain("Alternative local setup");
	});

	it("leads with a discovered setup option and keeps the local route as the alternative", async () => {
		const deps = makeDeps({
			setupByKey: {
				website: {
					action: "setup_options",
					connector_key: "website",
					cloud_status: "available",
					options: [
						{
							kind: "managed_oauth",
							label: "Connect with Example Cloud",
							description: "Use the managed app.",
							execution: "local",
							configured: true,
							managed_by_org: "example-cloud",
							url: "https://cloud.example/connect/managed?org=example-cloud",
							instructions: "Authorize, then bootstrap locally.",
						},
						// A local option is the fallback the line itself already
						// describes, so it must never be re-advertised as a choice.
						{
							kind: "local",
							label: "Use your own app",
							description: "Local setup",
							execution: "local",
							configured: false,
							instructions: "Configure an app",
						},
					],
				},
			},
		});

		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits[0]).toContain("Connect with Example Cloud (managed_oauth, execution: local)");
		expect(hits[0]).toContain("https://cloud.example/connect/managed?org=example-cloud");
		expect(hits[0]).not.toContain("Use your own app");
		expect(hits[0].indexOf("Connect with Example Cloud")).toBeLessThan(
			hits[0].indexOf("Alternative local setup")
		);
	});

	it("reports a setup-discovery outage without hiding a managed offer it already knows", async () => {
		const deps = makeDeps({
			catalog: {
				catalogs: {
					connectors: {
						entries: [{ id: "google.gmail", name: "Gmail", description: "Google Mail" }],
					},
				},
			},
			setupByKey: {
				"google.gmail": {
					action: "setup_options",
					connector_key: "google.gmail",
					cloud_status: "unavailable",
					options: [],
				},
			},
			organizations: [
				{
					id: "lobu-cloud",
					slug: "lobu-cloud",
					name: "Lobu Cloud",
					visibility: "public",
					is_member: false,
					managed_auth: {
						join_required: true,
						connect_method: "connections.connectManaged",
						local_bootstrap_command: "lobu init --from-org lobu-cloud",
						connectors: [
							{
								connector_key: "google.gmail",
								provider: "google",
								managed_by_org: "lobu-cloud",
							},
						],
					},
				},
			],
		});

		const hits = await searchLiveConnectors("gmail", env, ctx, deps);
		expect(hits[0]).toContain("Cloud setup discovery is unavailable");
		expect(hits[0]).toContain("public org 'lobu-cloud'");
		expect(hits[0]).toContain("connections.connectManaged");
		expect(hits[0]).not.toContain("  ");
	});

	it("hides private managed-auth memberships outside the grant while retaining public offers", async () => {
		const grantCtx = {
			...ctx,
			grantedOrganizationIds: ["granted-org"],
			directSearchFederation: false,
		} as ToolContext;
		const managedAuth = (managedByOrg: string) => ({
			credential_mode: "managed",
			requires_user_login: true,
			requires_user_consent: true,
			join_required: true,
			connect_method: "connections.connectManaged",
			local_bootstrap_command: `lobu init --from-org ${managedByOrg}`,
			connectors: [
				{
					connector_key: "google.gmail",
					provider: "google",
					managed_by_org: managedByOrg,
				},
			],
		});
		const deps = makeDeps({
			catalog: {
				catalogs: {
					connectors: {
						entries: [
							{
								id: "google.gmail",
								name: "Gmail",
								description: "Email search",
							},
						],
					},
				},
			},
			liveGrantedOrganizationIds: ["granted-org"],
			organizations: [
				{
					id: "ungranted-private",
					slug: "secret-team",
					name: "Secret Team",
					is_member: true,
					visibility: "private",
					managed_auth: managedAuth("secret-team"),
				},
				{
					id: "public-managed",
					slug: "public-catalog",
					name: "Public Catalog",
					is_member: false,
					visibility: "public",
					managed_auth: managedAuth("public-catalog"),
				},
			],
		});

		const hits = await searchLiveConnectors("gmail", env, grantCtx, deps);
		expect(hits.join("\n")).toContain("public-catalog");
		expect(hits.join("\n")).not.toContain("secret-team");
	});

	it("preserves private membership discovery when no OAuth grant snapshot exists", async () => {
		const managedAuth = {
			credential_mode: "managed",
			requires_user_login: true,
			requires_user_consent: true,
			join_required: false,
			connect_method: "connections.connectManaged",
			local_bootstrap_command: "lobu init --from-org legacy-team",
			connectors: [
				{
					connector_key: "google.gmail",
					provider: "google",
					managed_by_org: "legacy-team",
				},
			],
		};
		const deps = makeDeps({
			catalog: {
				catalogs: {
					connectors: {
						entries: [
							{
								id: "google.gmail",
								name: "Gmail",
								description: "Email search",
							},
						],
					},
				},
			},
			organizations: [
				{
					id: "legacy-private",
					slug: "legacy-team",
					name: "Legacy Team",
					is_member: true,
					visibility: "private",
					managed_auth: managedAuth,
				},
			],
		});

		const hits = await searchLiveConnectors("gmail", env, ctx, deps);
		expect(hits.join("\n")).toContain("legacy-team");
	});

	it("still surfaces connectors when optional managed-auth discovery fails", async () => {
		const deps = makeDeps();
		deps.listOrganizations = async () => {
			throw new Error("managed-auth discovery unavailable");
		};

		const hits = await searchLiveConnectors("website", env, ctx, deps);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toContain("connector 'website'");
	});

	it("does NOT recommend installConnector for a non-installable catalog entry", async () => {
		// The review-caught bug: a stale/unavailable catalog entry
		// (installable:false) was still told to run installConnector, which is
		// guaranteed to fail. Surface the reason instead.
		const deps = makeDeps({
			catalog: {
				catalogs: {
					connectors: {
						entries: [
							{
								id: "spotify",
								name: "Spotify",
								description: "Music",
								detail: {
									installable: false,
									installability_message: "Connector source is no longer available.",
								},
							},
						],
					},
				},
			},
		});
		const hits = await searchLiveConnectors("spotify", env, ctx, deps);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatch(/NOT currently installable/);
		expect(hits[0]).toMatch(/no longer available/);
		expect(hits[0]).not.toMatch(/installConnector/);
	});

	it("only discovers setup for rendered rows, including unavailable catalog rows in the limit", async () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({ id: `demo.limit-${i}`, name: `Demo Limit ${i}`, detail: { installable: i !== 0 } }));
		const deps = makeDeps({ catalog: { catalogs: { connectors: { entries } } } });
		const calls: string[] = [];
		deps.setupOptions = async ({ connector_key }) => {
			calls.push(connector_key);
			return { action: "setup_options", connector_key, cloud_status: "not_configured", options: [] };
		};
		const lines = await searchLiveConnectors("demo.limit", env, ctx, deps);
		expect(lines).toHaveLength(8);
		expect(lines[0]).toContain("NOT currently installable");
		expect(calls).toEqual(entries.slice(1, 8).map(entry => entry.id));
	});

	it("shares one public offer read per search and refreshes it on the next request", async () => {
		let reads = 0;
		const deps = makeDeps({
			catalog: {
				catalogs: {
					connectors: {
						entries: [
							{ id: "demo.mail-a", name: "Demo Mail A", description: "mail" },
							{ id: "demo.mail-b", name: "Demo Mail B", description: "mail" },
						],
					},
				},
			},
		});
		deps.listPublicOrganizations = async () => {
			reads++;
			return [];
		};
		deps.setupOptions = async ({ connector_key }, _ctx, setupDeps) =>
			setupDeps!.publicOptions!(connector_key, "https://gateway.example");

		expect(await searchLiveConnectors("demo.mail", env, ctx, deps)).toHaveLength(2);
		expect(reads).toBe(1);
		await searchLiveConnectors("demo.mail", env, ctx, deps);
		expect(reads).toBe(2);
	});

	it("never leaks credentials or raw connector config", async () => {
		const hits = await searchLiveConnectors("website", env, ctx, makeDeps());
		const json = JSON.stringify(hits);
		expect(json).not.toMatch(/sekret/);
		expect(json).not.toMatch(/auth_schema/);
		expect(json).not.toMatch(/default_connection_config/);
	});

	it("returns empty for a query that names no connector", async () => {
		expect(await searchLiveConnectors("zzz-nothing", env, ctx, makeDeps())).toEqual([]);
	});

	it("returns empty for a blank query (never dumps the whole catalog)", async () => {
		expect(await searchLiveConnectors("", env, ctx, makeDeps())).toEqual([]);
		expect(await searchLiveConnectors("   ", env, ctx, makeDeps())).toEqual([]);
	});

	it("returns nothing for a truly anonymous session (no userId) — no inventory to strangers", async () => {
		// search_sdk is publicly readable, so an anon session on a public workspace
		// can call it — but connector inventory is member context. Anon has no
		// userId, so it's gated here (and the downstream visibility gate would also
		// restrict it).
		const anon = { organizationId: "org-1", userId: null } as ToolContext;
		expect(await searchLiveConnectors("website", env, anon, makeDeps())).toEqual([]);
	});

	it("STILL returns connectors for a logged-in user whose memberRole isn't populated (scoped /mcp/{slug} session)", async () => {
		// Regression: scoped-endpoint sessions carry a userId but often a null
		// memberRole. Gating on memberRole wrongly suppressed discovery for real
		// members. Gate on userId only; the downstream handler enforces the actual
		// per-user visibility.
		const scopedMember = { organizationId: "org-1", userId: "u1", memberRole: null } as ToolContext;
		const hits = await searchLiveConnectors("website", env, scopedMember, makeDeps());
		expect(hits.some((h) => h.includes("'website'"))).toBe(true);
	});

	it("matches a dotted CONNECTOR id (google.calendar), not just single words", async () => {
		// Connector ids are commonly dotted; searchLiveConnectors must find them by
		// exact id. (search_sdk's method-path skip must not swallow these — its
		// first segment 'google' is not an SDK namespace.)
		const deps = makeDeps({
			catalog: {
				catalogs: {
					connectors: {
						entries: [
							{ id: "google.calendar", name: "Google Calendar", description: "Calendar sync" },
						],
					},
				},
			},
		});
		const hits = await searchLiveConnectors("google.calendar", env, ctx, deps);
		expect(hits.some((h) => h.includes("'google.calendar'"))).toBe(true);
	});

	it("drops stopword-only queries so filler words don't match every connector", async () => {
		// "connect a source" is all stopwords → no token → no match (else it would
		// spuriously match on the word 'connect' inside connector descriptions).
		expect(await searchLiveConnectors("connect a source", env, ctx, makeDeps())).toEqual([]);
	});
});
