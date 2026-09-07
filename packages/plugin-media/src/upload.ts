import {
  toolLogger,
  type GatewayParams,
  type TextResult,
  withErrorHandling,
} from "@lobu/plugin-toolkit";
import { uploadPortedFile, type UploadedFileNotification } from "./file-port";
import { createNodeFilePort } from "./file-port-node";

/**
 * `upload_file` on the lane whose workspace is a real directory.
 *
 * This module is now only the NODE COMPOSITION: the tool itself lives in
 * `file-port.ts` and runs on both lanes, and the filesystem it reads comes
 * from `createNodeFilePort`. Keeping the export here (and its signature)
 * means the agent worker's own regression suites still exercise the Node path
 * end to end through the same entry point they always have.
 */
export async function uploadUserFile(
  gw: GatewayParams,
  args: { file_path: string; description?: string },
  hooks?: {
    onUploaded?: (payload: UploadedFileNotification) => Promise<void> | void;
  }
): Promise<TextResult> {
  return withErrorHandling("Show file tool", () =>
    uploadPortedFile(gw, createNodeFilePort(gw.workspaceDir), args, {
      logger: toolLogger,
      ...(hooks?.onUploaded ? { onUploaded: hooks.onUploaded } : {}),
    })
  );
}
