import type {
  CardElement,
  ReactionClient,
  AutomationScriptContext,
} from "@lobu/connector-sdk";

const PRODUCT_ACTIVITY_CONNECTION = "lobu-product-activity-db";
const LOG_ACTIVITY_CONNECTION = "lobu-production-logs";
const CARD_TEXT_LIMIT = 2_800;
const LOG_WINDOW_MS = 20 * 60 * 1000;
const LOG_INGESTION_LAG_MS = 2 * 60 * 1000;
// Both feeds are scheduled 2–3 minutes before this digest. Ten minutes allows
// normal run delay without treating a missed 20-minute cycle as current.
const FEED_FRESHNESS_MS = 10 * 60 * 1000;

interface FeedCoverageRow {
  connection_slug: string;
  connection_status: string;
  status: string;
  last_sync_status: string | null;
  last_sync_at: string | null;
  consecutive_failures: number;
  expected_log_window_collected: boolean;
}

interface DigestCoverage {
  product: boolean;
  logs: boolean;
  issues: string[];
}

export function digestCoverage(
  rows: FeedCoverageRow[],
  windowEnd: Date
): DigestCoverage {
  const issues: string[] = [];
  const healthy = (slug: string, label: string): boolean => {
    const feed = rows.find((row) => row.connection_slug === slug);
    if (!feed) {
      issues.push(`${label}: feed unavailable`);
      return false;
    }
    if (feed.connection_status !== "active") {
      issues.push(
        `${label}: connection ${feed.connection_status ?? "unavailable"}`
      );
      return false;
    }
    if (
      feed.status !== "active" ||
      feed.last_sync_status !== "success" ||
      Number(feed.consecutive_failures) > 0
    ) {
      issues.push(
        `${label}: feed ${feed.status}; last sync ${feed.last_sync_status ?? "unknown"}`
      );
      return false;
    }
    const syncedAt = new Date(feed.last_sync_at ?? "").getTime();
    if (syncedAt >= windowEnd.getTime()) {
      issues.push(
        `${label}: latest successful sync completed at or after the window cutoff`
      );
      return false;
    }
    if (
      !Number.isFinite(syncedAt) ||
      syncedAt < windowEnd.getTime() - FEED_FRESHNESS_MS
    ) {
      issues.push(`${label}: last successful sync is stale or unknown`);
      return false;
    }
    if (
      slug === LOG_ACTIVITY_CONNECTION &&
      feed.expected_log_window_collected !== true
    ) {
      issues.push(
        `${label}: the expected log window has not been collected; catch-up may still be running`
      );
      return false;
    }
    return true;
  };
  return {
    product: healthy(PRODUCT_ACTIVITY_CONNECTION, "Product activity"),
    logs: healthy(LOG_ACTIVITY_CONNECTION, "Production logs"),
    issues,
  };
}

function logCounts(
  digest: ProductActivityDigest,
  coverage: DigestCoverage
): string {
  if (coverage.logs) return `${digest.errors} / ${digest.warnings}`;
  return digest.errors || digest.warnings
    ? `${digest.errors} / ${digest.warnings} observed — coverage incomplete`
    : "Unknown — coverage incomplete";
}

interface ActivityRow {
  connection_slug: string;
  title?: string | null;
  payload_text?: string | null;
  metadata?: unknown;
  source_url?: string | null;
  /** Keyset-pagination cursor columns; stripped before digesting. */
  _created_at?: string | Date | null;
  _id?: number | null;
}

interface LogActivity {
  errors?: number;
  warnings?: number;
  error_samples?: string[];
  warning_samples?: string[];
}

export interface ProductActivityDigest {
  signups: string[];
  logins: string[];
  connections: string[];
  mcp_conversations: string[];
  errors: number;
  warnings: number;
  error_samples: string[];
  warning_samples: string[];
  logs_url: string | null;
}

export function collectProductActivityDigest(
  rows: ActivityRow[],
  excludedEmail?: string | null
): ProductActivityDigest {
  const digest: ProductActivityDigest = {
    signups: [],
    logins: [],
    connections: [],
    mcp_conversations: [],
    errors: 0,
    warnings: 0,
    error_samples: [],
    warning_samples: [],
    logs_url: null,
  };

  for (const row of rows) {
    if (row.connection_slug === PRODUCT_ACTIVITY_CONNECTION) {
      const text = row.payload_text?.trim();
      if (!text) continue;
      // Presence rows carry the acting user's email; drop the excluded one
      // (typically the operator's own) so "online users" reflects the rest of
      // the team and a window where only that email was active reports nothing.
      if (
        excludedEmail &&
        (row.title === "User login" || row.title === "MCP activity") &&
        belongsToEmail(text, excludedEmail)
      ) {
        continue;
      }
      if (row.title === "New signup") digest.signups.push(text);
      if (row.title === "User login") digest.logins.push(text);
      if (row.title === "New connection") digest.connections.push(text);
      if (row.title === "MCP activity") digest.mcp_conversations.push(text);
      continue;
    }

    if (row.connection_slug === LOG_ACTIVITY_CONNECTION) {
      const activity = record(row.metadata) as unknown as LogActivity;
      digest.errors += finiteCount(activity.errors);
      digest.warnings += finiteCount(activity.warnings);
      digest.error_samples.push(...stringArray(activity.error_samples));
      digest.warning_samples.push(...stringArray(activity.warning_samples));
      if (row.source_url) digest.logs_url = row.source_url;
    }
  }

  digest.error_samples = [...new Set(digest.error_samples)];
  digest.warning_samples = [...new Set(digest.warning_samples)];
  return digest;
}

