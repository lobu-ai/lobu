/**
 * Portable connector file OUTPUT — the symmetric counterpart to `file-input.ts`.
 *
 * A connector hands bytes back by emitting an `attachments` array. The gateway
 * strips the bytes into the artifact store and rewrites each entry to an
 * `artifact_id` plus a signed `download_url`, so the bytes reach a device or a
 * sandbox over HTTP instead of through the model's context. A connector that
 * returns file content any other way (a bare base64 string, a provider URL that
 * needs the provider's credential) cannot be downloaded by an agent at all.
 *
 * This module exists because that emit step is identical for every provider —
 * only "which URL holds the bytes" differs. Before it, Drive carried its own
 * copy of the size guards, the UTF-8-safe truncation and the output shape, and
 * every other connector would have needed the same ~100 lines. Getting any one
 * of them subtly wrong is silent: a mis-sliced UTF-8 string stores a
 * manufactured U+FFFD, and a missing size guard is an out-of-memory kill rather
 * than a readable error.
 */

/**
 * Ceiling on a single download, enforced by the connector before it buffers.
 *
 * This sits ABOVE the gateway's own 8 MiB attachment cap on purpose: the
 * gateway decides what is too big to STORE and reports it as
 * `attachments_rejected`, while this decides what is too big to hold in memory.
 * A connector isolate buffers the whole body and then base64s it at 4/3 the
 * size, so an unbounded download is an OOM kill, not a rejected attachment.
 */
export const MAX_CONNECTOR_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** Inline text budget when the caller does not ask for one. */
export const DEFAULT_INLINE_CONTENT_BYTES = 256 * 1024;

/** Hard ceiling on inline text, whatever the caller asks for. */
export const MAX_INLINE_CONTENT_BYTES = 1024 * 1024;

/** Media types that are text even though they are not `text/*`. */
const TEXTUAL_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-yaml',
  'application/yaml',
  'application/typescript',
  'application/rtf',
  'application/x-sh',
  'application/sql',
  'image/svg+xml',
]);

/** True when a media type's bytes are meaningfully readable as text. */
export function isTextualMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return TEXTUAL_MIME_TYPES.has(base) || base.startsWith('text/');
}

/**
 * Clamp a caller-supplied `inline_max_bytes` into the allowed range.
 *
 * A non-number, a negative, or an absent value all fall back to the default;
 * `0` is honoured as "do not inline" rather than treated as absent, which is
 * why this cannot be written with `??`.
 */
export function inlineContentBudget(requested: unknown): number {
  const valid =
    typeof requested === 'number' && Number.isFinite(requested) && requested >= 0;
  return Math.min(valid ? requested : DEFAULT_INLINE_CONTENT_BYTES, MAX_INLINE_CONTENT_BYTES);
}

/**
 * Refuse an oversized download and say why, or return null to proceed.
 *
 * Call it twice: once with the size the provider DECLARES (before fetching, so
 * a 2 GB file costs nothing) and once with the bytes actually received, because
 * a provider may omit the declared size entirely — Google Drive does exactly
 * that for its native documents.
 */
export function downloadSizeError(
  size: number | undefined,
  label: string,
): string | null {
  if (size === undefined || size <= MAX_CONNECTOR_DOWNLOAD_BYTES) return null;
  return `File ${label} is ${size} bytes, above the ${MAX_CONNECTOR_DOWNLOAD_BYTES}-byte download limit. Fetch it directly from the provider instead.`;
}

/**
 * Cut already-valid UTF-8 to a byte budget without manufacturing a U+FFFD.
 *
 * A plain `slice(0, maxBytes)` can cut mid-sequence, and the decoder turns the
 * orphaned bytes into U+FFFD — a garbage character that then gets stored and
 * embedded. Back off up to three bytes (the longest UTF-8 tail) until the slice
 * decodes cleanly, so a legitimate U+FFFD already in the source is preserved
 * while a manufactured one is impossible.
 */
function decodeTruncated(encoded: Uint8Array, maxBytes: number): string {
  const strict = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end > maxBytes - 4 && end >= 0; end--) {
    try {
      return strict.decode(encoded.slice(0, end));
    } catch {
      // Slice ended mid-sequence — drop a byte and retry.
    }
  }
  // Unreachable: `encoded` always comes from TextEncoder, so one of the four
  // slices above lands on a character boundary. Returning lossily here would
  // manufacture the very U+FFFD this function exists to prevent.
  return '';
}

/**
 * Decode downloaded bytes as text and cut them to the inline budget.
 *
 * The decode comes FIRST because `decodeTruncated` requires well-formed UTF-8
 * (it hands back nothing rather than manufacture a U+FFFD), and a downloaded
 * file is not required to be any such thing — a latin-1 CSV would otherwise
 * inline as an empty string, the exact "looks like an empty file" outcome this
 * module refuses everywhere else. Decoding lossily once and re-encoding gives
 * the truncator the input it documents, and makes a truncated file read the
 * same as the first page of an untruncated one.
 */
export function inlineText(
  bytes: Uint8Array,
  maxBytes: number,
): { content: string; truncated: boolean } {
  const text = new TextDecoder('utf-8').decode(bytes);
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return { content: text, truncated: false };
  return { content: decodeTruncated(encoded, maxBytes), truncated: true };
}

export interface FileDownloadOutput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  /** Clamped budget from {@link inlineContentBudget}. Omit to use the default. */
  inlineMaxBytes?: number;
  /**
   * Force the textual decision instead of deriving it from `mimeType`. Drive
   * needs this: a Google Doc's own media type is not textual, but the bytes it
   * exported are.
   */
  textual?: boolean;
}

/**
 * Build the action output for one downloaded file.
 *
 * The attachment always carries the WHOLE file; inline text is a convenience
 * head, truncated rather than withheld, so a caller peeking at a large CSV gets
 * its first page instead of being told to go fetch a URL.
 *
 * `kind` is deliberately omitted from the attachment: the gateway infers it
 * from the media type (`inferKindFromMime`), so there is one rule rather than
 * two that can disagree about what counts as an image.
 */
export function fileDownloadOutput(params: FileDownloadOutput): Record<string, unknown> {
  const { bytes, filename, mimeType } = params;
  const budget = params.inlineMaxBytes ?? DEFAULT_INLINE_CONTENT_BYTES;
  const textual = params.textual ?? isTextualMimeType(mimeType);
  const inline = budget > 0 && textual ? inlineText(bytes, budget) : undefined;

  return {
    size_bytes: bytes.length,
    attachments: [
      {
        filename,
        mime_type: mimeType,
        data: Buffer.from(bytes).toString('base64'),
        size_bytes: bytes.length,
      },
    ],
    ...(inline
      ? {
          content: inline.content,
          content_truncated: inline.truncated,
          line_count: inline.content.length === 0 ? 0 : inline.content.split('\n').length,
        }
      : {
          content_omitted_reason: textual
            ? 'inlining disabled'
            : 'file is binary; fetch it through the attachment download_url',
        }),
  };
}

/**
 * The shared `inline_max_bytes` field, so every connector's download action
 * documents the same budget with the same words.
 */
export function inlineMaxBytesSchema(): Record<string, unknown> {
  return {
    type: 'integer',
    minimum: 0,
    maximum: MAX_INLINE_CONTENT_BYTES,
    description: `Return text content inline when the file is at most this many bytes (default ${DEFAULT_INLINE_CONTENT_BYTES}, max ${MAX_INLINE_CONTENT_BYTES}). Binary files are never inlined. 0 disables inlining; the attachment is still published.`,
  };
}
