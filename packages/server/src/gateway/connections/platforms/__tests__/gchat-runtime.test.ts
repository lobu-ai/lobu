import { describe, expect, test } from "bun:test";
import type { StoredConnection } from "@lobu/core";
import { orgContext, tryGetOrgId } from "../../../../lobu/stores/org-context.js";
import { ChatInstanceManager } from "../../chat-instance-manager.js";
import { googleChatInstallationId, resolveGoogleChatRuntime, routeGoogleChatWebhook } from "../gchat-installation.js";

const project = "123456789";
const space = "spaces/team-space";
const org = "test-team-org";

function fixture() {
  const source: StoredConnection = {
    id: "test-source", organizationId: "test-source-org", platform: "gchat", status: "active",
    config: { platform: "gchat", credentials: "secret://test-credentials", googleChatProjectNumber: project },
    settings: {}, metadata: {}, createdAt: 1, updatedAt: 1,
  };
  const target: StoredConnection = {
    id: googleChatInstallationId(org, project, space), organizationId: org,
    platform: "gchat", status: "active", config: { platform: "gchat" },
    settings: {}, metadata: { teamId: space }, createdAt: 1, updatedAt: 1,
  };
  const install: any = {
    id: 1, organizationId: org, provider: "gchat", providerInstance: "cloud", providerAppId: project,
    externalTenantId: space, status: "active", metadata: { source_connection_id: source.id, source_organization_id: source.organizationId }, updatedAt: 1,
  };
  let key = "first-key";
  const manager: any = new ChatInstanceManager();
  manager.publicGatewayUrl = "https://gateway.test";
  manager.connectionStore = { getConnection: async (id: string) => {
    const conn = [source, target].find((row) => row.id === id);
    const ambient = tryGetOrgId();
    return conn && (!ambient || conn.organizationId === ambient) ? conn : null;
  } };
  manager.services = {
    getAppInstallationStore: () => ({ resolveByExternalId: async () => install }),
    getSecretStore: () => ({ get: async () => {
      expect(tryGetOrgId()).toBe(source.organizationId);
      return JSON.stringify({ client_email: "bot@example.test", private_key: key });
    } }),
  };
  return { manager, source, target, install,
    rotate: () => { key = "second-key"; },
    resolve: () => orgContext.run({ organizationId: org }, () => resolveGoogleChatRuntime(target, manager.runtimeDeps())),
  };
}

describe("Google Chat runtime authority", () => {
  test("BYO routing without a project number does not query installation authority", async () => {
    const f = fixture();
    f.source.config = { platform: "gchat", endpointUrl: "https://gateway.test/webhook" };
    const request = new Request("https://gateway.test/webhook", {
      method: "POST", body: JSON.stringify({ space: { name: space } }),
    });
    expect(await routeGoogleChatWebhook(f.source, request, f.manager.runtimeDeps())).toBeUndefined();
  });
  test("resolves credentials only in their owner's vault and preserves source webhook audience", async () => {
    const f = fixture();
    const resolved = await f.resolve();
    expect((resolved!.config as any).credentials).toContain("first-key");
    expect(resolved!.webhookUrl).toBe("https://gateway.test/api/v1/webhooks/test-source");
    expect(resolved!.scope).toBe(space);
    expect(resolved!.stateKey).toBe(f.target.id);
    expect(f.target.config).toEqual({ platform: "gchat" });
    expect((resolved!.config as any).disableSignatureVerification).toBe(false);
  });
  test("secret-only rotation changes the opaque runtime revision", async () => {
    const f = fixture();
    const before = await f.resolve();
    f.rotate();
    const after = await f.resolve();
    expect(after!.revision).not.toBe(before!.revision);
    expect((after!.config as any).credentials).toContain("second-key");
    expect(f.source.updatedAt).toBe(1);
  });
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.install.status = "suspended"; },
    (f: ReturnType<typeof fixture>) => { f.install.status = "revoked"; },
    (f: ReturnType<typeof fixture>) => { f.source.status = "stopped"; },
    (f: ReturnType<typeof fixture>) => { f.source.status = "error"; },
    (f: ReturnType<typeof fixture>) => { f.source.organizationId = "test-recreated-foreign-owner"; },
    (f: ReturnType<typeof fixture>) => { f.install.organizationId = "test-foreign-org"; },
    (f: ReturnType<typeof fixture>) => { f.install.metadata.source_connection_id = "missing"; },
    (f: ReturnType<typeof fixture>) => { f.install.providerAppId = "987654321"; },
    (f: ReturnType<typeof fixture>) => { f.target.metadata.teamId = "spaces/foreign"; },
    (f: ReturnType<typeof fixture>) => { f.target.status = "stopped"; },
  ]) {
    test(`refuses invalid authority: ${mutate.toString()}`, async () => {
      const f = fixture();
      mutate(f);
      await expect(f.resolve()).rejects.toThrow();
    });
  }
  test("warm replicas invalidate on source rotation; cold and warm replicas refuse revocation", async () => {
    const f = fixture();
    const first = await f.resolve();
    const managers = [f.manager, fixture().manager];
    // Both replicas consult the same durable authority and credential resolver.
    managers[1].connectionStore = managers[0].connectionStore;
    managers[1].services = managers[0].services;
    for (const manager of managers) {
      manager.instances.set(f.target.id, { rowVersion: 1, runtimeRevision: first!.revision });
      manager.stopInstance = async (id: string) => { manager.instances.delete(id); };
      manager.hydrateFromRow = async (row: StoredConnection) => {
        const runtime = await resolveGoogleChatRuntime(row, manager.runtimeDeps());
        manager.instances.set(row.id, { rowVersion: row.updatedAt, runtimeRevision: runtime!.revision });
      };
      expect(await manager.ensureConnectionRunning(f.target.id)).toBe(true);
    }
    f.rotate();
    for (const manager of managers) {
      expect(await manager.ensureConnectionRunning(f.target.id)).toBe(true);
      expect(manager.instances.get(f.target.id).runtimeRevision).not.toBe(first!.revision);
    }
    f.install.status = "revoked";
    for (const manager of managers) {
      expect(await manager.ensureConnectionRunning(f.target.id)).toBe(false);
      expect(manager.instances.has(f.target.id)).toBe(false);
    }
    expect(await managers[0].ensureConnectionRunning(f.target.id)).toBe(false);
  });
});
