import { generateWorkerToken } from "@lobu/core";
import { buildWorkerTokenClaims, type WorkerTokenClaimsArgs } from "../orchestration/worker-token-claims.js";
import { AUTOMATION_RUN_SOURCE } from "../automation-run-session.js";

export interface RunWorkerAccess {
	conversationId: string;
	token: string;
	expiresAt: number;
}

function workerTokenTtlMs(): number {
	const raw = Number.parseInt(process.env.WORKER_TOKEN_TTL_MS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 60 * 1000;
}

function buildRunWorkerAccess(args: {
	agentId: string;
	conversationId: string;
	runId: number;
	organizationId: string;
	userId: string;
	channelId: string;
	source: string;
	/** Origin platform of the turn. Absent for a run with no chat transport. */
	platform?: string;
	/** Worker routing key; the native team is lifted off `platformMetadata`. */
	teamId?: string;
	platformMetadata?: WorkerTokenClaimsArgs["platformMetadata"];
}): RunWorkerAccess {
	const issuedAt = Date.now();
	return {
		conversationId: args.conversationId,
		expiresAt: issuedAt + workerTokenTtlMs(),
		token: generateWorkerToken(
			args.agentId,
			args.conversationId,
			// `deploymentName`. It keys per-turn liveness markers and secret
			// mappings, so it stays agent-scoped — a platform workspace id here
			// would collapse every agent in that workspace onto one identity.
			`api-${args.agentId.slice(0, 8)}`,
			{
				// One place for the routing claims, so this mint cannot diverge
				// from the per-run and deployment mints (#1274).
				...buildWorkerTokenClaims({
					channelId: args.channelId,
					agentId: args.agentId,
					organizationId: args.organizationId,
					platform: args.platform ?? "api",
					teamId: args.teamId,
					platformMetadata: args.platformMetadata,
				}),
				runId: args.runId,
				source: args.source,
				sessionKey: args.userId,
			},
		),
	};
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
	const expectedConversationId = `${args.agentId}_automation_${args.automationId}_run_${args.runId}`;
	const conversationId = args.conversationId ?? expectedConversationId;
	if (conversationId !== expectedConversationId) {
		throw new Error(
			`Automation conversation mismatch: expected ${expectedConversationId}, got ${conversationId}`,
		);
	}

	const userId = `automation_${args.automationId}`;
	return buildRunWorkerAccess({
		agentId: args.agentId,
		conversationId,
		runId: args.runId,
		organizationId: args.organizationId,
		userId,
		channelId: `api_${userId}`,
		source: AUTOMATION_RUN_SOURCE,
	});
}

/**
 * The one name for "this turn is a device-placed chat turn", stamped into the
 * signed worker token and read back by the direct-MCP auth lane so a spawned
 * local CLI can reach Lobu tools with the same per-run identity Automations use.
 */
export const DEVICE_CHAT_RUN_SOURCE = "device-chat";

/**
 * Mint the same run-scoped agent identity for a device-placed chat turn.
 *
 * A device chat turn originates on a chat platform, so it also carries that
 * turn's routing claims (platform, native team, connection, response thread).
 * Without them the mint falls back to `platform: "api"` with no connection or
 * thread, and a card the local CLI posts back is routed as an API interaction
 * instead of reaching the chat thread the turn came from.
 */
export function buildDeviceChatRunWorkerAccess(args: {
	agentId: string;
	conversationId: string;
	runId: number;
	organizationId: string;
	userId: string;
	channelId: string;
	platform?: string;
	teamId?: string;
	platformMetadata?: WorkerTokenClaimsArgs["platformMetadata"];
}): RunWorkerAccess {
	return buildRunWorkerAccess({ ...args, source: DEVICE_CHAT_RUN_SOURCE });
}
