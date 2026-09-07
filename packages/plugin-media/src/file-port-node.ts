import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MediaFilePort, MediaFileResolution } from "./file-port";

/**
 * The `MediaFilePort` for the lane whose workspace is a real directory on the
 * worker's disk.
 *
 * NODE-ONLY BY CONSTRUCTION: this is the module that owns `node:fs` and
 * `node:path` for the whole package, so `file-port.ts`, `multipart.ts` and
 * `generation.ts` stay loadable in an isolate. Nothing but the Node lane's
 * composition imports it.
 *
 * The containment rules are the ones that shipped, unchanged and unweakened:
 *   - a relative path with no `workspaceDir` is a wiring bug, not a read;
 *   - the workspace and the request are BOTH resolved through `realpath`, so a
 *     symlink pointing out of the workspace is caught after it is followed,
 *     not before;
 *   - the prefix test is against `workspaceReal + sep`, so `/workspace-evil`
 *     does not pass as a child of `/workspace`;
 *   - `lstat` decides file-vs-directory without re-dereferencing, because
 *     `realpath` already proved the resolved target is in-workspace.
 * The one rule that moved is the size cap, which now lives in
 * `uploadPortedFile` so both lanes enforce the same limit; this port still
 * reports the size that cap is applied to.
 */
export function createNodeFilePort(
  workspaceDir: string | undefined
): MediaFilePort {
  return {
    async resolve(requestedPath: string): Promise<MediaFileResolution> {
      if (!path.isAbsolute(requestedPath) && !workspaceDir) {
        return { ok: false, reason: "no-workspace" };
      }
      const requested = path.isAbsolute(requestedPath)
        ? requestedPath
        : path.join(workspaceDir as string, requestedPath);

      let filePath: string;
      if (workspaceDir) {
        try {
          const workspaceReal = await fs.realpath(workspaceDir);
          const requestedReal = await fs.realpath(requested);
          const withSep = workspaceReal.endsWith(path.sep)
            ? workspaceReal
            : workspaceReal + path.sep;
          if (
            requestedReal !== workspaceReal &&
            !requestedReal.startsWith(withSep)
          ) {
            return { ok: false, reason: "outside-workspace" };
          }
          filePath = requestedReal;
        } catch {
          return { ok: false, reason: "not-a-file" };
        }
      } else {
        filePath = requested;
      }

      const stats = await fs.lstat(filePath).catch(() => null);
      if (!stats?.isFile()) return { ok: false, reason: "not-a-file" };
      if (stats.size === 0) return { ok: false, reason: "empty" };
      return {
        ok: true,
        path: filePath,
        name: path.basename(filePath),
        size: stats.size,
      };
    },
    async read(filePath: string): Promise<Uint8Array<ArrayBuffer>> {
      const buffer = await fs.readFile(filePath);
      // Copied out of Node's Buffer rather than wrapped: a Buffer is a view
      // onto a pooled allocation, so `buffer.buffer` is shared with unrelated
      // reads and is far larger than this file.
      return new Uint8Array(
        buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength
        )
      ) as Uint8Array<ArrayBuffer>;
    },
  };
}
