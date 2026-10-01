import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client.js";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store.js";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores.js";
import { PostgresSecretStore } from "../../../lobu/stores/postgres-secret-store.js";
import { orgContext } from "../../../lobu/stores/org-context.js";
import { runtimeConnectionIdToSlug, upsertChatConnectionProjection } from "../../../lobu/stores/connections-projection.js";
import { ChatInstanceManager } from "../../../gateway/connections/chat-instance-manager.js";
import { acceptGoogleChatWebhook, activateGoogleChatSpace, googleChatInstallationId, resolveGoogleChatRuntime, revokeGoogleChatSpace, routeGoogleChatWebhook } from "../../../gateway/connections/platforms/gchat-installation.js";
import { cleanupTestDatabase } from "../../setup/test-db.js";
import { createTestOrganization } from "../../setup/test-fixtures.js";
import type { StoredConnection } from "@lobu/core";

beforeEach(async () => { await cleanupTestDatabase(); });

async function fixture() {
  const owner = await createTestOrganization();
  const target = await createTestOrganization();
  const third = await createTestOrganization();
  const store = createPostgresAppInstallationStore();
  const connectionStore = createPostgresAgentConnectionStore();
  const secrets = new PostgresSecretStore();
  const secretName = "connections/test-google-source/credentials";
  const credentials = await orgContext.run({ organizationId: owner.id }, () => secrets.put(secretName,
    JSON.stringify({ client_email: "bot@example.test", private_key: "test-key" })));
  const source: StoredConnection = {
    id: "test-google-source", organizationId: owner.id, platform: "gchat", status: "active",
    config: { platform: "gchat", googleChatProjectNumber: "123456789", credentials },
    settings: { allowGroups: true }, metadata: {}, createdAt: 1, updatedAt: 1,
  };
  const sql = getDb();
  await sql.begin((tx) => upsertChatConnectionProjection(tx, (value) => sql.json(value as any), source, owner.id, "byo"));
  const manager: any = new ChatInstanceManager();
  manager.publicGatewayUrl = "https://gateway.test";
  manager.connectionStore = connectionStore;
  manager.services = { getAppInstallationStore: () => store, getSecretStore: () => secrets };
  const deps = manager.runtimeDeps();
  const space = "spaces/test-team-space";
  const id = await activateGoogleChatSpace(store, source, target.id, space);
  const connection = await deps.getConnection(id);
  const request = (spaceName = space) => new Request("https://gateway.test/api/v1/webhooks/test-google-source", {
    method: "POST", headers: { authorization: "Bearer not-verified-here" },
    body: JSON.stringify({ type: "MESSAGE", space: { name: spaceName }, message: { name: `${spaceName}/messages/test` } }),
  });
  return { owner, target, third, source, store, secrets, deps, id, space, connection: connection!, request, secretName, sql };
}

