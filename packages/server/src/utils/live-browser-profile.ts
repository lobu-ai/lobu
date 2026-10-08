import { getDb, type DbClient } from '../db/client';
import { createAuthProfile, type AuthProfileRow } from './auth-profiles';

export interface LiveBrowserProfileParams {
  organizationId: string; connectorKey: string; deviceWorkerId: string; userId: string | null | undefined;
}

export async function findLiveBrowserProfile(params: LiveBrowserProfileParams, sql = getDb()): Promise<AuthProfileRow | null> {
  const [existing] = await sql`SELECT * FROM auth_profiles WHERE organization_id = ${params.organizationId}
    AND connector_key = ${params.connectorKey} AND profile_kind = 'browser_session'
    AND created_by = ${params.userId ?? null} AND device_worker_id = ${params.deviceWorkerId}::uuid
    AND auth_data->>'mode' = 'live' AND status <> 'revoked' ORDER BY id LIMIT 1`;
  return existing as AuthProfileRow ?? null;
}

/** One live account profile per owner, connector and paired Chrome profile.
 * When binding a connection, use its transaction so rejected writes leave no profile.
 */
export async function ensureLiveBrowserProfile(params: LiveBrowserProfileParams, transaction?: DbClient): Promise<AuthProfileRow> {
  const provision = async (tx: DbClient) => {
    const [device] = await tx`SELECT id FROM device_workers WHERE id = ${params.deviceWorkerId}::uuid
      AND organization_id = ${params.organizationId} AND user_id = ${params.userId ?? null}
      AND platform = 'chrome-extension' AND capabilities @> '["browser.debugger"]'::jsonb FOR UPDATE`;
    if (!device) throw new Error('Choose your own paired Chrome browser with browser access enabled.');
    const existing = await findLiveBrowserProfile(params, tx);
    if (existing) return existing;
    return createAuthProfile({ organizationId: params.organizationId, connectorKey: params.connectorKey,
      displayName: `${params.connectorKey} browser account`, profileKind: 'browser_session',
      authData: { mode: 'live' }, status: 'pending_auth', createdBy: params.userId,
      deviceWorkerId: params.deviceWorkerId, browserKind: 'chrome' }, tx);
  };
  return transaction ? provision(transaction) : getDb().begin(provision);
}
