/**
 * App-installation END-TO-END integration (the gate before live GitHub).
 *
 * The per-PR unit tests each cover a slice: PR2 the `app_installations` table +
 * store (reject/transfer/converge), PR3 the `InstallationTokenProvider` minting,
 * PR4 the shared `/app-webhooks/:provider` router. This test ties them into ONE
 * flow against REAL embedded Postgres — proving the slices line up across the PR
 * boundaries (the webhook `connector_key` the router lands on, the install row
 * shape `resolveExecutionAuth` reads, the active-tenant invariant the store and
 * the router agree on).
 *
 * Chain under test:
 *   1. install (store.upsert) → signed GitHub `issues` delivery → router →
 *      generic data dispatch marks the OWNING org's declared feeds due (no raw
 *      event — github is poll-canonical); redelivery just re-stamps next_run_at;
 *      a star commits a durable record job for the stargazers feed.
 *   2. reject/transfer: org A active → transfer to org B (atomic demote+activate)
 *      → delivery now triggers B's feeds, not A's; a 2nd concurrent active insert
 *      for the same tenant is rejected by the partial unique index.
 *   3. token mint via `resolveExecutionAuth`: an app_installation-backed
 *      connection mints + returns a usable bearer credential, with the GitHub
 *      `/access_tokens` exchange MOCKED (registry seam / injected fetch — never
 *      api.github.com); a revoked/suspended install → null creds, no crash.
 *   4. multi-replica: (a) a delivery lands with NO warm in-memory state (stateless,
 *      Postgres-mediated); (b) concurrent install upserts for one tenant converge
 *      to exactly one active row (advisory-lock path).
 *   5. unknown install (delivery before the install callback) → 200 ack, no event.
 */

import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type {
	ConnectorAuthAppInstallation,
	ConnectorWebhookSchema,
} from "@lobu/connector-sdk";
import GitHubConnector from "@lobu/connectors/github";
import ShopifyConnector from "@lobu/connectors/shopify";
import { claimPendingConnection } from "../connections/connection-claim.js";
import {
	getTenantDataInstall,
	tenantInstallClaimProvider,
} from "../connections/tenant-install-claim.js";
import { primeAppInstallationMethods } from "../installation/app-install-credentials.js";
import { RefreshTokenInstallationTokenProvider } from "../installation/refresh-token-installation-token-provider.js";
import { createInstallRoutes } from "../routes/public/app-install.js";
import { connectorRecordEnqueuer } from "../../connectors/webhook-delivery.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import {
	createAppWebhookRoutes,
	createDataWebhookDelivery,
	createDeclaredAppWebhookProvider,
} from "../routes/public/app-webhooks.js";
import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store.js";

/** GitHub's DECLARED webhook schema, read off the real connector definition. */
const GITHUB_WEBHOOK_SCHEMA = new GitHubConnector().definition
	.webhook as ConnectorWebhookSchema;

let queue: RunsQueue;

/** Build a github app-webhook provider from the declared schema + generic dispatch. */
function createGithubAppWebhookProvider(options: { appId: string }) {
	return createDeclaredAppWebhookProvider({
		provider: "github",
		appId: options.appId,
		webhookSchema: GITHUB_WEBHOOK_SCHEMA,
		onDelivery: createDataWebhookDelivery(
			{ connectorKey: "github", webhookSchema: GITHUB_WEBHOOK_SCHEMA },
			connectorRecordEnqueuer(queue),
		),
	});
}
import {
	ensureDbForGatewayTests,
	ensureEncryptionKey,
	resetTestDatabase,
	seedAgentRow,
	seedGithubConnectorDef,
	seedOrgMembership,
} from "./helpers/db-setup.js";

// One Lobu GitHub App receiving deliveries for many installed tenants.
const APP_ID = "112233";
const APP_SECRET = "ghapp-e2e-secret-0123456789abcdef0123";
const PROVIDER = "github";
const INSTANCE = "cloud";
const TENANT = "5550001"; // external installation_id

const ORG_A = "org-e2e-a";
const ORG_B = "org-e2e-b";
const AGENT_A = "agent-e2e-a";
const AGENT_B = "agent-e2e-b";

const CONNECTOR_KEY = "github-org";
// Gateway env var NAMES the connector's app_installation method points at. The
// VALUES are read gateway-side; the row never holds the App id or private key.
const APP_ID_ENV = "GITHUB_APP_ID";
const PRIVATE_KEY_ENV = "GITHUB_APP_PRIVATE_KEY";

/** GitHub signs the raw body with the App webhook secret → `sha256=<hex>`. */
function ghSign(rawBody: string, secret = APP_SECRET): string {
	return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** The router as wired in prod: GitHub plugin + fixed app-secret resolver. */
function buildRouter() {
	return createAppWebhookRoutes({
		installationStore: createPostgresAppInstallationStore(),
		providers: [createGithubAppWebhookProvider({ appId: APP_ID })],
		resolveAppWebhookSecret: async () => APP_SECRET,
	});
}

function issuesDelivery(
	body: Record<string, unknown>,
	{
		signature,
		deliveryId = "gh-e2e-1",
		event = "issues",
	}: { signature?: string; deliveryId?: string; event?: string } = {},
): Request {
	const raw = JSON.stringify(body);
	return new Request("http://gateway.test/api/v1/app-webhooks/github", {
		method: "POST",
		body: raw,
		headers: {
			"content-type": "application/json",
			"x-github-event": event,
			"x-github-delivery": deliveryId,
			"x-hub-signature-256": signature ?? ghSign(raw),
		},
	});
}

function issuesBody(tenant = TENANT, extra: Record<string, unknown> = {}) {
	return {
		action: "opened",
		installation: { id: Number(tenant) },
		issue: { number: 42, title: "Prod is on fire" },
		repository: { owner: { login: "acme" }, name: "api", full_name: "acme/api" },
		...extra,
	};
}

/** Every stored event, across orgs: a webhook delivery never stores one itself. */
async function allEventCount(): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const rows = await getDb()`SELECT count(*)::int AS n FROM events`;
	return rows[0].n as number;
}

