import { describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probePreview, startupStatus } from "../lib/preview-health.mjs";
import { previewHealthy, waitReady } from "../sandbox";

describe("sandbox frontend readiness", () => {
  test("checks a fresh transform when the cached entry survives compiler failure", async () => {
    const request = async (input: URL) => {
      const url = new URL(input);
      if (url.pathname === "/")
        return new Response(
          '<script type="module" src="/src/main.tsx"></script>'
        );
      if (url.pathname === "/src/main.tsx" && url.search)
        return new Response("Not found", { status: 404 });
      return new Response("export {};", {
        headers: { "content-type": "application/javascript" },
      });
    };
    expect(
      (await probePreview("https://preview.example.test", request)).status
    ).toBe("failed");
  });

  test("rejects an HTML shell whose Vite entry cannot transform", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/")
          return new Response(
            '<script type="module" src="/src/main.tsx"></script>',
            { headers: { "content-type": "text/html" } }
          );
        if (path === "/health/ready") return Response.json({ status: "ok" });
        return new Response("The service is no longer running", {
          status: 500,
        });
      }
    );
    try {
      // A generous budget: only an immediate "failed" verdict returns in time.
      expect(await previewHealthy("https://preview.example.test", 60_000)).toBe(
        false
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("retries a temporary Daytona transport failure", async () => {
    let attempts = 0;
    const sandbox = {
      process: {
        executeCommand: async (command: string) => {
          if (!command.includes("preview-health.mjs"))
            return { exitCode: 0, result: "" };
          if (++attempts === 1) throw new Error("temporary transport failure");
          return { exitCode: 0, result: '{"status":"ready"}' };
        },
      },
    } as unknown as Parameters<typeof waitReady>[0];
    expect(await waitReady(sandbox, 30)).toBe(true);
    expect(attempts).toBe(2);
  }, 15_000);

  test("retries a failed remote probe command without swallowing startup failures", async () => {
    let attempts = 0;
    const sandbox = {
      process: {
        executeCommand: async (command: string) => {
          if (!command.includes("preview-health.mjs"))
            return { exitCode: 0, result: "" };
          if (++attempts === 1) return { exitCode: 1, result: "" };
          return {
            exitCode: 0,
            result:
              '{"status":"failed","detail":"startup exited with code 37"}',
          };
        },
      },
    } as unknown as Parameters<typeof waitReady>[0];
    await expect(waitReady(sandbox, 30)).rejects.toThrow("37");
    expect(attempts).toBe(2);
  }, 15_000);

  test("fails immediately for a malformed probe response", async () => {
    const sandbox = {
      process: {
        executeCommand: async () => ({ exitCode: 0, result: "invalid JSON" }),
      },
    } as unknown as Parameters<typeof waitReady>[0];
    await expect(waitReady(sandbox, 30)).rejects.toBeInstanceOf(SyntaxError);
  });

  test("fails immediately after a startup process exits", async () => {
    const sandbox = {
      process: {
        executeCommand: async () => ({
          exitCode: 0,
          result: '{"status":"failed","detail":"startup exited with code 137"}',
        }),
      },
    } as unknown as Parameters<typeof waitReady>[0];
    await expect(waitReady(sandbox, 1)).rejects.toThrow("137");
  });
});

test("checks the actual HTTP frontend, including proxy HTML returned as JavaScript", async () => {
  let entryStatus = 200;
  let entryType = "application/javascript";
  let apiStatus = 200;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health/ready")
        return new Response("ok", { status: apiStatus });
      if (path === "/")
        return new Response(
          '<script type="module" src="/src/main.tsx"></script>'
        );
      return new Response("export {};", {
        status: entryStatus,
        headers: { "content-type": entryType },
      });
    },
  });
  try {
    expect(await probePreview(server.url)).toEqual({ status: "ready" });
    entryStatus = 500;
    expect((await probePreview(server.url)).status).toBe("failed");
    entryStatus = 200;
    entryType = "text/html";
    expect((await probePreview(server.url)).status).toBe("failed");
    apiStatus = 503;
    expect((await probePreview(server.url)).status).toBe("starting");
  } finally {
    await server.stop(true);
  }
});

test("launcher records a real child failure for the readiness probe", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-launch-test-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/dev-native.sh"), "#!/bin/sh\nexit 37\n", {
      mode: 0o755,
    });
    const result = Bun.spawnSync(
      ["bash", resolve(import.meta.dir, "../lib/sandbox-launch.sh"), root],
      { cwd: root, stdout: "pipe", stderr: "pipe" }
    );
    expect(result.exitCode).toBe(37);
    const read = (path: string) =>
      readFileSync(path.replace("/workspace", root), "utf8");
    expect(startupStatus(read)).toEqual({
      status: "failed",
      detail: "startup exited with code 37",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects an OOM victim even while the dev supervisor survives", () => {
  const files: Record<string, string> = {
    "/workspace/dev.pid": "123",
    "/workspace/dev.oom-kills": "2",
    "/sys/fs/cgroup/memory.events": "oom 4\noom_kill 3\n",
  };
  const read = (path: string) => {
    if (!(path in files)) throw new Error("ENOENT");
    return files[path];
  };
  expect(startupStatus(read, () => true)).toEqual({
    status: "failed",
    detail: "container OOM killed 1 process(es) during startup",
  });
  files["/sys/fs/cgroup/memory.events"] = "oom_kill 2\n";
  expect(startupStatus(read, () => true)).toEqual({ status: "starting" });
  expect(
    startupStatus(read, () => {
      throw new Error("ESRCH");
    })
  ).toEqual({ status: "failed", detail: "startup process disappeared" });
});
