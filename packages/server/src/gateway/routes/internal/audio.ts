/**
 * Internal Audio Routes
 *
 * Worker-facing endpoints for audio generation (TTS).
 * Used by the generate_audio custom MCP tool.
 */

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { TranscriptionService } from "../../services/transcription-service.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";
import { captureSideEffect } from "./capture-mode.js";
import { sendOncePerTurnInput } from "./turn-write-once.js";

const logger = createLogger("internal-audio-routes");

/**
 * Create internal audio routes (Hono)
 */
export function createAudioRoutes(
  transcriptionService: TranscriptionService
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  /**
   * Generate audio from text (TTS)
   * POST /internal/audio/synthesize
   *
   * Body: {
   *   text: string (required) - Text to convert to speech
   *   voice?: string - Provider-specific voice ID
   *   speed?: number - Speech speed (0.5-2.0)
   * }
   *
   * Response: Audio file (binary) with Content-Type header
   */
  router.post("/internal/audio/synthesize", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const { text, voice, speed } = await c.req.json();

      if (!text || typeof text !== "string") {
        return errorResponse(c, "text is required and must be a string", 400);
      }

      if (text.length > 4096) {
        return errorResponse(c, "text must be 4096 characters or less", 400);
      }

      const agentId = worker.agentId;
      if (!agentId) {
        return errorResponse(c, "Missing agentId in worker context", 400);
      }

      const captured = await captureSideEffect(c, "audio.synthesize", { voice, speed });
      if (captured) return captured;

      return await sendOncePerTurnInput(c, worker, "audio.synthesize", { text, voice, speed }, async () => {
        logger.info("Synthesizing audio", {
          agentId,
          textLength: text.length,
          voice,
        });

        const result = await transcriptionService.synthesize(text, agentId, {
          voice,
          speed,
        });

        if ("error" in result) {
          logger.warn("Audio synthesis failed", { error: result.error });
          return c.json(
            {
              error: result.error,
              availableProviders: result.availableProviders,
            },
            400
          );
        }

        // Return audio as binary response
        return new Response(result.audioBuffer, {
          headers: {
            "Content-Type": result.mimeType,
            "Content-Length": result.audioBuffer.length.toString(),
            "X-Audio-Provider": result.provider,
          },
        });
      });
    } catch (error) {
      logger.error("Audio synthesis error", { error });
      return errorResponse(
        c,
        error instanceof Error ? error.message : "Failed to synthesize audio",
        500
      );
    }
  });

  /**
   * Check audio capabilities for current agent
   * GET /internal/audio/capabilities
   *
   * Response: {
   *   available: boolean,
   *   provider?: string,
   *   features: { transcription: boolean, synthesis: boolean }
   * }
   */
  router.get("/internal/audio/capabilities", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const agentId = worker.agentId;

      if (!agentId) {
        return errorResponse(c, "Missing agentId in worker context", 400);
      }

      const config = await transcriptionService.getConfig(agentId);

      if (!config) {
        return c.json({
          available: false,
          features: { transcription: false, synthesis: false },
          providers: transcriptionService.getProviderInfo(),
        });
      }

      return c.json({
        available: true,
        provider: config.provider,
        features: { transcription: true, synthesis: true },
      });
    } catch (error) {
      logger.error("Capabilities check error", { error });
      return errorResponse(c, "Failed to check capabilities", 500);
    }
  });

  logger.debug("Internal audio routes registered");

  return router;
}