/** Durable `connector-record` jobs committed by deliveries, oldest first. */
async function recordJobs(): Promise<any[]> {
	const { getDb } = await import("../../db/client.js");
	return getDb()`
    SELECT organization_id, action_input FROM runs
    WHERE queue_name = 'internal:connector-record'
    ORDER BY id
  `;
}

/**
 * Seed a `github` connection (the trigger path keys on connector_key='github')
 * bound to `installId` via config.installation_ref, plus one ACTIVE feed (default
 * `issues`) for {owner,name} with next_run_at NULL. A trigger flips it to now(),
 * so NULL→NOT NULL proves the webhook marked the org's feed due. The connection
 * is reused per (org, repo) so multiple feed types don't collide on the slug.
 */
async function seedGithubFeed(
	organizationId: string,
	installId: number,
	owner = "acme",
	name = "api",
	feedKey = "issues",
): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	const slug = `gh-feed-${organizationId}-${owner}-${name}`;
	let [conn] = await sql`SELECT id FROM connections WHERE organization_id = ${organizationId} AND slug = ${slug}`;
	if (!conn) {
		[conn] = await sql`
      INSERT INTO connections (organization_id, connector_key, slug, status, config)
      VALUES (
        ${organizationId}, ${"github"}, ${slug},
        ${"active"}, ${sql.json({ installation_ref: installId })}
      )
      RETURNING id
    `;
	}
	const [feed] = await sql`
    INSERT INTO feeds (organization_id, connection_id, feed_key, status, config, next_run_at)
    VALUES (
      ${organizationId}, ${conn.id}, ${feedKey}, ${"active"},
      ${sql.json({ repo_owner: owner, repo_name: name })}, NULL
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

/** Reset a feed back to "not due" so a later delivery's effect is observable. */
async function clearFeedDue(feedId: number): Promise<void> {
	const { getDb } = await import("../../db/client.js");
	await getDb()`UPDATE feeds SET next_run_at = NULL WHERE id = ${feedId}`;
}

/** Seed one active github install for a tenant tuple under an org. */
async function seedActiveInstall(
	organizationId: string,
	tenant = TENANT,
): Promise<number> {
	const store = createPostgresAppInstallationStore();
	const row = await store.upsert({
		organizationId,
		provider: PROVIDER,
		providerInstance: INSTANCE,
		providerAppId: APP_ID,
		externalTenantId: tenant,
		status: "active",
		metadata: { account: organizationId },
	});
	return row.id;
}

/**
 * Seed a `connections` row backed by an `app_installation` connector, bound to
 * `installId` via `config.installation_ref` — the exact shape
 * `resolveAppInstallationCredential` reads. Returns the connection id.
 */
async function seedAppInstallationConnection(
	organizationId: string,
	connectionId: number,
	installId: number,
): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();

	// connector_definitions row whose auth_schema declares app_installation (the
	// JOIN in resolveAppInstallationCredential keys on key + org + active status).
	await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, auth_schema, status
    )
    VALUES (
      ${organizationId}, ${CONNECTOR_KEY}, ${"GitHub Org"}, ${"1.0.0"},
      ${sql.json({
				methods: [
					{
						type: "app_installation",
						provider: PROVIDER,
						providerInstance: INSTANCE,
						appIdKey: APP_ID_ENV,
						privateKeyKey: PRIVATE_KEY_ENV,
					},
				],
			})},
      ${"active"}
    )
    ON CONFLICT DO NOTHING
  `;

	await sql`
    INSERT INTO connections (
      id, organization_id, connector_key, slug, status, config
    )
    VALUES (
      ${connectionId}, ${organizationId}, ${CONNECTOR_KEY},
      ${`conn-${connectionId}`}, ${"active"},
      ${sql.json({ installation_ref: installId })}
    )
  `;
	return connectionId;
}

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
	// Each token-mint test installs its own registry; reset so a stale per-pod
	// singleton from a prior test can never leak across cases.
	const { __resetInstallationTokenRegistryForTests } = await import(
		"../installation/registry.js"
	);
	__resetInstallationTokenRegistryForTests();
	// Webhook routing is read from the connector definition; seed it for both
	// orgs (the transfer case routes to ORG_B).
	await seedGithubConnectorDef(ORG_A);
	await seedGithubConnectorDef(ORG_B);
}, 30_000);

afterEach(async () => {
	const { __resetInstallationTokenRegistryForTests } = await import(
		"../installation/registry.js"
	);
	__resetInstallationTokenRegistryForTests();
});

