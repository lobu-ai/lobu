import { type DbClient, pgTextArray } from "../../db/client";

/** Synthetic runs.action_key tagging an automation field-change held for approval. */
export const ENTITY_FIELD_CHANGE_ACTION_KEY = "entity_field_change";
export const ENTITY_CHANGE_ACTION_KEY = "entity_change";
/**
 * The entity-change run family. Lives in this leaf module (database client
 * only) so the notification and chat layers can read who decides a run
 * without importing `entity-field-approval`'s circular graph.
 */
export const ENTITY_CHANGE_ACTION_KEYS = [
	ENTITY_FIELD_CHANGE_ACTION_KEY,
	ENTITY_CHANGE_ACTION_KEY,
] as const;

/**
 * SQL for the one non-admin member allowed to decide the `runs` row in scope,
 * or NULL. Admins and owners decide every run; beyond them:
 *
 * - an entity-change proposal is decided by the field owner it records in
 *   `action_input.owner_user_id` (resolved from field_controls at propose time);
 * - a connector operation on a connection pinned to a device is decided by that
 *   device's owner: it runs on their own machine. A connection shared with the
 *   workspace qualifies, so a chat request the device access rule holds for the
 *   owner (authz/device-access.ts) reaches them; a PRIVATE connection qualifies
 *   only when the device owner also created it.
 *
 * An action run's `action_input` is agent-authored and is never read here — that
 * would let the agent nominate its own approver.
 *
 * The web gate (`manage_operations approve|reject`) and the chat card gate both
 * read this one expression, so who may decide a run cannot drift between them.
 */
export function runDeciderUserIdSql(sql: DbClient) {
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	return sql`CASE
		WHEN runs.run_type = 'internal' AND runs.action_key = ANY(${actionKeys}::text[])
			THEN runs.action_input->>'owner_user_id'
		WHEN runs.run_type = 'action' THEN (
			SELECT dw.user_id
			FROM connections c
			JOIN device_workers dw ON dw.id = c.device_worker_id
			WHERE c.id = runs.connection_id
			  AND c.organization_id = runs.organization_id
			  AND c.deleted_at IS NULL
			  AND (c.visibility <> 'private' OR c.created_by = dw.user_id)
		)
	END`;
}

/**
 * The run's non-admin decider (see {@link runDeciderUserIdSql}) while they are
 * still a member of the run's workspace, or null.
 */
export async function resolveRunDeciderUserId(
	sql: DbClient,
	runId: number,
	organizationId: string,
): Promise<string | null> {
	const [row] = await sql<{ decider: string }>`
		SELECT d.decider
		FROM runs
		CROSS JOIN LATERAL (SELECT ${runDeciderUserIdSql(sql)} AS decider) d
		WHERE runs.id = ${runId}
		  AND runs.organization_id = ${organizationId}
		  AND EXISTS (
		    SELECT 1 FROM "member" m
		    WHERE m."organizationId" = runs.organization_id AND m."userId" = d.decider
		  )
	`;
	return row?.decider ?? null;
}
