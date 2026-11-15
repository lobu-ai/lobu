/**
 * ClientSDK `notifications` namespace.
 *
 * `send` wraps the `notify` tool (in-app inbox + bot fan-out). `list` /
 * `markRead` reuse the REST service layer (`listNotifications` / `markAsRead`)
 * so callers can read and ack their own inbox without duplicate SQL. Reading
 * is available through `query_sdk`; acknowledging changes state and requires
 * `run_sdk`.
 */

import type { CardElement } from "chat";
import { type Static, Type } from "@sinclair/typebox";
import type {
	NotificationsSendInput as ReactionNotificationsSendInput,
	NotificationsSendResult,
} from "@lobu/connector-sdk";
import type { Env } from "../../index";
import { listNotifications, markAsRead } from "../../notifications/service";
import { notify } from "../../tools/admin/notify";
import type { ToolContext } from "../../tools/registry";
import { withValidatedArgs } from "../../tools/validate-args";
import { ToolUserError } from "../../utils/errors";
import { createValidatedSdkMethod } from "../sdk-preflight";
import { createActionCaller, idArg } from "./action-call";

const MarkReadSchema = Type.Object({ notification_id: Type.Number() });
type MarkReadArgs = Static<typeof MarkReadSchema>;

export type NotificationsSendInput = Omit<
	ReactionNotificationsSendInput,
	"card"
> & {
	/**
	 * Optional rich card (`chat` `CardElement`) for bot-connection delivery,
	 * rendered to each platform's native format (Block Kit / Adaptive Cards / …).
	 */
	card?: CardElement;
};

export interface NotificationsListInput {
	/** Keyset cursor: return notifications with id strictly less than this. */
	cursor?: number | null;
	/** Page size (service caps at 50; default 20). */
	limit?: number;
	/** When true, only unread notifications. */
	unread_only?: boolean;
}

export interface NotificationsListResult {
	notifications: Record<string, unknown>[];
	nextCursor: number | null;
}

export interface NotificationsNamespace {
  listInboxes(input: { organization: string }): Promise<import('../../notifications/inbox').InboxListing>;
  submit(input: import('../../notifications/inbox').InboxSubmitInput): Promise<import('../../notifications/inbox').InboxReceipt>;
	send(input: NotificationsSendInput): Promise<NotificationsSendResult>;
	list(input?: NotificationsListInput): Promise<NotificationsListResult>;
	/**
	 * Mark one of the caller's notifications as read. Accepts a positional id
	 * or `{ notification_id }`.
	 */
	markRead(
		notificationId: number | { notification_id: number },
	): Promise<{ success: true }>;
}

function requireUserId(ctx: ToolContext): string {
	if (!ctx.userId) {
		throw new ToolUserError("Authenticated user required", 401);
	}
	return ctx.userId;
}

export function buildNotificationsNamespace(
	ctx: ToolContext,
	env: Env,
): NotificationsNamespace {
	const { method } = createActionCaller(notify, env, ctx, "notifications");
	const prepareMarkRead = (
		notificationId: number | { notification_id: number },
	): MarkReadArgs => ({
		notification_id: idArg(
			"notifications.markRead",
			"notification_id",
			notificationId,
			"number",
		) as number,
	});
	const markRead = withValidatedArgs(
		"client.notifications.markRead",
		MarkReadSchema,
		async ({ notification_id }: MarkReadArgs) => {
			const userId = requireUserId(ctx);
			const updated = await markAsRead(
				ctx.organizationId,
				userId,
				notification_id,
			);
			if (!updated) {
				throw new ToolUserError("Not found or already read", 404);
			}
			return { success: true as const };
		},
	);

	return {
		send: method("send"),
		listInboxes: method("list_inboxes"),
		submit: method("submit"),
		async list(input) {
			const userId = requireUserId(ctx);
			return listNotifications({
				organizationId: ctx.organizationId,
				userId,
				cursor: input?.cursor ?? null,
				limit: input?.limit,
				unreadOnly: input?.unread_only ?? false,
			});
		},
		markRead: createValidatedSdkMethod(
			markRead,
			[],
			{
				path: "notifications.markRead",
				prepareArgs: prepareMarkRead,
			},
		),
	};
}
