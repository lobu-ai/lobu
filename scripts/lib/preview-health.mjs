import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Transport/transform readiness; browser rendering is verified separately. */
export async function probePreview(baseUrl, request = fetch) {
  for (const path of ["/health/ready", "/", "/@vite/client", "/src/main.tsx"]) {
    const url = new URL(baseUrl);
    url.pathname = path;
    // Vite strips `t` and `import` queries before looking in its transform
    // cache. A distinct module URL must exercise esbuild even on a warm app.
    if (path === "/src/main.tsx")
      url.searchParams.set("lobu_health", randomUUID());
    try {
      const response = await request(url, {
        headers: { Accept: path === "/" ? "text/html" : "*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.text();
      if (!response.ok) {
        return {
          status:
            path !== "/health/ready" &&
            ![502, 503, 504].includes(response.status)
              ? "failed"
              : "starting",
          detail: `${path}: HTTP ${response.status}`,
        };
      }
      if (
        path === "/" &&
        !/<script\b[^>]*\bsrc=["']\/src\/main\.tsx(?:\?[^"']*)?["']/i.test(body)
      ) {
        return { status: "failed", detail: "preview HTML has no Vite entry" };
      }
      if (path.startsWith("/@") || path.startsWith("/src/")) {
        if (
          !/(java|ecma)script/i.test(
            response.headers.get("content-type") ?? ""
          ) ||
          !body.trim()
        ) {
          return { status: "failed", detail: `${path}: expected JavaScript` };
        }
      }
    } catch {
      return { status: "starting", detail: `${path}: request unavailable` };
    }
  }
  return { status: "ready" };
}

export function startupStatus(
  read = (path) => readFileSync(path, "utf8"),
  alive = (pid) => process.kill(pid, 0)
) {
  try {
    const code = read("/workspace/dev.exit").trim();
    return { status: "failed", detail: `startup exited with code ${code}` };
  } catch {
    /* The launcher has not exited. */
  }
  try {
    const before = Number(read("/workspace/dev.oom-kills").trim());
    const now = Number(
      read("/sys/fs/cgroup/memory.events").match(/^oom_kill (\d+)$/m)?.[1]
    );
    if (now > before)
      return {
        status: "failed",
        detail: `container OOM killed ${now - before} process(es) during startup`,
      };
  } catch {
    /* No cgroup v2 counters on this host. */
  }
  try {
    const pid = Number(read("/workspace/dev.pid").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0)
      return { status: "failed", detail: "invalid startup PID" };
    try {
      alive(pid);
    } catch {
      return { status: "failed", detail: "startup process disappeared" };
    }
    return { status: "starting" };
  } catch {
    return { status: "starting", detail: "waiting for launcher" };
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const startup = startupStatus();
  console.log(
    JSON.stringify(
      startup.status === "failed"
        ? startup
        : await probePreview("http://127.0.0.1:8787")
    )
  );
}
