/**
 * POST /api/workers/poll
 *
 * Worker polls for the next available run. Handles device registration/upsert,
 * platform binding, capability authorization, and multi-lane run claiming.
 */

import {
  authorizeCapabilities,
  entryToMessage,
  isKnownPlatform,
  parseSessionEntries,
} from '@lobu/core';
import { Value } from '@sinclair/typebox/value';
import {
  PollRequestSchema,
  defaultBackendCapacity,
  type PollRequest,
} from '@lobu/core/contracts/worker/protocol';
import type { Context } from 'hono';
import {
  automationTriggerSignals,
  isWorkspaceEventTriggerSignal,
} from '../automations/workspace-event-contract';
import {
  buildDispatchMessage,
  ensureAutomationAgentExists,
  parseAutomationRunPayload,
} from '../automations/automation';
import {
  buildAutomationRunWorkerAccess,
  buildDeviceChatRunWorkerAccess,
} from '../gateway/services/run-worker-access';
import {
  readSnapshotJsonl,
  transcriptText,
} from '../gateway/services/transcript-snapshot';
import { resolvePublicOrigin } from '../utils/public-origin';
import { getDb, parsePgTextArray, pgTextArray } from '../db/client';
import type { Outputs } from '../types/automations';
import { deriveAutomationExtractionSchema } from '../utils/automation-extraction-schema';
import { withDbRetry } from '../db/with-retry';
import { incrementCounter, setGauge } from '../gateway/metrics/prometheus';
import {
  insertThreadResponseRow,
  notifyThreadResponse,
} from '../gateway/orchestration/turn-liveness';
import type { Env } from '../index';
import { supportsExactPageActivation } from '../runs/page-activation';
import { claimPendingAutomationRun } from '../runs/queue-service';
import { parseAutomationSkillSnapshots } from '../automations/skill-snapshots';
import {
  type MaterializedDueFeedRun,
  materializeDueFeeds,
} from '../scheduled/check-due-feeds';
import { reconcileDeviceCapabilities } from './device-reconcile';
import { findBundledConnectorFile } from '../utils/connector-catalog';
import { resolveConnectorCode } from '../utils/ensure-connector-installed';
import { resolveDeviceClaimableOrgs } from '../utils/device-claimable-orgs';
import { errorMessage } from '../utils/errors';
import { resolveAuthCredentials } from '../utils/auth-credential-secrets';
import { mergeExecutionConfig, resolveExecutionAuth } from '../utils/execution-context';
import { stripServerOnlyExecutionConfig } from '../tools/admin/automation-execution-config';
import { supersedeActionEvent } from '../tools/admin/approval-events';
import logger from '../utils/logger';
import { selectedConnectorVersionArtifactSql } from '../utils/connector-execution-placement';
import { recordLifecycleEvent } from '../utils/insert-event';
import { isCloudMode } from '../utils/cloud-mode';
import { normalizeAdvertisedCapabilities, normalizeAgentKinds } from './shared';
import {
  storedManifestMap,
  validateDeviceConnectorManifests,
  type ManifestClaimAuthorization,
} from './device-manifests';
import type { RunOutcome } from '../runs/run-outcome';
import {
  type ConnectorClaimContext,
  connectorClaimLaneSql,
} from './connector-claim-lanes';
import {
  browserActionContextFromMetadata,
  runScopedBrowserActionContext,
  standaloneBrowserActionContext,
  trustedChromeActionInput,
} from './browser-action-context';
import { runLeaseFence } from '../runs/run-lease';
import { insertAgentTurnResponse, agentTurnClaimEligible, agentTurnLockKey, lockAgentTurnRun, nativeSessionBase, releaseNextAgentTurn } from '../runs/agent-turn-inputs';

// A failure at the DISPATCH stage means the agent never ran: the run is not
// evidence about the agent regardless of the message, so no message
// classification applies.
const DISPATCH_FAILURE_OUTCOME: RunOutcome = 'infra_error';
const DEVICE_CHAT_HISTORY_TAIL_CHARS = 1024 * 1024;
const DEVICE_CHAT_DISPATCH_ERROR =
  'The selected device could not start this message.';

const DUE_FEEDS_LOCK_KEY = 71001;

/**
 * Fail a run that this worker already claimed. Approval-gated actions also
 * have a durable card, so the run failure and failed-card supersede share one
 * short transaction. Other worker lanes have no approval card and retain the
 * existing single-row terminal transition.
 */
export async function failClaimedWorkerRun(params: {
  runId: number;
  workerId: string;
  errorMessage: string;
}): Promise<boolean> {
  const sql = getDb();
  let delivered = false;
  const transitioned = await sql.begin(async (tx) => {
    const nativeRun = await lockAgentTurnRun(tx, params.runId, true);
    const rows = await tx<{
      organization_id: string;
      run_type: string;
      approval_status: string;
      action_key: string | null;
    }>`
      UPDATE runs
      SET status = ${nativeRun?.run_metadata?.cancel_requested_at ? 'cancelled' : 'failed'},
          outcome = ${nativeRun?.run_metadata?.cancel_requested_at ? null : DISPATCH_FAILURE_OUTCOME},
          completed_at = current_timestamp,
          error_message = ${params.errorMessage}
      WHERE id = ${params.runId}
        ${runLeaseFence(tx, params.workerId)}
      RETURNING organization_id, run_type, approval_status, action_key
    `;
    if (rows.length === 0) return false;

    if (nativeRun) {
      await releaseNextAgentTurn(tx, nativeRun);
      delivered = await insertAgentTurnResponse(tx, nativeRun, {
        error: nativeRun.run_metadata?.cancel_requested_at ? 'agent turn cancelled' : params.errorMessage,
      });
    }
    const row = rows[0];
    if (row.run_type === 'action' && row.approval_status === 'approved') {
      const actionKey = row.action_key ?? 'Action';
      const eventId = await supersedeActionEvent(
        params.runId,
        row.organization_id,
        'failed',
        `${actionKey} — failed`,
        `Action failed before worker dispatch: ${actionKey} — ${params.errorMessage}`,
        { error_message: params.errorMessage },
        null,
        tx
      );
      if (eventId === undefined) {
        throw new Error(
          `Cannot fail approval run ${params.runId}: its approval card is missing`
        );
      }
    }
    return true;
  });
  if (delivered) await notifyThreadResponse();
  return transitioned;
}

/** Fail a claimed device-chat dispatch and emit its visible terminal response atomically. */
async function failClaimedDeviceChatRun(params: {
  runId: number;
  workerId: string;
  errorMessage: string;
  message: Record<string, unknown> | null;
  organizationId: string;
}): Promise<boolean> {
  const messageId =
    typeof params.message?.messageId === 'string'
      ? params.message.messageId
      : '';
  if (!messageId) {
    return failClaimedWorkerRun({
      runId: params.runId,
      workerId: params.workerId,
      errorMessage: params.errorMessage,
    });
  }

  const sql = getDb();
  const transitioned = await sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE public.runs
      SET status = 'failed',
          outcome = ${DISPATCH_FAILURE_OUTCOME},
          completed_at = current_timestamp,
          error_message = ${params.errorMessage}
      WHERE id = ${params.runId}
        ${runLeaseFence(tx, params.workerId)}
        AND run_type = 'chat_message'
        AND queue_name = 'messages'
      RETURNING id
    `;
    if (rows.length === 0) return false;

    const stringField = (key: string): string | undefined => {
      const value = params.message?.[key];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };
    const platformMetadata = params.message?.platformMetadata;
    await insertThreadResponseRow(
      tx,
      {
        messageId,
        channelId: stringField('channelId'),
        conversationId: stringField('conversationId'),
        userId: stringField('userId'),
        teamId: stringField('teamId') ?? 'api',
        platform: stringField('platform') ?? 'api',
        organizationId: params.organizationId,
        platformMetadata:
          platformMetadata &&
          typeof platformMetadata === 'object' &&
          !Array.isArray(platformMetadata)
            ? platformMetadata
            : undefined,
        error: DEVICE_CHAT_DISPATCH_ERROR,
        processedMessageIds: [messageId],
        timestamp: Date.now(),
      },
      params.organizationId
    );
    return true;
  });
  if (transitioned) await notifyThreadResponse();
  return transitioned;
}

/** jsonb columns arrive as objects, text columns as JSON strings — normalize to an object or null. */
function parseClaimJson(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Device executors do not use the server-side worker filesystem, so compose the
 * same frozen snapshots into their per-run task at dispatch time. This does not
 * mutate or conflate the stored fields: `prompt` remains the author's task
 * statement and `skills` remain individually diffable on the version.
 */
function formatDeviceAutomationInstructions(
  prompt: string | null,
  rawSkills: unknown
): string | null {
  const skills = parseAutomationSkillSnapshots(rawSkills);
  if (skills.length === 0) return prompt;
  const skillSections = skills.map(
    (skill) => `### ${skill.name}\n\n${skill.content}`
  );
  return [
    ...(prompt?.trim() ? [prompt] : []),
    '## Pinned Automation skills',
    'These frozen skills are part of this Automation version. Follow every one when performing the task.',
    ...skillSections,
  ].join('\n\n');
}

/**
 * POST /api/workers/poll
 *
 * Worker polls for next available sync run.
 * Returns run details or empty response if no runs available.
 */
