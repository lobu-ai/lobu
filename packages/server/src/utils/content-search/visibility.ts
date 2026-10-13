/**
 * Visibility and org-scope WHERE clause helpers:
 * buildOrgScopeWhere, buildConnectionVisibilityClause, buildExcludeAutomationClause,
 * buildAnalyzedByAutomationClause, buildProducedByAutomationClause.
 */

import { compileConnectionFkVisibility } from '../../authz/connection-visibility';
import { compileResourceVisibility } from '../../authz/resource-visibility';
import type { AuthzScope } from '../../authz/scope';
import { useLinkedOrgScope } from '../linked-org-ids';
import { validateNumericId } from '../sql-validation';

/**
 * Exclude content already analyzed by any run of an automation. The id is bound as
 * a query parameter; `validateNumericId` is the belt to that suspenders.
 *
 * Returns empty strings/arrays when no filter is applied.
 */
export function buildExcludeAutomationClause(
  excludeAutomationId: number | undefined,
  baseParamIndex: number
): { sql: string; params: unknown[] } {
  if (excludeAutomationId === undefined) return { sql: '', params: [] };
  const validated = validateNumericId(excludeAutomationId, 'exclude_automation_id');
  return {
    sql: ` AND NOT EXISTS (
    SELECT 1 FROM automation_run_events exc_iwe
    WHERE exc_iwe.event_id = f.id AND exc_iwe.automation_id = $${baseParamIndex}::bigint
  )`,
    params: [validated],
  };
}

/**
 * Restrict to events an Automation ANALYZED — rows linked to one of its runs in
 * `automation_run_events`. The opposite direction to
 * {@link buildProducedByAutomationClause}.
 *
 * Shared by the two builders that had each dropped it: the chronological list
 * path applied it only inside its classification-filter branch, and the search
 * path never applied it at all. (The score and include-superseded builders
 * bind their own equivalent EXISTS.) A dropped filter is worse than a rejected
 * one: the request returns 200 with the org's ENTIRE activity stream, which
 * looks plausible — an unqualified `?automation=<id>` drill lands on the
 * standard list branch, so that drill was unscoped for exactly this reason.
 */
export function buildAnalyzedByAutomationClause(
  analyzedByAutomationId: number | undefined,
  baseParamIndex: number
): { sql: string; params: unknown[] } {
  if (analyzedByAutomationId === undefined) return { sql: '', params: [] };
  const validated = validateNumericId(analyzedByAutomationId, 'analyzed_by_automation_id');
  return {
    sql: ` AND EXISTS (
    SELECT 1 FROM automation_run_events ana_iwe
    WHERE ana_iwe.event_id = f.id AND ana_iwe.automation_id = $${baseParamIndex}::bigint
  )`,
    params: [validated],
  };
}

/**
 * Restrict to events an Automation PRODUCED (`events.automation_id`).
 *
 * All four `read_knowledge` builders must call it: a filter added to only some
 * is worse than one added to none, since the same scope would then return
 * different rows depending on whether a search term was typed.
 *
 * A column equality, NOT an EXISTS over `automation_run_events` — that table
 * records what an Automation READ. Backed by idx_events_automation_produced.
 */
export function buildProducedByAutomationClause(
  producedByAutomationId: number | undefined,
  baseParamIndex: number
): { sql: string; params: unknown[] } {
  if (producedByAutomationId === undefined) return { sql: '', params: [] };
  const validated = validateNumericId(producedByAutomationId, 'produced_by_automation_id');
  return {
    sql: ` AND f.automation_id = $${baseParamIndex}::bigint`,
    params: [validated],
  };
}

export interface OrgScopeWhere {
  /** `AND (...)` fragment for a WHERE body, or '' when no scoping applies. */
  sql: string;
  params: Array<string | number | null>;
  /**
   * Bare, disjoint predicates whose union is `sql`, or null when the scope
   * cannot be split (legacy bridge predicate, or no scoping).
   */
  branches: { direct: string; linked: string } | null;
}

