/**
 * CRUD action handlers for manage_automations:
 *   create, update, delete, create_from_version
 */

import { getDb, parsePgTextArray } from '../../../db/client';
import type { Env } from '../../../index';
import { ToolUserError } from '../../../utils/errors';
import { isUniqueViolation } from '../../../utils/pg-errors';
import { nextRunAt } from '../../../utils/cron';
import { intervals } from '../../../config/intervals';
import { recordChangeEvent, recordLifecycleEvent } from '../../../utils/insert-event';
import { recordToolConfigChange } from '../helpers/config-audit';
import logger from '../../../utils/logger';
import { buildAutomationUrl, getOrganizationSlug, getPublicWebUrl } from '../../../utils/url-builder';
import {
  createClassifiersForAutomation,
  enableClassifiersOnEntity,
} from '../../../automations/classifier-extraction';
import { assertAutomationScriptExecutor } from '../../../automations/script-config';
import { assertDeviceWorkerAccess } from '../automation-device-access';
import {
  assertServerLaneModelResolves,
  assertValidExecutionConfig,
  automationScriptExecutor,
} from '../automation-execution-config';
import { assertEntityIdsInOrg, getNextNumericId, requireExists } from '../helpers/db-helpers';
import type { ToolContext } from '../../registry';
import type { ManageAutomationsArgs } from '../manage_automations';
import {
  normalizeAutomationUpdatePatch,
  type AutomationTrigger,
  type AutomationUpdatePatch,
} from '@lobu/core/contracts/tools/manage-automations';
import {
  assertOutputEntityTypesExist,
  assertOutputEventTypesExist,
  assertOutputsShape,
  assertAutomationVersionConfigValid,
  assertAutomationSourcesResolve,
  assertAutomationSkillsResolve,
  assertPromptSkillTokensPinned,
  normalizeStoredJsonField,
  parseJsonInput,
  toJsonParam,
  toTextArrayParam,
  summarizeResults,
  type AutomationOperationResult,
} from './shared';
import {
  type AutomationExecutorDefaults,
  type AutomationTriggerInput,
  assertAutomationExecutorsAuthorized,
  assertAutomationExecutorsResolve,
  resolveAutomationExecutor,
} from './executors';
import { getErrorMessage } from '@lobu/core';
import { DEFAULT_AUTOMATION_SOURCE_QUERY, automationSourcesFromPrompt, mergePromptSources } from '../../../automations/source-refs';
import {
  compileReactionScript,
  extractReactionInputSchema,
  validateReactionDefaultExport,
} from '../../../automations/reaction-executor';
import {
  assertAutomationInstructions,
  assertAutomationOutputsUseWindowExecution,
  assertAutomationTriggerConnections,
  automationTriggersEqual,
  resolveAutomationTriggerWrite,
} from '../../../automations/triggers';
import {
  syncAutomationChannelFeeds,
  syncAutomationChannelFeedsBestEffort,
} from '../../../automations/channel-subscriptions';
import { assertAutomationDeliveryTarget } from '../../../automations/delivery-target';

/**
 * Drop chat-link style triggers when cloning an Automation onto an entity.
 * Steer + reply_to_source on message.created is the live channel responder
 * contract; copying it would double-reply in linked channels.
 */
function stripChatLinkTriggers(triggers: unknown): unknown {
  if (!Array.isArray(triggers)) return triggers ?? [];
  return triggers.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object') return true;
    const t = candidate as Record<string, unknown>;
    if (t.kind !== 'event') return true;
    const eventTypes = t.event_types;
    if (!Array.isArray(eventTypes) || !eventTypes.includes('message.created')) {
      return true;
    }
    if (t.active_run === 'steer' && t.output === 'reply_to_source') {
      return false;
    }
    return true;
  });
}

// ============================================
// handleCreate
// ============================================

