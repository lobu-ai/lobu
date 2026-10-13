import type { MemoryResource } from "../utils/url-builder";
import type { ToolContext } from "./registry";

/**
 * Verified context fields used to derive run provenance. Tool arguments are
 * deliberately excluded because callers control them.
 */
type InitiatorSource = Partial<
	Pick<
		ToolContext,
		| "userId"
		| "agentId"
		| "clientId"
		| "sourceContext"
		| "actingAutomationId"
		| "actingRunId"
	>
>;

type RunInitiatorColumns = {
	initiatorKind: "user" | "automation" | "agent_session" | "system";
	initiatorRef: Record<string, unknown>;
	createdByUserId: string | null;
};

export function resolveRunInitiator(ctx: InitiatorSource): RunInitiatorColumns {
	if (ctx.actingAutomationId != null) {
		return {
			initiatorKind: "automation",
			initiatorRef: {
				automation_id: ctx.actingAutomationId,
				run_id: ctx.actingRunId ?? null,
			},
			createdByUserId: null,
		};
	}

	if (ctx.agentId) {
		return {
			initiatorKind: "agent_session",
			initiatorRef: {
				agent_id: ctx.agentId,
				user_id: ctx.userId ?? null,
				client_id: ctx.clientId ?? null,
				conversation_id: ctx.sourceContext?.conversationId ?? null,
				platform: ctx.sourceContext?.platform ?? null,
				// WHO sent the chat message, from the signed worker token. A
				// userless chat turn (an unlinked sender, or a linked member in a
				// group conversation) has no user principal, so this is the only
				// record of the person behind the run.
				...(ctx.sourceContext?.userId
					? {
							platform_user_id: ctx.sourceContext.userId,
							platform_team_id: ctx.sourceContext.teamId ?? null,
						}
					: {}),
				...(ctx.sourceContext?.memberUserId
					? { member_user_id: ctx.sourceContext.memberUserId }
					: {}),
			},
			createdByUserId: ctx.userId ?? null,
		};
	}

	if (ctx.userId) {
		return {
			initiatorKind: "user",
			initiatorRef: { user_id: ctx.userId },
			createdByUserId: ctx.userId,
		};
	}

	return {
		initiatorKind: "system",
		initiatorRef: {},
		createdByUserId: null,
	};
}

/** Map persisted provenance to a run link, falling back if the route is incomplete. */
export function runPermalinkResource(
	initiator: {
		initiatorKind?: string | null;
		initiatorRef?: Record<string, unknown> | null;
	},
	runId: number,
	ownerAgentId: string | null | undefined,
): MemoryResource {
	if (initiator.initiatorKind !== "automation" || !ownerAgentId) {
		return { kind: "run", runId };
	}
	// Reject the empty cases before coercing: Number(null) and Number("") are
	// both 0, a valid-looking id that would build a link to "Automation 0".
	const rawAutomationId = initiator.initiatorRef?.automation_id;
	if (rawAutomationId == null || rawAutomationId === "") {
		return { kind: "run", runId };
	}
	const automationId = Number(rawAutomationId);
	if (!Number.isSafeInteger(automationId) || automationId <= 0) {
		return { kind: "run", runId };
	}
	return {
		kind: "automation_run",
		runId,
		agentId: ownerAgentId,
		automationId,
	};
}
