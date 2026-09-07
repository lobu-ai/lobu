/**
 * ClientSDK `organizations` namespace.
 *
 * Lets user scripts enumerate the orgs the caller belongs to and read the
 * session's current org. The `.org()` accessor on the root SDK (see
 * `client-sdk.ts`) handles the actual cross-org context swap.
 */

import type { AccountToolContext } from "../../tools/registry";
import { getWorkspaceProvider } from "../../workspace";
import type { OrgInfo } from "../../workspace/types";
import { listLiveGrantedMemberWorkspaces } from "../../auth/oauth/workspace-grants";

export interface OrgSummary {
	id: string;
	slug: string;
	name: string;
	is_member: boolean;
	is_personal: boolean;
	visibility: "public" | "private";
	managed_auth?: OrgInfo["managed_auth"];
}

export interface OrganizationsNamespace {
	/**
	 * List organizations accessible to the caller: member-ofs plus any public
	 * workspaces the session can read.
	 */
	list(options?: { search?: string }): Promise<OrgSummary[]>;
	/**
	 * Return the session's current organization context. Reflects the URL pin
	 * (`/mcp/{slug}`); returns null for an unselected account client.
	 */
	current(): Promise<OrgSummary | null>;
}

export function buildOrganizationsNamespace(
	ctx: AccountToolContext,
): OrganizationsNamespace {
	const summarize = (organization: OrgInfo): OrgSummary => ({
		id: organization.id,
		slug: organization.slug,
		name: organization.name,
		is_member: organization.is_member,
		is_personal: organization.is_personal,
		visibility: organization.visibility,
		...(organization.managed_auth
			? { managed_auth: organization.managed_auth }
			: {}),
	});

	return {
		async list(options) {
			const provider = getWorkspaceProvider();
			const orgs = await provider.listOrganizations(
				options?.search,
				ctx.userId,
			);
			const allowedIds =
				Array.isArray(ctx.grantedOrganizationIds) && ctx.userId
					? new Set(
						(
							await listLiveGrantedMemberWorkspaces({
								userId: ctx.userId,
								grantedOrganizationIds: ctx.grantedOrganizationIds,
							})
						).map((workspace) => workspace.id),
					)
					: null;
			// Only PRIVATE memberships outside the grant snapshot are
			// confidential; public workspaces stay listed for their members.
			return orgs
				.filter(
					(organization) =>
						allowedIds === null ||
						!organization.is_member ||
						organization.visibility === "public" ||
						allowedIds.has(organization.id),
				)
				.map(summarize);
		},
		async current() {
			if (!ctx.organizationId) return null;
			const provider = getWorkspaceProvider();
			const orgs = await provider.listOrganizations(undefined, ctx.userId);
			const current = orgs.find((o) => o.id === ctx.organizationId);
			if (!current) {
				// Public-workspace session where the user isn't a member: the org is
				// readable but absent from listOrganizations. Fall back to a slug
				// resolve so current() still returns something useful.
				const slug = await provider.getOrgSlug(ctx.organizationId);
				return {
					id: ctx.organizationId,
					slug: slug ?? ctx.organizationId,
					name: slug ?? "unknown",
					is_member: false,
					is_personal: false,
					visibility: "public",
				};
			}
			return summarize(current);
		},
	};
}
