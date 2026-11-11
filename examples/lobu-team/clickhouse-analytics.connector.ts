import {
  ConnectorRuntime,
  type QueryContext,
  type QueryResult,
  type RuntimeConnectorDefinition,
  type EventAttributionRule,
} from "@lobu/connector-sdk";
import { readUserMilestones } from "./user-milestones.ts";

const productUserAttributions: EventAttributionRule[] = [
  {
    role: "about",
    target: {
      entityType: "product-user",
      identities: [
        {
          namespace: "lobu_product_account_id",
          eventPath: "metadata.user_id",
          primary: true,
        },
      ],
    },
    autoCreate: false,
  },
];

const milestoneMetadata = {
  type: "object",
  required: [
    "user_id",
    "computed_at",
    "event_type",
    "evidence_basis",
    "source",
    "coverage",
  ],
  properties: {
    user_id: { type: "string" },
    computed_at: {
      type: "string",
      format: "date-time",
      description:
        "When this materialized version was computed; not a refresh heartbeat.",
    },
    event_type: { type: "string" },
    evidence_basis: { enum: ["inferred", "observed"] },
    source: { type: "string" },
    coverage: { type: "object" },
    attribution_method: { type: "string" },
    success_kind: { enum: ["agent_reply", "source_read", "automation_output"] },
  },
};

interface AnalyticsConfig {
  CLICKHOUSE_URL: string;
}

const MAX_BYTES = 2 * 1024 * 1024;
const TOTAL = "__lobu_analytics_total__";
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

/** Only a wrapping/statement gate. The server's immutable profile and grants
 * enforce read-only execution and deny external sources independently. */
export function readOnlyQuery(raw: string): string {
  const sql = raw.trim().replace(/;\s*$/, "");
  if (!sql || new TextEncoder().encode(sql).length > 65536)
    invalid("SQL must contain 1–65536 UTF-8 bytes");
  let code = "";
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      const start = i;
      let closed = false;
      while (++i < sql.length) {
        if (sql[i] === "\\") i++;
        else if (sql[i] === quote) {
          if (sql[i + 1] === quote) i++;
          else {
            closed = true;
            break;
          }
        }
      }
      if (!closed) invalid("Unterminated SQL quote");
      if (
        quote !== "'" &&
        sql
          .slice(start, i + 1)
          .toLowerCase()
          .includes(TOTAL)
      )
        invalid("Reserved analytics column name");
      // A quoted identifier stays an identifier token so `"db".settings` still
      // reads as qualified; a string literal leaves no token.
      code += quote === "'" ? " " : " _ ";
    } else if ((c === "-" && sql[i + 1] === "-") || c === "#") {
      while (i < sql.length && sql[i] !== "\n") i++;
      code += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      let comments = 1;
      i += 2;
      while (i < sql.length && comments) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          comments++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          comments--;
          i += 2;
        } else i++;
      }
      if (comments) invalid("Unterminated SQL comment");
      i--;
      code += " ";
    } else {
      if (c === ";" || c === "\0")
        invalid("Only one SELECT statement is allowed");
      // ClickHouse $$…$$ / $tag$…$tag$ heredoc strings would hide clauses
      // from this scanner; bare identifiers never contain `$`.
      if (c === "$") invalid("Heredoc strings are not supported");
      if (c === "(") depth++;
      if (c === ")" && --depth < 0) invalid("Unbalanced SQL parentheses");
      code += c;
    }
  }
  if (depth) invalid("Unbalanced SQL parentheses");
  if (code.toLowerCase().includes(TOTAL))
    invalid("Reserved analytics column name");
  if (!/^\s*\(*\s*(SELECT|WITH)\b/i.test(code))
    invalid("Only SELECT or WITH SELECT is allowed");
  // A keyword joined by a dot to another identifier is part of a qualified
  // name, e.g. system.tables or t.settings. A number beside the dot (`1.`,
  // `.5`) is a float literal, so the keyword stays a clause. Quotes and
  // comments have already been removed, so only SQL tokens remain.
  const tokens =
    code.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9][A-Za-z0-9_]*|[^\s]/g) ?? [];
  const identifier = (token: string | undefined) =>
    token !== undefined && /^[A-Za-z_]/.test(token);
  if (
    tokens.some(
      (token, i) =>
        /^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|RENAME|ATTACH|DETACH|SET|SYSTEM|KILL|GRANT|REVOKE|OPTIMIZE|BACKUP|RESTORE|INTO|OUTFILE|FORMAT|SETTINGS)$/i.test(
          token
        ) &&
        !(tokens[i - 1] === "." && identifier(tokens[i - 2])) &&
        !(tokens[i + 1] === "." && identifier(tokens[i + 2]))
    )
  )
    invalid("SQL contains an unsupported statement or output clause");
  return sql;
}

