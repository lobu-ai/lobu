/**
 * `@lobu/views` authoring surface (brief §1.4): `defineView`, `useParams`,
 * `useScope`, `useQuery`, `useAction`, `sql`, plus the `mountView` entry the
 * compiled bundle calls once. Thin layer over the hand-written `ViewBridge` —
 * nothing here talks to the API directly; every read and action goes through
 * the host as `tools/call`, every param change through
 * `ui/update-model-context`.
 *
 * Contract with the host (our web host, Claude, any MCP Apps host):
 *  - `ui/notifications/tool-input` `arguments` = `{ scope, params }`
 *    (in Claude these are the `open_view` tool arguments).
 *  - reads: `query_sql`, `query_sdk`, and tools the registry marks
 *    `readOnlyHint` (`read_knowledge`, `get_automation`, `query_metric`, …);
 *    actions: `invoke_view_action`. The web host refuses every other tool, so
 *    mixed read/write tools such as `manage_connections` are not reachable
 *    from a view: read that data with a `query_sdk` script
 *    (`client.connections.list()`) instead.
 *  - `setParams` → `ui/update-model-context` `{ structuredContent: { view,
 *    params } }`; the web host mirrors it into the address bar. Hosts without
 *    that capability keep params local to the frame.
 *
 * Read budget: reads run on a user-facing path, when the host is ready and
 * the query changes, `refetch()` is called, or a live query receives a host
 * data-change notification.
 * `query_sql` runs in a read-only, org-scoped transaction with a 5 second
 * statement timeout and returns at most 500 rows; `useQuery` reports a hit as
 * `errorCode: "UPSTREAM_TIMEOUT"` or `truncated: true`, so render those
 * states instead of an empty or partial table. Each cell is bounded too
 * (strings to a 4,000-code-point head plus a suffix, JSON values to 16 KiB);
 * `truncatedColumns` names the columns where a returned cell was cut.
 * Never aggregate history in a view: no `GROUP BY`, `DISTINCT ON`, per-row
 * regexp, or leading-wildcard `LIKE` over `events` (or any other table that
 * grows with history). History grows; the answer a view shows does not.
 *
 * For "latest state" views, compute state at write time. One event-based
 * pattern is an Automation bound to the entity declaring a keyed event output
 * (`outputs: { status: { event: "account_status", key: ["account"] } }`), so
 * each emitted update supersedes the previous event with the same output
 * identity. The view reads current events with `read_knowledge`
 * (registry-marked `readOnlyHint`, so the host lets a view call it), which
 * skips superseded rows:
 *
 * ```tsx
 * const { entity } = useScope();
 * const status = useQuery<{ content: Array<{ title: string | null;
 *   metadata: Record<string, unknown> }> }>(
 *   typeof entity === "number"
 *     ? tool("read_knowledge", { entity_id: entity,
 *         semantic_type: "account_status", sort_by: "date", limit: 1 })
 *     : null
 * );
 * const current = status.data?.content[0];
 * ```
 */

