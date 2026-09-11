/**
 * TaskScheduler boot + periodic platform-internal jobs.
 *
 * Each job is a standalone task with its own cron schedule, durable as a row
 * in `public.runs` (run_type='task'). Cross-pod coordination is the
 * runs-queue claim path — no per-job advisory locks.
 */

import type { Env } from '@lobu/connector-sdk';
import { runAclSyncTick } from '../authz/acl-sync';
import {
  activateWorkspaceEventTask,
} from '../automations/workspace-event';
import type { WorkspaceEventActivationTaskPayload } from '../automations/workspace-event-contract';
import type { CoreServices } from '../gateway/services/core-services';
import { getChatInstanceManager } from '../lobu/gateway';
import { cleanupExpiredMcpSessions } from '../mcp-handler';
import { cleanupExpiredMcpAppResultSnapshots } from '../mcp-app-result-snapshots';
import logger from '../utils/logger';
import { runAutomationTick } from '../automations/automation';
import { runAutomationAutoPauseNotificationSweep } from '../automations/auto-pause-notifications';
import type { AutomationReactionTaskPayload } from '../automations/reaction-enqueue';
import { runAutomationReactionTask } from '../automations/reaction-task';
import type { AutomationScriptTaskPayload } from '../automations/script-enqueue';
import { runAutomationScriptTask } from '../automations/script-task';
import { checkStalledExecutions } from './check-stalled-executions';
import { runConnectorHealthCheck } from '../connectors/connector-health';
import { retryPendingFeedAutoPausedSignals } from '../automations/platform-events';
import { runClassificationReconciliation } from './classification-reconciliation';
import { refreshConnectorDefinitions } from './refresh-connector-definitions';
import {
  isDeliverableChatPlatform,
  registerScheduledJobsTicker,
  type ScheduledDeliveryContext,
  validateDeliveryAuthorization,
} from './scheduled-jobs-service';
import { TaskScheduler } from './task-scheduler';
import {
  AUTOMATION_REACTION_TASK,
  AUTOMATION_SCRIPT_TASK,
  NOTIFICATION_DELIVERY_TASK,
  INTERACTIVE_EVENT_CARD_REFRESH_TASK,
  WORKSPACE_EVENT_ACTIVATION_TASK,
} from './task-definitions';
import { triggerEmbedBackfill } from './trigger-embed-backfill';
import { runMemberClaimDriftCheck } from './member-claim-drift';
import { runReapStaleDeviceWorkers } from './reap-stale-device-workers';
import { runReapExpiredPendingSlackInstalls } from './reap-expired-pending-installs';
import { runExpirePendingApprovals } from './expire-pending-approvals';
import { runScoreEvalRuns } from './score-eval-runs';
import { getDb, pgTextArray } from '../db/client';
import {
  createNotificationForUsers,
  deliverNotificationTask,
  type NotificationDeliveryTaskPayload,
  refreshInteractiveEventCardTask,
  type InteractiveEventCardRefreshTaskPayload,
} from '../notifications/service';
import {
  createThreadForAgent,
  enqueueAgentMessage,
} from '../gateway/services/agent-threads';
import { buildMessagePayload } from '../gateway/services/platform-helpers';
import { migrateLegacyPlaintextAuthData } from '../utils/auth-credential-secrets';
import { refreshDueAtlassianMcpJiraWebhooks } from '../connect/atlassian-mcp-webhook';

function asDeliveryContext(value: unknown): ScheduledDeliveryContext | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ScheduledDeliveryContext>;
  if (
    typeof candidate.platform !== 'string' ||
    typeof candidate.conversationId !== 'string' ||
    typeof candidate.channelId !== 'string' ||
    typeof candidate.connectionId !== 'string'
  ) {
    return null;
  }
  return {
    platform: candidate.platform,
    conversationId: candidate.conversationId,
    channelId: candidate.channelId,
    teamId: typeof candidate.teamId === 'string' ? candidate.teamId : null,
    connectionId: candidate.connectionId,
    userId: typeof candidate.userId === 'string' ? candidate.userId : null,
  };
}


