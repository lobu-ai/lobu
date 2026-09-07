#!/usr/bin/env bun

import {
  createLogger,
  initSentry,
  initTracing,
  moduleRegistry,
} from "@lobu/core";

const logger = createLogger("worker");

import { setToolLogger } from "@lobu/plugin-toolkit";
import { GatewayClient } from "./gateway/sse-client";
import { startWorkerHttpServer, stopWorkerHttpServer } from "./server";

// The gateway tools default to a console logger so the same code can run
// inside the connector isolate, whose bundle cannot contain winston. This lane
// is Node, so give them core's real logger back before any tool runs.
setToolLogger(createLogger("plugin-toolkit"));

/**
 * Main entry point for gateway-based persistent worker
 */
async function main() {
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection:", reason);
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception:", error);
    process.exit(1);
  });

  logger.info("Starting worker...");

  await initSentry();

  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otlpEndpoint) {
    initTracing({
      serviceName: "lobu-worker",
      otlpEndpoint,
    });
    logger.info(`Tracing initialized: lobu-worker -> ${otlpEndpoint}`);
  }

  await moduleRegistry.initAll();
  logger.info("✅ Modules initialized");

  logger.info("🔄 Starting in gateway mode (SSE/HTTP-based persistent worker)");

  const userId = process.env.USER_ID;

  if (!userId) {
    logger.error(
      "❌ USER_ID environment variable is required for gateway mode"
    );
    process.exit(1);
  }

  try {
    const deploymentName = process.env.DEPLOYMENT_NAME;
    const dispatcherUrl = process.env.DISPATCHER_URL;
    const workerToken = process.env.WORKER_TOKEN;

    if (!deploymentName) {
      logger.error("❌ DEPLOYMENT_NAME environment variable is required");
      process.exit(1);
    }
    if (!dispatcherUrl) {
      logger.error("❌ DISPATCHER_URL environment variable is required");
      process.exit(1);
    }
    if (!workerToken) {
      logger.error("❌ WORKER_TOKEN environment variable is required");
      process.exit(1);
    }

    const httpPort = await startWorkerHttpServer();
    logger.info(`Worker HTTP server started on port ${httpPort}`);

    logger.info(`🚀 Starting Gateway-based Persistent Worker`);
    logger.info(`- User ID: ${userId}`);
    logger.info(`- Deployment: ${deploymentName}`);
    logger.info(`- Dispatcher URL: ${dispatcherUrl}`);

    const gatewayClient = new GatewayClient(
      dispatcherUrl,
      workerToken,
      userId,
      deploymentName,
      httpPort
    );

    // Register signal handlers before async operations
    let isShuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info(`Received ${signal}, shutting down gateway worker...`);
      await gatewayClient.stop();
      await stopWorkerHttpServer();
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    logger.info("🔌 Connecting to dispatcher...");
    await gatewayClient.start();
    logger.info("✅ Gateway worker started successfully");

    await new Promise<never>(() => {
      // Intentionally never resolves — block process until signal.
    });
  } catch (error) {
    logger.error("❌ Gateway worker failed:", error);
    process.exit(1);
  }
}

export type { WorkerConfig } from "./core/types";

main().catch((error) => {
  logger.error("Fatal error in main:", error);
  process.exit(1);
});
