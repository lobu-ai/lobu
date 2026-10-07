import { DEVICE_ONLINE_WINDOW_SECONDS } from '../utils/device-liveness';
import { browserAuthMethod, resolveBrowserRequirement, type ConnectorBrowserRequirement } from '@lobu/connector-sdk';
import { getDb, type DbClient } from '../db/client';
import { compareSemverish } from '../worker-api/device-manifests';

export const BROWSER_EXTENSION_UPDATE_REQUIRED = 'Update the Lobu Chrome extension to version 0.9.2 or newer, then reload it and retry setup.';
export function browserExtensionSupportsOrigins(version: string | null | undefined): boolean {
  return !!version && compareSemverish(version, '0.9.2') >= 0;
}

export function selectedBrowserRequirement(browser: unknown, authSchema: unknown, profileKind?: string | null, browserSelected = false): ConnectorBrowserRequirement | null {
  const methods = (authSchema as { methods?: Array<{ type: string; mode?: string }> } | null)?.methods ?? [];
  const mode = profileKind ? browserAuthMethod(profileKind)
    : methods.some(method => method.type === 'browser' && method.mode === 'live') &&
      (methods.length === 1 || (browserSelected && !methods.some(method => method.type === 'none'))) ? 'browser' : 'none';
  return resolveBrowserRequirement(browser, mode);
}

/** Read the saved connection, never guest config or a caller-supplied browser id. */
export async function connectionBrowserResource(organizationId: string, connectionId: number | null | undefined, connectorVersion?: string | null, sql: DbClient = getDb()) {
  if (connectionId == null) return null;
  const [row] = await sql`
    SELECT cd.browser, cd.auth_schema, ap.profile_kind, ap.auth_data, ap.auth_data->>'account_id' AS browser_account_id,
           ap.status AS profile_status, ap.id AS auth_profile_id, ap.device_worker_id AS profile_device_id,
           c.device_worker_id, c.created_by, c.status, dw.platform, dw.app_version,
           dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS}) AS online
    FROM connections c
    JOIN connector_definitions cd ON cd.organization_id = c.organization_id
      AND cd.key = c.connector_key AND cd.status = 'active'
      AND (${connectorVersion ?? null}::text IS NULL OR cd.version = ${connectorVersion ?? null})
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id AND ap.organization_id = c.organization_id
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id AND dw.organization_id = c.organization_id
    WHERE c.id = ${connectionId} AND c.organization_id = ${organizationId} AND c.deleted_at IS NULL
    LIMIT 1
  `;
  if (!row) return null;
  const requirement = selectedBrowserRequirement(row.browser, row.auth_schema, row.profile_kind, !!row.device_worker_id);
  if (!requirement) return null;
  return { requirement, deviceWorkerId: row.platform === 'chrome-extension' ? row.device_worker_id as string : null,
    profileDeviceId: row.profile_device_id as string | null, authProfileId: row.auth_profile_id as number | null,
    accountId: row.browser_account_id as string | null, online: row.online === true, status: row.status as string,
    supportsScopedOrigins: browserExtensionSupportsOrigins(row.app_version as string | null),
    profileStatus: row.profile_status as string | null,
    live: row.profile_kind === 'browser_session' && row.auth_data?.mode === 'live' };
}

export async function connectionBrowserGrant(organizationId: string, connectionId: number | null | undefined, connectorVersion?: string | null) {
  return (await connectionBrowserResource(organizationId, connectionId, connectorVersion))?.requirement ?? undefined;
}

/** The queued run keeps the exact account binding the requester selected. */
export function browserBindingSnapshot(resource: NonNullable<Awaited<ReturnType<typeof connectionBrowserResource>>>) {
  return { device_worker_id: resource.deviceWorkerId, auth_profile_id: resource.authProfileId, account_id: resource.accountId };
}

/** An upgraded definition must not leave old, unbound connections claiming readiness. */
export async function reconcileBrowserConnections(organizationId: string, connectorKey: string, sql: DbClient) {
  const rows = await sql`SELECT c.id, c.auth_profile_id, cd.auth_schema FROM connections c
    JOIN connector_definitions cd ON cd.organization_id = c.organization_id AND cd.key = c.connector_key AND cd.status = 'active'
    WHERE c.organization_id = ${organizationId} AND c.connector_key = ${connectorKey}
      AND c.status = 'active' AND c.deleted_at IS NULL AND cd.browser IS NOT NULL`;
  for (const row of rows) {
    const browser = await connectionBrowserResource(organizationId, Number(row.id), null, sql);
    const methods = (row.auth_schema?.methods ?? []) as Array<{type: string}>;
    const missingAuth = !row.auth_profile_id && methods.length > 0 && !methods.some(method => method.type === 'none');
    const missingBinding = browser && (!browser.deviceWorkerId || (browser.requirement.accountProbe &&
      (!browser.live || !browser.accountId || browser.profileStatus !== 'active' || browser.profileDeviceId !== browser.deviceWorkerId)));
    if (missingAuth || missingBinding) {
      await sql`UPDATE connections SET status = 'pending_auth', updated_at = now()
        WHERE organization_id = ${organizationId} AND id = ${row.id} AND status = 'active'`;
    }
  }
}
