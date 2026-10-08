import { createHash } from 'node:crypto';
import type { ApprovalAttribution } from '@lobu/core/contracts/interaction-envelope';
import { runMutationGate } from '../authz/entity-mutation-gate';
import { type ActingPrincipal, resolveActingPrincipal, resolveStoredActingPrincipal } from '../authz/entity-policy';
import { type DbClient, pgBigintArray } from '../db/client';
import { loadLiveEntityIdentities } from '../entity-resolution/identities';
import { assessIdentityGroups, normalizedResolutionRuleKeys, readEntityResolutionRules, RESOLUTION_FINGERPRINT_VERSION, type ResolutionIdentity } from '../entity-resolution/policy';
import type { ToolContext } from '../tools/registry';
import { ToolUserError } from './errors';
import { insertEdgeChangeEventInTransaction, stableJson } from './insert-event';
import { requireWriteAccess } from './organization-access';
import { assertManualRelationshipClaim, assertNoReservedRelationshipMetadata, lockOrganizationForRelationshipClaims, IDENTITY_DECISION_METADATA_KEY } from './relationship-claims';
import { lockIdentityOrganization, validateTypeRule, withIdentityPrivilege } from './relationship-validation';

const SUPPORT_VERSION = 1;
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');

interface PairSupport {
  version: number;
  pair: number[];
  policy: string;
  keys: string[];
  fingerprint: string;
}

function supportSnapshot(policy: string, pair: number[], values: Iterable<string>): PairSupport {
  const snapshot = { version: SUPPORT_VERSION, policy, pair, keys: [...new Set(values)].sort() };
  return { ...snapshot, fingerprint: digest(snapshot) };
}

export class IdentityAssociationStaleError extends ToolUserError {
  constructor() { super('Identity approval is stale; request fresh review', 409); }
}

export interface IdentityAssociationInput {
  operation: 'link' | 'unlink';
  entity_id: number;
  to_entity_id: number;
  relationship_type_id: number;
  relationship_type_slug: string;
  relationship_id?: number;
  metadata?: Record<string, unknown>;
  dry_run?: boolean;
  automation_id?: number | null;
  source?: string;
  confidence?: number;
}

export interface IdentityAssociationProposal extends IdentityAssociationInput {
  identity_pair: string;
  support: PairSupport;
  suppression_support: PairSupport;
  topology: string;
  evidence_fingerprint?: string;
  member_support?: Record<string, PairSupport>;
  prior_decisions?: Array<{ kind: string; id: number }>;
  current: Array<{ id: number; name: string; parent: number | null }>;
  requester: { kind: ActingPrincipal['kind']; id: string | null; userId: string | null };
  attribution?: ApprovalAttribution;
  reason: string;
}

interface StoredRecord {
  name: string;
  id: number;
  entity_type_id: number;
  organization_id: string;
  metadata: Record<string, unknown>;
  slug: string;
  metadata_schema: unknown;
  backing_sql: string | null;
  backing_source: string | null;
}

export interface IdentityAssociationDecision {
  outcome: 'apply' | 'review' | 'suppressed' | 'refused';
  reason: string;
  relationshipId?: number;
  proposal?: IdentityAssociationProposal;
}

/** Matched normalized keys retain original records and source provenance, never row/version ids. */
function pairSupport(records: StoredRecord[], identities: Map<number, ResolutionIdentity[]>, policy: string): PairSupport {
  const keys = new Set<string>();
  const rules = readEntityResolutionRules(records[0].metadata_schema);
  for (const rule of rules) {
    const values = records.map(row => ({ id: Number(row.id), metadata: row.metadata ?? {}, identities: identities.get(Number(row.id)) ?? [] }));
    const right = new Set(normalizedResolutionRuleKeys(values[1], rule));
    const matches = normalizedResolutionRuleKeys(values[0], rule).filter(key => right.has(key));
    for (const match of matches) {
      const parts = JSON.parse(match) as Array<[string, string | null]>;
      for (const record of values) {
        keys.add(stableJson([record.id, rule.fields, match]));
        for (const identity of record.identities) {
          if (!rule.fields.includes(identity.namespace)) continue;
          const normalized = normalizedResolutionRuleKeys({ id: record.id, metadata: {}, identities: [identity] }, { ...rule, fields: [identity.namespace] });
          if (normalized.some(key => parts.some(part => stableJson([part]) === key))) {
            keys.add(stableJson([record.id, rule.fields, match, identity.sourceConnector ?? null, identity.connectionId ?? null, identity.scopeKey ?? null]));
          }
        }
      }
    }
  }
  return supportSnapshot(policy, records.map(row => Number(row.id)), keys);
}

