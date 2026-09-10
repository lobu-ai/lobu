import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Drive one device chat turn through the shipped executable rather than
// importing runCli into Node/Bun: a compiled Bun artifact cannot re-enter its
// runtime with `process.execPath -e`, and only the real binary proves which
// supervisor launch it actually uses.
//
// Usage: node scripts/test-mac-device-daemon-chat.mjs <path-to-lobu-device-daemon>
if (!process.argv[2]) {
  console.error(
    "usage: node scripts/test-mac-device-daemon-chat.mjs <path-to-lobu-device-daemon>"
  );
  process.exit(2);
}
const artifact = resolve(process.argv[2]);
const work = await mkdtemp(join(tmpdir(), "lobu-packaged-chat-"));
const bin = join(work, "bin");
await mkdir(bin);
await writeFile(
  join(bin, "codex"),
  "#!/bin/sh\n" +
    'if [ -n "$WORKER_API_TOKEN" ]; then echo "WORKER_API_TOKEN reached the CLI" >&2; exit 42; fi\n' +
    'printf "%s\\n" "$@" > "$ARG_LOG"\n' +
    'printf "COMPILED_DEVICE_CHAT_OK\\n"\n',
  { mode: 0o755 }
);
let claimed = false;
let complete;
const completed = new Promise((settle) => {
  complete = settle;
});
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/workers/poll" && !claimed) {
    claimed = true;
    res.end(
      JSON.stringify({
        run_id: 91,
        run_type: "chat_message",
        organization_id: "org-synthetic",
        payload: {
          chat: {
            agent_kind: "codex",
            execution_config: { model: "synthetic-model", effort: "xhigh" },
            message: "Return the synthetic test reply.",
            history: [],
            agent: { id: "synthetic-agent" },
          },
          context: {
            device: { worker_id: "synthetic-device" },
            user: { user_id: "synthetic-user" },
            agent_session: {
              conversation_id: "synthetic-conversation",
              mcp_url: "https://example.test/mcp",
              token: "synthetic-run-token",
              expires_at: Date.now() + 60_000,
            },
          },
        },
      })
    );
  } else if (req.url === "/api/workers/me/runs/91/complete-chat") {
    res.end(
      JSON.stringify({ ok: true, status: body.error ? "failed" : "completed" })
    );
    complete(body);
  } else {
    res.end(JSON.stringify({ next_poll_seconds: 1 }));
  }
});
let child;
let timeout;
let stderr = "";
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  child = spawn(
    artifact,
    [
      "--api-url",
      `http://127.0.0.1:${port}`,
      "--worker-id",
      "synthetic-device",
      "--default-agent-kind",
      "codex",
      "--poll-interval-ms",
      "50",
    ],
    {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: work,
        TMPDIR: work,
        WORKER_API_TOKEN: `owl_pat_${"x".repeat(32)}`,
        ARG_LOG: join(work, "args"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  const exited = once(child, "exit");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const report = await Promise.race([
    completed,
    exited.then(([code]) => {
      throw new Error(`Daemon exited ${code}: ${stderr}`);
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Timed out: ${stderr}`)),
        20_000
      );
    }),
  ]);
  assert.equal(report.error, null, JSON.stringify(report));
  assert.equal(report.exit_code, 0);
  assert.equal(report.output, "COMPILED_DEVICE_CHAT_OK");
  const args = await readFile(join(work, "args"), "utf8");
  assert.match(args, /model_reasoning_effort="xhigh"/);
  assert.match(args, /synthetic-model/);
  console.log(
    "Compiled device chat: poll → supervised CLI → completion passed"
  );
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 8000);
    await exited;
    clearTimeout(kill);
  }
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
  await rm(work, { recursive: true, force: true });
}
