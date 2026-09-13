/**
 * Persistence helpers for ACL-sync failures and derived ACL state. The shared
 * `connections.error_message` column is not ACL-owned, so ACL writes and clears
 * only touch values carrying the `acl: ` prefix. Other connection errors remain
 * authoritative when both subsystems fail at once.
 */

import { type DbClient, getDb } from "../db/client.js";
import { bumpAclGeneration } from "./acl-generation.js";

export const ACL_ERROR_MESSAGE_PREFIX = "acl: ";

/** Maximum length of the complete persisted message, including its prefix. */
const ACL_ERROR_MESSAGE_MAX_LENGTH = 500;

export function isAclErrorMessage(message: string | null | undefined): boolean {
	return (
		typeof message === "string" && message.startsWith(ACL_ERROR_MESSAGE_PREFIX)
	);
}

export function formatAclErrorMessage(reason: string): string {
	const maxReasonLength =
		ACL_ERROR_MESSAGE_MAX_LENGTH - ACL_ERROR_MESSAGE_PREFIX.length;
	const body =
		reason.length > maxReasonLength
			? `${reason.slice(0, maxReasonLength - 1)}…`
			: reason;
	return `${ACL_ERROR_MESSAGE_PREFIX}${body}`;
}

/** The exact `authz_source_acl_state.connection_id` for a connections row. */
export function aclConnectionIdSql(tableAlias?: "c"): string {
	const prefix = tableAlias ? `${tableAlias}.` : "";
	return `CASE
    WHEN ${prefix}credential_mode IS NULL THEN ${prefix}id::text
    WHEN left(${prefix}slug, length('agentconn-')) = 'agentconn-'
      THEN substr(${prefix}slug, length('agentconn-') + 1)
    ELSE ${prefix}slug
  END`;
}

/**
 * Downgrade an existing ACL row to `failed` and persist the reason. When the
 * connection was never graphed, the state update is a no-op so the gate remains
 * on the legacy fence, but the connection error is still recorded.
 *
 * Both writes commit in one transaction so the persisted reason cannot be lost
 * between the state flip and the column write.
 *
 * An unchanged reason does not rewrite `connections.updated_at`. ACL sync
 * retries on a fixed tick, and that column is the memo key
 * `ChatInstanceManager` hydrates chat adapters against (`rowVersion`), so a
 * repeated identical failure would otherwise tear down and rehydrate
 * otherwise-working Slack instances for the length of the outage. The ACL
 * state's own timestamp and the org generation still advance on every failure,
 * so an older in-flight snapshot cannot overwrite a newer failure.
 */
export async function markConnectionAclFailed(
	organizationId: string,
	connectionId: string,
	reason: string,
): Promise<void> {
	const sql = getDb();
	const message = formatAclErrorMessage(reason);
	await sql.begin(async (tx) => {
		// ORGANIZATION FIRST, then connections, then ACL state — the same order as
		// `markAclFresh` and as organization deletion, whose `ON DELETE CASCADE`
		// reaches connections while already holding the org row. Bumping after the
		// connection lock would invert that and deadlock against a concurrent org
		// delete.
		await bumpAclGeneration(tx, organizationId);
		// Then lock the live connection row UNCONDITIONALLY: the message UPDATE
		// below is conditional, so a repeated identical failure would take no row
		// lock at all and could interleave with `clearConnectionAclError`.
		await tx`
      SELECT 1
      FROM connections
      WHERE organization_id = ${organizationId}
        AND deleted_at IS NULL
        AND ${tx.unsafe(aclConnectionIdSql())} = ${connectionId}
      FOR UPDATE
    `;
		await tx`
      UPDATE connections
      SET error_message = ${message}, updated_at = current_timestamp
      WHERE organization_id = ${organizationId}
        AND deleted_at IS NULL
        AND ${tx.unsafe(aclConnectionIdSql())} = ${connectionId}
        AND (
          error_message IS NULL
          OR left(error_message, ${ACL_ERROR_MESSAGE_PREFIX.length}) = ${ACL_ERROR_MESSAGE_PREFIX}
        )
        AND error_message IS DISTINCT FROM ${message}
    `;
		await tx`
      UPDATE authz_source_acl_state
      SET freshness_state = 'failed', updated_at = clock_timestamp()
      WHERE organization_id = ${organizationId}
        AND connection_id = ${connectionId}
    `;
	});
}

