/**
 * Shared helpers for automation reaction queries and tracking.
 */

import { getDb } from '../db/client';
import { resolveActingPrincipal, listEntityApprovalPolicies } from '../authz/entity-policy';
import { evaluateConnectorPolicy } from '../authz/connector-policy';
import { listOperations } from '../operations/connector-operations';
import logger from './logger';

/**
 * Fetch available connection operations for a set of entity IDs.
 */
export async function getAvailableOperations(
  entityIds: number[],
  organizationId: string,
  automationId: number
): Promise<
  Array<{
    connection_id: number;
    operation_key: string;
    name: string;
    kind: 'read' | 'write';
  }>
> {
  if (entityIds.length === 0) return [];
  const sql = getDb();
  const idsLiteral = `{${entityIds.map(Number).join(',')}}`;
  const rows = await sql`
    SELECT DISTINCT c.id as connection_id
    FROM connections c JOIN feeds f ON f.connection_id = c.id
    WHERE c.status = 'active' AND c.deleted_at IS NULL
      AND f.entity_ids && ${idsLiteral}::bigint[] AND f.deleted_at IS NULL
      AND c.organization_id = ${organizationId}
  `;
  const actor = await resolveActingPrincipal(sql, { organizationId, sessionAutomationId: automationId });
  const policies = await listEntityApprovalPolicies(organizationId, 'connector_action');

  const result: Array<{
    connection_id: number;
    operation_key: string;
    name: string;
    kind: 'read' | 'write';
  }> = [];
  for (const row of rows as Array<{ connection_id: number }>) {
    let operations: Awaited<ReturnType<typeof listOperations>>['operations'];
    try {
      ({ operations } = await listOperations({
        organizationId,
        connectionId: Number(row.connection_id),
        includeInputSchema: false,
        includeOutputSchema: false,
        limit: 1000,
        offset: 0,
      }));
    } catch (err) {
      // Reaction context is best-effort: one connection's unreachable MCP
      // upstream must not hide every other connection's operations.
      logger.warn(
        { err, connectionId: row.connection_id },
        'Skipping unavailable operations for reaction context'
      );
      continue;
    }
    for (const operation of operations) {
      if (evaluateConnectorPolicy({ organizationId, connectionId: Number(row.connection_id), operation, actor, policies }).effect === 'deny') continue;
      result.push({
        connection_id: Number(row.connection_id),
        operation_key: operation.operation_key,
        name: operation.name,
        kind: operation.kind,
      });
    }
  }
  return result;
}

/**
 * Build a human-readable summary of past automation reactions.
 */
export async function getPastReactionsSummary(
  automationId: number | string,
  limit = 20
): Promise<string | undefined> {
  const sql = getDb();
  const reactions = await sql`
    SELECT wr.reaction_type, wr.tool_name, wr.tool_args, wr.created_at,
           (source.approved_input->>'window_start')::timestamptz AS window_start,
           decision.action_key AS decision_action_key,
           decision.status AS decision_status,
           decision.approval_status AS decision_approval_status,
           decision.action_input AS decision_input,
           decision.action_output AS decision_output,
           decision.error_message AS decision_error
    FROM automation_reactions wr
    JOIN automations owning_automation
      ON owning_automation.id = wr.automation_id
     AND owning_automation.organization_id = wr.organization_id
    JOIN runs source
      ON source.id = wr.source_run_id
     AND source.automation_id = wr.automation_id
     AND source.organization_id = wr.organization_id
    LEFT JOIN runs linked_run
      ON linked_run.id = wr.run_id
     AND linked_run.organization_id = wr.organization_id
     AND linked_run.automation_id = wr.automation_id
     AND linked_run.parent_run_id = wr.source_run_id
    LEFT JOIN runs decision
      ON decision.id = linked_run.id
     AND decision.run_type = 'internal'
     AND decision.action_key = 'agent_ask'
    WHERE wr.automation_id = ${automationId}
      AND (wr.run_id IS NULL OR linked_run.id IS NOT NULL)
    ORDER BY wr.created_at DESC
    LIMIT ${limit}
  `;
  if (reactions.length === 0) return undefined;
  const lines: string[] = ['## Past Reactions'];
  for (const r of reactions) {
    const date = r.window_start
      ? new Date(r.window_start as string).toISOString().split('T')[0]
      : '?';
    const toolArgs = r.tool_args as Record<string, unknown> | null;
    const detail = toolArgs ? JSON.stringify(toolArgs) : '';
    let decision = '';
    if (r.decision_action_key === 'agent_ask') {
      const proposal = r.decision_input as
        | { question?: string; context?: string }
        | null;
      const question = String(proposal?.question ?? 'Human review');
      const context = String(proposal?.context ?? '');
      decision = ` — Asked: ${question}`;
      if (context) {
        decision += ` | Context: ${context.slice(0, 600)}${context.length > 600 ? '…' : ''}`;
      }
      const approval = String(r.decision_approval_status ?? '');
      const status = String(r.decision_status ?? '');
      if (approval === 'approved' && status === 'completed') {
        const output = r.decision_output as
          | { answer?: Record<string, unknown> }
          | null;
        const answer = output?.answer ?? {};
        decision += ` — Human answered: ${JSON.stringify(answer)}`;
        if (answer.outcome === 'posted_edited' && !answer.final_text) {
          decision += ' (edited final text was not provided)';
        }
      } else if (approval === 'rejected') {
        decision += ` — Human rejected: ${String(r.decision_error ?? 'Rejected by user')}`;
      } else if (approval === 'expired') {
        // Expiry means no decision. Keep it explicit so the model never learns
        // an unattended question as negative preference feedback.
        decision += ' — Question expired without a human decision (neutral)';
      } else {
        decision += ' — Awaiting human decision';
      }
    }
    lines.push(
      `- Run ${date}: ${r.reaction_type} via ${r.tool_name} ${detail}${decision}`
    );
  }
  return lines.join('\n');
}

