/**
 * scheduled_jobs CRUD + ticker.
 *
 * Model: a `scheduled_jobs` row is the *definition* of a recurring (or
 * one-shot) job. The ticker — registered as a TaskScheduler cron at
 * `* * * * *` — scans due rows and `scheduler.spawn`s a task per firing.
 * The actual handler execution rides on the existing runs-queue, with
 * claim/retry/idempotency/observability inherited.
 *
 * Firing flow:
 *   1. Tick claims rows WHERE next_run_at <= now AND NOT paused.
 *   2. For each row, spawn(action_type, action_args, { idempotencyKey, runAt: now }).
 *   3. Advance last_fired_at + next_run_at (or pause if one-shot completed).
 * If the tick crashes between step 2 and 3, the next tick re-reads the
 * same row (next_run_at not advanced) and re-spawns — idempotency dedup
 * stops duplicates. Self-healing.
 */

import { getDb } from '../db/client';
import { runtimeConnectionIdToSlug } from '../lobu/stores/connections-projection';
import { nextRunAt as nextCronTickAt } from '../utils/cron';
import logger from '../utils/logger';
import type { TaskScheduler } from './task-scheduler';
import { errorMessage } from '../utils/errors';

export interface ScheduledDeliveryContext {
  platform: string;
  conversationId: string;
  channelId: string;
  teamId?: string | null;
  connectionId: string;
  userId?: string | null;
}

/**
 * Chat platforms a scheduled wake can post its reply back into. Single source
 * of truth shared by the create-time gate (`manage_schedules`) and the
 * fire-time dispatch (`scheduled/jobs.ts`) so the two can never drift — a
 * platform accepted at creation but unhandled at execution would store a dead
 * `delivery_context` and silently fall back to the api path.
 */
export const DELIVERABLE_CHAT_PLATFORMS = ['slack', 'telegram', 'gchat'] as const;

export function isDeliverableChatPlatform(platform: string): boolean {
  return (DELIVERABLE_CHAT_PLATFORMS as readonly string[]).includes(platform);
}

export type DeliveryAuthzDenyReason =
  | 'connection-missing'
  | 'platform-changed'
  | 'connection-inactive'
  | 'agent-mismatch'
  | 'channel-unbound';

export type DeliveryAuthzResult =
  | { authorized: true }
  | { authorized: false; reason: DeliveryAuthzDenyReason };

/**
 * Is `agentId` authorized to deliver into the connection/channel named by a
 * delivery context? Single source of truth shared by the create-time gate
 * (`manage_schedules`, which maps the deny reason to a user-facing error) and
 * the fire-time re-check (`scheduled/jobs.ts`, which only needs the boolean).
 * Both must agree, and a cron can fire long after creation, so the same
 * validation runs at both points against the live connection + binding rows.
 */
export async function validateDeliveryAuthorization(params: {
  organizationId: string;
  agentId: string;
  delivery: ScheduledDeliveryContext;
}): Promise<DeliveryAuthzResult> {
  const sql = getDb();
  const { organizationId, agentId, delivery } = params;
  const connectionRows = (await sql`
    SELECT id, connector_key, agent_id, status
    FROM connections
    WHERE organization_id = ${organizationId}
      AND slug = ${runtimeConnectionIdToSlug(delivery.connectionId)}
      AND credential_mode IS NOT NULL
      AND deleted_at IS NULL
    LIMIT 1
  `) as unknown as Array<{
    id: number;
    connector_key: string;
    agent_id: string | null;
    status: string;
  }>;
  const connection = connectionRows[0];
  if (!connection) return { authorized: false, reason: 'connection-missing' };
  if (connection.connector_key !== delivery.platform) {
    return { authorized: false, reason: 'platform-changed' };
  }
  if (connection.status !== 'active') {
    return { authorized: false, reason: 'connection-inactive' };
  }
  if (connection.agent_id) {
    return connection.agent_id === agentId
      ? { authorized: true }
      : { authorized: false, reason: 'agent-mismatch' };
  }

  // team_id on the view is COALESCE(trigger match, connection external_tenant_id,
  // config teamId) — so a Slack connection with external_tenant_id never exposes
  // team_id as NULL. trigger_team_id is the trigger's own team constraint only
  // (nullable). Delivery auth must use trigger semantics: a delivery with no
  // teamId is allowed when the trigger has no team constraint; a delivery with
  // a teamId matches either the trigger team or the resolved COALESCE team_id
  // (so team-scoped deliveries keep working via the connection fallback).
  const deliveryTeamId = delivery.teamId ?? null;
  const bindingRows = await sql`
    SELECT agent_id
    FROM automation_message_subscriptions
    WHERE organization_id = ${organizationId}
      AND platform = ${delivery.platform}
      AND connection_id = ${connection.id}
      AND (
        channel_id = ${delivery.channelId}
        OR native_channel_id = ${delivery.channelId}
      )
      AND (
        trigger_team_id IS NOT DISTINCT FROM ${deliveryTeamId}::text
        OR (
          ${deliveryTeamId}::text IS NOT NULL
          AND team_id IS NOT DISTINCT FROM ${deliveryTeamId}::text
        )
      )
    LIMIT 1
  `;
  const binding = (bindingRows as unknown as Array<{ agent_id: string }>)[0];
  return binding?.agent_id === agentId
    ? { authorized: true }
    : { authorized: false, reason: 'channel-unbound' };
}

