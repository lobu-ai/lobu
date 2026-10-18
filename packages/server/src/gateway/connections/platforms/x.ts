/**
 * X DM capability descriptor. The transport is the `x` connector connection
 * itself (`connectorTransport`): replies become `send_message` operations on
 * the paired browser, admitted through the same path `operations.execute`
 * uses, so policy, approval and the durable run record all apply and the
 * gateway never holds a credential.
 */

import { connectorChatPlatform } from "./connector-chat-platform.js";
import type { ChatPlatformDescriptor } from "./types.js";
import { XAdapter } from "./x-adapter.js";

export const xPlatform: ChatPlatformDescriptor = connectorChatPlatform(
  "x",
  (options) => new XAdapter(options),
);
