import { entityReadPolicySql, entityReadRestrictions } from "../authz/entity-read-policy";
import type { EntityDiscoverDuplicatesResult } from "@lobu/core/contracts/tools/manage-entity";
import { type DbClient } from "../db/client";
import { ToolUserError } from "../utils/errors";
import type { ToolContext } from "../tools/registry";
import { discoverIdentityJoin } from "../utils/identity-association";
import { configuredIdentityRelationship } from "../utils/entity-identity";
import { loadLiveEntityIdentities } from "./identities";
import {
	normalizedResolutionRuleKeys,
	readEntityResolutionRules,
	type ResolutionIdentity,
} from "./policy";

interface ResolutionCandidate {
	id: number;
	metadata: Record<string, unknown>;
	identities?: ResolutionIdentity[];
}

function populatedFieldCount(candidate: ResolutionCandidate): number {
	return Object.values(candidate.metadata).filter((value) => {
		if (value === null || value === undefined || value === "") return false;
		return !Array.isArray(value) || value.length > 0;
	}).length;
}

function buildResolutionComponents(input: {
	metadataSchema: unknown;
	candidates: ResolutionCandidate[];
	identityGroups?: number[][];
}) {
	const candidates = new Map(
		input.candidates.map((candidate) => [candidate.id, candidate]),
	);
	const parent = new Map([...candidates.keys()].map((id) => [id, id]));
	const find = (id: number): number => {
		const next = parent.get(id);
		if (next === undefined)
			throw new Error(`Unknown resolution candidate ${id}`);
		if (next === id) return id;
		const root = find(next);
		parent.set(id, root);
		return root;
	};
	const union = (left: number, right: number) => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot === rightRoot) return;
		parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
	};

	for (const group of input.identityGroups ?? []) {
		for (const id of group.slice(1)) union(group[0], id);
	}

	const ownersByIdentity = new Map<string, number[]>();
	const identitiesByCandidate = new Map<number, Set<string>>(
		[...candidates.keys()].map((id) => [id, new Set()]),
	);
	for (const rule of readEntityResolutionRules(input.metadataSchema)) {
		for (const candidate of candidates.values()) {
			for (const value of normalizedResolutionRuleKeys(candidate, rule)) {
				const key = JSON.stringify([rule.normalizer, rule.fields, value]);
				identitiesByCandidate.get(candidate.id)?.add(key);
				const owners = ownersByIdentity.get(key) ?? [];
				owners.push(candidate.id);
				ownersByIdentity.set(key, owners);
			}
		}
	}
	for (const owners of ownersByIdentity.values()) {
		const [first, ...rest] = [...new Set(owners)].sort((a, b) => a - b);
		if (first === undefined || rest.length === 0) continue;
		for (const owner of rest) union(first, owner);
	}

	const components = new Map<number, ResolutionCandidate[]>();
	for (const candidate of candidates.values()) {
		const root = find(candidate.id);
		const component = components.get(root) ?? [];
		component.push(candidate);
		components.set(root, component);
	}

	return { components, identitiesByCandidate };
}

