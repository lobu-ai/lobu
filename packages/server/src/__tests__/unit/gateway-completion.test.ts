import { afterEach, describe, expect, test } from "bun:test";
import {
  GatewayCompletionTimeoutError,
  GatewayCompletionTruncatedError,
  gatewayCompletion,
} from "../../gateway/inference/gateway-completion";

const TARGET = {
  baseUrl: "https://api.example.test/v1",
  apiKey: "sk-test",
  model: "test-model",
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** Stub `fetch`, capturing the request for assertions. */
function stubFetch(
  body: unknown,
  init: { ok?: boolean; status?: number } = {}
): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  const status = init.status ?? (init.ok === false ? 500 : 200);
  globalThis.fetch = (async (url: string, requestInit: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return { calls };
}

function completionBody(content: string) {
  return { choices: [{ message: { content } }] };
}

describe("gatewayCompletion", () => {
  test("posts an OpenAI-compatible chat/completions request", async () => {
    const { calls } = stubFetch(completionBody("hello"));

    const out = await gatewayCompletion({
      target: TARGET,
      systemPrompt: "SYS",
      userPrompt: "USER",
      timeoutMs: 5_000,
    });

    expect(out).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/v1/chat/completions");

    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent.model).toBe("test-model");
    expect(sent.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
    // These callers all parse strict JSON, so determinism is the default.
    expect(sent.temperature).toBe(0);
  });

  test.each([undefined, 0, 0.3])("posts Responses without unsupported sampling overrides (temperature %s)", async (temperature) => {
    const { calls } = stubFetch({ status: "completed", output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ] });
    const out = await gatewayCompletion({
      target: { ...TARGET, sdkCompat: "openai-responses" },
      systemPrompt: "SYS", userPrompt: "USER", timeoutMs: 5000, maxTokens: 128,
      temperature,
    });
    expect(out).toBe("hello");
    expect(calls[0]?.url).toBe("https://api.example.test/v1/responses");
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent.instructions).toBe("SYS");
    expect(sent.input).toEqual([{ role: "user", content: "USER" }]);
    expect(sent.max_output_tokens).toBe(128);
    expect(sent.store).toBe(false);
    expect(sent).not.toHaveProperty("temperature");
    expect(sent).not.toHaveProperty("messages");
    expect(sent).not.toHaveProperty("max_tokens");
  });

  test("Responses truncation rejects partial text without retrying", async () => {
    const { calls } = stubFetch({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }],
    });
    await expect(gatewayCompletion({ target: { ...TARGET, sdkCompat: "openai-responses" },
      systemPrompt: "s", userPrompt: "u", timeoutMs: 5000, maxTokens: 16,
    })).rejects.toBeInstanceOf(GatewayCompletionTruncatedError);
    expect(calls).toHaveLength(1);
  });

  test.each(["failed", "incomplete", "cancelled", "queued", "in_progress"])("Responses %s never returns partial text", async (status) => {
    const { calls } = stubFetch({ status,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }],
    });
    await expect(gatewayCompletion({ target: { ...TARGET, sdkCompat: "openai-responses" },
      systemPrompt: "s", userPrompt: "u", timeoutMs: 5000,
    })).rejects.toThrow("did not complete");
    expect(calls).toHaveLength(1);
  });

  test("Responses collects assistant text across output items and content parts", async () => {
    const { calls } = stubFetch({ status: "completed", output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [
        { type: "output_text", text: "first " },
        { type: "output_text", text: "second " },
      ] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "third" }] },
    ] });
    expect(await gatewayCompletion({
      target: { ...TARGET, sdkCompat: "openai-responses" },
      systemPrompt: "s", userPrompt: "u", timeoutMs: 5000,
    })).toBe("first second third");
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty("max_output_tokens");
  });

  test.each([
    { name: "empty output", output: [] },
    { name: "refusal", output: [
      { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Cannot comply" }] },
    ] },
  ])("Responses $name fails without retrying", async ({ output }) => {
    const { calls } = stubFetch({ status: "completed", output });
    await expect(gatewayCompletion({
      target: { ...TARGET, sdkCompat: "openai-responses" },
      systemPrompt: "s", userPrompt: "u", timeoutMs: 5000,
    })).rejects.toThrow("returned no text");
    expect(calls).toHaveLength(1);
  });

  test("sends the key as a bearer token", async () => {
    const { calls } = stubFetch(completionBody("ok"));
    await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 5_000,
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  test("an explicit temperature overrides the deterministic default", async () => {
    const { calls } = stubFetch(completionBody("ok"));
    await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      temperature: 0.3,
      timeoutMs: 5_000,
    });
    expect(JSON.parse(String(calls[0]?.init.body)).temperature).toBe(0.3);
  });

  test("throws on a non-ok response", async () => {
    stubFetch({}, { status: 401 });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/401/);
  });

  test("retries a transient 500 with backoff, then fails", async () => {
    const { calls } = stubFetch({}, { status: 500 });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/500/);
    // Initial + 2 bounded retries — no unbounded loop.
    expect(calls.length).toBe(3);
  });

  test("does NOT start a retry whose backoff cannot fit the shared timeout budget", async () => {
    const { calls } = stubFetch({}, { status: 500 });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 100,
      })
    ).rejects.toThrow(/500/);
    expect(calls.length).toBe(1);
  });

  test("retries a 429 then succeeds", async () => {
    const original = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async (url: string, requestInit: RequestInit) => {
      attempts += 1;
      if (attempts === 1) return new Response(JSON.stringify({}), { status: 429 });
      return new Response(JSON.stringify(completionBody("recovered")), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const out = await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 5_000,
    });
    expect(out).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("does NOT retry a terminal 401", async () => {
    const { calls } = stubFetch({}, { status: 401 });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/401/);
    expect(calls.length).toBe(1);
  });

  test("does NOT retry 'returned no text' (terminal empty result)", async () => {
    const { calls } = stubFetch({ choices: [{ message: { content: null } }] });
    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/no text/);
    expect(calls.length).toBe(1);
  });

  test("an elapsed timeout aborts the request", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        calls += 1;
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError"))
        );
      })) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 10,
      })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

