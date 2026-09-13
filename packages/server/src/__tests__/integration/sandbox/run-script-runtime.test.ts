/**
 * Sandbox runtime integration test.
 *
 * Asserts that the host runtime can actually load `isolated-vm` and run a
 * script end-to-end. Lives under integration/ and is invoked by the
 * `test:sandbox-runtime` package script — which CI runs under Node, the
 * production runtime.
 *
 * Background: `isolated-vm` is a V8 native addon. Bun (which uses
 * JavaScriptCore with a partial V8 ABI shim) cannot load it; the addon
 * throws at dlopen. The previous bun:test version of this suite hid that
 * gap by skipping when the runner reported `RuntimeUnavailable`. The
 * production app image silently regressed for months as a result.
 *
 * This file deliberately fails (not skips) when the runtime can't load
 * `isolated-vm` so the regression cannot ship again.
 */

import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import type { ClientSDK } from "../../../sandbox/client-sdk";
import { METHOD_METADATA } from "../../../sandbox/method-metadata";
import { ClientSdkActionError } from "../../../sandbox/namespaces/action-call";
import {
  MAX_SCRIPT_ERROR_MESSAGE_BYTES,
  MAX_SCRIPT_ERROR_STACK_BYTES,
  runScript,
} from "../../../sandbox/run-script";
import { createValidatedSdkMethod } from "../../../sandbox/sdk-preflight";
import { withValidatedArgs } from "../../../tools/validate-args";
import { ToolUserError } from "../../../utils/errors";

const StubArgsSchema = Type.Object({ args: Type.Array(Type.Unknown()) });

