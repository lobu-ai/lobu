/**
 * Window utilities for Automation windows.
 *
 * An Automation books progress on the ARRIVAL axis — `events.created_at`, the
 * instant Lobu stored a row — never on `occurred_at`. Connectors resync, archives
 * import, calendar items are written days after the meeting began: measured in
 * prod, 56% of first-seen connector rows were stored more than an hour after
 * they happened and 38% more than a week after. A window keyed on when things
 * happened silently lost every one of those inside an already-completed period;
 * a window keyed on when they arrived cannot.
 *
 * The bookkeeping is one mark per Automation, `automations.next_window_start`:
 * every row with `created_at >= mark` is unclaimed. Claims are serialized per
 * Automation (a second claim gets 409 while one is active), so the mark alone is
 * the whole record of progress: everything before it is covered, everything at
 * or after it is not. `last_completed_window_start` records where the newest
 * completed run began, which is what the `window_lag` surface reports.
 */

import { intervals } from '../config/intervals';
import type { DbClient } from '../db/client';
import type { UnprocessedRange } from '../types/automations';
import { parseDateAlias } from './date-aliases';
import { ToolUserError } from './errors';

/**
 * How long a stored row must have settled before a window may include it.
 *
 * Read through the lazy getter, never cached: an operator widens it during an
 * incident without a deploy, and an integration test collapses it to see a row
 * it just inserted. Default and rationale live in `config/intervals.ts`.
 */
export function automationArrivalSettleMs(): number {
  return intervals.automationArrivalSettleMs;
}

/** The newest instant a window may reach, given the database clock. */
export function automationArrivalHorizon(dbNow: Date): Date {
  return new Date(dbNow.getTime() - automationArrivalSettleMs());
}

/**
 * The database clock, rounded UP to the next whole millisecond.
 *
 * Truncating DOWN put the reading up to a millisecond behind the real clock, so
 * a row stored a fraction of a millisecond before the read could land at or
 * after the horizon and be dropped from a window that should have contained it.
 * Invisible against a 60s settle budget; the dominant flake once that budget is
 * collapsed. Rounding up keeps the millisecond precision the value needs to
 * round-trip through a run's `approved_input`, and makes "stored before this
 * read" mean "strictly behind the horizon".
 *
 * Every arrival instant is read from the clock that stamps `events.created_at`,
 * never from the application's, so application/database skew cannot move the
 * frontier. The window readers below take it from the row they already lock;
 * this is for the one caller that computes a range without reading one.
 */
export async function readDatabaseNow(sql: DbClient): Promise<Date> {
  const [row] = await sql<{ db_now: string | Date }>`
    SELECT date_trunc('milliseconds', current_timestamp) + interval '1 millisecond'
             AS db_now
  `;
  return new Date(row.db_now);
}

interface WindowDates {
  windowStart: Date;
  windowEnd: Date;
  /**
   * Start of the newest completed arrival range, handed back so a caller that
   * also reports it does not re-query the row this function just read.
   */
  lastCompletedWindowStart: Date | null;
}

interface ArrivalMarkRow {
  next_window_start: string | Date | null;
  last_completed_window_start: string | Date | null;
  db_now: string | Date;
}

function arrivalWindowFromRow(row: ArrivalMarkRow, mark: Date): WindowDates {
  const horizon = automationArrivalHorizon(new Date(row.db_now));
  return {
    windowStart: mark,
    // Never inverted: nothing has settled since the mark → an empty window.
    // Callers decide what that means (the claim path refuses it).
    windowEnd: horizon > mark ? horizon : mark,
    lastCompletedWindowStart: row.last_completed_window_start
      ? new Date(row.last_completed_window_start)
      : null,
  };
}

/**
 * The pending arrival window `[mark, horizon)`, locked.
 *
 * Locks the Automation row so a concurrent claim or completion serializes behind
 * it, and seeds a NULL mark to the database clock (a row that predates the mark
 * starts from its first read). Every instant comes from the database clock —
 * the clock that stamps `events.created_at` — so application/database skew can
 * never move the frontier. Rounded to a whole millisecond so the value
 * round-trips through the run's `approved_input` unchanged.
 */
