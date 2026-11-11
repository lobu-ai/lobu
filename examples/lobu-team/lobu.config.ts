import {
  connectorFromFile,
  context,
  defineAgent,
  defineAuthProfile,
  defineAutomation,
  defineConfig,
  defineConnection,
  defineEntityType,
  defineRelationshipType,
  every,
  reactionFromFile,
  Type,
} from "@lobu/cli/config";
import type ClickHouseAnalyticsConnector from "./clickhouse-analytics.connector.ts";
import type DataForSeoConnector from "./dataforseo.connector.ts";
import type IssueTrackerReaction from "./issue-tracker.reaction.ts";
import { productUsers } from "./product-users.ts";

// One backlog type for every kind of team work, written by people and agents.
// The organic acquisition review Automation reads the `seo` kind as its backlog
// and can link each report to the SEO tasks it covers. The Automation and its
// `seo.review` report kind are maintained in the workspace: the Automation is
// not bound to an entity, so the kind is declared on the workspace member type.
const task = defineEntityType({
  key: "task",
  name: "Task",
  description:
    "A unit of team work: a bug, feature, SEO, content or operations task with its status and what done means.",
  properties: {
    kind: Type.Unsafe({
      enum: ["bug", "feature", "seo", "content", "ops"],
      type: "string",
      title: "Kind",
      "x-facet": true,
      "x-table-column": true,
    }),
    status: Type.Unsafe({
      enum: ["open", "in_progress", "review", "done", "blocked", "deferred"],
      type: "string",
      title: "Status",
      "x-lobu": { role: "workflowState" },
      "x-facet": true,
      "x-table-column": true,
    }),
    priority: Type.Optional(
      Type.Unsafe({
        enum: ["high", "medium", "low"],
        type: "string",
        title: "Priority",
        "x-facet": true,
        "x-table-column": true,
      })
    ),
    summary: Type.Optional(
      Type.Unsafe({
        type: "string",
        title: "Summary",
        description: "What the work is and why it matters",
      })
    ),
    acceptance: Type.Optional(
      Type.Unsafe({
        type: "string",
        title: "Acceptance",
        description: "What done means and how it is verified",
      })
    ),
    next_action: Type.Optional(
      Type.Unsafe({ type: "string", title: "Next action" })
    ),
    area: Type.Optional(
      Type.Unsafe({
        type: "string",
        title: "Area",
        description:
          "Narrower area within the kind, such as onboarding or measurement for SEO work",
      })
    ),
    github_issue: Type.Optional(
      Type.Unsafe({ type: "integer", title: "GitHub issue", minimum: 1 })
    ),
    github_pr: Type.Optional(
      Type.Unsafe({ type: "integer", title: "GitHub pull request", minimum: 1 })
    ),
    branch: Type.Optional(Type.Unsafe({ type: "string", title: "Branch" })),
    url: Type.Optional(
      Type.Unsafe({
        type: "string",
        title: "Link",
        format: "uri",
        description: "Primary page or resource the work targets",
      })
    ),
    evidence_urls: Type.Optional(
      Type.Unsafe({
        type: "array",
        items: { type: "string", format: "uri" },
        title: "Evidence",
      })
    ),
    observed_at: Type.Optional(
      Type.Unsafe({
        type: "string",
        title: "Last observed",
        format: "date-time",
      })
    ),
    confidence: Type.Optional(
      Type.Unsafe({
        enum: ["verified", "hypothesis"],
        type: "string",
        title: "Evidence confidence",
        description:
          "Verified means the observation was verified; impact can remain unmeasured.",
      })
    ),
    evidence_basis: Type.Optional(
      Type.Unsafe({
        enum: ["public_content", "analytics", "mixed"],
        type: "string",
        title: "Evidence basis",
      })
    ),
    measurement_status: Type.Optional(
      Type.Unsafe({
        enum: ["baseline_needed", "measured", "not_applicable"],
        type: "string",
        title: "Impact measurement",
      })
    ),
  },
});

// This declaration owns only the existing agent's metadata. `lobu apply`
// diffs a settings field only when the config declares it, so the live model
// and skills stay unmanaged here.
const developer = defineAgent({
  id: "developer",
  name: "Developer",
  description:
    "A software development agent for Lobu repositories that works in the team Vercel sandbox, runs checks, creates pull requests, reviews previews, and coordinates approved merges.",
});

