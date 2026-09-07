import { getDb } from "../db/client";
import { parseAutomationRunConversationId } from "../gateway/permissions/automation-run-intent";
import { currentMcpActivityAttribution } from "../lobu/stores/mcp-client-conversations";
import type { ToolContext } from "../tools/registry";
import type { ActionOrigin } from "./action-card-state";

const PLATFORM_LABELS: Record<string, string> = {
	slack: "Slack",
	telegram: "Telegram",
	whatsapp: "WhatsApp",
	discord: "Discord",
	teams: "Microsoft Teams",
	gchat: "Google Chat",
	mcp: "MCP",
	web: "Lobu",
};

function platformName(value: string | null | undefined): string {
	const platform = value?.trim().toLowerCase();
	if (!platform || platform === "api" || platform === "lobu") return "Lobu";
	return PLATFORM_LABELS[platform] ?? platform;
}

async function automationOrigin(
	organizationId: string,
	automationId: number,
): Promise<ActionOrigin> {
	const rows = await getDb()<{
		name: string | null;
	}>`
		SELECT COALESCE(NULLIF(v.name, ''), NULLIF(a.name, '')) AS name
		FROM automations a
		LEFT JOIN automation_versions v ON v.id = a.current_version_id
		WHERE a.id = ${automationId}
		  AND a.organization_id = ${organizationId}
		LIMIT 1
	`;
	return {
		kind: "automation",
		label: rows[0]?.name?.trim() || `Automation #${automationId}`,
	};
}

async function mcpConversationOrigin(
	organizationId: string,
	activity: { clientIdentity: string; activityId: string },
): Promise<ActionOrigin> {
	const rows = await getDb()<{
		title: string | null;
		client_name: string | null;
	}>`
		SELECT mc.title, oc.client_name
		FROM mcp_client_conversations mc
		LEFT JOIN oauth_clients oc ON oc.id = mc.client_id
		WHERE mc.organization_id = ${organizationId}
		  AND mc.client_identity = ${activity.clientIdentity}
		  AND mc.conversation_id = ${activity.activityId}
		LIMIT 1
	`;
	const title = rows[0]?.title?.trim();
	const client = rows[0]?.client_name?.trim();
	return {
		kind: "conversation",
		label: title
			? client
				? `${client} — ${title}`
				: title
			: `${client ?? "MCP"} conversation`,
	};
}

async function resolveConversationActionOrigin(params: {
	organizationId: string;
	platform?: string | null;
	conversationId?: string | null;
	agentId?: string | null;
	clientIdentity?: string | null;
}): Promise<ActionOrigin> {
	let title: string | null = null;
	const sourcePlatform = params.platform?.trim().toLowerCase() || null;
	const storedPlatform = sourcePlatform === "api" ? "web" : sourcePlatform;
	if (storedPlatform === "mcp" && params.conversationId && params.clientIdentity) {
		return mcpConversationOrigin(params.organizationId, {
			clientIdentity: params.clientIdentity,
			activityId: params.conversationId,
		});
	}
	if (storedPlatform && params.conversationId) {
		const rows = await getDb()<{
			title: string | null;
			location_label: string | null;
		}>`
			SELECT title, location_label
			FROM conversations
			WHERE organization_id = ${params.organizationId}
			  AND platform = ${storedPlatform}
			  AND conversation_id = ${params.conversationId}
			  AND (${params.agentId ?? null}::text IS NULL OR agent_id = ${params.agentId ?? null})
			ORDER BY last_activity_at DESC
			LIMIT 1
		`;
		title = rows[0]?.title?.trim() || rows[0]?.location_label?.trim() || null;
	}
	const platform = platformName(sourcePlatform);
	return {
		kind: "conversation",
		label: title ? `${platform} — ${title}` : `${platform} conversation`,
	};
}

/** Resolve a transient question/tool card to an Automation or conversation. */
export async function resolveInteractionActionOrigin(params: {
	organizationId?: string | null;
	platform?: string | null;
	conversationId?: string | null;
	agentId?: string | null;
	clientIdentity?: string | null;
	automationId?: number | null;
	source?: string | null;
}): Promise<ActionOrigin> {
	if (params.organizationId && params.automationId != null) {
		return automationOrigin(params.organizationId, params.automationId).catch(
			() => ({
				kind: "automation",
				label: `Automation #${params.automationId}`,
			}),
		);
	}
	if (params.organizationId && params.source === "automation-run") {
		const run = parseAutomationRunConversationId(params.conversationId ?? "");
		if (run) {
			return automationOrigin(params.organizationId, run.automationId).catch(
				() => ({
					kind: "automation",
					label: `Automation #${run.automationId}`,
				}),
			);
		}
		return { kind: "automation", label: "Automation run" };
	}
	const fallback = `${platformName(params.platform)} conversation`;
	if (!params.organizationId) return { kind: "conversation", label: fallback };
	return resolveConversationActionOrigin({
		organizationId: params.organizationId,
		platform: params.platform,
		conversationId: params.conversationId,
		agentId: params.agentId,
		clientIdentity: params.clientIdentity,
	}).catch(() => ({ kind: "conversation", label: fallback }));
}

/** Resolve human-readable provenance only from verified server context. */
export async function resolveActionOrigin(
	ctx: ToolContext,
): Promise<ActionOrigin> {
	try {
		if (ctx.actingAutomationId != null) {
			return await automationOrigin(ctx.organizationId, ctx.actingAutomationId);
		}
		const mcpActivity = currentMcpActivityAttribution(ctx);
		if (mcpActivity) {
			return await mcpConversationOrigin(ctx.organizationId, mcpActivity);
		}
		if (ctx.sourceContext?.conversationId) {
			return await resolveConversationActionOrigin({
				organizationId: ctx.organizationId,
				platform: ctx.sourceContext.platform,
				conversationId: ctx.sourceContext.conversationId,
				agentId: ctx.agentId,
			});
		}
	} catch {
		// Provenance is display-only and must never fail the action itself.
	}
	return { kind: "direct", label: "Direct request" };
}