const MAX_EXCEPTION_CHARS = 1000;
const MAX_EXCEPTION_BYTES = 8 * 1024;

/** At most `maxBytes` of the body as text; the rest is never read. */
async function readPrefix(
  response: Response,
  maxBytes: number
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (size < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const take = Math.min(next.value.byteLength, maxBytes - size);
      bytes.set(next.value.subarray(0, take), size);
      size += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, size));
}

/** The exception ClickHouse itself raised for the query, or null. Only a
 * response carrying ClickHouse's exception-code header is ClickHouse's own
 * text; anything else (a proxy, an auth failure) may echo request headers, so
 * it is never relayed. The text has ClickHouse's fixed shape
 * `Code: N. DB::Exception: <message>. (NAME) (version …)`. */
async function clickHouseException(response: Response): Promise<string | null> {
  if (
    !response.headers.has("X-ClickHouse-Exception-Code") ||
    response.status === 401 ||
    response.status === 403
  )
    return null;
  let text = (await readPrefix(response, MAX_EXCEPTION_BYTES)).trim();
  const prefix = "DB::Exception: ";
  const start = text.indexOf(prefix);
  if (start !== -1) text = text.slice(start + prefix.length);
  const version = text.lastIndexOf(" (version ");
  if (version !== -1) text = text.slice(0, version);
  return text.slice(0, MAX_EXCEPTION_CHARS) || null;
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const exception = await clickHouseException(response);
    if (!response.bodyUsed) await response.body?.cancel();
    throw Object.assign(
      new Error(
        exception
          ? `Analytics query failed: ${exception}`
          : `Analytics query failed (HTTP ${response.status})`
      ),
      { status: response.status }
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Analytics returned no response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) throw new Error("Analytics response exceeds 2 MiB");
      chunks.push(next.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Keep the original read failure. */
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Analytics returned invalid JSON");
  }
}

function count(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error("Analytics returned an invalid result count");
  if (!/^\d+$/.test(String(value)))
    throw new Error("Analytics returned an invalid result count");
  const total = Number(value);
  if (!Number.isSafeInteger(total))
    throw new Error("Analytics count exceeds the supported range");
  return total;
}

/** Uses the existing gateway-bound fetch transport; no credentials are read
 * from ctx.credentials or placed in worker-supplied headers. */
