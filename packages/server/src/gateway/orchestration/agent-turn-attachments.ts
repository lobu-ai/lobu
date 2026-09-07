/**
 * The agent-turn isolate lane's attachment resolver.
 *
 * The subprocess lane reads a turn's attachments off the worker's own disk:
 * the gateway publishes every inbound attachment as an artifact and stamps
 * `platformMetadata.files[]` with its id, name, mimetype and a signed
 * `downloadUrl`; the worker downloads each one into `<workspace>/input/`, then
 * base64s the `image/*` ones into the prompt for vision and leaves the rest for
 * `cat` (`agent-worker/src/runtime/worker.ts` `downloadInputFiles` /
 * `loadImageAttachments`).
 *
 * The isolate lane has no disk and must not have a fetch. So the resolution
 * happens HERE, host-side, and it is deliberately not a download:
 *
 *  - the bytes come out of the gateway's OWN artifact store, keyed by the
 *    artifact id the gateway itself minted for THIS message. `downloadUrl` is
 *    never read, never forwarded and never trusted — an attacker who could put
 *    a URL on a message still cannot make the gateway dial it, and no signed
 *    URL or bearer ever crosses into the isolate;
 *  - an id that is not a well-formed artifact id, or names no artifact this
 *    store holds, resolves to nothing. `ArtifactStore.inspect`/`read` enforce
 *    both, plus the byte bound;
 *  - `image/*` is the only content type whose BYTES travel, matching what the
 *    subprocess lane actually sends the model. Everything else travels as its
 *    name and type so the model is told it exists, which is also what the
 *    subprocess lane does — this lane simply has no `input/` directory behind
 *    the name.
 *
 * Every rejection is a skip with a log line, never a failed turn: the
 * subprocess lane skips an unreadable or oversized image the same way, and a
 * turn that still has text must not die because one upload did not resolve.
 */

import { createLogger, getErrorMessage } from "@lobu/core";
import type { ArtifactStore } from "../files/artifact-store.js";

const logger = createLogger("agent-turn-attachments");

/**
 * The slice of the artifact store this resolver needs. Narrowed so a caller
 * can hand it a store without the producer depending on the whole class.
 */
export type AgentTurnArtifactReader = Pick<ArtifactStore, "inspect" | "read">;

/**
 * Per-image byte bound.
 *
 * The subprocess lane's own cap is 20 MB, but its images live on a worker's
 * disk while these are base64'd into a `runs.action_input` jsonb column and
 * carried through a poll response — a ~1.33x inflation on every hop. 5 MiB is
 * also the largest image Anthropic's API accepts base64, so an image over it
 * could not have reached the model on either lane anyway.
 */
export const MAX_TURN_IMAGE_BYTES = 5 * 1024 * 1024;

/** Total image bytes one turn may carry, before base64. */
export const MAX_TURN_IMAGE_BYTES_TOTAL = 10 * 1024 * 1024;

/** How many images one turn may carry, however small they are. */
export const MAX_TURN_IMAGES = 8;

/** What the model is told about each non-image attachment. */
export interface TurnAttachmentFile {
  name: string;
  mime_type: string;
  size?: number;
}

/** One image attachment, resolved to base64 by this module. */
export interface TurnAttachmentImage {
  mime_type: string;
  data: string;
}

export interface TurnAttachments {
  images: TurnAttachmentImage[];
  files: TurnAttachmentFile[];
}

/**
 * One entry of `platformMetadata.files`, as `ingestInboundAttachments` writes
 * it. Read defensively: the field is untyped `Record<string, unknown>` on the
 * wire, and a platform adapter that stamps its own shape must not throw here.
 */
interface InboundFileLike {
  id?: unknown;
  name?: unknown;
  mimetype?: unknown;
  size?: unknown;
}

function isImageMimeType(mimetype: string): boolean {
  return mimetype.startsWith("image/");
}

/** The message's attachment list, or an empty one when it carries none. */
function readFiles(
  platformMetadata: Record<string, unknown> | undefined
): InboundFileLike[] {
  const files = platformMetadata?.files;
  return Array.isArray(files) ? (files as InboundFileLike[]) : [];
}

