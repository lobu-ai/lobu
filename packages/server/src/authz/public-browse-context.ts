/**
 * The one projection for reading a public workspace from outside it.
 *
 * Reading another workspace's public records never carries a capability from
 * the caller's own workspace: no member role, no cross-workspace grant, no
 * search federation. Two shapes share that rule:
 *
 * - {@link publicBrowseContext} keeps the caller's identity (path browse by a
 *   signed-in non-member).
 * - {@link publicVisitorContext} is a stranger: anonymous, no chat tier, no
 *   private connection, and device-pinned sources are refused
 *   (`chatAccessOfToolContext` maps `anonymous` to `public_visitor`). Public
 *   pages and foreign source-record reads use it, so an owner of the public
 *   workspace reads it exactly like anyone else when acting from another one.
 */
import { SCOPE_CHECK_NOT_APPLICABLE } from '../auth/tool-access';
import type { AccountToolContext, ToolContext } from '../tools/registry';

export function publicBrowseContext(ctx: AccountToolContext, organizationId: string): ToolContext {
  return {
    ...ctx,
    organizationId,
    memberRole: null,
    allowCrossOrg: false,
    grantedOrganizationIds: ctx.tokenType === 'oauth' ? [] : null,
    directSearchFederation: false,
  };
}

export function publicVisitorContext(
  organizationId: string,
  request: Pick<ToolContext, 'requestUrl' | 'baseUrl' | 'abortSignal'>,
): ToolContext {
  return {
    organizationId,
    // No chat turn behind this call (authz/device-access.ts).
    sourceContext: null,
    userId: null,
    memberRole: null,
    isAuthenticated: false,
    tokenType: 'anonymous',
    // Anonymous public readers carry no MCP scope dimension: they are gated by
    // org scoping and public-readability filters, not by mcp:read.
    scopes: [...SCOPE_CHECK_NOT_APPLICABLE],
    scopedToOrg: true,
    allowCrossOrg: false,
    grantedOrganizationIds: null,
    directSearchFederation: false,
    requestUrl: request.requestUrl,
    baseUrl: request.baseUrl,
    ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
  };
}