export async function queryAnalytics(
  ctx: QueryContext<AnalyticsConfig>,
  fetchImpl: FetchLike = fetch
): Promise<QueryResult> {
  const url = new URL(ctx.config.CLICKHOUSE_URL);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    invalid("CLICKHOUSE_URL must be an HTTPS origin");
  const sql = readOnlyQuery(ctx.query);
  // Metric pushdown requests 5000 rows and uses total to detect truncation.
  const requestedLimit = ctx.limit ?? 50;
  const limit = Math.min(requestedLimit, 500);
  const offset = ctx.offset ?? 0;
  if (
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10000
  )
    invalid("Pagination requires a positive integer limit and offset 0–10000");
  let order = "";
  if (ctx.sort) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ctx.sort.column))
      invalid("Invalid sort column");
    if (ctx.sort.order !== "asc" && ctx.sort.order !== "desc")
      invalid("Invalid sort direction");
    order = `ORDER BY q.\`${ctx.sort.column}\` ${ctx.sort.order.toUpperCase()}`;
  }
  const signal = AbortSignal.timeout(20000);
  async function run(statement: string): Promise<{
    meta: { name: string; type: string }[];
    data: Record<string, unknown>[];
  }> {
    if (new TextEncoder().encode(statement).length > 65536)
      invalid("Wrapped SQL exceeds 65536 UTF-8 bytes");
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Accept: "application/json" },
        body: statement,
        redirect: "error",
        signal,
      });
    } catch {
      throw new Error("Analytics transport failed");
    }
    const body = (await jsonResponse(response)) as {
      meta?: unknown;
      data?: unknown;
      exception?: unknown;
    } | null;
    if (
      !body ||
      body.exception ||
      !Array.isArray(body.meta) ||
      !Array.isArray(body.data)
    )
      throw new Error("Analytics returned an invalid query result");
    const meta = body.meta as { name: string; type: string }[];
    if (
      meta.some(
        (c) => !c || typeof c.name !== "string" || typeof c.type !== "string"
      ) ||
      new Set(meta.map((c) => c.name)).size !== meta.length
    )
      throw new Error("Analytics returned invalid or duplicate columns");
    const data = body.data as Record<string, unknown>[];
    if (data.some((r) => !r || typeof r !== "object" || Array.isArray(r)))
      throw new Error("Analytics returned invalid rows");
    return { meta, data };
  }
  const result = await run(
    `SELECT q.*, count() OVER () AS ${TOTAL} FROM (\n${sql}\n) AS q ${order} LIMIT ${limit} OFFSET ${offset} FORMAT JSON`
  );
  if (result.data.length > limit || !result.meta.some((c) => c.name === TOTAL))
    throw new Error("Analytics returned an invalid page");
  let total: number;
  if (result.data.length) {
    total = count(result.data[0][TOTAL]);
    if (
      result.data.some((r) => count(r[TOTAL]) !== total) ||
      total < offset + result.data.length
    )
      throw new Error("Analytics returned inconsistent pagination");
  } else {
    const counts = await run(
      `SELECT count() AS ${TOTAL} FROM (\n${sql}\n) AS q FORMAT JSON`
    );
    if (counts.data.length !== 1)
      throw new Error("Analytics returned an invalid result count");
    total = count(counts.data[0][TOTAL]);
    if (total > offset)
      throw new Error(
        "Analytics source changed while counting; retry the query"
      );
  }
  return {
    rows: result.data.map(({ [TOTAL]: _total, ...row }) => row),
    columns: result.meta.filter((c) => c.name !== TOTAL),
    total,
  };
}

export default class ClickHouseAnalyticsConnector extends ConnectorRuntime<
  Record<string, unknown>,
  AnalyticsConfig
> {
  readonly definition: RuntimeConnectorDefinition<
    Record<string, unknown>,
    AnalyticsConfig
  > = {
    key: "clickhouse.analytics",
    name: "ClickHouse analytics",
    version: "2.0.0",
    description:
      "Run governed read-only SQL against an organization-owned ClickHouse analytics endpoint. Discover accessible tables and columns with SELECT from system.tables and system.columns; information_schema requires separate grants.",
    authSchema: {
      methods: [
        {
          type: "env_keys",
          required: true,
          scope: "connection",
          fields: [
            {
              key: "AUTHORIZATION",
              label: "Analytics HTTP authorization",
              secret: true,
              required: true,
            },
          ],
        },
      ],
    },
    optionsSchema: {
      type: "object",
      properties: { CLICKHOUSE_URL: { type: "string", format: "uri" } },
      required: ["CLICKHOUSE_URL"],
      additionalProperties: false,
    },
    feeds: {
      user_milestones: {
        key: "user_milestones",
        name: "User journey milestones",
        description:
          "Read-only derived attribution and first observed success. Signup belongs to Postgres. IP/browser attribution is inferred; success covers the 90-day signup cohort within 7 days of signup, refreshed every 6 hours. Missing milestones do not prove inactivity; this feed does not trigger Automations.",
        userManaged: true,
        configSchema: { type: "object", properties: {} },
        matchPaths: ["metadata.user_id"],
        eventKinds: {
          "product.landing_attributed": {
            description:
              "Inferred external landing match by IP and browser within 24 hours; not verified visitor identity.",
            metadataSchema: milestoneMetadata,
            attributions: productUserAttributions,
          },
          "product.first_success": {
            description:
              "First observed qualifying success within 7 days of signup for the 90-day cohort; includes account or personal-organization activity.",
            metadataSchema: milestoneMetadata,
            attributions: productUserAttributions,
          },
        },
        read: (ctx) => readUserMilestones(ctx, queryAnalytics),
      },
    },
  };

  async query(ctx: QueryContext<AnalyticsConfig>): Promise<QueryResult> {
    return queryAnalytics(ctx);
  }
}
