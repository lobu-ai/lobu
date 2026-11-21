import { type DbClient, pgTextArray } from "../db/client";
import { supersedeActionEvent } from "../tools/admin/approval-events";
import { APPROVAL_RUN_TYPES } from "../utils/run-statuses";

const approvalExpiryReason = "Connection deleted before approval; approval expired.";

/**
 * Settle the holds while their connection is being tombstoned. The caller must
 * hold the connection row lock inside the same transaction. A pending approval
 * would be unreviewable after the tombstone, so its card must advance atomically;
 * a Check has no approval card. Return the expired approvals for delivery cleanup.
 */
export async function settleConnectionHolds(
	tx: DbClient,
	organizationId: string,
	connectionId: number | string,
): Promise<number[]> {
	const approvalRunTypes = pgTextArray([...APPROVAL_RUN_TYPES]);
	const pending = await tx<{ id: number }>`
		SELECT id FROM runs
		WHERE organization_id = ${organizationId} AND connection_id = ${connectionId}
		  AND approval_status = 'pending'
		  AND run_type = ANY(${approvalRunTypes}::text[])
		ORDER BY id
		FOR UPDATE
	`;
	for (const { id } of pending) {
		await tx`
			UPDATE runs SET approval_status = 'expired', status = 'cancelled',
			       error_message = ${approvalExpiryReason}, completed_at = NOW()
			WHERE id = ${id} AND organization_id = ${organizationId}
		`;
		const eventId = await supersedeActionEvent(
			id, organizationId, "rejected", (operation) => `${operation} — expired`,
			approvalExpiryReason, { expiry_reason: approvalExpiryReason, approval_status: "expired" },
			null, tx,
		);
		if (eventId === undefined) {
			throw new Error(`Cannot expire approval run ${id}: its approval card is missing`);
		}
	}

	await tx`
		UPDATE runs SET approval_status = 'withdrawn', status = 'cancelled',
		       error_message = 'Connection deleted before the requester confirmed the check.',
		       completed_at = NOW()
		WHERE organization_id = ${organizationId} AND connection_id = ${connectionId}
		  AND approval_status = 'check' AND status = 'pending' AND run_type = 'action'
	`;
	return pending.map(({ id }) => id);
}