export async function computePendingWindow(
  sql: DbClient,
  automationId: number
): Promise<WindowDates> {
  const read = async (tx: DbClient): Promise<WindowDates> => {
    const [row] = await tx<ArrivalMarkRow>`
      SELECT next_window_start, last_completed_window_start,
             date_trunc('milliseconds', current_timestamp) + interval '1 millisecond'
               AS db_now
      FROM automations
      WHERE id = ${automationId}
      FOR UPDATE
    `;
    if (!row) throw new ToolUserError(`Automation ${automationId} not found.`, 404);
    if (row.next_window_start) {
      return arrivalWindowFromRow(row, new Date(row.next_window_start));
    }
    // A NULL mark is a repair, not a creation: we do not know what this
    // Automation has already processed, so we start at the clock rather than
    // reaching back. Only the creation INSERTs in `manage_automations/crud.ts`
    // reach back, by `intervals.automationFirstWindowLookbackMs`.
    const seeded = new Date(row.db_now);
    await tx`
      UPDATE automations
      SET next_window_start = ${seeded.toISOString()}::timestamptz
      WHERE id = ${automationId}
    `;
    return arrivalWindowFromRow(row, seeded);
  };
  return typeof sql.savepoint === 'function' ? read(sql) : sql.begin(read);
}

/**
 * The pending arrival window without a lock or a seed, for status surfaces
 * (`get_automation`) that must not write. Null when the Automation is missing.
 */
export async function readPendingWindow(
  sql: DbClient,
  automationId: number
): Promise<WindowDates | null> {
  const [row] = await sql<ArrivalMarkRow>`
    SELECT next_window_start, last_completed_window_start,
           date_trunc('milliseconds', current_timestamp) + interval '1 millisecond'
             AS db_now
    FROM automations
    WHERE id = ${automationId}
    LIMIT 1
  `;
  if (!row) return null;
  return arrivalWindowFromRow(
    row,
    row.next_window_start ? new Date(row.next_window_start) : new Date(row.db_now)
  );
}

/**
 * Book a completed arrival range: move the mark to `windowEnd`.
 *
 * Only a range that reaches the mark moves it (`windowStart <= mark < windowEnd`).
 * A range entirely behind the mark is a re-read and books nothing. A range that
 * starts after the mark is an explicitly selected later span and books nothing
 * either: the rows stored between the mark and it stay unclaimed, and the next
 * ordinary claim returns them. The booked span behind the mark therefore
 * stays contiguous.
 *
 * This is the only writer of the mark. The two completion sites that store
 * `action_output` — `complete-window.ts` and the unchanged-source skip in
 * `automations/automation.ts` — both call it inside their completion
 * transaction; no trigger re-derives the mark from run history any more.
 *
 * Returns whether the mark moved.
 */
export async function advanceAutomationArrivalMark(
  sql: DbClient,
  automationId: number,
  windowStart: Date,
  windowEnd: Date
): Promise<boolean> {
  const start = windowStart.toISOString();
  const end = windowEnd.toISOString();
  // The mark may never land in the future. Every forward path is already
  // horizon-bounded, so the clamp is a no-op for them — it exists for ONE
  // window: a token minted before the cutover, by the old `alignRequestedWindow`,
  // which never clamped an agent-supplied `until`. Such a token can complete
  // after the migration and push the mark past `now`, and an Automation whose
  // mark is in the future claims nothing until the clock catches up, silently.
  // `LEAST` can only ever lower the value, so it cannot mask a real advance.
  const moved = await sql`
    UPDATE automations
    SET next_window_start = LEAST(${end}::timestamptz, current_timestamp),
        last_completed_window_start = GREATEST(
          last_completed_window_start,
          ${start}::timestamptz
        ),
        updated_at = current_timestamp
    WHERE id = ${automationId}
      AND next_window_start IS NOT NULL
      AND ${start}::timestamptz <= next_window_start
      AND ${end}::timestamptz > next_window_start
    RETURNING id
  `;
  return moved.length > 0;
}

/** Start of the newest completed arrival range, or null before the first completion. */
export async function readLastCompletedWindowStart(
  sql: DbClient,
  automationId: number
): Promise<Date | null> {
  const [row] = await sql<{ last_completed_window_start: string | Date | null }>`
    SELECT last_completed_window_start
    FROM automations
    WHERE id = ${automationId}
    LIMIT 1
  `;
  return row?.last_completed_window_start ? new Date(row.last_completed_window_start) : null;
}

/**
 * An agent-chosen `since`/`until` as an arrival range.
 *
 * `until` is inclusive as the caller means it ("through Sep 3"), so the exclusive
 * end is the start of the following UTC day — clamped to the arrival horizon,
 * because a completion may never move the mark past rows that are still
 * settling. The caller rejects a range the clamp has emptied.
 */
