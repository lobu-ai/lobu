import { type DbClient, getDb } from "../../db/client";
import { queueOperationOutcomeFollowup } from "../../operations/operation-outcome-followup";
import { runOwnerFence } from "../../runs/run-lease";
import { insertEvent } from "../../utils/insert-event";

/**
 * The human who decided an approval. Threaded from the approve/reject handler
 * into every event of the post-decision chain so each state records who
 * authorized it. `null` denotes a later system-driven transition.
 */
export interface ApprovalReviewer {
	userId: string;
	name: string | null;
}

/**
 * Fail-closed guard for a managed approval DECISION's card. {@link
 * supersedeActionEvent} returns `undefined` when the run has NO approval card
 * (`current_event_records` has no matching `interaction_type='approval'` row) —
 * which is legitimate only for auto/no-approval worker actions that never had a
 * card. A managed approval DECISION (approve/reject/expire) must never commit
 * its runs write without the card, or the run goes terminal while the timeline
 * stays stuck at the prior card. Callers throw on `undefined` so the enclosing
 * transaction rolls the runs write back.
 */
export function requireApprovalCard(
	runId: number,
	eventId: number | undefined,
	transition: string,
): asserts eventId is number {
	if (eventId === undefined) {
		throw new Error(
			`Cannot transition approval run ${runId} to '${transition}': its approval card is missing`,
		);
	}
}

/**
 * Atomically persist a claimed run's terminal 'completed' state AND its
 * 'completed' card. The runs write is guarded (status='running' AND
 * approval_status='approved'), so concurrent terminalizations — a human retry
 * and the stale-run reaper — cannot double-finalize: exactly one UPDATE wins,
 * the loser matches zero rows and writes no card. The card guard runs INSIDE
 * the tx, so a missing card rolls the completed write back (fail-closed).
 *
 * `expectedOwner` is the lease this write is allowed to finalize under: the
 * owner the caller claimed, or the one it read off the row when recovering a
 * run someone else claimed. It is required, because a terminalization that
 * skips the owner check is exactly the one that overwrites a re-claim.
 *
 * Returns the completed card event id, or null when the run was no longer in
 * the claimed state (already terminalized concurrently) — the caller returns a
 * "decided concurrently" outcome instead of writing anything.
 */
export async function terminalizeApprovalRunCompleted(
	runId: number,
	organizationId: string,
	output: Record<string, unknown>,
	card: { title: string; content: string },
	reviewer: ApprovalReviewer | null,
	expectedOwner: string | null,
	db: DbClient = getDb(),
): Promise<number | null> {
	return db.begin(async (tx) => {
		const rows = await tx`
			UPDATE runs
			SET status = 'completed', completed_at = NOW(),
				action_output = ${tx.json(output)}
			WHERE id = ${runId}
				AND organization_id = ${organizationId}
				AND status = 'running'
				AND approval_status = 'approved'
				${runOwnerFence(tx, expectedOwner)}
			RETURNING id
		`;
		if (rows.length === 0) return null;
		const cardId = await supersedeActionEvent(
			runId,
			organizationId,
			"completed",
			card.title,
			card.content,
			{ output },
			reviewer,
			tx,
		);
		requireApprovalCard(runId, cardId, "completed");
		return cardId;
	});
}

/**
 * Append the next durable state of an approval card, optionally on the
 * caller's transaction handle. Returns undefined when the run has no current
 * approval card so managed transitions can fail closed before committing the
 * matching `runs` write.
 */
export async function supersedeActionEvent(
	runId: number,
	organizationId: string,
	status: string,
	title: string,
	content: string,
	extraMetadata: Record<string, unknown> = {},
	reviewer: ApprovalReviewer | null = null,
	db: DbClient = getDb(),
	interactionInput?: Record<string, unknown> | null,
): Promise<number | undefined> {
	const sql = db;
	const originalEvent = await sql`
    SELECT id, entity_ids, metadata, author_name, interaction_input_schema, interaction_input
    FROM current_event_records
    WHERE run_id = ${runId}
      AND organization_id = ${organizationId}
      AND semantic_type = 'operation'
      AND interaction_type = 'approval'
    LIMIT 1
  `;
	if (originalEvent.length === 0) return undefined;

	const orig = originalEvent[0] as any;
	// Carry the reviewer forward. A decision supplies one; later system
	// transitions inherit the reviewer stamped on the prior state.
	const priorMetadata = (orig.metadata ?? {}) as Record<string, unknown>;
	const reviewedById =
		reviewer?.userId ??
		(priorMetadata.reviewed_by_id as string | undefined) ??
		null;
	const reviewedByName =
		reviewer?.name ??
		(priorMetadata.reviewed_by_name as string | undefined) ??
		null;
	const reviewedAt = reviewer
		? new Date().toISOString()
		: ((priorMetadata.reviewed_at as string | undefined) ?? null);

	const nextEvent = await insertEvent(
		{
			entityIds: Array.isArray(orig.entity_ids)
				? orig.entity_ids.map(Number)
				: [],
			organizationId,
			originId: `run_${runId}_${status}_${Date.now()}`,
			title,
			content,
			semanticType: "operation",
			runId,
			interactionType: "approval",
			interactionStatus:
				status === "confirmed"
					? "approved"
					: status === "rejected"
						? "rejected"
						: status === "completed"
							? "completed"
							: status === "failed"
								? "failed"
								: "pending",
			interactionInputSchema:
				(orig.interaction_input_schema as Record<string, unknown> | null) ??
				null,
			interactionInput:
				interactionInput === undefined
					? ((orig.interaction_input as Record<string, unknown> | null) ?? null)
					: interactionInput,
			interactionOutput:
				((extraMetadata.output ?? extraMetadata.action_output) as
					| Record<string, unknown>
					| undefined) ?? null,
			interactionError:
				(extraMetadata.error_message as string | undefined) ?? null,
			supersedesEventId: Number(orig.id),
			createdBy: reviewedById,
			metadata: {
				...priorMetadata,
				status,
				...(reviewedById ? { reviewed_by_id: reviewedById } : {}),
				...(reviewedByName ? { reviewed_by_name: reviewedByName } : {}),
				...(reviewedAt ? { reviewed_at: reviewedAt } : {}),
				...(extraMetadata.output
					? { action_output: extraMetadata.output }
					: {}),
				...(extraMetadata.error_message
					? { error_message: extraMetadata.error_message }
					: {}),
				...extraMetadata,
			},
			authorName: orig.author_name ?? null,
		},
		{ sql },
	);

	// Auto runs also have cards, and a policy veto changes their run status to
	// rejected without ever asking a human. Only an actual approval request
	// carries approval_context (including an auto run later promoted to Ask).
	if (!priorMetadata.approval_context) return Number(nextEvent.id);

	await queueOperationOutcomeFollowup(sql, {
		runId,
		organizationId,
		cardStatus: status,
		operationName: String(
			priorMetadata.operation_name ??
				priorMetadata.action_name ??
				priorMetadata.operation_key ??
				priorMetadata.action_key ??
				"Operation",
		),
		connectionName:
			typeof priorMetadata.connection_name === "string"
				? priorMetadata.connection_name
				: null,
		output: extraMetadata.output ?? extraMetadata.action_output ?? null,
		reason: String(
			extraMetadata.error_message ??
				extraMetadata.reject_reason ??
				extraMetadata.expiry_reason ??
				content,
		),
	});

	return Number(nextEvent.id);
}
