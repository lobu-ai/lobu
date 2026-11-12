import type {
  FeedReadContext,
  FeedReadResult,
  QueryContext,
  QueryResult,
} from "@lobu/connector-sdk";

interface AnalyticsConfig {
  CLICKHOUSE_URL: string;
}
type Query = (ctx: QueryContext<AnalyticsConfig>) => Promise<QueryResult>;

/** Reads at most two derived milestones, never aggregates request history.
 * Signup is owned by the account row in Postgres. This source cannot prove
 * complete activity coverage, a signed-in landing visitor, or absence of use.
 */
export async function readUserMilestones(
  ctx: FeedReadContext<AnalyticsConfig>,
  query: Query
): Promise<FeedReadResult> {
  const userId = ctx.match?.values[0];
  if (
    ctx.match?.path !== "metadata.user_id" ||
    ctx.match.values.length !== 1 ||
    typeof userId !== "string" ||
    !userId ||
    userId.length > 128
  )
    throw new Error("User milestones require one exact product account ID");
  const limit = ctx.limit ?? 25;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    ctx.offset ||
    ctx.query ||
    ctx.window
  )
    throw new Error(
      "User milestones support exact account matching and cursor pagination only"
    );
  let before: string | undefined;
  if (ctx.cursor) {
    const cursor = JSON.parse(ctx.cursor);
    if (
      !cursor ||
      cursor.v !== 1 ||
      cursor.user_id !== userId ||
      typeof cursor.before !== "string" ||
      cursor.before.length > 1024
    )
      throw new Error("Invalid user milestone cursor");
    before = cursor.before;
  }
  const hex = encodeURIComponent(userId).replace(
    /%([0-9A-F]{2})|([^%])/g,
    (_match, byte: string | undefined, char: string | undefined) =>
      byte ?? char!.charCodeAt(0).toString(16).padStart(2, "0")
  );
  const user = `unhex('${hex}')`;
  const result = await query({
    ...ctx,
    query: `SELECT concat('landing:', user_id) AS origin_id, user_id,
        toString(toTimeZone(assumeNotNull(landing_at), 'UTC')) AS occurred_at,
        'Landing visit (approximate match)' AS title,
        concat(landing_host, landing_path, ' · source: ', utm_source, ' · medium: ', utm_medium,
          ' · campaign: ', utm_campaign, ' · referrer: ', referrer_domain,
          ' · IP and browser match within 24 hours; not verified identity or first touch') AS payload_text,
        toString(toTimeZone(computed_at, 'UTC')) AS computed_at, CAST(NULL AS Nullable(String)) AS success_kind
      FROM observability.analytics_signup_journey FINAL
      WHERE user_id = ${user} AND landing_at IS NOT NULL AND attribution = 'last_external_touch_24h'
      UNION ALL
      SELECT concat('first-success:', user_id), user_id, toString(toTimeZone(assumeNotNull(first_success_at), 'UTC')),
        'First observed success within 7 days', concat('Success kind: ', toString(assumeNotNull(success_kind)),
          ' · 90-day signup cohort; successes within 7 days of signup; absence is not proof of inactivity'),
        toString(toTimeZone(computed_at, 'UTC')), toString(assumeNotNull(success_kind))
      FROM observability.analytics_first_success FINAL
      WHERE user_id = ${user} AND first_success_at IS NOT NULL`,
    limit: 3,
    offset: 0,
    sort: undefined,
  });
  if ((result.total ?? result.rows.length) > 2 || result.rows.length > 2)
    throw new Error("User milestone projection returned duplicate accounts");
  const rows = result.rows
    .map((row) => {
      if (
        row.user_id !== userId ||
        typeof row.origin_id !== "string" ||
        typeof row.occurred_at !== "string" ||
        typeof row.title !== "string" ||
        typeof row.payload_text !== "string" ||
        typeof row.computed_at !== "string" ||
        (row.origin_id !== `landing:${userId}` &&
          row.origin_id !== `first-success:${userId}`) ||
        (row.origin_id === `first-success:${userId}` &&
          !["agent_reply", "source_read", "automation_output"].includes(
            String(row.success_kind)
          ))
      )
        throw new Error("Invalid user milestone projection");
      const date = new Date(`${row.occurred_at.replace(" ", "T")}Z`);
      const computed = new Date(`${row.computed_at.replace(" ", "T")}Z`);
      if (
        !Number.isFinite(date.getTime()) ||
        !Number.isFinite(computed.getTime())
      )
        throw new Error("Invalid user milestone timestamp");
      const occurred_at = date.toISOString();
      return {
        origin_id: row.origin_id,
        metadata: {
          user_id: userId,
          computed_at: computed.toISOString(),
          ...(row.origin_id === `landing:${userId}`
            ? {
                event_type: "product.landing_attributed",
                evidence_basis: "inferred",
                attribution_method: "ip_user_agent_24h",
                source: "observability.analytics_signup_journey",
                coverage: {
                  lookback_hours: 24,
                  verified_visitor_identity: false,
                },
              }
            : {
                event_type: "product.first_success",
                evidence_basis: "observed",
                source: "observability.analytics_first_success",
                success_kind: row.success_kind,
                coverage: { signup_cohort_days: 90, success_window_days: 7 },
              }),
        },
        title: row.title,
        payload_text: row.payload_text,
        occurred_at,
        pageKey: `${occurred_at}|${row.origin_id}`,
      };
    })
    .sort((a, b) =>
      b.pageKey < a.pageKey ? -1 : b.pageKey > a.pageKey ? 1 : 0
    )
    .filter((row) => !before || row.pageKey < before);
  const selected = rows.slice(0, limit);
  const rowCursors = selected.map((row) =>
    JSON.stringify({ v: 1, user_id: userId, before: row.pageKey })
  );
  return {
    rows: selected.map(({ pageKey: _pageKey, ...row }) => ({
      ...row,
      origin_type: row.metadata.event_type,
      payload_type: "text",
    })),
    rowCursors,
    hasMore: rows.length > limit,
    ...(rows.length > limit ? { nextCursor: rowCursors.at(-1) } : {}),
  };
}
