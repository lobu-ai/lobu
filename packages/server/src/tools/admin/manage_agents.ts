/**
 * Tool: manage_agents
 *
 * Manage agent definitions within an organization.
 *
 * Actions:
 * - list: List agents the principal may read (agent_config read policy)
 * - get: Get one agent when agent_config read allows that target
 * - create: Create an agent owned by the authenticated caller (owner_platform=
 *   'external' + an agent_users mapping, so the per-user chat path can reach it)
 * - update: Patch an agent's editable fields (name/description/identity_md/default_model)
 * - delete: Delete an agent
 *
 *
 * Agent/automation principals: list/get honor agent_config `read` (default auto;
 * per-target deny tightens via target_agent_id — max-restrictive fold, so
 * targets cannot loosen a blanket deny). Humans skip the write-gate (role
 * tier is separate). create/update/delete still go through the write-gate.
 */

import { isDeepStrictEqual } from 'node:util';
import type { AgentSettings } from '@lobu/core';
import {
  collectLobuFields,
  type LobuField,
} from '@lobu/core/contracts/field-engine';
import {
  CreateAgentAction,
  DeleteAgentAction,
  GetAgentAction,
  ListAgentsAction,
  ManageAgentsSchema,
  UpdateAgentAction,
  type AgentModelInfo,
  type AgentRecord,
  type ManageAgentsProposal,
  type ManageAgentsResult,
} from '@lobu/core/contracts/tools/manage-agents';
import { Type, type Static } from '@sinclair/typebox';
import {
  resolveActingPrincipal,
  resolveWritePolicyDecision,
  type ActingPrincipal,
} from '../../authz/entity-policy';
import { resolveNewAgentProvisioningDefaults } from '../../auth/system-provider-resolution';

import { createDbClientFromEnv, getDb, type DbClient } from '../../db/client';
import type { Env } from '../../index';
import {
  currentMcpActivityAttribution,
  currentMcpActivityEventMetadata,
} from '../../lobu/stores/mcp-client-conversations';
import {
  readAgentModels,
  resolveAgentModelInfo,
  validateModelRefsAgainstOrg,
} from '../../lobu/model-config';
import { getLobuCoreServices } from '../../lobu/gateway';
import { createPostgresAgentConfigStore, isValidAgentId } from '../../lobu/stores/postgres-stores';
import { orgContext } from '../../lobu/stores/org-context';
import { deleteAgentConfig, insertAgentConfig, persistAgentMetadataPatch, persistAgentSettingsPatch, validateAgentSettingsUpdate } from '../../lobu/agent-settings';
import { deriveToolActorSource } from '../../utils/apply-context';
import { lockOrganizationForRelationshipClaims } from '../../utils/relationship-claims';
import { resolveActionOrigin } from '../../notifications/action-origin';
import { notifyActionApprovalNeeded } from '../../notifications/triggers';
import { resolveApprovalChatOrigin } from './approval-delivery';
import { insertEvent } from '../../utils/insert-event';
import {
  ApprovalKind,
  approvalContext,
  highApprovalImpact,
  normalApprovalImpact,
} from '../../utils/approval-context';
import logger from '../../utils/logger';
import {
  buildAgentSettingsUrl,
  buildResourcePermalink,
} from '../../utils/url-builder';
import { ToolUserError } from '../../utils/errors';
import { requireOrgReadAccess, requireOrgWriteAccess } from '../../utils/organization-access';
import { resolveRunInitiator } from '../initiator';
import type { ToolContext } from '../registry';
import { validateToolArgs } from '../validate-args';
import { getOrgUrlContext } from '../view-urls';
import { action, defineActionTool } from './action-tool';
import { eventClientId } from '../../auth/event-client-id';

export { ManageAgentsSchema };
export type { ManageAgentsProposal };

type ListArgs = Static<typeof ListAgentsAction>;
type GetArgs = Static<typeof GetAgentAction>;
type CreateArgs = Static<typeof CreateAgentAction>;
type UpdateArgs = Static<typeof UpdateAgentAction>;
type DeleteArgs = Static<typeof DeleteAgentAction>;
/**
 * The three actions routed through the `agent_config` write-gate. Also a
 * schema, so a persisted proposal naming a NON-write action is rejected by
 * {@link applyManageAgentsProposal} instead of falling through its dispatch.
 */
