/**
 * WhatsApp capability descriptor. No file handler yet — outbound uploads fall
 * back to whatever the caller does when `getFileHandler` returns undefined.
 */

import { extractWhatsAppStyleRoutingInfo } from "./shared.js";
import type { ChatPlatformDescriptor } from "./types.js";

export const whatsappPlatform: ChatPlatformDescriptor = {
  requiredConfigKeys: [
    "accessToken",
    "phoneNumberId",
    "appSecret",
    "verifyToken",
  ],

  // Pre-existing lazy adapter factory, moved verbatim from the manager's
  // ADAPTER_FACTORIES map (adapter SDKs stay lazy-loaded per platform).
  createAdapter: async (c) =>
    (await import("@chat-adapter/whatsapp")).createWhatsAppAdapter(c),

  extractRoutingInfo: extractWhatsAppStyleRoutingInfo,
};
