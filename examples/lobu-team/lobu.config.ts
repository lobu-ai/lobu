import {
  connectorFromFile,
  defineAgent,
  defineAuthProfile,
  defineConfig,
  defineConnection,
  defineEntityType,
  defineRelationshipType,
  Type,
} from "@lobu/cli/config";
import type LokiActivityConnector from "./loki-activity.connector.ts";

const engineeringTask = defineEntityType({
  key: "engineering-task",
  name: "Engineering Task",
  description:
    "A durable unit of engineering work coordinated by Lobu agents and linked to code changes.",
  properties: {
    branch: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    status: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: [
          "open",
          "implementing",
          "review",
          "verification",
          "merged",
          "done",
          "blocked",
        ],
      })
    ),
    github_pr: Type.Optional(Type.Integer()),
    repository: Type.Optional(Type.String()),
    github_issue: Type.Optional(Type.Integer()),
    verification_level: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: ["none", "tests", "e2e", "ui", "production"],
      })
    ),
    verification_status: Type.Optional(
      Type.Unsafe({
        type: "string",
        enum: ["pending", "passed", "failed"],
      })
    ),
    verification_required: Type.Optional(Type.Boolean()),
  },
  eventKinds: {
    "engineering-task.checkpoint": {
      description:
        "Durable implementation checkpoint with status, branch, PR, tests, verification, and blockers",
    },
    "engineering-task.decision": {
      description: "Durable engineering decision and rationale",
    },
    "engineering-task.verification_completed": {
      description: "Completed test or environment verification evidence",
    },
    "engineering-task.review_completed": {
      description: "Completed code review outcome and remaining findings",
    },
  },
});

const targetsRepository = defineRelationshipType({
  key: "targets_repository",
  name: "Targets Repository",
  description: "Engineering task targets a code repository resource.",
  rules: [{ source: engineeringTask, target: "$resource" }],
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
  agents: [developer],
  authProfiles: [productActivityDbAuth, productionLogsAuth],
  entities: [engineeringTask],
  relationships: [targetsRepository],
  connections: [productActivityDb, productionLogs, lobuTeamSlack],
  // The external digest is maintained by scripts/configure-product-activity.ts.
  // Apply without prune: preserve its existing delivery agent and manual Automation.
  automations: [],
});
