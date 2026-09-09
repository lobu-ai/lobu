# Entity-bound metrics over the event stream

> **Status (2026-07-15):** **Shipped (v1)** — the metric compiler plus `list_metrics`/`query_metric` are live; deferred resolvers remain follow-ups.

Status: draft v7 (adds the **consumption half** — routing/discovery, segments, governance, temporal
read semantics, coverage telemetry, and an eval gate — after reviewing Snowflake Cortex Analyst
routing mode + Anthropic's "semantic layer is the required first step". v6 folded measures/dimensions
ONTO entity types — no separate "semantic model" noun; v5 simplifications still hold: no
`canonical_events`, no `amount_minor`, no microbatch engine in core).
Author: design notes from the buremba data-gap review (2026-05-29; v7 consumption pass 2026-06-15)

## TL;DR

`events` is an [Activity Schema](https://www.activityschema.com/) stream. We add metrics the way
MetricFlow/Cube do — **measures + dimensions + a join key** — but **bound to entity types**, not a
separate "semantic model" noun. Concretely, an **entity type declares:**

- `eventSets` — **how events attach to it** (the `resolves` join key, at a named grain): by
  alias-match (company), by time-window (trip), or by entity link.
- `measures` — aggregations over those resolved events (`sum/count/min/max/count_distinct`).
- `dimensions` — group-bys.
- `backing` — `table` (curated rows) or `sql` (a virtual/derived view).

**A metric = a named measure on an entity type.** **Subscriptions** are a virtual entity over a
company's spend measure; **trips/assets** are table entities with measures over their events. **Merge**
= `aliases` on the company entity (the resolver).

**Cross-source — be precise (pi v6):** an entity's events can come from many connectors, so its
measure **groups** across them for free. But that does **not** dedupe the *same real-world fact* seen
twice (a Revolut £20 Claude charge + a Gmail £20 Anthropic receipt are one charge; summing = £40).
Grouping is free via the entity; **same-fact dedupe needs a per-measure fact-identity rule** and only
matters once a measure fuses multiple sources. For buremba today (Revolut only) it doesn't bite.

**The layer has two halves (v7):** *definition* (measures/dimensions/segments over entities — covered
well below) and *consumption* (how the agent is steered into governed metrics first and kept out of
raw SQL until they can't answer — Cortex routing mode + Anthropic's required-first-step). Defining
metrics nobody is routed into is half a layer. See §Consumption & routing.

What we are NOT building (cut in v5, stays cut): a `canonical_events` projection, `amount_minor`
integer cents, the microbatch `partial`/`final`/batch-state engine, a `company_aliases` subsystem.
Materialization is an operational toggle (plain view → materialized view when slow), not a concept —
and it changes *latency*, not metric *coverage* (don't conflate; see §Coverage).

## Is this novel? (honest)

The pattern — measures/dimensions/metrics with entities as join keys — is **established**
(MetricFlow [semantic models](https://docs.getdbt.com/docs/build/semantic-models), Cube, LookML). The
only Lobu-native twist is **binding measures to entity types over an event/activity stream via a
`resolves` predicate** (alias-match / time-window / link) instead of to warehouse fact tables. That's
a sensible Activity-Schema adaptation (similar in spirit to Narrator attaching features to an entity
via temporal relationships), not an exotic invention. Low novelty risk.

## Decisions (v7 build)

Confirmed 2026-06-15 — the build is deliberately minimal:

- **Thin compiler over existing infra, no engine.** We do NOT invent metric semantics (measures/
  dimensions are the MetricFlow/Cube/LookML standard) and we do NOT embed a semantic-layer service
  (Cube/MetricFlow assume a warehouse fact table and don't model the event stream). The "engine" is a
  ~6-step SQL-string builder over `events` + `entity_types` + `buildScopedQuery` + `query_sql`
  (§Compiler). No new service, storage, planner, or cache.
- **Declarative measures, DECLARED-ONLY.** Author writes `agg`/`expr`/`eventSet`/`segment`; the
  compiler builds the SQL so dedupe/scoping/temporal are enforced once, not re-typed per measure. An
  entity is in the metric catalog **only if it declares `measures`/`dimensions`** — the on-read
  `infer-measures.ts` classification is **removed**, so a plain `backing`-SQL view with no declarations
  is just a `query_sql`-able view, not a metric. (Breaking: existing derived entities must declare to
  stay queryable as metrics.)
- **Everything lowers to a `backing`-SQL derived entity** executed by the EXISTING path
  (`entity_types.backing_sql` + `backing_source` + `runConnectorQuery` pushdown). `eventSets`/
  `measures`/`segments` are authoring sugar the compiler lowers into that SQL — no parallel engine,
  no new execution path. See §Contract.
- **Federation = derived entities + governance only.** `reflectMetrics()` returns derived entity types
  `backing`'d by live SQL over the warehouse's OWN semantic view (Snowflake `SEMANTIC_VIEW()` / dbt),
  plus `measures`/`dimensions` maps that DECLARE classification + carry descriptions. The warehouse
  stays source of truth; Lobu federates, never re-implements. See §Contract B.
- **One canonical producer per source — no re-authoring (pi).** "Producer" = provenance, not a
  competing definition, else this recreates the "forty definitions of revenue" the layer exists to
  kill. The rule: event-stream metric → `eventSets`+`measures`; warehouse-governed metric →
  `reflectMetrics()` (a native metric is NEVER re-authored in Lobu — fork under a new name if you must
  diverge); hand-written `backing.sql` → only for derived/post-aggregate/ratio/recurrence entities, and
  it must reference existing metrics via `measure()` rather than reimplement their filters.
- **Collision = reject unless explicit override.** `{source, entity, measure}` is unique. A local
  definition that shadows a connector-reflected (or otherwise existing) one is a **hard apply-time
  error** unless it declares `overrides: <source>`; collisions never resolve silently. (Settles
  open-question #5.)
- **Narrowed v1 resolver (pi).** v1 ships the `alias` resolver only, plus derived `backing.sql`
  (subscription, asset_candidate); `window`+`link` and `factIdentity` are deferred (window rides with
  the deferred `trip`). The "6-step string builder" undersells real complexity (alias matching, dedupe
  ordering, temporal reads, scope wrap, lineage) — keep predicates raw SQL internally but
  **parse/validate/org-scope them, never trust them**.
- **Declared-only needs a migration path, not a blind cut (pi).** Inventory current inferred measures →
  generate suggested `measures`/`dimensions` declarations → warn before removal → keep `query_sql`
  access to the old views → remove inference only from `query_metric`/the catalog, not from developer
  diagnostics.
- **Authored in `lobu.config.ts`** (code-reviewed, colocated with the agent + SKILL.md; CI enforces
  `description`). No web-UI write path in v1.
- **v1 scope = `company.spend` + `subscription` + `asset_candidate` over Revolut events** (alias
  resolver + derived SQL), proven against the pinned golden numbers. **`trip` + the `window` resolver
  are deferred to a fast-follow** (window is the overcounting-prone piece; not launch-critical). The
  connector-SDK warehouse-metric path still ships in v1 as the extension point (§Connectors), so
  warehouse metrics are right from day one.
- **Hand-roll the SQL-gen now, behind a Malloy-ready seam.** Prior art backs building thin: Anthropic
  and Snowflake both *built* a thin governed layer (Anthropic's compiled measures/dimensions/segments;
  Snowflake's `SEMANTIC_VIEW()`) rather than depend on a metric engine. So v1's compiler step 5/6
  (aggregate + emit SQL) lives behind an interface. When cross-entity joins make fan-out double-count
  a real bug, or warehouse federation needs multi-dialect SQL, [Malloy](https://malloydata.dev)
  (`@malloydata/malloy` — a TS library, no server; gives symmetric-aggregate safety + Postgres/
  Snowflake/BigQuery dialects) can drop in as the backend without touching the resolver, catalog, or
  config. Not a v1 dependency.

## The model

```ts
defineEntityType({
  key: string,
  backing: "table" | "sql",
  properties?: Schema,                  // table: curated columns

  // NAMED EVENT SETS = how events attach to this entity (the join key) AT AN EXPLICIT GRAIN.
  // An entity can resolve events in several roles/grains (merchant vs employer; txn vs line-item),
  // so the grain is named — not "all events that resolve" — else dimensions are ambiguous (pi v6 #1).
  eventSets?: Record<string, {
    from: "events",
    by: "alias" | "window" | "link",
    //  alias:  field ∈ <entity>.aliases     window: occurred_at ∈ [start,end]     link: events[].entity_ids
    field?: SqlExpr, against?: "aliases",                              // by:"alias"
    start?: string, end?: string, cardinality?: "one_trip_per_event", // by:"window" (MUST be constrained)
    where?: Predicate,                                                 // scope the grain explicitly
    reads?: "current" | "raw" | { asOf: string },                     // temporal truth (default "current"); see §Temporal
    dedupeKey?: SqlExpr[],                                             // same-source identity (DISTINCT tuple)
    factIdentity?: FactMatchRule,                                      // cross-source identity (deferred; see §Fact identity)
  }>,

  measures?: Record<string, {
    eventSet: string,                                                 // binds to a named grain (REQUIRED)
    agg: "sum"|"count"|"min"|"max"|"count_distinct",
    expr?: SqlExpr, where?: Predicate, segment?: string,              // segment = reusable named filter (below)
    description: string,                                              // REQUIRED — powers keyword discovery
    owner?: string, tier?: "gold"|"silver"|"bronze", freshness?: string,  // governance metadata
  }>,
  dimensions?: Record<string, { expr: SqlExpr, description: string }>,

  // reusable named population filters; the agent is told to ALWAYS check these (Anthropic "segments"):
  segments?: Record<string, {
    description: string,
    where: Predicate,
    on: "event" | "entity",                                          // grain the filter applies at
    appliedBefore?: "dedupe" | "aggregate",                          // ordering vs dedupe is load-bearing
  }>,

  // sql-backed (virtual) entities are a query (often over another entity's measures):
  sql?: Sql,
});
```

- A **measure** binds to a **named event set** (the resolved-fact grain), not just "all events that
  resolve to the entity" (pi v6 #1). An entity can resolve events in different roles/grains (company
  as *merchant* vs *employer* vs *mentioned-in-email*; transaction-level vs receipt-line-item), so the
  grain must be explicit — otherwise dimensions are ambiguous and aggregates fan out. `company.spend`
  = `sum(amount)` over the `charges` event set (bank transactions resolved by alias). `trip.cost` =
  `sum(amount)` over the trip's windowed transactions.
- A **metric** is just a named measure (derived/ratio metrics compose later: `metric: a / b`).
- **Cross-source**: `company`'s resolved events can be Revolut *and* Gmail receipts → `company.spend`
  fuses them. The entity is the join key; no `canonical_events`. (Aliases are what make a Gmail
  "Anthropic Inc." and a Revolut "Claude.ai" resolve to the same company — that's why the merge
  matters: it lines up the cross-source join key.)
- **backing** chosen by curation need: company/trip/asset = `table` (you curate); subscription =
  `sql` (pure derivation).

## End-to-end (buremba)

```ts
// COMPANY — table entity; the join key; carries spend measures over events resolved by alias
defineEntityType({
  key: "company", backing: "table",
  properties: { name: {}, aliases: { type: "array" } },         // ["Claude.ai","Anthropic","CLAUDE"]
  // named event set = the resolved-fact grain a measure aggregates over:
  eventSets: {
    charges: { from: "events", by: "alias", field: "metadata.description", against: "aliases",
               where: { connector_key: "revolut" },             // scope the grain explicitly
               dedupeKey: ["metadata.date", "metadata.amount", "metadata.description"] },
  },
  measures: {
    spend:       { eventSet: "charges", agg: "sum", expr: "(metadata.amount)::numeric", where: { "metadata.direction": "out" } },
    charges:     { eventSet: "charges", agg: "count", where: { "metadata.direction": "out" } },
    last_charge: { eventSet: "charges", agg: "max", expr: "metadata.date" },
  },
  dimensions: { currency: "metadata.currency", month: "month(metadata.date, tz)" },
});

// SUBSCRIPTION — derived (sql) entity: companies whose spend recurs >= 3 months.
// Under DECLARED-ONLY it MUST declare measures/dimensions over its view's columns (no inference).
defineEntityType({
  key: "subscription",
  backing: { sql: `
    SELECT company_id, currency, ${measure("company.spend")} AS total,
           ${measure("company.charges")} AS charge_count, count(distinct month) AS months
    FROM ${entity("company")} GROUP BY company_id, currency
    HAVING count(distinct month) >= 3` },
  measures: {
    total:        { eventSet: "self", agg: "sum", expr: "total", description: "Recurring spend total." },
    charge_count: { eventSet: "self", agg: "sum", expr: "charge_count", description: "Charges across the run." },
  },
  dimensions: { currency: { expr: "currency", description: "Subscription currency." } },
});

// TRIP — table entity; events resolve by time-window; cost is its measure
defineEntityType({
  key: "trip", backing: "table",
  properties: { destination: {}, start_date: {}, end_date: {} },
  // window resolver MUST be constrained (pi v6 #3): a raw date window wrongly grabs a London direct
  // debit that happened mid-trip, and overlapping trips would double-attach. Filter by type, and
  // forbid an event attaching to >1 trip; for trips, geo/foreign-currency is the real signal.
  eventSets: {
    spend: { from: "events", by: "window", start: "start_date", end: "end_date",
             where: { connector_key: "revolut", "metadata.currency": "!= home_currency" },  // foreign spend
             cardinality: "one_trip_per_event" },
  },
  measures: { cost: { eventSet: "spend", agg: "sum", expr: "(metadata.amount)::numeric", where: { "metadata.direction": "out" } } },
  dimensions: { currency: "metadata.currency" },
});

// ASSET — table entity (high judgment); a sibling sql "asset_candidate" view surfaces big one-off buys
defineEntityType({ key: "asset", backing: "table",
  properties: { category: {}, value: {}, company_id: {}, acquired: {} } });
```

What each produces (mechanism re-validated read-only on prod buremba 2026-06-15 — **figures move as the
append-only stream grows**, which is why the eval pins an `asOf`; see §Validation):

- `company "Anthropic" { aliases:["Claude.ai","Anthropic","CLAUDE"] }` → `company.spend` (deduped,
  `direction=out`, grouped by currency) = **GBP £1,222.83 / 27 charges / 9 months (Oct 2024–Apr 2026)**
  + USD $152.83 / 5 charges. (The 2026-05-29 snapshot was £1,006.83/35 — same SQL, fewer months of
  data. Note: prod `company` rows are currently email-domain-derived; the alias-merged "Anthropic" is
  the curation this design enables, not an entity that exists in prod yet.)
- `subscription` → Ultra £1,195/22mo, **Anthropic £1,006.83/9mo**, Apple £618.86 (55 deduped vs 64
  raw), Cursor, Hyperoptic, RAVE Coffee.
- `trip "Vietnam" {start:2026-02-06, end:2026-02-23}` → `trip.cost` = **₫35.06M + $14.7k + £3.3k**;
  120 photos geotagged Vietnam in-window corroborate.
- `asset_candidate` → Ruth Tomlinson jewelry, Warren Evans beds, Hydrow rower (you confirm category).

## Contract (v7) — authoring, federation, seam

The §End-to-end snippets above are illustrative; these are the **authoritative shapes**, fitted to the
real types (`packages/cli/src/config/define.ts:51` `EntityType`/`EntityBacking`; predicates are raw SQL
strings, not objects). All fields are additive to today's `EntityType`.

**A. Authoring** — added to `interface EntityType`:

```ts
eventSets?:  Record<string, EventSet>;    // how events resolve to this entity, at a NAMED grain
measures?:   Record<string, Measure>;     // governed aggregations (DECLARED — no inference)
dimensions?: Record<string, Dimension>;   // governed group-bys
segments?:   Record<string, Segment>;     // reusable named filters

interface EventSet {
  by: "alias" | "window" | "link";
  field?: string; against?: "aliases";                            // by:"alias"
  start?: string; end?: string; cardinality?: "one_per_event";    // by:"window"
  where?: string;                                                 // scope the grain (raw SQL predicate)
  reads?: "current" | "raw" | { asOf: string };                   // default "current"; §Temporal
  dedupeKey?: string[];                                           // same-source identity
  factIdentity?: FactMatchRule;                                   // cross-source (deferred no-op)
}
interface Measure   { eventSet: string; agg: "sum"|"count"|"min"|"max"|"count_distinct";
                      expr?: string; where?: string; segment?: string;
                      description: string; owner?: string; tier?: "gold"|"silver"|"bronze"; }
interface Dimension { expr: string; description: string; }
interface Segment   { description: string; where: string; on: "event"|"entity";
                      appliedBefore?: "dedupe"|"aggregate"; }
```

`company.spend` (lowers to the deduped/grouped `backing` SQL re-validated at GBP £1,222.83):

```ts
defineEntityType({
  key: "company",
  properties: { name: {}, aliases: { type: "array" } },
  eventSets: { charges: { by: "alias", field: "metadata->>'description'", against: "aliases",
      where: "semantic_type='transaction' AND connector_key='revolut'", reads: "current",
      dedupeKey: ["metadata->>'date'","metadata->>'amount'","metadata->>'description'"] } },
  segments: { outflow: { description: "Money leaving the account.",
      where: "metadata->>'direction'='out'", on: "event", appliedBefore: "dedupe" } },
  measures: {
    spend:   { eventSet: "charges", agg: "sum", expr: "(metadata->>'amount')::numeric",
               segment: "outflow", description: "Total outflow to this company, by currency.", tier: "gold" },
    charges: { eventSet: "charges", agg: "count", segment: "outflow", description: "Distinct charges." } },
  dimensions: {
    currency: { expr: "metadata->>'currency'", description: "Charge currency (never sum across)." },
    month:    { expr: "to_char((metadata->>'date')::date,'YYYY-MM')", description: "Calendar month." } },
});
```

**B. Federation** — a new OPTIONAL hook on the `defineConnector` spec (beside `feeds`/`actions`/
`query`/`authenticate` in `packages/connector-sdk`). Connectors today contribute only `event_kinds`;
this lets them contribute entity types:

```ts
reflectMetrics?(ctx: ReflectContext): Promise<EntityTypeContribution[]>;

type EntityTypeContribution = {
  key: string; name?: string; description?: string;
  backing: { sql: string; connection: string };                  // LIVE against the warehouse
  freshness?: string;                                            // native refresh cadence (drift signal)
  measures: Record<string, {
    description: string; tier?: Tier; owner?: string;
    grain: string;                                               // native grain (pi) — e.g. "order" vs "order_line"
    safeDimensions?: string[];                                   // dims valid WITH this measure (else fan-out)
  }>;
  dimensions?: Record<string, { description: string }>;
};
```

Reflecting a Snowflake semantic view (the `SEMANTIC_VIEW()` Cortex routing-mode targets):

```ts
async reflectMetrics(ctx) {
  return [{
    key: "orders",
    description: "Federated from Snowflake semantic view ANALYTICS.ORDERS.",
    backing: { connection: "snowflake",
      sql: `SELECT * FROM SEMANTIC_VIEW(ANALYTICS.ORDERS
              DIMENSIONS customer.market_segment, orders.order_month
              METRICS orders.order_count, orders.order_average_value)` },
    measures:   { order_count: { description: "Count of orders.", tier: "gold" },
                  order_average_value: { description: "Avg order value.", tier: "gold" } },
    dimensions: { market_segment: { description: "Customer market segment." } },
  }];
}
```

Executed via the EXISTING `runConnectorQuery` pushdown (`packages/server/src/lib/connector-pushdown.ts`)
→ the connector's `query()` hook. No new execution path; the warehouse stays source of truth.

**C. Compiler seam** (Malloy-ready):

```ts
interface MetricCompiler {
  resolve(entity: EntityType, eventSet: string, o: { reads: ReadMode; segment?: string }): BaseRelation; // steps 1–4, never moves
  aggregate(base: BaseRelation, measure: Measure, by: string[]): Sql;                                     // steps 5–6, THE SEAM
}
```

`infer-measures.ts` is removed — classification comes from the declared `measures`/`dimensions` maps in
both A and B.

## Connectors contribute entity types (Snowflake etc.)

A connector can ship entity types (with `eventSets`/`measures`) over its data. For event connectors
(Revolut) it's measures over events. For a **warehouse connector (Snowflake)** the connector's tables
*are* the entities — it contributes entity types whose eventSet is `from: "table:<x>"` and whose
measures are columns. The compiler treats both identically (the only difference is the eventSet
source: `events` vs `table:…`), so discovery/routing/catalog stay uniform across sources.

**The SDK must FEDERATE warehouse-defined metrics, not force re-authoring them (this is what makes it
"right").** A warehouse usually already has a governed semantic layer — Snowflake semantic views (the
`SEMANTIC_VIEW()` Cortex routing-mode queries), dbt MetricFlow metrics, Cube. Re-typing those as Lobu
measures would create exactly the "forty plausible definitions of revenue" drift the layer exists to
kill. So the connector SDK exposes two tiers:

- **Reflect/import (primary for warehouses):** the connector maps the warehouse's *native* metric
  definitions onto Lobu entity types — a `reflectMetrics()` hook that returns measures/dimensions
  pointing at `SEMANTIC_VIEW(...)` / the dbt metric / the Cube query. Lobu's catalog *federates* them;
  `query_metric` compiles a thin scoped wrapper and pushes down (the existing `query_sql` `connection`
  pushdown is the substrate). The warehouse stays the source of truth for its own metrics.
- **Declare (baseline / event connectors):** a connector with no native semantic layer declares
  Lobu-style measures directly, same as a config author.

v1 ships this SDK surface even though the first cut's data is buremba/Revolut, so warehouse metrics
slot in without a schema change. Connector-shipped entity types are overridable org defaults.

## Consumption & routing (semantic-first)

Defining measures is half the layer; the other half is the **consumption contract** — how the agent
reaches governed metrics first and stays out of raw SQL until they genuinely can't answer. This is the
shared lesson of Cortex routing mode and Anthropic's required-first-step; the prior draft was silent
on it. Today `query_sql` is the only data path (`packages/server/src/tools/registry.ts`), always
available with a generic description — so an agent free-form-SQLs `events` and silently re-derives (or
mis-derives) "spend", defeating the governed measure.

**Discovery + query tools — the agent never hand-writes SQL for a governed metric:**

- `list_metrics(entity?, q?)` / `describe_entity(entity)` — keyword-searchable catalog returning
  measures, dimensions, and segments **with their `description`s** (that is why `description` is
  required on every measure/dimension). Anthropic: "search measures and dimensions by keyword."
- `query_metric({ entity, measure, by?: dimension[], segment?, range? })` — the agent supplies
  *names*, not SQL; the tool compiles and executes.

**`query_metric` is a compiler, not a passthrough.** It *uses* `buildScopedQuery`
(`packages/server/src/utils/execute-data-sources.ts:358`) for org-scoping and table exposure — that is
the **substrate, not the whole job**. On top of it the compiler owns: resolving the named eventSet to
its events, supersession masking (§Temporal), dedupe-before-aggregate, applying segments at the right
grain, grouping at the declared dimension grain, and emitting lineage. Treating `buildScopedQuery`
*as* the metric compiler would be wrong.

**The compiler is a pure `(entityDef, request) → SQL` function — minimal, no planner, no cache.** It
is a fixed 6-step template, not a query optimizer; that is the whole point of "scalable and minimal":

1. **Look up** `measures[request.measure]` on the entity → its `eventSet`, `agg`, `expr`, `where`.
2. **Resolve the eventSet** to a base CTE over the chosen temporal source (§Temporal):
   `current_event_records` (default), `events` (raw), or `events` ≤ ceiling (`asOf`). Attach by
   `alias` (description ∈ `entity.aliases`), `window` (`occurred_at ∈ [start,end]` + its constraints),
   or `link` (`entity_ids @> entity.id`).
3. **Dedupe** — `SELECT DISTINCT <dedupeKey>` (before aggregate). Single-source only; cross-source is
   the deferred `factIdentity` step (§Fact identity), a no-op until a measure fuses sources.
4. **Segment** — AND the named `segments[request.segment].where` at its declared grain, ordered by
   `appliedBefore` (before dedupe vs before aggregate).
5. **Aggregate** — `agg(expr) … WHERE measure.where GROUP BY <request.by dimensions>`.
6. **Scope** — hand the assembled SQL to `buildScopedQuery` for the org CTE wrap + param binding.

**The compiled artifact is per `(entity, eventSet)`** (pi) — the resolved, `reads`-masked, deduped
event relation (steps 1–4). `measures`/`dimensions`/`segment`/`range` are NOT baked into it;
`query_metric({ measure, by, segment, range })` parameterizes the aggregate + group-by + filter on top
of that relation at call time (steps 5–6). So: one base relation per grain, not per measure and not per
query — which is also why a `(entity, eventSet)` relation is the unit that flips to a materialized view.

No new tables, no materialization in the core path; a slow measure flips to a materialized view
(§Materialization) without touching the compiler. The compiler stays a string-builder. **Steps 5–6
(aggregate + emit SQL) sit behind one interface** — that is the seam a metric engine (Malloy) can
replace later for symmetric-aggregate safety + multi-dialect output; steps 1–4 (Lobu-native resolve/
temporal/dedupe/segment) are ours regardless and never move (see Decisions).

**Routing is soft but instrumented.** `query_sql` stays available — it fails open and ad-hoc
questions are legitimate. The contract steers metrics-first via tool descriptions + agent-policy rules
(`packages/core/src/agent-policy.ts` `TOOL_RULES`, surfaced through the turn
system prompt in `packages/server/src/gateway/orchestration/agent-turn-producer.ts`): *if a `query_metric` covers the ask, use it;
reach for `query_sql` only when no measure/dimension does — and then pass an explicit `reason`.* That
fallback is logged as a **semantic miss** (§Coverage). This is the cheap middle between pure
prompt-nudging (which agents ignore) and hard gating (which blocks legitimate ad-hoc work).

**"Don't bail early" (Anthropic) — pre-empt the agent's excuses to skip the layer:**

| Agent thinks it needs… | Already covered by |
|---|---|
| a custom date range | the time dimension + `range` arg |
| a join to another entity | the eventSet resolver / `measure()` refs (the join lives in the definition) |
| a cohort / sub-population | a **segment** |
| dedupe of double-ingests | the eventSet `dedupeKey` (applied before aggregate) |

## Temporal semantics (append-only reads)

`events` is append-only; superseded rows are tombstoned and `current_event_records` masks them. A
metric over a moving, late-arriving stream is ambiguous unless it declares **which truth it reads**:

- `reads: "current"` (default) — over `current_event_records`; corrections, supersessions, and
  alias-merges change *past* metric values. This is what buremba wants (latest truth).
- `reads: "raw"` — over `events` verbatim, including superseded rows (audit/debug only).
- `reads: { asOf: <ts> }` — point-in-time snapshot; stable under late arrivals.

This is a correctness class warehouse semantic layers (Cortex) never face — they sit on one curated,
slowly-changing fact table. Lobu's stream means **late events, supersession, alias edits, entity
merges/splits, and overlapping windows can retroactively move a number**; `reads` makes that explicit
per eventSet instead of an unstated default.

## Governance & colocation

Per Anthropic, metadata is a first-class product, not an afterthought:

- Every measure/dimension carries a `description` (powers discovery) and optional `owner`, `tier`
  (gold/silver/bronze), `freshness`/grain note. The catalog surfaces these so the agent picks the
  *governed* metric instead of re-deriving its own — collapsing "revenue → one dataset, not forty".
- **Colocation:** metric defs live in `lobu.config.ts` beside the agent and its `SKILL.md` — Lobu's
  analog of Anthropic's single versioned repo (model + metric + docs together; ~90% of their
  data-model PRs also touch skill docs). The PR that changes a measure updates the SKILL.md that
  documents it.
- **CI guardrail:** fail review if any measure/dimension is missing a non-empty `description`.

## Coverage & observability (the loop that makes routing work)

Cortex's real lesson is not "prefer semantic SQL" — it is **measure the fallback and grow coverage**
(~10% of their queries hit the semantic path, scaling with metric coverage). Without this loop the
layer is write-once documentation an agent may ignore.

- Log every `query_metric` hit and every `query_sql` **semantic miss** (with its `reason`).
- Track the **fallback rate** and the top missed asks — that list *is* the work-queue for new
  measures.
- **Coverage** (more measures answering real asks) shrinks fallback; **materialization** only changes
  latency. Keep them separate.

## Validation & eval (semantic layer in isolation → ~100%)

Anthropic gates on the semantic layer scoring ~100% **in isolation** before agents consume it. The
buremba numbers in §End-to-end become **golden fixtures**, not asserted prose:

- **Goldens MUST pin `reads: { asOf }`** (or a fixed event-id ceiling). Proof this is mandatory: the
  same `company.spend` SQL returned £1,006.83/35-charges on 2026-05-29 and £1,222.83/27-charges on
  2026-06-15 — not a bug, just more months of an append-only stream. A live `current` golden can never
  stay green; an `asOf`-pinned one is deterministic.
- Reuse the seed→prompt→DB-check shape of `examples/lobu-crm/evals/tool-surface/`; assert the pinned
  `company.spend`, the Vietnam `trip.cost`, the Apple deduped count, etc.
- Any change to an eventSet predicate, `dedupeKey`, or `segment` must keep the goldens green — that is
  what stops silent drift, and it is the gate before the agent is routed into the layer.

## Materialization & scale (orthogonal)

A `sql`-backed entity / a measure is a view by default (live; fine at buremba's ~3k-row scale). If one
gets slow, flip it to a **materialized view with a scheduled refresh** — an ops toggle, no new
concept. The full incremental microbatch engine (per-batch overwrite, lookback, dirty flags) is the
*implementation* of that toggle for large/hot entities; it lives in an appendix, not the core, and is
only reached for if a materialized-view refresh is too coarse.

## Dedupe, fact identity, currency, lineage

- **same-source dedupe** (Revolut double-ingests) = `dedupeKey: [date, amount, description]` →
  `SELECT DISTINCT` inside the measure, applied **before aggregate**. Plain SQL, not a subsystem.
- **cross-source fact identity (deferred — the boundary of this draft).** A Revolut £20 charge and a
  Gmail £20 receipt are *one* fact; summing = £40. This is not a single-column `dedupeKey` but **fact
  modeling**: grain reconciliation (transaction vs receipt vs line-item), source field normalization
  (Revolut `metadata.amount` vs a parsed Gmail total), a match rule with tolerances (date±, amount,
  merchant) + source priority + provenance/confidence, and auditability of what was merged/excluded.
  It becomes load-bearing at the **first multi-source measure**; it does not bite buremba
  (Revolut-only) today, so v7 names the `factIdentity` slot on eventSets and **defers the matcher**.
  Neither Cortex nor warehouse layers solve this (they assume one curated fact table per concept) —
  Lobu is on its own here. **Shape now so the eventSet schema needs no breaking change later** (impl
  deferred — it is a no-op until a measure has >1 source):

  ```ts
  type FactMatchRule = {
    // normalize heterogeneous source fields to a common fact tuple before matching:
    key: { amount: SqlExpr; date: SqlExpr; merchant?: SqlExpr };   // per-source field map
    tolerance?: { date?: string; amount?: number };                // e.g. date "±2d", amount 0.0
    prefer?: string[];                                             // source priority (e.g. ["revolut","gmail"])
    // result carries provenance: which source events were merged / dropped (auditability).
  };
  ```

  The compiler's dedupe step (§Compiler) is where this slots in: same-source `dedupeKey` today, this
  cross-source matcher when the first multi-source measure ships. No other schema moves.
- **currency** is a dimension; never sum across currencies without an explicit FX metric.
- **lineage** = `entity()`/`measure()` are real refs → a DAG (subscription → company → events).

## Open questions

**Resolved in v7:**

1. `resolves` predicate set — **alias/window/link + segments is enough**; arbitrary join predicates
   stay out (power, but reintroduces the complexity v5 cut). Cohorts that felt like they needed
   arbitrary joins are segments.
2. Measure spanning connectors with different field names — **folded into the deferred `factIdentity`
   rule** (§Fact identity), not a global field-map table. Single-source stays on `dedupeKey`.
6. Table-entity measure compute (trip.cost) read-time vs cache — **read-time by default** (live view);
   the `reads` temporal mode (§Temporal) plus the materialize-when-hot toggle (§Materialization) cover
   the cache case. Coverage, not caching, is the real lever.

4. Recurrence (`HAVING months>=3`) — **NOT a segment.** Segments are pre-aggregate row filters;
   recurrence is a *post-aggregate* predicate over `count(distinct month)`. It stays in the
   `subscription` derived-entity `sql` (a `HAVING`). If reuse is needed elsewhere, expose it as a
   derived boolean measure `company.is_recurring`, not a segment. (Decision 2026-06-15; corrects the
   earlier lean — caught by pi's "segments need scope and grain".)

5. Connector-shipped entity-type override semantics — **resolved: reject on `{source, entity, measure}`
   collision unless the local def declares `overrides: <source>`** (no silent shadow, no fork-only
   restriction). See Decisions. (2026-06-15.)

**Still open:**

3. Virtual-entity ids for links/annotations (subscription rows are derived) — deterministic id from
   the group key, or ephemeral? (Leans deterministic so annotations can attach.)

## Appendix — incremental microbatch engine (deferred implementation of "materialize when hot")

Per-batch `DELETE+INSERT` over a tombstone-masked view, advanced by a lease, with a `lookback` +
dirty-batch invalidation; portable to Iceberg via partition overwrite. Only needed when a
materialized-view refresh is too coarse for a large/hot entity. Not part of the core model.
