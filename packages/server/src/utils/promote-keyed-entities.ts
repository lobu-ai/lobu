/**
 * Promote keyed automation-window rows into real child entities (P2 phase 1).
 *
 * For each row in one declared entity output, this module computes an internal
 * stable key and upserts a child entity. The key is persisted as an
 * `entity_identities` row in a dedicated `automation_key` namespace. Its identifier
 * is a fixed-size SHA-256 digest of the Automation, output, entity type, and exact
 * typed key tuple; the full tuple remains in entity metadata for inspection,
 * so a re-run — or a second replica racing the same window — resolves to the
 * existing entity instead of creating a duplicate. The partial unique index
 * `idx_entity_identities_live_unique_tenant_scoped (organization_id, namespace, identifier,
 * COALESCE(scope_key, ''))
 * WHERE deleted_at IS NULL` is the lock.
 *
 * Origin provenance (the run that first produced the entity, its stable key,
 * and the automation) is stamped onto the entity's own `metadata` at creation —
 * `metadata.run_id` / `stable_key` / `automation_id`. There is NO separate
 * observation event: an entity is promoted once (it's an identity, not a time
 * series), so its origin lives on the row itself.
 *
 * The upsert runs on the caller's transaction handle so the entity and identity
 * writes commit atomically with the window itself.
 *
 * Multi-replica notes:
 *   - `entities.id` / `entity_identities.id` are `nextval()` sequence columns,
 *     so concurrent inserts never collide on the PK (no advisory-lock allocator
 *     needed here — that's only for the MAX(id)+1 tables).
 *   - Completion serializes each Automation period; the per-key identity claim
 *     makes replays no-ops.
 *   - `fetch_types: false`: never bind a raw JS array — all identifiers here are
 *     scalar params.
 */

import { slugify } from '@lobu/core';
import { ApprovalAttribution } from '@lobu/core/contracts/interaction-envelope';
import {
  type CreateOrDeleteDecision,
  deferEntityCreate,
  type DeferredMutation,
  runMutationGate,
} from '../authz/entity-mutation-gate';
import {
  mutationPrincipalId,
  resolveAutomationOwner,
} from '../authz/entity-policy';
import type { DbClient } from '../db/client';
import type { Env } from '../index';
import type { EntityOutput } from '../types/automations';
import type { AppliedChange } from './entity-field-merge';
import { EntityPolicyDenialError, recordEntityWriteDenial } from './entity-write-denial-audit';
import {
  hardDeleteEntityRows,
  insertEntityRow,
  updateEntity,
} from './entity-management';
import { EntityRowValidationError, validateEntityRowInsert } from '../authz/entity-row-validation';
import logger from './logger';
import { isUniqueViolation } from './pg-errors';
import { resolveEntityCreator } from './resolve-entity-creator';
import { computeStableKey, formatAutomationEntityIdentity } from './stable-keys';

/** Namespace for the stable-key identity claim in `entity_identities`. */
const AUTOMATION_KEY_NAMESPACE = 'automation_key';

/** Agent-authored field naming the content a promoted row came from. */
const SOURCE_EVENT_ID_FIELD = 'source_event_id';

export interface PromoteKeyedEntitiesParams {
  /** Transaction-bound SQL handle (MUST be the window-write transaction). */
  tx: DbClient;
  /** Full extracted result containing this output's top-level array. */
  extractedData: Record<string, unknown>;
  outputName: string;
  output: EntityOutput;
  automationId: number;
  organizationId: string;
  /** The Automation run that produced this result. */
  runId: number;
  /**
   * The exact content IDs the window_token granted for this completion.
   * A promoted row may cite its origin via `source_event_id`; that value comes
   * from agent output and is otherwise stored verbatim, so an agent could point
   * a promotion at content its window never read. Citations outside this set are
   * dropped (the row still promotes — only the unverifiable claim is removed).
   */
  validContentIds: Set<number>;
  /** The automation's bound parent entity (entity_ids[0]); null when unbound. */
  parentEntityId: number | null;
  /**
   * Attribution for created entities — MUST be a live `user(id)` because
   * `entities.created_by` is NOT NULL with an ON DELETE RESTRICT FK. The
   * automation's own `created_by` satisfies this. When null, an org owner/admin is
   * resolved as a fallback; if none exists, entity creation is skipped.
   */
  createdBy?: string | null;
}

