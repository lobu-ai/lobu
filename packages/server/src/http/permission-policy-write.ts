import type { Context } from "hono";
import {
	deleteEntityApprovalPolicy,
	type EntityApprovalPolicy,
	type EntityApprovalPolicyInput,
	isEntityMutationMode,
	isWriteResourceClass,
	upsertEntityApprovalPolicy,
} from "../authz/entity-policy";
import { isLegalActionEffect, type WriteAction } from "../authz/write-action-manifest";
import { getDb } from "../db/client";
import * as invalidationEmitter from "../events/emitter";
import { listOperations } from "../operations/connector-operations";
import { qualifiedOperationKey } from "../tools/admin/manage_operations/handlers/shared";

export function serializeEntityApprovalPolicy(policy: EntityApprovalPolicy) {
	return {
		id: policy.id,
		organization_id: policy.organizationId,
		resource_class: policy.resourceClass,
		principal_kind: policy.principalKind,
		principal_id: policy.principalId,
		operation_key: policy.operationKey,
		target_agent_id: policy.targetAgentId,
		entity_type_slug: policy.entityTypeSlug,
		field_path: policy.fieldPath,
		entity_id: policy.entityId,
		create_mode: policy.createMode,
		update_mode: policy.updateMode,
		delete_mode: policy.deleteMode,
		// The full per-action effect map (incl. deny/disabled/execute), for the
		// agent Permissions UI which the create/update/delete triple can't express.
		effects: policy.effects,
		approval_connection_id: policy.deliveryTarget.connectionId,
		approval_channel_id: policy.deliveryTarget.channelId,
		approval_team_id: policy.deliveryTarget.teamId,
		approval_channel_name: policy.deliveryTarget.channelName,
	};
}

export async function requireOrganizationSettingsAdmin(c: Context) {
	const organizationId = c.get("organizationId");
	const memberRole = c.get("memberRole");

	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}

	if (memberRole !== "owner" && memberRole !== "admin") {
		return c.json(
			{
				error: "forbidden",
				message: "Workspace settings require owner or admin access.",
			},
			403,
		);
	}

	const authSource = c.get("authSource");
	if (authSource === "pat") {
		return c.json(
			{
				error: "forbidden",
				message: "Use OAuth or a web session to change workspace settings.",
			},
			403,
		);
	}

	const scopes = c.get("mcpAuthInfo")?.scopes ?? [];
	if (authSource === "oauth" && !scopes.includes("mcp:admin")) {
		return c.json(
			{
				error: "forbidden",
				message: "Workspace settings changes require mcp:admin scope.",
			},
			403,
		);
	}

	return null;
}

async function agentExists(organizationId: string, agentId: string) {
	const rows = await getDb()`
    SELECT id FROM agents
    WHERE organization_id = ${organizationId} AND id = ${agentId}
    LIMIT 1
  `;
	return rows.length > 0;
}

function invalid(c: Context, message: string) {
	return c.json({ error: "invalid_request", message }, 400);
}

function optionalString(value: unknown, name: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${name} must be a non-empty string or omitted.`);
	return value.trim();
}

function parsePolicy(input: Record<string, unknown>, deleting: boolean): EntityApprovalPolicyInput {
	const resourceClass =
		deleting && typeof input.resource_class === "string"
			? input.resource_class.trim()
			: input.resource_class;
	if (!isWriteResourceClass(resourceClass))
		throw new Error(
			"resource_class must be entity, agent_config, connector_action, or entity_schema.",
		);
	const policy: EntityApprovalPolicyInput = {
		resourceClass,
		preserveDelivery: true,
	};
	const fields = [
		["entity_type_slug", "entityTypeSlug", "entity"],
		["target_agent_id", "targetAgentId", "agent_config"],
		["operation_key", "operationKey", "connector_action"],
	] as const;
	for (const [wire, field, owner] of fields) {
		const value = optionalString(input[wire], wire);
		if (value !== null && resourceClass !== owner)
			throw new Error(`${wire} is only valid for resource_class '${owner}'.`);
		policy[field] = value;
	}
	if (deleting) return policy;
	const effects = input.effects;
	if (!effects || typeof effects !== "object" || Array.isArray(effects))
		throw new Error("effects must be a JSON object.");
	// PUT replaces the entire effect map: reject invalid entries instead of
	// silently dropping restrictions already stored for this scope.
	policy.effects = {};
	for (const [action, effect] of Object.entries(effects)) {
		if (
			!isEntityMutationMode(effect) ||
			!isLegalActionEffect(resourceClass, action as WriteAction, effect)
		) {
			throw new Error(`Illegal effect for ${resourceClass}: '${action}' = '${String(effect)}'.`);
		}
		policy.effects[action as WriteAction] = effect;
	}
	return policy;
}

/** Both org and agent policy writes share validation, authority, and persistence. */
export async function writePermissionPolicy(c: Context) {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) return c.json({ error: "Organization context required" }, 401);
	const deleting = c.req.method === "DELETE";
	let input: unknown;
	try {
		input = deleting ? c.req.query() : await c.req.json();
	} catch {
		return invalid(c, "Request body must be JSON.");
	}
	if (!input || typeof input !== "object" || Array.isArray(input))
		return invalid(c, "Request body must be a JSON object.");
	let policy: EntityApprovalPolicyInput;
	try {
		policy = parsePolicy(input as Record<string, unknown>, deleting);
	} catch (error) {
		return invalid(c, (error as Error).message);
	}
	// Connector policy writes share the human-only boundary of connection action_modes.
	if (
		policy.resourceClass === "connector_action" &&
		(c.get("authSource") !== "session" || !c.get("user")?.id || c.get("mcpAuthInfo"))
	) {
		return c.json(
			{
				error: "forbidden",
				message: "Changing connector policies requires a human web session.",
			},
			403,
		);
	}
	const agentId = c.req.param("agentId") ?? null;
	policy.principalKind = agentId ? "agent" : null;
	policy.principalId = agentId;
	// Deletes must remain possible after a target disappears from the catalog.
	if (!deleting) {
		if (agentId && !(await agentExists(organizationId, agentId))) {
			return c.json(
				{
					error: "not_found",
					message: `Agent '${agentId}' not found in this workspace.`,
				},
				404,
			);
		}
		if (policy.targetAgentId && !(await agentExists(organizationId, policy.targetAgentId))) {
			return invalid(c, `Unknown target agent '${policy.targetAgentId}' for this workspace.`);
		}
		if (policy.operationKey) {
			const catalog = await listOperations({
				organizationId,
				kind: "write",
				includeInputSchema: false,
				includeOutputSchema: false,
				limit: Number.MAX_SAFE_INTEGER,
			});
			if (
				!catalog.operations.some(
					(op) => qualifiedOperationKey(op.connector_key, op.operation_key) === policy.operationKey,
				)
			) {
				return invalid(
					c,
					`Unknown connector operation '${policy.operationKey}' for this workspace.`,
				);
			}
		}
	}
	const result = deleting
		? {
				deleted: await deleteEntityApprovalPolicy({
					...policy,
					organizationId,
				}),
			}
		: {
				policy: serializeEntityApprovalPolicy(
					await upsertEntityApprovalPolicy(organizationId, policy),
				),
			};
	invalidationEmitter.emit(organizationId, {
		keys: ["write-permissions", "agent-permissions"],
	});
	return c.json(result);
}
