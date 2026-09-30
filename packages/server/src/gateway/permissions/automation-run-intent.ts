/**
 * Server-side verification of a `automation_run` session intent.
 *
 * `POST /api/v1/agents` accepts `intent: {kind:"automation_run", runId, automationId}`
 * from the request body and turns it into `userId = automation_<automationId>` /
 * `thread = run_<runId>`, hence a conversationId ending
 * `_automation_<automationId>_run_<runId>`. Downstream consumers recover the
 * verified Automation correlation from that suffix.
 *
 * Without this check the whole chain is caller-authored. The worker token is
 * encrypted, so its claims cannot be tampered with AFTER minting, but the
 * gateway mints them from the request body: the signature attests transport
 * integrity, not provenance. Verify once, here, where the intent enters the
 * system; never re-derive provenance from the string further down.
 */

import { hashToken } from "../../auth/oauth/utils.js";
import { type DbClient, getDb } from "../../db/client.js";
import {
	AUTOMATION_RUN_TYPES_PG,
	type ExecutionMode,
	executionModeForRunType,
} from "../../runs/run-types.js";
import logger from "../../utils/logger.js";

/**
 * `claimPendingAutomationRun`'s `claimedBy` for the server-side Automation
 * dispatcher. Device-pinned Automations are claimed by their worker instead and
 * do not take this route.
 */
const SERVER_DISPATCHER = "lobu-dispatcher";
const INTERNAL_SERVICE_CLIENT = "lobu-internal";
const AUTOMATION_CONVERSATION_SUFFIX = /_automation_(\d+)_run_(\d+)$/;

export interface AutomationRunIntent {
	runId: number;
	automationId: number;
}

/**
 * Parse the internal Automation correlation suffix.
 * Callers without a verified `automation_run` intent must never be allowed to
 * construct this shape through arbitrary user/thread fields.
 */
export function parseAutomationRunConversationId(
	conversationId: string,
): AutomationRunIntent | null {
	const match = AUTOMATION_CONVERSATION_SUFFIX.exec(conversationId);
	if (!match) return null;
	const automationId = Number(match[1]);
	const runId = Number(match[2]);
	if (
		!Number.isSafeInteger(automationId) ||
		automationId < 1 ||
		!Number.isSafeInteger(runId) ||
		runId < 1
	) {
		return null;
	}
	return { automationId, runId };
}

/**
 * Verify both halves of a server-authored Automation dispatch: the run was
 * claimed by the dispatcher, and the request bears the short-lived internal
 * OAuth token minted by that dispatcher. Run state alone is not a capability:
 * an ordinary same-org agent owner can observe or guess an in-flight run id.
 *
 * Returns the session's {@link ExecutionMode} on success and null on refusal.
 * This is also where an eval run's `capture` mode ORIGINATES: the run row is
 * already being read here to decide whether the session may exist at all, so
 * the mode is derived from the same row under the same authorization — never
 * taken from the caller, and never re-derived downstream from the
 * conversationId string.
 */
export async function verifyAutomationRunIntent(
	args: {
		intent: AutomationRunIntent;
		organizationId: string | undefined;
		accessToken: string | null;
	},
	db?: DbClient,
): Promise<ExecutionMode | null> {
	if (!args.organizationId || !args.accessToken) return null;
	const { runId, automationId } = args.intent;
	if (
		!Number.isSafeInteger(runId) ||
		runId < 1 ||
		!Number.isSafeInteger(automationId) ||
		automationId < 1
	) {
		return null;
	}
	try {
		const sql = db ?? getDb();
		const tokenHash = hashToken(args.accessToken);
		const rows = (await sql`
	      SELECT automation_run.run_type
	      FROM runs automation_run
	      JOIN oauth_tokens service_token
	        ON service_token.token_hash = ${tokenHash}
	      WHERE automation_run.id = ${runId}
	        AND automation_run.run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
	        AND automation_run.automation_id = ${automationId}
	        AND automation_run.organization_id = ${args.organizationId}
	        AND automation_run.claimed_by = ${SERVER_DISPATCHER}
	        AND automation_run.status = 'claimed'
	        AND service_token.token_type = 'access'
	        AND service_token.client_id = ${INTERNAL_SERVICE_CLIENT}
	        AND service_token.organization_id = ${args.organizationId}
	        AND service_token.revoked_at IS NULL
	        AND service_token.expires_at > NOW()
	      LIMIT 1
	    `) as unknown as Array<{ run_type: string }>;
		if (rows.length === 0) return null;
		return executionModeForRunType(rows[0].run_type);
	} catch (error) {
		logger.warn(
			{ error, runId, automationId, organizationId: args.organizationId },
			"[agent] Could not verify an Automation run intent — refusing the session",
		);
		return null;
	}
}
