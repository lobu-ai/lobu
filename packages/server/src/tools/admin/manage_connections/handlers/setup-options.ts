import type { ConnectionSetupOptionsInput } from '@lobu/core/contracts/tools/manage-connections';
import type { ToolContext } from '../../../registry';
import { connectionSetupOptions } from '../../../../connect/setup-options';
import { resolveBaseUrl } from '../../../../auth/base-url';

export async function handleSetupOptions(args: ConnectionSetupOptionsInput, ctx: ToolContext) {
  return connectionSetupOptions(args.connector_key, ctx.organizationId, new URL(ctx.baseUrl || ctx.requestUrl || resolveBaseUrl()).origin);
}