const WriteActions = Type.Union([CreateAgentAction, UpdateAgentAction, DeleteAgentAction]);
type WriteArgs = Static<typeof WriteActions>;

/**
 * Synthetic `runs.action_key` tagging a manage_agents write held for approval.
 * `manage_operations`' approve/reject handlers branch on this value to apply
 * (or cancel) the held mutation, reusing the same durable runs/events approval
 * primitive that connector operations use. These rows have run_type='internal'
 * (no connector / connection), so the operation lookup in the connector path is
 * skipped.
 */
export const MANAGE_AGENTS_ACTION_KEY = 'manage_agents';

// ============================================
// Type handlers
// ============================================

async function actingPrincipalFor(ctx: ToolContext): Promise<ActingPrincipal> {
  return resolveActingPrincipal(getDb(), {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionAutomationId: ctx.actingAutomationId ?? null,
  });
}

/**
 * Compute an agent's effective model + inheritance source (#2047). Reads the
 * agent's `models` list through the shared settings store (org-scoped) and
 * folds in the org default — the SAME layered fallback the run path uses, so a
 * caller can distinguish a pinned model from an inherited default. With a
 * gateway catalog, also checks cloud-provider routing as the agent owner.
 */
async function agentModelInfo(
  ctx: ToolContext,
  agentId: string,
  settings?: AgentSettings,
): Promise<AgentModelInfo> {
  const models = settings ? settings.models : await readAgentModels(agentId, ctx.organizationId);
  const coreServices = getLobuCoreServices();
  return resolveAgentModelInfo(models, ctx.organizationId, {
    agentId,
    catalog: coreServices?.getProviderCatalogService?.(),
    publicGatewayUrl: coreServices?.getPublicGatewayUrl?.() ?? '',
  });
}

/**
 * Validate a `default_model` ref against the org's providers, reusing the SAME
 * core the web config route uses (#2047). A blank/empty ref is a legal "clear
 * back to org default" and passes. Throws a `ToolUserError` (400) with the
 * provider-not-connected guidance so a bad model is rejected at request time —
 * both for immediate applies and before an approval card is ever shown.
 */
async function assertDefaultModelValid(
  organizationId: string,
  modelRef: string,
): Promise<void> {
  if (!modelRef.trim()) return;
  const error = await validateModelRefsAgainstOrg([modelRef], organizationId);
  if (error) throw new ToolUserError(error.message, 400);
}

// ============================================
// Schema-driven editable-field engine
// ============================================
//
// The editable agent fields (name/description/identity_md/default_model) are
// declared ONCE, in the contract's shared field set, via `x-lobu-field`
// annotations. `collectLobuFields` reads them; the binding below says, per
// storage kind, how to read the current value, validate a new one, and persist
// it. create / update / buildProposal / pre-image all loop this single list —
// adding a field is one annotated schema entry, not edits in seven places.

/**
 * The editable fields of this tool, in schema declaration order. Read off the
 * `update` variant: it is the patch shape, so by construction it carries every
 * editable field and nothing else.
 */
const AGENT_FIELDS: LobuField[] = collectLobuFields(UpdateAgentAction);

/** Read a field's requested value off a write action's args. */
function argValue(args: WriteArgs, key: string): string | undefined {
  return (args as Record<string, unknown>)[key] as string | undefined;
}

/** Validate a single field's requested value (only the model field validates). */
async function validateField(
  ctx: ToolContext,
  field: LobuField,
  value: string,
): Promise<void> {
  if (field.meta.store === 'model') {
    await assertDefaultModelValid(ctx.organizationId, value);
  }
}

/**
 * agent_config read gate for list/get. Humans skip (admin tier is separate).
 * Default is auto; deny by target via target_agent_id (or blanket deny + whitelist).
 */
async function assertAgentConfigReadAllowed(
  ctx: ToolContext,
  targetAgentId: string | null,
): Promise<void> {
  const actor = await actingPrincipalFor(ctx);
  if (actor.kind === "user") return;
  const decision = await resolveWritePolicyDecision({
    organizationId: ctx.organizationId,
    resourceClass: "agent_config",
    principalKind: actor.kind,
    principalId: actor.id,
    ownerAgentId: actor.ownerAgentId,
    ownerResolved: actor.ownerResolved,
    action: "read",
    targetAgentId,
  });
  // require_approval collapses to deny for read (see resolveWritePolicyDecision).
  if (decision !== "allow") {
    const label = targetAgentId?.trim() || "agents";
    throw new ToolUserError(
      `Policy denies reading agent '${label}' for this principal.`,
      403,
    );
  }
}