export async function handleCreate(
  args: ManageAutomationsArgs,
  _env: Env,
  ctx: ToolContext
): Promise<{
  action: 'create';
  automation_id: string;
  version: number;
  status: string;
  sources?: Array<{ name: string; query: string }>;
  view_url?: string;
}> {
  const sql = getDb();

  // Require slug for create. Instruction text (prompt) is required only when
  // the trigger shape runs on instructions alone — event-turn Automations may
  // omit it and run on the built-in default (see assertAutomationInstructions,
  // called after triggers resolve below). The output contract is not authored
  // here: declared outputs derive it from entity/event contracts at runtime;
  // an Automation without outputs or a reaction uses the free-form summary fallback.
  if (!args.slug) {
    throw new ToolUserError('slug is required for create action');
  }
  assertValidExecutionConfig(args.execution_config, ctx);
  await assertServerLaneModelResolves({
    executionConfig: args.execution_config,
    organizationId: ctx.organizationId,
    isDevicePinned: args.device_worker_id != null,
    applyId: ctx.applyId,
  });

  // entity_id is optional: omit it for an org-scoped/global automation.
  const entityId = args.entity_id;

  // Parse JSON inputs
  const outputs = parseJsonInput<Record<string, unknown>>(args.outputs, 'outputs');
  // String inputs pass the wire union unparsed — enforce the declared shape
  // here so both input forms meet the same contract.
  assertOutputsShape(outputs);
  const classifiers = parseJsonInput<unknown[]>(args.classifiers, 'classifiers');

  // Build sources array. Sources are authored two ways and merged here:
  //   1. `@`-mention tokens in the prompt (the owletto composer's primary path)
  //      — the backend derives them so the UI sends only the raw prompt.
  //   2. explicit `args.sources` (API callers / legacy).
  // If neither yields anything, fall back to a default all-events source.
  // `create_version` deliberately does NOT derive (see version-actions.ts):
  // an existing prompt's prose must not silently re-author the Automation's
  // source set during an otherwise unrelated version bump.
  const promptSources = automationSourcesFromPrompt(args.prompt ?? '');
  const explicitSources = args.sources ?? [];
  const merged = mergePromptSources(explicitSources, promptSources);
  const sources: Array<{ name: string; query: string }> =
    merged.length > 0
      ? merged
      : [
          {
            name: 'content',
            query: DEFAULT_AUTOMATION_SOURCE_QUERY,
          },
        ];

  // Validate automation config
  assertAutomationVersionConfigValid({
    prompt: args.prompt,
    classifiers,
    sources,
  });

  interface EntityRow {
    entity_type: string;
    parent_id: number | null;
    slug: string;
    organization_id: string | null;
    parent_slug: string | null;
    parent_entity_type: string | null;
  }
  let entityRow: EntityRow | null = null;
  let organizationId: string | null = ctx.organizationId ?? null;
  let organizationSlug: string | null = null;

  if (entityId) {
    const entityResult = await sql`
      SELECT
        e.id, et.slug AS entity_type, e.parent_id, e.slug, e.organization_id,
        parent.slug as parent_slug, pet.slug as parent_entity_type
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      LEFT JOIN entities parent ON e.parent_id = parent.id
      LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
      WHERE e.id = ${entityId}
    `;
    if (entityResult.length === 0) {
      throw new ToolUserError(`Entity with ID ${entityId} not found`, 404);
    }
    entityRow = entityResult[0] as EntityRow;
    organizationId = entityRow.organization_id;
    organizationSlug = await getOrganizationSlug(organizationId);
  } else {
    if (!organizationId) {
      throw new ToolUserError(
        'entity_id or an organization context is required to create an Automation'
      );
    }
    organizationSlug = await getOrganizationSlug(organizationId);
  }

  // Resolve every source against the org now so a broken source fails at create
  // (422) instead of producing silent empty context at read_knowledge: @refs are
  // existence-checked, and custom SQL is planned (LIMIT 0) to catch bad
  // columns/syntax. Pass the Automation's entity_ids so {{entityId}} validates as
  // it runs.
  if (!organizationId) {
    throw new ToolUserError('Cannot resolve Automation sources without an organization');
  }
  // Both of these are free-text columns with NO database foreign key, so an
  // unresolvable id is accepted by the INSERT and only shows up as an Automation
  // that never runs (managed_agent_id) or one whose output contract is silently voided
  // (outputs' entity/event targets). The executor matrix catches unresolvable
  // executors up front — every automated Automation needs an executor;
  // manual-only Automations (no triggers) may be executor-less.
  const executorDefaults: AutomationExecutorDefaults = {
    agentId: args.managed_agent_id ?? null,
    deviceWorkerId: args.device_worker_id ?? null,
    agentKind: args.agent_kind ?? null,
  };
  // Resolve entity output targets BEFORE the row is written.
  await assertOutputEntityTypesExist(sql, organizationId, outputs);
  await assertOutputEventTypesExist(
    organizationId,
    outputs,
    entityId ? [entityId] : []
  );
  await assertAutomationSourcesResolve(
    sql,
    organizationId,
    sources,
    entityId ? [entityId] : [],
  );
  const triggerWrite = resolveAutomationTriggerWrite({
    triggers: args.triggers,
  });
  assertAutomationOutputsUseWindowExecution(triggerWrite.triggers, outputs);
  await assertAutomationTriggerConnections(sql, organizationId, triggerWrite.triggers);
  // Executor matrix (after triggers resolve): every automated Automation needs
  // an executor; manual-only Automations (no triggers) may be executor-less.
  assertAutomationExecutorsResolve(
    triggerWrite.triggers as AutomationTriggerInput[],
    executorDefaults
  );
  await assertAutomationExecutorsAuthorized(
    sql,
    organizationId,
    executorDefaults,
    ctx
  );
  const deliveryTarget = args.delivery_target
    ? await assertAutomationDeliveryTarget(
        sql,
        organizationId,
        args.managed_agent_id ?? null,
        args.delivery_target
      )
    : null;
  const skills = args.skills ?? [];
  await assertAutomationScriptExecutor({
    executionConfig: args.execution_config,
    ...executorDefaults,
    triggers: triggerWrite.triggers,
    skills,
    outputs,
    classifiers,
  });
  assertAutomationInstructions(
    triggerWrite.triggers,
    args.prompt,
    skills,
    args.reaction_script,
    automationScriptExecutor(args.execution_config)?.source
  );
  assertPromptSkillTokensPinned(args.prompt, skills);
  // v1 constraint: skill bodies resolve against ONE agent library at save
  // time — the Automation-level default executor when it is an agent.
  // Per-trigger responders reuse these frozen bodies at dispatch.
  const defaultExecutor = resolveAutomationExecutor(executorDefaults);
  if (skills.length > 0) {
    if (!defaultExecutor || defaultExecutor.kind !== 'agent') {
      throw new ToolUserError(
        'skills require an Automation-level agent executor: skills compile against the default agent’s library. Set managed_agent_id, or remove skills for device-executed / manual-only Automations.',
        422
      );
    }
    await assertAutomationSkillsResolve(sql, organizationId, defaultExecutor.agentId, skills);
  }

  // Check slug uniqueness within org
  const existingSlug = await sql`
    SELECT id FROM automations
    WHERE organization_id = ${organizationId} AND slug = ${args.slug}
    LIMIT 1
  `;
  if (existingSlug.length > 0) {
    throw new ToolUserError(
      `Automation with slug '${args.slug}' already exists in this organization`,
      409
    );
  }

  const reactionScript = args.reaction_script?.trim() ? args.reaction_script : null;
  const reactionScriptCompiled = reactionScript
    ? await compileReactionScript(reactionScript)
    : null;
  if (reactionScriptCompiled) {
    await validateReactionDefaultExport(reactionScriptCompiled);
  }
  const reactionInputSchema = reactionScript
    ? await extractReactionInputSchema(reactionScript)
    : null;

  const createdBy = ctx.userId ?? 'system';

  // Allocated inside the transaction below: getNextNumericId relies on
  // pg_advisory_xact_lock, which only serializes when a real transaction is
  // open. Called on the pooled autocommit connection it releases immediately,
  // so concurrent creates would both compute MAX(id)+1 and collide on the PK.
  let automationId!: number;
  let versionId!: number;

  try {
    await sql.begin(async (tx) => {
      automationId = await getNextNumericId(tx, 'automations');
      versionId = await getNextNumericId(tx, 'automation_versions');
      const entityIdsArray = entityId ? [entityId] : [];

      const projectionNow = new Date();
      const nextRunAtVal = triggerWrite.schedule
        ? nextRunAt(triggerWrite.schedule, projectionNow, triggerWrite.timezone)
        : null;

      // 1. Create automation row
      await tx`
      INSERT INTO automations (
        id, name, slug, organization_id, entity_ids,
        schedule, timezone, next_run_at, triggers, managed_agent_id, model_config, sources, version,
        current_version_id, tags, status, created_by, created_at, updated_at,
        automation_group_id,
        device_worker_id, agent_kind,
        min_cooldown_seconds,
        delivery_target, execution_config,
        reaction_script, reaction_script_compiled, reaction_input_schema,
        next_window_start
      ) VALUES (
        ${automationId}, ${args.name ?? args.slug}, ${args.slug}, ${organizationId},
        ${`{${entityIdsArray.join(',')}}`}::bigint[],
        ${triggerWrite.schedule}, ${triggerWrite.timezone}, ${nextRunAtVal}, ${tx.json(triggerWrite.triggers)},
        ${args.managed_agent_id ?? null},
        ${sql.json(args.model_config || {})}, ${sql.json(sources)},
        1, NULL, ${toTextArrayParam(args.tags || [])}::text[],
        'active', ${createdBy}, NOW(), NOW(),
        ${automationId},
        ${args.device_worker_id ?? null}, ${args.agent_kind ?? null},
        ${args.min_cooldown_seconds ?? 0},
        ${toJsonParam(tx, deliveryTarget)},
        ${toJsonParam(tx, args.execution_config)},
        ${reactionScript}, ${reactionScriptCompiled},
        ${reactionInputSchema ? tx.json(reactionInputSchema) : null},
        date_trunc('milliseconds', current_timestamp) + interval '1 millisecond'
          - make_interval(secs => ${intervals.automationFirstWindowLookbackMs / 1000})
      )
    `;

      // 2. Create automation_versions row (v1)
      // Reaction fields (reaction_script/reaction_script_compiled/
      // reaction_input_schema) intentionally live on the automations row only, not
      // on automation_versions. Reactions are group-shared and unversioned (see
      // handleCreateFromVersion, which copies them off automations, and
      // handleSetReactionScript, which writes them group-wide). Don't add them
      // here: automation_versions has no such columns.
      await tx`
      INSERT INTO automation_versions (
        id, automation_id, version, name, description,
        prompt, version_sources, skills,
        outputs, classifiers,
        reactions_guidance, change_notes, created_by, created_at
      ) VALUES (
        ${versionId}, ${automationId}, 1, ${args.name ?? args.slug}, ${args.description ?? null},
        ${args.prompt ?? ''}, ${toJsonParam(tx, sources)}, ${tx.json(skills)},
        ${toJsonParam(tx, outputs)}, ${toJsonParam(tx, classifiers)},
        ${args.reactions_guidance ?? null}, ${'Initial version'}, ${createdBy}, NOW()
      )
    `;

      // 3. Point automation to the newly created current version
      await tx`
      UPDATE automations
      SET current_version_id = ${versionId}
      WHERE id = ${automationId}
    `;

      // 4. Auto-create classifiers (entity-level only)
      if (entityId && classifiers && Array.isArray(classifiers) && classifiers.length > 0) {
        if (!ctx.userId) {
          throw new ToolUserError('Authenticated user is required to create Automation classifiers', 403);
        }

        await createClassifiersForAutomation(tx, automationId as number, entityId, classifiers as any[], {
          createdBy: ctx.userId,
          organizationId: ctx.organizationId,
        });

        const slugs = (classifiers as any[]).map((d: any) => d.slug);
        await enableClassifiersOnEntity(tx, entityId, slugs);
      }
    });
  } catch (err) {
    // The slug precheck above is not a lock: two concurrent replicas can both
    // pass it and race idx_automations_org_slug. Translate that 23505 to the SAME
    // coded 409 the precheck emits so callers see one stable duplicate signal.
    if (isUniqueViolation(err, 'idx_automations_org_slug')) {
      throw new ToolUserError(
        `Automation with slug '${args.slug}' already exists in this organization`,
        409
      );
    }
    throw err;
  }

  // Build view URL
  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  let viewUrl: string | undefined;

  // The route is workspace-level, so it no longer needs an owning agent —
  // device-pinned and manual-only Automations get a link too.
  if (organizationSlug) {
    viewUrl = buildAutomationUrl(organizationSlug, automationId as number, baseUrl);
  }

  logger.info(`[manage_automations] Created automation ${automationId} with slug '${args.slug}'`);

  await syncAutomationChannelFeedsBestEffort({
    organizationId,
    after: triggerWrite.triggers,
    sql,
  });

  if (organizationId) {
    recordLifecycleEvent({
      organizationId,
      entityType: 'automation',
      op: 'created',
      entityId: automationId,
      summary: `Automation "${args.name ?? args.slug}" created`,
      extra: { slug: args.slug, managed_agent_id: args.managed_agent_id ?? null },
    });

    recordToolConfigChange(ctx, {
      organizationId,
      resourceKind: 'automation',
      resourceId: automationId,
      op: 'created',
      summary: `Automation '${args.name ?? args.slug}' created`,
      // Post-insert state composed from the inserted values (the row is not
      // refetched); includes the v1 version-bound fields (prompt, sources, …).
      state: {
        id: automationId,
        name: args.name ?? args.slug,
        slug: args.slug,
        status: 'active',
        version: 1,
        current_version_id: versionId,
        entity_ids: entityId ? [entityId] : [],
        schedule: triggerWrite.schedule,
        timezone: triggerWrite.timezone,
        triggers: triggerWrite.triggers,
        managed_agent_id: args.managed_agent_id ?? null,
        agent_kind: args.agent_kind ?? null,
        device_worker_id: args.device_worker_id ?? null,
        model_config: args.model_config ?? {},
        execution_config: args.execution_config ?? null,
        sources,
        tags: args.tags ?? [],
        delivery_target: deliveryTarget,
        min_cooldown_seconds: args.min_cooldown_seconds ?? 0,
        prompt: args.prompt ?? '',
        description: args.description ?? null,
        outputs: outputs ?? null,
        classifiers: classifiers ?? null,
        reactions_guidance: args.reactions_guidance ?? null,
        reaction_script: reactionScript,
        reaction_input_schema: reactionInputSchema ?? null,
      },
    });
  }

  return {
    action: 'create',
    automation_id: String(automationId),
    version: 1,
    status: 'active',
    sources,
    view_url: viewUrl,
  };
}

