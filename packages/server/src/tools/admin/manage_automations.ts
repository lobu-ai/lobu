/**
 * Tool: manage_automations
 *
 * Manage Automation definitions backed by the existing automation execution engine.
 *
 * Actions:
 * - create: Create automation with prompt/schema/sources directly
 * - update: Modify config (model, schedule, sources)
 * - create_version: Create a new version for an automation (prompt/schema/sources)
 * - create_from_version: Create a new automation from an existing version
 * - claim_next_window: Atomically lease expected work and return bounded context
 * - complete_window: Complete a window using window_token from read_knowledge
 * - trigger: Manually trigger an automation run
 * - delete: Remove automation
 * - set_reaction_script: Attach automated TypeScript reaction
 * - get_versions: View version history for an automation
 * - get_version_details: Get full config for a specific version
 * - get_component_reference: Get available components and data types documentation
 * - submit_feedback: Submit feedback on an Automation window
 * - get_feedback: Retrieve feedback for an Automation
 *
 * This file is the entry point only — action handlers live in ./manage_automations/.
 */

import { InteractionResourceKind } from '@lobu/core/contracts/interaction-envelope';
import {
  ListAutomationsResultSchema,
  ListAutomationsSchema,
  ManageAutomationsResultSchema,
  ManageAutomationsSchema,
  type ManageAutomationsArgs,
  type ManageAutomationsProposal,
  type ManageAutomationsResult,
} from '@lobu/core/contracts/tools/manage-automations';
import { resolveActingPrincipal, resolveWritePolicyDecision } from '../../authz/entity-policy';
import { createDbClientFromEnv, getDb, withSessionAdvisoryLock } from '../../db/client';
import type { Env } from '../../index';
import {
  currentMcpActivityAttribution,
  currentMcpActivityEventMetadata,
} from '../../lobu/stores/mcp-client-conversations';
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
import { buildResourcePermalink, buildAutomationSettingsUrl } from '../../utils/url-builder';
import { parsePositiveIntegerId, ToolUserError } from '../../utils/errors';
import {
  requireOrgReadAccess,
  requireOrgWriteAccess,
  requireReadAccess,
  requireWriteAccess,
} from '../../utils/organization-access';
import { assertAutomationInstructions } from '../../automations/triggers';
import { resolveRunInitiator } from '../initiator';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { getOrgUrlContext } from '../view-urls';
import { defineFlatActionTool, flatAction } from './action-tool';
import { requireAutomationAccess } from './manage_automations/shared';
import {
  handleCreate,
  handleUpdate,
  handleDelete,
  handleCreateFromVersion,
} from './manage_automations/crud';
import {
  handleCreateVersion,
  handleGetVersions,
  handleGetVersionDetails,
} from './manage_automations/version-actions';
import { handleCompleteWindow } from './manage_automations/complete-window';
import { handleClaimNextWindow } from './manage_automations/claim-next-window';
import { handleTrigger, handleSetReactionScript } from './manage_automations/trigger';
import {
  handleSubmitFeedback,
  handleGetFeedback,
  handleListPromoted,
} from './manage_automations/feedback';
import { handleGetComponentReference } from './manage_automations/reference';
import { handleList } from './manage_automations/list';

export {
  ListAutomationsResultSchema,
  ListAutomationsSchema,
  ManageAutomationsResultSchema,
  ManageAutomationsSchema,
};
export type { ManageAutomationsArgs, ManageAutomationsProposal, ManageAutomationsResult };

/**
 * Synthetic `runs.action_key` tagging a manage_automations write held for approval.
 * `manage_operations`' approve/reject handlers branch on this value to apply
 * (or cancel) the held mutation, reusing the same durable runs/events approval
 * primitive that manage_agents uses. These rows have run_type='internal'
 * (no connector / connection), so the operation lookup in the connector path is
 * skipped.
 */
export const MANAGE_AUTOMATIONS_ACTION_KEY = 'manage_automations';

// ============================================
// Main Function
// ============================================

export const manageAutomations = withValidatedArgs(
  'manage_automations',
  ManageAutomationsSchema,
  manageAutomationsImpl
);

