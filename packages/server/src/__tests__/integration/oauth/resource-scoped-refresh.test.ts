/**
 * Refresh of a resource-scoped (RFC 8707) grant.
 *
 * Production incident (#3625): a `lobu login` bound to
 * `https://app.lobu.ai/mcp/<workspace>` stopped authenticating hours before
 * its advertised access expiry, and refresh returned `invalid_grant`. The
 * grant is recorded with `resource` on the refresh row, and
 * `refreshAccessToken` requires the request to carry the SAME resource. A
 * client that omits the indicator can never refresh that grant.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { OAuthClientsStore } from "../../../auth/oauth/clients";
import { OAuthProvider } from "../../../auth/oauth/provider";
import { hashToken } from "../../../auth/oauth/utils";
import { pgTextArray } from "../../../db/client";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const RESOURCE = "https://app.lobu.ai/mcp/resource-refresh-ws";

async function seedResourceScopedGrant(refreshToken: string) {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Resource Refresh Org" });
	const user = await createTestUser({ name: "Resource Refresh User" });
	await addUserToOrganization(user.id, org.id, "owner");

	const store = new OAuthClientsStore(sql);
	const client = await store.registerClient({
		client_name: "Resource Refresh Client",
		redirect_uris: ["https://client.example/callback"],
		grant_types: ["authorization_code", "refresh_token"],
		token_endpoint_auth_method: "none",
	});

	await sql`
    INSERT INTO oauth_tokens (
      id, token_type, token_hash, client_id, user_id, organization_id,
      granted_organization_ids, authorization_grant_type, scope, resource, expires_at
    ) VALUES (
      'resource-refresh-row', 'refresh', ${hashToken(refreshToken)},
      ${client.client_id}, ${user.id}, ${org.id},
      ${pgTextArray([org.id])}::text[], 'authorization_code',
      'mcp:read profile:read', ${RESOURCE}, NOW() + INTERVAL '30 days'
    )
  `;

	return { sql, client, user, org };
}

describe("resource-scoped refresh grant", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("rotates and stays bound to the resource when the indicator is sent", async () => {
		const { sql, client } = await seedResourceScopedGrant("rt-with-resource");
		const provider = new OAuthProvider(sql);

		const result = await provider.refreshAccessToken({
			grant_type: "refresh_token",
			client_id: client.client_id,
			refresh_token: "rt-with-resource",
			resource: RESOURCE,
		});

		expect(result).not.toHaveProperty("error");
		const tokens = result as {
			access_token: string;
			refresh_token: string;
			resource?: string;
		};
		expect(tokens.resource).toBe(RESOURCE);

		// The minted access token must be usable and still carry the audience,
		// otherwise the MCP audience check 401s the freshly refreshed token.
		const authInfo = await provider.verifyAccessToken(tokens.access_token);
		expect(authInfo?.resource).toBe(RESOURCE);

		// And the rotated refresh token must itself be refreshable — a second
		// rotation is what a long-lived CLI login actually does.
		const second = await provider.refreshAccessToken({
			grant_type: "refresh_token",
			client_id: client.client_id,
			refresh_token: tokens.refresh_token,
			resource: RESOURCE,
		});
		expect(second).not.toHaveProperty("error");
	});

	/**
	 * #3625 copied the same grant to a second machine. Rotation is one-time by
	 * design, so the second copy's refresh MUST fail — but the access token it
	 * already holds has to keep working until its own expiry, otherwise a copy
	 * silently dies hours before its advertised lifetime.
	 */
	it("keeps an already-issued access token valid after another copy rotates the grant", async () => {
		const { sql, client } = await seedResourceScopedGrant("rt-shared-copy");
		const provider = new OAuthProvider(sql);

		const first = (await provider.refreshAccessToken({
			grant_type: "refresh_token",
			client_id: client.client_id,
			refresh_token: "rt-shared-copy",
			resource: RESOURCE,
		})) as { access_token: string; refresh_token: string };
		expect(first).not.toHaveProperty("error");

		// Copy B still holds the pre-rotation refresh token.
		const stale = await provider.refreshAccessToken({
			grant_type: "refresh_token",
			client_id: client.client_id,
			refresh_token: "rt-shared-copy",
			resource: RESOURCE,
		});
		expect(stale).toMatchObject({ error: "invalid_grant" });

		// Copy A's access token must remain usable for its full lifetime — a
		// stale sibling refresh must not invalidate it.
		const authInfo = await provider.verifyAccessToken(first.access_token);
		expect(authInfo).not.toBeNull();
		expect(authInfo?.resource).toBe(RESOURCE);
	});

	it("rejects a refresh that omits the resource indicator", async () => {
		const { sql, client } = await seedResourceScopedGrant("rt-no-resource");
		const provider = new OAuthProvider(sql);

		// This is exactly what the CLI/core refresh client sent in #3625.
		const result = await provider.refreshAccessToken({
			grant_type: "refresh_token",
			client_id: client.client_id,
			refresh_token: "rt-no-resource",
		});

		expect(result).toMatchObject({ error: "invalid_grant" });

		// Fail-closed must be non-destructive: the refresh row is still live, so
		// a client that later sends the indicator can recover.
		const rows = await sql`
      SELECT revoked_at FROM oauth_tokens WHERE id = 'resource-refresh-row'
    `;
		expect(rows[0]?.revoked_at).toBeNull();
	});
});
