import type { McpToolDef } from "@lobu/core";
import { defineLobuPlugin } from "@lobu/plugin-api";
import {
  defineTool,
  joinTextContent,
  toToolResult,
  type GatewayParams,
  type TextResult,
} from "@lobu/plugin-toolkit";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { checkMcpLogin, logoutMcp, startMcpLogin } from "./auth";
import { callMcpTool, maybePostApprovalCard } from "./tools";

export {
  checkMcpLogin,
  logoutMcp,
  startMcpLogin,
} from "./auth";
export { callMcpTool, maybePostApprovalCard } from "./tools";

export interface McpPluginParams extends GatewayParams {
  mcpTools: Record<string, McpToolDef[]>;
  mcpStatus: Array<{
    id: string;
    name: string;
    requiresAuth: boolean;
    requiresInput?: boolean;
    authenticated?: boolean;
    configured?: boolean;
  }>;
  mcpContext?: Record<string, string>;
  onAuthChanged: () => void;
}

export function createMcpToolDefinitions(
  mcpTools: Record<string, McpToolDef[]>,
  gateway: GatewayParams,
  mcpContext?: Record<string, string>
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const [mcpId, definitions] of Object.entries(mcpTools)) {
    const contextPrefix = mcpContext?.[mcpId];
    for (const definition of definitions) {
      if (!definition.name?.trim()) continue;
      const baseDescription =
        definition.description || `MCP tool from ${mcpId}`;
      tools.push({
        name: definition.name,
        label: `${mcpId}/${definition.name}`,
        description: contextPrefix
          ? `[${contextPrefix}] ${baseDescription}`
          : baseDescription,
        parameters: definition.inputSchema
          ? Type.Unsafe(definition.inputSchema)
          : Type.Object({}),
        execute: async (_toolCallId, args, _signal, _onUpdate, context) => {
          const result = await callMcpTool(
            gateway,
            mcpId,
            definition.name,
            (args || {}) as Record<string, unknown>,
            {
              supportsImages: context?.model?.input.includes("image") === true,
            }
          );
          await maybePostApprovalCard(
            gateway,
            definition.name,
            joinTextContent(result.content)
          );
          return toToolResult(result);
        },
      });
    }
  }
  return tools;
}

export function createMcpAuthToolDefinitions(
  status: McpPluginParams["mcpStatus"],
  gateway: GatewayParams,
  existingToolNames: Set<string> = new Set(),
  onAuthChanged: () => void = () => undefined
): ToolDefinition[] {
  const specs: Array<{
    suffix: string;
    description: (name: string) => string;
    run: (mcpId: string) => Promise<TextResult>;
  }> = [
    {
      suffix: "_login",
      description: (name) =>
        `Start the authentication flow for the ${name} MCP. Use this when ${name} requires login before its tools can be used.`,
      run: (mcpId) => startMcpLogin(gateway, { mcpId }),
    },
    {
      suffix: "_login_check",
      description: (name) =>
        `Check whether authentication for the ${name} MCP has completed. Call this after the user finishes login.`,
      run: (mcpId) => checkMcpLogin(gateway, { mcpId }, onAuthChanged),
    },
    {
      suffix: "_logout",
      description: (name) =>
        `Remove the stored authentication credential for the ${name} MCP.`,
      run: (mcpId) => logoutMcp(gateway, { mcpId }),
    },
  ];

  const tools: ToolDefinition[] = [];
  for (const mcp of status) {
    if (!mcp.requiresAuth) continue;
    for (const spec of specs) {
      const name = `${mcp.id}${spec.suffix}`;
      if (existingToolNames.has(name)) continue;
      tools.push(
        defineTool({
          name,
          description: spec.description(mcp.name),
          parameters: Type.Object({}),
          run: () => spec.run(mcp.id),
        })
      );
      existingToolNames.add(name);
    }
  }
  return tools;
}

export function createMcpPlugin(params: McpPluginParams) {
  const gateway: GatewayParams = params;
  return defineLobuPlugin<ToolDefinition>({
    manifest: {
      name: "lobu-mcp",
      version: "1.0.0",
      apiVersion: 1,
      description: "First-class MCP and device-auth tools",
    },
    tools: () => {
      const tools = createMcpToolDefinitions(
        params.mcpTools,
        gateway,
        params.mcpContext
      );
      tools.push(
        ...createMcpAuthToolDefinitions(
          params.mcpStatus,
          gateway,
          new Set(tools.map((tool) => tool.name)),
          params.onAuthChanged
        )
      );
      return tools;
    },
  });
}
