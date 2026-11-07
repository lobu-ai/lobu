import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import {
  ActionApplyInputSchema,
  isActionFieldName,
  type ActionApplyInput,
  type ActionDefinition,
  type ActionValueBinding,
} from '@lobu/core/contracts/tools/manage-actions';
import { eventClientId } from '../auth/event-client-id';
import { resolveActingPrincipal, type ActingPrincipal } from '../authz/entity-policy';
import { EntityRowValidationError } from '../authz/entity-row-validation';
import { type DbClient, getDb } from '../db/client';
import { emit } from '../events/emitter';
import type { Env } from '../index';
import type { ToolContext } from '../tools/registry';
import { runWithActingAutomation } from '../utils/acting-automation-context';
import { getEntityHooks } from '../utils/entity-hooks';
import { updateEntity } from '../utils/entity-management';
import { mismatchedExpectedFields } from '../utils/entity-field-merge';
import {
  EntityPolicyDenialError,
  recordEntityWriteDenial,
  type EntityWriteDenialDescription,
} from '../utils/entity-write-denial-audit';
import { ToolUserError } from '../utils/errors';
import { insertConnectionlessWorkspaceEvent, stableJson } from '../utils/insert-event';
import { requireOrgWriteAccess } from '../utils/organization-access';
import {
  assertActionJson,
  getActionVersion,
  requireActionPermission,
  validateActionDefinition,
  validateActionEvent,
  validateActionParams,
} from './registry';

export interface ActionSource {
  viewKey: string;
  action: string;
  scopeEventId?: number;
}

export interface ApplyActionOptions {
  source?: ActionSource;
  /** The view adapter checks its current saved binding only for NEW execution.
   * The same transaction holds its lock through commit. Replays do not depend
   * on a view still existing or its alias still naming the original revision. */
  beforeNewExecution?: (tx: DbClient) => Promise<void>;
}

export interface CommittedActionResult {
  created: boolean;
  replayed: boolean;
  dry_run: false;
  receipt_id: number;
  action: { id: number; key: string; version: number };
  event_id: number;
  event_type: string;
  /** Only the declared writeback fields; never expose the whole entity row. */
  entity: { id: number; metadata: Record<string, unknown> };
}

export interface ValidatedActionResult {
  dry_run: true;
  valid: true;
  action: { id: number; key: string; version: number };
  target_id: number;
  changed_fields: string[];
}

export type ActionApplyResult = CommittedActionResult | ValidatedActionResult;

class DryRunRollback extends Error {
  constructor(readonly result: ValidatedActionResult) {
    super('Roll back validated action');
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid persisted action JSON');
  }
  return parsed as Record<string, unknown>;
}

function conflict(): never {
  throw new ToolUserError(
    'The idempotency key belongs to a different action, actor, or request.',
    409,
    'IDEMPOTENCY_CONFLICT'
  );
}

function checkExpected(
  definition: ActionDefinition,
  expected: Record<string, unknown>,
  current: Record<string, unknown>
): void {
  if (Object.keys(expected).length > 50 || Object.keys(expected).some((key) => !isActionFieldName(key))) {
    throw new ToolUserError('Expected values must name at most 50 metadata fields.', 400, 'VALIDATION');
  }
  const missing = (definition.requiredExpected ?? []).filter((key) => !Object.hasOwn(expected, key));
  if (missing.length > 0) {
    throw new ToolUserError(`Required expected fields: ${missing.join(', ')}.`, 400, 'VALIDATION');
  }
  const mismatched = mismatchedExpectedFields(current, expected);
  if (mismatched.length > 0) {
    throw new ToolUserError(
      'The record changed. Refresh it before submitting a new action.',
      409,
      'PRECONDITION_FAILED',
      { mismatched_fields: mismatched }
    );
  }
}

function checkTransition(
  definition: ActionDefinition,
  params: Record<string, unknown>,
  current: Record<string, unknown>
): void {
  const transition = definition.transition;
  if (!transition) return;
  const from = current[transition.field] ?? null;
  const to = params[transition.param];
  const allowed = transition.allowed.some(
    (edge) => edge.from === from && typeof to === 'string' && edge.to.includes(to)
  );
  if (!allowed) {
    throw new ToolUserError('This state transition is not permitted.', 409, 'VALIDATION');
  }
}

