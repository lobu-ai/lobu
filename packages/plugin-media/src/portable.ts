/**
 * The media tools WITHOUT the Node filesystem.
 *
 * The package root re-exports `upload.ts`, whose Node port owns `node:fs` and
 * `node:path` for the whole package. That is correct for the subprocess lane
 * and fatal for the isolate one: an isolate bundle that names a Node builtin
 * is rejected outright by `assertIsolateEligible`, and a bundler cannot
 * tree-shake a CommonJS `require` out of the graph just because the value is
 * unused.
 *
 * So the isolate lane imports THIS entry point instead. Same tools, same
 * schemas, same implementations — only the Node composition is missing, and a
 * caller here supplies its own `filePort` in its place. The two entry points
 * share every module that matters, so nothing is duplicated to get one of them
 * portable.
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
export { generateAudio, generateImage } from "./generation";
export {
  uploadGeneratedFile,
  uploadMultipart,
  type MultipartFile,
} from "./multipart";
export {
  createMediaPlugin,
  createMediaTools,
  type MediaPluginParams,
} from "./tools";
