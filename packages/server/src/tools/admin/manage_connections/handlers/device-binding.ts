/**
 * Shared helpers for device-worker binding resolution and managed-connector detection.
 */

import { getDb } from '../../../../db/client';
import { getPrimaryAuthProfileForKind } from '../../../../utils/auth-profiles';
import {
  DEVICE_WORKER_FRESH_INTERVAL,
  describeDeviceLastSeen,
} from '../../../../utils/device-liveness';
import type { ScopedConnectorDefinitionRow } from '../../../../catalog/connector-definitions';

// ============================================
// Managed-connector detection (public-org delegation)
// ============================================

/**
 * Is this connect happening against a MANAGED connector in a PUBLIC org?
 *
 * Managed connectors live in a `visibility='public'` org with a managed
 * org-level `oauth_app` profile (the client secret stays in the cloud). When a
 * member connects one here, the resulting connection must be CONSENT-ONLY: it
 * holds the OAuth grant for delegation (the local instance fetches a fresh
 * access token at runtime via /oauth/connection-token) but has NO feeds, so the
 * cloud never syncs a copy — the managed connector's data lives only on the
 * member's local instance.
 *
 * Signal (the cleanest available, no new schema): the org is public AND the
 * connector resolves to an org-level managed `oauth_app` profile for the OAuth
 * method's provider. We only mark consent-only on the OAuth path — env-key /
 * browser connectors aren't delegated this way.
 */
export async function isManagedPublicOrgConnect(params: {
  organizationId: string;
  connectorKey: string;
  provider: string;
}): Promise<boolean> {
  const sql = getDb();
  const orgRows = (await sql`
    SELECT visibility FROM "organization" WHERE id = ${params.organizationId} LIMIT 1
  `) as unknown as Array<{ visibility: string | null }>;
  if (orgRows[0]?.visibility !== 'public') return false;

  const managedApp = await getPrimaryAuthProfileForKind({
    organizationId: params.organizationId,
    connectorKey: params.connectorKey,
    profileKind: 'oauth_app',
    provider: params.provider,
  });
  return !!managedApp && managedApp.status === 'active';
}

// ============================================
// Device-worker binding resolution
// ============================================

/**
 * Validate + normalize a connection's device-worker binding (the "Run on"
 * target). Returns the resolved id (or `null` = serverless, in the Lobu server) or an error string.
 *
 *  - A connector that declares `required_capability` MUST be pinned to a device,
 *    and that device must currently advertise the capability.
 *  - Any other connector may optionally be pinned to a device (run-on-device).
 *  - The requester may only pin a device they own, and only into the workspace
 *    that device is attached to (device_workers.organization_id).
 *  - The device must still be in the fleet freshness window. Every gate here
 *    answers "can this device actually serve this connector", and a device the
 *    fleet no longer contains cannot — see the freshness check below.
 */
export async function resolveDeviceBinding(params: {
  organizationId: string;
  userId: string | null | undefined;
  connector: ScopedConnectorDefinitionRow;
  deviceWorkerId: string | null | undefined;
  /**
   * The connection's CURRENT pin, when re-validating an existing connection
   * (`update`). Re-sending the pin the connection already has is not a
   * placement change, so the freshness gate does not apply to it — see below.
   * Ownership, workspace and capability are still re-checked.
   */
  currentDeviceWorkerId?: string | null;
}): Promise<{ error: string } | { deviceWorkerId: string | null }> {
  const sql = getDb();
  const requiredCapability = params.connector.required_capability ?? null;
  const deviceWorkerId = params.deviceWorkerId?.trim() || null;

  if (!deviceWorkerId) {
    if (requiredCapability) {
      return {
        error: `Connector '${params.connector.key}' runs on a device — pass device_worker_id for one of your devices attached to this workspace that advertises the '${requiredCapability}' permission.`,
      };
    }
    return { deviceWorkerId: null };
  }

  const rows = (await sql`
    SELECT dw.id, dw.user_id, dw.capabilities, dw.label, dw.organization_id,
           dw.last_seen_at, now() AS db_now,
           dw.last_seen_at > now() - ${DEVICE_WORKER_FRESH_INTERVAL}::interval AS fresh
    FROM device_workers dw
    WHERE dw.id = ${deviceWorkerId}
    LIMIT 1
  `) as unknown as Array<{
    id: string;
    user_id: string;
    capabilities: unknown;
    label: string | null;
    organization_id: string | null;
    // `device_workers.last_seen_at` is NOT NULL; `fresh` is computed from it.
    last_seen_at: Date | string;
    // Postgres' clock, so the age in the message agrees with the `fresh` verdict.
    db_now: Date | string;
    fresh: boolean;
  }>;
  const device = rows[0];
  if (!device) {
    return { error: `Device worker '${deviceWorkerId}' not found.` };
  }
  if (!params.userId || device.user_id !== params.userId) {
    return { error: `You can only pin a device you own.` };
  }
  if (device.organization_id !== params.organizationId) {
    return {
      error: `Device '${device.label ?? deviceWorkerId}' isn't attached to this workspace. Re-attach it from Connect › Runtime first.`,
    };
  }

  if (requiredCapability) {
    const caps = Array.isArray(device.capabilities) ? (device.capabilities as string[]) : [];
    if (!caps.includes(requiredCapability)) {
      return {
        error: `Device '${device.label ?? deviceWorkerId}' hasn't granted the '${requiredCapability}' permission required by '${params.connector.key}'.`,
      };
    }
  }

  // Freshness is the last gate, so the more specific "not yours" / "wrong
  // workspace" / "permission not granted" answers win when several apply.
  //
  // A device outside the fleet window is one every execution path already
  // treats as absent: it is not in the capability set reconcile computes, the
  // poll's unpinned lane cannot match it, and no run pinned to it will ever be
  // claimed. Accepting the write anyway produced the #3212 report — success
  // returned, the device echoed back as applied, and the only later signal a
  // run that silently never starts. Freshness is knowable here, for the same
  // reason the capability check is, so it is answered here.
  //
  // This is the 7-day fleet window, NOT the 120s "online" one: a pin is
  // placement rather than a liveness claim, and a laptop closed for the
  // weekend must stay pinnable — reconcile is separately required to preserve
  // its placement across exactly that interval.
  //
  // Only a placement CHANGE is gated. An `update` that round-trips the pin the
  // connection already holds (read-modify-write of the whole row, or a rename
  // sent alongside the unchanged `device_worker_id`) is not asking to place
  // anything, and rejecting it would fail the unrelated edit for a device that
  // reconcile is about to repair anyway.
  // Compared on `device.id`, the canonical value postgres returned for this
  // row, not the caller's raw string: postgres normalizes uuids and compares
  // them case-insensitively, so a differently-cased id selects this same device
  // and clears every gate above. Comparing the raw string would disagree with
  // the database about identity and reject a round-trip that moved nothing.
  const unchangedPin = device.id === (params.currentDeviceWorkerId ?? null);
  if (!device.fresh && !unchangedPin) {
    const dbNow = device.db_now instanceof Date ? device.db_now : new Date(device.db_now);
    return {
      error: `Device '${device.label ?? deviceWorkerId}' is offline — it ${describeDeviceLastSeen(device.last_seen_at, dbNow)} and hasn't been seen in the last ${DEVICE_WORKER_FRESH_INTERVAL}, so a run pinned to it would never be claimed. Bring it back online, or pin a device that has checked in within the last ${DEVICE_WORKER_FRESH_INTERVAL}.`,
    };
  }

  // The canonical id, so the value echoed back matches the one stored.
  return { deviceWorkerId: device.id };
}
