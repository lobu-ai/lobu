/**
 * `resolveChatUserIdentity` across platforms.
 *
 * The function used to open with `if (platform !== "slack") return null`, so a
 * Google Chat sender could never be recognised as the Lobu user who signed in
 * with that same Google account — which is what gates `/lobu <agent>` re-binding.
 * It is now registry-driven: a platform resolves iff a connector contributes a
 * `ChatUserIdentity` for it.
 *
 * These cases pin the two things that registry must get right, which are
 * OPPOSITE for the two platforms shipped today:
 *
 *   - gchat keys on the BARE Google account id, accepting the `users/{id}`
 *     resource name Google Chat actually sends, and needs NO team id.
 *   - slack keys on the composite `TEAM:USER` and must REFUSE to resolve
 *     without a team — two workspaces can share a bare `U…`.
 *
 * Plus the fail-closed properties: an unregistered platform resolves null, a
 * malformed id resolves null, and one platform's namespace is never reachable
 * through another's.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { CHAT_USER_IDENTITIES } from "../chat-identity-sources";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../../__tests__/setup/test-fixtures";
import { cleanupTestDatabase, getTestDb } from "../../../__tests__/setup/test-db";
import { provisionMemberAndCoreIdentities } from "../../../auth/subject-identities";
import { resolveChatUserIdentity } from "../chat-identity";

/** A synthetic Google account id — the shape Google's OIDC `sub` uses. */
const GOOGLE_SUB = "100000000000000000001";
const TEAM = "T1";
const SLACK_USER = "U1";

async function seedMember(email: string): Promise<{
	orgId: string;
	userId: string;
	memberEntityId: number;
}> {
	const org = await createTestOrganization({
		name: "Acme",
		visibility: "private",
	});
	const user = await createTestUser({ name: "Alice", email });
	await addUserToOrganization(user.id, org.id, "owner");
	const { memberEntityId } = await provisionMemberAndCoreIdentities(org.id, {
		userId: user.id,
		email,
		name: "Alice",
	});
	return { orgId: org.id, userId: user.id, memberEntityId };
}

/** Stamp a chat identity directly, as the login writer would. */
async function stamp(
	organizationId: string,
	memberEntityId: number,
	namespace: string,
	identifier: string,
): Promise<void> {
	await getTestDb()`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector, scope_key
    ) VALUES (
      ${organizationId}, ${memberEntityId}, ${namespace}, ${identifier}, 'auth:signup', NULL
    )
  `;
}

describe("resolveChatUserIdentity across platforms", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("resolves a Google Chat sender from the `users/{id}` resource name", async () => {
		const { orgId, userId, memberEntityId } = await seedMember(
			"alice@acme.test",
		);
		await stamp(orgId, memberEntityId, "google_user_id", GOOGLE_SUB);

		// Exactly what the gchat adapter hands over: `message.sender.name`, and no
		// team id — Google Chat events carry none.
		expect(
			await resolveChatUserIdentity("gchat", undefined, `users/${GOOGLE_SUB}`),
		).toBe(userId);
	});

	it("resolves a Google Chat sender from a bare account id too", async () => {
		const { orgId, userId, memberEntityId } = await seedMember(
			"alice@acme.test",
		);
		await stamp(orgId, memberEntityId, "google_user_id", GOOGLE_SUB);

		expect(await resolveChatUserIdentity("gchat", undefined, GOOGLE_SUB)).toBe(
			userId,
		);
	});

	it("refuses a malformed Google Chat sender id", async () => {
		const { orgId, memberEntityId } = await seedMember("alice@acme.test");
		await stamp(orgId, memberEntityId, "google_user_id", GOOGLE_SUB);

		// A Chat app / service-account resource name, not a person.
		expect(
			await resolveChatUserIdentity("gchat", undefined, "users/app-not-a-person"),
		).toBeNull();
		expect(await resolveChatUserIdentity("gchat", undefined, "")).toBeNull();
	});

	it("still REFUSES a Slack sender with no team id", async () => {
		const { orgId, userId, memberEntityId } = await seedMember("alice@acme.test");
		await stamp(orgId, memberEntityId, "slack_user_id", `${TEAM}:${SLACK_USER}`);

		// Two workspaces can both contain `U1`, and this link grants privilege —
		// an unscoped match would be a mis-grant. Generalising the platform gate
		// must not have relaxed this.
		expect(
			await resolveChatUserIdentity("slack", undefined, SLACK_USER),
		).toBeNull();
		// With the team id it resolves, so the null above is the scoping rule and
		// not a broken fixture.
		expect(await resolveChatUserIdentity("slack", TEAM, SLACK_USER)).toBe(
			userId,
		);
	});

	it("resolves null for a platform no connector has registered", async () => {
		const { orgId, memberEntityId } = await seedMember("alice@acme.test");
		await stamp(orgId, memberEntityId, "google_user_id", GOOGLE_SUB);

		// telegram/discord/teams/whatsapp ship no ChatUserIdentity yet. Fail
		// closed: an unlinked sender must never resolve to some user.
		for (const platform of ["telegram", "discord", "teams", "whatsapp"]) {
			expect(
				await resolveChatUserIdentity(platform, undefined, GOOGLE_SUB),
			).toBeNull();
		}
	});

	it("never reaches one platform's namespace through another's", async () => {
		const { orgId, memberEntityId } = await seedMember("alice@acme.test");
		// Only a Slack identity exists. A gchat lookup whose id happens to be
		// numeric must not find it, and vice versa.
		await stamp(orgId, memberEntityId, "slack_user_id", `${TEAM}:${SLACK_USER}`);

		expect(
			await resolveChatUserIdentity("gchat", undefined, GOOGLE_SUB),
		).toBeNull();
		expect(
			await resolveChatUserIdentity("gchat", TEAM, `users/${GOOGLE_SUB}`),
		).toBeNull();
	});

	it("resolves BOTH of one person's Google accounts to that same user", async () => {
		// Real shape: a human signs into Lobu with their work Google account and
		// their personal one, so two `google_user_id` rows land on one `$member`.
		// Each must resolve independently — neither is ambiguity.
		const { orgId, userId, memberEntityId } = await seedMember(
			"alice@acme.test",
		);
		const SECOND_SUB = "100000000000000000002";
		await stamp(orgId, memberEntityId, "google_user_id", GOOGLE_SUB);
		await stamp(orgId, memberEntityId, "google_user_id", SECOND_SUB);

		expect(
			await resolveChatUserIdentity("gchat", undefined, `users/${GOOGLE_SUB}`),
		).toBe(userId);
		expect(
			await resolveChatUserIdentity("gchat", undefined, `users/${SECOND_SUB}`),
		).toBe(userId);
	});

	it("fails closed when two distinct users are reachable from one sender id", async () => {
		const a = await seedMember("alice@acme.test");
		const b = await seedMember("bob@acme.test");
		await stamp(a.orgId, a.memberEntityId, "google_user_id", GOOGLE_SUB);
		await stamp(b.orgId, b.memberEntityId, "google_user_id", GOOGLE_SUB);

		// The graph is inconsistent — one Google account cannot be two humans.
		// Returning either one would be an arbitrary privilege grant.
		expect(
			await resolveChatUserIdentity("gchat", undefined, `users/${GOOGLE_SUB}`),
		).toBeNull();
	});
});

