import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export interface ToolResult {
  [key: string]: unknown;
  content: AgentToolResult<Record<string, unknown>>["content"];
}

// Tool-result limits, shared by both managed-agent adapters and the MCP host.
export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOOL_IMAGE_BYTES_TOTAL = 10 * 1024 * 1024;
export const MAX_TOOL_IMAGES = 8;

/** Decoded image bytes already retained in the session; a count would lock out small observations. */
export interface ToolImageBudget {
  bytes: number;
}

/** Charge images already retained in the session, including user attachments. */
export function toolImageBudget(content: unknown[]): ToolImageBudget {
  const budget = { bytes: 0 };
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    if (part.type !== "image" || typeof part.data !== "string") continue;
    budget.bytes +=
      Math.ceil(part.data.length / 4) * 3 -
      (part.data.endsWith("==") ? 2 : part.data.endsWith("=") ? 1 : 0);
  }
  return budget;
}

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function isToolImageMimeType(value: unknown): value is string {
  return typeof value === "string" && IMAGE_TYPES.has(value);
}

/** Validate before decoding/copying. No URL fetching or Node dependency. */
function imageBytes(data: unknown): number | null {
  if (typeof data !== "string" || data.length === 0) return null;
  if (data.length > 4 * Math.ceil(MAX_TOOL_IMAGE_BYTES / 3)) return null;
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    return null;
  return (
    (data.length / 4) * 3 -
    (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
  );
}

function hasImageSignature(data: string, mimeType: string): boolean {
  const header = atob(data.slice(0, 16));
  if (mimeType === "image/png") return header.startsWith("\x89PNG\r\n\x1a\n");
  if (mimeType === "image/jpeg") return header.startsWith("\xff\xd8\xff");
  if (mimeType === "image/gif")
    return header.startsWith("GIF87a") || header.startsWith("GIF89a");
  return header.startsWith("RIFF") && header.slice(8, 12) === "WEBP";
}

/**
 * Preserve MCP pixels as Pi image blocks. Links alone never become pixels;
 * callers must resolve them through their permission-aware resource reader.
 * Unsupported/malformed/over-budget images produce a visible diagnostic.
 */
export function mcpToolResult(
  content: unknown,
  fallback: string,
  supportsImages = true,
  budget?: ToolImageBudget
): ToolResult {
  const result: ToolResult = { content: [] };
  let count = 0;
  let total = 0;
  let hasImageLink = false;
  const diagnostics = new Set<string>();
  for (const raw of Array.isArray(content) ? content : []) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text) result.content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "resource_link") {
      hasImageLink ||= isToolImageMimeType(part.mimeType);
      continue;
    }
    const resource =
      part.type === "resource" &&
      part.resource &&
      typeof part.resource === "object"
        ? (part.resource as Record<string, unknown>)
        : undefined;
    if (resource && typeof resource.text === "string") {
      if (resource.text)
        result.content.push({ type: "text", text: resource.text });
      continue;
    }
    if (
      part.type !== "image" &&
      !(
        resource &&
        typeof resource.mimeType === "string" &&
        resource.mimeType.startsWith("image/")
      )
    )
      continue;
    const mimeType = resource ? resource.mimeType : part.mimeType;
    const data = resource ? resource.blob : part.data;
    const size = imageBytes(data);
    let reason: string | undefined;
    if (!supportsImages)
      reason = "the selected model does not declare image input support";
    else if (
      !isToolImageMimeType(mimeType) ||
      size === null ||
      size === 0 ||
      !hasImageSignature(data as string, mimeType)
    )
      reason =
        "unsupported MIME type, invalid image bytes, or image size limit";
    else if (
      size > MAX_TOOL_IMAGE_BYTES ||
      count >= MAX_TOOL_IMAGES ||
      total + size > MAX_TOOL_IMAGE_BYTES_TOTAL ||
      (budget && budget.bytes + size > MAX_TOOL_IMAGE_BYTES_TOTAL)
    )
      reason = "tool image budget exhausted";
    if (reason) {
      diagnostics.add(
        `Image not delivered: ${reason}. Do not infer visual contents.`
      );
      continue;
    }
    result.content.push({
      type: "image",
      mimeType: mimeType as string,
      data: data as string,
    });
    count++;
    total += size!;
    if (budget) budget.bytes += size!;
  }
  if (hasImageLink && count === 0)
    diagnostics.add(
      "Image bytes were not supplied. A resource link alone is not a visual observation."
    );
  for (const text of diagnostics) result.content.push({ type: "text", text });
  if (result.content.length === 0)
    result.content.push({ type: "text", text: fallback });
  return result;
}
