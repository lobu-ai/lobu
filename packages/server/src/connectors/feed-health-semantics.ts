/**
 * Derived feed-health semantics.
 *
 * Execution mode and attention state are DERIVED from existing
 * feed/connection/device columns at read time — never stored. The stored
 * columns keep their historical meaning; this module only classifies.
 *
 * ## Why derive instead of store
 *
 * A feed's execution nature (`source_only` vs `streaming` vs `scheduled` vs
 * `no_schedule`) is a pure function of its declared operations and schedule. Its
 * attention state is a pure function of lifecycle/sync state, auth-profile
 * status, and device liveness. Storing these would duplicate state that already
 * lives on the row and drift when the source columns move (auto-pause, backoff,
 * resume). Read-time derivation is O(1) per feed and cannot diverge.
 *
 * ## The two outputs
 *
 * - `executionMode` — what the row says about how this feed runs:
 *   - `source_only` — a feed that supports direct reads but not sync.
 *   - `streaming` — a chat channel populated by incoming messages, or a
 *     delivery-only feed whose source pushes bounded batches (no cron, no sync).
 *   - `scheduled` — a syncable feed with a cron in `feeds.schedule`.
 *   - `no_schedule` — a syncable feed with no cron. This says the feed has
 *     no cron and NOTHING MORE. It was called `manual` until 2026-08-12, which
 *     read an intent into it that the column does not carry: measured on prod
 *     that day, 196 of 215 active sync-capable feeds have no cron, and many are
 *     driven unattended through other dispatch paths (github `issue_comments` =
 *     4551 sync runs in 14 days with `schedule` and `next_run_at` both NULL).
 *     Do not reintroduce the intent reading under a new name.
 *
 *     `attention='no_trigger'` is NOT that reading returning. The 2026-08-12
 *     note named its own precondition — "a stored signal that distinguishes an
 *     unattended event-driven feed from a human-triggered one" — and that
 *     signal now exists: `feeds_schema[key].webhook`, the declaration the
 *     app-webhook router dispatches on. So the classification below is not
 *     "no cron, therefore manual"; it enumerates what can REPEATEDLY re-arm
 *     `next_run_at` and fires only when a syncable feed has neither. github's
 *     no-cron feeds declare a webhook and stay `healthy`.
 * - `attention` — what a human/UI should be told about the feed right now,
 *   ordered so the most actionable state wins:
 *   - `needs_auth` — the connection/auth profile is not usable (pending_auth,
 *     revoked, auth profile not active).
 *   - `setup_required` — a manifest-backed device connector is online but has
 *     not granted its declared capability.
 *   - `paused` — operator- or auto-paused; not running until resumed.
 *   - `misconfigured` — the connection is in an error state.
 *   - `device_offline` — the feed is pinned to a device that has not polled
 *     within the liveness window.
 *   - `last_attempt_failed` — the most recent attempt failed (failing state,
 *     including backoff episodes).
 *   - `overdue` — a scheduled feed has had no active run for more than an hour
 *     past `next_run_at`.
 *   - `no_trigger` — a syncable feed with no way to be dispatched: no cron, no
 *     webhook route, not a channel. `CheckDueFeeds` selects on
 *     `next_run_at <= now`. Two writers of that column are REPEATING and can
 *     sustain a cadence: the cron (re-stamped at every run completion) and an
 *     app-webhook delivery. The rest are one-shot episodic re-arms tied to a
 *     lifecycle moment — device auto-wire's first stamp, auth-completion and
 *     browser-reauth resume (`run-lifecycle`), connect (`connect/routes`), and
 *     auth-profile activation (`manage_auth_profiles`). Each fires once and
 *     `run-lifecycle` nulls the column again when that run completes, because
 *     there is no cron to compute the next one from. So a feed with neither
 *     repeating writer cannot hold a cadence however many episodic re-arms it
 *     sees, and runs only when something triggers it by hand. Ranked above
 *     `never_run` because that one states the symptom while this states the
 *     cause.
 *   - `never_run` — never synced.
 *   - `healthy` — everything else.
 *
 * ## There is deliberately no `incidentEligible` here
 *
 * An earlier version derived one, defined as "an active SCHEDULED feed failing
 * for a platform-relevant reason". It rested on the cron inference above, and
 * nothing consumed it — `list_feeds` copied it into its output and no caller
 * ever read it, while the alerter that actually pages disagreed with it. "Is
 * this failure worth paging someone about" is a decision, not a property of a
 * row; it lives in `connectors/connector-health.ts`, the one place that acts on
 * it, alongside the prod measurements justifying its predicate. Do not
 * reintroduce a second copy here without a stored signal that distinguishes an
 * unattended event-driven feed from a human-triggered one.
 */

import type { FeedOperation } from '@lobu/connector-sdk';