/** Indexed lookups preserve the original member pair after either root changes. */
async function rejectedPairDecisions(db: DbClient, org: string, pair: number[], excludeRunId: number | null = null) {
  const key = stableJson(pair);
  return db<{ id: number; support: PairSupport }>`
    (SELECT id, COALESCE(action_input->'member_support'->${key}::text,
        action_input->'suppression_support', action_input->'support') AS support FROM runs
      WHERE organization_id = ${org} AND approval_status = 'rejected' AND action_key = 'entity_change'
        AND (${excludeRunId}::bigint IS NULL OR id <> ${excludeRunId})
        AND action_input->>'operation' = 'link' AND action_input->>'identity_pair' = ${key}
      ORDER BY id DESC LIMIT 1)
    UNION ALL
    (SELECT id, action_input->'member_support'->${key}::text AS support FROM runs
      WHERE organization_id = ${org} AND approval_status = 'rejected' AND action_key = 'entity_change'
        AND (${excludeRunId}::bigint IS NULL OR id <> ${excludeRunId})
        AND action_input->>'operation' = 'link' AND (action_input->'member_support') ? ${key}
      ORDER BY id DESC LIMIT 1)
  `;
}

/** Accumulate at rejection time, including overlapping proposals rejected out of order. */
export async function rememberIdentityRejection(db: DbClient, org: string, runId: number, proposal: IdentityAssociationProposal): Promise<void> {
  const members = proposal.member_support ?? { [proposal.identity_pair]: proposal.suppression_support };
  for (const [key, support] of Object.entries(members)) {
    const previous = await rejectedPairDecisions(db, org, support.pair, runId);
    const matching = previous.filter(row => row.support?.version === SUPPORT_VERSION && row.support.policy === support.policy);
    const keys = matching.flatMap(row => row.support.keys);
    const remembered = supportSnapshot(support.policy, support.pair, [...support.keys, ...keys]);
    const targetId = Math.max(runId, ...matching.map(row => Number(row.id)));
    // Keep the accumulated support on the newest indexed decision even when an
    // older proposal is rejected last. Other member pairs remain untouched.
    await db`UPDATE runs SET action_input = jsonb_set(action_input, '{member_support}',
      COALESCE(action_input->'member_support', '{}'::jsonb) || ${db.json({ [key]: remembered })}::jsonb)
      WHERE id = ${targetId} AND organization_id = ${org}`;
  }
}

interface RememberedPairDecision { kind: 'rejection' | 'withdrawal'; id: number; support: PairSupport }

