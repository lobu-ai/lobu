/**
 * Shared multi-tenant app-webhook router (app-installation design §4.3).
 *
 * Drives the REAL Hono route (`createAppWebhookRoutes`) → declared provider →
 * generic data dispatch → real Postgres, the path an actual App delivery
 * exercises (minus the live provider POST). We hold the app webhook secret, so
 * we compute a real HMAC over the raw body.
 *
 * Every connector-specific fact comes from the connector's own declaration:
 * the webhook schema names the event-type header, and each feed declares the
 * events that update it, the selector that binds a delivery to a feed instance
 * (`webhook.match`), and whether the payload is recorded (`kind: 'record'`).
 * The fixtures persist the REAL github/linear declarations, so a drift between
 * the connector and the dispatcher fails here.
 *
 * Under test (GitHub):
 *  1. A signed delivery marks every matching feed due (fan-out), nothing raw.
 *  2. Selectors: casing, unconfigured repo, malformed or empty selector.
 *  3. The feed's selected definition (pinned version first) decides routing.
 *  4. A star/watch delivery commits a durable record job before the ack and
 *     never marks the stargazers poll due.
 *  5. Forged/wrong-secret/tampered → 401; unknown tenant / no install → 200 ack.
 *
 * Jira declares no webhook event type: its verified deliveries are acked with
 * nothing triggered or stored.
 *
 * The record job's normalize → attributed event → Automation chain needs the
 * isolate executor, so it runs in the vitest integration suite
 * (`__tests__/integration/connectors/github-webhook-delivery.test.ts`).
 */

import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ConnectorWebhookSchema } from "@lobu/connector-sdk";
import GitHubConnector from "@lobu/connectors/github";
import JiraConnector from "@lobu/connectors/jira";
import LinearConnector from "@lobu/connectors/linear";
import { connectorRecordEnqueuer } from "../../connectors/webhook-delivery.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import {
	type AppWebhookProvider,
	createAppWebhookRoutes,
	createDataWebhookDelivery,
	createDeclaredAppWebhookProvider,
	extractTenantFromSchema,
	verifyDeclaredWebhook,
} from "../routes/public/app-webhooks.js";

// The connectors' DECLARED webhook schemas, read off the real definitions so
// the generic engine is driven exactly as the bundled declaration drives it.
const GITHUB_WEBHOOK_SCHEMA = new GitHubConnector().definition
	.webhook as ConnectorWebhookSchema;
const LINEAR_WEBHOOK_SCHEMA = new LinearConnector().definition
	.webhook as ConnectorWebhookSchema;
const JIRA_WEBHOOK_SCHEMA = new JiraConnector().definition
	.webhook as ConnectorWebhookSchema;

let queue: RunsQueue;

/** Build a declared app-webhook provider wired to the generic data dispatch. */
function declaredProvider(
	provider: string,
	appId: string,
	webhookSchema: ConnectorWebhookSchema,
): AppWebhookProvider {
	return createDeclaredAppWebhookProvider({
		provider,
		appId,
		webhookSchema,
		onDelivery: createDataWebhookDelivery(
			{ connectorKey: provider, webhookSchema },
			connectorRecordEnqueuer(queue),
		),
	});
}
import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import { declaredFeedsSchema } from "../../__tests__/setup/test-fixtures.js";
import {
	ensureDbForGatewayTests,
	ensureEncryptionKey,
	resetTestDatabase,
	seedAgentRow,
	seedGithubConnectorDef,
} from "./helpers/db-setup.js";

const ORG = "org-app-webhook";
const AGENT = "agent-app-webhook";
const APP_ID = "654321";
const APP_SECRET = "ghapp-webhook-secret-0123456789abcdef";
const INSTALLATION_ID = "987654";

/** GitHub signs the raw body with the App webhook secret → `sha256=<hex>`. */
function ghSign(rawBody: string, secret = APP_SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Build the router with the GitHub plugin and a fixed app-secret resolver. */
function buildApp() {
	return createAppWebhookRoutes({
		installationStore: createPostgresAppInstallationStore(),
		providers: [declaredProvider("github", APP_ID, GITHUB_WEBHOOK_SCHEMA)],
		resolveAppWebhookSecret: async () => APP_SECRET,
	});
}

/** Seed an ACTIVE github installation for the routed tenant tuple. */
async function seedActiveInstall(): Promise<number> {
	const store = createPostgresAppInstallationStore();
	const row = await store.upsert({
		organizationId: ORG,
		provider: "github",
		providerInstance: "cloud",
		providerAppId: APP_ID,
		externalTenantId: INSTALLATION_ID,
		status: "active",
		metadata: { account: "acme" },
	});
	return row.id;
}

function ghDelivery(
	rawBody: string,
	{
		signature = ghSign(rawBody),
		deliveryId = "gh-app-1",
		event = "issues",
	}: { signature?: string; deliveryId?: string; event?: string } = {},
): Request {
	return new Request("http://gateway.test/api/v1/app-webhooks/github", {
		method: "POST",
		body: rawBody,
		headers: {
			"content-type": "application/json",
			"x-github-event": event,
			"x-github-delivery": deliveryId,
			"x-hub-signature-256": signature,
		},
	});
}

async function eventRows(connectorKey: string): Promise<any[]> {
	const { getDb } = await import("../../db/client.js");
	return getDb()`
    SELECT * FROM events
    WHERE connector_key = ${connectorKey}
    ORDER BY id
  `;
}

/** Count every event in the org: a webhook delivery never stores one itself. */
async function orgEventCount(): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const [row] = await getDb()`
    SELECT count(*)::int AS n FROM events WHERE organization_id = ${ORG}
  `;
	return row.n;
}

