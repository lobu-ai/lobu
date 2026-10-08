import {
  connectorFromFile,
  context,
  defineAgent,
  defineAuthProfile,
  defineAutomation,
  defineConfig,
  defineConnection,
  defineEntityType,
  rulesFromFile,
  defineRelationshipType,
  defineSkill,
  every,
  reactionFromFile,
  scriptFromFile,
  field,
  Type,
} from "@lobu/cli/config";
import { duplicateCandidateQuery } from "./duplicate-report.reaction.ts";
import type DuplicateReportReaction from "./duplicate-report.reaction.ts";
import type GoogleTakeoutConnector from "./google-takeout.connector.ts";
import type HackerNewsConnector from "./hackernews.connector.ts";
import type InstagramTakeoutConnector from "./instagram-takeout.connector.ts";
import type LinkedInConnector from "./linkedin.connector.ts";
import type LinkedInFlagReaction from "./linkedin-flag.reaction.ts";
import {
  linkedInFeedFlaggerPrompt,
  linkedInInterestProfilePrompt,
} from "./linkedin.prompts.ts";
import type MidasConnector from "./midas.connector.ts";
import type NetWorthScript from "./net-worth.reaction.ts";
import type RevolutTransactionsConnector from "./revolut-transactions.connector.ts";
import type SpotifyConnector from "./spotify.connector.ts";
import { takeoutConfig } from "./takeout-dirs.ts";
import { taskBuilderPrompt } from "./task-builder.prompt.ts";
import type TaskBuilderReaction from "./task-builder.reaction.ts";
import type TaskRules from "./task.rules.ts";
import type TwitterTakeoutConnector from "./twitter-takeout.connector.ts";

const hourlyTaskCollaboratorSkill = defineSkill({
  name: "hourly-task-collaborator",
  content: taskBuilderPrompt,
});

const duplicateEntityResolutionRealV3FinalSkill = defineSkill({
  name: "duplicate-entity-resolution-real-v3-final",
  content:
    "Review the supplied sources.people context for this reporting-only Automation. State whether that context is complete; the reaction independently reads all candidate pages. Explain likely duplicate groups in analysis_summary and put uncertain groups in uncertain_groups with why. Names, aliases, handles, email and phone strings are candidate evidence, not proof of shared ownership. Do not call entity tools, merge contacts, or emit backlog tasks. The deterministic reaction re-reads all current candidates, saves the evidence, and sends one notification per distinct report.\n",
});

const personalAgent = defineAgent({
  id: "personal-agent",
  skills: [
    hourlyTaskCollaboratorSkill,
    duplicateEntityResolutionRealV3FinalSkill,
  ],
  dir: ".",
  name: "personal-agent",
  description:
    "A personal agent that tracks finances, people, companies, tasks, and subscriptions across the user's own data.",
  // No cloud provider key: runs on the local/Mac-app device worker and inherits
  // the org's default provider. No ANTHROPIC_API_KEY needed.
  //
  // The Revolut connector no longer makes worker-side HTTP requests to Revolut:
  // it reads the rendered DOM through the paired Owletto Chrome extension, which
  // runs inside the user's own browser (its own network context), so the worker
  // egress allowlist no longer needs `app.revolut.com` / `.revolut.com`. We keep
  // the github/npm entries that the CLI uses to compile the connector.
  network: {
    allowed: [
      "github.com",
      ".github.com",
      ".githubusercontent.com",
      "lnkd.in",
      "registry.npmjs.org",
      ".npmjs.org",
    ],
  },
});

