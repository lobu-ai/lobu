/**
 * Postgres-backed `pending-tool:<requestId>` store. Backed by the
 * `oauth_states` table with a `pending-tool` scope so the MCP proxy
 * (writer) and the interaction bridge / CLI gateway (reader) can hand off
 * blocked-tool invocations through a single primitive.
 */

import { getDb } from "../../../db/client.js";

const SCOPE = "pending-tool";

interface PendingToolInvocationFields {
  mcpId: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  userId: string;
	organizationId: string;
  channelId?: string;
  conversationId?: string;
  teamId?: string;
  connectionId?: string;
  platform?: string;
  source?: string;
  deploymentName?: string;
}

/**
 * The signed per-turn admin-tool allowlist and the canonical Lobu actor it is
 * bound to, preserved across approval resume. Modeled as a PAIR, not two
 * independent optional fields: the resumed call mints a worker token carrying
 * this allowlist, so an allowlist with no verified actor must never be
 * constructible or round-trippable as valid.
 */
export type PendingAdminGrant =
  | { adminTools: string[]; adminActorUserId: string }
  | { adminTools?: undefined; adminActorUserId?: undefined };

export type PendingToolInvocation = PendingToolInvocationFields &
  PendingAdminGrant;

/**
 * Fail closed on an unpaired admin grant: drop the tier entirely rather than
 * defaulting an actor. A legacy or tampered payload carrying an allowlist with
 * no actor (or an actor with no allowlist) resumes as a plain, non-admin call.
 */
export function pairAdminGrant(
  adminTools: string[] | undefined,
  adminActorUserId: string | undefined,
): PendingAdminGrant {
  if (!adminTools?.length || !adminActorUserId) return {};
  return { adminTools, adminActorUserId };
}

function withPairedAdminGrant(
  payload: PendingToolInvocation,
): PendingToolInvocation {
  const { adminTools, adminActorUserId, ...rest } = payload;
  return { ...rest, ...pairAdminGrant(adminTools, adminActorUserId) };
}

export async function storePendingTool(
  requestId: string,
  invocation: PendingToolInvocation,
	ttlSeconds: number,
): Promise<void> {
  const sql = getDb();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await sql`
    INSERT INTO oauth_states (id, scope, payload, expires_at)
    VALUES (${requestId}, ${SCOPE}, ${sql.json(invocation as object)}, ${expiresAt})
    ON CONFLICT (id) DO UPDATE SET
      scope = EXCLUDED.scope,
      payload = EXCLUDED.payload,
      expires_at = EXCLUDED.expires_at
  `;
}

/**
 * Read (without consuming) the unresolved pending-tool invocations for a
 * conversation. The live `tool-approval` SSE card is one-shot, so without this
 * a pending approval vanishes from the web UI on reload. The SPA fetches this
 * on load and replays open approvals as approval cards; resolution stays
 * claim-and-delete via `takePendingTool`, so a row surfaced here disappears the
 * moment the user approves/denies and never replays.
 *
 * `organizationId` is REQUIRED — it MUST be the caller's AUTHORIZED org
 * (resolved by the route's authorizeAgentAccess) and always scopes the read so a
 * row can never cross tenants, defense-in-depth on top of the conversationId
 * key. The route returns 403 when no org resolves rather than ever issuing an
 * unscoped read.
 */
export async function listPendingToolsForConversation(
	conversationId: string,
	organizationId: string,
): Promise<Array<PendingToolInvocation & { requestId: string }>> {
	const sql = getDb();
	const rows = await sql`
    SELECT id, payload
    FROM oauth_states
    WHERE scope = ${SCOPE}
      AND expires_at > now()
      AND payload->>'conversationId' = ${conversationId}
      AND payload->>'organizationId' = ${organizationId}
    ORDER BY expires_at ASC
  `;
	return rows.map((r) => {
		const row = r as { id: string; payload: PendingToolInvocation };
		return { ...withPairedAdminGrant(row.payload), requestId: row.id };
	});
}

/**
 * Atomically fetch and delete a pending tool invocation. Used by the
 * interaction bridge / CLI approve handler to claim the row exactly
 * once — Slack/Telegram webhook retries that arrive after the first
 * click see null and no-op.
 */
export interface PendingToolClaimant {
	userId: string;
	organizationId?: string;
	conversationId?: string;
}

export async function takePendingTool(
	requestId: string,
	claimant: PendingToolClaimant,
): Promise<PendingToolInvocation | null> {
  const sql = getDb();
  const rows = await sql`
    DELETE FROM oauth_states
    WHERE id = ${requestId}
      AND scope = ${SCOPE}
      AND expires_at > now()
      AND payload->>'userId' = ${claimant.userId}
      AND (${claimant.organizationId ?? null}::text IS NULL OR payload->>'organizationId' = ${claimant.organizationId ?? null})
      AND (${claimant.conversationId ?? null}::text IS NULL OR payload->>'conversationId' = ${claimant.conversationId ?? null})
    RETURNING payload
  `;
  if (rows.length === 0) return null;
	const payload = (rows[0] as { payload: PendingToolInvocation }).payload;
	return payload ? withPairedAdminGrant(payload) : null;
}

/** Active tool approvals belonging to this Automation run's agent session. */
export async function listPendingToolsForRun(
	runId: number,
	sql: ReturnType<typeof getDb>
): Promise<Array<{ mcpId: string; toolName: string }>> {
	const rows = await sql`
    SELECT DISTINCT
      pending.payload->>'mcpId' AS mcp_id,
      pending.payload->>'toolName' AS tool_name
    FROM oauth_states pending
    JOIN runs automation_run
      ON automation_run.id = ${runId}
     AND automation_run.run_type = 'automation'
    WHERE pending.scope = ${SCOPE}
      AND pending.expires_at > now()
      AND pending.payload->>'organizationId' = automation_run.organization_id
      AND right(
        pending.payload->>'conversationId',
        length(
          '_automation_' || automation_run.automation_id::text ||
          '_run_' || automation_run.id::text
        )
      ) = '_automation_' || automation_run.automation_id::text ||
          '_run_' || automation_run.id::text
    ORDER BY mcp_id, tool_name
  `;
	return rows
		.map((r) => r as { mcp_id: string | null; tool_name: string | null })
		.filter((r) => r.mcp_id && r.tool_name)
		.map((r) => ({ mcpId: r.mcp_id as string, toolName: r.tool_name as string }));
}
