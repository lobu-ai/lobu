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
 *  - reads: any tool with an `outputSchema` (`query_sql`, `query_sdk`,
 *    `manage_connections`, …); actions: `invoke_view_action`.
 *  - `setParams` → `ui/update-model-context` `{ structuredContent: { view,
 *    params } }`; the web host mirrors it into the address bar. Hosts without
 *    that capability keep params local to the frame.
 */

import {
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
import { ViewBridge, type HostContext, type ToolResult } from "./bridge.js";

export type ParamValue = string | number | boolean;
export type Params = Record<string, ParamValue>;

export interface Scope {
  type?: string;
  entity?: number | string;
}

export interface ParamDef {
  type: "string" | "number" | "boolean";
  default?: ParamValue;
}

export interface Attachment {
  type?: string;
  entity?: number | string;
  workspace?: true;
  placement?: "tab" | "overview";
}

export interface ViewDefinition {
  /** View key: the single namespace of keys (no `custom:` prefix). Required —
   *  it is the identity `invoke_view_action` and the shell route key on. */
  key: string;
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
  callTool: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<ToolResult>;
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
} {
  const rt = useRuntime();
  return { connected: rt.connected, ready: rt.ready, theme: rt.theme };
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

/** Direct tool read: for tools that return their JSON as `structuredContent`
 *  on MCP hosts (any tool with an `outputSchema`, e.g. `manage_connections`). */
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

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Run a read through the host. `sql\`…\`` → `query_sql`; a string →
 * `query_sdk` script; `tool(name, args)` → that tool; `null` skips. The first
 * fetch waits for the host's first `tool-input`: reads before it run against
 * defaults and double-fetch when the real scope lands.
 */
export function useQuery<T = unknown>(
  query: SqlQuery | ToolQuery | string | null
): QueryState<T> {
  const rt = useRuntime();
  const [state, setState] = useState<Omit<QueryState<T>, "refetch">>({
    data: null,
    error: null,
    loading: query !== null,
  });
  const [tick, setTick] = useState(0);
  const key =
    query === null
      ? null
      : typeof query === "string"
        ? `sdk:${query}`
        : query.kind === "tool"
          ? `tool:${query.name}:${JSON.stringify(query.args)}`
          : `sql:${query.text}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the stable identity of query (listing query itself refetches every render); rt.callTool is stable and tick is the intentional refetch trigger.
  useEffect(() => {
    // Parked: no query, or the host has not seeded scope/params yet.
    if (key === null || !rt.ready) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const q = query as SqlQuery | ToolQuery | string;
    const call =
      typeof q === "string"
        ? rt.callTool("query_sdk", { script: q })
        : q.kind === "tool"
          ? rt.callTool(q.name, q.args)
          : rt.callTool("query_sql", { sql: q.text, limit: 500 });
    call
      .then((result) => {
        if (cancelled) return;
        const err = resultError(result);
        if (err) {
          setState({ data: null, error: err, loading: false });
          return;
        }
        // structuredContent when the tool declares an outputSchema (query_sql,
        // query_sdk, every read tool on MCP hosts); otherwise the text body.
        const sc = (result.structuredContent ??
          parseTextJson(result) ??
          {}) as Record<string, unknown>;
        // query_sdk → { success, return_value }, query_sql → { rows }, a named
        // tool → its whole body.
        const data = (
          typeof q === "string"
            ? sc.return_value
            : q.kind === "tool"
              ? sc
              : sc.rows
        ) as T;
        setState({ data: data ?? null, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({
          data: null,
          error: e instanceof Error ? e.message : String(e),
          loading: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [key, rt.ready, tick]);
  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refetch };
}

export interface ActionResult {
  ok: boolean;
  error: string | null;
  result: unknown;
}

/** Mint the per-click interaction id the action tool requires (browser retry
 *  id on web): a UUID where available, else a time + random fallback. */
export function mintInteractionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** A declared action → `invoke_view_action { view, action, value }`. The name
 *  must exist on the CURRENT view definition; a removed button throws here
 *  instead of emitting a stale event. */
export function useAction(
  name: string
): (value?: Record<string, unknown>) => Promise<ActionResult> {
  const rt = useRuntime();
  if (!rt.def.actions?.[name]) {
    throw new Error(`Action "${name}" is not declared on view "${rt.def.key}"`);
  }
  return useCallback(
    async (value: Record<string, unknown> = {}) => {
      try {
        // The tool requires an interaction id (browser retry id on web):
        // mint one per click so retries stay idempotent.
        const result = await rt.callTool("invoke_view_action", {
          view: rt.def.key,
          action: name,
          value,
          interaction_id: mintInteractionId(),
        });
        const err = resultError(result);
        return {
          ok: !err,
          error: err,
          result: result.structuredContent ?? null,
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          result: null,
        };
      }
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

function coerceScope(raw: unknown): Scope {
  if (!raw || typeof raw !== "object") return {};
  const scope = raw as Record<string, unknown>;
  const out: Scope = {};
  if (typeof scope.type === "string" && scope.type.length > 0)
    out.type = scope.type;
  if (typeof scope.entity === "number" || typeof scope.entity === "string") {
    out.entity = scope.entity;
  }
  return out;
}

function themeFromContext(ctx: HostContext): "light" | "dark" {
  return ctx.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

function Provider({
  def,
  bridge,
  children,
}: {
  def: ViewDefinition;
  bridge: ViewBridge;
  children: ReactNode;
}) {
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(bridge.hasToolInput());
  const [scope, setScope] = useState<Scope>({});
  const [params, setParamsState] = useState<Params>(() => defaultsFor(def));
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  useEffect(() => {
    const b = bridgeRef.current;
    const offInput = b.onToolInput((args) => {
      const input = (args ?? {}) as { scope?: unknown; params?: unknown };
      setScope(coerceScope(input.scope));
      setParamsState(coerceParams(def, input.params));
      setReady(true);
    });
    const offCtx = b.onHostContext((ctx) => {
      const next = themeFromContext(ctx);
      setTheme(next);
      applyTheme(next);
    });
    b.connect()
      .then((ctx) => {
        const next = themeFromContext(ctx);
        setTheme(next);
        applyTheme(next);
        setConnected(true);
        setReady(b.hasToolInput());
        document.documentElement.setAttribute("data-ready", "true");
      })
      .catch((e) => console.error("[lobu-views] connect failed", e));
    return () => {
      offInput();
      offCtx();
    };
  }, [def]);

  const setParams = useCallback(
    (patch: Partial<Params>) => {
      setParamsState((prev) => {
        const next = coerceParams(def, { ...prev, ...patch });
        bridgeRef.current
          .updateModelContext({ view: def.key, params: next })
          .catch(() => {
            /* host without update-model-context: params stay frame-local */
          });
        return next;
      });
    },
    [def]
  );

  const callTool = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      const b = bridgeRef.current;
      if (!b.isConnected()) {
        // No handshake yet — fail loud instead of queueing into a dead host.
        throw new Error("Not connected to a host");
      }
      return b.callTool(name, args);
    },
    []
  );

  const value = useMemo<ViewRuntime>(
    () => ({
      def,
      connected,
      ready,
      scope,
      params,
      setParams,
      theme,
      callTool,
    }),
    [def, connected, ready, scope, params, setParams, theme, callTool]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
  const bridge = opts?.bridge ?? new ViewBridge();
  let reported = false;
  const reportSize = () => {
    if (!reported) {
      reported = true;
      document.documentElement.setAttribute("data-mounted", "true");
    }
    const doc = document.documentElement;
    const prev = doc.style.height;
    doc.style.height = "max-content";
    const height = Math.ceil(doc.getBoundingClientRect().height);
    doc.style.height = prev;
    bridge.notifySize(Math.ceil(window.innerWidth), height);
  };
  createRoot(el).render(
    <Provider def={valid} bridge={bridge}>
      <Component />
    </Provider>
  );
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(reportSize);
    observer.observe(document.documentElement);
    observer.observe(document.body);
  }
  reportSize();
}
