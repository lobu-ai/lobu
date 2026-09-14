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
import { errorMessage } from "../../utils/errors";

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