/**
 * Options added for the fail-closed judge transport. The judge needs a bounded
 * reply, no retries (the circuit breaker is its retry policy), and a timeout it
 * can tell apart from an upstream fault when deciding what to alert on.
 */
describe("gatewayCompletion — fail-closed caller options", () => {
  test("omits max_tokens by default so existing callers are unchanged", async () => {
    const { calls } = stubFetch(completionBody("ok"));

    await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 5_000,
    });

    const sent = JSON.parse(String(calls[0]?.init.body));
    expect("max_tokens" in sent).toBe(false);
  });

  test("sends max_tokens when the caller sets a ceiling", async () => {
    const { calls } = stubFetch(completionBody("ok"));

    await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 5_000,
      maxTokens: 256,
    });

    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent.max_tokens).toBe(256);
  });

  test("maxRetries: 0 makes exactly one upstream attempt on a retryable 500", async () => {
    // Without the option this retries twice, so a naive judge migration would
    // triple the upstream load and delay every fail-closed deny.
    const { calls } = stubFetch({}, { status: 500 });

    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 5_000,
        maxRetries: 0,
      })
    ).rejects.toThrow();

    expect(calls).toHaveLength(1);
  });

  test("default retry budget is still 2 attempts after the first", async () => {
    const { calls } = stubFetch({}, { status: 500 });

    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 30_000,
      })
    ).rejects.toThrow();

    expect(calls).toHaveLength(3);
  });

  test("a blown deadline throws GatewayCompletionTimeoutError, not a generic error", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError"))
        );
      })) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const err = await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 10,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayCompletionTimeoutError);
    expect((err as GatewayCompletionTimeoutError).timeoutMs).toBe(10);
  });
});

describe("gatewayCompletion — truncated replies", () => {
  /**
   * A reasoning model's hidden thinking tokens are charged against
   * `max_tokens` while being EXCLUDED from `completion_tokens`, so a ceiling
   * that looks generous next to the visible reply can still cut the answer
   * off. Measured against gemini-2.5-flash with the judge's production
   * prompts: `max_tokens: 256` produced `finish_reason: "length"` with
   * `completion_tokens: 40` but 252 tokens actually generated.
   *
   * Returning that truncated body is the dangerous part: the judge's parser
   * reports it as "no JSON object", which is indistinguishable from a model
   * that ignored its instructions. A ceiling the operator can raise then looks
   * like a model that has to be replaced, and the fail-closed deny gets blamed
   * on the wrong cause.
   */
  test("throws rather than returning a body cut off by the token ceiling", async () => {
    stubFetch({
      choices: [
        {
          message: { content: '```json\n{\n  "verdict": "' },
          finish_reason: "length",
        },
      ],
    });

    await expect(
      gatewayCompletion({
        target: TARGET,
        systemPrompt: "s",
        userPrompt: "u",
        timeoutMs: 1000,
        maxTokens: 256,
        maxRetries: 0,
      })
    ).rejects.toThrow(GatewayCompletionTruncatedError);
  });

  test("the error names the ceiling so an operator can act on it", async () => {
    stubFetch({
      choices: [{ message: { content: "partial" }, finish_reason: "length" }],
    });

    const err = await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 1000,
      maxTokens: 256,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(GatewayCompletionTruncatedError);
    expect(err.maxTokens).toBe(256);
  });

  /**
   * Retrying cannot help: the same ceiling truncates the same way, and for a
   * fail-closed caller each attempt burns the shared deadline before the deny
   * it was always going to produce.
   */
  test("does NOT retry a truncation — the ceiling will not change", async () => {
    const { calls } = stubFetch({
      choices: [{ message: { content: "partial" }, finish_reason: "length" }],
    });

    await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 5000,
      maxTokens: 256,
    }).catch(() => {});

    expect(calls.length).toBe(1);
  });

  test("a normal `stop` finish is unaffected", async () => {
    stubFetch({
      choices: [{ message: { content: "complete" }, finish_reason: "stop" }],
    });

    const out = await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 1000,
    });

    expect(out).toBe("complete");
  });

  /**
   * Not every provider returns `finish_reason`. Absence must not be read as
   * truncation, or a conforming provider that simply omits the field would
   * have every reply rejected.
   */
  test("a missing finish_reason is not treated as truncation", async () => {
    stubFetch(completionBody("no finish reason here"));

    const out = await gatewayCompletion({
      target: TARGET,
      systemPrompt: "s",
      userPrompt: "u",
      timeoutMs: 1000,
    });

    expect(out).toBe("no finish reason here");
  });
});