/** Bounded original pairs, each using the latest indexed decision; never scan history. */
async function loadPairDecisions(db: DbClient, org: string, pairs: number[][]) {
  if (pairs.length === 0) return new Map<string, RememberedPairDecision[]>();
  const rows = await db<RememberedPairDecision & { pair_key: string }>`
    SELECT requested.pair_key, decision.*
    FROM jsonb_to_recordset(${db.json(pairs.map(pair => ({ pair_key: stableJson(pair), a: pair[0], b: pair[1] })))}::jsonb)
      AS requested(pair_key text, a bigint, b bigint)
    CROSS JOIN LATERAL (
      (SELECT 'rejection' AS kind, id, COALESCE(action_input->'member_support'->requested.pair_key,
          action_input->'suppression_support', action_input->'support') AS support FROM runs
        WHERE organization_id = ${org} AND approval_status = 'rejected' AND action_key = 'entity_change'
          AND action_input->>'operation' = 'link' AND action_input->>'identity_pair' = requested.pair_key
        ORDER BY id DESC LIMIT 1)
      UNION ALL
      (SELECT 'rejection' AS kind, id, action_input->'member_support'->requested.pair_key AS support FROM runs
        WHERE organization_id = ${org} AND approval_status = 'rejected' AND action_key = 'entity_change'
          AND action_input->>'operation' = 'link' AND (action_input->'member_support') ? requested.pair_key
        ORDER BY id DESC LIMIT 1)
      UNION ALL
      (SELECT 'withdrawal' AS kind, id, COALESCE(metadata->${IDENTITY_DECISION_METADATA_KEY}::text->'member_support'->requested.pair_key,
          metadata->${IDENTITY_DECISION_METADATA_KEY}::text->'suppression_support',
          metadata->${IDENTITY_DECISION_METADATA_KEY}::text->'support') AS support FROM entity_relationships
        WHERE organization_id = ${org} AND LEAST(from_entity_id, to_entity_id) = requested.a
          AND GREATEST(from_entity_id, to_entity_id) = requested.b
          AND metadata ? ${IDENTITY_DECISION_METADATA_KEY} AND deleted_at IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1)
      UNION ALL
      (SELECT 'withdrawal' AS kind, id, metadata->${IDENTITY_DECISION_METADATA_KEY}::text->'member_support'->requested.pair_key AS support FROM entity_relationships
        WHERE organization_id = ${org} AND deleted_at IS NOT NULL
          AND (metadata->${IDENTITY_DECISION_METADATA_KEY}::text->'member_support') ? requested.pair_key
        ORDER BY updated_at DESC LIMIT 1)
    ) decision`;
  const result = new Map<string, RememberedPairDecision[]>();
  for (const row of rows) {
    const list = result.get(row.pair_key) ?? [];
    list.push(row); result.set(row.pair_key, list);
  }
  return result;
}

function suppression(pair: number[], support: PairSupport, decisions: RememberedPairDecision[]) {
  const refs = decisions.map(row => ({ kind: row.kind, id: Number(row.id) }));
  const reconsider = decisions.length > 0;
  const previousKeys = new Set(decisions.filter(row => row.support?.version === SUPPORT_VERSION && row.support.policy === support.policy).flatMap(row => row.support.keys));
  const keys = [...new Set([...previousKeys, ...support.keys])].sort();
  const remembered = supportSnapshot(support.policy, pair, keys);
  if (decisions.some(row => !row.support || row.support.version !== SUPPORT_VERSION)) return { suppressed: true, hardSuppressed: true, previousKeys: [...previousKeys], reconsider, remembered, refs };
  if (decisions.some(row => row.support.policy === support.policy) && support.keys.every(key => previousKeys.has(key))) {
    return { suppressed: true, hardSuppressed: false, previousKeys: [...previousKeys], reconsider, remembered, refs };
  }
  return { suppressed: false, hardSuppressed: false, previousKeys: [...previousKeys], reconsider, remembered, refs };
}

function associationEvidence(left: StoredRecord[], right: StoredRecord[], identities: Map<number, ResolutionIdentity[]>, pair: number[]) {
  const candidate = (row: StoredRecord) => ({ id: Number(row.id), metadata: row.metadata ?? {}, identities: identities.get(Number(row.id)) ?? [] });
  const assessment = assessIdentityGroups({ metadataSchema: left[0].metadata_schema,
    left: left.map(candidate), right: right.map(candidate) });
  const policy = digest([RESOLUTION_FINGERPRINT_VERSION, assessment.policyHash]);
  const memberSupport = Object.fromEntries(left.flatMap(a => right.map(b => {
    const endpoints = [a, b].sort((x, y) => Number(x.id) - Number(y.id));
    const support = pairSupport(endpoints, identities, policy);
    return [stableJson(support.pair), support];
  })));
  const support = supportSnapshot(policy, pair, Object.values(memberSupport).flatMap(item => item.keys));
  return { assessment, policy, memberSupport, support };
}

