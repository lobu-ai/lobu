/**
 * Which agent an unlinked DM binds itself to.
 *
 * A connection created by an OAuth install has no owning agent — routing is by
 * Automation, and before one exists a DM resolves to nothing. That dead end used
 * to be answered with a notice asking the person to go build the Automation by
 * hand, which is a strange thing to ask of someone who just installed the app
 * and sent "hi".
 *
 * The rule is deliberately narrow: bind only when the org's agent is
 * UNAMBIGUOUS. With several, picking one would be a guess — a DM silently wired
 * to the billing agent instead of the support agent is worse than being asked —
 * so those keep the notice and its per-agent deep links. With none there is
 * nothing to bind to at all. Nothing is stored or marked here, so the answer
 * changes by itself the moment the org gains a second agent; that is a statement
 * about ambiguity, not a "default agent" setting anyone has to manage.
 */

import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client";
import { resolveChatUserIdentity } from "../../lobu/stores/chat-identity";
import { errorMessage } from "../../utils/errors";
import { getMembershipRole } from "../../workspace/multi-tenant";

const logger = createLogger("chat-auto-bind");

/**
 * The org's only agent, or null when it has none or more than one.
 *
 * `LIMIT 2` is the whole trick: it distinguishes "exactly one" from "more than
 * one" without counting a table that an established org can fill.
 */
export async function resolveSoleOrgAgent(
	organizationId: string,
): Promise<string | null> {
	try {
		const rows = await getDb()<{ id: string }>`
      SELECT id
      FROM agents
      WHERE organization_id = ${organizationId}
      LIMIT 2
    `;
		return rows.length === 1 ? (rows[0]?.id ?? null) : null;
	} catch (err) {
		// Best effort, like every other read on the inbound-message hot path: a
		// lookup failure must fall through to the notice, never throw out of
		// message handling and drop the message entirely.
		logger.warn(
			{ err: errorMessage(err), organizationId },
			"[auto-bind] sole-agent lookup failed",
		);
		return null;
	}
}

/**
 * Whether this sender may have their chat bound into the connection's org.
 *
 * A connection with an owning agent carries an admin's explicit decision that
 * the bot answers whoever can reach it. An ownerless one carries no such
 * decision, so the bind cannot inherit one — and on an open-address platform
 * (Telegram, WhatsApp) a tenant's bot is reachable by ANY stranger, who would
 * otherwise be handed that org's agent, its model credentials and its tools.
 *
 * So require the sender to be someone the org actually contains. The chat
 * identity registry answers null for a platform with no sender-identity model
 * at all, which is its deliberate fail-closed answer and exactly the verdict
 * wanted here; the membership read then scopes it to THIS organization, since
 * an identity resolves across every org the person belongs to.
 */
export async function senderMayAutoBind(params: {
	platform: string;
	teamId: string | undefined;
	platformUserId: string;
	organizationId: string;
}): Promise<boolean> {
	try {
		const userId = await resolveChatUserIdentity(
			params.platform,
			params.teamId,
			params.platformUserId,
		);
		if (!userId) return false;
		return (await getMembershipRole(params.organizationId, userId)) !== null;
	} catch (err) {
		// Fail closed: an authority check that cannot complete is not a pass.
		logger.warn(
			{ err: errorMessage(err), organizationId: params.organizationId },
			"[auto-bind] sender authority check failed",
		);
		return false;
	}
}
