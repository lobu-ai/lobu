/**
 * An event attachment that stays in its source.
 *
 * A feed that sees a file (a mail attachment, a Drive file) records it on the
 * event as metadata only: no bytes, no artifact, no download URL. `open` names
 * the connection's own read operation and the input that fetches this one
 * file, so the app can run it on demand through `operations.execute` (normal
 * connector policy applies) and show the short-lived file it publishes.
 *
 * Every value in `open.input` must be a string or a number, because the event
 * row stores it verbatim and the app passes it back unchanged.
 */
export interface SourceFileAttachment {
  kind: 'image' | 'audio' | 'video' | 'file';
  filename: string;
  mime_type: string;
  size_bytes?: number;
  open: { operation: string; input: Record<string, string | number> };
}

export function sourceFileAttachment(file: {
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  operation: string;
  input: Record<string, string | number>;
}): SourceFileAttachment {
  const mimeType = file.mimeType.toLowerCase();
  return {
    kind: attachmentKind(mimeType),
    filename: file.filename,
    mime_type: mimeType,
    ...(typeof file.sizeBytes === 'number' && Number.isFinite(file.sizeBytes)
      ? { size_bytes: file.sizeBytes }
      : {}),
    open: { operation: file.operation, input: file.input },
  };
}

// Same media-type split the gateway applies when it publishes a file.
function attachmentKind(mimeType: string): SourceFileAttachment['kind'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}