const person = defineEntityType({
  key: "person",
  name: "Person",
  description:
    "A real-world person linked across connectors via identities (x_user_id, x_handle, wa_jid, phone, email, linkedin_slug, …). Metadata holds connector traits and optional human notes — not a CRM form.",
  metadata: { icon: "user", color: "#8B5CF6" },
  // Trait names must match connector EventAttributionRule.traits keys.
  // Identity join keys live on entity identities/aliases, not as required props.
  properties: {
    x_handle: field("X", {
      description:
        "X/Twitter @handle without @. Mutable secondary identity; primary join is x_user_id.",
      optional: true,
    }),
    x_display_name: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Display name from X profile/posts.",
      })
    ),
    last_x_interaction_at: field("Last X", {
      format: "date-time",
      description:
        "Most recent X post/like/bookmark/reply involving this person.",
      optional: true,
    }),
    last_x_dm_at: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date-time",
        description: "Most recent X DM with this person.",
      })
    ),
    push_name: field("WA name", {
      description: "WhatsApp push name.",
      optional: true,
    }),
    last_seen_at: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date-time",
        description: "Most recent WhatsApp message time for this contact.",
      })
    ),
    linkedin_url: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "LinkedIn profile URL (display trait; identity is linkedin_slug).",
      })
    ),
    position: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "LinkedIn headline/position.",
      })
    ),
    company: field("Company", {
      description:
        "Employer name as seen (LinkedIn connection + manual). Canonical identity lives in the market org's public company entity; prefer its domain or slug when known.",
      optional: true,
    }),
    last_linkedin_message_at: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date-time",
        description: "Most recent LinkedIn message with this person.",
      })
    ),
    ig_username: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Instagram username.",
      })
    ),
    instagram_profile_url: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Instagram profile URL.",
      })
    ),
    from_name: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Name as seen on inbound email.",
      })
    ),
    last_email_at: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date-time",
        description: "Most recent email from/to this address.",
      })
    ),
    email: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Email address (also an identity namespace).",
      })
    ),
    first_name: Type.Optional(Type.Unsafe({ type: "string" })),
    last_name: Type.Optional(Type.Unsafe({ type: "string" })),
    role: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Freeform role or relationship note (not a CRM enum).",
      })
    ),
  },
  // WhatsApp + X identity metrics. Declared here so `apply` preserves them
  // rather than pruning — persons alias connector identities (wa_jid, x_handle).
  eventSets: {
    wa_messages: {
      by: "alias",
      field: "metadata->>'sender_jid'",
      against: "aliases",
      where: "connector_key='whatsapp.web'",
    },
    x_posts: {
      by: "alias",
      field: "metadata->>'author_handle'",
      against: "aliases",
      where:
        "connector_key='x' AND origin_type IN ('tweet','reply','liked_tweet','bookmark')",
    },
    x_dms: {
      by: "alias",
      field: "metadata->>'participant_handle'",
      against: "aliases",
      where: "connector_key='x' AND origin_type='dm_message'",
    },
  },
  measures: {
    messages_received: {
      eventSet: "wa_messages",
      agg: "count",
      where: "metadata->>'from_me'='false'",
      description: "WhatsApp messages received from this person.",
      tier: "silver",
    },
    x_posts_seen: {
      eventSet: "x_posts",
      agg: "count",
      description:
        "X posts involving this person as author (timeline, likes, bookmarks).",
      tier: "silver",
    },
    x_dms_received: {
      eventSet: "x_dms",
      agg: "count",
      where: "metadata->>'from_me'='false'",
      description: "Inbound X DMs with this person.",
      tier: "silver",
    },
  },
  dimensions: {
    chat: {
      expr: "metadata->>'chat_jid'",
      description: "WhatsApp chat the message belongs to.",
    },
  },
  // Entity-resolution policy: a normalized email match auto-merges two persons
  // (a normalized address is a strong unique key — the same human on LinkedIn,
  // Gmail, X, etc.). Phone stays review-only: shared/work numbers collide too
  // easily to merge without a human look. Declared here so `apply` folds it into
  // the person type's metadata_schema and the duplicate-entity-resolution
  // reaction's candidate submissions auto-merge on email.
  resolutionPolicy: {
    rules: [
      { fields: ["email"], normalizer: "email", onMatch: "auto_merge" },
      { fields: ["emails"], normalizer: "email", onMatch: "auto_merge" },
      { fields: ["phone"], normalizer: "phone", onMatch: "review" },
      { fields: ["phones"], normalizer: "phone", onMatch: "review" },
    ],
  },
});

// System chat-surface unit (Slack etc.). Declared so prune does not attempt to
// delete the org's channel type while conversation ACL still depends on it.
const channel = defineEntityType({
  key: "channel",
  name: "Channel",
  description:
    "A chat channel (Slack channel, etc.) — the unit of conversation access control",
});

// Collaborative actions for Burak + personal-agent. Identity comes from the
// stable source plus a per-source task key, never editable display wording.
// Schema is owned here — the Automation does not declare an extraction schema.
const task = defineEntityType({
  key: "task",
  name: "Task",
  description:
    "An actionable item collaboratively managed by Burak and his personal agent.",
  metadata: { icon: "check-square", color: "#10B981" },
  rules: rulesFromFile<typeof TaskRules>("./task.rules.ts"),
  properties: {
    action: field("Action", {
      minLength: 1,
      description: "Concrete action to perform",
    }),
    status: field("Status", {
      enum: ["backlog", "active", "done", "dismissed"],
      description: "Collaborative task state",
    }),
    owner: field("Owner", {
      description: "Person or agent responsible",
      optional: true,
    }),
    priority: field("Priority", {
      enum: ["high", "medium", "low"],
      description: "Execution priority",
      optional: true,
    }),
    due_date: field("Due", {
      format: "date-time",
      description: "Due time when known",
      optional: true,
    }),
    source: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Where this task came from",
      })
    ),
    rationale: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Why this task is worth doing",
      })
    ),
    agent_help: Type.Optional(
      Type.Union(
        [
          Type.Object(
            {
              summary: Type.String({ minLength: 1, maxLength: 600 }),
              prompt: Type.String({ minLength: 1, maxLength: 6000 }),
            },
            { additionalProperties: false }
          ),
          Type.Null(),
        ],
        {
          description:
            "Proposed agent work for the user to review and start; null when no longer applicable.",
        }
      )
    ),
    source_event_id: Type.Optional(
      Type.Unsafe({
        type: "integer",
        description: "Originating Lobu event id (provenance, not identity)",
      })
    ),
    source_scope: {
      type: "string",
      minLength: 1,
      description:
        "Stable source namespace copied from the source row (connection, connector, or local event)",
    },
    source_origin_id: {
      type: "string",
      minLength: 1,
      description: "Stable source event identity copied from the source row",
    },
    task_key: {
      type: "string",
      minLength: 1,
      description:
        "Stable machine key for one distinct action within the source event",
    },
  },
});

