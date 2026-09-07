import { describe, expect, test } from "bun:test";
import { estimatePromptTokenCost, resolveMemoryFlushConfig } from "@lobu/core";

describe("memory flush config", () => {
  test("uses defaults when config missing", () => {
    const cfg = resolveMemoryFlushConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.softThresholdTokens).toBe(4000);
    expect(cfg.systemPrompt).toBe(
      "Session nearing compaction. Store durable memories now."
    );
    expect(cfg.prompt).toContain("Reply with NO_REPLY");
  });

  test("uses configured memory flush options", () => {
    const cfg = resolveMemoryFlushConfig({
      compaction: {
        memoryFlush: {
          enabled: false,
          softThresholdTokens: 1234,
          systemPrompt: "  custom system  ",
          prompt: "  custom prompt  ",
        },
      },
    });

    expect(cfg).toEqual({
      enabled: false,
      softThresholdTokens: 1234,
      systemPrompt: "custom system",
      prompt: "custom prompt",
    });
  });

  test("falls back for invalid values", () => {
    const cfg = resolveMemoryFlushConfig({
      compaction: {
        memoryFlush: {
          enabled: "yes",
          softThresholdTokens: -10,
          systemPrompt: "   ",
          prompt: 123,
        },
      },
    } as unknown as Record<string, unknown>);

    expect(cfg.enabled).toBe(true);
    expect(cfg.softThresholdTokens).toBe(4000);
    expect(cfg.systemPrompt).toBe(
      "Session nearing compaction. Store durable memories now."
    );
    expect(cfg.prompt).toContain("Reply with NO_REPLY");
  });
});

describe("estimatePromptTokenCost", () => {
  test("includes text and image token estimates", () => {
    expect(estimatePromptTokenCost("1234", 0)).toBe(1);
    expect(estimatePromptTokenCost("1234", 2)).toBe(2401);
  });
});