async function manageAutomationsImpl(
  args: ManageAutomationsArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageAutomationsResult> {
  if (args.automation_id !== undefined) {
    parsePositiveIntegerId(args.automation_id, 'automation_id');
  }
  for (const automationId of args.automation_ids ?? []) {
    parsePositiveIntegerId(automationId, 'automation_ids');
  }

  const pgSql = createDbClientFromEnv(env);

  // Field-level `update` validation runs before any access check or write-gate
  // so the human-immediate and agent-approval paths reject identically (a
  // version-owned / no-op update can never queue or apply). See
  // {@link assertAutomationUpdateArgs} for the version-owned / entity_ids / status
  // rationale.
  if (args.action === 'update') {
    assertAutomationUpdateArgs(args);
  }

  // Validate organization access based on action type
  if (args.action === 'create') {
    if (args.entity_id) {
      await requireWriteAccess(pgSql, args.entity_id, ctx);
    } else {
      await requireOrgWriteAccess(pgSql, ctx);
    }
  } else if (args.action === 'list') {
    if (args.entity_id) {
      await requireReadAccess(pgSql, args.entity_id, ctx);
    } else {
      await requireOrgReadAccess(pgSql, ctx);
    }
  } else if (args.action === 'update' && args.automation_id) {
    await requireAutomationAccess(pgSql, [args.automation_id], ctx, 'write');
  } else if (args.action === 'trigger' && args.automation_id) {
    await requireAutomationAccess(pgSql, [args.automation_id], ctx, 'write');
  } else if (args.action === 'claim_next_window' && args.automation_id) {
    await requireAutomationAccess(pgSql, [args.automation_id], ctx, 'write');
  } else if (args.action === 'delete' && args.automation_ids && args.automation_ids.length > 0) {
    // delete alone allows missing ids to fall through to its per-id aggregate
    // ("not found or already archived"); every other action stays a hard 403.
    await requireAutomationAccess(pgSql, args.automation_ids, ctx, 'write', {
      allowMissing: true,
    });
  } else if (args.action === 'complete_window' && args.entity_id) {
    await requireWriteAccess(pgSql, args.entity_id, ctx);
  } else if (args.action === 'create_version' && args.automation_id) {
    await requireAutomationAccess(pgSql, [args.automation_id], ctx, 'write');
  } else if (args.action === 'set_reaction_script' && args.automation_id) {
    await requireAutomationAccess(pgSql, [args.automation_id], ctx, 'write');
  } else if (args.action === 'submit_feedback' && args.automation_id) {
    await requireAutomationAccess(pgSql, [args.automation_id], ctx, 'write');
  } else if (args.action === 'get_feedback' && args.automation_id) {
    await requireAutomationAccess(pgSql, [args.automation_id], ctx, 'read');
  } else if (args.action === 'list_promoted' && args.automation_id) {
    await requireAutomationAccess(pgSql, [args.automation_id], ctx, 'read');
  } else if (args.action === 'get_versions' && args.automation_id) {
    await requireAutomationAccess(pgSql, [args.automation_id], ctx, 'read');
  } else if (args.action === 'get_version_details' && args.automation_id) {
    await requireAutomationAccess(pgSql, [args.automation_id], ctx, 'read');
  } else if (args.action === 'create_from_version' && args.entity_ids) {
    for (const eid of args.entity_ids) {
      await requireWriteAccess(pgSql, eid, ctx);
    }
  }

  // Instruction-presence for create_version is enforced in handleCreateVersion
  // against the *final* resolved (triggers, prompt) pair — not here against
  // stored triggers + only an explicit prompt write. That incomplete pre-check
  // let event-turn → schedule transitions keep an empty prompt.

  // An automation IS agent config — it's an autonomous-execution definition (prompt,
  // SQL source, reaction). Gate its create/update/delete under the `agent_config`
  // write class, exactly like editing an agent. A human member applies immediately
  // (resolveWritePolicyDecision returns 'allow' for users); a non-human principal
  // follows the org policy (default: create/update need approval, delete denied).
  // This closes the two-step self-escalation: an agent whose own agent_config
  // writes require approval can no longer freely mint an automation to escape its
  // envelope.
  //
  // TOCTOU: gateAutomationWrite's escalation guard reads the affected automation owners
  // (resolveEffectiveAutomationOwners) and the mutation writes them, but on SEPARATE
  // pooled connections. A concurrent reassign of the target automation's managed_agent_id
  // could slip between the check and the write, so the guard would pass on owner A
  // while the write lands on a now-B-owned Automation. We serialize both the guard
  // AND the mutation under ONE session-level advisory lock keyed by the target's
  // automation_group_id. EVERY mutating action that has a resolvable target group
  // takes the lock — human or non-human — because the racing reassign is itself an
  // `update` that flows through this same path, so the lock makes them mutually
  // exclusive. Actions with no existing target group (`create`) skip the lock.
  //
  // `require_approval` queues a pending run + card (does NOT apply); `allow`
  // proceeds to the handler; `deny` / foreign-owner still throw.
  return withAutomationGroupLock(args, ctx, async () => {
    const gated = await gateAutomationWrite(args, ctx);
    if (gated) return gated;
    return runManageAutomations(args, env, ctx);
  });
}

/**
 * Namespace half of the (int, int) advisory-lock key. Pairs with the
 * automation_group_id so unrelated lock users never collide with a bare group id.
 * Distinct from the `automation_create_version` key version-actions.ts takes inside
 * its own handler — that's a different, tx-scoped lock; nesting two distinct
 * advisory keys is safe. This one is SESSION scope so it can span the guard read
 * and the mutation write, which run on different pooled connections.
 */
const AUTOMATION_GROUP_LOCK_NS = 'automation_group_ownership';

/**
 * Resolve the automation_group_id whose ownership this action touches — the row the
 * escalation guard reads and the mutation writes must not have its owner changed
 * underneath us. Returns null when there is no pre-existing group to race on:
 *   - `create` mints a brand-new row (no target yet).
 *   - `update` targets args.automation_id → its group.
 *   - `create_version` / `set_reaction_script` write GROUP-WIDE off args.automation_id.
 *   - `create_from_version` reads a SOURCE version → lock the source automation's group
 *     so a concurrent reassign of the source can't change the owner we clone.
 * All lookups are org-scoped.
 */
async function resolveTargetAutomationGroupId(
  args: ManageAutomationsArgs,
  ctx: ToolContext
): Promise<number | null> {
  const sql = getDb();
  if (
    args.action === 'update' ||
    args.action === 'create_version' ||
    args.action === 'set_reaction_script'
  ) {
    if (args.automation_id == null) return null;
    const rows = await sql<{ automation_group_id: number | null }>`
      SELECT automation_group_id FROM automations
      WHERE id = ${Number(args.automation_id)} AND organization_id = ${ctx.organizationId}
      LIMIT 1
    `;
    const gid = rows.length > 0 ? rows[0].automation_group_id : null;
    return gid == null ? null : Number(gid);
  }
  if (args.action === 'create_from_version') {
    if (args.version_id == null) return null;
    const rows = await sql<{ automation_group_id: number | null }>`
      SELECT w.automation_group_id
      FROM automation_versions wv JOIN automations w ON w.id = wv.automation_id
      WHERE wv.id = ${Number(args.version_id)} AND w.organization_id = ${ctx.organizationId}
      LIMIT 1
    `;
    const gid = rows.length > 0 ? rows[0].automation_group_id : null;
    return gid == null ? null : Number(gid);
  }
  return null;
}

/**
 * Run `fn` (guard + mutation) while holding a SESSION-level Postgres advisory
 * lock on the action's target automation_group_id. A session lock (vs. the
 * tx-scoped `pg_advisory_xact_lock`) is required because the guard read and the
 * mutation write happen on different pooled connections and across separate
 * transactions — a tx-scoped lock would release at the guard's implicit commit,
 * before the mutation runs. {@link withSessionAdvisoryLock} owns the reserved
 * lock-pool connection, the `lock_timeout` bound, and the release path.
 *
 * Only the mutating write-gate actions with a resolvable target group are locked;
 * read-only actions and `create` (no pre-existing group) run `fn` directly.
 */
async function withAutomationGroupLock<T>(
  args: ManageAutomationsArgs,
  ctx: ToolContext,
  fn: () => Promise<T>
): Promise<T> {
  if (automationWriteAction(args.action) === null) return fn();
  const groupId = await resolveTargetAutomationGroupId(args, ctx);
  if (groupId == null) return fn();

  return withSessionAdvisoryLock(
    { namespace: AUTOMATION_GROUP_LOCK_NS, value: groupId },
    fn,
    {
      // lock_timeout expiry (55P03): another holder kept the group busy past
      // the bound. We do NOT hold the lock — surface a clean retryable
      // conflict instead of an unbounded stall.
      onAcquireTimeout: () =>
        new ToolUserError(
          'Another change to this Automation group is in progress; retry shortly.',
          409
        ),
    }
  );
}

/** Maps a manage_automations action to its agent_config write verb, or null for a
 * read-only / non-definition action that the write-gate doesn't govern. */
function automationWriteAction(
  action: ManageAutomationsArgs['action']
): 'create' | 'update' | 'delete' | null {
  switch (action) {
    case 'create':
    case 'create_from_version':
      return 'create';
    case 'update':
    case 'create_version':
    case 'set_reaction_script':
      return 'update';
    case 'delete':
      return 'delete';
    default:
      // list/get/trigger/claim/complete/feedback etc. aren't definition writes.
      return null;
  }
}

/**
 * EVERY agent that ends up OWNING automation this write installs — resolved by what
 * each handler ACTUALLY persists, NOT the supplied `args.managed_agent_id` (several handlers
 * ignore it). The guard requires all of them to be the actor itself. Returns `[]`
 * when there's nothing to check.
 *
 *  - `create`: the supplied `args.managed_agent_id`, including an explicit null.
 *  - `create_from_version`: IGNORES args.managed_agent_id — the clone inherits the SOURCE
 *    version's automation.managed_agent_id.
 *  - `update`: an explicit args.managed_agent_id (including null) becomes the new owner;
 *    omission preserves the current owner.
 *  - `create_version` / `set_reaction_script`: IGNORE args.managed_agent_id and write
 *    GROUP-WIDE (WHERE automation_group_id = …) → EVERY owner in the target's group is
 *    affected; a mixed-owner group means A editing its assignment also rewrites B's
 *    prompt/reaction code. Validate ALL of them.
 *
 * All lookups are org-scoped so a caller can't probe another org.
 */
async function resolveEffectiveAutomationOwners(
  args: ManageAutomationsArgs,
  ctx: ToolContext
): Promise<Array<string | null>> {
  const sql = getDb();
  switch (args.action) {
    case 'create':
      // Explicitly preserve the ownerless state. Humans bypass this guard, but
      // a non-human principal must not be able to shed its policy ancestry by
      // creating an Automation with managed_agent_id: null.
      return [args.managed_agent_id ?? null];
    case 'create_from_version': {
      if (!args.version_id) return [];
      const rows = await sql<{ managed_agent_id: string | null }>`
        SELECT w.managed_agent_id
        FROM automation_versions wv JOIN automations w ON w.id = wv.automation_id
        WHERE wv.id = ${Number(args.version_id)} AND w.organization_id = ${ctx.organizationId}
        LIMIT 1
      `;
      return rows.length > 0 ? [rows[0].managed_agent_id ?? null] : [];
    }
    case 'update': {
      // `undefined` means ownership is unchanged; `null` is an explicit clear
      // and must be checked as the effective owner rather than treated as
      // omission. Otherwise an agent could drop its own policy ancestor.
      if (args.managed_agent_id !== undefined) return [args.managed_agent_id];
      if (args.automation_id == null) return [];
      const rows = await sql<{ managed_agent_id: string | null }>`
        SELECT managed_agent_id FROM automations
        WHERE id = ${Number(args.automation_id)} AND organization_id = ${ctx.organizationId}
        LIMIT 1
      `;
      return rows.length > 0 ? [rows[0].managed_agent_id ?? null] : [];
    }
    case 'create_version':
    case 'set_reaction_script': {
      if (args.automation_id == null) return [];
      // Group-wide: EVERY owner in the target automation's group is affected.
      const rows = await sql<{ managed_agent_id: string | null }>`
        SELECT DISTINCT managed_agent_id FROM automations
        WHERE organization_id = ${ctx.organizationId}
          AND automation_group_id = (
            SELECT automation_group_id FROM automations
            WHERE id = ${Number(args.automation_id)} AND organization_id = ${ctx.organizationId}
            LIMIT 1
          )
      `;
      return rows.map((r) => r.managed_agent_id ?? null);
    }
    default:
      return [];
  }
}

/** Human label for each gated action, used in card titles + notifications. */
function automationActionLabel(args: ManageAutomationsArgs): string {
  switch (args.action) {
    case 'create':
      return `Create Automation "${args.slug ?? args.name ?? 'new'}"`;
    case 'create_from_version':
      return `Create Automations from version ${args.version_id ?? '?'}`;
    case 'update':
      return `Update Automation ${args.automation_id ?? '?'}`;
    case 'create_version':
      return `Create version for Automation ${args.automation_id ?? '?'}`;
    case 'set_reaction_script':
      return `Set reaction script on Automation ${args.automation_id ?? '?'}`;
    case 'delete':
      return `Delete Automation(s) ${(args.automation_ids ?? []).join(', ') || '?'}`;
    default:
      return `Automation ${args.action}`;
  }
}

/**
 * Fetch a compact current automation row for the approval card diff. Returns null
 * when there is no single target (create / bulk delete / missing id).
 */
async function fetchCurrentAutomation(
  organizationId: string,
  args: ManageAutomationsArgs
): Promise<Record<string, unknown> | null> {
  if (args.automation_id == null) return null;
  const sql = getDb();
  const rows = await sql`
    SELECT id, slug, name, description, managed_agent_id, schedule, timezone, triggers,
           delivery_target, status
    FROM automations
    WHERE organization_id = ${organizationId} AND id = ${Number(args.automation_id)}
    LIMIT 1
  `;
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

/**
 * Build the proposed-change payload held on the run. Validates required fields
 * for the gated write so a malformed proposal is rejected at request time, not
 * at approve time.
 *
 * Automation definition writes have no per-field pre-image; the proposal is the
 * full original args for a straight re-run on approve (a stale approval may
 * clobber a newer edit — acceptable for launch). Acting principal is persisted
 * so apply can re-run the foreign-owner guard against the original actor.
 */
function buildAutomationProposal(
  args: ManageAutomationsArgs,
  acting: { actingAgentId: string | null; actingAutomationId: string | null }
): ManageAutomationsProposal {
  const writeAction = automationWriteAction(args.action);
  if (!writeAction) {
    throw new ToolUserError(`action "${args.action}" is not a gated Automation write`);
  }
  if (args.action === 'create') {
    if (!args.slug) throw new ToolUserError('slug is required for create action');
    // An event-turn Automation may omit all three instruction sources (built-in
    // default); every other shape needs a prompt, pinned skills, or a reaction
    // script.
    assertAutomationInstructions(
      args.triggers ?? [],
      args.prompt,
      args.skills,
      args.reaction_script,
      args.execution_config?.executor?.source,
    );
    if (!args.managed_agent_id) {
      throw new ToolUserError(
        'managed_agent_id is required to create an Automation (the agent that executes it).'
      );
    }
  }
  if (args.action === 'delete' && (!args.automation_ids || args.automation_ids.length === 0)) {
    throw new ToolUserError('automation_ids is required for delete action');
  }
  if (
    (args.action === 'create_version' || args.action === 'set_reaction_script') &&
    args.automation_id == null
  ) {
    throw new ToolUserError(`automation_id is required for ${args.action} action`);
  }
  if (args.action === 'set_reaction_script' && args.reaction_script === undefined) {
    // An omitted script silently REMOVES the existing reaction (handleSetReactionScript
    // treats missing as falsy). Require the field explicitly; an empty string is the
    // documented way to clear it.
    throw new ToolUserError(
      'reaction_script is required for set_reaction_script (pass an empty string to clear the existing script).'
    );
  }
  if (args.action === 'create_from_version') {
    if (args.version_id == null) {
      throw new ToolUserError('version_id is required for create_from_version action');
    }
    if (!args.entity_ids || args.entity_ids.length === 0) {
      throw new ToolUserError('entity_ids is required for create_from_version action');
    }
  }
  return {
    args,
    actingAgentId: acting.actingAgentId,
    actingAutomationId: acting.actingAutomationId,
  };
}

/**
 * Routing-only key rendered in the card title, not the field list. Everything
 * else present on the proposed args is a mutation input humans must be able to
 * review (reaction script, execution_config, explicit null clears, …).
 */
const AUTOMATION_APPROVAL_ROUTING_KEYS = new Set(['action']);

/** Display sentinel for an explicit null clear (field present, value null). */
const AUTOMATION_APPROVAL_CLEARED = '(cleared)';

/**
 * Fields `handleUpdate` actually patches — mirrors its `updatedFields.push`
 * list and the UPDATE SET clause in crud.ts exactly. Version-owned fields
 * (name/description/prompt/sources), `entity_ids` (create_from_version-only)
 * are intentionally ABSENT: `handleUpdate` writes
 * none of them, so an `update` carrying any used to pass validation and return
 * success with `updated_fields: []` — a silent no-op the caller believed
 * applied. {@link assertAutomationUpdateArgs} rejects them up front (before the
 * write-gate), so neither the human-immediate nor the agent-approval path can
 * queue or apply a version-owned change via `update`.
 */
const VERSION_OWNED_AUTOMATION_FIELDS = ['name', 'description', 'prompt', 'sources'] as const;

const AUTOMATION_PATCHABLE_FIELDS = [
  'model_config',
  'execution_config',
  // schedule/timezone are projections of triggers (resolveAutomationTriggerWrite);
  // patch them only via triggers, not as direct writable fields.
  'triggers',
  'managed_agent_id',
  'tags',
  'device_worker_id',
  'agent_kind',
  'delivery_target',
  'min_cooldown_seconds',
] as const;

/**
 * Validate `update` args before any access check or write-gate. Both the
 * human-immediate and the agent-approval paths flow through `manageAutomationsImpl`,
 * so calling this there makes a version-owned / no-op `update` reject
 * identically and never reach `handleUpdate` (which would otherwise return a
 * silent `updated_fields: []`).
 */
function assertAutomationUpdateArgs(args: ManageAutomationsArgs): void {
  if (args.automation_id == null) {
    throw new ToolUserError('automation_id is required for update action');
  }
  const present = (keys: readonly string[]): string[] =>
    keys.filter((k) => args[k as keyof ManageAutomationsArgs] !== undefined);
  const versionOwned = present(VERSION_OWNED_AUTOMATION_FIELDS);
  if (versionOwned.length > 0) {
    throw new ToolUserError(
      `update cannot change version-owned field(s) ${versionOwned.map((f) => `'${f}'`).join(', ')} — use action: 'create_version' to publish a new Automation version (name/description/prompt/sources inherit from the current version when omitted, and the persisted name cascades on set_as_current).`
    );
  }
  if (args.entity_ids !== undefined) {
    throw new ToolUserError(
      "update cannot change entity_ids — entity targeting is set at create / create_from_version. To re-target per entity, clone a version with action: 'create_from_version'."
    );
  }
  if (present(AUTOMATION_PATCHABLE_FIELDS).length === 0) {
    throw new ToolUserError(
      "update changes runtime config only (e.g. triggers, managed_agent_id, tags, model_config) and needs at least one such field. It cannot change status — an Automation is retired via action: 'delete' (→ archived); name/description/prompt/sources are version-owned (action: 'create_version')."
    );
  }
}

/**
 * Flat automation mutation fields for the events-tab ActionApprovalCard fallback.
 * Includes every proposed arg that is present (including explicit `null`
 * clears); only `action` is omitted (shown in the title). Absent fields
 * (`undefined`) are excluded so the card does not invent values.
 */
function pickAutomationApprovalDisplayFields(args: ManageAutomationsArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (AUTOMATION_APPROVAL_ROUTING_KEYS.has(key)) continue;
    if (value === undefined) continue;
    // Explicit null = clear (e.g. schedule: null). Render as a visible sentinel
    // so the card can show the clear rather than dropping the field.
    if (value === null) {
      out[key] = AUTOMATION_APPROVAL_CLEARED;
      continue;
    }
    if (Array.isArray(value)) {
      // Primitive arrays (automation_ids, entity_ids, tags) collapse to a readable
      // list; object arrays (sources) serialize to JSON so the schema's string
      // field renders the actual structure, not "[object Object]".
      out[key] = value.every(
        (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
      )
        ? value.join(', ')
        : JSON.stringify(value);
      continue;
    }
    // Structured objects (execution_config, model_config) serialize to JSON for
    // the same reason — the approval card field is a readOnly string.
    if (typeof value === 'object') {
      out[key] = JSON.stringify(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Human-readable titles for common Automation approval fields. */
const AUTOMATION_APPROVAL_FIELD_TITLES: Record<string, string> = {
  slug: 'Slug',
  name: 'Name',
  description: 'Description',
  prompt: 'Prompt',
  schedule: 'Schedule',
  triggers: 'Triggers',
  timezone: 'Timezone',
  managed_agent_id: 'Agent',
  automation_id: 'Automation ID',
  automation_ids: 'Automation IDs',
  version_id: 'Version ID',
  entity_id: 'Entity ID',
  entity_ids: 'Entity IDs',
  reaction_script: 'Reaction script',
  execution_config: 'Execution config',
  device_worker_id: 'Device worker',
  agent_kind: 'Agent kind',
  sources: 'Sources',
  model_config: 'Model config',
  outputs: 'Outputs',
  classifiers: 'Classifiers',
  tags: 'Tags',
  change_notes: 'Change notes',
  set_as_current: 'Set as current',
  reactions_guidance: 'Reactions guidance',
  delivery_target: 'Delivery channel',
  min_cooldown_seconds: 'Min cooldown (seconds)',
  name_pattern: 'Name pattern',
};

function buildAutomationApprovalInputSchema(fields: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const baseTitle = AUTOMATION_APPROVAL_FIELD_TITLES[key] ?? key;
    const title = value === AUTOMATION_APPROVAL_CLEARED ? `${baseTitle} (cleared)` : baseTitle;
    // Every field is readOnly: the automation approval card is a review-and-decide
    // surface, not an editor. The apply path always executes the ORIGINAL
    // proposal.args, so an editable field would silently discard the reviewer's
    // change. readOnly makes the form render the proposed value as inspectable
    // text without pretending it can be edited.
    const base = { title, readOnly: true } as const;
    // Structured values (execution_config, model_config, sources, arrays of
    // objects) have no nested schema, so the generic form would coerce them to
    // "[object Object]". Serialize to a JSON string so the reviewer sees the
    // actual proposed configuration.
    if (typeof value === 'object' && value !== null) {
      properties[key] = { ...base, type: 'string' };
      continue;
    }
    if (typeof value === 'number') {
      properties[key] = { ...base, type: 'number' };
      continue;
    }
    if (typeof value === 'boolean') {
      properties[key] = { ...base, type: 'boolean' };
      continue;
    }
    properties[key] = { ...base, type: 'string' };
  }
  return { type: 'object', properties };
}

/**
 * Queue a manage_automations write for approval instead of running it. Writes a
 * pending `runs` row (run_type='internal', action_key='manage_automations') plus an
 * `interaction_type='approval'` event holding the proposed args. The mutation is
 * applied later by manage_operations' approve handler via
 * {@link applyManageAutomationsProposal}.
 *
 * `acting` is the principal resolved at gate time (same seam as the foreign-
 * owner check) and is persisted on the proposal so apply can re-validate.
 */
async function queueAutomationWriteForApproval(
  args: ManageAutomationsArgs,
  ctx: ToolContext,
  acting: { actingAgentId: string | null; actingAutomationId: string | null }
): Promise<ManageAutomationsResult> {
  const proposal = buildAutomationProposal(args, acting);
  const writeAction = automationWriteAction(args.action)!;

  // create attributes ownership via created_by — fail at request time rather
  // than after the human approves an unattributable create.
  if (writeAction === 'create' && !ctx.userId) {
    throw new ToolUserError('create requires an authenticated caller to own the new Automation');
  }

  const current = await fetchCurrentAutomation(ctx.organizationId, args);
  if (args.action === 'update' && !current) {
    throw new ToolUserError(`Automation "${args.automation_id}" not found`, 404);
  }

  const sql = getDb();
  const initiatorColumns = resolveRunInitiator(ctx);
  const label = automationActionLabel(args);
  // Flat display fields for the events-tab fallback card (ActionApprovalCard
  // only renders input when interactionInputSchema is present). Keep the
  // nested proposal in metadata for the apply path / history replay.
  const displayInput = pickAutomationApprovalDisplayFields(args);
  const inputSchema = buildAutomationApprovalInputSchema(displayInput);
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
        ${ctx.organizationId}, 'internal', ${MANAGE_AUTOMATIONS_ACTION_KEY},
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
        entityIds: args.entity_id != null ? [args.entity_id] : [],
        organizationId: ctx.organizationId,
        originId: `run_${runId}_pending`,
        title: `${label} — pending approval`,
        content: `Builder requested: ${label}`,
        semanticType: 'operation',
        runId,
        interactionType: 'approval',
        interactionStatus: 'pending',
        interactionInputSchema: inputSchema,
        interactionInput: displayInput,
        metadata: {
          ...approvalContext(
            ApprovalKind.Automation,
            args.action === 'delete'
              ? highApprovalImpact('This archives the Automation and stops future runs.')
              : normalApprovalImpact()
          ),
          tool: 'manage_automations',
          action_key: MANAGE_AUTOMATIONS_ACTION_KEY,
          action: args.action,
          resourceKind: InteractionResourceKind.Automation,
          automation_id: args.automation_id ?? null,
          proposal,
          current: current ?? null,
          initiator: {
            kind: initiatorColumns.initiatorKind,
            ...initiatorColumns.initiatorRef,
          },
          status: 'pending_approval',
          input_schema: inputSchema,
          action_input: displayInput,
          ...currentMcpActivityEventMetadata(ctx),
        },
        authorName: ctx.clientId ?? 'agent',
        clientId: ctx.tokenType === 'oauth' ? (ctx.clientId ?? null) : null,
      },
      { sql: tx },
    );
    return { runId, eventId: Number(event.id) };
  });

  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  // An `update` is config-shaped, so its review surface is the automation edit form
  // prefilled via `?run_id=` (WI-0.3, automation parity with manage_agents): the
  // reviewer sees the proposed change in the real form and Approves/Rejects.
  // The route is the workspace-level Automations section (agent-owned and
  // agentless alike). create / create_from_version / set_reaction_script etc.
  // aren't a single-form review, so they keep the run permalink (valid across
  // the supersede chain on approve).
  const settingsReviewUrl =
    args.action === 'update' && args.automation_id != null
      ? await buildAutomationSettingsUrl(baseUrl, ctx.organizationId, args.automation_id, {
          runId,
        }).catch(() => null)
      : null;
  const approvalUrl =
    settingsReviewUrl ?? buildResourcePermalink(ownerSlug, { kind: 'run', runId }, baseUrl);

  // One destination, never the org-wide fan-out — see resolveApprovalChatOrigin.
  const chatOrigin = await resolveApprovalChatOrigin(ctx);
  const actionOrigin = await resolveActionOrigin(ctx);
  notifyActionApprovalNeeded({
    orgId: ctx.organizationId,
    runId,
    actionKey: MANAGE_AUTOMATIONS_ACTION_KEY,
    connectionName: label,
    eventId,
    approvalUrl,
    connectionId: chatOrigin.connectionId,
    channelId: chatOrigin.channelId,
    teamId: chatOrigin.teamId,
    requesterUserId: ctx.userId ?? null,
    mcpActivity: currentMcpActivityAttribution(ctx),
    actionOrigin,
  }).catch((error) => logger.error(error, 'Failed to send manage_automations approval notification'));

  return {
    action: args.action as
      | 'create'
      | 'update'
      | 'create_version'
      | 'create_from_version'
      | 'set_reaction_script'
      | 'delete',
    run_id: runId,
    event_id: eventId,
    status: 'pending_approval',
    // An interactive approval card (change details + Approve/Reject buttons) is
    // rendered into the chat from this result — so instruct the model to stay
    // terse and NOT restate the change or paste a link.
    message: `${label} is queued for approval. A confirmation card with the change details and Approve/Reject buttons is now shown to the user in the chat — reply with at most one short sentence and do NOT restate the change or include an approval link.`,
    proposal,
    current,
  };
}

/**
 * Foreign-owner escalation guard shared by the request-time gate and the
 * approve-time apply path. Every effective owner the write would install must
 * equal `actingAgentId`. Pass null to skip (humans are ungoverned here — same
 * as the gate's `actor.kind === 'user'` branch). Throws ToolUserError 403.
 *
 * Uses {@link resolveEffectiveAutomationOwners} so the check matches what each
 * handler actually persists (not the supplied args.managed_agent_id alone).
 */
async function assertAutomationOwnersMatchActingAgent(
  args: ManageAutomationsArgs,
  ctx: ToolContext,
  actingAgentId: string | null,
  actorKind: string = 'agent'
): Promise<void> {
  if (actingAgentId == null) return;
  const owners = await resolveEffectiveAutomationOwners(args, ctx);
  const foreign = owners.find((o) => o !== actingAgentId);
  if (foreign !== undefined) {
    throw new ToolUserError(
      `A ${actorKind} cannot install an Automation owned by another agent — every affected owner must be itself (${actingAgentId}); found ${foreign ?? 'none'}.`,
      403
    );
  }
}

/**
 * Apply a previously-queued manage_automations proposal. Called by
 * manage_operations' approve handler once a human confirms. Re-runs the original
 * write handler with the held args. `ownerUserId` is the original requester
 * (persisted on the run), so an approving admin doesn't become the created
 * automation's `created_by`.
 *
 * Re-takes the automation-group advisory lock and re-runs the foreign-owner guard
 * against the PERSISTED acting agent (not the approver). If ownership changed
 * between queue and approve (e.g. group reassigned to another agent), the apply
 * fails closed — the approve handler supersedes the card to 'failed'.
 *
 * Automation definition writes have no per-field pre-image; this is a straight
 * re-run — a stale approval may clobber a newer edit (acceptable for launch)
 * when ownership is still valid.
 */
export async function applyManageAutomationsProposal(
  proposal: ManageAutomationsProposal,
  ctx: ToolContext,
  env: Env,
  ownerUserId: string | null
): Promise<ManageAutomationsResult> {
  const args = proposal.args;
  const writeAction = automationWriteAction(args.action);
  // create attributes ownership to the ORIGINAL requester, not the approver.
  const applyCtx: ToolContext = writeAction === 'create' ? { ...ctx, userId: ownerUserId } : ctx;
  // Lock + re-gate under the same session advisory lock as the request path so
  // a concurrent reassign can't slip between the ownership re-check and the write.
  return withAutomationGroupLock(args, applyCtx, async () => {
    // Humans leave actingAgentId null — skip, matching the gate.
    await assertAutomationOwnersMatchActingAgent(
      args,
      applyCtx,
      proposal.actingAgentId ?? null,
      'agent'
    );
    // Re-run the CURRENT write-gate before applying: policy may have flipped to
    // `deny` (or the acting principal may have been deleted) while the approval
    // sat pending. Fail closed rather than execute a now-denied proposal — the
    // approve handler supersedes the card to 'failed'. Humans (null actingAgentId)
    // are ungoverned here, matching the request-path gate.
    if (proposal.actingAgentId != null) {
      const writeGateAction = automationWriteAction(args.action);
      if (writeGateAction) {
        const decision = await resolveWritePolicyDecision({
          organizationId: applyCtx.organizationId,
          resourceClass: 'agent_config',
          principalKind: 'agent',
          principalId: proposal.actingAgentId,
          ownerAgentId: proposal.actingAgentId,
          ownerResolved: true,
          action: writeGateAction,
        });
        // Only `deny` blocks the apply: this run IS the approval, so a
        // `require_approval` decision is already satisfied and must not re-block.
        if (decision === 'deny') {
          throw new ToolUserError(
            `Policy now denies ${writeGateAction} of Automations for this principal; the approved change was not applied.`,
            403
          );
        }
      }
    }
    // The approval path already established the human's authority. Dispatch
    // directly so this server-side continuation does not re-enter routeAction's
    // fresh-call mcp:admin gate; resolve_approval intentionally requires only
    // mcp:write.
    switch (args.action) {
      case 'create':
        return handleCreate(args, env, applyCtx);
      case 'update':
        return handleUpdate(args, env, applyCtx);
      case 'create_version':
        return handleCreateVersion(args, env, applyCtx);
      case 'create_from_version':
        return handleCreateFromVersion(args, env, applyCtx);
      case 'set_reaction_script':
        return handleSetReactionScript(args, env, applyCtx);
      case 'delete':
        return handleDelete(args, applyCtx);
      default:
        // Only write actions queue (automationWriteAction gates the queue path);
        // a held proposal with any other action is corrupt — fail the apply.
        throw new ToolUserError(
          `Queued manage_automations proposal holds a non-write action: ${args.action}`
        );
    }
  });
}

/**
 * Enforce the `agent_config` write-gate for an automation definition write. No-op for
 * read-only actions and for human members (whose decision is always 'allow').
 * Returns a pending_approval result when the policy requires approval (queued
 * via the same runs/events primitive manage_agents uses); throws on deny or
 * foreign-owner escalation; returns null when the write may apply now.
 */
async function gateAutomationWrite(
  args: ManageAutomationsArgs,
  ctx: ToolContext
): Promise<ManageAutomationsResult | null> {
  const action = automationWriteAction(args.action);
  if (!action) return null;
  // Resolve the actor through the shared seam. A reaction script editing automations
  // acts as its own automation (ctx.actingAutomationId) — the seam folds that automation's
  // owning agent so the agent's agent_config envelope binds and the reaction can't
  // self-escalate. manage_automations has no automation_source arg, so only the session
  // automation applies.
  const actor = await resolveActingPrincipal(getDb(), {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionAutomationId: ctx.actingAutomationId ?? null,
  });
  // Non-human principal identity captured for the ownership guard AND (when
  // queued) the proposal. Same formula the gate has always used.
  const actingAgentId = actor.kind !== 'user' ? (actor.ownerAgentId ?? actor.id) : null;
  const actingAutomationId = ctx.actingAutomationId != null ? String(ctx.actingAutomationId) : null;

  // Escalation guard: a non-human caller must not end up installing automation OWNED by
  // another agent. An automation's `managed_agent_id` IS its policy principal, so if restricted
  // agent A could create/clone/edit an automation (or a group-shared prompt/reaction)
  // that stays owned by looser agent B, every later run would fold B's (looser)
  // envelope instead of A's, side-stepping A's deny rules. We validate what each
  // handler ACTUALLY persists (see resolveEffectiveAutomationOwners) — NOT the supplied
  // `managed_agent_id` (create_from_version/create_version/set_reaction_script ignore it) —
  // and ALL owners a group-wide write touches. EVERY affected owner must be the actor
  // itself. Humans are ungoverned here and may own/assign freely.
  // MUST run BEFORE queueing so a foreign-owner proposal never becomes a pending card.
  await assertAutomationOwnersMatchActingAgent(args, ctx, actingAgentId, actor.kind);

  const decision = await resolveWritePolicyDecision({
    organizationId: ctx.organizationId,
    resourceClass: 'agent_config',
    principalKind: actor.kind,
    principalId: actor.id,
    ownerAgentId: actor.ownerAgentId,
    ownerResolved: actor.ownerResolved,
    action,
  });
  if (decision === 'allow') return null;
  if (decision === 'require_approval') {
    return queueAutomationWriteForApproval(args, ctx, {
      actingAgentId,
      actingAutomationId,
    });
  }
  throw new ToolUserError(
    `Policy denies ${action} of Automations (agent config) for this principal.`,
    403
  );
}

const runManageAutomations = defineFlatActionTool<ManageAutomationsArgs, ManageAutomationsResult>(
  'manage_automations',
  {
    create: flatAction((args, ctx, env) => handleCreate(args, env, ctx)),
    list: flatAction((args: ManageAutomationsArgs, ctx, env) => handleList(args, env, ctx)),
    update: flatAction((args, ctx, env) => handleUpdate(args, env, ctx)),
    create_version: flatAction((args, ctx, env) => handleCreateVersion(args, env, ctx)),
    complete_window: flatAction((args, ctx, env) => handleCompleteWindow(args, env, ctx)),
    claim_next_window: flatAction((args, ctx, env) => handleClaimNextWindow(args, env, ctx)),
    trigger: flatAction((args, ctx, env) => handleTrigger(args, env, ctx)),
    delete: flatAction((args, ctx) => handleDelete(args, ctx)),
    set_reaction_script: flatAction((args, ctx, env) => handleSetReactionScript(args, env, ctx)),
    get_versions: flatAction(handleGetVersions),
    get_version_details: flatAction(handleGetVersionDetails),
    get_component_reference: flatAction(() => Promise.resolve(handleGetComponentReference())),
    submit_feedback: flatAction(handleSubmitFeedback),
    get_feedback: flatAction(handleGetFeedback),
    list_promoted: flatAction(handleListPromoted),
    create_from_version: flatAction((args, ctx, env) => handleCreateFromVersion(args, env, ctx)),
  }
);
