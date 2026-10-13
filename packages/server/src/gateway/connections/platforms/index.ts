/**
 * Per-platform capability registry — the successor to the manager's
 * `ADAPTER_FACTORIES` map. Each entry merges the lazy adapter factory with
 * the platform's optional capability hooks (routing extraction, file
 * handlers, instruction providers, webhook/command setup, config guards).
 *
 * `ChatInstanceManager` consumes this registry generically:
 * `getPlatformDescriptor(platform)?.capability?.(...)`. Adding a platform =
 * one new module here + a registry entry; the manager needs no edits.
 */

import { discordPlatform } from "./discord.js";
import { gchatPlatform } from "./gchat.js";
import { slackPlatform } from "./slack.js";
import { teamsPlatform } from "./teams.js";
import { telegramPlatform } from "./telegram.js";
import type { ChatPlatformDescriptor } from "./types.js";
import { whatsappPlatform } from "./whatsapp.js";
import { whatsappWebPlatform } from "./whatsapp-web.js";
import { WHATSAPP_WEB_PLATFORM } from "./whatsapp-web-adapter.js";

export const PLATFORM_REGISTRY: Record<string, ChatPlatformDescriptor> = {
  telegram: telegramPlatform,
  slack: slackPlatform,
  discord: discordPlatform,
  whatsapp: whatsappPlatform,
  teams: teamsPlatform,
  gchat: gchatPlatform,
  [WHATSAPP_WEB_PLATFORM]: whatsappWebPlatform,
};

/** Look up a platform's capability descriptor, or undefined when unsupported. */
export function getPlatformDescriptor(
  platform: string
): ChatPlatformDescriptor | undefined {
  return PLATFORM_REGISTRY[platform];
}

/**
 * Platforms that run over a connector connection (`connectorTransport`) —
 * derived from the declarations, so the chat store never names a connector.
 */
export function connectorTransportPlatforms(): string[] {
  return Object.entries(PLATFORM_REGISTRY)
    .filter(([, descriptor]) => descriptor.connectorTransport === true)
    .map(([platform]) => platform);
}