// ============================================
// handleUpdate
// ============================================

export async function handleUpdate(
  args: ManageAutomationsArgs,
  _env: Env,
  ctx: ToolContext
): Promise<{ action: 'update'; automation_id: string; updated_fields: string[] }> {
  const sql = getDb();

  if (!args.automation_id) {
    throw new ToolUserError('automation_id is required for update action', 400);
  }
  assertValidExecutionConfig(args.execution_config, ctx);
  // Re-pinning to a device targets that device owner's machine — validate the
  // caller may pin it (own it, or org owner/admin over an org-attached device).
  // undefined = unchanged and null = clear the pin both pass without a lookup.
  await assertDeviceWorkerAccess(sql, args.device_worker_id, ctx);

  await requireExists(sql, 'automations', args.automation_id, 'Automation');
  const currentRows = await sql`
    SELECT w.organization_id, w.managed_agent_id, w.schedule, w.timezone, w.triggers,
           w.device_worker_id::text AS device_worker_id, w.agent_kind,
           w.delivery_target, w.reaction_script, w.execution_config,
           cv.prompt AS current_prompt, cv.skills AS current_skills,
           cv.outputs AS current_outputs, cv.classifiers AS current_classifiers
    FROM automations w
    LEFT JOIN automation_versions cv ON cv.id = w.current_version_id
    WHERE w.id = ${args.automation_id}
    LIMIT 1
  `;
  const currentRow = currentRows[0] as {
    organization_id: string;
    managed_agent_id: string | null;
    device_worker_id: string | null;
    agent_kind: string | null;
    schedule: string | null;
    timezone: string | null;
    triggers: ManageAutomationsArgs['triggers'];
    delivery_target: ManageAutomationsArgs['delivery_target'];
    reaction_script: string | null;
    execution_config: unknown;
    current_prompt: string | null;
    current_skills: Array<{ name: string; content: string }> | null;
    current_outputs: Record<string, unknown> | null;
    current_classifiers: unknown[] | null;
  };
  // Judge the model against the lane the Automation will be on AFTER this
  // patch, not the one it is on now: clearing a device pin in the same call
  // moves the ref onto the server lane, where it has to resolve.
  //
  // Only an incoming `execution_config` is judged. Clearing the pin WITHOUT
  // re-sending one leaves an already-stored CLI-namespace ref on the now-server
  // lane, and it fails at dispatch rather than here. That is deliberate:
  // re-validating the stored model would make unrelated updates start failing
  // on legacy rows nobody is touching.
  await assertServerLaneModelResolves({
    executionConfig: args.execution_config,
    organizationId: currentRow.organization_id,
    isDevicePinned:
      args.device_worker_id !== undefined
        ? args.device_worker_id != null
        : currentRow.device_worker_id != null,
    applyId: ctx.applyId,
  });
  const effectiveExecutionConfig =
    args.execution_config !== undefined
      ? args.execution_config
      : currentRow.execution_config;
  const triggerWrite = resolveAutomationTriggerWrite({
    triggers: args.triggers,
    currentTriggers: currentRow.triggers ?? [],
  });
  assertAutomationOutputsUseWindowExecution(
    triggerWrite.triggers,
    normalizeStoredJsonField(
      currentRow.current_outputs,
      undefined as Record<string, unknown> | undefined
    )
  );
  if (
    args.triggers !== undefined &&
    !automationTriggersEqual(currentRow.triggers ?? [], triggerWrite.triggers)
  ) {
    await assertAutomationTriggerConnections(sql, currentRow.organization_id, triggerWrite.triggers);
    // Trigger shape alone can force the instruction rule (event-turn → schedule
    // with an empty current prompt must fail). Callers that need to change both
    // triggers and instructions atomically must use create_version with both
    // fields — lobu apply does that path.
    assertAutomationInstructions(
      triggerWrite.triggers,
      currentRow.current_prompt,
      currentRow.current_skills,
      currentRow.reaction_script,
      automationScriptExecutor(effectiveExecutionConfig)?.source,
    );
  }

  // Executor matrix on the EFFECTIVE state (patch over the current row): an
  // automated Automation needs an executor. Clearing managed_agent_id is fine when a
  // device pin remains (device precedence), and manual-only Automations (no
  // triggers) may be executor-less.
  const effectiveDefaults: AutomationExecutorDefaults = {
    agentId: args.managed_agent_id !== undefined ? args.managed_agent_id : currentRow.managed_agent_id,
    deviceWorkerId:
      args.device_worker_id !== undefined
        ? args.device_worker_id
        : currentRow.device_worker_id,
    agentKind:
      args.agent_kind !== undefined ? args.agent_kind : currentRow.agent_kind,
  };
  assertAutomationExecutorsResolve(
    triggerWrite.triggers as AutomationTriggerInput[],
    effectiveDefaults
  );
  await assertAutomationExecutorsAuthorized(
    sql,
    ctx.organizationId,
    effectiveDefaults,
    ctx
  );

  await assertAutomationScriptExecutor({
    executionConfig: effectiveExecutionConfig, ...effectiveDefaults,
    triggers: triggerWrite.triggers,
    skills: currentRow.current_skills, outputs: currentRow.current_outputs,
    classifiers: currentRow.current_classifiers,
    validateSource: args.execution_config !== undefined,
  });
  // Clearing a sole script executor must not leave an instruction-free job.
  if (args.execution_config !== undefined) {
    assertAutomationInstructions(
      triggerWrite.triggers,
      currentRow.current_prompt,
      currentRow.current_skills,
      currentRow.reaction_script,
      automationScriptExecutor(effectiveExecutionConfig)?.source
    );
  }

  let normalizedDeliveryTarget = args.delivery_target ?? null;
  if (args.delivery_target) {
    normalizedDeliveryTarget = await assertAutomationDeliveryTarget(
      sql,
      currentRow.organization_id,
      effectiveDefaults.agentId ?? null,
      args.delivery_target
    );
  } else if (
    args.managed_agent_id !== undefined &&
    args.delivery_target === undefined &&
    currentRow.delivery_target
  ) {
    await assertAutomationDeliveryTarget(
      sql,
      currentRow.organization_id,
      effectiveDefaults.agentId ?? null,
      currentRow.delivery_target
    );
  }

  const updatedFields: string[] = [];
  if (args.model_config !== undefined) updatedFields.push('model_config');
  if (args.execution_config !== undefined) updatedFields.push('execution_config');
  if (args.triggers !== undefined) updatedFields.push('triggers');
  if (args.managed_agent_id !== undefined) updatedFields.push('managed_agent_id');
  if (args.tags !== undefined) updatedFields.push('tags');
  if (args.device_worker_id !== undefined) updatedFields.push('device_worker_id');
  if (args.agent_kind !== undefined) updatedFields.push('agent_kind');
  if (args.delivery_target !== undefined) updatedFields.push('delivery_target');
  if (args.min_cooldown_seconds !== undefined) updatedFields.push('min_cooldown_seconds');

  if (updatedFields.length === 0) {
    return {
      action: 'update',
      automation_id: args.automation_id,
      updated_fields: [],
    };
  }

  // Single source of truth for the stored write-normalization — the SAME
  // function feeds the config-approval review's `proposedAfter`, so what the
  // reviewer saw is byte-for-byte what this UPDATE writes (displayed == applied,
  // drift-impossible). `field in patch` reproduces the prior `args.field !==
  // undefined` guard: normalize only emits keys present in args.
  const patch = normalizeAutomationUpdatePatch(args);
  if (args.triggers !== undefined) {
    patch.triggers = triggerWrite.triggers;
  }
  if (args.delivery_target !== undefined) {
    patch.delivery_target = normalizedDeliveryTarget;
  }
  const has = (k: keyof AutomationUpdatePatch) => k in patch;
  // Recompute next_run_at when the cadence OR its zone changes; the effective
  // pair mixes the incoming args with the stored row for whichever side was
  // omitted, so a timezone-only update re-anchors the pending firing.
  const touchesCadence = args.triggers !== undefined;
  const effectiveSchedule = touchesCadence ? triggerWrite.schedule : currentRow.schedule;
  const effectiveTimezone = touchesCadence ? triggerWrite.timezone : currentRow.timezone;
  const cadenceChanged =
    touchesCadence &&
    (effectiveSchedule !== currentRow.schedule ||
      effectiveTimezone !== currentRow.timezone);
  const projectionNow = new Date();
  const nextRunAtVal =
    touchesCadence && effectiveSchedule
      ? nextRunAt(effectiveSchedule, projectionNow, effectiveTimezone)
      : null;

  const updatedRows = await sql`
    UPDATE automations SET
      updated_at = NOW(),
      model_config = CASE WHEN ${has('model_config')} THEN ${toJsonParam(sql, patch.model_config)} ELSE model_config END,
      execution_config = CASE WHEN ${has('execution_config')} THEN ${toJsonParam(sql, patch.execution_config)} ELSE execution_config END,
      schedule = CASE WHEN ${touchesCadence} THEN ${triggerWrite.schedule ?? null} ELSE schedule END,
      timezone = CASE WHEN ${touchesCadence} THEN ${triggerWrite.timezone ?? null} ELSE timezone END,
      triggers = CASE WHEN ${has('triggers')} THEN ${toJsonParam(sql, patch.triggers)} ELSE triggers END,
      next_run_at = CASE WHEN ${touchesCadence} THEN ${nextRunAtVal}::timestamptz ELSE next_run_at END,
      consecutive_scheduled_failures = CASE WHEN ${cadenceChanged} THEN 0 ELSE consecutive_scheduled_failures END,
      schedule_auto_paused_at = CASE WHEN ${cadenceChanged} THEN NULL ELSE schedule_auto_paused_at END,
      managed_agent_id = CASE WHEN ${has('managed_agent_id')} THEN ${patch.managed_agent_id ?? null} ELSE managed_agent_id END,
      tags = CASE WHEN ${has('tags')} THEN ${toTextArrayParam(patch.tags ?? [])}::text[] ELSE tags END,
      device_worker_id = CASE WHEN ${has('device_worker_id')} THEN ${patch.device_worker_id ?? null}::uuid ELSE device_worker_id END,
      agent_kind = CASE WHEN ${has('agent_kind')} THEN ${patch.agent_kind ?? null} ELSE agent_kind END,
      delivery_target = CASE WHEN ${has('delivery_target')} THEN ${toJsonParam(sql, patch.delivery_target)} ELSE delivery_target END,
      -- A 0-cooldown reply Automation stamps this cursor for observability.
      -- Enabling debounce must start with a fresh window, exactly as it did
      -- before zero-cooldown stamping; positive -> positive keeps its window.
      last_event_activation_at = CASE
        WHEN ${has('min_cooldown_seconds')}
          AND min_cooldown_seconds = 0
          AND ${patch.min_cooldown_seconds ?? 0} > 0
        THEN NULL
        ELSE last_event_activation_at
      END,
      min_cooldown_seconds = CASE WHEN ${has('min_cooldown_seconds')} THEN ${patch.min_cooldown_seconds ?? 0} ELSE min_cooldown_seconds END
    WHERE id = ${args.automation_id} AND organization_id = ${ctx.organizationId}
    RETURNING *
  `;

  logger.info(`[manage_automations] Updated automation ${args.automation_id}: ${updatedFields.join(', ')}`);

  const updatedRow = (updatedRows[0] ?? null) as Record<string, unknown> | null;
  await syncAutomationChannelFeedsBestEffort({
    organizationId: currentRow.organization_id,
    before: currentRow.triggers ?? [],
    after: triggerWrite.triggers,
    sql,
  });
  recordToolConfigChange(ctx, {
    organizationId: (updatedRow?.organization_id as string | null) ?? ctx.organizationId,
    resourceKind: 'automation',
    resourceId: args.automation_id,
    op: 'updated',
    summary: `Automation '${updatedRow?.name ?? args.automation_id}' updated`,
    state: updatedRow,
    changedFields: updatedFields,
  });

  return {
    action: 'update',
    automation_id: args.automation_id,
    updated_fields: updatedFields,
  };
}