describe("app-installation e2e: install → webhook → trigger (happy path)", () => {
	test("a signed delivery routes to the owning org and marks its feeds due, storing no raw event", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		const installId = await seedActiveInstall(ORG_A);
		const feedId = await seedGithubFeed(ORG_A, installId);
		const router = buildRouter();

		// First delivery triggers the org's feed (next_run_at NULL → now()).
		const res = await router.fetch(
			issuesDelivery(issuesBody(), { deliveryId: "gh-happy-1" }),
		);
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);

		// github is a poll-canonical connector: the webhook stores no raw event…
		expect(await allEventCount()).toBe(0);
		// …it just marks the affected feed due, in the install's owning org.
		expect(await feedNextRunAt(feedId)).not.toBeNull();

		// Redelivery is idempotent: re-stamps next_run_at, still lands no event.
		await clearFeedDue(feedId);
		const redelivery = await router.fetch(
			issuesDelivery(issuesBody(), { deliveryId: "gh-happy-1" }),
		);
		expect(redelivery.status).toBe(200);
		expect((await redelivery.json()).triggered).toBe(true);
		expect(await feedNextRunAt(feedId)).not.toBeNull();
		expect(await allEventCount()).toBe(0);
	});
});

describe("app-installation e2e: star delivery recorded (event-complete)", () => {
	test("a star commits a record job for the install's stargazers feed before the ack, no poll", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		const installId = await seedActiveInstall(ORG_A);
		// The record path is gated on a configured stargazers feed (like the trigger
		// path). Also seed an issues feed to prove the star doesn't touch it.
		const stargazersFeed = await seedGithubFeed(ORG_A, installId, "acme", "api", "stargazers");
		const issuesFeed = await seedGithubFeed(ORG_A, installId);
		const router = buildRouter();

		const starBody = {
			action: "created",
			starred_at: "2026-06-20T10:00:00Z",
			installation: { id: Number(TENANT) },
			sender: { login: "Octocat", id: 583231 },
			repository: { owner: { login: "acme" }, name: "api" },
		};
		const res = await router.fetch(
			issuesDelivery(starBody, { deliveryId: "gh-star-e2e", event: "star" }),
		);
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);

		// The verified payload is a durable job in the owning org by the ack; the
		// job normalizes it into the stargazer event (vitest integration suite).
		const jobs = await recordJobs();
		expect(jobs).toHaveLength(1);
		expect(jobs[0].organization_id).toBe(ORG_A);
		expect(jobs[0].action_input).toMatchObject({ feedId: stargazersFeed, eventType: "star", payload: starBody });
		// Record, not trigger: no feed is marked due and no raw event lands.
		expect(await feedNextRunAt(stargazersFeed)).toBeNull();
		expect(await feedNextRunAt(issuesFeed)).toBeNull();
		expect(await allEventCount()).toBe(0);
	});
});

describe("app-installation e2e: reject / transfer ownership", () => {
	test("transfer re-routes deliveries to org B and stops routing to org A", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		await seedAgentRow(AGENT_B, { organizationId: ORG_B });
		const store = createPostgresAppInstallationStore();

		// Org A installs first.
		const a = await store.upsert({
			organizationId: ORG_A,
			provider: PROVIDER,
			providerInstance: INSTANCE,
			providerAppId: APP_ID,
			externalTenantId: TENANT,
			status: "active",
		});
		const feedA = await seedGithubFeed(ORG_A, a.id);
		const router = buildRouter();

		// A delivery triggers org A's feed.
		const first = await router.fetch(
			issuesDelivery(issuesBody(), { deliveryId: "gh-xfer-1" }),
		);
		expect(first.status).toBe(200);
		expect(await feedNextRunAt(feedA)).not.toBeNull();
		// Reset so a later trigger of org A's feed (which must NOT happen) is visible.
		await clearFeedDue(feedA);

		// Org B re-installs the SAME tenant → transfer (A demoted, B active) in one tx.
		const b = await store.upsert({
			organizationId: ORG_B,
			provider: PROVIDER,
			providerInstance: INSTANCE,
			providerAppId: APP_ID,
			externalTenantId: TENANT,
			status: "active",
		});
		expect(b.id).not.toBe(a.id);
		expect(b.organizationId).toBe(ORG_B);
		const feedB = await seedGithubFeed(ORG_B, b.id);

		// Prior owner demoted (kept for audit), exactly one active owner remains.
		const aAfter = await store.getById(a.id);
		expect(aAfter?.status).toBe("suspended");
		const active = await store.resolveActiveByTenant({
			provider: PROVIDER,
			providerInstance: INSTANCE,
			providerAppId: APP_ID,
			externalTenantId: TENANT,
		});
		expect(active?.id).toBe(b.id);
		expect(active?.organizationId).toBe(ORG_B);

		// A new delivery now triggers org B's feed, NOT org A's.
		const second = await router.fetch(
			issuesDelivery(issuesBody(), { deliveryId: "gh-xfer-2" }),
		);
		expect(second.status).toBe(200);
		expect(await feedNextRunAt(feedB)).not.toBeNull();
		// Org A's feed was left untouched — routing follows the active install.
		expect(await feedNextRunAt(feedA)).toBeNull();
		// No raw events on either side throughout the transfer.
		expect(await allEventCount()).toBe(0);
	});

	test("a 2nd concurrent active insert for the same tenant is rejected by the unique index", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();

		// First active row claims the partial-unique slot.
		await createPostgresAppInstallationStore().upsert({
			organizationId: ORG_A,
			provider: PROVIDER,
			providerInstance: INSTANCE,
			providerAppId: APP_ID,
			externalTenantId: TENANT,
			status: "active",
		});

		// A RAW second active insert for the SAME tuple (bypassing the store's
		// transfer transaction) must violate app_installations_active_tenant.
		let violated = false;
		try {
			await sql`
        INSERT INTO app_installations (
          organization_id, provider, provider_instance, provider_app_id,
          external_tenant_id, status, metadata
        )
        VALUES (
          ${ORG_B}, ${PROVIDER}, ${INSTANCE}, ${APP_ID},
          ${TENANT}, ${"active"}, ${sql.json({})}
        )
      `;
		} catch (error) {
			violated = (error as { code?: string }).code === "23505";
		}
		expect(violated).toBe(true);

		// Still exactly one active owner.
		const rows = await sql`
      SELECT count(*)::int AS n FROM app_installations
      WHERE provider = ${PROVIDER} AND provider_instance = ${INSTANCE}
        AND provider_app_id = ${APP_ID} AND external_tenant_id = ${TENANT}
        AND status = 'active'
    `;
		expect(rows[0].n).toBe(1);
	});
});