function associationHistory(memberSupport: Record<string, PairSupport>, support: PairSupport, pair: number[], memory: Map<string, RememberedPairDecision[]>) {
  const priorDecisions = Object.values(memberSupport).map(item => suppression(item.pair, item, memory.get(stableJson(item.pair)) ?? []));
  // Changing representatives must not count the same normalized evidence again.
  // A genuinely new value/source anywhere across the components permits review,
  // even when other cross-member pairs have no matching evidence at all.
  const evidenceKey = (key: string) => stableJson((JSON.parse(key) as unknown[]).slice(1));
  const previousEvidence = new Set(priorDecisions.flatMap(item => item.previousKeys).map(evidenceKey));
  const gainedSupport = support.keys.some(key => !previousEvidence.has(evidenceKey(key)));
  const prior = { suppressed: priorDecisions.some(item => item.hardSuppressed) ||
      (priorDecisions.some(item => item.suppressed) && !gainedSupport),
    reconsider: priorDecisions.some(item => item.reconsider),
    remembered: supportSnapshot(support.policy, pair, priorDecisions.flatMap(item => item.remembered.keys)) };
  const rememberedMembers = Object.fromEntries(Object.keys(memberSupport).map((key, index) =>
    [key, priorDecisions[index].remembered]));
  const priorRefs = [...new Map(priorDecisions.flatMap(item => item.refs).map(ref =>
    [`${ref.kind}:${ref.id}`, ref])).values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);
  return { prior, rememberedMembers, priorRefs };
}

/** Read-only component assessment. Load decisions once and evaluate each record's
 * mutation gate once. Execution rechecks policy, evidence and topology under locks.
 */
export async function discoverIdentityJoin(db: DbClient, ctx: ToolContext, groups: StoredRecord[][],
  identities: Map<number, ResolutionIdentity[]>, sharesIdentity: (a: number, b: number) => boolean,
): Promise<{ from: number; to: number; memberCount: number } | null> {
  const actor = await resolveActingPrincipal(db, { organizationId: ctx.organizationId, userId: ctx.userId,
    agentId: ctx.agentId, sessionAutomationId: ctx.actingAutomationId });
  const eligible: StoredRecord[][] = [];
  for (const group of groups) {
    let allowed = true;
    for (const record of group) {
      const gate = await runMutationGate({ action: 'link', organizationId: ctx.organizationId, sql: db,
        principalKind: actor.kind, principalId: actor.id, ownerAgentId: actor.ownerAgentId, ownerResolved: actor.ownerResolved,
        entityId: Number(record.id), entityTypeSlug: record.slug, entityOrgId: record.organization_id,
        attribution: actor.kind === 'automation' ? 'automation' : 'agent' });
      if (gate.outcome === 'deny') { allowed = false; break; }
    }
    if (allowed) eligible.push(group);
  }
  const candidates = eligible.flatMap((right, index) => eligible.slice(index + 1).flatMap(left =>
    left.some(a => right.some(b => sharesIdentity(Number(a.id), Number(b.id)))) ? [{ left, right }] : []));
  const pairs = candidates.flatMap(({ left, right }) => left.flatMap(a => right.map(b =>
    [Number(a.id), Number(b.id)].sort((x, y) => x - y))));
  const memory = actor.kind === 'user' ? new Map<string, RememberedPairDecision[]>()
    : await loadPairDecisions(db, ctx.organizationId, pairs);
  for (const { left, right } of candidates) {
    // Discovery passes the current root first in each group.
    const from = Number(left[0].id), to = Number(right[0].id);
    const pair = [from, to].sort((a, b) => a - b);
    const { memberSupport, support } = associationEvidence(left, right, identities, pair);
    if (actor.kind !== 'user' && associationHistory(memberSupport, support, pair, memory).prior.suppressed) continue;
    return { from, to, memberCount: left.length + right.length };
  }
  return null;
}

