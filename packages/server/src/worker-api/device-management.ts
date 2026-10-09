/**
 * Device worker management endpoints.
 *
 * Session-authenticated (mcpAuth) endpoints for managing registered device
 * workers:
 *
 *   GET    /api/me/devices
 *   POST   /api/me/devices/mint-child-token
 *   PATCH  /api/me/devices/:id
 *   DELETE /api/me/devices/:id
 */

import { isKnownPlatform } from '@lobu/core';
import type { Context } from 'hono';
import { createAuth } from '../auth';
import { findExistingPersonalOrg } from '../auth/personal-org-provisioning';
import { PersonalAccessTokenService } from '../auth/tokens';
import { getDb, parsePgTextArray, pgBigintArray } from '../db/client';
import type { Env } from '../index';
import { captureServerError } from '../diagnostics';
import { errorMessage } from '../utils/errors';
import { recordLifecycleEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { DEVICE_ONLINE_WINDOW_SECONDS } from '../utils/device-liveness';
import {
  DEVICE_MOVED_TOMBSTONE,
  DEVICE_REMOVED_TOMBSTONE,
} from '../utils/device-pin-tombstones';
import { getWorkspaceRole } from '../utils/organization-access';
import { parseJsonBody } from '../gateway/routes/shared/helpers';
import { resolvePublicOrigin } from '../utils/public-origin';
import { buildAutomationUrl, getPublicWebUrl } from '../utils/url-builder';

const DEVICE_WORKER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** One of the caller's registered devices, as both readers return it. */
export interface DeviceWorkerSummary {
  id: string;
  worker_id: string;
  platform: string | null;
  app_version: string | null;
  capabilities: string[];
  agent_kinds: string[] | null;
  label: string | null;
  last_seen_at: string;
  online: boolean;
  organization_id: string | null;
  organization_name: string | null;
  organization_slug: string | null;
  connector_count: number;
  connector_error_count: number;
  last_sync_at: string | null;
  connectors: Array<{
    connection_id: number;
    connector_key: string;
    display_name: string;
    status: string;
    organization_slug: string | null;
  }>;
}

/**
 * The caller's registered devices, most-recently-seen first.
 *
 * Owner-scoped on `user_id`, never on the org: `device_workers` is keyed
 * `(user_id, worker_id)` and `organization_id` records where a device is
 * ATTACHED, not who owns it — so an org filter would both hide a user's own
 * unattached devices and expose colleagues' machines (`label` is typically a
 * personal name, `last_seen_at` a presence feed).
 *
 * Shared deliberately: `GET /api/me/devices` and the ClientSDK `devices`
 * namespace are two transports over this one query, so a column added here
 * reaches both and neither can drift.
 */
export async function queryDeviceWorkers(
  userId: string
): Promise<DeviceWorkerSummary[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      dw.id,
      dw.worker_id,
      dw.platform,
      dw.app_version,
      dw.capabilities,
      dw.agent_kinds,
      dw.label,
      dw.last_seen_at,
      (dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})) AS online,
      dw.organization_id,
      o.name AS organization_name,
      o.slug AS organization_slug,
      (SELECT count(*) FROM connections cn WHERE cn.device_worker_id = dw.id AND cn.deleted_at IS NULL)::int AS connector_count,
      (SELECT count(*) FROM connections cn WHERE cn.device_worker_id = dw.id AND cn.deleted_at IS NULL AND cn.status = 'error')::int AS connector_error_count,
      (
        SELECT max(f.last_sync_at) FROM feeds f
        JOIN connections cn ON cn.id = f.connection_id
        WHERE cn.device_worker_id = dw.id AND f.deleted_at IS NULL
      ) AS last_sync_at,
      (
        SELECT coalesce(
          json_agg(
            json_build_object(
              'connection_id', cn.id,
              'connector_key', cn.connector_key,
              'display_name', coalesce(cd.name, cn.connector_key),
              'status', cn.status,
              'organization_slug', cno.slug
            )
            ORDER BY cn.created_at
          ),
          '[]'::json
        )
        FROM connections cn
        LEFT JOIN organization cno ON cno.id = cn.organization_id
        LEFT JOIN LATERAL (
          SELECT name FROM connector_definitions
          WHERE key = cn.connector_key AND status = 'active' AND organization_id = cn.organization_id
          ORDER BY updated_at DESC LIMIT 1
        ) cd ON TRUE
        WHERE cn.device_worker_id = dw.id AND cn.deleted_at IS NULL
      ) AS connectors
    FROM device_workers dw
    LEFT JOIN organization o ON o.id = dw.organization_id
    WHERE dw.user_id = ${userId}
    ORDER BY dw.last_seen_at DESC
  `) as unknown as Array<
    Omit<DeviceWorkerSummary, 'agent_kinds'> & { agent_kinds: string | string[] | null }
  >;

  return rows.map((r) => ({
    ...r,
    capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
    // null (never advertised) is distinct from [] (advertised none): the
    // automation lane leaves the former unrestricted and withholds every run
    // from the latter, so a reader must be able to tell "unknown" from "runs
    // nothing". The driver hands text[] back as a raw '{a,b}' literal, so it
    // needs parsing, not Array.isArray.
    agent_kinds: r.agent_kinds == null ? null : parsePgTextArray(r.agent_kinds),
    connector_count: r.connector_count ?? 0,
    connector_error_count: r.connector_error_count ?? 0,
    connectors: Array.isArray(r.connectors) ? r.connectors : [],
  }));
}

/**
 * GET /api/me/devices
 *
 * Thin transport over `queryDeviceWorkers`. Returns the calling user's
 * registered device workers, each with its surrogate id (used as
 * `device_worker_id` when pinning a connection or an Automation), the workspace
 * the device is attached to, how many connections are pinned to it (and how
 * many of those are erroring), and when its feeds last synced.
 * Requires session / PAT / OAuth authentication (mcpAuth).
 */
export async function listDeviceWorkers(c: Context<{ Bindings: Env }>) {
  const userId = c.var.user?.id;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    return c.json({ devices: await queryDeviceWorkers(userId) });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[listDeviceWorkers] Error');
    captureServerError(c, err, 'listDeviceWorkers', 500);
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * Child PATs expire, so an orphaned or leaked one stops working on its own
 * instead of living until someone revokes it by hand. A device refreshes by
 * re-minting through this endpoint with its stored worker_id (the reuse branch
 * keeps the device identity and revokes the old token). `lobu daemon` does this
 * for itself: on start it re-mints from its cached child PAT once less than a
 * third of that token's life remains. The response includes the replacement's
 * exact expiry so long-running clients can schedule another re-mint before it.
 *
 * Forward-only: legacy children (minted before this shipped) keep their null
 * expiry until they rotate. A retroactive backfill would hard-kill working
 * devices at day 90 — the Mac bridge's chrome children still have no rotation
 * client — an owner decision, not one this change takes.
 */
const CHILD_PAT_EXPIRES_IN_DAYS = 90;
/** Refusal body for both arms of the depth-1 gate (see `mintDeviceChildToken`). */
const CHILD_SELF_MINT_ONLY = {
  error: 'insufficient_scope',
  error_description:
    'a device child token can only re-mint its own worker_id, not mint new device credentials',
} as const;

/**
 * POST /api/me/devices/mint-child-token  { platform, label?, worker_id? }
 *
 * Hand-off path for a first-party device grant to authorize a worker without a
 * second OAuth dance. It supports a Mac app authorizing a packaged daemon, a
 * Mac bridge pairing an Owletto Chrome sibling, or `lobu daemon` authorizing
 * this host from its stored login. The caller's bearer authenticates the user;
 * we mint a PAT in that user's personal org bound to a worker_id — the one the
 * caller asked for, else a fresh uuid — and return both for the device to use
 * as if it had completed device-authorization on its own.
 *
 * The child token carries the same `device_worker:run` scope the regular Mac
 * OAuth flow ends up with. Its stored worker_id binding stops the mint chain at
 * depth 1, while capability authorization at
 * /api/workers/poll still constrains what the child can advertise per its
 * declared `platform` (see @lobu/core/capabilities).
 */
export async function mintDeviceChildToken(c: Context<{ Bindings: Env }>) {
  const userId = c.var.user?.id;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  // The caller must already hold a device-worker bearer — i.e. a session
  // that itself was minted for running on a device (the Mac bridge's
  // signed-in OAuth token, or a previously-issued child PAT). A plain
  // browser/web session shouldn't be allowed to silently escalate into a
  // device worker; if a user wants to pair Chrome from a browser they go
  // through the OAuth device-authorization flow, not this endpoint.
  const callerScopes = c.var.mcpAuthInfo?.scopes ?? [];
  if (!callerScopes.includes('device_worker:run')) {
    return c.json(
      { error: 'insufficient_scope', required: 'device_worker:run' },
      403
    );
  }
  // MCP OAuth clients (Slack, Cursor, …) may receive `device_worker:run` in
  // the token scope string for authorize-request compatibility when they
  // over-request from a cached scopes_supported list. Those tokens are
  // resource-bound to `/mcp` and must not mint sibling device credentials.
  // Real device grants (device-code / lobu login) have no resource audience.
  if (c.var.mcpAuthInfo?.resource) {
    return c.json(
      { error: 'insufficient_scope', required: 'device-bound token without MCP resource' },
      403
    );
  }

  const body = await parseJsonBody<{
    platform?: string;
    label?: string;
    /**
     * Optional: the worker_id the first-party caller wants this device to use.
     * A Mac bridge normally forwards the extension's stored id, while the CLI
     * daemon sends the identity its first-run wizard selected. When the id
     * already belongs to this user on the SAME platform, re-mint the bound PAT
     * and keep the row; when it is new for this user, create that exact identity.
     * A bound child token is still limited to rotating its own existing id.
     */
    worker_id?: string;
  }>(c, 'Invalid or missing JSON body');
  if (body instanceof Response) return body;
  const platform = (body.platform ?? '').trim();
  if (!platform) {
    return c.json({ error: 'platform is required' }, 400);
  }
  // Only known device platforms can mint children — keeps the surface tight.
  // Eligible identities are macos (packaged daemon), chrome-extension (Mac
  // bridge pairing), and headless (server/VM daemon). iOS remains ineligible.
  if (
    (platform !== 'macos' && platform !== 'chrome-extension' && platform !== 'headless') ||
    !isKnownPlatform(platform)
  ) {
    return c.json({ error: `platform '${platform}' is not eligible for child-token mint` }, 400);
  }
  const label = body.label?.toString().trim() || null;
  // The caller's previously-stored worker_id, if it forwarded one. Trimmed;
  // validated against ownership + the requested platform in the reuse branch
  // below. Validate its public worker-id shape before it reaches either the
  // device row or PAT binding.
  const requestedWorkerId = (body.worker_id ?? '').trim();
  if (requestedWorkerId && !DEVICE_WORKER_ID_PATTERN.test(requestedWorkerId)) {
    return c.json(
      {
        error: 'invalid_worker_id',
        error_description:
          'worker_id must be 1-128 characters of letters, digits, dot, underscore, colon, or hyphen',
      },
      400
    );
  }

  // The chain stops at depth 1: a PAT this endpoint minted may ROTATE itself —
  // re-mint its own bound worker_id, which revokes the old PAT in the same
  // transaction — but may not mint credentials for any other device. Only a
  // first-party device grant (Mac bridge OAuth, `lobu login` device-code)
  // pairs new siblings, preventing any new grandchild credential from
  // surviving revocation of its parent device's PAT.
  //
  // This endpoint is the only writer of worker-bound PATs (local-init and the
  // org-token route mint unbound; first-party device grants are OAuth tokens,
  // which carry no workerId), so a bearer bound to a worker_id is an
  // endpoint-minted child. Binding also recognizes every already-issued child;
  // no new scope or token-shape compatibility path is needed.
  const callerBoundWorkerId = c.var.mcpAuthInfo?.workerId ?? null;
  const callerIsMintedChild = callerBoundWorkerId !== null;
  if (callerIsMintedChild && (!requestedWorkerId || requestedWorkerId !== callerBoundWorkerId)) {
    return c.json(CHILD_SELF_MINT_ONLY, 403);
  }

  try {
    const sql = getDb();
    // Device clients (Owletto Chrome extension via the Mac bridge) ALWAYS bind
    // to the user's personal org — never the calling token's org. Personal
    // device data (browser context, captured pages, …) belongs in the user's
    // private workspace; a team org reaches the device by pinning an automation /
    // connection to it (see resolveDeviceClaimableOrgs), not by re-binding the
    // device token. Ignoring `c.var.organizationId` here is what makes a Mac
    // app whose own token is bound to a team org still land Chrome's data in
    // the personal org.
    const personalOrg = await findExistingPersonalOrg(userId, sql);
    const organizationId: string | null = personalOrg?.id ?? null;
    if (!organizationId) {
      return c.json(
        { error: 'personal_org_missing', error_description: 'User has no personal org to bind the device to.' },
        403
      );
    }

    // Identity reuse/creation: an unbound first-party device grant may create
    // the exact requested id (the CLI wizard/session identity) or re-mint it
    // when the same user already owns it on this platform. If the same user has
    // that id on another platform, preserve the established cross-platform
    // isolation by falling back to a fresh UUID. Child PAT callers cannot reach
    // either fresh path because the depth-1 check below requires `reused`.
    let workerId: string;
    let reused = false;
    if (requestedWorkerId) {
      const existing = (await sql`
        SELECT worker_id, platform FROM device_workers
        WHERE user_id = ${userId}
          AND worker_id = ${requestedWorkerId}
        LIMIT 1
      `) as unknown as Array<{ worker_id: string; platform: string | null }>;
      if (existing[0]?.platform === platform) {
        workerId = existing[0].worker_id;
        reused = true;
      } else if (existing.length === 0) {
        workerId = requestedWorkerId;
      } else {
        workerId = crypto.randomUUID();
      }
    } else {
      workerId = crypto.randomUUID();
    }
    // Matching the caller's own worker_id is not enough: the reuse lookup also
    // requires the SAME platform, so a child re-declaring its worker_id under a
    // different platform falls through to a fresh uuid — i.e. a brand-new
    // device credential, exactly what the depth-1 gate refuses. A child's mint
    // must land on the reuse branch or not at all.
    if (callerIsMintedChild && !reused) {
      return c.json(CHILD_SELF_MINT_ONLY, 403);
    }

    // Upsert the device_workers row (exists on reuse, created on first mint).
    // On the reuse path this MUST run inside the same transaction as the PAT
    // mint/revoke (see below) so last_seen_at refresh + new-PAT-visibility
    // commit atomically — otherwise a concurrent reaper could see the reused
    // row still stale (30+ days unseen) and the freshly-minted PAT as already
    // committed, then delete the row and revoke that brand-new PAT. The helper
    // takes the db handle so both paths run the identical statement: a
    // random-id fresh mint passes `sql`, while an exact requested identity
    // passes `tx` whether it is new or reused. Platform is bound once and never
    // changed here (poll's ON CONFLICT preserves it via COALESCE + a
    // SELECT-then-reject check, and the gateway's capability authorization uses
    // the stored platform rather than whatever the bearer self-reports).
    // The label is recorded on insert only: a re-mint carries whatever the
    // client self-reports (a headless daemon sends its hostname), which must
    // not clobber a name the user set on the Devices page — same reason poll's
    // ON CONFLICT leaves it alone. `PATCH /api/me/devices/:id` owns it after
    // first registration.
    const upsertDeviceWorker = (db: typeof sql) => db`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${userId}, ${workerId}, ${platform}, ${db.json([])}, ${label}, ${organizationId})
      ON CONFLICT (user_id, worker_id) DO UPDATE
        SET last_seen_at = NOW()
    `;

    let created: { id: number; token: string; expires_at: Date | null } | null;
    // Any exact requested identity — fresh or reused — takes the same advisory
    // lock and re-checks under it. Without this, two replicas can both observe
    // a new CLI wizard id as absent, mint two live PATs, and only then race the
    // device-row upsert. The second caller must instead observe the first row
    // and take the normal re-mint path that revokes the first PAT.
    if (requestedWorkerId && workerId === requestedWorkerId) {
      created = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:mint-child'), hashtext(${workerId}))`;
        const current = (await tx`
          SELECT platform FROM device_workers
          WHERE user_id = ${userId} AND worker_id = ${workerId}
          LIMIT 1
        `) as unknown as Array<{ platform: string | null }>;
        reused = current[0]?.platform === platform;
        // Re-check the depth-1 boundary after acquiring the identity lock. A
        // device row can be deleted between the optimistic lookup above and
        // this transaction; a child whose own row disappeared must not recreate
        // it as though it were an unbound first-party login.
        if (callerIsMintedChild && !reused) return null;
        // The optimistic lookup's third case can also land here: another
        // registration may have claimed this id for a DIFFERENT platform while
        // we waited on the lock. The upsert below only refreshes last_seen_at,
        // so reusing the id would bind this platform's PAT to a row whose
        // stored platform is the other one — the exact confusion the
        // cross-platform fallback exists to prevent. Take a fresh uuid instead.
        if (current.length > 0 && !reused) workerId = crypto.randomUUID();
        // Refresh last_seen_at in the SAME transaction so the reaper can never
        // observe a committed, valid PAT bound to a still-stale reused row. Do
        // this BEFORE the PAT mint/revoke so this tx acquires the device_workers
        // row lock before any personal_access_tokens row locks — the same
        // lock order the reaper uses (DELETE device_workers → UPDATE PATs),
        // which avoids a cross-transaction deadlock when both touch the same
        // stale reused device at once.
        await upsertDeviceWorker(tx);
        const minted = await new PersonalAccessTokenService(tx).create(
          userId,
          organizationId,
          `device:${platform}:${workerId.slice(0, 8)}`,
          {
            scope: 'device_worker:run',
            description: label ?? undefined,
            workerId,
            expiresInDays: CHILD_PAT_EXPIRES_IN_DAYS,
          }
        );
        // Revoke on EVERY exact-identity path, not just the reuse one: a device
        // deleted from the Devices page drops its `device_workers` row without
        // revoking the PAT bound to that worker_id, so re-registering the same
        // id would otherwise leave two live credentials polling as one device.
        // When the cross-platform fallback above swapped in a fresh uuid this
        // matches nothing, which is exactly right.
        await tx`
          UPDATE personal_access_tokens
          SET revoked_at = NOW(), updated_at = NOW()
          WHERE user_id = ${userId}
            AND worker_id = ${workerId}
            AND id <> ${minted.id}
            AND revoked_at IS NULL
        `;
        return minted;
      });
    } else {
      created = await new PersonalAccessTokenService(sql).create(
        userId,
        organizationId,
        `device:${platform}:${workerId.slice(0, 8)}`,
        {
          scope: 'device_worker:run',
          description: label ?? undefined,
          workerId,
          expiresInDays: CHILD_PAT_EXPIRES_IN_DAYS,
        }
      );
      // Fresh row — no staleness to race against, so the upsert runs outside a
      // transaction (the INSERT sets last_seen_at = NOW() via the column default).
      await upsertDeviceWorker(sql);
    }
    if (!created) {
      return c.json(CHILD_SELF_MINT_ONLY, 403);
    }

    // Also mint a Better Auth session token for a Chrome sibling. Its iframe
    // needs a session cookie (not a PAT) to land signed-in; the extension
    // installs this via /api/exchange-token. A headless daemon has no iframe,
    // so minting a browser session for every daemon start would create an
    // unused credential.
    let sessionToken: string | null = null;
    if (platform === 'chrome-extension') {
      try {
        const auth = await createAuth(c.env, c.req.raw);
        const ctx = await auth.$context;
        const session = await ctx.internalAdapter.createSession(userId);
        sessionToken = session?.token ?? null;
      } catch (err) {
        // Session mint is best-effort — child PAT is the primary credential.
        // Falling back to no session_token means the iframe shows sign-in,
        // matching pre-existing semantics for siblings that haven't adopted
        // the handoff.
        logger.warn(
          { err: errorMessage(err), userId },
          '[mintDeviceChildToken] session mint failed; returning child PAT only'
        );
      }
    }

    const gatewayUrl = resolvePublicOrigin(c.req.url);
    if (reused) {
      logger.info(
        { userId, workerId, platform },
        '[mintDeviceChildToken] reused existing device identity on re-pair'
      );
    }
    return c.json({
      worker_id: workerId,
      access_token: created.token,
      // The child PAT's hard expiry, so a caller that stores the token can tell
      // when it must re-mint rather than discovering it as a 401 on poll.
      expires_at: created.expires_at?.toISOString() ?? null,
      session_token: sessionToken,
      gateway_url: gatewayUrl,
      label,
      platform,
    });
  } catch (err) {
    logger.error({ err: errorMessage(err) }, '[mintDeviceChildToken] failed');
    captureServerError(c, err, 'mintDeviceChildToken', 500);
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/** Max length for a user-set device display name. */
const DEVICE_LABEL_MAX_LEN = 80;

/**
 * PATCH /api/me/devices/:id  { organization_id?, label? }
 *
 * Update one of the caller's devices. At least one field is required:
 *
 *  - `label` — human display name (Devices page). Empty/null clears it so the
 *    UI falls back to the platform label ("Chrome", "Mac", …). Poll heartbeats
 *    never overwrite a stored label — it is recorded at first registration (or
 *    child-token mint) and after that changes only through this endpoint, so a
 *    user-set name sticks even against a headless daemon that reports its
 *    hostname as `label` on every poll.
 *  - `organization_id` — re-attach to a different workspace the caller belongs
 *    to. Moving un-pins and pauses the connections (and their feeds) it backed
 *    in the previous workspace.
 */
export async function updateDeviceWorkerOrg(c: Context<{ Bindings: Env }>) {
  const userId = c.var.user?.id;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const deviceWorkerId = (c.req.param('id') ?? '').trim();
  if (!deviceWorkerId) {
    return c.json({ error: 'device id is required' }, 400);
  }
  let body: { organization_id?: string | null; label?: string | null };
  try {
    body = await c.req.json<{ organization_id?: string | null; label?: string | null }>();
  } catch {
    return c.json({ error: 'Invalid or missing JSON body' }, 400);
  }

  const hasOrg = Object.hasOwn(body, 'organization_id');
  const hasLabel = Object.hasOwn(body, 'label');
  if (!hasOrg && !hasLabel) {
    return c.json(
      { error: 'Provide organization_id and/or label to update' },
      400
    );
  }

  const organizationId = hasOrg
    ? (body.organization_id ?? '').toString().trim()
    : null;
  if (hasOrg && !organizationId) {
    return c.json({ error: 'organization_id must not be empty' }, 400);
  }

  // Normalize label: trim; empty string / null → clear (store NULL). Cap length.
  let nextLabel: string | null | undefined;
  if (hasLabel) {
    if (body.label == null) {
      nextLabel = null;
    } else if (typeof body.label !== 'string') {
      return c.json({ error: 'label must be a string or null' }, 400);
    } else {
      const trimmed = body.label.trim();
      if (trimmed.length === 0) {
        nextLabel = null;
      } else if (trimmed.length > DEVICE_LABEL_MAX_LEN) {
        return c.json(
          { error: `label must be at most ${DEVICE_LABEL_MAX_LEN} characters` },
          400
        );
      } else {
        nextLabel = trimmed;
      }
    }
  }

  try {
    const sql = getDb();

    if (organizationId) {
      const role = await getWorkspaceRole(sql, organizationId, userId);
      if (!role) {
        return c.json({ error: 'You are not a member of that workspace' }, 403);
      }
    }

    const updated = await sql.begin(async (tx) => {
      const owned = (await tx`
        SELECT organization_id FROM device_workers WHERE id = ${deviceWorkerId} AND user_id = ${userId} LIMIT 1
      `) as unknown as Array<{ organization_id: string | null }>;
      if (owned.length === 0) return false;

      if (organizationId && owned[0].organization_id !== organizationId) {
        const affected = (await tx`
          UPDATE connections
          SET device_worker_id = NULL,
              status = 'paused',
              error_message = ${DEVICE_MOVED_TOMBSTONE},
              updated_at = NOW()
          WHERE device_worker_id = ${deviceWorkerId}
          RETURNING id
        `) as unknown as Array<{ id: number }>;
        const ids = affected.map((r) => r.id);
        if (ids.length > 0) {
          await tx`
            UPDATE feeds SET status = 'paused', updated_at = NOW()
            WHERE connection_id = ANY(${pgBigintArray(ids)}::bigint[]) AND deleted_at IS NULL AND status = 'active'
          `;
        }
        await tx`UPDATE device_workers SET organization_id = ${organizationId} WHERE id = ${deviceWorkerId}`;
      }

      if (hasLabel) {
        await tx`
          UPDATE device_workers
          SET label = ${nextLabel ?? null}
          WHERE id = ${deviceWorkerId} AND user_id = ${userId}
        `;
      }
      return true;
    });
    if (!updated) {
      return c.json({ error: 'Device not found or not owned by you' }, 404);
    }
    return c.json({ ok: true, ...(hasLabel ? { label: nextLabel ?? null } : {}) });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[updateDeviceWorkerOrg] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}

/**
 * DELETE /api/me/devices/:id
 *
 * Permanently forgets one of the caller's registered devices. Refused with a
 * 409 (listing the blockers) while active Automations are pinned to the device;
 * archived Automations are un-pinned. Connections pinned to it are un-pinned and
 * paused — they can't run anywhere without the device — and their active feeds
 * are paused. If the device app is still running it re-registers on its next
 * heartbeat as a fresh device.
 */
export async function deleteDeviceWorker(c: Context<{ Bindings: Env }>) {
  const userId = c.var.user?.id;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const deviceWorkerId = (c.req.param('id') ?? '').trim();
  if (!deviceWorkerId) {
    return c.json({ error: 'device id is required' }, 400);
  }
  try {
    const sql = getDb();
    const result = await sql.begin(async (tx) => {
      const owned = (await tx`
        SELECT organization_id, label, worker_id FROM device_workers
        WHERE id = ${deviceWorkerId} AND user_id = ${userId}
        LIMIT 1
        FOR UPDATE
      `) as unknown as Array<{
        organization_id: string | null;
        label: string | null;
        worker_id: string;
      }>;
      if (owned.length === 0) return { kind: 'not_found' } as const;

      const automations = (await tx`
        SELECT w.id::text AS automation_id, w.name, o.slug AS organization_slug
        FROM automations w
        JOIN organization o ON o.id = w.organization_id
        WHERE w.device_worker_id = ${deviceWorkerId}
          AND w.status = 'active'
        ORDER BY w.id
      `) as unknown as Array<{
        automation_id: string;
        name: string;
        organization_slug: string;
      }>;
      if (automations.length > 0) {
        return { kind: 'conflict', automations } as const;
      }

      // Archival is the supported soft-delete for Automations. Archived rows are
      // retained for history, but no longer execute and must not keep the
      // restrictive FK alive after the user explicitly archives them.
      await tx`
        UPDATE automations
        SET device_worker_id = NULL, updated_at = NOW()
        WHERE device_worker_id = ${deviceWorkerId}
          AND status = 'archived'
      `;
      // Un-pin and pause every connection backed by this device — a device
      // connector can't run anywhere without it; the owner re-pins to a new
      // device (or removes the connection) to bring it back.
      const affected = (await tx`
        UPDATE connections
        SET device_worker_id = NULL,
            status = 'paused',
            error_message = ${DEVICE_REMOVED_TOMBSTONE},
            updated_at = NOW()
        WHERE device_worker_id = ${deviceWorkerId}
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      const ids = affected.map((r) => r.id);
      if (ids.length > 0) {
        await tx`
          UPDATE feeds SET status = 'paused', updated_at = NOW()
          WHERE connection_id = ANY(${pgBigintArray(ids)}::bigint[]) AND deleted_at IS NULL AND status = 'active'
        `;
      }
      await tx`DELETE FROM device_workers WHERE id = ${deviceWorkerId} AND user_id = ${userId}`;
      return { kind: 'deleted', device: owned[0] } as const;
    });
    if (result.kind === 'not_found') {
      return c.json({ error: 'Device not found or not owned by you' }, 404);
    }
    if (result.kind === 'conflict') {
      const baseUrl = getPublicWebUrl(c.req.url);
      return c.json(
        {
          error:
            'Device is pinned by active Automations. Reassign or archive the listed Automations, then retry device deletion.',
          automations: result.automations.map((automation) => ({
            ...automation,
            view_url: buildAutomationUrl(
              automation.organization_slug,
              automation.automation_id,
              baseUrl
            ),
          })),
        },
        409
      );
    }
    if (result.device.organization_id) {
      recordLifecycleEvent({
        organizationId: result.device.organization_id,
        entityType: 'device',
        op: 'deleted',
        entityId: deviceWorkerId,
        summary: `Device "${result.device.label ?? result.device.worker_id}" removed`,
      });
    }
    return c.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ error: errorMessage(err) }, '[deleteDeviceWorker] Error');
    return c.json({ error: errorMessage(err) }, 500);
  }
}
