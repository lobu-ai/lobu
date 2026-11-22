import type { Context } from "hono";
import {
	type AllowedAction,
	type AllowlistSubject,
	callerActionAllowlistSnapshot,
	readCallerActionAllowlist,
} from "../authz/caller-action-allowlist";
import { withConnectorPolicyTransaction } from "../authz/entity-policy";
import { type DbClient, getDb, pgBigintArray } from "../db/client";
import { PersonalAccessTokenService } from "../auth/tokens";
import { listOperations } from "../operations/connector-operations";
import { requireHumanWorkspaceAdmin } from "./permission-policy-write";

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseEntries(value: unknown): AllowedAction[] {
	if (!Array.isArray(value) || value.length > 100) {
		throw new Error("Provide an array of up to 100 allowed actions.");
	}
	const seen = new Set<string>();
	return value.map((entry): AllowedAction => {
		if (!record(entry)) throw new Error("Each allowed action must be an object.");
		let key: string;
		let parsed: AllowedAction;
		const action = entry.action;
		if (action === "entity.update" && positiveInteger(entry.entity_id) && Object.keys(entry).length === 2) {
			key = JSON.stringify([action, entry.entity_id]);
			parsed = { action, entity_id: entry.entity_id };
		} else if (
			action === "connector.execute" &&
			positiveInteger(entry.connection_id) &&
			typeof entry.operation_key === "string" && entry.operation_key.length > 0 &&
			(entry.effect === "auto" || entry.effect === "log" || entry.effect === "check" || entry.effect === "approval") &&
			Object.keys(entry).length === 4
		) {
			key = JSON.stringify([action, entry.connection_id, entry.operation_key]);
			parsed = { action, connection_id: entry.connection_id, operation_key: entry.operation_key, effect: entry.effect };
		} else {
			throw new Error("Each entry must specify an exact entity update or connector operation.");
		}
		if (seen.has(key)) throw new Error("Duplicate allowed action.");
		seen.add(key);
		return parsed;
	});
}

async function subjectExists(sql: DbClient, organizationId: string, subject: AllowlistSubject): Promise<boolean> {
	if (subject.kind === "pat") {
		return !!await new PersonalAccessTokenService(sql).findInOrganization(Number(subject.id), organizationId);
	}
	const [agent] = await sql`
		SELECT id FROM agents WHERE organization_id = ${organizationId} AND id = ${subject.id}
	`;
	return !!agent;
}

async function validateTargets(organizationId: string, userId: string, entries: AllowedAction[]): Promise<string | null> {
	const entityIds = entries.flatMap((entry) => entry.action === "entity.update" ? [entry.entity_id] : []);
	if (entityIds.length) {
		const rows = await getDb()`
			SELECT id FROM entities WHERE organization_id = ${organizationId}
			AND deleted_at IS NULL AND id = ANY(${pgBigintArray(entityIds)}::bigint[])
		`;
		if (rows.length !== entityIds.length) return "An allowed entity does not exist in this workspace.";
	}
	const byConnection = new Map<number, Set<string>>();
	for (const entry of entries) {
		if (entry.action !== "connector.execute") continue;
		const keys = byConnection.get(entry.connection_id) ?? new Set<string>();
		keys.add(entry.operation_key);
		byConnection.set(entry.connection_id, keys);
	}
	for (const [connectionId, keys] of byConnection) {
		const catalog = await listOperations({
			organizationId,
			discoveryUserId: userId,
			connectionId,
			limit: Number.MAX_SAFE_INTEGER,
		});
		for (const operation of catalog.operations) keys.delete(operation.operation_key);
		if (keys.size) return "An allowed operation does not exist on the specified connection.";
	}
	return null;
}

export async function callerActionAllowlist(c: Context) {
	const denied = requireHumanWorkspaceAdmin(c);
	if (denied) return denied;
	const organizationId = c.get("organizationId")!;
	const kind = c.req.param("kind");
	const id = c.req.param("id");
	if (
		(kind !== "agent" && kind !== "pat") || !id ||
		(kind === "pat" && (!positiveInteger(Number(id)) || String(Number(id)) !== id))
	) {
		return c.json({ error: "invalid_request", message: "Specify an agent ID or a numeric PAT ID." }, 400);
	}
	const subject: AllowlistSubject = { kind, id };
	const db = getDb();
	if (!await subjectExists(db, organizationId, subject)) {
		return c.json({ error: "not_found", message: "Caller not found in this workspace." }, 404);
	}
	const readSnapshot = async (sql: DbClient) =>
		callerActionAllowlistSnapshot(organizationId, subject, await readCallerActionAllowlist(organizationId, subject, sql));
	const current = await readSnapshot(db);
	if (c.req.method === "GET") return c.json(current);

	let entries: AllowedAction[] | null;
	let revision: string;
	try {
		const body: unknown = await c.req.json();
		const deleting = c.req.method === "DELETE";
		if (!record(body) || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision) ||
			Object.keys(body).length !== (deleting ? 1 : 2)) {
			throw new Error(deleting ? "Provide the current revision." : "Provide the current revision and entries.");
		}
		revision = body.revision;
		entries = deleting ? null : parseEntries(body.entries);
	} catch (error) {
		return c.json({ error: "invalid_request", message: (error as Error).message }, 400);
	}
	const conflict = () => c.json({ error: "policy_conflict", message: "Reload and review the current allowlist." }, 409);
	if (revision !== current.revision) return conflict();
	if (entries) {
		const targetError = await validateTargets(organizationId, c.get("user")!.id, entries);
		if (targetError) return c.json({ error: "invalid_request", message: targetError }, 400);
	}
	return withConnectorPolicyTransaction(organizationId, async (tx) => {
		if ((await readSnapshot(tx)).revision !== revision) return conflict();
		if (!await subjectExists(tx, organizationId, subject)) {
			return c.json({ error: "not_found", message: "Caller not found in this workspace." }, 404);
		}
		if (entries === null) {
			await tx`
				DELETE FROM caller_action_allowlists WHERE organization_id = ${organizationId}
				  AND subject_kind = ${kind} AND subject_id = ${id}
			`;
		} else {
			await tx`
				INSERT INTO caller_action_allowlists (organization_id, subject_kind, subject_id, entries)
				VALUES (${organizationId}, ${kind}, ${id}, ${tx.json(entries)})
				ON CONFLICT (organization_id, subject_kind, subject_id)
				DO UPDATE SET entries = EXCLUDED.entries
			`;
		}
		return c.json(await readSnapshot(tx));
	});
}