/** One transaction-local decision path for preview, execution and approval. */
export async function decideIdentityAssociation(db: DbClient, input: IdentityAssociationInput, ctx: ToolContext, approved?: IdentityAssociationProposal): Promise<IdentityAssociationDecision> {
  await lockIdentityOrganization(db, ctx.organizationId);
  await lockOrganizationForRelationshipClaims(db, ctx.organizationId);
  const refuse = (reason: string): IdentityAssociationDecision => ({ outcome: 'refused', reason });
  if (input.entity_id === input.to_entity_id) return refuse('Identity joins require two distinct roots');
  assertNoReservedRelationshipMetadata(input.metadata);
  const pair = [input.entity_id, input.to_entity_id].sort((a, b) => a - b);
  for (const id of pair) await requireWriteAccess(db, id, ctx);
  const [type] = await db`
    SELECT * FROM entity_relationship_types WHERE id = ${input.relationship_type_id}
      AND organization_id = ${ctx.organizationId} AND purpose = 'identity'
      AND deleted_at IS NULL AND status = 'active' FOR SHARE
  `;
  if (!type || type.is_symmetric || type.inverse_type_id != null) return refuse('Identity association requires an active directional workspace type');
  // Only the two affected components are read. The DB insert guard independently
  // enforces the forest for every writer, including direct SQL.
  const members = await db<{ id: number }>`
    WITH RECURSIVE members(id) AS (
      SELECT unnest(${pgBigintArray(pair)}::bigint[])
      UNION
      SELECT CASE WHEN r.from_entity_id = m.id THEN r.to_entity_id ELSE r.from_entity_id END
      FROM members m JOIN entity_relationships r ON m.id IN (r.from_entity_id, r.to_entity_id)
        JOIN entity_relationship_types t ON t.id = r.relationship_type_id
      WHERE r.organization_id = ${ctx.organizationId} AND r.deleted_at IS NULL AND t.purpose = 'identity'
        AND t.organization_id = ${ctx.organizationId} AND t.status = 'active' AND t.deleted_at IS NULL
    ) SELECT id FROM members LIMIT 53
  `;
  const memberIds = members.map(row => Number(row.id)).sort((a, b) => a - b);
  const records = await db<StoredRecord>`
    SELECT e.id, e.name, e.entity_type_id, e.organization_id, e.metadata, t.slug, t.metadata_schema, t.backing_sql, t.backing_source
    FROM entities e JOIN entity_types t ON t.id = e.entity_type_id
    WHERE e.id = ANY(${pgBigintArray(memberIds)}::bigint[]) AND e.organization_id = ${ctx.organizationId}
      AND e.deleted_at IS NULL AND t.deleted_at IS NULL
    ORDER BY e.id FOR UPDATE OF e FOR SHARE OF t
  `;
  if (records.length !== memberIds.length || new Set(records.map(row => Number(row.entity_type_id))).size !== 1 ||
    records.some(row => row.slug.startsWith('$') || row.backing_sql || row.backing_source)) {
    return refuse('Identity endpoints must be live stored records of the same non-reserved type and organization');
  }
  await validateTypeRule(input.relationship_type_id, input.entity_id, input.to_entity_id, db);
  const edges = await db<{ id: number; from_entity_id: number; to_entity_id: number; relationship_type_id: number; metadata: Record<string, unknown> }>`
    SELECT r.id, r.from_entity_id, r.to_entity_id, r.relationship_type_id, r.metadata
    FROM entity_relationships r JOIN entity_relationship_types t ON t.id = r.relationship_type_id
    WHERE r.organization_id = ${ctx.organizationId} AND t.purpose = 'identity' AND r.deleted_at IS NULL
      AND t.organization_id = ${ctx.organizationId} AND t.status = 'active' AND t.deleted_at IS NULL
      AND r.from_entity_id = ANY(${pgBigintArray(memberIds)}::bigint[]) ORDER BY r.id FOR UPDATE OF r
  `;
  const topology = digest({ members: memberIds, edges: edges.map(edge => [Number(edge.id), Number(edge.from_entity_id), Number(edge.to_entity_id), Number(edge.relationship_type_id)]) });
  if (approved && approved.topology !== topology) throw new IdentityAssociationStaleError();
  const existing = edges.find(edge => Number(edge.from_entity_id) === input.entity_id && Number(edge.to_entity_id) === input.to_entity_id && Number(edge.relationship_type_id) === input.relationship_type_id);
  if (input.operation === 'link' && !existing) {
    if (edges.some(edge => pair.includes(Number(edge.from_entity_id)))) return refuse('Identity joins must be directed root-to-root; a root already has a parent');
    if (memberIds.length > 26) return refuse('Identity components may have at most 26 members');
  }
  let withdrawn = false;
  if (input.operation === 'unlink' && !existing && input.relationship_id) {
    const [previous] = await db`SELECT 1 FROM entity_relationships WHERE id = ${input.relationship_id}
      AND organization_id = ${ctx.organizationId} AND from_entity_id = ${input.entity_id} AND to_entity_id = ${input.to_entity_id}
      AND relationship_type_id = ${input.relationship_type_id} AND deleted_at IS NOT NULL
      AND metadata->${IDENTITY_DECISION_METADATA_KEY}::text->>'outcome' = 'withdrawn'`;
    withdrawn = !!previous;
  }
  if (input.operation === 'unlink' && ((!existing && !withdrawn) || (existing && input.relationship_id && Number(existing.id) !== input.relationship_id))) return refuse('Identity association is no longer live');
  // Removing the requested edge partitions unlink into the same two sides that
  // link evaluates. This also keeps the fingerprint stable across retries.
  const adjacency = new Map(memberIds.map(id => [id, [] as number[]]));
  for (const edge of edges) {
    if (Number(edge.id) === Number(existing?.id)) continue;
    adjacency.get(Number(edge.from_entity_id))?.push(Number(edge.to_entity_id));
    adjacency.get(Number(edge.to_entity_id))?.push(Number(edge.from_entity_id));
  }
  const leftIds = new Set<number>();
  const visit = (id: number) => {
    if (leftIds.has(id)) return;
    leftIds.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
  };
  visit(pair[0]);
  const left = records.filter(row => leftIds.has(Number(row.id)));
  const right = records.filter(row => !leftIds.has(Number(row.id)));
  if (right.length === 0 && !withdrawn) return refuse('Identity endpoints already belong to the same component');
  const identities = await loadLiveEntityIdentities(db, { organizationId: ctx.organizationId, entityIds: memberIds, forUpdate: true });
  const { assessment, policy, memberSupport, support } = associationEvidence(left, right, identities, pair);
  const evidenceFingerprint = digest({ assessment: assessment.fingerprint,
    sources: Object.values(memberSupport).map(item => item.fingerprint), topology });
  if (approved && (approved.evidence_fingerprint !== evidenceFingerprint || approved.support.fingerprint !== support.fingerprint)) {
    throw new IdentityAssociationStaleError();
  }
  const actor = approved
    ? await resolveStoredActingPrincipal(db, ctx.organizationId, approved.requester.kind, approved.requester.id)
    : await resolveActingPrincipal(db, { organizationId: ctx.organizationId, userId: ctx.userId, agentId: ctx.agentId,
        explicitAutomationId: input.automation_id, sessionAutomationId: ctx.actingAutomationId });
  if (approved) for (const id of memberIds) await requireWriteAccess(db, id, { ...ctx, userId: approved.requester.userId });
  let review = false;
  for (const record of records) {
    await requireWriteAccess(db, Number(record.id), ctx);
    const gate = await runMutationGate({ action: input.operation, organizationId: ctx.organizationId, sql: db,
      principalKind: actor.kind, principalId: actor.id, ownerAgentId: actor.ownerAgentId, ownerResolved: actor.ownerResolved,
      entityId: Number(record.id), entityTypeSlug: record.slug, entityOrgId: record.organization_id,
      attribution: actor.kind === 'automation' ? 'automation' : 'agent' });
    if (gate.outcome === 'deny') return refuse(gate.reason);
    review ||= gate.outcome === 'review';
  }
  if (withdrawn) return { outcome: 'apply', reason: 'Identity association was already withdrawn', relationshipId: input.relationship_id };
  if (input.operation === 'link' && existing) return { outcome: 'apply', reason: 'Identity association already exists', relationshipId: Number(existing.id) };
  const memory = await loadPairDecisions(db, ctx.organizationId, Object.values(memberSupport).map(item => item.pair));
  const { prior, rememberedMembers, priorRefs } = associationHistory(memberSupport, support, pair, memory);
  if (approved && stableJson(approved.prior_decisions ?? []) !== stableJson(priorRefs)) throw new IdentityAssociationStaleError();
  if (input.operation === 'link' && actor.kind === 'user') review ||= prior.reconsider;
  if (input.operation === 'link' && actor.kind !== 'user') {
    if (prior.suppressed) return { outcome: 'suppressed', reason: 'Unchanged or reduced support was already rejected or withdrawn' };
    review ||= prior.reconsider || assessment.decision === 'review';
  }
  const reason = review && prior.reconsider ? `Reconsider ${priorRefs.map(ref => `${ref.kind} #${ref.id}`).join(', ')} with fresh human approval.`
    : review ? 'Identity association requires human review under the current resolution and write policies' : 'Identity association is allowed by the current policies';
  const proposal: IdentityAssociationProposal = { ...input, dry_run: undefined, identity_pair: stableJson(pair), support, suppression_support: prior.remembered, topology, evidence_fingerprint: evidenceFingerprint, member_support: rememberedMembers, prior_decisions: priorRefs,
    current: records.map(row => ({ id: Number(row.id), name: row.name, parent: Number(edges.find(edge => Number(edge.from_entity_id) === Number(row.id))?.to_entity_id) || null })),
    requester: approved?.requester ?? { kind: actor.kind, id: actor.id, userId: ctx.userId ?? null },
    attribution: actor.kind === 'automation' ? 'automation' : 'agent', reason };
  if (review && !approved) return { outcome: 'review', reason, proposal };
  if (input.dry_run) return { outcome: 'apply', reason };
  const accepted = existing?.metadata[IDENTITY_DECISION_METADATA_KEY] as {
    support?: PairSupport; suppression_support?: PairSupport; member_support?: Record<string, PairSupport>;
  } | undefined;
  const acceptedMembers = accepted?.member_support ?? (accepted?.support
    ? { [stableJson(accepted.support.pair)]: accepted.suppression_support ?? accepted.support } : {});
  for (const [key, acceptedSupport] of Object.entries(acceptedMembers)) {
    if (acceptedSupport.version !== SUPPORT_VERSION || acceptedSupport.policy !== policy) continue;
    rememberedMembers[key] = supportSnapshot(policy, acceptedSupport.pair,
      [...(rememberedMembers[key]?.keys ?? []), ...acceptedSupport.keys]);
  }
  const suppressionKeys = [...new Set(Object.values(rememberedMembers).flatMap(item => item.keys))].sort();
  const decision = { outcome: input.operation === 'link' ? 'accepted' : 'withdrawn', support, topology, member_support: rememberedMembers,
    prior_decisions: priorRefs,
    suppression_support: supportSnapshot(support.policy, pair, suppressionKeys),
    requester: proposal.requester, decided_by: ctx.userId ?? null };
  const relationshipId = await withIdentityPrivilege(db, async () => {
    if (input.operation === 'link') {
      const claimed = await assertManualRelationshipClaim(db, { organizationId: ctx.organizationId,
        fromEntityId: input.entity_id, toEntityId: input.to_entity_id, relationshipTypeId: input.relationship_type_id,
        source: input.source ?? 'api', confidence: input.confidence ?? 1, createdBy: ctx.userId,
        metadata: { ...input.metadata, [IDENTITY_DECISION_METADATA_KEY]: decision } });
      return claimed.id;
    }
    await db`UPDATE entity_relationships SET deleted_at = current_timestamp, updated_at = current_timestamp,
      updated_by = ${ctx.userId ?? null}, metadata = metadata || ${db.json({ [IDENTITY_DECISION_METADATA_KEY]: decision })}::jsonb
      WHERE id = ${Number(existing!.id)}`;
    return Number(existing!.id);
  });
  await insertEdgeChangeEventInTransaction({ organizationId: ctx.organizationId, relationshipId,
    fromEntityId: input.entity_id, toEntityId: input.to_entity_id, relationshipTypeId: input.relationship_type_id,
    relationshipTypeSlug: input.relationship_type_slug, op: input.operation,
    changes: [{ field: 'exists', old: input.operation === 'unlink', new: input.operation === 'link' },
      { field: IDENTITY_DECISION_METADATA_KEY, old: existing?.metadata[IDENTITY_DECISION_METADATA_KEY] ?? null, new: decision }],
    createdBy: ctx.userId, clientId: ctx.clientId }, db);
  return { outcome: 'apply', reason, relationshipId };
}

export async function applyIdentityAssociationProposal(db: DbClient, proposal: IdentityAssociationProposal, ctx: ToolContext) {
  const result = await decideIdentityAssociation(db, proposal, ctx, proposal);
  if (result.outcome !== 'apply') throw new ToolUserError(result.reason, 409);
  return result;
}