describe("app-installation e2e: token mint via resolveExecutionAuth", () => {
	test("an app_installation connection mints + returns a usable bearer credential (exchange MOCKED)", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		const installId = await seedActiveInstall(ORG_A);
		const connectionId = 90001;
		await seedAppInstallationConnection(ORG_A, connectionId, installId);

		// MOCK the registry's github provider so NOTHING reaches api.github.com.
		// This is the same registry seam resolveExecutionAuth mints through.
		const MINTED = "ghs_minted_installation_token_abc123";
		const EXPIRES = new Date(Date.now() + 3600_000).toISOString();
		let mintCalls = 0;
		const { getInstallationTokenRegistry } = await import(
			"../installation/registry.js"
		);
		getInstallationTokenRegistry().register({
			provider: "github",
			async mintToken(install) {
				mintCalls += 1;
				// The connector method's env-var names are stamped onto the row by
				// resolveExecutionAuth — assert that wiring lines up across the PRs.
				expect(install.id).toBe(installId);
				expect(install.metadata.appIdKey).toBe(APP_ID_ENV);
				expect(install.metadata.privateKeyKey).toBe(PRIVATE_KEY_ENV);
				return { token: MINTED, expiresAt: EXPIRES };
			},
		});

		const { resolveExecutionAuth } = await import(
			"../../utils/execution-context.js"
		);
		const { getDb } = await import("../../db/client.js");
		const result = await resolveExecutionAuth({
			organizationId: ORG_A,
			connectionId,
			credentialDb: getDb() as any,
		});

		expect(mintCalls).toBe(1);
		expect(result.credentials).not.toBeNull();
		expect(result.credentials?.provider).toBe("github");
		expect(result.credentials?.accessToken).toBe(MINTED);
		expect(result.credentials?.expiresAt).toBe(EXPIRES);
	});

	test("the GitHub provider's /access_tokens exchange is reachable via an injected fetch (no real network)", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		const installId = await seedActiveInstall(ORG_A);
		const connectionId = 90002;
		await seedAppInstallationConnection(ORG_A, connectionId, installId);

		// Drive the REAL GitHubInstallationTokenProvider (App JWT signing + the
		// exchange) but inject a fetch that stands in for api.github.com — the
		// `fetchImpl` seam PR3's own tests use. A throwaway RSA key signs the JWT.
		const { generateKeyPairSync } = await import("node:crypto");
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

		const MINTED = "ghs_real_provider_path_token_xyz";
		const EXPIRES = new Date(Date.now() + 3600_000).toISOString();
		let exchangedUrl = "";
		const fetchImpl = (async (url: string) => {
			exchangedUrl = String(url);
			return new Response(
				JSON.stringify({ token: MINTED, expires_at: EXPIRES }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const { GitHubInstallationTokenProvider } = await import(
			"../installation/github-installation-token-provider.js"
		);
		const { getInstallationTokenRegistry } = await import(
			"../installation/registry.js"
		);
		getInstallationTokenRegistry().register(
			new GitHubInstallationTokenProvider({
				env: { [APP_ID_ENV]: APP_ID, [PRIVATE_KEY_ENV]: pem },
				fetchImpl,
			}),
		);

		const { resolveExecutionAuth } = await import(
			"../../utils/execution-context.js"
		);
		const { getDb } = await import("../../db/client.js");
		const result = await resolveExecutionAuth({
			organizationId: ORG_A,
			connectionId,
			credentialDb: getDb() as any,
		});

		expect(result.credentials?.accessToken).toBe(MINTED);
		// Exchanged against the install's external tenant id — never live GitHub
		// in this test, but the URL proves the right installation was targeted.
		expect(exchangedUrl).toBe(
			`https://api.github.com/app/installations/${TENANT}/access_tokens`,
		);
	});

	test("a revoked install yields null credentials and does not crash", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		const installId = await seedActiveInstall(ORG_A);
		const connectionId = 90003;
		await seedAppInstallationConnection(ORG_A, connectionId, installId);

		// Revoke the install after the connection was bound. The registry refuses
		// to mint for a non-active install (install_inactive) before any provider
		// exchange — resolveExecutionAuth must surface null creds, never throw.
		await createPostgresAppInstallationStore().setStatus(installId, "revoked");

		// A mock provider that would THROW if reached — it must never be reached,
		// since mintFor short-circuits on the non-active status.
		const { getInstallationTokenRegistry } = await import(
			"../installation/registry.js"
		);
		getInstallationTokenRegistry().register({
			provider: "github",
			async mintToken() {
				throw new Error("provider must not be reached for a revoked install");
			},
		});

		const { resolveExecutionAuth } = await import(
			"../../utils/execution-context.js"
		);
		const { getDb } = await import("../../db/client.js");
		const result = await resolveExecutionAuth({
			organizationId: ORG_A,
			connectionId,
			credentialDb: getDb() as any,
		});
		expect(result.credentials).toBeNull();
	});

	test("a suspended install (exchange 404) yields null credentials, no crash", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		const installId = await seedActiveInstall(ORG_A);
		const connectionId = 90004;
		await seedAppInstallationConnection(ORG_A, connectionId, installId);

		// Keep the row 'active' but have the provider exchange fail (the classic
		// 404 = removed/suspended on GitHub's side). Drive the real provider with
		// an injected fetch returning 404 — resolveExecutionAuth maps the
		// InstallationTokenError onto null creds, not a 500.
		const { generateKeyPairSync } = await import("node:crypto");
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ message: "Not Found" }), {
				status: 404,
			})) as unknown as typeof fetch;

		const { GitHubInstallationTokenProvider } = await import(
			"../installation/github-installation-token-provider.js"
		);
		const { getInstallationTokenRegistry } = await import(
			"../installation/registry.js"
		);
		getInstallationTokenRegistry().register(
			new GitHubInstallationTokenProvider({
				env: { [APP_ID_ENV]: APP_ID, [PRIVATE_KEY_ENV]: pem },
				fetchImpl,
			}),
		);

		const { resolveExecutionAuth } = await import(
			"../../utils/execution-context.js"
		);
		const { getDb } = await import("../../db/client.js");
		const result = await resolveExecutionAuth({
			organizationId: ORG_A,
			connectionId,
			credentialDb: getDb() as any,
		});
		expect(result.credentials).toBeNull();
	});
});

