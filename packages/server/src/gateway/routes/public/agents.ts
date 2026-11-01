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
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store.js";
import type {
  AgentSettingsStore,
} from "../../auth/settings/agent-settings-store.js";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import { getOrgId, orgContext, tryGetOrgId } from "../../../lobu/stores/org-context.js";
import { getDb } from "../../../db/client.js";
import { agentConfigRevision, readAgentConfigurationRow } from "../../../lobu/agent-config-revision.js";
import { createPostgresAgentConfigStore, getAgentConfigurationSnapshot } from "../../../lobu/stores/postgres-stores.js";
import { resolveNewAgentProvisioningDefaults } from "../../../auth/system-provider-resolution.js";
import { assertExpectedRevision } from "../../../utils/config-revision.js";
import { ToolUserError } from "../../../utils/errors.js";
import { recordLifecycleEvent } from "../../../utils/insert-event.js";
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

      // Creation is absent-only, and defaults are inserted with the row. A
      // racing create must not upsert metadata or erase initialized settings.
      const organizationId = getOrgId();
      const provisioning = await resolveNewAgentProvisioningDefaults(organizationId);
      const revision = await getDb().begin(async (tx) => {
        const inserted = await tx`
          INSERT INTO agents (id, organization_id, name, description, owner_platform, owner_user_id, models, created_at)
          VALUES (${agentId}, ${organizationId}, ${body.name}, ${body.description ?? null},
            ${payload.platform}, ${lookupUserId}, ${tx.json(provisioning.models)}, NOW())
          ON CONFLICT (organization_id, id) DO NOTHING RETURNING id
        `;
        if (!inserted.length) throw new ToolUserError("An agent with this ID already exists", 409);
        await tx`
          INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
          VALUES (${organizationId}, ${agentId}, ${payload.platform}, ${lookupUserId}, NOW())
          ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
        `;
        await recordLifecycleEvent({
          organizationId, entityType: "agent", op: "created", entityId: agentId,
          summary: `Agent "${body.name}" created`,
        }, tx);
        return (await getAgentConfigurationSnapshot(organizationId, agentId, tx))!.revision;
      });

      logger.info(
        `Created agent ${agentId} for user ${payload.platform}/${payload.userId}`
      );

      return c.json({
        agentId,
        name: body.name,
        revision,
        created: true,
        settingsUrl: `/api/v1/agents/${encodeURIComponent(agentId)}/config`,
      });
    } catch (error) {
      if (error instanceof ToolUserError) return c.json({ error: error.message, code: error.code, retryable: error.retryable }, error.httpStatus as ContentfulStatusCode);
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
          revision: (metadata as typeof metadata & { revision?: string }).revision,
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
      async ({ agentId, access }) => {
        const body = await c.req.json<{
          name?: string;
          description?: string;
          expected_revision?: string;
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

        const organizationId = access.organizationId ?? tryGetOrgId();
        if (!organizationId) return errorResponse(c, "Organization context required", 400);
        try {
          const revision = await orgContext.run({ organizationId }, () => getDb().begin(async (tx) => {
            const current = await readAgentConfigurationRow(organizationId, agentId, tx, true);
            if (!current) throw new ToolUserError("Agent not found", 404);
            assertExpectedRevision(body.expected_revision, agentConfigRevision(current));
            await createPostgresAgentConfigStore(tx).updateMetadata(agentId, updates);
            return (await getAgentConfigurationSnapshot(organizationId, agentId, tx))!.revision;
          }));
          logger.info(`Updated agent identity for ${agentId}`);
          return c.json({ success: true, revision });
        } catch (error) {
          if (error instanceof ToolUserError) return c.json({ error: error.message, code: error.code, retryable: error.retryable }, error.httpStatus as ContentfulStatusCode);
          throw error;
        }
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
