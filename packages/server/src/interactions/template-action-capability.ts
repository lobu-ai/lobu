import type { AccountToolContext, ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import {
	type McpAppCapabilityBinding,
	canIssueMcpAppCapability,
	isMcpAppCapabilityBinding,
	issueMcpAppCapability,
	MCP_APP_CAPABILITY_MAX_LENGTH,
	mcpAppCapabilityMatchesHost,
	readMcpAppCapability,
} from "../tools/mcp-app-capability";

export const TEMPLATE_ACTION_CAPABILITY_META_KEY =
	"lobu/event-action-capability";
const TEMPLATE_ACTION_CAPABILITY_TTL_MS = 10 * 60 * 1_000;
/**
 * The capability travels in MCP `_meta`, so the id set needs both a count bound
 * and the encoded-length check below. The actual fit also depends on the host
 * binding fields (especially the optional conversation id); callers that page
 * multiple events use `issueTemplateActionCapabilityWindow` to select the
 * largest leading window the transport can carry.
 */
export const MAX_TEMPLATE_ACTION_SOURCE_EVENTS = 64;

type TemplateActionCapability = {
	v: 1;
	sourceEventIds: number[];
};

function isTemplateActionCapability(
	value: unknown,
): value is TemplateActionCapability & McpAppCapabilityBinding {
	if (!isMcpAppCapabilityBinding(value)) return false;
	const payload = value as McpAppCapabilityBinding & {
		v?: unknown;
		sourceEventIds?: unknown;
	};
	return (
		payload.v === 1 &&
		Array.isArray(payload.sourceEventIds) &&
		payload.sourceEventIds.length > 0 &&
		payload.sourceEventIds.length <= MAX_TEMPLATE_ACTION_SOURCE_EVENTS &&
		payload.sourceEventIds.every(
			(id) => Number.isSafeInteger(id) && Number(id) > 0,
		)
	);
}

export { canIssueMcpAppCapability as canIssueTemplateActionCapability };

export function issueTemplateActionCapability(
	sourceEventIds: number[],
	ctx: ToolContext & {
		userId: string;
		clientId: string;
		mcpSessionId: string;
	},
): string {
	const normalizedSourceEventIds = [...new Set(sourceEventIds)].sort(
		(a, b) => a - b,
	);
	if (
		normalizedSourceEventIds.length === 0 ||
		normalizedSourceEventIds.length > MAX_TEMPLATE_ACTION_SOURCE_EVENTS ||
		!normalizedSourceEventIds.every((id) => Number.isSafeInteger(id) && id > 0)
	) {
		throw new Error(
			`Template action capabilities require 1-${MAX_TEMPLATE_ACTION_SOURCE_EVENTS} positive integer source event ids.`,
		);
	}
	const token = issueMcpAppCapability(
		{
			v: 1,
			sourceEventIds: normalizedSourceEventIds,
		},
		ctx,
		TEMPLATE_ACTION_CAPABILITY_TTL_MS,
	);
	if (token.length > MCP_APP_CAPABILITY_MAX_LENGTH) {
		throw new Error(
			`Template action capability exceeds the ${MCP_APP_CAPABILITY_MAX_LENGTH}-character MCP transport limit.`,
		);
	}
	return token;
}

export interface TemplateActionCapabilityWindow {
	token: string;
	sourceEventIds: number[];
}

/**
 * Issue a token for the largest leading event-id window that fits MCP `_meta`.
 * Returns null only when the host binding alone leaves no room for one event;
 * a content read must remain useful even when its actions cannot be enabled.
 */
export function issueTemplateActionCapabilityWindow(
	sourceEventIds: number[],
	ctx: ToolContext & {
		userId: string;
		clientId: string;
		mcpSessionId: string;
	},
): TemplateActionCapabilityWindow | null {
	const uniqueSourceEventIds = [...new Set(sourceEventIds)];
	if (
		uniqueSourceEventIds.length === 0 ||
		!uniqueSourceEventIds.every(
			(id) => Number.isSafeInteger(id) && Number(id) > 0,
		)
	) {
		return null;
	}

	let low = 1;
	let high = Math.min(
		uniqueSourceEventIds.length,
		MAX_TEMPLATE_ACTION_SOURCE_EVENTS,
	);
	let issued: TemplateActionCapabilityWindow | null = null;
	while (low <= high) {
		const size = Math.floor((low + high) / 2);
		const ids = uniqueSourceEventIds.slice(0, size);
		try {
			issued = {
				token: issueTemplateActionCapability(ids, ctx),
				sourceEventIds: ids,
			};
			low = size + 1;
		} catch {
			high = size - 1;
		}
	}
	return issued;
}

export function assertTemplateActionCapability(
	token: string | null | undefined,
	sourceEventId: number,
	ctx: AccountToolContext,
): string {
	const capability = readMcpAppCapability(token);
	if (
		!isTemplateActionCapability(capability) ||
		!capability.sourceEventIds.includes(sourceEventId) ||
		(ctx.organizationId !== null && capability.organizationId !== ctx.organizationId) ||
		!mcpAppCapabilityMatchesHost(capability, ctx)
	) {
		throw new ToolUserError(
			"A valid MCP App event-action capability is required.",
			403,
		);
	}
	return capability.organizationId;
}
