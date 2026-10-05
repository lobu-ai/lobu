/**
 * Kelder Coffee — an org-level CONTEXT LAYER on stock Lobu.
 *
 * A semantic layer governs the WHAT of a metric (the SQL). A context layer
 * governs the WHY: the dated business events that distort a series, the
 * versioned definition changelog, and the verified answers you can diff
 * against later. This config declares that schema; the entity/field
 * descriptions below are not decoration — they are the context agents get
 * when they touch these records, so they are written as instructions.
 *
 * No `org:` on purpose — `lobu run` auto-applies this config to the local
 * bootstrap org of the embedded server.
 */
import {
  defineAgent,
  defineAuthProfile,
  defineConfig,
  defineConnection,
  defineEntityType,
  field,
  Type,
} from "@lobu/cli/config";
import { CHURN_ROLLUP_SQL } from "./scripts/lib/env.ts";

const analyst = defineAgent({
  id: "analyst",
  dir: ".",
  name: "analyst",
  description:
    "Answers metric questions for Kelder Coffee. Must consult business-event " +
    "records and the current metric-definition version before explaining any " +
    "movement in a series — never speculate about a spike that has a governed why.",
});

/**
 * The warehouse connection, declared as config (config-as-constructor). `lobu
 * run` applies this: it installs the bundled `postgres` connector, creates an
 * authenticated, read-only connection to the fake Kelder warehouse, AND creates
 * the source-readable churn-rollup feed on it (declared below). The credential is a
 * `$VAR` reference resolved from the environment at apply time — it never lives
 * in committed code.
 */
const warehouseAuth = defineAuthProfile({
  slug: "kelder-warehouse",
  connector: "postgres",
  authKind: "env",
  name: "Kelder warehouse (read-only)",
  credentials: { DATABASE_URL: "$KELDER_WAREHOUSE_URL" },
});

const warehouse = defineConnection({
  slug: "kelder-warehouse",
  connector: "postgres",
  name: "Kelder warehouse",
  authProfile: warehouseAuth,
  // The monthly churn rollup is read live through the connector pushdown. It
  // has no schedule, so Lobu does not copy it unless a caller explicitly
  // triggers the same feed's sync operation.
  feeds: [
    {
      feed: "query",
      name: "Monthly churn rollup (live)",
      config: { query: CHURN_ROLLUP_SQL },
    },
  ],
});

/**
 * The "governed why" record. One row per thing-that-happened that a metric
 * reader must know about. This is the heart of the context layer: anomaly
 * explanations become lookups instead of archaeology.
 */
const businessEvent = defineEntityType({
  key: "business-event",
  name: "Business Event",
  description:
    "A dated, sourced record of something that changed or distorted a metric — " +
    "a data incident, a definition change, an external shock, a campaign, or a " +
    "pricing change. Before explaining any movement in a metric, check the " +
    "business events overlapping that period; if one exists, cite it (with its " +
    "source_link) instead of speculating.",
  properties: {
    event_date: field("Date", {
      description: "ISO date (YYYY-MM-DD) the event took effect.",
    }),
    event_type: field("Type", {
      enum: [
        "data_incident",
        "definition_change",
        "external_shock",
        "campaign",
        "pricing_change",
      ],
      description:
        "What kind of why this is. data_incident = the numbers are wrong (exclude/repair them); definition_change = the metric's meaning moved; external_shock = the numbers are right but the cause is external and temporary; campaign/pricing_change = self-inflicted, expected shifts.",
    }),
    affected_metrics: Type.Optional(
      Type.Unsafe({
        type: "array",
        items: { type: "string" },
        description:
          "Metric slugs this event distorts or shifts (must match a " +
          "metric-definition entity's metric slug, e.g. churn_rate).",
        "x-table-label": "Affects",
        "x-table-column": true,
      })
    ),
    expected_effect: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Operative instruction for anyone reading the affected metrics: what " +
          "the series will look like and how to treat it (e.g. 'exclude 2026-03 " +
          "from churn trend — rows are migration artifacts, not real churn').",
      })
    ),
    owner: field("Owner", {
      description: "Person or team accountable for this record being correct.",
      column: false,
      optional: true,
    }),
    source_link: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Deep link to the source of truth — incident ticket, decision doc, or " +
          "Slack thread. Always cite this when the event is used in an answer.",
      })
    ),
  },
});

/**
 * The versioned definition of a business metric. The definition text lives in
 * `definition` EVENTS attached to this entity; a new version supersedes the
 * previous one, so the current definition is the one unsuperseded event and
 * the full supersede chain is the changelog — append-only, never edited.
 *
 * The eventSets/measures/dimensions below are the DECLARED metric contract
 * (metrics_config): governed aggregations over observation events recorded in
 * Lobu, resolved to this entity via its metadata.aliases.
 */
