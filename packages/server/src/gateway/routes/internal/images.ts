/**
 * Internal Image Routes
 *
 * Worker-facing endpoints for image generation.
 */

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { ImageGenerationService } from "../../services/image-generation-service.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";
import { captureSideEffect } from "./capture-mode.js";
import { sendOncePerTurnInput } from "./turn-write-once.js";

const logger = createLogger("internal-image-routes");

export function createImageRoutes(
  imageGenerationService: ImageGenerationService
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  /**
   * Generate an image from prompt text
   * POST /internal/images/generate
   */
  router.post("/internal/images/generate", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const { prompt, size, quality, background, format } = await c.req.json<{
        prompt?: string;
        size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
        quality?: "low" | "medium" | "high" | "auto";
        background?: "transparent" | "opaque" | "auto";
        format?: "png" | "jpeg" | "webp";
      }>();

      if (!prompt || typeof prompt !== "string") {
        return errorResponse(c, "prompt is required and must be a string", 400);
      }

      if (prompt.length > 4000) {
        return errorResponse(c, "prompt must be 4000 characters or less", 400);
      }

      const agentId = worker.agentId;
      if (!agentId) {
        return errorResponse(c, "Missing agentId in worker context", 400);
      }

      // After validation, before the billable call: a capture run must see the
      // same 400s a live run would, and only the side effect is suppressed.
      const captured = await captureSideEffect(c, "images.generate", { prompt, size });
      if (captured) return captured;

      return await sendOncePerTurnInput(c, worker, "images.generate", { prompt, size, quality, background, format }, async () => {
        logger.info("Generating image", {
          agentId,
          promptLength: prompt.length,
          size,
          quality,
          background,
          format,
        });

        const result = await imageGenerationService.generate(prompt, agentId, {
          size,
          quality,
          background,
          format,
        });
        if ("error" in result) {
          return c.json(
            {
              error: result.error,
              availableProviders: result.availableProviders,
            },
            400
          );
        }

        return new Response(result.imageBuffer, {
          headers: {
            "Content-Type": result.mimeType,
            "Content-Length": result.imageBuffer.length.toString(),
            "X-Image-Provider": result.provider,
          },
        });
      });
    } catch (error) {
      logger.error("Image generation error", { error });
      return errorResponse(c, "Failed to generate image", 500);
    }
  });

  /**
   * Check image generation capabilities for current agent
   * GET /internal/images/capabilities
   */
  router.get("/internal/images/capabilities", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const agentId = worker.agentId;
      if (!agentId) {
        return errorResponse(c, "Missing agentId in worker context", 400);
      }

      const config = await imageGenerationService.getConfig(agentId);
      if (!config) {
        return c.json({
          available: false,
          features: { generation: false },
          providers: imageGenerationService.getProviderInfo(),
        });
      }

      return c.json({
        available: true,
        provider: config.provider,
        features: { generation: true },
      });
    } catch (error) {
      logger.error("Image capabilities check error", { error });
      return errorResponse(c, "Failed to check capabilities", 500);
    }
  });

  logger.debug("Internal image routes registered");
  return router;
}
