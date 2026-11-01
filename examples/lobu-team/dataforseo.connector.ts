/**
 * DataForSEO Connector (lobu-team project-owned) — SEO reads.
 *
 * Three read-only actions, each a single request:
 *
 *   - `serp_live({ keyword, ... })` → Google Organic SERP items (Live POST).
 *   - `keyword_search_volume({ keywords, ... })` → Google Ads search volume
 *     (Live POST).
 *   - `account_balance()` → free `appendix/user_data` balance check (GET, no
 *     charge).
 *
 * One `rank_tracking` feed on the cheaper Standard method
 * (task_post → tasks_ready → task_get): one event per keyword per UTC day.
 * Posted task ids are committed to the checkpoint before polling, so a failed
 * poll never re-posts (re-bills) tasks that were already paid for.
 *
 * Auth is `env_keys` DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD, sent as
 * `Authorization: Basic base64(login:password)` per request (same isolate-safe
 * `btoa` pattern as the reddit connector). Credentials arrive via ctx.config;
 * nothing secret is logged or persisted.
 *
 * Cost guards (not API limits): serp `depth` defaults 10, max 100; search
 * volume takes at most 20 keywords per call. Every paid call returns its
 * `cost` so the agent sees spend. Retries re-bill, so unlike free lookups
 * these actions do NOT claim `idempotentHint`.
 */

import {
  type ActionContext,
  type ActionResult,
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  sleep,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

const API_BASE = "https://api.dataforseo.com/v3";
const SERP_LIVE_PATH = "/serp/google/organic/live/regular";
const SEARCH_VOLUME_LIVE_PATH = "/keywords_data/google_ads/search_volume/live";
const USER_DATA_PATH = "/appendix/user_data";
const SERP_TASK_POST_PATH = "/serp/google/organic/task_post";
const SERP_TASKS_READY_PATH = "/serp/google/organic/tasks_ready";
const SERP_TASK_GET_ADVANCED_PATH = "/serp/google/organic/task_get/advanced";

const DEFAULT_LOCATION_CODE = 2840; // United States
const DEFAULT_LANGUAGE_CODE = "en";
const MAX_SERP_DEPTH = 100;
const MAX_KEYWORDS_PER_CALL = 20;
const MAX_SNIPPET_CHARS = 500;
// Standard-method bounds (cheap bulk path; Live stays for on-demand reads).
// 100 is task_post's per-call cap, so one post covers a whole feed.
const MAX_TRACKED_KEYWORDS = 100;
const MAX_READY_POLLS = 5;
const READY_POLL_INTERVAL_MS = 30_000; // tasks_ready allows 20 calls/min
// Normal-priority Standard tasks finish in minutes. One that has not shown up
// in tasks_ready after this long is treated as lost, so a stuck task cannot
// keep the feed in an endless `more` loop.
const MAX_PENDING_AGE_MS = 2 * 60 * 60 * 1000;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

interface DataForSeoTask {
  id?: string;
  status_code?: number;
  status_message?: string;
  cost?: number;
  result?: unknown;
}

interface DataForSeoEnvelope {
  status_code?: number;
  status_message?: string;
  tasks?: DataForSeoTask[];
}

/** Build the Basic auth header value. Pure, never logged. */
function basicAuthHeader(login: string, password: string): string {
  return `Basic ${btoa(`${login}:${password}`)}`;
}

function readCredentials(config: Record<string, unknown>): {
  login: string;
  password: string;
} {
  const login = (config.DATAFORSEO_LOGIN as string | undefined)?.trim();
  const password = (config.DATAFORSEO_PASSWORD as string | undefined)?.trim();
  if (!login || !password) {
    throw new Error(
      "DataForSEO credentials are missing — set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD on the connection's auth profile."
    );
  }
  return { login, password };
}

/**
 * Classify a DataForSEO HTTP response by status code; returns only when ok.
 * 403 is NOT a credential error: DataForSEO documents only 401/402/404/500 as
 * its own HTTP codes, so a 403 comes from an intermediary (egress proxy or
 * upstream WAF). Keep the body — it identifies which.
 */
async function assertHttpOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  if (response.status === 401) {
    throw new Error(
      "DataForSEO authentication failed (HTTP 401) — check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD."
    );
  }
  const text = await response.text().catch(() => "");
  if (response.status === 403) {
    throw new Error(
      `DataForSEO ${label} refused (HTTP 403, not a credential error): ${text.slice(0, 300)}`
    );
  }
  throw new Error(
    `DataForSEO ${label} failed (HTTP ${response.status}): ${text.slice(0, 300)}`
  );
}

