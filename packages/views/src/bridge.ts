/**
 * Hand-written MCP Apps guest transport for Lobu views.
 *
 * Zero dependencies on purpose: the spike measured zod + MCP SDK + ext-apps at
 * 378 KB of a 577 KB view bundle, so the guest speaks the wire protocol
 * directly instead of importing `@modelcontextprotocol/ext-apps`. The method
 * names below mirror that SDK (protocol version `2026-01-26`): the host side
 * (`AppBridge` in owletto, Claude, any MCP Apps host) is unchanged.
 *
 * Wire shape is plain JSON-RPC 2.0 over `window.postMessage` to the parent
 * frame: requests carry `{ jsonrpc: "2.0", id, method, params }`, responses
 * `{ jsonrpc: "2.0", id, result }` (or `error`), notifications `{ jsonrpc:
 * "2.0", method, params }`. Anything else in the inbox is ignored, exactly
 * like the SDK's transport.
 */

export interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}

export interface HostContext {
  theme?: unknown;
  [key: string]: unknown;
}

/**
 * Bootstrap state the generic loader injects into the per-view document
 * (`window.__lobuViewHandoff`) before replacing its own: the authenticated
 * initialize result's context, the last complete tool input, event
 * notifications that arrived after it, and the loader's request-id counter.
 * Adopting it lets the mounted guest continue the loader's session — a host
 * that delivers the opening input once has already fulfilled it. The
 * readiness gate is NOT bypassed: queries still wait for a tool input, now
 * satisfied by the authentic cached one through the normal listener path.
 */
export interface ViewHandoff {
  v?: unknown;
  hostContext?: unknown;
  toolInput?: unknown;
  queue?: unknown;
  nextId?: unknown;
}

/** Event notifications worth replaying to the mounted guest (context merges
 *  into adopted state instead; anything else is ignored). */
const HANDOFF_NOTIFICATIONS = new Set([
  "ui/notifications/tool-result",
  "ui/notifications/tool-cancelled",
]);

export interface BridgeOptions {
  appName?: string;
  appVersion?: string;
  /** Parent origin. Default `*`: the frame is sandboxed opaque-origin, so the
   *  host cannot be allow-listed; the host authenticates the frame, not vice
   *  versa — same posture as the SDK's `PostMessageTransport`. */
  targetOrigin?: string;
  /** Milliseconds before a pending request rejects. Default 60_000. */
  requestTimeoutMs?: number;
}

type JsonRpcId = string | number;

interface Pending {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PROTOCOL_VERSION = "2026-01-26";
const DEFAULT_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimal MCP Apps guest. Construct, register listeners, then `connect()`.
 * Listeners registered after `connect()` resolves can miss the host's one-shot
 * `tool-input` (the SDK warns for the same reason), so the view layer wires
 * them synchronously at mount.
 */
export class ViewBridge {
  private target: Window;
  private expectedSource: Window | null;
  private targetOrigin: string;
  private timeoutMs: number;
  private appInfo: { name: string; version: string };
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private toolInputListeners = new Set<
    (args: Record<string, unknown>) => void
  >();
  private toolResultListeners = new Set<(result: ToolResult) => void>();
  private toolCancelledListeners = new Set<(reason: string | null) => void>();
  private hostContextListeners = new Set<(ctx: HostContext) => void>();
  /** Set by the first `tool-input` and never cleared: queries must not fire
   *  before it (the host seeds scope + params there; anything read earlier
   *  runs against defaults and double-fetches). */
  private toolInputReceived = false;
  private hostContext: HostContext = {};
  private didConnect = false;
  private handoff: ViewHandoff | null = null;
  private onMessage = (event: MessageEvent) => this.handleMessage(event);
  private listening = false;

  constructor(
    target?: Window,
    expectedSource?: Window | null,
    opts?: BridgeOptions
  ) {
    const w = globalThis as unknown as { window?: Window; parent?: Window };
    this.target = target ?? w.window?.parent ?? (w.parent as Window);
    this.expectedSource =
      expectedSource ?? (w.window?.parent as Window | null) ?? null;
    this.targetOrigin = opts?.targetOrigin ?? "*";
    this.timeoutMs = opts?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.appInfo = {
      name: opts?.appName ?? "Lobu view",
      version: opts?.appVersion ?? "0.0.1",
    };
    this.readHandoff();
  }

