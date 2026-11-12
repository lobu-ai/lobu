import type {
  ReactionClient,
  AutomationScriptContext,
} from "@lobu/connector-sdk";
// Lobu team alerts: deterministic rules for things the team must never miss.
// Each rule selects rows in the window and turns each row into one alert;
// Idempotency keys make retried windows safe; the digest owns narrative.
interface Settings {
  teamGithub: string[];
  digestAutomationId: string;
  namespace: string;
  sourceConnection: string;
  legacyFeedId: number;
  signupCatchupStart: string;
  cutoverEnd: string;
}
interface Row {
  origin_id: string;
  semantic_type: string;
  source_url?: string;
  author?: string;
  repo?: string;
  title?: string;
  excerpt?: string;
  server_errors?: string;
  payload_text: string;
}
interface Window {
  start: string;
  end: string;
  signupStart: string;
  team: string;
}
const settings: Settings = JSON.parse("__TEAM_ALERTS_CONFIG__");
const TEAM_GITHUB = settings.teamGithub;
const SERVER_ERROR_THRESHOLD = 5; // HTTP 5xx in one 20-minute log window

const GITHUB_LABELS: Record<string, string> = {
  issue: "New issue",
  issue_comment: "New comment",
  discussion: "New discussion",
  discussion_comment: "New discussion comment",
  pull_request: "New PR",
  pr_comment: "New PR review comment",
};

const RULES: Array<{
  name: string;
  connection?: string;
  query: (window: Window) => string;
  alert: (row: Row) => Parameters<ReactionClient["notifications"]["send"]>[0];
}> = [
  {
    name: "github_outside_activity",
    query: (w) => `
      SELECT e.origin_id, e.semantic_type, e.source_url,
             coalesce(e.metadata->>'author_login', e.author_name) AS author,
             coalesce(e.metadata->>'github_repo_full_name', '') AS repo,
             e.title, left(e.payload_text, 500) AS excerpt
      FROM events e JOIN connections c ON c.id = e.connection_id
      WHERE c.slug = 'github-app-install'
        AND e.semantic_type IN ('issue','issue_comment','discussion','discussion_comment','pull_request','pr_comment')
        AND e.created_at >= '${w.start}' AND e.created_at < '${w.end}'
        AND e.occurred_at >= '${w.start}'::timestamptz - interval '2 days'
        AND coalesce(e.metadata->>'author_login', e.author_name, '') NOT IN ('', ${w.team})
        AND coalesce(e.metadata->>'author_login', e.author_name, '') NOT LIKE '%[bot]'
      ORDER BY e.occurred_at`,
    alert: (r) => ({
      title:
        (GITHUB_LABELS[r.semantic_type] ?? r.semantic_type) +
        " from " +
        r.author +
        (r.repo ? ` in ${r.repo}` : ""),
      body: [
        r.title ? `*${r.title}*` : null,
        r.excerpt,
        r.source_url,
        "Needs a reply from the team.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      resource_url: r.source_url ?? undefined,
      idempotency_key: `gh-external:${r.origin_id}`,
    }),
  },
  {
    name: "production_server_errors",
    query: (w) => `
      SELECT origin_id, payload_text, server_errors
      FROM (
        SELECT DISTINCT ON (w->>'window_end')
          w->>'window_end' AS origin_id,
          concat('Production ', e.metadata->>'namespace', ' logs (',
            w->>'window_start', ', ', w->>'window_end', ']: ',
            w->>'http_server_errors', ' HTTP 5xx responses.') AS payload_text,
          CASE WHEN w->>'http_server_errors' ~ '^[0-9]{1,20}$'
            THEN (w->>'http_server_errors')::numeric END AS server_errors
        FROM events e
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(e.metadata->'recent_windows') = 'array'
            THEN e.metadata->'recent_windows' ELSE '[]'::jsonb END) AS w
        WHERE e.automation_id = ${settings.digestAutomationId} AND e.semantic_type = 'summary'
          AND e.metadata->>'automation_output' = 'log_progress'
          AND e.metadata->>'checkpoint_key' = 'product-activity-digest:${settings.digestAutomationId}:${settings.namespace}'
          AND e.metadata->>'namespace' = '${settings.namespace}'
          AND e.created_at >= '${w.start}' AND e.created_at < '${w.end}'
          AND jsonb_typeof(w->'window_start') = 'string'
          AND jsonb_typeof(w->'window_end') = 'string'
          AND length(w->>'window_start') = 24 AND length(w->>'window_end') = 24
        ORDER BY w->>'window_end', e.created_at DESC, e.id DESC
      ) latest
      WHERE server_errors >= ${SERVER_ERROR_THRESHOLD}
      ORDER BY origin_id`,
    alert: (r) => ({
      title: `${r.server_errors} HTTP 5xx responses in production`,
      body: [r.payload_text, "Check the production logs for the failing route."]
        .filter(Boolean)
        .join("\n\n"),
      idempotency_key: `prod-5xx:${r.origin_id}`,
    }),
  },
  {
    name: "new_signup",
    connection: settings.sourceConnection,
    query: (w) => `
      SELECT '${settings.legacyFeedId}:signup:' || u.id AS origin_id,
        concat_ws(' · ', coalesce(nullif(u.name, ''), 'Unnamed user'), u.email,
          coalesce((SELECT string_agg(DISTINCT o.name, ', ' ORDER BY o.name)
            FROM member m JOIN organization o ON o.id = m."organizationId"
            WHERE m."userId" = u.id), 'No organization')) AS payload_text
      FROM "user" u
      WHERE coalesce(u.principal_kind, 'human') = 'human'
        AND u."createdAt" >= '${w.signupStart}'::timestamptz
        AND u."createdAt" < '${w.end}'::timestamptz
      ORDER BY u."createdAt", u.id`,
    alert: (r) => ({
      title: "New signup",
      body: r.payload_text,
      idempotency_key: `signup:${r.origin_id}`,
    }),
  },
];

export default async (ctx: AutomationScriptContext, client: ReactionClient) => {
  const { window_start: start, window_end: end } = ctx.window;
  for (const value of [start, end]) {
    if (
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    )
      throw new Error("Expected frozen canonical UTC window");
  }
  if (start >= end) throw new Error("Expected ordered window");
  // One cutover overlap covers source rows not yet collected by the old feed.
  // Exact legacy notification keys suppress already delivered signups.
  const signupStart =
    start < settings.cutoverEnd && settings.signupCatchupStart < start
      ? settings.signupCatchupStart
      : start;
  const w = {
    start,
    end,
    signupStart,
    team: TEAM_GITHUB.map((l) => `'${l}'`).join(","),
  };
  const sent: Record<string, number> = {};
  for (const rule of RULES) {
    const rows = (
      rule.connection
        ? await client.query(rule.query(w), { connection: rule.connection })
        : await client.query(rule.query(w))
    ) as Row[];
    for (const r of rows) await client.notifications.send(rule.alert(r));
    sent[rule.name] = rows.length;
  }
  return { checked_window: { start, end }, alerts_checked: sent };
};
