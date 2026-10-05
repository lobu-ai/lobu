/**
 * Metric compiler — "producer A": lowers a declared metric (an entity type's
 * eventSets/measures/dimensions/segments) into org-scopable SQL over the event
 * stream, then aggregates it. The output SELECT references `events` + `entities`
 * as plain tables; the caller passes it through `validateAndScopeQuery`, which
 * rewrites `events` → `current_event_records` (superseded rows masked) and
 * org-scopes both — so this module never writes scoping or masking itself.
 *
 * Consolidation: the `aggregate` step (SELECT agg(expr) … GROUP BY dims) is the
 * SAME step a federated warehouse metric flows through — only the *relation*
 * differs (here a resolved/deduped CTE over events; there a connector's
 * SEMANTIC_VIEW). That step is the Malloy-swappable seam.
 *
 * v1 scope: `eventSet.by: "alias"`, with `reads: "current"` or `{ asOf }`.
 * window/link, `raw` reads, and cross-entity joins are deferred
 * (NotImplemented).
 *
 * On the "request paths never aggregate history" invariant: `asOf` adds only a
 * range predicate on `occurred_at` to the SAME filtered-events relation the
 * `current` read already scans, so it strictly narrows an existing shape rather
 * than introducing a new history walk. Reconstructing SYSTEM-time state ("what
 * we believed then") WOULD need a per-row supersede-chain walk — that is why
 * `read-mode.ts` refuses it instead of compiling it.
 */

import type { EntityMetrics } from "@lobu/connector-sdk";
import {
  IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY,
  ORGANIZATION_SCOPE_PROJECTION,
} from "../identity/scope-projection";
import { inferColumns } from "../utils/infer-measures";
import { MetricCompileError, MetricNotImplementedError } from "./errors";
import { compileReadModePredicate } from "./read-mode";

interface CompileMetricInput {
  /** entity_types.id, for the alias-resolution join. */
  entityTypeId: number;
  /** The entity type's declared metric contract (from metrics_config). */
  metrics: EntityMetrics;
  /** Measure name to compute. */
  measure: string;
  /** Dimension names to group by (default: none → a single grand-total row per entity). */
  by?: string[];
  /** Extra segment name to AND in, beyond the measure's own `segments`. */
  segment?: string;
  /** Restrict to one entity (entities.id); omitted ⇒ all entities of the type. */
  entityId?: number;
}

const SANE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Return the identity namespace only for a direct metadata-slot alias field. */
function metadataKeyFromAliasField(field: string): string | null {
  const match = field.trim().match(/^metadata\s*->>\s*'((?:[^']|'')+)'$/);
  return match ? match[1].replaceAll("''", "'") : null;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Output column alias for a dimension / measure — guarded so names can't inject. */
function outName(kind: string, name: string): string {
  if (!SANE_IDENT.test(name)) {
    throw new MetricCompileError(`${kind} name "${name}" must be a plain identifier`);
  }
  return name;
}

/**
 * Compile a measure into a single SELECT (no top-level WITH). Throws
 * MetricCompileError on bad references and MetricNotImplementedError for
 * deferred features. The result is NOT yet org-scoped — pass it through
 * `validateAndScopeQuery`.
 */
