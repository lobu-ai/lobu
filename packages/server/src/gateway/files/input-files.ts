import { createHash } from 'node:crypto';
import { fetchPublicUrl } from '@lobu/connector-worker/egress';
import type { FileReference } from '@lobu/connector-sdk';
import { type ArtifactStore, MAX_ARTIFACT_BYTES } from './artifact-store';
import { ingestAttachments, type AttachmentSource } from './attachment-ingestion';
import type { AccountToolContext } from '../../tools/registry';
import { ToolUserError } from '../../utils/errors';
import { cancelResponseBody, readResponseBytesWithLimit } from '../../utils/bounded-response';

export const MAX_INPUT_FILES = 10;
export const MAX_INPUT_TOTAL_BYTES = 100 * 1024 * 1024;

export type InputFileOwner = Pick<
  AccountToolContext,
  'organizationId' | 'userId' | 'agentId' | 'actingAutomationId' | 'isAuthenticated' | 'scopes'
>;

export interface StoredInputFile extends FileReference {
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
}

export function inputFileBinding(owner: InputFileOwner): string {
  if (!owner.isAuthenticated || !owner.organizationId || !owner.userId) {
    throw new ToolUserError('File input requires an authenticated user and a selected workspace.', 403);
  }
  // Human sessions and ordinary OAuth callers share files within an identity;
  // agent, Automation, and device-worker callers use separate namespaces.
  const principal = JSON.stringify([
    owner.organizationId, owner.userId, owner.agentId ?? null, owner.actingAutomationId ?? null,
    owner.scopes?.includes('device_worker:run') ? 'device-worker' : 'user',
  ]);
  return `input:${createHash('sha256').update(principal).digest('hex')}`;
}

export function inputArtifactId(reference: unknown): string | null {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return null;
  const value = (reference as Record<string, unknown>).$file;
  if (typeof value !== 'string') return null;
  return /^lobu:\/\/file\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(value)?.[1] ?? null;
}

export function storedInputFile(metadata: {
  artifactId: string; filename: string; contentType: string; size: number; sha256: string;
}): StoredInputFile {
  return {
    $file: `lobu://file/${metadata.artifactId}`,
    filename: metadata.filename,
    content_type: metadata.contentType,
    size_bytes: metadata.size,
    sha256: metadata.sha256,
  };
}

/** Strict counterpart to chat attachment ingestion: no silently omitted files. */
export async function ingestInputFiles(
  sources: AttachmentSource[],
  owner: InputFileOwner,
  store: ArtifactStore,
  publicGatewayUrl: string,
  signal?: AbortSignal,
): Promise<StoredInputFile[]> {
  const binding = inputFileBinding(owner);
  if (sources.length === 0 || sources.length > MAX_INPUT_FILES) {
    throw new ToolUserError(`Supply between 1 and ${MAX_INPUT_FILES} files.`, 400);
  }
  for (const [index, source] of sources.entries()) {
    if ((source.name != null && (source.name.length > 255 || /[\r\n\0]/.test(source.name))) ||
        (source.mimeType != null && (source.mimeType.length > 100 || /[\r\n\0]/.test(source.mimeType)))) {
      throw new ToolUserError(`File ${index + 1} has invalid filename or media type metadata.`, 422);
    }
  }
  const artifacts = await ingestAttachments(sources, store, publicGatewayUrl, { binding, signal, maxTotalBytes: MAX_INPUT_TOTAL_BYTES });
  return artifacts.map(storedInputFile);
}

/** URL intake is common to all hosts; never forward provider credentials. */
export async function fetchInputFile(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType?: string }> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new ToolUserError('File download requires an HTTPS URL without embedded credentials.', 422);
    }
    const deadline = AbortSignal.timeout(30_000);
    const response = await fetchPublicUrl(parsed, {
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      redirect: 'error',
    });
    if (!response.ok || !response.body) {
      await cancelResponseBody(response);
      throw new ToolUserError(`File download returned HTTP ${response.status}. Upload the file again.`, 422);
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType && (contentType.length > 100 || /[\r\n\0]/.test(contentType))) {
      await cancelResponseBody(response);
      throw new ToolUserError('Downloaded file has invalid media type metadata.', 422);
    }
    return {
      bytes: await readResponseBytesWithLimit(response, MAX_ARTIFACT_BYTES, 'File exceeds the upload size limit'),
      contentType: contentType || undefined,
    };
  } catch (error) {
    if (error instanceof ToolUserError) throw error;
    if (error instanceof RangeError) throw new ToolUserError('File exceeds the file upload size limit.', 413);
    // Download URLs can contain bearer tokens. Never expose fetch/parser errors.
    throw new ToolUserError('File download failed. Supply a fresh direct download link or upload the file again.', 422);
  }
}

export function attachmentFromUrl(url: string, metadata: Pick<AttachmentSource, 'name' | 'mimeType'>, signal?: AbortSignal): AttachmentSource {
  const attachment: AttachmentSource = {
    ...metadata,
    fetchData: async () => {
      const downloaded = await fetchInputFile(url, signal);
      if (!attachment.mimeType) attachment.mimeType = downloaded.contentType;
      return downloaded.bytes;
    },
  };
  return attachment;
}
