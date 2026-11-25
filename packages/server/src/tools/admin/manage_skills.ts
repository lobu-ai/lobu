/**
 * Tool: manage_skills
 *
 * The workspace skill library.
 *
 * - list: the library, ordered by (sort_order, name), keyset-paginated
 * - get: one skill by id, or an unarchived skill by name
 * - put: create a skill (no id, expected_revision 0) or replace one by id at
 *   its current revision (compare-and-swap; a stale revision is a 409)
 * - archive: archive a skill at its current revision
 * - install_from_catalog: add a catalog skill with provenance = its catalog id
 *
 * Reads are org-read and honor the `skill_config` `read` policy for agent,
 * Automation and app principals. Writes are owner/admin and go through the
 * `skill_config` write policy: create (put without id, catalog installs),
 * update (put with id) and delete (archive). A human applies immediately; an
 * agent or Automation applies, queues a human approval, or is refused (403).
 */

import { deriveSkillDescription } from '@lobu/core/agent-tooling';
import {
  ArchiveSkillAction,
  GetSkillAction,
  InstallSkillFromCatalogAction,
  ListSkillsAction,
  ManageSkillsResultSchema,
  ManageSkillsSchema,
  PutSkillAction,
  SKILLS_LIST_DEFAULT_LIMIT,
  type ManageSkillsArgs,
  type ManageSkillsResult,
  type WorkspaceSkill,
} from '@lobu/core/contracts/tools/manage-skills';
import { eventClientId } from '../../auth/event-client-id';
import {
  type ActingPrincipal,
  resolveActingPrincipal,
  resolveStoredActingPrincipal,
  resolveWritePolicyDecision,
} from '../../authz/entity-policy';
import { assertSkillConfigReadAllowed, skillConfigReadAllowed } from '../../authz/skill-config-access';
import { listCatalogEntries } from '../../catalog/load';
import { createDbClientFromEnv, type DbClient, getDb, pgBigintArray } from '../../db/client';
import type { Env } from '../../index';
import {
  currentMcpActivityAttribution,
  currentMcpActivityEventMetadata,
} from '../../lobu/stores/mcp-client-conversations';
import { resolveActionOrigin } from '../../notifications/action-origin';
import { notifyActionApprovalNeeded } from '../../notifications/triggers';
import {
  applySkillWrite,
  checkSkillWrite,
  getWorkspaceSkill,
  listWorkspaceSkills,
  normalizeSkillInput,
  type SkillBody,
  type SkillWrite,
} from '../../skills/workspace-skills';
import { ApprovalKind, approvalContext, normalApprovalImpact } from '../../utils/approval-context';
import { redactConfigState } from '../../utils/config-redaction';
import { ToolUserError } from '../../utils/errors';
import { insertEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import { requireOrgReadAccess, requireOrgWriteAccess } from '../../utils/organization-access';
import { lockOrganizationForRelationshipClaims } from '../../utils/relationship-claims';
import { buildResourcePermalink } from '../../utils/url-builder';
import { resolveRunInitiator } from '../initiator';
import type { ToolContext } from '../registry';
import { getOrgUrlContext } from '../view-urls';
import { action, defineActionTool } from './action-tool';
import { resolveApprovalChatOrigin } from './approval-delivery';
import { insertToolConfigChange } from './helpers/config-audit';

export { ManageSkillsResultSchema, ManageSkillsSchema };

/** `runs.action_key` of a skill write held for approval. */
export const MANAGE_SKILLS_ACTION_KEY = 'manage_skills';

type WriteArgs = Extract<ManageSkillsArgs, { action: 'put' | 'archive' | 'install_from_catalog' }>;
type PolicyAction = 'create' | 'update' | 'delete';

/** A held skill write (`runs.action_input`), re-checked when a human approves it. */
export interface ManageSkillsProposal {
  action: WriteArgs['action'];
  policy_action: PolicyAction;
  policy_principal_kind: ActingPrincipal['kind'];
  policy_principal_id: string | null;
  write: SkillWrite;
}

export function isManageSkillsProposal(value: unknown): value is ManageSkillsProposal {
  if (!value || typeof value !== 'object') return false;
  const proposal = value as Partial<ManageSkillsProposal>;
  const write = proposal.write as Partial<SkillWrite> | undefined;
  return (
    (proposal.action === 'put' || proposal.action === 'archive' || proposal.action === 'install_from_catalog') &&
    (proposal.policy_action === 'create' || proposal.policy_action === 'update' || proposal.policy_action === 'delete') &&
    typeof proposal.policy_principal_kind === 'string' &&
    !!write &&
    (write.op === 'create' || write.op === 'update' || write.op === 'archive') &&
    typeof write.expected_revision === 'number' &&
    (write.op === 'archive' ? write.skill === null : !!write.skill && typeof write.skill === 'object')
  );
}

export function describeManageSkillsProposal(proposal: ManageSkillsProposal): string {
  const target = proposal.write.skill?.name ?? proposal.write.id ?? 'skill';
  if (proposal.action === 'install_from_catalog') return `install ${target}`;
  if (proposal.action === 'archive') return `archive ${target}`;
  return `${proposal.write.op === 'create' ? 'create' : 'update'} ${target}`;
}

const POLICY_ACTION: Record<SkillWrite['op'], PolicyAction> = {
  create: 'create',
  update: 'update',
  archive: 'delete',
};

/** Turn the tool arguments into one library write; 404/422 before any policy check. */
async function prepareSkillWrite(args: WriteArgs): Promise<SkillWrite> {
  if (args.action === 'archive') {
    return { op: 'archive', id: args.id, expected_revision: args.expected_revision, skill: null };
  }
  if (args.action === 'install_from_catalog') {
    const entry = (await listCatalogEntries(['skills'])).skills.find((candidate) => candidate.id === args.catalog_id);
    if (!entry) throw new ToolUserError(`Catalog skill "${args.catalog_id}" not found`, 404);
    const content = typeof entry.detail.content === 'string' ? entry.detail.content : '';
    const description = entry.description?.trim() || deriveSkillDescription(content) || entry.name;
    const skill = normalizeSkillInput({
      name: entry.name,
      description,
      content,
      provenance: entry.id,
      ...(args.applies_to ? { applies_to: args.applies_to } : {}),
    });
    return { op: 'create', id: null, expected_revision: 0, skill };
  }
  const skill: SkillBody = normalizeSkillInput(args.skill);
  if (args.id === undefined) {
    if (args.expected_revision !== 0) {
      throw new ToolUserError('Creating a skill takes expected_revision 0; pass id to replace an existing skill.', 422);
    }
    return { op: 'create', id: null, expected_revision: 0, skill };
  }
  if (args.expected_revision === 0) {
    throw new ToolUserError('Replacing a skill takes its current revision; omit id to create one.', 422);
  }
  return { op: 'update', id: args.id, expected_revision: args.expected_revision, skill };
}

const AUDITED_FIELDS = ['description', 'content', 'provenance', 'applies_to', 'enabled', 'sort_order'] as const;

/** Apply one write and its config event in the caller's transaction. */
async function applyAndAudit(
  tx: DbClient,
  ctx: ToolContext,
  action: WriteArgs['action'],
  write: SkillWrite,
): Promise<WorkspaceSkill> {
  await lockOrganizationForRelationshipClaims(tx, ctx.organizationId);
  const { before, after, changed } = await applySkillWrite(tx, ctx.organizationId, write);
  if (!changed) return after;
  const op = write.op === 'create' ? 'created' : write.op === 'archive' ? 'deleted' : 'updated';
  const verb = write.op === 'archive' ? 'archived' : op;
  await insertToolConfigChange(
    ctx,
    {
      resourceKind: 'skill',
      resourceId: after.id,
      op,
      summary: `Skill '${after.name}' ${verb}`,
      state: write.op === 'archive' ? null : { ...after },
      before: before ? { ...before } : null,
      action,
      ...(before && write.op === 'update'
        ? {
            changedFields: AUDITED_FIELDS.filter(
              (field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null),
            ),
          }
        : {}),
    },
    tx,
  );
  return after;
}

/**
 * Route one library write through the `skill_config` policy: a human applies
 * now; an agent, Automation or app principal applies, queues a human approval,
 * or is refused.
 */
async function governSkillWrite(args: WriteArgs, ctx: ToolContext): Promise<ManageSkillsResult> {
  const write = await prepareSkillWrite(args);
  const sql = getDb();
  const actor = await resolveActingPrincipal(sql, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    appId: ctx.appPrincipalId,
    sessionAutomationId: ctx.actingAutomationId ?? null,
  });
  const policyAction = POLICY_ACTION[write.op];
  const decision =
    actor.kind === 'user'
      ? 'allow'
      : await resolveWritePolicyDecision({
          organizationId: ctx.organizationId,
          resourceClass: 'skill_config',
          principalKind: actor.kind,
          principalId: actor.id,
          ownerAgentId: actor.ownerAgentId,
          ownerResolved: actor.ownerResolved,
          action: policyAction,
        });
  if (decision === 'deny') {
    throw new ToolUserError(`Policy denies ${policyAction} of workspace skills for this principal.`, 403);
  }
  if (decision === 'allow') {
    return { skill: await sql.begin((tx) => applyAndAudit(tx, ctx, args.action, write)) };
  }
  return queueSkillWriteForApproval(
    {
      action: args.action,
      policy_action: policyAction,
      policy_principal_kind: actor.kind,
      policy_principal_id: actor.id,
      write,
    },
    ctx,
  );
}