import type { CollectionSelection } from "@lobu/core/contracts/tools/collection-selection";
import type { ViewAttachment } from "@lobu/core/contracts/tools/manage-views";
import {
  Component,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { type HostContext, type ToolResult, ViewBridge } from "./bridge.js";

export type ParamValue = string | number | boolean;
export type Params = Record<string, ParamValue>;

/**
 * What the view is rendering. `type` on a type page, `entity` (plus its
 * `type`) on a record page, `event` on an event's page, nothing on the Data hub.
 *
 * `event` is the resolved stored version supplied by the host. New actions
 * reject a superseded version; reopening resolves the permalink again.
 * There is no event hook: read it with the same exact-id read the event page
 * renders. Select the supplied version from the returned lineage so the
 * displayed content and action subject stay aligned:
 *
 * ```tsx
 * export const view = defineView({
 *   key: "deal-won",
 *   attach: [{ event: "deal.won", type: "deal" }],
 * });
 *
 * export default function DealWon() {
 *   const { event } = useScope();
 *   const read = useQuery<{ content: Array<{ id: number;
 *     title: string | null; metadata: Record<string, unknown> }> }>(
 *     event === undefined ? null : tool("read_knowledge", { content_ids: [event] })
 *   );
 *   const subject = read.data?.content.find((row) => row.id === event);
 *   return <h1>{subject?.title}</h1>;
 * }
 * ```
 */
export interface Scope {
  type?: string;
  entity?: number | string;
  event?: number;
  /** Shared collection selection; absent on record, event and workspace pages.
   * Pass search/filters/segment to entities.list alongside entity_type: type.
   * Host selection does not replace view-specific sort/layout params. */
  collection?: CollectionSelection;
}

export interface ParamDef {
  type: "string" | "number" | "boolean";
  default?: ParamValue;
  /** Offer this param in the host's filter bar: a set value shows as a chip
   *  above the view, and picking one updates the param. Options make it a
   *  pick list; without them the host asks for a value of the param's type. */
  filter?: {
    label: string;
    options?: Array<{ value: ParamValue; label: string }>;
  };
}

/**
 * Where a view appears: one page per entry.
 *
 * - `{ record: "deal" }` — a card on every deal's page, above its activity;
 *   `{ record: "deal", id: 7 }` pins it to one record. The card renders
 *   `inline`; "See all" (`requestDisplayMode("fullscreen")`) or the card's
 *   Open shows the same view fullscreen in the peek.
 * - `{ collection: "deal", when? }` — a tab on the deal list page. `when`
 *   equalities must all be present in scope.collection.filters; they control
 *   discoverability, never authorization.
 * - `{ workspace: true }` — a tab on the Data hub.
 * - `{ event: "deal.won", type? }` — one event's page, optionally only when
 *   the event links an entity of `type`.
 */
export type Attachment = ViewAttachment;

/** How the host is showing the view: a card in a page (`inline`) or the
 *  view's own surface (`fullscreen`: the peek, a full page, a tab). */
export type DisplayMode = "inline" | "fullscreen";

/** The space the host gives the frame. Width is fixed or capped; an inline
 *  card's `maxHeight` is the height budget past which the host clips. */
export interface Container {
  width?: number;
  maxWidth?: number;
  height?: number;
  maxHeight?: number;
}

export interface ViewDefinition {
  /** View key: the single namespace of keys (no `custom:` prefix). Required —
   *  it is the identity `invoke_view_action` and the shell route key on. */
  key: string;
  /** Display name; defaults to the key when the view is saved. */
  name?: string;
  description?: string;
  /** Where the view appears. The attach line lives in the module; there are
   *  no attach/detach verbs. */
  attach: Attachment[];
  params?: Record<string, ParamDef>;
  actions?: Record<string, { emits: string }>;
}

export function defineView(def: ViewDefinition): ViewDefinition {
  if (!def || typeof def.key !== "string" || def.key.length === 0) {
    throw new Error(
      "defineView({ key, attach, ... }) requires a non-empty key"
    );
  }
  if (!Array.isArray(def.attach)) {
    throw new Error(`defineView("${def.key}") requires attach to be an array`);
  }
  return def;
}

interface ViewRuntime {
  def: ViewDefinition;
  connected: boolean;
  /** True once the first `tool-input` arrived. Queries stay parked until
   *  then: the host seeds scope + params there, and anything read earlier
   *  runs against defaults and fetches twice. */
  ready: boolean;
  scope: Scope;
  params: Params;
  setParams: (patch: Partial<Params>) => void;
  theme: "light" | "dark";
  /** Bumped when the host reports a workspace data change; live reads re-run. */
  dataVersion: number;
  callTool: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<ToolResult>;
  openLink: (url: string) => Promise<void>;
  displayMode: DisplayMode;
  container: Container;
  requestDisplayMode: (mode: DisplayMode) => Promise<DisplayMode>;
}

const Ctx = createContext<ViewRuntime | null>(null);

function useRuntime(): ViewRuntime {
  const rt = useContext(Ctx);
  if (!rt) throw new Error("@lobu/views hooks must run inside mountView()");
  return rt;
}

export function useParams(): readonly [
  Params,
  (patch: Partial<Params>) => void,
] {
  const rt = useRuntime();
  return [rt.params, rt.setParams] as const;
}

export function useScope(): Scope {
  return useRuntime().scope;
}

export function useHost(): {
  connected: boolean;
  ready: boolean;
  theme: "light" | "dark";
  /**
   * Ask the host to open `url`. A relative URL (`"deal/acme-renewal"`, a
   * record's `<type>/<slug>`) resolves against the workspace root, so the same
   * link works on every page and in every host; a full URL opens outside the
   * app. The frame is sandboxed, so this is the only way a view navigates;
   * rejects when the host declines.
   */
  openLink: (url: string) => Promise<void>;
  /** `inline` as a card on a page, `fullscreen` as the view's own surface.
   *  Render a summary inline and the full view fullscreen. */
  displayMode: DisplayMode;
  container: Container;
  /** Ask the host for another mode ("See all" → `"fullscreen"`). Resolves with
   *  the mode the host set, which stays the current one when it declines. */
  requestDisplayMode: (mode: DisplayMode) => Promise<DisplayMode>;
} {
  const rt = useRuntime();
  return {
    connected: rt.connected,
    ready: rt.ready,
    theme: rt.theme,
    openLink: rt.openLink,
    displayMode: rt.displayMode,
    container: rt.container,
    requestDisplayMode: rt.requestDisplayMode,
  };
}

/** The workspace root relative links resolve against: the shell's
 *  `lobu-workspace` meta, absent outside a server-rendered shell. */
export function resolveViewHref(href: string): string {
  const base = document
    .querySelector('meta[name="lobu-workspace"]')
    ?.getAttribute("content");
  if (!base) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function resultError(result: ToolResult): string | null {
  if (result.isError !== true) return null;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((c) =>
      c && typeof c === "object" && (c as { type?: string }).type === "text"
        ? String((c as { text?: unknown }).text ?? "")
        : ""
    )
    .join("\n")
    .trim();
  return text || "The host reported a tool error.";
}

/**
 * Tagged template: scalar values are rendered as escaped SQL literals,
 * never spliced raw. Numbers must be finite, booleans map to true/false,
 * null/undefined become NULL, strings are single-quote escaped; anything
 * else (objects, arrays) throws rather than stringifying a blob into the
 * query. `query_sql` takes no bind parameters, so the guest escapes and the
 * server validates tables — server-side binding stays a one-paragraph
 * proposal until a use case needs it.
 */
export interface SqlQuery {
  kind: "sql";
  text: string;
}
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SqlQuery {
  let text = "";
  strings.forEach((s, i) => {
    text += s;
    if (i < values.length) text += escapeLiteral(values[i]);
  });
  return { kind: "sql", text };
}

export function escapeLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("sql: only finite numbers can be bound");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(
    "sql: only string, number, boolean, null values can be bound"
  );
}

/** Direct tool read, for a tool the registry marks `readOnlyHint`
 *  (`read_knowledge`, `get_automation`, …). The web host refuses mixed
 *  read/write tools such as `manage_connections`; use `query_sdk` for those reads. */
export interface ToolQuery {
  kind: "tool";
  name: string;
  args: Record<string, unknown>;
}
export function tool(
  name: string,
  args: Record<string, unknown> = {}
): ToolQuery {
  if (!name) throw new Error("tool() requires a tool name");
  return { kind: "tool", name, args };
}

function parseTextJson(result: ToolResult): unknown {
  const content = Array.isArray(result.content) ? result.content : [];
  for (const c of content) {
    if (!c || typeof c !== "object" || (c as { type?: string }).type !== "text")
      continue;
    let text = String((c as { text?: unknown }).text ?? "").trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fence?.[1]) text = fence[1].trim();
    try {
      return JSON.parse(text);
    } catch {
      // not JSON — keep looking
    }
  }
  return null;
}

