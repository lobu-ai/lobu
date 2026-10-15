/**
 * Which `entity_identities` rows count as proof of who a chat sender is.
 *
 * Connector attribution (`applyEventAttributions`) matches an event onto an
 * existing entity by ANY declared identity and then accretes the event's other
 * identities onto it, sourced `connector:<key>`. A connector an organization
 * installs therefore decides which chat ids land on which `$member` in that
 * organization: an event carrying a member's email plus someone else's
 * WhatsApp JID attaches that JID to the member. Such a row is evidence from
 * data, not proof the member controls the chat account, so it must never
 * resolve a chat sender to that member — in its own organization or in any
 * other one the member belongs to.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../../__tests__/setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../../__tests__/setup/test-fixtures";
import {
	adoptChatIdentityOntoMember,
	provisionMemberAndCoreIdentities,
} from "../../../auth/subject-identities";
import { applyEventAttributions } from "../../../utils/entity-link-upsert";
import { CHAT_LINK_IDENTITY_SOURCE, resolveChatSenderMember } from "../chat-identity";

const VICTIM_EMAIL = "victim@example.test";
/** The attacker's own WhatsApp account (synthetic). */
const ATTACKER_JID = "15550000001@s.whatsapp.net";
const PLATFORM = "whatsapp.web";

async function seed() {
	const victim = await createTestUser({ name: "Victim", email: VICTIM_EMAIL });
	// Org X: an organization the victim belongs to, where someone else can
	// install connectors. Org Y: the victim's own organization with a chat bot.
	const orgX = await createTestOrganization({ name: "Org X", visibility: "private" });
	const orgY = await createTestOrganization({ name: "Org Y", visibility: "private" });
	await addUserToOrganization(victim.id, orgX.id, "member");
	await addUserToOrganization(victim.id, orgY.id, "owner");
	const x = await provisionMemberAndCoreIdentities(orgX.id, {
		userId: victim.id,
		email: VICTIM_EMAIL,
		name: "Victim",
	});
	const y = await provisionMemberAndCoreIdentities(orgY.id, {
		userId: victim.id,
		email: VICTIM_EMAIL,
		name: "Victim",
	});
	return { victim, orgX, orgY, memberX: x.memberEntityId, memberY: y.memberEntityId };
}

/**
 * Org X's connector reports one contact event: the victim's email and the
 * attacker's JID. The rule is what any installed connector may declare.
 */
async function attributeAttackerJidInOrgX(orgXId: string) {
	await applyEventAttributions({
		connectorKey: "crm",
		orgId: orgXId,
		items: [
			{
				origin_type: "contact",
				metadata: { email: VICTIM_EMAIL, jid: ATTACKER_JID },
			},
		],
		rules: {
			contact: [
				{
					entityType: "person",
					autoCreate: false,
					identities: [
						{ namespace: "email", eventPath: "metadata.email" },
						{ namespace: "whatsapp_user_jid", eventPath: "metadata.jid" },
					],
				},
			],
		},
	});
}

describe("chat sender identity trust", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("connector attribution attaches a foreign chat id to a member (the precondition)", async () => {
		const { orgX, memberX } = await seed();
		await attributeAttackerJidInOrgX(orgX.id);

		const rows = await getTestDb()<{ entity_id: number; source_connector: string }[]>`
      SELECT entity_id, source_connector
      FROM entity_identities
      WHERE organization_id = ${orgX.id}
        AND namespace = 'whatsapp_user_jid'
        AND identifier = ${ATTACKER_JID}
        AND deleted_at IS NULL
    `;
		expect(rows).toEqual([{ entity_id: memberX, source_connector: "connector:crm" }]);
	});

	it("a connector-attributed chat id does not resolve the sender in another organization", async () => {
		const { orgX, orgY } = await seed();
		await attributeAttackerJidInOrgX(orgX.id);

		expect(await resolveChatSenderMember(PLATFORM, undefined, ATTACKER_JID, orgY.id)).toBeNull();
	});

	it("a connector-attributed chat id does not resolve the sender in its own organization", async () => {
		const { orgX } = await seed();
		await attributeAttackerJidInOrgX(orgX.id);

		expect(await resolveChatSenderMember(PLATFORM, undefined, ATTACKER_JID, orgX.id)).toBeNull();
	});

	it("a sign-in row resolves in every organization; a redeemed link only in its own", async () => {
		const { victim, orgX, orgY, memberX } = await seed();
		const sql = getTestDb();
		await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector, scope_key
      ) VALUES (${orgX.id}, ${memberX}, 'whatsapp_user_jid', ${ATTACKER_JID}, ${CHAT_LINK_IDENTITY_SOURCE}, NULL)
    `;
		expect(await resolveChatSenderMember(PLATFORM, undefined, ATTACKER_JID, orgX.id)).toEqual({
			userId: victim.id,
			role: "member",
		});
		expect(await resolveChatSenderMember(PLATFORM, undefined, ATTACKER_JID, orgY.id)).toBeNull();

		await sql`
      UPDATE entity_identities SET source_connector = 'auth:signup'
      WHERE organization_id = ${orgX.id} AND namespace = 'whatsapp_user_jid'
    `;
		expect(await resolveChatSenderMember(PLATFORM, undefined, ATTACKER_JID, orgY.id)).toEqual({
			userId: victim.id,
			role: "owner",
		});
	});

	it("the member redeeming a link for an attributed chat id makes it proof in that organization", async () => {
		const { victim, orgX, orgY, memberX } = await seed();
		await attributeAttackerJidInOrgX(orgX.id);

		expect(
			await adoptChatIdentityOntoMember(
				getTestDb(),
				orgX.id,
				memberX,
				"whatsapp_user_jid",
				ATTACKER_JID,
				victim.id,
				"link",
			),
		).toBe("already-owned");
		expect(await resolveChatSenderMember(PLATFORM, undefined, ATTACKER_JID, orgX.id)).toEqual({
			userId: victim.id,
			role: "member",
		});
		expect(await resolveChatSenderMember(PLATFORM, undefined, ATTACKER_JID, orgY.id)).toBeNull();
	});
});
