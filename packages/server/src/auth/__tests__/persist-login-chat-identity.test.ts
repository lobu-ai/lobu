/**
 * Unit coverage for `persistLoginChatIdentity`.
 *
 * On sign-in with a provider that proves a chat identity we stamp that identity
 * onto the user's `$member` entity, sourced `auth:signup`. Which providers
 * qualify, and the key each writes, come from the registry — not from this
 * function.
 *
 * SLACK writes the team-scoped `slack_user_id` (`T…:U…`), resolved id_token
 * PRIMARY (decode the stored OIDC id_token — no network) with a userinfo-fetch
 * FALLBACK. These cases pin: the id_token path (and that it makes NO fetch),
 * a clean fallback write, idempotency, the missing-team guard (never write a
 * bare id), multi-org fanout, and malformed-id_token → fallback.
 *
 * GOOGLE writes the BARE `google_user_id` straight off `account.accountId` —
 * which is the OIDC `sub`, and the same id Google Chat puts in a sender's
 * `users/{id}`. These cases pin: the write itself, that it needs no network,
 * that a non-numeric id is refused, and that the two namespaces never cross.
 *
 * A provider that mints no chat identity at all (github, email/password) is a
 * no-op.
 *
 * The network reads (userinfo fetch + provider config) are injected stubs; the
 * DB write path is REAL against the embedded test database — the `isolate:false`
 * vitest run makes `vi.mock` of shared singletons unreliable, so dependency
 * injection is the durable seam.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../__tests__/setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../__tests__/setup/test-fixtures";
import { resolveMemberOrgsForUser } from "../../identity/member-orgs";
import type { PersistLoginChatIdentityDeps } from "../subject-identities";
import {
	persistLoginChatIdentity,
	provisionMemberAndCoreIdentities,
} from "../subject-identities";

const TEAM = "T1";
const USER = "U1";
/** A synthetic Google account id — the shape Google's OIDC `sub` uses. */
const GOOGLE_SUB = "100000000000000000001";

/** Rows written per chat namespace in an org. */
async function identityCount(
	organizationId: string,
): Promise<{ slack: number; google: number }> {
	const sql = getTestDb();
	const rows = await sql<{ namespace: string; n: number }>`
    SELECT namespace, COUNT(*)::int AS n FROM entity_identities
    WHERE organization_id = ${organizationId}
      AND namespace IN ('slack_user_id', 'google_user_id')
      AND deleted_at IS NULL
    GROUP BY namespace
  `;
	const by = new Map(rows.map((r) => [r.namespace, Number(r.n)]));
	return {
		slack: by.get("slack_user_id") ?? 0,
		google: by.get("google_user_id") ?? 0,
	};
}

async function seedMember(): Promise<{
	orgId: string;
	userId: string;
	memberEntityId: number;
}> {
	const org = await createTestOrganization({
		name: "Acme",
		visibility: "private",
	});
	const user = await createTestUser({
		name: "Alice",
		email: "alice@acme.test",
	});
	await addUserToOrganization(user.id, org.id, "owner");
	const { memberEntityId } = await provisionMemberAndCoreIdentities(org.id, {
		userId: user.id,
		email: "alice@acme.test",
		name: "Alice",
	});
	return { orgId: org.id, userId: user.id, memberEntityId };
}

