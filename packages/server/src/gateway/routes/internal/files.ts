#!/usr/bin/env bun

import { Readable } from "node:stream";
import {
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type ArtifactStore,
  MAX_ARTIFACT_BYTES,
} from "../../files/artifact-store.js";
import type { PlatformRegistry } from "../../platform.js";
import type { IFileHandler } from "../../platform/file-handler.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import { captureSideEffect } from "./capture-mode.js";
import type { WorkerContext } from "./types.js";

const logger = createLogger("file-routes");
// The wire body carries multipart boundaries, part headers, and the other
// form fields on top of the file itself, so allow 1 MiB of framing over the
// decoded artifact limit; the exact decoded size is re-checked after parsing.
const MAX_ARTIFACT_UPLOAD_REQUEST_BYTES = MAX_ARTIFACT_BYTES + 1024 * 1024;

const limitArtifactUploadBody = bodyLimit({
  maxSize: MAX_ARTIFACT_UPLOAD_REQUEST_BYTES,
  onError: (c) =>
    errorResponse(c, "File exceeds the artifact storage limit", 413),
});

/**
 * Resolve the file handler for a given platform from the registry.
 * Connections hydrate lazily per replica, and the pod that claims a worker's
 * run is routinely not the pod that received the inbound webhook — so warm
 * the connection from its row first, otherwise `getFileHandler` (a
 * synchronous instance lookup) misses and every upload falls back to an
 * artifact URL instead of a native platform upload.
 */
async function resolveFileHandler(
  platformRegistry: PlatformRegistry,
  options: {
    platformName?: string;
    connectionId?: string;
    channelId?: string;
    conversationId?: string;
    teamId?: string;
  }
): Promise<IFileHandler | null> {
  if (!options.platformName) return null;
  const platform = platformRegistry.get(options.platformName);
  if (!platform) return null;
  if (options.connectionId && platform.warmConnection) {
    try {
      await platform.warmConnection(options.connectionId);
    } catch (error) {
      logger.warn(
        { connectionId: options.connectionId, error: String(error) },
        "Failed to warm connection for file handler; falling back"
      );
    }
  }
  return (
    platform.getFileHandler?.({
      connectionId: options.connectionId,
      channelId: options.channelId,
      conversationId: options.conversationId,
      teamId: options.teamId,
    }) ?? null
  );
}

/**
 * Create internal file routes (Hono)
 */