async function agentConfigReadAllowed(
  ctx: ToolContext,
  actor: ActingPrincipal,
  targetAgentId: string,
): Promise<boolean> {
  if (actor.kind === "user") return true;
  const decision = await resolveWritePolicyDecision({
    organizationId: ctx.organizationId,
    resourceClass: "agent_config",
    principalKind: actor.kind,
    principalId: actor.id,
    ownerAgentId: actor.ownerAgentId,
    ownerResolved: actor.ownerResolved,
    action: "read",
    targetAgentId,
  });
  return decision === "allow";
}

async function handleList(
  _args: ListArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  const sql = createDbClientFromEnv(env);
  const rows = await sql`
    SELECT
      a.id,
      a.name,
      a.description,
      a.owner_platform,
      a.owner_user_id,
      a.created_at,
      a.last_used_at
    FROM agents a
    WHERE a.organization_id = ${ctx.organizationId}
    ORDER BY a.created_at ASC
  `;
  const agents = rows as unknown as AgentRecord[];
  const actor = await actingPrincipalFor(ctx);
  if (actor.kind === "user") {
    return { action: "list", agents };
  }
  // Per-target read: drop peers the agent_config envelope denies (blacklist via
  // default auto + target_agent_id deny). Cache by agent id.
  const allowed: AgentRecord[] = [];
  const cache = new Map<string, boolean>();
  for (const agent of agents) {
    let ok = cache.get(agent.id);
    if (ok === undefined) {
      ok = await agentConfigReadAllowed(ctx, actor, agent.id);
      cache.set(agent.id, ok);
    }
    if (ok) allowed.push(agent);
  }
  return { action: "list", agents: allowed };
}

async function handleGet(
  args: GetArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  // Gate before the lookup so a denied target does not distinguish "exists" vs
  // "forbidden" via timing alone more than a 404 would — we still 403 on deny
  // after confirming org membership of the id when found; missing stays 404.
  const sql = createDbClientFromEnv(env);
  const rows = await sql`
    SELECT
      a.id,
      a.name,
      a.description,
      a.owner_platform,
      a.owner_user_id,
      a.created_at,
      a.last_used_at
    FROM agents a
    WHERE a.organization_id = ${ctx.organizationId} AND a.id = ${args.agent_id}
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Agent "${args.agent_id}" not found`, 404);
  }
  await assertAgentConfigReadAllowed(ctx, args.agent_id.trim());
  const settings = await orgContext.run({ organizationId: ctx.organizationId }, () =>
    createPostgresAgentConfigStore().getSettings(args.agent_id),
  );
  if (!settings) throw new ToolUserError(`Agent "${args.agent_id}" not found`, 404);
  const model = await agentModelInfo(ctx, args.agent_id, settings);
  return { action: 'get', agent: rows[0] as unknown as AgentRecord, model, settings };
}

function agentConfigAudit(ctx: ToolContext) {
  return {
    organizationId: ctx.organizationId, applyId: ctx.applyId,
    actorSource: deriveToolActorSource(ctx), createdBy: ctx.userId,
    clientId: eventClientId(ctx), agentId: ctx.agentId,
    actingAutomationId: ctx.actingAutomationId, actingRunId: ctx.actingRunId,
    mcpSessionId: ctx.mcpSessionId, tokenType: ctx.tokenType,
  };
}

/**
 * Insert the agent. Every caller runs the args through {@link buildProposal}
 * first — the immediate path right before dispatch, the queued path when the
 * proposal was queued and again as it is applied — so the id/name rules are
 * enforced there, once.
 */
