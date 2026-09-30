import type { ToolContext } from '../../../registry';
import { joinPublicOrganization } from '../../../../workspace/join-public';
import { resolveManagedAuthConnectorOffer } from '../../../../workspace/managed-auth-discovery';
import type { ConnectionsArgs, ManageConnectionsResult } from '../schemas';
import { handleRequiredManagedConnect } from './connect';
import {
	DEVICE_AUTOWIRE_SUPPRESSION_ERROR,
	hasDeviceAutowireSuppressionMarker,
} from '../../../../utils/device-autowire-suppression';

/**
 * Start a managed OAuth grant from any workspace context.
 *
 * The public org + active app profile are validated from Postgres before the
 * user is enrolled. The joined organization supplies the cross-org context,
 * and handleConnect refuses to create an ordinary cloud-synced connection if
 * the managed signal no longer holds.
 */
export async function handleConnectManaged(
	args: Extract<ConnectionsArgs, { action: 'connect_managed' }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
	if (hasDeviceAutowireSuppressionMarker(args.config)) {
		return { error: DEVICE_AUTOWIRE_SUPPRESSION_ERROR };
	}
	if (!ctx.isAuthenticated || !ctx.userId) {
		return { error: 'Lobu login is required before using managed auth.' };
	}
	const organizationSlug = await resolveManagedAuthConnectorOffer({
		organizationSlug: args.managed_by_org,
		connectorKey: args.connector_key,
	});
	if (!organizationSlug) {
		return {
			error: `No active managed OAuth offer for connector '${args.connector_key}' was found in public org '${args.managed_by_org}'. Discover organizations.list again before retrying.`,
		};
	}

	const membership = await joinPublicOrganization({
		userId: ctx.userId,
		orgSlug: organizationSlug,
	});
	if (membership.status === 'not_found' || membership.status === 'not_public') {
		return {
			error: `Managed auth org '${args.managed_by_org}' is no longer available. Discover organizations.list again before retrying.`,
		};
	}

	return handleRequiredManagedConnect(
		{
			action: 'connect',
			connector_key: args.connector_key,
			...(args.display_name ? { display_name: args.display_name } : {}),
			...(args.slug ? { slug: args.slug } : {}),
			...(args.config ? { config: args.config } : {}),
		},
		{
			...ctx,
			organizationId: membership.organizationId,
			memberRole: membership.role,
			scopedToOrg: true,
			allowCrossOrg: false,
			grantedOrganizationIds: [membership.organizationId],
			directSearchFederation: false,
		},
	);
}