function resolveBindings(
  bindings: Record<string, ActionValueBinding>,
  params: Record<string, unknown>,
  timestamp: string,
  eventId?: number
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(bindings).map(([field, binding]) => {
    if ('param' in binding) {
      if (!Object.hasOwn(params, binding.param)) {
        throw new ToolUserError(`Missing action parameter: ${binding.param}.`, 400, 'VALIDATION');
      }
      return [field, params[binding.param]];
    }
    if ('literal' in binding) return [field, binding.literal];
    if ('server' in binding) return [field, timestamp];
    if (eventId === undefined) {
      throw new ToolUserError('An event cannot refer to its own generated ID.', 400, 'VALIDATION');
    }
    return [field, eventId];
  }));
}

function denialFrom(error: unknown): EntityWriteDenialDescription | null {
  if (error instanceof EntityPolicyDenialError) return error.denial;
  if (error instanceof EntityRowValidationError && error.verdict.outcome === 'deny') {
    const verdict = error.verdict;
    return {
      denialSource: 'rule',
      operation: verdict.operation,
      reason: verdict.reason,
      deniedFields: verdict.fields,
      entityId: verdict.entityId,
      entityType: verdict.entityType,
      entityOrganizationId: verdict.entityOrganizationId,
    };
  }
  return null;
}