// Metadata only, like `developer`: the Automations this agent runs are
// maintained outside this config.
const productOps = defineAgent({
  id: "product-ops",
  name: "product-ops",
  description:
    "Summarizes Lobu production activity from organization-owned read-only feeds",
});

const text = (title: string, description?: string) =>
  Type.Optional(
    Type.Unsafe({
      type: "string",
      title,
      ...(description ? { description } : {}),
    })
  );
const time = (title: string, description?: string) =>
  Type.Optional(
    Type.Unsafe({
      type: "string",
      format: "date-time",
      title,
      ...(description ? { description } : {}),
    })
  );
const count = (title: string) =>
  Type.Optional(Type.Unsafe({ type: "integer", minimum: 0, title }));

// A production error group. The issue-tracker Automation creates one only when
// a ClickHouse fingerprint passes its noise gate, and owns status and the
// counters. Triage fields belong to the agents and people who investigate; the
// work to fix it is a linked `task`.
const issue = defineEntityType({
  key: "issue",
  name: "Issue",
  description:
    "A production error group keyed by its fingerprint: lifecycle, counters and triage. Live occurrences stay in ClickHouse (issue_trend, issue_events).",
  properties: {
    fingerprint: Type.Unsafe({
      type: "string",
      title: "Fingerprint",
      pattern: "^[0-9a-f]{32}$",
    }),
    status: Type.Unsafe({
      enum: [
        "new",
        "ongoing",
        "escalating",
        "regressed",
        "resolved",
        "ignored",
      ],
      type: "string",
      title: "Status",
      "x-lobu": { role: "workflowState" },
      "x-facet": true,
      "x-table-column": true,
    }),
    kind: Type.Unsafe({
      enum: ["system", "user", "dependency"],
      type: "string",
      title: "Kind",
      "x-facet": true,
      "x-table-column": true,
    }),
    priority: Type.Optional(
      Type.Unsafe({
        enum: ["high", "medium", "low"],
        type: "string",
        title: "Priority",
        "x-facet": true,
        "x-table-column": true,
      })
    ),
    culprit: text("Culprit", "Where it fails: the span or log scope"),
    message: text("Message", "Parameterized error message"),
    first_seen: time("First seen"),
    last_seen: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date-time",
        title: "Last seen",
        "x-table-column": true,
      })
    ),
    seen_24h: count("Seen in 24h"),
    seen_14d: count("Seen in 14 days"),
    affected_orgs: count("Workspaces affected (peak hour)"),
    affected_users: count("Users affected (peak hour)"),
    first_release: text("First release"),
    last_release: text("Last release"),
    sample_trace_id: text("Sample trace"),
    observed_at: time("Counters observed at"),
    escalated_at: time("Escalated at"),
    regressed_at: time("Regressed at"),
    resolved_at: time("Resolved at"),
    resolution: Type.Optional(
      Type.Unsafe({
        enum: ["auto", "manual", "fix"],
        type: "string",
        title: "Resolution",
      })
    ),
    resolved_in_release: text(
      "Resolved in release",
      "Release that must stop emitting it; set by a merged fix"
    ),
    ignore_until: time("Ignore until"),
    triage_summary: text(
      "Triage summary",
      "What is failing and why it matters"
    ),
    suspected_cause: text("Suspected cause"),
    triaged_at: time("Triaged at"),
  },
});

const trackedBy = defineRelationshipType({
  key: "tracked-by",
  name: "Tracked By",
  description:
    "Links an issue to the task that fixes it. One task can track several issues with the same cause.",
});

const issueTracker = defineAutomation({
  agent: productOps,
  slug: "issue-tracker",
  name: "Issue tracker",
  description:
    "Promotes ClickHouse error fingerprints past the noise gate into issues and runs their lifecycle. Deterministic; no agent turn.",
  // Five minutes after each quarter-hour issue_occurrences_hourly refresh.
  triggers: [every("12,27,42,57 * * * *", { skip_if_unchanged: false })],
  tags: ["observability", "issues"],
  // The module reads ClickHouse and the issue records itself. A context-only
  // source keeps the default events source from pacing runs by arrivals.
  sources: { clock: context("SELECT CURRENT_TIMESTAMP AS observed_at") },
  reaction: reactionFromFile<typeof IssueTrackerReaction>(
    "./issue-tracker.reaction.ts"
  ),
});

