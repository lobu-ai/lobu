import { createHash } from "node:crypto";
import { type DbClient, getDb } from "../db/client";
import type { ActingPrincipal } from "./entity-policy";
import { writeEffectRank } from "./write-action-manifest";

export type AllowlistSubject = { kind: "agent" | "pat"; id: string };

type ConnectorAllowance = {
	action: "connector.execute";
	connection_id: number;
	operation_key: string;
	effect: "auto" | "log" | "check" | "approval";
};

export type AllowedAction =
	| { action: "entity.update"; entity_id: number }
	| ConnectorAllowance;

export async function readCallerActionAllowlist(
	organizationId: string,
	subject: AllowlistSubject,
	sql: DbClient = getDb(),
): Promise<AllowedAction[] | null> {
	const [row] = await sql<{ entries: AllowedAction[] }>`
		SELECT entries FROM caller_action_allowlists
		WHERE organization_id = ${organizationId}
		  AND subject_kind = ${subject.kind}
		  AND subject_id = ${subject.id}
	`;
	return row?.entries ?? null;
}

export function callerActionAllowlistSnapshot(organizationId: string, subject: AllowlistSubject, entries: AllowedAction[] | null) {
	// JSONB may reorder object fields. Sort the individual keys before computing a
	// revision so a round trip through Postgres preserves the snapshot identity.
	const canonical = entries?.map((entry) => Object.entries(entry).sort()) ?? null;
	return {
		revision: createHash("sha256").update(JSON.stringify([organizationId, subject.kind, subject.id, canonical])).digest("hex"),
		entries,
	};
}

/**
 * Every allowlist bound to this call: the acting (or owning) agent's, the
 * authenticated caller agent's, and the PAT's. A PAT may bind its MCP session
 * to an agent, so the agent's list never replaces the token's; callers apply
 * each list and keep the strictest result.
 */
export async function loadCallerActionAllowlists(
	organizationId: string,
	actor: Pick<ActingPrincipal, "kind" | "id" | "ownerAgentId">,
	appPrincipalId?: string | null,
	sql?: DbClient,
	callerAgentId?: string | null,
): Promise<AllowedAction[][]> {
	const subjects = new Map<string, AllowlistSubject>();
	for (const agentId of [actor.kind === "agent" ? actor.id : actor.ownerAgentId, callerAgentId]) {
		if (agentId) subjects.set(`agent:${agentId}`, { kind: "agent", id: agentId });
	}
	for (const principal of [actor.kind === "app" ? actor.id : null, appPrincipalId]) {
		if (principal?.startsWith("pat:")) subjects.set(principal, { kind: "pat", id: principal.slice(4) });
	}
	const lists = await Promise.all(
		[...subjects.values()].map((subject) => readCallerActionAllowlist(organizationId, subject, sql)),
	);
	return lists.filter((entries): entries is AllowedAction[] => entries !== null);
}

/** The strictest allowance across every bound list; a miss in any list denies. */
export function allowedConnectorEffect(
	allowlists: readonly (readonly AllowedAction[])[],
	connectionId: number | null,
	operationKey: string,
): ConnectorAllowance["effect"] | "deny" {
	let effect: ConnectorAllowance["effect"] = "auto";
	for (const entries of allowlists) {
		const entry = entries.find((item): item is ConnectorAllowance =>
			item.action === "connector.execute" &&
			item.connection_id === connectionId &&
			item.operation_key === operationKey
		);
		if (!entry) return "deny";
		if (writeEffectRank(entry.effect) > writeEffectRank(effect)) effect = entry.effect;
	}
	return effect;
}

export async function permitsEntityUpdate(args: {
	organizationId: string;
	actor: Pick<ActingPrincipal, "kind" | "id" | "ownerAgentId">;
	/**
	 * The authenticated agent behind the call. A declared View write runs under
	 * the clicking user's policy principal, yet an agent invoking it stays bound
	 * to its own list.
	 */
	callerAgentId?: string | null;
	appPrincipalId?: string | null;
	entityId: number;
	sql?: DbClient;
}): Promise<boolean> {
	const allowlists = await loadCallerActionAllowlists(
		args.organizationId, args.actor, args.appPrincipalId, args.sql, args.callerAgentId,
	);
	return allowlists.every((entries) =>
		entries.some((entry) => entry.action === "entity.update" && entry.entity_id === args.entityId)
	);
}
