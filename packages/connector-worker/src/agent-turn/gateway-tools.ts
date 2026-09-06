/**
 * The turn's gateway tools: `ask_user`, `send_message`, `suggest_actions` and
 * the rest of `@lobu/plugin-conversations`.
 *
 * GUEST code, bundled with the agent entry, so the same portability rules as
 * `workspace.ts` apply: no `node:` import, no host module, no root
 * `@lobu/core` import.
 *
 * Nothing here reimplements a tool. `createConversationTools` is the SAME
 * function the subprocess lane composes through `createRuntimePluginHost`, so
 * an agent gets one `ask_user` — one schema, one description, one request body,
 * one piece of turn-ending prose — whichever lane runs the turn. That is only
 * possible because those tools were already plain `fetch` calls to
 * `/internal/...` under a worker bearer; making the package isolate-loadable
 * was a matter of keeping the winston-bearing `@lobu/core` root out of its
 * import graph (`@lobu/core/agent-tooling`), not of porting any tool.
 *
 * What this module adds is only the seam: which tools the policy admitted,
 * the turn's one credential as the bearer, and pi's `AgentTool` shape.
 */

import { createConversationTools } from '@lobu/plugin-conversations';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { AgentTurnConversation, AgentTurnGatewayTool } from './types.js';

/**
 * Build the gateway tools this turn may call.
 *
 * `allowed` is the producer's list, already filtered through the agent's tool
 * policy — this function only selects, it never grants: a name the plugin does
 * not define is dropped rather than invented.
 *
 * `onAskUserPosted` exists because `ask_user` ENDS the turn on the subprocess
 * lane: pi is told the user's click arrives as a new inbound message. The
 * caller uses it to stop the loop for the same reason, so a model that asks a
 * question does not then keep talking to itself.
 *
 * `onInBandReplyDelivered` fires when `send_message`/`present_event` posted
 * into the conversation this turn is ALREADY answering. The user has read that
 * message, so the turn's terminal reply would be the same answer a second
 * time. The subprocess lane threads this same hook to `recordInBandReply`; on
 * this lane it travels out on the turn result, and the completion route stamps
 * `repliedInBand` so the renderers' existing suppression acts on it unchanged.
 */
export function createGatewayTools(
  allowed: readonly AgentTurnGatewayTool[],
  args: {
    gatewayUrl: string;
    credential: string;
    conversation: AgentTurnConversation;
    onAskUserPosted: () => void;
    onInBandReplyDelivered: () => void;
  }
): AgentTool[] {
  const wanted = new Set<string>(allowed);
  if (wanted.size === 0) return [];
  const tools = createConversationTools({
    gatewayUrl: args.gatewayUrl,
    workerToken: args.credential,
    channelId: args.conversation.channelId,
    conversationId: args.conversation.conversationId,
    platform: args.conversation.platform,
    onAskUserPosted: args.onAskUserPosted,
    onInBandReplyDelivered: args.onInBandReplyDelivered,
  });
  return tools.filter((tool) => wanted.has(tool.name)) as unknown as AgentTool[];
}