/**
 * Resolve this message's attachments for the turn envelope.
 *
 * `artifacts` absent → the images cannot be resolved, so only the names travel
 * and the log says so. That is the honest degradation: the model is still told
 * what was attached rather than answering as if the message were bare text.
 */
export async function resolveTurnAttachments(
  platformMetadata: Record<string, unknown> | undefined,
  artifacts: AgentTurnArtifactReader | undefined,
  context: { agentId: string; messageId: string }
): Promise<TurnAttachments> {
  const inbound = readFiles(platformMetadata);
  if (inbound.length === 0) return { images: [], files: [] };

  const images: TurnAttachmentImage[] = [];
  const files: TurnAttachmentFile[] = [];
  let imageBytes = 0;

  for (const entry of inbound) {
    const name = typeof entry.name === "string" && entry.name ? entry.name : "attachment";
    const mimetype =
      typeof entry.mimetype === "string" && entry.mimetype
        ? entry.mimetype
        : "application/octet-stream";
    const size = typeof entry.size === "number" && Number.isFinite(entry.size) ? entry.size : undefined;

    if (!isImageMimeType(mimetype)) {
      // Not sent to the model on either lane; named so the model knows it
      // exists and can ask the user for the part it needs.
      files.push({ name, mime_type: mimetype, ...(size !== undefined ? { size } : {}) });
      continue;
    }

    // From here the attachment is an image, and every exit is a SKIP, so a
    // refused image degrades the turn rather than failing it.
    const skip = (reason: string, detail?: Record<string, unknown>) => {
      logger.info(
        { agentId: context.agentId, messageId: context.messageId, name, mimetype, ...detail },
        `Agent turn attachment skipped: ${reason}`
      );
      files.push({ name, mime_type: mimetype, ...(size !== undefined ? { size } : {}) });
    };

    if (!artifacts) {
      skip("the artifact store is not wired, so its bytes cannot be resolved");
      continue;
    }
    if (typeof entry.id !== "string" || !entry.id) {
      skip("it carries no artifact id, so there is nothing to resolve it against");
      continue;
    }
    if (images.length >= MAX_TURN_IMAGES) {
      skip(`this turn already carries ${MAX_TURN_IMAGES} images`);
      continue;
    }

    try {
      // Metadata first, exactly as the MCP resource reader does: a bounded
      // `read` reports an oversized artifact as simply absent, which would be
      // indistinguishable from a missing one in the log.
      const metadata = await artifacts.inspect(entry.id);
      if (!metadata) {
        skip("this gateway's artifact store holds no such artifact");
        continue;
      }
      if (metadata.size > MAX_TURN_IMAGE_BYTES) {
        skip("it is larger than one turn may carry", {
          size: metadata.size,
          cap: MAX_TURN_IMAGE_BYTES,
        });
        continue;
      }
      if (imageBytes + metadata.size > MAX_TURN_IMAGE_BYTES_TOTAL) {
        skip("this turn's total image budget is spent", {
          size: metadata.size,
          used: imageBytes,
          cap: MAX_TURN_IMAGE_BYTES_TOTAL,
        });
        continue;
      }

      const stored = await artifacts.read(entry.id, { maxBytes: MAX_TURN_IMAGE_BYTES });
      if (!stored) {
        skip("its bytes could not be read back");
        continue;
      }
      // The STORED content type, not the one the message claimed: the model is
      // told what the gateway actually holds.
      if (!isImageMimeType(stored.metadata.contentType)) {
        skip("the stored artifact is not an image", { stored: stored.metadata.contentType });
        continue;
      }
      // The budget is charged the size the store REPORTED, which is what the
      // total was checked against a moment ago. Charging the length of the
      // buffer instead would let a store that answers short leave the budget
      // open forever.
      imageBytes += metadata.size;
      images.push({
        mime_type: stored.metadata.contentType,
        data: stored.bytes.toString("base64"),
      });
    } catch (err) {
      skip("reading it failed", { err: getErrorMessage(err) });
    }
  }

  return { images, files };
}
