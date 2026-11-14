/**
 * Chat webhook delivery and development-only test discovery.
 *
 * Connection CRUD lives exclusively in the org-scoped manage_connections API.
 */

import { createLogger } from "@lobu/core";
import { type Context, Hono } from "hono";
import type { ChatInstanceManager } from "../../connections/chat-instance-manager.js";
import type { PlatformConnection } from "../../connections/types.js";
import { routeFailure } from "../../../diagnostics.js";

const logger = createLogger("connection-routes");
const LOCAL_TEST_PLATFORMS = ["slack", "telegram", "whatsapp"] as const;

async function getLocalTestDefaultTarget(
  manager: ChatInstanceManager,
	connectionId: string,
): Promise<string | undefined> {
  const channels = await manager.listHistoryChannels(connectionId);
  return channels[0];
}

async function getActiveLocalTestConnections(
	manager: ChatInstanceManager,
): Promise<PlatformConnection[] | null> {
	if (process.env.NODE_ENV === "production") return null;
  const supported = new Set<string>(LOCAL_TEST_PLATFORMS);
  const connections = await manager.listConnections();
  return connections.filter(
    (connection) =>
			connection.status === "active" && supported.has(connection.platform),
  );
}

export function createConnectionWebhookRoutes(
	manager: ChatInstanceManager,
): Hono {
  const router = new Hono();

  router.post("/api/v1/webhooks/:connectionId", async (c) => {
    const connectionId = c.req.param("connectionId");
		if (!connectionId) return c.json({ error: "Missing connectionId" }, 400);

    const connection = await manager.getConnection(connectionId);
    logger.info(
      { connectionId, platform: connection?.platform ?? "connector-webhook" },
			"Inbound platform webhook",
    );

    try {
      if (!connection || connection.platform === "webhook") {
        return await manager.handleIngestWebhook(
          connectionId,
          c.req.raw,
					c.var.peerRemoteAddress,
        );
      }
			return await manager.handleWebhook(connectionId, c.req.raw);
    } catch (error) {
      logger.error({ connectionId, error: String(error) }, "Webhook error");
      throw routeFailure(c.json({ error: "Webhook processing failed" }, 500), error);
    }
  });

  return router;
}

/** Internal endpoints consumed by local bot test scripts. */
export function createConnectionCrudRoutes(
  manager: ChatInstanceManager,
): Hono {
	const app = new Hono();

	app.get("/internal/connections/platforms", async (c: Context) => {
    const connections = await getActiveLocalTestConnections(manager);
		if (!connections) return c.json({ error: "Not found" }, 404);
		return c.json([
      ...new Set(connections.map((connection) => connection.platform)),
		]);
	});

	app.get("/internal/connections/test-targets", async (c: Context) => {
    const connections = await getActiveLocalTestConnections(manager);
		if (!connections) return c.json({ error: "Not found" }, 404);
    const targets = new Map<
      string,
      { platform: string; defaultTarget?: string; agentId?: string }
    >();
    for (const connection of connections) {
			if (targets.has(connection.platform)) continue;
        targets.set(connection.platform, {
          platform: connection.platform,
				defaultTarget: await getLocalTestDefaultTarget(manager, connection.id),
          agentId: connection.agentId,
        });
      }
    return c.json([...targets.values()]);
  });

  return app;
}