/** Current-state sweep: propose one root pair per component, then rediscover after a join. */
export async function discoverWorkspaceResolutionPage(
  db: DbClient,
  input: { organizationId: string; entityType: string; limit?: number; cursor?: string },
  ctx: ToolContext,
): Promise<EntityDiscoverDuplicatesResult> {
  let after = 0;
  if (input.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (cursor.v !== 2 || cursor.org !== input.organizationId || cursor.type !== input.entityType ||
        !Number.isSafeInteger(cursor.after) || cursor.after < 1) throw new Error();
      after = cursor.after;
    } catch { throw new ToolUserError("Invalid duplicate discovery cursor for this workspace and entity type", 400); }
  }
  const [type] = await db<{ id: number; metadata_schema: unknown; backing_sql: string | null; backing_source: string | null }>`
    SELECT id, metadata_schema, backing_sql, backing_source FROM entity_types
    WHERE organization_id = ${input.organizationId} AND slug = ${input.entityType} AND deleted_at IS NULL`;
  if (!type) throw new ToolUserError(`Entity type '${input.entityType}' not found`, 404);
  if (input.entityType.startsWith('$') || type.backing_sql || type.backing_source) {
    throw new ToolUserError('Identity discovery requires a stored, non-reserved entity type', 400);
  }
  const relationship = await configuredIdentityRelationship(db, input.organizationId, input.entityType);
  const readParams: unknown[] = [input.organizationId, type.id];
  const readPredicate = entityReadPolicySql(await entityReadRestrictions(db, ctx), 'e', readParams);
  const rows = await db.unsafe<{ id: number; name: string; entity_type_id: number; organization_id: string; metadata: Record<string, unknown> }>(`
    SELECT e.id, e.name, e.entity_type_id, e.organization_id, e.metadata FROM entities e WHERE e.organization_id = $1
      AND e.entity_type_id = $2 AND e.deleted_at IS NULL AND ${readPredicate} ORDER BY e.id`, readParams);
  const identities = await loadLiveEntityIdentities(db, {
    organizationId: input.organizationId, entityIds: rows.map(row => Number(row.id)),
  });
  const recordsById = new Map(rows.map(row => [Number(row.id), row]));
  const candidates = rows.map(row => ({ id: Number(row.id), metadata: row.metadata ?? {},
    identities: identities.get(Number(row.id)) ?? [] }));
  const edges = await db<{ from_entity_id: number; to_entity_id: number }>`
    SELECT r.from_entity_id, r.to_entity_id FROM entity_relationships r
    JOIN entity_relationship_types t ON t.id = r.relationship_type_id
    JOIN entities a ON a.id = r.from_entity_id JOIN entities b ON b.id = r.to_entity_id
    WHERE r.organization_id = ${input.organizationId} AND r.deleted_at IS NULL
      AND t.organization_id = ${input.organizationId} AND t.purpose = 'identity'
      AND t.status = 'active' AND t.deleted_at IS NULL
      AND a.organization_id = ${input.organizationId} AND b.organization_id = ${input.organizationId}
      AND a.entity_type_id = ${type.id} AND b.entity_type_id = ${type.id}
      AND a.deleted_at IS NULL AND b.deleted_at IS NULL`;
  const parents = new Map(edges.map(edge => [Number(edge.from_entity_id), Number(edge.to_entity_id)]));
  const rootOf = (id: number) => {
    const visited = new Set<number>();
    while (parents.has(id)) {
      if (visited.has(id) || visited.size >= 26) throw new ToolUserError('Invalid identity component; repair its topology before discovery', 409);
      visited.add(id); id = parents.get(id)!;
    }
    return id;
  };
  const identityGroups = new Map<number, ResolutionCandidate[]>();
  for (const row of candidates) {
    const root = rootOf(row.id);
    const group = identityGroups.get(root) ?? [];
    group.push(row); identityGroups.set(root, group);
  }
  const { components, identitiesByCandidate } = buildResolutionComponents({ metadataSchema: type.metadata_schema,
    candidates, identityGroups: [...identityGroups.values()].map(group => group.map(row => row.id)) });
  const remaining = [...components.entries()].filter(([id, members]) => id > after &&
    new Set(members.map(row => rootOf(row.id))).size > 1).sort(([a], [b]) => a - b);
  const page: EntityDiscoverDuplicatesResult['components'] = [];
  for (const [componentId, members] of remaining) {
    if (page.length >= Math.min(input.limit ?? 50, 199)) break;
    const oversized = members.length > 26;
    const decisions: EntityDiscoverDuplicatesResult['components'][number]['decisions'] = [];
    let proposedMembers = 0;
    if (!oversized) {
      const roots = [...new Set(members.map(row => rootOf(row.id)))].sort((a, b) =>
        identityGroups.get(b)!.reduce((n, row) => n + populatedFieldCount(row), 0) -
        identityGroups.get(a)!.reduce((n, row) => n + populatedFieldCount(row), 0) || a - b);
      const decision = await discoverIdentityJoin(db, ctx, roots.map(root =>
        identityGroups.get(root)!.map(member => ({ ...recordsById.get(member.id)!,
          id: member.id, slug: input.entityType, metadata_schema: type.metadata_schema,
          backing_sql: null, backing_source: null,
        })).sort((a, b) => Number(b.id === root) - Number(a.id === root))), identities,
        (a, b) => [...identitiesByCandidate.get(a)!].some(key => identitiesByCandidate.get(b)!.has(key)));
      if (decision) {
        decisions.push({ from_entity_id: decision.from, to_entity_id: decision.to, relationship_type_slug: relationship.slug });
        proposedMembers = decision.memberCount;
      }
    }
    page.push({ component_id: componentId, candidate_count: members.length,
      candidate_entity_ids: oversized ? [] : members.map(row => row.id).sort((a, b) => a - b),
      oversized, deferred_candidates: members.length - proposedMembers, decisions });
  }
  const last = page.at(-1);
  return { action: 'discover_duplicates', candidates_scanned: candidates.length, components: page,
    next_cursor: last && remaining.length > page.length ? Buffer.from(JSON.stringify({
      v: 2, org: input.organizationId, type: input.entityType, after: last.component_id,
    })).toString('base64url') : null };
}