/**
 * SQL for the `webhook_driven` input below — the single definition of what
 * counts as a dispatchable webhook route.
 *
 * It mirrors `loadGithubWebhookRoutes`
 * (`gateway/routes/public/app-webhooks.ts`), which skips a feed unless
 * `webhook.events` is an ARRAY holding at least one non-empty string.
 * A bare `IS NOT NULL` on the `webhook` key is NOT equivalent: jsonb null is
 * not SQL NULL, so `{}`, `{mode:'store'}`, `{events: []}`, `{events: ['']}`
 * and a JSON-null webhook would all read as event-driven and hide exactly the
 * feed `no_trigger` exists to surface.
 *
 * Exported as one fragment because two readers must agree — `list_feeds`
 * (`tools/admin/manage_feeds.ts`) and the health scan
 * (`connectors/connector-health.ts`). Hand-copied jsonb predicates drift, and
 * drift here means the two surfaces silently disagree about one feed.
 *
 * The type guard is a CASE, not `AND`, deliberately. Postgres does not promise
 * that `AND` short-circuits left-to-right ("Expression Evaluation Rules" — use
 * CASE when order matters), and if the planner evaluated the EXISTS first a
 * scalar or object `events` would reach `jsonb_array_elements` and raise
 * "cannot extract elements from a scalar", 500ing a user-facing read path.
 * CASE makes the guard ordering part of the semantics rather than a bet.
 */
export function feedWebhookDrivenSql(
  definitionAlias: string,
  feedAlias: string
): string {
  const events =
    `${definitionAlias}.feeds_schema -> ${feedAlias}.feed_key` +
    ` -> 'webhook' -> 'events'`;
  return `CASE WHEN jsonb_typeof(${events}) = 'array' THEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements(${events}) AS declared_event
            WHERE jsonb_typeof(declared_event) = 'string'
              AND declared_event #>> '{}' <> ''
          ) ELSE false END`;
}

type FeedExecutionMode = "source_only" | "streaming" | "scheduled" | "no_schedule";

type FeedAttentionState =
  | "healthy"
  | "paused"
  | "needs_auth"
  | "setup_required"
  | "last_attempt_failed"
  | "overdue"
  | "no_trigger"
  | "never_run"
  | "device_offline"
  | "misconfigured";

interface FeedHealthSemanticsInput {
  /** Operations derived from the selected connector feed handlers. */
  operations?: FeedOperation[] | null;
  /** Storage plane. Channel feeds read transcripts rather than connector events. */
  store?: 'events' | 'channel_messages' | null;
  /** `feeds.status` — 'active' | 'paused' | 'error'. */
  status?: string | null;
  /** `feeds.schedule` — cron; NULL means no cron is configured, which does NOT
   *  imply the feed is human-triggered (see the header). */
  schedule?: string | null;
  /** `feeds.last_sync_status` — 'success' | 'failed' | 'pending' | NULL. */
  last_sync_status?: string | null;
  /** `feeds.last_sync_at`. */
  last_sync_at?: Date | string | null;
  /** `feeds.consecutive_failures`. */
  consecutive_failures?: number | null;
  /** `feeds.next_run_at` — only meaningful when schedule is present. */
  next_run_at?: Date | string | null;
  /**
   * The connector declares a DISPATCHABLE webhook route for this feed, so an
   * inbound delivery re-arms `next_run_at`. This is the stored signal that
   * separates an unattended event-driven feed from one with no dispatch path
   * at all; without it, "no cron" is not classifiable (see the header).
   * Compute it with `feedWebhookDrivenSql` above — "dispatchable" is narrower
   * than "a webhook key exists", and that fragment is the definition.
   */
  webhook_driven?: boolean | null;
  /** Number of pending/claimed/running sync runs selected by list_feeds. */
  active_runs?: number | null;
  /** `connections.status` — 'active' | 'paused' | 'error' | 'revoked' |
   *  'pending_auth'. */
  connection_status?: string | null;
  /** `auth_profiles.status` — 'active' | 'pending_auth' | 'error' | 'revoked'. */
  auth_profile_status?: string | null;
  /** `connections.device_worker_id` — NULL when not device-pinned. */
  device_worker_id?: string | null;
  /** Derived `device_online` flag (device polled within the liveness window). */
  device_online?: boolean | null;
  /** Canonical manifest/capability/liveness projection for a device connector. */
  device_connector_readiness?:
    | "ready"
    | "setup_required"
    | "device_offline"
    | null;
}

interface FeedHealthSemantics {
  executionMode: FeedExecutionMode;
  attention: FeedAttentionState;
}

const isStreaming = (input: FeedHealthSemanticsInput): boolean =>
  input.store === "channel_messages";

const isScheduled = (input: FeedHealthSemanticsInput): boolean =>
  input.operations?.includes('sync') === true &&
  typeof input.schedule === "string" &&
  input.schedule.length > 0;

/** The connection or auth profile is not usable without human action. */
function needsAuth(input: FeedHealthSemanticsInput): boolean {
  if (
    input.connection_status === "pending_auth" ||
    input.connection_status === "revoked"
  ) {
    return true;
  }
  return (
    input.auth_profile_status != null &&
    input.auth_profile_status !== "" &&
    input.auth_profile_status !== "active"
  );
}