export function createFileRoutes(
  platformRegistry: PlatformRegistry,
  artifactStore: ArtifactStore,
  publicGatewayUrl: string
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  // Worker file downloads are no longer routed through the gateway with a
  // platform-specific fileId. Inbound attachments are pre-published as
  // gateway artifacts in `MessageHandlerBridge.ingestAttachments` and the
  // worker fetches them directly via the signed `/api/v1/files/:artifactId`
  // public URL embedded in `platformMetadata.files[].downloadUrl`.

  /**
   * Upload file endpoint for workers
   * POST /upload
   */
  router.post("/upload", limitArtifactUploadBody, authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      // SECURITY: the channel/conversation a worker may upload to is fixed by
      // its verified token, NOT by request headers. Trusting the X-Channel-Id /
      // X-Conversation-Id headers let a worker (or anyone holding a worker
      // token) deliver attachments to ANY channel the connection's bot can
      // reach — cross-channel/cross-conversation disclosure. Mirror the history
      // route, which is token-bound for exactly this reason. Only the voice-
      // message flag stays caller-controlled (it's not a routing decision).
      const channelId = worker.channelId;
      const conversationId = worker.conversationId;
      const voiceMessage = c.req.header("x-voice-message") === "true";

      if (!channelId || !conversationId) {
        return errorResponse(c, "Missing channel or conversation ID", 400);
      }

      const formData = await c.req.formData();
      const file = formData.get("file") as File | null;

      if (!file) {
        return errorResponse(c, "No file provided", 400);
      }
      if (file.size > MAX_ARTIFACT_BYTES) {
        return errorResponse(c, "File exceeds the artifact storage limit", 413);
      }

      const filename = (formData.get("filename") as string) || file.name;
      const initialComment = formData.get("comment") as string | null;

      // Delivery into the conversation is a side effect: the media plugins
      // generate content and then land it here, so this is where a capture
      // run's attachment attempt is recorded instead of delivered. Callers
      // only require a 2xx (`upload.response.ok`), so the generic body works.
      const captured = await captureSideEffect(c, "files.upload", {
        filename,
        mimeType: file.type || null,
        size: file.size,
        voiceMessage,
      });
      if (captured) return captured;

      const fileHandler = await resolveFileHandler(platformRegistry, {
        platformName: worker.platform,
        connectionId: worker.connectionId,
        channelId,
        conversationId,
        teamId: worker.teamId,
      });

      logger.info(
        `Worker uploading file ${filename} via ${worker.platform || "unknown"} for conversation ${worker.conversationId} to conversation ${conversationId}${voiceMessage ? " as voice message" : ""}`
      );

      const fileBuffer = Buffer.from(await file.arrayBuffer());
      let result:
        | {
            fileId: string;
            permalink: string;
            name: string;
            size: number;
            delivery?: "platform-upload" | "artifact-url";
            artifactId?: string;
          }
        | undefined;

      if (fileHandler) {
        try {
          result = await fileHandler.uploadFile(Readable.from(fileBuffer), {
            filename,
            channelId,
            threadTs: conversationId,
            initialComment: initialComment || undefined,
            voiceMessage,
          });
          logger.info(`File uploaded successfully: ${result.fileId}`);
        } catch (error) {
          logger.warn(
            `Platform upload failed for ${filename}; falling back to artifact URL`,
            error
          );
        }
      }

      if (!result) {
        const artifact = await artifactStore.publish({
          buffer: fileBuffer,
          filename,
          contentType: file.type || "application/octet-stream",
          publicGatewayUrl,
        });
        result = {
          fileId: artifact.artifactId,
          permalink: artifact.downloadUrl,
          name: artifact.filename,
          size: artifact.size,
          delivery: "artifact-url",
          artifactId: artifact.artifactId,
        };
        logger.info(`Published artifact fallback: ${artifact.artifactId}`);
      }

      return c.json({
        success: true,
        fileId: result.fileId,
        permalink: result.permalink,
        name: result.name,
        size: result.size,
        delivery: result.delivery || "platform-upload",
        artifactId: result.artifactId,
      });
    } catch (error) {
      // Hono does not export `BodyLimitError`, so its name is the only handle
      // on it; `instanceof` has no class to test against.
      if (error instanceof Error && error.name === "BodyLimitError") {
        return errorResponse(c, "File exceeds the artifact storage limit", 413);
      }
      logger.error("Failed to upload file", {
        error: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return errorResponse(c, "Failed to upload file", 500);
    }
  });

  /**
   * Batch upload endpoint for multiple files
   * POST /upload-batch
   */
  router.post("/upload-batch", limitArtifactUploadBody, authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      // SECURITY: token-bound channel/conversation (see /upload above) — never
      // the X-Channel-Id / X-Conversation-Id headers, which a worker could
      // override to deliver attachments to an arbitrary channel.
      const channelId = worker.channelId;
      const conversationId = worker.conversationId;

      if (!channelId || !conversationId) {
        return errorResponse(c, "Missing channel or conversation ID", 400);
      }

      const formData = await c.req.formData();
      const fileEntries = formData.getAll("files");

      if (!fileEntries || fileEntries.length === 0) {
        return errorResponse(c, "No files provided", 400);
      }
      const files = fileEntries.filter(
        (entry): entry is File => entry instanceof File
      );
      if (files.length !== fileEntries.length) {
        return errorResponse(c, "Every upload entry must be a file", 400);
      }
      // The batch buffers every entry concurrently below, so the aggregate —
      // not just each file — has to stay inside the artifact storage limit.
      if (
        files.reduce((total, file) => total + file.size, 0) >
        MAX_ARTIFACT_BYTES
      ) {
        return errorResponse(
          c,
          "Batch exceeds the artifact storage limit",
          413
        );
      }

      const captured = await captureSideEffect(c, "files.upload_batch", {
        count: files.length,
        filenames: files.map((entry) => entry.name),
      });
      if (captured) return captured;

      const fileHandler = await resolveFileHandler(platformRegistry, {
        platformName: worker.platform,
        connectionId: worker.connectionId,
        channelId,
        conversationId,
        teamId: worker.teamId,
      });

      logger.info(
        `Worker uploading ${files.length} files for conversation ${worker.conversationId}`
      );

      const uploadPromises = files.map(async (entry) => {
        const filename = entry.name;
        const fileBuffer = Buffer.from(await entry.arrayBuffer());

        if (fileHandler) {
          try {
            return await fileHandler.uploadFile(Readable.from(fileBuffer), {
              filename,
              channelId,
              threadTs: conversationId,
            });
          } catch (error) {
            logger.warn(
              `Platform batch upload failed for ${filename}; falling back to artifact URL`,
              error
            );
          }
        }

        const artifact = await artifactStore.publish({
          buffer: fileBuffer,
          filename,
          contentType: entry.type || "application/octet-stream",
          publicGatewayUrl,
        });
        return {
          fileId: artifact.artifactId,
          permalink: artifact.downloadUrl,
          name: artifact.filename,
          size: artifact.size,
          delivery: "artifact-url" as const,
          artifactId: artifact.artifactId,
        };
      });

      const uploadResults = await Promise.allSettled(uploadPromises);

      const results = uploadResults.map((result, index) => {
        if (result.status === "fulfilled") {
          return {
            success: true,
            delivery: result.value.delivery || "platform-upload",
            ...result.value,
          };
        }
        logger.error(`Failed to upload file ${index}`, {
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          stack:
            result.reason instanceof Error ? result.reason.stack : undefined,
        });
        return {
          success: false,
          error: result.reason?.message || "Upload failed",
        };
      });

      return c.json({ results });
    } catch (error) {
      // Hono does not export `BodyLimitError`, so its name is the only handle
      // on it; `instanceof` has no class to test against.
      if (error instanceof Error && error.name === "BodyLimitError") {
        return errorResponse(c, "File exceeds the artifact storage limit", 413);
      }
      logger.error("Failed to batch upload files", {
        error: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return errorResponse(c, "Failed to batch upload files", 500);
    }
  });

  return router;
}
