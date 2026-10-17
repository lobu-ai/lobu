import { afterEach, expect, test } from "bun:test";
import { syntheticImage } from "../../../../scripts/__tests__/fixtures/synthetic-image";
import { createMcpToolDefinitions } from "../index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("bounds each legacy MCP result without permanently disabling later observations", async () => {
  const bytes = Buffer.alloc((10 * 1024 * 1024) / 8);
  syntheticImage().bytes.copy(bytes);
  const image = {
    type: "image",
    mimeType: "image/png",
    data: bytes.toString("base64"),
  };
  globalThis.fetch = (async () =>
    Response.json({
      content: Array.from({ length: 9 }, () => image),
    })) as typeof fetch;
  const context = {
    model: { input: ["text", "image"] },
    sessionManager: {
      getSessionId: () => "synthetic-session",
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "user",
            content: Array.from({ length: 8 }, () => image),
          },
        },
      ],
    },
  } as never;
  const [tool] = createMcpToolDefinitions(
    { synthetic: [{ name: "observe", inputSchema: { type: "object" } }] },
    {
      gatewayUrl: "https://gateway.example.test",
      workerToken: "synthetic-token",
      channelId: "test",
      conversationId: "test",
    }
  );
  for (let call = 0; call < 2; call++) {
    const result = await tool!.execute(
      `call-${call}`,
      {},
      undefined,
      undefined,
      context
    );
    expect(result.content.filter((part) => part.type === "image")).toHaveLength(
      8
    );
    expect(JSON.stringify(result.content)).toContain("image budget exhausted");
  }
});

test.each([
  true,
  false,
])("plugin tool checks image support (%s) before delivering pixels", async (supportsImages) => {
  const image = {
    type: "image",
    mimeType: "image/png",
    data: syntheticImage().bytes.toString("base64"),
  };
  globalThis.fetch = (async () =>
    Response.json({
      content: [{ type: "text", text: "Observed." }, image],
    })) as typeof fetch;
  const [tool] = createMcpToolDefinitions(
    { synthetic: [{ name: "observe", inputSchema: { type: "object" } }] },
    {
      gatewayUrl: "https://gateway.example.test",
      workerToken: "synthetic-token",
      channelId: "test",
      conversationId: "test",
    }
  );
  const result = await tool!.execute("call", {}, undefined, undefined, {
    model: { input: supportsImages ? ["text", "image"] : ["text"] },
  } as never);
  if (supportsImages) expect(result.content).toContainEqual(image);
  else {
    expect(result.content.some((part) => part.type === "image")).toBe(false);
    expect(JSON.stringify(result.content)).toContain(
      "does not declare image input support"
    );
  }
});