export function compileMetricSql(input: CompileMetricInput): string {
  const { metrics, entityTypeId } = input;
  const measure = metrics.measures?.[input.measure];
  if (!measure) {
    throw new MetricCompileError(`measure "${input.measure}" is not declared`);
  }
  const eventSet = metrics.eventSets?.[measure.eventSet];
  if (!eventSet) {
    throw new MetricCompileError(
      `measure "${input.measure}" references eventSet "${measure.eventSet}" which is not declared`,
    );
  }
  if (eventSet.by !== "alias") {
    throw new MetricNotImplementedError(
      `eventSet resolver "${eventSet.by}" is not implemented in v1 (alias only)`,
    );
  }
  const readsWhere = compileReadModePredicate(eventSet.reads, measure.eventSet);
  if (!eventSet.field) {
    throw new MetricCompileError(`alias eventSet "${measure.eventSet}" needs a "field"`);
  }

  // ── Resolve segments (measure's own + the caller's override) ──────────────
  const segNames = [...(measure.segments ?? []), ...(input.segment ? [input.segment] : [])];
  const segWheres: string[] = [];
  const entitySegWheres: string[] = [];
  for (const name of segNames) {
    const seg = metrics.segments?.[name];
    if (!seg) throw new MetricCompileError(`segment "${name}" is not declared`);
    if (seg.on === "entity") {
      entitySegWheres.push(entitySegmentPredicate("ent.id", entityTypeId, seg.where));
    } else {
      segWheres.push(`(${seg.where})`);
    }
  }

  // ── Dimensions to group by ────────────────────────────────────────────────
  const dims = (input.by ?? []).map((name) => {
    const dim = metrics.dimensions?.[name];
    if (!dim) throw new MetricCompileError(`dimension "${name}" is not declared`);
    return { col: outName("dimension", name), expr: dim.expr };
  });

  // ── Inner: filtered events (single table → `metadata` is unambiguous, no
  //    qualifier needed for the config-authored predicates). ─────────────────
  const innerWhere = [
    // The read-mode cut goes first: it's the most selective predicate available
    // and it must narrow the set BEFORE dedupe, so a point-in-time answer
    // dedupes only the rows that existed by then.
    readsWhere ? `(${readsWhere})` : null,
    eventSet.where ? `(${eventSet.where})` : null,
    measure.where ? `(${measure.where})` : null,
    ...segWheres,
  ].filter(Boolean);
  const evt = `SELECT * FROM events${
    innerWhere.length ? ` WHERE ${innerWhere.join(" AND ")}` : ""
  }`;

  // ── Alias resolution. Arbitrary fields retain legacy flat-alias matching.
  //    A direct metadata namespace additionally resolves the durable identity
  //    tuple, including the event-side tenant projection. ───────────────────
  const entWhere = [`ent.entity_type_id = ${Number(entityTypeId)}`, `ent.deleted_at IS NULL`];
  if (input.entityId !== undefined) entWhere.push(`ent.id = ${Number(input.entityId)}`);
  entWhere.push(...entitySegWheres);
  const identityNamespace = metadataKeyFromAliasField(eventSet.field);
  const identityNamespaceSql = identityNamespace ? sqlString(identityNamespace) : null;
  const flatAliases = `SELECT ent.id AS entity_id, a.alias,
              NULL::text AS namespace, NULL::text AS scope_key
       FROM entities ent, jsonb_array_elements_text(ent.metadata->'aliases') AS a(alias)
       WHERE ${entWhere.join(" AND ")}`;
  const entAlias = identityNamespaceSql
    ? `${flatAliases}
       UNION ALL
       SELECT ent.id AS entity_id, ei.identifier AS alias,
              ei.namespace, ei.scope_key
       FROM entities ent
       JOIN entity_identities ei ON ei.entity_id = ent.id AND ei.deleted_at IS NULL
       WHERE ${entWhere.join(" AND ")}
         AND ei.namespace = ${identityNamespaceSql}`
    : flatAliases;

  // ── Resolved + deduped relation. DISTINCT over the dedupe tuple ∪ entity ∪
  //    dims ∪ measure expr so summing over distinct rows is correct (a missing
  //    dim in the dedupe set would wrongly collapse rows across that dim). ────
  const dedupeCols = (eventSet.dedupeKey ?? []).map((e, i) => `(${e}) AS __dk${i}`);
  const measureExprSel = measure.expr ? `(${measure.expr}) AS __m` : null;
  const dimSels = dims.map((d) => `(${d.expr}) AS ${d.col}`);
  const distinct = eventSet.dedupeKey && eventSet.dedupeKey.length > 0 ? "DISTINCT " : "";
  const relationCols = [
    "ea.entity_id",
    ...dimSels,
    ...(measureExprSel ? [measureExprSel] : []),
    ...dedupeCols,
  ].join(", ");
  const fieldExpr = `evt.${eventSet.field}`;
  const aliasMatch = identityNamespaceSql
    ? `ea.alias = ${fieldExpr}
      AND (
        (
          ea.namespace IS NULL
          AND NOT (
            COALESCE(
              evt.metadata->'${IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY}',
              '{}'::jsonb
            ) ? ${identityNamespaceSql}
          )
        )
        OR (
          ea.namespace = ${identityNamespaceSql}
          AND COALESCE(
            evt.metadata->'${IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY}',
            '{}'::jsonb
          ) ? ${identityNamespaceSql}
          AND COALESCE(ea.scope_key, '${ORGANIZATION_SCOPE_PROJECTION}') = COALESCE(
            (evt.metadata->'${IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY}')->>${identityNamespaceSql},
            '${ORGANIZATION_SCOPE_PROJECTION}'
          )
        )
      )`
    : `ea.alias = ${fieldExpr} AND ea.namespace IS NULL`;
  const resolved = `SELECT ${distinct}${relationCols}
     FROM (${evt}) evt
     JOIN (${entAlias}) ea ON ${aliasMatch}`;

  // ── Aggregate (the shared, Malloy-swappable seam) ─────────────────────────
  const measureName = outName("measure", input.measure);
  const aggExpr = aggregateExpr(measure.agg, measure.expr ? "__m" : null, measureName);
  const groupCols = ["entity_id", ...dims.map((d) => d.col)];
  const selectCols = [...groupCols, aggExpr].join(", ");
  return `SELECT ${selectCols}
     FROM (${resolved}) resolved
     GROUP BY ${groupCols.join(", ")}`;
}