export function requestedArrivalWindow(
  since: Date,
  until: Date,
  now: Date
): { windowStart: Date; windowEnd: Date } {
  const horizon = automationArrivalHorizon(now);
  const dayAfterUntil = new Date(
    Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate() + 1)
  );
  return {
    windowStart: since,
    windowEnd: dayAfterUntil < horizon ? dayAfterUntil : horizon,
  };
}

/**
 * The rows an explicitly selected later range leaves unclaimed, in words, or
 * null when the range starts at or before the mark.
 *
 * Travels IN the payload rather than only in the markdown: Automation runs read
 * `read_knowledge` as JSON through `run_sdk`, and a number alone did not change
 * what a run did (an earlier lag field was ignored on a live run).
 */
export function describeUnclaimedArrivals(mark: Date, windowStart: Date): string | null {
  if (windowStart <= mark) return null;
  return (
    `Rows stored between ${mark.toISOString()} and ${windowStart.toISOString()} are not ` +
    "included here: this explicitly selected range starts after the Automation's mark. " +
    'The mark stays where it is, so an ordinary claim still returns them. Read and ' +
    'complete this range without treating the earlier arrivals as processed.'
  );
}

/** Row shape for a `DATE_TRUNC('month', ...)` aggregate of total events per month. */
interface MonthlyTotalRow {
  month: string | Date;
  total: number | string;
}

/** Row shape for a `DATE_TRUNC('month', ...)` aggregate of linked events per month. */
interface MonthlyLinkedRow {
  month: string | Date;
  linked: number | string;
}

/**
 * Fold two month-bucketed aggregates — total events per month vs. events linked
 * to an automation's windows per month — into the `UnprocessedRange[]` histogram.
 *
 * Shared by `get_content` (Automation mode) and `get_automation` (pending analysis).
 *
 * @param includeComplete when true, months with zero unprocessed content are
 *   still emitted (with `status: 'complete'`). When false, only months with
 *   unprocessed content are emitted. `get_content` passes true; `get_automation`
 *   passes false.
 */
export function foldUnprocessedRanges(
  monthlyTotals: Iterable<MonthlyTotalRow>,
  monthlyLinked: Iterable<MonthlyLinkedRow>,
  includeComplete: boolean
): UnprocessedRange[] {
  const linkedByMonth = new Map<string, number>();
  for (const row of monthlyLinked) {
    const monthKey = new Date(row.month as string).toISOString().slice(0, 7);
    linkedByMonth.set(monthKey, Number(row.linked));
  }

  const ranges: UnprocessedRange[] = [];
  for (const row of monthlyTotals) {
    const monthDate = new Date(row.month as string);
    const monthKey = monthDate.toISOString().slice(0, 7);
    const total = Number(row.total);
    const linked = linkedByMonth.get(monthKey) || 0;
    const unprocessed = total - linked;

    if (!includeComplete && unprocessed <= 0) continue;

    const rangeStart = new Date(monthDate);
    const rangeEnd = new Date(monthDate);
    rangeEnd.setUTCMonth(rangeEnd.getUTCMonth() + 1);
    rangeEnd.setUTCMilliseconds(-1);

    let status: UnprocessedRange['status'];
    if (linked === 0) {
      status = 'unprocessed';
    } else if (unprocessed === 0) {
      status = 'complete';
    } else {
      status = 'partial';
    }

    ranges.push({
      month: monthKey,
      window_start: rangeStart.toISOString(),
      window_end: rangeEnd.toISOString(),
      total_content: total,
      processed_content: linked,
      unprocessed_content: unprocessed,
      status,
    });
  }
  return ranges;
}

/**
 * Resolve an agent-supplied `since`/`until` to a UTC instant.
 *
 * Window boundaries are UTC everywhere in this file (`requestedArrivalWindow`
 * builds its day edge with `Date.UTC`), and so is `parseDateAlias`: a calendar
 * date or alias names a UTC day on every deployment. The shared parser used to
 * resolve in the SERVER's LOCAL zone, so content filters could read an explicit
 * `2026-08-06` as the 5th west of UTC, while this function could resolve
 * `today` to a window starting tomorrow east of UTC. A datetime is truncated to
 * its UTC day.
 */
