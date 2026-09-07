/**
 * Tool: list_organizations
 *
 * Discovery for the orgs the authenticated user belongs to (and any public
 * workspaces the session can read). Exposed on both unscoped /mcp and
 * scoped /mcp/{slug} endpoints. The response marks the token's bound org
 * with `is_current: true`; an unselected account client has no current workspace.
 *
 * Cross-org reads from inside `query_sdk` / `run_sdk` go through `client.org(slug)`;
 * scoped connections retain their explicit /mcp/{slug} binding.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { Env } from '../index';
import { getWorkspaceProvider } from '../workspace';
import type { OrgInfo } from '../workspace/types';
import { withValidatedArgs } from './validate-args';
import { listLiveGrantedMemberWorkspaces } from '../auth/oauth/workspace-grants';

export const ListOrganizationsSchema = Type.Object({
  search: Type.Optional(
    Type.String({ description: 'Filter organizations by name (case-insensitive substring match)' })
  ),
});

export const listOrganizations = withValidatedArgs(
  'list_organizations',
  ListOrganizationsSchema,
  listOrganizationsImpl
);

async function listOrganizationsImpl(
  args: Static<typeof ListOrganizationsSchema>,
  _env: Env,
  ctx: {
    userId: string;
    currentOrganizationId: string | null;
    grantedOrganizationIds: string[] | null;
  }
): Promise<unknown> {
  const provider = getWorkspaceProvider();
  const orgs = await provider.listOrganizations(args.search, ctx.userId);
  const allowedIds =
    ctx.grantedOrganizationIds !== null
      ? new Set(
          (
            await listLiveGrantedMemberWorkspaces({
              userId: ctx.userId,
              grantedOrganizationIds: ctx.grantedOrganizationIds,
            })
          ).map((workspace) => workspace.id)
        )
      : null;
  // Only PRIVATE memberships outside the grant snapshot are confidential.
  // Public workspaces are visible to any caller (including anonymous), so
  // hiding one from its own member would only break managed-auth onboarding.
  return orgs
    .filter(
      (o: OrgInfo) =>
        allowedIds === null ||
        !o.is_member ||
        o.visibility === 'public' ||
        allowedIds.has(o.id)
    )
    .map((o: OrgInfo) => ({
      slug: o.slug,
      name: o.name,
      is_member: o.is_member,
      is_personal: o.is_personal,
      is_current: ctx.currentOrganizationId !== null && o.id === ctx.currentOrganizationId,
      visibility: o.visibility,
      ...(o.managed_auth ? { managed_auth: o.managed_auth } : {}),
    }));
}
