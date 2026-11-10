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
  type ViewFocusDirection,
} from "@lobu/core/contracts/tools/view-host";
import {
  type CSSProperties,
  createContext,
  type FocusEvent,
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

/** Layers laid over the page: while one covers a slot, its child hides so
 *  the parent's own dialog or menu stays on top and takes the clicks. */
const OVERLAYS =
  'dialog[open],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-lobu-overlay]';

type Box = { x: number; y: number; width: number; height: number };

function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

const EMPTY: Box = { x: 0, y: 0, width: 0, height: 0 };

/** The part of `element` the page actually shows: inside the viewport and
 *  every ancestor that clips or scrolls, and none of it under an overlay. */
function shownPart(element: HTMLElement, box: Box): Box {
  let shown = intersect(box, {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  });
  for (
    let el = element.parentElement;
    el && el !== document.documentElement;
    el = el.parentElement
  ) {
    const style = window.getComputedStyle(el);
    if (style.overflowX === "visible" && style.overflowY === "visible")
      continue;
    const r = el.getBoundingClientRect();
    // The padding box: clientWidth/Height exclude borders and scrollbars.
    shown = intersect(shown, {
      x: r.left + el.clientLeft,
      y: r.top + el.clientTop,
      width: el.clientWidth,
      height: el.clientHeight,
    });
  }
  if (shown.width === 0 || shown.height === 0) return EMPTY;
  for (const layer of document.querySelectorAll<HTMLElement>(OVERLAYS)) {
    if (layer.contains(element)) continue;
    const r = layer.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const over = intersect(shown, {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
    });
    if (over.width > 0 && over.height > 0) return EMPTY;
  }
  return shown;
}

/** Longest a transition or animation keeps the per-frame sync running. */
const MOTION_LIMIT_MS = 5_000;

/**
 * The slots of one frame. A change that can move a slot — the page's DOM, a
 * resize, any scroll, an image load, a transition or animation — schedules
 * one measurement on the next animation frame; only a changed picture is
 * sent, carrying all slots (the host's answer is the whole picture, never a
 * diff). Nothing polls: with no change there is no work, and motion keeps
 * measuring each frame only until it ends (bounded by `MOTION_LIMIT_MS`).
 */
export class EmbedRegistry {
  private slots = new Map<string, SlotEntry>();
  private states = new Map<string, SlotState>();
  private listeners = new Set<() => void>();
  private frame = 0;
  private unsupported = false;
  private connected = false;
  private returning = new Set<string>();
  /** Set while focus is being placed on entry from the host, so a slot that
   *  is itself the first or last stop passes the same direction on. */
  arrival: ViewFocusDirection | null = null;

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
    // This view is itself a slot's child: land on its first or last control.
    const offEnter = bridge.onFocusEnter((direction) => {
      const stops = tabStops(document);
      this.arrival = direction;
      try {
        (direction === "forward" ? stops[0] : stops[stops.length - 1])?.focus();
      } finally {
        this.arrival = null;
      }
    });
    const reflow = () => this.schedule();
    const motionStart = () => {
      this.motionUntil = window.performance.now() + MOTION_LIMIT_MS;
      this.moving += 1;
      this.schedule();
    };
    const motionEnd = () => {
      this.moving = Math.max(0, this.moving - 1);
      this.schedule();
    };
    window.addEventListener("resize", reflow);
    window.addEventListener("scroll", reflow, true);
    window.addEventListener("load", reflow, true);
    window.addEventListener("transitionrun", motionStart, true);
    window.addEventListener("animationstart", motionStart, true);
    for (const end of [
      "transitionend",
      "transitioncancel",
      "animationend",
      "animationcancel",
    ])
      window.addEventListener(end, motionEnd, true);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reflow);
    if (observer && document.body) observer.observe(document.body);
    this.observer = observer;
    // A slot moves without resizing when content above it changes, it is
    // reordered, or a class or style shifts it: the DOM says so.
    const mutations =
      typeof window.MutationObserver === "undefined"
        ? null
        : new window.MutationObserver(reflow);
    mutations?.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "role"],
    });
    return () => {
      offSize();
      offFocus();
      offEnter();
      window.removeEventListener("resize", reflow);
      window.removeEventListener("scroll", reflow, true);
      window.removeEventListener("load", reflow, true);
      window.removeEventListener("transitionrun", motionStart, true);
      window.removeEventListener("animationstart", motionStart, true);
      for (const end of [
        "transitionend",
        "transitioncancel",
        "animationend",
        "animationcancel",
      ])
        window.removeEventListener(end, motionEnd, true);
      observer?.disconnect();
      mutations?.disconnect();
      this.observer = null;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
    };
  }

  private observer: ResizeObserver | null = null;
  /** Transitions/animations running now, and when to stop trusting the count. */
  private moving = 0;
  private motionUntil = 0;
  /** The last picture sent; an identical one is not sent again. */
  private sent: string | null = null;

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.sent = null;
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
  enter(id: string, direction: ViewFocusDirection): void {
    if (this.returning.delete(id)) return;
    if (this.states.get(id)?.kind !== "mounted") return;
    void this.bridge()
      ?.focusEmbed(id, direction)
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
      // Mid-motion a slot moves every frame without any other signal.
      if (this.moving > 0 && window.performance.now() < this.motionUntil)
        this.schedule();
      else this.moving = 0;
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
      const element = slot.element.current;
      const r = element?.getBoundingClientRect();
      const box: Box = {
        x: r?.left ?? 0,
        y: r?.top ?? 0,
        width: r?.width ?? 0,
        height: r?.height ?? 0,
      };
      const shown = element ? shownPart(element, box) : EMPTY;
      const whole =
        shown.x === box.x &&
        shown.y === box.y &&
        shown.width === box.width &&
        shown.height === box.height;
      embeds.push({
        id,
        view: slot.view,
        scope: slot.scope,
        params: slot.params,
        rect: whole ? box : { ...box, clip: shown },
      });
    }
    const picture = JSON.stringify(embeds);
    if (picture === this.sent) return;
    this.sent = picture;
    let answer: { embeds?: ViewEmbedStatus[] };
    try {
      answer = await bridge.syncEmbeds(embeds);
    } catch (error) {
      // Not delivered: the same picture must be sent again next time.
      this.sent = null;
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

const TABBABLE =
  'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable="true"]';

/** The document's Tab stops in order (positive `tabIndex` is not used by
 *  views, so document order is Tab order). */
function tabStops(root: Document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement).disabled &&
      !el.closest("[inert],[hidden]") &&
      el.getClientRects().length > 0
  );
}

/** Which way the visitor was tabbing when focus reached the slot: from a
 *  control after it means backward. From outside this frame, forward. */
function focusDirection(event: FocusEvent<HTMLElement>): ViewFocusDirection {
  const from = event.relatedTarget as Node | null;
  return from &&
    event.currentTarget.compareDocumentPosition(from) &
      window.Node.DOCUMENT_POSITION_FOLLOWING
    ? "backward"
    : "forward";
}

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
          onFocus={(event) =>
            registry.enter(id, registry.arrival ?? focusDirection(event))
          }
          onClick={() => registry.enter(id, "forward")}
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
