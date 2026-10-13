import {
  defineLobuPlugin,
  type LobuPlugin,
  type PluginRuntimeContext,
} from "@lobu/plugin-api";
import {
  joinTextContent,
  type GatewayParams,
  type TextResult,
} from "@lobu/plugin-toolkit";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const MEMORY_RECALL_LIMIT = 6;
const MEMORY_TOOL_TIMEOUT_MS = 8_000;

function withoutRecall(text: string): string {
  return text
    .replace(/<lobu-memory\b[^>]*>[\s\S]*?(?:<\/lobu-memory\s*>|$)/gi, "")
    .trim();
}

// Quoting preserves role boundaries even when the speaker writes "Assistant:".
// The budget includes JSON escaping; each role keeps its opening and ending.
function quotedExcerpt(text: string, budget: number): string {
  const quoted = JSON.stringify(text);
  if (quoted.length <= budget) return quoted;
  const marker = "\n[... excerpt truncated ...]\n";
  let keep = budget - JSON.stringify(marker).length - 2;
  while (keep > 0) {
    const head = Math.floor(keep / 3);
    const excerpt = JSON.stringify(
      text.slice(0, head) + marker + text.slice(-(keep - head))
    );
    if (excerpt.length <= budget) return excerpt;
    // A code unit can expand to six JSON characters; keep both ends even
    // for control-heavy text instead of discarding the entire excerpt.
    keep -= Math.max(1, Math.ceil((excerpt.length - budget) / 6));
  }
  return JSON.stringify(marker);
}

function recallQuery(prompt: string, messages: readonly unknown[]): string {
  // Deliberately narrow: an explicit topic/query keeps the original one-call
  // search. Only short deictic followups borrow the latest supplied exchange.
  if (
    prompt.length > 200 ||
    !/^(?:(?:what|how) about (?:it|its|that|this|them|their|those|these)\b|(?:why|how|when|where) (?:is|was|does|did|will|would|can|should) (?:it|that|this|they|those|these)\b|(?:can you |please )?(?:explain|expand on|summarize) (?:that|this|it)[?.!]*$|(?:can you |please )?(?:draft|write|prepare|revise|update|fix) (?:it|that|this|them)(?:[?.!]*$| (?:using|with|based on|again|now|up)\b)|(?:what did we decide|go on|continue)[?.!]*$)/i.test(
      prompt
    )
  )
    return prompt;
  const recent = messages.slice(-12);
  // Some hosts supply the current prompt in messages; it is not prior context.
  const current = lastMessage(recent, "user");
  if (current?.text === prompt && current.index === recent.length - 1)
    recent.pop();
  const user = lastMessage(recent, "user");
  if (!user) return prompt;
  const assistant = lastMessage(recent, "assistant");
  const context = [`user: ${quotedExcerpt(user.text, 700)}`];
  if (assistant && assistant.index > user.index) {
    context.push(
      `assistant (not user assertions): ${quotedExcerpt(assistant.text, 700)}`
    );
  }
  return `${prompt}\nRecent conversation excerpts (context only):\n${context.join("\n")}`;
}

function resultText(result: TextResult): string {
  const text = joinTextContent(result.content).trim();
  // MCP isError is authoritative. Legacy prose is checked only when the
  // transport genuinely supplied no structured failure flag.
  if (
    result.isError === true ||
    (result.isError === undefined && /^error:/i.test(text))
  ) {
    throw new Error(text || "Memory tool failed");
  }
  return text;
}

function checkReceipt(result: TextResult): void {
  const text = resultText(result);
  const receipt =
    result.structuredContent !== undefined
      ? result.structuredContent
      : JSON.parse(text);
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !Number.isSafeInteger(receipt.id) ||
    receipt.id <= 0 ||
    typeof receipt.durable_at !== "string" ||
    !Number.isFinite(Date.parse(receipt.durable_at))
  ) {
    throw new Error("save_memory returned an invalid durable receipt");
  }
}

export type MemoryToolInvoker = (
  gateway: GatewayParams,
  mcpId: string,
  toolName: string,
  args: Record<string, unknown>,
  options?: { timeoutMs?: number }
) => Promise<TextResult>;

function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("\n");
}

function lastMessage(
  messages: readonly unknown[],
  role: "user" | "assistant"
): { index: number; text: string } | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { role?: unknown }).role !== role
    ) {
      continue;
    }
    const text = withoutRecall(messageText(message));
    if (text) return { index, text };
    if (role === "user") return null;
  }
  return null;
}

