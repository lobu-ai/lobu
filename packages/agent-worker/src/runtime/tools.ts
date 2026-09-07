import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import {
  type BashCommandPolicy,
  enforceBashCommandPolicy,
  isDirectPackageInstallCommand,
  withLobuFileParameters,
} from "@lobu/core";
import { buildAgentEnv } from "../shared/worker-env-keys";

export function createLobuTools(
  cwd: string,
  options?: { bashOperations?: BashOperations; bashPolicy?: BashCommandPolicy }
): AgentTool<any>[] {
  const read = withLobuFileParameters(createReadTool(cwd), "read");
  const write = withLobuFileParameters(createWriteTool(cwd), "write");
  const edit = withLobuFileParameters(createEditTool(cwd), "edit");

  const bashToolOpts = {
    ...(options?.bashOperations ? { operations: options.bashOperations } : {}),
    spawnHook: (params: {
      command: string;
      cwd: string;
      env: Record<string, string | undefined>;
    }) => ({
      command: params.command,
      cwd: params.cwd,
      env: buildAgentEnv(params.env) as NodeJS.ProcessEnv,
    }),
  };
  const bash = wrapBashWithProxyHint(
    createBashTool(cwd, bashToolOpts),
    options?.bashPolicy
  );

  return [
    read,
    write,
    edit,
    bash,
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}

function isDirectGatewayApiAccessCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  if (/\$(?:\{)?(?:DISPATCHER_URL|WORKER_TOKEN)\b/.test(trimmed)) {
    return true;
  }

  if (!/\b(?:curl|wget|http|httpie|fetch)\b/i.test(trimmed)) {
    return false;
  }

  if (!/\/(?:internal|mcp)(?:\/|\b)/i.test(trimmed)) {
    return false;
  }

  const gatewayTargets = new Set<string>([
    "http://gateway",
    "https://gateway",
    "gateway:",
    "http://dispatcher",
    "https://dispatcher",
    "dispatcher:",
    "http://localhost",
    "https://localhost",
    "localhost:",
    "http://127.0.0.1",
    "https://127.0.0.1",
    "127.0.0.1:",
  ]);

  const dispatcherUrl = process.env.DISPATCHER_URL?.trim();
  if (dispatcherUrl) {
    gatewayTargets.add(dispatcherUrl);
    gatewayTargets.add(dispatcherUrl.replace(/\/+$/, ""));
    try {
      const parsed = new URL(dispatcherUrl);
      gatewayTargets.add(`${parsed.protocol}//${parsed.host}`);
      gatewayTargets.add(parsed.host);
      gatewayTargets.add(parsed.hostname);
    } catch {
      // Ignore invalid dispatcher URLs and rely on static aliases.
    }
  }

  const normalized = trimmed.toLowerCase();
  return [...gatewayTargets].some((target) =>
    normalized.includes(target.toLowerCase())
  );
}

/**
 * The command-inspection gauntlet the hardened bash tool applies before it runs
 * anything. Extracted so BOTH the agent's tool wrapper (below) and the `!`-bash
 * intercept (which calls pi's `session.executeBash` for its transcript recording
 * and so bypasses the tool wrapper) enforce the SAME guards from one source of
 * truth. Throws on any violation; returns void when the command is allowed.
 * Order:
 *   - prefix allow/deny policy (`enforceBashCommandPolicy`)
 *   - direct-gateway-API-access block
 *   - direct-package-install block
 *
 * NOT included here: env allowlisting (`spawnHook`/`buildAgentEnv`, inside
 * `createBashTool`) and bash *removal* when policy disallows it (a tool-list
 * filter in the caller). The `!` intercept covers those separately: it selects
 * the same hardened `BashOperations` and only runs when bash survived the
 * removal filter.
 */
export function enforceBashPreflight(
  command: string,
  bashPolicy?: BashCommandPolicy
): void {
  if (bashPolicy) {
    enforceBashCommandPolicy(command, bashPolicy);
  }
  if (isDirectGatewayApiAccessCommand(command)) {
    throw new Error(
      "DIRECT GATEWAY API ACCESS BLOCKED. Use the registered MCP/auth tools instead of calling gateway /mcp or /internal endpoints from Bash."
    );
  }
  if (isDirectPackageInstallCommand(command)) {
    throw new Error(
      "DIRECT PACKAGE INSTALL BLOCKED. Install system packages with nixPackages in lobu.config.ts or agent settings instead of using package managers inside the worker."
    );
  }
}

/**
 * The single hardened bash entry point. Wraps the raw bash tool so any caller
 * that holds this tool object gets the full policy by construction — the agent's
 * tool loop routes through here. It runs {@link enforceBashPreflight} on the
 * extracted command, then, on failure, appends a proxy-403 hint (curl hides the
 * proxy CONNECT body, so the model would otherwise see only exit code 56, not
 * "Domain not allowed").
 *
 * Env allowlisting (`spawnHook`/`buildAgentEnv`) lives inside `createBashTool`;
 * bash *removal* when policy disallows it is a tool-list filter in the caller.
 */
function wrapBashWithProxyHint(
  tool: AgentTool<any>,
  bashPolicy?: BashCommandPolicy
): AgentTool<any> {
  const PROXY_403_PATTERN = /Received HTTP code 403 from proxy after CONNECT/i;

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const command =
        params && typeof params === "object" && "command" in params
          ? String((params as { command?: unknown }).command ?? "")
          : "";
      enforceBashPreflight(command, bashPolicy);
      try {
        return await tool.execute(toolCallId, params, signal, onUpdate);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (PROXY_403_PATTERN.test(msg)) {
          throw new Error(
            `DOMAIN BLOCKED BY PROXY. The domain is blocked at the network level. Network access is configured via lobu.config.ts or the gateway configuration APIs — do NOT retry the request.\n\n${msg}`
          );
        }
        throw err;
      }
    },
  };
}