export async function applyCreate(
  args: CreateArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  // Created agents must have an owner to attribute them to — without one the
  // agents row exists but the per-user ownership path can't reach it.
  if (!ctx.userId) {
    throw new ToolUserError(
      'create requires an authenticated caller to own the new agent'
    );
  }
  // Validate every requested field BEFORE inserting, so an invalid value can't
  // leave a half-created agent (row inserted, a later field rejected). The loop
  // is the same for whatever fields the schema declares.
  for (const field of AGENT_FIELDS) {
    const value = argValue(args, field.key);
    if (value !== undefined) await validateField(ctx, field, value);
  }
  const sql = createDbClientFromEnv(env);
  const ownerUserId = ctx.userId;
  // Fresh-agent provisioning defaults, from the SAME helper every other create
  // path uses (see `resolveNewAgentProvisioningDefaults` for the full rationale
  // and the org-default ordering). Seeded ONLY when the caller did not pin an
  // explicit `default_model` — that takes precedence in the insert below.
  const provisioning = await resolveNewAgentProvisioningDefaults(
    ctx.organizationId
  );
  const explicitModel = argValue(args, 'default_model');
  const seedModels = explicitModel !== undefined
    ? (explicitModel.trim() ? [explicitModel.trim()] : null)
    : provisioning.models;
  const created = await sql.begin(tx => insertAgentConfig(tx, args,
    { platform: 'external', userId: ownerUserId }, seedModels, agentConfigAudit(ctx)));
  const model = await agentModelInfo(ctx, args.agent_id);
  return { action: 'create', agent_id: args.agent_id, created, model };
}

export async function applyUpdate(
  args: UpdateArgs,
  ctx: ToolContext,
  env: Env,
  /**
   * Pre-image captured when a queued update was proposed. When present, a field
   * is written only if its live value still equals its pre-image — a stale
   * approval skips (and reports) fields another writer has since changed. Absent
   * for immediate (human) applies, which overwrite unconditionally.
   */
  base?: ManageAgentsProposal['base'],
  /**
   * Set by the QUEUED-approval apply path ({@link applyManageAgentsProposal}).
   * A queued update MUST carry a pre-image for every field it writes — that's
   * how a stale approval is prevented from clobbering a newer human edit. A
   * legacy pending run created before this branch has no `base`; without this
   * flag a missing base read as "overwrite unconditionally" and silently
   * clobbered the newer value (sol review #8). With it set, a field lacking a
   * pre-image FAILS CLOSED: the field is skipped and reported, never written on
   * blind faith. Immediate (human) applies leave this false and overwrite.
   */
  requireBase = false
): Promise<ManageAgentsResult> {
  const agentId = args.agent_id;
  const requested = AGENT_FIELDS.filter((f) => argValue(args, f.key) !== undefined);
  const requestedSettings = args.settings ?? {};
  if (!requested.length && !Object.keys(requestedSettings).length) {
    throw new ToolUserError('update requires at least one editable field or setting');
  }
  assertUnambiguousSettings(args);
  const appliedFields: string[] = [];
  const skippedFields: string[] = [];
  await orgContext.run({ organizationId: ctx.organizationId }, () =>
    createDbClientFromEnv(env).begin(async (tx) => {
      await lockOrganizationForRelationshipClaims(tx, ctx.organizationId);
      const rows = await tx`SELECT id, name, description, identity_md FROM agents
        WHERE organization_id = ${ctx.organizationId} AND id = ${agentId} FOR UPDATE`;
      if (!rows.length) throw new ToolUserError(`Agent "${agentId}" not found`, 404);
      const row = rows[0];
      const store = createPostgresAgentConfigStore(tx);
      const before = (await store.getSettings(agentId))!;
      const settings: Partial<AgentSettings> = {};
      const columns: Pick<UpdateArgs, 'name' | 'description'> = {};
      for (const field of requested) {
        const value = argValue(args, field.key)!;
        const live = field.meta.store === 'model'
          ? (before.models?.[0] ?? null) : (row[field.key] ?? null);
        const preimage = base?.[field.key as keyof typeof base];
        if ((requireBase && preimage === undefined) ||
            (preimage !== undefined && !isDeepStrictEqual(live, preimage))) {
          skippedFields.push(field.key);
          continue;
        }
        if (field.key === 'identity_md') settings.identityMd = value;
        else if (field.meta.store === 'model') {
          // Replace models[0] only; the fallback entries stay. The merged list is
          // validated with the rest of the settings patch below.
          settings.models = value.trim() ? [value.trim(), ...(before.models?.slice(1) ?? [])] : undefined;
        } else if (field.key === 'name' || field.key === 'description') columns[field.key] = value;
        appliedFields.push(field.key);
      }
      for (const key of Object.keys(requestedSettings) as Array<keyof typeof requestedSettings>) {
        const preimage = base?.settings?.[key];
        if ((requireBase && !Object.hasOwn(base?.settings ?? {}, key)) ||
            (base?.settings && Object.hasOwn(base.settings, key) &&
             !isDeepStrictEqual(before[key] ?? null, preimage))) {
          skippedFields.push(`settings.${key}`);
          continue;
        }
        // Object.assign: TS cannot relate settings[key] to requestedSettings[key]
        // across the key union, and the action schema already typed the value.
        Object.assign(settings, { [key]: requestedSettings[key] });
        appliedFields.push(`settings.${key}`);
      }
      await assertSettingsValid(ctx, agentId, settings, before);
      const audit = agentConfigAudit(ctx);
      if (Object.keys(settings).length) {
        await persistAgentSettingsPatch(tx, agentId, settings, before, audit);
      }
      if (Object.keys(columns).length) {
        await persistAgentMetadataPatch(tx, agentId, columns, audit);
      }
    }),
  );
  const model = await agentModelInfo(ctx, agentId);
  return {
    action: 'update', agent_id: agentId, updated_fields: appliedFields,
    ...(skippedFields.length ? { skipped_fields: skippedFields } : {}), model,
  };
}

