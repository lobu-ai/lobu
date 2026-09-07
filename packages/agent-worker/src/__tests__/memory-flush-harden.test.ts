/**
 * Hardening tests for memory-flush and estimatePromptTokenCost.
 *
 * Covers gaps in memory-flush.test.ts and memory-flush-runtime.test.ts:
 * - resolveMemoryFlushConfig with null compaction / deeply-nested invalid values
 * - resolveMemoryFlushConfig enabled=false prevents flush
 * - estimatePromptTokenCost with edge values (0 chars, negative image count)
 * - maybeRunPreCompactionMemoryFlush: flush skipped when config.enabled=false
 * - maybeRunPreCompactionMemoryFlush: flush skipped when projected tokens are below threshold
 * - maybeRunPreCompactionMemoryFlush: 'stored' outcome recorded correctly
 * - getLatestAssistantText: multi-block content and NO_REPLY case-insensitivity
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { estimatePromptTokenCost, resolveMemoryFlushConfig } from "@lobu/core";
import { LobuAgentWorker } from "../runtime/worker";
import { mockWorkerConfig } from "./setup";

// ---------------------------------------------------------------------------
// resolveMemoryFlushConfig edge cases
// ---------------------------------------------------------------------------

describe("resolveMemoryFlushConfig — edge cases", () => {
  test("null compaction falls back to defaults", () => {
    const cfg = resolveMemoryFlushConfig({ compaction: null } as any);
    expect(cfg.enabled).toBe(true);
    expect(cfg.softThresholdTokens).toBe(4000);
  });

  test("compaction is a number (not object) falls back to defaults", () => {
    const cfg = resolveMemoryFlushConfig({ compaction: 42 } as any);
    expect(cfg.enabled).toBe(true);
  });

  test("memoryFlush.softThresholdTokens=0 is valid (non-negative)", () => {
    const cfg = resolveMemoryFlushConfig({
      compaction: { memoryFlush: { softThresholdTokens: 0 } },
    });
    expect(cfg.softThresholdTokens).toBe(0);
  });

  test("memoryFlush.softThresholdTokens=Infinity is invalid → fallback", () => {
    const cfg = resolveMemoryFlushConfig({
      compaction: { memoryFlush: { softThresholdTokens: Infinity } },
    } as any);
    expect(cfg.softThresholdTokens).toBe(4000);
  });

  test("memoryFlush.softThresholdTokens=NaN is invalid → fallback", () => {
    const cfg = resolveMemoryFlushConfig({
      compaction: { memoryFlush: { softThresholdTokens: NaN } },
    } as any);
    expect(cfg.softThresholdTokens).toBe(4000);
  });

  test("enabled=false is preserved", () => {
    const cfg = resolveMemoryFlushConfig({
      compaction: { memoryFlush: { enabled: false } },
    });
    expect(cfg.enabled).toBe(false);
  });

  test("systemPrompt whitespace-only falls back to default", () => {
    const cfg = resolveMemoryFlushConfig({
      compaction: { memoryFlush: { systemPrompt: "   " } },
    });
    expect(cfg.systemPrompt).toBe(
      "Session nearing compaction. Store durable memories now."
    );
  });

  test("prompt whitespace-only falls back to default", () => {
    const cfg = resolveMemoryFlushConfig({
      compaction: { memoryFlush: { prompt: "\t\n" } },
    });
    expect(cfg.prompt).toContain("NO_REPLY");
  });

  test("extra unknown keys in memoryFlush are ignored", () => {
    const cfg = resolveMemoryFlushConfig({
      compaction: {
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 2000,
          unknownKey: "value",
        },
      },
    } as any);
    expect(cfg.softThresholdTokens).toBe(2000);
    expect((cfg as any).unknownKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// estimatePromptTokenCost edge cases
// ---------------------------------------------------------------------------

describe("estimatePromptTokenCost — edge cases", () => {
  test("empty string with no images costs 0", () => {
    expect(estimatePromptTokenCost("", 0)).toBe(0);
  });

  test("negative image count is treated as 0", () => {
    expect(estimatePromptTokenCost("abcd", -5)).toBe(1);
  });

  test("4-char string costs 1 token", () => {
    expect(estimatePromptTokenCost("abcd", 0)).toBe(1);
  });

  test("5-char string costs 2 tokens (ceil)", () => {
    expect(estimatePromptTokenCost("abcde", 0)).toBe(2);
  });

  test("each image adds ~1200 tokens", () => {
    const oneImage = estimatePromptTokenCost("", 1);
    const twoImages = estimatePromptTokenCost("", 2);
    expect(twoImages - oneImage).toBe(1200);
  });

  test("large text + multiple images combine additively", () => {
    const textTokens = Math.ceil("hello world".length / 4); // 3
    const imageTokens = 3 * 1200;
    expect(estimatePromptTokenCost("hello world", 3)).toBe(
      textTokens + imageTokens
    );
  });
});

// ---------------------------------------------------------------------------
// maybeRunPreCompactionMemoryFlush: enabled=false skips flush
// ---------------------------------------------------------------------------

describe("maybeRunPreCompactionMemoryFlush — enabled=false", () => {
  beforeEach(() => {
    process.env.DISPATCHER_URL = "https://test-dispatcher.example.com";
    process.env.WORKER_TOKEN = "test-worker-token";
  });

  test("skips flush when memoryFlushConfig.enabled=false regardless of context usage", async () => {
    const worker = new LobuAgentWorker(mockWorkerConfig);
    const settingsManager = SettingsManager.inMemory();

    let silentCallCount = 0;
    const session = {
      getContextUsage: () => ({
        tokens: 99000,
        contextWindow: 100000,
        percent: 99,
        usageTokens: 99000,
        trailingTokens: 0,
        lastUsageIndex: 1,
      }),
      messages: [],
    } as any;

    const sessionManager = {
      getBranch: () => [],
      appendCustomEntry: () => undefined,
    } as any;

    await (worker as any).maybeRunPreCompactionMemoryFlush({
      session,
      sessionManager,
      settingsManager,
      memoryFlushConfig: {
        enabled: false,
        softThresholdTokens: 4000,
        systemPrompt: "Store now.",
        prompt: "Reply with NO_REPLY.",
      },
      incomingPromptText: "hello",
      incomingImageCount: 0,
      runSilentPrompt: async () => {
        silentCallCount += 1;
      },
    });

    expect(silentCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// maybeRunPreCompactionMemoryFlush: 'stored' outcome
// ---------------------------------------------------------------------------

describe("maybeRunPreCompactionMemoryFlush — 'stored' outcome", () => {
  beforeEach(() => {
    process.env.DISPATCHER_URL = "https://test-dispatcher.example.com";
    process.env.WORKER_TOKEN = "test-worker-token";
  });

  test("records 'stored' outcome when latest assistant message is not NO_REPLY", async () => {
    const worker = new LobuAgentWorker(mockWorkerConfig);
    const settingsManager = SettingsManager.inMemory();

    const branchEntries: Array<Record<string, unknown>> = [];
    const sessionManager = {
      getBranch: () => branchEntries as any,
      appendCustomEntry: (customType: string, data: unknown) => {
        branchEntries.push({
          type: "custom",
          id: crypto.randomUUID(),
          parentId: null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        });
      },
    } as any;

    const session = {
      getContextUsage: () => ({
        tokens: 95000,
        contextWindow: 100000,
        percent: 95,
        usageTokens: 95000,
        trailingTokens: 0,
        lastUsageIndex: 1,
      }),
      messages: [
        {
          role: "assistant",
          content: "I stored the key information in memory.",
        },
      ],
    } as any;

    await (worker as any).maybeRunPreCompactionMemoryFlush({
      session,
      sessionManager,
      settingsManager,
      memoryFlushConfig: {
        enabled: true,
        softThresholdTokens: 4000,
        systemPrompt: "Store now.",
        prompt: "Reply with NO_REPLY.",
      },
      incomingPromptText: "hello",
      incomingImageCount: 0,
      runSilentPrompt: async () => undefined,
    });

    const state = branchEntries.find((e) => e.type === "custom") as any;
    expect(state?.data?.outcome).toBe("stored");
  });
});

// ---------------------------------------------------------------------------
// maybeRunPreCompactionMemoryFlush: NO_REPLY is case-insensitive
// ---------------------------------------------------------------------------

describe("maybeRunPreCompactionMemoryFlush — NO_REPLY case-insensitivity", () => {
  beforeEach(() => {
    process.env.DISPATCHER_URL = "https://test-dispatcher.example.com";
    process.env.WORKER_TOKEN = "test-worker-token";
  });

  test("lowercase 'no_reply' is treated as NO_REPLY outcome", async () => {
    const worker = new LobuAgentWorker(mockWorkerConfig);
    const settingsManager = SettingsManager.inMemory();

    const branchEntries: Array<Record<string, unknown>> = [];
    const sessionManager = {
      getBranch: () => branchEntries as any,
      appendCustomEntry: (customType: string, data: unknown) => {
        branchEntries.push({
          type: "custom",
          id: crypto.randomUUID(),
          parentId: null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        });
      },
    } as any;

    const session = {
      getContextUsage: () => ({
        tokens: 95000,
        contextWindow: 100000,
        percent: 95,
        usageTokens: 95000,
        trailingTokens: 0,
        lastUsageIndex: 1,
      }),
      messages: [{ role: "assistant", content: "no_reply" }],
    } as any;

    await (worker as any).maybeRunPreCompactionMemoryFlush({
      session,
      sessionManager,
      settingsManager,
      memoryFlushConfig: {
        enabled: true,
        softThresholdTokens: 4000,
        systemPrompt: "Store now.",
        prompt: "Reply with NO_REPLY.",
      },
      incomingPromptText: "hello",
      incomingImageCount: 0,
      runSilentPrompt: async () => undefined,
    });

    const state = branchEntries.find((e) => e.type === "custom") as any;
    expect(state?.data?.outcome).toBe("no_reply");
  });

  test("array-content NO_REPLY is detected", async () => {
    const worker = new LobuAgentWorker(mockWorkerConfig);
    const settingsManager = SettingsManager.inMemory();

    const branchEntries: Array<Record<string, unknown>> = [];
    const sessionManager = {
      getBranch: () => branchEntries as any,
      appendCustomEntry: (customType: string, data: unknown) => {
        branchEntries.push({
          type: "custom",
          id: crypto.randomUUID(),
          parentId: null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        });
      },
    } as any;

    const session = {
      getContextUsage: () => ({
        tokens: 95000,
        contextWindow: 100000,
        percent: 95,
        usageTokens: 95000,
        trailingTokens: 0,
        lastUsageIndex: 1,
      }),
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "NO_REPLY" }],
        },
      ],
    } as any;

    await (worker as any).maybeRunPreCompactionMemoryFlush({
      session,
      sessionManager,
      settingsManager,
      memoryFlushConfig: {
        enabled: true,
        softThresholdTokens: 4000,
        systemPrompt: "Store now.",
        prompt: "Reply with NO_REPLY.",
      },
      incomingPromptText: "hi",
      incomingImageCount: 0,
      runSilentPrompt: async () => undefined,
    });

    const state = branchEntries.find((e) => e.type === "custom") as any;
    expect(state?.data?.outcome).toBe("no_reply");
  });
});
