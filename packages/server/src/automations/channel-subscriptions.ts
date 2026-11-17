import { createLogger, getErrorMessage } from "@lobu/core";
import type { AutomationTrigger } from "@lobu/core/contracts/tools/manage-automations";
import { type DbClient, pgBigintArray } from "../db/client";
import {
	resolveChannelFeedId,
	softDeleteChannelFeed,
} from "../gateway/channels/channel-feed";
import { qualifiedOperationKey } from "../tools/admin/manage_operations/handlers/shared";

const logger = createLogger("automation-channel-feeds");

interface ChannelSubscriptionRef {
	connectionId: number;
	channelKey: string;
}

function channelSubscriptions(
	triggers: AutomationTrigger[],
): ChannelSubscriptionRef[] {
	const refs: ChannelSubscriptionRef[] = [];
	for (const trigger of triggers) {
		if (
			trigger.kind !== "event" ||
			trigger.source === "workspace" ||
			trigger.connection_id == null ||
			!trigger.event_types.includes("message.created")
		) {
			continue;
		}
		const nativeChannelId = trigger.match?.channel_id;
		if (typeof nativeChannelId !== "string" || !nativeChannelId.trim()) continue;
		refs.push({
			connectionId: trigger.connection_id,
			channelKey: `${trigger.connector_key}:${nativeChannelId.trim()}`,
		});
	}
	return refs;
}

/** The connections whose channels these triggers bind an Automation to. */
export function chatBindingConnectionIds(
	...triggerSets: Array<readonly AutomationTrigger[] | null | undefined>
): number[] {
	return triggerSets.flatMap((triggers) =>
		channelSubscriptions([...(triggers ?? [])]).map((ref) => ref.connectionId),
	);
}

function key(ref: ChannelSubscriptionRef): string {
	return `${ref.connectionId}:${ref.channelKey}`;
}

/** Keep channel-feed projections aligned with canonical Automation triggers. */
export async function syncAutomationChannelFeeds(args: {
	organizationId: string;
	before?: AutomationTrigger[];
	after?: AutomationTrigger[];
	sql: DbClient;
}): Promise<void> {
	const before = channelSubscriptions(args.before ?? []);
	const after = channelSubscriptions(args.after ?? []);
	const beforeKeys = new Set(before.map(key));
	const afterKeys = new Set(after.map(key));

	for (const ref of after) {
		if (beforeKeys.has(key(ref))) continue;
		await resolveChannelFeedId({
			connectionId: String(ref.connectionId),
			organizationId: args.organizationId,
			channelKey: ref.channelKey,
			sql: args.sql,
		});
	}

	for (const ref of before) {
		if (afterKeys.has(key(ref))) continue;
		const remaining = await args.sql`
			SELECT 1
			FROM automation_message_subscriptions
			WHERE connection_id = ${ref.connectionId}
			  AND channel_id = ${ref.channelKey}
			LIMIT 1
		`;
		if (remaining.length > 0) continue;
		await softDeleteChannelFeed({
			connectionId: String(ref.connectionId),
			channelKey: ref.channelKey,
			sql: args.sql,
		});
	}
}

/** Reconcile the derived feed projection without failing an already-committed Automation write. */
export async function syncAutomationChannelFeedsBestEffort(
	args: Parameters<typeof syncAutomationChannelFeeds>[0],
): Promise<void> {
	try {
		await syncAutomationChannelFeeds(args);
	} catch (error) {
		logger.warn(
			{ error: getErrorMessage(error) },
			"Failed to reconcile channel feeds",
		);
	}
}

/**
 * Marks a grant this module wrote for a binding. It is also the reason shown
 * when the grant decides a send. A rule with any other note was written by a
 * person and is never removed here.
 */
export const BINDING_SEND_GRANT_NOTE =
	"Allowed because an agent is bound to a channel on this connection";

/**
 * Binding an agent to a chat channel is the owner's consent to its posts there.
 * Keep one Auto grant for `<connector>::send_message` on each Chat SDK
 * connection the org's agents are bound to, and remove it when the last binding
 * goes. It is an ordinary stored rule: visible, editable and revocable, and
 * every matching guardrail still applies after it. Delivery re-authorizes
 * against the sending agent's own bindings, so a connection-wide grant never
 * opens a channel the agent is not bound to.
 *
 * Call inside the transaction that writes the binding, with every connection
 * the write may have bound or unbound.
 */
export async function reconcileBindingSendGrants(args: {
	organizationId: string;
	connectionIds: readonly number[];
	sql: DbClient;
}): Promise<void> {
	const connectionIds = [...new Set(args.connectionIds)];
	if (connectionIds.length === 0) return;
	const { organizationId, sql } = args;
	// Serialize with connector-rule edits (withConnectorPolicyTransaction).
	// NO KEY UPDATE still conflicts with its FOR UPDATE but not with the
	// FOR KEY SHARE a foreign-key insert takes on this row.
	await sql`SELECT id FROM organization WHERE id = ${organizationId} FOR NO KEY UPDATE`;
	const bound = await sql<{ connection_id: string; platform: string }>`
		SELECT DISTINCT connection_id::text AS connection_id, platform
		FROM automation_message_subscriptions
		WHERE organization_id = ${organizationId}
		  AND connection_organization_id = ${organizationId}
		  AND connection_status = 'active'
		  AND credential_mode IS NOT NULL
		  AND connection_id = ANY(${pgBigintArray(connectionIds)}::bigint[])
	`;
	for (const row of bound) {
		await sql`
			WITH inserted AS (
				INSERT INTO write_approval_policies (
					organization_id, resource_class, operation_key, connection_id,
					kind, note, created_at, updated_at
				) VALUES (
					${organizationId}, 'connector_action',
					${qualifiedOperationKey(row.platform, "send_message")}, ${Number(row.connection_id)},
					'grant', ${BINDING_SEND_GRANT_NOTE}, now(), now()
				)
				ON CONFLICT DO NOTHING
				RETURNING id
			)
			INSERT INTO write_policy_action_effects (policy_id, action, effect)
			SELECT id, 'execute', 'auto' FROM inserted
		`;
	}
	const stillBound = new Set(bound.map((row) => Number(row.connection_id)));
	const unbound = connectionIds.filter((id) => !stillBound.has(id));
	if (unbound.length === 0) return;
	await sql`
		DELETE FROM write_approval_policies p
		USING connections c
		WHERE p.organization_id = ${organizationId}
		  AND p.resource_class = 'connector_action'
		  AND p.kind = 'grant'
		  AND p.principal_kind IS NULL
		  AND p.note = ${BINDING_SEND_GRANT_NOTE}
		  AND p.connection_id = ANY(${pgBigintArray(unbound)}::bigint[])
		  AND c.id = p.connection_id
		  AND p.operation_key = c.connector_key || '::send_message'
	`;
}
