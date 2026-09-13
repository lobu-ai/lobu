/**
 * `lobu call <tool> [args]` — generic dispatcher over the admin REST surface
 * mounted at `POST /api/:orgSlug/:toolName`. Companion to `lobu call --list`
 * (`GET /api/:orgSlug/tools`).
 *
 * Argument shapes (mutually exclusive):
 *   --input-file <path>     JSON object read from disk
 *   stdin                   JSON object piped on stdin (when stdin is not a TTY)
 *   --arg key=value         flat string field (top-level only)
 *   --arg key:=<jsonvalue>  JSON-parsed field (httpie-style)
 *
 * Output is pretty JSON by default; `--raw` switches to compact JSON for piping.
 * Errors go to stderr with exit code 1 (ApiError) / 2 (validation).
 */

import { readFile } from "node:fs/promises";

import { resolveApiClient } from "../internal/api-client.js";
import { printJson } from "../internal/output.js";
import { parseJsonObject, ValidationError } from "./memory/_lib/errors.js";
import { restToolCall } from "./memory/_lib/mcp.js";
import {
  getSessionForOrg,
  mcpUrlForOrg,
  resolveOrg,
  resolveServerUrl,
} from "./memory/_lib/memory-auth.js";

interface CallOptions {
  org?: string;
  context?: string;
  inputFile?: string;
  arg?: string[];
  list?: boolean;
  all?: boolean;
  json?: boolean;
  raw?: boolean;
  url?: string;
}

interface ToolListEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
  internal?: boolean;
}

/** Parse a single `--arg key=value` or `key:=<json>` entry into a [key, value]. */
export function parseArgEntry(entry: string): [string, unknown] {
  // `:=` first — must be longer than `=` to win the prefix match.
  const jsonIdx = entry.indexOf(":=");
  const eqIdx = entry.indexOf("=");
  if (jsonIdx >= 0 && (eqIdx < 0 || jsonIdx < eqIdx)) {
    const key = entry.slice(0, jsonIdx).trim();
    const rawValue = entry.slice(jsonIdx + 2);
    if (!key) {
      throw new ValidationError(`--arg "${entry}" has no key before ':='`);
    }
    try {
      return [key, JSON.parse(rawValue)];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(
        `--arg "${entry}": value after ':=' must be valid JSON (${message})`
      );
    }
  }
  if (eqIdx >= 0) {
    const key = entry.slice(0, eqIdx).trim();
    const value = entry.slice(eqIdx + 1);
    if (!key) {
      throw new ValidationError(`--arg "${entry}" has no key before '='`);
    }
    return [key, value];
  }
  throw new ValidationError(
    `--arg "${entry}" missing '=' or ':='. Use key=string or key:=<json>.`
  );
}

async function readStdinJson(): Promise<Record<string, unknown> | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return parseJsonObject(raw, "on stdin");
}

async function readInputFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(
      `Failed to read --input-file ${path}: ${message}`
    );
  }
  return parseJsonObject(raw, `in ${path}`);
}

/** Build the args payload from the three mutually-exclusive sources. */
export async function buildArgs(
  options: CallOptions
): Promise<Record<string, unknown>> {
  const argEntries = options.arg ?? [];
  const hasArgFlag = argEntries.length > 0;
  const hasFile = !!options.inputFile;

  if (hasArgFlag && hasFile) {
    throw new ValidationError(
      "Cannot combine --arg with --input-file. Pick one."
    );
  }

  if (hasFile) {
    return readInputFile(options.inputFile as string);
  }

  if (hasArgFlag) {
    const out: Record<string, unknown> = {};
    for (const entry of argEntries) {
      const [key, value] = parseArgEntry(entry);
      out[key] = value;
    }
    return out;
  }

  const fromStdin = await readStdinJson();
  if (fromStdin) return fromStdin;

  // No payload provided — let the server validate. Empty object is the
  // honest default; many admin tools have all-optional fields.
  return {};
}

/** Resolve the MCP URL for the requested org (mirrors `memory run`'s chain). */
async function resolveCallEndpoint(options: CallOptions): Promise<string> {
  const org = await resolveOrg(options.org, undefined, options.context);
  if (!org) {
    throw new ValidationError(
      "Cannot resolve org slug. Pass --org or run `lobu context use <name>` / `lobu org set <slug>`."
    );
  }
  const orgSession = await getSessionForOrg(org, options.context, options.url);
  if (orgSession) return orgSession.key;

  const base = await resolveServerUrl(options.url, options.context);
  if (!base) {
    throw new ValidationError(
      "Server URL required. Pass --url or configure a context with `lobu context add`."
    );
  }
  return mcpUrlForOrg(base, org);
}

function printToolList(
  tools: ToolListEntry[],
  options: { json: boolean; raw: boolean; includeInternal: boolean }
): void {
  const visible = options.includeInternal
    ? tools
    : tools.filter((t) => t.internal !== true);

  if (options.json) {
    printJson({ tools: visible }, options.raw);
    return;
  }

  if (visible.length === 0) {
    process.stdout.write("No tools available.\n");
    return;
  }

  const nameWidth = Math.max(...visible.map((t) => t.name.length));
  for (const tool of visible) {
    const tag = tool.internal ? " [admin]" : "";
    const desc = tool.description ? ` — ${tool.description}` : "";
    process.stdout.write(`  ${tool.name.padEnd(nameWidth)}${tag}${desc}\n`);
  }
  process.stdout.write(`\n${visible.length} tool(s)\n`);
}

export async function callCommand(
  tool: string | undefined,
  options: CallOptions = {}
): Promise<void> {
  const json = options.json === true;
  const raw = options.raw === true;
  if (options.list || !tool) {
    const { client, orgSlug } = await resolveApiClient({
      context: options.context,
      org: options.org,
      apiUrl: options.url,
    });
    const result = await client.get<{ tools: ToolListEntry[] }>(
      `/api/${encodeURIComponent(orgSlug)}/tools`
    );
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    printToolList(tools, {
      json,
      raw,
      includeInternal: options.all === true,
    });
    return;
  }

  const mcpUrl = await resolveCallEndpoint(options);
  const args = await buildArgs(options);
  const result = await restToolCall<unknown>(
    mcpUrl,
    tool,
    args,
    options.context
  );
  printJson(result, raw);
}