/**
 * Clear the persisted ACL failure reason once a sync succeeds without removing
 * another subsystem's error. The state must still be `fresh`: an older sync
 * whose freshness stamp lost to a newer failure must not clear that failure's
 * reason afterward.
 */
export async function clearConnectionAclError(
	organizationId: string,
	connectionId: string,
): Promise<void> {
	const sql = getDb();
	await sql.begin(async (tx) => {
		// Take the connection lock BEFORE reading freshness, in the same order as
		// `markConnectionAclFailed`. Without it these two can interleave: under
		// READ COMMITTED a single UPDATE evaluates its freshness subquery against
		// the snapshot taken when the statement began, and re-checking a blocked
		// row does NOT re-run that subquery against the newer snapshot. A clear
		// could therefore observe `fresh`, wait behind a failure that then
		// commits, and erase the newly recorded reason — leaving
		// `freshness_state='failed'` with no cause, which is exactly the blindness
		// this module exists to remove. Locking first forces the freshness read
		// into a statement that begins after the failure has committed.
		await tx`
      SELECT 1
      FROM connections
      WHERE organization_id = ${organizationId}
        AND deleted_at IS NULL
        AND ${tx.unsafe(aclConnectionIdSql())} = ${connectionId}
      FOR UPDATE
    `;
		await tx`
      UPDATE connections
      SET error_message = NULL, updated_at = current_timestamp
      WHERE organization_id = ${organizationId}
        AND deleted_at IS NULL
        AND left(error_message, ${ACL_ERROR_MESSAGE_PREFIX.length}) = ${ACL_ERROR_MESSAGE_PREFIX}
        AND ${tx.unsafe(aclConnectionIdSql())} = ${connectionId}
        AND EXISTS (
          SELECT 1
          FROM authz_source_acl_state a
          WHERE a.organization_id = ${organizationId}
            AND a.connection_id = ${connectionId}
            AND a.freshness_state = 'fresh'
        )
    `;
	});
}

/**
 * Delete a connection's ACL-enforcement row when its connection is deleted.
 * `authz_source_acl_state` is a pure materialization (rebuildable by the next
 * sync) with no foreign-key dependents, so removing it on deletion is safe.
 *
 * Resolve the ACL key from the stored connection row at the deletion
 * chokepoint. Data ACL rows use `connections.id::text`; chat ACL rows use the
 * runtime id derived from their slug. Deriving the kind here prevents a caller
 * from deleting another connection's state through a colliding slug.
 */
export async function deleteConnectionAclRow(
	sql: DbClient,
	params: {
		organizationId: string;
		connectionId: string | number;
	},
): Promise<void> {
	await sql`
    DELETE FROM authz_source_acl_state a
    USING connections c
    WHERE c.id = ${params.connectionId}
      AND c.organization_id = ${params.organizationId}
      AND a.organization_id = c.organization_id
      AND a.connection_id = ${sql.unsafe(aclConnectionIdSql("c"))}
  `;
}

/**
 * Clear the ACL-owned error text on a connection, leaving every other piece
 * of ACL state alone.
 *
 * For a connection a source deliberately EXCLUDES from its sweep (a
 * consent-only grant-holder), {@link clearConnectionAclError} can never fire:
 * it only clears behind a `fresh` state, and an excluded connection never syncs
 * to reach one. Without this, a failure message recorded by an earlier tick —
 * or by any tick before the exclusion existed — stays on a healthy row forever.
 *
 * Deliberately does NOT touch `authz_source_acl_state`. Dropping that row moves
 * a graphed connection to `not-graphed`, which is the legacy path of
 * `compileResourceVisibility` for its UNSTAMPED rows — while its
 * resource-stamped rows stay fail-closed with no enforced authority to
 * satisfy them. Retaining a `failed` row keeps exactly that fail-closed
 * posture; only the operator-facing message is stale, and only it is cleared.
 *
 * Only `acl:`-prefixed text is cleared, so another subsystem's error message
 * survives untouched.
 */
export async function clearRetainedAclErrorMessage(
	sql: DbClient,
	params: {
		organizationId: string;
		connectionId: string | number;
	},
): Promise<void> {
	await sql`
    UPDATE connections
    SET error_message = NULL, updated_at = current_timestamp
    WHERE id = ${params.connectionId}
      AND organization_id = ${params.organizationId}
      AND deleted_at IS NULL
      AND left(error_message, ${ACL_ERROR_MESSAGE_PREFIX.length}) = ${ACL_ERROR_MESSAGE_PREFIX}
  `;
}