function createTestSdkMethod(
  path: string,
  method: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<unknown> {
  const handler = withValidatedArgs(
    `test.${path}`,
    StubArgsSchema,
    async ({ args }) => method(...args),
  );
  return createValidatedSdkMethod(handler, [], {
    path,
    prepareArgs: (...args) => ({ args }),
    projectArgs: (validated) =>
      (validated as { args: unknown[] }).args,
  });
}

// Counts compiles so the memo is asserted by call count rather than by
// wall-clock timing, which is unassertable at the ~3ms scale a warm run costs.
// The spy delegates to the real compiler, so every test in this file still
// exercises genuine esbuild + isolated-vm.
vi.mock("../../../utils/compiler-core", async (importActual) => {
  const actual =
    await importActual<typeof import("../../../utils/compiler-core")>();
  return { ...actual, compileSource: vi.fn(actual.compileSource) };
});

async function compileCallCount(): Promise<number> {
  const { compileSource } = await import("../../../utils/compiler-core");
  return vi.mocked(compileSource).mock.calls.length;
}

describe("sandbox runtime", () => {
  it("loads isolated-vm and runs a trivial script", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const result = await runScript({
      source: "export default async () => 1 + 2;",
      sdk: stubSdk,
    });
    if (result.error?.name === "RuntimeUnavailable") {
      throw new Error(
        "isolated-vm failed to load under the test runtime. " +
          "Production runs the backend under Node; this test must too. " +
          `Detail: ${result.error.message}`,
      );
    }
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(3);
    expect(result.sdkCalls).toBe(0);
  });

  it("distinguishes a missing return from an explicit null", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const [missing, explicitNull] = await Promise.all([
      runScript({ source: "export default async () => {};", sdk: stubSdk }),
      runScript({ source: "export default async () => null;", sdk: stubSdk }),
    ]);

    expect(missing).toMatchObject({
      success: true,
      returnValue: null,
      didReturnValue: false,
    });
    expect(explicitNull).toMatchObject({
      success: true,
      returnValue: null,
      didReturnValue: true,
    });
  });

  it("returns structured result shape", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const result = await runScript({
      source: "export default async () => 42;",
      sdk: stubSdk,
    });
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("logs");
    expect(result).toHaveProperty("durationMs");
    expect(result).toHaveProperty("sdkCalls");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("bounds thrown messages and stacks before returning them", async () => {
    const result = await runScript({
      source: `export default async () => {
        const error = new Error("💥".repeat(100_000));
        error.stack = "stack:" + "x".repeat(100_000);
        throw error;
      };`,
      sdk: stubSDK(),
      sdkMode: "read",
    });

    expect(result.success).toBe(false);
    expect(Buffer.byteLength(result.error?.message ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_SCRIPT_ERROR_MESSAGE_BYTES,
    );
    expect(result.error?.message).toMatch(/… \[truncated\]$/);
    expect(Buffer.byteLength(result.error?.stack ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_SCRIPT_ERROR_STACK_BYTES,
    );
    expect(result.error?.stack).toMatch(/… \[truncated\]$/);
  });

  it("classifies a missing default export as a validation error", async () => {
    const result = await runScript({
      source: "const value = 1;",
      sdk: stubSDK(),
      sdkMode: "read",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      name: "ValidationError",
      message: "Script must `export default` an async function",
    });
  });

  it("normalizes non-string thrown fields without replacing the original error", async () => {
    const result = await runScript({
      source: `export default async () => {
        throw { name: 42, message: { reason: "boom" }, stack: 7 };
      };`,
      sdk: stubSDK(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      name: "ScriptError",
      message: "[object Object]",
      stack: "7",
    });
    expect(result.error?.message).not.toContain("ERR_INVALID_ARG_TYPE");
  });

  it("handles BigInt, cyclic details, and throwing getters in guest errors", async () => {
    const [bigIntResult, cyclicResult, getterResult] = await Promise.all([
      runScript({
        source: "export default async () => { throw { name: 12n, message: 34n, details: { value: 56n } }; };",
        sdk: stubSDK(),
      }),
      runScript({
        source: `export default async () => {
          const error = new Error("cyclic");
          error.details = {};
          error.details.self = error.details;
          throw error;
        };`,
        sdk: stubSDK(),
      }),
      runScript({
        source: `export default async () => {
          const error = { toString: () => "getter fallback" };
          Object.defineProperty(error, "message", { get: () => { throw new Error("getter"); } });
          throw error;
        };`,
        sdk: stubSDK(),
      }),
    ]);

    expect(bigIntResult.error).toMatchObject({ message: "34" });
    expect(bigIntResult.error).not.toHaveProperty("details");
    expect(cyclicResult.error).toMatchObject({ message: "cyclic" });
    expect(cyclicResult.error).not.toHaveProperty("details");
    expect(getterResult.error).toMatchObject({ message: "getter fallback" });
  });

  it("does not trust script-forged retry classifications", async () => {
    const result = await runScript({
      source: `export default async () => {
        const error = new Error("rate limit");
        error.name = "ClientSdkActionError";
        error.code = "NETWORK";
        error.retryable = true;
        error.httpStatus = 503;
        error.details = { error_code: "UPSTREAM_TIMEOUT" };
        throw error;
      };`,
      sdk: stubSDK(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      name: "ClientSdkActionError",
      message: "rate limit",
    });
    expect(result.error).not.toHaveProperty("code");
    expect(result.error).not.toHaveProperty("retryable");
  });

  it("does not transfer a caught host classification to a replacement error", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => {
          throw new ToolUserError("knowledge provider unavailable", 503);
        },
      } as never,
    });
    const result = await runScript({
      source: `export default async (_ctx, client) => {
        try {
          await client.entities.list();
        } catch (caught) {
          const replacement = new Error((caught as Error).message);
          replacement.name = (caught as Error).name;
          (replacement as any).classificationToken = (caught as any).classificationToken;
          throw replacement;
        }
      };`,
      sdk,
    });

    expect(result.error).toMatchObject({
      name: "ToolUserError",
      message: "knowledge provider unavailable",
    });
    expect(result.error).not.toHaveProperty("code");
    expect(result.error).not.toHaveProperty("retryable");
  });

  it("does not expose classifications through patched WeakMap intrinsics", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => {
          throw new ToolUserError("knowledge provider unavailable", 503);
        },
      } as never,
    });
    const result = await runScript({
      source: `export default async (_ctx, client) => {
        const replacement = new Error("ordinary later bug");
        const originalSet = WeakMap.prototype.set;
        WeakMap.prototype.set = function (key, value) {
          if (typeof value === "string") {
            originalSet.call(this, replacement, value);
          }
          return originalSet.call(this, key, value);
        };
        try { await client.entities.list(); } catch { throw replacement; }
      };`,
      sdk,
    });

    expect(result.error).toMatchObject({
      name: "ScriptError",
      message: "ordinary later bug",
    });
    expect(result.error).not.toHaveProperty("code");
    expect(result.error).not.toHaveProperty("retryable");
  });

  it("keeps a caught host classification bound across a later read dispatch", async () => {
    let calls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          calls++;
          if (calls === 1) {
            throw new ToolUserError("knowledge provider unavailable", 503);
          }
          return [];
        },
      } as never,
    });
    const result = await runScript({
      source: `export default async (_ctx, client) => {
        let caught;
        try { await client.entities.list(); } catch (error) { caught = error; }
        await client.entities.list();
        throw caught;
      };`,
      sdk,
    });

    expect(result.error).toMatchObject({
      name: "ToolUserError",
      message: "knowledge provider unavailable",
      code: "UPSTREAM_5XX",
      retryable: true,
    });
  });

  it("keeps concurrent same-message failures bound to their own error object", async () => {
    let calls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          calls++;
          if (calls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            throw new ToolUserError("same failure", 503);
          }
          throw new ToolUserError("same failure", 400);
        },
      } as never,
    });
    const result = await runScript({
      source: `export default async (ctx, client) => {
        const delayed = client.entities.list().catch((error) => error);
        await ctx.sleep(5);
        const immediate = await client.entities.list().catch((error) => error);
        await delayed;
        throw immediate;
      };`,
      sdk,
    });

    expect(result.error).toMatchObject({
      name: "ValidationError",
      message: "same failure",
      code: "VALIDATION",
      retryable: false,
    });
  });

  it("preserves a structured transient ToolUserError classification", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => {
          throw new ToolUserError("knowledge provider unavailable", 503);
        },
      } as never,
    });
    const result = await runScript({
      source:
        "export default async (_ctx, client) => client.entities.list();",
      sdk,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      name: "ToolUserError",
      code: "UPSTREAM_5XX",
      retryable: true,
    });
  });

  it("maps a local 403 ToolUserError to permission, not invalid credentials", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => {
          throw new ToolUserError("workspace access denied", 403);
        },
      } as never,
    });
    const result = await runScript({
      source: "export default async (_ctx, client) => client.entities.list();",
      sdk,
    });

    expect(result.error).toMatchObject({
      name: "ToolUserError",
      code: "PERMISSION",
      retryable: false,
    });
  });

  it("preserves ClientSdkActionError result codes across the isolate", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => {
          throw new ClientSdkActionError("list", "connector failed", {
            error_code: "NETWORK",
            retryable: true,
          });
        },
      } as never,
    });
    const result = await runScript({
      source:
        "export default async (_ctx, client) => client.entities.list();",
      sdk,
    });

    expect(result.error).toMatchObject({
      name: "ClientSdkActionError",
      code: "NETWORK",
      retryable: true,
      details: { error_code: "NETWORK", retryable: true },
    });
  });

  it("rejects inherited object keys as ClientSdkActionError codes", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => {
          throw new ClientSdkActionError("list", "connector failed", {
            error_code: "constructor",
          });
        },
      } as never,
    });
    const result = await runScript({
      source: "export default async (_ctx, client) => client.entities.list();",
      sdk,
    });

    expect(result.error).toMatchObject({
      name: "ClientSdkActionError",
      code: "INTERNAL",
      retryable: false,
    });
  });

  it("classifies legacy ClientSdkActionError error_message values", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => {
          throw new ClientSdkActionError("list", "connector failed", {
            status: "failed",
            error_message: "fetch failed: ENOTFOUND",
          });
        },
      } as never,
    });
    const result = await runScript({
      source: "export default async (_ctx, client) => client.entities.list();",
      sdk,
    });

    expect(result.error).toMatchObject({
      name: "ClientSdkActionError",
      code: "NETWORK",
      retryable: true,
    });
  });

  it("classifies an operation timeout result independently of its synthetic 400", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => {
          throw new ClientSdkActionError("list", "operation timed out", {
            status: "timeout",
          });
        },
      } as never,
    });
    const result = await runScript({
      source: "export default async (_ctx, client) => client.entities.list();",
      sdk,
    });

    expect(result.error).toMatchObject({
      name: "ClientSdkActionError",
      code: "UPSTREAM_TIMEOUT",
      retryable: true,
    });
  });

  it("exposes bounded ctx.sleep without exposing unrestricted timers", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const started = Date.now();
    const result = await runScript({
      source:
        "export default async (ctx) => { await ctx.sleep(15); return { timer: typeof setTimeout, hostBridge: typeof __sdk_dispatch }; };",
      sdk: stubSdk,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({
      timer: "undefined",
      hostBridge: "undefined",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });

  it("rejects a sleep longer than the per-call limit", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const result = await runScript({
      source: "export default async (ctx) => ctx.sleep(30001);",
      sdk: stubSdk,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("SleepLimitExceeded");
    expect(result.error?.message).toContain("30000ms");
  });

  it("aborts ctx.sleep at the overall script deadline", async () => {
    const stubSdk = { log: () => undefined } as unknown as ClientSDK;
    const started = Date.now();
    const result = await runScript({
      source: "export default async (ctx) => { await ctx.sleep(200); return 'late'; };",
      sdk: stubSdk,
      limits: { timeoutMs: 25 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("TimeoutError");
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("supports direct client.org(slug).namespace.method() chaining", async () => {
    const orgSdk = {
      entities: {
        get: async () => ({ org: "atlas", id: 123 }),
      },
      org: async () => {
        throw new Error("nested org not expected");
      },
      query: async () => [],
      log: () => undefined,
    } as unknown as ClientSDK;
    const stubSdk = {
      org: async (slug: string) => {
        expect(slug).toBe("atlas");
        return orgSdk;
      },
      query: async () => [],
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        'export default async (_ctx, client) => client.org("atlas").entities.get({ entity_id: 123 });',
      sdk: stubSdk,
      allowCrossOrg: true,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ org: "atlas", id: 123 });
    expect(result.sdkCalls).toBe(1);
  });

  it("dispatches client.notifications.send from a reaction script", async () => {
    // Guards the gap fix: before `notifications.send` was added to the SDK +
    // method-metadata, the sandbox proxy wouldn't advertise it and a reaction
    // calling it threw. This proves a reaction can now push a notification.
    let captured: unknown;
    const stubSdk = {
      notifications: {
        send: async (input: unknown) => {
          captured = input;
          return {
            notified_count: 1,
            event_id: 41,
            url: "/atlas/activity?event=41",
            run_id: 42,
          };
        },
      },
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        "export default async (ctx, client) => client.notifications.send({ title: 'Choose a plan', input_schema: { type: 'object', properties: { plan: { enum: ['legacy', 'new'] } }, required: ['plan'] }, automation_source: { automation_id: 7, run_id: 9 } });",
      sdk: stubSdk,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({
      notified_count: 1,
      event_id: 41,
      url: "/atlas/activity?event=41",
      run_id: 42,
    });
    expect(result.sdkCalls).toBe(1);
    expect(captured).toEqual({
      title: "Choose a plan",
      input_schema: {
        type: "object",
        properties: { plan: { enum: ["legacy", "new"] } },
        required: ["plan"],
      },
      automation_source: { automation_id: 7, run_id: 9 },
    });
  });

  it("read mode: notification mutations are absent while list is callable", async () => {
    const stubSdk = {
      notifications: {
        list: async () => ({ notifications: [], nextCursor: null }),
      },
      query: async () => [],
      log: () => undefined,
    } as unknown as ClientSDK;

    const listed = await runScript({
      source:
        "export default async (_ctx, client) => client.notifications.list({ unread_only: true });",
      sdk: stubSdk,
      sdkMode: "read",
    });
    expect(listed.success).toBe(true);
    expect(listed.returnValue).toEqual({ notifications: [], nextCursor: null });

    for (const call of [
      "client.notifications.markRead(1)",
      "client.notifications.send({ title: 'x' })",
    ]) {
      const result = await runScript({
        source: `export default async (_ctx, client) => ${call};`,
        sdk: stubSdk,
        sdkMode: "read",
      });

      expect(result.success).toBe(false);
      expect(result.error?.message ?? "").toMatch(/not a function|undefined/i);
      // The mutation must fail guest-side without dispatching to the host.
      expect(result.sdkCalls).toBe(0);
    }
  });

  it("read mode: a genuinely unknown namespace stays undefined (not a false stub)", async () => {
    const stubSdk = {
      query: async () => [],
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        "export default async (_ctx, client) => ({ t: typeof client.totallyMadeUp });",
      sdk: stubSdk,
      sdkMode: "read",
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ t: "undefined" });
  });

  it("enforces wall-clock timeout while awaiting SDK calls", async () => {
    const stubSdk = {
      entities: {
        list: async () =>
          new Promise((resolve) => setTimeout(() => resolve([]), 200)),
      },
      log: () => undefined,
    } as unknown as ClientSDK;

    const result = await runScript({
      source:
        "export default async (_ctx, client) => client.entities.list({ limit: 1 });",
      sdk: stubSdk,
      limits: { timeoutMs: 25 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("TimeoutError");
    expect(result.sdkCalls).toBe(1);
  });
});

describe("compiled-source memo", () => {
  const stub = stubSDK();

  /** Unique per run so a previous test cannot have warmed the entry. */
  const uniqueSource = (tag: string) =>
    `// ${tag}\nexport default async () => ${tag.length};`;

  it("re-running identical source skips compilation", async () => {
    const source = uniqueSource(`memo_hit_${process.pid}`);

    const before = await compileCallCount();
    const first = await runScript({ source, sdk: stub });
    const afterCold = await compileCallCount();
    const second = await runScript({ source, sdk: stub });
    const afterWarm = await compileCallCount();

    expect(first.success).toBe(true);
    expect(second.returnValue).toBe(first.returnValue);
    expect(afterCold - before).toBe(1);
    expect(afterWarm - afterCold).toBe(0);
  });

  it("different source is compiled separately, not served from the memo", async () => {
    const before = await compileCallCount();
    const a = await runScript({
      source: uniqueSource(`memo_a_${process.pid}`),
      sdk: stub,
    });
    const b = await runScript({
      source: uniqueSource(`memo_bb_${process.pid}`),
      sdk: stub,
    });

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect((await compileCallCount()) - before).toBe(2);
    // Return values are derived from the tag length, so a collision here would
    // mean one entry was served for both sources.
    expect(a.returnValue).not.toBe(b.returnValue);
  });

  it("a compile error is not cached as a success", async () => {
    const broken = `export default async () => { this is not valid ts`;
    const before = await compileCallCount();
    const first = await runScript({ source: broken, sdk: stub });
    const second = await runScript({ source: broken, sdk: stub });

    expect(first.success).toBe(false);
    expect(first.error?.name).toBe("ValidationError");
    expect(second.success).toBe(false);
    expect(second.error?.name).toBe("ValidationError");
    // A failed compile leaves no entry, so the retry recompiles.
    expect((await compileCallCount()) - before).toBe(2);
  });

  it("keeps compiler infrastructure failures internal", async () => {
    const { compileSource } = await import("../../../utils/compiler-core");
    vi.mocked(compileSource).mockRejectedValueOnce(
      Object.assign(new Error("ENOSPC"), {
        errors: [{ text: "Could not write output file", location: null }],
      }),
    );

    const result = await runScript({
      source: uniqueSource(`compile_enospc_${process.pid}`),
      sdk: stub,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      name: "CompileError",
      message: "ENOSPC",
    });
  });
});

function stubSDK(partial: Partial<ClientSDK> = {}): ClientSDK {
  for (const [namespaceName, namespace] of Object.entries(partial)) {
    if (!namespace || typeof namespace !== "object") continue;
    for (const [methodName, method] of Object.entries(namespace)) {
      const metadata = METHOD_METADATA[`${namespaceName}.${methodName}`];
      if (!metadata || metadata.access === "read" || typeof method !== "function") {
        continue;
      }
      (namespace as Record<string, unknown>)[methodName] = createTestSdkMethod(
        `${namespaceName}.${methodName}`,
        method as (...args: unknown[]) => unknown,
      );
    }
  }
  return { log: () => undefined, ...partial } as ClientSDK;
}

describe("sandbox output budgets", () => {
  it("keeps a return value whose serialized size exactly matches the cap", async () => {
    const result = await runScript({
      source: "export default async () => 'a'.repeat(1048574);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.returnValue), "utf8")).toBe(1_048_576);
    expect(result.returnValuePreview).toBeUndefined();
    expect(result.returnTruncated).toBeUndefined();
  });

  it("replaces an oversized return with a bounded preview instead of shipping it", async () => {
    const result = await runScript({
      source: "export default async () => 'a'.repeat(1200000);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBeUndefined();
    expect(typeof result.returnValuePreview).toBe("string");
    expect(result.returnValuePreview).toMatch(/^"a+\u2026 \[truncated\]$/);
    expect(result.returnTruncated).toBeDefined();
    expect(result.returnTruncated!.total_bytes).toBeGreaterThan(1_048_576);
    expect(result.returnTruncated!.kept_bytes).toBe(
      Buffer.byteLength(result.returnValuePreview!, "utf8"),
    );
  });

  it("keeps the preview within a lowered output cap", async () => {
    const result = await runScript({
      source: "export default async () => 'a'.repeat(2000);",
      sdk: stubSDK(),
      limits: { outputBytes: 1024 },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBeUndefined();
    expect(result.returnTruncated!.total_bytes).toBeGreaterThan(
      result.returnTruncated!.kept_bytes,
    );
    expect(
      Buffer.byteLength(result.returnValuePreview!, "utf8"),
    ).toBeLessThanOrEqual(1024);
  });

  it("hard-fails an oversized extracted schema instead of previewing it", async () => {
    const result = await runScript({
      source: [
        "export const input = { type: 'string', description: 'x'.repeat(2000) };",
        "export default async () => undefined;",
      ].join("\n"),
      sdk: stubSDK(),
      extractExport: "input",
      limits: { outputBytes: 1024 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(result.returnValuePreview).toBeUndefined();
  });

  it("previews an oversized array as a text head and reports byte sizes", async () => {
    const result = await runScript({
      source: [
        "export default async () => {",
        "  const rows = Array.from({ length: 50000 }, (_, i) => ({ id: i, body: 'x'.repeat(60) }));",
        "  return rows;",
        "};",
      ].join("\n"),
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBeUndefined();
    const preview = result.returnValuePreview!;
    expect(preview.startsWith("[")).toBe(true);
    expect(result.returnTruncated).toBeDefined();
    expect(result.returnTruncated!.total_bytes).toBeGreaterThan(
      result.returnTruncated!.kept_bytes,
    );
    expect(result.returnTruncated!.kept_bytes).toBe(
      Buffer.byteLength(preview, "utf8"),
    );
  });

  it("drops console logs past the log cap without failing the run", async () => {
    const result = await runScript({
      source: [
        "export default async () => {",
        "  console.log('x'.repeat(70000));",
        "  console.log('y'.repeat(70000));",
        "  return 'ok';",
        "};",
      ].join("\n"),
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("ok");
    expect(result.returnTruncated).toBeUndefined();
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]?.message).toContain("console output truncated");
  });

  it("stops forwarding console calls after the log cap fills", async () => {
    const result = await runScript({
      source: [
        "export default async () => {",
        "  const line = 'x'.repeat(1024);",
        "  for (let i = 0; i < 1000000; i++) console.log(line);",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk: stubSDK(),
      limits: { timeoutMs: 1000 },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("done");
    expect(result.logs).toHaveLength(65);
    expect(result.logs.at(-1)?.message).toContain("console output truncated");
  });

  it("terminates a guest that bypasses the saturated console latch", async () => {
    const result = await runScript({
      source: [
        "export default async () => {",
        "  const line = 'x'.repeat(1024);",
        "  for (let i = 0; i < 1000; i++) {",
        "    try { __console_call.applySync(undefined, ['log', line]); } catch (e) {}",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk: stubSDK(),
      limits: { timeoutMs: 5000 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
  });

  it("does not let a large SDK call result evict a small return value", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => ({ rows: "x".repeat(1_200_000) }),
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  const big = await client.entities.list();",
        "  return { count: big.rows.length };",
        "};",
      ].join("\n"),
      sdk,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ count: 1_200_000 });
  });

  it("hard-fails a single oversized SDK result message", async () => {
    let hostCalls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          hostCalls++;
          return { rows: "x".repeat(5_000_000) };
        },
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 6; i++) {",
        "    try { await client.entities.list(); } catch (e) {}",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
      limits: { messageBytes: 65_536 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    // Only the first result ran host work before the message cap terminated.
    expect(hostCalls).toBe(1);
  });

  it("rejects an oversized SDK request payload before host work", async () => {
    let hostCalls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          hostCalls++;
          return [];
        },
      } as never,
    });
    const result = await runScript({
      source:
        "export default async (_ctx, client) => { await client.entities.list({ q: 'x'.repeat(70000) }); return 'done'; };",
      sdk,
      limits: { messageBytes: 65_536 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(hostCalls).toBe(0);
  });

  it("hard-fails an interactive return over the message cap before parsing", async () => {
    const result = await runScript({
      source: "export default async () => 'x'.repeat(5000000);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(result.returnValuePreview).toBeUndefined();
  });

  it("does not split a UTF-16 surrogate pair at the preview boundary", async () => {
    const result = await runScript({
      source: "export default async () => '😀'.repeat(600000);",
      sdk: stubSDK(),
    });

    expect(result.success).toBe(true);
    const preview = result.returnValuePreview!;
    const suffix = "\u2026 [truncated]";
    expect(preview.endsWith(suffix)).toBe(true);
    const prefix = preview.slice(0, -suffix.length);
    expect(prefix.endsWith("😀")).toBe(true);
    for (let i = 0; i < prefix.length; i++) {
      const c = prefix.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = prefix.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
  });

  it("terminates on console output over the message cap before any SDK work", async () => {
    let hostCalls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          hostCalls++;
          return [{ ok: true }];
        },
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  console.log('x'.repeat(4200000));",
        "  try { await client.entities.list(); } catch (e) {}",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    expect(hostCalls).toBe(0);
  });

  it("makes quota exhaustion terminal (uncatchable)", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => [{ ok: true }],
      } as never,
    });
    const started = Date.now();
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 300; i++) {",
        "    try { await client.entities.list(); } catch (e) {}",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
      limits: { sdkCallQuota: 5, timeoutMs: 5000 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("QuotaExceeded");
    // Terminated on quota exhaustion, not left spinning until the timeout.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("terminates a guest that loops dispatch with oversized payloads", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => [{ ok: true }],
      } as never,
    });
    const started = Date.now();
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  while (true) {",
        "    try { await client.entities.list({ big: 'x'.repeat(70000) }); } catch (e) {}",
        "  }",
        "};",
      ].join("\n"),
      sdk,
      limits: { messageBytes: 65_536, timeoutMs: 5000 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("OutputSizeExceeded");
    // Interrupted at the first oversized payload, well under the 5s timeout.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("bounds the SDK call trace and keeps the tail", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => [{ id: 1 }],
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 50; i++) {",
        "    await client.entities.list({ big: 'x'.repeat(4000) });",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("done");
    const serialized = Buffer.byteLength(
      JSON.stringify(result.sdkCallTrace),
      "utf8",
    );
    expect(serialized).toBeLessThanOrEqual(131_072);
    expect(result.sdkCallTrace.at(-1)?.path).toBe("entities.list");
    expect(result.traceDropped).toBeGreaterThan(0);
  });

  it("stays within traceBytes even at the 200-entry boundary", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => [{ id: 1 }],
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 200; i++) {",
        "    await client.entities.list({ big: 'x'.repeat(600) });",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
    });

    expect(result.success).toBe(true);
    // Entry-byte sum alone is under the cap, but with commas/brackets the
    // serialized array would exceed it — the strict bound must still hold.
    const serialized = Buffer.byteLength(
      JSON.stringify(result.sdkCallTrace),
      "utf8",
    );
    expect(serialized).toBeLessThanOrEqual(131_072);
    expect(result.traceDropped).toBeGreaterThan(0);
  });

  it("keeps the failing call in the tail of a bounded trace", async () => {
    let calls = 0;
    const sdk = stubSDK({
      entities: {
        list: async () => {
          calls++;
          if (calls === 50) throw new Error("boom");
          return [{ id: 1 }];
        },
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 50; i++) {",
        "    await client.entities.list({ big: 'x'.repeat(4000) });",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("ScriptError");
    expect(result.error?.message).toContain("boom");
    // The 50th (failing) call is the last trace entry and survives tail-keep.
    expect(result.sdkCallTrace.at(-1)?.path).toBe("entities.list");
    expect(result.traceDropped).toBeGreaterThan(0);
  });

  it("drops and counts a single trace entry over the cap", async () => {
    const sdk = stubSDK({
      entities: {
        list: async () => [],
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  await client.entities.list({ small: 1 });",
        "  await client.entities.list({ big: 'x'.repeat(4000) });",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
      limits: { traceBytes: 1024 },
    });

    expect(result.success).toBe(true);
    // The big-arg entry alone exceeds the 1 KB cap -> dropped and counted.
    expect(result.traceDropped).toBeGreaterThan(0);
    // The small entry is retained.
    expect(result.sdkCallTrace.length).toBeGreaterThan(0);
  });

  it("reports the total skipped calls even when the preview truncates", async () => {
    const sdk = stubSDK({
      entities: {
        manage: async () => ({}),
      } as never,
    });
    const result = await runScript({
      source: [
        "export default async (_ctx, client) => {",
        "  for (let i = 0; i < 30; i++) {",
        "    await client.entities.manage({ big: 'x'.repeat(4000) });",
        "  }",
        "  return 'done';",
        "};",
      ].join("\n"),
      sdk,
      sdkMode: "full",
      dryRun: true,
      limits: { traceBytes: 4096 },
    });

    expect(result.success).toBe(true);
    // All 30 are skipped; the counter is independent of preview retention.
    expect(result.skippedCalls).toBe(30);
    // The preview is bounded and truncated.
    expect(result.sideEffectPreview.length).toBeLessThan(30);
    expect(result.traceDropped).toBeGreaterThan(0);
  });

  it("omits the truncation marker on a normal run", async () => {
    const result = await runScript({
      source:
        "export default async (_ctx, client) => { await client.entities.list(); return 'ok'; };",
      sdk: stubSDK({
        entities: { list: async () => [] } as never,
      }),
    });

    expect(result.success).toBe(true);
    expect(result.traceDropped).toBe(0);
  });
});
