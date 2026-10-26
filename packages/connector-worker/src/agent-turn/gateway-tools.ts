/**
 * The turn's gateway tools: `ask_user`, `send_message` and the rest of
 * `@lobu/plugin-conversations`.
 *
 * GUEST code, bundled with the agent entry, so the same portability rules as
 * `workspace.ts` apply: no `node:` import, no host module, no root
 * `@lobu/core` import.
 *
 * Nothing here reimplements a tool. `createConversationTools` owns each
 * schema, description, request body and piece of turn-ending prose. The tools
 * are plain `fetch` calls to
 * `/internal/...` under a worker bearer; making the package isolate-loadable
 * was a matter of keeping the winston-bearing `@lobu/core` root out of its
 * import graph (`@lobu/core/agent-tooling`), not of porting any tool.
 *
 * What this module adds is only the seam: which tools the policy admitted,
 * the turn's one credential as the bearer, and pi's `AgentTool` shape.
 */

import { TURN_INPUT_RUN_HEADER } from '@lobu/core/agent-tooling';
import { createConversationTools } from '@lobu/plugin-conversations';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { AgentTurnConversation, AgentTurnGatewayTool } from './types.js';

/**
 * `tools`, with each call executed by a tool set built for THAT call: one whose
 * gateway requests name the steered input the call answers
 * (`TURN_INPUT_RUN_HEADER`), so the gateway keys the write on that input's
 * stored message. Building a plugin tool set is only object construction; the
 * schemas and descriptions offered to the model are the first set's.
 */
export function perCallInputRun(
  tools: AgentTool[],
  build: (headers: Record<string, string>) => AgentTool[],
  inputRunFor: (toolCallId: string) => number | undefined
): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: (toolCallId, ...rest) => {
      const inputRunId = inputRunFor(toolCallId);
      if (inputRunId === undefined) return tool.execute(toolCallId, ...rest);
      const forCall = build({ [TURN_INPUT_RUN_HEADER]: String(inputRunId) }).find((t) => t.name === tool.name)!;
      return forCall.execute(toolCallId, ...rest);
    },
  }));
}

/**
 * Build the gateway tools this turn may call.
 *
 * `allowed` is the producer's list, already filtered through the agent's tool
 * policy — this function only selects, it never grants: a name the plugin does
 * not define is dropped rather than invented.
 *
 * `onAskUserPosted` exists because `ask_user` ends the turn: pi is told the
 * user's click arrives as a new inbound message. The caller stops the loop so
 * a model that asks a question does not then keep talking to itself.
 *
 * `onInBandReplyDelivered` fires when `send_message`/`present_event` posted
 * into the conversation this turn is ALREADY answering. The user has read that
 * message, so the turn's terminal reply would be the same answer a second
 * time. The hook travels out on the turn result, and the completion route
 * stamps `repliedInBand` so the renderers suppress the duplicate.
 */
export function createGatewayTools(
  allowed: readonly AgentTurnGatewayTool[],
  args: {
    gatewayUrl: string;
    credential: string;
    conversation: AgentTurnConversation;
    onAskUserPosted: () => void;
    onInBandReplyDelivered: () => void;
    inputRunFor: (toolCallId: string) => number | undefined;
  }
): AgentTool[] {
  const wanted = new Set<string>(allowed);
  if (wanted.size === 0) return [];
  const build = (headers?: Record<string, string>) =>
    createConversationTools({
      gatewayUrl: args.gatewayUrl,
      workerToken: args.credential,
      channelId: args.conversation.channelId,
      conversationId: args.conversation.conversationId,
      platform: args.conversation.platform,
      ...(headers ? { headers } : {}),
      onAskUserPosted: args.onAskUserPosted,
      onInBandReplyDelivered: args.onInBandReplyDelivered,
    }) as unknown as AgentTool[];
  return perCallInputRun(build().filter((tool) => wanted.has(tool.name)), build, args.inputRunFor);
}
