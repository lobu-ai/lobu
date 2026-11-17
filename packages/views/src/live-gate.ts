/**
 * Bounded live refresh for view reads.
 *
 * A host forwards every workspace content invalidation to an open view. A
 * view can issue several reads (the net-worth view issues five), so an
 * unbounded forward turns workspace write volume into view read volume. The
 * app's own content queries already bound this with `liveRefreshIntervalMs`
 * (`packages/owletto/src/lib/live-refresh.ts`); the view runtime only had
 * in-flight coalescing. This gate adds the missing time floor:
 *
 * - the first change after an idle window reads immediately (leading edge);
 * - changes inside the window collapse into one trailing read;
 * - a hidden frame defers, then reads once when it becomes visible;
 * - a committed action forces an immediate read (`force`) so a view never
 *   shows stale data after its own write waiting for the window.
 *
 * "Hidden" is the top-level document's visibility: an iframe inherits it, so
 * a dashboard left in a background tab costs nothing until it is looked at.
 */
export const LIVE_REFRESH_MIN_INTERVAL_MS = 15_000;

export interface DataChangeGate {
  /** Subscribe to `visibilitychange`; idempotent. */
  start(): void;
  /** Drop the listener and any pending trailing read; idempotent. */
  stop(): void;
  /** A host data change arrived: read now, or once at the end of the window. */
  notify(): void;
  /** Read now regardless of the window (a committed action). */
  force(): void;
}

export function createDataChangeGate(
  onChange: () => void,
  intervalMs: number = LIVE_REFRESH_MIN_INTERVAL_MS
): DataChangeGate {
  let lastFiredAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let listening = false;

  const hidden = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const fire = () => {
    timer = null;
    pending = false;
    lastFiredAt = Date.now();
    onChange();
  };

  const notify = () => {
    if (hidden()) {
      // Do not spend a read on a frame nobody is looking at. Keep one
      // "something changed" bit for the next visibility change.
      pending = true;
      clearTimer();
      return;
    }
    const wait = lastFiredAt + intervalMs - Date.now();
    if (wait <= 0) {
      clearTimer();
      fire();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(fire, wait);
  };

  const force = () => {
    clearTimer();
    fire();
  };

  const onVisibilityChange = () => {
    if (hidden() || !pending) return;
    pending = false;
    clearTimer();
    fire();
  };

  return {
    start() {
      if (listening || typeof document === "undefined") return;
      document.addEventListener("visibilitychange", onVisibilityChange);
      listening = true;
    },
    stop() {
      if (listening) {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        listening = false;
      }
      clearTimer();
      pending = false;
    },
    notify,
    force,
  };
}
