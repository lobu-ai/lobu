/**
 * Auto operations use the same append-only ledger cards as approval runs.
 * Their card starts at auto_approved because organization policy admitted
 * execution, then follows the shared completion and failure transitions.
 */

import { deepRedactSecrets, isSecretKey, REDACTED_SENTINEL } from "@lobu/core";
import { getDb } from "../db/client";
import { ApprovalKind, approvalContext, highApprovalImpact, normalApprovalImpact } from "../utils/approval-context";
import type { OperationDescriptor } from "./types";
import { runLeaseFence } from "../runs/run-lease";
import { supersedeActionEvent } from "../tools/admin/approval-events";

/** The same review details apply whether Ask is decided at admission or dispatch. */
export function connectorApprovalMetadata(
	connectionName: string,
	operation: Pick<OperationDescriptor, "name" | "annotations">,
	input: Record<string, unknown>,
) {
	return {
		...approvalContext(
			ApprovalKind.Connector,
			operation.annotations?.destructiveHint === true
				? highApprovalImpact(
					"This action can remove or irreversibly change data in the connected service.",
					["Lobu may not be able to undo the external change."],
				)
				: normalApprovalImpact(),
		),
		review_fields: [
			{ key: "resource", value: "Connector operation" },
			{ key: "connection", value: connectionName },
			{ key: "operation", value: operation.name },
			...Object.entries(input).map(([key, value]) => ({
				key: `input_${key}`,
				value: value != null && isSecretKey(key) ? REDACTED_SENTINEL : deepRedactSecrets(value),
			})),
		],
	};
}

/**
 * Origin id of the dispatch card a non-queued operation run writes. Source
 * identity for the card, since `events.id` is a stored-version id that a
 * supersede re-mints; the queued branch's counterpart is `run_<id>_pending`.
 */
export function autoOperationCardOriginId(runId: number): string {
	return `run_${runId}_auto`;
}

/** `metadata.status` on a dispatch card that needed no human decision. */
export const AUTO_APPROVED_CARD_STATUS = "auto_approved";

export type InlineOperationTerminal =
	| { status: "completed"; output: Record<string, unknown> }
	| {
			status: "failed";
			errorMessage: string;
			output?: Record<string, unknown> | null;
	  };

/**
 * Land a gateway-executed operation run's terminal state AND its terminal card
 * in ONE transaction, so the ledger can never disagree with the run: a card
 * write that throws rolls the runs write back, and the caller retries or
 * reports the failure.
 *
 * Returns false when the lease fence matched no row — the run was cancelled,
 * reaped or re-claimed while this request was executing, and the durable row
 * is authoritative (see {@link runLeaseFence}).
 *
 * A run with no current card supersedes nothing and is NOT an error here:
 * `supersedeActionEvent` returns undefined for an auto run created by a pod
 * that predates the dispatch card, and refusing to terminalize it would strand
 * a live run. The fail-closed `requireApprovalCard` guard stays where it
 * belongs — on a managed approval DECISION, which always has a card.
 */
export async function terminalizeInlineOperationRun(
	runId: number,
	organizationId: string,
	claimedBy: string,
	terminal: InlineOperationTerminal,
): Promise<boolean> {
	return getDb().begin(async (tx) => {
		const output = terminal.output ?? null;
		const errorMessage =
			terminal.status === "failed" ? terminal.errorMessage : null;
		// `action_output` is written only when this terminal carries one. A
		// failure without output must leave the column alone rather than null
		// out a payload an earlier phase of the same run already persisted.
		const rows = await tx<{ action_key: string | null }>`
			UPDATE runs
			SET status = ${terminal.status},
			    completed_at = NOW(),
			    error_message = ${errorMessage}
			    ${output === null ? tx`` : tx`, action_output = ${tx.json(output)}`}
			WHERE id = ${runId}
			  AND organization_id = ${organizationId}
			  ${runLeaseFence(tx, claimedBy)}
			RETURNING action_key
		`;
		if (rows.length === 0) return false;
		const actionKey = rows[0].action_key ?? "Operation";
		await supersedeActionEvent(
			runId,
			organizationId,
			terminal.status,
			`${actionKey} — ${terminal.status}`,
			terminal.status === "completed"
				? `Operation completed: ${actionKey}`
				: `Operation failed: ${actionKey} — ${terminal.errorMessage}`,
			terminal.status === "completed"
				? { output: terminal.output }
				: {
						error_message: terminal.errorMessage,
						...(output === null ? {} : { output }),
					},
			null,
			tx,
		);
		return true;
	});
}
