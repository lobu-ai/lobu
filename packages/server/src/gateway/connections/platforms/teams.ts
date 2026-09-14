/**
 * Microsoft Teams capability descriptor. File uploads ride the generic Chat
 * SDK Postable.files handler; routing extraction keeps the legacy
 * WhatsApp-shape fallthrough (see `extractWhatsAppStyleRoutingInfo`).
 */

import {
  createChatSdkFileHandler,
  extractWhatsAppStyleRoutingInfo,
} from "./shared.js";
import type { ChatPlatformDescriptor } from "./types.js";

export const teamsPlatform: ChatPlatformDescriptor = {
  requiredConfigKeys: ["appId", "appPassword"],

  // Pre-existing lazy adapter factory, moved verbatim from the manager's
  // ADAPTER_FACTORIES map (adapter SDKs stay lazy-loaded per platform).
  createAdapter: async (c) =>
    (await import("@chat-adapter/teams")).createTeamsAdapter(c),

  extractRoutingInfo: extractWhatsAppStyleRoutingInfo,

  createFileHandler: createChatSdkFileHandler,
};