export interface ScheduledJobRow {
  id: string;
  organization_id: string;
  action_type: string;
  action_args: Record<string, unknown>;
  delivery_context: ScheduledDeliveryContext | null;
  cron: string | null;
  next_run_at: string;
  timezone: string | null;
  until_at: string | null;
  idempotency_key: string | null;
  last_fired_at: string | null;
  last_fired_run_id: number | null;
  paused: boolean;
  description: string;
  created_by_user: string | null;
  created_by_agent: string | null;
  source_run_id: number | null;
  source_event_id: number | null;
  source_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CreateScheduledJobParams {
  organizationId: string;
  actionType: string;
  actionArgs: Record<string, unknown>;
  deliveryContext?: ScheduledDeliveryContext | null;
  description: string;
  cron?: string | null;
  runAt: Date;
  /** IANA zone the cron is evaluated in; null/omitted = server time. */
  timezone?: string | null;
  /** Stop recurring after this instant; the ticker pauses the row instead of advancing past it. */
  untilAt?: Date | null;
  /** Client-chosen dedup key: a retried create with the same (org, key) returns the existing row. */
  idempotencyKey?: string | null;
  createdByUser?: string | null;
  createdByAgent?: string | null;
  sourceRunId?: number | null;
  sourceEventId?: number | null;
  sourceThreadId?: string | null;
}

export async function createScheduledJob(
  params: CreateScheduledJobParams
): Promise<ScheduledJobRow> {
  if (!params.createdByUser && !params.createdByAgent) {
    throw new Error('scheduled_jobs requires created_by_user or created_by_agent');
  }
  const sql = getDb();
  // ON CONFLICT rides the partial unique index on (org, idempotency_key).
  // The no-op DO UPDATE (vs DO NOTHING) makes RETURNING yield the existing
  // row, so a retried create gets the original schedule back instead of a
  // duplicate — or an empty result it would have to re-query for.
  const rows = (await sql`
    INSERT INTO scheduled_jobs (
      organization_id, action_type, action_args, delivery_context, cron, next_run_at,
      timezone, until_at, idempotency_key,
      description,
      created_by_user, created_by_agent,
      source_run_id, source_event_id, source_thread_id
    ) VALUES (
      ${params.organizationId}, ${params.actionType},
      ${sql.json(params.actionArgs)}, ${params.deliveryContext ? sql.json(params.deliveryContext) : null}, ${params.cron ?? null}, ${params.runAt},
      ${params.timezone ?? null}, ${params.untilAt ?? null}, ${params.idempotencyKey ?? null},
      ${params.description},
      ${params.createdByUser ?? null}, ${params.createdByAgent ?? null},
      ${params.sourceRunId ?? null}, ${params.sourceEventId ?? null},
      ${params.sourceThreadId ?? null}
    )
    ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    RETURNING *
  `) as unknown as ScheduledJobRow[];
  return rows[0];
}

export async function listScheduledJobs(opts: {
  organizationId: string;
  createdByAgent?: string | null;
  createdByUser?: string | null;
  actionType?: string | null;
  includePaused?: boolean;
}): Promise<ScheduledJobRow[]> {
  const sql = getDb();
  const includePaused = opts.includePaused ?? true;
  return (await sql`
    SELECT * FROM scheduled_jobs
    WHERE organization_id = ${opts.organizationId}
      AND (${opts.createdByAgent ?? null}::text IS NULL OR created_by_agent = ${opts.createdByAgent ?? null})
      AND (${opts.createdByUser ?? null}::text IS NULL OR created_by_user = ${opts.createdByUser ?? null})
      AND (${opts.actionType ?? null}::text IS NULL OR action_type = ${opts.actionType ?? null})
      AND (${includePaused} OR NOT paused)
    ORDER BY next_run_at ASC
  `) as unknown as ScheduledJobRow[];
}

export async function getScheduledJob(
  organizationId: string,
  id: string
): Promise<ScheduledJobRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM scheduled_jobs
    WHERE organization_id = ${organizationId} AND id = ${id}
    LIMIT 1
  `) as unknown as ScheduledJobRow[];
  return rows[0] ?? null;
}

export async function pauseScheduledJob(
  organizationId: string,
  id: string,
  paused: boolean
): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE scheduled_jobs
    SET paused = ${paused}, updated_at = now()
    WHERE organization_id = ${organizationId} AND id = ${id}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

interface UpdateScheduledJobParams {
  organizationId: string;
  id: string;
  description?: string;
  /** `null` clears the cron (recurring → one-shot); a string sets a new cadence. */
  cron?: string | null;
  /** `null` clears the zone (back to server time); a string sets a new zone. */
  timezone?: string | null;
  /** `null` clears the bound (recur forever); a Date sets/moves it. */
  untilAt?: Date | null;
  /** Reschedule the next firing. */
  runAt?: Date;
  /** Replace the durable action payload (e.g. a new wake_agent prompt). */
  actionArgs?: Record<string, unknown>;
}

/**
 * Patch the mutable fields of a schedule (description / cron / next firing /
 * payload). Attribution, action_type and delivery_context are immutable — a
 * different target or handler is a new schedule, not an edit. Every param is
 * optional; omitted fields keep their current value via COALESCE, except
 * `cron` which is deliberately settable to NULL (recurring → one-shot).
 */
export async function updateScheduledJob(
  params: UpdateScheduledJobParams
): Promise<ScheduledJobRow | null> {
  const sql = getDb();
  const setCron = params.cron !== undefined;
  const setTimezone = params.timezone !== undefined;
  const setUntilAt = params.untilAt !== undefined;
  const rows = (await sql`
    UPDATE scheduled_jobs
    SET
      description = COALESCE(${params.description ?? null}, description),
      cron = CASE WHEN ${setCron} THEN ${params.cron ?? null} ELSE cron END,
      timezone = CASE WHEN ${setTimezone} THEN ${params.timezone ?? null} ELSE timezone END,
      until_at = CASE WHEN ${setUntilAt} THEN ${params.untilAt ?? null} ELSE until_at END,
      next_run_at = COALESCE(${params.runAt ?? null}, next_run_at),
      action_args = COALESCE(${params.actionArgs ? sql.json(params.actionArgs) : null}, action_args),
      updated_at = now()
    WHERE organization_id = ${params.organizationId} AND id = ${params.id}
    RETURNING *
  `) as unknown as ScheduledJobRow[];
  return rows[0] ?? null;
}

export async function deleteScheduledJob(
  organizationId: string,
  id: string
): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    DELETE FROM scheduled_jobs
    WHERE organization_id = ${organizationId} AND id = ${id}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Register the per-minute tick. Call once during bootTaskScheduler.
 *
 * The handler claims due rows transactionally (FOR UPDATE SKIP LOCKED so
 * concurrent pods coordinate without an advisory lock), spawns one task
 * per row, and advances next_run_at. A handler crash leaves rows un-
 * advanced — next minute's tick retries them. Per-row idempotency key
 * `scheduled_job:<id>:<tick-iso>` deduplicates if the same row is read
 * twice across pods.
 */
export function registerScheduledJobsTicker(scheduler: TaskScheduler): void {
  scheduler.register(
    'scheduled-jobs-tick',
    async () => {
      const sql = getDb();
      const claimed = await sql.begin(async (tx) => {
        return (await tx`
          SELECT *
          FROM scheduled_jobs
          WHERE next_run_at <= now() AND NOT paused
          ORDER BY next_run_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 200
        `) as unknown as ScheduledJobRow[];
      });
      if (claimed.length === 0) return;

      for (const row of claimed) {
        const untilAtMs = row.until_at ? new Date(row.until_at).getTime() : null;
        // A due row past its until_at bound retires without firing. Normal
        // advancement never lands next_run_at past until_at (see below), so
        // this is only reachable when an update pushed run_at beyond the
        // bound. Same conditional-advance guard as the paths below.
        if (untilAtMs !== null && new Date(row.next_run_at).getTime() > untilAtMs) {
          await sql`
            UPDATE scheduled_jobs
            SET paused = true, updated_at = now()
            WHERE id = ${row.id} AND next_run_at <= now()
          `;
          continue;
        }
        const tickIso = row.next_run_at;
        const idempotencyKey = `scheduled_job:${row.id}:${tickIso}`;
        let spawnedRunId: number | null = null;
        try {
          const spawnedId = await scheduler.spawn(row.action_type, {
            ...row.action_args,
            __scheduled_job_id: row.id,
            __delivery_context: row.delivery_context,
            __scheduled_job_tick: tickIso,
            __organization_id: row.organization_id,
            __created_by_user: row.created_by_user,
            __created_by_agent: row.created_by_agent,
          }, { idempotencyKey });
          // Record the enqueued run so last_fired_run_id points at the task run
          // (a deduped spawn returns no id; keep the previous value then).
          spawnedRunId = /^\d+$/.test(String(spawnedId ?? '')) ? Number(spawnedId) : null;
        } catch (err) {
          logger.warn(
            { scheduled_job_id: row.id, err: errorMessage(err) },
            '[scheduled-jobs-tick] spawn failed; leaving next_run_at unchanged for retry'
          );
          continue;
        }
        // Advance OR pause-when-done depending on whether this is recurring.
        //
        // The claim transaction (FOR UPDATE SKIP LOCKED) commits when the
        // closure above returns, releasing the row locks BEFORE this advance
        // runs — so SKIP LOCKED gives no cross-pod exclusion during the
        // spawn+advance window. The spawn idempotency key collapses duplicate
        // tasks, but the advance itself must be conditional or two pods reading
        // the same pre-advance `next_run_at` can both write (and clobber a
        // concurrent pause/delete/re-schedule).
        //
        // Guard on `next_run_at <= now()` (same predicate as the claim SELECT),
        // NOT equality against the value we read: postgres.js parses
        // timestamptz to a millisecond-precision JS Date while the column
        // stores microseconds, so an equality round-trip silently never
        // matches for µs-precision rows — leaving them eternally due and
        // re-claimed every tick. `<= now()` is a no-op once any pod has
        // advanced the row (next_run_at is then in the future) and never
        // clobbers an operator re-schedule to a future time.
        const nextAt = row.cron ? nextCronTickAt(row.cron, new Date(), row.timezone) : null;
        // A recurring row whose next occurrence would land past until_at is
        // done: fall through to the one-shot pause path instead of advancing.
        const withinBound =
          nextAt !== null && (untilAtMs === null || new Date(nextAt).getTime() <= untilAtMs);
        if (withinBound) {
          await sql`
            UPDATE scheduled_jobs
            SET last_fired_at = now(), last_fired_run_id = COALESCE(${spawnedRunId}::bigint, last_fired_run_id),
                next_run_at = ${nextAt}, updated_at = now()
            WHERE id = ${row.id} AND next_run_at <= now()
          `;
        } else {
          // One-shot, or recurring past its until_at bound: mark as fired +
          // paused so the index ignores it. Re-pausing is idempotent.
          await sql`
            UPDATE scheduled_jobs
            SET last_fired_at = now(), last_fired_run_id = COALESCE(${spawnedRunId}::bigint, last_fired_run_id),
                paused = true, updated_at = now()
            WHERE id = ${row.id} AND next_run_at <= now()
          `;
        }
      }
    },
    { cron: '* * * * *' }
  );
}
