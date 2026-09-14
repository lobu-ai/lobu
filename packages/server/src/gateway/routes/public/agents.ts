/**
 * Agent Management Routes - Create, list, update, and delete user agents
 *
 * Routes:
 * - POST /api/v1/agents - Create a new agent
 * - GET /api/v1/agents - List user's agents (requires token)
 * - PATCH /api/v1/agents/{agentId} - Update agent name/description
 * - DELETE /api/v1/agents/{agentId} - Delete an agent
 */

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store.js";
import type {
  AgentSettings,
  AgentSettingsStore,
} from "../../auth/settings/agent-settings-store.js";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import { orgContext } from "../../../lobu/stores/org-context.js";
import { resolveSettingsLookupUserId } from "../shared/agent-ownership.js";
import {
  errorResponse,
  requireSession,
  withOwnedAgent,
} from "../shared/helpers.js";

const logger = createLogger("agent-routes");

/** Environment-configurable limits */
const MAX_AGENTS_PER_USER = parseInt(
  process.env.MAX_AGENTS_PER_USER || "0",
  10
);

interface AgentRoutesConfig {
  userAgentsStore: UserAgentsStore;
  agentMetadataStore: AgentMetadataStore;
  agentSettingsStore: AgentSettingsStore;
}

/**
 * The `(agentId, organizationId)` pairs the caller owns, each org resolved from
 * an authoritative per-caller source — NEVER the unscoped `getMetadata` (a
 * global `WHERE id = $agentId` that returns an arbitrary tenant's row). The org
 * is the fence key for the listing, so it must be tenant-safe:
 *  - `agent_users` mappings → `findAgentOrganizations` (per-caller, may yield
 *    multiple orgs for the same agent id; each is a distinct owned instance).
 *  - external browser sessions also own via the legacy `agents.owner_user_id`
 *    column; `listAllAgents` is ambient-org-scoped (`listAgents` filters on the
 *    ALS org) and carries each row's `organizationId`, so it's safe to trust.
 * De-duped on `(agentId, organizationId)`.
 */
async function listOwnedAgentInstances(
  payload: SettingsTokenPayload,
  config: Pick<AgentRoutesConfig, "userAgentsStore" | "agentMetadataStore">
): Promise<Array<{ agentId: string; organizationId: string }>> {
  const lookupUserId = resolveSettingsLookupUserId(payload);
  const byKey = new Map<string, { agentId: string; organizationId: string }>();
  const add = (agentId: string, organizationId: string) => {
    byKey.set(`${organizationId} ${agentId}`, { agentId, organizationId });
  };

  const mappedAgentIds = await config.userAgentsStore.listAgents(
    payload.platform,
    lookupUserId
  );
  for (const agentId of mappedAgentIds) {
    const orgs = await config.userAgentsStore.findAgentOrganizations(
      payload.platform,
      lookupUserId,
      agentId
    );
    for (const organizationId of orgs) add(agentId, organizationId);
  }

  if (payload.platform === "external") {
    const allAgents = await config.agentMetadataStore.listAllAgents();
    for (const agent of allAgents) {
      if (agent.owner.userId === lookupUserId && agent.organizationId) {
        add(agent.agentId, agent.organizationId);
      }
    }
  }

  return [...byKey.values()];
}

/**
 * Sanitize user-provided agentId.
 * Lowercase alphanumeric with hyphens, 3-60 chars, must start with a letter.
 */
function sanitizeAgentId(input: string): string | null {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (cleaned.length < 3 || cleaned.length > 60) return null;
  if (!/^[a-z]/.test(cleaned)) return null;
  return cleaned;
}

