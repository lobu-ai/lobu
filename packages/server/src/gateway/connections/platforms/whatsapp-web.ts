/**
 * WhatsApp Web capability descriptor. The transport is the `whatsapp.web`
 * connector connection itself (`connectorTransport`): outbound verbs become
 * connector operations on the paired device, executed through the same
 * admission path `operations.execute` uses, so policy, approval and the
 * durable run record all apply and the gateway never holds a credential.
 */

import { connectorChatPlatform } from "./connector-chat.js";
import type { ChatPlatformDescriptor } from "./types.js";
import { WhatsAppWebAdapter } from "./whatsapp-web-adapter.js";

export const whatsappWebPlatform: ChatPlatformDescriptor = connectorChatPlatform(
  "whatsapp",
  (options) => new WhatsAppWebAdapter(options),
);
