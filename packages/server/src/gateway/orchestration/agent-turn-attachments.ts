/**
 * The agent-turn isolate lane's attachment resolver.
 *
 * The gateway publishes every inbound attachment as an artifact and stamps
 * `platformMetadata.files[]` with its id, name, mimetype and a signed
 * `downloadUrl`. The isolate has no disk and must not fetch that URL, so
 * resolution happens here, host-side, and is deliberately not a download:
 *
 *  - the bytes come out of the gateway's OWN artifact store, keyed by the
 *    artifact id the gateway itself minted for THIS message. `downloadUrl` is
 *    never read, never forwarded and never trusted — an attacker who could put
 *    a URL on a message still cannot make the gateway dial it, and no signed
 *    URL or bearer ever crosses into the isolate;
 *  - an id that is not a well-formed artifact id, or names no artifact this
 *    store holds, resolves to nothing. `ArtifactStore.inspect`/`read` enforce
 *    both, plus the byte bound;
 *  - `image/*` bytes become model image blocks. Every other resolved upload is
 *    seeded under the isolate turn's in-memory `input/` directory. Unresolved
 *    uploads still travel by name so the model is told they exist.
 *
 * Every rejection is a skip with a log line, never a failed turn: a turn that
 * still has text must not die because one upload did not resolve.
 */

import { createLogger, getErrorMessage } from "@lobu/core";
import { AgentTurnPollPayloadSchema } from "@lobu/core/contracts/worker/protocol";
import type { ArtifactStore } from "../files/artifact-store.js";

const logger = createLogger("agent-turn-attachments");
const fileSchema = AgentTurnPollPayloadSchema.properties.turn.properties.message_files;
const imageMimeSchema = AgentTurnPollPayloadSchema.properties.turn.properties.message_images.items.properties.mime_type;

/**
 * The slice of the artifact store this resolver needs. Narrowed so a caller
 * can hand it a store without the producer depending on the whole class.
 */
export type AgentTurnArtifactReader = Pick<ArtifactStore, "inspect" | "read">;

/**
 * Per-image byte bound.
 *
 * These bytes are base64'd into a `runs.action_input` jsonb column and carried
 * through a poll response, a ~1.33x inflation on every hop. 5 MiB is also the
 * largest image Anthropic's API accepts base64.
 */
export const MAX_TURN_IMAGE_BYTES = 5 * 1024 * 1024;

/** Total image bytes one turn may carry, before base64. */
export const MAX_TURN_IMAGE_BYTES_TOTAL = 10 * 1024 * 1024;

/** How many images one turn may carry, however small they are. */
export const MAX_TURN_IMAGES = 8;

/**
 * Per-file byte bound for a NON-IMAGE attachment, seeded into the turn's
 * `input/` directory.
 *
 * Same number as an image's: both are base64'd into the same envelope and
 * cross the same isolate bridge, so admitting more of one than the other would
 * only move which attachment blows the bridge budget.
 */
export const MAX_TURN_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Total NON-IMAGE bytes one turn may seed, before base64.
 *
 * A SEPARATE budget from the image total rather than a shared pool, so a turn
 * of spreadsheets and a turn of screenshots admit independently and one large
 * upload cannot starve the other kind.
 *
 * 5 MiB, not the image total's 10 MiB, because the envelope has to fit the
 * isolate bridge with room left for history. See `turnEnvelopeBudget` for the
 * arithmetic that makes this number the constrained one.
 */
export const MAX_TURN_FILE_BYTES_TOTAL = 5 * 1024 * 1024;

/** What the model is told about each non-image attachment, and its bytes. */
export interface TurnAttachmentFile {
  name: string;
  mime_type: string;
  size?: number;
  /** Base64 of the artifact's bytes. Absent when they could not be resolved. */
  data?: string;
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
  let fileBytes = 0;