/**
 * Track an automation reaction.
 *
 * A run-linked reaction is a durable feedback edge, not best-effort telemetry.
 * Serialize concurrent retries for the same edge and insert only when it is
 * missing. Callers that truly want fire-and-forget semantics can catch/log the
 * propagated error at their own boundary. Entries without a run handle retain
 * their historical best-effort semantics because they cannot be reconciled by a
 * later idempotent replay.
 */
export async function trackAutomationReaction(params: {
  organizationId: string;
  automationId: number;
  sourceRunId: number;
  reactionType: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  entityId?: number;
  runId?: number;
}): Promise<void> {
  const sql = getDb();
  if (params.runId != null) {
    const lockKey = [
      params.organizationId,
      params.automationId,
      params.sourceRunId,
      params.reactionType,
      params.toolName,
      params.runId,
    ].join(':');
    await sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtext('lobu:automation-reaction'),
          hashtext(${lockKey})
        )
      `;
      const matchingRuns = await tx`
        SELECT id
        FROM runs
        WHERE id = ${params.runId}
          AND organization_id = ${params.organizationId}
          AND automation_id = ${params.automationId}
          AND parent_run_id = ${params.sourceRunId}
        FOR KEY SHARE
      `;
      if (matchingRuns.length === 0) {
        throw new Error('Run provenance does not match the Automation feedback edge.');
      }
      await tx`
        INSERT INTO automation_reactions (
          organization_id, automation_id, source_run_id,
          reaction_type, tool_name, tool_args, tool_result, entity_id, run_id
        )
        SELECT
          ${params.organizationId}, ${params.automationId}, ${params.sourceRunId},
          ${params.reactionType}, ${params.toolName},
          ${tx.json(params.toolArgs)},
          ${params.toolResult ? tx.json(params.toolResult) : null},
          ${params.entityId ?? null},
          ${params.runId}
        WHERE NOT EXISTS (
          SELECT 1
          FROM automation_reactions
          WHERE organization_id = ${params.organizationId}
            AND automation_id = ${params.automationId}
            AND source_run_id = ${params.sourceRunId}
            AND reaction_type = ${params.reactionType}
            AND tool_name = ${params.toolName}
            AND run_id = ${params.runId}
        )
      `;
    });
    return;
  }
  await sql`
    INSERT INTO automation_reactions (
      organization_id, automation_id, source_run_id,
      reaction_type, tool_name, tool_args, tool_result, entity_id, run_id
    ) VALUES (
      ${params.organizationId}, ${params.automationId}, ${params.sourceRunId},
      ${params.reactionType}, ${params.toolName},
      ${sql.json(params.toolArgs)},
      ${params.toolResult ? sql.json(params.toolResult) : null},
      ${params.entityId ?? null},
      ${params.runId ?? null}
    )
  `.catch((err) => logger.error(err, 'Failed to track automation reaction'));
}
