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
import type { ConnectorWebhookSchema } from "@lobu/connector-sdk";
import GitHubConnector from "@lobu/connectors/github";
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

const fakeSecretStore = { get: async () => null };

/** The router as wired in prod: GitHub plugin + fixed app-secret resolver. */
function buildRouter() {
	return createAppWebhookRoutes({
		installationStore: createPostgresAppInstallationStore(),
		secretStore: fakeSecretStore,
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

async function allInstallEventCount(): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const rows = await getDb()`
    SELECT count(*)::int AS n FROM events WHERE connector_key LIKE 'webhook:app_install:%'
  `;
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
		expect(await allInstallEventCount()).toBe(0);
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
		expect(await allInstallEventCount()).toBe(0);
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
		expect(await allInstallEventCount()).toBe(0);
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
		expect(await allInstallEventCount()).toBe(0);
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
			secretStore: { get: async () => null },
			providers: [createGithubAppWebhookProvider({ appId: APP_ID })],
			resolveAppWebhookSecret: async () => APP_SECRET,
		});

		const res = await coldRouter.fetch(
			issuesDelivery(issuesBody(), { deliveryId: "gh-cold-1" }),
		);
		expect(res.status).toBe(200);
		expect((await res.json()).triggered).toBe(true);
		expect(await feedNextRunAt(feedId)).not.toBeNull();
		expect(await allInstallEventCount()).toBe(0);
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
		expect(await allInstallEventCount()).toBe(0);
	});
});