async function postLive<T>(
  path: string,
  login: string,
  password: string,
  body: unknown,
  fetchImpl: FetchLike = fetch
): Promise<{ payload: T; cost: number }> {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: basicAuthHeader(login, password),
    },
    body: JSON.stringify(body),
  });
  await assertHttpOk(response, "request");
  const envelope = (await response.json()) as DataForSeoEnvelope;
  // Classify on the numeric status codes, never on message text.
  if (envelope.status_code !== 20000) {
    throw new Error(
      `DataForSEO error ${envelope.status_code}: ${envelope.status_message ?? "unknown"}`
    );
  }
  const task = envelope.tasks?.[0];
  if (!task || task.status_code !== 20000 || task.result == null) {
    throw new Error(
      `DataForSEO task error ${task?.status_code}: ${task?.status_message ?? "empty result"}`
    );
  }
  return { payload: task.result as T, cost: task.cost ?? 0 };
}

// ── SERP live ─────────────────────────────────────────────────────────────

interface SerpLiveInput {
  keyword?: string;
  location_code?: number;
  location_name?: string;
  language_code?: string;
  language_name?: string;
  depth?: number;
  device?: string;
}

interface SerpOrganicItem {
  rank_group: number;
  rank_absolute: number;
  domain: string;
  title: string;
  url: string;
  description?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Curate one SERP live result into organic items + a type histogram. Pure. */
function parseSerpResult(result: unknown): {
  items: SerpOrganicItem[];
  result_types: Record<string, number>;
  check_url?: string;
  datetime?: string;
} {
  const root = asRecord(result);
  const rawItems = Array.isArray(root?.items) ? root.items : [];
  const items: SerpOrganicItem[] = [];
  const result_types: Record<string, number> = {};
  for (const raw of rawItems) {
    const item = asRecord(raw);
    if (!item) continue;
    const type = asString(item.type) ?? "unknown";
    result_types[type] = (result_types[type] ?? 0) + 1;
    if (type !== "organic") continue;
    const rank_group = asNumber(item.rank_group);
    const rank_absolute = asNumber(item.rank_absolute);
    const url = asString(item.url);
    if (rank_group === undefined || rank_absolute === undefined || !url)
      continue;
    const description = asString(item.description);
    items.push({
      rank_group,
      rank_absolute,
      domain: asString(item.domain) ?? "",
      title: asString(item.title) ?? "",
      url,
      description: description?.slice(0, MAX_SNIPPET_CHARS) || undefined,
    });
  }
  items.sort((a, b) => a.rank_absolute - b.rank_absolute);
  return {
    items,
    result_types,
    check_url: asString(root?.check_url),
    datetime: asString(root?.datetime),
  };
}

// ── Search volume live ────────────────────────────────────────────────────

interface KeywordVolume {
  keyword: string;
  search_volume?: number;
  cpc?: number;
  competition?: number;
  competition_index?: number;
}

/** Curate search-volume rows; unknown shapes are skipped, never crash. Pure. */
function parseVolumeResult(result: unknown): KeywordVolume[] {
  const rows = Array.isArray(result) ? result : [];
  const out: KeywordVolume[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    const keyword = asString(row.keyword);
    if (!keyword) continue;
    out.push({
      keyword,
      search_volume: asNumber(row.search_volume),
      cpc: asNumber(row.cpc),
      competition: asNumber(row.competition),
      competition_index: asNumber(row.competition_index),
    });
  }
  return out;
}

// ── Shared location/language props (used by feed + action schemas) ───────

const locationProps = {
  location_code: {
    type: "integer",
    description: `Search engine location code (e.g. 2840 = United States). Defaults to ${DEFAULT_LOCATION_CODE}. Use either this or location_name.`,
  },
  location_name: {
    type: "string",
    description:
      'Search engine location name (e.g. "United States"). Use either this or location_code.',
  },
};

const languageProps = {
  language_code: {
    type: "string",
    description: `Search engine language code (e.g. "en"). Defaults to "${DEFAULT_LANGUAGE_CODE}". Use either this or language_name.`,
  },
  language_name: {
    type: "string",
    description:
      'Search engine language name (e.g. "English"). Use either this or language_code.',
  },
};

// ── Rank tracking feed (Standard method) ─────────────────────────────────
// Cheap bulk path: task_post (≤100/call) → tasks_ready poll → task_get.
// One event per keyword per day; resyncs supersede via the stable origin_id.

interface RankTrackingConfig {
  keywords?: string[];
  target_domain?: string;
  location_code?: number;
  location_name?: string;
  language_code?: string;
  language_name?: string;
  depth?: number;
  device?: string;
  priority?: number;
}

interface PendingRankTask {
  keyword: string;
  task_id: string;
  /** ISO time of the task_post that created (and billed) the task. */
  posted_at: string;
}

export interface RankTrackingCheckpoint {
  pending?: PendingRankTask[];
  /**
   * Keywords whose task posted on `day` (UTC) is settled: recorded, failed, or
   * expired. Each keyword is posted (billed) at most once per day; a `more`
   * continuation re-runs immediately and must not re-post them.
   */
  completed?: { day: string; keywords: string[] };
  last_sync_at?: string;
}

/** URL/host-safe slug for origin_id. Pure. */
function slugifyKeyword(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Stable origin_id: same keyword + same UTC day = same id across syncs. Pure. */
export function rankEventId(keyword: string, day: string): string {
  return `dataforseo_rank_${day}_${slugifyKeyword(keyword)}`;
}

/** Best organic hit on the target domain (exact or subdomain). Pure. */
function findTargetHit(
  items: SerpOrganicItem[],
  targetDomain: string
): SerpOrganicItem | undefined {
  const target = targetDomain.trim().toLowerCase();
  if (!target) return undefined;
  return items.find(
    (item) => item.domain === target || item.domain.endsWith(`.${target}`)
  );
}

/**
 * One Standard task per keyword. Results are matched back by task id; the
 * tag (≤255 chars) only labels the task in DataForSEO's own task list. Pure.
 */
function buildRankTasks(
  keywords: string[],
  opts: {
    location_code?: number;
    location_name?: string;
    language_code?: string;
    language_name?: string;
    depth: number;
    device: string;
    priority?: number;
  }
): Array<Record<string, unknown>> {
  return keywords.map((keyword) => {
    const task: Record<string, unknown> = {
      keyword,
      location_code: opts.location_code ?? DEFAULT_LOCATION_CODE,
      language_code: opts.language_code ?? DEFAULT_LANGUAGE_CODE,
      depth: opts.depth,
      device: opts.device,
      tag: keyword.slice(0, 255),
    };
    if (opts.location_name) {
      delete task.location_code;
      task.location_name = opts.location_name;
    }
    if (opts.language_name) {
      delete task.language_code;
      task.language_name = opts.language_name;
    }
    // priority is opt-in only: high-priority tasks cost more.
    if (opts.priority === 2) task.priority = 2;
    return task;
  });
}

const rankTrackingConfigSchema = {
  type: "object",
  required: ["keywords"],
  properties: {
    keywords: {
      type: "array",
      minItems: 1,
      maxItems: MAX_TRACKED_KEYWORDS,
      items: { type: "string", minLength: 1 },
      description: `Keywords to track (max ${MAX_TRACKED_KEYWORDS}, the task_post per-call cap).`,
    },
    target_domain: {
      type: "string",
      description:
        'Domain to find in each SERP (e.g. "lobu.ai" — subdomains match). Omit to record top results without a target.',
    },
    ...locationProps,
    ...languageProps,
    depth: {
      type: "integer",
      minimum: 1,
      maximum: MAX_SERP_DEPTH,
      default: 20,
      description: `Results per SERP (default 20, max ${MAX_SERP_DEPTH}).`,
    },
    device: {
      type: "string",
      enum: ["desktop", "mobile"],
      default: "desktop",
    },
    priority: {
      type: "integer",
      enum: [1, 2],
      default: 1,
      description: "Standard priority: 1 normal, 2 high (costs more).",
    },
  },
};

/** GET helper with Basic auth + credential-aware errors. */
async function getJson<T>(
  path: string,
  login: string,
  password: string,
  fetchImpl: FetchLike = fetch
): Promise<T> {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: basicAuthHeader(login, password) },
  });
  await assertHttpOk(response, "request");
  return (await response.json()) as T;
}

