import {
  coerceApprovalAttribution,
  createLogger,
  InteractionResourceKind,
  type ToolApprovalCreateBody,
} from "@lobu/core";
import {
  createGatewayClient,
  gatewayFetch,
  joinTextContent,
  mcpToolResult,
  textResult,
  withErrorHandling,
  type GatewayParams,
  type TextResult,
  type ToolResult,
  type ToolImageBudget,
} from "@lobu/plugin-toolkit";

const logger = createLogger("plugin-mcp");

// ============================================================================
// MCP Tools (route to MCP proxy /mcp/{mcpId}/tools/{toolName})
// ============================================================================

/**
 * Retrieval tools that we ask the upstream MCP server to return as JSON instead
 * of formatted markdown so the worker can include structured `result_summary`
 * (event IDs, snippet text) in the `tool_use` SSE event for RAG assertions.
 */
const TOOLS_REQUESTING_JSON_FORMAT = new Set([
  "search_memory",
  "lobu_search_memory",
  // The builder agent's manage_agents write gate returns a structured
  // `pending_approval` result (run_id + proposed/current). We need the JSON,
  // not formatted markdown, to forward an approval card into the chat (see
  // maybePostApprovalCard / createMcpToolDefinitions).
  "manage_agents",
  // Same shape as manage_agents: automation definition create/update/delete may
  // return pending_approval under the agent_config write-gate.
  "manage_automations",
  // manage_entity's update path queues a human-owned-field change for approval
  // (approval_queued + approval_run_id + approval_fields/current). Same reason:
  // we need the JSON to forward the entity_field_change approval card.
  "manage_entity",
]);

/**
 * Approval-gate bridge: when a gated write returns a pending-approval result,
 * post a durable approval card into the chat so the SPA renders the interactive
 * Approve/Reject diff. Handles three producers:
 *   - manage_agents write gate → `{ status: 'pending_approval', run_id,
 *     action, proposal, current }` (the builder agent's create/update/delete).
 *   - manage_automations write gate → same `pending_approval` shape (automation
 *     definition create/update/delete under agent_config).
 *   - manage_entity update gate → `{ approval_queued: true, approval_run_id,
 *     approval_fields, approval_current, approval_attribution }` (a human-owned
 *     entity field an agent or Automation proposed changing).
 *
 * Best-effort — a failed post never breaks the tool call (the agent still
 * narrates the result, and the events-tab approval card remains the fallback).
 * Returns true when a card was posted (caller logs at debug only).
 *
 * The card rides the SAME owner-gated thread_response delivery as ask_user:
 * POST /internal/interactions/create → InteractionService → API platform →
 * Postgres thread_response queue → SSE-owning pod. Multi-replica safe by reuse.
 */
export async function maybePostApprovalCard(
  gw: GatewayParams,
  toolName: string,
  rawResultText: string
): Promise<boolean> {
  const body = buildApprovalCardBody(toolName, rawResultText);
  if (!body) return false;

  // Best-effort: a failed post must never break the tool call (the agent
  // still narrates the result, and the events-tab approval card is the
  // fallback). gatewayFetch throws on a hard network error, so guard it too.
  let error: TextResult | undefined;
  try {
    ({ error } = await gatewayFetch<{ id: string }>(
      gw,
      "/internal/interactions/create",
      { method: "POST", body: JSON.stringify(body) },
      "Failed to post approval card"
    ));
  } catch {
    logger.warn(`${toolName} approval card post threw`);
    return false;
  }
  if (error) {
    logger.warn(`${toolName} approval card post failed`);
    return false;
  }
  return true;
}

/**
 * Parse a gated tool result into the /internal/interactions/create body, or
 * null when the result is not a pending approval. entity_field_change carries
 * `fields`/`attribution` (the human-owned-field diff); manage_agents carries
 * `proposal` (the agent row diff); manage_automations carries flat automation args
 * plus `resourceKind: automation`. All share the `tool_approval` transport.
 * Wire literals come from `@lobu/core` (`interaction-envelope` contract).
 */
