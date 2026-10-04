import type { DbClient } from '../db/client';
import type { ToolContext } from '../tools/registry';
import type { EventOutput } from '../types/automations';
import { errorMessage, ToolUserError } from './errors';
import { insertEvent, type InsertedEvent } from './insert-event';
import { isUniqueViolation } from './pg-errors';
import { validateSaveContentSemanticType } from './event-kind-validation';
import { requireWriteAccess } from './organization-access';
import {
  AUTOMATION_EVENT_IDENTITY_NS,
  computeStableKey,
  formatAutomationEventIdentity,
} from './stable-keys';

interface EventDraft {
  content: string;
  title?: string;
  metadata?: Record<string, unknown>;
  author?: string;
  source_url?: string;
  occurred_at?: string;
  parent_event_id?: number;
  payload_type?: 'text' | 'markdown';
  idempotency_key?: string;
  /** Replaces the Automation's bound entities for this row (see the contract). */
  entity_ids?: number[];
}

export interface PersistAutomationEventOutputParams {
  tx: DbClient;
  /** The completing run identity; row `entity_ids` are authorized against it. */
  ctx: ToolContext;
  rows: unknown;
  outputName: string;
  output: EventOutput;
  automationId: number;
  /** Automation version that produced these rows, for per-version output quality.
   *  Null only for a completion resolved outside a run and outside a version. */
  versionId: number | null;
  organizationId: string;
  runId: number;
  boundEntityIds: number[];
  validContentIds: Set<number>;
  occurredAt: string;
  createdBy?: string | null;
}

