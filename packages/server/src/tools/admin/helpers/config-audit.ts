/**
 * Config-audit emission for tool handlers (manage_* admin tools).
 *
 * Wraps `recordConfigChangeEvent` with the actor fields every tool call site
 * derives the same way from its ToolContext — apply-id grouping, actor
 * source, user, client. Handlers state only WHAT changed; forgetting the
 * apply-id threading (which would silently ungroup a `lobu apply` run's
 * changes in the Deployments feed) stops being possible.
 */

import type { ConfigResourceKind } from '../../../utils/config-redaction';
import { deriveToolActorSource } from '../../../utils/apply-context';
import type { DbClient } from '../../../db/client';
import {
  insertConfigChangeEventInTransaction,
  recordConfigChangeEvent,
} from '../../../utils/insert-event';
import type { ToolContext } from '../../registry';

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
): Parameters<typeof recordConfigChangeEvent>[0] {
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
    clientId: ctx.clientId ?? null,
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

export function recordToolConfigChange(
  ctx: ToolContext,
  params: ToolConfigChangeParams
): void {
  recordConfigChangeEvent(toolConfigChangeEvent(ctx, params));
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