function assertUnambiguousSettings(args: UpdateArgs): void {
  if (args.default_model !== undefined && args.settings?.models !== undefined) {
    throw new ToolUserError('Use either default_model or settings.models, not both');
  }
}

async function assertSettingsValid(
  ctx: ToolContext,
  agentId: string,
  settings: Partial<AgentSettings>,
  before: AgentSettings | null,
): Promise<void> {
  const error = await validateAgentSettingsUpdate(settings, before, ctx.organizationId, agentId);
  if (error) throw new ToolUserError(error.error_description, error.error === 'models_validation_failed' ? 503 : 400);
}

export async function applyDelete(
  args: DeleteArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  const deleted = await orgContext.run({ organizationId: ctx.organizationId }, () =>
    createDbClientFromEnv(env).begin(async tx => {
      await lockOrganizationForRelationshipClaims(tx, ctx.organizationId);
      await tx`SELECT id FROM agents WHERE organization_id = ${ctx.organizationId}
        AND id = ${args.agent_id} FOR UPDATE`;
      return deleteAgentConfig(tx, args.agent_id, agentConfigAudit(ctx));
    }));
  return { action: 'delete', agent_id: args.agent_id, deleted };
}

// ============================================
// Approval gate (reuses the runs/events primitive)
// ============================================