// GBP-equivalent of a transaction amount, using ONLY exact, Revolut-booked
// values — never a fuzzy FX-rate lookup:
//   • native GBP                       → the amount itself
//   • foreign card payment converted   → `counterpart_amount` (the GBP side
//     Revolut actually moved; present when `counterpart_currency = 'GBP'`)
//   • multi-currency pocket spend      → NULL. There is no GBP figure on the
//     transaction (the pocket was funded earlier by a GBP→ccy EXCHANGE); the
//     GBP cost is realised on that exchange, so we deliberately don't guess
//     here. `SUM(gbp)` therefore ignores these rows rather than double-counting
//     or inventing a rate. The stored per-transaction `fx_rate` is NOT used —
//     its direction is inconsistent across currencies (USD stores ccy→GBP,
//     VND stores GBP→ccy), so `amount * fx_rate` is unsafe.
const gbpAmountSql = `CASE
    WHEN metadata->>'currency' = 'GBP' THEN nullif(metadata->>'amount', '')::numeric
    WHEN metadata->>'counterpart_currency' = 'GBP' THEN nullif(metadata->>'counterpart_amount', '')::numeric
    ELSE NULL
  END`;

// Pocket-spend fallback rate. A spend from a multi-currency pocket (USD/EUR
// charges from a USD/EUR balance) carries no per-transaction GBP — there is no
// exact figure to read. Rather than leave those costs null or invent a market
// rate, we convert at the user's OWN realised rate: the average GBP-per-unit
// across their actual conversions (rows where `counterpart_currency = 'GBP'`).
// It's their real, data-grounded rate (USD ≈ 0.76, EUR ≈ 0.85), and it self-
// updates as they transact. Returns NULL for a currency they've never converted,
// so the caller can still distinguish "estimated" from "truly unknown".
const realizedGbpRateSql = (ccyExpr: string) => `(
    SELECT round(avg(
      nullif(r.metadata->>'counterpart_amount', '')::numeric
      / nullif(nullif(r.metadata->>'amount', '')::numeric, 0)
    ), 6)
    FROM events r
    WHERE r.semantic_type = 'transaction'
      AND r.metadata->>'counterpart_currency' = 'GBP'
      AND r.metadata->>'currency' = ${ccyExpr}
      AND nullif(r.metadata->>'amount', '')::numeric > 0
      AND nullif(r.metadata->>'counterpart_amount', '')::numeric > 0
  )`;

// Spend rows we treat as real consumption: a COMPLETED outbound CARD_PAYMENT.
// This single predicate removes the three classes that polluted the old views:
//   • DECLINED / FAILED / REVERTED / DELETED states (money never moved — e.g.
//     the "Hydra" £600k was 12 DECLINED charge attempts), and
//   • TRANSFER / EXCHANGE / ATM / FEE / SAVINGS types (own-money movement, not
//     spend — e.g. "Personal → Joint", "Bought GBP with USD", "Ultra Plan Fee").
const completedCardSpendWhere = `semantic_type = 'transaction'
    AND metadata->>'state' = 'COMPLETED'
    AND metadata->>'transaction_type' = 'CARD_PAYMENT'
    AND metadata->>'direction' = 'out'`;

// One bounded, immutable weekly row is the financial read model. The inner
// top-1 uses the live-event index; the outer SUM window runs over that one row
// only and lets the existing derived-column classifier expose net_worth_gbp as
// the first-class measure without a separate metrics DSL.
const netWorthSnapshot = defineEntityType({
  key: "net-worth-snapshot",
  name: "Net Worth Snapshot",
  description:
    "Latest household balance-sheet valuation from connector positions and current observations, with weekly FX, valuation range, and deterministic attribution.",
  metadata: { icon: "wallet-cards", color: "#10B981" },
  backing: {
    sql: `SELECT
      latest.id,
      latest.week,
      latest.snapshot_at,
      SUM(latest.net_worth_gbp) OVER () AS net_worth_gbp,
      SUM(latest.net_worth_low_gbp) OVER () AS net_worth_low_gbp,
      SUM(latest.net_worth_high_gbp) OVER () AS net_worth_high_gbp,
      latest.scope,
      latest.sources,
      latest.positions,
      latest.breakdowns,
      latest.previous,
      latest.attribution
    FROM (
      SELECT
        id,
        metadata->>'week' AS week,
        occurred_at AS snapshot_at,
        (metadata->>'net_worth_gbp')::numeric AS net_worth_gbp,
        (metadata->'net_worth_range_gbp'->>'low')::numeric AS net_worth_low_gbp,
        (metadata->'net_worth_range_gbp'->>'high')::numeric AS net_worth_high_gbp,
        metadata->>'scope' AS scope,
        metadata->'sources' AS sources,
        metadata->'positions' AS positions,
        metadata->'breakdowns' AS breakdowns,
        metadata->'previous' AS previous,
        metadata->'attribution' AS attribution
      FROM events
      WHERE semantic_type = 'summary'
        AND metadata->>'schema' = 'net-worth-snapshot/v4'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) latest`,
  },
});

