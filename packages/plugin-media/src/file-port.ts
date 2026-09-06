import {
  type GatewayParams,
  type TextResult,
  textResult,
} from "@lobu/plugin-toolkit";
import { uploadMultipart } from "./multipart";

/**
 * How `upload_file` reaches a file, without saying what a file is.
 *
 * The two lanes hold the agent's workspace in genuinely different places: the
 * subprocess lane writes it to a real directory on the worker's disk, and the
 * isolate lane keeps it in just-bash's in-memory filesystem, which exists for
 * the length of one turn and has no disk behind it at all. Everything else
 * about the tool — the schema, the prose the model reads, the multipart body,
 * the gateway response handling, the notification — is identical, so the
 * runtime difference is isolated to this ONE injected port and nothing else
 * forks.
 *
 * The port is deliberately not an `fs` shape. It answers exactly the two
 * questions the tool asks ("what is this path, if I am allowed to see it?" and
 * "give me its bytes"), which keeps each implementation free to enforce
 * containment the way its own filesystem can: the Node port with `realpath`
 * against symlinks, the isolate port with the same path resolution its
 * workspace tools already use.
 */
export interface MediaFilePort {
  /**
   * Resolve `requestedPath` against the workspace and describe the file.
   *
   * Containment, existence and file-vs-directory are ALL this method's
   * responsibility — it is the only place that knows what the lane's
   * filesystem can be asked. Returns a discriminated failure rather than
   * throwing so the tool can hand the model the same sentences it always has.
   */
  resolve(requestedPath: string): Promise<MediaFileResolution>;
  /**
   * The file's bytes. Only ever called with a `path` this port itself just
   * returned from `resolve`, and only after the size check passed.
   *
   * `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: the default type
   * parameter admits `SharedArrayBuffer`, which cannot back a `Blob` part.
   */
  read(path: string): Promise<Uint8Array<ArrayBuffer>>;
}

export type MediaFileResolution =
  | { ok: true; path: string; name: string; size: number }
  | {
      ok: false;
      reason:
        | "outside-workspace"
        | "not-a-file"
        | "empty"
        /**
         * A workspace-relative path on a lane that was started without a
         * workspace. Distinct from "not found" because the model cannot fix it
         * by retrying — it is a wiring bug, and it has always been reported in
         * those words.
         */
        | "no-workspace";
    };

/**
 * Cap the upload BEFORE reading a byte. The whole file is buffered into the
 * multipart body, so an agent pointing this at a huge file it wrote in the
 * workspace could exhaust the runtime's memory — the Node worker's heap or the
 * isolate's `memoryLimit`. Override via `LOBU_MAX_UPLOAD_BYTES`.
 *
 * Read through `globalThis.process` rather than a bare `process`: the isolate
 * guest has one (the prelude installs `process = { env }`), but a portable
 * module must not assume the Node global exists at module scope.
 */
export function maxUploadBytes(): number {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  const raw = Number.parseInt(env?.LOBU_MAX_UPLOAD_BYTES ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 100 * 1024 * 1024;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json",
  html: "text/html",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain",
  md: "text/markdown",
  py: "text/x-python",
  js: "text/javascript",
  ts: "text/typescript",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
};

/**
 * The MIME type the gateway is told a file part carries. Keyed off the
 * extension of the file NAME rather than a path, so it reads the same whatever
 * separator the lane's filesystem uses.
 */
export function contentTypeForName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1)
    return "application/octet-stream";
  return (
    CONTENT_TYPES[fileName.slice(dot + 1).toLowerCase()] ??
    "application/octet-stream"
  );
}

/** What the tool reports back to the lane once the gateway accepted a file. */
export interface UploadedFileNotification {
  tool: "upload_file";
  platform: string;
  fileId: string;
  name: string;
  permalink: string;
  size: number;
  delivery?: "platform-upload" | "artifact-url";
  artifactId?: string;
}

/**
 * `upload_file`, once for both lanes.
 *
 * Every message the model can receive here is the wording the subprocess lane
 * has been sending it, because the model has been reading these sentences and
 * acting on them; a lane that phrased a refusal differently would be changing
 * what the agent does under cover of a port.
 */
export async function uploadPortedFile(
  gw: GatewayParams,
  port: MediaFilePort,
  args: { file_path: string; description?: string },
  hooks: {
    logger: {
      info: (message: unknown, ...args: unknown[]) => void;
      error: (message: unknown, ...args: unknown[]) => void;
    };
    onUploaded?: (payload: UploadedFileNotification) => Promise<void> | void;
  }
): Promise<TextResult> {
  hooks.logger.info(
    `Show file to user: ${args.file_path}, description: ${args.description || "none"}`
  );

  const resolved = await port.resolve(args.file_path);
  if (!resolved.ok) {
    if (resolved.reason === "no-workspace") {
      return textResult(
        `Error: Cannot resolve relative file path "${args.file_path}" — workspaceDir not set. This is a wiring bug; pass an absolute path or ensure the worker was started with a workspace.`
      );
    }
    if (resolved.reason === "outside-workspace") {
      return textResult(
        `Error: Refusing to upload file outside workspace: ${args.file_path}`
      );
    }
    if (resolved.reason === "empty") {
      return textResult(`Error: Cannot show empty file: ${args.file_path}`);
    }
    return textResult(
      `Error: Cannot show file - not found or is not a file: ${args.file_path}`
    );
  }

  const limit = maxUploadBytes();
  if (resolved.size > limit) {
    return textResult(
      `Error: Cannot show file - too large (${resolved.size} bytes, limit ${limit}): ${args.file_path}`
    );
  }

  const bytes = await port.read(resolved.path);
  const upload = await uploadMultipart(gw, {
    file: {
      filename: resolved.name,
      contentType: contentTypeForName(resolved.name),
      bytes,
    },
    fields: {
      filename: resolved.name,
      ...(args.description ? { comment: args.description } : {}),
    },
  });
  if (!upload.ok) {
    return textResult(`Error: Failed to show file to user: upload timed out`);
  }
  const response = upload.response;

  if (!response.ok) {
    const error = await response.text();
    hooks.logger.error(`Failed to show file: ${response.status} - ${error}`);
    return textResult(
      `Error: Failed to show file to user: ${response.status} - ${error}`
    );
  }

  const result = (await response.json()) as {
    fileId: string;
    name: string;
    permalink: string;
    delivery?: "platform-upload" | "artifact-url";
    artifactId?: string;
  };
  hooks.logger.info(
    `Successfully showed file to user: ${result.fileId} - ${result.name}`
  );
  await hooks.onUploaded?.({
    tool: "upload_file",
    platform: gw.platform || "unknown",
    fileId: result.fileId,
    name: result.name || resolved.name,
    permalink: result.permalink,
    size: resolved.size,
    ...(result.delivery ? { delivery: result.delivery } : {}),
    ...(result.artifactId ? { artifactId: result.artifactId } : {}),
  });
  return textResult(`Successfully showed ${resolved.name} to the user`);
}