/** Fetch the current agent row so the approval card can diff proposed vs current. */
async function fetchCurrentAgent(
  organizationId: string,
  agentId: string,
  env: Env
): Promise<Record<string, unknown> | null> {
  const sql = createDbClientFromEnv(env);
  const rows = await sql`
    SELECT id, name, description, identity_md
    FROM agents
    WHERE organization_id = ${organizationId} AND id = ${agentId}
    LIMIT 1
  `;
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

/** Human label for each gated action, used in card titles + notifications. */
function actionLabel(action: 'create' | 'update' | 'delete', agentId: string): string {
  switch (action) {
    case 'create':
      return `Create agent "${agentId}"`;
    case 'update':
      return `Update agent "${agentId}"`;
    case 'delete':
      return `Delete agent "${agentId}"`;
  }
}

/**
 * Build the proposed-change payload held on the run for a write action, after
 * the per-action rules the schema cannot express (so a malformed proposal is
 * rejected at request time, not at approve time). Presence of `agent_id` and
 * `name` is the schema's job.
 */
function buildProposal(args: WriteArgs): ManageAgentsProposal {
  const { action } = args;
  if (action === 'create') {
    if (!isValidAgentId(args.agent_id)) {
      throw new ToolUserError(
        `Invalid agent_id "${args.agent_id}": must match /^[a-z][a-z0-9-]{2,59}$/`
      );
    }
    if (!args.name.trim()) {
      throw new ToolUserError('name must not be blank for create action');
    }
  }
  if (action === 'update') {
    assertUnambiguousSettings(args);
    const hasField = Object.keys(args.settings ?? {}).length > 0 || AGENT_FIELDS.some(
      (f) => argValue(args, f.key) !== undefined
    );
    if (!hasField) {
      const names = AGENT_FIELDS.map((f) => f.key).join(', ');
      throw new ToolUserError(`update requires at least one of: ${names}`);
    }
  }
  // Copy every requested editable field onto the proposal, loop-driven off the
  // schema — a new field flows through without editing this block.
  const proposal: ManageAgentsProposal = { action, agent_id: args.agent_id };
  for (const field of AGENT_FIELDS) {
    const value = argValue(args, field.key);
    if (value !== undefined) {
      (proposal as unknown as Record<string, unknown>)[field.key] = value;
    }
  }
  if (args.action === 'update' && args.settings !== undefined) proposal.settings = args.settings;
  return proposal;
}

/**
 * Queue a manage_agents write for approval instead of running it. Writes a
 * pending `runs` row (run_type='internal', action_key='manage_agents') plus an
 * `interaction_type='approval'` event holding the proposed change AND the
 * current agent row (for the frontend diff). The mutation is applied later by
 * manage_operations' approve handler via {@link applyManageAgentsProposal}.
 */
async function queueWriteForApproval(
  args: WriteArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  const proposal = buildProposal(args);
  // create needs an owner to attribute the new agent to — fail at request time
  // rather than after the human approves an unattributable create.
  if (proposal.action === 'create' && !ctx.userId) {
    throw new ToolUserError(
      'create requires an authenticated caller to own the new agent'
    );
  }

  // Validate every requested editable field before queuing, so a bad value is
  // rejected at request time and an un-approvable card is never shown. Loop-
  // driven off the schema; reuses each field's validator.
  for (const field of AGENT_FIELDS) {
    const value = (proposal as unknown as Record<string, unknown>)[field.key] as
      | string
      | undefined;
    if (value !== undefined) await validateField(ctx, field, value);
  }

  const sql = getDb();
  const current = await fetchCurrentAgent(ctx.organizationId, proposal.agent_id, env);
  if (proposal.action === 'create' && current) {
    throw new ToolUserError(`Agent "${proposal.agent_id}" already exists`, 409);
  }
  if (proposal.action !== 'create' && !current) {
    throw new ToolUserError(`Agent "${proposal.agent_id}" not found`, 404);
  }

  if (proposal.action === 'update' && current) {
    await orgContext.run({ organizationId: ctx.organizationId }, () => sql.begin(async (tx) => {
      await lockOrganizationForRelationshipClaims(tx, ctx.organizationId);
      const [row] = await tx`SELECT name, description, identity_md FROM agents
        WHERE organization_id = ${ctx.organizationId} AND id = ${proposal.agent_id} FOR UPDATE`;
      if (!row) throw new ToolUserError(`Agent "${proposal.agent_id}" not found`, 404);
      const settings = (await createPostgresAgentConfigStore(tx).getSettings(proposal.agent_id))!;
      await assertSettingsValid(ctx, proposal.agent_id, { ...proposal.settings }, settings);
      const base: NonNullable<ManageAgentsProposal['base']> = {};
      for (const field of AGENT_FIELDS) {
        if (argValue(args, field.key) === undefined) continue;
        Object.assign(base, { [field.key]: field.meta.store === 'model'
          ? (settings.models?.[0] ?? null) : (row[field.key] ?? null) });
      }
      if (proposal.settings) {
        base.settings = {};
        for (const key of Object.keys(proposal.settings) as Array<keyof typeof proposal.settings>) {
          Object.assign(base.settings, { [key]: settings[key] ?? null });
        }
      }
      proposal.base = base;
      Object.assign(current, row, { settings });
    }));
  }

  const initiatorColumns = resolveRunInitiator(ctx);
  const label = actionLabel(proposal.action, proposal.agent_id);
  // Atomic: the pending run and its approval card commit together. If the card
  // INSERT fails, the run must not exist — otherwise the proposal is durably
  // pending but the events-only approval surface shows nothing (the #2033
  // divergence, same as the connector queue path).
  const { runId, eventId } = await sql.begin(async (tx) => {
    const inserted = await tx`
      INSERT INTO runs (
        organization_id, run_type, action_key, action_input,
        created_by_user_id, initiator_kind, initiator_ref,
        approval_status, status, created_at
      ) VALUES (
        ${ctx.organizationId}, 'internal', ${MANAGE_AGENTS_ACTION_KEY},
        ${tx.json(proposal as unknown as Record<string, unknown>)},
        ${initiatorColumns.createdByUserId},
        ${initiatorColumns.initiatorKind},
        ${tx.json(initiatorColumns.initiatorRef)},
        'pending', 'pending', current_timestamp
      )
      RETURNING id
    `;
    const runId = Number((inserted[0] as { id: unknown }).id);

    const event = await insertEvent(
      {
        entityIds: [],
        organizationId: ctx.organizationId,
        originId: `run_${runId}_pending`,
        title: `${label} — pending approval`,
        content: `Builder requested: ${label}`,
        semanticType: 'operation',
        runId,
        interactionType: 'approval',
        interactionStatus: 'pending',
        interactionInput: proposal as unknown as Record<string, unknown>,
        metadata: {
          ...approvalContext(
            ApprovalKind.Agent,
            proposal.action === 'delete'
              ? highApprovalImpact('This permanently deletes the agent and its configuration.')
              : normalApprovalImpact()
          ),
          tool: 'manage_agents',
          action_key: MANAGE_AGENTS_ACTION_KEY,
          action: proposal.action,
          agent_id: proposal.agent_id,
          proposal,
          current: current ?? null,
          initiator: {
            kind: initiatorColumns.initiatorKind,
            ...initiatorColumns.initiatorRef,
          },
          status: 'pending_approval',
          ...currentMcpActivityEventMetadata(ctx),
        },
        authorName: ctx.clientId ?? 'agent',
        clientId: eventClientId(ctx),
      },
      { sql: tx },
    );
    return { runId, eventId: Number(event.id) };
  });

  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  // An `update` proposal is config-shaped (name/description/identity), so its
  // review surface is the agent settings form prefilled via `?run_id=` (WI-0.3):
  // the reviewer sees the proposed change in the real form and Approves/Rejects.
  // Settings patches include fields the identity form cannot render, so they
  // use the full run review too. create/delete keep the run permalink
  // (a run-scoped link that survives the supersede chain on approve→complete;
  // read-side content_ids resolution also covers the event id carried below).
  const settingsReviewUrl =
    proposal.action === 'update' && !proposal.settings
      ? await buildAgentSettingsUrl(baseUrl, ctx.organizationId, proposal.agent_id, {
          runId,
        }).catch(() => null)
      : null;
  const approvalUrl =
    settingsReviewUrl ??
    buildResourcePermalink(ownerSlug, { kind: 'run', runId }, baseUrl);

  // One destination, never the org-wide fan-out — see resolveApprovalChatOrigin.
  const chatOrigin = await resolveApprovalChatOrigin(ctx);
  const actionOrigin = await resolveActionOrigin(ctx);
  notifyActionApprovalNeeded({
    orgId: ctx.organizationId,
    runId,
    actionKey: MANAGE_AGENTS_ACTION_KEY,
    connectionName: label,
    eventId,
    approvalUrl,
    connectionId: chatOrigin.connectionId,
    channelId: chatOrigin.channelId,
    teamId: chatOrigin.teamId,
    requesterUserId: ctx.userId ?? null,
    mcpActivity: currentMcpActivityAttribution(ctx),
    actionOrigin,
  }).catch((error) =>
    logger.error(error, 'Failed to send manage_agents approval notification')
  );

  return {
    action: proposal.action,
    run_id: runId,
    event_id: eventId,
    status: 'pending_approval',
    // An interactive approval card (change details + Approve/Reject buttons) is
    // rendered into the chat from this result — so instruct the model to stay
    // terse and NOT restate the change or paste a link. Narrating a Markdown
    // "Approval Link" duplicates the card and leaves a dead link once resolved.
    message: `${label} is queued for approval. A confirmation card with the change details and Approve/Reject buttons is now shown to the user in the chat — reply with at most one short sentence and do NOT restate the change or include an approval link.`,
    proposal,
    current,
  };
}

/**
 * Apply a previously-queued manage_agents proposal. Called by
 * manage_operations' approve handler once a human confirms. Maps the held
 * proposal back onto the real apply* handler. `ownerUserId` is the original
 * requester (persisted on the run), so an approving admin doesn't become the
 * created agent's owner.
 */
export async function applyManageAgentsProposal(
  proposal: ManageAgentsProposal,
  ctx: ToolContext,
  env: Env,
  ownerUserId: string | null
): Promise<ManageAgentsResult> {
  // Rebuild the action's args from the proposal, loop-driven off the schema so
  // an added field flows back through without editing this remap. The proposal
  // is a persisted row (`runs.action_input`), so it is re-validated against the
  // action's variant rather than trusted as typed input.
  const fields: Record<string, unknown> = {
    action: proposal.action,
    agent_id: proposal.agent_id,
  };
  for (const field of AGENT_FIELDS) {
    const value = (proposal as unknown as Record<string, unknown>)[field.key];
    if (value !== undefined) fields[field.key] = value;
  }
  if (proposal.action === 'update' && proposal.settings !== undefined) fields.settings = proposal.settings;
  const args = validateToolArgs('manage_agents', WriteActions, fields) as WriteArgs;
  // Re-run the rules the schema cannot express (agent_id shape, "update needs
  // one field"); the rebuilt proposal itself is discarded — `proposal` is what
  // the apply* handlers already carry.
  buildProposal(args);
  // create attributes ownership to the ORIGINAL requester, not the approver.
  const applyCtx: ToolContext =
    args.action === 'create' ? { ...ctx, userId: ownerUserId } : ctx;
  switch (args.action) {
    case 'create':
      return applyCreate(args, applyCtx, env);
    case 'update':
      // Queued apply: require a pre-image per field. A legacy pending run with no
      // `base` thus skips (never blind-overwrites a newer human edit) — fail closed.
      return applyUpdate(args, applyCtx, env, proposal.base, true);
    case 'delete':
      return applyDelete(args, applyCtx, env);
  }
}

// ============================================
// Main Function
// ============================================

type Handler<A> = (args: A, ctx: ToolContext, env: Env) => Promise<ManageAgentsResult>;

/** Run the org-level access check for the action's tier before its handler. */
function orgGated<A>(
  requireAccess: (sql: DbClient, ctx: ToolContext) => Promise<void>,
  handler: Handler<A>
): Handler<A> {
  return async (args, ctx, env) => {
    await requireAccess(createDbClientFromEnv(env), ctx);
    return handler(args, ctx, env);
  };
}

/**
 * Route one agent write through the `agent_config` write-gate class. The policy
 * decides per (principal, action): a human member applies immediately, an
 * agent/automation-driven write follows the org's policy (default: create/update
 * queue an approval, delete is denied). `require_approval` → queue a pending run
 * + card; `allow` → run the apply* handler now; `deny` → refuse.
 */
async function dispatchAgentWrite(
  args: WriteArgs,
  ctx: ToolContext,
  env: Env
): Promise<ManageAgentsResult> {
  const { action } = args;
  // Resolve identity through the shared seam so an automation reaction (which sets
  // ctx.actingAutomationId but no agentId) binds its owning agent's `agent_config`
  // envelope — otherwise it would gate as a null-id agent and skip the owner's
  // approval/deny override. manage_agents has no automation_source arg, so only the
  // trusted session rules apply.
  const actor = await actingPrincipalFor(ctx);
  // update/delete name the target agent; create has no target (blanket only).
  const targetAgentId = action === 'create' ? null : args.agent_id.trim() || null;
  const decision = await resolveWritePolicyDecision({
    organizationId: ctx.organizationId,
    resourceClass: 'agent_config',
    principalKind: actor.kind,
    principalId: actor.id,
    ownerAgentId: actor.ownerAgentId,
    ownerResolved: actor.ownerResolved,
    action,
    targetAgentId,
  });
  if (decision === 'deny') {
    throw new ToolUserError(
      `Policy denies ${action} of agents for this principal.`,
      403
    );
  }
  if (decision === 'require_approval') {
    return queueWriteForApproval(args, ctx, env);
  }
  // allow → apply immediately (validate the proposal first so an immediate apply
  // enforces the same required-field checks the queued path does).
  buildProposal(args);
  switch (args.action) {
    case 'create':
      return applyCreate(args, ctx, env);
    case 'update':
      return applyUpdate(args, ctx, env);
    case 'delete':
      return applyDelete(args, ctx, env);
  }
}

// list/get are org-read and honor agent_config `read` for agent/automation
// principals; create/update/delete are org-write and consult the agent_config
// write-gate (human immediate; agent/automation may queue approval).
const manageAgentsTool = defineActionTool('manage_agents', {
  list: action(ListAgentsAction, orgGated(requireOrgReadAccess, handleList)),
  get: action(GetAgentAction, orgGated(requireOrgReadAccess, handleGet)),
  create: action(CreateAgentAction, orgGated(requireOrgWriteAccess, dispatchAgentWrite)),
  update: action(UpdateAgentAction, orgGated(requireOrgWriteAccess, dispatchAgentWrite)),
  delete: action(DeleteAgentAction, orgGated(requireOrgWriteAccess, dispatchAgentWrite)),
});

export const manageAgents = manageAgentsTool.run;
