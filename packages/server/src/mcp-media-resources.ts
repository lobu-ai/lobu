import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isToolImageMimeType, MAX_TOOL_IMAGE_BYTES, MAX_TOOL_IMAGE_BYTES_TOTAL, MAX_TOOL_IMAGES, mcpToolResult } from '@lobu/plugin-toolkit';
import {
  ArtifactStore,
  eventArtifactBinding,
  runArtifactBinding,
} from './gateway/files/artifact-store';
import type { Env } from './index';
import { getLobuCoreServices } from './lobu/gateway';
import { type AuthContext, executeTool, toAccountToolContext } from './tools/execute';
import { getDb } from './db/client';
import { resolveCrossOrgToolContext } from './sandbox/client-sdk';

// resources/read embeds base64 in one JSON-RPC response, so the decoded cap
// bounds how much a single read can amplify app memory. Kept at the limit
// this endpoint already served: lowering it would silently start rejecting
// media that reads fine today.
const MAX_MCP_RESOURCE_BYTES = 20 * 1024 * 1024;

type ResourceLink = Extract<
  CallToolResult['content'][number],
  { type: 'resource_link' }
>;

type AttachmentRecord = {
  artifact_id?: unknown;
  filename?: unknown;
  mime_type?: unknown;
  size_bytes?: unknown;
};

type ResourceRef =
  | { kind: 'run'; id: number; index: number }
  | { kind: 'event'; id: number; index: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function runAttachmentResourceUri(runId: number, index: number): string {
  return `lobu://run/${runId}/attachment/${index}`;
}

function eventAttachmentResourceUri(eventId: number, index: number): string {
  return `lobu://event/${eventId}/attachment/${index}`;
}

function resourceLinksForAttachments(
  uriForIndex: (index: number) => string,
  attachments: unknown
): ResourceLink[] {
  if (!Array.isArray(attachments)) return [];

  return attachments.flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    const attachment = raw as AttachmentRecord;
    if (
      typeof attachment.artifact_id !== 'string' ||
      typeof attachment.mime_type !== 'string'
    ) {
      return [];
    }
    const name =
      typeof attachment.filename === 'string' && attachment.filename.trim()
        ? attachment.filename
        : `attachment-${index + 1}`;
    const size = nonNegativeInteger(attachment.size_bytes);
    return [
      {
        type: 'resource_link' as const,
        uri: uriForIndex(index),
        name,
        mimeType: attachment.mime_type,
        ...(size !== null ? { size } : {}),
      },
    ];
  });
}

function resourceLinksForRunOutput(runId: number, output: unknown): ResourceLink[] {
  if (!isRecord(output)) return [];
  return resourceLinksForAttachments(
    (index) => runAttachmentResourceUri(runId, index),
    output.attachments
  );
}

function resourceLinksForKnowledgeRead(value: Record<string, unknown>): ResourceLink[] {
  if (!Array.isArray(value.content)) return [];

  return value.content.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const eventId = positiveInteger(raw.id);
    if (eventId === null) return [];
    return resourceLinksForAttachments(
      (index) => eventAttachmentResourceUri(eventId, index),
      raw.attachments
    );
  });
}

/**
 * Recognize resource-bearing ClientSDK return values and expose materialized
 * attachments as MCP resource links. Links use Lobu-owned stable ids, never
 * ephemeral signed download URLs.
 */
function resourceLinksForSdkLeaf(value: unknown): ResourceLink[] {
  if (!isRecord(value)) return [];

  if (value.action === 'execute' && value.status === 'completed') {
    const runId = positiveInteger(value.run_id);
    return runId === null ? [] : resourceLinksForRunOutput(runId, value.output);
  }

  if (value.action === 'get_run' && isRecord(value.run)) {
    const runId = positiveInteger(value.run.id);
    return runId === null
      ? []
      : resourceLinksForRunOutput(runId, value.run.output);
  }

  return resourceLinksForKnowledgeRead(value);
}

