import {
  connectorFromFile,
  defineAgent,
  defineAuthProfile,
  defineAutomation,
  every,
  defineConfig,
  defineConnection,
  defineEntityType,
  defineRelationshipType,
  defineSkill,
  reactionFromFile,
  secret,
  skillFromFile,
  field,
  Type,
} from "@lobu/cli/config";
import type DeliverooConnector from "./deliveroo.connector.ts";
import type lunchDeliverooReaction from "./lunch-deliveroo.reaction.ts";
import type LokiActivityConnector from "./loki-activity.connector.ts";
import type productActivityDigestReaction from "./product-activity-digest.reaction.ts";

const lunchOpenSkill = defineSkill({
  name: "lunch-open",
  content:
    "Open today's office lunch run (step 1 in your instructions):\n\n1. Check memory for a `lunch-run` entity dated today — if one exists and isn't\n   cancelled, stop (don't open a second one).\n2. Guess who's in from recent chat activity and past `lunch-run` entities.\n3. Post the lunch call in the channel: react 🍕 / \"+1\" to join, drop restaurant\n   recommendations, options coming ~11:35, targeting ~12:30 delivery. @-mention\n   the people you think are in, but make clear anyone can join or skip.\n4. Open a thread off that message.\n5. Save a `lunch-run` entity {date, channel, status: \"collecting\", thread_ref,\n   restaurant: null, items: []} and a `lunch:opened` event linked to it.\n\nThen end — the lobu-team-lunch-finalize Automation takes it from here. Keep it to one short\nmessage in the channel.\n",
});

const lunchFinalizeSkill = defineSkill({
  name: "lunch-finalize",
  content:
    'Finalize today\'s office lunch run (step 2 in your instructions):\n\n1. Find today\'s `lunch-run` entity (status "collecting"). If there isn\'t one,\n   open one (step 1) and stop. If it\'s already "done"/"cancelled", do nothing.\n2. Read the run\'s thread — work out who\'s in (🍕 / "+1" / put in an order) and\n   any restaurant recommendations. If nobody\'s in: post a "skipping today 👋"\n   note, set the run to "cancelled", save a `lunch:cancelled` event, stop.\n3. Pick the restaurant (a clear thread recommendation, else a usual spot from\n   USER.md, biased away from the last couple of runs).\n4. Post the call for orders: name the restaurant and its Deliveroo page. You do\n   NOT scrape the menu yourself — a live menu shortlist with real prices is\n   fetched and posted automatically right after this turn (the deliveroo\n   connector reads it via the office\'s Owletto extension). Just set `restaurant`\n   so that reaction knows which one. Always accept free-text orders.\n5. Collect orders from replies + number reactions into items: [{person, item,\n   price?, notes}]. Ask directly about anything ambiguous — don\'t guess silently.\n6. Post the summary in the thread: restaurant; per-person list (@person — item\n   (notes)); subtotal + per-head (flag if well over budget); and the next action\n   — "@here someone place + pay on Deliveroo: <link>". The live menu + order link\n   arrive from the reaction; you never build a basket, log in, or touch payment.\n7. Update the `lunch-run` entity (status "done", restaurant, items, subtotal)\n   and save a `lunch:placed` event linked to it. Outcome is "manual" — a human\n   places + pays on Deliveroo.\n\nNever complete checkout or pay. A run is a success once the order list is\ncollected and handed off cleanly.\n',
});

const foodOrdering = defineAgent({
  id: "food-ordering",
  name: "food-ordering",
  description:
    "Runs the office lunch order — presence check, recommendations, options poll, order collection, Deliveroo basket handoff",
  dir: ".",
  skills: [
    skillFromFile("./skills/deliveroo-order"),
    lunchOpenSkill,
    lunchFinalizeSkill,
  ],
  providers: [
    {
      id: "anthropic",
      model: "claude/claude-sonnet-5",
      key: secret("ANTHROPIC_API_KEY"),
    },
  ],
  network: {
    // Deliveroo is a flat allow rather than LLM-judged: the egress judge needs
    // an ANTHROPIC_API_KEY (OAuth tokens are rejected for direct API use), and
    // the deliveroo-order skill's script has no checkout/payment path, so the
    // per-request judge was defense-in-depth we opt out of here.
    allowed: [
      "registry.npmjs.org",
      ".npmjs.org",
      "playwright.azureedge.net",
      "cdn.playwright.dev",
      "deliveroo.co.uk",
      ".deliveroo.co.uk",
      "deliveroo.com",
      ".deliveroo.com",
    ],
  },
});

