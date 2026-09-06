import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createNodeFilePort } from "./file-port-node";
import {
  createMediaPlugin as createMediaPluginWithPort,
  createMediaTools as createMediaToolsWithPort,
  type MediaPluginParams as PortedMediaPluginParams,
} from "./tools";

/**
 * The media plugin for the lane whose workspace is a real directory.
 *
 * This entry point is the NODE COMPOSITION: it defaults the file port to the
 * one backed by `node:fs`, which is why importing it pulls Node builtins into
 * the graph. A runtime that cannot take those — the connector isolate lane —
 * imports `@lobu/plugin-media/portable` and supplies its own port. The tools
 * themselves live in `./tools` and are shared by both.
 */

export {
  fetchAudioProviderSuggestions,
  normalizeAudioProviderSuggestions,
} from "./audio-provider-suggestions";
export {
  contentTypeForName,
  maxUploadBytes,
  uploadPortedFile,
  type MediaFilePort,
  type MediaFileResolution,
  type UploadedFileNotification,
} from "./file-port";
export { createNodeFilePort } from "./file-port-node";
export { generateAudio, generateImage } from "./generation";
export {
  uploadGeneratedFile,
  uploadMultipart,
  type MultipartFile,
} from "./multipart";
export { uploadUserFile } from "./upload";

/**
 * The Node lane's params: the file port is OPTIONAL here and defaults to the
 * `node:fs` one addressed by `workspaceDir`, which is the call shape the agent
 * worker has always used.
 */
export interface MediaPluginParams
  extends Omit<PortedMediaPluginParams, "filePort"> {
  filePort?: PortedMediaPluginParams["filePort"];
}

function withNodePort(params: MediaPluginParams): PortedMediaPluginParams {
  return {
    ...params,
    filePort: params.filePort ?? createNodeFilePort(params.workspaceDir),
  };
}

export function createMediaTools(params: MediaPluginParams): ToolDefinition[] {
  return createMediaToolsWithPort(withNodePort(params));
}

export function createMediaPlugin(params: MediaPluginParams) {
  return createMediaPluginWithPort(withNodePort(params));
}