describe("Google Chat installation ownership and dispatch", () => {
  it("creates an owned projection without copying source credentials or settings", async () => {
    const f = await fixture();
    expect(f.id).toBe(googleChatInstallationId(f.target.id, "123456789", f.space));
    expect(f.connection.organizationId).toBe(f.target.id);
    expect(f.connection.config).toMatchObject({ platform: "gchat", installation_ref: expect.any(String) });
    expect(f.connection.config.credentials).toBeUndefined();
    expect((f.connection.settings as any).previewMode).not.toBe(true);
    const runtime = await orgContext.run({ organizationId: f.target.id }, () => resolveGoogleChatRuntime(f.connection, f.deps));
    expect((runtime!.config as any).credentials).toContain("test-key");
    const rows = await f.sql`SELECT organization_id FROM agent_secrets WHERE name = ${f.secretName}`;
    expect(rows.map((row) => row.organization_id)).toEqual([f.owner.id]);
  });
  it("repeated concurrent activation converges on one install and projection", async () => {
    const f = await fixture();
    const ids = await Promise.all([1, 2, 3].map(() => activateGoogleChatSpace(f.store, f.source, f.target.id, f.space)));
    expect(ids).toEqual([f.id, f.id, f.id]);
    const installs = await f.store.listByProviderAndOrg("gchat", f.target.id);
    expect(installs.filter((row) => row.status === "active")).toHaveLength(1);
    const slug = runtimeConnectionIdToSlug(f.id);
    const rows = await f.sql`SELECT id FROM connections WHERE slug = ${slug} AND deleted_at IS NULL`;
    expect(rows).toHaveLength(1);
    await expect(activateGoogleChatSpace(f.store, f.source, f.third.id, f.space)).rejects.toThrow();
  });
  it("routes only the installed space and preserves other private spaces", async () => {
    const f = await fixture();
    expect(await routeGoogleChatWebhook(f.source, f.request(), f.deps)).toBe(f.id);
    expect(await routeGoogleChatWebhook(f.source, f.request("spaces/test-personal-space"), f.deps)).toBeUndefined();
    expect((await f.deps.getConnection(f.source.id))!.organizationId).toBe(f.owner.id);
    const wrongSource = { ...f.source, id: "test-other-source" };
    expect((await routeGoogleChatWebhook(wrongSource, f.request(), f.deps) as Response).status).toBe(403);
  });
  it("leaves endpoint-authenticated BYO connections without a project number on their own transport", async () => {
    const f = await fixture();
    const source = { ...f.source, config: {
      platform: "gchat", endpointUrl: "https://gateway.test/api/v1/webhooks/test-google-source",
      credentials: (f.source.config as any).credentials,
    } };
    await expect(routeGoogleChatWebhook(source, f.request(), f.deps)).resolves.toBeUndefined();
  });
  it("revocation blocks installed routing without falling back to a private binding", async () => {
    const f = await fixture();
    await revokeGoogleChatSpace({ id: f.id, organizationId: f.target.id }, f.deps);
    expect((await routeGoogleChatWebhook(f.source, f.request(), f.deps) as Response).status).toBe(403);
    await expect(resolveGoogleChatRuntime(f.connection, f.deps)).rejects.toThrow();
    const secret = await orgContext.run({ organizationId: f.owner.id }, () => f.secrets.list("connections/test-google-source/"));
    expect(secret).toHaveLength(1);
    expect((await f.deps.getConnection(f.source.id))!.status).toBe("active");
  });
  it("observes a real vault rotation that does not change the source row", async () => {
    const f = await fixture();
    const before = await resolveGoogleChatRuntime(f.connection, f.deps);
    await orgContext.run({ organizationId: f.owner.id }, () => f.secrets.put(f.secretName,
      JSON.stringify({ client_email: "bot@example.test", private_key: "rotated-test-key" })));
    const after = await resolveGoogleChatRuntime(f.connection, f.deps);
    expect(after!.revision).not.toBe(before!.revision);
    expect((after!.config as any).credentials).toContain("rotated-test-key");
  });
  for (const removal of [
    { type: "REMOVED_FROM_SPACE" },
    { eventType: "REMOVED_FROM_SPACE" },
    { chat: { removedFromSpacePayload: { space: { name: "spaces/test-team-space" } } } },
  ]) {
    it(`revokes a verified removal: ${JSON.stringify(removal)}`, async () => {
      const f = await fixture();
      await acceptGoogleChatWebhook(f.connection, new Request("https://gateway.test", {
        method: "POST", body: JSON.stringify({ ...removal, space: { name: f.space } }),
      }), f.deps);
      expect((await f.deps.getConnection(f.id))!.status).toBe("stopped");
      await expect(resolveGoogleChatRuntime(f.connection, f.deps)).rejects.toThrow();
      expect((await f.deps.getConnection(f.source.id))!.status).toBe("active");
    });
  }
  it("does not resurrect a projection when revocation wins between activation and projection", async () => {
    const f = await fixture();
    const revokedDuringActivation = {
      ...f.store, upsert: async (input: Parameters<typeof f.store.upsert>[0]) => {
        const row = await f.store.upsert(input);
        await f.store.revoke(row.id);
        return row;
      },
    };
    await expect(activateGoogleChatSpace(revokedDuringActivation, f.source, f.target.id, f.space)).rejects.toThrow();
    await expect(resolveGoogleChatRuntime(f.connection, f.deps)).rejects.toThrow();
  });
  it("serializes projection activation against a concurrent installation revoke", async () => {
    const f = await fixture();
    const activated = Promise.withResolvers<number>();
    const project = Promise.withResolvers<void>();
    const pausedStore = {
      ...f.store, upsert: async (input: Parameters<typeof f.store.upsert>[0]) => {
        const row = await f.store.upsert(input);
        activated.resolve(row.id);
        await project.promise;
        return row;
      },
    };
    const activation = activateGoogleChatSpace(pausedStore, f.source, f.target.id, f.space)
      .then(() => null, (error: unknown) => error);
    const installId = await activated.promise;
    await f.sql.begin(async (tx) => {
      const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT id FROM app_installations WHERE id = ${installId} FOR UPDATE`;
      project.resolve();
      // Observe the real second session waiting on this transaction, rather
      // than treating an arbitrary sleep as evidence of serialization.
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const rows = await f.sql`
          SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid)) LIMIT 1
        `;
        if (rows.length) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await tx`UPDATE app_installations SET status = 'revoked', updated_at = now() WHERE id = ${installId}`;
      const slug = runtimeConnectionIdToSlug(f.id);
      await tx`UPDATE connections SET status = 'paused', updated_at = now() WHERE slug = ${slug} AND deleted_at IS NULL`;
    });
    expect(await activation).toBeInstanceOf(Error);
    expect((await f.deps.getConnection(f.id))!.status).toBe("stopped");
    await expect(resolveGoogleChatRuntime(f.connection, f.deps)).rejects.toThrow();
  });
});
