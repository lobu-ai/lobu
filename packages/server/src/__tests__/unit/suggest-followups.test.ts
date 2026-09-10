import { afterEach, describe, expect, test } from "bun:test";
import {
  createSuggestFollowupsGuardrail,
  generateSuggestFollowups,
  isEnrichmentGuardrail,
  SUGGEST_FOLLOWUPS_NAME,
} from "../../gateway/guardrails/suggest-followups";
import type { Guardrail } from "@lobu/core";

const REPLY =
  "I looked at the connector and it polls every 15 minutes. The rate limit is 100 requests per hour, so the current schedule leaves plenty of headroom.";

const ORG = "org-test";
const ORG_DEFAULT_MODEL = "gpt-test";

/**
 * Stub target resolution so unit tests stay DB-free. Injected via
 * `options.resolveTarget` rather than `mock.module`, which is process-global in
 * Bun and corrupts sibling suites.
 */
function target(
  over: Partial<{ baseUrl: string; apiKey: string; model: string }> = {}
) {
  return async () => ({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: ORG_DEFAULT_MODEL,
    ...over,
  });
}

/** Resolution that finds nothing — the org has no provider row. */
const noTarget = async () => null;

/** Stub `fetch` with a canned chat-completion body. */
function stubFetch(content: string | null, ok = true): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: ok ? 200 : 500,
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("suggest-followups guardrail", () => {
  test("registers under the operator-facing name", () => {
    const g = createSuggestFollowupsGuardrail();
    expect(g.name).toBe(SUGGEST_FOLLOWUPS_NAME);
    expect(g.stage).toBe("output");
  });

  test("run is a pure no-op pass (generation is out-of-band)", async () => {
    const g = createSuggestFollowupsGuardrail();
    const result = await g.run({
      agentId: "a",
      userId: "u",
      text: REPLY,
      platform: "api",
    });
    expect(result).toEqual({ tripped: false });
  });

  test("isEnrichmentGuardrail identifies the built-in instance, not a colliding name", () => {
    const enrichment = createSuggestFollowupsGuardrail();
    const collidingInline = {
      name: SUGGEST_FOLLOWUPS_NAME,
      stage: "output" as const,
      run: async () => ({ tripped: true }),
    };
    expect(isEnrichmentGuardrail(enrichment)).toBe(true);
    expect(isEnrichmentGuardrail(collidingInline)).toBe(false);
  });

  test("the blocking filter drops enrichment entries", () => {
    const enrichment = createSuggestFollowupsGuardrail();
    const list = [
      { name: "secret-scan", stage: "output" as const, run: async () => ({ tripped: false }) },
      enrichment,
    ] as Guardrail<"output">[];
    const blocking = list.filter((g) => !isEnrichmentGuardrail(g));
    expect(blocking.map((g) => g.name)).toEqual(["secret-scan"]);
  });
});

describe("generateSuggestFollowups", () => {
  // The prompt used to demand "2-3 things" on every reply, so the model padded
  // turns that needed nothing. It now instructs an empty set as the default,
  // and an empty set must survive the parse/sanitize path as [] (the callers
  // treat [] as "post no card").
  test("instructs an empty default and returns [] for it", async () => {
    let systemPrompt = "";
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      systemPrompt = body.messages.find(
        (message: { role: string }) => message.role === "system"
      ).content;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"prompts":[]}' } }],
        })
      );
    }) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const out = await generateSuggestFollowups(REPLY, ORG, {
      resolveTarget: target(),
    });
    expect(systemPrompt).toContain('{"prompts":[]}');
    expect(systemPrompt).toMatch(/optional/i);
    expect(systemPrompt).toMatch(/completed requests/i);
    expect(systemPrompt).not.toMatch(/return 2-3 things/i);
    expect(out).toEqual([]);
  });

  test("parses well-formed prompts from the model", async () => {
    restore = stubFetch(
      JSON.stringify({
        prompts: [
          { title: "Raise the interval", message: "Change the poll to 5 min" },
          { title: "Show the rate limit", message: "Where is the limit set?" },
        ],
      })
    );
    const out = await generateSuggestFollowups(REPLY, ORG, { resolveTarget: target() });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      title: "Raise the interval",
      message: "Change the poll to 5 min",
    });
  });

  test("tolerates a markdown code fence around the JSON", async () => {
    restore = stubFetch(
      '```json\n{"prompts":[{"title":"T","message":"M"}]}\n```'
    );
    const out = await generateSuggestFollowups(REPLY, ORG, { resolveTarget: target() });
    expect(out).toEqual([{ title: "T", message: "M" }]);
  });

  test("returns [] when the org resolves no model, without calling out", async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const out = await generateSuggestFollowups(REPLY, ORG, {
      resolveTarget: noTarget,
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("returns [] on short replies without calling out", async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const out = await generateSuggestFollowups("ok", ORG, { resolveTarget: target() });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("returns [] when the model HTTP-errors", async () => {
    restore = stubFetch("{}", false);
    const out = await generateSuggestFollowups(REPLY, ORG, { resolveTarget: target() });
    expect(out).toEqual([]);
  });

  // A per-agent `model` is the one override worth having: credentials come from
  // the org's provider row either way, but model choice decides whether chips
  // arrive at all (a slow reasoning model times out and silently yields none).
  test("a per-guardrail model ref overrides the org default", async () => {
    let sentModel: string | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentModel = JSON.parse(String(init.body)).model;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"prompts":[{"title":"T","message":"M"}]}',
              },
            },
          ],
        })
      );
    }) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const out = await generateSuggestFollowups(REPLY, ORG, {
      model: "prov/per-agent-model",
      resolveTarget: target({ model: "per-agent-model" }),
    });
    expect(sentModel).toBe("per-agent-model");
    expect(out).toEqual([{ title: "T", message: "M" }]);
  });

  test("falls back to the org default model when the guardrail sets none", async () => {
    let sentModel: string | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentModel = JSON.parse(String(init.body)).model;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"prompts":[]}' } }],
        })
      );
    }) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    await generateSuggestFollowups(REPLY, ORG, { resolveTarget: target() });
    expect(sentModel).toBe(ORG_DEFAULT_MODEL);
  });

  test("an elapsed timeout yields [] rather than throwing", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      })) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const out = await generateSuggestFollowups(REPLY, ORG, {
      timeoutMs: 10,
      resolveTarget: target(),
    });
    expect(out).toEqual([]);
  });
});