/**
 * `userKeyScope` and `platformUserIdFromKey` are the reverse direction of
 * `buildUserKey`, and all three must agree or the reverse lookup silently
 * searches the wrong key space — or returns an id the platform cannot address.
 * These enumerate the registry, so a newly registered platform is covered
 * without editing this file.
 */
describe("chat user key scope contract", () => {
	it("every registered platform declares a scope", () => {
		const declared = Object.fromEntries(
			CHAT_USER_IDENTITIES.map((identity) => [
				identity.platform,
				identity.userKeyScope("T0XYZ")?.kind ?? null,
			]),
		);
		// Golden pin: a platform silently flipping to `global` would widen its
		// reverse lookup across tenants, which no outcome-level test would catch.
		expect(declared).toEqual({ slack: "team-prefix", gchat: "global" });
	});

	// A representative sender id per platform, in the form that platform
	// ADDRESSES a person — what an inbound event carries and what its API takes
	// back. This IS platform knowledge, so it is declared rather than guessed —
	// and pinned against the registry below, so a newly registered platform fails
	// here with a clear reason instead of silently skipping the invariants.
	const SAMPLE_USER_ID: Record<string, string> = {
		slack: "U12345",
		gchat: "users/110000000000000000001",
	};

	it("every registered platform has a sample id for the invariant below", () => {
		expect(Object.keys(SAMPLE_USER_ID).sort()).toEqual(
			CHAT_USER_IDENTITIES.map((i) => i.platform).sort(),
		);
	});

	it.each(CHAT_USER_IDENTITIES.map((i) => [i.platform, i] as const))(
		"%s: a key built for a team lies inside that team's scope",
		(platform, identity) => {
			// THE invariant tying the two directions together. If a platform's
			// prefix and its built keys ever disagree, `resolveChatUserIdForUser`
			// returns null for identities that genuinely exist.
			const scope = identity.userKeyScope("T0XYZ");
			if (!scope) throw new Error("expected a scope for a valid team id");
			const sample = SAMPLE_USER_ID[platform];
			const key = identity.buildUserKey("T0XYZ", sample);
			if (!key) throw new Error(`expected a key for ${platform}/${sample}`);
			if (scope.kind === "team-prefix") {
				expect(key.startsWith(scope.prefix)).toBe(true);
				// And the prefix is not the whole key — there is a user half left
				// for `platformUserIdFromKey` to recover.
				expect(key.slice(scope.prefix.length)).toBeTruthy();
			} else {
				// A global platform must not smuggle a tenant into its key.
				expect(identity.buildUserKey("T-OTHER", sample)).toBe(key);
			}
		},
	);

	it.each(CHAT_USER_IDENTITIES.map((i) => [i.platform, i] as const))(
		"%s: a stored key round-trips to the id the platform addresses",
		(platform, identity) => {
			// The half that is NOT prefix-stripping. Google stores a bare account
			// id but addresses `users/<id>`, and the chat SDK picks its adapter off
			// that prefix — so a reverse lookup that returned the raw key would
			// hand `openDM` an id it cannot route. Round-tripping through
			// `buildUserKey` proves the recovered form is the one the writer takes.
			const sample = SAMPLE_USER_ID[platform];
			const key = identity.buildUserKey("T0XYZ", sample);
			if (!key) throw new Error(`expected a key for ${platform}/${sample}`);
			const addressable = identity.platformUserIdFromKey(key);
			expect(addressable).toBe(sample);
			expect(identity.buildUserKey("T0XYZ", addressable)).toBe(key);
		},
	);

	it("a team-scoped platform refuses a missing or blank team, never widening", () => {
		for (const identity of CHAT_USER_IDENTITIES) {
			if (identity.userKeyScope("T0XYZ")?.kind !== "team-prefix") continue;
			// Refusal, NOT `{kind:"global"}` — the whole point of the nullable.
			expect(identity.userKeyScope(null)).toBeNull();
			expect(identity.userKeyScope(undefined)).toBeNull();
			expect(identity.userKeyScope("   ")).toBeNull();
		}
	});
});