function pinnedDeviceOffline(input: FeedHealthSemanticsInput): boolean {
  return (
    input.device_worker_id != null &&
    input.device_worker_id.length > 0 &&
    input.device_online === false
  );
}

/** The feed is pinned to a device that has not recently polled. */
function deviceOffline(input: FeedHealthSemanticsInput): boolean {
  // A connection pin is narrower than fleet readiness. Another ready device
  // cannot execute a feed that remains pinned to this offline device.
  if (pinnedDeviceOffline(input)) return true;
  if (input.device_connector_readiness == null) return false;
  return input.device_connector_readiness === "device_offline";
}

function setupRequired(input: FeedHealthSemanticsInput): boolean {
  return !pinnedDeviceOffline(input) && input.device_connector_readiness === "setup_required";
}

/** The most recent attempt failed, or a failure episode is underway. */
function lastAttemptFailed(input: FeedHealthSemanticsInput): boolean {
  return (
    input.last_sync_status === "failed" ||
    (input.consecutive_failures ?? 0) > 0
  );
}

const FEED_OVERDUE_MARGIN_MS = 60 * 60 * 1000;

function scheduledExecutionOverdue(
  input: FeedHealthSemanticsInput,
  now: number
): boolean {
  if (!isScheduled(input) || (input.active_runs ?? 0) > 0) return false;
  if (input.next_run_at == null) return false;
  const nextRun =
    input.next_run_at instanceof Date
      ? input.next_run_at.getTime()
      : new Date(input.next_run_at).getTime();
  return Number.isFinite(nextRun) && nextRun < now - FEED_OVERDUE_MARGIN_MS;
}

/**
 * A syncable feed with nothing that can re-arm `next_run_at`. Enumerates the
 * dispatch paths rather than inferring intent from the absence of a cron:
 * cron (`feeds.schedule`), app-webhook delivery (`webhook_driven`), or a
 * channel/read-only feed that runs no sync lifecycle at all (both handled
 * before this is reached). Device auto-wire also stamps `next_run_at` once at
 * creation, which is why such a feed can show one successful sync and still be
 * unreachable forever after.
 */
function hasNoDispatchPath(input: FeedHealthSemanticsInput): boolean {
  return (
    input.operations?.includes('sync') === true &&
    !isScheduled(input) &&
    input.webhook_driven !== true
  );
}

/** The feed is paused, by operator or auto-pause. */
function isPaused(input: FeedHealthSemanticsInput): boolean {
  return input.status === "paused" || input.connection_status === "paused";
}

/** Attention for feed kinds that do not run collector sync jobs. */
function nonCollectorAttention(
  input: FeedHealthSemanticsInput
): FeedAttentionState {
  if (needsAuth(input)) return "needs_auth";
  if (setupRequired(input)) return "setup_required";
  if (isPaused(input)) return "paused";
  if (input.status === "error" || input.connection_status === "error") {
    return "misconfigured";
  }
  if (deviceOffline(input)) return "device_offline";
  return "healthy";
}

/**
 * Derive execution mode + attention state from the stored feed/connection/device
 * columns. Pure: the caller feeds the joined row fields and gets back the
 * classification. Order of checks fixes the precedence (the most actionable
 * state wins).
 */
export function deriveFeedHealthSemantics(
  input: FeedHealthSemanticsInput,
  now: number = Date.now()
): FeedHealthSemantics {
  // Storage decides presentation. A chat channel remains streaming even if a
  // connector later adds a direct read operation for that transcript.
  if (isStreaming(input)) {
    return {
      executionMode: "streaming",
      attention: nonCollectorAttention(input),
    };
  }

  // Read-only feeds are evaluated on demand; they have no sync lifecycle.
  if (
    input.operations?.includes('read') === true &&
    input.operations.includes('sync') === false &&
    input.operations.includes('delivery') === false
  ) {
    return {
      executionMode: "source_only",
      attention: nonCollectorAttention(input),
    };
  }

  const executionMode: FeedExecutionMode = input.operations?.includes('delivery') && !input.operations.includes('sync')
    ? "streaming"
    : isScheduled(input)
    ? "scheduled"
    : "no_schedule";

  let attention: FeedAttentionState;
  if (needsAuth(input)) {
    attention = "needs_auth";
  } else if (setupRequired(input)) {
    attention = "setup_required";
  } else if (isPaused(input)) {
    attention = "paused";
  } else if (input.status === "error" || input.connection_status === "error") {
    attention = "misconfigured";
  } else if (deviceOffline(input)) {
    attention = "device_offline";
  } else if (lastAttemptFailed(input)) {
    attention = "last_attempt_failed";
  } else if (scheduledExecutionOverdue(input, now)) {
    attention = "overdue";
  } else if (hasNoDispatchPath(input)) {
    attention = "no_trigger";
  } else if (
    input.last_sync_at == null &&
    input.last_sync_status !== "success"
  ) {
    attention = "never_run";
  } else {
    attention = "healthy";
  }

  return { executionMode, attention };
}