const lunchRun = defineEntityType({
  key: "lunch-run",
  name: "Lunch run",
  description:
    "One day's office lunch order — who's in, what they ordered, the restaurant, the basket link, and where it ended up",
  properties: {
    date: field("Date", {
      description: "ISO date of the run (one run per day)",
    }),
    channel: field("Channel", {
      description: "The chat channel/conversation the run happened in",
      column: false,
    }),
    status: field("Status", { enum: ["collecting", "done", "cancelled"] }),
    restaurant: field("Restaurant", { optional: true }),
    thread_ref: Type.Optional(
      Type.Unsafe({
        type: "string",

        description:
          "Reference to the thread/message where the run is happening — lunch-finalize uses this to find the conversation",
      })
    ),
    items: Type.Optional(
      Type.Unsafe({
        type: "array",
        description: "Per-person order lines",
        items: {
          type: "object",
          properties: {
            person: { type: "string" },
            item: { type: "string" },
            price: { type: "number" },
            notes: { type: "string" },
          },
        },
      })
    ),
    subtotal: Type.Optional(field(Type.Number(), "Subtotal")),
    basket_url: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "Deliveroo group-order / basket link handed to a human, or null if placed manually",
      })
    ),
    notes: Type.Optional(Type.Unsafe({ type: "string" })),
  },
});

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

// The office's Deliveroo connection. Feedless — it exposes only on-demand
// actions (search_restaurants / read_menu) that the lobu-team-lunch-finalize reaction
// drives through the paired Owletto Chrome extension. `restaurants_url` is the
// office's delivery-location restaurants list (set it to your office postcode's
// Deliveroo page — the geohash pins delivery to that address).
const deliverooConn = defineConnection({
  slug: "deliveroo-office",
  connector: "deliveroo",
  name: "Deliveroo — office",
  config: {
    restaurants_url:
      "https://deliveroo.co.uk/restaurants/london/the-city?fulfillment_method=DELIVERY&geohash=gcpvjcnm9jsv",
  },
});

const lunchOpen = defineAutomation({
  agent: foodOrdering,
  slug: "lobu-team-lunch-open",
  name: "Open the lunch run",
  triggers: [every("0 11 * * 1-5")],
  tags: ["lunch", "daily"],
  minCooldownSeconds: 600,
  skills: ["lunch-open"],
  // No inline schema: the run's state lives on the `lunch-run` entity (created
  // above) — the one source of truth, editable + correctable like any entity.
});

const lunchFinalize = defineAutomation({
  agent: foodOrdering,
  slug: "lobu-team-lunch-finalize",
  name: "Collect orders and hand off",
  triggers: [every("35 11 * * 1-5")],
  tags: ["lunch", "daily"],
  minCooldownSeconds: 600,
  reaction: reactionFromFile<typeof lunchDeliverooReaction>(
    "./lunch-deliveroo.reaction.ts"
  ),
  reactionsGuidance:
    "When the run ends in `placed` or `manual`, store the per-head cost back into a\n`lunch:placed` event on the lunch-run entity so the next day's lobu-team-lunch-open can\nread the most-recent restaurant.\n",
  skills: ["lunch-finalize"],
  // No inline schema: the reaction reads the run's outcome straight off the
  // `lunch-run` entity this prompt updates (status "done" + restaurant), so the
  // handoff contract is the entity, not an Automation-authored payload.
});

// This declaration owns only the existing agent's metadata. `lobu apply`
// diffs a settings field only when the config declares it, so the live model,
// tools, and skills stay unmanaged here.
const developer = defineAgent({
  id: "developer",
  name: "Developer",
  description:
    "A software development agent for Lobu repositories that works in the team Vercel sandbox, runs checks, creates pull requests, reviews previews, and coordinates approved merges.",
});

// Dogfood task 35364 is deliberately project-owned. The worker and local coding
// agent are selected here, not embedded in Lobu's shared runtime. Change
// `agentKind` to another daemon-supported CLI when switching agents.
const engineeringTaskRunner = defineAutomation({
  agent: "developer",
  slug: "engineering-task-runner-dogfood-35364",
  name: "Engineering Task Runner Dogfood 35364",
  triggers: [],
  tags: ["engineering-task", "dogfood"],
  deviceWorkerId: "66af4f1d-13c5-4d2d-b848-5b6b5dde7b63",
  agentKind: "opencode",
  sources: {
    task_history: `SELECT id, semantic_type, occurred_at, payload_text, metadata
      FROM events
      WHERE entity_ids @> ARRAY[35364]::bigint[]
      ORDER BY occurred_at DESC
      LIMIT 100`,
  },
  prompt: `Continue engineering task 35364.

Before editing, read the task with client.entities.get({ entity_id: 35364 }) and its durable history with client.knowledge.read({ entity_id: 35364, limit: 100 }). The task metadata repository is authoritative.

Never edit a shared checkout. Work only in a workspace owned by task 35364. If no isolated task workspace is available, another writer is active, or a required environment change needs approval, stop without editing and save a blocked checkpoint.

Before completing the Automation run, append engineering-task.checkpoint linked to entity 35364 with the current status, workspace, branch, PR, tests, verification, and blockers. Persist important rationale as engineering-task.decision, test evidence as engineering-task.verification_completed, and review results as engineering-task.review_completed. Update the task metadata when its current status, branch, PR, or verification state changes.

Use the existing GitHub connector and approval flow. Never bypass an approval or merge without the required review and verification evidence.`,
});

