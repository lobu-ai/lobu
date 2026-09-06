/**
 * The turn's memory hooks: recall before the model runs, capture after it
 * answers, from `@lobu/plugin-memory` itself.
 *
 * GUEST code, so the same portability rules as `workspace.ts` apply: no `node:`
 * import, no host module, no root `@lobu/core` import.
 *
 * Nothing here reimplements a hook. `createMemoryPlugin` is the SAME function
 * the subprocess lane composes, so the recall query, the `<lobu-memory>` block
 * the model reads, the capture's shape and its 2,000-character bound are
 * identical on both lanes. Two things are supplied here:
 *
 *  1. The INVOKER. The subprocess lane passes `callMcpTool` from
 *     `@lobu/plugin-mcp`, which imports the `@lobu/core` root and therefore
 *     cannot load in an isolate. This lane passes the guest's own MCP caller
 *     instead — the same `POST {gateway}/mcp/lobu/tools/{name}` under the same
 *     bearer that every other tool call on this turn takes, so there is still
 *     ONE credential and ONE host.
 *
 *  2. The SETTLE. `agentEnd` starts the `save_memory` write and returns
 *     without waiting, which is correct on a runtime that outlives the turn and
 *     silently lossy on one that does not: this isolate is disposed the moment
 *     `runAgentTurn` resolves. `runTurnMemory` therefore awaits the plugin's
 *     `settle()` before returning, so the capture actually reaches the gateway.
 */

import { PluginHost } from '@lobu/plugin-host';
import { createMemoryPlugin, type MemoryToolInvoker } from '@lobu/plugin-memory';
import type { PluginLogger, PluginRuntimeContext } from '@lobu/plugin-api';
import type { TextResult } from '@lobu/plugin-toolkit';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

/** What the guest needs from a turn to run its memory hooks. */
export interface TurnMemoryContext {
  gatewayUrl: string;
  credential: string;
  agentId: string;
  conversationId: string;
  /**
   * The MCP server `search_memory` and `save_memory` are mounted on. The
   * plugin names `lobu` internally; the producer states which server that is
   * for this turn, and the invoker below routes to it.
   */
  mcpId: string;
  /**
   * One MCP tool call, as the guest already makes them. Injected rather than
   * imported so this module carries no second transport: `guest-entry.ts` owns
   * the one `POST /mcp/{id}/tools/{name}` and its timeout mapping.
   */
  callTool: (
    mcpId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<string>;
  /** Where a hook's own diagnostics go. The host redacts and budgets them. */
  logger: PluginLogger;
}

/**
 * The turn's memory plugin, composed through the real `PluginHost` so the hooks
 * are dispatched by the same code the subprocess lane dispatches them with —
 * including its `agentEnd` error containment, which logs a throwing hook and
 * moves on rather than failing the turn.
 */
export function createTurnMemory(context: TurnMemoryContext): {
  host: PluginHost<ToolDefinition>;
  runtime: PluginRuntimeContext;
  settle: () => Promise<void>;
} {
  // The plugin addresses its server as `lobu`; the turn says which server that
  // actually is. Routing on the turn's id rather than the plugin's literal is
  // what keeps the guest free of a hardcoded server name.
  const invoke: MemoryToolInvoker = async (_gateway, _mcpId, toolName, args, options) => {
    // The plugin's contract is a `TextResult`; a failed call is text the hook
    // inspects (it skips a recall whose text starts with "error:"), never a
    // throw. Matching that here keeps the hook's own branches live.
    try {
      const text = await context.callTool(context.mcpId, toolName, args, options);
      return { content: [{ type: 'text', text }] } satisfies TextResult;
    } catch (error) {
      return {
        content: [
          { type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` },
        ],
      } satisfies TextResult;
    }
  };

  const plugin = createMemoryPlugin(
    {
      // The plugin passes these straight back to the invoker, which ignores
      // them: this lane addresses the MCP route itself. They are filled in
      // rather than faked so nothing downstream reads an empty string.
      gatewayUrl: context.gatewayUrl,
      workerToken: context.credential,
      channelId: '',
      conversationId: context.conversationId,
    },
    invoke
  );

  // `PluginRuntimeContext` is the subprocess lane's shape and carries more than
  // the memory hooks read (they use `logger` and `agentId`). The rest is filled
  // with what this lane actually knows, and nothing is invented: a field this
  // lane has no value for stays empty rather than carrying a plausible lie.
  const runtime: PluginRuntimeContext = {
    logger: context.logger,
    organizationId: '',
    actorId: '',
    credentialSubject: '',
    destination: '',
    agentId: context.agentId,
    conversationId: context.conversationId,
    runId: 0,
    messageId: '',
    workspaceDir: '',
    platform: '',
  };

  return {
    // `lobu-memory` contributes no tools, but `PluginHost` is generic in the
    // tool type its plugins declare, and the plugin declares pi's.
    host: new PluginHost<ToolDefinition>([plugin]),
    runtime,
    settle: () => plugin.settle(),
  };
}

/** The memory used by ONE turn, from recall through capture. */
export interface TurnMemory {
  /**
   * The recall block to prepend to this turn's prompt, or `''`. Never throws:
   * a memory server that is down must not cost the user their answer, which is
   * the same best-effort contract the subprocess lane has.
   */
  recall(prompt: string, messages: readonly unknown[]): Promise<string>;
  /**
   * Capture the exchange, and WAIT for it. Called after the turn produced its
   * answer and before the isolate is disposed. Never throws.
   */
  capture(messages: readonly unknown[], error?: string): Promise<void>;
}

export function createTurnMemoryHooks(context: TurnMemoryContext): TurnMemory {
  const { host, runtime, settle } = createTurnMemory(context);
  return {
    async recall(prompt, messages) {
      try {
        const blocks = await host.beforeAgentStart({ prompt, messages }, runtime);
        return blocks.join('\n\n');
      } catch (error) {
        // `PluginHost.beforeAgentStart` does NOT contain a throwing hook the
        // way `agentEnd` does, so the containment is here: a failed recall
        // costs the model its memories, never the user their reply.
        context.logger.warn('Plugin memory recall failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return '';
      }
    },
    async capture(messages, error) {
      // `agentEnd` contains its own hook failures; `settle` waits for the write
      // the hook started and never rejects. The try still stands because a
      // dispose-time path must not be able to fail the turn that already
      // succeeded.
      try {
        await host.agentEnd({ messages, ...(error !== undefined ? { error } : {}) }, runtime);
        await settle();
      } catch (settleError) {
        context.logger.warn('Plugin memory capture did not settle', {
          error: settleError instanceof Error ? settleError.message : String(settleError),
        });
      }
    },
  };
}
