/**
 * Config-audit emission for tool handlers (manage_* admin tools).
 *
 * Wraps the transactional config writer with the actor fields every tool call site
 * derives the same way from its ToolContext — apply-id grouping, actor
 * source, user, client. Handlers state only WHAT changed; forgetting the
 * apply-id threading (which would silently ungroup a `lobu apply` run's
 * changes in the Events feed) stops being possible.
 */

import type { ConfigResourceKind } from '../../../utils/config-redaction';
import { deriveToolActorSource } from '../../../utils/apply-context';
import { type DbClient, getDb } from '../../../db/client';
import { lockOrganizationForRelationshipClaims } from '../../../utils/relationship-claims';
import {
  insertConfigChangeEventInTransaction,
} from '../../../utils/insert-event';
import type { ToolContext } from '../../registry';
import { eventClientId } from '../../../auth/event-client-id';

interface ToolConfigChangeParams {
  /**
   * Override when the mutated row's org is resolved from data rather than
   * the caller (automation tools can act on entity-derived orgs). Defaults to
   * `ctx.organizationId`.
   */
  organizationId?: string;
  resourceKind: ConfigResourceKind;
  resourceId: string | number;
  op: 'created' | 'updated' | 'deleted';
  /** Human-readable summary (e.g. "Automation 'inbox' paused"). */
  summary: string;
  /** Full post-change state (redacted by the writer); null for deletes. */
  state: Record<string, unknown> | null;
  /** Explicit pre-change snapshot for the audited fields (#3664). */
  before?: Record<string, unknown> | null;
  /** Tool-level action (e.g. `update`, `create_version`, `set_reaction_script`). */
  action?: string | null;
  changedFields?: string[];
  /** Approval linkage: original requester + approval run/reference. */
  requestedBy?: string | null;
  approvedBy?: string | null;
  approvalRunId?: number | string | null;
  approvalReference?: string | null;
}

function toolConfigChangeEvent(
  ctx: ToolContext,
  params: ToolConfigChangeParams
): Parameters<typeof insertConfigChangeEventInTransaction>[0] {
  const approvalRunId = params.approvalRunId ?? ctx.approvalRunId ?? null;
  const requestedBy = params.requestedBy ?? ctx.approvalRequesterId ?? null;
  const approvedBy = params.approvedBy ?? (ctx as { approvalApproverId?: string | null }).approvalApproverId ?? null;
  return {
    organizationId: params.organizationId ?? ctx.organizationId,
    resourceKind: params.resourceKind,
    resourceId: params.resourceId,
    op: params.op,
    summary: params.summary,
    state: params.state,
    ...(params.before === undefined ? {} : { before: params.before }),
    ...(params.action ? { action: params.action } : {}),
    ...(params.changedFields ? { changedFields: params.changedFields } : {}),
    applyId: ctx.applyId ?? null,
    actorSource: deriveToolActorSource(ctx),
    createdBy: ctx.userId ?? null,
    clientId: eventClientId(ctx),
    agentId: ctx.agentId ?? null,
    actingAutomationId: ctx.actingAutomationId ?? null,
    actingRunId: ctx.actingRunId ?? null,
    mcpSessionId: ctx.mcpSessionId ?? null,
    mcpConversationId: ctx.mcpConversationId ?? null,
    tokenType: ctx.tokenType ?? null,
    ...(requestedBy ? { requestedBy } : {}),
    ...(approvedBy ? { approvedBy } : {}),
    ...(approvalRunId != null ? { approvalRunId } : {}),
    ...(params.approvalReference ? { approvalReference: params.approvalReference } : {}),
  };
}

/** Awaited variant for mutations whose state and audit must share a commit. */
export async function insertToolConfigChange(
  ctx: ToolContext,
  params: ToolConfigChangeParams,
  sql: DbClient
): Promise<void> {
  await insertConfigChangeEventInTransaction(
    toolConfigChangeEvent(ctx, params),
    sql
  );
}

class RejectedConfigMutation<T> {
  constructor(readonly result: T) {}
}

/** Tool errors must roll back earlier writes while preserving the tool's error response. */
export async function withToolConfigTransaction<T extends object>(ctx: ToolContext, mutate: (tx: DbClient) => Promise<T>): Promise<T> {
  try {
    return await getDb().begin(async (tx) => {
      await lockOrganizationForRelationshipClaims(tx, ctx.organizationId);
      const result = await mutate(tx);
      if ('error' in result && result.error !== undefined) throw new RejectedConfigMutation(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RejectedConfigMutation) return error.result as T;
    throw error;
  }
}
