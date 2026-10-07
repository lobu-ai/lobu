import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import { ChatInstanceManager } from "../../../gateway/connections/chat-instance-manager";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store";
import { runtimeConnectionIdToSlug } from "../../../lobu/stores/connections-projection";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store";
import { claimSlackPendingInstall, resolveSlackPendingByTenant, upsertSlackInstallByTeam, writeSlackPendingInstall } from "../../../lobu/stores/slack-installations";
import { orgContext } from "../../../lobu/stores/org-context";
import { SecretStoreRegistry } from "../../../gateway/secrets";
import { handleApplyChatConnection, handleCreate } from "../../../tools/admin/manage_connections/handlers/crud";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import { addUserToOrganization, createTestUser, seedOwnerContext } from "../../setup/test-fixtures";

const CONFIG = {
  platform: "telegram" as const,
  botToken: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  mode: "webhook" as const,
};
const store = createPostgresAgentConnectionStore();
const installations = createPostgresAppInstallationStore();
let registry: SecretStoreRegistry;
let ctx: ToolContext;
let manager: ChatInstanceManager;

beforeAll(async () => { await initWorkspaceProvider(); });
beforeEach(async () => {
  await cleanupTestDatabase();
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  ({ ctx } = await seedOwnerContext({ orgName: "Chat Creator Test" }));
  const secrets = new PostgresSecretStore();
  registry = new SecretStoreRegistry(secrets, { secret: secrets });
  manager = new ChatInstanceManager();
  Object.assign(manager, {
    connectionStore: store,
    publicGatewayUrl: "",
    services: { getSecretStore: () => registry },
    // Only provider startup is suppressed; creation, secrets, and Postgres are real.
    hydrateFromRow: async () => undefined,
  });
  __setChatInstanceManagerForTests(manager);
});
afterEach(async () => {
  __setChatInstanceManagerForTests(null);
  await manager.shutdown();
});

async function owner(stableId: string) {
  const [row] = await getDb()`
    SELECT created_by FROM connections
    WHERE organization_id = ${ctx.organizationId} AND slug = ${runtimeConnectionIdToSlug(stableId)}
      AND deleted_at IS NULL
  `;
  expect(row).toBeDefined();
  return row.created_by;
}

describe("chat connection creator ownership", () => {
  it("records the authenticated creator through connections.create", async () => {
    const result = await handleCreate({
      action: "create", connector_key: "telegram", slug: "test-created-chat", config: CONFIG,
    }, ctx);
    expect(result).not.toHaveProperty("error");
    expect(await owner("test-created-chat")).toBe(ctx.userId);
    const stored = await orgContext.run({ organizationId: ctx.organizationId },
      () => store.getConnection("test-created-chat"));
    expect(stored).toHaveProperty("createdBy", ctx.userId);
  });

  it("honors the existing admin creator override and preserves ownership on apply", async () => {
    const other = await createTestUser();
    await addUserToOrganization(other.id, ctx.organizationId, "member");
    const result = await handleCreate({
      action: "create", connector_key: "telegram", slug: "test-delegated-chat",
      created_by: other.id, config: CONFIG,
    }, ctx);
    expect(result).not.toHaveProperty("error");
    expect(await owner("test-delegated-chat")).toBe(other.id);
    const reapplied = await handleApplyChatConnection({
      action: "apply_chat_connection", connector_key: "telegram",
      stable_id: "test-delegated-chat", config: CONFIG,
    }, ctx);
    expect(reapplied).not.toHaveProperty("error");
    expect(await owner("test-delegated-chat")).toBe(other.id);
  });

  it("records a first apply's creator but never claims a legacy ownerless row on reapply", async () => {
    const input = {
      action: "apply_chat_connection" as const, connector_key: "telegram",
      stable_id: "test-applied-chat", config: CONFIG,
    };
    expect(await handleApplyChatConnection(input, ctx)).not.toHaveProperty("error");
    expect(await owner(input.stable_id)).toBe(ctx.userId);
    await getDb()`UPDATE connections SET created_by = NULL
      WHERE organization_id = ${ctx.organizationId} AND slug = ${runtimeConnectionIdToSlug(input.stable_id)}`;
    expect(await handleApplyChatConnection(input, ctx)).not.toHaveProperty("error");
    expect(await owner(input.stable_id)).toBeNull();
  });

  it("records the Lobu claimant for a managed Slack install and preserves it on reinstall", async () => {
    const teamId = "T_SYNTHETIC_CREATOR";
    await writeSlackPendingInstall({
      teamId, teamName: "Synthetic team", botUserId: "U_SYNTHETIC_BOT",
      installerUserId: "U_SYNTHETIC_PROVIDER_INSTALLER", botToken: "xoxb-synthetic-test-token",
      enterpriseId: null, isEnterpriseInstall: false,
    });
    const pending = await resolveSlackPendingByTenant(teamId);
    expect(pending).not.toBeNull();
    const { installationId } = await claimSlackPendingInstall(
      installations, registry, pending!, ctx.organizationId, false, ctx.userId!,
    );
    expect(await owner(installationId)).toBe(ctx.userId);

    const other = await createTestUser();
    await addUserToOrganization(other.id, ctx.organizationId, "admin");
    const reinstalled = await upsertSlackInstallByTeam(
      installations, registry, ctx.organizationId, teamId,
      { botToken: "xoxb-synthetic-reinstall-token", createdBy: other.id },
    );
    expect(reinstalled.id).toBe(installationId);
    expect(await owner(installationId)).toBe(ctx.userId);

    await getDb()`UPDATE connections SET created_by = NULL
      WHERE organization_id = ${ctx.organizationId}
        AND slug = ${runtimeConnectionIdToSlug(installationId)}`;
    await upsertSlackInstallByTeam(
      installations, registry, ctx.organizationId, teamId,
      { botToken: "xoxb-synthetic-legacy-token", createdBy: ctx.userId! },
    );
    expect(await owner(installationId)).toBeNull();
  });
});
