import type { SlackAdapter } from "@chat-adapter/slack";
import { NotificationDeliveryError } from "../../../notifications/delivery.js";

const deliveryCodes = new Map([
  ["channel_not_found", "provider_not_found"],
  ["user_not_found", "provider_not_found"],
  ["is_archived", "provider_permission"],
  ["not_in_channel", "provider_permission"],
  ["cannot_dm_bot", "provider_permission"],
  ["invalid_auth", "provider_authentication"],
  ["token_revoked", "provider_authentication"],
  ["account_inactive", "provider_authentication"],
  ["not_authed", "provider_authentication"],
  ["missing_scope", "provider_permission"],
  ["no_permission", "provider_permission"],
  ["restricted_action", "provider_permission"],
  ["ratelimited", "provider_rate_limited"],
]);

/** Normalize provider structure before the shared delivery classifier sees it. */
export function withSlackDeliveryErrors(adapter: SlackAdapter): SlackAdapter {
  // The SDK's protected hook covers channel/thread posts and opening DMs.
  const boundary = adapter as unknown as { handleSlackError(error: unknown): never };
  const original = boundary.handleSlackError.bind(adapter);
  boundary.handleSlackError = (error: unknown): never => {
    const value = error as { code?: unknown; data?: { error?: unknown } } | null;
    if (value?.code !== "slack_webapi_platform_error") {
      return original(error);
    }
    // Keep only a bounded provider code, never the response, credentials or prose.
    const providerCode = typeof value.data?.error === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/.test(value.data.error) ? value.data.error : undefined;
    const code = providerCode ? deliveryCodes.get(providerCode) ?? "delivery_unknown" : "delivery_unknown";
    const normalized = new NotificationDeliveryError(
      code,
      "Slack delivery failed",
      code === "provider_rate_limited" || code === "delivery_unknown",
    );
    if (providerCode) normalized.cause = { code: providerCode };
    throw normalized;
  };
  return adapter;
}
