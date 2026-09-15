/**
 * query_metric — run a governed declared or derived measure and return its rows.
 *
 * Prefer this over `query_sql` whenever an available measure answers the
 * question. Declared measures enforce their resolution, dedupe, segments, and
 * aggregation; derived measures execute their reusable, precomputed SQL grain.
 * Discover both with `list_metrics`.
 *
 * Thin wrapper over runMetric (compile → org-scope → read-only execute) — the
 * same path a federated warehouse metric flows through.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { Env } from '../../index';
import { runMetric } from '../../metrics/run-metric';
import { isAdminOrOwnerRole, isInProcessSystemCall } from '../access-control';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';

export const QueryMetricSchema = Type.Object({
  entity_type: Type.String({
    description: 'Entity type slug exposing the measure (e.g. "company"). See list_metrics.',
  }),
  measure: Type.String({
    description: 'Available declared or derived measure name (e.g. "spend" or "net_worth_gbp").',
  }),
  by: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Dimension names to group by (e.g. ["currency","month"]). Omit for a grand total per entity.',
    }),
  ),
  segment: Type.Optional(
    Type.String({ description: 'An extra declared segment (named population filter) to AND in.' }),
  ),
  entity_id: Type.Optional(
    Type.Number({ description: 'Restrict to a single entity (entities.id); omit for all entities of the type.' }),
  ),
});

async function queryMetricImpl(
  args: Static<typeof QueryMetricSchema>,
  _env: Env,
  ctx: ToolContext,
): Promise<{ rows: Record<string, unknown>[]; row_count: number }> {
  if (!ctx.organizationId) {
    throw new Error('query_metric requires a bound organization');
  }
  const rows = await runMetric({
    organizationId: ctx.organizationId,
    entityType: args.entity_type,
    measure: args.measure,
    by: args.by,
    segment: args.segment,
    entityId: args.entity_id,
    userId: ctx.userId,
    // Workspace-identity audit rows are owner/admin/system-only; ordinary
    // members must not move a declared metric by counting lifecycle events.
    excludeWorkspaceAudit: !isInProcessSystemCall(ctx) && !isAdminOrOwnerRole(ctx.memberRole),
    // $member entity rows carry PII reserved by the manage_entity read
    // policy; ordinary members must not bypass it via a declared measure.
    excludeMemberEntities: !isInProcessSystemCall(ctx) && !isAdminOrOwnerRole(ctx.memberRole),
  });
  return { rows, row_count: rows.length };
}

export const queryMetric = withValidatedArgs('query_metric', QueryMetricSchema, queryMetricImpl);
