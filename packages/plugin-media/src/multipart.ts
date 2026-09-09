import {
  type GatewayParams,
  type TextResult,
  textResult,
} from "@lobu/plugin-toolkit";

/**
 * The multipart upload driver, shared by every media tool and BOTH runtimes.
 *
 * PORTABLE ON PURPOSE: nothing here imports `node:`, `form-data`, or the
 * `@lobu/core` root. The body is built with the platform `FormData` and a
 * `Blob` file part, which the Node lane has natively and the isolate lane's
 * guest prelude provides. That is what lets `upload_file`, `generate_image`
 * and `generate_audio` be ONE implementation instead of two: the only thing
 * that differs between lanes is where the BYTES came from, and that is the
 * file port's job (`file-port.ts`), not this module's.
 *
 * What this owns: the part layout the gateway's `/internal/files/upload`
 * route parses (`file` as a named file part, `filename`, optional `comment`),
 * the worker-auth and channel/conversation headers, the abort budget, and the
 * `TimeoutError` -> discriminated result mapping. `Content-Length` is NOT set:
 * the runtime derives it from the body it serialises, and a hand-computed one
 * would have to duplicate the boundary framing to be right.
 */

/**
 * The bytes of one file part, already in memory.
 *
 * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: the default type
 * parameter admits `SharedArrayBuffer`, which a `Blob` part cannot be. Naming
 * the buffer here keeps the constraint at the contract instead of pushing a
 * cast into the one place that builds the body.
 */
export interface MultipartFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * A stalled gateway upload must not wedge the agent turn forever — a 5-minute
 * ceiling is well above any legitimate file delivery.
 */
const UPLOAD_TIMEOUT_MS = 300_000;

export type MultipartUploadResult =
  | { ok: true; response: Response }
  | { ok: false; timedOut: true };

/**
 * POST one file part plus its text fields to the gateway's file-upload
 * endpoint. Returns the raw `Response` on success and a `timedOut` flag
 * instead of a `TextResult`, because the two callers surface different fields
 * out of the success body.
 */
export async function uploadMultipart(
  gw: GatewayParams,
  options: {
    file: MultipartFile;
    fields?: Record<string, string | undefined>;
    extraHeaders?: Record<string, string>;
    timeoutMs?: number;
  }
): Promise<MultipartUploadResult> {
  const form = new FormData();
  // A `Blob` with an explicit type is what makes the part carry both a
  // `filename` and a `Content-Type`, which the gateway route requires: it
  // reads `formData.get("file")` and rejects anything that is not a file.
  form.append(
    "file",
    new Blob([options.file.bytes], { type: options.file.contentType }),
    options.file.filename
  );
  for (const [name, value] of Object.entries(options.fields ?? {})) {
    if (value !== undefined) form.append(name, value);
  }

  try {
    const response = await fetch(`${gw.gatewayUrl}/internal/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gw.workerToken}`,
        "X-Channel-Id": gw.channelId,
        "X-Conversation-Id": gw.conversationId,
        ...options.extraHeaders,
      },
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? UPLOAD_TIMEOUT_MS),
    });
    return { ok: true, response };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, timedOut: true };
    }
    throw err;
  }
}

/**
 * Send bytes the caller already holds — a generated image or audio clip — to
 * the user. Resolves `null` on success and a `TextResult` describing the
 * failure otherwise, which is the shape `generateAndUploadMedia` branches on.
 *
 * The bytes go straight from the provider response into the request body. An
 * earlier version wrote them to `os.tmpdir()` only to open a read stream over
 * the file it had just written; that round trip bought nothing (the bytes were
 * already resident) and is gone.
 */
export async function uploadGeneratedFile(
  gw: GatewayParams,
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  mimeType: string,
  extraHeaders?: Record<string, string>
): Promise<TextResult | null> {
  const upload = await uploadMultipart(gw, {
    file: { filename, contentType: mimeType, bytes },
    fields: { filename, comment: "Generated content" },
    ...(extraHeaders ? { extraHeaders } : {}),
  });
  if (!upload.ok) {
    return textResult(`Generated content but upload timed out`);
  }
  if (!upload.response.ok) {
    const uploadError = await upload.response.text();
    return textResult(`Generated content but failed to send: ${uploadError}`);
  }
  return null;
}
