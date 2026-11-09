/**
 * Workspace navigation through the REST tool route the web host uses
 * (`POST /api/:org/manage_views` get_navigation / set_navigation), against
 * real Postgres. Covers: automatic defaults while unset; owner writes with
 * compare-and-swap (one of two concurrent writers 409s); member reads but
 * cannot write; canonical validation (duplicate ids, unsafe hrefs, unresolved
 * targets); resolution into real links with typed params; a removed parent
 * never shows its label; a public visitor gets resolved sections only, never
 * the raw document or the `$member` directory; a private workspace's stranger
 * is refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from "../../setup/test-fixtures";
import { post } from "../../setup/test-helpers";
import { executeTool, type AuthContext } from "../../../tools/execute";
import { useViewValidator } from "../../setup/view-validator";
import { viewModule } from "./view-module";
import { upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import { buildViewsNamespace } from "../../../sandbox/namespaces/views";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};
useViewValidator(TEST_ENV);

interface NavResult {
	revision: number;
	config?: unknown;
	sections: Array<{
		id: string;
		label?: string;
		// biome-ignore lint/suspicious/noExplicitAny: assertions read nested fields
		items: Array<Record<string, any>>;
	}>;
	error?: string;
}

describe("workspace navigation", () => {
	let org: { id: string; slug: string };
	let ownerCookie: string;
	let memberCookie: string;
	let dealId: number;
	let memberRecordId: number;

	const call = async (body: Record<string, unknown>, cookie?: string, slug = org.slug) => {
		const res = await post(`/api/${slug}/manage_views`, { body, cookie });
		return { status: res.status, json: (await res.json()) as NavResult };
	};
	const read = (cookie?: string) => call({ action: "get_navigation" }, cookie);
	const write = (expected_revision: number, config: unknown, cookie = ownerCookie) =>
		call({ action: "set_navigation", expected_revision, config }, cookie);

	async function setView(key: string, def: Record<string, unknown>) {
		const owner = (await getTestDb()`SELECT "userId" FROM member WHERE "organizationId" = ${org.id} AND role = 'owner' LIMIT 1`)[0];
		const ctx: AuthContext = {
			organizationId: org.id,
			tokenOrganizationId: org.id,
			userId: owner.userId as string,
			memberRole: "owner",
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "oauth",
			requestUrl: `http://localhost/api/${org.id}`,
			baseUrl: "",
			scopedToOrg: true,
			allowCrossOrg: false,
		};
		await executeTool(
			"manage_views",
			{ action: "set", source_code: viewModule({ key, ...def }) },
			TEST_ENV,
			ctx
		);
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		org = await createTestOrganization({ name: "Nav Org", slug: "nav-org", visibility: "public" });
		const owner = await createTestUser({ email: "nav-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCookie = (await createTestSession(owner.id)).cookieHeader;
		const member = await createTestUser({ email: "nav-member@test.com" });
		await addUserToOrganization(member.id, org.id, "member");
		memberCookie = (await createTestSession(member.id)).cookieHeader;
		dealId = (await createTestEntity({ name: "Acme Renewal", entity_type: "deal", organization_id: org.id })).id;
		memberRecordId = (await createTestEntity({ name: "Directory Person", entity_type: "$member", organization_id: org.id })).id;
		await setView("pipeline", {
			name: "Pipeline",
			attach: [{ workspace: true }, { collection: "deal" }],
			params: { stage: { type: "string" }, open: { type: "boolean" }, page: { type: "number" } },
		});
		await setView("queue", { name: "Work Queue", attach: [{ workspace: true }] });
		await setView("deal-card", { name: "Deal Card", attach: [{ record: "deal" }] });
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	const curated = {
		schemaVersion: 1,
		sections: [
			{
				id: "work",
				label: "Work",
				items: [
					{
						id: "pipeline",
						target: {
							kind: "view",
							key: "pipeline",
							params: { stage: "Ünï & co", open: false, page: 0 },
						},
						children: [
							{ id: "deals", target: { kind: "collection", entityType: "deal" } },
							{ id: "acme", label: "Acme", target: { kind: "record", entityId: 0 } },
							{
								id: "acme-card",
								target: { kind: "view", key: "deal-card", scope: { type: "deal", entity: 0 } },
							},
						],
					},
					{
						id: "reports",
						label: "Reports",
						children: [{ id: "queue", target: { kind: "view", key: "queue" } }],
					},
					{ id: "docs", label: "Docs", target: { kind: "link", href: "https://docs.example/guide" } },
					{ id: "won", label: "Won deals", target: { kind: "link", href: "deal?stage=won" } },
				],
			},
		],
	};
	const curatedFor = (id: number) =>
		JSON.parse(JSON.stringify(curated).replaceAll('"entityId":0', `"entityId":${id}`).replaceAll('"entity":0', `"entity":${id}`));

	it("resolves the automatic default while unset", async () => {
		const { status, json } = await read(memberCookie);
		expect(status).toBe(200);
		expect(json.revision).toBe(0);
		// The raw document is editor material; a member gets resolved sections.
		expect(json.config).toBeUndefined();
		expect((await read(ownerCookie)).json.config).toBeNull();
		expect(json.sections).toEqual([
			{
				id: "views",
				items: [
					{ id: "view:pipeline", label: "Pipeline", href: "/nav-org/data/-/views/pipeline", children: [] },
					{ id: "view:queue", label: "Work Queue", href: "/nav-org/data/-/views/queue", children: [] },
				],
			},
		]);
	});

	it("stores a curated document and resolves it into real links", async () => {
		const saved = await write(0, curatedFor(dealId));
		expect(saved.status).toBe(200);
		expect(saved.json.revision).toBe(1);

		const { json } = await read(memberCookie);
		expect(json.revision).toBe(1);
		expect(json.config).toBeUndefined();
		expect((await read(ownerCookie)).json.config).toEqual(curatedFor(dealId));
		const [pipeline, reports, docs, won] = json.sections[0].items as Array<{
			id: string;
			label: string;
			href?: string;
			external?: boolean;
			children: Array<{ id: string; label: string; href?: string }>;
		}>;
		expect(json.sections[0].label).toBe("Work");
		// Typed scalars survive, including false, 0 and Unicode.
		expect(pipeline.label).toBe("Pipeline");
		expect(new URL(pipeline.href ?? "", "http://x").pathname).toBe("/nav-org/data/-/views/pipeline");
		expect(Object.fromEntries(new URL(pipeline.href ?? "", "http://x").searchParams)).toEqual({
			stage: "Ünï & co",
			open: "false",
			page: "0",
		});
		expect(pipeline.children.map((c) => [c.id, c.label, c.href])).toEqual([
			["deals", "deal", "/nav-org/deal"],
			["acme", "Acme", "/nav-org/deal/acme-renewal"],
			["acme-card", "Deal Card", "/nav-org/deal/acme-renewal/-/views/deal-card"],
		]);
		expect(reports).toMatchObject({ label: "Reports", children: [{ id: "queue", href: "/nav-org/data/-/views/queue" }] });
		expect(reports.href).toBeUndefined();
		expect(docs).toMatchObject({ href: "https://docs.example/guide", external: true });
		expect(won).toMatchObject({ href: "/nav-org/deal?stage=won" });
	});

	it("lets exactly one of two writers at the same revision win", async () => {
		const [a, b] = await Promise.all([
			write(0, curatedFor(dealId)),
			write(0, { schemaVersion: 1, sections: [] }),
		]);
		expect([a.status, b.status].sort()).toEqual([200, 409]);
		const { json } = await read(ownerCookie);
		expect(json.revision).toBe(1);
		const stale = await write(0, null);
		expect(stale.status).toBe(409);
		expect(stale.json.error).toContain("now 1");
		// An empty document is a deliberate "no custom entries", not the default.
		const emptied = await write(1, { schemaVersion: 1, sections: [] });
		expect(emptied.status).toBe(200);
		expect((await read(ownerCookie)).json.sections).toEqual([]);
		// null returns to the automatic default.
		expect((await write(2, null)).status).toBe(200);
		expect((await read(ownerCookie)).json.sections[0].id).toBe("views");
	});

	it("refuses a member's write", async () => {
		const res = await write(0, { schemaVersion: 1, sections: [] }, memberCookie);
		expect(res.status).toBe(403);
		expect((await read(ownerCookie)).json.revision).toBe(0);
	});

	it("validates the document canonically before writing", async () => {
		const dup = await write(0, {
			schemaVersion: 1,
			sections: [{ id: "a", items: [{ id: "a", target: { kind: "view", key: "queue" } }] }],
		});
		expect(dup.status).toBe(400);
		expect(dup.json.error).toContain("duplicate id 'a'");
		for (const href of ["javascript:alert(1)", "../other/x", "/other-org/x", "http://plain.example"]) {
			const bad = await write(0, {
				schemaVersion: 1,
				sections: [{ id: "s", items: [{ id: "l", label: "L", target: { kind: "link", href } }] }],
			});
			expect(bad.status, href).toBe(400);
		}
		const unresolved = await write(0, {
			schemaVersion: 1,
			sections: [
				{
					id: "s",
					items: [
						{ id: "ghost", target: { kind: "view", key: "no-such-view" } },
						{ id: "card-unscoped", target: { kind: "view", key: "deal-card" } },
						{ id: "bad-param", target: { kind: "view", key: "pipeline", params: { page: "two" } } },
					],
				},
			],
		});
		expect(unresolved.status).toBe(400);
		expect(unresolved.json.error).toContain("ghost, card-unscoped, bad-param");
		expect((await read(ownerCookie)).json.revision).toBe(0);
	});

	it("drops a removed destination's label and keeps its readable children", async () => {
		await write(0, curatedFor(dealId));
		await getTestDb()`UPDATE entities SET deleted_at = NOW() WHERE id = ${dealId}`;
		await getTestDb()`DELETE FROM views WHERE organization_id = ${org.id} AND key IN ('queue', 'pipeline')`;
		const { json } = await read(memberCookie);
		const body = JSON.stringify(json.sections);
		expect(body).not.toContain("Acme");
		expect(body).not.toContain("Pipeline");
		// The "Reports" group lost its only child, so it is gone too.
		expect(body).not.toContain("Reports");
		expect(json.sections[0].items.map((i) => i.id)).toEqual(["deals", "docs", "won"]);
	});

	it("holds a thousand views and a tree far deeper than four levels", async () => {
		// Registered views in bulk, cloned from a compiled one (compiling a
		// thousand bundles would only test the compiler).
		await getTestDb()`
      INSERT INTO views (organization_id, key, name, source_code, compiled_code, content_hash, attach, last_writer)
      SELECT organization_id, 'bulk-' || lpad(n::text, 4, '0'), 'Bulk ' || lpad(n::text, 4, '0'),
             source_code, compiled_code, content_hash, attach, last_writer
      FROM views, generate_series(0, 999) AS n
      WHERE organization_id = ${org.id} AND key = 'queue'
    `;
		const defaults = await read(memberCookie);
		expect(defaults.json.sections[0].items).toHaveLength(1002);

		// Twelve levels of groups, a wide group of 300 views, and a removed
		// destination deep inside — its label never shows, its child does.
		let leaf: Record<string, unknown> = {
			id: "deepest",
			label: "Deepest",
			target: { kind: "view", key: "bulk-0500" },
		};
		leaf = {
			id: "gone",
			label: "Gone",
			target: { kind: "view", key: "no-longer-here" },
			children: [leaf],
		};
		for (let level = 11; level >= 1; level -= 1)
			leaf = { id: `level-${level}`, label: `Level ${level}`, children: [leaf] };
		const wide = {
			id: "all-bulk",
			label: "All bulk",
			children: Array.from({ length: 300 }, (_, i) => ({
				id: `bulk-${i}`,
				target: { kind: "view", key: `bulk-${String(i).padStart(4, "0")}` },
			})),
		};
		const config = {
			schemaVersion: 1,
			sections: [{ id: "deep", label: "Deep", items: [leaf, wide] }],
		};
		// The author's write insists every target resolves…
		expect((await write(0, config)).status).toBe(400);
		// …so the destination is removed after it was saved.
		await setView("no-longer-here", { name: "Soon gone", attach: [{ workspace: true }] });
		expect((await write(0, config)).status).toBe(200);
		await getTestDb()`DELETE FROM views WHERE organization_id = ${org.id} AND key = 'no-longer-here'`;

		const { json } = await read(memberCookie);
		const [deep] = json.sections;
		let node = deep.items[0];
		const labels: string[] = [];
		while (node.children.length > 0 && node.label.startsWith("Level")) {
			labels.push(node.label);
			node = node.children[0];
		}
		expect(labels).toHaveLength(11);
		expect(node).toMatchObject({
			id: "deepest",
			label: "Deepest",
			href: "/nav-org/data/-/views/bulk-0500",
		});
		expect(JSON.stringify(json.sections)).not.toContain("Gone");
		expect(deep.items[1].children).toHaveLength(300);
		expect(deep.items[1].children[299]).toMatchObject({
			label: "Bulk 0299",
			href: "/nav-org/data/-/views/bulk-0299",
		});
	});

	it("gives a public visitor resolved sections only, without the member directory", async () => {
		await write(0, {
			schemaVersion: 1,
			sections: [
				{
					id: "s",
					label: "Shared",
					items: [
						{ id: "people", label: "Team directory", target: { kind: "record", entityId: memberRecordId } },
						{ id: "q", target: { kind: "view", key: "queue" } },
					],
				},
			],
		});
		const visitor = await read();
		expect(visitor.status).toBe(200);
		expect(visitor.json.config).toBeUndefined();
		expect(JSON.stringify(visitor.json)).not.toContain("Team directory");
		expect(visitor.json.sections[0].items.map((i) => i.id)).toEqual(["q"]);
		// A member sees the same document resolved for them.
		expect((await read(memberCookie)).json.sections[0].items.map((i) => i.id)).toEqual(["people", "q"]);
		// A visitor cannot write.
		expect((await write(1, null, "")).status).toBeGreaterThanOrEqual(401);
	});

	it("applies a scoped agent's entity read restrictions to every target", async () => {
		const owner = (await getTestDb()`SELECT "userId" FROM member WHERE "organizationId" = ${org.id} AND role = 'owner' LIMIT 1`)[0];
		const principal = await createTestAgent({ organizationId: org.id, ownerUserId: owner.userId as string });
		await write(0, curatedFor(dealId));
		await upsertEntityApprovalPolicy(org.id, {
			principalKind: "agent",
			principalId: principal.agentId,
			entityId: dealId,
			effects: { read: "deny" },
		});
		const agent = buildViewsNamespace(
			{
				organizationId: org.id,
				userId: owner.userId as string,
				memberRole: "owner",
				agentId: principal.agentId,
				isAuthenticated: true,
				clientId: null,
				scopes: ["mcp:read", "mcp:write"],
				tokenType: "oauth",
				scopedToOrg: true,
				allowCrossOrg: false,
				requestUrl: `http://localhost/api/${org.slug}`,
				baseUrl: "",
			} as Parameters<typeof buildViewsNamespace>[0],
			TEST_ENV
		);
		const result = (await agent.getNavigation({ action: "get_navigation" })) as NavResult;
		const body = JSON.stringify(result);
		// Neither the record link nor the view scoped to it, nor the custom label,
		// nor the slug that names the record.
		expect(result.config).toBeUndefined();
		expect(body).not.toContain("Acme");
		expect(body).not.toContain("acme-renewal");
		expect(body).not.toContain("acme-card");
		expect(result.sections[0].items[0].children.map((c: { id: string }) => c.id)).toEqual(["deals"]);
		// The same owner, as a human session, still sees them.
		expect(JSON.stringify((await read(ownerCookie)).json.sections)).toContain("acme-renewal");
	});

	it("refuses a stranger on a private workspace", async () => {
		const priv = await createTestOrganization({ name: "Private", slug: "nav-private" });
		const res = await call({ action: "get_navigation" }, undefined, priv.slug);
		expect(res.status).toBeGreaterThanOrEqual(401);
		expect(res.status).toBeLessThan(500);
	});
});