const account = defineEntityType({
  key: "account",
  name: "Financial Account",
  description:
    "A financial account used as the stable grain for account-level transaction metrics.",
  metadata: { icon: "landmark", color: "#10B981" },
  properties: {
    is_active: Type.Optional(
      field(
        Type.Boolean({ description: "Whether this account is active" }),
        "Active"
      )
    ),
    institution: Type.Optional(
      Type.Unsafe({ type: "string", description: "Financial institution" })
    ),
    account_type: Type.Optional(
      Type.Unsafe({ type: "string", description: "Account classification" })
    ),
  },
  // Governed spend metrics over the Revolut transaction stream. The eventSet
  // resolves a transaction to an account by matching its `currency` against the
  // account's aliases. This example assumes a single consolidated Revolut
  // account, so that one account is aliased with EVERY currency it transacts in
  // (GBP, USD, EUR, …) and owns all transactions; `currency` is then a
  // dimension, not a separate entity per pocket. Because the measure is
  // GBP-normalised, the per-account roll-up is a valid single GBP total. Aliases
  // are entity data, not schema — seed them with
  // examples/personal-agent/seed-account-aliases.sql.
  eventSets: {
    transactions: {
      by: "alias",
      field: "metadata->>'currency'",
      reads: "current",
    },
  },
  segments: {
    card_spend: {
      description:
        "Completed outbound card payments only (excludes declined/reverted charges and transfers/exchanges/ATM/fees).",
      where: completedCardSpendWhere,
      on: "event",
    },
  },
  measures: {
    spend: {
      eventSet: "transactions",
      agg: "sum",
      expr: gbpAmountSql,
      segments: ["card_spend"],
      description:
        "Total card spend in GBP. Exact only (native GBP + Revolut-booked GBP counterpart); foreign pocket spend is excluded here and accounted at the funding exchange.",
      tier: "gold",
    },
    transaction_count: {
      eventSet: "transactions",
      agg: "count",
      segments: ["card_spend"],
      description: "Number of completed card payments.",
      tier: "gold",
    },
  },
  dimensions: {
    category: {
      expr: "metadata->>'category'",
      description:
        "Revolut spend category (restaurants, groceries, travel, services, …).",
    },
    month: {
      expr: "to_char(occurred_at, 'YYYY-MM')",
      description: "Calendar month of the transaction (YYYY-MM).",
    },
    currency: {
      expr: "metadata->>'currency'",
      description: "Transaction currency (ISO 4217).",
    },
    merchant_country: {
      expr: "metadata->>'merchant_country'",
      description: "Merchant country (ISO 3166-1 alpha-2).",
    },
  },
});

// Subscriptions are derived from repeated COMPLETED card payments. We trust two
// signals, OR'd: (1) Revolut's own `is_subscription` mandate flag (high
// precision, but only on recently-detected mandates), and (2) a recurrence
// heuristic for older history — a stable monthly charge (low amount variance)
// in a subscription-like category. The category exclusion + low-variance test
// keep frequent restaurants/groceries (which the old blocklist chased by hand)
// from masquerading as subscriptions.
const subscriptionBackingSql = `
WITH card AS (
  SELECT
    occurred_at,
    occurred_at::date AS tx_date,
    max(occurred_at::date) OVER () AS data_as_of,
    coalesce(
      nullif(metadata->>'merchant_brand_id', ''),
      lower(regexp_replace(coalesce(metadata->>'description', payload_text, 'unknown'), '[^a-z0-9]+', ' ', 'g'))
    ) AS merchant_key,
    coalesce(metadata->>'description', payload_text, 'Unknown') AS merchant_name,
    nullif(metadata->>'amount', '')::numeric AS amount,
    coalesce(metadata->>'currency', 'GBP') AS currency,
    metadata->>'category' AS category,
    (metadata->>'is_subscription') = 'true' AS flagged,
    ${gbpAmountSql} AS gbp
  FROM events
  WHERE ${completedCardSpendWhere}
    AND nullif(metadata->>'amount', '') IS NOT NULL
)
SELECT
  'subscription:' || md5(merchant_key || ':' || currency) AS id,
  regexp_replace(initcap(max(merchant_name)), '\\s+', ' ', 'g') AS name,
  'subscription-' || md5(merchant_key || ':' || currency) AS slug,
  CASE
    WHEN max(tx_date) >= max(data_as_of) - interval '45 days' THEN 'active'
    WHEN max(tx_date) >= max(data_as_of) - interval '120 days' THEN 'changed'
    ELSE 'cancelled'
  END AS status,
  'subscription' AS category,
  currency,
  CASE
    WHEN count(*) <= count(distinct date_trunc('month', occurred_at)) + 2 THEN 'monthly'
    ELSE 'periodic'
  END AS frequency,
  round((array_agg(amount ORDER BY occurred_at DESC))[1], 2) AS amount,
  min(tx_date)::text AS first_seen,
  max(tx_date)::text AS last_seen,
  round(avg(extract(day from occurred_at)))::int AS billing_day,
  round(sum(amount), 2) AS total_spent,
  nullif(
    round(
      coalesce(sum(gbp), 0)
      + coalesce(sum(amount) FILTER (WHERE gbp IS NULL), 0)
        * coalesce(${realizedGbpRateSql("max(card.currency)")}, 0),
      2
    ),
    0
  ) AS total_spent_gbp,
  count(*)::int AS charge_count,
  count(distinct date_trunc('month', occurred_at))::int AS active_months
FROM card
GROUP BY merchant_key, currency
HAVING bool_or(flagged)
   OR (
     count(distinct date_trunc('month', occurred_at)) >= 4
     AND max(category) NOT IN ('restaurants', 'groceries', 'transport', 'cash', 'general')
     AND coalesce(stddev_pop(amount), 0) <= avg(amount) * 0.2
     AND count(*) <= count(distinct date_trunc('month', occurred_at)) + 2
     AND sum(amount) >= 20
   )
ORDER BY total_spent DESC
`;