/**
 * One entity this run touched inline, for the first-class run change-set. Emitted
 * for auto-applied changes too — the diff is a property of the run, not of the
 * approval flow, so a fully-auto automation run still shows exactly what it changed.
 */
export interface PromotedEntityChange {
  entityId: number;
  name: string;
  /**
   * `created` = brand-new entity; `updated` = existing entity whose fields
   * changed; `denied` = the write was REFUSED and nothing was written.
   *
   * A denial belongs in the run's change set for the same reason a write does:
   * containing a per-row refusal keeps the window alive, so this event is the
   * only durable record that the row was seen and turned down. Without it a
   * refusal is indistinguishable from a row the automation never emitted.
   */
  kind: 'created' | 'updated' | 'denied';
  /** For `updated`, the fields written inline (old→new). Empty otherwise. */
  applied: Record<string, AppliedChange>;
  /** Why the write was refused, and by which decider. Set only for `denied`. */
  denied?: { source: 'policy' | 'rule'; reason: string };
}

export interface PromoteKeyedEntitiesResult {
  /** Number of distinct keyed rows that resolved to an entity. */
  promoted: number;
  /** Of those, how many created a brand-new entity (vs. matched an existing). */
  created: number;
  /**
   * Owned-field / policy-gated changes and policy-held creates that were NOT
   * applied — packaged as deferred approvals the caller flushes POST-COMMIT
   * (never writing inline, never on the caller's tx).
   */
  deferred: DeferredMutation[];
  /**
   * The applied change-set: every entity this run created or updated inline. The
   * caller records this as a first-class event on the run so the change is
   * visible on the run itself, independent of any approval.
   */
  changes: PromotedEntityChange[];
}

/**
 * Build a human-readable entity name from RAW field values (not the slugified
 * key). Falls back to the stable key when no field carries a value.
 *
 * Prefers `name_fields` and falls back to `key_fields`. The two are separate on
 * purpose: a stable key must never change between runs, so it is usually an
 * opaque id (`li_home_DijYQ…`), which makes a terrible display name. Keying on
 * the readable field instead would tie the entity's identity to a value that can
 * be edited upstream — a renamed author would orphan the entity and promote a
 * duplicate.
 */
export function buildEntityName(
  entityRecord: Record<string, unknown>,
  output: EntityOutput,
  stableKey: string
): string {
  const nameFields =
    output.name && output.name.length > 0 ? output.name : output.key;
  const parts = nameFields
    .map((field) => entityRecord[field])
    .filter((v): v is string | number => v !== null && v !== undefined && String(v).trim().length > 0)
    .map((v) => String(v).trim());
  const joined = parts.join(' · ');
  return joined.length > 0 ? joined : stableKey;
}

/**
 * Resolve an entity-type slug → entity_types(id), searching the automation's own
 * org first then any public catalog (same precedence as createEntity). Skips
 * derived (view-backed) types — they have no stored rows to insert into.
 */