export function hasProductActivity(digest: ProductActivityDigest): boolean {
  return (
    digest.signups.length > 0 ||
    digest.logins.length > 0 ||
    digest.connections.length > 0 ||
    digest.mcp_conversations.length > 0 ||
    digest.errors > 0 ||
    digest.warnings > 0
  );
}

export function buildProductActivityCard(
  digest: ProductActivityDigest,
  window: { start: string; end: string },
  coverage: DigestCoverage
): CardElement {
  const online = uniqueUsers([...digest.logins, ...digest.mcp_conversations]);
  const productCount = (count: number) =>
    coverage.product ? count : `${count} observed`;
  const children: CardElement[] = [
    {
      type: "fields",
      children: [
        field("Signups", productCount(digest.signups.length)),
        field("Login sessions", productCount(digest.logins.length)),
        field("Online users", productCount(online.length)),
        field("New connections", productCount(digest.connections.length)),
        field(
          "Active MCP conversations",
          productCount(digest.mcp_conversations.length)
        ),
        field("Errors / warnings", logCounts(digest, coverage)),
      ],
    },
  ];

  appendSection(children, "Coverage incomplete", coverage.issues.map(safe));

  appendSection(children, "New signups", digest.signups.map(safe));
  appendSection(children, "Online users", online.map(safe));
  appendSection(children, "New connections", digest.connections.map(safe));
  appendSection(
    children,
    "Active MCP conversations",
    digest.mcp_conversations.map(safe)
  );
  appendSection(children, "Recent errors", digest.error_samples.map(safe));
  appendSection(children, "Recent warnings", digest.warning_samples.map(safe));
  if (digest.logs_url) {
    children.push({
      type: "actions",
      children: [
        {
          type: "link-button",
          url: digest.logs_url,
          label: "Open production logs",
        },
      ],
    });
  }

  return {
    type: "card",
    title: "Lobu production activity",
    subtitle: `Activity received ${formatWindow(window.start, window.end)}`,
    children,
  };
}

function field(label: string, value: string | number): CardElement {
  return { type: "field", label, value: String(value) };
}

function appendSection(
  children: CardElement[],
  heading: string,
  values: string[]
): void {
  if (values.length === 0) return;
  children.push({ type: "divider" });
  for (const content of chunkText(
    `**${heading} (${values.length})**\n${values.map((value) => `• ${value}`).join("\n")}`
  )) {
    children.push({ type: "text", content });
  }
}

function chunkText(value: string): string[] {
  const lines = value.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= CARD_TEXT_LIMIT) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line.slice(0, CARD_TEXT_LIMIT);
  }
  if (current) chunks.push(current);
  return chunks;
}

/** True when a presence payload belongs to the given email address. */
function belongsToEmail(payload: string, email: string): boolean {
  const want = email.toLowerCase();
  const match = payload.match(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
  )?.[0];
  return match != null && match.toLowerCase() === want;
}

function uniqueUsers(rows: string[]): string[] {
  const users = new Map<string, string>();
  for (const row of rows) {
    const email = row.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
    users.set(email?.toLowerCase() ?? row, row);
  }
  return [...users.values()];
}

function formatWindow(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (
    !Number.isFinite(startDate.getTime()) ||
    !Number.isFinite(endDate.getTime())
  ) {
    return `${start} → ${end}`;
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  });
  return `${formatter.format(startDate)} → ${formatter.format(endDate)} UTC`;
}

function summaryBody(
  digest: ProductActivityDigest,
  window: { start: string; end: string },
  coverage: DigestCoverage
): string {
  return (
    `${coverage.issues.length ? `Coverage incomplete: ${coverage.issues.join("; ")}. Observed activity: ` : ""}` +
    `${formatWindow(window.start, window.end)} · ` +
    `${digest.signups.length} signups · ` +
    `${digest.logins.length} login sessions · ` +
    `${uniqueUsers([...digest.logins, ...digest.mcp_conversations]).length} online users · ` +
    `${digest.connections.length} new connections · ` +
    `${digest.mcp_conversations.length} active MCP conversations · ` +
    (coverage.logs
      ? `${digest.errors} errors · ${digest.warnings} warnings`
      : `Errors / warnings: ${logCounts(digest, coverage)}`)
  );
}