/**
 * The one lowering of an `on: "entity"` segment: membership of `idColumn` in
 * the type's entities matching the org-authored predicate. The predicate runs
 * against a single-table `entities` scope so its unqualified columns
 * (`metadata`, `name`, …) resolve to the entity row. The caller passes the
 * whole statement through `validateAndScopeQuery`, which org-scopes the inner
 * `entities` reference like any other.
 */
export function entitySegmentPredicate(
  idColumn: string,
  entityTypeId: number,
  where: string,
): string {
  return `${idColumn} IN (SELECT id FROM entities WHERE entity_type_id = ${Number(entityTypeId)} AND (${where}))`;
}

/**
 * Select a precomputed measure from a derived entity's backing SQL. The
 * authored SQL owns aggregation and grain; this path only validates that the
 * requested columns were inferred with the right roles, then projects them.
 * That keeps derived measures composable with ordinary SQL without inventing
 * a second metric declaration language.
 */
export function compileDerivedMetricSql(input: {
  backingSql: string;
  measure: string;
  by?: string[];
  segment?: string;
  entityId?: number;
}): string {
  if (input.segment) {
    throw new MetricNotImplementedError(
      "segments do not apply to a precomputed derived measure",
    );
  }
  if (input.entityId !== undefined) {
    throw new MetricNotImplementedError(
      "entity_id does not apply to a derived entity",
    );
  }
  const columns = new Map(inferColumns(input.backingSql).map((column) => [column.name, column.role]));
  if (columns.get(input.measure) !== "measure") {
    throw new MetricCompileError(`measure "${input.measure}" is not declared or inferred`);
  }
  const dimensions = (input.by ?? []).map((name) => {
    if (columns.get(name) !== "dimension") {
      throw new MetricCompileError(`dimension "${name}" is not inferred`);
    }
    return outName("dimension", name);
  });
  const measure = outName("measure", input.measure);
  const backing = input.backingSql.trim().replace(/;\s*$/, "");
  return `SELECT ${[...dimensions, measure].join(", ")}
     FROM (${backing}) derived_metric`;
}

/** The aggregate column for a measure. `count` ⇒ COUNT(*); others aggregate the
 *  measure expr (aliased `__m` in the relation). */
function aggregateExpr(
  agg: string,
  exprCol: string | null,
  outAlias: string,
): string {
  if (agg === "count") return `COUNT(*) AS ${outAlias}`;
  if (!exprCol) {
    throw new MetricCompileError(`agg "${agg}" requires an expr`);
  }
  switch (agg) {
    case "sum":
      return `SUM(${exprCol}) AS ${outAlias}`;
    case "min":
      return `MIN(${exprCol}) AS ${outAlias}`;
    case "max":
      return `MAX(${exprCol}) AS ${outAlias}`;
    case "count_distinct":
      return `COUNT(DISTINCT ${exprCol}) AS ${outAlias}`;
    default:
      throw new MetricCompileError(`unsupported agg "${agg}"`);
  }
}