  for (const entry of inbound) {
    const name = (typeof entry.name === "string" && entry.name ? entry.name : "attachment")
      .slice(0, fileSchema.items.properties.name.maxLength);
    const mimetype =
      (typeof entry.mimetype === "string" && entry.mimetype
        ? entry.mimetype
        : "application/octet-stream").slice(0, fileSchema.items.properties.mime_type.maxLength);
    const size = typeof entry.size === "number" && Number.isInteger(entry.size) && entry.size >= 0
      ? entry.size : undefined;
    // Ordinary files and rejected images share the same metadata budget.
    const appendFile = () => {
      if (files.length >= fileSchema.maxItems!) {
        logger.info(
          { ...context, name, mimetype },
          "Agent turn attachment metadata skipped: this turn's file limit is reached"
        );
        return;
      }
      files.push({ name, mime_type: mimetype, ...(size !== undefined ? { size } : {}) });
    };

    if (!isImageMimeType(mimetype)) {
      // Resolved to BYTES, then seeded into the turn's `input/` directory, so
      // the model can read an upload here exactly as it can on the subprocess
      // lane — whose download is mimetype-blind and whose prompt says `cat`.
      // Every exit below still APPENDS the name: a file the turn cannot open
      // must be named anyway, or the model answers about a file it was never
      // told existed.
      const skipFile = (reason: string, detail?: Record<string, unknown>) => {
        logger.info(
          { agentId: context.agentId, messageId: context.messageId, name, mimetype, ...detail },
          `Agent turn attachment bytes skipped: ${reason}`
        );
        appendFile();
      };
      if (!artifacts) {
        skipFile("the artifact store is not wired, so its bytes cannot be resolved");
        continue;
      }
      if (typeof entry.id !== "string" || !entry.id) {
        skipFile("it carries no artifact id, so there is nothing to resolve it against");
        continue;
      }
      if (files.length >= fileSchema.maxItems!) {
        appendFile();
        continue;
      }
      try {
        const metadata = await artifacts.inspect(entry.id);
        if (!metadata) {
          skipFile("this gateway's artifact store holds no such artifact");
          continue;
        }
        if (metadata.size > MAX_TURN_FILE_BYTES) {
          skipFile("it is larger than one turn may carry", {
            size: metadata.size,
            cap: MAX_TURN_FILE_BYTES,
          });
          continue;
        }
        if (metadata.size === 0) {
          skipFile("the stored artifact is empty");
          continue;
        }
        if (fileBytes + metadata.size > MAX_TURN_FILE_BYTES_TOTAL) {
          skipFile("this turn's total file budget is spent", {
            size: metadata.size,
            used: fileBytes,
            cap: MAX_TURN_FILE_BYTES_TOTAL,
          });
          continue;
        }
        const stored = await artifacts.read(entry.id, { maxBytes: MAX_TURN_FILE_BYTES });
        if (!stored) {
          skipFile("its bytes could not be read back");
          continue;
        }
        // Charge the size the store REPORTED, which is what the total was
        // checked against, so a store that answers short cannot leave the
        // budget open forever. Same rule as the image path.
        fileBytes += metadata.size;
        files.push({
          name,
          mime_type: mimetype,
          ...(size !== undefined ? { size } : {}),
          data: stored.bytes.toString("base64"),
        });
      } catch (err) {
        skipFile("reading it failed", { err: getErrorMessage(err) });
      }
      continue;
    }

    // From here the attachment is an image, and every exit is a SKIP, so a
    // refused image degrades the turn rather than failing it.
    const skip = (reason: string, detail?: Record<string, unknown>) => {
      logger.info(
        { agentId: context.agentId, messageId: context.messageId, name, mimetype, ...detail },
        `Agent turn attachment skipped: ${reason}`
      );
      appendFile();
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
      if (metadata.size === 0) {
        skip("the stored artifact is empty");
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
      if (stored.metadata.contentType.length > imageMimeSchema.maxLength!) {
        skip("the stored image MIME type exceeds the worker contract");
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

/**
 * The isolate bridge's string cap, restated where the envelope is built.
 *
 * The guest receives the whole turn as ONE JSON string across the isolate
 * bridge, and the bridge terminates the run over `messageBytes`
 * (`AGENT_TURN_BRIDGE_BYTES` in `connector-worker/src/daemon/agent-turn.ts`).
 * Admission budgets are counted in RAW bytes; the bridge counts the base64'd
 * envelope, so raw admission has to leave room for the ~4/3 inflation plus the
 * session journal and the system prompt.
 */
const ISOLATE_BRIDGE_BYTES = 32 * 1024 * 1024;

/** Base64 grows 3 bytes into 4 characters, padded up to the quantum. */
function base64Length(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * Prove the admitted budgets cannot build an envelope the bridge will kill.
 *
 * This exists because the two ends were set independently and did NOT agree:
 * admission allowed 10 MiB of images (~13.3 MiB base64) against a 16 MiB
 * bridge, leaving under 3 MiB for everything else, and adding a file budget on
 * top would have exceeded the bridge outright. Rather than trust a comment to
 * keep that arithmetic true across later edits to either end, the numbers are
 * checked against each other and a test calls this.
 *
 * `historyHeadroom` is what must survive for the session journal and system
 * prompt once attachments are counted — the quantity a reader actually cares
 * about, so it is returned rather than asserted against a magic number here.
 */
export function turnEnvelopeBudget(): {
  attachmentsBase64: number;
  bridge: number;
  historyHeadroom: number;
} {
  const attachmentsBase64 =
    base64Length(MAX_TURN_IMAGE_BYTES_TOTAL) + base64Length(MAX_TURN_FILE_BYTES_TOTAL);
  return {
    attachmentsBase64,
    bridge: ISOLATE_BRIDGE_BYTES,
    historyHeadroom: ISOLATE_BRIDGE_BYTES - attachmentsBase64,
  };
}