export function parseAutomationWindowDate(value: string): Date {
  const date = new Date(parseDateAlias(value).date);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/**
 * When something an Automation window produced actually happened.
 *
 * A claimed `window_end` is an arrival horizon and already in the past, but an
 * agent-chosen range may reach the clock, and every read path bounds on
 * `occurred_at <= now()`, so a flat `window_end` stamp would hide the row until
 * that instant passes. Clamping keeps the window-end reading for a range that
 * closed and tells the truth for one still open.
 *
 * Shared rather than inlined because the stamp has more than one writer:
 * `complete-window.ts` writes run output and `feedback.ts` writes a correction.
 */
export function automationOutputOccurredAt(windowEnd: string | Date): string {
  const endMs = new Date(windowEnd).getTime();
  return new Date(
    Number.isFinite(endMs) ? Math.min(endMs, Date.now()) : Date.now()
  ).toISOString();
}

/**
 * SQL fragments for the completed-window history `get_automation` reads
 * directly off `runs`. Extracted so the SELECT and its COUNT(*) pagination
 * fallback cannot drift apart.
 */
/** FROM fragment for callers that need `iw` joined to versions (the SELECT clause). */
export function buildWindowsFromWithVersions(): string {
  return `runs iw
    JOIN automations i ON iw.automation_id = i.id
    LEFT JOIN automation_versions automation_v ON i.current_version_id = automation_v.id
    LEFT JOIN automation_versions window_v
      ON window_v.id = CASE
        WHEN iw.approved_input->>'version_id' ~ '^\\d+$'
          THEN (iw.approved_input->>'version_id')::bigint
        ELSE NULL
      END`;
}

/** Bare FROM fragment for the COUNT(*) pagination fallback (no version joins). */
export function buildWindowsCountFromClause(): string {
  return `runs iw
    JOIN automations i ON iw.automation_id = i.id`;
}

export function buildWindowsSelectClause(): string {
  return `
    SELECT
      iw.id as run_id,
      iw.automation_id,
      COALESCE(window_v.name, automation_v.name, i.name) as automation_name,
      (iw.approved_input->>'window_start')::timestamptz as window_start,
      (iw.approved_input->>'window_end')::timestamptz as window_end,
      COALESCE(
        CASE WHEN iw.run_metadata->>'content_analyzed' ~ '^\\d+$'
          THEN (iw.run_metadata->>'content_analyzed')::bigint END,
        (SELECT COUNT(*) FROM automation_run_events link WHERE link.run_id = iw.id)
      ) as content_analyzed,
      iw.action_output as extracted_data,
      iw.model_used,
      NULLIF(iw.run_metadata->>'client_id', '') as client_id,
      iw.run_metadata,
      COALESCE(
        CASE WHEN iw.run_metadata->>'execution_time_ms' ~ '^\\d+$'
          THEN (iw.run_metadata->>'execution_time_ms')::bigint END,
        CASE WHEN iw.completed_at IS NOT NULL AND iw.claimed_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (iw.completed_at - iw.claimed_at)) * 1000)::bigint END
      ) as execution_time_ms,
      iw.created_at,
      window_v.id as version_id,
      CAST(COUNT(*) OVER () AS INTEGER) as total_count
    FROM ${buildWindowsFromWithVersions()}
  `.trim();
}

/**
 * Safely convert a value to a JavaScript number.
 *
 * PostgreSQL BIGSERIAL columns can return BigInt,
 * which causes issues with JSON serialization and API responses.
 * This utility ensures consistent number types throughout the application.
 */
export function ensureNumber(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return value;
}

/**
 * Safely convert a timestamp value from a SQL row to an ISO string.
 *
 * postgres.js returns `timestamp`/`timestamptz` columns as JS `Date` objects
 * (not strings) unless the projection casts them to text, so a field typed
 * `string` in the row interface is a `Date` at runtime. Emitting that raw Date
 * as `structuredContent` fails a `Type.String()` outputSchema check. Normalize
 * Date | string to ISO here; `fallback` covers a nullable column (e.g. a window
 * `created_at` that defaults to its `window_end`). Returns null when neither is
 * a usable timestamp — callers map that to a nullable schema field.
 */
export function ensureIsoString(
  value: Date | string | null | undefined,
  fallback?: Date | string | null | undefined
): string | null {
  for (const candidate of [value, fallback]) {
    if (candidate == null) continue;
    const date = candidate instanceof Date ? candidate : new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

/**
 * Parse a PostgreSQL bigint[] column that may come back as a raw string
 * like "{9}" or "{1,2,3}" when fetch_types is disabled.
 * Returns an array of numbers.
 */
export function parseBigintArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') {
    return value.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number);
  }
  return [];
}