/**
 * Construct the TaskScheduler, register every periodic task, start dispatch,
 * and wire the lazy at-use-time refresh hooks into AuthProfilesManager.
 * Single call site for both `server.ts` (prod) and `embedded-runtime.ts` (embedded Postgres).
 */
export async function bootTaskScheduler(
  coreServices: CoreServices,
  env: Env,
): Promise<TaskScheduler> {
  const scheduler = new TaskScheduler(coreServices.getQueue());

  registerMaintenanceTasks(scheduler, env, coreServices);
  await scheduler.start();

  // AuthProfilesManager.ensureFreshCredential is a no-op until these hooks
  // are wired; during the brief startup window before scheduler.start()
  // returns, the periodic safety-net is the only refresh path.
  const authProfilesManager = coreServices.getAuthProfilesManager();
  if (authProfilesManager) {
    authProfilesManager.setLazyRefreshHooks({
      triggerAsync: async (userId, agentId) => {
        await scheduler.spawn(
          'refresh-token-for-user-agent',
          { userId, agentId },
          { idempotencyKey: `refresh-token:${userId}:${agentId}` },
        );
      },
      refreshNow: (userId, agentId) =>
        coreServices.getTokenRefreshJob().refreshForUserAgent(userId, agentId),
    });
  }

  return scheduler;
}