/**
 * Read one `useQuery` result. A failed read is an error, never an empty
 * result: `query_sql` answers a rejected statement (unknown table, bad column)
 * with a normal result carrying `error` beside `rows: []`, and `query_sdk`
 * reports a thrown script as `success: false` — both would otherwise render as
 * "no rows". The server's typed code rides along as `errorCode`, and a capped
 * result (`query_sql`'s `has_more`, `query_sdk`'s `return_truncated`) is
 * flagged `truncated` instead of passing as the whole answer, and a
 * `query_sql` cell bounded by its size limits is named in `truncatedColumns`.
 */
export function queryResult<T>(
  kind: "sql" | "sdk" | "tool",
  result: ToolResult
): Pick<
  QueryState<T>,
  "data" | "error" | "errorCode" | "truncated" | "truncatedColumns"
> {
  // structuredContent when the tool declares an outputSchema (query_sql,
  // query_sdk, every read tool on MCP hosts); otherwise the text body.
  const sc = (result.structuredContent ??
    parseTextJson(result) ??
    {}) as Record<string, unknown>;
  if (kind === "sql" && typeof sc.error === "string" && sc.error)
    return {
      data: null,
      error: sc.error,
      errorCode: typeof sc.error_code === "string" ? sc.error_code : null,
      truncated: false,
      truncatedColumns: [],
    };
  if (kind === "sdk" && sc.success === false) {
    const e = sc.error as
      | { message?: unknown; code?: unknown }
      | string
      | undefined;
    const message = typeof e === "string" ? e : e?.message;
    const code = typeof e === "object" ? e?.code : undefined;
    return {
      data: null,
      error:
        typeof message === "string" && message
          ? message
          : "Query script failed",
      errorCode: typeof code === "string" ? code : null,
      truncated: false,
      truncatedColumns: [],
    };
  }
  // MCP also marks resolved SQL/SDK failures isError; decode their envelopes
  // above before falling back to the host's text and thrown-error metadata.
  const err = resultError(result);
  if (err) {
    const e = sc.error as { code?: unknown } | null | undefined;
    const code = typeof e === "object" ? e?.code : undefined;
    return {
      data: null,
      error: err,
      errorCode: typeof code === "string" ? code : null,
      truncated: false,
      truncatedColumns: [],
    };
  }
  // query_sdk → { success, return_value }, query_sql → { rows }, a named
  // tool → its whole body.
  const data = (
    kind === "sdk" ? sc.return_value : kind === "tool" ? sc : sc.rows
  ) as T;
  const truncated =
    kind === "sql"
      ? sc.has_more === true
      : kind === "sdk" && sc.return_truncated != null;
  const truncatedColumns =
    kind === "sql" && Array.isArray(sc.truncated_columns)
      ? sc.truncated_columns.filter((c): c is string => typeof c === "string")
      : [];
  return {
    data: data ?? null,
    error: null,
    errorCode: null,
    truncated,
    truncatedColumns,
  };
}

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  /** The server's typed code for a failed read, e.g. `UPSTREAM_TIMEOUT` when
   *  the statement ran past `query_sql`'s 5 second timeout. Branch on this,
   *  never on `error` text. Null on success or when the host gave no code. */
  errorCode: string | null;
  /** True when the server capped the answer: `query_sql` returns at most 500
   *  rows (fewer past its response-size ceiling) and `query_sdk` drops an
   *  oversized return value. `data` is then not the whole result. */
  truncated: boolean;
  /** `query_sql` columns where a returned cell was bounded: a string cut to
   *  its first 4,000 Unicode code points plus "… [truncated]", or a JSON value
   *  over 16 KiB replaced by `{ _truncated: true, bytes }` (attachments become
   *  null with attachments_truncated). Show those cells as too large, or select
   *  smaller elements or fields, e.g. `jsonb_array_elements(metadata->'items')`.
   *  Paginate as needed; each returned cell is still subject to these limits. */
  truncatedColumns: string[];
  loading: boolean;
  refetch: () => void;
}

