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
 * SQL for the device the `runs` row in scope executes on, or NULL: its explicit
 * `target_device_worker_id`, else the device its connection is pinned to. The
 * connection's visibility and creator are deliberately not consulted — a device
 * pinned into a team workspace still runs on its owner's machine.
 */
function runDeviceWorkerIdSql(sql: DbClient) {
	return sql`COALESCE(runs.target_device_worker_id, (
		SELECT c.device_worker_id
		FROM connections c
		WHERE c.id = runs.connection_id
		  AND c.organization_id = runs.organization_id
	))`;
}

/**
 * SQL for the member who decides the `runs` row in scope beyond the admins, or
 * NULL:
 *
 * - a device-targeted run (see {@link runDeviceWorkerIdSql}) is decided by the
 *   device's owner (`device_workers.user_id`) — and by nobody else, admins
 *   included; {@link resolveRunDevice} is what makes that exclusive;
 * - an entity-change proposal is decided by the field owner it records in
 *   `action_input.owner_user_id` (resolved from field_controls at propose time).
 *
 * An action run's `action_input` is agent-authored and is never read here — that
 * would let the agent nominate its own approver.
 *
 * The web gate (`manage_operations approve|reject`), the chat card gate and the
 * approval notification all read this one expression, so who may decide a run
 * cannot drift between them.
 */
export function runDeciderUserIdSql(sql: DbClient) {
	const actionKeys = pgTextArray([...ENTITY_CHANGE_ACTION_KEYS]);
	return sql`CASE
		WHEN ${runDeviceWorkerIdSql(sql)} IS NOT NULL THEN (
			SELECT dw.user_id FROM device_workers dw WHERE dw.id = ${runDeviceWorkerIdSql(sql)}
		)
		WHEN runs.run_type = 'internal' AND runs.action_key = ANY(${actionKeys}::text[])
			THEN runs.action_input->>'owner_user_id'
	END`;
}

/** The device a run executes on and the one user who may decide the run. */
interface RunDevice {
	/** `device_workers.user_id`; null when the device row is gone (nobody decides). */
	ownerUserId: string | null;
	/** The device's label, falling back to worker id then row id, for refusal messages. */
	label: string;
}

/**
 * The device the run executes on, or null for a run that touches no device. A
 * device-targeted run is decided ONLY by {@link RunDevice.ownerUserId}: an admin
 * who does not own the machine cannot approve work that runs on it.
 */
export async function resolveRunDevice(
	sql: DbClient,
	runId: number,
	organizationId: string,
): Promise<RunDevice | null> {
	const [row] = await sql<{ owner_user_id: string | null; label: string }>`
		SELECT dw.user_id AS owner_user_id,
		       COALESCE(dw.label, dw.worker_id, d.device_id::text) AS label
		FROM runs
		CROSS JOIN LATERAL (SELECT ${runDeviceWorkerIdSql(sql)} AS device_id) d
		LEFT JOIN device_workers dw ON dw.id = d.device_id
		WHERE runs.id = ${runId}
		  AND runs.organization_id = ${organizationId}
		  AND d.device_id IS NOT NULL
	`;
	return row ? { ownerUserId: row.owner_user_id ?? null, label: row.label } : null;
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