describe("app-installation e2e: multi-replica safety", () => {
	test("a delivery triggers with NO warm in-memory state (stateless, Postgres-mediated)", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		const installId = await seedActiveInstall(ORG_A);
		const feedId = await seedGithubFeed(ORG_A, installId);

		// Simulate a COLD pod: a freshly-built router + a freshly-built store, no
		// memoized instance, no warm cache. The delivery must still resolve the
		// install from Postgres and mark the feed due — proving any replica can
		// serve any delivery.
		const coldRouter = createAppWebhookRoutes({
			installationStore: createPostgresAppInstallationStore(),
			providers: [createGithubAppWebhookProvider({ appId: APP_ID })],
			resolveAppWebhookSecret: async () => APP_SECRET,
		});

		const res = await coldRouter.fetch(
			issuesDelivery(issuesBody(), { deliveryId: "gh-cold-1" }),
		);
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);
		expect(await feedNextRunAt(feedId)).not.toBeNull();
		expect(await allEventCount()).toBe(0);
	});

	test("concurrent install upserts for one tenant converge to exactly one active row", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		await seedAgentRow(AGENT_B, { organizationId: ORG_B });

		// Two independent stores (two pods) race to activate the SAME tenant — one
		// for org A, one for org B. The advisory-lock + partial-unique-index path
		// must serialize them to a single active owner, no crash.
		const storeA = createPostgresAppInstallationStore();
		const storeB = createPostgresAppInstallationStore();
		const upsert = (
			store: ReturnType<typeof createPostgresAppInstallationStore>,
			org: string,
		) =>
			store.upsert({
				organizationId: org,
				provider: PROVIDER,
				providerInstance: INSTANCE,
				providerAppId: APP_ID,
				externalTenantId: TENANT,
				status: "active",
			});

		const results = await Promise.allSettled([
			upsert(storeA, ORG_A),
			upsert(storeB, ORG_B),
			upsert(storeA, ORG_A),
			upsert(storeB, ORG_B),
		]);
		// The transfer path never throws — every caller resolves (transfer demotes
		// the prior owner under the lock rather than colliding on the index).
		const rejected = results.filter((r) => r.status === "rejected");
		expect(rejected.length).toBe(0);

		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const active = await sql`
      SELECT count(*)::int AS n FROM app_installations
      WHERE provider = ${PROVIDER} AND provider_instance = ${INSTANCE}
        AND provider_app_id = ${APP_ID} AND external_tenant_id = ${TENANT}
        AND status = 'active'
    `;
		expect(active[0].n).toBe(1);
	});
});

describe("app-installation e2e: unknown install (delivery before callback)", () => {
	test("a delivery for a tenant with no install acks 200, lands no event, does not throw", async () => {
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		// No install seeded — the provider delivered before the install callback.
		const router = buildRouter();

		const res = await router.fetch(
			issuesDelivery(issuesBody("9999999"), { deliveryId: "gh-unknown-1" }),
		);
		expect(res.status).toBe(200);
		expect((await res.json()).landed).toBe(false);
		expect(await allEventCount()).toBe(0);
	});
});

// ---- tenant-scoped data install (Shopify app) -------------------------------

const SHOPIFY_METHOD = (
	new ShopifyConnector().definition.authSchema as {
		methods: ConnectorAuthAppInstallation[];
	}
).methods.find((m) => m.type === "app_installation") as ConnectorAuthAppInstallation;
const SHOP = "acme-store.myshopify.com";
const INSTALLER = "user-shop-installer";
const SHOPIFY_ENV = {
	SHOPIFY_CLIENT_ID: "shopify-e2e-client",
	SHOPIFY_CLIENT_SECRET: "shopify-e2e-secret",
};

