/**
 * Discord capability descriptor. File uploads ride the generic Chat SDK
 * Postable.files handler; routing extraction keeps the legacy WhatsApp-shape
 * fallthrough (see `extractWhatsAppStyleRoutingInfo`).
 */

import {
  createChatSdkFileHandler,
  extractWhatsAppStyleRoutingInfo,
} from "./shared.js";
import type { ChatPlatformDescriptor } from "./types.js";

export const discordPlatform: ChatPlatformDescriptor = {
  requiredConfigKeys: ["botToken", "applicationId", "publicKey"],

  // Pre-existing lazy adapter factory, moved verbatim from the manager's
  // ADAPTER_FACTORIES map (adapter SDKs stay lazy-loaded per platform).
  createAdapter: async (c) =>
    (await import("@chat-adapter/discord")).createDiscordAdapter(c),

  extractRoutingInfo: extractWhatsAppStyleRoutingInfo,

  createFileHandler: createChatSdkFileHandler,
};