export function createAgentRoutes(config: AgentRoutesConfig): Hono {
  const router = new Hono();

  // POST /api/v1/agents - Create a new agent
  router.post("/", async (c) => {
    const payload = await requireSession(c);
    if (payload instanceof Response) return payload;

    try {
      const lookupUserId = resolveSettingsLookupUserId(payload);
      const body = await c.req.json<{
        agentId: string;
        name: string;
        description?: string;
      }>();

      if (!body.agentId || !body.name) {
        return errorResponse(c, "agentId and name are required", 400);
      }

      const agentId = sanitizeAgentId(body.agentId);
      if (!agentId) {
        return errorResponse(
          c,
          "Invalid agentId. Must be 3-40 chars, lowercase alphanumeric with hyphens, starting with a letter.",
          400
        );
      }

      // Check if agentId already exists
      const existing = await config.agentMetadataStore.hasAgent(agentId);
      if (existing) {
        return errorResponse(c, "An agent with this ID already exists", 409);
      }

      // Check per-user limit (admins bypass)
      if (!payload.isAdmin && MAX_AGENTS_PER_USER > 0) {
        const userAgents = await listOwnedAgentInstances(payload, config);
        if (userAgents.length >= MAX_AGENTS_PER_USER) {
          return errorResponse(
            c,
            `Agent limit reached (${MAX_AGENTS_PER_USER}). Delete an existing agent first.`,
            429
          );
        }
      }

      // Create metadata
      await config.agentMetadataStore.createAgent(
        agentId,
        body.name,
        payload.platform,
        lookupUserId,
        { description: body.description }
      );

      // Create empty settings row.
      const defaultSettings: Omit<AgentSettings, "updatedAt"> = {};
      await config.agentSettingsStore.saveSettings(agentId, defaultSettings);

      // Associate with user
      await config.userAgentsStore.addAgent(
        payload.platform,
        lookupUserId,
        agentId
      );

      logger.info(
        `Created agent ${agentId} for user ${payload.platform}/${payload.userId}`
      );

      return c.json({
        agentId,
        name: body.name,
        settingsUrl: `/api/v1/agents/${encodeURIComponent(agentId)}/config`,
      });
    } catch (error) {
      logger.error("Failed to create agent", { error });
      return errorResponse(c, "Internal server error", 500);
    }
  });

  // GET /api/v1/agents - List user's agents
  router.get("/", async (c) => {
    const payload = await requireSession(c);
    if (payload instanceof Response) return payload;

    try {
      // Each owned instance carries its authoritative org (the fence key).
      const instances = await listOwnedAgentInstances(payload, config);

      const agents = [];
      for (const { agentId, organizationId } of instances) {
        // Read metadata scoped to the resolved org. getMetadata reads
        // the ambient ALS org, so pin it to THIS org so it selects the right
        // row instead of an arbitrary tenant's via the global lookup.
        const metadata = await orgContext.run({ organizationId }, () =>
          config.agentMetadataStore.getMetadata(agentId)
        );
        if (!metadata) continue;
        agents.push({
          agentId,
          name: metadata.name,
          description: metadata.description,
          createdAt: metadata.createdAt,
          lastUsedAt: metadata.lastUsedAt,
        });
      }

      return c.json({ agents });
    } catch (error) {
      logger.error("Failed to list agents", { error });
      return errorResponse(c, "Failed to list agents", 500);
    }
  });

  const ownershipAccessConfig = {
    userAgentsStore: config.userAgentsStore,
    agentMetadataStore: config.agentMetadataStore,
  };

  // PATCH /api/v1/agents/{agentId} - Update agent name/description
  router.patch("/:agentId", async (c) =>
    withOwnedAgent(
      c,
      {
        access: ownershipAccessConfig,
        errorLabel: "Failed to update agent",
        logger,
      },
      async ({ agentId }) => {
        const body = await c.req.json<{
          name?: string;
          description?: string;
        }>();
        const updates: { name?: string; description?: string } = {};

        if (body.name !== undefined) {
          const name = body.name.trim();
          if (!name || name.length > 100) {
            return errorResponse(c, "Name must be 1-100 characters", 400);
          }
          updates.name = name;
        }

        if (body.description !== undefined) {
          const desc = body.description.trim();
          if (desc.length > 200) {
            return errorResponse(
              c,
              "Description must be at most 200 characters",
              400
            );
          }
          updates.description = desc;
        }

        if (Object.keys(updates).length === 0) {
          return errorResponse(c, "No fields to update", 400);
        }

        await config.agentMetadataStore.updateMetadata(agentId, updates);
        logger.info(`Updated agent identity for ${agentId}`);
        return c.json({ success: true });
      }
    )
  );

  // NOTE: DELETE /api/v1/agents/:agentId is served by the session-only handler
  // in `agent.ts` (mounted first; Hono is first-match), and the APP/CLI delete
  // via `/api/:orgSlug/agents/:id` (org-context middleware; bindings/settings
  // cleaned by the composite `(org_id, agent_id)` FK ON DELETE CASCADE). A
  // second item-DELETE here would be dead code, so it is intentionally absent.

  logger.debug("Agent management routes registered");
  return router;
}
