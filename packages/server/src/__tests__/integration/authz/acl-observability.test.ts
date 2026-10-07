/**
 * ACL observability — integration tests against real Postgres.
 *
 * Pins the three surfaces of ACL-failure observability:
 *  1. a failing ACL sync persists its reason on `connections.error_message`
 *     under the `acl: ` prefix, never clobbers another subsystem's text, and
 *     clears only ACL-owned text once the sync recovers;
 *  2. a connection whose ACL graph is fail-closed
 *     (`authz_source_acl_state.freshness_state='failed'`) is flagged
 *     `acl_failed` by the connector-health alerter, alerting exactly once per
 *     episode through the existing `unhealthy_alerted_at` claim;
 *  3. deleting a connection removes its `authz_source_acl_state` row.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	clearConnectionAclError,
	clearRetainedAclErrorMessage,
	formatAclErrorMessage,
	isAclErrorMessage,
	markConnectionAclFailed,
} from "../../../authz/acl-observability";
import {
	runGithubAclSyncTick,
	syncGithubConnectionAcl,
} from "../../../authz/github-acl-sync";
import { runConnectorHealthCheck } from "../../../connectors/connector-health";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { TestApiClient } from "../../setup/test-mcp-client";

// The connector-health scan skips connections younger than
// minConnectionAgeHours (24h default); backdate fixtures so the ACL rule runs.
const OLD = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

async function seedAclFailedConnection(opts: {
	orgId: string;
	errorMessage: string;
}): Promise<{ id: number }> {
	const sql = getTestDb();
	const conn = await createTestConnection({
		organization_id: opts.orgId,
		connector_key: "github",
		visibility: "org",
		createDefaultFeed: false,
	});
	await sql`
    UPDATE connections SET created_at = ${OLD()}, updated_at = ${OLD()} WHERE id = ${conn.id}
  `;
	// A healthy feed, so no FEED rule can be what flags the connection — only the
	// fail-closed ACL state may.
	await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status,
      last_sync_status, last_sync_at, consecutive_failures, created_at, updated_at
    ) VALUES (
      ${opts.orgId}, ${conn.id}, 'ok', 'active',
      'success', now(), 0, now(), now()
    )
  `;
	await sql`
    INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
    VALUES (${opts.orgId}, ${String(conn.id)}, 'full', 'failed', now() - interval '1 hour')
  `;
	await sql`
    UPDATE connections SET error_message = ${opts.errorMessage} WHERE id = ${conn.id}
  `;
	return { id: conn.id };
}

describe("acl observability", () => {
	afterAll(async () => {
		await cleanupTestDatabase();
	});
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	describe("failure reason persistence", () => {
		it("persists an acl:-prefixed failure reason when a sync fails", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Reason Org" });
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				visibility: "org",
				createDefaultFeed: false,
			});
			await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
        VALUES (${org.id}, ${String(conn.id)}, 'full', 'fresh', now())
      `;

			// Drive the production sync path with a failing GitHub call.
			const result = await syncGithubConnectionAcl(
				{
					listRepos: async () => [{ owner: "acme", repo: "repo-a" }],
					fetchCollaborators: async () => {
						throw new Error("401 Unauthorized — GitHub token is not valid");
					},
				},
				{ connectionId: String(conn.id), organizationId: org.id },
			);
			expect(result.ok).toBe(false);

			const [state] = await sql`
        SELECT freshness_state FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
			expect(state?.freshness_state).toBe("failed");

			const [row] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
			expect(isAclErrorMessage(row?.error_message)).toBe(true);
			expect(row?.error_message).toContain("GitHub ACL sync failed");
			expect(row?.error_message).toContain("401 Unauthorized");
		});

		it("marks an existing ACL graph failed when its repository feeds drop to zero", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Empty Repos Org" });
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				visibility: "org",
				createDefaultFeed: false,
			});
			await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
        VALUES (${org.id}, ${String(conn.id)}, 'full', 'fresh', now())
      `;

			const result = await syncGithubConnectionAcl(
				{
					listRepos: async () => [],
					fetchCollaborators: async () => {
						throw new Error("must not fetch collaborators without repository feeds");
					},
				},
				{ connectionId: String(conn.id), organizationId: org.id },
			);

			expect(result).toEqual({ ok: false, reposSynced: 0 });
			const [state] = await sql`
        SELECT freshness_state FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
			expect(state?.freshness_state).toBe("failed");

			const [row] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
			expect(row?.error_message).toBe(
				formatAclErrorMessage(
					"GitHub ACL sync unavailable: no repository feeds configured",
				),
			);
		});

		it("caps the complete persisted failure message at 500 characters", () => {
			expect(formatAclErrorMessage("x".repeat(1_000))).toHaveLength(500);
		});

		it("never clobbers a non-ACL error_message when an ACL sync fails", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Collision Org" });
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				visibility: "org",
				createDefaultFeed: false,
			});
			await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
        VALUES (${org.id}, ${String(conn.id)}, 'full', 'fresh', now())
      `;
			// A feed-sync owned message occupies the shared column.
			await sql`
        UPDATE connections SET error_message = 'Feed sync failed: HTTP 429 rate limited' WHERE id = ${conn.id}
      `;

			await syncGithubConnectionAcl(
				{
					listRepos: async () => [{ owner: "acme", repo: "repo-a" }],
					fetchCollaborators: async () => {
						throw new Error("401 Unauthorized");
					},
				},
				{ connectionId: String(conn.id), organizationId: org.id },
			);

			const [row] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
			expect(row?.error_message).toBe(
				"Feed sync failed: HTTP 429 rate limited",
			);
		});

		it("clears only acl:-owned text once the sync recovers", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Clear Org" });
			const aclOwned = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				display_name: "Acl-owned Conn",
				createDefaultFeed: false,
			});
			const feedOwned = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				display_name: "Feed-owned Conn",
				createDefaultFeed: false,
			});
			const newerFailure = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				display_name: "Newer ACL Failure Conn",
				createDefaultFeed: false,
			});
			await sql`
        UPDATE connections SET error_message = ${formatAclErrorMessage("GitHub ACL sync failed: 401")} WHERE id = ${aclOwned.id}
      `;
			await sql`
        UPDATE connections SET error_message = 'Feed sync failed: HTTP 429' WHERE id = ${feedOwned.id}
      `;
			await sql`
        UPDATE connections SET error_message = ${formatAclErrorMessage("GitHub ACL sync failed: 403")} WHERE id = ${newerFailure.id}
      `;
			await sql`
        INSERT INTO authz_source_acl_state (
          organization_id, connection_id, acl_support, freshness_state
        ) VALUES
          (${org.id}, ${String(aclOwned.id)}, 'full', 'fresh'),
          (${org.id}, ${String(feedOwned.id)}, 'full', 'fresh'),
          (${org.id}, ${String(newerFailure.id)}, 'full', 'failed')
      `;

			await clearConnectionAclError(org.id, String(aclOwned.id));
			await clearConnectionAclError(org.id, String(feedOwned.id));
			await clearConnectionAclError(org.id, String(newerFailure.id));

			const [afterAcl, afterFeed, afterNewerFailure] = await Promise.all([
				sql`SELECT error_message FROM connections WHERE id = ${aclOwned.id}`,
				sql`SELECT error_message FROM connections WHERE id = ${feedOwned.id}`,
				sql`SELECT error_message FROM connections WHERE id = ${newerFailure.id}`,
			]);
			expect(afterAcl[0]?.error_message).toBeNull();
			expect(afterFeed[0]?.error_message).toBe("Feed sync failed: HTTP 429");
			expect(afterNewerFailure[0]?.error_message).toContain("403");
		});

		it("leaves connections.updated_at untouched when the same failure repeats", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Repeat Org" });
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				visibility: "org",
				createDefaultFeed: false,
			});
			await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
        VALUES (${org.id}, ${String(conn.id)}, 'full', 'fresh', now())
      `;

			const failWith = (message: string) =>
				syncGithubConnectionAcl(
					{
						listRepos: async () => [{ owner: "acme", repo: "repo-a" }],
						fetchCollaborators: async () => {
							throw new Error(message);
						},
					},
					{ connectionId: String(conn.id), organizationId: org.id },
				);

			await failWith("401 Unauthorized");
			const [firstConn] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
			expect(isAclErrorMessage(firstConn?.error_message)).toBe(true);

			// Backdate both rows to a fixed sentinel so "was it rewritten?" is an
			// exact-value question rather than a sub-millisecond clock comparison,
			// which two consecutive transactions can lose.
			const SENTINEL = "2001-01-01T00:00:00.000Z";
			await sql`UPDATE connections SET updated_at = ${SENTINEL} WHERE id = ${conn.id}`;
			await sql`
        UPDATE authz_source_acl_state SET updated_at = ${SENTINEL}
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;

			// The ACL sync retries on a fixed tick. `connections.updated_at` is the
			// memo key chat adapters hydrate against, so an unchanged failure must
			// not rewrite the row — otherwise every tick rehydrates live Slack
			// instances for the length of the outage.
			await failWith("401 Unauthorized");
			const [repeatConn] = await sql`
        SELECT updated_at FROM connections WHERE id = ${conn.id}
      `;
			const [repeatState] = await sql`
        SELECT updated_at FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
			expect(repeatConn?.updated_at).toEqual(new Date(SENTINEL));
			// Unlike the shared connection row, ACL state must record every failure.
			// The timestamp and generation fences keep an older in-flight sync from
			// overwriting a newer repeated failure.
			expect(repeatState?.updated_at).not.toEqual(new Date(SENTINEL));

			// A genuinely different reason still lands — the guard suppresses
			// duplicates, not updates.
			await failWith("403 Forbidden — SAML enforcement");
			const [changedConn] = await sql`
        SELECT error_message, updated_at FROM connections WHERE id = ${conn.id}
      `;
			expect(changedConn?.error_message).toContain("403 Forbidden");
			expect(changedConn?.updated_at).not.toEqual(new Date(SENTINEL));
		});

		it("does not erase a failure that commits while a clear is already waiting", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Clear Race Org" });
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				visibility: "org",
				createDefaultFeed: false,
			});
			await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
        VALUES (${org.id}, ${String(conn.id)}, 'full', 'fresh', now())
      `;
			await sql`
        UPDATE connections SET error_message = ${formatAclErrorMessage("older failure")}
        WHERE id = ${conn.id}
      `;

			let signalLocked!: () => void;
			let releaseFailure!: () => void;
			const locked = new Promise<void>((resolve) => {
				signalLocked = resolve;
			});
			const release = new Promise<void>((resolve) => {
				releaseFailure = resolve;
			});

			// An in-flight failure that already holds the connection lock but has
			// not yet written. This is the window the clear must not slip through.
			const failing = sql.begin(async (tx) => {
				await tx`SELECT 1 FROM connections WHERE id = ${conn.id} FOR UPDATE`;
				signalLocked();
				await release;
				await tx`
          UPDATE connections SET error_message = ${formatAclErrorMessage("newer failure")}
          WHERE id = ${conn.id}
        `;
				await tx`
          UPDATE authz_source_acl_state SET freshness_state = 'failed', updated_at = clock_timestamp()
          WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
        `;
			});

			await locked;
			// Start the clear while the failure holds the lock, so it blocks with a
			// pre-failure view of freshness, then let the failure commit under it.
			const clearing = clearConnectionAclError(org.id, String(conn.id));
			await new Promise((resolve) => setTimeout(resolve, 150));
			releaseFailure();
			await failing;
			await clearing;

			const [state] = await sql`
        SELECT freshness_state FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
			const [row] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
			// A failed state with no recorded reason is precisely the blindness this
			// module exists to remove, so the reason must survive the losing clear.
			expect(state?.freshness_state).toBe("failed");
			expect(row?.error_message).toBe(formatAclErrorMessage("newer failure"));
		});

		it("skips a consent-only grant-holder instead of marking it ACL-failed", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Consent Only Org" });
			// A consent-only grant-holder holds an OAuth grant for delegation and
			// `manage_feeds` refuses feeds on it BY CONSTRUCTION, so a feedless sweep
			// is its steady state — not an outage to downgrade the graph over.
			const consentOnly = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				config: { consent_only: true },
				createDefaultFeed: false,
			});
			// A NORMAL connection that has no feeds must still fail closed; the skip
			// is scoped to consent-only, never a blanket "empty means fine".
			const regular = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				createDefaultFeed: false,
			});

			await runGithubAclSyncTick();

			const [consentRow] = await sql`
        SELECT error_message FROM connections WHERE id = ${consentOnly.id}
      `;
			expect(consentRow?.error_message).toBeNull();

			const [regularRow] = await sql`
        SELECT error_message FROM connections WHERE id = ${regular.id}
      `;
			expect(regularRow?.error_message).toBe(
				formatAclErrorMessage(
					"GitHub ACL sync unavailable: no repository feeds configured",
				),
			);
		});

		it("releases ACL residue a consent-only grant-holder can no longer clear", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Residue Org" });
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				config: { consent_only: true },
				createDefaultFeed: false,
			});
			// Residue from a tick that ran BEFORE the exclusion existed. The row can
			// never sync to `fresh`, so `clearConnectionAclError` would never fire —
			// without an explicit release this is permanent.
			await markConnectionAclFailed(
				org.id,
				String(conn.id),
				"GitHub ACL sync unavailable: no repository feeds configured",
			);
			const [seeded] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
			expect(seeded?.error_message).not.toBeNull();

			await runGithubAclSyncTick();

			const [row] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
			expect(row?.error_message).toBeNull();
		});

		it("keeps the enforcement row on a consent-only connection that was graphed", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Residue Graphed Org" });
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				config: { consent_only: true },
				createDefaultFeed: false,
			});
			// A connection graphed BEFORE it became consent-only: delete its feeds
			// and flip the flag and this is the live shape. Its already-synced
			// events are fenced by this row, and `compileResourceVisibility` treats
			// a MISSING row as never-graphed (connection visibility) — so dropping it here
			// would turn fail-closed into readable.
			await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
        VALUES (${org.id}, ${String(conn.id)}, 'full', 'fresh', now())
      `;
			await sql`
        UPDATE connections SET error_message = ${formatAclErrorMessage("GitHub ACL sync unavailable: no repository feeds configured")} WHERE id = ${conn.id}
      `;

			await runGithubAclSyncTick();

			const [row] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
			expect(row?.error_message).toBeNull();
			const [state] = await sql`
        SELECT freshness_state FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
			expect(state?.freshness_state).toBe("fresh");
		});

		it("clears only acl-prefixed text when called directly", async () => {
			// The tick's selection predicate already filters on the prefix, so the
			// guard inside the clear cannot be reached through it. Exercise the
			// function's own contract: `connections.error_message` is shared, and
			// this must never blank another subsystem's message.
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Clear Guard Org" });
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				config: { consent_only: true },
				createDefaultFeed: false,
			});
			await sql`
        UPDATE connections SET error_message = 'oauth: token expired' WHERE id = ${conn.id}
      `;

			await clearRetainedAclErrorMessage(sql, {
				organizationId: org.id,
				connectionId: String(conn.id),
			});

			const [row] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
			expect(row?.error_message).toBe("oauth: token expired");
		});

		it("leaves a NON-acl error on a consent-only row untouched", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Residue Foreign Org" });
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				config: { consent_only: true },
				createDefaultFeed: false,
			});
			await sql`
        UPDATE connections SET error_message = 'oauth: token expired' WHERE id = ${conn.id}
      `;

			await runGithubAclSyncTick();

			const [row] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
			expect(row?.error_message).toBe("oauth: token expired");
		});
	});

	describe("connector-health alerting", () => {
		it("alerts once on the transition into acl_failed", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Alert Org" });
			const conn = await seedAclFailedConnection({
				orgId: org.id,
				errorMessage: formatAclErrorMessage(
					"GitHub ACL sync failed: 401 Unauthorized",
				),
			});

			const result = await runConnectorHealthCheck();
			const detail = result.details.find((d) => d.connectionId === conn.id);
			expect(detail?.reason).toBe("acl_failed");
			expect(detail?.lastError).toContain("GitHub ACL sync failed");
			expect(result.newlyAlerted).toBeGreaterThan(0);
			expect(result.authNotified).toBe(0);

			const [row] = await sql`
        SELECT unhealthy_alerted_at FROM connections WHERE id = ${conn.id}
      `;
			expect(row?.unhealthy_alerted_at).not.toBeNull();
		});

		it("suppresses the alert for a consent-only github row but not a slack one", async () => {
			// The retained `failed` row is deliberate — it keeps already-synced
			// events fenced — but the github tick no longer sweeps consent-only
			// connections, so it can never clear and alerting on it would be
			// permanent noise. The slack tick DOES still sweep them, so a failure
			// it records is live and must still alert.
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Consent Alert Org" });
			const gh = await seedAclFailedConnection({
				orgId: org.id,
				errorMessage: formatAclErrorMessage("GitHub ACL sync failed: 401"),
			});
			const slack = await seedAclFailedConnection({
				orgId: org.id,
				errorMessage: formatAclErrorMessage("Slack ACL sync failed: 401"),
			});
			await sql`
        UPDATE connections
        SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{consent_only}', 'true')
        WHERE id IN (${gh.id}, ${slack.id})
      `;
			await sql`
        UPDATE connections SET connector_key = 'slack' WHERE id = ${slack.id}
      `;

			const result = await runConnectorHealthCheck();
			expect(
				result.details.find((d) => d.connectionId === gh.id)?.reason,
			).toBeUndefined();
			expect(result.details.find((d) => d.connectionId === slack.id)?.reason).toBe(
				"acl_failed",
			);
		});

		it("does not attribute a chat runtime ACL failure to a colliding data slug", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({
				name: "Acl Collision Health Org",
			});
			const data = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				slug: "shared-runtime-id",
				createDefaultFeed: false,
			});
			const chat = await createTestConnection({
				organization_id: org.id,
				connector_key: "slack",
				slug: "agentconn-shared-runtime-id",
				createDefaultFeed: false,
			});
			await sql`
        UPDATE connections
        SET created_at = ${OLD()}, updated_at = ${OLD()},
            credential_mode = CASE WHEN id = ${chat.id} THEN 'byo' ELSE credential_mode END
        WHERE id IN (${data.id}, ${chat.id})
      `;
			await sql`
        INSERT INTO feeds (
          organization_id, connection_id, feed_key, status,
          last_sync_status, last_sync_at, consecutive_failures, created_at, updated_at
        ) VALUES (
          ${org.id}, ${data.id}, 'ok', 'active',
          'success', now(), 0, now(), now()
        )
      `;
			await sql`
        INSERT INTO authz_source_acl_state (
          organization_id, connection_id, acl_support, freshness_state
        ) VALUES (${org.id}, 'shared-runtime-id', 'full', 'failed')
      `;

			const result = await runConnectorHealthCheck();
			expect(
				result.details.find((detail) => detail.connectionId === data.id),
			).toBeUndefined();
			expect(
				result.details.find((detail) => detail.connectionId === chat.id)
					?.reason,
			).toBe("acl_failed");
		});

		it("does not double-alert while still acl_failed, and re-alerts after recovery", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Dedupe Org" });
			const conn = await seedAclFailedConnection({
				orgId: org.id,
				errorMessage: formatAclErrorMessage(
					"GitHub ACL sync failed: 401 Unauthorized",
				),
			});

			const first = await runConnectorHealthCheck();
			expect(first.details.some((d) => d.connectionId === conn.id)).toBe(true);
			expect(first.newlyAlerted).toBeGreaterThan(0);

			// Still unhealthy → no second alert (the unhealthy_alerted_at claim).
			const second = await runConnectorHealthCheck();
			expect(second.details.some((d) => d.connectionId === conn.id)).toBe(true);
			expect(second.newlyAlerted).toBe(0);

			// Recovery re-arms the marker...
			await sql`
        UPDATE authz_source_acl_state
        SET freshness_state = 'fresh', last_synced_at = now(), updated_at = now()
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
			const afterRecovery = await runConnectorHealthCheck();
			expect(afterRecovery.recovered).toBeGreaterThan(0);
			const [cleared] = await sql`
        SELECT unhealthy_alerted_at FROM connections WHERE id = ${conn.id}
      `;
			expect(cleared?.unhealthy_alerted_at).toBeNull();

			// ...and a fresh failure alerts again (NULL→set transition once more).
			await sql`
        UPDATE authz_source_acl_state
        SET freshness_state = 'failed', updated_at = now()
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
			const broken = await runConnectorHealthCheck();
			expect(broken.newlyAlerted).toBeGreaterThan(0);
		});
	});

	describe("orphan cleanup", () => {
		it("deleting a connection removes only its ACL row", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Delete Org" });
			const user = await createTestUser({
				name: "Owner",
				email: "acl-delete@example.com",
			});
			await addUserToOrganization(user.id, org.id, "owner");
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				slug: "unrelated-chat-runtime",
				visibility: "org",
				createDefaultFeed: false,
			});
			const [{ slug }] = await sql<{ slug: string }>`
        SELECT slug FROM connections WHERE id = ${conn.id}
      `;
			// The numeric key belongs to this data connection. The slug-shaped key
			// simulates a different chat runtime id and must survive this deletion.
			await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state)
        VALUES
          (${org.id}, ${String(conn.id)}, 'full', 'fresh'),
          (${org.id}, ${slug}, 'full', 'failed')
      `;

			const client = await TestApiClient.for({
				organizationId: org.id,
				userId: user.id,
				memberRole: "owner",
			});
			const result = (await client.connections.delete(conn.id)) as {
				deleted?: boolean;
			};
			expect(result.deleted).toBe(true);

			const [tombstoned] = await sql`
        SELECT deleted_at FROM connections WHERE id = ${conn.id}
      `;
			expect(tombstoned?.deleted_at).not.toBeNull();

			const remaining = await sql`
        SELECT connection_id FROM authz_source_acl_state
        WHERE organization_id = ${org.id}
          AND connection_id IN (${String(conn.id)}, ${slug})
      `;
			expect(remaining).toHaveLength(1);
			expect(remaining[0]?.connection_id).toBe(slug);
		});

		it("does not recreate ACL state when an in-flight sync finishes after deletion", async () => {
			const sql = getTestDb();
			const org = await createTestOrganization({ name: "Acl Delete Race Org" });
			const user = await createTestUser({
				name: "Owner",
				email: "acl-delete-race@example.com",
			});
			await addUserToOrganization(user.id, org.id, "owner");
			const conn = await createTestConnection({
				organization_id: org.id,
				connector_key: "github",
				visibility: "org",
				createDefaultFeed: false,
			});
			await sql`
        INSERT INTO authz_source_acl_state (
          organization_id, connection_id, acl_support, freshness_state
        ) VALUES (${org.id}, ${String(conn.id)}, 'full', 'fresh')
      `;

			let signalFetchStarted!: () => void;
			let releaseFetch!: () => void;
			const fetchStarted = new Promise<void>((resolve) => {
				signalFetchStarted = resolve;
			});
			const fetchRelease = new Promise<void>((resolve) => {
				releaseFetch = resolve;
			});
			const sync = syncGithubConnectionAcl(
				{
					listRepos: async () => [{ owner: "acme", repo: "repo-a" }],
					fetchCollaborators: async () => {
						signalFetchStarted();
						await fetchRelease;
						return [{ login: "alice", id: 1 }];
					},
				},
				{ connectionId: String(conn.id), organizationId: org.id },
			);
			await fetchStarted;

			const client = await TestApiClient.for({
				organizationId: org.id,
				userId: user.id,
				memberRole: "owner",
			});
			let deleted: { deleted?: boolean };
			try {
				deleted = (await client.connections.delete(conn.id)) as {
					deleted?: boolean;
				};
			} finally {
				releaseFetch();
			}
			expect(deleted.deleted).toBe(true);
			expect((await sync).ok).toBe(true);

			const state = await sql`
        SELECT connection_id
        FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
			expect(state).toHaveLength(0);
		});
	});
});