/**
 * Hold a write for human approval: a pending `runs` row plus its approval
 * card, committed together. The write is checked first (existence, revision,
 * name) so a request that could never apply fails now, not after a review.
 */
async function queueSkillWriteForApproval(
  proposal: ManageSkillsProposal,
  ctx: ToolContext,
): Promise<ManageSkillsResult> {
  const sql = getDb();
  const initiator = resolveRunInitiator(ctx);
  const label = `Skill: ${describeManageSkillsProposal(proposal)}`;
  const { runId, eventId } = await sql.begin(async (tx) => {
    await lockOrganizationForRelationshipClaims(tx, ctx.organizationId);
    const current = await checkSkillWrite(tx, ctx.organizationId, proposal.write, { lock: false });
    const [run] = await tx`
      INSERT INTO runs (
        organization_id, run_type, action_key, action_input,
        created_by_user_id, initiator_kind, initiator_ref,
        policy_principal_kind, policy_principal_id,
        approval_status, status, created_at
      ) VALUES (
        ${ctx.organizationId}, 'internal', ${MANAGE_SKILLS_ACTION_KEY},
        ${tx.json(proposal as unknown as Record<string, unknown>)},
        ${initiator.createdByUserId},
        ${initiator.initiatorKind},
        ${tx.json(initiator.initiatorRef)},
        ${proposal.policy_principal_kind}, ${proposal.policy_principal_id},
        'pending', 'pending', current_timestamp
      )
      RETURNING id
    `;
    const runId = Number((run as { id: unknown }).id);
    const event = await insertEvent(
      {
        entityIds: [],
        organizationId: ctx.organizationId,
        originId: `run_${runId}_pending`,
        title: `${label} — pending approval`,
        content: `Requested: ${label}`,
        semanticType: 'operation',
        runId,
        interactionType: 'approval',
        interactionStatus: 'pending',
        interactionInput: skillProposalEventCopy(proposal) as Record<string, unknown>,
        metadata: {
          ...approvalContext(ApprovalKind.Approval, normalApprovalImpact()),
          tool: 'manage_skills',
          action_key: MANAGE_SKILLS_ACTION_KEY,
          action: proposal.action,
          policy_action: proposal.policy_action,
          proposal: skillProposalEventCopy(proposal),
          // The library's copy, digested like its audit rows: anyone who can
          // read this event may lack skill_config read.
          current: redactConfigState('skill', current ? { ...current } : null),
          initiator: { kind: initiator.initiatorKind, ...initiator.initiatorRef },
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
  const approvalUrl = buildResourcePermalink(ownerSlug, { kind: 'run', runId }, baseUrl);
  const chatOrigin = await resolveApprovalChatOrigin(ctx);
  const actionOrigin = await resolveActionOrigin(ctx);
  notifyActionApprovalNeeded({
    orgId: ctx.organizationId,
    runId,
    actionKey: MANAGE_SKILLS_ACTION_KEY,
    connectionName: label,
    eventId,
    approvalUrl,
    connectionId: chatOrigin.connectionId,
    channelId: chatOrigin.channelId,
    teamId: chatOrigin.teamId,
    requesterUserId: ctx.userId ?? null,
    mcpActivity: currentMcpActivityAttribution(ctx),
    actionOrigin,
  }).catch((error) => logger.error(error, 'Failed to send manage_skills approval notification'));

  return {
    status: 'pending_approval',
    run_id: runId,
    event_id: eventId,
    message: `${label} is queued for approval. Call get_approval with run_id ${runId} to show the confirmation card.`,
    proposal: proposal as unknown as Record<string, unknown>,
  };
}

/**
 * Apply a held write once a human approves it, in the approval transaction.
 * The original requester's principal is re-resolved and its policy re-read, so
 * a rule tightened to deny while the card waited still refuses; the write's
 * revision and name checks run again under the row lock.
 */
export async function applyManageSkillsProposal(
  proposal: ManageSkillsProposal,
  ctx: ToolContext,
  requesterUserId: string | null,
  db: DbClient,
): Promise<{ skill: Record<string, unknown> | null }> {
  if (!isManageSkillsProposal(proposal)) {
    throw new ToolUserError('Invalid manage_skills approval proposal', 400);
  }
  const principal = await resolveStoredActingPrincipal(
    db,
    ctx.organizationId,
    proposal.policy_principal_kind,
    proposal.policy_principal_id,
  );
  if (principal.kind !== 'user') {
    const decision = await resolveWritePolicyDecision({
      organizationId: ctx.organizationId,
      resourceClass: 'skill_config',
      principalKind: principal.kind,
      principalId: principal.id,
      ownerAgentId: principal.ownerAgentId,
      ownerResolved: principal.ownerResolved,
      action: proposal.policy_action,
      sql: db,
    });
    if (decision === 'deny') {
      throw new ToolUserError('The skill_config policy now denies this write.', 403);
    }
  }
  // The proposal is a stored row: re-validate its body rather than trust it.
  const skill = proposal.write.skill;
  const write: SkillWrite =
    skill === null
      ? proposal.write
      : ({
          ...proposal.write,
          skill: normalizeSkillInput({ ...skill, provenance: skill.provenance ?? undefined }),
        } as SkillWrite);
  const applyCtx: ToolContext = { ...ctx, userId: requesterUserId ?? ctx.userId };
  // The approval stores this output on its event: digest the body like the audit row.
  const applied = await applyAndAudit(db, applyCtx, proposal.action, write);
  return { skill: redactConfigState('skill', { ...applied }) };
}

/**
 * A held write as its event copies carry it: the skill body becomes its
 * digest, like the audit row. The full proposal stays in `runs.action_input`;
 * `revealSkillApprovalProposals` restores it for a reader the `skill_config`
 * read policy allows.
 */
export function skillProposalEventCopy(proposal: unknown): unknown {
  if (!isManageSkillsProposal(proposal) || !proposal.write.skill) return proposal;
  return { ...proposal, write: { ...proposal.write, skill: redactConfigState('skill', { ...proposal.write.skill }) } };
}

/** Whether this caller may see skill bodies: a workspace member the `skill_config` read policy allows. */
export async function mayReadSkillBodies(ctx: ToolContext): Promise<boolean> {
  return ctx.memberRole != null && skillConfigReadAllowed(ctx);
}

/** Restore the full proposal on skill approval events for a reader that may see skill bodies. */
export async function revealSkillApprovalProposals(
  sql: DbClient,
  ctx: ToolContext,
  items: Array<{ metadata: Record<string, unknown> | null; interaction_input?: Record<string, unknown> | null; run_id?: number | string | null }>,
): Promise<void> {
  const held = items.filter((item) => item.metadata?.action_key === MANAGE_SKILLS_ACTION_KEY && item.run_id != null);
  if (held.length === 0 || !(await mayReadSkillBodies(ctx))) return;
  const rows = await sql<{ id: string; action_input: unknown }>`
    SELECT id::text AS id, action_input FROM runs
    WHERE organization_id = ${ctx.organizationId} AND action_key = ${MANAGE_SKILLS_ACTION_KEY}
      AND id = ANY(${pgBigintArray(held.map((item) => Number(item.run_id)))}::bigint[])
  `;
  const proposals = new Map(rows.map((row) => [row.id, row.action_input]));
  for (const item of held) {
    const proposal = proposals.get(String(item.run_id));
    if (!isManageSkillsProposal(proposal)) continue;
    item.interaction_input = proposal as unknown as Record<string, unknown>;
    item.metadata = { ...item.metadata, proposal };
  }
}

const writeAction = (args: WriteArgs, ctx: ToolContext, env: Env) =>
  requireOrgWriteAccess(createDbClientFromEnv(env), ctx).then(() => governSkillWrite(args, ctx));

const manageSkillsTool = defineActionTool('manage_skills', {
  list: action(ListSkillsAction, async (args, ctx, env) => {
    const sql = createDbClientFromEnv(env);
    await requireOrgReadAccess(sql, ctx);
    await assertSkillConfigReadAllowed(ctx);
    return listWorkspaceSkills(sql, ctx.organizationId, {
      includeArchived: args.include_archived ?? false,
      cursor: args.cursor,
      limit: args.limit ?? SKILLS_LIST_DEFAULT_LIMIT,
    });
  }),
  get: action(GetSkillAction, async (args, ctx, env) => {
    const sql = createDbClientFromEnv(env);
    await requireOrgReadAccess(sql, ctx);
    await assertSkillConfigReadAllowed(ctx);
    if ((args.id === undefined) === (args.name === undefined)) {
      throw new ToolUserError('Pass exactly one of id or name.', 422);
    }
    const key = args.id !== undefined ? { id: args.id } : { name: args.name as string };
    return { skill: await getWorkspaceSkill(sql, ctx.organizationId, key) };
  }),
  put: action(PutSkillAction, writeAction),
  archive: action(ArchiveSkillAction, writeAction),
  install_from_catalog: action(InstallSkillFromCatalogAction, writeAction),
});

export const manageSkills = manageSkillsTool.run;
