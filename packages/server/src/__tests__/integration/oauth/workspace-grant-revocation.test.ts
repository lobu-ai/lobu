import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { OAuthClientsStore } from "../../../auth/oauth/clients";
import { OAuthProvider } from "../../../auth/oauth/provider";
import { hashToken } from "../../../auth/oauth/utils";
import { parsePgTextArray, pgTextArray } from "../../../db/client";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

describe("connected-app workspace grant revocation", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("removes a secondary workspace but revokes the token when its primary is disconnected", async () => {
		const sql = getTestDb();
		const primary = await createTestOrganization({ name: "Revoke Primary" });
		const secondary = await createTestOrganization({
			name: "Revoke Secondary",
		});
		const user = await createTestUser({ name: "Revoke User" });
		await addUserToOrganization(user.id, primary.id, "owner");
		await addUserToOrganization(user.id, secondary.id, "owner");

		const store = new OAuthClientsStore(sql);
		const client = await store.registerClient({
			client_name: "Workspace Revoke Client",
			redirect_uris: ["https://client.example/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			token_endpoint_auth_method: "none",
		});
		await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        granted_organization_ids, scope, expires_at
      ) VALUES
        ('grant-access', 'access', 'grant-access-hash', ${client.client_id}, ${user.id}, ${primary.id},
         ${pgTextArray([primary.id, secondary.id])}::text[], 'mcp:read', NOW() + INTERVAL '1 hour'),
        ('grant-refresh', 'refresh', 'grant-refresh-hash', ${client.client_id}, ${user.id}, ${primary.id},
         ${pgTextArray([primary.id, secondary.id])}::text[], 'mcp:read', NOW() + INTERVAL '1 day')
    `;
		await sql`
      INSERT INTO mcp_sessions (
        session_id, user_id, client_id, organization_id, member_role,
        is_authenticated, scoped_to_org, expires_at
      ) VALUES
        (
          'workspace-grant-session', ${user.id}, ${client.client_id}, ${primary.id}, 'owner',
          true, false, NOW() + INTERVAL '1 hour'
        ),
        (
          'workspace-scoped-primary-session', ${user.id}, ${client.client_id}, ${primary.id}, 'owner',
          true, true, NOW() + INTERVAL '1 hour'
        )
    `;

		expect(
			(await store.listClientsByOrganization(secondary.id)).map(
				(entry) => entry.client_id,
			),
		).toContain(client.client_id);
		expect(
			await store.revokeClientForOrganization(
				client.client_id,
				secondary.id,
				user.id,
			),
		).toBe(true);

		const afterSecondary = await sql`
      SELECT revoked_at, granted_organization_ids
      FROM oauth_tokens
      WHERE id = 'grant-access'
    `;
		expect(afterSecondary[0]?.revoked_at).toBeNull();
		expect(
			parsePgTextArray(
				afterSecondary[0]?.granted_organization_ids as string | null,
			),
		).toEqual([primary.id]);
		const sessions = await sql`
      SELECT session_id
      FROM mcp_sessions
      WHERE session_id IN ('workspace-grant-session', 'workspace-scoped-primary-session')
      ORDER BY session_id
    `;
		expect(sessions.map((row) => row.session_id)).toEqual([
			"workspace-scoped-primary-session",
		]);

		expect(
			await store.revokeClientForOrganization(
				client.client_id,
				primary.id,
				user.id,
			),
		).toBe(true);
		const afterPrimary = await sql`
      SELECT revoked_at FROM oauth_tokens WHERE id = 'grant-access'
    `;
		expect(afterPrimary[0]?.revoked_at).not.toBeNull();
		const sessionsAfterPrimary = await sql`
      SELECT session_id
      FROM mcp_sessions
      WHERE session_id = 'workspace-scoped-primary-session'
    `;
		expect(sessionsAfterPrimary).toHaveLength(0);
	});

	it("revokes codes that lose their last workspace while preserving account-only grants", async () => {
		const sql = getTestDb();
		const removed = await createTestOrganization({ name: "Removed Grant" });
		const retained = await createTestOrganization({ name: "Retained Grant" });
		const user = await createTestUser({ name: "Account Grant User" });
		const provider = new OAuthProvider(sql, "http://localhost", true);
		const client = await provider.clientsStore.registerClient({
			client_name: "Account Code Revocation",
			redirect_uris: ["http://localhost/callback"],
			grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
			token_endpoint_auth_method: "none",
		});
		const verifier = "synthetic-code-verifier-for-workspace-revocation";
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const authorizationCodes: string[] = [];
		const deviceCodes: string[] = [];
		for (const grants of [[removed.id], [removed.id, retained.id], []]) {
			const scope = grants.length ? "mcp:read" : "profile:read";
			const resource = grants.length ? "http://localhost/mcp" : undefined;
			authorizationCodes.push(await provider.createAuthorizationCode({
				client_id: client.client_id, redirect_uri: "http://localhost/callback",
				response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
				scope, resource,
			}, user.id, null, grants));
			const device = await provider.createDeviceAuthorization(client.client_id, scope, resource ?? null);
			if ("error" in device) throw new Error(device.error);
			expect(await provider.claimDeviceCodeForUser(device.user_code, user.id)).toBeTruthy();
			expect(await provider.approveDeviceCode(device.user_code, user.id, null, scope, grants)).toBe(true);
			deviceCodes.push(device.device_code);
		}

		expect(await provider.clientsStore.revokeClientForOrganization(client.client_id, removed.id, user.id)).toBe(true);
		const afterFirst = await sql`
      SELECT code, granted_organization_ids FROM oauth_authorization_codes
      WHERE client_id = ${client.client_id} ORDER BY scope ASC
    `;
		expect(afterFirst.map((row) => row.code)).toEqual([authorizationCodes[1], authorizationCodes[2]]);
		expect(parsePgTextArray(afterFirst[0]?.granted_organization_ids as string)).toEqual([retained.id]);
		const devicesAfterFirst = await sql`
      SELECT device_code, granted_organization_ids FROM oauth_device_codes
      WHERE client_id = ${client.client_id} ORDER BY scope ASC
    `;
		expect(devicesAfterFirst.map((row) => row.device_code)).toEqual([deviceCodes[1], deviceCodes[2]]);
		expect(parsePgTextArray(devicesAfterFirst[0]?.granted_organization_ids as string)).toEqual([retained.id]);
		expect(await provider.exchangeAuthorizationCode({
			grant_type: "authorization_code", client_id: client.client_id,
			code: authorizationCodes[0], code_verifier: verifier, redirect_uri: "http://localhost/callback",
			resource: "http://localhost/mcp",
		})).toMatchObject({ error: "invalid_grant" });
		expect(await provider.exchangeDeviceCode({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: client.client_id,
			device_code: deviceCodes[0], resource: "http://localhost/mcp",
		})).toMatchObject({ error: "invalid_grant" });

		expect(await provider.clientsStore.revokeClientForOrganization(client.client_id, retained.id, user.id)).toBe(true);
		const afterLast = await sql`
      SELECT code FROM oauth_authorization_codes WHERE client_id = ${client.client_id}
    `;
		expect(afterLast.map((row) => row.code)).toEqual([authorizationCodes[2]]);
		const devicesAfterLast = await sql`
      SELECT device_code FROM oauth_device_codes WHERE client_id = ${client.client_id}
    `;
		expect(devicesAfterLast.map((row) => row.device_code)).toEqual([deviceCodes[2]]);
	});

	it("serializes refresh rotation with workspace revoke so children cannot retain the removed grant", async () => {
		const sql = getTestDb();
		const primary = await createTestOrganization({ name: "Refresh Race Primary" });
		const secondary = await createTestOrganization({ name: "Refresh Race Secondary" });
		const user = await createTestUser({ name: "Refresh Race User" });
		await addUserToOrganization(user.id, primary.id, "owner");
		await addUserToOrganization(user.id, secondary.id, "owner");
		const store = new OAuthClientsStore(sql);
		const client = await store.registerClient({
			client_name: "Refresh Race Client",
			redirect_uris: ["https://client.example/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			token_endpoint_auth_method: "none",
		});
		const refreshToken = "owl_rt_workspace-revoke-race";
		await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        granted_organization_ids, scope, resource, expires_at
      ) VALUES (
        'grant-race-refresh', 'refresh', ${hashToken(refreshToken)}, ${client.client_id},
        ${user.id}, ${primary.id}, ${pgTextArray([primary.id, secondary.id])}::text[],
        'mcp:read', 'https://lobu.test/mcp', NOW() + INTERVAL '1 day'
      )
    `;

		const advisoryKey = 8272711;
		await sql.unsafe(`
      CREATE OR REPLACE FUNCTION test_pause_workspace_grant_refresh()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.client_id = '${client.client_id}' THEN
          PERFORM pg_advisory_xact_lock(${advisoryKey});
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
		await sql.unsafe(`
      DROP TRIGGER IF EXISTS test_pause_workspace_grant_refresh_trigger ON oauth_tokens;
    `);
		await sql.unsafe(`
      CREATE TRIGGER test_pause_workspace_grant_refresh_trigger
      BEFORE INSERT ON oauth_tokens
      FOR EACH ROW EXECUTE FUNCTION test_pause_workspace_grant_refresh();
    `);

		let releaseAdvisory!: () => void;
		let advisoryReady!: () => void;
		const ready = new Promise<void>((resolve) => {
			advisoryReady = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseAdvisory = resolve;
		});
		const holder = sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_lock(${advisoryKey})`;
			advisoryReady();
			await release;
			await tx`SELECT pg_advisory_unlock(${advisoryKey})`;
		});
		await ready;

		const waitForBlockedQuery = async (fragment: string): Promise<void> => {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const rows = await sql`
          SELECT 1
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query ILIKE ${`%${fragment}%`}
          LIMIT 1
        `;
				if (rows.length > 0) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`Timed out waiting for blocked query: ${fragment}`);
		};

		const provider = new OAuthProvider(sql, "https://lobu.test", true);
		const refreshPromise = provider.refreshAccessToken({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: client.client_id,
			resource: "https://lobu.test/mcp",
		});
		let revokePromise: Promise<boolean> | null = null;

		try {
			await waitForBlockedQuery("INSERT INTO oauth_tokens");
			revokePromise = store.revokeClientForOrganization(
				client.client_id,
				secondary.id,
				user.id,
			);
			await waitForBlockedQuery("SELECT id FROM oauth_clients");
			releaseAdvisory();
			await holder;
			const [refreshed, revoked] = await Promise.all([
				refreshPromise,
				revokePromise,
			]);
			expect("error" in refreshed).toBe(false);
			expect(revoked).toBe(true);

			const rows = await sql`
        SELECT revoked_at, granted_organization_ids
        FROM oauth_tokens
        WHERE client_id = ${client.client_id}
          AND revoked_at IS NULL
      `;
			expect(rows).toHaveLength(2);
			for (const row of rows) {
				expect(
					parsePgTextArray(row.granted_organization_ids as string | null),
				).toEqual([primary.id]);
			}
		} finally {
			releaseAdvisory();
			await holder.catch(() => undefined);
			await Promise.all([
				refreshPromise.catch(() => undefined),
				revokePromise?.catch(() => undefined),
			]);
			await sql.unsafe(
				"DROP TRIGGER IF EXISTS test_pause_workspace_grant_refresh_trigger ON oauth_tokens",
			);
			await sql.unsafe(
				"DROP FUNCTION IF EXISTS test_pause_workspace_grant_refresh()",
			);
		}
	});
});
