/** Best-effort cancellation for a response body the caller will not consume. */
export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the caller's primary redirect/status/size error.
  }
}

/**
 * Read text without ever buffering more than maxBytes. An honest oversized
 * Content-Length is rejected before reading; chunked/lying responses are
 * cancelled as soon as the streamed total crosses the same boundary.
 */
export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  tooLargeLabel: string
): Promise<string> {
  return (await readResponseBytesWithLimit(response, maxBytes, tooLargeLabel)).toString('utf-8');
}

/** The same bounded body reader serves binary attachments and text responses. */
export async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  tooLargeLabel: string
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (!Number.isNaN(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new RangeError(`${tooLargeLabel} (max ${maxBytes} bytes).`);
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new RangeError(`${tooLargeLabel} (max ${maxBytes} bytes).`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    try { await reader.cancel(); } catch { /* Preserve the primary read error. */ }
    reader.releaseLock();
  }
}
