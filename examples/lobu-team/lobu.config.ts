import {
  connectorFromFile,
  defineAgent,
  defineAuthProfile,
  defineConfig,
  defineConnection,
  defineEntityType,
  Type,
} from "@lobu/cli/config";
import type LokiActivityConnector from "./loki-activity.connector.ts";

// One backlog type for every kind of team work, written by people and agents.
// The organic acquisition review Automation (maintained in the workspace) reads
// the `seo` kind as its backlog and links each `seo.review` report to the SEO
// tasks it covers, so the report's event kind is declared here.
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
  eventKinds: {
    "seo.review": {
      description:
        "Dated SEO review with source coverage, evidence, hypotheses and follow-up actions.",
      metadataSchema: {
        type: "object",
        required: [
          "report_key",
          "method_version",
          "observed_at",
          "source_coverage",
          "paid_data_spend_usd",
          "measurement_status",
        ],
        properties: {
          report_key: { type: "string", maxLength: 256, minLength: 1 },
          observed_at: { type: "string", format: "date-time" },
          method_version: { type: "string", minLength: 1 },
          source_coverage: { type: "string", minLength: 1 },
          measurement_status: { type: "string", minLength: 1 },
          paid_data_spend_usd: { type: "number", minimum: 0 },
        },
      },
    },
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
        cursor_column: "occurred_at",
        max_rows_per_sync: 5000,
        // The durable keyset cursor bounds reads, including catch-up after an
        // outage; a feed without a checkpoint starts from the oldest row. Keep
        // rows readable without connector-specific payload fields.
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
              ) AS payload_text
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
              )
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
              )
            FROM connections c
            JOIN organization o ON o.id = c.organization_id
            LEFT JOIN "user" u ON u.id = c.created_by
            WHERE c.deleted_at IS NULL

            UNION ALL

            SELECT
              'mcp:' || jsonb_build_array(m.user_id, m.client_identity, m.conversation_id)::text,
              m.last_activity_at,
              'MCP activity'::text,
              concat_ws(
                ' · ',
                coalesce(nullif(m.client_software_id, ''), nullif(client.client_name, ''), 'Unknown client'),
                coalesce(nullif(u.name, ''), 'Unknown user'),
                u.email,
                coalesce((
                  SELECT string_agg(o.name, ', ' ORDER BY o.name)
                  FROM mcp_client_conversation_workspaces w
                  JOIN organization o ON o.id = w.organization_id
                  WHERE w.user_id = m.user_id
                    AND w.client_identity = m.client_identity
                    AND w.conversation_id = m.conversation_id
                ), 'Account activity'),
                CASE WHEN m.last_action IS NOT NULL THEN 'last action: ' || m.last_action END,
                m.call_count || ' total calls'
              )
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
              )
            FROM events e
            JOIN "user" u ON u.id = e.created_by
            LEFT JOIN organization o ON o.id = e.organization_id
            WHERE e.semantic_type = 'audit'
              AND e.origin_type = 'tool_invocation'
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
const productionLogsAuth = defineAuthProfile({
  slug: "lobu-production-loki-http",
  connector: "loki.activity",
  authKind: "env",
  name: "Lobu production Loki HTTP",
});

const productionLogs = defineConnection({
  slug: "lobu-production-logs",
  connector: "loki.activity",
  name: "Lobu production Kubernetes logs",
  authProfile: productionLogsAuth,
  config: {
    LOKI_URL: "https://loki.lobu.ai",
    namespace: "summaries-prod",
    grafana_url:
      "https://monitoring-kube-prometheus-stack-grafana.brill-kanyu.ts.net",
  },
  feeds: [
    {
      feed: "activity",
      name: "Lobu production log activity",
      schedule: "3,23,43 * * * *",
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

// The Google OAuth app behind the company Gmail and Search Console connections.
const gmailOAuthApp = defineAuthProfile({
  slug: "google-gmail-google-app",
  connector: "google.gmail",
  authKind: "oauth_app",
  name: "Gmail Google App",
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof LokiActivityConnector>(
      "./loki-activity.connector.ts"
    ),
  ],
  org: "lobu-team",
  orgName: "Lobu Team",
  orgDescription: "Lobu Team agents and internal operations",
  organizationId: "UdNAH1bb3csC842vhOgxAHVcfX4tYU5A",
  agents: [developer, productOps],
  authProfiles: [
    productActivityDbAuth,
    productionLogsAuth,
    cloudflareOAuthApp,
    companyCloudflareAccount,
    gmailOAuthApp,
  ],
  entities: [task],
  connections: [
    productActivityDb,
    productionLogs,
    lobuTeamSlack,
    companyCloudflare,
  ],
  // The external digest is maintained by scripts/configure-product-activity.ts.
  // Apply without prune: preserve its existing delivery agent and manual Automation.
  automations: [],
});