export interface QueryOptions {
  /** Re-read in the background whenever workspace data changes (default
   *  true). Pass false for a read that reaches a remote source, such as a
   *  `feeds.readMany` search: it then runs once per query and again only on
   *  `refetch()`. */
  live?: boolean;
}

/**
 * Run a read through the host. `sql\`…\`` → `query_sql`; a string →
 * `query_sdk` script; `tool(name, args)` → that tool; `null` skips. The first
 * fetch waits for the host's first `tool-input`: reads before it run against
 * defaults and double-fetch when the real scope lands.
 */
export function useQuery<T = unknown>(
  query: SqlQuery | ToolQuery | string | null,
  options: QueryOptions = {}
): QueryState<T> {
  const live = options.live ?? true;
  const rt = useRuntime();
  const [state, setState] = useState<Omit<QueryState<T>, "refetch">>({
    data: null,
    error: null,
    errorCode: null,
    truncated: false,
    truncatedColumns: [],
    loading: query !== null,
  });
  const [tick, setTick] = useState(0);
  // A host data change re-reads the same query in the background: the rows
  // already on screen stay until the fresh ones land, so a live view never
  // flashes its loading state on every write.
  const lastRead = useRef<{
    key: string | null;
    dataVersion: number;
    tick: number;
  } | null>(null);
  // Reads are numbered so a newer read never discards an older one still in
  // flight for the same key: under a steady stream of writes every re-read
  // would be superseded before it answered. Only a key change, or a newer
  // answer already on screen, drops a result.
  const readSeq = useRef(0);
  const shownSeq = useRef(0);
  const key =
    query === null
      ? null
      : typeof query === "string"
        ? `sdk:${query}`
        : query.kind === "tool"
          ? `tool:${query.name}:${JSON.stringify(query.args)}`
          : `sql:${query.text}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the stable identity of query (listing query itself refetches every render); rt.callTool is stable; tick and rt.dataVersion are the intentional refetch triggers.
  useEffect(() => {
    // A skipped query is idle, even when the previous request is in flight.
    if (key === null) {
      lastRead.current = null;
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return;
    }
    // Queries still wait for the host to seed scope and params.
    if (!rt.ready) return;
    // A non-live read ignores data changes; a new key or refetch() still reads.
    if (
      !live &&
      lastRead.current?.key === key &&
      lastRead.current.tick === tick
    ) {
      return;
    }
    const seq = ++readSeq.current;
    const show = (next: Omit<QueryState<T>, "refetch">) => {
      if (lastRead.current?.key !== key || seq < shownSeq.current) return;
      shownSeq.current = seq;
      setState(next);
    };
    const background =
      lastRead.current?.key === key &&
      lastRead.current.tick === tick &&
      lastRead.current.dataVersion !== rt.dataVersion;
    lastRead.current = { key, dataVersion: rt.dataVersion, tick };
    if (!background) setState((s) => ({ ...s, loading: true }));
    const q = query as SqlQuery | ToolQuery | string;
    const call =
      typeof q === "string"
        ? rt.callTool("query_sdk", { script: q })
        : q.kind === "tool"
          ? rt.callTool(q.name, q.args)
          : rt.callTool("query_sql", { sql: q.text, limit: 500 });
    call
      .then((result) => {
        const out = queryResult<T>(
          typeof q === "string" ? "sdk" : q.kind === "tool" ? "tool" : "sql",
          result
        );
        show({ ...out, loading: false });
      })
      .catch((e: unknown) => {
        show({
          data: null,
          error: e instanceof Error ? e.message : String(e),
          errorCode: null,
          truncated: false,
          truncatedColumns: [],
          loading: false,
        });
      });
  }, [key, rt.ready, tick, rt.dataVersion, live]);
  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refetch };
}

export interface ActionResult {
  ok: boolean;
  error: string | null;
  result: unknown;
  /** Retry the same submission after a failed acknowledgement. A new call to
   * useAction's function is a new intent, even when its value is identical. */
  retry: (() => Promise<ActionResult>) | null;
}

/** Mint one id for a deliberate submission, retained by its retry closure. */
export function mintInteractionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** Submit a declared action. Failed acknowledgements expose an explicit retry
 * that keeps the original value, event subject and interaction id. */
export function useAction(
  name: string
): (value?: Record<string, unknown>) => Promise<ActionResult> {
  const rt = useRuntime();
  if (!rt.def.actions?.[name]) {
    throw new Error(`Action "${name}" is not declared on view "${rt.def.key}"`);
  }
  return useCallback(
    async (value: Record<string, unknown> = {}) => {
      if (!rt.ready) {
        return {
          ok: false,
          error: "The host has not supplied the view subject.",
          result: null,
          retry: null,
        };
      }
      let args: Record<string, unknown>;
      try {
        // Snapshot JSON before the first send; edits to a form after a failure
        // must not change the meaning of an already accepted submission.
        args = JSON.parse(
          JSON.stringify({
            view: rt.def.key,
            action: name,
            value,
            ...(rt.scope.event === undefined
              ? {}
              : { scope: { event: rt.scope.event } }),
            interaction_id: mintInteractionId(),
          })
        );
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          result: null,
          retry: null,
        };
      }
      const submit = async (): Promise<ActionResult> => {
        try {
          const result = await rt.callTool("invoke_view_action", args);
          const error = resultError(result);
          return {
            ok: !error,
            error,
            result: result.structuredContent ?? null,
            retry: error ? submit : null,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            result: null,
            retry: submit,
          };
        }
      };
      return submit();
    },
    [rt, name]
  );
}

export function defaultsFor(def: ViewDefinition): Params {
  const out: Params = {};
  for (const [k, p] of Object.entries(def.params ?? {})) {
    if (p.default !== undefined) out[k] = p.default;
  }
  return out;
}

export function coerceParams(def: ViewDefinition, raw: unknown): Params {
  const out = defaultsFor(def);
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const decl = def.params?.[k];
    if (!decl) continue; // unknown params ignored (§1.6)
    if (decl.type === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (decl.type === "boolean") {
      out[k] = v === true || v === "true";
    } else if (v !== undefined && v !== null) {
      out[k] = String(v);
    }
  }
  return out;
}

export function coerceScope(raw: unknown): Scope {
  if (!raw || typeof raw !== "object") return {};
  const scope = raw as Record<string, unknown>;
  const out: Scope = {};
  if (typeof scope.type === "string" && scope.type.length > 0)
    out.type = scope.type;
  if (typeof scope.entity === "number" || typeof scope.entity === "string") {
    out.entity = scope.entity;
  }
  if (typeof scope.event === "number" && Number.isInteger(scope.event)) {
    out.event = scope.event;
  }
  if (scope.collection !== undefined) {
    if (!out.type || out.entity !== undefined || out.event !== undefined) {
      throw new Error("Collection selection requires a type page");
    }
    if (
      !scope.collection ||
      typeof scope.collection !== "object" ||
      Array.isArray(scope.collection)
    ) {
      throw new Error("Collection selection must be an object");
    }
    // The host validates selection. Preserve it for the validating read API;
    // never drop an unfamiliar filter and silently widen the collection.
    out.collection = scope.collection as CollectionSelection;
  }
  return out;
}

function themeFromContext(ctx: HostContext): "light" | "dark" {
  return ctx.theme === "dark" ? "dark" : "light";
}

/** `pip` and unknown modes render like a card; only fullscreen is the full view. */
function displayModeFromContext(ctx: HostContext): DisplayMode {
  return ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
}

function containerFromContext(ctx: HostContext): Container {
  const raw = ctx.containerDimensions;
  if (!raw || typeof raw !== "object") return {};
  const out: Container = {};
  for (const key of ["width", "maxWidth", "height", "maxHeight"] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

/**
 * The MCP Apps standard style variables (`McpUiStyleVariableKey`, protocol
 * `2026-01-26`). A host sends any subset in `hostContext.styles.variables`;
 * the shell's tokens (`--fg`, `--muted`, `--border`, `--accent`, the font and
 * radii) derive from them, so a view takes the host's look. Built from the
 * spec's own axes rather than imported: the guest carries no ext-apps code.
 */
const SEMANTIC = ["primary", "secondary", "tertiary", "inverse", "ghost"];
const STATUS = ["info", "danger", "success", "warning"];
const HEADINGS = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"];
const HOST_STYLE_KEYS: ReadonlySet<string> = new Set([
  ...["background", "text", "border"].flatMap((part) =>
    [...SEMANTIC, ...STATUS, "disabled"].map((v) => `--color-${part}-${v}`)
  ),
  ...["primary", "secondary", "inverse", ...STATUS].map(
    (v) => `--color-ring-${v}`
  ),
  "--font-sans",
  "--font-mono",
  ...["normal", "medium", "semibold", "bold"].map((w) => `--font-weight-${w}`),
  ...["size", "line-height"].flatMap((m) => [
    ...["xs", "sm", "md", "lg"].map((s) => `--font-text-${s}-${m}`),
    ...HEADINGS.map((s) => `--font-heading-${s}-${m}`),
  ]),
  ...["xs", "sm", "md", "lg", "xl", "full"].map((r) => `--border-radius-${r}`),
  "--border-width-regular",
  ...["hairline", "sm", "md", "lg"].map((s) => `--shadow-${s}`),
]);

/**
 * Apply the host's standard style variables to the document root. Every
 * standard key is set or cleared from the current context, so a variable a
 * theme switch drops does not linger; anything outside the standard list is
 * ignored, never written.
 */
function applyHostStyles(ctx: HostContext): void {
  const styles = ctx.styles as { variables?: unknown } | undefined;
  const variables =
    styles && typeof styles.variables === "object" && styles.variables
      ? (styles.variables as Record<string, unknown>)
      : {};
  const root = document.documentElement.style;
  for (const key of HOST_STYLE_KEYS) {
    const value = variables[key];
    if (typeof value === "string" && value.trim()) {
      root.setProperty(key, value);
    } else {
      root.removeProperty(key);
    }
  }
}

/**
 * Contains a render error to the view so the Provider (which owns the host
 * handshake) stays mounted: an uncaught error would unmount it before its
 * effect connects, leaving the host a blank frame with no size and no error.
 * `resetKey` changes when the host delivers scope/params or data changes, so
 * a render that only failed for lack of scope retries once it arrives.
 */
class RenderBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: Error | null; resetKey: string }
> {
  state = { error: null as Error | null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: Error | null; resetKey: string }
  ) {
    return props.resetKey === state.resetKey
      ? null
      : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown) {
    console.error("[lobu-views] view failed to render", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ padding: 12, color: "var(--fg)" }}>
        This view failed to render: {this.state.error.message}
      </div>
    );
  }
}

/**
 * Host bridge provider: seeds scope/params from the first tool-input,
 * exposes reads/actions over tools/call, mirrors params through
 * update-model-context. The server bootstrap renders this around the view's
 * default export; `mountView` does the same for CLI-bundled entries.
 */
export function Provider({
  def,
  bridge,
  children,
}: {
  def: ViewDefinition;
  bridge?: ViewBridge;
  children: ReactNode;
}) {
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [scope, setScope] = useState<Scope>({});
  const [params, setParamsState] = useState<Params>(() => defaultsFor(def));
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [container, setContainer] = useState<Container>({});
  const [dataVersion, setDataVersion] = useState(0);
  const bridgeRef = useRef<ViewBridge | null>(bridge ?? null);
  if (bridge) bridgeRef.current = bridge;
  if (bridgeRef.current === null) bridgeRef.current = new ViewBridge();

  useEffect(() => {
    const b = bridgeRef.current;
    // Unreachable in practice (the body above always installs a bridge
    // before effects run); fail loud instead of dereferencing null.
    if (!b) throw new Error("@lobu/views provider has no host bridge");
    const offInput = b.onToolInput((args) => {
      const input = (args ?? {}) as { scope?: unknown; params?: unknown };
      setScope(coerceScope(input.scope));
      setParamsState(coerceParams(def, input.params));
      setReady(true);
    });
    // MCP hosts initially send the permalink arguments. The opening result
    // supplies the exact readable version, including after a supersession.
    const offResult = b.onToolResult((result) => {
      const resolved = result.structuredContent as
        | { view?: unknown; scope?: unknown }
        | undefined;
      if (resolved?.view === def.key && resolved.scope) {
        setScope(coerceScope(resolved.scope));
      }
    });
    const adoptContext = (ctx: HostContext) => {
      const next = themeFromContext(ctx);
      setTheme(next);
      applyTheme(next);
      applyHostStyles(ctx);
      setDisplayMode(displayModeFromContext(ctx));
      setContainer(containerFromContext(ctx));
    };
    const offCtx = b.onHostContext(adoptContext);
    const offData = b.onDataChanged(() => setDataVersion((v) => v + 1));
    b.connect()
      .then((ctx) => {
        adoptContext(ctx);
        setConnected(true);
        setReady(b.hasToolInput());
        document.documentElement.setAttribute("data-ready", "true");
      })
      .catch((e) => console.error("[lobu-views] connect failed", e));
    return () => {
      offInput();
      offResult();
      offCtx();
      offData();
    };
  }, [def]);

  // Report the document height so the host can fit the frame. This lives in
  // the provider, not `mountView`: the server bootstrap renders the provider
  // directly, and a frame that never hears a size stays at its minimum height.
  useEffect(() => {
    const b = bridgeRef.current;
    if (!b) return;
    const reportSize = () => {
      const doc = document.documentElement;
      doc.setAttribute("data-mounted", "true");
      const prev = doc.style.height;
      doc.style.height = "max-content";
      const height = Math.ceil(doc.getBoundingClientRect().height);
      doc.style.height = prev;
      b.notifySize(Math.ceil(window.innerWidth), height);
    };
    reportSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reportSize);
    observer.observe(document.documentElement);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  const setParams = useCallback(
    (patch: Partial<Params>) => {
      setParamsState((prev) => {
        const next = coerceParams(def, { ...prev, ...patch });
        const b = bridgeRef.current;
        if (b) {
          b.updateModelContext({ view: def.key, params: next }).catch(() => {
            /* host without update-model-context: params stay frame-local */
          });
        }
        return next;
      });
    },
    [def]
  );

  const callTool = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      const b = bridgeRef.current;
      if (!b?.isConnected()) {
        // No handshake yet — fail loud instead of queueing into a dead host.
        throw new Error("Not connected to a host");
      }
      return b.callTool(name, args);
    },
    []
  );

  const openLink = useCallback(async (url: string) => {
    const b = bridgeRef.current;
    if (!b?.isConnected()) throw new Error("Not connected to a host");
    const error = resultError(await b.openLink(resolveViewHref(url)));
    if (error) throw new Error(error);
  }, []);

  const requestDisplayMode = useCallback(async (mode: DisplayMode) => {
    const b = bridgeRef.current;
    if (!b?.isConnected()) throw new Error("Not connected to a host");
    const granted = await b.requestDisplayMode(mode);
    return granted === "fullscreen" ? "fullscreen" : "inline";
  }, []);

  const value = useMemo<ViewRuntime>(
    () => ({
      def,
      connected,
      ready,
      scope,
      params,
      setParams,
      theme,
      dataVersion,
      callTool,
      openLink,
      displayMode,
      container,
      requestDisplayMode,
    }),
    [
      def,
      connected,
      ready,
      scope,
      params,
      setParams,
      theme,
      dataVersion,
      callTool,
      openLink,
      displayMode,
      container,
      requestDisplayMode,
    ]
  );
  // A host-resolved replacement is a new form, including in MCP hosts that
  // keep the iframe mounted while delivering the opening result.
  return (
    <Ctx.Provider key={scope.event ?? "unbound"} value={value}>
      <RenderBoundary
        resetKey={`${ready}:${JSON.stringify(scope)}:${JSON.stringify(params)}:${dataVersion}`}
      >
        {children}
      </RenderBoundary>
    </Ctx.Provider>
  );
}

export interface MountOptions {
  /** Test seam: drive the view against a fake parent instead of `window.parent`. */
  bridge?: ViewBridge;
}

/** Entry point the compiled bundle calls once. Mounts the component into
 *  `#root` and connects to the host. */
export function mountView(
  def: ViewDefinition,
  Component: () => ReactNode,
  opts?: MountOptions
): void {
  const valid = defineView(def);
  const el = document.getElementById("root");
  if (!el) throw new Error("#root missing in view shell");
  createRoot(el).render(
    <Provider def={valid} bridge={opts?.bridge}>
      <Component />
    </Provider>
  );
}