// ============================================
// handleDelete
// ============================================

export async function handleDelete(
  args: ManageAutomationsArgs,
  ctx: ToolContext
): Promise<{
  action: 'delete';
  results: AutomationOperationResult[];
  summary: { total: number; successful: number; failed: number };
}> {
  const sql = getDb();

  if (!args.automation_ids || args.automation_ids.length === 0) {
    throw new ToolUserError('automation_ids is required and cannot be empty', 400);
  }

  const results: AutomationOperationResult[] = [];

  for (const automationId of args.automation_ids) {
    try {
      // Org-scope the mutation: requireAutomationAccess now lets ids that aren't
      // in-org at check time fall through to this aggregate, and automation ids are
      // sequential integers — so a racing cross-tenant insert between check and
      // write must not be archivable. organization_id fences that TOCTOU.
      const updated = await sql`
        UPDATE automations
        SET status = 'archived', updated_at = NOW()
        WHERE id = ${automationId}
          AND organization_id = ${ctx.organizationId}
          AND status != 'archived'
        RETURNING id, name, entity_ids, organization_id, triggers
      `;

      if (updated.length === 0) {
        results.push({
          automation_id: automationId,
          success: false,
          message: 'Automation not found or already archived',
        });
      } else {
        const automation = updated[0];
        const entityIds = Array.isArray(automation.entity_ids) ? automation.entity_ids : [];

        // Record change event in knowledge for audit trail
        if (entityIds.length > 0 && automation.organization_id) {
          recordChangeEvent({
            entityIds: entityIds.map(Number),
            organizationId: automation.organization_id as string,
            subject: 'automation',
            // `deleted`, not `archived`: the lifecycle and config writers for
            // this same action below already stamp `automation.deleted`, and
            // one action must not fork the shared vocabulary.
            op: 'deleted',
            title: `Automation archived: ${automation.name || automationId}`,
            content: `Automation "${automation.name || automationId}" (id: ${automationId}) was archived.`,
            metadata: {
              action: 'automation_archived',
              automation_id: automationId,
              automation_name: automation.name,
            },
          });
        }
        if (automation.organization_id) {
          await syncAutomationChannelFeedsBestEffort({
            organizationId: automation.organization_id as string,
            before: (automation.triggers ?? []) as ManageAutomationsArgs['triggers'],
            sql,
          });
          recordLifecycleEvent({
            organizationId: automation.organization_id as string,
            entityType: 'automation',
            op: 'deleted',
            entityId: automationId,
            summary: `Automation "${automation.name || automationId}" archived`,
          });

          recordToolConfigChange(ctx, {
            organizationId: automation.organization_id as string,
            resourceKind: 'automation',
            resourceId: automationId,
            op: 'deleted',
            summary: `Automation '${automation.name || automationId}' archived`,
            state: null,
          });
        }

        results.push({
          automation_id: automationId,
          success: true,
          message: 'Automation archived successfully',
        });
      }
    } catch (error) {
      results.push({
        automation_id: automationId,
        success: false,
        message: getErrorMessage(error),
      });
    }
  }

  return {
    action: 'delete',
    results,
    summary: summarizeResults(results),
  };
}