function registerMaintenanceTasks(
  scheduler: TaskScheduler,
  env: Env,
  coreServices: CoreServices,
): void {
  // OAuth token refresh — periodic safety-net at 30min intervals. The hot path
  // is at-use-time lazy refresh in AuthProfilesManager.ensureFreshCredential,
  // which spawns `refresh-token-for-user-agent` per-user when a soon-expiring
  // token is read. This periodic scan only catches users who haven't accessed
  // the system in a while.
  scheduler.register(
    'token-refresh',
    () => coreServices.getTokenRefreshJob().runOnce(),
    { cron: '*/30 * * * *' },
  );

  // Lazy refresh handler — spawned by AuthProfilesManager when a soon-expiring
  // OAuth token is read. Idempotency-keyed by (userId, agentId) so concurrent
  // reads collapse to one refresh.
  scheduler.register('refresh-token-for-user-agent', async (ctx) => {
    const { userId, agentId } = ctx.payload as {
      userId: string;
      agentId: string;
    };
    if (!userId || !agentId) {
      logger.warn(
        { payload: ctx.payload },
        '[task] refresh-token-for-user-agent missing userId/agentId',
      );
      return;
    }
    await coreServices.getTokenRefreshJob().refreshForUserAgent(userId, agentId);
  });

  // MCP session cleanup — drops expired session rows from the DB. Lives here
  // (cross-pod-coordinated) instead of as an mcp-handler module-level
  // setInterval. The IN-MEMORY part stays per-pod (see mcp-handler.ts).
  scheduler.register(
    'mcp-session-cleanup',
    () => cleanupExpiredMcpSessions(),
    { cron: '*/10 * * * *' },
  );

  scheduler.register(
    'mcp-app-result-snapshot-cleanup',
    async () => {
      const deleted = await cleanupExpiredMcpAppResultSnapshots();
      if (deleted > 0) {
        logger.info({ deleted }, '[task] expired MCP App result snapshots deleted');
      }
    },
    { cron: '23 */6 * * *' },
  );

  // Jira dynamic webhooks expire after 30 days. Refresh each separately
  // authorized Atlassian MCP subscription before its provider expiry.
  scheduler.register(
    'atlassian-mcp-webhook-refresh',
    async () => {
      const result = await refreshDueAtlassianMcpJiraWebhooks();
      if (result.refreshed > 0 || result.errors > 0) {
        logger.info({ ...result }, '[task] Atlassian MCP webhook refresh swept');
      }
    },
    { cron: '17 */6 * * *' },
  );

  // Hygiene sweep — drops expired rows from oauth_states, rate_limits,
  // grants, and archives completed runs.
  scheduler.register(
    'sweep-ephemeral-tables',
    () => coreServices.sweepEphemeralTables(),
    { cron: '*/5 * * * *' },
  );

  scheduler.register(
    'check-stalled-executions',
    async () => {
      await checkStalledExecutions(env);
      logger.info('[task] check-stalled-executions completed');
    },
    { cron: '*/5 * * * *' },
  );

  scheduler.register(
    'trigger-embed-backfill',
    async () => {
      const result = await triggerEmbedBackfill(env);
      if (result.runsCreated > 0) {
        logger.info({ ...result }, '[task] trigger-embed-backfill enqueued runs');
      }
    },
    { cron: '*/5 * * * *' },
  );

  // Connection health — keeps connections.status honest now that boot
  // no longer warm-starts (and status-marks) every connection on every pod.
  // One claimant per tick validates config rejections + secret-ref
  // resolution; instances themselves hydrate lazily on use.
  scheduler.register(
    'connection-health',
    async () => {
      const manager = getChatInstanceManager();
      if (!manager) return;
      const result = await manager.sweepConnectionHealth();
      if (result.errored > 0 || result.recovered > 0) {
        logger.info({ ...result }, '[task] connection-health swept');
      }
    },
    { cron: '*/5 * * * *' },
  );

  // ACL sync — re-materializes every registered source's `member_of` graph (the
  // authz read-gates' source of truth) from live membership: Slack channels via
  // `conversations.members`, GitHub repos via collaborators. Joins/leaves
  // converge within the cadence and the gate's freshness window keeps a stalled
  // connection fail-closed. Single-claimant per tick via the runs-queue. No-ops
  // on zero connections per source.
  scheduler.register(
    'authz-acl-sync',
    async () => {
      await runAclSyncTick(coreServices);
    },
    { cron: '*/15 * * * *' },
  );

  // Connector health alerter — surfaces connectors that have silently died
  // (every feed failing, an active connection collecting nothing, or a feed
  // that stopped syncing for days) which per-feed auto-pause alone can't catch
  // (it only fires when a worker actually runs). Single-claimant per tick;
  // alerts fire on the transition into unhealthy via a Postgres-mediated marker
  // (connections.unhealthy_alerted_at), and ride the existing pino→Sentry→Slack
  // path — no new alerting infra.
  //
  // Also redelivers feed.auto_paused signals if activation was lost after a
  // hard pause (idempotent delivery_id). Remediation Automations come from the
  // Automation catalog — not auto-created automations.
  scheduler.register(
    'connector-health-alert',
    async () => {
      const result = await runConnectorHealthCheck();
      if (result.newlyAlerted > 0 || result.recovered > 0) {
        logger.info(
          {
            scanned: result.scanned,
            unhealthy: result.unhealthy,
            newly_alerted: result.newlyAlerted,
            recovered: result.recovered,
          },
          '[task] connector-health-alert swept'
        );
      }

      try {
        const retry = await retryPendingFeedAutoPausedSignals({ limit: 50 });
        if (retry.attempted > 0 || retry.errors > 0) {
          logger.info(
            {
              scanned: retry.scanned,
              attempted: retry.attempted,
              errors: retry.errors,
            },
            '[task] feed.auto_paused redelivery tick'
          );
        }
      } catch (err) {
        logger.warn({ err }, '[task] feed.auto_paused redelivery failed');
      }
    },
    { cron: '*/15 * * * *' }
  );

  scheduler.register(
    'automation-auto-pause-notifications',
    async () => {
      const result = await runAutomationAutoPauseNotificationSweep();
      if (result.attempted > 0 || result.errors > 0) {
        logger.info(
          { ...result },
          '[task] automation-auto-pause-notifications swept'
        );
      }
    },
    { cron: '*/5 * * * *' },
  );

  // Read-only detector for members whose trusted $member claim is missing or
  // blocked by another live claim. Cron dispatch is single-claimant per tick.
  scheduler.register(
    'member-claim-drift',
    async () => {
      const result = await runMemberClaimDriftCheck();
      if (result.missingClaim > 0 || result.poisonClaim > 0) {
        logger.error(
          { ...result },
          '[task] member-claim-drift found members without a resolvable $member claim',
        );
      }
    },
    { cron: '0 * * * *' },
  );

  scheduler.register(
    'classification-reconciliation',
    async () => {
      const result = await runClassificationReconciliation(env);
      logger.info({ ...result }, '[task] classification-reconciliation completed');
    },
    { cron: '*/5 * * * *' },
  );

  // Connector-definition refresh — re-syncs every org's existing built-in
  // connector definition from the on-disk registry, so code-side schema changes
  // (e.g. github gaining the app_installation auth method) reach orgs that
  // installed the connector before the change. Idempotent; preserves org config
  // (login_enabled / default_connection_config). Single-claimant per tick. The
  // first tick after a deploy converges the fleet without an operator step;
  // hourly thereafter is plenty since it only matters across releases.
  scheduler.register(
    'refresh-connector-definitions',
    async () => {
      const result = await refreshConnectorDefinitions();
      if (result.refreshed > 0 || result.errored > 0) {
        logger.info({ ...result }, '[task] refresh-connector-definitions completed');
      }
    },
    { cron: '0 * * * *' },
  );

  // Credential-at-rest convergence — rewrites any `env` auth profile still
  // holding a PLAINTEXT credential (e.g. a postgres DSN, which embeds its own
  // password) into an encrypted `secret://` ref. Encryption cannot happen in a
  // SQL migration, so the conversion runs here instead. Idempotent: a profile
  // already holding refs is skipped, so this is a no-op after the first pass.
  // Single-claimant per tick; pure Postgres, so multi-replica safe.
  scheduler.register(
    'converge-auth-credential-secrets',
    async () => {
      const converted = await migrateLegacyPlaintextAuthData();
      if (converted > 0) {
        logger.info({ converted }, '[task] converge-auth-credential-secrets converted profiles');
      }
    },
    { cron: '*/10 * * * *' },
  );

  // Stale device-worker reaper — deletes device_workers rows that are unseen
  // for 30+ days AND have no pinned connections/automations/auth-profiles. Safety
  // net for orphaning that identity-reuse-at-mint can't cover (extension
  // uninstall, "clear extension data", abandoned second machine): those rows
  // have no live credential anywhere, so they're dead and only clutter the
  // Devices page. Single-claimant per tick; pure Postgres (multi-replica safe).
  // Daily is plenty — these rows are already a month stale.
  scheduler.register(
    'reap-stale-device-workers',
    async () => {
      await runReapStaleDeviceWorkers();
    },
    { cron: '0 3 * * *' },
  );

  // Expired unclaimed-Slack-install reaper — deletes org-less `pending`
  // app_installations rows older than 7 days (a marketplace / "Add to Slack"
  // install the installer never claimed) after best-effort revoking the bot
  // token, so an abandoned workspace doesn't leave a live credential lying
  // around. Tightly scoped to pending slack rows; never touches active/claimed
  // installs. Single-claimant per tick; pure Postgres (multi-replica safe).
  // Daily, off-peak, distinct minute from the device-worker reaper.
  scheduler.register(
    'reap-expired-pending-installs',
    async () => {
      await runReapExpiredPendingSlackInstalls();
    },
    { cron: '17 3 * * *' },
  );

  // Long-horizon pending-approval expiry: the counterpart to the short-horizon
  // claim reaper, which exempts approval-pending rows on purpose (#2044) and so
  // never resolves them. Rationale + fairness/draining details live in
  // scheduled/expire-pending-approvals.ts. Daily, off-peak, distinct minute from
  // the other two reapers.
  scheduler.register(
    'expire-pending-approvals',
    async () => {
      await runExpirePendingApprovals();
    },
    { cron: '31 3 * * *' },
  );

  // Eval scorer queue: score terminal `automation_eval` replays that have no
  // score events yet. The anti-join predicate IS the claim (rationale in
  // scheduled/score-eval-runs.ts) — no cursor, no in-memory sampler, safe under
  // N>1 replicas.
  //
  // Every 5 minutes, not daily: an eval batch is something a human kicked off
  // and is waiting on, so a day-long lag would make the feature feel broken.
  // The batch cap bounds each tick's judge spend, and a backlog drains across
  // ticks.
  //
  // No judge model is passed, so the judge runs on the ORG DEFAULT — which may
  // be the model that produced the output, leaving self-preference bias
  // unmitigated. Where the judge model is configured is still open in the spec
  // (lobu#2564); `runScoreEvalRuns` takes `judgeModelRef`, so wiring the answer
  // is one argument.
  scheduler.register(
    'score-eval-runs',
    async () => {
      const summary = await runScoreEvalRuns();
      if (summary.claimed > 0) {
        logger.info(summary, '[task] score-eval-runs completed');
      }
    },
    { cron: '*/5 * * * *' },
  );

  // Automation tick: reconcile in-flight runs, materialize newly-due runs,
  // dispatch pending runs. The orphaned-runs reset is bounded and idempotent
  // so it runs every tick — no per-pod first-tick latch needed.
  //
  // Each phase is isolated: a throw in one (e.g. the `malformed array literal`
  // bug that wedged reconcile, lobu#1046) must NOT abort the later phases —
  // otherwise a single fault stops materialize+dispatch and no automation fires.
  scheduler.register(
    'automation',
    async () => {
      const { errors, ...summary } = await runAutomationTick(env);
      logger.info(
        { ...summary, ...(errors.length > 0 ? { errors } : {}) },
        '[task] automation completed',
      );
    },
    { cron: '* * * * *' },
  );

  // An Automation output event and this task row commit together. The handler
  // performs subscriber lookup and takes downstream per-Automation locks only
  // after the producer's window transaction has released its own resources.
  scheduler.register(WORKSPACE_EVENT_ACTIVATION_TASK, async (ctx) => {
    const result = await activateWorkspaceEventTask(
      ctx.payload as WorkspaceEventActivationTaskPayload,
    );
    if (
      result.matched > 0 ||
      result.depthLimited ||
      result.causalBreadthLimited ||
      result.fanoutLimited ||
      result.invalidCausalPath
    ) {
      logger.info(result, '[task] activate-workspace-event completed');
    }
  });

  scheduler.register(INTERACTIVE_EVENT_CARD_REFRESH_TASK, async (ctx) => {
    await refreshInteractiveEventCardTask(
      ctx.payload as InteractiveEventCardRefreshTaskPayload,
    );
  });

  // Executor scripts own the parent Automation run, so the child task carries
  // the durable handoff that resumes it after a scheduler restart.
  scheduler.register(AUTOMATION_SCRIPT_TASK, async (ctx) => {
    await runAutomationScriptTask(ctx.payload as AutomationScriptTaskPayload, env, ctx.taskRunId, ctx.attempt);
  });

  // The Automation reaction script. Queued inside `complete_window`'s window
  // transaction, so the handoff survives a crash that would previously have
  // lost the reaction outright. The handler throws only on a TRANSIENT script
  // failure — that is what asks this scheduler for another attempt; a
  // deterministic failure settles the task and is recorded on
  // `automation_reactions` instead of re-burning the 60s executor budget.
  scheduler.register(AUTOMATION_REACTION_TASK, async (ctx) => {
    const outcome = await runAutomationReactionTask(
      ctx.payload as AutomationReactionTaskPayload,
      env,
      ctx.taskRunId,
      ctx.attempt,
    );
    if (outcome.status !== 'success') {
      logger.info(
        { ...outcome, payload: ctx.payload },
        '[task] automation-reaction settled',
      );
    }
  });

  scheduler.register(NOTIFICATION_DELIVERY_TASK, async (ctx) => {
    await deliverNotificationTask(
      ctx.payload as NotificationDeliveryTaskPayload,
    );
  });

  // scheduled_jobs ticker: scans the table every minute, spawns due rows
  // as task runs via this same scheduler. The actual firing handlers are
  // registered below so spawn() can find them.
  registerScheduledJobsTicker(scheduler);

  // Handler: send_notification. Payload mirrors the notify-tool shape;
  // resolves recipients to user_ids and inserts events + notification_targets.
  scheduler.register('send_notification', async (ctx) => {
    const sql = getDb();
    const p = ctx.payload as {
      __organization_id?: string;
      organization_id?: string;
      recipients?: string[] | 'admins' | 'all';
      type?: string;
      title?: string;
      body?: string | null;
      resource_url?: string | null;
    };
    const orgId = p.__organization_id ?? p.organization_id;
    const title = p.title;
    if (!orgId || !title) {
      logger.warn({ payload: ctx.payload }, '[task] send_notification missing org or title');
      return;
    }
    const recipients = p.recipients ?? 'admins';
    let userIds: string[];
    if (Array.isArray(recipients)) {
      const rows = await sql<{ userId: string }>`
        SELECT "userId" FROM "member"
        WHERE "organizationId" = ${orgId}
          AND "userId" = ANY(${pgTextArray(recipients)}::text[])
      `;
      userIds = rows.map((r) => r.userId);
    } else if (recipients === 'all') {
      const rows = await sql<{ userId: string }>`
        SELECT "userId" FROM "member"
        WHERE "organizationId" = ${orgId}
      `;
      userIds = rows.map((r) => r.userId);
    } else {
      const rows = await sql<{ userId: string }>`
        SELECT "userId" FROM "member"
        WHERE "organizationId" = ${orgId} AND role IN ('admin', 'owner')
      `;
      userIds = rows.map((r) => r.userId);
    }
    if (userIds.length === 0) return;
    await createNotificationForUsers(userIds, {
      organizationId: orgId,
      type: (p.type as 'agent_message') ?? 'agent_message',
      title,
      body: p.body ?? null,
      resourceUrl: p.resource_url ?? null,
    });
  });

  // Handler: wake_agent. Creates a thread for the agent (or reuses one
  // supplied by the caller) and enqueues the prompt as a user message.
  // Lets an agent schedule its own follow-up wake-ups via manage_schedules.
  scheduler.register('wake_agent', (ctx) =>
    runWakeAgentTask(coreServices, ctx.payload as WakeAgentTaskPayload)
  );
}

