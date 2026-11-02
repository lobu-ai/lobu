import {
  ConnectorRuntime,
  type QueryContext,
  type QueryResult,
  type RuntimeConnectorDefinition,
} from "@lobu/connector-sdk";

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
      code += " ";
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
  if (
    /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|RENAME|ATTACH|DETACH|SET|SYSTEM|KILL|GRANT|REVOKE|OPTIMIZE|BACKUP|RESTORE|INTO|OUTFILE|FORMAT|SETTINGS)\b/i.test(
      code
    )
  )
    invalid("SQL contains an unsupported statement or output clause");
  return sql;
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Analytics query failed (HTTP ${response.status})`);
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
    version: "1.0.0",
    description:
      "Run governed read-only SQL against an organization-owned ClickHouse analytics endpoint.",
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
  };

  async query(ctx: QueryContext<AnalyticsConfig>): Promise<QueryResult> {
    return queryAnalytics(ctx);
  }
}
