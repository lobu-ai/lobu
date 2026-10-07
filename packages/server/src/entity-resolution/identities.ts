import { type DbClient, pgBigintArray } from "../db/client";
import type { ResolutionIdentity } from "./policy";

/**
 * Load the live `entity_identities` rows the resolution policy resolves rule
 * fields against, keyed by entity id. All namespaces are loaded — custom
 * `exact` rules may key on custom namespaces, and the per-field namespace
 * filter lives in the policy itself.
 *
 * Pass `forUpdate: true` only from within an open transaction (the staleness
 * re-check inside `applyMergeGroup`) so the evidence rows stay locked through
 * the following merge. Read-only callers (discovery, pre-approval preview) omit
 * it: `FOR UPDATE` in an auto-committed statement releases the lock immediately
 * and only contends with concurrent merges for no benefit.
 */
export async function loadLiveEntityIdentities(
	db: DbClient,
	input: { organizationId: string; entityIds: number[]; forUpdate?: boolean },
): Promise<Map<number, ResolutionIdentity[]>> {
	const identities = new Map<number, ResolutionIdentity[]>();
	if (input.entityIds.length === 0) return identities;
	const lockClause = input.forUpdate ? db`FOR UPDATE` : db``;
	const rows = await db<{
		entity_id: number;
		namespace: string;
		identifier: string;
		scope_key: string | null;
		source_connector: string | null;
		connection_id: number | null;
	}>`
		SELECT entity_id, namespace, identifier, scope_key, source_connector, connection_id
		FROM entity_identities
		WHERE organization_id = ${input.organizationId}
		  AND entity_id = ANY(${pgBigintArray(input.entityIds)}::bigint[])
		  AND deleted_at IS NULL
		ORDER BY entity_id, namespace, identifier
		${lockClause}
	`;
	for (const row of rows) {
		const entityId = Number(row.entity_id);
		const bucket = identities.get(entityId) ?? [];
		bucket.push({
			namespace: row.namespace,
			identifier: row.identifier,
			scopeKey: row.scope_key,
			sourceConnector: row.source_connector,
			connectionId: row.connection_id == null ? null : Number(row.connection_id),
		});
		identities.set(entityId, bucket);
	}
	return identities;
}