interface TokenCall {
	url: string;
	form: Record<string, string>;
}

/** A fake tenant token endpoint: records each call, answers with `respond`. */
function fakeTokenEndpoint(
	respond: (call: TokenCall) => Promise<Response> | Response,
) {
	const calls: TokenCall[] = [];
	const fetchImpl = async (url: string, init: RequestInit) => {
		const call = {
			url,
			form: Object.fromEntries(new URLSearchParams(String(init.body))),
		};
		calls.push(call);
		return respond(call);
	};
	return { calls, fetchImpl };
}

function tokenResponse(access: string, refresh: string): Response {
	return Response.json({
		access_token: access,
		refresh_token: refresh,
		expires_in: 3600,
		refresh_token_expires_in: 7_776_000,
		scope: "read_orders,read_products,read_inventory,read_customers",
	});
}

function buildShopifyInstallRouter(
	fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
) {
	return createInstallRoutes({
		installationStore: createPostgresAppInstallationStore(),
		resolveInstallOrgId: async () => null,
		verifyInstallOrgAccess: async () => false,
		verifyInstallOrgAdminAccess: async () => false,
		getPublicGatewayUrl: () => "https://gateway.test",
		integrations: [
			{
				connectorKey: "shopify",
				provider: "shopify",
				method: SHOPIFY_METHOD,
				deliveryKind: "data",
			},
		],
		resolveInstallUserId: (c) => c.req.header("x-test-user") ?? null,
		fetchTenantTokenEndpoint: fetchImpl,
	});
}

function startInstall(router: ReturnType<typeof createInstallRoutes>, shop: string) {
	return router.request(
		`https://gateway.test/shopify/install?shop=${encodeURIComponent(shop)}`,
		{ headers: { "x-test-user": INSTALLER } },
	);
}

/** Start an install and return the state the authorize redirect carries. */
async function installState(
	router: ReturnType<typeof createInstallRoutes>,
): Promise<string> {
	const res = await startInstall(router, SHOP);
	expect(res.status).toBe(302);
	const location = new URL(res.headers.get("location") as string, "https://gateway.test");
	return location.searchParams.get("state") as string;
}

function callback(
	router: ReturnType<typeof createInstallRoutes>,
	params: Record<string, string>,
) {
	return router.request(
		`https://gateway.test/shopify/oauth_callback?${new URLSearchParams(params)}`,
	);
}

async function pendingShopifyRows(): Promise<any[]> {
	const { getDb } = await import("../../db/client.js");
	return getDb()`
		SELECT id, organization_id, status, provider_app_id, external_tenant_id, metadata
		FROM app_installations
		WHERE provider = 'shopify' AND organization_id IS NULL
	`;
}

/** Claim engine deps backed by the seeded `member` rows. */
const CLAIM_DEPS = {
	resolveMemberOrgs: async () => [],
	resolveOrgIfMember: async (userId: string, orgSlugOrId: string) => {
		const { getDb } = await import("../../db/client.js");
		const [row] = await getDb()`
			SELECT "organizationId" AS id FROM "member"
			WHERE "userId" = ${userId} AND "organizationId" = ${orgSlugOrId}
		`;
		return (row?.id as string | undefined) ?? null;
	},
	resolveOrgSlug: async (organizationId: string) => organizationId,
};

/** Drive install → callback → claim into `organizationId`; returns the claim ref. */
async function installAndClaim(organizationId: string): Promise<string> {
	const { fetchImpl } = fakeTokenEndpoint(() =>
		tokenResponse("shpat_initial", "shprt_initial"),
	);
	const router = buildShopifyInstallRouter(fetchImpl);
	const state = await installState(router);
	const res = await callback(router, { code: "code-1", shop: SHOP, state });
	expect(res.status).toBe(302);
	const ref = new URL(res.headers.get("location") as string, "https://gateway.test").searchParams.get(
		"ref",
	) as string;
	const install = getTenantDataInstall("shopify");
	expect(install).not.toBeNull();
	const result = await claimPendingConnection(
		tenantInstallClaimProvider(install as NonNullable<typeof install>, {
			store: createPostgresAppInstallationStore(),
		}),
		CLAIM_DEPS,
		{ userId: INSTALLER, ref, organizationId },
	);
	expect(result.status).toBe("ok");
	return ref;
}

async function activeShopifyInstall(organizationId: string) {
	const store = createPostgresAppInstallationStore();
	const row = await store.getByTenantAndOrg(
		{
			provider: "shopify",
			providerInstance: "cloud",
			providerAppId: SHOPIFY_ENV.SHOPIFY_CLIENT_ID,
			externalTenantId: SHOP,
		},
		organizationId,
	);
	expect(row?.status).toBe("active");
	return row as NonNullable<typeof row>;
}

/** Replace the install's stored grant (e.g. with an already-expired token). */
async function storeGrant(
	organizationId: string,
	authProfileId: number,
	grant: Record<string, unknown>,
): Promise<void> {
	const { persistAuthCredentials } = await import(
		"../../utils/auth-credential-secrets.js"
	);
	await persistAuthCredentials({ organizationId, authProfileId, credentials: grant });
}

async function storedGrant(
	organizationId: string,
	authProfileId: number,
): Promise<Record<string, unknown>> {
	const { getDb } = await import("../../db/client.js");
	const { resolveAuthCredentials } = await import(
		"../../utils/auth-credential-secrets.js"
	);
	const [row] = await getDb()`
		SELECT auth_data FROM auth_profiles WHERE id = ${authProfileId}
	`;
	return resolveAuthCredentials({
		organizationId,
		authProfileId,
		authData: row.auth_data,
		appInstallationRenewal: true,
	});
}