async function findByIdempotencyKey(
  tx: DbClient,
  organizationId: string,
  idempotencyKey: string
): Promise<InsertedEvent | null> {
  const rows = await tx<InsertedEvent>`
    SELECT id, entity_ids, origin_id, title, semantic_type, created_at,
           'unchanged'::text AS change
    FROM events
    WHERE organization_id = ${organizationId}
      AND metadata ? '_lobu_idempotency_key'
      AND metadata->>'_lobu_idempotency_key' = ${idempotencyKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Recover from a concurrent duplicate completion: `idx_events_org_idempotency_key`
 * rejected our insert because another run committed the same idempotency key
 * between our probe and our write. Adopt that committed row instead of
 * surfacing a raw 23505. Shared by the first-attempt catch and the identity
 * retry — a duplicate completion can race BOTH indices at once (two concurrent
 * runs of the same output carry the same per-item key, and may also probe the
 * same identity head), and either order must dedupe, not crash.
 */
async function recoverIdempotencyWinner(
  tx: DbClient,
  organizationId: string,
  event: string,
  idempotencyKey: string,
  cause: unknown
): Promise<InsertedEvent> {
  const winner = await findByIdempotencyKey(tx, organizationId, idempotencyKey);
  if (!winner) throw cause;
  if (winner.semantic_type !== event) {
    throw new ToolUserError(
      `Automation output idempotency key already belongs to '${winner.semantic_type}'.`,
      409
    );
  }
  return winner;
}

/**
 * The current head event for a keyed event output, by stable identity.
 *
 * `superseded_by IS NULL` identifies heads — the insert-time dual-write stamps
 * the replaced row's `superseded_by`, so a key keeps exactly one current event
 * while history stays append-only.
 *
 * The lookup is scoped by (org, identity) and deliberately NOT by `automation_id`:
 * an event carrying a keyed identity may predate the Automation that now maintains
 * it — prod's first four `voice_profile` rows were written by a migration with
 * no `automation_id`. Automation-scoping would leave those permanently unadoptable.
 *
 * Adoption of such rows is a DELIBERATE one-time act
 * (scripts/backfill-event-identity.ts stamping the identity this same function
 * computes), never an ambient effect of a run matching some metadata. A row that
 * nothing claimed an identity for is inert: it is not a supersede candidate, and
 * a run extends only its own chain.
 *
 * This replaces a `metadata @>` containment probe that was wrong in three
 * ways. It stringified key values before matching type-sensitive jsonb, so a
 * numeric or whitespace-padded value never matched its own head and every run
 * appended another live one. Containment is SUBSET matching, so shrinking a
 * declared key silently superseded a DIFFERENT key's head. And with no GIN
 * index on `events.metadata` it degraded to a bitmap heap scan over the org's
 * whole history — measured at 970 ms per probe against 1.2 ms via
 * idx_events_identity_head_automation, whose predicate matches this WHERE
 * exactly (the root index serves the CONSTRAINT, not this probe: heads are
 * usually not roots).
 */
async function findCurrentHeadByIdentity(
  tx: DbClient,
  organizationId: string,
  identityKey: string
): Promise<number | null> {
  const rows = await tx<{ id: number }>`
    SELECT id
    FROM events
    WHERE organization_id = ${organizationId}
      AND identity_ns = ${AUTOMATION_EVENT_IDENTITY_NS}
      AND identity_key = ${identityKey}
      AND superseded_by IS NULL
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * `origin_id` for an event-output row whose draft carried an `idempotency_key`
 * — the source item's own stable id, so this names the row identically on every
 * run that rediscovers it.
 *
 */
function automationOutputOriginId(
  automationId: number,
  outputName: string,
  idempotencyKey: string
): string {
  return `automation_${automationId}_${outputName}_key_${idempotencyKey}`;
}

/** Persist one declared event array atomically with its Automation run. */
export async function persistAutomationEventOutput(
  params: PersistAutomationEventOutputParams
): Promise<InsertedEvent[]> {
  if (!Array.isArray(params.rows) || params.rows.length === 0) return [];
  const seenIdempotencyKeys = new Set<string>();
  const keyFields = params.output.key ?? null;
  const seenKeyValues = new Set<string>();
  for (let index = 0; index < params.rows.length; index++) {
    const draft = params.rows[index] as EventDraft;
    if (typeof draft?.idempotency_key !== 'string') continue;
    if (seenIdempotencyKeys.has(draft.idempotency_key)) {
      throw new ToolUserError(
        `outputs.${params.outputName} contains a duplicate idempotency_key at item ${index}.`,
        422
      );
    }
    seenIdempotencyKeys.add(draft.idempotency_key);
  }
  const inserted: InsertedEvent[] = [];
  const producer = `run:${params.runId}`;

  for (let index = 0; index < params.rows.length; index++) {
    const draft = params.rows[index] as EventDraft;
    const metadata = { ...(draft.metadata ?? {}) };
    delete metadata._lobu_idempotency_key;

    // Keyed event output: derive the draft's stable identity, resolve the
    // current head for it, and supersede that head — so the type keeps exactly
    // one current event per key. The identity is derived SERVER-SIDE from the
    // declared key fields, never taken from the model: prod's `profile_key`
    // shows why, having drifted from `x:taste` to `x_taste` between two runs of
    // the same Automation. A duplicate key within one array would double-supersede
    // the same head, so it is rejected up front.
    let supersedesEventId: number | null = null;
    let identityKey: string | null = null;
    if (keyFields) {
      // computeStableKey enforces the whole field contract — present, non-blank,
      // scalar, safe integer, within the field-count and byte bounds — and
      // type-tags each value so numeric 3 and string '3' stay distinct
      // identities instead of being collapsed by String().
      let stableKey: string;
      try {
        stableKey = computeStableKey(metadata, keyFields);
      } catch (error) {
        throw new ToolUserError(
          `outputs.${params.outputName}[${index}] has an invalid key (${keyFields.join(', ')}): ${errorMessage(error)}`,
          422
        );
      }
      identityKey = formatAutomationEventIdentity(params.output.event, stableKey);
      if (seenKeyValues.has(identityKey)) {
        throw new ToolUserError(
          `outputs.${params.outputName} contains a duplicate key (${keyFields.join(', ')}) at item ${index}.`,
          422
        );
      }
      seenKeyValues.add(identityKey);
      supersedesEventId = await findCurrentHeadByIdentity(
        params.tx,
        params.organizationId,
        identityKey
      );
    }

    // Explicit linkage uses the same write gate as save_memory; a denied id
    // fails the entire completion rather than silently dropping that link.
    const entityIds = draft.entity_ids ?? params.boundEntityIds;
    if (draft.entity_ids) {
      for (const entityId of draft.entity_ids) {
        try {
          await requireWriteAccess(params.tx, entityId, params.ctx);
        } catch (error) {
          if (!(error instanceof ToolUserError)) throw error;
          throw new ToolUserError(
            `outputs.${params.outputName}[${index}].entity_ids: ${error.message}`,
            error.httpStatus,
            error.code
          );
        }
      }
    }

    const kindValidation = await validateSaveContentSemanticType(
      params.output.event,
      metadata,
      params.organizationId,
      entityIds.length > 0 ? entityIds : undefined
    );
    if (!kindValidation.valid) {
      throw new ToolUserError(
        `Invalid event in outputs.${params.outputName}[${index}]: ${kindValidation.errors.join('\n')}`,
        422
      );
    }

    let parentOriginId: string | null = null;
    let parentSourceUrl: string | null = null;
    if (draft.parent_event_id != null) {
      if (!params.validContentIds.has(draft.parent_event_id)) {
        throw new ToolUserError(
          `outputs.${params.outputName}[${index}].parent_event_id must reference content read by this Automation window.`,
          422
        );
      }
      const parentRows = await params.tx<{ origin_id: string; source_url: string | null }>`
        SELECT origin_id, source_url
        FROM events
        WHERE id = ${draft.parent_event_id}
          AND organization_id = ${params.organizationId}
        LIMIT 1
      `;
      if (parentRows.length === 0 || !parentRows[0].origin_id) {
        throw new ToolUserError(
          `outputs.${params.outputName}[${index}].parent_event_id does not resolve to a source event.`,
          422
        );
      }
      parentOriginId = parentRows[0].origin_id;
      parentSourceUrl = parentRows[0].source_url;
    }

    // The row's identity, and the origin_id that must name it. A model-supplied
    // `idempotency_key` is the source item's own stable id, so it identifies the
    // row across runs; without one the row is only identifiable as its slot in
    // this Automation run. origin_id is DERIVED from the same identity rather
    // than stamped positionally: an hourly Automation's runs all append to one
    // result period, so `..._${index}` named item N of every run the same
    // thing. Prod Automation 71 put 8 unrelated posts under
    // `automation_71_signals_canvas_4819569_4` — distinct rows, each correctly
    // deduped by its idempotency key, all sharing one origin_id. That breaks the
    // rule that origin_id is stable source identity: resolving one returned a
    // set of unrelated events.
    const idempotencyKey = draft.idempotency_key
      ? `automation:${params.automationId}:output:${params.outputName}:key:${draft.idempotency_key}`
      : `automation:${params.automationId}:${producer}:output:${params.outputName}:item:${index}`;
    const originId = draft.idempotency_key
      ? automationOutputOriginId(
          params.automationId,
          params.outputName,
          draft.idempotency_key
        )
      : `automation_${params.automationId}_${params.outputName}_${producer.replace(':', '_')}_${index}`;
    const prior = await findByIdempotencyKey(
      params.tx,
      params.organizationId,
      idempotencyKey
    );
    if (prior) {
      if (prior.semantic_type !== params.output.event) {
        throw new ToolUserError(
          `Automation output idempotency key already belongs to '${prior.semantic_type}'.`,
          409
        );
      }
      inserted.push(prior);
      continue;
    }

    const eventMetadata = {
      ...metadata,
      _lobu_idempotency_key: idempotencyKey,
      automation_id: params.automationId,
      automation_output: params.outputName,
    };
    const writeEvent = (headId: number | null) =>
      params.tx.savepoint((sp) =>
        insertEvent(
          {
            entityIds,
            organizationId: params.organizationId,
            originId,
            title: draft.title ?? null,
            payloadType: draft.payload_type ?? 'text',
            content: draft.content,
            authorName: draft.author ?? null,
            sourceUrl: draft.source_url ?? parentSourceUrl,
            occurredAt: draft.occurred_at ?? params.occurredAt,
            semanticType: params.output.event,
            originType: params.output.event,
            metadata: eventMetadata,
            parentOriginId,
            supersedesEventId: headId,
            identity: identityKey
              ? { ns: AUTOMATION_EVENT_IDENTITY_NS, key: identityKey }
              : null,
            runId: params.runId,
            automationId: params.automationId,
            automationVersionId: params.versionId,
            createdBy: params.createdBy ?? null,
          },
          { sql: sp }
        )
      );

    try {
      inserted.push(await writeEvent(supersedesEventId));
    } catch (error) {
      // A concurrent run committed a head for this identity between our probe
      // and our insert. The unique index rejected us rather than letting both
      // rows stay live, which is the whole point — re-resolve the winner and
      // supersede it. One retry only: a second rejection means yet another run
      // beat us, and returning a 409 to an Automation window is the correct
      // fail-closed outcome rather than looping.
      //
      // Two indices can reject the FIRST attempt, depending on which head both
      // runs probed:
      //   * root collision — neither saw a head, both inserted roots
      //     (supersedes_event_id IS NULL, so idx_events_superseded_by cannot
      //     see them);
      //   * superseded_by collision — both saw the SAME committed head and both
      //     inserted successors of it (a successor is not in the root index, so
      //     only the superseded_by index can catch it).
      // Either way the recovery is identical: re-resolve the winner and retry
      // as its successor.
      if (
        identityKey &&
        (isUniqueViolation(error, 'idx_events_identity_root_automation') ||
          isUniqueViolation(error, 'idx_events_superseded_by'))
      ) {
        const winnerHead = await findCurrentHeadByIdentity(
          params.tx,
          params.organizationId,
          identityKey
        );
        if (winnerHead === null) throw error;
        try {
          inserted.push(await writeEvent(winnerHead));
        } catch (retryError) {
          // The retry can lose three ways, and the first two mean the same
          // thing — a third writer moved the chain under us. The retry inserts
          // a SUCCESSOR (supersedes_event_id is non-NULL), so it is not in the
          // root index; it collides on idx_events_superseded_by instead, which
          // is unique on supersedes_event_id and rejects a second successor for
          // the head we just read. Accept either as the same lost race rather
          // than surfacing a raw 23505. The third is a concurrent duplicate
          // completion (shared explicit idempotency key) that won the write —
          // dedupe onto its row rather than crashing, same as the first attempt.
          if (
            isUniqueViolation(retryError, 'idx_events_identity_root_automation') ||
            isUniqueViolation(retryError, 'idx_events_superseded_by')
          ) {
            throw new ToolUserError(
              `outputs.${params.outputName}[${index}] lost a concurrent write for its key (${(keyFields ?? []).join(', ')}); retry the completion.`,
              409
            );
          }
          if (isUniqueViolation(retryError, 'idx_events_org_idempotency_key')) {
            inserted.push(
              await recoverIdempotencyWinner(
                params.tx,
                params.organizationId,
                params.output.event,
                idempotencyKey,
                retryError
              )
            );
            continue;
          }
          throw retryError;
        }
        continue;
      }
      if (!isUniqueViolation(error, 'idx_events_org_idempotency_key')) throw error;
      const winner = await recoverIdempotencyWinner(
        params.tx,
        params.organizationId,
        params.output.event,
        idempotencyKey,
        error
      );
      inserted.push(winner);
    }
  }

  return inserted;
}