// Reuse the Lobu Team read-only database credentials already stored in Lobu.
// Apply preserves the live secret because credentials are intentionally omitted.
const productActivityDbAuth = defineAuthProfile({
  slug: "lobu-prod-db-read-only",
  connector: "postgres",
  authKind: "env",
  name: "Lobu Prod DB (read-only)",
});

const productActivityDb = defineConnection({
  slug: "lobu-product-activity-db",
  connector: "postgres",
  name: "Lobu Prod DB — product activity",
  authProfile: productActivityDbAuth,
  feeds: [
    {
      feed: "query",
      name: "Lobu production activity",
      schedule: "2,22,42 * * * *",
      config: {
        primary_key: "activity_id",
        cursor_column: "observed_at",
        max_rows_per_sync: 5000,
        // Incremental timestamps are not a commit-ordered ledger: late commits
        // behind the checkpoint can be missed. Session/connection rows can
        // disappear, and tool audit is best effort. This is observed account
        // activity, not a complete history or anonymous browsing coverage.
        // Delivery time is separate from occurrence time: a conversation may
        // be seeded with zero calls and become visible only on completion.
        query: `SELECT *
          FROM (
            SELECT
              'signup:' || u.id AS activity_id,
              u."createdAt" AS occurred_at,
              'New signup'::text AS title,
              concat_ws(
                ' · ',
                coalesce(nullif(u.name, ''), 'Unnamed user'),
                u.email,
                coalesce((
                  SELECT string_agg(DISTINCT o.name, ', ' ORDER BY o.name)
                  FROM member m
                  JOIN organization o ON o.id = m."organizationId"
                  WHERE m."userId" = u.id
                ), 'No organization')
              ) AS payload_text,
              u."createdAt" AS observed_at
            FROM "user" u
            WHERE coalesce(u.principal_kind, 'human') = 'human'

            UNION ALL

            SELECT
              'login:' || s.id,
              s."createdAt",
              'User login'::text,
              concat_ws(
                ' · ',
                coalesce(nullif(u.name, ''), 'Unnamed user'),
                u.email,
                coalesce((
                  SELECT string_agg(DISTINCT o.name, ', ' ORDER BY o.name)
                  FROM member m
                  JOIN organization o ON o.id = m."organizationId"
                  WHERE m."userId" = u.id
                ), 'No organization')
              ),
              s."createdAt"
            FROM session s
            JOIN "user" u ON u.id = s."userId"
            WHERE coalesce(u.principal_kind, 'human') = 'human'

            UNION ALL

            SELECT
              'connection:' || c.id,
              c.created_at,
              'New connection'::text,
              concat_ws(
                ' · ',
                c.connector_key,
                coalesce(nullif(c.display_name, ''), 'Unnamed connection'),
                o.name,
                CASE WHEN u.email IS NOT NULL THEN 'created by ' || u.email END
              ),
              c.created_at
            FROM connections c
            JOIN organization o ON o.id = c.organization_id
            LEFT JOIN "user" u ON u.id = c.created_by
            WHERE c.deleted_at IS NULL

            UNION ALL

            SELECT
              'mcp:' || jsonb_build_array(m.user_id, m.client_identity, m.conversation_id)::text,
              m.first_activity_at,
              'MCP conversation first seen'::text,
              concat_ws(
                ' · ',
                coalesce(nullif(m.client_software_id, ''), nullif(client.client_name, ''), 'Unknown client'),
                coalesce(nullif(u.name, ''), 'Unknown user'),
                u.email,
                'Account-linked conversation; workspace scope is not captured by this fact'
              ),
              m.last_activity_at
            FROM mcp_client_conversations m
            LEFT JOIN oauth_clients client ON client.id = m.client_id
            JOIN "user" u ON u.id = m.user_id
            WHERE m.call_count > 0
              AND coalesce(u.principal_kind, 'human') = 'human'

            UNION ALL

            SELECT
              'tool-failure:' || e.origin_id,
              e.created_at,
              'Failed tool call'::text,
              concat_ws(
                ' · ',
                coalesce(nullif(u.name, ''), 'Unknown user'),
                u.email,
                coalesce(o.name, 'Account activity'),
                e.payload_data->>'tool_name',
                coalesce(e.payload_data->'error'->>'code', e.payload_data->'error'->>'name', 'Unknown error')
              ),
              e.created_at
            FROM events e
            JOIN "user" u ON u.id = e.created_by
            LEFT JOIN organization o ON o.id = e.organization_id
            WHERE e.semantic_type = 'audit'
              AND e.origin_type = 'tool_invocation'
              AND e.metadata->>'event_type' = 'tool_invocation.completed'
              AND e.payload_data->>'success' = 'false'
              AND coalesce(u.principal_kind, 'human') = 'human'
          ) activity`,
        mapping: {
          title: "title",
          occurred_at: "occurred_at",
          payload_text: "payload_text",
        },
      },
    },
  ],
});