const metricDefinition = defineEntityType({
  key: "metric-definition",
  name: "Metric Definition",
  description:
    "The governed definition of one business metric, versioned over time. Read " +
    "the current `definition` event before computing or explaining the metric; " +
    "when a month straddles a definition change, say which version was in " +
    "effect. metadata.aliases carries the metric slug so observation events " +
    "resolve to this entity.",
  properties: {
    metric: field("Metric", {
      description: "Stable metric slug, e.g. churn_rate.",
    }),
    unit: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Unit of the metric's readings (e.g. cancellations/month).",
      })
    ),
    owner: field("Owner", {
      description: "Team that owns this metric's definition.",
      column: false,
      optional: true,
    }),
    aliases: Type.Optional(
      Type.Unsafe({
        type: "array",
        items: { type: "string" },
        description:
          "Alias strings observation events use to resolve to this entity — an " +
          "observation's metadata.metric must equal one of these.",
      })
    ),
  },
  eventKinds: {
    definition: {
      description:
        "One version of this metric's definition. Save a new version with " +
        "supersedes_event_id pointing at the previous version's event — the " +
        "chain is the changelog and only the newest version stays current.",
      metadataSchema: {
        type: "object",
        properties: {
          version: {
            type: "string",
            description: "Version tag, e.g. v2.",
          },
          effective_from: {
            type: "string",
            description:
              "ISO date this version starts governing the metric. Earlier " +
              "periods stay governed by the version that preceded it.",
          },
          approved_by: {
            type: "string",
            description: "Who signed off on this version.",
          },
        },
        required: ["version", "effective_from"],
      },
    },
    observation: {
      description:
        "A periodic reading of this metric recorded in Lobu. metadata.metric " +
        "must equal one of the entity's aliases so the declared measures below " +
        "resolve it.",
      metadataSchema: {
        type: "object",
        properties: {
          metric: { type: "string", description: "Metric slug (alias match)." },
          month: {
            type: "string",
            description: "Observation month (YYYY-MM).",
          },
          cancellations: {
            type: "number",
            description: "Cancellations recorded for the month.",
          },
        },
        required: ["metric", "month", "cancellations"],
      },
    },
  },
  // Declared metric contract — compiled server-side, queryable via
  // client.metrics.query / the metric catalog. No on-read inference.
  eventSets: {
    churn_observations: {
      by: "alias",
      field: "metadata->>'metric'",
      where: "semantic_type = 'observation'",
    },
  },
  measures: {
    total_cancellations: {
      eventSet: "churn_observations",
      agg: "sum",
      expr: "(metadata->>'cancellations')::numeric",
      description: "Total recorded cancellations from internal observations.",
    },
  },
  dimensions: {
    month: {
      expr: "metadata->>'month'",
      description: "Observation month (YYYY-MM).",
    },
  },
});

/**
 * The trust loop: a question answered once, correctly, then pinned. Re-running
 * the SQL and diffing against the approved answer is the drift canary — a
 * mismatch means the warehouse (or a definition) moved and the answer needs
 * re-verification, BEFORE someone repeats a stale number in a board deck.
 */
const verifiedQuery = defineEntityType({
  key: "verified-query",
  name: "Verified Query",
  description:
    "A business question with a human-approved, pinned answer: the exact SQL " +
    "plus the result rows it produced at approval time. Prefer these over " +
    "ad-hoc SQL when one matches the question. If the drift check reports a " +
    "mismatch, treat the pinned answer as stale and flag it for " +
    "re-verification — do not silently quote either side.",
  properties: {
    question: field("Question", {
      description: "The business question this query answers, verbatim.",
    }),
    sql: {
      type: "string",
      description:
        "The exact read-only SQL that produced the approved answer. Runs " +
        "against the warehouse connection (same query the source-readable feed uses).",
    },
    approved_answer: Type.Optional(
      Type.Unsafe({
        type: "array",
        items: { type: "object" },
        description:
          "The result rows pinned at approval time. The drift canary diffs live " +
          "results against these.",
      })
    ),
    approved_by: field("Approved by", {
      description: "Who verified and approved the answer.",
      column: false,
      optional: true,
    }),
    approved_at: field("Approved", {
      description: "ISO date of approval.",
      optional: true,
    }),
  },
});

export default defineConfig({
  orgName: "Kelder Coffee",
  orgDescription:
    "Fictional coffee-subscription company demonstrating Lobu as an org-level context layer",
  agents: [analyst],
  entities: [businessEvent, metricDefinition, verifiedQuery],
  authProfiles: [warehouseAuth],
  connections: [warehouse],
});
