/**
 * `<EmbeddedView>` — place another registered view inside this one.
 *
 * The child is never rendered by this frame. The slot reports its position
 * to the host (`lobu/embeds/sync`), and the Lobu web host mounts the child as
 * its own sandboxed frame over the slot: its own bundle, its own view key and
 * actions, the visitor's own session. This frame cannot reach into the child,
 * and the child's param changes stay with that one instance — they never
 * reach this view's params, a sibling, or the address bar.
 *
 * Hosts that do not mount embedded views (other MCP Apps hosts) answer
 * -32601, and the slot says so instead of rendering nothing.
 */
import {
  VIEW_EMBED_MAX_PARAMS,
  type ViewEmbedParams,
  type ViewEmbedScope,
  type ViewEmbedSlot,
  type ViewEmbedStatus,
} from "@lobu/core/contracts/tools/view-host";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { type ViewBridge, ViewBridgeError } from "./bridge.js";

interface SlotEntry {
  view: string;
  scope: ViewEmbedScope;
  params: ViewEmbedParams;
  element: RefObject<HTMLElement | null>;
  enter: RefObject<HTMLElement | null>;
  after: RefObject<HTMLElement | null>;
}

type SlotState =
  | { kind: "pending" }
  | { kind: "mounted"; height: number | null }
  | { kind: "refused"; reason: string }
  | { kind: "unsupported" };

const PENDING: SlotState = { kind: "pending" };
/** `Node.DOCUMENT_POSITION_FOLLOWING`, without needing the `Node` global. */
const DOCUMENT_POSITION_FOLLOWING = 4;

/**
 * The slots of one frame. Every change (a slot added, moved, resized, or its
 * params changed) schedules one sync on the next animation frame, carrying
 * all slots — the host's answer is the whole picture, never a diff.
 */
export class EmbedRegistry {
  private slots = new Map<string, SlotEntry>();
  private states = new Map<string, SlotState>();
  private listeners = new Set<() => void>();
  private frame = 0;
  private unsupported = false;
  private connected = false;
  private returning = new Set<string>();

  constructor(private readonly bridge: () => ViewBridge | null) {}

  /** Wire the host's notifications; returns the teardown. */
  attach(bridge: ViewBridge): () => void {
    const offSize = bridge.onEmbedSize((id, height) => {
      const state = this.states.get(id);
      if (state?.kind !== "mounted" || !Number.isFinite(height)) return;
      this.setState(id, { kind: "mounted", height: Math.max(0, height) });
    });
    const offFocus = bridge.onEmbedFocus((id, direction) => {
      const slot = this.slots.get(id);
      if (!slot) return;
      if (direction === "forward") {
        slot.after.current?.focus();
      } else {
        // Land on the slot's own entry point without re-entering the child,
        // so the next Shift+Tab continues before the slot.
        this.returning.add(id);
        slot.enter.current?.focus();
      }
    });
    const reflow = () => this.schedule();
    window.addEventListener("resize", reflow);
    window.addEventListener("scroll", reflow, true);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reflow);
    if (observer && document.body) observer.observe(document.body);
    this.observer = observer;
    return () => {
      offSize();
      offFocus();
      window.removeEventListener("resize", reflow);
      window.removeEventListener("scroll", reflow, true);
      observer?.disconnect();
      this.observer = null;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
    };
  }

  private observer: ResizeObserver | null = null;

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected) this.schedule();
  }

  register(id: string, entry: SlotEntry): () => void {
    this.slots.set(id, entry);
    const element = entry.element.current;
    if (element) this.observer?.observe(element);
    if (!this.states.has(id))
      this.setState(id, this.unsupported ? { kind: "unsupported" } : PENDING);
    this.schedule();
    return () => {
      if (this.slots.get(id) !== entry) return;
      if (element) this.observer?.unobserve(element);
      this.slots.delete(id);
      this.states.delete(id);
      this.schedule();
    };
  }

  /** Keyboard focus reached the slot: hand it to the child, unless it is
   *  coming back out of the child the other way. */
  enter(id: string): void {
    if (this.returning.delete(id)) return;
    if (this.states.get(id)?.kind !== "mounted") return;
    void this.bridge()
      ?.focusEmbed(id)
      .catch(() => {
        /* host declined: focus stays on the slot */
      });
  }

  state(id: string): SlotState {
    return this.states.get(id) ?? PENDING;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(id: string, state: SlotState): void {
    this.states.set(id, state);
    for (const listener of [...this.listeners]) listener();
  }

  schedule(): void {
    if (this.frame || this.unsupported || !this.connected) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      void this.sync();
    });
  }

  private async sync(): Promise<void> {
    const bridge = this.bridge();
    if (!bridge?.isConnected()) return;
    const embeds: ViewEmbedSlot[] = [];
    // Document order, so the host's limit keeps the first slots on the page.
    const ordered = [...this.slots].sort(([, a], [, b]) => {
      const x = a.element.current;
      const y = b.element.current;
      if (!x || !y) return 0;
      return x.compareDocumentPosition(y) & DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
    });
    for (const [id, slot] of ordered) {
      const box = slot.element.current?.getBoundingClientRect();
      embeds.push({
        id,
        view: slot.view,
        scope: slot.scope,
        params: slot.params,
        rect: {
          x: box?.left ?? 0,
          y: box?.top ?? 0,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
        },
      });
    }
    let answer: { embeds?: ViewEmbedStatus[] };
    try {
      answer = await bridge.syncEmbeds(embeds);
    } catch (error) {
      if (error instanceof ViewBridgeError && error.code === -32601) {
        this.unsupported = true;
        for (const id of this.slots.keys())
          this.setState(id, { kind: "unsupported" });
      }
      return;
    }
    for (const status of answer.embeds ?? []) {
      if (!this.slots.has(status.id)) continue;
      const previous = this.states.get(status.id);
      if (status.status === "mounted") {
        if (previous?.kind !== "mounted")
          this.setState(status.id, { kind: "mounted", height: null });
      } else if (
        previous?.kind !== "refused" ||
        previous.reason !== status.reason
      ) {
        this.setState(status.id, { kind: "refused", reason: status.reason });
      }
    }
  }
}

