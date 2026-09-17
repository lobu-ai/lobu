/**
 * How fresh a device worker's `last_seen_at` must be for the device to count
 * as online, and how to describe that freshness to a human.
 *
 * `device_workers.last_seen_at` is written on every `/api/workers/poll`, on
 * device registration, and when a device refreshes its child credential. A
 * stale value proves no poll occurred after it; a fresh value is only a
 * liveness proxy, not proof that the claim query ran. Scheduled execution pins
 * therefore use the current poll itself as their stronger readiness signal
 * (check-due-feeds.ts), while this window remains useful for UI/offline hints.
 *
 * ## Why 2 minutes
 *
 * The window was 20 minutes, duplicated across nine inline query sites plus a
 * local constant in dispatch-chrome-action. Measured on prod 2026-08-05 over
 * ~50 minutes of poll traffic, every LIVE worker — both
 * platforms, four devices — polled far faster than that:
 *
 *     source                     polls   median gap   p95      max gap
 *     fleet worker (in-cluster)   1811       1.5s      5.0s      5.3s
 *     chrome-extension (device)    550       7.3s     10.3s     11.6s
 *     chrome-extension (device)    442       5.4s      7.3s    546.9s ← outage
 *
 * The worst gap for a healthy worker was 11.6s, so 120s leaves ~10x headroom
 * for a network blip or a rolling deploy, while collapsing the window in which
 * a dead device still reports "online" from 20 minutes to 2.
 *
 * That window was not academic: an extension whose poll loop died was reported
 * `readiness: "ready", executable: true` for the full 18 minutes it was dead,
 * and every dispatch to it stalled for the 60s queue budget and then failed
 * with "the device may be offline" — a guess the server had the data to
 * answer. Keeping this comfortably under `QUEUE_BUDGET_MS` x2 means "online"
 * now implies "a dispatch right now has a real chance of being claimed".
 *
 * There is no known device class that polls slower; if one is ever added, it
 * must either poll within this window or the reporting has to become
 * per-platform — do not widen this back to cover it silently.
 */
export const DEVICE_ONLINE_WINDOW_SECONDS = 120;

/**
 * How recently a device must have polled to still count as part of the user's
 * FLEET — the set of devices whose advertised capabilities can serve a
 * connector at all.
 *
 * Deliberately not `DEVICE_ONLINE_WINDOW_SECONDS`. The two windows answer
 * different questions and must not be collapsed:
 *
 *  - 120s "online" = a dispatch issued right now has a real chance of being
 *    claimed. A laptop closed for an hour fails this, and should.
 *  - 7 days "fresh" = this machine is still one of mine. A laptop closed for a
 *    weekend, or a desktop asleep over PTO, is still a legitimate execution
 *    target; its pin is placement, not a liveness claim, and reconcile is
 *    required to preserve it across exactly these intervals
 *    (`worker-api/device-reconcile.ts`). 7 days spans a work week plus a
 *    weekend, and sits well inside the reaper's 30-day delete window
 *    (`scheduled/reap-stale-device-workers.ts`) so a device is never
 *    un-pinnable before it is reapable.
 *
 * Expressed as a postgres interval literal because every consumer applies it in
 * SQL against `device_workers.last_seen_at`. Derived in ONE place: this window
 * previously existed as three separate `'7 days'` literals (device-reconcile,
 * two sites in device-manifests), so widening it in one and not the others
 * would have silently disagreed about which devices are fleet members.
 */
export const DEVICE_WORKER_FRESH_INTERVAL = '7 days';

/**
 * Human-readable age of a device's last poll, for `reason` strings and
 * dispatch errors. Deliberately coarse: the caller needs "is this stale and
 * roughly how stale", not milliseconds.
 */
export function describeDeviceLastSeen(
  lastSeenAt: Date | string | null | undefined,
  now: Date = new Date()
): string {
  if (lastSeenAt == null) return 'has never polled';
  const seen = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  const ms = seen.getTime();
  if (!Number.isFinite(ms)) return 'has never polled';
  const seconds = Math.round((now.getTime() - ms) / 1000);
  // A worker that polled "in the future" is a clock-skew artifact, not news.
  if (seconds < 0) return 'last polled just now';
  if (seconds < 60) return `last polled ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `last polled ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last polled ${hours}h ago`;
  return `last polled ${Math.floor(hours / 24)}d ago`;
}
