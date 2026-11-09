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

/** Reads at most three materialized milestones, never aggregates request history. */
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
    query: `SELECT concat('signup:', user_id) AS origin_id, user_id,
        toString(toTimeZone(signup_at, 'UTC')) AS occurred_at, 'Signed up' AS title,
        concat('Signup method: ', method, ' · ', if(attribution = 'unattributed',
          'Acquisition source unknown; this does not mean direct traffic',
          'An approximate last external touch was matched within 24 hours')) AS payload_text
      FROM observability.analytics_signup_journey FINAL WHERE user_id = ${user}
      UNION ALL
      SELECT concat('landing:', user_id), user_id, toString(toTimeZone(assumeNotNull(landing_at), 'UTC')),
        'Landing visit (approximate match)',
        concat(landing_host, landing_path, ' · source: ', utm_source, ' · medium: ', utm_medium,
          ' · campaign: ', utm_campaign, ' · referrer: ', referrer_domain,
          ' · IP and browser match within 24 hours; not verified identity or first touch')
      FROM observability.analytics_signup_journey FINAL
      WHERE user_id = ${user} AND landing_at IS NOT NULL AND attribution = 'last_external_touch_24h'
      UNION ALL
      SELECT concat('first-success:', user_id), user_id, toString(toTimeZone(assumeNotNull(first_success_at), 'UTC')),
        'First verified success', concat('Success kind: ', toString(assumeNotNull(success_kind)))
      FROM observability.analytics_first_success FINAL
      WHERE user_id = ${user} AND first_success_at IS NOT NULL`,
    limit: 4,
    offset: 0,
    sort: undefined,
  });
  if ((result.total ?? result.rows.length) > 3 || result.rows.length > 3)
    throw new Error("User milestone projection returned duplicate accounts");
  const rows = result.rows
    .map((row) => {
      if (
        row.user_id !== userId ||
        typeof row.origin_id !== "string" ||
        typeof row.occurred_at !== "string" ||
        typeof row.title !== "string" ||
        typeof row.payload_text !== "string"
      )
        throw new Error("Invalid user milestone projection");
      const date = new Date(`${row.occurred_at.replace(" ", "T")}Z`);
      if (!Number.isFinite(date.getTime()))
        throw new Error("Invalid user milestone timestamp");
      const occurred_at = date.toISOString();
      return {
        origin_id: row.origin_id,
        user_id: row.user_id,
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
    rows: selected.map(({ user_id, pageKey: _pageKey, ...row }) => ({
      ...row,
      origin_type: "product.milestone",
      payload_type: "text",
      metadata: { user_id },
    })),
    rowCursors,
    hasMore: rows.length > limit,
    ...(rows.length > limit ? { nextCursor: rowCursors.at(-1) } : {}),
  };
}