const productOps = defineAgent({
  id: "product-ops",
  name: "product-ops",
  description:
    "Summarizes Lobu production activity from organization-owned read-only feeds",
  providers: [{ id: "qwen", model: "qwen3.8-max" }],
  tools: {
    // Keep the headless lockdown (no native worker tools) and pre-approve the
    // one MCP write the Automation needs: run_sdk carries completeWindow, is not
    // read-only, and would otherwise stall an unattended run on an approval
    // card. query_sdk is readOnlyHint and needs no grant.
    allowed: [],
    strict: true,
    preApproved: ["/mcp/lobu-memory/tools/run_sdk"],
  },
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
        // The connector adds keyset pagination. Keep each row human-readable so
        // the digest does not depend on connector-specific payload_data fields.
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
              AND u."createdAt" > now() - interval '24 hours'

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
              AND s."createdAt" > now() - interval '24 hours'

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
              AND c.created_at > now() - interval '24 hours'

            UNION ALL

            SELECT
              concat_ws(':', 'mcp', m.organization_id, m.client_identity, m.conversation_id),
              m.last_activity_at,
              'MCP activity'::text,
              concat_ws(
                ' · ',
                coalesce(m.client_software_id, 'Unknown client'),
                coalesce(nullif(u.name, ''), 'Unknown user'),
                u.email,
                o.name,
                CASE WHEN m.last_action IS NOT NULL THEN 'last action: ' || m.last_action END,
                m.call_count || ' total calls',
                m.failed_count || ' failed'
              )
            FROM mcp_client_conversations m
            JOIN organization o ON o.id = m.organization_id
            LEFT JOIN "user" u ON u.id = m.user_id
            WHERE m.call_count > 0
              AND m.last_activity_at > now() - interval '24 hours'
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

const productionLogsAuth = defineAuthProfile({
  slug: "lobu-production-loki",
  connector: "loki.activity",
  authKind: "env",
  name: "Lobu production Loki",
  credentials: {
    LOKI_URL: secret("LOBU_PRODUCT_OPS_LOKI_URL"),
  },
});

const productionLogs = defineConnection({
  slug: "lobu-production-logs",
  connector: "loki.activity",
  name: "Lobu production Kubernetes logs",
  authProfile: productionLogsAuth,
  config: {
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

const productActivityDigest = defineAutomation({
  agent: productOps,
  slug: "product-activity-digest",
  name: "Lobu production activity digest",
  description:
    "Every 20 minutes, summarize new signups, logins, connections, MCP clients, and Kubernetes log activity; stay silent when nothing happened.",
  triggers: [
    every("5,25,45 * * * *", {
      skip_if_unchanged: true,
    }),
  ],
  sources: {
    product_activity: "@connection:lobu-product-activity-db",
    kubernetes_logs: "@connection:lobu-production-logs",
  },
  minCooldownSeconds: 60,
  tags: ["product-ops", "production", "slack"],
  prompt:
    'The reaction sends the exact activity rows for this window. Return exactly {"run":true,"exclude_email":"emrekabakci@gmail.com"} — the digest excludes this operator email from presence counts.',
  reactionsGuidance:
    "Send one rich digest containing every user email and activity detail in the window. Send nothing when both sources are empty.",
  reaction: reactionFromFile<typeof productActivityDigestReaction>(
    "./product-activity-digest.reaction.ts"
  ),
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
    connectorFromFile<typeof DeliverooConnector>("./deliveroo.connector.ts"),
    connectorFromFile<typeof LokiActivityConnector>(
      "./loki-activity.connector.ts"
    ),
  ],
  org: "lobu-team",
  orgName: "Lobu Team",
  orgDescription: "Lobu Team agents and internal operations",
  organizationId: "UdNAH1bb3csC842vhOgxAHVcfX4tYU5A",
  agents: [foodOrdering, developer, productOps],
  authProfiles: [productActivityDbAuth, productionLogsAuth],
  entities: [lunchRun, engineeringTask],
  relationships: [targetsRepository],
  connections: [
    deliverooConn,
    productActivityDb,
    productionLogs,
    lobuTeamSlack,
  ],
  automations: [
    lunchOpen,
    lunchFinalize,
    productActivityDigest,
    engineeringTaskRunner,
  ],
});
