// Chrome native messaging framing: each message is UTF-8 JSON preceded by its
// byte length as a 32-bit unsigned integer in native byte order. Every
// platform `lobu browser` supports (macOS, Linux on x64/arm64) is
// little-endian. Chrome caps a host's replies at 1 MiB.

const MAX_REPLY_BYTES = 1024 * 1024;
/** The extension only ever sends small control messages. */
const MAX_REQUEST_BYTES = 1024 * 1024;

export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_REPLY_BYTES) {
    throw new Error("native message reply exceeds Chrome's 1 MiB limit");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Read the first framed message from `input`. Resolves to null when the stream
 * ends before a complete message arrives (Chrome closed the port).
 */
export async function readNativeMessage(
  input: AsyncIterable<Buffer | string>
): Promise<unknown> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of input) {
    buffered = Buffer.concat([
      buffered,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    ]);
    if (buffered.length < 4) continue;
    const length = buffered.readUInt32LE(0);
    if (length > MAX_REQUEST_BYTES) {
      throw new Error(`native message of ${length} bytes is too large`);
    }
    if (buffered.length < 4 + length) continue;
    return JSON.parse(buffered.subarray(4, 4 + length).toString("utf8"));
  }
  return null;
}
