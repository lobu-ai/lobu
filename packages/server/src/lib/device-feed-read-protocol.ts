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

/** Server-owned provenance for a source read and its browser steps. */
export const SOURCE_FEED_READ_METADATA_KEY = 'source_feed_read';
/** A headless read delegated by an active, owner-visible source subscription. */
export const SOURCE_FEED_SUBSCRIPTION_METADATA_KEY = 'source_feed_subscription';
/** Configuration identity captured before a subscription listener starts. */
export const SOURCE_FEED_SCOPE_METADATA_KEY = 'source_feed_scope_key';

export function isSourceFeedRead(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.[SOURCE_FEED_READ_METADATA_KEY] === true;
}

type SqlTag<T> = (strings: TemplateStringsArray, ...values: unknown[]) => T;

/** Payload assignments only; callers own terminal state, errors and row fences. */
export function sourceReadScrubAssignments<T>(sql: SqlTag<T>): T {
  return readScrubAssignments(sql, sql``);
}

/** Policy rejection gates each CASE arm without changing non-blocked runs. */
export function guardedSourceReadScrubAssignments<T>(sql: SqlTag<T>, guard: boolean): T {
  return readScrubAssignments(sql, sql`${guard} AND `);
}

function readScrubAssignments<T>(sql: SqlTag<T>, guard: T): T {
  const sourceRead = sql`run_metadata->>${SOURCE_FEED_READ_METADATA_KEY} = 'true'`;
  const deviceRead = sql`action_key = ${DEVICE_FEED_READ_ACTION_KEY}`;
  // Native transport owns feed_key. Browser step arguments are opaque source
  // input, even if they happen to use a protocol-looking key.
  const nativeBranch = sql`
    WHEN ${guard}${deviceRead} THEN jsonb_build_object('scrubbed', true, 'feed_key', action_input->>'feed_key')
    ELSE action_input`;
  return sql`action_output = CASE
    WHEN ${guard}(${deviceRead} OR ${sourceRead}) THEN NULL
    ELSE action_output END,
    action_input = CASE WHEN ${guard}${sourceRead} THEN '{"scrubbed":true}'::jsonb
      ${nativeBranch} END`;
}

/** The caller's WHERE clause already restricts this write to source reads. */
export function sourceReadOnlyScrubAssignments<T>(
  sql: SqlTag<T>,
  nativeInput: unknown = sql`jsonb_build_object('scrubbed', true, 'feed_key', action_input->>'feed_key')`,
  metadataKey: string = SOURCE_FEED_READ_METADATA_KEY,
): T {
  return sql`action_output = NULL,
    action_input = CASE WHEN run_metadata->>${metadataKey} = 'true' THEN '{"scrubbed":true}'::jsonb
      ELSE ${nativeInput} END`;
}

/** Raw SQL adapter for the reaper; preserves its existing positional bindings. */
export function sourceReadScrubAssignmentsSql(metadataKeyPlaceholder: `$${number}`): string {
  return sourceReadOnlyScrubAssignments(
    (strings, ...values) => strings.reduce((text, part, index) => text + String(values[index - 1]) + part),
    undefined,
    metadataKeyPlaceholder,
  );
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