async function resolveEntityTypeId(
  tx: DbClient,
  organizationId: string,
  entityTypeSlug: string
): Promise<number | null> {
  const rows = await tx<{ id: number; backing_sql: string | null }>`
    SELECT et.id, et.backing_sql
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    WHERE et.slug = ${entityTypeSlug}
      AND et.deleted_at IS NULL
      AND (
        et.organization_id = ${organizationId}
        OR o.visibility = 'public'
      )
    ORDER BY (et.organization_id = ${organizationId}) DESC, et.id ASC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  if (rows[0].backing_sql) return null;
  return Number(rows[0].id);
}

/**
 * How many readable numeric suffixes (`-2`, `-3`, …) to try before falling back
 * to a guaranteed-unique identifier-derived slug. Keeps slugs human-friendly
 * while guaranteeing the insert terminates.
 */
const SLUG_DISAMBIGUATION_ATTEMPTS = 5;

/**
 * Insert the child entity, tolerating a slug collision on
 * `entities_slug_parent_unique (organization_id, COALESCE(parent_id,0), slug)`.
 * Two keyed rows can slugify to the same base slug, and the slug can clash with
 * a pre-existing sibling. A raw INSERT would then throw 23505 and — because
 * promotion runs inside the window-completion transaction — roll the whole
 * completion back; since the slug is deterministic, every retry re-hits it and
 * the window is permanently poison-pilled. The entity's real identity is its
 * `automation_key` claim, so the slug is cosmetic: retry with `-2`, `-3`, … and
 * finally an identifier-derived suffix (unique per automation+key). Each attempt is
 * savepoint-isolated so a failed INSERT doesn't abort the outer transaction.
 */
async function insertEntityWithUniqueSlug(params: {
  tx: DbClient;
  organizationId: string;
  entityTypeId: number;
  parentEntityId: number | null;
  name: string;
  baseSlug: string;
  identifier: string;
  metadata: Record<string, unknown>;
  createdBy: string;
}): Promise<number> {
  const { tx } = params;
  // Automation output promoted into tenant state — the single most important
  // create to govern, since it is the path an agent's work reaches the table by.
  // Validation runs INSIDE the savepoint so a rule reads the same snapshot the
  // insert writes into.
  const insertWithSlug = (slug: string) =>
    tx.savepoint(async (sp) =>
      insertEntityRow({
        tx: sp,
        row: await validateEntityRowInsert({
          tx: sp,
          row: {
            organizationId: params.organizationId,
            entityTypeId: params.entityTypeId,
            name: params.name,
            slug,
            parentId: params.parentEntityId,
            metadata: params.metadata,
            createdBy: params.createdBy,
          },
        }),
      })
    );

  for (let attempt = 1; attempt <= SLUG_DISAMBIGUATION_ATTEMPTS; attempt++) {
    const slug = attempt === 1 ? params.baseSlug : `${params.baseSlug}-${attempt}`;
    try {
      const inserted = await insertWithSlug(slug);
      return Number(inserted.id);
    } catch (err) {
      if (isUniqueViolation(err, 'entities_slug_parent_unique')) continue;
      throw err;
    }
  }
  // Readable suffixes exhausted: the identifier is unique per (automation, key), so
  // this slug is collision-free among promotions (and effectively so against any
  // sibling). A final failure here propagates to the per-row guard in the loop.
  const inserted = await insertWithSlug(`${params.baseSlug}-${slugify(params.identifier)}`);
  return Number(inserted.id);
}

/**
 * Upsert a child entity by stable key. Returns its id and whether it was newly
 * created. Idempotent across re-runs / concurrent replicas via the
 * `entity_identities` live-unique index on
 * (org, namespace, identifier, COALESCE(scope_key, '')) — automation
 * keys are org-scoped, so that column is always NULL here. Slug
 * collisions are disambiguated by `insertEntityWithUniqueSlug` (the stable key,
 * not the slug, is the identity).
 */
async function upsertKeyedEntity(params: {
  tx: DbClient;
  organizationId: string;
  entityTypeId: number;
  entityTypeSlug: string;
  parentEntityId: number | null;
  identifier: string;
  name: string;
  baseSlug: string;
  output: EntityOutput;
  stableKey: string;
  runId: number;
  metadata: Record<string, unknown>;
  /** Extracted entity field values to sync into metadata (excludes the stable key). */
  fieldValues: Record<string, unknown>;
  createdBy: string;
  /** Automation whose run is promoting this entity — used for per-principal policy. */
  automationId: number;
  /**
   * The agent that owns this automation (automations.managed_agent_id). The gate resolves the
   * principal to this agent id so the agent's own envelope binds the automation's
   * writes; null when the automation row is missing (see automationOwnerResolved).
   */
  automationAgentId: string | null;
  /**
   * False iff the automation row was gone when we resolved its owner — the gate then
   * fails closed (deny) rather than promote under no agent envelope.
   */
  automationOwnerResolved: boolean;
  /**
   * The type-wide org-policy decision for creates of this type, resolved once per
   * promotion. Passed whole rather than as a derived boolean so the refusal is
   * reported from the same place as every other refusal — see `denied` below.
   */
  createGate: CreateOrDeleteDecision;
}): Promise<{
  entityId: number;
  created: boolean;
  /** Fields the automation actually wrote inline (auto-applied), old→new. */
  applied: Record<string, AppliedChange>;
  blockedCreate: boolean;
  deferred?: DeferredMutation;
  name?: string;
  /**
   * Set when the write was REFUSED here — every refusal, whichever decider made
   * it: a rule deny on either op, and a policy deny on an update or a create.
   * Carries the reason so the run's change set can record WHY, not just that a
   * row was skipped: containment means the window survives, so nothing else
   * marks it.
   */
  denied?: { source: 'policy' | 'rule'; reason: string; auditFields: string[] };
  /**
   * Set when a write RULE escalates the write the card will replay. The card
   * must carry that verdict's field list verbatim: the replay checks
   * `verdict.fields.every(f => approvedFields.includes(f))`, so a grant built
   * from anything else — the fields this row happened to propose, the verdict
   * on some subset of the write — mints a card no approval can ever clear.
   */
  escalated?: { fields: string[]; reason: string };
}> {
  const { tx, organizationId, identifier } = params;

  // 1. Existing identity → reuse its entity (the idempotent fast path), and SYNC the
  //    freshly-extracted field values into it honoring human ownership AND the org's
  //    update policy: un-gated fields are written; human-owned or policy-gated
  //    fields are returned as a deferred approval and never overwritten inline.
  const existing = await tx<{ entity_id: number | string }>`
    SELECT ei.entity_id
    FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id
    WHERE ei.organization_id = ${organizationId}
      AND ei.namespace = ${AUTOMATION_KEY_NAMESPACE}
      AND ei.identifier = ${identifier}
      AND ei.scope_key IS NULL
      AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length > 0) {
    const entityId = Number(existing[0].entity_id);
    const applied: Record<string, AppliedChange> = {};
    try {
      // Promotion is an in-process Automation write, using the same principal
      // and owning-agent envelope as its reaction. Reuse the shared update
      // funnel so metadata, derived names, rules and approvals stay atomic.
      const updated = await updateEntity(entityId, { metadata: params.fieldValues }, {} as Env, {
        organizationId,
        userId: null,
        memberRole: null,
        agentId: params.automationAgentId,
        isAuthenticated: true,
        tokenType: 'session',
        scopedToOrg: true,
        allowCrossOrg: false,
        grantedOrganizationIds: null,
        directSearchFederation: false,
        actingAutomationId: params.automationId,
        actingRunId: params.runId,
      }, {
        sql: tx,
        policyPrincipalKind: 'automation',
        attribution: ApprovalAttribution.Automation,
        principalId: mutationPrincipalId({ automationId: params.automationId }),
        ownerAgentId: params.automationAgentId,
        ownerResolved: params.automationOwnerResolved,
        parentRunId: params.runId,
        preserveSlug: true,
        derivedName: {
          fields: params.output.name?.length ? params.output.name : params.output.key,
          compute: (metadata) => buildEntityName(metadata, params.output, params.stableKey),
        },
        afterPersist: async (before, after) => {
          for (const field of Object.keys(params.fieldValues)) {
            const oldValue = before.metadata?.[field] ?? null;
            const newValue = after.metadata?.[field] ?? null;
            if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
              applied[field] = { old: oldValue, new: newValue };
            }
          }
          if (before.name !== after.name) {
            applied.$name = { old: before.name, new: after.name };
          }
        },
      });
      return {
        entityId,
        name: updated.name,
        created: false,
        applied,
        blockedCreate: false,
        deferred: updated.deferred,
      };
    } catch (err) {
      // The shared funnel rejects before persistence. Unexpected failures still
      // escape to the enclosing savepoint and roll back the completion.
      if (err instanceof EntityPolicyDenialError) {
        return {
          entityId, created: false, applied: {}, blockedCreate: false,
          denied: { source: 'policy', reason: err.denial.reason, auditFields: err.denial.deniedFields },
        };
      }
      if (!(err instanceof EntityRowValidationError)) throw err;
      return {
        entityId, created: false, applied: {}, blockedCreate: false,
        denied: { source: 'rule', reason: err.verdict.reason, auditFields: err.verdict.fields },
      };
    }
  }

  // Org policy is not an unqualified allow for creates of this type — no insert,
  // no identity claim. A `defer` means the caller queues a durable create proposal
  // post-commit; when it is approved and re-promoted, the identity claim above
  // dedupes as usual. A `deny` is reported as a refusal right here, so no caller
  // has to re-derive from the type-wide decision which of the two it was.
  if (params.createGate.outcome !== 'allow') {
    return {
      entityId: 0,
      created: false,
      applied: {},
      blockedCreate: true,
      ...(params.createGate.outcome === 'deny'
        ? {
            denied: {
              source: 'policy' as const,
              reason: params.createGate.reason,
              auditFields: Object.keys(params.fieldValues),
            },
          }
        : {}),
    };
  }

  // 2. Create the entity (sequence-allocated id — multi-replica safe),
  //    tolerating a slug collision so promotion can never poison-pill the window.
  let entityId: number;
  try {
    entityId = await insertEntityWithUniqueSlug({
      tx,
      organizationId,
      entityTypeId: params.entityTypeId,
      parentEntityId: params.parentEntityId,
      name: params.name,
      baseSlug: params.baseSlug,
      identifier,
      metadata: params.metadata,
      createdBy: params.createdBy,
    });
  } catch (err) {
    if (!(err instanceof EntityRowValidationError)) throw err;
    // Same containment as the update path above, and for the same reason: a
    // rule verdict is per-ROW, so letting it escape rolls back the whole window
    // completion and recurs on every retry.
    //
    // Validation runs INSIDE the savepoint and throws before `insertEntityRow`,
    // so the savepoint has already unwound — there is no partial row to undo.
    if (err.verdict.outcome !== 'escalate') {
      // The refusal is logged and recorded by the caller, which knows the op and
      // the window this row came from.
      return {
        entityId: 0,
        created: false,
        applied: {},
        blockedCreate: true,
        denied: {
          source: 'rule',
          reason: err.verdict.reason,
          auditFields: err.verdict.fields,
        },
      };
    }
    // Unlike the update path, this verdict needs no second ask. A create has no
    // committed row and so no held fields — nothing is stripped before the rule
    // runs — and the card replays the same `entity_data` that was just judged.
    // The verdict and the replay are already about the same write.
    return {
      entityId: 0,
      created: false,
      applied: {},
      blockedCreate: true,
      escalated: { fields: err.verdict.fields, reason: err.verdict.reason },
    };
  }

  // 3. Claim the stable key. ON CONFLICT DO NOTHING against the live-unique
  //    index: if a concurrent completion already claimed it, our insert is a
  //    no-op and we resolve the winner below.
  const claimed = await tx<{ entity_id: number | string }>`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector, scope_key
    ) VALUES (
      ${organizationId}, ${entityId}, ${AUTOMATION_KEY_NAMESPACE}, ${identifier}, 'automation', NULL
    )
    ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, '')) WHERE deleted_at IS NULL
    DO NOTHING
    RETURNING entity_id
  `;
  if (claimed.length > 0) {
    return { entityId, created: true, applied: {}, blockedCreate: false };
  }

  // Lost the race: another live transaction already claimed this key. Resolve
  // the winner, then drop the provisional entity so it does not linger.
  const winner = await tx<{ entity_id: number | string }>`
    SELECT entity_id
    FROM entity_identities
    WHERE organization_id = ${organizationId}
      AND namespace = ${AUTOMATION_KEY_NAMESPACE}
      AND identifier = ${identifier}
      AND scope_key IS NULL
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (winner.length > 0) {
    // Safe hard delete: this entity is brand-new in THIS transaction — nothing
    // references it yet (no identity, children, events, or relationships), and
    // entities' only blocking FK is `parent_id ON DELETE RESTRICT`, which can't
    // fire on a freshly-created leaf. The kernel keys on id alone; this id was
    // minted by our own insert above under `organizationId`, so it cannot
    // address another tenant's row.
    await hardDeleteEntityRows({ tx, ids: [entityId] });
    return {
      entityId: Number(winner[0].entity_id),
      created: false,
      applied: {},
      blockedCreate: false,
    };
  }
  // Extremely unlikely: the conflicting claim was tombstoned between our INSERT
  // and this re-read. Keep our entity as the canonical one.
  return { entityId, created: true, applied: {}, blockedCreate: false };
}

/**
 * Promote every row in one named entity output into a child entity.
 * The extraction schema requires every stable-key component, and
 * `computeStableKey` preserves exact scalar identity rather than display
 * normalization. Duplicate exact keys and unexpected persistence errors fail
 * the completion transaction: declared outputs are an atomic contract, not a
 * best-effort side channel that may silently lose rows.
 */
export async function promoteAutomationEntityOutput(
  params: PromoteKeyedEntitiesParams
): Promise<PromoteKeyedEntitiesResult> {
  const {
    tx,
    extractedData,
    outputName,
    output,
    automationId,
    organizationId,
    runId,
    parentEntityId,
    validContentIds,
  } = params;
  let droppedCitations = 0;
  const result: PromoteKeyedEntitiesResult = {
    promoted: 0,
    created: 0,
    deferred: [],
    changes: [],
  };

  const rows = extractedData[outputName];
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const entityTypeSlug = output.entity.trim();
  const entityTypeId = await resolveEntityTypeId(tx, organizationId, entityTypeSlug);
  if (entityTypeId == null) {
    logger.warn(
      { automationId, organizationId, entityTypeSlug, outputName },
      '[promote-keyed-entities] target entity type not found (or derived) — skipping promotion'
    );
    return result;
  }

  const createdBy = await resolveEntityCreator(tx, organizationId, params.createdBy);
  if (createdBy == null) {
    logger.warn(
      { automationId, organizationId },
      '[promote-keyed-entities] no live user to attribute created entities to — skipping promotion'
    );
    return result;
  }

  // An automation IS an agent's autonomous mode: resolve the owning agent so its
  // write envelope binds these promotions (automations.managed_agent_id, when set). The
  // principal resolves to the agent id — the same id the agent uses when acting
  // attended — and mode 'autonomous' lets the agent set a stricter automation-only
  // envelope. Without this, an agent's own delete=deny would NOT bind its own
  // automation (the write would fall through to the looser org default).
  const automationOwner = await resolveAutomationOwner(tx, automationId, organizationId);

  // Gate decision for creates of this type (automations are never human): resolved
  // once per promotion — every row in this window is the same entity type, so
  // one create decision governs them all. We only read the outcome here (the
  // probe's deferral is discarded); each held-back row builds its own deferral
  // below. Fail CLOSED: anything but an explicit 'allow' skips inline creation,
  // and only a 'defer' queues an approval — a 'deny' creates nothing at all.
  const createGate = await runMutationGate({
    action: 'create',
    organizationId,
    // The automation is the acting principal (its OWN rows bind, e.g. an automation-
    // specific deny). Its owning agent is folded in as the ancestor via
    // `ownerAgentId` so the agent's envelope ALSO binds — max-restrictive, so
    // the agent envelope can tighten but an automation-specific restriction can only
    // tighten further, never be loosened away.
    principalKind: 'automation',
    sql: tx,
    attribution: ApprovalAttribution.Automation,
    automationId,
    principalId: mutationPrincipalId({ automationId }),
    ownerAgentId: automationOwner.ownerAgentId,
    ownerResolved: automationOwner.resolved,
    entityTypeSlug,
    entityData: { entity_type: entityTypeSlug, name: '' },
    proposal: {},
  });
  if (createGate.outcome === 'deny') {
    logger.warn(
      { automationId, organizationId, entityTypeSlug, reason: createGate.reason },
      '[promote-keyed-entities] mutation gate denied creates for this type — new rows will be skipped'
    );
  }

  // A declared output is a complete result, so duplicate identities are an
  // authoring error. Silently keeping the first row would make output depend on
  // array order and discard potentially different field values.
  const seenKeys = new Set<string>();
  const keyedRows = rows.map((row) => {
    const entityRecord = row as Record<string, unknown>;
    const stableKey = computeStableKey(entityRecord, output.key);
    if (seenKeys.has(stableKey)) {
      throw new Error(
        `Automation output "${outputName}" contains a duplicate exact key (${stableKey})`
      );
    }
    seenKeys.add(stableKey);
    return { entityRecord, stableKey };
  });

  for (const { entityRecord, stableKey } of keyedRows) {
    const identifier = formatAutomationEntityIdentity(
      automationId,
      outputName,
      entityTypeSlug,
      stableKey
    );
    const name = buildEntityName(entityRecord, output, stableKey);
    const slug = slugify(name) || stableKey;
    // The extracted record's data fields (everything except the computed stable
    // key) are the entity's field values — synced into metadata on create and,
    // for existing entities, merged honoring human ownership.
    const fieldValues = { ...entityRecord };
    // `source_event_id` is an agent-authored provenance claim. Keep it only when
    // it names content this window actually read — same rule the classifier
    // applies to citations. An unverifiable id is worse than none: it reads like
    // proof of origin while pointing anywhere in the org.
    if (SOURCE_EVENT_ID_FIELD in fieldValues) {
      const claimed = fieldValues[SOURCE_EVENT_ID_FIELD];
      if (typeof claimed !== 'number' || !validContentIds.has(claimed)) {
        logger.warn(
          {
            automationId,
            organizationId,
            runId,
            stableKey,
            claimedSourceEventId: claimed,
          },
          '[promote-keyed-entities] dropping source_event_id not present in this window'
        );
        delete fieldValues[SOURCE_EVENT_ID_FIELD];
        droppedCitations += 1;
      }
    }
    const metadata: Record<string, unknown> = {
      // Domain source evidence is preserved; provenance has its own keys below.
      ...fieldValues,
      automation_id: automationId,
      automation_output: outputName,
      stable_key: stableKey,
      // Origin provenance lives on the entity itself — the run that first
      // produced it. (No separate append-only observation event in phase 1;
      // the entity is upserted once, so this is its origin, not a time series.)
      run_id: runId,
    };

    try {
      const {
        created,
        deferred,
        name: persistedName,
        applied,
        entityId,
        blockedCreate,
        denied,
        escalated,
      } = await tx.savepoint((sp) =>
        upsertKeyedEntity({
          tx: sp,
          organizationId,
          entityTypeId,
          entityTypeSlug,
          parentEntityId,
          identifier,
          name,
          baseSlug: slug,
          output,
          stableKey,
          runId,
          metadata,
          fieldValues,
          createdBy,
          automationId,
          automationAgentId: automationOwner.ownerAgentId,
          automationOwnerResolved: automationOwner.resolved,
          createGate,
        })
      );
      // A refusal, on either op and from either decider — rule or policy. Every
      // one of them arrives as `denied`; there is nothing left to re-derive here.
      if (denied) {
        const { auditFields, ...changeSetDenial } = denied;
        logger.warn(
          {
            automationId,
            organizationId,
            runId,
            stableKey,
            entityId,
            op: blockedCreate ? 'create' : 'update',
            deniedBy: denied.source,
            reason: denied.reason,
          },
          '[promote-keyed-entities] write denied — row skipped'
        );
        await recordEntityWriteDenial({
          organizationId,
          attemptId: `automation:${automationId}:run:${runId}:${outputName}:${stableKey}`,
          denialSource: denied.source,
          operation: blockedCreate ? 'create' : 'update',
          reason: denied.reason,
          deniedFields: auditFields,
          entityId: entityId > 0 ? entityId : null,
          entityType: entityTypeSlug,
          entityOrganizationId: entityId > 0 ? organizationId : null,
          actor: {
            kind: 'automation',
            id: mutationPrincipalId({ automationId }),
          },
          automationId,
          runId,
          createdBy,
          clientId: null,
          sql: tx,
        });
        // A log line is not an audit record. Put the refusal in the run's change
        // set so it is queryable next to the writes that DID land. A refused
        // CREATE has no id, so it is recorded under the name the automation
        // proposed — the only handle a reader has on a row never written.
        result.changes.push({
          entityId,
          name,
          kind: 'denied',
          applied: {},
          denied: changeSetDenial,
        });
        continue;
      }
      if (blockedCreate) {
        // A create is carded when POLICY defers it or when a write RULE
        // escalated it. A deny from either was already recorded and skipped
        // above, because approval cannot launder a refusal into a write.
        if (createGate.outcome === 'defer' || escalated) {
          const createProposal = {
            entity_type: entityTypeSlug,
            name,
            parent_id: parentEntityId,
            metadata,
          };
          result.deferred.push(
            deferEntityCreate({
              entityData: {
                entity_type: entityTypeSlug,
                name,
                parent_id: parentEntityId,
                metadata,
              },
              proposal: createProposal,
              attribution: ApprovalAttribution.Automation,
              // A rule-held create carries the rule's own grant and reason: the
              // apply path replays the insert, so an empty grant re-escalates.
              ...(escalated
                ? { escalatedFields: escalated.fields, reason: escalated.reason }
                : {}),
              automationId,
              parentRunId: runId,
            })
          );
        }
        continue;
      }
      result.promoted += 1;
      if (created) result.created += 1;
      // Record the applied change on the run's change-set. A brand-new entity is
      // a `created` change; an existing entity is `updated` only if the automation
      // actually wrote a field inline (an all-blocked or no-op sync adds nothing).
      if (created) {
        result.changes.push({ entityId, name, kind: 'created', applied: {} });
      } else if (Object.keys(applied).length > 0) {
        result.changes.push({ entityId, name: persistedName ?? name, kind: 'updated', applied });
      }
      if (deferred) result.deferred.push(deferred);
    } catch (err) {
      // The savepoint gives us a clean error boundary, but the declared output
      // remains atomic: an unexpected failure must roll back the completion so
      // the caller can fix or retry it. Known slug collisions are recovered in
      // upsertKeyedEntity and policy outcomes are modeled explicitly above.
      logger.error(
        { err, automationId, runId, stableKey, organizationId },
        '[promote-keyed-entities] keyed output failed; rolling back window completion'
      );
      throw err;
    }
  }

  logger.info(
    {
      automationId,
      runId,
      entityTypeSlug,
      promoted: result.promoted,
      created: result.created,
      droppedCitations,
    },
    '[promote-keyed-entities] promoted keyed window rows into entities'
  );

  return result;
}
