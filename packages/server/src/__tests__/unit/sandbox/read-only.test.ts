import { describe, expect, it } from "bun:test";
import type { ToolAccessLevel } from "../../../auth/tool-access";
import {
  buildClientSDK,
  enumerateSDKManifest,
} from "../../../sandbox/client-sdk";
import { METHOD_METADATA } from "../../../sandbox/method-metadata";
import { sdkMethodVisible } from "../../../sandbox/sdk-method-access";
import { baseCtx, expectReturnValue, runOrSkip, stubSDK } from "./_helpers";

const stubEntitiesList = stubSDK({
  entities: { list: async () => [] } as never,
});

describe("enumerateSDKManifest", () => {
  it("read mode mirrors METHOD_METADATA access classification", () => {
    const callerMax: ToolAccessLevel = "admin";
    const read = enumerateSDKManifest("read", { maxAccessLevel: callerMax });
    const full = enumerateSDKManifest("full", { maxAccessLevel: callerMax });
    for (const [path, meta] of Object.entries(METHOD_METADATA)) {
      const dot = path.indexOf(".");
      if (dot === -1) continue;
      const ns = path.slice(0, dot);
      const method = path.slice(dot + 1);
      const inFull = full.byNamespace[ns]?.includes(method) ?? false;
      expect(inFull).toBe(sdkMethodVisible(meta.access, callerMax, "full"));
      const inRead = read.byNamespace[ns]?.includes(method) ?? false;
      expect(inRead).toBe(sdkMethodVisible(meta.access, callerMax, "read"));
    }
  });

  it("includes `org` in topLevel iff allowCrossOrg !== false", () => {
    expect(enumerateSDKManifest("read").topLevel).toContain("org");
    expect(
      enumerateSDKManifest("read", { allowCrossOrg: false }).topLevel,
    ).not.toContain("org");
  });
});

describe("buildClientSDK filter", () => {
  it("read mode strips mutators; full mode keeps them", () => {
    const env = {} as never;
    const read = buildClientSDK(baseCtx, env, { mode: "read" });
    const full = buildClientSDK(baseCtx, env, { mode: "full" });
    const r = read.entities as Record<string, unknown>;
    const f = full.entities as Record<string, unknown>;
    expect(typeof r.list).toBe("function");
    expect(r.delete).toBeUndefined();
    expect(r.create).toBeUndefined();
    expect(typeof f.delete).toBe("function");
    expect(typeof f.create).toBe("function");
    expect((read.knowledge as Record<string, unknown>).save).toBeUndefined();
  });
});

describe("guest-side proxy traps", () => {
  it("hidden methods report `in` false; unknown methods read as undefined", async () => {
    const result = await runOrSkip({
      source: [
        "export default async (_ctx, client) => ({",
        '  hasDelete: "delete" in client.entities,',
        "  typeofUnknown: typeof client.entities.noSuchMethod,",
        "  typeofList: typeof client.entities.list,",
        "});",
      ].join("\n"),
      sdk: stubEntitiesList,
      sdkMode: "read",
    });
    expectReturnValue(result, {
      hasDelete: false,
      typeofUnknown: "undefined",
      typeofList: "function",
    });
  });

  it("ownKeys returns no duplicates", async () => {
    const result = await runOrSkip({
      source:
        "export default async (_ctx, client) => { const k = Reflect.ownKeys(client); return { dupes: k.length !== new Set(k).size }; };",
      sdk: stubEntitiesList,
      sdkMode: "read",
    });
    expectReturnValue(result, { dupes: false });
  });

  it("client.org is undefined when allowCrossOrg is false", async () => {
    const result = await runOrSkip({
      source:
        'export default async (_ctx, client) => ({ typeofOrg: typeof client.org, hasOrg: "org" in client });',
      sdk: stubEntitiesList,
      sdkMode: "read",
      allowCrossOrg: false,
    });
    expectReturnValue(result, { typeofOrg: "undefined", hasOrg: false });
  });

  it("present read methods dispatch to the host", async () => {
    const sdk = stubSDK({
      entities: { list: async () => [{ id: 1, name: "Acme" }] } as never,
    });
    const result = await runOrSkip({
      source:
        "export default async (_ctx, client) => client.entities.list({ entity_type: 'company' });",
      sdk,
      sdkMode: "read",
    });
    expectReturnValue(result, [{ id: 1, name: "Acme" }]);
  });

  it("calling a hidden write method names run_sdk", async () => {
    const result = await runOrSkip({
      source:
        "export default async (_ctx, client) => client.entities.delete({ entity_id: 42 });",
      sdk: stubEntitiesList,
      sdkMode: "read",
    });
    if (!result) return;
    expect(result.success).toBe(false);
    expect(result.error?.message ?? "").toMatch(/^MethodNotAvailable: .*run_sdk/);
  });

  it("dry-run skips write methods and returns a side-effect preview", async () => {
    let created = false;
    const sdk = stubSDK({
      entities: {
        list: async () => [{ id: 1, name: "Acme" }],
        create: async () => {
          created = true;
          return { id: 2 };
        },
      } as never,
    });
    const result = await runOrSkip({
      source: `
        export default async (_ctx, client) => {
          const before = await client.entities.list({ entity_type: 'company' });
          const create = await client.entities.create({
            type: 'company',
            name: 'Dry Run Co',
            metadata: {
              api_key: 'secret-value',
              access_token: 'access-secret',
              client_secret: 'client-secret',
              cookie: 'session-cookie',
              public_note: 'safe',
            },
          });
          return { before, create };
        };
      `,
      sdk,
      sdkMode: "full",
      dryRun: true,
    });
    if (!result) return;
    expect(result.success).toBe(true);
    expect(created).toBe(false);
    expect(result.returnValue).toEqual({
      before: [{ id: 1, name: "Acme" }],
      create: { dry_run: true, skipped_call: "entities.create", access: "write" },
    });
    expect(result.sideEffectPreview).toEqual([
      {
        path: "entities.create",
        orgPath: [],
        access: "write",
        args: [
          {
            type: "company",
            name: "Dry Run Co",
            metadata: {
              api_key: "[redacted]",
              access_token: "[redacted]",
              client_secret: "[redacted]",
              cookie: "[redacted]",
              public_note: "safe",
            },
          },
        ],
        skipped: true,
        required_access: "write",
        authorization_status: "not_evaluated",
      },
    ]);
  });

  it("__sdk_dispatch rejects inherited Object.prototype paths", async () => {
    // Bypassing the proxy via the global dispatch should still fail because
    // the host requires an own-property entry for both ns and method.
    const result = await runOrSkip({
      source: `
        export default async () => {
          try {
            await __sdk_dispatch.apply(undefined, ['entities.constructor', JSON.stringify({ args: [], orgPath: [] })], { result: { promise: true, copy: true } });
            return 'ESCAPED';
          } catch (e) {
            return String(e.message ?? e);
          }
        };
      `,
      sdk: stubEntitiesList,
      sdkMode: "read",
    });
    if (!result) return;
    expect(result.success).toBe(true);
    expect(result.returnValue).not.toBe("ESCAPED");
    expect(String(result.returnValue)).toMatch(/Unknown SDK method/);
  });
});