function buildApprovalCardBody(
  toolName: string,
  rawResultText: string
): ToolApprovalCreateBody | null {
  let raw: unknown;
  try {
    raw = JSON.parse(rawResultText);
  } catch {
    return null;
  }
  const parsed = recordOrNull(raw);
  if (!parsed) return null;

  if (toolName === "manage_automations") {
    if (
      parsed.status !== "pending_approval" ||
      typeof parsed.run_id !== "number"
    ) {
      return null;
    }
    // Server proposal is `{ args: ManageAutomationsArgs }`; SPA renderer needs the
    // flat automation fields (action, slug, prompt, schedule, …).
    const rawProposal = recordOrNull(parsed.proposal);
    const flatProposal = recordOrNull(rawProposal?.args) ?? rawProposal;
    return {
      interactionType: "tool_approval",
      runId: parsed.run_id,
      action: typeof parsed.action === "string" ? parsed.action : "change",
      resourceKind: InteractionResourceKind.Automation,
      proposal: flatProposal,
      current: recordOrNull(parsed.current),
    };
  }

  if (toolName === "manage_agents") {
    if (
      parsed.status !== "pending_approval" ||
      typeof parsed.run_id !== "number"
    ) {
      return null;
    }
    return {
      interactionType: "tool_approval",
      runId: parsed.run_id,
      action: typeof parsed.action === "string" ? parsed.action : "change",
      resourceKind: InteractionResourceKind.Agent,
      proposal: recordOrNull(parsed.proposal),
      current: recordOrNull(parsed.current),
    };
  }

  if (toolName === "manage_entity") {
    if (
      parsed.approval_queued !== true ||
      typeof parsed.approval_run_id !== "number"
    ) {
      return null;
    }
    return {
      interactionType: "tool_approval",
      runId: parsed.approval_run_id,
      action:
        typeof parsed.approval_action === "string"
          ? parsed.approval_action
          : "change",
      resourceKind: InteractionResourceKind.Entity,
      proposal: recordOrNull(parsed.approval_proposal),
      // entity_field_change diff: field_path -> proposed / current. The SPA
      // routes on `fields` (non-empty) to the entity-field-change card.
      fields: recordOrNull(parsed.approval_fields),
      current: recordOrNull(parsed.approval_current),
      attribution: coerceApprovalAttribution(parsed.approval_attribution),
    };
  }

  return null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function callMcpTool(
  gw: GatewayParams,
  mcpId: string,
  toolName: string,
  args: Record<string, unknown>,
  options?: {
    timeoutMs?: number;
    supportsImages?: boolean;
    imageBudget?: ToolImageBudget;
  }
): Promise<ToolResult> {
  return withErrorHandling(`${mcpId}/${toolName}`, async () => {
    let response: Response;
    const wantsJson = TOOLS_REQUESTING_JSON_FORMAT.has(toolName);
    try {
      // Retrieval tools (`search_memory`) opt into JSON-encoded results so the
      // worker → SSE `tool_use` event can carry structured `result_summary`
      // (event ids + snippet text) to clients like @lobu/promptfoo-provider for
      // RAG assertions. Other tools keep the formatted-markdown output the
      // agent has been seeing. External MCP servers ignore the header.
      response = await createGatewayClient({
        baseUrl: gw.gatewayUrl,
        token: gw.workerToken,
      }).request(`/mcp/${mcpId}/tools/${toolName}`, {
        method: "POST",
        headers: wantsJson ? { "x-mcp-format": "json" } : undefined,
        body: JSON.stringify(args),
        // Third-party MCP server on the other side — give it a generous
        // budget but never wait forever.
        timeoutMs: options?.timeoutMs ?? 120_000,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        return textResult(`Error: MCP tool ${mcpId}/${toolName} timed out`);
      }
      throw err;
    }

    // MCP proxy returns JSON on success, but a misbehaving upstream (502
    // HTML, plain-text 500, empty body) would otherwise crash the tool call
    // with "Unexpected token < in JSON". Treat parse failure as a transport
    // error message instead of letting it bubble out as an unhandled throw.
    let data: {
      content?: Array<{ type: string; text: string }>;
      error?: string;
      isError?: boolean;
    };
    try {
      data = (await response.json()) as {
        content?: Array<{ type: string; text: string }>;
        error?: string;
        isError?: boolean;
      };
    } catch (parseErr) {
      const parseMsg =
        parseErr instanceof Error ? parseErr.message : String(parseErr);
      return textResult(
        `Error: ${toolName} returned a non-JSON response (status ${response.status}): ${parseMsg}`
      );
    }

    if (!response.ok || data.isError) {
      const contentText = joinTextContent(data.content);
      const errorMsg =
        data.error || contentText || `${toolName} failed (${response.status})`;
      return textResult(`Error: ${errorMsg}`);
    }

    return mcpToolResult(
      data.content,
      `${toolName} completed.`,
      options?.supportsImages,
      options?.imageBudget
    );
  });
}