describe("app-installation e2e: tenant data install (Shopify app)", () => {
	const savedEnv: Record<string, string | undefined> = {};
	beforeEach(async () => {
		for (const [key, value] of Object.entries(SHOPIFY_ENV)) {
			savedEnv[key] = process.env[key];
			process.env[key] = value;
		}
		await seedAgentRow(AGENT_A, { organizationId: ORG_A });
		await seedOrgMembership(ORG_A, INSTALLER, "owner");
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test("the start route rejects any shop that does not fully match the declared pattern", async () => {
		const { calls, fetchImpl } = fakeTokenEndpoint(() =>
			tokenResponse("unused", "unused"),
		);
		const router = buildShopifyInstallRouter(fetchImpl);
		for (const shop of [
			"evil.example.com",
			`${SHOP}.evil.test`,
			`${SHOP}/admin`,
			`evil.test/${SHOP}`,
			"-acme.myshopify.com",
			".myshopify.com",
			`user@${SHOP}`,
		]) {
			const res = await startInstall(router, shop);
			expect(res.status, shop).toBe(400);
		}
		expect(calls).toHaveLength(0);

		// Signed out: bounced to login with the install as the return target.
		const anonymous = await router.request(
			`https://gateway.test/shopify/install?shop=${SHOP}`,
		);
		expect(anonymous.status).toBe(302);
		expect(anonymous.headers.get("location")).toContain(
			encodeURIComponent(`/shopify/install?shop=${SHOP}`),
		);

		// A valid shop redirects to ITS OWN authorize host with comma-joined scopes.
		const ok = await startInstall(router, SHOP);
		expect(ok.status).toBe(302);
		const location = new URL(ok.headers.get("location") as string);
		expect(location.origin).toBe(`https://${SHOP}`);
		expect(location.pathname).toBe("/admin/oauth/authorize");
		expect(location.searchParams.get("client_id")).toBe(
			SHOPIFY_ENV.SHOPIFY_CLIENT_ID,
		);
		expect(location.searchParams.get("scope")).toBe(
			"read_orders,read_products,read_inventory,read_customers",
		);
		expect(location.searchParams.get("redirect_uri")).toBe(
			"https://gateway.test/shopify/oauth_callback",
		);
		expect(location.searchParams.get("state")).toBeTruthy();
	});

	test("a callback whose shop differs from the state-bound shop is rejected and burns the state", async () => {
		const { calls, fetchImpl } = fakeTokenEndpoint(() =>
			tokenResponse("shpat_x", "shprt_x"),
		);
		const router = buildShopifyInstallRouter(fetchImpl);
		const state = await installState(router);

		const mismatched = await callback(router, {
			code: "code-1",
			shop: "other-store.myshopify.com",
			state,
		});
		expect(mismatched.status).toBe(400);
		// The state is one-time: replaying it with the right shop also fails.
		const replay = await callback(router, { code: "code-1", shop: SHOP, state });
		expect(replay.status).toBe(400);
		expect(calls).toHaveLength(0);
		expect(await pendingShopifyRows()).toHaveLength(0);
	});

	test("install → callback parks an encrypted grant on an org-less pending row", async () => {
		const { calls, fetchImpl } = fakeTokenEndpoint(() =>
			tokenResponse("shpat_initial", "shprt_initial"),
		);
		const router = buildShopifyInstallRouter(fetchImpl);
		const state = await installState(router);

		const res = await callback(router, {
			code: "code-1",
			shop: SHOP,
			state,
			hmac: "unverified",
			host: "aG9zdA",
			timestamp: "1700000000",
		});
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location") as string, "https://gateway.test");
		expect(location.pathname).toBe("/connector/shopify/connection");

		// The code was exchanged at the SHOP's token endpoint, asking for an
		// expiring (refreshable) offline token.
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`https://${SHOP}/admin/oauth/access_token`);
		expect(calls[0].form).toEqual({
			client_id: SHOPIFY_ENV.SHOPIFY_CLIENT_ID,
			client_secret: SHOPIFY_ENV.SHOPIFY_CLIENT_SECRET,
			code: "code-1",
			expiring: "1",
		});

		const rows = await pendingShopifyRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("pending");
		expect(rows[0].external_tenant_id).toBe(SHOP);
		expect(rows[0].provider_app_id).toBe(SHOPIFY_ENV.SHOPIFY_CLIENT_ID);
		expect(rows[0].metadata.external_id).toBe(location.searchParams.get("ref"));
		expect(rows[0].metadata.installer_user_id).toBe(INSTALLER);
		// Encrypted at rest: neither token appears in the row.
		expect(typeof rows[0].metadata.tokens_enc).toBe("string");
		expect(JSON.stringify(rows[0].metadata)).not.toContain("shpat_initial");
		expect(JSON.stringify(rows[0].metadata)).not.toContain("shprt_initial");
	});

	test("claim binds the install into the org: active row + auth profile + connection", async () => {
		const ref = await installAndClaim(ORG_A);
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();

		const active = await activeShopifyInstall(ORG_A);
		expect(active.authProfileId).not.toBeNull();
		expect(await storedGrant(ORG_A, active.authProfileId as number)).toMatchObject({
			access_token: "shpat_initial",
			refresh_token: "shprt_initial",
		});

		const connections = await sql`
			SELECT connector_key, status, config FROM connections
			WHERE organization_id = ${ORG_A} AND deleted_at IS NULL
		`;
		expect(connections).toHaveLength(1);
		expect(connections[0].connector_key).toBe("shopify");
		expect(connections[0].config).toMatchObject({
			installation_ref: active.id,
			shop: SHOP,
		});

		// The consumed setup row stays org-less and no longer carries the grant.
		const [setup] = await pendingShopifyRows();
		expect(setup.metadata.claimed).toBe(true);
		expect(setup.metadata.tokens_enc).toBeUndefined();

		// A second claim of the same ref is an idempotent no-op, not a duplicate.
		const again = await claimPendingConnection(
			tenantInstallClaimProvider(
				getTenantDataInstall("shopify") as NonNullable<
					ReturnType<typeof getTenantDataInstall>
				>,
				{ store: createPostgresAppInstallationStore() },
			),
			CLAIM_DEPS,
			{ userId: INSTALLER, ref, organizationId: ORG_A },
		);
		expect(again.status).toBe("ok");
		const [{ n }] = await sql`
			SELECT count(*)::int AS n FROM connections WHERE organization_id = ${ORG_A}
		`;
		expect(n).toBe(1);
	});

	test("the claimed connection resolves a short-lived access token, never the refresh token", async () => {
		await installAndClaim(ORG_A);
		await primeAppInstallationMethods([
			{ connectorKey: "shopify", provider: "shopify" },
		]);
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const [connection] = await sql`
			SELECT id FROM connections WHERE organization_id = ${ORG_A}
		`;
		const { resolveExecutionAuth } = await import(
			"../../utils/execution-context.js"
		);
		const result = await resolveExecutionAuth({
			organizationId: ORG_A,
			connectionId: Number(connection.id),
			credentialDb: sql as any,
		});
		expect(result.credentials?.provider).toBe("shopify");
		expect(result.credentials?.accessToken).toBe("shpat_initial");
		expect(JSON.stringify(result)).not.toContain("shprt_initial");

		// The worker-facing resolver refuses the install's profile outright.
		const active = await activeShopifyInstall(ORG_A);
		const [profile] = await sql`
			SELECT auth_data FROM auth_profiles WHERE id = ${active.authProfileId}
		`;
		const { resolveAuthCredentials } = await import(
			"../../utils/auth-credential-secrets.js"
		);
		await expect(
			resolveAuthCredentials({
				organizationId: ORG_A,
				authProfileId: active.authProfileId as number,
				authData: profile.auth_data,
			}),
		).rejects.toThrow("only available to gateway token renewal");
	});

	test("concurrent renewal on two pods makes ONE upstream refresh and persists the rotated token", async () => {
		await installAndClaim(ORG_A);
		await primeAppInstallationMethods([
			{ connectorKey: "shopify", provider: "shopify" },
		]);
		const active = await activeShopifyInstall(ORG_A);
		const authProfileId = active.authProfileId as number;
		await storeGrant(ORG_A, authProfileId, {
			access_token: "shpat_expired",
			refresh_token: "shprt_r1",
			expires_at: new Date(Date.now() - 60_000).toISOString(),
		});

		const { calls, fetchImpl } = fakeTokenEndpoint(async () => {
			// Hold the row lock long enough for the other pod to queue behind it.
			await new Promise((resolve) => setTimeout(resolve, 100));
			return tokenResponse("shpat_r2", "shprt_r2");
		});
		const podA = new RefreshTokenInstallationTokenProvider({ fetchImpl });
		const podB = new RefreshTokenInstallationTokenProvider({ fetchImpl });
		const [a, b] = await Promise.all([
			podA.mintToken(active),
			podB.mintToken(active),
		]);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`https://${SHOP}/admin/oauth/access_token`);
		expect(calls[0].form).toEqual({
			grant_type: "refresh_token",
			refresh_token: "shprt_r1",
			client_id: SHOPIFY_ENV.SHOPIFY_CLIENT_ID,
			client_secret: SHOPIFY_ENV.SHOPIFY_CLIENT_SECRET,
		});
		expect(a.token).toBe("shpat_r2");
		expect(b.token).toBe("shpat_r2");
		expect(await storedGrant(ORG_A, authProfileId)).toMatchObject({
			access_token: "shpat_r2",
			refresh_token: "shprt_r2",
		});
	});

	test("a refused refresh (401) marks the install error and fails the mint", async () => {
		await installAndClaim(ORG_A);
		await primeAppInstallationMethods([
			{ connectorKey: "shopify", provider: "shopify" },
		]);
		const active = await activeShopifyInstall(ORG_A);
		await storeGrant(ORG_A, active.authProfileId as number, {
			access_token: "shpat_expired",
			refresh_token: "shprt_revoked",
			expires_at: new Date(Date.now() - 60_000).toISOString(),
		});
		const { calls, fetchImpl } = fakeTokenEndpoint(
			() => new Response("{}", { status: 401 }),
		);
		const pod = new RefreshTokenInstallationTokenProvider({ fetchImpl });
		await expect(pod.mintToken(active)).rejects.toMatchObject({
			reason: "exchange_failed",
			status: 401,
		});
		expect(calls).toHaveLength(1);
		const { getDb } = await import("../../db/client.js");
		const [row] = await getDb()`
			SELECT status FROM app_installations WHERE id = ${active.id}
		`;
		expect(row.status).toBe("error");
	});
});
