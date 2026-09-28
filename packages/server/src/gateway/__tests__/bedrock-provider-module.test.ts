import { describe, expect, test } from "bun:test";
import { BedrockProviderModule } from "../auth/bedrock/provider-module.js";
import { BedrockModelCatalog } from "../services/bedrock-model-catalog.js";

describe("BedrockProviderModule", () => {
  const createModule = () =>
    new BedrockProviderModule(
      {} as any,
      new BedrockModelCatalog({
        cacheTtlMs: 0,
        loadModels: async () => [
          {
            id: "amazon.nova-lite-v1:0",
            label: "Amazon / Nova Lite",
          },
        ],
      })
    );

  test("points workers at the gateway-owned Bedrock route", () => {
    const module = createModule();

    expect(
      module.getProxyBaseUrlMappings(
        "http://gateway:8080/api/proxy",
        "agent-123"
      )
    ).toEqual({
      AMAZON_BEDROCK_BASE_URL:
        "http://gateway:8080/api/bedrock/openai/a/agent-123",
    });
  });

  test("returns Bedrock model options under the amazon-bedrock provider prefix", async () => {
    const module = createModule();
    const options = await module.getModelOptions("agent-1", "user-1");

    expect(options).toEqual([
      {
        value: "amazon-bedrock/amazon.nova-lite-v1:0",
        label: "Amazon / Nova Lite",
      },
    ]);
  });
});
