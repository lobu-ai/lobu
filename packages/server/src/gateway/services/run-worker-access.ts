import { generateWorkerToken } from "@lobu/core";
import { AUTOMATION_RUN_SOURCE } from "../automation-run-session.js";
import { buildAutomationRunConversationId } from "../permissions/automation-run-intent.js";
import { buildWorkerTokenClaims } from "../orchestration/worker-token-claims.js";

export interface RunWorkerAccess {
	conversationId: string;
	token: string;
	expiresAt: number;
}

function workerTokenTtlMs(): number {
	const raw = Number.parseInt(process.env.WORKER_TOKEN_TTL_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 60 * 1000;
}

/**
 * Mint the exact WorkerToken identity used by a verified Automation Agent API
 * session. Device-pinned Automations use this same identity for lobu-memory MCP
 * access; the device PAT remains poll/lifecycle-only and never crosses orgs.
 */
export function buildAutomationRunWorkerAccess(args: {
	agentId: string;
	automationId: number;
	runId: number;
	organizationId: string;
	conversationId?: string;
}): RunWorkerAccess {
	const expectedConversationId = buildAutomationRunConversationId(
		args.agentId,
		args.automationId,
		args.runId,
	);
	const conversationId = args.conversationId ?? expectedConversationId;
	if (conversationId !== expectedConversationId) {
		throw new Error(
			`Automation conversation mismatch: expected ${expectedConversationId}, got ${conversationId}`,
		);
	}

	const userId = `automation_${args.automationId}`;
	const issuedAt = Date.now();
	return {
		conversationId,
		expiresAt: issuedAt + workerTokenTtlMs(),
		token: generateWorkerToken(
			args.agentId,
			conversationId,
			// `deploymentName`. It keys per-turn liveness markers and secret
			// mappings, so it stays agent-scoped — a platform workspace id here
			// would collapse every agent in that workspace onto one identity.
			`api-${args.agentId.slice(0, 8)}`,
			{
				// One place for the routing claims, so this mint cannot diverge
				// from the per-run and deployment mints (#1274).
				...buildWorkerTokenClaims({
					channelId: `api_${userId}`,
					agentId: args.agentId,
					organizationId: args.organizationId,
					platform: "api",
				}),
				runId: args.runId,
				source: AUTOMATION_RUN_SOURCE,
				sessionKey: userId,
			},
		),
	};
}
