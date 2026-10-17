import { afterEach, expect, test } from "bun:test";
import { syntheticImage } from "../../../../scripts/__tests__/fixtures/synthetic-image";
import { createMcpToolDefinitions } from "../index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("shares the retained-image budget across concurrent tools and rehydrates it", async () => {
  // Eight padded PNGs fill the 10 MiB retained-byte budget.
  const bytes = Buffer.alloc((10 * 1024 * 1024) / 8);
  syntheticImage().bytes.copy(bytes);
  const image = {
    type: "image",
    mimeType: "image/png",
    data: bytes.toString("base64"),
  };
  globalThis.fetch = (async () =>
    Response.json({
      content: Array.from({ length: 6 }, () => image),
    })) as typeof fetch;
  const sessionManager = {
    getSessionId: () => "synthetic-session",
    getEntries: () => [
      { type: "message", message: { role: "user", content: [image, image] } },
    ],
  };
  const context = {
    model: { input: ["text", "image"] },
    sessionManager,
  } as never;
  const gateway = {
    gatewayUrl: "https://gateway.example.test",
    workerToken: "synthetic-token",
    channelId: "test",
    conversationId: "test",
  };
  const definitions = {
    synthetic: [
      { name: "observe", inputSchema: { type: "object" } },
      { name: "observe_again", inputSchema: { type: "object" } },
    ],
  };
  const tools = createMcpToolDefinitions(definitions, gateway);
  const results = await Promise.all(
    tools.map((tool) => tool.execute("call", {}, undefined, undefined, context))
  );
  expect(
    results
      .flatMap((result) => result.content)
      .filter((part) => part.type === "image")
  ).toHaveLength(6);
  expect(JSON.stringify(results)).toContain("image budget exhausted");
  // Fresh plugin instance reads a checkpoint with all eight images retained.
  sessionManager.getEntries = () => [
    {
      type: "message",
      message: {
        role: "user",
        content: Array.from({ length: 8 }, () => image),
      },
    },
  ];
  const [rehydrated] = createMcpToolDefinitions(definitions, gateway);
  const result = await rehydrated!.execute(
    "call",
    {},
    undefined,
    undefined,
    context
  );
  expect(result.content.some((part) => part.type === "image")).toBe(false);
  // Pi can reuse the manager object for a new conversation.
  sessionManager.getSessionId = () => "new-synthetic-session";
  sessionManager.getEntries = () => [];
  const fresh = await tools[0]!.execute(
    "call",
    {},
    undefined,
    undefined,
    context
  );
  expect(fresh.content.filter((part) => part.type === "image")).toHaveLength(6);
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
