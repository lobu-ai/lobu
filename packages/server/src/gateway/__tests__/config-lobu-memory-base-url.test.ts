import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetPublicOriginCachesForTests,
  getConfiguredPublicGatewayUrl,
  getConfiguredPublicOrigin,
  normalizePublicGatewayUrl,
  resolvePublicGatewayUrl,
} from "../../utils/public-origin.js";
import { getLobuMemoryUpstreamOrigin } from "../config/index.js";
import { McpConfigService } from "../auth/mcp/config-service.js";
import { buildGatewayConfig } from "../config/index.js";

const ORIGINAL_ENV = {
  ALLOWED_TOOLS: process.env.ALLOWED_TOOLS,
  DISALLOWED_TOOLS: process.env.DISALLOWED_TOOLS,
  DATABASE_URL: process.env.DATABASE_URL,
  DISPATCHER_URL: process.env.DISPATCHER_URL,
  PORT: process.env.PORT,
  PUBLIC_GATEWAY_URL: process.env.PUBLIC_GATEWAY_URL,
};

afterEach(() => {
  __resetPublicOriginCachesForTests();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("normalizePublicGatewayUrl", () => {
  test("appends /lobu when only an origin is configured", () => {
    expect(normalizePublicGatewayUrl("https://public.example.com")).toBe(
      "https://public.example.com/lobu"
    );
  });

  test("preserves an explicit /lobu mount", () => {
    expect(normalizePublicGatewayUrl("https://public.example.com/lobu/")).toBe(
      "https://public.example.com/lobu"
    );
  });
});

describe("getLobuMemoryUpstreamOrigin", () => {
  test("derives loopback origin from PORT", () => {
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";
    process.env.PUBLIC_GATEWAY_URL = "https://public.example.com";

    expect(getLobuMemoryUpstreamOrigin()).toBe("http://127.0.0.1:8787");
  });

  test("derives origin from DISPATCHER_URL when set", () => {
    process.env.DISPATCHER_URL = "http://gateway.internal:9000/lobu";

    expect(getLobuMemoryUpstreamOrigin()).toBe("http://gateway.internal:9000");
  });
});

describe("resolvePublicGatewayUrl", () => {
  test("maps PUBLIC_GATEWAY_URL to the /lobu gateway mount", () => {
    process.env.PUBLIC_GATEWAY_URL = "https://public.example.com";
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";

    expect(getConfiguredPublicOrigin()).toBe("https://public.example.com");
    expect(getConfiguredPublicGatewayUrl()).toBe(
      "https://public.example.com/lobu"
    );
    expect(resolvePublicGatewayUrl()).toBe("https://public.example.com/lobu");
  });
});

describe("McpConfigService lobu-memory upstream", () => {
  test("derives upstream from internal gateway URL, not PUBLIC_GATEWAY_URL", async () => {
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";
    process.env.PUBLIC_GATEWAY_URL = "https://public.example.com";

    const service = new McpConfigService({
      lobuMemory: {
        resolveOrgSlug: async () => "acme",
      },
    });

    await expect(service.getHttpServer("lobu-memory", "agent1")).resolves.toEqual({
      id: "lobu-memory",
      upstreamUrl: "http://127.0.0.1:8787/mcp/acme",
      internal: true,
    });
  });
});

describe("buildGatewayConfig embedded overrides", () => {
  test.each(["ALLOWED_TOOLS", "DISALLOWED_TOOLS"])("rejects retired %s instead of ignoring a restriction", (key) => {
    delete process.env.ALLOWED_TOOLS;
    delete process.env.DISALLOWED_TOOLS;
    process.env[key] = "read";
    expect(() => buildGatewayConfig()).toThrow(`${key} was removed`);
  });

  test("normalizes PUBLIC_GATEWAY_URL for webhook and artifact URLs", () => {
    process.env.DATABASE_URL = "postgres://localhost/lobu";
    process.env.PUBLIC_GATEWAY_URL = "https://public.example.com";
    delete process.env.DISPATCHER_URL;
    process.env.PORT = "8787";

    const config = buildGatewayConfig({
      mcp: { publicGatewayUrl: resolvePublicGatewayUrl() },
      auth: { issuerUrl: getConfiguredPublicOrigin() || "https://public.example.com" },
    });

    expect(config.mcp.publicGatewayUrl).toBe("https://public.example.com/lobu");
  });
});