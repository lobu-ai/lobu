import type { ConnectionSetupOptionsInput } from '@lobu/core/contracts/tools/manage-connections';
import type { ToolContext } from '../../../registry';
import { connectionSetupOptions, type SetupOptionsDeps } from '../../../../connect/setup-options';
import { resolveBaseUrl, safeOrigin } from '../../../../auth/base-url';

export async function handleSetupOptions(
  args: ConnectionSetupOptionsInput,
  ctx: ToolContext,
  deps?: Partial<SetupOptionsDeps>
) {
  return connectionSetupOptions(
    args.connector_key,
    ctx.organizationId,
    safeOrigin(ctx.baseUrl) ?? resolveBaseUrl({ url: ctx.requestUrl }),
    deps
  );
}