// ============================================
// handleCreateFromVersion
// ============================================

export async function handleCreateFromVersion(
  args: ManageAutomationsArgs,
  _env: Env,
  ctx: ToolContext
): Promise<{
  action: 'create_from_version';
  created: Array<{ automation_id: string; entity_id: number; name: string }>;
}> {
  const sql = getDb();

  if (!args.version_id) throw new ToolUserError('version_id is required for create_from_version', 400);
  if (!args.entity_ids || args.entity_ids.length === 0) {
    throw new ToolUserError('entity_ids is required for create_from_version', 400);
  }
  // Bind the narrowed value: the transaction closure below re-widens
  // `args.entity_ids` back to `number[] | undefined`, losing this guard.
  const entityIds = args.entity_ids;

  // Fetch the source version + the source automation's reaction script AND its
  // derived input schema. Reaction script + its `reaction_input_schema` contract
  // live on the automations row, not on automation_versions, so they have to be copied
  // explicitly when assigning the template to a new entity. Without this copy the
  // new assignment would have no reactions — or (dropping the input schema) a
  // reaction with no extraction contract, silently running free-form.
  const versionRows = await sql`
    SELECT wv.*, w.organization_id, w.schedule, w.timezone, w.triggers, w.sources, w.managed_agent_id,
           w.device_worker_id::text AS device_worker_id, w.agent_kind,
           w.model_config, w.execution_config, w.tags, w.automation_group_id,
           w.reaction_script, w.reaction_script_compiled, w.reaction_input_schema
    FROM automation_versions wv
    JOIN automations w ON w.id = wv.automation_id
    WHERE wv.id = ${args.version_id}
    LIMIT 1
  `;
  if (versionRows.length === 0) throw new ToolUserError(`Version ${args.version_id} not found`, 404);
  const version = versionRows[0];
  const organizationId = version.organization_id as string;
  if (!organizationId || organizationId !== ctx.organizationId) {
    throw new ToolUserError(
      `Access denied: Automation version ${args.version_id} does not belong to your organization`,
      403
    );
  }
  // The clone strips chat-link steer/reply triggers (a second agent turn for
  // the same message), so the matrix runs on the STRIPPED shape — an agentless
  // source whose only automated triggers were chat-link responders must be
  // allowed to clone as manual-only, and a source that strips down to nothing
  // must not land executor-less automated rows. Every automated clone needs an
  // executor; manual-only clones may be executor-less (same invariant as
  // handleCreate/handleUpdate).
  const cloneTriggers = stripChatLinkTriggers(version.triggers) as AutomationTrigger[];
  const cloneDefaults: AutomationExecutorDefaults = {
    agentId: (version.managed_agent_id as string | null) ?? null,
    deviceWorkerId: (version.device_worker_id as string | null) ?? null,
    agentKind: (version.agent_kind as string | null) ?? null,
  };
  // The executor is copied verbatim onto every clone, and a version can
  // outlive the executor it names (managed_agent_id/device_worker_id have no FK, so a
  // deleted agent/device leaves the reference dangling). Resolve + authorize
  // once here so the fan-out cannot mint a batch of Automations the scheduler
  // will never run — or store a device pin the caller may not target.
  assertAutomationExecutorsResolve(cloneTriggers, cloneDefaults);
  await assertAutomationExecutorsAuthorized(sql, organizationId, cloneDefaults, ctx);

  // Reject cross-org entity_ids before cloning: an automation attached to another
  // org's entity links its synced/extracted content to a non-existent in-org
  // entity (silent data-correctness bug). Names are fetched org-scoped below.
  await assertEntityIdsInOrg(sql, organizationId, entityIds);

  // Fetch entity names for name pattern substitution (org-scoped)
  const entityRows = await sql`
    SELECT e.id, e.name, et.slug AS entity_type, e.slug
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${organizationId}
      AND e.id = ANY(${`{${entityIds.join(',')}}`}::bigint[])
  `;
  const entityMap = new Map(entityRows.map((e: any) => [Number(e.id), e]));

  // A once-valid version can outlive a referenced table or entity type. Resolve
  // its sources before fan-out, passing each assignment's entity context so
  // `{{entityId}}` is validated the same way as at runtime.
  const clonedSources = (version.version_sources ?? version.sources ?? []) as Array<{
    name: string;
    query: string;
  }>;
  const clonedOutputs = normalizeStoredJsonField(
    version.outputs,
    undefined as Record<string, unknown> | undefined
  );
  await assertOutputEntityTypesExist(sql, organizationId, clonedOutputs);
  for (const entityId of entityIds) {
    await assertOutputEventTypesExist(organizationId, clonedOutputs, [entityId]);
  }
  if (clonedSources.length > 0) {
    for (const entityId of entityIds) {
      await assertAutomationSourcesResolve(sql, organizationId, clonedSources, [entityId]);
    }
  }

  const createdBy = ctx.userId ?? 'system';
  const created: Array<{
    automation_id: string;
    entity_id: number;
    name: string;
  }> = [];
  // Audit/lifecycle payloads are collected inside the transaction and emitted
  // only after it commits — a rollback must not leak "created" events for
  // automations that never landed (events is append-only; we can't take them back).
  const auditPayloads: Array<{
    entityId: number;
    automationId: number;
    automationName: string;
    automationSlug: string;
    sources: unknown;
    sharedVersionId: number;
    groupId: number;
  }> = [];

  // The whole fan-out runs in ONE transaction. Two reasons:
  //  1. getNextNumericId relies on pg_advisory_xact_lock, which only serializes
  //     when a real transaction is open. On the pooled autocommit connection the
  //     lock releases immediately, so concurrent assignments would both compute
  //     MAX(id)+1 and collide on the automations PK.
  //  2. Atomicity: a mid-loop failure (e.g. a slug clash on the 3rd entity)
  //     would otherwise leave a partial fan-out — some assignments created,
  //     some not. All-or-nothing is the correct contract here.
  try {
    await sql.begin(async (tx) => {
      for (const entityId of entityIds) {
        const entity = entityMap.get(entityId);
        if (!entity) throw new ToolUserError(`Entity ${entityId} not found`, 404);

        const namePattern = args.name_pattern ?? `${version.name}: {{entity_name}}`;
        const automationName = namePattern.replace(/\{\{entity_name\}\}/g, entity.name as string);
        const automationSlug = `${version.name}-${entity.slug}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-');

        const automationId = await getNextNumericId(tx, 'automations');
        // The new assignment shares the source's existing automation_versions row
        // rather than getting its own duplicate copy. version_id (the arg) is
        // the row in automation_versions we're cloning from; that becomes the
        // assignment's current_version_id directly. The version row itself is
        // owned by the group root (automation_group_id), so all assignments in
        // the group point at the same chain.
        const sharedVersionId = Number(args.version_id);
        const groupId = (version.automation_group_id ?? version.automation_id) as number;
        // Entity clones must not inherit chat-link steer/reply triggers (or the
        // system:chat-link tag): those bind a live channel responder, and
        // cloning them would create a second agent turn for the same message.
        // cloneTriggers is computed once above (it does not depend on entity).
        // After stripping, the residual trigger shape must still satisfy the
        // instruction rule (chat-link-only sources become manual/empty triggers
        // and require a non-empty prompt, a pinned skill, a reaction script, or
        // a script executor).
        // The clone SHARES the source's automation_versions row, so its pinned
        // skills come along with it — they satisfy the rule here exactly as they
        // will at dispatch.
        assertAutomationInstructions(
          (Array.isArray(cloneTriggers) ? cloneTriggers : []) as AutomationTrigger[],
          version.prompt as string | null | undefined,
          version.skills as Array<{ name: string; content: string }> | null,
          version.reaction_script as string | null | undefined,
          automationScriptExecutor(version.execution_config)?.source,
        );
        assertAutomationOutputsUseWindowExecution(
          (Array.isArray(cloneTriggers) ? cloneTriggers : []) as AutomationTrigger[],
          clonedOutputs
        );
        await assertAutomationScriptExecutor({ executionConfig: version.execution_config, ...cloneDefaults,
          triggers: cloneTriggers as AutomationTrigger[], skills: version.skills as unknown[] | null,
          outputs: clonedOutputs, classifiers: version.classifiers as unknown[] | null,
          validateSource: false });
        // `tags` is a text[] column read under fetch_types:false, so postgres.js
        // hands back a raw array literal string (e.g. "{}" or "{system:chat-link}"),
        // not a JS array. Parse it before filtering.
        const cloneTags = parsePgTextArray(
          version.tags as string | string[] | null,
        ).filter((tag) => tag !== 'system:chat-link');
        await tx`
          INSERT INTO automations (
            id, name, slug, organization_id, entity_ids,
            schedule, timezone, next_run_at, triggers, managed_agent_id, device_worker_id, agent_kind, model_config, execution_config, sources, version,
            current_version_id, tags, status, created_by, created_at, updated_at,
            automation_group_id, source_automation_id,
            reaction_script, reaction_script_compiled, reaction_input_schema,
            next_window_start
          ) VALUES (
            ${automationId}, ${automationName}, ${automationSlug}, ${organizationId},
            ${`{${entityId}}`}::bigint[],
            ${version.schedule ?? null}, ${version.timezone ?? null}, ${version.schedule ? nextRunAt(version.schedule as string, new Date(), version.timezone as string | null) : null}, ${toJsonParam(tx, cloneTriggers)},
            ${version.managed_agent_id ?? null},
            ${version.device_worker_id ?? null},
            ${version.agent_kind ?? null},
            ${toJsonParam(tx, version.model_config)}, ${toJsonParam(tx, version.execution_config)}, ${toJsonParam(tx, clonedSources)},
            ${(version.version as number) ?? 1}, ${sharedVersionId}, ${toTextArrayParam(cloneTags)}::text[],
            'active', ${createdBy}, NOW(), NOW(),
            ${groupId}, ${version.automation_id},
            ${(version.reaction_script as string | null) ?? null},
            ${(version.reaction_script_compiled as string | null) ?? null},
            ${toJsonParam(tx, version.reaction_input_schema)},
            date_trunc('milliseconds', current_timestamp) + interval '1 millisecond'
              - make_interval(secs => ${intervals.automationFirstWindowLookbackMs / 1000})
          )
        `;

        created.push({
          automation_id: String(automationId),
          entity_id: entityId,
          name: automationName,
        });
        auditPayloads.push({
          entityId,
          automationId,
          automationName,
          automationSlug,
          sources: clonedSources,
          sharedVersionId,
          groupId,
        });
        // This runs inside the clone transaction, so projection failure must
        // roll the clone back with it.
        await syncAutomationChannelFeeds({
          organizationId,
          after: Array.isArray(cloneTriggers)
            ? (cloneTriggers as AutomationTrigger[])
            : [],
          sql: tx,
        });
      }
    });
  } catch (err) {
    // The derived slug is not pre-checked and is not locked: two concurrent
    // assignments (or a re-run) can produce the same slug and race
    // idx_automations_org_slug. Surface a coded 409 instead of leaking a raw 23505.
    if (isUniqueViolation(err, 'idx_automations_org_slug')) {
      throw new ToolUserError(
        `An Automation assignment with a colliding slug already exists in this organization`,
        409
      );
    }
    throw err;
  }

  // Post-commit: emit lifecycle + audit events now that the rows are durable.
  for (const p of auditPayloads) {
    recordLifecycleEvent({
      organizationId,
      entityType: 'automation',
      op: 'created',
      entityId: p.automationId,
      summary: `Automation "${p.automationName}" created`,
      extra: { slug: p.automationSlug, via: 'create_from_version' },
    });

    recordToolConfigChange(ctx, {
      organizationId,
      resourceKind: 'automation',
      resourceId: p.automationId,
      op: 'created',
      summary: `Automation '${p.automationName}' created from version ${args.version_id}`,
      // Composed from the cloned insert values (row not refetched); the
      // version-bound fields come from the shared source version row.
      state: {
        id: p.automationId,
        name: p.automationName,
        slug: p.automationSlug,
        status: 'active',
        entity_ids: [p.entityId],
        schedule: version.schedule ?? null,
        timezone: version.timezone ?? null,
        triggers: version.triggers ?? [],
        managed_agent_id: version.managed_agent_id ?? null,
        device_worker_id: (version.device_worker_id as string | null) ?? null,
        agent_kind: (version.agent_kind as string | null) ?? null,
        version: (version.version as number) ?? 1,
        current_version_id: p.sharedVersionId,
        automation_group_id: p.groupId,
        source_automation_id: version.automation_id,
        sources: p.sources,
        prompt: version.prompt ?? null,
        outputs: version.outputs ?? null,
        classifiers: version.classifiers ?? null,
        reactions_guidance: version.reactions_guidance ?? null,
      },
    });
  }

  return { action: 'create_from_version', created };
}