/**
 * Seed a github connection bound to `installId` (its config.installation_ref is
 * the app_installations row id, exactly as the install callback writes it) plus
 * one ACTIVE feed for {owner,name} with `next_run_at` NULL. A trigger sets it to
 * now(), so NULL→NOT NULL cleanly proves the webhook marked the feed due.
 */
async function seedGithubFeed(opts: {
	installId: number;
	owner: string;
	name: string;
	feedKey?: string;
	/** A second connection on the same install (another user's OAuth grant). */
	connectionSlug?: string;
	pinnedVersion?: string;
}): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	// One github connection per (install, repo), reused across feed types — so
	// seeding e.g. both issues + commits feeds doesn't collide on the slug.
	const slug = opts.connectionSlug ?? `github-${opts.owner}-${opts.name}`;
	let [conn] = await sql`SELECT id FROM connections WHERE organization_id = ${ORG} AND slug = ${slug}`;
	if (!conn) {
		[conn] = await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, config, visibility, created_at, updated_at
      ) VALUES (
        ${ORG}, 'github', ${slug}, 'GitHub', 'active',
        ${sql.json({ installation_ref: opts.installId })}, 'org', NOW(), NOW()
      )
      RETURNING id
    `;
	}
	const [feed] = await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, display_name, status, config, next_run_at, pinned_version
    ) VALUES (
      ${ORG}, ${conn.id}, ${opts.feedKey ?? "issues"}, 'Issues', 'active',
      ${sql.json({ repo_owner: opts.owner, repo_name: opts.name })}, NULL, ${opts.pinnedVersion ?? null}
    )
    RETURNING id
  `;
	return Number(feed.id);
}

/** Current `next_run_at` of a feed (NULL until a trigger marks it due). */
async function feedNextRunAt(feedId: number): Promise<unknown> {
	const { getDb } = await import("../../db/client.js");
	const [row] = await getDb()`SELECT next_run_at FROM feeds WHERE id = ${feedId}`;
	return row?.next_run_at ?? null;
}

/** Durable `connector-record` jobs committed by deliveries, oldest first. */
async function recordJobs(): Promise<any[]> {
	const { getDb } = await import("../../db/client.js");
	return getDb()`
    SELECT run_type, status, organization_id, action_input FROM runs
    WHERE queue_name = 'internal:connector-record'
    ORDER BY id
  `;
}

/** The persisted github declaration with one feed's `webhook` replaced. */
function githubSchemaWith(
	feedKey: string,
	webhook: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
	const schema = declaredFeedsSchema(new GitHubConnector().definition);
	return { ...schema, [feedKey]: { ...schema[feedKey], webhook } };
}

async function replaceGithubDefinition(
	feedsSchema: Record<string, Record<string, unknown>>,
): Promise<void> {
	const { getDb } = await import("../../db/client.js");
	await getDb()`
    UPDATE connector_definitions SET feeds_schema = ${getDb().json(feedsSchema)}
    WHERE organization_id = ${ORG} AND key = 'github'
  `;
}

const STAR_BODY = {
	action: "created",
	starred_at: "2026-06-20T10:00:00Z",
	installation: { id: Number(INSTALLATION_ID) },
	sender: { login: "Octocat", id: 583231, html_url: "https://github.com/Octocat" },
	repository: { owner: { login: "acme" }, name: "api" },
};

beforeAll(async () => {
	await ensureDbForGatewayTests();
	queue = new RunsQueue();
	await queue.start();
}, 60_000);

afterAll(async () => {
	await queue?.stop();
});

beforeEach(async () => {
	await resetTestDatabase();
	ensureEncryptionKey();
	const { resetRateLimiterForTests } = await import(
		"../../utils/rate-limiter.js"
	);
	resetRateLimiterForTests();
	// Webhook routing is read from the connector definition (feeds_schema), so
	// every github delivery test needs it seeded.
	await seedGithubConnectorDef(ORG);
}, 30_000);

