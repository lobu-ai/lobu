import type { DbClient } from "../db/client";
import type { ConnectorPolicyPrincipal } from "./connector-policy";
import { automationIdFromPrincipalId, type EntityPolicyPrincipalKind } from "./entity-policy";

const PRINCIPAL_KINDS: readonly EntityPolicyPrincipalKind[] = ["user", "agent", "automation", "app"];

async function appLabel(sql: DbClient, organizationId: string, appKey: string): Promise<string | null> {
	const separator = appKey.indexOf(":");
	const prefix = appKey.slice(0, separator);
	const value = appKey.slice(separator + 1);
	if (separator <= 0 || !value) return null;
	// A web app is named by its domain and a local client by the name it registered.
	if (prefix === "web" || prefix === "local") return value;
	if (prefix === "client") {
		const [row] = await sql<{ client_name: string | null }>`SELECT client_name FROM oauth_clients WHERE id = ${value}`;
		return row?.client_name ?? null;
	}
	const patId = Number(value);
	if (prefix === "pat" && Number.isSafeInteger(patId) && patId > 0) {
		const [row] = await sql<{ name: string }>`
			SELECT name FROM personal_access_tokens
			WHERE id = ${patId} AND (organization_id = ${organizationId} OR organization_id IS NULL)
		`;
		return row?.name ?? null;
	}
	return null;
}

/**
 * The caller a policy decision was made for, from the run's stored policy
 * principal (`runs.policy_principal_kind/id`), named as it is at decision time.
 */
export async function resolvePolicyPrincipal(
	sql: DbClient,
	organizationId: string,
	stored: { kind: string | null; id: string | null },
): Promise<ConnectorPolicyPrincipal> {
	const kind = PRINCIPAL_KINDS.find((candidate) => candidate === stored.kind);
	if (!kind || kind === "user" || stored.id === null) return { kind: kind ?? "user", id: stored.id, label: null };
	let label: string | null = null;
	if (kind === "agent") {
		const [row] = await sql<{ name: string }>`SELECT name FROM agents WHERE id = ${stored.id} AND organization_id = ${organizationId}`;
		label = row?.name ?? null;
	} else if (kind === "automation") {
		const automationId = automationIdFromPrincipalId(stored.id);
		if (automationId !== null) {
			const [row] = await sql<{ name: string }>`SELECT name FROM automations WHERE id = ${automationId} AND organization_id = ${organizationId}`;
			label = row?.name ?? null;
		}
	} else {
		label = await appLabel(sql, organizationId, stored.id);
	}
	return { kind, id: stored.id, label };
}