  /**
   * Adopt the loader's bootstrap state, if this document was mounted through
   * the generic loader. Consumed once: a stale blob must never reseed a later
   * navigation. Malformed blobs are ignored — the guest then waits for live
   * host input like a directly mounted shell.
   */
  private readHandoff(): void {
    const w = globalThis as unknown as { window?: Record<string, unknown> };
    const win = w.window;
    if (!win || typeof win !== "object") return;
    const raw = win.__lobuViewHandoff;
    try {
      delete win.__lobuViewHandoff;
    } catch {
      // Non-configurable property: single-run document, ignore.
    }
    if (!isRecord(raw)) return;
    this.handoff = raw as ViewHandoff;
    if (isRecord(this.handoff.hostContext)) {
      this.hostContext = { ...(this.handoff.hostContext as HostContext) };
    }
  }

  /** Latest host context (theme, display mode, …), merged from every
   *  `host-context-changed` notification. */
  getHostContext(): HostContext {
    return { ...this.hostContext };
  }

  hasToolInput(): boolean {
    return this.toolInputReceived;
  }

  onToolInput(listener: (args: Record<string, unknown>) => void): () => void {
    this.toolInputListeners.add(listener);
    return () => this.toolInputListeners.delete(listener);
  }

  onToolResult(listener: (result: ToolResult) => void): () => void {
    this.toolResultListeners.add(listener);
    return () => this.toolResultListeners.delete(listener);
  }

  onToolCancelled(listener: (reason: string | null) => void): () => void {
    this.toolCancelledListeners.add(listener);
    return () => this.toolCancelledListeners.delete(listener);
  }

  onHostContext(listener: (ctx: HostContext) => void): () => void {
    this.hostContextListeners.add(listener);
    return () => this.hostContextListeners.delete(listener);
  }

  /**
   * Run the `ui/initialize` handshake, then announce readiness. Resolves with
   * the host context. Rejects when the host answers with an error or stays
   * silent past the deadline — the view renders its defaults, never a hang.
   */
  async connect(): Promise<HostContext> {
    this.startListening();
    const result = (await this.request("ui/initialize", {
      appInfo: this.appInfo,
      appCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    })) as Record<string, unknown>;
    const ctx = (result.hostContext ?? {}) as HostContext;
    this.hostContext = { ...this.hostContext, ...ctx };
    this.didConnect = true;
    this.notify({ method: "ui/notifications/initialized", params: {} });
    this.adoptHandoff();
    return this.getHostContext();
  }

  /**
   * Continue the loader's session: seed request numbering from its counter,
   * then deliver the cached tool input and queued event notifications through
   * the normal listener paths — the readiness gate sees a real input, not a
   * bypass. The fresh initialize result above keeps precedence for context.
   */
  private adoptHandoff(): void {
    const h = this.handoff;
    this.handoff = null;
    if (!h) return;
    if (typeof h.nextId === "number" && Number.isFinite(h.nextId)) {
      this.nextId = Math.max(this.nextId, Math.floor(h.nextId));
    }
    if (isRecord(h.toolInput)) {
      this.toolInputReceived = true;
      const args = h.toolInput;
      for (const listener of [...this.toolInputListeners]) listener(args);
    }
    if (Array.isArray(h.queue)) {
      for (const item of h.queue) {
        if (!isRecord(item) || typeof item.method !== "string") continue;
        if (!HANDOFF_NOTIFICATIONS.has(item.method)) continue;
        this.handleNotification(
          item.method,
          isRecord(item.params) ? item.params : {}
        );
      }
    }
  }

  /** True once the `ui/initialize` handshake completed. */
  isConnected(): boolean {
    return this.didConnect;
  }

  /** Proxy one `tools/call` to the host and return the FULL result (a view
   *  reads `structuredContent`; the boolean-only hook on the card path is
   *  what this deliberately does not copy). */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.request("tools/call", {
      name,
      arguments: args,
    }) as Promise<ToolResult>;
  }