// Provisioned with an immutable HTTP binding through authProfiles.create.
// Apply preserves the live secret because credentials are intentionally omitted.
const analyticsAuth = defineAuthProfile({
  slug: "lobu-clickhouse-analytics-http",
  connector: "clickhouse.analytics",
  authKind: "env",
  name: "Lobu ClickHouse analytics HTTP",
});
const analytics = defineConnection({
  slug: "lobu-analytics",
  connector: "clickhouse.analytics",
  name: "Lobu analytics",
  authProfile: analyticsAuth,
  config: { CLICKHOUSE_URL: "https://clickhouse.lobu.ai" },
  feeds: [
    {
      feed: "user_milestones",
      name: "Live user journey milestones",
      config: {},
    },
  ],
});

const lobuTeamSlack = defineConnection({
  slug: "lobu-team-slack",
  connector: "slack",
  credentialMode: "hosted",
  surfaces: ["dm", "channel"],
  codeTtlMinutes: 15,
});

// Company accounts connected through the UI. Profiles and connections are
// declared without credentials, so apply only checks the wiring; the grants
// stay where the OAuth flow stored them.
const cloudflareOAuthApp = defineAuthProfile({
  slug: "mcp-mcp-cloudflare-com-mcp-mcp-cloudflare-com-app",
  connector: "mcp.mcp-cloudflare-com",
  authKind: "oauth_app",
  name: "mcp.cloudflare.com OAuth App",
});

const companyCloudflareAccount = defineAuthProfile({
  slug: "cloudflare-lobu-company",
  connector: "mcp.mcp-cloudflare-com",
  authKind: "oauth_account",
  name: "Lobu company Cloudflare",
});

const companyCloudflare = defineConnection({
  slug: "cloudflare-lobu-company",
  connector: "mcp.mcp-cloudflare-com",
  name: "Lobu company Cloudflare",
  authProfile: companyCloudflareAccount,
  appAuthProfile: cloudflareOAuthApp,
});

// The Google OAuth app behind the company Gmail connection.
const gmailOAuthApp = defineAuthProfile({
  slug: "google-gmail-google-app",
  connector: "google.gmail",
  authKind: "oauth_app",
  name: "Gmail Google App",
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof ClickHouseAnalyticsConnector>(
      "./clickhouse-analytics.connector.ts"
    ),
    connectorFromFile<typeof DataForSeoConnector>("./dataforseo.connector.ts"),
  ],
  org: "lobu-team",
  orgName: "Lobu Team",
  orgDescription: "Lobu Team agents and internal operations",
  organizationId: "UdNAH1bb3csC842vhOgxAHVcfX4tYU5A",
  agents: [developer, productOps],
  authProfiles: [
    analyticsAuth,
    productActivityDbAuth,
    cloudflareOAuthApp,
    companyCloudflareAccount,
    gmailOAuthApp,
  ],
  entities: [task, issue, productUsers],
  relationships: [trackedBy],
  connections: [analytics, productActivityDb, lobuTeamSlack, companyCloudflare],
  // The external digest is maintained by scripts/configure-product-activity.ts.
  // Apply without prune: preserve its existing delivery agent and manual Automation.
  automations: [issueTracker],
});
