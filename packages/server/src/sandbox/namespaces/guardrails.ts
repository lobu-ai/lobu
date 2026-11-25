/**
 * ClientSDK `guardrails` namespace: read-only access to the workspace
 * guardrail library, over the same functions as `GET /api/:org/guardrails`.
 */

import type {
	GetGuardrailResult,
	ListGuardrailsParams,
	ListGuardrailsResult,
} from "@lobu/core/contracts/workspace-guardrails";
import { getGuardrail, listGuardrails } from "../../guardrails/guardrail-reads";
import type { ToolContext } from "../../tools/registry";

export interface GuardrailsNamespace {
	list(input?: ListGuardrailsParams): Promise<ListGuardrailsResult>;
	get(input: { id: string }): Promise<GetGuardrailResult>;
}

export function buildGuardrailsNamespace(ctx: ToolContext): GuardrailsNamespace {
	return {
		list: (input = {}) => listGuardrails(input, ctx),
		get: (input) => getGuardrail(input, ctx),
	};
}