  /** Read one `resources/read` URI and return the first text payload. The
   *  generic loader uses this to fetch `ui://lobu/views/<key>` through the
   *  host instead of a custom message. */
  async readResourceText(uri: string): Promise<string> {
    const result = (await this.request("resources/read", { uri })) as {
      contents?: Array<{ text?: unknown }>;
    };
    const text = result.contents?.[0]?.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(`Resource ${uri} returned no text content`);
    }
    return text;
  }

  /** Push `{ structuredContent }` into the model's context. Hosts without the
   *  capability reject; callers keep params frame-local on failure. */
  updateModelContext(
    structuredContent: Record<string, unknown>
  ): Promise<void> {
    return this.request("ui/update-model-context", { structuredContent }).then(
      () => undefined
    );
  }

  sendMessage(text: string): Promise<ToolResult> {
    return this.request("ui/message", {
      role: "user",
      content: [{ type: "text", text }],
    }) as Promise<ToolResult>;
  }

  openLink(url: string): Promise<ToolResult> {
    return this.request("ui/open-link", { url }) as Promise<ToolResult>;
  }

  /** Report the document size so the host can fit the frame. Fire-and-forget:
   *  a host that ignores it keeps its default height. */
  notifySize(width: number, height: number): void {
    this.notify({
      method: "ui/notifications/size-changed",
      params: { width, height },
    });
  }

  close(): void {
    if (this.listening) {
      window.removeEventListener("message", this.onMessage);
      this.listening = false;
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ViewBridge closed"));
    }
    this.pending.clear();
  }

  private startListening(): void {
    if (this.listening) return;
    window.addEventListener("message", this.onMessage);
    this.listening = true;
  }

  private request(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ViewBridge request "${method}" timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        timer,
      });
      this.target.postMessage(message, this.targetOrigin);
    });
  }

  private notify(message: {
    method: string;
    params: Record<string, unknown>;
  }): void {
    this.target.postMessage({ jsonrpc: "2.0", ...message }, this.targetOrigin);
  }

  private respond(id: JsonRpcId, result: Record<string, unknown>): void {
    this.target.postMessage({ jsonrpc: "2.0", id, result }, this.targetOrigin);
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.target.postMessage(
      { jsonrpc: "2.0", id, error: { code, message } },
      this.targetOrigin
    );
  }

  private handleMessage(event: MessageEvent): void {
    if (this.expectedSource && event.source !== this.expectedSource) return;
    const data = event.data;
    if (!isRecord(data) || data.jsonrpc !== "2.0") return;
    const hasId =
      ("id" in data && typeof data.id === "string") ||
      ("id" in data && typeof data.id === "number");
    // An inbound host request carries both `id` and `method` (ping,
    // teardown); a response to one of ours carries `id` without `method`.
    if (hasId && typeof data.method === "string") {
      this.handleRequest(data.id as JsonRpcId, data.method);
      return;
    }
    if (hasId) {
      this.handleResponse(data.id as JsonRpcId, data);
      return;
    }
    if (typeof data.method !== "string") return;
    this.handleNotification(
      data.method,
      isRecord(data.params) ? data.params : {}
    );
  }

  private handleResponse(id: JsonRpcId, data: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ("error" in data && isRecord(data.error)) {
      pending.reject(
        new Error(String(data.error.message ?? "Host request failed"))
      );
      return;
    }
    pending.resolve(data.result as never);
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>
  ): void {
    switch (method) {
      case "ui/notifications/tool-input": {
        this.toolInputReceived = true;
        const args = isRecord(params.arguments) ? params.arguments : {};
        for (const listener of [...this.toolInputListeners]) listener(args);
        break;
      }
      case "ui/notifications/tool-result": {
        const result = params as ToolResult;
        for (const listener of [...this.toolResultListeners]) listener(result);
        break;
      }
      case "ui/notifications/tool-cancelled": {
        const reason = typeof params.reason === "string" ? params.reason : null;
        for (const listener of [...this.toolCancelledListeners])
          listener(reason);
        break;
      }
      case "ui/notifications/host-context-changed": {
        this.hostContext = { ...this.hostContext, ...params };
        const snapshot = this.getHostContext();
        for (const listener of [...this.hostContextListeners])
          listener(snapshot);
        break;
      }
      default:
        break;
    }
  }

  /** Answer an inbound host request (ping, teardown). Wired through the same
   *  inbox: JSON-RPC requests carry both `id` and `method`. */
  handleRequest(id: JsonRpcId, method: string): boolean {
    if (method === "ping" || method === "ui/resource-teardown") {
      this.respond(id, {});
      return true;
    }
    this.respondError(id, -32601, `Method not found: ${method}`);
    return false;
  }
}