export function mcpResourceLinksForSdkReturnValue(value: unknown): ResourceLink[] {
  const links = new Map<string, ResourceLink>();
  const seen = new Set<object>();
  let visited = 0;
  function visit(current: unknown, depth: number): void {
    if (depth > 8 || visited >= 1_000 || links.size >= 64) return;
    visited++;
    if (!current || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    const own = resourceLinksForSdkLeaf(current);
    if (own.length > 0) {
      for (const link of own) {
        if (links.size >= 64) break;
        links.set(link.uri, link);
      }
      return;
    }
    for (const child of Object.values(current)) {
      visit(child, depth + 1);
      if (visited >= 1_000 || links.size >= 64) break;
    }
  }
  visit(value, 0);
  return [...links.values()];
}

/**
 * Resolve only host-authored Lobu links, through the SAME reader used by
 * resources/read. No signed URL, arbitrary fetch, or caller-supplied artifact
 * binding. A missing image never changes an already completed operation into
 * a retryable failure: report the delivery problem alongside the resource.
 */
export async function mcpImagesForResourceLinks(
  content: CallToolResult['content'],
  read: (uri: string, maxBytes: number) => Promise<{ contents: Array<{ mimeType: string; blob: string }> } | null>
): Promise<CallToolResult['content']> {
  const output: CallToolResult['content'] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let attempted = 0;
  for (const link of content) {
    if (link.type !== 'resource_link' || !parseAttachmentUri(link.uri) || !isToolImageMimeType(link.mimeType) || seen.has(link.uri)) continue;
    seen.add(link.uri);
    const limit = Math.min(MAX_TOOL_IMAGE_BYTES, MAX_TOOL_IMAGE_BYTES_TOTAL - bytes);
    if (attempted >= MAX_TOOL_IMAGES || limit <= 0 || (typeof link.size === 'number' && link.size > limit)) {
      output.push({ type: 'text', text: `Image not delivered for ${link.uri}: tool image budget exhausted.` });
      continue;
    }
    attempted++;
    try {
      const resource = await read(link.uri, limit);
      const stored = resource?.contents[0];
      if (!stored) throw new Error('unavailable');
      const normalized = mcpToolResult([{ type: 'image', mimeType: stored.mimeType, data: stored.blob }], '');
      const image = normalized.content.find(part => part.type === 'image');
      const size = image ? Buffer.from(image.data, 'base64').length : 0;
      if (!image || size > limit) throw new Error('unavailable');
      output.push(image);
      bytes += size;
    } catch {
      // Do not leak a permission/storage error's details or suggest repeating
      // the operation (which could have side effects).
      output.push({ type: 'text', text: `Image not delivered for ${link.uri}: unavailable, invalid, unauthorized, or over budget. Do not infer visual contents.` });
    }
  }
  return output;
}

function parseAttachmentUri(uri: string): ResourceRef | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'lobu:') return null;
  const kind = parsed.hostname;
  if (kind !== 'run' && kind !== 'event') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[1] !== 'attachment') return null;
  const id = Number(parts[0]);
  const index = Number(parts[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return { kind, id, index };
}

async function loadResourceAttachment(
  ref: ResourceRef,
  env: Env,
  authCtx: AuthContext
): Promise<{ attachment: Record<string, unknown>; binding: string } | null> {
  if (ref.kind === 'run') {
    const result = await executeTool(
      'manage_operations',
      { action: 'get_run', run_id: ref.id },
      env,
      authCtx
    );
    if (!isRecord(result) || result.action !== 'get_run' || !isRecord(result.run)) {
      return null;
    }
    const output = result.run.output;
    if (!isRecord(output) || !Array.isArray(output.attachments)) return null;
    const raw = output.attachments[ref.index];
    return isRecord(raw)
      ? { attachment: raw, binding: runArtifactBinding(ref.id) }
      : null;
  }

  const result = await executeTool(
    'read_knowledge',
    { content_ids: [ref.id], limit: 50 },
    env,
    authCtx
  );
  if (!isRecord(result) || !Array.isArray(result.content)) return null;
  const item = result.content.find(
    (raw) => isRecord(raw) && positiveInteger(raw.id) === ref.id
  );
  if (!isRecord(item) || !Array.isArray(item.attachments)) return null;
  const raw = item.attachments[ref.index];
  if (!isRecord(raw) || !authCtx.organizationId) return null;
  const originId = typeof item.origin_id === 'string' ? item.origin_id : '';
  if (!originId) return null;
  return {
    attachment: raw,
    binding: eventArtifactBinding({
      organizationId: authCtx.organizationId,
      connectionId: positiveInteger(item.connection_id),
      feedId: positiveInteger(item.feed_id),
      originId,
    }),
  };
}

/**
 * Resolve a stable Lobu attachment URI through the same permission-aware
 * readers used by SDK/MCP tools, then return its bytes as an MCP blob.
 */
export async function readMcpAttachmentResource(
  uri: string,
  env: Env,
  authCtx: AuthContext,
  maxBytes = MAX_MCP_RESOURCE_BYTES
): Promise<
  | {
      contents: Array<{
        uri: string;
        mimeType: string;
        blob: string;
      }>;
    }
  | null
> {
  const ref = parseAttachmentUri(uri);
  if (!ref) return null;

  // Account-scoped SDK calls may select a workspace without changing the MCP
  // session's anchor. Resolve the resource's workspace through the same live
  // grant/membership gate as client.org(), then use the normal resource reader.
  // The indexed id lookup locates a workspace; it confers no read authority.
  if (!authCtx.organizationId || authCtx.allowCrossOrg || authCtx.chatSenderReach) {
    const sql = getDb();
    const [row] = ref.kind === 'run'
      ? await sql`SELECT organization_id FROM runs WHERE id = ${ref.id}`
      : await sql`SELECT organization_id FROM events WHERE id = ${ref.id}`;
    if (!row?.organization_id) throw new Error(`Unknown resource: ${uri}`);
    if (row.organization_id !== authCtx.organizationId) {
      const workspace = await resolveCrossOrgToolContext(row.organization_id, toAccountToolContext(authCtx))
        .catch(() => null);
      if (!workspace) throw new Error(`Unknown resource: ${uri}`);
      authCtx = { ...authCtx, organizationId: workspace.organizationId,
        memberRole: workspace.memberRole, agentId: workspace.agentId ?? null };
    }
  }
  const loaded = await loadResourceAttachment(ref, env, authCtx);
  const attachment = loaded?.attachment;
  if (!loaded || !attachment || typeof attachment.artifact_id !== 'string') {
    throw new Error(`Unknown resource: ${uri}`);
  }

  const artifactStore =
    getLobuCoreServices()?.getArtifactStore() ?? new ArtifactStore();
  // Metadata first: a bounded `read` reports an oversized artifact as simply
  // absent, and the caller needs to be told the payload exists but cannot be
  // inlined.
  const metadata = await artifactStore.inspect(attachment.artifact_id, {
    binding: loaded.binding,
  });
  if (!metadata) throw new Error(`Unknown resource: ${uri}`);
  const limit = Math.min(MAX_MCP_RESOURCE_BYTES, maxBytes);
  if (metadata.size > limit) {
    throw new Error(
      `MCP resource is too large to inline (${metadata.size} bytes; limit ${limit})`
    );
  }

  const stored = await artifactStore.read(attachment.artifact_id, {
    binding: loaded.binding,
    maxBytes: limit,
  });
  if (!stored) throw new Error(`Unknown resource: ${uri}`);
  return {
    contents: [
      {
        uri,
        mimeType: stored.metadata.contentType,
        blob: stored.bytes.toString('base64'),
      },
    ],
  };
}