const subscription = defineEntityType({
  key: "subscription",
  name: "Subscription",
  description:
    "Recurring costs and obligations derived from repeated transaction patterns",
  metadata: { icon: "🔄", color: "#EF4444" },
  backing: { sql: subscriptionBackingSql },
  properties: {
    amount: Type.Optional(
      field(Type.Number({ description: "Current charge amount" }), "Amount")
    ),
    status: field("Status", {
      enum: ["active", "cancelled", "changed"],
      description: "Current status",
      optional: true,
    }),
    category: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: ["subscription", "bill", "insurance", "membership"],
        description: "Type of expense",
      })
    ),
    currency: Type.Optional(
      Type.Unsafe({ type: "string", description: "Currency code" })
    ),
    frequency: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: ["monthly", "annual", "periodic"],
        description: "How often charged",
      })
    ),
    last_seen: field("Last Seen", { format: "date", optional: true }),
    first_seen: Type.Optional(Type.Unsafe({ type: "string", format: "date" })),
    billing_day: Type.Optional(
      Type.Unsafe({
        type: "number",
        description: "Day of month typically charged",
      })
    ),
    total_spent: Type.Optional(
      field(
        Type.Number({
          description:
            "Total charged over the tracked period, in the charge currency",
        }),
        "Total"
      )
    ),
    total_spent_gbp: Type.Optional(
      Type.Unsafe({
        type: "number",
        description:
          "Total in GBP: exact where known (native GBP + Revolut-booked GBP counterpart), and pocket charges (USD/EUR) valued at the user's own realised conversion rate",
      })
    ),
    charge_count: Type.Optional(Type.Unsafe({ type: "integer" })),
    active_months: Type.Optional(Type.Unsafe({ type: "integer" })),
  },
});

// Trips are stored from explicit travel evidence such as passport stamps.
// Related transaction/photo windows are attached through event sets below.
// Revolut auth is implicit: through the paired Owletto Chrome extension, the
// connector captures request headers from a signed-in tab and pages the retail
// API in that browser context. No secret or browser-auth profile is stored.
//
// The connection is not device-pinned; Chrome dispatch selects an online paired
// extension. `max_scrolls` is the compatibility name for its paging-batch cap.
const revolutConnection = defineConnection({
  slug: "revolut-buremba",
  connector: "revolut",
  name: "Revolut",
  feeds: [
    // Apply replaces feed config wholesale. Preserve checkpointed syncs and the
    // 60s passcode grace period within the device worker's ~95s run budget.
    {
      feed: "transactions",
      config: { max_scrolls: 20, backfill: false, wait_for_data_seconds: 60 },
    },
    { feed: "balances", config: {} },
  ],
});

// LinkedIn is also a browser connector. Unlike takeout-only connections, never
// synthesize a local path for it: a browser-only deployment must not provision
// CSV feeds that can only fail forever. Opt in with either an explicit LinkedIn
// directory or an explicitly configured shared takeout root.
const linkedinTakeoutDir =
  process.env.LINKEDIN_TAKEOUT_DIR ??
  (process.env.LOCAL_TAKEOUT_ROOT
    ? `${process.env.LOCAL_TAKEOUT_ROOT}/linkedin`
    : null);

const takeoutConnection = defineConnection({
  slug: "google-takeout-buremba",
  connector: "google.takeout",
  name: "Google Takeout Local",
  feeds: [
    {
      feed: "youtube",
      config: takeoutConfig("GOOGLE_YOUTUBE_TAKEOUT_DIR", "google-youtube"),
    },
    {
      feed: "keep",
      config: takeoutConfig("GOOGLE_KEEP_TAKEOUT_DIR", "google-keep"),
    },
    {
      feed: "maps",
      config: takeoutConfig("GOOGLE_MAPS_TAKEOUT_DIR", "google-maps"),
    },
  ],
});

