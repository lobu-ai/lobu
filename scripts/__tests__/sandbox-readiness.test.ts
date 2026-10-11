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
      expect(await previewHealthy("https://preview.example.test", 1)).toBe(
        false
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("fails immediately after a startup process exits", async () => {
    const sandbox = {
      process: {
        executeCommand: async (command: string) => ({
          exitCode: 0,
          result: command.includes("/health/ready")
            ? "200"
            : '{"status":"failed","detail":"startup exited with code 137"}',
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
