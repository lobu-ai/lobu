/**
 * Tool: save_memory
 *
 * Save content to the workspace, optionally associated with entities.
 * semantic_type is required and validated against $member.event_kinds for the org.
 * Entity metadata is validated against the entity type's schema.
 * Embeddings are left null for background worker backfill.
 */

import { Buffer } from 'node:buffer';
import { normalizeAuthUserId, normalizeEmail } from '@lobu/connector-sdk/identity-normalize';
import { type SaveContentArgs, SaveContentSchema } from '@lobu/core/contracts/tools/save-memory';
import { Type } from '@sinclair/typebox';
import { resolveAutomationAttribution } from '../automations/automation-source';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { resolveChannelEntityId } from '../authz/channel-entity';
import { type DbClient, getDb, parsePgNumberArray } from '../db/client';
import type { Env } from '../index';
import { INTERACTIVE_EVENT_CARD_REFRESH_TASK } from '../scheduled/task-definitions';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';
import { autoLinkEvent } from '../utils/auto-linker';
import { ToolUserError } from '../utils/errors';
import { validateSaveContentSemanticType } from '../utils/event-kind-validation';
import { getConfiguredEmbeddingModel, needsEmbeddingSql } from '../utils/embeddings';
import { eventArtifactBinding } from '../gateway/files/artifact-store';
import {
  deleteMaterializedArtifacts,
  materializeInlineAttachments,
} from '../utils/inline-attachments';
import { insertEvent, type InsertedEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import {
  assertCanAuthorGuidance,
  assertCanRemoveGuidance,
  GUIDANCE_SEMANTIC_TYPE,
} from '../utils/org-guidance';
import { ensureMemberEntityType } from '../utils/member-entity-type';
import { requireWriteAccess } from '../utils/organization-access';
import { isUniqueViolation } from '../utils/pg-errors';
import { validateTemplateHandlers } from '../utils/validate-json-template';
import { trackAutomationReaction } from '../utils/automation-reactions';
import { isSystemContext } from './access-control';
import { MEMBER_ENTITY_TYPE_SLUG } from './constants';
import type { ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';
import { buildEventViewUrl } from './view-urls';

// Leave headroom below the 512 KiB MCP App snapshot ceiling for the receipt,
// tool name, and snapshot envelope. Larger events remain exactly readable by
// the returned id instead of being copied into every caller's response.
const SAVE_MEMORY_INLINE_PAYLOAD_MAX_BYTES = 480 * 1024;

/**
 * Result fields that carry the saved event's render payload, as opposed to the
 * compact receipt. The text fallback strips exactly these (see
 * `formatToolResult`), so both sides must move together when one is added.
 */
export const SAVE_MEMORY_RENDER_PAYLOAD_KEYS = [
  'payload_type',
  'payload_text',
  'payload_data',
  'payload_template',
  'attachments',
  'source_url',
] as const;

/**
 * True when a Postgres error is the unique-violation (23505) on the partial
 * index that guards "at most one event supersedes a given target". The loser
 * of a concurrent-supersede race hits this; postgres.js exposes the SQLSTATE
 * on `code` and the index name on `constraint`/`constraint_name`.
 */
function isSupersededByUniqueViolation(error: unknown): boolean {
  const err = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
  };
  if (err?.code !== '23505') return false;
  return (
    err.constraint === 'idx_events_superseded_by' ||
    err.constraint_name === 'idx_events_superseded_by' ||
    (typeof err.message === 'string' && err.message.includes('idx_events_superseded_by'))
  );
}

async function findIdempotentEvent(
  sql: DbClient,
  organizationId: string,
  idempotencyKey: string
): Promise<
  | (Awaited<ReturnType<typeof insertEvent>> & { metadata: Record<string, unknown> })
  | undefined
> {
  const rows = await sql`
    SELECT id, entity_ids, origin_id, title, semantic_type, created_at, metadata
    FROM events
    WHERE organization_id = ${organizationId}
      AND metadata ? '_lobu_idempotency_key'
      AND metadata->>'_lobu_idempotency_key' = ${idempotencyKey}
    LIMIT 1
  `;
  if (rows.length === 0) return undefined;
  const row = rows[0];
  return {
    id: Number(row.id),
    entity_ids: parsePgNumberArray(row.entity_ids),
    origin_id: String(row.origin_id ?? ''),
    title: row.title == null ? null : String(row.title),
    semantic_type: String(row.semantic_type),
    created_at: String(row.created_at),
    change: 'unchanged',
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

// ============================================
// Result Type
// ============================================

export const SaveContentResultSchema = Type.Object({
  id: Type.Integer(),
  entity_ids: Type.Array(Type.Integer()),
  title: Type.Union([Type.String(), Type.Null()]),
  semantic_type: Type.String(),
  payload_type: Type.Optional(
    Type.Union([
      Type.Literal('text'),
      Type.Literal('markdown'),
      Type.Literal('json_template'),
      Type.Literal('media'),
      Type.Literal('empty'),
    ])
  ),
  payload_text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  payload_data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  payload_template: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  attachments: Type.Optional(Type.Array(Type.Unknown())),
  source_url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  created_at: Type.String(),
  supersedes_event_id: Type.Optional(Type.Integer()),
  view_url: Type.Optional(Type.String()),
  durable_at: Type.String(),
  indexing_status: Type.Union([Type.Literal('pending'), Type.Literal('completed')]),
  searchable: Type.Boolean(),
  created: Type.Boolean(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  exact_read: Type.Object({
    method: Type.Literal('client.knowledge.read'),
    content_ids: Type.Tuple([Type.Integer()]),
  }),
});

interface SaveContentResult {
  id: number;
  entity_ids: number[];
  title: string | null;
  semantic_type: string;
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty';
  payload_text?: string | null;
  payload_data?: Record<string, unknown>;
  payload_template?: Record<string, unknown> | null;
  attachments?: unknown[];
  source_url?: string | null;
  created_at: string;
  supersedes_event_id?: number;
  view_url?: string;
  /**
   * When durable storage completed — the row is committed and readable by exact
   * id from this instant. Distinct from semantic-index readiness below: durability
   * is synchronous, indexing is not.
   */
  durable_at: string;
  /**
   * Semantic-index readiness for THIS content, probed at save time (not a fixed
   * literal): 'completed' when a current-model embedding already exists (e.g. an
   * embedding was supplied inline), 'pending' when the async embed backfill still
   * has to produce one. While 'pending', semantic search may not yet return this
   * content — an exact read by id always works.
   */
  indexing_status: 'pending' | 'completed';
  /** Convenience mirror of `indexing_status === 'completed'`. */
  searchable: boolean;
  /** True only for the call that appended the event; false on an idempotent replay. */
  created: boolean;
  /** Metadata on the durable event (the original metadata on an idempotent replay). */
  metadata: Record<string, unknown>;
  exact_read: { method: 'client.knowledge.read'; content_ids: [number] };
}

// ============================================
// Handler
// ============================================

export const saveContent = withValidatedArgs('save_memory', SaveContentSchema, saveContentImpl);

async function saveContentImpl(
  args: SaveContentArgs,
  _env: Env,
  ctx: ToolContext
): Promise<SaveContentResult> {
  // SDK delegates (`client.knowledge.save`) skip `checkToolAccess`, so apply
  // the same member+scope gate here. System contexts (userId=null + auth=true)
  // bypass — automation reactions don't carry a user identity.
  if (!isSystemContext(ctx)) {
    if (!ctx.memberRole) {
      throw new ToolUserError('save_memory requires workspace membership with write access.', 403);
    }
    if (!hasRequiredMcpScope('write', ctx.scopes)) {
      throw new ToolUserError('save_memory requires an MCP session with write access.', 403);
    }
  }

  const sql = getDb();

  // 0. Ensure $member entity type exists for this org
  await ensureMemberEntityType(ctx.organizationId);

  const entityIds: number[] = args.entity_ids ?? [];
  const semanticType = args.semantic_type;
  if (!semanticType) throw new ToolUserError('semantic_type is required');

  // `guidance` is the built-in org-wide context kind: current guidance events
  // are injected into EVERY agent's system prompt (workspace instructions +
  // worker session context), which makes authorship a prompt-injection
  // surface. Fail closed: only org owners/admins may author it — system
  // contexts (automation reactions, memberRole=null) and plain members are
  // rejected. This is the single choke point for both the MCP tool and the
  // SDK delegate (`client.knowledge.save`).
  const isOrgGuidance = semanticType === GUIDANCE_SEMANTIC_TYPE;
  assertCanAuthorGuidance(semanticType, ctx.memberRole);

  const payloadType = args.payload_type ?? 'text';

  // Guidance renders from `payload_text` only (loadOrgGuidanceBlock), so a
  // media/json_template/empty guidance event would save yet render as nothing.
  // Constrain authorship to non-whitespace text/markdown rather than silently
  // storing an un-renderable row.
  if (isOrgGuidance) {
    if (payloadType !== 'text' && payloadType !== 'markdown') {
      throw new ToolUserError(
        `semantic_type '${GUIDANCE_SEMANTIC_TYPE}' requires payload_type 'text' or 'markdown'.`,
        422
      );
    }
    if (!args.content || !args.content.trim()) {
      throw new ToolUserError(
        `semantic_type '${GUIDANCE_SEMANTIC_TYPE}' requires non-empty content.`,
        422
      );
    }
  }

  // Validate content requirement based on payload_type
  if ((payloadType === 'text' || payloadType === 'markdown') && !args.content) {
    throw new ToolUserError(`content is required for payload_type '${payloadType}'`);
  }
  if (payloadType === 'json_template' && !args.payload_template) {
    throw new ToolUserError("payload_template is required when payload_type is 'json_template'");
  }
  // Events retain their existing permissive template shape, but handler values
  // must use the renderer's action-binding syntax.
  if (payloadType === 'json_template') {
    try {
      validateTemplateHandlers(args.payload_template);
    } catch (err) {
      throw new ToolUserError((err as Error).message, 422);
    }
  }

  // 1. Require write access for each entity
  for (const eid of entityIds) {
    await requireWriteAccess(sql, eid, ctx);
  }

  // 2. Validate semantic_type against $member.event_kinds + entity type event_kinds.
  //    `guidance` is a built-in org-wide kind registered in the $member
  //    event_kinds registry (ensureMemberEntityType), so it validates through
  //    this same path as every other kind — no code-level bypass. Its admin-only
  //    authorship/removal gates (org-guidance.ts) are orthogonal and applied
  //    above/below. See issue #1913.
  const kindValidation = await validateSaveContentSemanticType(
    semanticType,
    args.metadata,
    ctx.organizationId,
    entityIds.length > 0 ? entityIds : undefined
  );
  if (!kindValidation.valid) {
    throw new ToolUserError(kindValidation.errors.join('\n'), 422);
  }

  // 3. Validate event metadata against entity type's event kind schema (if entity-associated)
  //    Note: entity type metadata_schema is for entity creation/update, not for events.
  //    Event metadata is already validated against event_kinds metadataSchema in step 2.

  // 4. Resolve $member entity for this user via entity_identities and append to entity_ids.
  //    Identity lookup order:
  //      1) auth_user_id namespace (already linked in a prior call)
  //      2) email namespace (user has a member entity claimed by some connector); claim auth_user_id
  const finalEntityIds = [...entityIds];
  if (ctx.userId) {
    const authId = normalizeAuthUserId(ctx.userId);
    let memberRows: Array<{ id: number | string }> = [];

    if (authId) {
      memberRows = await sql`
        SELECT e.id
        FROM entity_identities ei
        JOIN entities e ON e.id = ei.entity_id
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE ei.organization_id = ${ctx.organizationId}
          AND ei.namespace = 'auth_user_id'
          AND ei.identifier = ${authId}
          AND ei.scope_key IS NULL
          AND ei.deleted_at IS NULL
          AND et.slug = ${MEMBER_ENTITY_TYPE_SLUG}
          AND e.deleted_at IS NULL
        LIMIT 1
      `;
    }

    if (memberRows.length === 0 && authId) {
      const userRows = await sql`SELECT email FROM "user" WHERE id = ${ctx.userId} LIMIT 1`;
      const userEmail =
        userRows.length > 0 ? normalizeEmail(userRows[0].email as string | null) : null;
      if (userEmail) {
        memberRows = await sql`
          SELECT e.id
          FROM entity_identities ei
          JOIN entities e ON e.id = ei.entity_id
          JOIN entity_types et ON et.id = e.entity_type_id
          WHERE ei.organization_id = ${ctx.organizationId}
            AND ei.namespace = 'email'
            AND ei.identifier = ${userEmail}
            AND ei.scope_key IS NULL
            AND ei.deleted_at IS NULL
            AND et.slug = ${MEMBER_ENTITY_TYPE_SLUG}
            AND e.deleted_at IS NULL
          LIMIT 1
        `;
      }
    }

    // Heal the member's auth_user_id claim to the gate's trusted source. The
    // channel-visibility gate only resolves a user to their $member via an
    // entity_identities row with source_connector='auth:signup' (the anti-hijack
    // guard); this call is a verified signed-in user resolved to their own
    // member, so it IS that trusted tier. save_content historically wrote the
    // claim with source 'save_content', which — because the live-unique index
    // is on (org, namespace, identifier, COALESCE(scope_key, '')) and
    // this claim is org-scoped (NULL) — permanently blocks the correct insert
    // and poisons the member for the authz gate. Only that legacy source
    // is eligible for promotion: upgrading an arbitrary conflicting source
    // would defeat the gate's anti-hijack boundary.
    if (memberRows.length > 0 && authId) {
      const memberId = Number(memberRows[0].id);
      await sql`
        INSERT INTO entity_identities (
          organization_id, entity_id, namespace, identifier, source_connector, scope_key
        ) VALUES (
          ${ctx.organizationId}, ${memberId}, 'auth_user_id', ${authId}, 'auth:signup', NULL
        )
        ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_key, '')) WHERE deleted_at IS NULL
        DO UPDATE SET
          source_connector = 'auth:signup',
          entity_id = EXCLUDED.entity_id
        WHERE entity_identities.source_connector = 'save_content'
          AND entity_identities.entity_id = EXCLUDED.entity_id
      `;
    }

    if (memberRows.length > 0) {
      const memberId = Number(memberRows[0].id);
      if (!finalEntityIds.includes(memberId)) {
        finalEntityIds.push(memberId);
      }
    }
  }

  // 4b. Stamp the source CHANNEL entity when this save originates from a chat
  //     session (worker-originated, carries team + channel in sourceContext).
  //     This makes distilled channel knowhow inherit the channel's per-member
  //     visibility gate (resource-visibility) instead of being org-visible —
  //     so a member of #eng recalls what the agent learned there, but #exec
  //     knowhow never leaks into #eng recall. Best-effort: a channel with no
  //     graphed entity (never synced) resolves to null and the save proceeds
  //     with the existing org/$member scoping.
  const channelEntityId = await resolveChannelEntityId(
    ctx.organizationId,
    ctx.sourceContext?.platform,
    ctx.sourceContext?.teamId,
    ctx.sourceContext?.channelId,
    sql
  );
  if (channelEntityId !== null && !finalEntityIds.includes(channelEntityId)) {
    finalEntityIds.push(channelEntityId);
  }

  // 5. Validate supersedes target exists and belongs to this org
  if (args.supersedes_event_id) {
    // Superseding a `guidance` target stamps its superseded_by, removing it
    // from every prompt — the same effect as delete_knowledge. Authorship is
    // admin-gated, so removal must be too, regardless of the NEW row's kind
    // (a member could otherwise erase guidance by superseding it with a note).
    await assertCanRemoveGuidance(
      ctx.organizationId,
      [args.supersedes_event_id],
      ctx.memberRole
    );
    const existing = await sql`
      SELECT id FROM events
      WHERE id = ${args.supersedes_event_id}
        AND organization_id = ${ctx.organizationId}
    `;
    if (existing.length === 0) {
      // Stale supersede target (already gone / wrong org) is a user fault, not
      // an infra error — ToolUserError so it doesn't fire a Sentry alert.
      throw new ToolUserError(
        `Cannot supersede event ${args.supersedes_event_id}: not found in this organization`,
        404
      );
    }
    const superseding = await sql`
      SELECT id FROM events
      WHERE supersedes_event_id = ${args.supersedes_event_id}
      LIMIT 1
    `;
    if (superseding.length > 0) {
      throw new ToolUserError(
        `Cannot supersede event ${args.supersedes_event_id}: already superseded by event ${superseding[0].id}`,
        409
      );
    }
  }

  // 5b. Resolve the source event for a first-class reply. `origin_parent_id`
  // stores the source's stable external origin, so the child continues to
  // thread under the current source row even when a connector re-sync
  // supersedes the exact event id the Automation originally read.
  let parentOriginId: string | null = null;
  let parentSourceUrl: string | null = null;
  if (args.parent_event_id !== undefined) {
    const parentRows = await sql`
      SELECT origin_id, source_url
      FROM events
      WHERE id = ${args.parent_event_id}
        AND organization_id = ${ctx.organizationId}
      LIMIT 1
    `;
    if (parentRows.length === 0) {
      throw new ToolUserError(
        `Cannot reply to event ${args.parent_event_id}: not found in this organization`,
        404
      );
    }
    parentOriginId = String(parentRows[0].origin_id ?? '');
    if (!parentOriginId) {
      throw new ToolUserError(
        `Cannot reply to event ${args.parent_event_id}: source has no origin id`,
        422
      );
    }
    parentSourceUrl = parentRows[0].source_url ? String(parentRows[0].source_url) : null;
  }

  // 6. Insert into events
  const externalId = `uc_${crypto.randomUUID()}`;

  // Reserved delivery metadata is added only after the caller-authored event
  // metadata passes its event-kind schema. It is platform bookkeeping, not a
  // domain field the entity type needs to declare. Strip it from caller
  // metadata unconditionally. A key smuggled in that way (e.g. metadata copied
  // forward from a prior KnowledgeSaveResult) would land on the row without
  // going through the preflight read or the unique-violation reconciliation,
  // surfacing a raw Postgres conflict on collision.
  const callerMetadata: Record<string, unknown> = { ...(args.metadata ?? {}) };
  // The `_lobu_` metadata namespace is server-owned: strip every reserved key
  // from caller input so a member cannot forge audit discriminators
  // (_lobu_workspace_audit) or idempotency keys by supplying them as metadata.
  for (const key of Object.keys(callerMetadata)) {
    if (key.startsWith('_lobu_')) delete callerMetadata[key];
  }
  // Memory scope, stamped from the BOUND context rather than caller metadata.
  //
  // `search_memory` fences content recall to `events.metadata->>'agent_id' =
  // ctx.agentId` (`ContentSearchFilters.agent_id`, documented as "populated
  // automatically by Lobu-owned save paths"). This is such a path, and it was
  // not populating it: only the memory plugin's auto-capture passed `agent_id`
  // as caller metadata, so a model's own `save_memory` call landed with `{}`
  // and the agent could not recall what it had just written — a PAT search
  // found the row, the agent's own search returned nothing.
  //
  // Written LAST so it wins over a caller-supplied `agent_id`: the scope is an
  // identity assertion, and a caller that could set it for another agent would
  // write into that agent's memory. An unbound caller (a PAT, a session, a
  // system context) stamps nothing, which is what keeps workspace nouns and
  // connector ingest out of any agent's private scope.
  const eventMetadata: Record<string, unknown> = {
    ...callerMetadata,
    ...(args.idempotency_key ? { _lobu_idempotency_key: args.idempotency_key } : {}),
    ...(ctx.agentId ? { agent_id: ctx.agentId } : {}),
  };

  let row: Awaited<ReturnType<typeof insertEvent>>;
  let inserted = true;
  let persistedMetadata = eventMetadata;
  const prior = args.idempotency_key
    ? await findIdempotentEvent(sql, ctx.organizationId, args.idempotency_key)
    : undefined;
  if (prior) {
    if (prior.semantic_type !== semanticType) {
      throw new ToolUserError(
        `Idempotency key '${args.idempotency_key}' already belongs to semantic type '${prior.semantic_type}'`,
        409
      );
    }
    row = prior;
    inserted = false;
    persistedMetadata = prior.metadata;
  } else {
    // Inline media becomes a bound artifact BEFORE the row is written, exactly
    // as connector ingest does it (run-lifecycle → materializeInlineAttachments).
    // Without this, `events` is the binary store for anything arriving through
    // save_memory, and the attachment carries no binding for the download route
    // to check.
    //
    // Publishing escapes the insert: every path below that does not end in a row
    // referencing these artifacts has to delete them, or a failed save leaks bytes
    // onto the volume with no owner.
    let attachments = args.attachments;
    let publishedArtifactIds: string[] = [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      const materialized = await materializeInlineAttachments(
        [{ id: externalId, attachments }],
        () =>
          eventArtifactBinding({
            organizationId: ctx.organizationId,
            originId: externalId,
          })
      );
      attachments = materialized.items[0]?.attachments ?? [];
      publishedArtifactIds = materialized.publishedArtifactIds;
      // pendingTranscriptions is deliberately dropped: transcription is wired to
      // connector ingest, and save_memory has never enqueued it. Wiring it here
      // would change what save_memory DOES; this change only fixes where the
      // bytes live.
    }

    const insertOptions = args.supersedes_event_id
      ? {
          afterPersist: async (event: InsertedEvent, tx: DbClient) => {
            if (event.change !== 'superseded') return;
            const [presented] = await tx<{ presented: boolean }>`
              WITH RECURSIVE ancestry AS (
                SELECT id, supersedes_event_id, metadata
                FROM events
                WHERE id = ${args.supersedes_event_id}
                  AND organization_id = ${ctx.organizationId}
                UNION ALL
                SELECT parent.id, parent.supersedes_event_id, parent.metadata
                FROM events parent
                JOIN ancestry child ON child.supersedes_event_id = parent.id
                WHERE parent.organization_id = ${ctx.organizationId}
              )
              SELECT EXISTS (
                SELECT 1 FROM ancestry
                WHERE jsonb_array_length(
                  CASE WHEN jsonb_typeof(metadata->'delivery') = 'array'
                    THEN metadata->'delivery' ELSE '[]'::jsonb END
                ) > 0
              ) AS presented
            `;
            if (!presented?.presented) return;
            await enqueueTasksInTransaction(tx, [
              {
                name: INTERACTIVE_EVENT_CARD_REFRESH_TASK,
                payload: {
                  organizationId: ctx.organizationId,
                  replacementEventId: Number(event.id),
                },
                opts: {
                  idempotencyKey: `interactive-event-card-refresh:${event.id}`,
                  maxAttempts: 5,
                  organizationId: ctx.organizationId,
                },
              },
            ]);
          },
        }
      : undefined;
    try {
      row = await insertEvent({
        entityIds: finalEntityIds,
        organizationId: ctx.organizationId,
        originId: externalId,
        title: args.title,
        payloadType,
        content: args.content ?? null,
        payloadData: args.payload_data,
        payloadTemplate: args.payload_template ?? null,
        attachments,
        authorName: args.author,
        sourceUrl: args.source_url ?? parentSourceUrl,
        // The schema promises "Defaults to now if omitted" — honor it. A NULL
        // occurred_at makes the event invisible to automation windows (window
        // content filters on occurred_at within [window_start, window_end)).
        occurredAt: args.occurred_at ?? new Date().toISOString(),
        semanticType,
        metadata: eventMetadata,
        parentOriginId,
        createdBy: ctx.userId,
        clientId: ctx.clientId,
        supersedesEventId: args.supersedes_event_id ?? null,
      }, insertOptions);
    } catch (error) {
      // No row of ours references these artifacts on any branch below — the
      // idempotency loser returns the winner's event, and everything else
      // rethrows — so they are unreachable bytes unless we delete them here.
      await deleteMaterializedArtifacts(publishedArtifactIds);
      // Two replicas may race after the preflight read. The unique index is the
      // lock; the loser resolves and returns the winner's durable event.
      if (
        args.idempotency_key &&
        isUniqueViolation(error, 'idx_events_org_idempotency_key')
      ) {
        const winner = await findIdempotentEvent(
          sql,
          ctx.organizationId,
          args.idempotency_key
        );
        if (!winner) throw error;
        if (winner.semantic_type !== semanticType) {
          throw new ToolUserError(
            `Idempotency key '${args.idempotency_key}' already belongs to semantic type '${winner.semantic_type}'`,
            409
          );
        }
        row = winner;
        inserted = false;
        persistedMetadata = winner.metadata;
      } else if (args.supersedes_event_id && isSupersededByUniqueViolation(error)) {
        // The "already superseded?" SELECT above is non-atomic: two concurrent
        // supersedes can both pass the read. Surface the index conflict cleanly.
        throw new ToolUserError(
          `Cannot supersede event ${args.supersedes_event_id}: already superseded by a concurrent write`,
          409
        );
      } else {
        throw error;
      }
    }
  }

  // 6b. Auto-link: scan content for entity name mentions.
  // Awaited so the background work doesn't outlive the tool call and reject
  // into an unhandled promise after the DB pool has been torn down.
  if (inserted && finalEntityIds.length > 0) {
    await autoLinkEvent({
      eventId: Number(row.id),
      entityIds: finalEntityIds,
      content: args.content ?? '',
      title: args.title,
      organizationId: ctx.organizationId,
    }).catch((err) => {
      logger.warn({ err, eventId: row.id }, 'autoLinkEvent failed');
    });
  }

  logger.info(
    {
      id: row.id,
      entity_ids: finalEntityIds,
      semantic_type: semanticType,
      supersedes: args.supersedes_event_id,
      idempotent_replay: !inserted,
    },
    inserted ? 'Content saved via save_memory' : 'Content save replay returned existing event'
  );

  // Track the automation reaction. The declared source is caller input; the
  // shared rule prefers a reaction session's own stamped identity over it and
  // credits nobody for an id belonging to another organization. Resolve it
  // whenever a row was inserted, not only when a source was declared: a
  // reaction carries the stamped pair and declares nothing, so gating on the
  // declaration left its write recorded against no Automation at all.
  const reactionAttribution = inserted
    ? await resolveAutomationAttribution(ctx, args.automation_source)
    : null;
  if (reactionAttribution?.automationId != null && reactionAttribution.runId != null) {
    await trackAutomationReaction({
      organizationId: ctx.organizationId,
      automationId: reactionAttribution.automationId,
      sourceRunId: reactionAttribution.runId,
      reactionType: 'content_saved',
      toolName: 'save_memory',
      toolArgs: { entity_ids: finalEntityIds, semantic_type: semanticType, title: args.title },
      entityId: finalEntityIds[0],
    }).catch((err) => {
      logger.warn({ err, automationSource: args.automation_source }, 'trackAutomationReaction failed');
    });
  }

  // Read real semantic-index readiness for this specific event rather than
  // asserting a fixed 'pending', and read back the persisted payload the inline
  // card renders.
  //
  // This used to be gated on the caller having negotiated MCP Apps, on the
  // theory that a client which cannot render the payload should not pay to ship
  // it. That theory died on prod: claude.ai renders the card while declaring no
  // Apps capability at all, so the gate handed it a card with no body. The
  // declaration is not a usable proxy for "can render" — the tool binding
  // stopped being gated on it for the same reason (see mcp-handler.ts) — and
  // the payload has to follow the binding, or the host mounts an empty widget.
  //
  // The cost is small and bounded: this is the content the caller just sent us,
  // echoed back to the surface that displays it. What still opts out is a
  // nested SDK save inside `run_sdk`, which mounts no card of its own — see
  // `headlessResult`. The per-column CASE keeps that a single round trip.
  // `needsEmbeddingSql` is the same predicate the embed backfill and worker use,
  // so callers can never disagree with the pipeline on what "indexed" means.
  // Embeddings are usually produced by the async backfill (so this is 'pending'),
  // but when one is supplied inline the row is already searchable.
  const savedId = Number(row.id);
  const shouldReadInlinePayload = ctx.headlessResult !== true;
  const [savedEvent] = await sql`
    SELECT
      CASE WHEN ${shouldReadInlinePayload} THEN e.payload_type END AS payload_type,
      CASE WHEN ${shouldReadInlinePayload} THEN e.payload_text END AS payload_text,
      CASE WHEN ${shouldReadInlinePayload} THEN e.payload_data END AS payload_data,
      CASE WHEN ${shouldReadInlinePayload} THEN e.payload_template END AS payload_template,
      CASE WHEN ${shouldReadInlinePayload} THEN e.attachments END AS attachments,
      CASE WHEN ${shouldReadInlinePayload} THEN e.source_url END AS source_url,
      ${sql.unsafe(needsEmbeddingSql('e', getConfiguredEmbeddingModel()))} AS needs_embedding
    FROM events e WHERE e.id = ${savedId}
  `;
  // The row is already committed, so a read-back miss must never fail the call:
  // reporting an error for a durable write invites a retry that appends a
  // duplicate. Degrade to "not searchable yet" and no inline payload instead.
  const searchable = savedEvent ? !savedEvent.needs_embedding : false;

  const inlinePayload =
    shouldReadInlinePayload && savedEvent
      ? {
          payload_type: String(savedEvent.payload_type) as NonNullable<
            SaveContentResult['payload_type']
          >,
          payload_text:
            savedEvent.payload_text == null ? null : String(savedEvent.payload_text),
          payload_data: (savedEvent.payload_data ?? {}) as Record<string, unknown>,
          payload_template:
            savedEvent.payload_template == null
              ? null
              : (savedEvent.payload_template as Record<string, unknown>),
          attachments: Array.isArray(savedEvent.attachments) ? savedEvent.attachments : [],
          source_url:
            savedEvent.source_url == null ? null : String(savedEvent.source_url),
        }
      : null;
  const boundedInlinePayload =
    inlinePayload &&
    Buffer.byteLength(JSON.stringify(inlinePayload), 'utf8') <=
      SAVE_MEMORY_INLINE_PAYLOAD_MAX_BYTES
      ? inlinePayload
      : null;

  const result: SaveContentResult = {
    id: savedId,
    entity_ids: Array.isArray(row.entity_ids) ? row.entity_ids.map(Number) : finalEntityIds,
    title: row.title as string | null,
    semantic_type: semanticType,
    // When present, this is the exact durable payload, not the caller's
    // arguments: it keeps idempotent retries honest and gives MCP App hosts the
    // same event the Lobu Activity UI reads from Postgres. Absent for headless
    // nested SDK saves and for oversized events, which keep the compact receipt
    // and the exact-read id rather than exceeding the App snapshot limit.
    ...(boundedInlinePayload ?? {}),
    created_at: String(row.created_at),
    // Row is committed by now; exact reads by id are available from this instant.
    durable_at: String(row.created_at),
    indexing_status: searchable ? 'completed' : 'pending',
    searchable,
    created: inserted,
    metadata: persistedMetadata,
    // `knowledge.read` takes `content_ids` (array) — a singular `content_id`
    // is rejected as an unknown argument, so the self-documenting hint must
    // use the exact shape the reader accepts.
    exact_read: {
      method: 'client.knowledge.read',
      content_ids: [savedId],
    },
  };
  if (args.supersedes_event_id) {
    result.supersedes_event_id = args.supersedes_event_id;
  }

  const viewUrl = await buildEventViewUrl(ctx, result.id);
  if (viewUrl) {
    result.view_url = viewUrl;
  }

  return result;
}
