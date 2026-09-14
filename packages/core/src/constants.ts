#!/usr/bin/env bun

/**
 * Shared constants across all packages
 * These are platform-agnostic and used by core, gateway, and platform adapters
 */

// Time constants (milliseconds)
export const TIME = {
  /** One hour in milliseconds */
  HOUR_MS: 60 * 60 * 1000,
  /** One day in milliseconds */
  DAY_MS: 24 * 60 * 60 * 1000,
  /** One hour in seconds */
  HOUR_SECONDS: 3600,
  /** One day in seconds */
  DAY_SECONDS: 24 * 60 * 60,
  /** Five seconds in milliseconds */
  FIVE_SECONDS_MS: 5000,
  /** Thirty seconds */
  THIRTY_SECONDS: 30,
} as const;

/**
 * MCP protocol version this codebase advertises on `initialize` handshakes.
 * Kept in one place so the gateway, CLI, and native runtime stay in lockstep.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/**
 * Every chat platform Lobu ships a connector for — the connectors declaring
 * `x-lobu-chat-platform` in their options schema. A `connectors/*-chat-platforms`
 * guard test keeps this in step with those declarations.
 *
 * This answers "is this connector a chat platform", which is all a CLIENT can
 * know. It deliberately does NOT answer "does Lobu run a hosted bot for it" —
 * that depends on whether a hosted preview connection exists in the deployment,
 * which only the server can see, and which it reports with a specific 400.
 * Conflating the two is what previously hard-rejected Google Chat in `lobu
 * apply` while happily minting Telegram codes that nothing could redeem.
 */
export const CHAT_PLATFORMS = [
  "slack",
  "telegram",
  "gchat",
  "discord",
  "teams",
  "whatsapp",
] as const;
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number];

export function isChatPlatform(type: string): type is ChatPlatform {
  return (CHAT_PLATFORMS as readonly string[]).includes(type);
}

// Default configuration values
export const DEFAULTS = {
  /** Default session TTL in milliseconds */
  SESSION_TTL_MS: TIME.DAY_MS,
  /** Default session TTL in seconds */
  SESSION_TTL_SECONDS: TIME.DAY_SECONDS,
  /** Default queue expiration in hours */
  QUEUE_EXPIRE_HOURS: 24,
  /** Default retry limit for queue operations */
  QUEUE_RETRY_LIMIT: 3,
  /** Default retry delay in seconds */
  QUEUE_RETRY_DELAY_SECONDS: TIME.THIRTY_SECONDS,
  /** Default session timeout in minutes */
  SESSION_TIMEOUT_MINUTES: 5,
} as const;