interface ReadyTaskEntry {
  id?: string;
}

/** Post Standard tasks; classify per-task by numeric code (20100 = created). */
async function postRankTasks(
  tasks: Array<Record<string, unknown>>,
  login: string,
  password: string,
  fetchImpl: FetchLike = fetch
): Promise<{ created: PendingRankTask[]; rejected: number }> {
  const response = await fetchImpl(`${API_BASE}${SERP_TASK_POST_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: basicAuthHeader(login, password),
    },
    body: JSON.stringify(tasks),
  });
  await assertHttpOk(response, "task_post");
  const envelope = (await response.json()) as DataForSeoEnvelope;
  if (envelope.status_code !== 20000 || !Array.isArray(envelope.tasks)) {
    throw new Error(
      `DataForSEO task_post error ${envelope.status_code}: ${envelope.status_message ?? "unknown"}`
    );
  }
  const created: PendingRankTask[] = [];
  const postedAt = new Date().toISOString();
  let rejected = 0;
  envelope.tasks.forEach((task, index) => {
    const requested = tasks[index] ?? {};
    if (task.status_code === 20100 && task.id) {
      created.push({
        keyword: String(requested.keyword ?? ""),
        task_id: task.id,
        posted_at: postedAt,
      });
    } else {
      rejected += 1;
    }
  });
  return { created, rejected };
}

// ── Input schemas ─────────────────────────────────────────────────────────

const serpLiveInputSchema = {
  type: "object",
  required: ["keyword"],
  properties: {
    keyword: {
      type: "string",
      minLength: 1,
      maxLength: 700,
      description: "Keyword to fetch the live Google Organic SERP for.",
    },
    ...locationProps,
    ...languageProps,
    depth: {
      type: "integer",
      minimum: 1,
      maximum: MAX_SERP_DEPTH,
      default: 10,
      description: `How many results to parse (default 10, max ${MAX_SERP_DEPTH} — cost guard, not an API limit: billing rises past 10).`,
    },
    device: {
      type: "string",
      enum: ["desktop", "mobile"],
      default: "desktop",
      description: "Device type to return results for.",
    },
  },
};

const searchVolumeInputSchema = {
  type: "object",
  required: ["keywords"],
  properties: {
    keywords: {
      type: "array",
      minItems: 1,
      maxItems: MAX_KEYWORDS_PER_CALL,
      items: { type: "string", minLength: 1 },
      description: `Keywords to look up (max ${MAX_KEYWORDS_PER_CALL} per call — cost guard).`,
    },
    ...locationProps,
    ...languageProps,
  },
};

// ── Connector ─────────────────────────────────────────────────────────────

export default class DataForSeoConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "dataforseo",
    name: "DataForSEO",
    description:
      "On-demand SEO reads via DataForSEO Live endpoints plus scheduled rank tracking via the Standard method. Read-only; every paid call reports its cost.",
    version: "1.1.0",
    faviconDomain: "dataforseo.com",
    authSchema: {
      methods: [
        {
          type: "env_keys",
          required: true,
          scope: "connection",
          description:
            "API login and password from app.dataforseo.com/api-access (this is the API password, not the account password).",
          fields: [
            {
              key: "DATAFORSEO_LOGIN",
              label: "API login",
              secret: true,
              required: true,
            },
            {
              key: "DATAFORSEO_PASSWORD",
              label: "API password",
              secret: true,
              required: true,
            },
          ],
        },
      ],
    },
    feeds: {
      rank_tracking: {
        key: "rank_tracking",
        name: "Rank tracking",
        description:
          "Scheduled Google Organic rank checks via the Standard method (task_post → tasks_ready → task_get). One event per keyword per day.",
        sync: (ctx: SyncContext) => this.syncRankTracking(ctx),
        configSchema: rankTrackingConfigSchema,
        eventKinds: {
          rank_check: {
            description: "A keyword's SERP rank snapshot for one day",
            metadataSchema: {
              type: "object",
              properties: {
                keyword: { type: "string" },
                target_domain: { type: "string" },
                rank_group: { type: "number" },
                rank_absolute: { type: "number" },
                url: { type: "string" },
                organic_total: { type: "number" },
                check_url: { type: "string" },
                cost: { type: "number" },
              },
            },
          },
        },
      },
    },
    actions: {
      serp_live: {
        key: "serp_live",
        name: "Live SERP",
        kind: "read",
        description:
          "Fetch the live Google Organic SERP for one keyword. Returns organic items as { rank_group, rank_absolute, domain, title, url, description } plus cost.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: serpLiveInputSchema,
      },
      keyword_search_volume: {
        key: "keyword_search_volume",
        name: "Keyword search volume",
        kind: "read",
        description:
          "Look up Google Ads search volume, CPC and competition for keywords. Returns one row per keyword plus cost.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: searchVolumeInputSchema,
      },
      account_balance: {
        key: "account_balance",
        name: "Account balance",
        kind: "read",
        description:
          "Free balance/limits check (appendix/user_data — not charged). Call before paid actions when spend is uncertain.",
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: { type: "object", properties: {} },
      },
    },
  };

  fetchImpl: FetchLike = fetch;
  // Test hooks (defaults honor the tasks_ready 20-calls/min limit).
  pollIntervalMs = READY_POLL_INTERVAL_MS;
  maxPolls = MAX_READY_POLLS;

  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      if (ctx.actionKey === "serp_live") return await this.serpLive(ctx);
      if (ctx.actionKey === "keyword_search_volume")
        return await this.searchVolume(ctx);
      if (ctx.actionKey === "account_balance")
        return await this.accountBalance(ctx);
      return { success: false, error: `Unknown action '${ctx.actionKey}'` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async serpLive(ctx: ActionContext): Promise<ActionResult> {
    const { login, password } = readCredentials(ctx.config);
    const input = ctx.input as SerpLiveInput;
    const keyword = (input.keyword ?? "").trim();
    if (!keyword) throw new Error("keyword is required");
    if (keyword.length > 700)
      throw new Error("keyword must be at most 700 characters");
    const depth = input.depth ?? 10;

    const task: Record<string, unknown> = {
      keyword,
      location_code: input.location_code ?? DEFAULT_LOCATION_CODE,
      language_code: input.language_code ?? DEFAULT_LANGUAGE_CODE,
      depth,
      device: input.device ?? "desktop",
    };
    if (input.location_name) {
      delete task.location_code;
      task.location_name = input.location_name;
    }
    if (input.language_name) {
      delete task.language_code;
      task.language_name = input.language_name;
    }

    const { payload, cost } = await postLive<unknown[]>(
      SERP_LIVE_PATH,
      login,
      password,
      [task],
      this.fetchImpl
    );
    const parsed = parseSerpResult(payload[0]);
    return {
      success: true,
      output: {
        keyword,
        cost,
        organic_found: parsed.items.length,
        ...parsed,
      },
    };
  }

  private async searchVolume(ctx: ActionContext): Promise<ActionResult> {
    const { login, password } = readCredentials(ctx.config);
    const input = ctx.input as {
      keywords?: string[];
      location_code?: number;
      location_name?: string;
      language_code?: string;
      language_name?: string;
    };
    const keywords = (input.keywords ?? [])
      .map((k) => k.trim())
      .filter(Boolean);
    if (keywords.length === 0) throw new Error("keywords is required");
    if (keywords.length > MAX_KEYWORDS_PER_CALL) {
      throw new Error(
        `At most ${MAX_KEYWORDS_PER_CALL} keywords per call — split the list.`
      );
    }

    const task: Record<string, unknown> = {
      keywords,
      location_code: input.location_code ?? DEFAULT_LOCATION_CODE,
      language_code: input.language_code ?? DEFAULT_LANGUAGE_CODE,
    };
    if (input.location_name) {
      delete task.location_code;
      task.location_name = input.location_name;
    }
    if (input.language_name) {
      delete task.language_code;
      task.language_name = input.language_name;
    }

    const { payload, cost } = await postLive<unknown>(
      SEARCH_VOLUME_LIVE_PATH,
      login,
      password,
      [task],
      this.fetchImpl
    );
    const rows = parseVolumeResult(payload);
    return {
      success: true,
      output: { cost, keywords_found: rows.length, keywords: rows },
    };
  }

  private async accountBalance(ctx: ActionContext): Promise<ActionResult> {
    const { login, password } = readCredentials(ctx.config);
    const envelope = await getJson<DataForSeoEnvelope>(
      USER_DATA_PATH,
      login,
      password,
      this.fetchImpl
    );
    const taskResult = envelope.tasks?.[0]?.result;
    const result = asRecord(
      Array.isArray(taskResult) ? taskResult[0] : undefined
    );
    // Surface balance + totals only; rates/price tables are noise here.
    return {
      success: true,
      output: {
        login: asString(result?.login),
        balance: asRecord(result?.money)?.balance,
        total_deposited: asRecord(result?.money)?.total,
      },
    };
  }

  private rankEvent(
    keyword: string,
    targetDomain: string | undefined,
    parsed: ReturnType<typeof parseSerpResult>,
    cost: number
  ): EventEnvelope {
    const day =
      parsed.datetime?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    const hit = targetDomain
      ? findTargetHit(parsed.items, targetDomain)
      : undefined;
    const title = hit
      ? `${keyword} — #${hit.rank_absolute} (${hit.domain})`
      : `${keyword} — target not in top ${parsed.items.length}`;
    const lines = [
      `Keyword "${keyword}": ${hit ? `rank ${hit.rank_absolute} at ${hit.url}` : "target domain not found in organic results"}.`,
      `${parsed.items.length} organic results${parsed.check_url ? ` (${parsed.check_url})` : ""}.`,
      `Task cost $${cost}.`,
    ];
    return {
      origin_id: rankEventId(keyword, day),
      origin_type: "rank_check",
      title,
      payload_text: lines.join(" "),
      occurred_at: parsed.datetime ? new Date(parsed.datetime) : new Date(),
      metadata: {
        keyword,
        target_domain: targetDomain,
        rank_group: hit?.rank_group,
        rank_absolute: hit?.rank_absolute,
        url: hit?.url,
        organic_total: parsed.items.length,
        check_url: parsed.check_url,
        cost,
      },
    };
  }

  private async syncRankTracking(ctx: SyncContext): Promise<SyncResult> {
    const { login, password } = readCredentials(ctx.config);
    const config = ctx.config as unknown as RankTrackingConfig;
    const keywords = [
      ...new Set((config.keywords ?? []).map((k) => k.trim()).filter(Boolean)),
    ];
    if (keywords.length === 0) {
      throw new Error("rank_tracking feed requires keywords");
    }
    if (keywords.length > MAX_TRACKED_KEYWORDS) {
      throw new Error(
        `At most ${MAX_TRACKED_KEYWORDS} keywords per feed — split the list.`
      );
    }
    const depth = config.depth ?? 20;
    const device = config.device ?? "desktop";
    const targetDomain = config.target_domain?.trim() || undefined;
    const checkpoint = (ctx.checkpoint ?? {}) as RankTrackingCheckpoint;
    const today = new Date().toISOString().slice(0, 10);
    const doneKeywords = new Set(
      checkpoint.completed?.day === today ? checkpoint.completed.keywords : []
    );
    // A task settles the day it was posted; one posted yesterday never
    // blocks today's check of the same keyword.
    const settle = (task: PendingRankTask): void => {
      if (task.posted_at.slice(0, 10) === today) doneKeywords.add(task.keyword);
    };
    let uncommitted: EventEnvelope[] = [];
    let found = 0;
    let skipped = 0;
    const now = Date.now();
    let pending: PendingRankTask[] = [];
    for (const task of checkpoint.pending ?? []) {
      if (now - Date.parse(task.posted_at) <= MAX_PENDING_AGE_MS) {
        pending.push(task);
      } else {
        settle(task);
        skipped += 1;
      }
    }

    const commit = async (): Promise<void> => {
      const batch = uncommitted;
      uncommitted = [];
      await ctx.commit(batch, {
        pending,
        completed: { day: today, keywords: [...doneKeywords] },
        last_sync_at: new Date().toISOString(),
      } satisfies RankTrackingCheckpoint);
    };

    const collectReady = async (): Promise<void> => {
      if (pending.length === 0) return;
      const ready = await getJson<{
        tasks?: Array<{ result?: ReadyTaskEntry[] }>;
      }>(SERP_TASKS_READY_PATH, login, password, this.fetchImpl);
      const readyIds = new Set(
        (ready.tasks?.[0]?.result ?? [])
          .map((entry) => entry.id)
          .filter((id): id is string => typeof id === "string")
      );
      const stillPending: PendingRankTask[] = [];
      for (const task of pending) {
        if (!readyIds.has(task.task_id)) {
          stillPending.push(task);
          continue;
        }
        const got = await getJson<DataForSeoEnvelope>(
          `${SERP_TASK_GET_ADVANCED_PATH}/${task.task_id}`,
          login,
          password,
          this.fetchImpl
        );
        const completed = got.tasks?.[0];
        const result = completed?.result;
        const first = Array.isArray(result) ? result[0] : result;
        settle(task);
        if (completed?.status_code !== 20000 || first == null) {
          // Counted, not retried today: re-posting would bill again.
          skipped += 1;
          continue;
        }
        uncommitted.push(
          this.rankEvent(
            task.keyword,
            targetDomain,
            parseSerpResult(first),
            completed.cost ?? 0
          )
        );
        found += 1;
      }
      pending = stillPending;
    };

    await collectReady();

    const pendingKeywords = new Set(pending.map((task) => task.keyword));
    const fresh = keywords.filter(
      (keyword) => !doneKeywords.has(keyword) && !pendingKeywords.has(keyword)
    );
    if (fresh.length > 0) {
      const { created, rejected } = await postRankTasks(
        buildRankTasks(fresh, {
          location_code: config.location_code,
          location_name: config.location_name,
          language_code: config.language_code,
          language_name: config.language_name,
          depth,
          device,
          priority: config.priority,
        }),
        login,
        password,
        this.fetchImpl
      );
      pending.push(...created);
      skipped += rejected;
      // task_post is billed on creation: persist the ids before polling so a
      // failed poll cannot make the next run re-post (re-bill) them.
      await commit();
    }

    for (let poll = 0; poll < this.maxPolls && pending.length > 0; poll++) {
      await sleep(this.pollIntervalMs);
      await collectReady();
    }

    await commit();
    return {
      status: pending.length > 0 ? "more" : "complete",
      metadata: {
        items_found: found,
        items_skipped: skipped,
        pending: pending.length,
      },
    };
  }
}
