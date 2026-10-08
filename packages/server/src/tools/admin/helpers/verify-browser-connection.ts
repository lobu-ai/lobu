import { BROWSER_VERIFY_OPERATION } from '@lobu/connector-sdk';
import type { Env } from '../../../index';
import type { ToolContext } from '../../registry';
import { handleExecute } from '../manage_operations/handlers/execute';
import { buildConnectionSetupContinuation } from './connect-setup-continuation';

/** Setup and retry use the same policy-governed operation as an explicit account check. */
export async function verifyBrowserConnection(connectionId: number, ctx: ToolContext) {
  return handleExecute({ action: 'execute', connection_id: connectionId,
    operation_key: BROWSER_VERIFY_OPERATION, input: {} }, ctx, {} as Env);
}

export async function completeBrowserConnectionSetup(params: {
  action: 'create' | 'connect'; connectionId: number; connectorKey: string; slug: string;
  setupUrl?: string; ctx: ToolContext;
}) {
  const result = await verifyBrowserConnection(params.connectionId, params.ctx);
  if ('status' in result && result.status === 'completed') return null;
  const message = 'error' in result ? String(result.error) : 'error_message' in result && result.error_message
    ? String(result.error_message) : 'Complete the browser verification operation, then retry the account check.';
  return buildConnectionSetupContinuation({ action: params.action, connectorKey: params.connectorKey,
    connectionId: params.connectionId, slug: params.slug, setupFamily: 'browser', nextAction: 'open_setup',
    setupUrl: params.setupUrl, instructions: message,
    resumeCall: { sdk_method: 'operations.execute', arguments: [{ connection_id: params.connectionId,
      operation_key: BROWSER_VERIFY_OPERATION, input: {} }] } });
}
