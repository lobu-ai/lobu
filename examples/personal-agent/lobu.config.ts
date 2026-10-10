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
import type HackerNewsConnector from "./hackernews.connector.ts";
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
import {
  tiktokResearchExecution,
  tiktokResearchPrompt,
} from "./tiktok-research.prompt.ts";
import type TikTokResearchReaction from "./tiktok-research.reaction.ts";

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
    "A personal agent that tracks people and collaborative tasks, with financial context and net-worth snapshots drawn from the user's own data.",
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
  // Keep scrape affinity: omission is an explicit unpin on reapply.
  deviceWorkerId: "2e8a0557-ddd9-48a9-913e-f476163c0cd2",
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
    // Omit maps while reusing the installed takeout definition. Installing
    // the local definition requires a runtime that supports node:fs.
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

const xAccountAuth = defineAuthProfile({
  slug: "x-browser-account-2",
  connector: "x",
  authKind: "browser_session",
  name: "X Mac mini browser account",
});

const xConnection = defineConnection({
  slug: "x-twitter-bu7emba",
  connector: "x",
  name: "X",
  // Keep the adopted connection's identity, remote feed settings and cadence.
  // Declaring config: {} would replace existing per-feed browser settings.
  // These feeds use the verified Mac mini browser account. OAuth alone does
  // not supply a browser dispatcher, even when a device pin is present.
  deviceWorkerId: "2e8a0557-ddd9-48a9-913e-f476163c0cd2",
  authProfile: xAccountAuth,
  feeds: [
    { feed: "bookmarks" },
    { feed: "my_tweets" },
    { feed: "home_feed" },
    { feed: "liked_tweets" },
  ],
});

const linkedinAccountAuth = defineAuthProfile({
  slug: "linkedin-browser-account",
  connector: "linkedin",
  authKind: "browser_session",
  name: "LinkedIn browser account",
});

const linkedinConnection = defineConnection({
  slug: "linkedin-buremba",
  connector: "linkedin",
  name: "LinkedIn",
  // Keep the verified browser account attached on reapply. A device pin alone
  // does not supply the authenticated browser session for live reads.
  deviceWorkerId: "0727b16f-a1e3-419c-96f5-d47d5c76f0bc",
  authProfile: linkedinAccountAuth,
  feeds: [
    // Apply never prunes feeds. Clear the old schedule explicitly so live
    // reads do not leave the previous periodic ingestion running.
    { feed: "home_feed", schedule: null },
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
  ],
});

const hackerNewsConnection = defineConnection({
  slug: "hackernews-buremba",
  connector: "hackernews",
  name: "Hacker News",
  // No device pin: the Algolia sync needs no browser.
  // prepare_comment staging would resolve a Chrome at call time.
  feeds: [{ feed: "front_page", schedule: "0 */3 * * *", config: {} }],
});

const spotifyAccountAuth = defineAuthProfile({
  slug: "spotify-spotify-account",
  connector: "spotify",
  authKind: "oauth_account",
  name: "Spotify Account",
});

const spotifyAppAuth = defineAuthProfile({
  slug: "spotify-oauth-app",
  connector: "spotify",
  authKind: "oauth_app",
  name: "Spotify OAuth App",
});

const spotifyConnection = defineConnection({
  slug: "spotify-buremba",
  connector: "spotify",
  name: "Spotify",
  // Both bindings are prod truth: omitting one reads as an explicit clear
  // on reapply. App credentials resolve org-first from the app profile's
  // auth_data, then host env. Fill the app profile after apply, then
  // complete OAuth in the UI against the hosted callback.
  authProfile: spotifyAccountAuth,
  appAuthProfile: spotifyAppAuth,
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
  // Keep scrape affinity: omission is an explicit unpin on reapply.
  deviceWorkerId: "2e8a0557-ddd9-48a9-913e-f476163c0cd2",
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

const worksAt = defineRelationshipType({
  key: "works_at",
  name: "Works At",
  description: "Person employed by / associated with a company",
});

const founderOf = defineRelationshipType({
  key: "founder_of",
  name: "Founder Of",
  description: "A person founded or co-founded a company.",
});

const sameAs = defineRelationshipType({
  key: "same_as",
  name: "Same As",
  description:
    "Maps a private person profile to its canonical public identity. The mapping and private profile remain visible only to this workspace.",
});

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
  // Omitted model preserves the Automation's existing execution setting on apply.
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
  // Live reads must run even though their declared source is always empty.
  triggers: [
    every("30 */3 * * *", {
      timezone: "Europe/London",
      skip_if_unchanged: false,
    }),
  ],
  sources: { none: "SELECT id FROM events WHERE false" },
  prompt: linkedInFeedFlaggerPrompt,
  reaction: reactionFromFile<typeof LinkedInFlagReaction>(
    "./linkedin-flag.reaction.ts"
  ),
});

// Keep research inference separate from the personal agent's configured models.
const tiktokResearchAgent = defineAgent({
  id: "tiktok-research",
  name: "TikTok research",
  description:
    "Manual, read-only AI teammate research with verified inbox leads.",
  providers: [
    {
      id: "openai",
      // Keep literal for the provider-ref test scan; matches tiktokResearchExecution.
      model: "gpt-5.4",
    },
  ],
});

// Manual research: prove useful leads before enabling a cadence.
const tiktokPracticalAiResearch = defineAutomation({
  agent: tiktokResearchAgent,
  slug: "tiktok-practical-ai-research",
  name: "TikTok practical AI research",
  description:
    "Manual AI teammate research with verified inspection receipts and private, deduplicated inbox leads. No TikTok writes or schedule.",
  model: tiktokResearchExecution.model,
  tags: ["tiktok", "research", "manual-preview"],
  triggers: [],
  sources: {
    manual_context: context("SELECT CURRENT_TIMESTAMP AS observed_at"),
  },
  prompt: tiktokResearchPrompt,
  reaction: reactionFromFile<typeof TikTokResearchReaction>(
    "./tiktok-research.reaction.ts"
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
    // Reuse installed takeout definitions: the local sources need filesystem
    // access unavailable in the V8 isolate. Referenced connections protect
    // their installed definitions from prune.
  ],
  org: "buremba",
  orgName: "Buremba Org",
  orgDescription:
    "Personal agent tracking people, collaborative tasks, and financial context.",
  agents: [personalAgent, tiktokResearchAgent],
  entities: [person, task],
  relationships: [worksAt, mentions, connectedWith, founderOf, sameAs],
  automations: [
    hourlyTaskCollaborator,
    duplicateEntityResolution,
    midasNetWorth,
    linkedInInterestProfile,
    linkedInFeedFlagger,
    tiktokPracticalAiResearch,
  ],
  authProfiles: [
    gmailAccountAuth,
    gmailAppAuth,
    spotifyAccountAuth,
    spotifyAppAuth,
    xAccountAuth,
    linkedinAccountAuth,
  ],
  connections: [
    midasConnection,
    marketQuotesConnection,
    revolutConnection,
    takeoutConnection,
    instagramTakeoutConnection,
    linkedinConnection,
    hackerNewsConnection,
    xConnection,
    spotifyConnection,
    gmailConnection,
  ],
});
