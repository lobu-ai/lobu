import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs/promises";
import {
  addContext,
  DEFAULT_CONTEXT_NAME,
  findContextByMemoryUrl,
  findContextByOrigin,
  findContextByUrl,
  getActiveOrg,
  getMemoryUrl,
  getServerConfig,
  loadContextConfig,
  removeContext,
  setActiveOrg,
  toolApiOriginForMcpUrl,
} from "../context";

describe("context management", () => {
  let readFileSpy: ReturnType<typeof spyOn<typeof fs, "readFile">>;
  let writeFileSpy: ReturnType<typeof spyOn<typeof fs, "writeFile">>;

  beforeEach(() => {
    delete process.env.LOBU_CONTEXT;
    delete process.env.LOBU_ORG;
    delete process.env.LOBU_API_URL;
    delete process.env.LOBU_MEMORY_URL;

    readFileSpy = spyOn(fs, "readFile");
    writeFileSpy = spyOn(fs, "writeFile").mockResolvedValue(undefined);
    spyOn(fs, "mkdir").mockResolvedValue(undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  test("loadContextConfig handles missing file", async () => {
    readFileSpy.mockRejectedValue(new Error("File not found"));

    const config = await loadContextConfig();

    expect(config.currentContext).toBe(DEFAULT_CONTEXT_NAME);
    expect(config.contexts[DEFAULT_CONTEXT_NAME]).toBeDefined();
  });

  test("stores and reads the active org per context", async () => {
    const configData = {
      currentContext: "prod",
      contexts: {
        lobu: {
          url: "https://app.lobu.ai/api/v1",
          activeOrg: "default-org",
        },
        prod: { url: "https://prod.lobu.ai/api/v1", activeOrg: "prod-org" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getActiveOrg("lobu")).toBe("default-org");
    expect(await getActiveOrg("prod")).toBe("prod-org");
    expect(await getActiveOrg()).toBe("prod-org");

    await setActiveOrg("new-org", "lobu");
    const [, written] = writeFileSpy.mock.calls[0]!;
    const saved = JSON.parse(written as string) as typeof configData;
    expect(saved.contexts.lobu.activeOrg).toBe("new-org");
    expect(saved.contexts.prod.activeOrg).toBe("prod-org");
  });

  test("finds contexts by normalized URL", async () => {
    const configData = {
      currentContext: "lobu",
      contexts: {
        lobu: { url: "https://app.lobu.ai/api/v1" },
        custom: { url: "https://custom.lobu.ai/api/v1" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    const matched = await findContextByUrl("https://custom.lobu.ai/api/v1/");
    expect(matched?.name).toBe("custom");
    expect(matched?.url).toBe("https://custom.lobu.ai/api/v1");

    const none = await findContextByUrl("https://unknown.ai");
    expect(none).toBeUndefined();
  });

  test("finds a context by gateway origin across SDK path spellings", async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        currentContext: "lobu",
        contexts: {
          lobu: { url: "https://app.lobu.ai/api/v1" },
          buremba: { url: "https://buremba.lobu.ai/api/v1" },
        },
      })
    );

    expect((await findContextByOrigin("https://buremba.lobu.ai"))?.name).toBe(
      "buremba"
    );
    expect(
      await findContextByOrigin("https://different.lobu.ai/api/v1")
    ).toBeUndefined();
  });

  test("prefers the current context over the built-in one on the same origin", async () => {
    // The built-in "lobu" context is always materialized at the hosted origin.
    // Matching it ahead of the user's own context for that installation would
    // read credentials from a slot they never logged into.
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        currentContext: "prod",
        contexts: {
          prod: { url: "https://app.lobu.ai/api/v1" },
        },
      })
    );

    expect((await findContextByOrigin("https://app.lobu.ai"))?.name).toBe(
      "prod"
    );
  });

  test("prefers a user-named matching context when current points elsewhere", async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        currentContext: "local",
        contexts: {
          local: { url: "http://127.0.0.1:8787" },
          prod: { url: "https://app.lobu.ai/api/v1" },
        },
      })
    );

    expect((await findContextByOrigin("https://app.lobu.ai"))?.name).toBe(
      "prod"
    );
  });

  test("reads legacy apiUrl contexts and saves the new url shape", async () => {
    const configData = {
      currentContext: "legacy",
      contexts: {
        legacy: {
          apiUrl: "http://localhost:8788/api/v1",
          server: {
            cwd: "/Users/me/Code/lobu/.claude/worktrees/legacy",
            lifecycle: "managed",
          },
        },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getServerConfig("legacy")).toEqual({
      lifecycle: "managed",
      cwd: "/Users/me/Code/lobu/.claude/worktrees/legacy",
      host: "localhost",
      port: 8788,
    });

    await setActiveOrg("new-org", "legacy");
    const [, written] = writeFileSpy.mock.calls.at(-1)!;
    const saved = JSON.parse(written as string);
    expect(saved.contexts.legacy).toEqual({
      url: "http://localhost:8788/api/v1",
      lifecycle: "managed",
      cwd: "/Users/me/Code/lobu/.claude/worktrees/legacy",
      activeOrg: "new-org",
    });
  });

  test("finds contexts by normalized memory URL", async () => {
    const configData = {
      currentContext: "lobu",
      contexts: {
        lobu: { url: "https://app.lobu.ai/api/v1" },
        local: {
          url: "http://localhost:8787/api/v1",
          memoryUrl: "http://localhost:8787/mcp/acme",
        },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    const matched = await findContextByMemoryUrl("http://localhost:8787/mcp");

    expect(matched?.name).toBe("local");
  });

  test("derives local memory URL from a loopback context URL", async () => {
    const configData = {
      currentContext: "local",
      contexts: {
        lobu: { url: "https://app.lobu.ai/api/v1" },
        local: { url: "http://localhost:8787/api/v1" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getMemoryUrl("local")).toBe("http://localhost:8787/mcp");
    expect(
      (await findContextByMemoryUrl("http://127.0.0.1:8787/mcp"))?.name
    ).toBeUndefined();
    expect(
      (await findContextByMemoryUrl("http://localhost:8787/mcp"))?.name
    ).toBe("local");
  });

  test("derives managed server settings from flat context fields", async () => {
    const configData = {
      currentContext: "local",
      contexts: {
        local: {
          url: "http://localhost:9000/api/v1",
          lifecycle: "managed",
          cwd: "/tmp/lobu-worktree",
        },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getServerConfig("local")).toEqual({
      lifecycle: "managed",
      cwd: "/tmp/lobu-worktree",
      port: 9000,
      host: "localhost",
    });
  });

  test("derives default ports for scheme-only managed URLs", async () => {
    const configData = {
      currentContext: "secure",
      contexts: {
        secure: { url: "https://example.com/api/v1", lifecycle: "managed" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getServerConfig("secure")).toEqual({
      lifecycle: "managed",
      port: 443,
      host: "example.com",
    });
  });

  test("derives port 80 for a scheme-only http managed URL", async () => {
    const configData = {
      currentContext: "plain",
      contexts: {
        plain: { url: "http://localhost/api/v1", lifecycle: "managed" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getServerConfig("plain")).toEqual({
      lifecycle: "managed",
      port: 80,
      host: "localhost",
    });
  });

  test("strips IPv6 brackets from the derived managed host", async () => {
    const configData = {
      currentContext: "v6",
      contexts: {
        v6: { url: "http://[::1]:8787/api/v1", lifecycle: "managed" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getServerConfig("v6")).toEqual({
      lifecycle: "managed",
      port: 8787,
      host: "::1",
    });
  });

  test("external contexts do not produce server settings", async () => {
    const configData = {
      currentContext: "prod",
      contexts: {
        prod: { url: "https://app.lobu.ai/api/v1", lifecycle: "external" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    expect(await getServerConfig("prod")).toBeUndefined();
  });

  test("addContext stores flat lifecycle config", async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ contexts: {} }));

    await addContext("verify-flow", "http://localhost:8788", {
      cwd: "/Users/me/Code/lobu/.claude/worktrees/verify-flow",
      lifecycle: "managed",
    });

    const [, written] = writeFileSpy.mock.calls.at(-1)!;
    const saved = JSON.parse(written as string);
    expect(saved.contexts["verify-flow"]).toEqual({
      url: "http://localhost:8788",
      cwd: "/Users/me/Code/lobu/.claude/worktrees/verify-flow",
      lifecycle: "managed",
    });
  });

  test("addContext preserves omitted lifecycle metadata when refreshing a context", async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        currentContext: "release",
        contexts: {
          release: { url: "https://app.lobu.ai/api/v1" },
          debug: {
            url: "http://localhost:8787",
            activeOrg: "local-install",
            memoryUrl: "http://localhost:8787/api/v1",
            lifecycle: "managed",
            cwd: "/tmp/lobu-debug",
          },
        },
      })
    );

    await addContext("debug", "http://127.0.0.1:8788");

    const [, written] = writeFileSpy.mock.calls.at(-1)!;
    const saved = JSON.parse(written as string);
    expect(saved.currentContext).toBe("release");
    expect(saved.contexts.debug).toEqual({
      url: "http://127.0.0.1:8788",
      lifecycle: "managed",
      cwd: "/tmp/lobu-debug",
    });
  });

  test("changing a managed context to external removes its managed cwd", async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        contexts: {
          local: {
            url: "http://localhost:8787",
            lifecycle: "managed",
            cwd: "/tmp/lobu-local",
          },
        },
      })
    );

    await addContext("local", "http://localhost:8787", {
      lifecycle: "external",
    });

    const [, written] = writeFileSpy.mock.calls.at(-1)!;
    const saved = JSON.parse(written as string);
    expect(saved.contexts.local).toEqual({
      url: "http://localhost:8787",
      lifecycle: "external",
    });
  });

  test("addContext rejects cwd on a non-managed context", async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ contexts: {} }));

    await expect(
      addContext("ext", "http://localhost:8788", {
        cwd: "/tmp/lobu-worktree",
        lifecycle: "external",
      })
    ).rejects.toThrow(/`cwd` can only be set on managed contexts/);
    expect(writeFileSpy.mock.calls.length).toBe(0);
  });

  test("addContext rejects cwd when lifecycle is absent", async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ contexts: {} }));

    await expect(
      addContext("plain", "http://localhost:8788", {
        cwd: "/tmp/lobu-worktree",
      })
    ).rejects.toThrow(/`cwd` can only be set on managed contexts/);
    expect(writeFileSpy.mock.calls.length).toBe(0);
  });

  test("addContext refuses to overwrite the default context", async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        contexts: {
          [DEFAULT_CONTEXT_NAME]: { url: "https://app.lobu.ai/api/v1" },
        },
      })
    );

    await expect(
      addContext(DEFAULT_CONTEXT_NAME, "http://localhost:8788")
    ).rejects.toThrow(/Cannot overwrite the default context/);
    expect(writeFileSpy.mock.calls.length).toBe(0);
  });

  test("addContext without lifecycle keeps a minimal shape", async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ contexts: {} }));

    await addContext("plain", "https://example.com/api/v1");

    const [, written] = writeFileSpy.mock.calls.at(-1)!;
    const saved = JSON.parse(written as string);
    expect(saved.contexts.plain).toEqual({
      url: "https://example.com/api/v1",
    });
  });

  test("removeContext deletes the entry and resets currentContext if needed", async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        currentContext: "verify-flow",
        contexts: {
          lobu: { url: "https://app.lobu.ai/api/v1" },
          "verify-flow": { url: "http://localhost:8788" },
        },
      })
    );

    await removeContext("verify-flow");
    const [, written] = writeFileSpy.mock.calls.at(-1)!;
    const saved = JSON.parse(written as string);
    expect(saved.contexts["verify-flow"]).toBeUndefined();
    expect(saved.currentContext).toBe(DEFAULT_CONTEXT_NAME);
  });

  test("removeContext is idempotent for missing entries", async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ contexts: {} }));

    await removeContext("never-existed");
    expect(writeFileSpy.mock.calls.length).toBe(0);
  });

  test("removeContext refuses the default context", async () => {
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        contexts: {
          [DEFAULT_CONTEXT_NAME]: { url: "https://app.lobu.ai/api/v1" },
        },
      })
    );

    await expect(removeContext(DEFAULT_CONTEXT_NAME)).rejects.toThrow(
      /Cannot remove the default context/
    );
  });

  test("drops malformed stored URLs during normalization", async () => {
    const configData = {
      currentContext: "lobu",
      contexts: {
        lobu: { url: "https://app.lobu.ai/api/v1" },
        broken: { url: "localhost:4111" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    const config = await loadContextConfig();
    expect(config.contexts.broken).toBeUndefined();
    expect(config.contexts.lobu).toBeDefined();
  });

  test("a malformed currentContext URL falls back to the default", async () => {
    const configData = {
      currentContext: "broken",
      contexts: {
        broken: { url: "localhost:4111" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    const config = await loadContextConfig();
    // The malformed entry is dropped, so currentContext can't point at it.
    expect(config.contexts.broken).toBeUndefined();
    expect(config.currentContext).toBe(DEFAULT_CONTEXT_NAME);
  });

  test("drops invalid lifecycle fields during normalization", async () => {
    const configData = {
      currentContext: "local",
      contexts: {
        local: {
          url: "http://localhost:8787/api/v1",
          lifecycle: "maybe",
          cwd: "   ",
        },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(configData));

    const config = await loadContextConfig();
    expect(config.contexts.local).toEqual({
      url: "http://localhost:8787/api/v1",
    });
  });

  test("tool API origin: the hosted MCP edge maps to the hosted gateway", () => {
    expect(toolApiOriginForMcpUrl("https://lobu.ai/mcp")).toBe(
      "https://app.lobu.ai"
    );
    expect(toolApiOriginForMcpUrl("https://lobu.ai/mcp/acme")).toBe(
      "https://app.lobu.ai"
    );
    expect(toolApiOriginForMcpUrl("https://app.lobu.ai/mcp/acme")).toBe(
      "https://app.lobu.ai"
    );
    expect(toolApiOriginForMcpUrl("http://localhost:8787/mcp")).toBe(
      "http://localhost:8787"
    );
    expect(
      toolApiOriginForMcpUrl("https://gateway.test/lobu/mcp/lobu-memory")
    ).toBe("https://gateway.test");
  });
});
