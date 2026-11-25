import { afterEach, describe, expect, test } from "bun:test";
import { McpConfigService } from "../auth/mcp/config-service.js";

const ORIGINAL_PORT = process.env.PORT;
const ORIGINAL_DISPATCHER_URL = process.env.DISPATCHER_URL;

afterEach(() => {
  if (ORIGINAL_PORT === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = ORIGINAL_PORT;
  }
  if (ORIGINAL_DISPATCHER_URL === undefined) {
    delete process.env.DISPATCHER_URL;
  } else {
    process.env.DISPATCHER_URL = ORIGINAL_DISPATCHER_URL;
  }
});

describe("McpConfigService", () => {
  test("returns no MCPs when lobu-memory cannot be derived", async () => {
    const service = new McpConfigService();

    expect(await service.getMcpStatus("agent1")).toEqual([]);
    expect(await service.getAllHttpServers("agent1")).toEqual(new Map());
  });

  test("exposes lobu-memory proxy metadata and status", async () => {
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";
    const service = new McpConfigService({
      lobuMemory: {
        resolveOrgSlug: async () => "acme",
      },
    });

    await expect(service.getMcpStatus("agent1")).resolves.toEqual([
      {
        id: "lobu-memory",
        name: "lobu-memory",
        requiresAuth: false,
        requiresInput: false,
      },
    ]);

    await expect(service.getHttpServer("lobu-memory", "agent1")).resolves.toEqual({
      id: "lobu-memory",
      upstreamUrl: "http://127.0.0.1:8787/mcp/acme",
      internal: true,
    });

    const all = await service.getAllHttpServers("agent1");
    expect([...all.keys()]).toEqual(["lobu-memory"]);
  });
});