export async function pollWorkerJob(c: Context<{ Bindings: Env }>) {
  let worker_id: string;
  let capabilities: Record<string, boolean> = {};
  let platform: string | null = null;
  let app_version: string | null = null;
  let label: string | null = null;
  let capacityAvailable: number | null = null;
  let backendCapacity: Record<string, number> = {};
  let backendCapacityProvided = false;
  let connectorManifestsProvided = false;
  let connectorManifestsRaw: unknown;
  // Agent CLIs this device can spawn. `null` is NOT the same as `[]`: null means
  // the client never told us (today that is every client except the
  // connector-worker daemon — the Mac app, the Chrome bridge, older daemons)
  // and must stay as claimable as it is today, while `[]` means it told us and
  // can run nothing.
  let agentKinds: string[] | null = null;
  try {
    const rawBody = await c.req.json<unknown>();
    if (!Value.Check(PollRequestSchema, rawBody)) {
      const first = Value.Errors(PollRequestSchema, rawBody).First();
      return c.json(
        {
          error: first
            ? `${first.path || '(root)'} ${first.message}`.trim()
            : 'Invalid request body',
        },
        400
      );
    }
    const body = rawBody as PollRequest;
    worker_id = body.worker_id;
    capabilities = body.capabilities ?? {};
    platform = body.platform ?? null;
    app_version = body.app_version ?? null;
    label = body.label ?? null;
    capacityAvailable = body.capacity_available ?? null;
    backendCapacity = body.backend_capacity ?? {};
    backendCapacityProvided = Object.hasOwn(body, 'backend_capacity');
    connectorManifestsProvided = Object.hasOwn(body, 'connector_manifests');
    connectorManifestsRaw = body.connector_manifests;
    agentKinds = normalizeAgentKinds(body.agent_kinds);
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }

  // postgres.js renders a bound JS array as a bare comma list, which Postgres
  // rejects for text[]; the repo's array params go through pgTextArray. NULL
  // must stay NULL — that's the "never advertised" case the lane keys on.
  const agentKindsParam = agentKinds === null ? null : pgTextArray(agentKinds);
  const sql = getDb();
  // Capability set the worker advertised, used to filter on
  // connector_definitions.required_capability.
  const advertisedCapabilities = normalizeAdvertisedCapabilities(capabilities);
  // Trusted fleet workers (WORKER_API_TOKEN) run the no-capability cloud
  // connectors too, so '' (a NULL required_capability becomes '' via COALESCE
  // below) belongs in their match set. User-scoped workers — the Lobu Mac
  // Bridge, anything in `workerAuthMode === 'user'` — are *device* workers:
  // they may ONLY claim runs whose connector declares a `required_capability`
  // they advertise, never the embedded-server connectors. So '' is excluded for them,
  // which means a bridge with no granted capabilities claims *nothing* instead
  // of hijacking-and-failing arbitrary embedded-server connector runs (e.g. hackernews).
  // Local/personal-install fallback. When WORKER_API_TOKEN is unset, a device
  // worker whose token fails auth doesn't 401 — the /api/workers/* middleware
  // degrades it to `anonymous` (workerUserId = null), which previously skipped
  // the device_workers upsert + reconcileDeviceCapabilities below, so device
  // connectors (Screen Time, Photos, …) silently never wired up. In a non-cloud
  // install, re-anchor an anonymous poll to the user that already owns this
  // worker_id and treat it as a device worker END-TO-END (platform binding,
  // capability allowlist, org-scoped claims, registration) — not as a
  // trusted/anonymous fleet worker. Cloud (LOBU_CLOUD_MODE) stays strict: a poll
  // must carry a user-scoped token, so a known worker_id can't be spoofed across
  // tenants.
  let anonLocalUserId: string | null = null;
  let anonLocalOrgId: string | null = null;
  if (c.var.workerAuthMode === 'anonymous' && worker_id && !isCloudMode()) {
    const owner = (await sql`
      SELECT user_id, organization_id FROM device_workers
      WHERE worker_id = ${worker_id} LIMIT 1
    `) as unknown as Array<{ user_id: string; organization_id: string | null }>;
    if (owner.length > 0) {
      anonLocalUserId = owner[0].user_id;
      anonLocalOrgId = owner[0].organization_id;
      logger.info(
        { worker_id, user_id: anonLocalUserId },
        '[pollWorkerJob] local (non-cloud) anonymous device poll → treating as device worker for existing owner'
      );
    }
  }
  // A re-anchored local poll is a device (user-scoped) worker for every check
  // below, so platform binding / capability authorization / org-scoped claiming
  // all apply exactly as for a signed-in device.
  const isUserScopedWorker = c.var.workerAuthMode === 'user' || anonLocalUserId != null;
  // Effective device identity: the token's user/org when user-scoped, else the
  // re-anchored local owner.
  const effectiveWorkerUserId = c.var.workerUserId ?? anonLocalUserId;
  const effectiveWorkerOrgIds = c.var.workerOrgIds ?? (anonLocalOrgId ? [anonLocalOrgId] : null);
  const effectiveTokenOrgId = c.var.organizationId ?? anonLocalOrgId;
  // User-scoped (device) callers must post a non-empty worker_id. An empty
  // or missing id would otherwise let a bound PAT (see below) sidestep the
  // binding check by claiming all worker rows under `(user_id, "")`.
  if (isUserScopedWorker && (!worker_id || worker_id.length === 0)) {
    return c.json({ error: 'worker_id is required' }, 400);
  }
  // Worker-id binding: when the caller's PAT was minted via
  // /api/me/devices/mint-child-token, its row in personal_access_tokens
  // carries a non-NULL `worker_id`. The poll body must use the same id —
  // otherwise the caller could escape platform binding by registering
  // arbitrary fresh worker_ids and picking their own platform on each.
  // Comparing unconditionally (not `&& worker_id`) catches the empty-string
  // case too.
  const boundWorkerId = c.var.mcpAuthInfo?.workerId ?? null;
  if (boundWorkerId && boundWorkerId !== worker_id) {
    return c.json(
      {
        error: 'worker_id_mismatch',
        error_description: `this token is bound to worker_id '${boundWorkerId}'`,
      },
      403
    );
  }
  // Platform binding: once a (user_id, worker_id) row has set its platform,
  // subsequent polls cannot change it. Without this lock a chrome-extension
  // PAT could post `platform: "macos"` and unlock the macOS allowlist —
  // the gateway's capability authorization would otherwise believe the
  // self-reported platform. We read the stored platform first, reject
  // mismatches, and use the stored value for authorization.
  let effectivePlatform: string | null = platform;
  if (isUserScopedWorker && effectiveWorkerUserId && worker_id) {
    const existing = (await sql`
      SELECT platform FROM device_workers
      WHERE user_id = ${effectiveWorkerUserId} AND worker_id = ${worker_id}
      LIMIT 1
    `) as unknown as Array<{ platform: string | null }>;
    if (existing.length > 0 && existing[0].platform) {
      if (platform && platform !== existing[0].platform) {
        return c.json(
          {
            error: 'platform_mismatch',
            error_description: `worker is bound to platform '${existing[0].platform}'`,
          },
          403
        );
      }
      effectivePlatform = existing[0].platform;
    }
  }
  // An omitted map means a client that predates the field; mirror what a daemon
  // would have advertised. Capacity now covers only server-shipped compiled
  // code, so it no longer varies by platform — a connector the endpoint
  // implements itself needs no advertised backend at all.
  if (!backendCapacityProvided) {
    backendCapacity = defaultBackendCapacity();
  }
  // For user-scoped (device) workers, authorize the advertised capability set
  // against the platform-specific allowlist in @lobu/core. Anything outside
  // the allowlist for the device's reported platform is silently dropped —
  // a chrome-extension can't claim `os.shell`, an iOS bridge can't claim
  // `browser.debugger`, etc. Trusted-fleet workers (no platform) skip this.
  let authorizedCapabilities = advertisedCapabilities;
  if (isUserScopedWorker) {
    const auth = authorizeCapabilities(effectivePlatform, advertisedCapabilities);
    authorizedCapabilities = auth.authorized;
    if (auth.dropped.length > 0) {
      logger.warn(
        { worker_id, platform: effectivePlatform, dropped: auth.dropped },
        '[pollWorkerJob] dropped capabilities not allowed for platform'
      );
    }
  }
  const capabilityMatchSet = isUserScopedWorker
    ? authorizedCapabilities
    : [''].concat(authorizedCapabilities);

  // Capability negotiation for DB-egress-hardened connectors (postgres, future
  // warehouses). A run for one of these connectors opens a raw tenant DB socket
  // and depends on the worker enforcing block-private egress. During a rolling
  // deploy a NEW gateway must NOT hand such a run to an OLD fleet worker that
  // predates the hardening (it would default to allow-private and reopen
  // private-IP/plaintext egress). Read the RAW advertised map — this is a fleet
  // worker, not a device-authorized one, so the platform-authorized set does not
  // apply. Gated in the shared fleet claim lane; only active in cloud mode.
  const workerHardensDbEgress = capabilities.db_egress_hardening === true;

  // An agent turn runs Lobu's own agent-session guest bundle through
  // IsolateExecutor. `executeRun`'s default arm is a connector sync, so a
  // daemon that predates this lane would claim the row and then fail it as a
  // malformed connector run. Gate the claim on the worker SAYING it can run
  // one: the two sides agree by string equality, so an old worker simply never
  // matches. Fleet only — an agent turn carries the org's provider proxy and
  // has no business on a user's device.
  const workerRunsAgentTurns = capabilities.agent_turn === true;

  // Device-worker registry: upsert device_workers row for user-scoped workers
  // so /api/me/devices can enumerate them. Also ensure advertised capability
  // connectors are fully wired. Best-effort — never fail the poll.
  //
  // `deviceWorkerId` is this device's surrogate id; a pending run whose
  // connection is pinned to it (connections.device_worker_id) is claimable
  // regardless of the connector's required_capability — that's how an
  // otherwise-embedded connector (Reddit, …) ends up running on a chosen device.
  // Device home org: the workspace the device's token was issued for (or, for a
  // re-anchored local device, the org it already lives in). The upsert COALESCEs
  // to the owner's personal org when null, and sets the home only on first
  // registration; moving an existing device is the Devices-page action.
  const registrationUserId = effectiveWorkerUserId;
  const registrationOrgId = effectiveTokenOrgId;

  let deviceWorkerId: string | null = null;
  let manifestClaimAuthorizations: ManifestClaimAuthorization[] = [];
  if (registrationUserId) {
    try {
      const incomingCaps = authorizedCapabilities;
      const manifestValidation = connectorManifestsProvided
        ? validateDeviceConnectorManifests({
            platform: effectivePlatform,
            capabilities: incomingCaps,
            manifests: connectorManifestsRaw,
          })
        : null;
      // An explicitly empty array is an authoritative "this device serves no
      // connectors". A payload the validator rejected is not: replacing the
      // last good inventory with {} would make reconcile archive working
      // definitions because a malformed poll looked like removal.
      const connectorManifestsAccepted = manifestValidation?.accepted === true;
      const connectorManifestMap = connectorManifestsAccepted
        ? storedManifestMap(manifestValidation.manifests)
        : null;

      // `xmax = 0` on the RETURNING row distinguishes a brand-new device
      // registration from a routine poll-update so we only emit the
      // `device:created` lifecycle event once per device.
      const upserted = (await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id, connector_manifests, agent_kinds)
        VALUES (
          ${registrationUserId}, ${worker_id}, ${platform}, ${app_version},
          ${sql.json(incomingCaps)}, ${label},
          COALESCE(
            ${registrationOrgId}::text,
            (SELECT id FROM organization WHERE (metadata::jsonb)->>'personal_org_for_user_id' = ${registrationUserId} LIMIT 1)
          ),
          ${sql.json(connectorManifestMap ?? {})},
          ${agentKindsParam}::text[]
        )
        ON CONFLICT (user_id, worker_id) DO UPDATE SET
          -- platform is set-once: COALESCE preserves the original value,
          -- so a compromised PAT can't re-platform a Chrome worker into a
          -- macOS one to unlock OS capabilities. The mismatch check above
          -- already rejects deliberate attempts; this is defense-in-depth
          -- against a race between the SELECT and the UPSERT.
          platform = COALESCE(device_workers.platform, EXCLUDED.platform),
          app_version = EXCLUDED.app_version,
          capabilities = EXCLUDED.capabilities,
          -- label is deliberately absent: it is recorded on insert and owned by
          -- the user afterwards (PATCH /api/me/devices/:id). A heartbeat that
          -- wrote it back would clobber a Devices-page rename on the next poll,
          -- since a headless daemon self-reports its hostname every time.
          organization_id = COALESCE(device_workers.organization_id, EXCLUDED.organization_id),
          connector_manifests = CASE
            WHEN ${connectorManifestsAccepted} THEN EXCLUDED.connector_manifests
            ELSE device_workers.connector_manifests
          END,
          -- Only overwrite when the device actually advertised. A client that
          -- stops sending the field (a downgraded build) must not erase what a
          -- capable client already told us.
          agent_kinds = COALESCE(EXCLUDED.agent_kinds, device_workers.agent_kinds),
          last_seen_at = now()
        RETURNING id, organization_id, (xmax = 0) AS inserted
      `) as unknown as Array<{
        id: string;
        organization_id: string | null;
        inserted: boolean;
      }>;
      deviceWorkerId = upserted[0]?.id ?? null;
      if (upserted[0]?.inserted && upserted[0]?.organization_id) {
        recordLifecycleEvent({
          organizationId: upserted[0].organization_id,
          entityType: 'device',
          op: 'created',
          entityId: upserted[0].id,
          summary: `Device "${label ?? worker_id}" registered`,
          extra: { platform, worker_id, app_version },
        });
      }

      // Reconcile this user's device connectors against the capabilities their
      // whole fleet currently advertises: auto-wire / re-activate the ones that
      // are present (cheap fast path, also heals partially-wired state), pause
      // the ones that have gone away. The just-upserted row above is already
      // visible to this query, so the polling device's capabilities count.
      const reconciliationStartedAt = performance.now();
      try {
        manifestClaimAuthorizations = await reconcileDeviceCapabilities(
          registrationUserId,
          deviceWorkerId
        );
      } finally {
        setGauge(
          'lobu_device_manifest_reconciliation_duration_ms',
          performance.now() - reconciliationStartedAt
        );
      }
    } catch (err) {
      logger.error(
        { worker_id, err: errorMessage(err) },
        '[pollWorkerJob] device_workers upsert failed (non-fatal)'
      );
    }
    if (!deviceWorkerId) {
      try {
        const existing = (await sql`
          SELECT id FROM device_workers
          WHERE user_id = ${registrationUserId} AND worker_id = ${worker_id}
          LIMIT 1
        `) as unknown as Array<{ id: string }>;
        deviceWorkerId = existing[0]?.id ?? null;
      } catch (err) {
        logger.error(
          { worker_id, err: errorMessage(err) },
          '[pollWorkerJob] deviceWorkerId fallback lookup failed (non-fatal)'
        );
      }
    }
  }

  // User-scoped workers (e.g. Lobu for Mac) can only claim runs in the
  // org their token is bound to, plus the user's personal org (where device
  // connectors auto-wire) — the set is computed in the /api/workers/* auth
  // middleware. Trusted workers (matched WORKER_API_TOKEN) and anonymous
  // local-dev requests see all pending runs — preserving the existing
  // server-side worker fleet semantics.
  //
  // Cross-org device pins: also let the device claim runs in any org where it
  // has a pinned automation/connection AND its owner is still a member of that
  // org. The pin IS the owner's consent — `evaluateDeviceWorkerAccess` only
  // lets a device's owner attach it — so this keeps the device anchored to its
  // home + personal org while serving automations it was explicitly attached to in
  // other orgs the owner belongs to. The membership join revokes access
  // automatically if the owner later leaves the org. Within-org claiming still
  // follows the pinned/capability rules below, so the device only ever runs the
  // resource it was actually pinned to.
  let claimableOrgIds = effectiveWorkerOrgIds;
  if (isUserScopedWorker && deviceWorkerId && effectiveWorkerUserId) {
    try {
      claimableOrgIds = await resolveDeviceClaimableOrgs(sql, {
        deviceWorkerId,
        ownerUserId: effectiveWorkerUserId,
        baseOrgIds: effectiveWorkerOrgIds ?? [],
      });
    } catch (err) {
      // Non-fatal: fall back to the base [bound, personal] scope.
      logger.warn(
        { worker_id, err: errorMessage(err) },
        '[pollWorkerJob] cross-org pinned-scope lookup failed'
      );
    }
  }
  // Org scope applies to every device (user-scoped) worker — including a
  // re-anchored local device, whose org is claimableOrgIds. A signed-in
  // worker with no org in scope can claim nothing; a re-anchored device with no
  // org falls through to the empty-array gate (claims only by capability).
  const hasEmptyUserOrgScope =
    c.var.workerAuthMode === 'user' && (!claimableOrgIds || claimableOrgIds.length === 0);
  const orgScopeActive = isUserScopedWorker;
  // Always pass a non-empty array to ANY() to keep the SQL valid; the gate
  // below only activates when orgScopeActive is true.
  //
  // Two scopes: `orgScopeIds` (widened with cross-org pins) gates the
  // explicitly-PINNED claim branches — the pin is the owner's consent.
  // `baseOrgScopeIds` (token's bound + personal org only) gates the UNPINNED
  // capability-matched branch, so a single pin in org B does NOT also let the
  // device claim unrelated unpinned device-connector runs in org B.
  const orgScopeIds = orgScopeActive && claimableOrgIds ? claimableOrgIds : [''];
  const baseOrgScopeIds =
    orgScopeActive && effectiveWorkerOrgIds && effectiveWorkerOrgIds.length > 0
      ? effectiveWorkerOrgIds
      : [''];
  const connectorClaimContext: ConnectorClaimContext = {
    isUserScopedWorker,
    deviceWorkerId,
    workerPlatform: effectivePlatform,
    authorizedCapabilities,
    capabilityMatchSet,
    manifestClaimAuthorizations,
    allowLegacyManifestCapabilityClaims:
      isUserScopedWorker &&
      !connectorManifestsProvided &&
      effectivePlatform !== 'chrome-extension' &&
      effectivePlatform !== 'headless',
    orgScopeIds,
    baseOrgScopeIds,
    workerHardensDbEgress,
    backendCapacity,
  };
  const workerKind = isUserScopedWorker ? 'device' : 'fleet';
  // `platform` is self-reported in the poll body and is only pinned to the
  // stored value once a device_workers row exists, so it must be collapsed to
  // the known set before it becomes a metric label — an unbounded label value
  // both blows up series cardinality and is emitted unescaped by
  // getMetricsText().
  const platformLabel = effectivePlatform
    ? isKnownPlatform(effectivePlatform)
      ? effectivePlatform
      : 'unknown'
    : 'none';
  incrementCounter('lobu_worker_polls_total', {
    worker_kind: workerKind,
    platform: platformLabel,
  });
  if (capacityAvailable === 0) {
    return c.json({
      next_poll_seconds: 10,
      ...(effectivePlatform === 'chrome-extension' ? { page_activations: [] } : {}),
    });
  }
  if (hasEmptyUserOrgScope) {
    // No org in scope — nothing this worker can ever claim. The rejection is
    // deferred to here (rather than returning at the check above) so the poll
    // is still counted: "this worker is alive but claims nothing" and "this
    // worker stopped polling" must not look identical on the metric.
    return c.json({
      next_poll_seconds: 30,
      ...(effectivePlatform === 'chrome-extension' ? { page_activations: [] } : {}),
    });
  }

  const pageActivations =
    isUserScopedWorker && effectivePlatform === 'chrome-extension' && supportsExactPageActivation(app_version)
      ? (
          await sql<{ run_id: number; urls: string | string[] }>`
          SELECT id AS run_id, activation_target_urls AS urls
          FROM runs
          WHERE organization_id = ANY(${pgTextArray(orgScopeIds)}::text[])
            AND created_by_user_id = ${effectiveWorkerUserId}
            AND run_type = 'action'
            AND status = 'pending'
            AND approval_status = 'auto'
            AND activation_kind = 'page_visit'
            AND run_metadata->>'page_activation_identity' = 'exact'
            AND activated_at IS NULL
            AND expires_at > current_timestamp
          ORDER BY expires_at, id
          LIMIT 100
        `
        ).map((row) => ({
          run_id: Number(row.run_id),
          urls: parsePgTextArray(row.urls),
        }))
      : // An extension that cannot verify the exact target itself gets an
        // empty list rather than no field: that is what makes it drop the
        // hints it already cached from a lossily-normalized target.
        effectivePlatform === 'chrome-extension'
        ? []
        : undefined;
  const pollMetadata =
    pageActivations === undefined ? {} : { page_activations: pageActivations };

  const claimNextPendingRun = async () =>
    sql.begin(async (tx) => {
      const candidates = await tx`
      WITH next_run AS (
        SELECT r.id, r.run_type, r.automation_id, r.organization_id,
          r.action_input->'turn'->>'agent_id' AS turn_agent_id,
          r.action_input->'turn'->>'conversation_id' AS turn_conversation_id
        FROM runs r
        LEFT JOIN connections con ON con.id = r.connection_id
        -- Pin target platform: chrome-extension pins on non-chrome connectors mean
        -- browser affinity (scrape via that extension), not "run parent sync on
        -- the extension". See dispatch-chrome-action preferredBrowserWorkerForConnection.
        LEFT JOIN device_workers pin_dw ON pin_dw.id = con.device_worker_id
        LEFT JOIN LATERAL (
          SELECT
            CASE
              WHEN r.connector_version IS NULL OR cd.version = r.connector_version
                THEN cd.required_capability
              ELSE NULL
            END AS run_required_capability,
            CASE
              WHEN r.connector_version IS NULL OR cd.version = r.connector_version
                THEN cd.runtime
              ELSE NULL
            END AS run_runtime
          FROM connector_definitions cd
          WHERE cd.key = r.connector_key
            AND cd.organization_id = r.organization_id
            AND cd.status = 'active'
            AND (r.connector_version IS NULL OR cd.version = r.connector_version)
          ORDER BY cd.updated_at DESC, cd.id DESC
          LIMIT 1
        ) cd ON true
        LEFT JOIN LATERAL (
          ${selectedConnectorVersionArtifactSql(tx, {
            connectorKey: tx`r.connector_key`,
            version: tx`r.connector_version`,
            organizationId: tx`r.organization_id`,
          })}
        ) run_cv ON true
        WHERE r.status = 'pending'
          AND (r.activation_kind IS NULL OR (
            r.activated_at IS NOT NULL AND r.run_metadata->>'page_activation_identity' = 'exact'
          ))
          -- A child of a page-activated parent runs on the tab the human opened,
          -- so it is claimable only while that exact-identity parent is running,
          -- and never by an extension too old to verify the target URL itself.
          AND NOT EXISTS (
            SELECT 1 FROM runs activation_parent
            WHERE activation_parent.id = r.parent_run_id
              AND activation_parent.organization_id = r.organization_id
              AND activation_parent.activation_kind = 'page_visit'
              AND (
                activation_parent.run_metadata->>'page_activation_identity' IS DISTINCT FROM 'exact'
                OR activation_parent.status <> 'running'
                OR ${effectivePlatform === 'chrome-extension' && !supportsExactPageActivation(app_version)}
              )
          )
          AND (
            r.run_type <> 'action'
            OR r.expires_at IS NULL
            OR r.expires_at > now()
          )
          AND (r.approval_status = 'auto' OR r.approval_status = 'approved')
          AND (
            -- (1) Connector-worker lanes: sync / action / auth.
            (
              r.run_type IN ('sync', 'action', 'auth')
              AND ${connectorClaimLaneSql(tx, connectorClaimContext, {
                connectorKey: tx`r.connector_key`,
                connectorVersion: tx`r.connector_version`,
                organizationId: tx`r.organization_id`,
                activationKind: tx`r.activation_kind`,
                activatedAt: tx`r.activated_at`,
                connectionDeviceWorkerId: tx`con.device_worker_id`,
                runTargetDeviceWorkerId: tx`r.target_device_worker_id`,
                pinPlatform: tx`pin_dw.platform`,
                runRequiredCapability: tx`cd.run_required_capability`,
                runManifestBacked: tx`run_cv.manifest_backed`,
                runManifestHash: tx`run_cv.artifact_hash`,
                runRuntime: tx`cd.run_runtime`,
              })}
            )
            -- (1a) Agent turns: one conversation turn as one isolate job.
            --      Fleet-only, and only for a worker that advertises the lane.
            OR (
              ${!isUserScopedWorker && workerRunsAgentTurns}
              AND r.run_type = 'agent_turn'
              AND ${agentTurnClaimEligible(tx)}
            )
            -- (1b) Embedding backfills have no connector identity. They are
            -- server-side work and may only be claimed by the trusted fleet.
            OR (
              ${!isUserScopedWorker}
              AND r.run_type = 'embed_backfill'
            )
            -- (2) Automation lane: an automation run with approved_input.device_worker_id
            --     matching this device. Automations don't carry a connection_id and
            --     don't gate on the connector capability set — the matching device's
            --     local CLI executor handles the work, routing by
            --     approved_input.agent_kind. The server-side dispatcher (#802)
            --     already refuses to claim rows with this pin set, so this branch
            --     is the only legal claim path for them.
            --
            --     It DOES gate on the agent kinds the device advertised on this
            --     poll, which the daemon derives from the CLIs it can actually
            --     resolve on the machine. Without that, a run pinned to a device
            --     with no claude binary on PATH is still claimed and then fails with
            --     "binary not found on PATH" — which reads as a broken Automation
            --     rather than a machine missing a CLI. Leaving it unclaimed keeps
            --     it queued until a device that can run it polls.
            --     A device that advertised nothing (agentKinds IS NULL: the Mac
            --     app and Chrome bridge today, or an older daemon) is deliberately
            --     unrestricted. A run that names no agent_kind is claimable too —
            --     the device resolves it against its own default — but only by a
            --     device that advertised at least one kind: a device that told us
            --     it can run nothing has no default to resolve against either.
            OR (
              ${isUserScopedWorker}
              AND r.run_type = 'automation'
              AND ${deviceWorkerId}::uuid IS NOT NULL
              AND (
                r.target_device_worker_id = ${deviceWorkerId}::uuid
                OR (
                  r.target_device_worker_id IS NULL
                  AND r.approved_input ? 'device_worker_id'
                  AND r.approved_input->>'device_worker_id' = ${deviceWorkerId}::text
                )
              )
              AND (
                'automations.execute' = ANY(${pgTextArray(authorizedCapabilities)}::text[])
                OR ${effectivePlatform}::text = 'macos'
              )
              AND r.organization_id = ANY(${pgTextArray(orgScopeIds)}::text[])
              AND (
                ${agentKindsParam}::text[] IS NULL
                OR CASE
                  WHEN NULLIF(r.approved_input->>'agent_kind', '') IS NULL
                    THEN cardinality(${agentKindsParam}::text[]) > 0
                  ELSE r.approved_input->>'agent_kind' = ANY(${agentKindsParam}::text[])
                END
              )
              AND NOT EXISTS (
                SELECT 1
                FROM runs active
                WHERE active.automation_id = r.automation_id
                  AND active.run_type = 'automation'
                  AND active.status IN ('claimed', 'running')
              )
            )
            -- (3) Device chat lane: the ordinary messages/chat_message row is
            --     pinned through its shared MessagePayload.executionTarget.
            --     Only an explicitly-advertising daemon can claim it; legacy
            --     Mac/extension polls with agentKinds=NULL never enter here.
            OR (
              ${isUserScopedWorker}
              AND r.run_type = 'chat_message'
              AND r.queue_name = 'messages'
              AND ${deviceWorkerId}::uuid IS NOT NULL
              AND jsonb_typeof(r.action_input) = 'object'
              AND (
                r.target_device_worker_id = ${deviceWorkerId}::uuid
                OR (
                  r.target_device_worker_id IS NULL
                  AND r.action_input->'executionTarget'->>'kind' = 'device'
                  AND r.action_input->'executionTarget'->>'deviceWorkerId' = ${deviceWorkerId}::text
                )
              )
              AND r.organization_id = ANY(${pgTextArray(orgScopeIds)}::text[])
              AND ${agentKindsParam}::text[] IS NOT NULL
              AND r.action_input->'executionTarget'->>'agentKind' = ANY(${agentKindsParam}::text[])
              AND 'automations.execute' = ANY(${pgTextArray(authorizedCapabilities)}::text[])
              AND NOT EXISTS (
                SELECT 1
                FROM runs active
                WHERE active.id < r.id
                  AND active.run_type = 'chat_message'
                  AND active.queue_name = 'messages'
                  AND active.status IN ('pending', 'running')
                  AND active.organization_id = r.organization_id
                  AND active.action_input->>'conversationId' = r.action_input->>'conversationId'
              )
            )
          )
        ORDER BY
          CASE WHEN r.run_type = 'auth' THEN 0 ELSE 1 END,
          r.created_at ASC
        FOR UPDATE OF r SKIP LOCKED
        LIMIT 1
      )
      SELECT id, run_type, automation_id, organization_id, turn_agent_id, turn_conversation_id
      FROM next_run
    `;

      if (candidates.length === 0) {
        return null;
      }

      const candidate = candidates[0] as {
        id: unknown;
        run_type: unknown;
        automation_id: unknown;
        organization_id: string | null;
        turn_agent_id: string | null;
        turn_conversation_id: string | null;
      };
      const runId = Number(candidate.id);
      if (candidate.run_type === 'agent_turn') {
        // Hold the conversation through commit: a lower-id insert can become
        // visible after the recheck and otherwise claim a different locked row.
        // This namespace is separate from the old worker's session lock.
        const [lock] = await tx<{ acquired: boolean }>`
          SELECT pg_try_advisory_xact_lock(${agentTurnLockKey(tx, candidate.organization_id,
            candidate.turn_agent_id, candidate.turn_conversation_id)}) AS acquired
        `;
        if (!lock?.acquired) return null;
        // A lower-id insert can commit after candidate selection. Re-read in
        // a fresh statement so a row the first snapshot could not see fences
        // this claim. One committing after the recheck still waits: the
        // claimed row fences it until this turn is terminal.
        const eligible = await tx`
          SELECT r.id FROM runs r
          WHERE r.id = ${runId} AND r.status = 'pending'
            AND ${agentTurnClaimEligible(tx)}
        `;
        if (eligible.length === 0) return null;
      }
      if (candidate.run_type === 'automation') {
        const claimed = await claimPendingAutomationRun(tx, {
          runId,
          automationId: Number(candidate.automation_id),
          claimedBy: worker_id,
          status: 'running',
          executedByDeviceWorkerId: deviceWorkerId,
        });
        if (!claimed) return null;
      } else {
        const claimed = await tx`
          WITH claimed_run AS (
            UPDATE runs
            SET status = 'running',
                claimed_at = current_timestamp,
                last_heartbeat_at = current_timestamp,
                claimed_by = ${worker_id},
                executed_by_device_worker_id = COALESCE(${deviceWorkerId ?? null}::uuid, executed_by_device_worker_id)
            WHERE id = ${runId}
              AND status = 'pending'
              AND (
                run_type <> 'action'
                OR expires_at IS NULL
                OR expires_at > now()
              )
            RETURNING id, run_type, feed_id, dry_run
          ), marked_feed AS (
            -- Feed health describes connector/source execution, not queue
            -- admission. Only a successful worker claim starts a real sync.
            -- Nothing SELECTs from this CTE: a data-modifying WITH sub-statement
            -- runs exactly once and to completion whether or not the primary
            -- query reads it, so the stamp lands atomically with the claim.
            UPDATE feeds f
            SET last_sync_status = 'pending',
                last_error = NULL,
                updated_at = current_timestamp
            FROM claimed_run claimed
            WHERE claimed.run_type = 'sync'
              AND NOT claimed.dry_run
              AND claimed.feed_id = f.id
            RETURNING f.id
          )
          SELECT id FROM claimed_run
        `;
        if (claimed.length === 0) return null;
      }

      const rows = await tx`
      SELECT
        r.id AS run_id,
        r.run_type,
        r.feed_id,
        r.connection_id,
        r.connector_key,
        r.connector_version,
        r.action_key,
        r.action_input,
        r.approved_input,
        r.parent_run_id,
        r.run_metadata,
        r.automation_id,
        r.organization_id,
        org.slug AS organization_slug,
        r.created_at AS run_created_at,
        r.auth_profile_id AS run_auth_profile_id,
        f.feed_key,
        f.config AS feed_config,
        f.checkpoint,
        f.entity_ids AS feed_entity_ids,
        conn.auth_profile_id,
        conn.app_auth_profile_id,
        conn.config AS connection_config,
        conn.device_worker_id AS connection_device_worker_id,
        cv.artifact_row_id AS connector_version_row_id,
        cv.artifact_organization_id,
        cv.artifact_row_count,
        cv.artifact_compiled_code AS compiled_code,
        cv.artifact_compile_config_hash AS compile_config_hash,
        cv.artifact_hash AS connector_manifest_hash,
        COALESCE(cv.manifest_backed, false) AS connector_manifest_backed,
        CASE WHEN cd.version = r.connector_version THEN cd.required_capability ELSE NULL END
          AS connector_required_capability,
        ap.auth_data AS auth_profile_auth_data,
        w.name AS automation_name,
        w.managed_agent_id AS automation_agent_id,
        w.slug AS automation_slug,
        w.agent_kind AS automation_agent_kind,
        w.execution_config AS automation_execution_config,
        wv.prompt AS automation_prompt,
        wv.skills AS automation_skills,
        wv.outputs AS automation_outputs,
        chat_agent.id AS chat_agent_id,
        chat_agent.name AS chat_agent_name,
        chat_agent.identity_md AS chat_agent_identity_md,
        chat_agent.soul_md AS chat_agent_soul_md,
        chat_agent.user_md AS chat_agent_user_md,
        parent.activation_tab_id AS parent_activation_tab_id,
        parent.run_metadata->>'page_activation_url' AS parent_activation_url
      FROM runs r
      LEFT JOIN organization org ON org.id = r.organization_id
      LEFT JOIN feeds f ON f.id = r.feed_id
      LEFT JOIN connections conn ON conn.id = r.connection_id
      LEFT JOIN LATERAL (
        ${selectedConnectorVersionArtifactSql(tx, {
          connectorKey: tx`r.connector_key`,
          version: tx`r.connector_version`,
          organizationId: tx`r.organization_id`,
        })}
      ) cv ON TRUE
      LEFT JOIN LATERAL (
        SELECT cd.*
        FROM connector_definitions cd
        WHERE cd.key = r.connector_key
          AND cd.organization_id = r.organization_id
          AND cd.status = 'active'
          AND (r.connector_version IS NULL OR cd.version = r.connector_version)
        ORDER BY cd.updated_at DESC, cd.id DESC
        LIMIT 1
      ) cd ON TRUE
      LEFT JOIN auth_profiles ap ON ap.id = r.auth_profile_id
      LEFT JOIN automations w ON w.id = r.automation_id
      LEFT JOIN automation_versions wv
        ON wv.id = COALESCE((r.approved_input->>'version_id')::bigint, w.current_version_id)
        AND wv.automation_id = w.automation_group_id
      LEFT JOIN agents chat_agent
        ON chat_agent.organization_id = r.organization_id
        AND chat_agent.id = r.action_input->>'agentId'
      -- A page-activated parent already resolved WHICH user tab the human
      -- opened. The extension's ownership guard cannot see that decision, so
      -- carry it down to the child action; scoped to the same organization for
      -- the same reason dispatch-chrome-action.ts scopes its own read.
      LEFT JOIN runs parent
        ON parent.id = r.parent_run_id
        AND parent.organization_id = r.organization_id
      WHERE r.id = ${runId}
      LIMIT 1
    `;

      const row = rows[0];
      if (row?.run_type === 'agent_turn') {
        const input = row.action_input as {
          turn?: Record<string, unknown>;
          reply?: { user_id?: string; platform_metadata?: { sessionReset?: unknown } };
        } | null;
        const turn = input?.turn;
        // `/new` asks for a fresh conversation. The chat bridge turns it into
        // an ordinary turn carrying this flag, so hydrating the snapshot would
        // hand the model the very history the user asked to leave behind —
        // making the reset an ordinary prompt with the old context loaded.
        // Skipping the read starts the native session empty; the reply then
        // persists a snapshot containing only this exchange, so the reset is
        // durable without deleting anything (`events` stays append-only).
        const sessionReset = input?.reply?.platform_metadata?.sessionReset === true;
        if (typeof turn?.agent_id === 'string' && turn.agent_id.trim()
          && typeof turn.conversation_id === 'string' && turn.conversation_id.trim()) {
          // Read only after admission, while the conversation claim is held.
          // A read failure rolls back the claim so the next poll can retry.
          // The whole conversation replays: this turn IS the conversation's
          // answer, so there is no source message to bound history at.
          const sessionJsonl = sessionReset ? '' : await readSnapshotJsonl({
            organizationId: candidate.organization_id ?? undefined,
            agentId: turn.agent_id,
            conversationId: turn.conversation_id,
            client: tx,
          });
          await tx`UPDATE runs SET run_metadata = COALESCE(run_metadata, '{}'::jsonb)
            || ${tx.json(nativeSessionBase(sessionJsonl ?? ''))}::jsonb WHERE id = ${runId}`;
          row.action_input = { ...input, turn: { ...turn, session_jsonl: sessionJsonl ?? '' } };
        }
      }
      return row ?? null;
    });

  const claimWithDiagnostics = async () => {
    try {
      return await withDbRetry('worker_poll_claim', claimNextPendingRun);
    } catch (err) {
      incrementCounter('lobu_worker_claim_query_errors_total', {
        worker_kind: workerKind,
        platform: platformLabel,
      });
      logger.error(
        {
          classification: 'dispatch_unavailable',
          stage: 'worker_claim_query',
          worker_id,
          device_worker_id: deviceWorkerId,
          worker_kind: workerKind,
          platform: effectivePlatform,
          error: errorMessage(err),
        },
        '[pollWorkerJob] Worker claim query failed after retries'
      );
      throw err;
    }
  };

  let pending = await claimWithDiagnostics();

  if (!pending) {
    // Keep the explicit return type: TypeScript cannot infer the assignment
    // made inside onRunCreated when it narrows the transaction result.
    const materializedRun = await sql.begin(
      async (tx): Promise<MaterializedDueFeedRun | null> => {
        const lockRows = await tx<{ acquired: boolean }>`
          SELECT pg_try_advisory_xact_lock(${DUE_FEEDS_LOCK_KEY}) AS acquired
        `;

        if (!lockRows[0]?.acquired) {
          return null;
        }

        let createdRun: MaterializedDueFeedRun | null = null;
        await materializeDueFeeds(c.env, tx, {
          claimContext: connectorClaimContext,
          // The caller has exactly one free claim slot. Scan past broken or
          // raced head rows, but stop after filling that one slot.
          maxRunsCreated: 1,
          onRunCreated: (run) => {
            createdRun = run;
          },
        });
        return createdRun;
      }
    );

    // Production Pino defaults to info. Emit one correlatable event only
    // when this exact poller actually materialized a scoped sync, after the
    // transaction committed. Ordinary empty polls stay metric-only, avoiding
    // per-worker log volume and high-cardinality metric labels.
    if (materializedRun) {
      logger.info(
        {
          dispatch_event: 'worker_scoped_sync_materialized',
          run_id: materializedRun.runId,
          feed_id: materializedRun.feedId,
          worker_id,
          device_worker_id: deviceWorkerId,
          eligibility_lane: materializedRun.eligibilityLane,
        },
        '[pollWorkerJob] Materialized due sync for current poller'
      );
    }

    pending = await claimWithDiagnostics();
  }

  if (!pending) {
    return c.json({ next_poll_seconds: 10, ...pollMetadata });
  }

  const row = pending as unknown as {
    run_id: number;
    run_type: string;
    feed_id: number | null;
    connection_id: number | null;
    connector_key: string | null;
    connector_version: string | null;
    action_key: string | null;
    action_input: Record<string, unknown> | null;
    approved_input: Record<string, unknown> | null;
    parent_run_id: number | null;
    run_metadata: Record<string, unknown> | null;
    feed_key: string | null;
    feed_config: Record<string, unknown> | null;
    checkpoint: Record<string, unknown> | null;
    feed_entity_ids: number[] | null;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
    connection_config: Record<string, unknown> | null;
    connection_device_worker_id: string | null;
    parent_activation_tab_id: number | string | null;
    parent_activation_url: string | null;
    connector_version_row_id: number | null;
    artifact_organization_id: string | null;
    artifact_row_count: number;
    compiled_code: string | null;
    compile_config_hash: string | null;
    connector_manifest_hash: string | null;
    connector_manifest_backed: boolean;
    connector_required_capability: string | null;
    run_created_at: string | Date | null;
    // Automation run fields (populated via LEFT JOINs)
    automation_id: number | null;
    organization_id: string;
    organization_slug: string | null;
    automation_name: string | null;
    automation_agent_id: string | null;
    automation_slug: string | null;
    automation_agent_kind: string | null;
    automation_execution_config: Record<string, unknown> | null;
    automation_prompt: string | null;
    automation_skills: unknown;
    automation_outputs: Record<string, unknown> | string | null;
    // Device chat fields (derived from the ordinary MessagePayload row)
    chat_agent_id: string | null;
    chat_agent_name: string | null;
    chat_agent_identity_md: string | null;
    chat_agent_soul_md: string | null;
    chat_agent_user_md: string | null;
    // Auth run fields
    run_auth_profile_id: number | null;
    auth_profile_auth_data: Record<string, unknown> | null;
  };

  // The device implements a manifest-backed connector itself: the artifact
  // carries no code and its identity is the contract hash the device
  // advertised. HOW it runs there — a native bridge, an in-process built-in —
  // is the endpoint's own routing decision, made from its local registry, so
  // the gateway neither classifies it nor names a backend. Encoding the
  // implementation here is what previously forced it into the manifest, and
  // therefore into the hash, so one contract could not be served by two
  // endpoints.
  const isDeviceOwnedRun = isUserScopedWorker && row.connector_manifest_backed;

  // An agent turn ships its whole envelope in `action_input`: the producer
  // resolved the model, prompt and proxy; the claim refreshed the native
  // session snapshot after all earlier turns finished. The provider
  // credential is lifted OUT of the payload and onto the response's
  // `credentials`, so the worker host conceals it behind a per-run placeholder
  // the way it does a connector's OAuth token — the guest never sees either.
  if (row.run_type === 'agent_turn') {
    const envelope = (row.action_input ?? {}) as {
      turn?: Record<string, unknown>;
      credential?: unknown;
    };
    const turn = envelope.turn;
    const credential = envelope.credential;
    if (!turn || typeof credential !== 'string' || credential.length === 0
      || typeof turn.agent_id !== 'string' || !turn.agent_id.trim()
      || typeof turn.conversation_id !== 'string' || !turn.conversation_id.trim()) {
      const failure = 'agent turn run has an incomplete execution envelope';
      await failClaimedWorkerRun({
        runId: row.run_id,
        workerId: worker_id,
        errorMessage: failure,
      });
      logger.error({ run_id: row.run_id }, failure);
      return c.json({
        next_poll_seconds: 1,
        skipped_run_id: row.run_id,
        error: failure,
        ...pollMetadata,
      });
    }
    return c.json({
      ...pollMetadata,
      run_id: row.run_id,
      run_type: 'agent_turn',
      organization_id: row.organization_id,
      payload: { turn },
      credentials: {
        provider: String((turn.provider as { provider?: unknown } | undefined)?.provider ?? 'unknown'),
        accessToken: credential,
      },
    });
  }

  // Device chat reuses the ordinary messages/chat_message row. The poll
  // response is only an execution envelope: ownership/routing remain on the
  // original MessagePayload and completion emits the standard thread_response.
  if (row.run_type === 'chat_message') {
    const message = row.action_input;
    const target =
      message?.executionTarget &&
      typeof message.executionTarget === 'object' &&
      !Array.isArray(message.executionTarget)
        ? (message.executionTarget as Record<string, unknown>)
        : null;
    const agentKind =
      typeof target?.agentKind === 'string' ? target.agentKind.trim() : '';
    const conversationId =
      typeof message?.conversationId === 'string' ? message.conversationId : '';
    const messageText =
      typeof message?.messageText === 'string' ? message.messageText : '';
    const messageId =
      typeof message?.messageId === 'string' ? message.messageId : '';
    const userId = typeof message?.userId === 'string' ? message.userId : '';
    const channelId =
      typeof message?.channelId === 'string' ? message.channelId : '';
    if (
      !agentKind ||
      !row.chat_agent_id ||
      !conversationId ||
      !messageText ||
      !messageId ||
      !userId ||
      !channelId ||
      !row.organization_slug
    ) {
      const failure = 'device chat run has an incomplete execution envelope';
      await failClaimedDeviceChatRun({
        runId: row.run_id,
        workerId: worker_id,
        errorMessage: failure,
        message,
        organizationId: row.organization_id,
      });
      return c.json({
        next_poll_seconds: 1,
        skipped_run_id: row.run_id,
        error: failure,
        ...pollMetadata,
      });
    }

    let agentSession: {
      conversation_id: string;
      mcp_url: string;
      token: string;
      expires_at: number;
    };
    try {
      const access = buildDeviceChatRunWorkerAccess({
        agentId: row.chat_agent_id,
        conversationId,
        runId: row.run_id,
        organizationId: row.organization_id,
        userId,
        channelId,
      });
      agentSession = {
        conversation_id: access.conversationId,
        mcp_url: `${resolvePublicOrigin(c.req.url)}/mcp/${encodeURIComponent(row.organization_slug)}`,
        token: access.token,
        expires_at: access.expiresAt,
      };
    } catch (err) {
      const failure = 'failed to mint the required device chat run session';
      await failClaimedDeviceChatRun({
        runId: row.run_id,
        workerId: worker_id,
        errorMessage: failure,
        message,
        organizationId: row.organization_id,
      });
      logger.error({ run_id: row.run_id, err }, failure);
      return c.json({
        next_poll_seconds: 1,
        skipped_run_id: row.run_id,
        error: failure,
        ...pollMetadata,
      });
    }

    const snapshot = await readSnapshotJsonl({
      organizationId: row.organization_id,
      agentId: row.chat_agent_id,
      conversationId,
      // History returns at most twelve 16 KB messages. A 1 MB suffix keeps the
      // poll request bounded while leaving ample room for JSONL overhead and
      // ordinary longer raw replies; parseSessionEntries ignores a cut line.
      suffixChars: DEVICE_CHAT_HISTORY_TAIL_CHARS,
    });
    const history = snapshot
      ? parseSessionEntries(snapshot).entries
          .flatMap((entry) => {
            const messageEntry = entryToMessage(entry);
            if (
              messageEntry?.type !== 'message' ||
              (messageEntry.role !== 'user' &&
                messageEntry.role !== 'assistant')
            ) {
              return [];
            }
            const content = transcriptText(messageEntry.content).slice(0, 16_000);
            return content
              ? [{ role: messageEntry.role, content }]
              : [];
          })
          .slice(-12)
      : [];

    return c.json({
      ...pollMetadata,
      run_id: row.run_id,
      run_type: 'chat_message',
      organization_id: row.organization_id,
      payload: {
        chat: {
          agent_kind: agentKind,
          message: messageText.slice(0, 32_000),
          ...(typeof message?.ephemeralContext === 'string' &&
          message.ephemeralContext.length > 0
            ? { ephemeral_context: message.ephemeralContext.slice(0, 2_048) }
            : {}),
          history,
          agent: {
            id: row.chat_agent_id,
            name: row.chat_agent_name ?? undefined,
            identity_md: row.chat_agent_identity_md ?? undefined,
            soul_md: row.chat_agent_soul_md ?? undefined,
            user_md: row.chat_agent_user_md ?? undefined,
          },
        },
        context: {
          device: { worker_id: deviceWorkerId ?? undefined },
          user: { user_id: effectiveWorkerUserId ?? null },
          agent_session: agentSession,
        },
      },
    });
  }

  // Automation run: device worker is going to spawn a local CLI executor and
  // return the result via /api/workers/me/runs/:runId/complete-automation. No
  // connector code, no connection credentials, no compiled_code lookup —
  // just the payload envelope the dispatcher needs to build a prompt. The
  // server-side claim filter (#802 + this PR) already guarantees only the
  // matching device can land on this row.
  if (row.run_type === 'automation') {
    const approved = (row.approved_input ?? {}) as Record<string, unknown>;
    const triggerSignals = automationTriggerSignals({
      trigger_signal: approved.trigger_signal,
      trigger_signals: approved.trigger_signals,
    });
    const workspaceEventIds = triggerSignals
      .filter(isWorkspaceEventTriggerSignal)
      .map((signal) => signal.event_id);
    const firedAtRaw = row.run_created_at;
    const firedAt =
      firedAtRaw instanceof Date
        ? firedAtRaw.toISOString()
        : typeof firedAtRaw === 'string' && firedAtRaw.trim()
          ? firedAtRaw
          : new Date().toISOString();
    const automationIdStr = row.automation_id != null ? String(row.automation_id) : '';
    const agentKindFromPayload =
      typeof approved['agent_kind'] === 'string' && (approved['agent_kind'] as string).trim()
        ? (approved['agent_kind'] as string).trim()
        : null;
    // Output contract for the device: composed from declared entity/event
    // outputs and the optional reaction input contract. The same helper is used
    // by complete_window, so extraction and validation cannot drift.
    const automationExtractionSchema = await deriveAutomationExtractionSchema(
      getDb(),
      row.organization_id,
      parseClaimJson(row.automation_outputs) as Outputs | null,
      row.automation_id
    );
    let automationInstructions: string | null;
    try {
      automationInstructions = formatDeviceAutomationInstructions(
        row.automation_prompt,
        row.automation_skills
      );
    } catch (err) {
      const message = errorMessage(err);
      await failClaimedWorkerRun({
        runId: row.run_id,
        workerId: worker_id,
        errorMessage: message,
      });
      logger.error(
        { run_id: row.run_id, err },
        'Failed to resolve pinned Automation skills for device dispatch'
      );
      return c.json({
        next_poll_seconds: 1,
        skipped_run_id: row.run_id,
        error: message,
        ...pollMetadata,
      });
    }
    let devicePrompt = automationInstructions;
    let agentSession: {
      conversation_id: string;
      mcp_url: string;
      token: string;
      expires_at: number;
      resume_session_id?: string;
    } | undefined;
    const requiresRunScopedAgentSession =
      effectivePlatform === 'macos' && authorizedCapabilities.includes('automations.execute');
    if (
      row.automation_id != null &&
      (effectivePlatform !== 'macos' || requiresRunScopedAgentSession)
    ) {
      const runPayload = parseAutomationRunPayload(approved);
      const agentId =
        typeof approved['agent_id'] === 'string' && approved['agent_id'].trim()
          ? approved['agent_id'].trim()
          : row.automation_agent_id?.trim() || null;
      if (
        runPayload &&
        agentId &&
        (await ensureAutomationAgentExists(sql, row.organization_id, agentId))
      ) {
        devicePrompt = buildDispatchMessage({
          automationId: row.automation_id,
          runId: row.run_id,
          agentId,
          payload: runPayload,
          automationInstructions: automationInstructions ?? undefined,
          executor: 'device',
        });
        // Per-run Automation agent session (same WorkerToken identity as the
        // server-side dispatcher's agent session) — never the device's PAT,
        // which is bound to the user's personal org and can't authenticate to
        // a team-org Automation. The daemon injects the token into the spawned
        // CLI (env + MCP wiring).
        //
        // Use the org-scoped direct endpoint: the gateway MCP proxy owns its
        // upstream session lifecycle and cannot serve a raw client's initialize.
        //
        // Minting encrypts, so it can throw (missing/short ENCRYPTION_KEY). The
        // run is ALREADY claimed by this point, so letting that escape would 500
        // the poll and strand it `running` — the exact wedge the claim gate
        // exists to prevent. Legacy workers retain the pre-session dispatch;
        // the new standalone Mac capability fails closed instead.
        try {
          if (!row.organization_slug) {
            throw new Error(
              `organization ${row.organization_id} has no slug to scope the MCP session URL`
            );
          }
          const access = buildAutomationRunWorkerAccess({
            agentId,
            automationId: row.automation_id,
            runId: row.run_id,
            organizationId: row.organization_id,
          });
          // Hand back the run's own ACP checkpoint only to the device that
          // wrote it, and only while the run still resolves to the same agent
          // kind. Sessions are agent-local state, so a different device or a
          // re-pinned agent kind cannot resume them.
          const selectedAgentKind = agentKindFromPayload ?? row.automation_agent_kind ?? null;
          const checkpoint = row.run_metadata?.['device_agent_session'];
          const stored =
            checkpoint != null && typeof checkpoint === 'object' && !Array.isArray(checkpoint)
              ? (checkpoint as Record<string, unknown>)
              : null;
          const resumeSessionId =
            stored?.['protocol'] === 'acp' &&
            stored['worker_id'] === worker_id &&
            stored['agent_kind'] === selectedAgentKind &&
            typeof stored['session_id'] === 'string'
              ? (stored['session_id'] as string)
              : undefined;
          agentSession = {
            conversation_id: access.conversationId,
            mcp_url: `${resolvePublicOrigin(c.req.url)}/mcp/${encodeURIComponent(row.organization_slug)}`,
            token: access.token,
            expires_at: access.expiresAt,
            ...(resumeSessionId ? { resume_session_id: resumeSessionId } : {}),
          };
        } catch (err) {
          if (requiresRunScopedAgentSession) {
            const message = 'failed to mint the required Automation run session';
            await failClaimedWorkerRun({
              runId: row.run_id,
              workerId: worker_id,
              errorMessage: message,
            });
            logger.error(
              { run_id: row.run_id, automation_id: row.automation_id, agent_id: agentId, err },
              '[poll] failed to mint the required macOS Automation run session'
            );
            return c.json({
              next_poll_seconds: 1,
              skipped_run_id: row.run_id,
              error: message,
              ...pollMetadata,
            });
          }
          devicePrompt = automationInstructions;
          logger.error(
            { run_id: row.run_id, automation_id: row.automation_id, agent_id: agentId, err },
            '[poll] failed to mint the Automation run session; dispatching instructions-only'
          );
        }
      } else {
        if (requiresRunScopedAgentSession) {
          const message = 'macOS Automation run has no assigned agent for its required run session';
          await failClaimedWorkerRun({
            runId: row.run_id,
            workerId: worker_id,
            errorMessage: message,
          });
          return c.json({
            next_poll_seconds: 1,
            skipped_run_id: row.run_id,
            error: message,
            ...pollMetadata,
          });
        }
        // No assigned agent (or no parseable run payload): dispatch the
        // pre-session shape — instructions prompt + exit-report completion on
        // the daemon's own wiring — rather than failing a run that used to
        // execute. Only runs with a real agent identity get a minted session.
        logger.warn(
          { run_id: row.run_id, automation_id: row.automation_id, agent_id: agentId },
          '[poll] headless automation has no usable assigned agent; dispatching instructions-only (no run-scoped MCP session)'
        );
      }
    }

    return c.json({
      ...pollMetadata,
      run_id: row.run_id,
      run_type: row.run_type,
      organization_id: row.organization_id,
      payload: {
        automation: {
          id: automationIdStr,
          name: row.automation_name ?? null,
          slug: row.automation_slug ?? null,
          agent_kind: agentKindFromPayload ?? row.automation_agent_kind ?? null,
          // Strip server-only keys (e.g. finalize_nudges) so the device-worker's
          // strict payload decode never sees a field it doesn't know.
          execution_config: stripServerOnlyExecutionConfig(row.automation_execution_config),
          // The instructions of the version this run was pinned to at creation:
          // the author's prompt plus its frozen skill snapshots. Device-local
          // executors do not receive the server-side worker's `.skills/` tree,
          // so dispatch composes the two at this boundary without changing the
          // separately stored/diffable version fields.
          //
          // (run's snapshotted approved_input.version_id, else the automation's
          // current_version_id) — same source complete_window validates
          // against, so an automation edited after the run was queued doesn't swap
          // the prompt mid-flight. Device-local executors had no other channel
          // for the automation's instructions (the payload shipped only
          // id/name/slug), so a scheduled automation's local CLI got a bare
          // "process this" and improvised; shipping it lets the device run the
          // real prompt. Null only if the automation has no version row.
          prompt: devicePrompt,
          // The derived extraction contract (entity-typed → derived from that
          // entity type's metadata_schema; untyped → null). The dispatcher embeds
          // it in the prompt as the output contract: the CLI must finish with a
          // JSON object matching it, which /complete-automation feeds through the
          // shared complete_window pipeline (schema validation included). Null
          // when the automation is untyped — the dispatcher then asks for a
          // free-form `{"summary": ...}` object.
          extraction_schema: automationExtractionSchema,
        },
        event: {
          trigger_event_id:
            workspaceEventIds.length === 1
              ? String(workspaceEventIds[0])
              : null,
          fired_at: firedAt,
          payload: approved,
        },
        context: {
          device: {
            worker_id: deviceWorkerId,
          },
          user: {
            user_id: effectiveWorkerUserId ?? null,
          },
          ...(agentSession ? { agent_session: agentSession } : {}),
        },
      },
    });
  }

  // Connector code delivery:
  //   - Fleet workers (server pods, embedded mode) ship the same bundled
  //     connector .ts sources in their image. The gateway omits
  //     `compiled_code` from the response — the worker resolves
  //     `connector_key` against its own filesystem and compiles locally,
  //     keeping its own LRU-capped cache. Cuts gateway poll responses
  //     from ~13 MB to ~kB and stops the gateway-side cache from being
  //     the dominant heap occupant (lobu#771 postmortem trail; 29 cached
  //     bundles totalled ~384 MB).
  //   - Device workers and DB-only user-uploaded connectors don't have the
  //     source on disk. When their version has stored TypeScript code, the
  //     gateway ships `compiled_code` inline. A metadata-only device manifest
  //     needs no bundle only when it is an attested native-bridge run, or when
  //     the gateway has no connector source it could deliver. We check the
  //     gateway-local
  //     `findBundledConnectorFile` (different filesystem layout from the
  //     worker image — see worker-side resolver in
  //     connector-worker/src/compile-connector.ts) to decide whether the
  //     fleet path applies.
  let compiledCode: string | undefined;
  const gatewayHasLocalSource = row.connector_key
    ? findBundledConnectorFile(row.connector_key) !== null
    : false;
  // Org-installed overrides (install_connector / source_url) persist
  // compiled_code on the version row. Fleet workers normally compile bundled
  // sources locally, but an explicit override must still ship inline so prod
  // picks up connector code before the next image deploy. In Cloud the image
  // is the trust root, so stored bytes are ignored whenever the image carries
  // the source — the worker compiles from its own image.
  //
  // Deliberately NOT restricted to shared rows. Scoping the suppression to
  // `artifact_organization_id === null` left the shadow shape — an org-scoped
  // copy of an image-shipped key — routing into `resolveConnectorCode` with a
  // row it then refused, failing an already-claimed run. Suppressing on the
  // image alone is also the stricter half of the pair: org bytes now never
  // reach a worker for a key the image ships.
  const hasStoredCompiledCode = Boolean(row.compiled_code) &&
    !(isCloudMode() && gatewayHasLocalSource);
  const workerWillResolveLocally =
    !isUserScopedWorker && gatewayHasLocalSource && !hasStoredCompiledCode;
  // Whether the claiming device implements this connector itself, so the
  // gateway may omit `compiled_code`. A device-owned (manifest-backed) run
  // always qualifies. A legacy device manifest or a capability-only client also
  // stays device-executed when the gateway has no code it could deliver; once
  // bundled or stored code exists, manifest backing and capability
  // advertisement are authorization signals only and do not establish that the
  // device implements the connector.
  const deviceWillExecuteNativeConnector =
    isUserScopedWorker &&
    !hasStoredCompiledCode &&
    (isDeviceOwnedRun ||
      (!gatewayHasLocalSource &&
        (row.connector_manifest_backed ||
          (row.connector_required_capability != null &&
            authorizedCapabilities.includes(row.connector_required_capability)))));
  if (row.connector_key && !workerWillResolveLocally && !deviceWillExecuteNativeConnector) {
    try {
      compiledCode = await resolveConnectorCode(row.connector_key, {
        id: row.connector_version_row_id,
        organization_id: row.artifact_organization_id,
        version: row.connector_version,
        compiled_code: row.compiled_code,
        compile_config_hash: row.compile_config_hash,
      });
    } catch (err) {
      const message = errorMessage(err);
      await failClaimedWorkerRun({
        runId: row.run_id,
        workerId: worker_id,
        errorMessage: message,
      });
      logger.error(
        { run_id: row.run_id, connector_key: row.connector_key, err },
        'Failed to resolve connector code for claimed worker run'
      );
      return c.json({
        next_poll_seconds: 1,
        skipped_run_id: row.run_id,
        error: message,
        ...pollMetadata,
      });
    }
  }

  // Credential delivery:
  //  - trusted/anonymous fleet workers always resolve connection credentials;
  //  - a user-scoped device worker only gets real credentials when the run's
  //    connection is *explicitly pinned to a device* (connections.device_worker_id),
  //    which was authorized at bind time. A device connector reached via the
  //    capability match (no pin) is no-auth by construction, so it gets nothing —
  //    a connector misconfigured with both a `required_capability` and an auth
  //    profile still can't leak secrets to an arbitrary capability-matched device.
  // `credentials` carries the access token for this run and never the refresh
  // token, and it stops at the worker HOST: the isolate lane replaces it with a
  // per-run placeholder before connector code sees it and swaps the value back
  // into the request header at `fetch`. The other secret-bearing fields below
  // (`connection_credentials`, `previous_credentials`) still travel resolved
  // and reach connector code as-is.
  const connectionIsDevicePinned = row.connection_device_worker_id != null;
  const deliverConnectionAuth =
    !isDeviceOwnedRun && !!row.connection_id && (!isUserScopedWorker || connectionIsDevicePinned);
  // `user_data_dir` and `cdp_url` for device-bound browser profiles flow to
  // the worker via `sessionState.user_data_dir` / `sessionState.cdp_url`
  // (set inside resolveExecutionAuth). No need to thread them as separate
  // top-level fields here.
  const { credentials, connectionCredentials, sessionState } = deliverConnectionAuth
    ? await resolveExecutionAuth({
        organizationId: row.organization_id,
        connectionId: row.connection_id!,
        authProfileId: row.auth_profile_id,
        appAuthProfileId: row.app_auth_profile_id,
        credentialDb: sql,
        logContext: { run_id: row.run_id },
        logMessage: 'Failed to resolve connection credentials for worker poll',
      })
    : {
        credentials: null,
        connectionCredentials: {},
        sessionState: null,
      };

  // `auth_data` holds `secret://` refs, not values. An `authenticate` run
  // consumes these as REAL credentials (e.g. to refresh an expiring token),
  // so resolve them rather than shipping the refs verbatim.
  // resolveAuthCredentials returns `{}` (not undefined) when there are no
  // refs to resolve, e.g. a null auth_profile_auth_data. Collapse the empty
  // object to undefined so `previous_credentials` is omitted rather than
  // serialized as `{}` — matching the connection_credentials idiom below and
  // keeping the payload contract unchanged for workers that test presence.
  const resolvedPreviousCredentials =
    deliverConnectionAuth && row.run_auth_profile_id != null
      ? await resolveAuthCredentials({
          organizationId: row.organization_id,
          authProfileId: Number(row.run_auth_profile_id),
          authData: row.auth_profile_auth_data,
        })
      : undefined;
  const previousCredentials =
    resolvedPreviousCredentials &&
    Object.keys(resolvedPreviousCredentials).length > 0
      ? resolvedPreviousCredentials
      : undefined;

  const selectedActionInput = row.approved_input ?? row.action_input ?? undefined;
  const isChromeAction =
    row.run_type === 'action' &&
    (row.connector_key === 'chrome' || row.connector_key?.startsWith('chrome.'));
  const actionInput = isChromeAction
    ? trustedChromeActionInput(
        selectedActionInput ?? {},
        // Stored context first (a conversation/Automation/MCP container decided
        // at dispatch), then the parent run for a connector child. An action
        // with neither is standalone: group those together per
        // organization+connection instead of minting a group per run, which
        // turned ten SDK navigates into ten visible groups.
        browserActionContextFromMetadata(row.run_metadata) ??
          (row.parent_run_id != null
            ? runScopedBrowserActionContext(row.parent_run_id)
            : (standaloneBrowserActionContext(
                row.organization_id,
                row.connection_id,
                row.run_id
              ) ?? runScopedBrowserActionContext(row.run_id))),
        // The extension's ownership guard has no way to know the human opened
        // this exact tab, nor which pages it was opened for, so the server
        // hands down the tab and the exact URL that won activation. The
        // original list can allow several pages; that is not permission to
        // follow a later navigation to another one. The extension re-checks the
        // live URL against them. Set here, never from action_input.
        row.parent_activation_tab_id == null
          ? null
          : Number(row.parent_activation_tab_id),
        row.parent_activation_url ? [row.parent_activation_url] : []
      )
    : selectedActionInput;

  return c.json({
    ...pollMetadata,
    run_id: row.run_id,
    run_type: row.run_type,
    connector_key: row.connector_key ?? undefined,
    connector_version: row.connector_version ?? undefined,
    // The contract identity the device must recognise. The native bridge
    // forwards it so the app can refuse a manifest it does not implement at the
    // exact hash. No routing marker rides along: which local backend serves the
    // run is the endpoint's decision, not the gateway's.
    ...(isDeviceOwnedRun && row.connector_manifest_hash
      ? { connector_manifest_hash: row.connector_manifest_hash }
      : {}),
    feed_key: row.feed_key ?? undefined,
    feed_id: row.feed_id ?? undefined,
    connection_id: row.connection_id ?? undefined,
    config: mergeExecutionConfig(row.connection_config, row.feed_config),
    // The DB egress boundary (private-IP block + IP pin + forced TLS) is decided
    // by the GATEWAY, which authoritatively knows cloud mode. The out-of-process
    // connector-worker must NOT re-derive it from its own `LOBU_CLOUD_MODE` — a
    // fleet worker missing that flag would run `allow-private` and reach private/
    // metadata IPs (SSRF). Shipped as a dedicated top-level field (not in tenant
    // `config`) so the worker installs it as authoritative `job.env` and takes the
    // STRICTER of gateway-vs-worker; block-private can never be downgraded.
    db_egress_policy: isCloudMode() ? 'block-private' : 'allow-private',
    // Operator allow-host list rides the SAME authoritative channel as the
    // policy: exact hosts that stay reachable under block-private. Never from
    // tenant config, and it never exempts metadata/link-local.
    db_egress_allow_hosts: process.env.LOBU_DB_EGRESS_ALLOW_HOSTS || undefined,
    checkpoint: row.checkpoint ?? undefined,
    entity_ids: row.feed_entity_ids ?? undefined,
    credentials,
    connection_credentials:
      Object.keys(connectionCredentials).length > 0 ? connectionCredentials : undefined,
    compiled_code: compiledCode,
    session_state: sessionState ?? undefined,
    action_key: row.action_key ?? undefined,
    // Mac/iOS bridge decodes `operation_key`; chrome uses `action_key` directly.
    operation_key: row.action_key ?? undefined,
    action_input: actionInput,
    auth_profile_id: deliverConnectionAuth ? (row.run_auth_profile_id ?? undefined) : undefined,
    previous_credentials: previousCredentials,
  });
}