export function applyAction(
  input: ActionApplyInput & { dry_run?: false },
  env: Env,
  ctx: ToolContext,
  options?: ApplyActionOptions
): Promise<CommittedActionResult>;
export function applyAction(
  input: ActionApplyInput,
  env: Env,
  ctx: ToolContext,
  options?: ApplyActionOptions
): Promise<ActionApplyResult>;
export async function applyAction(
  input: ActionApplyInput,
  env: Env,
  ctx: ToolContext,
  options: ApplyActionOptions = {}
): Promise<ActionApplyResult> {
  if (!Value.Check(ActionApplyInputSchema, input)) {
    throw new ToolUserError('Invalid typed action request.', 400, 'VALIDATION');
  }
  assertActionJson(input.params, 'params');
  assertActionJson(input.expected ?? {}, 'expected');
  if (input.idempotency_key.includes('\0')) {
    throw new ToolUserError('The idempotency key must not contain NUL.', 400, 'VALIDATION');
  }
  // Snapshot once before awaiting. SDK callers must not be able to change the
  // request between receipt hashing, validation, and the guarded write.
  const params = JSON.parse(JSON.stringify(input.params)) as Record<string, unknown>;
  const expected = JSON.parse(JSON.stringify(input.expected ?? {})) as Record<string, unknown>;
  const { key, version, idempotency_key: callerKey, dry_run: dryRun = false } = input;
  const source = options.source ? {
    viewKey: options.source.viewKey,
    action: options.source.action,
    scopeEventId: options.source.scopeEventId ?? null,
  } : null;
  const receiptKey = `typed:${callerKey}`;
  let actor: ActingPrincipal | undefined;
  let attemptId: string | undefined;

  try {
    const result = await getDb().begin(async (tx) => {
      // Current account/role/scope authorization still applies to receipt
      // replay. Target preconditions and transition rules apply only to writes.
      await requireOrgWriteAccess(tx, ctx);
      const action = await getActionVersion(tx, ctx.organizationId, key, version);
      await requireActionPermission(tx, ctx, action.definition.invokePermission);
      actor = await resolveActingPrincipal(tx, {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        agentId: ctx.agentId,
        sessionAutomationId: ctx.actingAutomationId ?? null,
      });
      if (!actor.ownerResolved) {
        throw new ToolUserError('The acting principal is no longer available.', 403, 'PERMISSION');
      }
      const request = {
        action: { id: action.id, key, version, versionId: action.versionId },
        actor: {
          userId: ctx.userId ?? null,
          clientId: eventClientId(ctx),
          kind: actor.kind,
          id: actor.id,
          automationId: ctx.actingAutomationId ?? null,
        },
        params,
        expected,
        source,
      };
      const canonical = stableJson(request);
      const fingerprint = createHash('sha256').update(canonical).digest('hex');
      attemptId = `typed-action:${ctx.organizationId}:${callerKey}:${fingerprint}`;

      // The durable UNIQUE index waits for a simultaneous owner to commit or
      // roll back. No reservation or running row is ever committed separately.
      const inserted = await tx<{ id: number }>`
        INSERT INTO runs (
          organization_id, run_type, action_key, action_input, action_idempotency_key,
          action_type_id, action_version_id, status, approval_status,
          policy_principal_kind, policy_principal_id, created_by_user_id,
          automation_id, parent_run_id, run_metadata
        ) VALUES (
          ${ctx.organizationId}, 'action', ${key}, ${tx.json(request)}, ${receiptKey},
          ${action.id}, ${action.versionId}, 'running', 'auto',
          ${actor.kind}, ${actor.id}, ${ctx.userId ?? null},
          ${ctx.actingAutomationId ?? null}, ${ctx.actingRunId ?? null},
          ${tx.json({ kind: 'typed_action', request_hash: fingerprint })}
        )
        ON CONFLICT (organization_id, action_idempotency_key)
          WHERE run_type = 'action' AND action_idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) {
        const [prior] = await tx<{
          id: number;
          action_type_id: number | null;
          action_version_id: number | null;
          action_input: unknown;
          action_output: unknown;
          status: string;
        }>`
          SELECT id, action_type_id, action_version_id, action_input, action_output, status
          FROM runs
          WHERE organization_id = ${ctx.organizationId}
            AND run_type = 'action' AND action_idempotency_key = ${receiptKey}
          FOR SHARE
        `;
        if (!prior) throw new Error('Committed action receipt was not readable');
        if (Number(prior.action_type_id) !== action.id ||
            Number(prior.action_version_id) !== action.versionId ||
            stableJson(objectValue(prior.action_input)) !== canonical) conflict();
        const output = objectValue(prior.action_output);
        if (prior.status !== 'completed' || output.dry_run !== false ||
            output.receipt_id !== Number(prior.id) || typeof output.event_id !== 'number') {
          throw new Error('Action receipt is not a completed command');
        }
        // Validation of a retry has no new execution to preview.
        if (dryRun) {
          throw new DryRunRollback({
            dry_run: true,
            valid: true,
            action: { id: action.id, key, version },
            target_id: Number(objectValue(output.entity).id),
            changed_fields: [],
          });
        }
        return { ...output, created: false, replayed: true } as unknown as CommittedActionResult;
      }
      const receiptId = Number(inserted[0]!.id);

      // Keep enabled state and the view binding stable through this commit.
      const [currentAction] = await tx<{ enabled: boolean }>`
        SELECT enabled FROM action_types
        WHERE id = ${action.id} AND organization_id = ${ctx.organizationId}
        FOR SHARE
      `;
      if (!currentAction?.enabled) {
        throw new ToolUserError('This action is disabled.', 409, 'VALIDATION');
      }
      await options.beforeNewExecution?.(tx);
      await validateActionDefinition(tx, ctx.organizationId, action.definition);
      validateActionParams(action.definition, params);
      const entityId = params[action.definition.target.idParam];
      if (typeof entityId !== 'number' || !Number.isSafeInteger(entityId) || entityId <= 0) {
        throw new ToolUserError('The target parameter must be a positive entity ID.', 400, 'VALIDATION');
      }

      // Preserve the normal mutation lock order: organization before entity.
      await tx`SELECT id FROM organization WHERE id = ${ctx.organizationId} FOR KEY SHARE`;
      const [target] = await tx<{ metadata: unknown; entity_type: string }>`
        SELECT e.metadata, et.slug AS entity_type
        FROM entities e JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.id = ${entityId} AND e.organization_id = ${ctx.organizationId}
          AND e.deleted_at IS NULL AND et.slug = ${action.definition.target.entityType}
        FOR UPDATE OF e
      `;
      if (!target) throw new ToolUserError('The action target was not found.', 404, 'NOT_FOUND');
      if (target.entity_type.startsWith('$') || getEntityHooks(target.entity_type)) {
        throw new ToolUserError('This entity type does not support atomic actions.', 400, 'VALIDATION');
      }
      const before = objectValue(target.metadata);
      checkExpected(action.definition, expected, before);
      checkTransition(action.definition, params, before);
      const timestamp = new Date().toISOString();
      const payload = resolveBindings(action.definition.emits.payload, params, timestamp);
      await validateActionEvent(tx, ctx.organizationId, action.definition, payload);

      // This is the only domain event. Its insertion also appends the existing
      // workspace activation task on tx. Both disappear if any later write fails.
      const event = await runWithActingAutomation({
        automationId: ctx.actingAutomationId ?? null,
        runId: ctx.actingRunId ?? null,
      }, () => insertConnectionlessWorkspaceEvent({
        organizationId: ctx.organizationId,
        entityIds: [entityId],
        originId: `typed-action:${receiptId}`,
        originType: 'typed_action',
        semanticType: action.definition.emits.kind,
        title: action.key,
        payloadType: 'empty',
        occurredAt: timestamp,
        metadata: {
          ...payload,
          _lobu_action_id: action.id,
          _lobu_action_version: version,
          _lobu_action_receipt_id: receiptId,
          _lobu_event_schema_version: action.definition.emits.schemaVersion,
          ...(source ? { _lobu_view_action: source } : {}),
        },
        createdBy: ctx.userId ?? null,
        clientId: eventClientId(ctx),
        runId: receiptId,
        automationId: ctx.actingAutomationId ?? null,
      }, `typed-action:${receiptId}`, { sql: tx }));
      const patch = resolveBindings(action.definition.set, params, timestamp, Number(event.id));
      const updated = await updateEntity(entityId, { metadata: patch }, env, ctx, {
        sql: tx,
        approvalMode: 'reject',
        policyPrincipalKind: actor.kind,
        principalId: actor.id,
        ownerAgentId: actor.ownerAgentId,
        ownerResolved: actor.ownerResolved,
        attribution: actor.kind === 'automation' ? 'automation' : 'agent',
        parentRunId: ctx.actingRunId ?? null,
      });
      const persisted = objectValue(updated.metadata);
      if (Object.keys(patch).some((field) => stableJson(persisted[field]) !== stableJson(patch[field]))) {
        throw new ToolUserError('Action writeback must match the target schema without coercion.', 400, 'VALIDATION');
      }
      const metadata = Object.fromEntries(Object.keys(patch).map((field) => [field, persisted[field]]));
      const committed: CommittedActionResult = {
        created: true,
        replayed: false,
        dry_run: false,
        receipt_id: receiptId,
        action: { id: action.id, key, version },
        event_id: Number(event.id),
        event_type: action.definition.emits.kind,
        entity: { id: entityId, metadata },
      };
      await tx`
        UPDATE runs
        SET status = 'completed', action_output = ${tx.json(committed)},
            completed_at = current_timestamp
        WHERE id = ${receiptId} AND organization_id = ${ctx.organizationId}
      `;
      if (dryRun) {
        // Exercise the real event, queue, validation and write path, then roll
        // everything back. Generated sequence IDs/time are not preview promises.
        throw new DryRunRollback({
          dry_run: true,
          valid: true,
          action: committed.action,
          target_id: entityId,
          changed_fields: Object.keys(patch).filter(
            (field) => stableJson(before[field] ?? null) !== stableJson(persisted[field] ?? null)
          ),
        });
      }
      return committed;
    }) as CommittedActionResult;

    emit(ctx.organizationId, { keys: ['entities', 'entities-by-type', 'resolve-path'] });
    return result;
  } catch (error) {
    if (error instanceof DryRunRollback) return error.result;
    const denial = denialFrom(error);
    if (!dryRun && denial && actor && attemptId) {
      // A denied attempt is an audit fact, separate from the rolled-back domain
      // event. Expected/approval conflicts and dry runs append no denial audit.
      await recordEntityWriteDenial({
        ...denial,
        organizationId: ctx.organizationId,
        ctx,
        attemptId,
        actor,
        automationId: ctx.actingAutomationId ?? null,
      });
    }
    throw error;
  }
}