describe("app-webhook router (GitHub)", () => {
	test("an issues delivery marks ONLY the issues feed due (scoped, no raw event)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		// Two feeds on the same repo. An `issues` delivery must trigger only the
		// issues feed — not re-poll commits.
		const issuesFeed = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const commitsFeed = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "api",
			feedKey: "commits",
		});
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: {
				number: 11,
				title: "Prod is down",
				html_url: "https://github.com/acme/api/issues/11",
			},
			repository: { owner: { login: "acme" }, name: "api", full_name: "acme/api" },
		});
		const res = await app.fetch(ghDelivery(raw));
		// Trigger path acks 200 (not 202 — nothing was landed as a record).
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);

		// The poll is the canonical record, so the webhook stores no raw event…
		expect(await orgEventCount()).toBe(0);
		// …it marks the issues feed due (NULL → now()) and leaves commits untouched.
		expect(await feedNextRunAt(issuesFeed)).not.toBeNull();
		expect(await feedNextRunAt(commitsFeed)).toBeNull();
	});

	test("a delivery wakes EVERY matching feed across the install's connections", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		// Two connections on one installation each track acme/api issues (two
		// members' grants), plus an unrelated repo on the first.
		const first = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const second = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "api",
			connectionSlug: "github-second-grant",
		});
		const other = await seedGithubFeed({ installId, owner: "acme", name: "web" });
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 3 },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-fanout" }));
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);
		expect(await feedNextRunAt(first)).not.toBeNull();
		expect(await feedNextRunAt(second)).not.toBeNull();
		expect(await feedNextRunAt(other)).toBeNull();
	});

	test("a delivery wakes every feed key that declares its event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await replaceGithubDefinition(githubSchemaWith("commits", { events: ["push", "issues"], match: { fields: { repo_owner: "repository.owner.login", repo_name: "repository.name" } } }));
		const installId = await seedActiveInstall();
		const issues = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const commits = await seedGithubFeed({ installId, owner: "acme", name: "api", feedKey: "commits" });
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-two-keys" }));
		expect((await res.json()).triggered).toBe(true);
		expect(await feedNextRunAt(issues)).not.toBeNull();
		expect(await feedNextRunAt(commits)).not.toBeNull();
	});

	test("a selector without caseInsensitive compares values exactly", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await replaceGithubDefinition(githubSchemaWith("issues", { events: ["issues"], match: { fields: { repo_owner: "repository.owner.login", repo_name: "repository.name" } } }));
		const installId = await seedActiveInstall();
		const feedId = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const app = buildApp();

		const delivery = (owner: string, id: string) =>
			ghDelivery(
				JSON.stringify({
					action: "opened",
					installation: { id: Number(INSTALLATION_ID) },
					repository: { owner: { login: owner }, name: "api" },
				}),
				{ deliveryId: id },
			);
		expect((await (await app.fetch(delivery("ACME", "gh-exact-1"))).json()).triggered).toBe(false);
		expect(await feedNextRunAt(feedId)).toBeNull();
		expect((await (await app.fetch(delivery("acme", "gh-exact-2"))).json()).triggered).toBe(true);
	});

	test("a delivery whose repo casing differs from the feed config still matches", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const feedId = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 4 },
			repository: { owner: { login: "ACME" }, name: "Api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-casing" }));
		expect((await res.json()).triggered).toBe(true);
		expect(await feedNextRunAt(feedId)).not.toBeNull();
	});

	test("a delivery for an unconfigured repo acks 200 triggered:false and stores nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		// A feed exists, but for a DIFFERENT repo than the delivery is about.
		const otherFeedId = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "other",
		});
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 1, title: "x" },
			repository: { owner: { login: "acme" }, name: "api", full_name: "acme/api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-unconf-1" }));
		expect(res.status).toBe(200);
		// No matching feed for acme/api → triggered:false, a no-op (not an error).
		expect((await res.json()).triggered).toBe(false);
		expect(await orgEventCount()).toBe(0);
		// The unrelated repo's feed was left untouched.
		expect(await feedNextRunAt(otherFeedId)).toBeNull();
	});

	test("a delivery without the selector's payload fields matches no repo-scoped feed", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const feedId = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const app = buildApp();

		// Only full_name: the selector reads owner.login + name, and a missing
		// value never matches (no implicit fallback).
		for (const repository of [
			{ full_name: "acme/api" },
			{ owner: { login: "acme" }, name: "" },
			{ owner: { login: "acme" }, name: { nested: "api" } },
		]) {
			const raw = JSON.stringify({
				action: "opened",
				installation: { id: Number(INSTALLATION_ID) },
				repository,
			});
			const res = await app.fetch(ghDelivery(raw, { deliveryId: `gh-missing-${JSON.stringify(repository)}` }));
			expect((await res.json()).triggered).toBe(false);
		}
		expect(await feedNextRunAt(feedId)).toBeNull();
	});

	test("a malformed declared selector never matches; a feed with no selector matches every instance", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const issuesFeed = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const commitsFeed = await seedGithubFeed({ installId, owner: "acme", name: "web", feedKey: "commits" });
		const app = buildApp();

		const delivery = (event: string, id: string) =>
			ghDelivery(
				JSON.stringify({
					installation: { id: Number(INSTALLATION_ID) },
					repository: { owner: { login: "acme" }, name: "api" },
				}),
				{ event, deliveryId: id },
			);

		for (const match of [{ fields: {} }, { fields: "repo_name" }, { fields: { repo_name: 7 } }, "repo"]) {
			await replaceGithubDefinition(githubSchemaWith("issues", { events: ["issues"], match }));
			const res = await app.fetch(delivery("issues", `gh-malformed-${JSON.stringify(match)}`));
			expect((await res.json()).triggered).toBe(false);
		}
		expect(await feedNextRunAt(issuesFeed)).toBeNull();

		// No selector: the commits feed for acme/web is woken by an acme/api push.
		await replaceGithubDefinition(githubSchemaWith("commits", { events: ["push"] }));
		const res = await app.fetch(delivery("push", "gh-no-selector"));
		expect((await res.json()).triggered).toBe(true);
		expect(await feedNextRunAt(commitsFeed)).not.toBeNull();
	});

	test("a feed pinned to an older definition routes by its pinned declaration", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		// The pinned 0.9.0 definition predates the issues webhook declaration.
		const declared = declaredFeedsSchema(new GitHubConnector().definition);
		await seedGithubConnectorDef(ORG, {
			version: "0.9.0",
			status: "archived",
			feedsSchema: { ...declared, issues: { ...declared.issues, webhook: undefined } },
		});
		const installId = await seedActiveInstall();
		const pinned = await seedGithubFeed({ installId, owner: "acme", name: "api", pinnedVersion: "0.9.0" });
		const current = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "api",
			connectionSlug: "github-current",
		});
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-pinned" }));
		expect((await res.json()).triggered).toBe(true);
		expect(await feedNextRunAt(pinned)).toBeNull();
		expect(await feedNextRunAt(current)).not.toBeNull();
	});

	test("a delivery for an active feed on a PAUSED connection is a no-op", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const feedId = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		// Pause the github connection; the feed row stays active.
		const { getDb } = await import("../../db/client.js");
		await getDb()`
			UPDATE connections SET status = 'paused'
			WHERE organization_id = ${ORG} AND connector_key = 'github'
		`;
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 1, title: "x" },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-paused-conn" }));
		expect(res.status).toBe(200);
		// Connection isn't active → no feed woken, even though the feed row is.
		expect((await res.json()).triggered).toBe(false);
		expect(await feedNextRunAt(feedId)).toBeNull();
	});

	test("a forged signature is rejected with 401 and lands nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 12 },
		});
		const res = await app.fetch(
			ghDelivery(raw, { signature: "sha256=forged" }),
		);
		expect(res.status).toBe(401);
		expect(await orgEventCount()).toBe(0);
	});

	test("a delivery signed with the wrong secret is rejected with 401", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
		});
		const res = await app.fetch(
			ghDelivery(raw, { signature: ghSign(raw, "the-wrong-secret") }),
		);
		expect(res.status).toBe(401);
		expect(await orgEventCount()).toBe(0);
	});

	test("a tampered body (signature over different bytes) is rejected", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedActiveInstall();
		const app = buildApp();

		const signedOver = JSON.stringify({
			installation: { id: Number(INSTALLATION_ID) },
			issue: 1,
		});
		const tampered = JSON.stringify({
			installation: { id: Number(INSTALLATION_ID) },
			issue: 999,
		});
		const res = await app.fetch(
			ghDelivery(tampered, { signature: ghSign(signedOver) }),
		);
		expect(res.status).toBe(401);
		expect(await orgEventCount()).toBe(0);
	});

	test("an unknown tenant (no active install) acks 200 without landing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		// No install seeded — delivery arrives before the install callback.
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: 111222 },
			issue: { number: 1 },
		});
		const res = await app.fetch(ghDelivery(raw));
		// Ack, NOT 500 — the provider must not retry-storm; reconcile on callback.
		expect(res.status).toBe(200);
		expect((await res.json()).landed).toBe(false);
		expect(await orgEventCount()).toBe(0);
	});

	test("a suspended install does not route (transfer demoted it) → 200 ack", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const store = createPostgresAppInstallationStore();
		// Activate then suspend (e.g. ownership transferred away). resolveActive
		// must miss, so the delivery acks without landing.
		const row = await store.upsert({
			organizationId: ORG,
			provider: "github",
			providerInstance: "cloud",
			providerAppId: APP_ID,
			externalTenantId: INSTALLATION_ID,
			status: "active",
		});
		await store.setStatus(row.id, "suspended");
		const app = buildApp();

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
		});
		const res = await app.fetch(ghDelivery(raw));
		expect(res.status).toBe(200);
		expect(await orgEventCount()).toBe(0);
	});

	test("a delivery with no installation in the body acks 200 (no tenant)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedActiveInstall();
		const app = buildApp();

		const raw = JSON.stringify({ action: "ping", zen: "Keep it logically awesome." });
		const res = await app.fetch(ghDelivery(raw));
		expect(res.status).toBe(200);
		expect((await res.json()).landed).toBe(false);
	});

	test("redeliveries and concurrent deliveries just re-stamp next_run_at — still no event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const feedId = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const app = buildApp();

		const raw = JSON.stringify({
			action: "edited",
			installation: { id: Number(INSTALLATION_ID) },
			issue: { number: 9 },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const responses = await Promise.all(
			Array.from({ length: 5 }, () => app.fetch(ghDelivery(raw, { deliveryId: "gh-dupe-1" }))),
		);
		for (const res of responses) {
			expect(res.status).toBe(200);
			expect((await res.json()).triggered).toBe(true);
		}
		// Re-stamping next_run_at is idempotent; the poll (not the webhook) dedupes
		// the actual content by stable origin_id, so still nothing landed raw.
		expect(await feedNextRunAt(feedId)).not.toBeNull();
		expect(await orgEventCount()).toBe(0);
	});

	test("a star delivery commits a record job before the ack, without triggering a poll", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		// The stargazers feed is the poll backstop; the record path must NOT mark
		// it due (re-polling the whole list to capture one star is waste).
		const stargazersFeed = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "api",
			feedKey: "stargazers",
		});
		const app = buildApp();

		const res = await app.fetch(ghDelivery(JSON.stringify(STAR_BODY), { deliveryId: "gh-star-1", event: "star" }));
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);

		// The verified payload is durably queued by the time GitHub sees the ack;
		// the job (not the request) normalizes and ingests it.
		const jobs = await recordJobs();
		expect(jobs).toHaveLength(1);
		expect(jobs[0].run_type).toBe("internal");
		expect(jobs[0].organization_id).toBe(ORG);
		expect(jobs[0].action_input).toMatchObject({
			organizationId: ORG,
			feedId: stargazersFeed,
			eventType: "star",
			payload: STAR_BODY,
		});
		expect(await eventRows("github")).toHaveLength(0);
		expect(await feedNextRunAt(stargazersFeed)).toBeNull();
	});

	test("a watch delivery records through the same feed; differing repo casing still matches", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const stargazersFeed = await seedGithubFeed({ installId, owner: "acme", name: "api", feedKey: "stargazers" });
		const app = buildApp();

		const raw = JSON.stringify({
			...STAR_BODY,
			action: "started",
			repository: { owner: { login: "ACME" }, name: "API" },
		});
		const res = await app.fetch(ghDelivery(raw, { deliveryId: "gh-watch", event: "watch" }));
		expect((await res.json()).triggered).toBe(true);
		const jobs = await recordJobs();
		expect(jobs.map((job) => [job.action_input.feedId, job.action_input.eventType])).toEqual([
			[stargazersFeed, "watch"],
		]);
	});

	test("a star for a repo with no stargazers feed configured is a no-op", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		// An issues feed on the same repo does not declare star.
		await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const app = buildApp();

		const res = await app.fetch(ghDelivery(JSON.stringify(STAR_BODY), { deliveryId: "gh-star-nofeed", event: "star" }));
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(false);
		expect(await recordJobs()).toHaveLength(0);
		expect(await eventRows("github")).toHaveLength(0);
	});

	test("concurrent star deliveries to two matching stargazers feeds each commit a job per feed", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		const first = await seedGithubFeed({ installId, owner: "acme", name: "api", feedKey: "stargazers" });
		const second = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "api",
			feedKey: "stargazers",
			connectionSlug: "github-second-grant",
		});
		const app = buildApp();

		const raw = JSON.stringify(STAR_BODY);
		const responses = await Promise.all([
			app.fetch(ghDelivery(raw, { deliveryId: "gh-star-a", event: "star" })),
			app.fetch(ghDelivery(raw, { deliveryId: "gh-star-b", event: "star" })),
		]);
		for (const res of responses) expect(res.status).toBe(200);
		// Redeliveries are not deduped at the edge: ingest dedupes on origin_id.
		const feeds = (await recordJobs()).map((job) => job.action_input.feedId).sort();
		expect(feeds).toEqual([first, first, second, second].sort());
	});

	test("a push delivery triggers the COMMITS feed (not issues)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedActiveInstall();
		// push maps to the commits feed; an issues feed on the same repo must stay put.
		const commitsFeed = await seedGithubFeed({
			installId,
			owner: "acme",
			name: "api",
			feedKey: "commits",
		});
		const issuesFeed = await seedGithubFeed({ installId, owner: "acme", name: "api" });
		const app = buildApp();

		const raw = JSON.stringify({
			ref: "refs/heads/main",
			installation: { id: Number(INSTALLATION_ID) },
			pusher: { name: "someone" },
			sender: { login: "someone", id: 9 },
			repository: { owner: { login: "acme" }, name: "api" },
		});
		const res = await app.fetch(
			ghDelivery(raw, { deliveryId: "gh-push-1", event: "push" }),
		);
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);
		expect(await feedNextRunAt(commitsFeed)).not.toBeNull();
		expect(await feedNextRunAt(issuesFeed)).toBeNull();
		expect(await recordJobs()).toHaveLength(0);
		expect(await orgEventCount()).toBe(0);
	});

	test("an unknown provider path returns 404", async () => {
		const app = buildApp();
		const res = await app.fetch(
			new Request("http://gateway.test/api/v1/app-webhooks/slack", {
				method: "POST",
				body: JSON.stringify({ team_id: "T1" }),
				headers: { "content-type": "application/json" },
			}),
		);
		expect(res.status).toBe(404);
	});

	test("fails closed with 401 when no app webhook secret is configured", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedActiveInstall();
		const app = createAppWebhookRoutes({
			installationStore: createPostgresAppInstallationStore(),
			providers: [declaredProvider("github", APP_ID, GITHUB_WEBHOOK_SCHEMA)],
			resolveAppWebhookSecret: async () => undefined,
		});

		const raw = JSON.stringify({
			action: "opened",
			installation: { id: Number(INSTALLATION_ID) },
		});
		const res = await app.fetch(ghDelivery(raw));
		expect(res.status).toBe(401);
		expect(await orgEventCount()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Jira — schema-driven verify (`x-hub-signature: sha256=<hex>`), site-host
// tenant. The connector declares no webhook event type, so it has no data hook:
// a verified, routed delivery is acked with nothing triggered or stored.
// ---------------------------------------------------------------------------

const JIRA_APP_ID = "jira-client-id";
const JIRA_SECRET = "jira-webhook-secret-0123456789abcdef";
const JIRA_SITE = "acme.atlassian.net";

/** Jira signs the raw body with the webhook secret → `sha256=<hex>`. */
function jiraSign(rawBody: string, secret = JIRA_SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function buildJiraApp() {
	return createAppWebhookRoutes({
		installationStore: createPostgresAppInstallationStore(),
		providers: [declaredProvider("jira", JIRA_APP_ID, JIRA_WEBHOOK_SCHEMA)],
		resolveAppWebhookSecret: async () => JIRA_SECRET,
	});
}

async function seedJiraInstall(): Promise<number> {
	const store = createPostgresAppInstallationStore();
	const row = await store.upsert({
		organizationId: ORG,
		provider: "jira",
		providerInstance: "cloud",
		providerAppId: JIRA_APP_ID,
		externalTenantId: JIRA_SITE,
		status: "active",
	});
	return row.id;
}

/** An install-bound Jira connection with an active issues feed. */
async function seedJiraIssuesFeed(installId: number): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	await sql`
    INSERT INTO connector_definitions (organization_id, key, name, version, feeds_schema, status)
    VALUES (${ORG}, 'jira', 'Jira', '1.0.0',
      ${sql.json(declaredFeedsSchema(new JiraConnector().definition))}, 'active')
  `;
	const [conn] = await sql`
    INSERT INTO connections (organization_id, connector_key, slug, display_name, status, config, visibility)
    VALUES (${ORG}, 'jira', 'jira', 'Jira', 'active', ${sql.json({ installation_ref: installId })}, 'org')
    RETURNING id
  `;
	const [feed] = await sql`
    INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, config, next_run_at)
    VALUES (${ORG}, ${conn.id}, 'issues', 'Issues', 'active', '{}'::jsonb, NULL)
    RETURNING id
  `;
	return Number(feed.id);
}

function jiraDelivery(
	rawBody: string,
	{ signature = jiraSign(rawBody) }: { signature?: string } = {},
): Request {
	return new Request("http://gateway.test/api/v1/app-webhooks/jira", {
		method: "POST",
		body: rawBody,
		headers: {
			"content-type": "application/json",
			"x-hub-signature": signature,
		},
	});
}

describe("app-webhook router (Jira)", () => {
	test("a signed delivery for a connector with no matching feed is acked and stores nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedJiraInstall();
		const feedId = await seedJiraIssuesFeed(installId);
		const app = buildJiraApp();

		const raw = JSON.stringify({
			webhookEvent: "jira:issue_updated",
			issue: {
				id: "10000",
				key: "ACME-1",
				self: `https://${JIRA_SITE}/rest/api/2/issue/10000`,
				fields: { summary: "Routed, not stored" },
			},
		});
		const res = await app.fetch(jiraDelivery(raw));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, triggered: false });
		// Nothing is stored raw, no feed is woken and no record job is queued.
		expect(await orgEventCount()).toBe(0);
		expect(await feedNextRunAt(feedId)).toBeNull();
		expect(await recordJobs()).toHaveLength(0);
	});

	test("a forged signature is rejected with 401 and lands nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedJiraInstall();
		const app = buildJiraApp();

		const raw = JSON.stringify({
			webhookEvent: "jira:issue_updated",
			issue: { self: `https://${JIRA_SITE}/rest/api/2/issue/1` },
		});
		const res = await app.fetch(jiraDelivery(raw, { signature: "sha256=forged" }));
		expect(res.status).toBe(401);
		expect(await orgEventCount()).toBe(0);
	});

	test("a delivery with no self URL has no tenant → 200 ack, nothing landed", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedJiraInstall();
		const app = buildJiraApp();

		const raw = JSON.stringify({ webhookEvent: "jira:test", timestamp: 1 });
		const res = await app.fetch(jiraDelivery(raw));
		expect(res.status).toBe(200);
		expect((await res.json()).landed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Linear — schema-driven verify (`linear-signature: <hex>`, no prefix),
// organizationId tenant
// ---------------------------------------------------------------------------

const LINEAR_APP_ID = "linear-client-id";
const LINEAR_SECRET = "linear-webhook-secret-0123456789abcdef";
const LINEAR_ORG_ID = "11111111-2222-3333-4444-555555555555";

/** Linear signs the raw body and sends a BARE hex digest (no prefix). */
function linearSign(rawBody: string, secret = LINEAR_SECRET): string {
	return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function buildLinearApp() {
	return createAppWebhookRoutes({
		installationStore: createPostgresAppInstallationStore(),
		providers: [declaredProvider("linear", LINEAR_APP_ID, LINEAR_WEBHOOK_SCHEMA)],
		resolveAppWebhookSecret: async () => LINEAR_SECRET,
	});
}

async function seedLinearInstall(): Promise<number> {
	const store = createPostgresAppInstallationStore();
	const row = await store.upsert({
		organizationId: ORG,
		provider: "linear",
		providerInstance: "cloud",
		providerAppId: LINEAR_APP_ID,
		externalTenantId: LINEAR_ORG_ID,
		status: "active",
	});
	return row.id;
}

function linearDelivery(
	rawBody: string,
	{ signature = linearSign(rawBody) }: { signature?: string } = {},
): Request {
	return new Request("http://gateway.test/api/v1/app-webhooks/linear", {
		method: "POST",
		body: rawBody,
		headers: {
			"content-type": "application/json",
			"linear-signature": signature,
		},
	});
}

/** The org's linear definition (real declaration) + one install-bound issues feed. */
async function seedLinearIssuesFeed(installId: number): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	await sql`
    INSERT INTO connector_definitions (organization_id, key, name, version, feeds_schema, status)
    VALUES (${ORG}, 'linear', 'Linear', '1.0.0',
      ${sql.json(declaredFeedsSchema(new LinearConnector().definition))}, 'active')
  `;
	const [conn] = await sql`
    INSERT INTO connections (organization_id, connector_key, slug, display_name, status, config, visibility)
    VALUES (${ORG}, 'linear', 'linear', 'Linear', 'active', ${sql.json({ installation_ref: installId })}, 'org')
    RETURNING id
  `;
	const [feed] = await sql`
    INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, config, next_run_at)
    VALUES (${ORG}, ${conn.id}, 'issues', 'Issues', 'active', '{}'::jsonb, NULL)
    RETURNING id
  `;
	return Number(feed.id);
}

describe("app-webhook router (Linear)", () => {
	test("a signed Issue delivery routes via organizationId and marks the declared feed due", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const installId = await seedLinearInstall();
		const feedId = await seedLinearIssuesFeed(installId);
		const app = buildLinearApp();

		const delivery = (type: string) =>
			linearDelivery(
				JSON.stringify({
					action: "create",
					type,
					organizationId: LINEAR_ORG_ID,
					data: { id: "abc", title: "Ship it" },
				}),
			);
		// An undeclared event type wakes nothing and lands no raw row.
		const project = await app.fetch(delivery("Project"));
		expect(project.status).toBe(200);
		expect((await project.json()).triggered).toBe(false);
		expect(await feedNextRunAt(feedId)).toBeNull();

		// The body's `type` is the declared discriminator; Issue is declared.
		const issue = await app.fetch(delivery("Issue"));
		expect(issue.status).toBe(200);
		expect((await issue.json()).triggered).toBe(true);
		expect(await feedNextRunAt(feedId)).not.toBeNull();
		expect(await orgEventCount()).toBe(0);
	});

	test("a bare-hex signature with a `sha256=` prefix is rejected (no prefix expected)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedLinearInstall();
		const app = buildLinearApp();

		const raw = JSON.stringify({ organizationId: LINEAR_ORG_ID, action: "create" });
		// Linear sends NO prefix; a `sha256=`-prefixed value must fail.
		const res = await app.fetch(
			linearDelivery(raw, { signature: `sha256=${linearSign(raw)}` }),
		);
		expect(res.status).toBe(401);
		expect(await orgEventCount()).toBe(0);
	});

	test("a delivery with no organizationId has no tenant → 200 ack", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await seedLinearInstall();
		const app = buildLinearApp();

		const raw = JSON.stringify({ action: "create", type: "Issue" });
		const res = await app.fetch(linearDelivery(raw));
		expect(res.status).toBe(200);
		expect((await res.json()).landed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Generic engine — ONE verify + ONE tenant extractor, no provider name
// ---------------------------------------------------------------------------

describe("verifyDeclaredWebhook (the single generic verifier)", () => {
	test("GitHub-shape (plain {body} HMAC) verifies by declaration alone", () => {
		const raw = new TextEncoder().encode("hello");
		const secret = "s3cret";
		const digest = createHmac("sha256", secret).update(raw).digest("hex");
		const good = new Headers({ "x-hub-signature-256": `sha256=${digest}` });
		expect(verifyDeclaredWebhook(raw, good, secret, GITHUB_WEBHOOK_SCHEMA)).toBe(
			true,
		);
		const forged = new Headers({ "x-hub-signature-256": "sha256=deadbeef" });
		expect(verifyDeclaredWebhook(raw, forged, secret, GITHUB_WEBHOOK_SCHEMA)).toBe(
			false,
		);
		const wrongHeader = new Headers({ "x-other": `sha256=${digest}` });
		expect(
			verifyDeclaredWebhook(raw, wrongHeader, secret, GITHUB_WEBHOOK_SCHEMA),
		).toBe(false);
	});

	test("Slack-shape (v0:{ts}:{body} + freshness) verifies by the SAME fn", () => {
		const schema: ConnectorWebhookSchema = {
			signatureHeader: "x-slack-signature",
			algorithm: "sha256",
			signaturePrefix: "v0=",
			signingBaseTemplate: "v0:{timestamp}:{body}",
			timestampHeader: "x-slack-request-timestamp",
			freshnessSeconds: 300,
		};
		const body = JSON.stringify({ team_id: "T1" });
		const raw = new TextEncoder().encode(body);
		const secret = "slack-secret";
		const ts = String(Math.floor(Date.now() / 1000));
		const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
		const good = new Headers({
			"x-slack-request-timestamp": ts,
			"x-slack-signature": sig,
		});
		expect(verifyDeclaredWebhook(raw, good, secret, schema)).toBe(true);

		// A stale timestamp (replay) is rejected even with a valid signature.
		const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 6);
		const staleSig = `v0=${createHmac("sha256", secret).update(`v0:${staleTs}:${body}`).digest("hex")}`;
		const stale = new Headers({
			"x-slack-request-timestamp": staleTs,
			"x-slack-signature": staleSig,
		});
		expect(verifyDeclaredWebhook(raw, stale, secret, schema)).toBe(false);
	});

	test("rejects (no throw) when the schema declares no signatureHeader", () => {
		const raw = new TextEncoder().encode("x");
		expect(
			verifyDeclaredWebhook(raw, new Headers(), "s", { algorithm: "sha256" }),
		).toBe(false);
	});
});

describe("extractTenantFromSchema (the single generic tenant extractor)", () => {
	test("reads a single routingKeyPath (github installation.id, numeric)", () => {
		const raw = new TextEncoder().encode(
			JSON.stringify({ installation: { id: 42 } }),
		);
		expect(
			extractTenantFromSchema(raw, GITHUB_WEBHOOK_SCHEMA, "app-1"),
		).toEqual({
			providerInstance: "cloud",
			providerAppId: "app-1",
			externalTenantId: "42",
		});
	});

	test("ordered routingKeyPaths, first match wins (slack team id)", () => {
		const schema: ConnectorWebhookSchema = {
			signatureHeader: "x-slack-signature",
			routingKeyPaths: ["team_id", "team.id", "event.team_id"],
		};
		const raw = new TextEncoder().encode(
			JSON.stringify({ event: { team_id: "TEV" } }),
		);
		expect(extractTenantFromSchema(raw, schema, "app")?.externalTenantId).toBe(
			"TEV",
		);
	});

	test("url-host transform yields the site host (jira self URL)", () => {
		const raw = new TextEncoder().encode(
			JSON.stringify({ issue: { self: "https://acme.atlassian.net/rest/x" } }),
		);
		expect(
			extractTenantFromSchema(raw, JIRA_WEBHOOK_SCHEMA, "app")?.externalTenantId,
		).toBe("acme.atlassian.net");
	});

	test("no resolvable path → null (acked without landing)", () => {
		const raw = new TextEncoder().encode(JSON.stringify({ zen: "x" }));
		expect(extractTenantFromSchema(raw, GITHUB_WEBHOOK_SCHEMA, "app")).toBeNull();
	});
});

describe("createDeclaredAppWebhookProvider", () => {
	test("throws when the schema declares no signatureHeader (must fail closed)", () => {
		expect(() =>
			createDeclaredAppWebhookProvider({
				provider: "unsigned",
				appId: "x",
				webhookSchema: { algorithm: "sha256" },
			}),
		).toThrow(/signatureHeader/);
	});
});