export interface WakeAgentTaskPayload {
  __organization_id?: string;
  __created_by_user?: string | null;
  __created_by_agent?: string | null;
  __scheduled_job_id?: string;
  __delivery_context?: unknown;
  organization_id?: string;
  agent_id?: string;
  prompt?: string;
  thread_id?: string | null;
  reason?: string | null;
  /**
   * Optional per-schedule model override (a `provider/model` ref or "auto").
   * Injected into agentOptions.model at dispatch so the layered fallback
   * (automation → agent → org default) resolves it as the winning override.
   */
  model?: string | null;
}

/**
 * Execute a `wake_agent` scheduled task: post the agent's reply back into the
 * originating chat channel when the ticker injected a trusted delivery context,
 * otherwise dispatch the unchanged api-platform message. Exported so the
 * fire-time delivery dispatch can be driven end-to-end in tests (the
 * registration above is a thin adapter over it).
 */
export async function runWakeAgentTask(
  coreServices: CoreServices,
  p: WakeAgentTaskPayload
): Promise<void> {
  const sql = getDb();
  const orgId = p.__organization_id ?? p.organization_id;
  if (!orgId || !p.agent_id || !p.prompt) {
    logger.warn({ payload: p }, '[task] wake_agent missing org/agent/prompt');
    return;
  }
  // Target-agent existence check. The cascade FK on scheduled_jobs only
  // covers `created_by_agent` (the *scheduler*'s identity), not the
  // *target* of a wake_agent action. If a user scheduled a wake for
  // agent X and X was deleted, we'd silently enqueue a message for a
  // ghost — so verify the target exists and auto-pause the schedule
  // when it doesn't.
  const agentRows = (await sql`
    SELECT id FROM agents
    WHERE organization_id = ${orgId} AND id = ${p.agent_id}
    LIMIT 1
  `) as unknown as Array<{ id: string }>;
  if (agentRows.length === 0) {
    logger.warn(
      { scheduled_job_id: p.__scheduled_job_id, agent_id: p.agent_id },
      '[task] wake_agent target agent no longer exists; pausing schedule'
    );
    if (p.__scheduled_job_id) {
      await sql`UPDATE scheduled_jobs SET paused = true, updated_at = now() WHERE id = ${p.__scheduled_job_id}`;
    }
    return;
  }
  const sessionManager = coreServices.getSessionManager();
  const queueProducer = coreServices.getQueueProducer();

  // Per-schedule model override (a `provider/model` ref or "auto"). Injected
  // into agentOptions.model on both dispatch paths so `resolveAgentOptions`
  // treats it as the winning override in the layered fallback.
  const automationModel =
    typeof p.model === 'string' && p.model.trim() ? p.model.trim() : undefined;

  // When the schedule carries trusted gateway-owned delivery context, dispatch
  // a real platform message so the reply posts back into the originating chat
  // channel. User action_args never supply this value; the ticker injects it
  // from scheduled_jobs.delivery_context.
  const delivery = asDeliveryContext(p.__delivery_context);
  if (
    delivery &&
    isDeliverableChatPlatform(delivery.platform) &&
    (
      await validateDeliveryAuthorization({
        organizationId: orgId,
        agentId: p.agent_id,
        delivery,
      })
    ).authorized
  ) {
    await queueProducer.enqueueMessage(
      buildMessagePayload({
        platform: delivery.platform,
        userId: delivery.userId || p.__created_by_user || 'scheduled',
        botId: delivery.platform,
        conversationId: delivery.conversationId,
        teamId: delivery.teamId ?? undefined,
        agentId: p.agent_id,
        organizationId: orgId,
        messageId: `wake_${p.__scheduled_job_id ?? p.agent_id}_${Date.now()}`,
        messageText: p.prompt,
        channelId: delivery.channelId,
        platformMetadata: {
          agentId: p.agent_id,
          chatId: delivery.channelId,
          senderId: delivery.userId || undefined,
          teamId: delivery.teamId || undefined,
          connectionId: delivery.connectionId,
          responseChannel: delivery.channelId,
          organizationId: orgId,
          source: 'scheduled-job',
        },
        agentOptions: automationModel ? { model: automationModel } : {},
      })
    );
    return;
  }

  let threadId = p.thread_id ?? null;
  if (!threadId) {
    const result = await createThreadForAgent(
      { sessionManager },
      {
        agentId: p.agent_id,
        organizationId: orgId,
        // The ticker injects the scheduling user under the `__` prefix
        // so handler payloads can mix scheduler-controlled metadata with
        // user-supplied action_args without collision. Reading from
        // p.__created_by_user keeps the wake-up's thread / message
        // attribution pointing at whoever scheduled it (not the agent
        // itself, which would obscure the audit trail).
        createdByUserId: p.__created_by_user ?? undefined,
        reason: p.reason ?? 'scheduled-wake',
      }
    );
    threadId = result.threadId;
  }
  await enqueueAgentMessage(
    { sessionManager, queueProducer },
    {
      threadId,
      messageText: p.prompt,
      source: 'scheduled-job',
      model: automationModel,
    }
  );
}
