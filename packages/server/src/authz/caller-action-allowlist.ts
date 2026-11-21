import { createHash } from "node:crypto";
import { type DbClient, getDb } from "../db/client";
import type { ActingPrincipal } from "./entity-policy";

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

export function loadCallerActionAllowlist(
	organizationId: string,
	actor: Pick<ActingPrincipal, "kind" | "id" | "ownerAgentId">,
	sql?: DbClient,
): Promise<AllowedAction[] | null> {
	const agentId = actor.kind === "agent" ? actor.id : actor.ownerAgentId;
	if (agentId) {
		return readCallerActionAllowlist(organizationId, { kind: "agent", id: agentId }, sql);
	}
	if (actor.kind === "app" && actor.id?.startsWith("pat:")) {
		return readCallerActionAllowlist(organizationId, { kind: "pat", id: actor.id.slice(4) }, sql);
	}
	return Promise.resolve(null);
}

export function allowedConnectorEffect(
	entries: readonly AllowedAction[],
	connectionId: number | null,
	operationKey: string,
): ConnectorAllowance["effect"] | "deny" {
	const entry = entries.find((item): item is ConnectorAllowance =>
		item.action === "connector.execute" &&
		item.connection_id === connectionId &&
		item.operation_key === operationKey
	);
	return entry?.effect ?? "deny";
}

export async function permitsEntityUpdate(args: {
	organizationId: string;
	actor: Pick<ActingPrincipal, "kind" | "id" | "ownerAgentId">;
	appPrincipalId?: string | null;
	entityId: number;
	sql?: DbClient;
}): Promise<boolean> {
	const [agentEntries, patEntries] = await Promise.all([
		loadCallerActionAllowlist(args.organizationId, args.actor, args.sql),
		args.appPrincipalId?.startsWith("pat:")
			? readCallerActionAllowlist(args.organizationId, { kind: "pat", id: args.appPrincipalId.slice(4) }, args.sql)
			: null,
	]);
	return [agentEntries, patEntries].every((entries) =>
		entries === null || entries.some((entry) => entry.action === "entity.update" && entry.entity_id === args.entityId)
	);
}