/**
 * Build an org/workspace-scoping WHERE clause using EXISTS (no JOIN needed).
 * Returns an empty string when no scoping is needed (for example, entity_id is
 * set and the caller did not opt into strict organization scoping).
 * Assumes the query has `f` aliasing events and `c` aliasing connections.
 *
 * An event is in scope when ANY of these hold:
 *  - the event itself was stamped to the caller's org (`f.organization_id`),
 *  - one of its `entity_ids` belongs to the caller's org, or
 *  - the connection that produced it belongs to the caller's org.
 *
 * The bridge clauses cover events ingested into another org but cross-linked
 * to entities/connections here. Stand-alone events with no entity links and
 * no connection are still findable via the direct `f.organization_id` match.
 */
export function buildOrgScopeWhere(options: {
  entity_id?: number;
  organization_id?: string;
  strict_organization_scope?: boolean;
  baseParamIndex: number;
}): OrgScopeWhere {
  if (!options.organization_id || (options.entity_id && !options.strict_organization_scope)) {
    return { sql: '', params: [], branches: null };
  }

  const p = `$${options.baseParamIndex}::text`;
  // Denormalized bridge (events.linked_org_ids, write-once at INSERT): folds
  // the entity + connection branches into one GIN-indexed condition instead
  // of per-row OR/EXISTS subplans. Gated until the one-time backfill is done.
  if (useLinkedOrgScope()) {
    const direct = `f.organization_id = ${p}`;
    return {
      sql: `AND (${direct} OR f.linked_org_ids @> ARRAY[${p}]::text[])`,
      params: [options.organization_id],
      // The same predicate as two DISJOINT arms. Their union is exactly `sql`;
      // `IS DISTINCT FROM` keeps a row that matches both arms in one of them.
      // The OR above hides `organization_id` from the index, so a top-N read
      // runs one ordered, index-bounded scan per arm and merges them instead.
      branches: {
        direct,
        linked: `f.linked_org_ids @> ARRAY[${p}]::text[] AND f.organization_id IS DISTINCT FROM ${p}`,
      },
    };
  }
  const directCond = `f.organization_id = ${p}`;
  const entityCond = `EXISTS (SELECT 1 FROM entities ent_org WHERE ent_org.id = ANY(f.entity_ids) AND ent_org.organization_id = ${p})`;
  const connCond = `c.organization_id = ${p}`;
  return {
    sql: `AND (${directCond} OR ${entityCond} OR ${connCond})`,
    params: [options.organization_id],
    branches: null,
  };
}

/**
 * Build a connection-visibility WHERE clause that lives inline alongside the
 * other content filters, so the list and count queries don't need a separate
 * "which connection ids may I see?" round trip.
 *
 * Semantics (must match `getContent`'s legacy two-step flow):
 *  - Authed user: connections with `visibility='org' OR created_by = $userId`.
 *  - Unauthed:    connections with `visibility='org'`.
 *  - Soft-deleted connections (`deleted_at IS NOT NULL`) are excluded.
 *  - Events with `connection_id IS NULL` (system / non-connection events)
 *    are visible in both authed and unauthed cases.
 *
 * Returns an empty fragment when no scope is requested (callers like the
 * automation-mode path that already select by other constraints).
 *
 * Thin adapter over the one connection-visibility compiler (M1): builds an
 * {@link AuthzScope} from this seam's legacy `{ organizationId, userId }` shape
 * and defers the predicate to {@link compileConnectionFkVisibility}, so the rule
 * lives in exactly one place.
 */
export function buildConnectionVisibilityClause(
  options: {
    organizationId?: string;
    userId?: string | null;
    baseParamIndex: number;
  },
  tableAlias: string = 'f'
): { sql: string; params: Array<string | number | null> } {
  if (!options.organizationId) return { sql: '', params: [] };

  const scope: AuthzScope = {
    organizationId: options.organizationId,
    principal: options.userId ?? null,
  };
  // Compose the two read gates: per-connection visibility AND per-resource
  // membership (the latter only constrains ACL-enforced connections). Resource
  // visibility binds its own params AFTER the connection-visibility params, so a
  // single returned `{ sql, params }` keeps every caller's `$N` indexing intact.
  const conn = compileConnectionFkVisibility(scope, options.baseParamIndex, tableAlias);
  const resource = compileResourceVisibility(
    scope,
    options.baseParamIndex + conn.params.length,
    tableAlias,
  );
  return {
    sql: `${conn.sql} ${resource.sql}`,
    params: [...conn.params, ...resource.params],
  };
}