function safe(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function finiteCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export default async (
  ctx: AutomationScriptContext,
  client: ReactionClient,
  params?: Record<string, unknown>
): Promise<void> => {
  const runId = Number(ctx.window.run_id);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error("Product activity digest requires a durable run id");
  }

  // The scheduler owns the durable arrival cursor. Read exactly the claimed
  // half-open window so retries cannot skip activity based on a later inbox
  // notification or include arrivals reserved for the next run.
  const start = new Date(ctx.window.window_start);
  const end = new Date(ctx.window.window_end);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start >= end
  ) {
    throw new Error("Product activity digest requires a valid arrival window");
  }

  const excludedEmail =
    typeof params?.exclude_email === "string"
      ? params.exclude_email.trim() || null
      : null;

  // Read the window in bounded keyset pages ordered by (created_at, id) and
  // exclude the operator's presence rows in memory. No leading-wildcard LIKE
  // over events, and excluded rows cannot consume a fixed LIMIT budget: the
  // cursor keeps advancing past them until the window is exhausted, so later
  // valid activity is never starved. Hitting the safety cap fails the run
  // instead of silently reporting a truncated digest.
  const rows: ActivityRow[] = [];
  let lastCreatedAt: string | null = null;
  let lastId = 0;
  const PAGE_SIZE = 1000;
  const MAX_ROWS = 20_000;
  let pageWasFull = true;
  while (pageWasFull && rows.length < MAX_ROWS) {
    const page = (await client.query(`
      SELECT
        c.slug AS connection_slug,
        e.title,
        e.payload_text,
        e.metadata,
        e.source_url,
        e.created_at AS _created_at,
        e.id AS _id
      FROM events e
      JOIN connections c ON c.id = e.connection_id
      WHERE c.slug IN ('${PRODUCT_ACTIVITY_CONNECTION}', '${LOG_ACTIVITY_CONNECTION}')
        AND e.created_at >= '${start.toISOString()}'::timestamptz
        AND e.created_at < '${end.toISOString()}'::timestamptz
        AND (
          ${
            lastCreatedAt == null
              ? "TRUE"
              : `(e.created_at > '${lastCreatedAt}'::timestamptz
              OR (e.created_at = '${lastCreatedAt}'::timestamptz AND e.id > ${lastId}))`
          }
        )
      ORDER BY e.created_at ASC, e.id ASC
      LIMIT ${PAGE_SIZE}
    `)) as ActivityRow[];
    pageWasFull = page.length === PAGE_SIZE;
    for (const row of page) {
      rows.push(row);
      if (typeof row._created_at === "string") lastCreatedAt = row._created_at;
      if (typeof row._id === "number") lastId = row._id;
    }
  }
  if (pageWasFull) {
    throw new Error(
      "Product activity digest exceeded its row budget; narrow the arrival window before retrying"
    );
  }
  const digest = collectProductActivityDigest(rows, excludedEmail);
  const expectedLogEnd = new Date(
    Math.floor((end.getTime() - LOG_INGESTION_LAG_MS) / LOG_WINDOW_MS) *
      LOG_WINDOW_MS
  ).toISOString();
  // Bounded configuration rows and an exact source-identity index probe. A
  // recent sync alone cannot prove catch-up has reached the expected window.
  const coverageRows = (await client.query(`
    SELECT c.slug AS connection_slug, c.status AS connection_status, f.status, f.last_sync_status,
      f.last_sync_at, f.consecutive_failures,
      EXISTS (SELECT 1 FROM events e WHERE e.connection_id = c.id
        AND e.origin_id = '${expectedLogEnd}' AND e.origin_type = 'log_activity'
        AND e.created_at < '${end.toISOString()}')
        AS expected_log_window_collected
    FROM connections c JOIN feeds f ON f.connection_id = c.id
    WHERE c.deleted_at IS NULL AND f.deleted_at IS NULL AND (
      (c.slug = '${PRODUCT_ACTIVITY_CONNECTION}' AND f.feed_key = 'query')
      OR (c.slug = '${LOG_ACTIVITY_CONNECTION}' AND f.feed_key = 'activity'))
  `)) as FeedCoverageRow[];
  const coverage = digestCoverage(coverageRows, end);
  if (!hasProductActivity(digest) && coverage.issues.length === 0) {
    client.log("No production activity; Slack digest skipped", {
      window_start: start.toISOString(),
      window_end: end.toISOString(),
    });
    return;
  }

  await client.notifications.send({
    title: "Lobu production activity digest",
    body: summaryBody(
      digest,
      {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      coverage
    ),
    card: buildProductActivityCard(
      digest,
      {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      coverage
    ),
    recipients: "admins",
    idempotency_key: `product-activity-digest:run:${runId}`,
    automation_source: {
      automation_id: ctx.window.automation_id,
      run_id: ctx.window.run_id,
    },
  });
};
