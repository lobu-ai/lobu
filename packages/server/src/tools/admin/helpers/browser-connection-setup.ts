import type { ScopedConnectorDefinitionRow } from '../../../catalog/connector-definitions';
import type { AuthProfileRow } from '../../../utils/auth-profiles';
import type { ToolContext } from '../../registry';
import { selectedBrowserRequirement } from '../../../connectors/browser-resource';
import { resolveDeviceBinding } from '../manage_connections/handlers/device-binding';
import { buildConnectionSetupContinuation } from './connect-setup-continuation';

/** Shared by create and connect; a saved row cannot bypass the dependency. */
export async function checkBrowserConnectionSetup(params: {
  action: 'create' | 'connect'; connector: ScopedConnectorDefinitionRow;
  profile?: AuthProfileRow | null; deviceWorkerId?: string | null; ctx: ToolContext; setupUrl?: string;
}) {
  const browser = selectedBrowserRequirement(params.connector.browser, params.connector.auth_schema, params.profile?.profile_kind);
  if (!browser) return null;
  const deviceId = params.profile?.device_worker_id ?? params.deviceWorkerId;
  if (!deviceId) return buildConnectionSetupContinuation({ action: params.action,
    connectorKey: params.connector.key, setupFamily: 'browser', nextAction: 'pair_browser', setupUrl: params.setupUrl,
    instructions: 'Pair and choose a Chrome browser for this connection, then retry setup.' });
  const binding = await resolveDeviceBinding({ organizationId: params.ctx.organizationId,
    userId: params.ctx.userId, connector: params.connector, deviceWorkerId: deviceId, browser: true });
  if ('error' in binding) return binding;
  if (browser.accountProbe && params.profile && params.profile.auth_data?.mode !== 'live') {
    return { error: 'This connector requires a live browser account. Choose a Chrome browser instead of a captured-cookie profile.' };
  }
  return null;
}
