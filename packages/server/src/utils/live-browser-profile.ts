import { getDb } from '../db/client';
import { createAuthProfile, type AuthProfileRow } from './auth-profiles';

/** One live account profile per owner, connector and paired Chrome profile. */
export async function ensureLiveBrowserProfile(params: {
  organizationId: string; connectorKey: string; deviceWorkerId: string; userId: string | null | undefined;
}): Promise<AuthProfileRow> {
  const sql = getDb();
  return sql.begin(async tx => {
    const [device] = await tx`SELECT id FROM device_workers WHERE id = ${params.deviceWorkerId}::uuid
      AND organization_id = ${params.organizationId} AND user_id = ${params.userId ?? null}
      AND platform = 'chrome-extension' AND capabilities @> '["browser.debugger"]'::jsonb FOR UPDATE`;
    if (!device) throw new Error('Choose your own paired Chrome browser with browser access enabled.');
    const [existing] = await tx`SELECT * FROM auth_profiles WHERE organization_id = ${params.organizationId}
      AND connector_key = ${params.connectorKey} AND profile_kind = 'browser_session'
      AND created_by = ${params.userId ?? null} AND device_worker_id = ${params.deviceWorkerId}::uuid
      AND auth_data->>'mode' = 'live' AND status <> 'revoked' ORDER BY id LIMIT 1`;
    if (existing) return existing as AuthProfileRow;
    return createAuthProfile({ organizationId: params.organizationId, connectorKey: params.connectorKey,
      displayName: `${params.connectorKey} browser account`, profileKind: 'browser_session',
      authData: { mode: 'live' }, status: 'pending_auth', createdBy: params.userId,
      deviceWorkerId: params.deviceWorkerId, browserKind: 'chrome' }, tx);
  });
}
