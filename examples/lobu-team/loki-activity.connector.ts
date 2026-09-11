import {
  type RuntimeConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

const WINDOW_MS = 20 * 60 * 1000;
const INGESTION_LAG_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CATCHUP_WINDOWS = 72;
const SAMPLE_LIMIT = 20;

interface LokiActivityConfig {
  LOKI_URL: string;
  namespace: string;
  grafana_url?: string;
}

interface LokiActivityCheckpoint {
  window_end?: string;
}

export interface LokiActivityWindow {
  start: Date;
  end: Date;
}

export interface LokiActivityResult {
  errors: number;
  warnings: number;
  error_samples: string[];
  warning_samples: string[];
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export function windowsToCollect(
  checkpoint: LokiActivityCheckpoint | null,
  now: Date
): LokiActivityWindow[] {
  const latestEndMs =
    Math.floor((now.getTime() - INGESTION_LAG_MS) / WINDOW_MS) * WINDOW_MS;
  if (!Number.isFinite(latestEndMs)) return [];

  const checkpointMs = checkpoint?.window_end
    ? new Date(checkpoint.window_end).getTime()
    : Number.NaN;
  const startMs = Number.isFinite(checkpointMs)
    ? checkpointMs
    : latestEndMs - WINDOW_MS;
  if (startMs >= latestEndMs) return [];

  // Bound each sync's work without moving the saved cursor past unread logs.
  const batchEndMs = Math.min(
    latestEndMs,
    startMs + MAX_CATCHUP_WINDOWS * WINDOW_MS
  );
  const windows: LokiActivityWindow[] = [];
  for (let cursor = startMs; cursor < batchEndMs; cursor += WINDOW_MS) {
    windows.push({
      start: new Date(cursor),
      end: new Date(cursor + WINDOW_MS),
    });
  }
  return windows;
}

export async function queryLokiActivity(
  config: LokiActivityConfig,
  window: LokiActivityWindow,
  fetchImpl: FetchLike = fetch
): Promise<LokiActivityResult> {
  const namespace = escapeLogQlString(config.namespace);
  const selector =
    `{namespace="${namespace}"} | json | __error__="" ` +
    `| level=~"(?i)(warn|warning|error|fatal|panic)"`;
  const seconds = Math.max(
    1,
    Math.ceil((window.end.getTime() - window.start.getTime()) / 1000)
  );
  const countQuery = `sum by (level) (count_over_time(${selector} [${seconds}s]))`;

  const countUrl = lokiUrl(config.LOKI_URL, "/loki/api/v1/query");
  countUrl.searchParams.set("query", countQuery);
  countUrl.searchParams.set("time", String(window.end.getTime() / 1000));
  const countBody = await getLokiJson(countUrl, fetchImpl);
  const counts = parseCountVector(countBody);
  if (counts.errors === 0 && counts.warnings === 0) {
    return {
      ...counts,
      error_samples: [],
      warning_samples: [],
    };
  }

  const sampleUrl = lokiUrl(config.LOKI_URL, "/loki/api/v1/query_range");
  sampleUrl.searchParams.set("query", selector);
  sampleUrl.searchParams.set(
    "start",
    String(BigInt(window.start.getTime()) * 1_000_000n)
  );
  sampleUrl.searchParams.set(
    "end",
    String(BigInt(window.end.getTime()) * 1_000_000n)
  );
  sampleUrl.searchParams.set("direction", "backward");
  sampleUrl.searchParams.set("limit", String(SAMPLE_LIMIT));
  const samples = parseLogStreams(await getLokiJson(sampleUrl, fetchImpl));
  return { ...counts, ...samples };
}

function lokiUrl(baseUrl: string, path: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
}

async function getLokiJson(url: URL, fetchImpl: FetchLike): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Loki query failed with ${response.status}`);
  return response.json();
}

function parseCountVector(body: unknown): {
  errors: number;
  warnings: number;
} {
  const parsed = body as {
    status?: unknown;
    data?: { resultType?: unknown; result?: unknown };
  };
  if (
    parsed.status !== "success" ||
    parsed.data?.resultType !== "vector" ||
    !Array.isArray(parsed.data.result)
  ) {
    throw new Error("Loki count query returned an invalid response");
  }

  let errors = 0;
  let warnings = 0;
  for (const entry of parsed.data.result) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as {
      metric?: { level?: unknown };
      value?: unknown[];
    };
    const level = String(row.metric?.level ?? "").toLowerCase();
    const value = Number(row.value?.[1] ?? 0);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Loki count query returned an invalid count");
    }
    if (["error", "fatal", "panic"].includes(level)) errors += value;
    if (["warn", "warning"].includes(level)) warnings += value;
  }
  return { errors, warnings };
}

function parseLogStreams(body: unknown): {
  error_samples: string[];
  warning_samples: string[];
} {
  const parsed = body as {
    status?: unknown;
    data?: { resultType?: unknown; result?: unknown };
  };
  if (
    parsed.status !== "success" ||
    parsed.data?.resultType !== "streams" ||
    !Array.isArray(parsed.data.result)
  ) {
    throw new Error("Loki sample query returned an invalid response");
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const entry of parsed.data.result) {
    if (!entry || typeof entry !== "object") continue;
    const stream = entry as {
      stream?: Record<string, unknown>;
      values?: unknown[];
    };
    for (const value of stream.values ?? []) {
      if (!Array.isArray(value) || typeof value[1] !== "string") continue;
      const line = parseLogLine(value[1], stream.stream ?? {});
      if (!line) continue;
      if (["error", "fatal", "panic"].includes(line.level)) {
        if (!errors.includes(line.text)) errors.push(line.text);
      } else if (["warn", "warning"].includes(line.level)) {
        if (!warnings.includes(line.text)) warnings.push(line.text);
      }
    }
  }
  return {
    error_samples: errors.slice(0, 10),
    warning_samples: warnings.slice(0, 10),
  };
}

function parseLogLine(
  raw: string,
  stream: Record<string, unknown>
): { level: string; text: string } | null {
  let record: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(raw) as unknown;
    if (candidate && typeof candidate === "object") {
      record = candidate as Record<string, unknown>;
    }
  } catch {
    record = {};
  }
  const level = String(record.level ?? stream.level ?? "").toLowerCase();
  if (!level) return null;
  const message = String(
    record.message ?? record.msg ?? record.error ?? record.err ?? raw
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  if (!message) return null;
  const source = String(
    stream.pod ??
      stream.app ??
      stream.container ??
      record.service ??
      "kubernetes"
  );
  return { level, text: `[${source}] ${message}` };
}

function escapeLogQlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export default class LokiActivityConnector extends ConnectorRuntime<
  LokiActivityCheckpoint,
  LokiActivityConfig
> {
  readonly definition: RuntimeConnectorDefinition<
    LokiActivityCheckpoint,
    LokiActivityConfig
  > = {
    key: "loki.activity",
    name: "Kubernetes logs",
    description:
      "Collect error and warning counts plus recent samples from Lobu production Loki in aligned 20-minute windows.",
    version: "1.0.1",
    authSchema: {
      methods: [
        {
          type: "env_keys",
          required: true,
          scope: "connection",
          fields: [
            {
              key: "LOKI_URL",
              label: "Loki URL",
              secret: true,
              required: true,
            },
          ],
        },
      ],
    },
    feeds: {
      activity: {
        sync: (ctx) => this.syncFeed(ctx),
        key: "activity",
        name: "Production log activity",
        configSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        eventKinds: {
          log_activity: {
            description:
              "Kubernetes warning/error counts and samples for one 20-minute production window.",
          },
        },
      },
    },
    optionsSchema: {
      type: "object",
      required: ["namespace"],
      properties: {
        namespace: { type: "string", minLength: 1 },
        grafana_url: { type: "string", format: "uri" },
      },
      additionalProperties: false,
    },
  };

  private async syncFeed(
    ctx: SyncContext<LokiActivityCheckpoint, LokiActivityConfig>
  ): Promise<SyncResult<LokiActivityCheckpoint>> {
    if (!ctx.config.LOKI_URL?.trim()) throw new Error("LOKI_URL is required");
    if (!ctx.config.namespace?.trim()) throw new Error("namespace is required");

    const windows = windowsToCollect(ctx.checkpoint, new Date());
    const events: EventEnvelope[] = [];
    for (const window of windows) {
      const activity = await queryLokiActivity(ctx.config, window);
      // Persist empty windows too: a durable zero distinguishes successful
      // collection from a missing or failed log feed.
      events.push({
        origin_id: window.end.toISOString(),
        origin_type: "log_activity",
        title: `${activity.errors} errors · ${activity.warnings} warnings`,
        payload_text:
          `${activity.errors} production errors and ${activity.warnings} warnings ` +
          `from ${window.start.toISOString()} to ${window.end.toISOString()}.`,
        source_url: ctx.config.grafana_url,
        occurred_at: window.end,
        metadata: {
          ...activity,
          window_start: window.start.toISOString(),
          window_end: window.end.toISOString(),
          namespace: ctx.config.namespace,
        },
      });
    }

    const windowEnd =
      windows.at(-1)?.end.toISOString() ?? ctx.checkpoint?.window_end;
    return {
      events,
      checkpoint: windowEnd ? { window_end: windowEnd } : {},
    };
  }
}