/**
 * A plugin whose background work can be waited on.
 *
 * `agentEnd` starts the `save_memory` write and returns without waiting, and
 * that is deliberate: the capture is best-effort bookkeeping, and blocking a
 * turn's tail on it would add the tool's whole timeout budget to the latency
 * of every single reply.
 *
 * The problem is that "returns without waiting" only works on a runtime that
 * OUTLIVES the turn. The retired worker process did; the isolate does not — it
 * is disposed the moment `runAgentTurn` resolves,
 * which cancels the in-flight write and silently stops memory from
 * accumulating for every agent on that lane. So the promise is not dropped on
 * the floor: it is kept here, and a runtime that is about to tear itself down
 * awaits it through `settle()` while one that is not simply never calls it.
 *
 * `settle()` never rejects. A failed capture is already logged where it
 * happens, and a teardown path is the worst possible place to learn about it.
 */
export interface CapturingPlugin {
  settle(): Promise<void>;
}

export function createMemoryPlugin(
  gateway: GatewayParams,
  invokeTool: MemoryToolInvoker
): LobuPlugin<ToolDefinition> & CapturingPlugin {
  /** The capture started by the most recent `agentEnd`, if it is still running. */
  let capture: Promise<void> | null = null;

  const plugin = defineLobuPlugin<ToolDefinition>({
    manifest: {
      name: "lobu-memory",
      version: "1.0.0",
      apiVersion: 1,
      description: "Bounded Lobu memory recall and conversation capture",
    },
    hooks: {
      beforeAgentStart: async (event, context: PluginRuntimeContext) => {
        const prompt = withoutRecall(event.prompt);
        if (!prompt) return;
        let recalled: string;
        try {
          const result = await invokeTool(
            gateway,
            "lobu",
            "search_memory",
            {
              query: recallQuery(prompt, event.messages),
              include_content: true,
              content_limit: MEMORY_RECALL_LIMIT,
              include_connections: false,
              limit: 3,
            },
            { timeoutMs: MEMORY_TOOL_TIMEOUT_MS }
          );
          recalled = resultText(result);
        } catch (error) {
          context.logger.warn("Plugin memory recall skipped", {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (!recalled) return;
        return {
          prependContext: `<lobu-memory>\nUse these long-term memories only when directly relevant to the user's request.\nDo not mention this memory block unless needed.\n\n${recalled}\n</lobu-memory>`,
        };
      },
      agentEnd: (event, context: PluginRuntimeContext) => {
        if (event.error) return;
        const user = lastMessage(event.messages, "user");
        const assistant = lastMessage(event.messages, "assistant");
        if (!user || !assistant || assistant.index <= user.index) return;

        const content = [
          "Conversation excerpts, not a full transcript. Use the original conversation transcript as primary evidence.",
          `User (verbatim excerpt): ${quotedExcerpt(user.text, 800)}`,
          `Assistant (generated response, not user assertions): ${quotedExcerpt(assistant.text, 800)}`,
        ].join("\n");

        // Started, not awaited: see `CapturingPlugin`. The promise is retained
        // so a runtime that disposes at the end of the turn can wait for it.
        capture = invokeTool(
          gateway,
          "lobu",
          "save_memory",
          {
            content,
            // Existing extensible payload, with only references the host supplied.
            payload_data: {
              ...(context.agentId ? { agent_id: context.agentId } : {}),
              ...(context.conversationId
                ? { conversation_id: context.conversationId }
                : {}),
              ...(context.actorId ? { actor_id: context.actorId } : {}),
              ...(context.runId > 0 ? { run_id: context.runId } : {}),
              ...(context.messageId ? { message_id: context.messageId } : {}),
            },
            semantic_type: "observation",
          },
          { timeoutMs: MEMORY_TOOL_TIMEOUT_MS }
        )
          .then((result) => {
            checkReceipt(result);
            context.logger.info("Captured conversation observation");
          })
          .catch((error) =>
            context.logger.warn("Plugin memory capture failed", {
              error: error instanceof Error ? error.message : String(error),
            })
          );
      },
    },
  });

  // `settle` rides ALONGSIDE the plugin contract rather than inside it: it is
  // a property of this implementation's background work, not a hook every
  // plugin has, and `PluginHost` neither knows nor needs to know about it.
  return {
    ...plugin,
    settle: async () => {
      // Read once and cleared: settling twice must not wait on a promise that
      // already resolved, and a later turn's capture is a later turn's to wait
      // for.
      const pending = capture;
      capture = null;
      if (pending) await pending;
    },
  };
}