const EmbedCtx = createContext<EmbedRegistry | null>(null);

/** Installed by the view runtime's provider. */
export function EmbedProvider({
  registry,
  children,
}: {
  registry: EmbedRegistry;
  children: ReactNode;
}) {
  return <EmbedCtx.Provider value={registry}>{children}</EmbedCtx.Provider>;
}

const REFUSALS: Record<string, string> = {
  cycle: "This view already contains it, so it is not shown again here.",
  depth: "Views nest at most two levels deep.",
  limit: "This view shows too many embedded views at once.",
  invalid: "This embedded view's settings are not valid.",
};

const HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

function scalarParams(params: Record<string, unknown> | undefined) {
  const out: ViewEmbedParams = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (Object.keys(out).length >= VIEW_EMBED_MAX_PARAMS) break;
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      out[key] = value;
  }
  return out;
}

export interface EmbeddedViewProps {
  /** Key of the view to show; it is registered and authorized on its own. */
  view: string;
  /** The child's scope. Omit for a workspace view. */
  scope?: ViewEmbedScope;
  /** The child's starting params. A change here resets the instance to them;
   *  the child's own changes stay local to it. */
  params?: Record<string, string | number | boolean>;
  /** Stable instance id; defaults to the slot's position in the tree. */
  id?: string;
  /** Accessible name of the slot. */
  title?: string;
  /** Height reserved until the child reports its own. */
  minHeight?: number;
}

export function EmbeddedView({
  view,
  scope,
  params,
  id: explicitId,
  title,
  minHeight = 120,
}: EmbeddedViewProps) {
  const registry = useContext(EmbedCtx);
  if (!registry)
    throw new Error("<EmbeddedView> must render inside mountView()");
  const autoId = useId();
  const id = explicitId ?? `embed${autoId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const slotRef = useRef<HTMLDivElement>(null);
  const enterRef = useRef<HTMLButtonElement>(null);
  const afterRef = useRef<HTMLSpanElement>(null);
  const scopeKey = JSON.stringify(scope ?? {});
  const paramsKey = JSON.stringify(scalarParams(params));
  const entryScope = useMemo(
    () => JSON.parse(scopeKey) as ViewEmbedScope,
    [scopeKey]
  );
  const entryParams = useMemo(
    () => JSON.parse(paramsKey) as ViewEmbedParams,
    [paramsKey]
  );
  useEffect(
    () =>
      registry.register(id, {
        view,
        scope: entryScope,
        params: entryParams,
        element: slotRef,
        enter: enterRef,
        after: afterRef,
      }),
    [registry, id, view, entryScope, entryParams]
  );
  const state = useSyncExternalStore(
    registry.subscribe,
    () => registry.state(id),
    () => registry.state(id)
  );
  const label = title ?? view;
  const height =
    state.kind === "mounted"
      ? (state.height ?? minHeight)
      : state.kind === "pending"
        ? minHeight
        : undefined;
  return (
    <div
      ref={slotRef}
      data-lobu-embed={id}
      data-state={state.kind}
      style={{ position: "relative", height }}
    >
      {state.kind === "mounted" || state.kind === "pending" ? (
        // Where Tab meets the slot: focus moves on into the child's frame.
        <button
          ref={enterRef}
          type="button"
          style={HIDDEN}
          onFocus={() => registry.enter(id)}
          onClick={() => registry.enter(id)}
        >
          {label}
        </button>
      ) : null}
      {state.kind === "unsupported" ? (
        <p role="note">
          “{label}” is an embedded view. Open this page in the Lobu app to see
          it.
        </p>
      ) : state.kind === "refused" ? (
        <p role="note">{REFUSALS[state.reason] ?? REFUSALS.invalid}</p>
      ) : null}
      <span ref={afterRef} tabIndex={-1} style={HIDDEN} />
    </div>
  );
}
