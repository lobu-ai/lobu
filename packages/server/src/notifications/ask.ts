/**
 * Durable lifecycle for an agent-authored question.
 *
 * The answer contract and form-compatibility rules live in `ask-schema.ts`;
 * this module only owns the existing run/event approval rail.
 */

import { eventClientId } from "../auth/event-client-id";
import { getDb } from "../db/client";
import { currentMcpActivityEventMetadata } from "../lobu/stores/mcp-client-conversations";
import { resolveRunInitiator } from "../tools/initiator";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import {
	ApprovalKind,
	approvalContext,
} from "../utils/approval-context";
import { insertEvent } from "../utils/insert-event";
import {
	CURRENT_ASK_SCHEMA_VERSION,
	validateAskInputSchema,
} from "./ask-schema";

/** `runs.action_key` for an agent-authored ask. */
export const AGENT_ASK_ACTION_KEY = "agent_ask";

/** What the agent asked, held in `runs.action_input` for the reviewer. */
export interface AgentAskProposal {
	question: string;
	/** Reviewer context retained so future Automation runs can interpret the answer. */
	context?: string;
	/** Absent on legacy pending asks created before strict answer validation. */
	input_schema_validation_version?: number;
	/** JSON Schema for the answer; an empty schema is a binary decision. */
	input_schema: Record<string, unknown>;
}

export function isAgentAskProposal(value: unknown): value is AgentAskProposal {
	if (value === null || typeof value !== "object") return false;
	const proposal = value as Record<string, unknown>;
	return (
		typeof proposal.question === "string" &&
		proposal.input_schema !== null &&
		typeof proposal.input_schema === "object" &&
		!Array.isArray(proposal.input_schema)
	);
}

/**
 * Queue an ask on the same pending-run and interaction-event rail used by
 * existing approvals. The caller writes the addressed notification that points
 * at the returned interaction event.
 */
export async function queueAgentAsk(params: {
	ctx: ToolContext;
	question: string;
	body: string | null;
	inputSchema: Record<string, unknown>;
}): Promise<{ runId: number; interactionEventId: number }> {
	const schemaError = validateAskInputSchema(params.inputSchema);
	if (schemaError) throw new ToolUserError(schemaError, 422);

	const sql = getDb();
	const proposal: AgentAskProposal = {
		question: params.question,
		...(params.body ? { context: params.body } : {}),
		input_schema_validation_version: CURRENT_ASK_SCHEMA_VERSION,
		input_schema: params.inputSchema,
	};
	const initiator = resolveRunInitiator(params.ctx);

	// Atomic: the pending run and its approval card commit together. If the card
	// INSERT fails, the run must not exist — otherwise the ask is durably
	// pending but the events-only approval surface shows nothing (the #2033
	// divergence, same as the connector queue path).
	return sql.begin(async (tx) => {
		const inserted = await tx`
			INSERT INTO runs (
				organization_id, run_type, action_key, action_input,
				automation_id, parent_run_id,
				created_by_user_id, initiator_kind, initiator_ref,
				approval_status, status, created_at
			) VALUES (
				${params.ctx.organizationId}, 'internal', ${AGENT_ASK_ACTION_KEY},
				${tx.json(proposal as unknown as Record<string, unknown>)},
				${params.ctx.actingAutomationId ?? null},
				${params.ctx.actingRunId ?? null},
				${initiator.createdByUserId},
				${initiator.initiatorKind},
				${tx.json(initiator.initiatorRef)},
				'pending', 'pending', current_timestamp
			)
			RETURNING id
		`;
		const runId = Number((inserted[0] as { id: unknown }).id);

		const event = await insertEvent(
			{
				entityIds: [],
				organizationId: params.ctx.organizationId,
				originId: `run_${runId}_pending`,
				title: params.question,
				content: params.body,
				semanticType: "operation",
				runId,
				interactionType: "approval",
				interactionStatus: "pending",
				interactionInputSchema: params.inputSchema,
				metadata: {
					...approvalContext(ApprovalKind.Question),
					tool: "notify",
					action_key: AGENT_ASK_ACTION_KEY,
					question: params.question,
					status: "pending_approval",
					initiator: {
						kind: initiator.initiatorKind,
						...initiator.initiatorRef,
					},
					...currentMcpActivityEventMetadata(params.ctx),
				},
				authorName: params.ctx.clientId ?? "agent",
				// Interaction events are deliberately not connection-scoped. Authorization
				// treats them as reviewable workflow records, not connector-synced content.
				clientId: eventClientId(params.ctx),
			},
			{ sql: tx },
		);

		return { runId, interactionEventId: Number(event.id) };
	});
}
