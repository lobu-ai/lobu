/**
 * LinkedIn capability descriptor. The transport is the `linkedin` connector
 * connection itself (`connectorTransport`): replies become the connector's
 * `send_message` operation on the paired browser, admitted like any manual
 * `operations.execute`, so the gateway never holds a LinkedIn credential.
 */

import { connectorChatPlatform } from "./connector-chat-platform.js";
import { LinkedInAdapter } from "./linkedin-adapter.js";
import type { ChatPlatformDescriptor } from "./types.js";

export const linkedinPlatform: ChatPlatformDescriptor = connectorChatPlatform(
  "linkedin",
  (options) => new LinkedInAdapter(options),
);
