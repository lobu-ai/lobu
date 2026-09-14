import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnvContent } from "./env-file.js";

export const GATEWAY_DEFAULT_URL = "http://localhost:8787";

/**
 * The embedded Lobu server mounts its public Agent API (`/api/v1/agents/*`,
 * `/api/docs`) under this path prefix — see `buildWrapperApp` in
 * `packages/server/src/server-lifecycle.ts`. Every deployment (local `lobu run`,
 * app.lobu.ai, community.lobu.ai) follows this layout: the org-scoped admin
 * REST API and OAuth live at the origin, the Agent API lives at `<origin>/lobu`.
 */
export const GATEWAY_AGENT_API_PREFIX = "/lobu";

/**
 * Normalize a gateway URL (from `--gateway`, a context's apiUrl, or `.env`) to
 * the base the Agent API is served from: `<origin>/lobu`. Idempotent — passing
 * a URL that already ends in `/lobu` returns it unchanged.
 */
export function agentApiBase(gatewayUrl: string): string {
  const trimmed = gatewayUrl.replace(/\/+$/, "");
  return trimmed.endsWith(GATEWAY_AGENT_API_PREFIX)
    ? trimmed
    : trimmed + GATEWAY_AGENT_API_PREFIX;
}

interface ResolveGatewayUrlOptions {
  cwd?: string;
}

/**
 * Resolve the local gateway URL by reading `GATEWAY_PORT` / `PORT` from the
 * project's `.env` file (if present). Falls back to `GATEWAY_DEFAULT_URL` when
 * the file is missing or neither variable is set.
 */
export async function resolveGatewayUrl(
  options: ResolveGatewayUrlOptions = {}
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  try {
    const envContent = await readFile(join(cwd, ".env"), "utf-8");
    const parsed = parseEnvContent(envContent);
    const port = parsed.GATEWAY_PORT || parsed.PORT;
    if (port) return `http://localhost:${port}`;
  } catch {
    // No .env file
  }
  return GATEWAY_DEFAULT_URL;
}
