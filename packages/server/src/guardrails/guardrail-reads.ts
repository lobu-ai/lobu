/**
 * The read-only guardrail library surface: `GET /api/:org/guardrails[/:id]`
 * and `client.guardrails.list/get` share these two functions, so the
 * transports cannot drift in authorization or shape.
 */
import {
	GUARDRAILS_LIST_DEFAULT_LIMIT,
	GUARDRAILS_LIST_MAX_LIMIT,
	type GetGuardrailResult,
	type ListGuardrailsParams,
	type ListGuardrailsResult,
} from "@lobu/core/contracts/workspace-guardrails";
import { assertGuardrailConfigReadAllowed } from "../authz/guardrail-config-access";
import { getDb } from "../db/client";
import type { ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import { requireOrgReadAccess } from "../utils/organization-access";
import { getWorkspaceGuardrail, listWorkspaceGuardrails } from "./workspace-guardrails";

async function assertReadable(ctx: ToolContext): Promise<void> {
	await requireOrgReadAccess(getDb(), ctx);
	await assertGuardrailConfigReadAllowed(ctx);
}

export async function listGuardrails(
	params: ListGuardrailsParams,
	ctx: ToolContext,
): Promise<ListGuardrailsResult> {
	const limit = params.limit ?? GUARDRAILS_LIST_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > GUARDRAILS_LIST_MAX_LIMIT) {
		throw new ToolUserError(
			`limit must be an integer from 1 to ${GUARDRAILS_LIST_MAX_LIMIT}.`,
			422,
		);
	}
	await assertReadable(ctx);
	return listWorkspaceGuardrails(getDb(), ctx.organizationId, {
		includeArchived: params.include_archived === true,
		cursor: params.cursor,
		limit,
	});
}

export async function getGuardrail(
	params: { id: string },
	ctx: ToolContext,
): Promise<GetGuardrailResult> {
	if (typeof params?.id !== "string" || params.id.trim() === "") {
		throw new ToolUserError("id is required.", 422);
	}
	await assertReadable(ctx);
	return { guardrail: await getWorkspaceGuardrail(getDb(), ctx.organizationId, params.id) };
}
