/**
 * Wire constants for the device feed-read protocol.
 *
 * Deliberately dependency-free. The reserved action key is needed by three
 * unrelated layers — the read seam (lib/device-feed-read.ts), the manifest
 * validator (worker-api/device-manifests.ts) and the stale-run reaper
 * (scheduled/check-stalled-executions.ts) — and the reaper must not pull the
 * read seam's transitive graph (runs/queue-service → connector resolution) into
 * the scheduler just to learn one string.
 */

/**
 * Reserved action key a device connector must implement for feeds that declare
 * the `read` operation.
 *
 * The `__lobu_` prefix is reserved protocol namespace, rejected in manifest
 * `actions_schema` keys (`RESERVED_ACTION_KEY_PREFIX` in device-manifests.ts),
 * so this can never collide with a connector's own public action. It is
 * deliberately NOT declared in `actions_schema`: declaring it would flip
 * `supportsExecute` and publish a read seam as a user-invokable operation.
 */
export const DEVICE_FEED_READ_ACTION_KEY = '__lobu_feed_read';

/** Server-owned provenance for a compiled source read and its browser steps. */
export const SOURCE_FEED_READ_METADATA_KEY = 'source_feed_read';

export function isSourceFeedRead(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.[SOURCE_FEED_READ_METADATA_KEY] === true;
}

/**
 * How long a TERMINAL source-read run keeps its payload before the reaper sweeps
 * it, when the in-process cleanup never ran (gateway crash, pod eviction).
 *
 * The grace exists to not race a healthy waiter: `waitForDeviceActionRun` polls
 * every 500ms, so a run that has just been marked `completed` is about to be
 * read by a waiter that will then scrub it itself. Sweeping instantly would
 * turn a normal read into an empty result. 30s is two orders of magnitude above
 * the poll interval and far below the run-retention window.
 */
export const DEVICE_FEED_READ_SCRUB_GRACE_SECONDS = 30;