const twitterTakeoutConnection = defineConnection({
  slug: "twitter-takeout-buremba",
  connector: "twitter.takeout",
  name: "X/Twitter Takeout Local",
  feeds: [
    { feed: "tweets", config: takeoutConfig("TWITTER_TAKEOUT_DIR", "twitter") },
    {
      feed: "messages",
      config: takeoutConfig("TWITTER_TAKEOUT_DIR", "twitter"),
    },
    { feed: "likes", config: takeoutConfig("TWITTER_TAKEOUT_DIR", "twitter") },
    {
      feed: "followers",
      config: takeoutConfig("TWITTER_TAKEOUT_DIR", "twitter"),
    },
    {
      feed: "following",
      config: takeoutConfig("TWITTER_TAKEOUT_DIR", "twitter"),
    },
  ],
});

const instagramTakeoutConnection = defineConnection({
  slug: "instagram-takeout-buremba",
  connector: "instagram.takeout",
  name: "Instagram Takeout Local",
  feeds: [
    {
      feed: "messages",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "connections",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "saved",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "comments",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "likes",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "media",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "story_interactions",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "searches",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "link_history",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
    {
      feed: "ads",
      config: takeoutConfig("INSTAGRAM_TAKEOUT_DIR", "instagram"),
    },
  ],
});

// One consolidated LinkedIn connection spanning BOTH sources: the local Data
// Export CSV feeds AND the live Chrome-extension feeds. Because it's a single
// connection on connector "linkedin", people met live and people in the CSV
// export dedup on the shared linkedin_slug/email identity. The stable slug is
// the config identity; runtime database ids are deliberately not hard-coded.
//
// The live home_feed reads linkedin.com/feed/ through the paired Owletto Chrome
// extension and needs no company_url. The company_updates/jobs live feeds each
// require a company_url, so add them per-company when tracking a specific page
// (e.g. { feed: "company_updates", config: { company_url: "https://www.linkedin.com/company/openai" } }).
const linkedinConnection = defineConnection({
  slug: "linkedin-buremba",
  connector: "linkedin",
  name: "LinkedIn",
  // Scrape affinity: the paired Mac mini Chrome owns the signed-in session.
  deviceWorkerId: "2e8a0557-ddd9-48a9-913e-f476163c0cd2",
  feeds: [
    // Local Data Export (CSV) feeds.
    ...(linkedinTakeoutDir
      ? [
          "messages",
          "connections",
          "invitations",
          "applied_jobs",
          "profile",
          "companies",
          "learning",
          "events",
          "endorsements",
          "media",
        ].map((feed) => ({ feed, config: { takeout_dir: linkedinTakeoutDir } }))
      : []),
    // Live Chrome-extension feed (no company_url needed). Every 3 hours; a run
    // while the paired browser is offline re-arms without a source-health failure.
    {
      feed: "home_feed",
      schedule: "0 */3 * * *",
      config: { min_scrolls: 6, max_scrolls: 10 },
    },
  ],
});

const hackerNewsConnection = defineConnection({
  slug: "hackernews-buremba",
  connector: "hackernews",
  name: "Hacker News",
  // Draft staging rides the paired Mac mini Chrome's signed-in HN session.
  deviceWorkerId: "2e8a0557-ddd9-48a9-913e-f476163c0cd2",
  // No feeds: front_page synced rows nobody reads. Re-add a feed (or a
  // live read action) when a consumer exists; the connection stays for
  // prepare_comment staging.
  feeds: [],
});

const spotifyConnection = defineConnection({
  slug: "spotify-buremba",
  connector: "spotify",
  name: "Spotify",
  // OAuth lives in the Spotify app grant (SPOTIFY_CLIENT_ID/SECRET +
  // dashboard redirect URI); nothing device-pinned here. Complete the
  // grant in the UI, then each feed syncs on its own cadence.
  feeds: [
    { feed: "saved_tracks", config: {} },
    { feed: "playlists", config: {} },
    { feed: "recently_played", config: {} },
    {
      feed: "top_tracks",
      config: { time_range: "medium_term", limit: 50 },
    },
  ],
});

const midasConnection = defineConnection({
  slug: "midas",
  connector: "midas",
  name: "Midas",
  feeds: [{ feed: "assets", config: {} }],
});

// A same-workspace execution target for market marks. It has no credentials or
// feeds: the weekly reaction receives quotes directly from its read-only action
// without persisting raw quote events.
const marketQuotesConnection = defineConnection({
  slug: "market-quotes",
  connector: "market.quotes",
  name: "Market Quotes",
  feeds: [],
});

// Remote Gmail reads reuse the existing OAuth grant. No scheduled mail copies;
// service notices remain eligible because they can contain concrete obligations.
const gmailAccountAuth = defineAuthProfile({
  slug: "personal",
  connector: "google.gmail",
  authKind: "oauth_account",
  name: "personal",
});

const gmailAppAuth = defineAuthProfile({
  slug: "google-gmail-google-app",
  connector: "google.gmail",
  authKind: "oauth_app",
  name: "Google Gmail Google App",
});

const gmailConnection = defineConnection({
  slug: "gmail-buremba",
  connector: "google.gmail",
  name: "Gmail",
  // Apply treats omitted bindings as null, so both must remain explicit.
  authProfile: gmailAccountAuth,
  appAuthProfile: gmailAppAuth,
  feeds: [
    {
      feed: "threads",
      schedule: null,
      config: {
        human_senders_only: false,
        query: "-in:spam -in:trash",
        max_results: 500,
        lookback_days: 365,
      },
    },
  ],
});

// ── Relationships (only those the personal agent uses) ──────────
// Tax-graph relationship types (account_contains, for_tax_year, …) belong in
// examples/personal-finance — not here. With prune:true they are removed from
// buremba if present.

const mentions = defineRelationshipType({
  key: "mentions",
  name: "Mentions",
  description: "Auto-discovered content reference",
});

// Graph edges created in the org (and populated with live relationships) that
// the config must declare — otherwise prune flags them "removed from config"
// and the apply aborts: the server refuses to delete a relationship type that
// still has relationship rows.
const connectedWith = defineRelationshipType({
  key: "connected_with",
  name: "Connected With",
  description:
    "Social connection observed on a platform (LinkedIn connection, mutual follow). Symmetric.",
});

// Historical social-signal entity rows still exist. Prune must retain their
// type until an explicit data migration removes them.
const socialSignal = defineEntityType({
  key: "social-signal",
  name: "Social Signal",
  description:
    "Deprecated historical entity rows from the former Social Interest Radar output path.",
  metadata: { icon: "radar" },
  properties: {
    platform: {
      type: "string",
      enum: ["x", "linkedin"],
      description: "Source platform",
    },
    author: {
      type: "string",
      minLength: 1,
      description: 'Post author (never "unknown")',
    },
    snippet: Type.Optional(
      Type.Unsafe({ type: "string", description: "Excerpt of the post" })
    ),
    why: {
      type: "string",
      minLength: 1,
      description: "Why this matches taste — specific to this item",
    },
    priority: { type: "string", enum: ["high", "normal", "low"] },
    source_origin_id: {
      type: "string",
      description: "Stable events.origin_id of the source post",
    },
    source_event_id: Type.Optional(
      Type.Unsafe({
        type: "integer",
        description: "Originating event id (unstable across re-sync)",
      })
    ),
    suggested_action: Type.Optional(
      Type.Unsafe({ type: "string", description: "Concrete next step" })
    ),
  },
  required: ["platform", "author", "why", "priority", "source_origin_id"],
});

// ── Automations (must be declared under prune or apply deletes them) ─

const midasNetWorth = defineAutomation({
  agent: personalAgent,
  // Keep the existing slug: it is the Automation's durable identity. Renaming it
  // would delete/recreate the Automation and discard its cooldown/history.
  slug: "midas-net-worth",
  name: "Weekly net worth",
  description:
    "Consolidates connector positions and current balance-sheet observations into one immutable weekly GBP snapshot with exact change attribution.",
  triggers: [
    every("0 9 * * 1", {
      timezone: "Europe/London",
      // Prices change even when the current broker position book does not.
      skip_if_unchanged: false,
    }),
  ],
  minCooldownSeconds: 300,
  tags: ["finance", "net-worth", "balance-sheet"],
  // The script reads current books itself. Context-only sources preserve the
  // valuation window instead of capping it against unrelated event arrivals.
  sources: {
    valuation_clock: context("SELECT CURRENT_TIMESTAMP AS observed_at"),
  },
  executor: scriptFromFile<typeof NetWorthScript>("./net-worth.reaction.ts"),
  reaction: null,
});

const hourlyTaskCollaborator = defineAutomation({
  agent: personalAgent,
  slug: "hourly-task-collaborator",
  name: "Hourly Task Collaborator",
  model: "chatgpt/gpt-6-astra",
  triggers: [every("0 * * * *", { timezone: "Europe/London" })],
  minCooldownSeconds: 300,
  outputs: {
    tasks: {
      entity: task,
      key: ["source_scope", "source_origin_id", "task_key"],
      name: ["action"],
    },
  },
  sources: {
    // SQL frames summarize the run-bound arrival range. The agent queries each
    // cohort using its window token; no raw-body or arbitrary task-count cap.
    arrival_frame: context(
      "SELECT connector_key, connection_id, origin_type, COUNT(*)::int AS event_count, MIN(created_at) AS first_arrival, MAX(created_at) AS last_arrival, MIN(occurred_at) AS oldest_source_time, MAX(occurred_at) AS newest_source_time, SUM(COALESCE(LENGTH(payload_text),0)) AS text_chars FROM events WHERE semantic_type NOT IN ('change','audit') AND connector_key IS DISTINCT FROM 'google.gmail' GROUP BY connector_key, connection_id, origin_type ORDER BY connector_key NULLS LAST, connection_id NULLS LAST, origin_type NULLS LAST"
    ),
    chats_frame: context(
      "SELECT platform, connection_id, channel_id, COUNT(*)::int AS message_count, MIN(created_at) AS first_arrival, MAX(created_at) AS last_arrival FROM channel_messages GROUP BY platform, connection_id, channel_id ORDER BY platform, connection_id, channel_id"
    ),
    mail: "@feed:threads",
  },
  prompt: taskBuilderPrompt,
  reaction: reactionFromFile<typeof TaskBuilderReaction>(
    "./task-builder.reaction.ts"
  ),
});

const duplicateEntityResolution = defineAutomation({
  agent: personalAgent,
  slug: "duplicate-entity-resolution-real-v3-final",
  name: "Duplicate entity resolution — real contacts",
  tags: ["identity", "deduplication", "world-model"],
  // The reaction fingerprints current evidence, including edits on old rows.
  // A source-window unchanged check cannot replace that comparison.
  triggers: [
    every("0 6 * * 1", {
      timezone: "Europe/London",
      skip_if_unchanged: false,
    }),
  ],
  sources: { people: context(duplicateCandidateQuery) },
  prompt:
    "Review the supplied sources.people context for this reporting-only Automation. State whether that context is complete; the reaction independently reads all candidate pages. Follow the pinned skill.",
  reactionsGuidance:
    "Explain uncertainty; never merge contacts or submit candidates for merging. The reaction only saves a report and notification.",
  reaction: reactionFromFile<typeof DuplicateReportReaction>(
    "./duplicate-report.reaction.ts"
  ),
  skills: ["duplicate-entity-resolution-real-v3-final"],
});

// The LinkedIn assistant runs on the same device and CLI as the hourly task
// collaborator; the paired Chrome reads LinkedIn through the extension.
const linkedInAssistantDevice = {
  deviceWorkerId: "66af4f1d-13c5-4d2d-b848-5b6b5dde7b63",
  agentKind: "claude-code",
};

const linkedInInterestProfile = defineAutomation({
  agent: personalAgent,
  slug: "linkedin-interest-profile-weekly",
  name: "LinkedIn interest profile",
  ...linkedInAssistantDevice,
  // The profile comes from the live read_my_activity action, not stored events,
  // so its source is always empty: an unchanged-source skip would never run it.
  triggers: [
    every("0 7 * * 1", {
      timezone: "Europe/London",
      skip_if_unchanged: false,
    }),
  ],
  // Declared keyed state: each run supersedes the current preference event
  // carrying the same channel+mode. Replaces the former manual
  // client.knowledge.save of a title-addressed note (no lineage) and the
  // removed voice-profile entity type. `preference` is a default $member
  // kind, so unlike a bespoke semantic type this needs no registry
  // provisioning before apply.
  outputs: {
    profiles: { event: "preference", key: ["channel", "mode"] },
  },
  sources: { none: "SELECT id FROM events WHERE false" },
  prompt: linkedInInterestProfilePrompt,
});

const linkedInFeedFlagger = defineAutomation({
  agent: personalAgent,
  slug: "linkedin-feed-flagger",
  name: "LinkedIn feed flagger",
  ...linkedInAssistantDevice,
  // Half an hour after each 3-hourly home_feed sync.
  triggers: [every("30 */3 * * *", { timezone: "Europe/London" })],
  sources: {
    posts:
      "SELECT * FROM events WHERE connector_key = 'linkedin' AND feed_key = 'home_feed' ORDER BY occurred_at DESC",
  },
  prompt: linkedInFeedFlaggerPrompt,
  reaction: reactionFromFile<typeof LinkedInFlagReaction>(
    "./linkedin-flag.reaction.ts"
  ),
});

export default defineConfig({
  // Source of truth for buremba definitions. Deletes org-owned entity /
  // relationship types and automations absent from this config (including
  // UI-created ones). Data rows, connections, auth profiles, and agents are
  // never pruned. Tax-graph types belong in examples/personal-finance only.
  prune: true,
  connectors: [
    connectorFromFile<typeof MidasConnector>("./midas.connector.ts"),
    connectorFromFile<typeof RevolutTransactionsConnector>(
      "./revolut-transactions.connector.ts"
    ),
    connectorFromFile<typeof LinkedInConnector>("./linkedin.connector.ts"),
    connectorFromFile<typeof HackerNewsConnector>("./hackernews.connector.ts"),
    connectorFromFile<typeof SpotifyConnector>("./spotify.connector.ts"),
    connectorFromFile<typeof GoogleTakeoutConnector>(
      "./google-takeout.connector.ts"
    ),
    connectorFromFile<typeof TwitterTakeoutConnector>(
      "./twitter-takeout.connector.ts"
    ),
    connectorFromFile<typeof InstagramTakeoutConnector>(
      "./instagram-takeout.connector.ts"
    ),
  ],
  org: "buremba",
  orgName: "Buremba Org",
  orgDescription:
    "Personal agent tracking finances, people, companies, tasks, and subscriptions.",
  agents: [personalAgent],
  entities: [
    person,
    task,
    channel,
    account,
    netWorthSnapshot,
    subscription,
    trip,
    goal,
    learning,
    socialSignal,
  ],
  relationships: [mentions, connectedWith],
  automations: [
    hourlyTaskCollaborator,
    duplicateEntityResolution,
    midasNetWorth,
    linkedInInterestProfile,
    linkedInFeedFlagger,
  ],
  authProfiles: [gmailAccountAuth, gmailAppAuth],
  connections: [
    midasConnection,
    marketQuotesConnection,
    revolutConnection,
    takeoutConnection,
    twitterTakeoutConnection,
    instagramTakeoutConnection,
    linkedinConnection,
    hackerNewsConnection,
    spotifyConnection,
    gmailConnection,
  ],
});
