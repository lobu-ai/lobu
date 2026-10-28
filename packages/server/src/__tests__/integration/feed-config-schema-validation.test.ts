/**
 * manage_feeds create_feed / update_feed — feed `config` validation against the
 * connector's declared feed configSchema (connector_definitions.feeds_schema).
 *
 * Regression (live-verified on prod 2026-07-15): `feeds.create` accepted
 * `{ config: { url: "https://…" } }` for the rss connector even though its
 * feeds.articles.configSchema declares `required: ['feed_urls']`. The feed row
 * was created "successfully" and only failed at sync time with
 * "feed_urls is required and must be a non-empty array." — zero upfront signal
 * for an MCP client. The fix validates config against the declared JSON Schema
 * on both create_feed and update_feed.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ClientSdkActionError } from "../../sandbox/namespaces/action-call";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";
import { TestApiClient } from "../setup/test-mcp-client";

// Mirror of packages/connectors/src/rss.ts feeds.articles.configSchema.
const RSS_FEEDS_SCHEMA = {
	articles: {
		key: "articles",
		name: "Feed Articles",
		operations: ["sync"],
		configSchema: {
			type: "object",
			required: ["feed_urls"],
			properties: {
				feed_urls: {
					type: "array",
					items: { type: "string", format: "uri" },
					minItems: 1,
				},
				max_items_per_feed: { type: "integer", minimum: 1, maximum: 1000 },
			},
		},
	},
};

describe("manage_feeds config validation against connector configSchema", () => {
	let owner: TestApiClient;
	let orgId: string;
	let rssConnectionId: number;
	let bareConnectionId: number;
	let noSchemaConnectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();

		const org = await createTestOrganization({ name: "Feed Config Org" });
		orgId = org.id;
		const user = await createTestUser({ email: "feed-config@test.com" });
		owner = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});

		await createTestConnectorDefinition({
			key: "rss",
			name: "RSS / Atom",
			organization_id: orgId,
			feeds_schema: RSS_FEEDS_SCHEMA,
		});
		const rssConn = await createTestConnection({
			organization_id: orgId,
			connector_key: "rss",
			created_by: user.id,
			createDefaultFeed: false,
		});
		rssConnectionId = Number(rssConn.id);

		// A connector whose feed declares NO configSchema — any config must pass.
		await createTestConnectorDefinition({
			key: "no-config-schema",
			name: "No Config Schema",
			organization_id: orgId,
			feeds_schema: {
				default: { key: "default", name: "Default", operations: ["sync"] },
			},
		});
		const noSchemaConn = await createTestConnection({
			organization_id: orgId,
			connector_key: "no-config-schema",
			created_by: user.id,
			createDefaultFeed: false,
		});
		noSchemaConnectionId = Number(noSchemaConn.id);

		// A connection with NO connector definition installed at all.
		const bareConn = await createTestConnection({
			organization_id: orgId,
			connector_key: "github",
			created_by: user.id,
			createDefaultFeed: false,
		});
		bareConnectionId = Number(bareConn.id);
	});

	it("rejects create_feed when config violates the declared configSchema (prod repro)", async () => {
		const error = await owner.feeds
			.create({
				connection_id: rssConnectionId,
				feed_key: "articles",
				config: { url: "https://example.com/feed.xml" },
			})
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ClientSdkActionError);
		expect((error as ClientSdkActionError).message).toContain("feed_urls");

		// No feed row leaked into the DB.
		const sql = getTestDb();
		const rows = await sql<{ id: number }[]>`
      SELECT id FROM feeds WHERE connection_id = ${rssConnectionId} AND deleted_at IS NULL
    `;
		expect(rows.length).toBe(0);
	});

	it("rejects create_feed when a config field has the wrong type", async () => {
		const error = await owner.feeds
			.create({
				connection_id: rssConnectionId,
				feed_key: "articles",
				config: { feed_urls: ["https://example.com/feed.xml"], max_items_per_feed: 5000 },
			})
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ClientSdkActionError);
		expect((error as ClientSdkActionError).message).toContain("max_items_per_feed");
	});

	it("accepts create_feed with a schema-valid config", async () => {
		const result = (await owner.feeds.create({
			connection_id: rssConnectionId,
			feed_key: "articles",
			config: { feed_urls: ["https://example.com/feed.xml"] },
		})) as { error?: string; feed?: { id: number } };

		expect(result.error).toBeUndefined();
		expect(result.feed?.id).toBeDefined();
	});

	it("rejects update_feed whose merged config would violate the schema", async () => {
		const created = (await owner.feeds.create({
			connection_id: rssConnectionId,
			feed_key: "articles",
			display_name: "update-target",
			config: { feed_urls: ["https://example.com/a.xml"] },
		})) as { feed?: { id: number } };
		const feedId = Number(created.feed?.id);
		expect(feedId).toBeGreaterThan(0);

		const error = await owner.feeds
			.update({ feed_id: feedId, config: { max_items_per_feed: 5000 } })
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ClientSdkActionError);
		expect((error as ClientSdkActionError).message).toContain("max_items_per_feed");

		// Stored config unchanged.
		const sql = getTestDb();
		const [row] = await sql<{ config: Record<string, unknown> | null }[]>`
      SELECT config FROM feeds WHERE id = ${feedId}
    `;
		expect(row?.config).toEqual({ feed_urls: ["https://example.com/a.xml"] });
	});

	it("rejects update_feed with replace_config that drops a required field", async () => {
		const created = (await owner.feeds.create({
			connection_id: rssConnectionId,
			feed_key: "articles",
			display_name: "replace-target",
			config: { feed_urls: ["https://example.com/b.xml"] },
		})) as { feed?: { id: number } };
		const feedId = Number(created.feed?.id);
		expect(feedId).toBeGreaterThan(0);

		// Raw manage() returns `{ error }` instead of throwing.
		const result = (await owner.feeds.manage({
			action: "update_feed",
			feed_id: feedId,
			config: { max_items_per_feed: 10 },
			replace_config: true,
		})) as { error?: string };

		expect(result.error).toContain("feed_urls");
	});

	it("accepts a partial update_feed whose merged config stays valid", async () => {
		const created = (await owner.feeds.create({
			connection_id: rssConnectionId,
			feed_key: "articles",
			display_name: "merge-target",
			config: { feed_urls: ["https://example.com/c.xml"] },
		})) as { feed?: { id: number } };
		const feedId = Number(created.feed?.id);

		const result = (await owner.feeds.update({
			feed_id: feedId,
			config: { max_items_per_feed: 50 },
		})) as { error?: string; feed?: { config: Record<string, unknown> } };

		expect(result.error).toBeUndefined();
		expect(result.feed?.config).toEqual({
			feed_urls: ["https://example.com/c.xml"],
			max_items_per_feed: 50,
		});
	});

	it("persists AJV type coercions applied during merge-update validation", async () => {
		const created = (await owner.feeds.create({
			connection_id: rssConnectionId,
			feed_key: "articles",
			display_name: "coerce-target",
			config: { feed_urls: ["https://example.com/d.xml"] },
		})) as { feed?: { id: number } };
		const feedId = Number(created.feed?.id);

		// coerceTypes turns "50" into 50 during validation; the STORED patch must
		// be the coerced value, not the original string.
		const result = (await owner.feeds.update({
			feed_id: feedId,
			config: { max_items_per_feed: "50" as unknown as number },
		})) as { error?: string };
		expect(result.error).toBeUndefined();

		const sql = getTestDb();
		const [row] = await sql<{ config: Record<string, unknown> | null }[]>`
      SELECT config FROM feeds WHERE id = ${feedId}
    `;
		expect(row?.config?.max_items_per_feed).toBe(50);
	});

	it("normalizes a coercible LEGACY stored key on merge-update (persisted == validated)", async () => {
		// A pre-fix row can hold a coercible legacy value (string "75"). A merge
		// update of a DIFFERENT key validates the whole merged object; the fix
		// persists exactly that validated object, so the legacy key is normalized.
		const sql = getTestDb();
		const [legacy] = await sql<{ id: number }[]>`
      INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, config, created_at, updated_at)
      VALUES (${orgId}, ${rssConnectionId}, 'articles', 'legacy-config', 'active',
              ${sql.json({ feed_urls: ["https://example.com/legacy.xml"], max_items_per_feed: "75" })}, NOW(), NOW())
      RETURNING id
    `;
		const feedId = Number(legacy?.id);

		const result = (await owner.feeds.update({
			feed_id: feedId,
			config: { feed_urls: ["https://example.com/updated.xml"] },
		})) as { error?: string };
		expect(result.error).toBeUndefined();

		const [row] = await sql<{ config: Record<string, unknown> | null }[]>`
      SELECT config FROM feeds WHERE id = ${feedId}
    `;
		expect(row?.config).toEqual({
			feed_urls: ["https://example.com/updated.xml"],
			max_items_per_feed: 75,
		});
	});

	it("still rejects an unknown feed_key (no regression)", async () => {
		const error = await owner.feeds
			.create({
				connection_id: rssConnectionId,
				feed_key: "not-a-feed",
				config: { feed_urls: ["https://example.com/feed.xml"] },
			})
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ClientSdkActionError);
		expect((error as ClientSdkActionError).message).toContain("Invalid feed_key");
	});

	it("allows create_feed when the feed declares no configSchema", async () => {
		const result = (await owner.feeds.create({
			connection_id: noSchemaConnectionId,
			feed_key: "default",
			config: { anything: "goes", nested: { ok: true } },
		})) as { error?: string; feed?: { id: number } };

		expect(result.error).toBeUndefined();
		expect(result.feed?.id).toBeDefined();
	});

	it("rejects create_feed when the connector has no capability definition", async () => {
		const error = await owner.feeds
			.create({
				connection_id: bareConnectionId,
				feed_key: "default",
				config: { arbitrary: true },
			})
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ClientSdkActionError);
		expect((error as ClientSdkActionError).message).toContain("no sync or read operation");
	});

	describe("schedule (manual default)", () => {
		type FeedResult = {
			error?: string;
			feed?: { id: number; schedule: string | null; next_run_at: string | null };
		};

		it("create_feed without schedule persists schedule/next_run_at NULL; an explicit cron still schedules", async () => {
			const manual = (await owner.feeds.create({
				connection_id: noSchemaConnectionId,
				feed_key: "default",
				display_name: "manual",
			})) as FeedResult;
			expect(manual.error).toBeUndefined();
			expect(manual.feed?.schedule).toBeNull();
			expect(manual.feed?.next_run_at).toBeNull();

			const scheduled = (await owner.feeds.create({
				connection_id: noSchemaConnectionId,
				feed_key: "default",
				display_name: "daily",
				schedule: "0 9 * * *",
			})) as FeedResult;
			expect(scheduled.error).toBeUndefined();
			expect(scheduled.feed?.schedule).toBe("0 9 * * *");
			expect(scheduled.feed?.next_run_at).toBeTruthy();
		});

		it("update_feed schedule null clears auto-poll", async () => {
			const created = (await owner.feeds.create({
				connection_id: noSchemaConnectionId,
				feed_key: "default",
				display_name: "twice daily",
				schedule: "0 */12 * * *",
			})) as FeedResult;
			const feedId = Number(created.feed?.id);
			expect(feedId).toBeGreaterThan(0);

			const updated = (await owner.feeds.update({
				feed_id: feedId,
				schedule: null,
			})) as FeedResult;
			expect(updated.error).toBeUndefined();
			expect(updated.feed?.schedule).toBeNull();
			expect(updated.feed?.next_run_at).toBeNull();
		});
	});
});
