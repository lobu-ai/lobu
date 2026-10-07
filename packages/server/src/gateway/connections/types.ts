/**
 * Platform connection types for API-driven Chat SDK integrations.
 * Config types are derived directly from adapter factory signatures — zero maintenance.
 */

import type { createDiscordAdapter } from "@chat-adapter/discord";
import type { createGoogleChatAdapter } from "@chat-adapter/gchat";
import type { createSlackAdapter } from "@chat-adapter/slack";
import type { createTeamsAdapter } from "@chat-adapter/teams";
import type { createTelegramAdapter } from "@chat-adapter/telegram";
import type { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { ConnectorWebhookSchema } from "@lobu/connector-sdk";

// Derive config types from what the adapter factories actually accept
export type TelegramAdapterConfig = NonNullable<
  Parameters<typeof createTelegramAdapter>[0]
> & { platform: "telegram" };
export type SlackAdapterConfig = NonNullable<
  Parameters<typeof createSlackAdapter>[0]
> & { platform: "slack" };
export type DiscordAdapterConfig = NonNullable<
  Parameters<typeof createDiscordAdapter>[0]
> & { platform: "discord" };
export type WhatsAppAdapterConfig = NonNullable<
  Parameters<typeof createWhatsAppAdapter>[0]
> & { platform: "whatsapp" };
export type TeamsAdapterConfig = NonNullable<
  Parameters<typeof createTeamsAdapter>[0]
> & { platform: "teams" };
export type GoogleChatAdapterConfig = NonNullable<
  Parameters<typeof createGoogleChatAdapter>[0]
> & { platform: "gchat"; helpCommandId?: string };

/**
 * `rest` is the always-on HTTP Agent API
 * (`POST /lobu/api/v1/agents/:id/messages`, registered unconditionally in
 * gateway/routes/public/agent.ts). It is declarable on an agent — so
 * `lobu apply` can converge on the scaffolded `{ type: "rest", config: {} }`
 * binding — but it has no Chat SDK adapter and takes no config.
 */
export type RestPlatformConfig = { platform: "rest" };

/**
 * `webhook` is the inbound push-source primitive (#1235): external systems
 * POST JSON to `POST /api/v1/webhooks/:connectionId` and the payload is
 * persisted as an `events` row. Adapterless like `rest` — handled per
 * request by gateway/connections/webhook-ingest.ts, no Chat SDK instance.
 */
export type WebhookIngestPlatformConfig = {
  platform: "webhook";
  /** Bearer token; auto-generated at create, stored as a `secret://` ref. */
  token?: string;
  /** Opt-in `?token=` auth for header-less senders. Default false. */
  allowQueryAuth?: boolean | string;
  /**
   * Shared signing secret (a `secret://` ref), minted by a connector's
   * `registerWebhook`. When set, a delivery is rejected (401) unless its HMAC
   * signature verifies per the scheme below — this is how connector-owned
   * webhooks (GitHub/Linear/Jira) authenticate, in addition to (or instead of)
   * the bearer token. The scheme fields themselves (`signatureHeader`,
   * `algorithm`, `signaturePrefix`, `dedupeHeader`) come from the single
   * source of truth, the connector's {@link ConnectorWebhookSchema}, which
   * `registerWebhook` stamps onto the connection alongside this secret.
   */
  signatureSecret?: string;
  /** `events.semantic_type` for ingested rows; default "content". */
  semanticType?: string;
  /** JSON pointer extracted into `events.title`. */
  titlePath?: string;
  /**
   * Index ingested payloads into semantic memory (render `payload_text` →
   * embed → recallable via `search_memory`). Default false: store-only, so
   * the row is reachable by Automation SQL but never floods semantic memory
   * with high-volume/low-value webhook traffic.
   */
  searchable?: boolean | string;
} & ConnectorWebhookSchema;

export type PlatformAdapterConfig =
  | TelegramAdapterConfig
  | SlackAdapterConfig
  | DiscordAdapterConfig
  | WhatsAppAdapterConfig
  | TeamsAdapterConfig
  | GoogleChatAdapterConfig
  | RestPlatformConfig
  | WebhookIngestPlatformConfig;

/** Narrow a connection's config to the Telegram shape. */
export function isTelegramConfig(
  config: PlatformAdapterConfig
): config is TelegramAdapterConfig {
  return config.platform === "telegram";
}

/** Narrow a connection's config to the Slack shape. */
export function isSlackConfig(
  config: PlatformAdapterConfig
): config is SlackAdapterConfig {
  return config.platform === "slack";
}

export interface PlatformConnection {
  id: string;
  platform: string;
  createdBy?: string;
  agentId?: string;
  /**
   * Organization id this connection belongs to. Mirrors
   * `connections.organization_id`. Optional in the type for
   * back-compat with in-memory tests; required at the storage layer.
   */
  organizationId?: string;
  config: PlatformAdapterConfig;
  settings: ConnectionSettings;
  metadata: Record<string, any>;
  status: "active" | "stopped" | "error";
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export type UserConfigScope =
  | "model"
  | "view-model"
  | "system-prompt"
  | "skills"
  | "permissions"
  | "packages";

export interface ConnectionSettings {
  allowFrom?: string[];
  allowGroups?: boolean;
  userConfigScopes?: UserConfigScope[];
  /**
   * Marks this connection as a hosted "Preview" workspace bot (today: Slack —
   * the public "Lobu" workspace). When a DM/@-mention arrives for a chat that
   * hasn't been linked to an agent yet, the message-handler replies with the
   * linking instructions instead of running the connection's (placeholder)
   * owning agent. The connection's `platform` determines which notice/link
   * mechanism applies.
   */
  previewMode?: boolean;
  /**
   * Whole-channel transcript capture. When true, a *subscribed* (non-mention,
   * non-DM) channel message is still recorded to `channel_messages` but does
   * NOT trigger an agent turn — so the bot can mirror a whole channel it's
   * subscribed to (Slack `message.channels`) without responding to everything.
   * Mentions and DMs still get a response. Default off: semantics unchanged, and
   * actually receiving every channel message also requires the platform app to
   * be subscribed to channel-message events (an ops/app-config step).
   */
  recordChannelMessages?: boolean;
}

/** Heuristic: field names matching these patterns contain secrets and must be encrypted at rest. */
const SECRET_FIELD_PATTERNS = [
  "token",
  "secret",
  "password",
  "key",
  "credential",
];

export function isSecretField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return SECRET_FIELD_PATTERNS.some((p) => lower.includes(p));
}
