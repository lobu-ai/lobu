import { type ArtifactStore, MAX_ARTIFACT_BYTES } from "./artifact-store.js";
import { ToolUserError } from "../../utils/errors.js";

/** Transport adapters provide bytes or an authenticated fetch closure. */
export interface AttachmentSource {
  data?: Buffer | Blob;
  fetchData?: () => Promise<Buffer>;
  mimeType?: string;
  name?: string;
  size?: number;
  type?: string;
}

/** Shared ingestion for chat, multipart uploads, and MCP attachments. */
export async function ingestAttachments(
  attachments: AttachmentSource[],
  artifactStore: ArtifactStore,
  publicGatewayUrl: string,
  options: {
    binding?: string;
    signal?: AbortSignal;
    maxTotalBytes?: number;
    onBytes?: (buffer: Buffer, mimeType: string) => void;
    /** Chat can report individual failures and continue; required files cannot. */
    onError?: (error: unknown, attachment: AttachmentSource) => void;
  } = {},
): Promise<Awaited<ReturnType<ArtifactStore["publish"]>>[]> {
  const artifacts: Awaited<ReturnType<ArtifactStore["publish"]>>[] = [];
  let totalBytes = 0;
  try {
    for (const [index, attachment] of attachments.entries()) {
      try {
        options.signal?.throwIfAborted();
        const buffer = attachment.data
          ? Buffer.isBuffer(attachment.data)
            ? attachment.data
            : Buffer.from(await attachment.data.arrayBuffer())
          : await attachment.fetchData?.();
        options.signal?.throwIfAborted();
        if (!buffer?.length) throw new ToolUserError(`File ${index + 1} has no readable bytes.`, 422);
        totalBytes += buffer.length;
        if (buffer.length > MAX_ARTIFACT_BYTES || totalBytes > (options.maxTotalBytes ?? Infinity)) {
          throw new ToolUserError(`File ${index + 1} exceeds the file upload size limit.`, 413);
        }
        const mimeType = attachment.mimeType || "application/octet-stream";
        const ext = attachment.mimeType?.split("/")[1]?.split(";")[0];
        const stem = `${attachment.type || "attachment"}-${index + 1}`;
        const filename = attachment.name?.trim() || (ext ? `${stem}.${ext}` : stem);
        options.onBytes?.(buffer, mimeType);
        artifacts.push(await artifactStore.publish({
          buffer, filename, contentType: mimeType, publicGatewayUrl, binding: options.binding,
        }));
      } catch (error) {
        if (!options.onError) throw error;
        options.onError(error, attachment);
      }
    }
    return artifacts;
  } catch (error) {
    // Strict batches never expose a partial set of required attachments.
    await Promise.all(artifacts.map(({ artifactId }) => artifactStore.delete(artifactId)));
    throw error;
  }
}