/** Build an (unsigned-but-well-formed) JWT carrying the given claims. */
function makeJwt(claims: Record<string, unknown>): string {
	const b64 = (o: unknown) =>
		Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

/** Deps that resolve the real tenant member but stub the two network reads. */
function depsWith(
	raw: Record<string, unknown> | null,
): PersistLoginChatIdentityDeps {
	return {
		resolveMemberOrgsForUser,
		getEnabledLoginProviderConfigs: async () => [
			{
				connectorKey: "slack",
				provider: "slack",
				loginScopes: [],
				clientIdKey: "SLACK_CLIENT_ID",
				clientSecretKey: "SLACK_CLIENT_SECRET",
				userinfoUrl: "https://slack.test/openid/connect/userInfo",
			},
		],
		fetchUserInfoWithRaw: async () => ({ raw, normalized: null }),
	};
}

/**
 * Deps that record whether the network fallback was reached. `raw` is what the
 * fetch returns when it IS called (the fallback path).
 */
function trackingDeps(raw: Record<string, unknown> | null): {
	deps: PersistLoginChatIdentityDeps;
	calls: { fetched: boolean; configs: boolean };
} {
	const calls = { fetched: false, configs: false };
	return {
		calls,
		deps: {
			resolveMemberOrgsForUser,
			getEnabledLoginProviderConfigs: async () => {
				calls.configs = true;
				return [];
			},
			fetchUserInfoWithRaw: async () => {
				calls.fetched = true;
				return { raw, normalized: null };
			},
		},
	};
}

async function slackIdentityCount(
	orgId: string,
	identifier: string,
): Promise<number> {
	const sql = getTestDb();
	const rows = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n
    FROM entity_identities
    WHERE organization_id = ${orgId}
      AND namespace = 'slack_user_id'
      AND identifier = ${identifier}
      AND source_connector = 'auth:signup'
      AND deleted_at IS NULL
  `;
	return Number(rows[0]?.n ?? 0);
}

describe("persistLoginChatIdentity", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});
	afterEach(async () => {
		await cleanupTestDatabase();
	});

	it("PRIMARY: decodes the stored id_token and writes (slack_user_id) with NO network fetch", async () => {
		const { orgId, userId, memberEntityId } = await seedMember();
		const { deps, calls } = trackingDeps(null);

		await persistLoginChatIdentity(
			{
				providerId: "slack",
				userId,
				accessToken: "xoxp-token",
				accountId: USER,
				idToken: makeJwt({
					"https://slack.com/team_id": TEAM,
					"https://slack.com/user_id": USER,
					sub: USER,
				}),
			},
			deps,
		);

		// The id_token carried everything → neither the userinfo fetch nor the
		// provider-config lookup was reached.
		expect(calls.fetched).toBe(false);
		expect(calls.configs).toBe(false);

		const sql = getTestDb();
		const rows = await sql<{ entity_id: number }>`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${orgId}
        AND namespace = 'slack_user_id'
        AND identifier = ${`${TEAM}:${USER}`}
        AND source_connector = 'auth:signup'
        AND deleted_at IS NULL
    `;
		expect(rows).toHaveLength(1);
		expect(Number(rows[0].entity_id)).toBe(memberEntityId);
	});

	it("writes the team-scoped identity to every org where the user has a trusted $member claim", async () => {
		const first = await seedMember();
		const secondOrg = await createTestOrganization({
			name: "Second Acme",
			visibility: "private",
		});
		await addUserToOrganization(first.userId, secondOrg.id, "member");
		await provisionMemberAndCoreIdentities(secondOrg.id, {
			userId: first.userId,
			email: "alice@acme.test",
			name: "Alice",
		});

		await persistLoginChatIdentity(
			{
				providerId: "slack",
				userId: first.userId,
				accessToken: "xoxp-token",
				accountId: USER,
				idToken: makeJwt({
					"https://slack.com/team_id": TEAM,
					"https://slack.com/user_id": USER,
				}),
			},
			trackingDeps(null).deps,
		);

		expect(await slackIdentityCount(first.orgId, `${TEAM}:${USER}`)).toBe(1);
		expect(await slackIdentityCount(secondOrg.id, `${TEAM}:${USER}`)).toBe(1);
	});

	it("FALLBACK: no id_token → fetches userinfo and writes the team-scoped slack_user_id", async () => {
		const { orgId, userId, memberEntityId } = await seedMember();

		await persistLoginChatIdentity(
			{
				providerId: "slack",
				userId,
				accessToken: "xoxp-token",
				accountId: USER,
			},
			depsWith({ "https://slack.com/team_id": TEAM }),
		);

		const sql = getTestDb();
		const rows = await sql<{ entity_id: number }>`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${orgId}
        AND namespace = 'slack_user_id'
        AND identifier = ${`${TEAM}:${USER}`}
        AND source_connector = 'auth:signup'
        AND deleted_at IS NULL
    `;
		expect(rows).toHaveLength(1);
		expect(Number(rows[0].entity_id)).toBe(memberEntityId);
	});

	it("FALLBACK: a malformed id_token falls back to the userinfo fetch", async () => {
		const { orgId, userId } = await seedMember();
		const { deps, calls } = trackingDeps({ "https://slack.com/team_id": TEAM });

		await persistLoginChatIdentity(
			{
				providerId: "slack",
				userId,
				accessToken: "xoxp-token",
				accountId: USER,
				idToken: "not-a-jwt",
			},
			deps,
		);

		// Malformed token decoded to nothing → fell through to the fetch path.
		expect(calls.fetched).toBe(true);
		expect(await slackIdentityCount(orgId, `${TEAM}:${USER}`)).toBe(1);
	});

	it("FALLBACK: reads userinfoUrl from the trusted baseline, never a tenant org's config", async () => {
		// The fetch sends the user's real Slack access token to `userinfoUrl`, so
		// that URL must never come from a tenant. An org can SHADOW the baseline
		// Slack provider (mergeLoginProviderConfigs), so if the fallback read a
		// member org's config, a malicious co-member org could exfiltrate the
		// token. The fallback must query only the baseline (org id = null).
		const baselineUrl = "https://slack.test/openid/connect/userInfo";
		const attackerUrl = "https://attacker.example/steal";
		const { orgId, userId } = await seedMember();

		let seenUserinfoUrl: string | undefined = "UNSET";
		const configOrgIds: Array<string | null | undefined> = [];
		await persistLoginChatIdentity(
			{
				providerId: "slack",
				userId,
				accessToken: "xoxp-token",
				accountId: USER,
			},
			{
				resolveMemberOrgsForUser,
				getEnabledLoginProviderConfigs: async (id?: string | null) => {
					configOrgIds.push(id);
					// Baseline (null) → the trusted endpoint. Any tenant org → an
					// attacker-controlled endpoint that must NOT be used.
					return [
						{
							connectorKey: "slack",
							provider: "slack",
							loginScopes: [],
							clientIdKey: "SLACK_CLIENT_ID",
							clientSecretKey: "SLACK_CLIENT_SECRET",
							userinfoUrl: id == null ? baselineUrl : attackerUrl,
						},
					];
				},
				fetchUserInfoWithRaw: async (args) => {
					seenUserinfoUrl = args.userinfoUrl;
					return {
						raw: { "https://slack.com/team_id": TEAM },
						normalized: null,
					};
				},
			},
		);

		// The config lookup was made against the baseline only, and the fetch got
		// the baseline endpoint — the attacker URL never reached fetchUserInfo.
		expect(configOrgIds).toEqual([null]);
		expect(seenUserinfoUrl).toBe(baselineUrl);
		expect(seenUserinfoUrl).not.toBe(attackerUrl);
		expect(await slackIdentityCount(orgId, `${TEAM}:${USER}`)).toBe(1);
	});

	it("is idempotent — a second call writes no duplicate", async () => {
		const { orgId, userId } = await seedMember();
		const deps = depsWith({ "https://slack.com/team_id": TEAM });
		const account = {
			providerId: "slack",
			userId,
			accessToken: "xoxp-token",
			accountId: USER,
		};

		await persistLoginChatIdentity(account, deps);
		await persistLoginChatIdentity(account, deps);

		expect(await slackIdentityCount(orgId, `${TEAM}:${USER}`)).toBe(1);
	});

	it("never writes a bare id when team_id is missing", async () => {
		const { orgId, userId } = await seedMember();

		await persistLoginChatIdentity(
			{
				providerId: "slack",
				userId,
				accessToken: "xoxp-token",
				accountId: USER,
			},
			// No team_id in the userinfo body → normalizeSlackUserId returns null.
			depsWith({ sub: USER }),
		);

		const sql = getTestDb();
		const rows = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM entity_identities
      WHERE organization_id = ${orgId} AND namespace = 'slack_user_id'
        AND deleted_at IS NULL
    `;
		expect(Number(rows[0].n)).toBe(0);
	});

	it("is a no-op for a provider that mints no chat identity", async () => {
		const { orgId, userId } = await seedMember();
		let fetched = false;

		await persistLoginChatIdentity(
			{
				providerId: "github",
				userId,
				accessToken: "gho-token",
				accountId: "12345",
			},
			{
				resolveMemberOrgsForUser,
				getEnabledLoginProviderConfigs: async () => [],
				fetchUserInfoWithRaw: async () => {
					fetched = true;
					return { raw: null, normalized: null };
				},
			},
		);

		expect(fetched).toBe(false);
		expect(await identityCount(orgId)).toEqual({ slack: 0, google: 0 });
	});

	it("stamps the BARE google_user_id on Google sign-in, with no network read", async () => {
		const { orgId, userId } = await seedMember();
		let fetched = false;

		await persistLoginChatIdentity(
			{
				providerId: "google",
				userId,
				accessToken: "ya29-token",
				accountId: GOOGLE_SUB,
			},
			{
				resolveMemberOrgsForUser,
				getEnabledLoginProviderConfigs: async () => [],
				fetchUserInfoWithRaw: async () => {
					fetched = true;
					return { raw: null, normalized: null };
				},
			},
		);

		// Google needs neither the userinfo endpoint nor the provider config: the
		// account id IS the identity.
		expect(fetched).toBe(false);

		const sql = getTestDb();
		const rows = await sql<{ identifier: string; source_connector: string }>`
      SELECT identifier, source_connector FROM entity_identities
      WHERE organization_id = ${orgId} AND namespace = 'google_user_id'
        AND deleted_at IS NULL
    `;
		// BARE, not tenant-prefixed. A Google account id is globally unique, so
		// unlike Slack there is nothing to scope it by — and a `T…:` prefix here
		// would never match the id Google Chat sends.
		expect(rows).toHaveLength(1);
		expect(rows[0].identifier).toBe(GOOGLE_SUB);
		expect(rows[0].source_connector).toBe("auth:signup");
		// The Slack namespace is untouched — one login mints exactly one identity.
		expect(await identityCount(orgId)).toEqual({ slack: 0, google: 1 });
	});

	it("refuses a Google account id that is not a bare numeric id", async () => {
		const { orgId, userId } = await seedMember();

		// `account` rows with providerId 'google' are NOT all sign-ins: a Google
		// CONNECTOR grant (drive/gmail/calendar) writes one too, under a synthetic
		// account id. Those must never mint a chat identity — a connector
		// authorization is a different consent from proving who you are. Some of
		// them do carry `openid`, so a scope check would let them through; the
		// digits-only rule is what actually rejects them.
		//
		// Shapes below mirror the ones observed in production, plus a Slack id
		// arriving on the wrong provider.
		for (const accountId of [
			"connect_1_2",
			"lobu-connector:org-id:google.drive:1",
			USER,
			"12345678901234567890123456789012345",
			"10000000000000000000x",
		]) {
			await persistLoginChatIdentity(
				{
					providerId: "google",
					userId,
					accessToken: "ya29-token",
					accountId,
				},
				{
					resolveMemberOrgsForUser,
					getEnabledLoginProviderConfigs: async () => [],
					fetchUserInfoWithRaw: async () => ({ raw: null, normalized: null }),
				},
			);
		}

		expect(await identityCount(orgId)).toEqual({ slack: 0, google: 0 });
	});

	it("keeps Slack and Google identities in separate namespaces for one user", async () => {
		const { orgId, userId } = await seedMember();

		await persistLoginChatIdentity(
			{ providerId: "slack", userId, accessToken: "xoxp", accountId: USER },
			depsWith({ "https://slack.com/team_id": TEAM }),
		);
		await persistLoginChatIdentity(
			{
				providerId: "google",
				userId,
				accessToken: "ya29",
				accountId: GOOGLE_SUB,
			},
			{
				resolveMemberOrgsForUser,
				getEnabledLoginProviderConfigs: async () => [],
				fetchUserInfoWithRaw: async () => ({ raw: null, normalized: null }),
			},
		);

		// One human, two proven platform accounts, two rows on the same $member.
		expect(await identityCount(orgId)).toEqual({ slack: 1, google: 1 });
		const sql = getTestDb();
		const rows = await sql<{ namespace: string; identifier: string }>`
      SELECT namespace, identifier FROM entity_identities
      WHERE organization_id = ${orgId}
        AND namespace IN ('slack_user_id', 'google_user_id')
        AND deleted_at IS NULL
      ORDER BY namespace
    `;
		expect(rows.map((r) => [r.namespace, r.identifier])).toEqual([
			["google_user_id", GOOGLE_SUB],
			["slack_user_id", `${TEAM}:${USER}`],
		]);
	});
});
