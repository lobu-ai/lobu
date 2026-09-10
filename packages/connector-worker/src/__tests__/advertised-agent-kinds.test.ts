/**
 * The device advertises the agent CLIs it can actually spawn, not the list its
 * build knows about.
 *
 * The gateway withholds an Automation run whose `agent_kind` is missing from
 * `device_workers.agent_kinds`. If the client advertised the static
 * `AGENT_KINDS` table, that gate would only ever distinguish client versions —
 * every device would claim every kind and then fail locally with "binary not
 * found on PATH", which is the exact failure the gate exists to prevent.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as agentBinaries from "../daemon/agent-binaries";
import {
  resolveRunnableAgentKinds,
  supportsOpenCodeAcp,
} from "../daemon/agent-binaries";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A bin dir holding exactly the named executables. Passed to the resolver
 * explicitly: the real discovery list includes absolute prefixes like
 * /opt/homebrew/bin, so a PATH-only stub would still see the developer's own
 * CLIs and make the assertion machine-dependent.
 */
function binDirWith(names: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-bins-"));
  tempDirs.push(dir);
  for (const name of names) {
    const file = path.join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

describe("local agent binary selection", () => {
  test("prefers the configured PATH over a conflicting fallback installation", () => {
    const configured = binDirWith(["codex"]);
    const previousPath = process.env.PATH;
    const fallbackBinary = path.join(agentBinaries.searchDirs()[0], "codex");
    const configuredBinary = path.join(configured, "codex");
    const exists = spyOn(fs, "existsSync").mockImplementation((candidate) =>
      candidate === fallbackBinary || candidate === configuredBinary
    );
    process.env.PATH = configured;
    try {
      expect(agentBinaries.locateBinary("codex")).toBe(configuredBinary);
      process.env.PATH = "";
      expect(agentBinaries.locateBinary("codex")).toBe(fallbackBinary);
    } finally {
      exists.mockRestore();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

describe("resolveRunnableAgentKinds", () => {
  test("reports only kinds whose binary resolves, in canonical AGENT_KINDS order", () => {
    // `claude` → claude-code, `pi` → pi. codex/opencode/agy are absent.
    const dirs = [binDirWith(["pi", "claude"])];
    expect(resolveRunnableAgentKinds(undefined, dirs)).toEqual(["claude-code", "pi"]);
  });

  test("no local CLI at all reports an empty set, not the static table", () => {
    expect(resolveRunnableAgentKinds(undefined, [binDirWith([])])).toEqual([]);
  });

  test("a binary override counts even when the search dirs are empty", () => {
    const dir = binDirWith(["my-codex"]);
    expect(
      resolveRunnableAgentKinds({ codex: path.join(dir, "my-codex") }, [binDirWith([])])
    ).toEqual(["codex"]);
  });

  test("a dangling override does not — the device would fail to launch it", () => {
    const dir = binDirWith([]);
    expect(
      resolveRunnableAgentKinds({ codex: path.join(dir, "gone") }, [binDirWith([])])
    ).toEqual([]);
  });
});

describe("supportsOpenCodeAcp", () => {
  test("accepts an installed OpenCode binary only when its ACP entrypoint starts", () => {
    const dir = binDirWith([]);
    const supported = path.join(dir, "supported-opencode");
    writeFileSync(
      supported,
      "#!/bin/sh\n[ \"$1\" = acp ] && [ \"$2\" = --pure ] && [ \"$3\" = --help ]\n"
    );
    chmodSync(supported, 0o755);
    const unsupported = path.join(dir, "unsupported-opencode");
    writeFileSync(unsupported, "#!/bin/sh\nexit 64\n");
    chmodSync(unsupported, 0o755);

    expect(supportsOpenCodeAcp(supported)).toBe(true);
    expect(supportsOpenCodeAcp(unsupported)).toBe(false);
  });

  test("does not expose daemon credentials to the OpenCode capability probe", () => {
    const dir = binDirWith([]);
    const binary = path.join(dir, "opencode-env-probe");
    writeFileSync(
      binary,
      "#!/bin/sh\n[ -z \"$WORKER_API_TOKEN\" ] && [ -z \"$LOBU_API_TOKEN\" ] && [ -z \"$LOBU_MEMORY_URL\" ]\n"
    );
    chmodSync(binary, 0o755);
    const previous = {
      worker: process.env.WORKER_API_TOKEN,
      api: process.env.LOBU_API_TOKEN,
      memory: process.env.LOBU_MEMORY_URL,
    };
    process.env.WORKER_API_TOKEN = "device-secret";
    process.env.LOBU_API_TOKEN = "run-secret";
    process.env.LOBU_MEMORY_URL = "https://lobu.test/mcp";
    try {
      expect(supportsOpenCodeAcp(binary)).toBe(true);
    } finally {
      if (previous.worker === undefined) delete process.env.WORKER_API_TOKEN;
      else process.env.WORKER_API_TOKEN = previous.worker;
      if (previous.api === undefined) delete process.env.LOBU_API_TOKEN;
      else process.env.LOBU_API_TOKEN = previous.api;
      if (previous.memory === undefined) delete process.env.LOBU_MEMORY_URL;
      else process.env.LOBU_MEMORY_URL = previous.memory;
    }
  });
});

describe("poll body agent_kinds", () => {
  /**
   * Stub the discovery sweep, then import the client fresh so it binds the
   * stub. Returns the captured poll bodies and the discovery call count (the
   * TTL assertion needs it).
   *
   * bun's `mock.module` is process-global, so everything except the sweep is
   * re-exported from the real module — the automation-arm tests in this
   * package resolve binaries through `locateBinary` and must keep seeing the
   * real one.
   */
  async function pollWith(
    kinds: string[][],
    config: { platform?: string; agentKinds?: Array<"claude-code" | "codex" | "opencode" | "pi" | "agy"> } = {}
  ): Promise<{ bodies: Array<Record<string, unknown>>; discoveries: number }> {
    let discoveries = 0;
    mock.module("../daemon/agent-binaries", () => ({
      ...agentBinaries,
      resolveRunnableAgentKinds: () => kinds[Math.min(discoveries++, kinds.length - 1)],
    }));

    const bodies: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ next_poll_seconds: 5 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const { WorkerClient } = await import("../daemon/client");
      const client = new WorkerClient({
        apiUrl: "https://app.example.com",
        workerId: "w-kinds",
        capabilities: {},
        ...config,
      });
      await client.poll();
      await client.poll();
      return { bodies, discoveries };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test("a device worker forwards exactly what discovery returned", async () => {
    const { bodies } = await pollWith([["claude-code"]], { platform: "macos" });
    expect(bodies[0].agent_kinds).toEqual(["claude-code"]);
  });

  test("an interactive worker advertises only its matching session kind", async () => {
    const { bodies, discoveries } = await pollWith([["claude-code", "codex", "opencode"]], {
      platform: "headless",
      agentKinds: ["codex"],
    });
    expect(bodies[0].agent_kinds).toEqual(["codex"]);
    expect(discoveries).toBe(0);
  });

  test("a device with no CLIs still sends the key, so the server stores [] not NULL", async () => {
    // NULL means "never advertised" and stays unrestricted server-side; a
    // device that genuinely runs nothing has to say so explicitly.
    const { bodies } = await pollWith([[]], { platform: "macos" });
    expect(bodies[0]).toHaveProperty("agent_kinds");
    expect(bodies[0].agent_kinds).toEqual([]);
  });

  test("a fleet worker (no platform) advertises nothing — it runs no Automations", async () => {
    const { bodies } = await pollWith([["claude-code"]]);
    expect(bodies[0]).not.toHaveProperty("agent_kinds");
  });

  test("discovery runs once per TTL, not once per poll", async () => {
    // Two polls back to back are well inside the 60s window, so the second
    // must reuse the first sweep rather than re-stat the filesystem.
    const { bodies, discoveries } = await pollWith([["claude-code"], ["pi"]], {
      platform: "macos",
    });
    expect(discoveries).toBe(1);
    expect(bodies[1].agent_kinds).toEqual(["claude-code"]);
  });
});
