#!/usr/bin/env node

// ─────────────────────────────────────────────────────────────────────────────
// Node-version bootstrap. MUST run before `import "../dist/index.js"`.
//
// Lobu's gateway and worker load isolated-vm, whose native addon is built for
// Node 26's V8 ABI in this repo. The backend command may be launched by a host
// that still selects an older Node (the macOS app currently prepends Homebrew
// Node 22/24 to PATH, and `bunx` runs the shebang through Bun), so `lobu run`
// re-execs itself under a verified Node 26 binary when one is available. Every
// other command keeps the strict Node 26 gate.
//
// Only Node builtins load before that check; the application bundle stays
// behind the dynamic import below.
//
// Keep the major in sync with packages/cli/src/internal/node-version.ts
// (`lobu doctor`) and packages/server's assert-node-version.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_NODE_MAJOR = 26;
const BOOTSTRAP_ENV = "LOBU_NODE26_BOOTSTRAP";

function majorOf(version) {
  return Number.parseInt(String(version ?? "").split(".")[0], 10);
}

function isBun(versions = process.versions) {
  return typeof versions.bun === "string";
}

/**
 * Every place a Node 26 binary may live: PATH first (nvm/fnm/asdf/mise/volta
 * expose it there), then the fixed Homebrew keg-only locations the macOS app
 * uses, then the common version-manager install roots for GUI launches whose
 * PATH never saw a shell profile.
 */
function node26Candidates() {
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) => names.map((name) => join(dir, name)));

  candidates.push(
    "/opt/homebrew/opt/node@26/bin/node",
    "/usr/local/opt/node@26/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node"
  );

  const home = homedir();
  const versionRoots = [
    [join(home, ".nvm/versions/node"), "bin/node"],
    [join(home, ".local/share/fnm/node-versions"), "installation/bin/node"],
    [join(home, ".volta/tools/image/node"), "bin/node"],
    [join(home, ".asdf/installs/nodejs"), "bin/node"],
    [join(home, ".local/share/mise/installs/node"), "bin/node"],
  ];
  for (const [root, suffix] of versionRoots) {
    try {
      for (const entry of readdirSync(root)) {
        if (majorOf(entry.replace(/^v/, "")) === REQUIRED_NODE_MAJOR) {
          candidates.push(join(root, entry, suffix));
        }
      }
    } catch {
      // Version manager not installed.
    }
  }
  return [...new Set(candidates)];
}

function probeNode26(binary) {
  if (!existsSync(binary)) return false;
  const probe = spawnSync(
    binary,
    [
      "-p",
      "JSON.stringify({node:process.versions.node,bun:process.versions.bun??null})",
    ],
    { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }
  );
  if (probe.error || probe.status !== 0) return false;
  try {
    const parsed = JSON.parse(probe.stdout);
    return parsed.bun === null && majorOf(parsed.node) === REQUIRED_NODE_MAJOR;
  } catch {
    return false;
  }
}

function findNode26() {
  if (!isBun() && majorOf(process.versions.node) === REQUIRED_NODE_MAJOR) {
    return process.execPath;
  }
  return node26Candidates().find(probeNode26) ?? null;
}

function fail(current) {
  process.stderr.write(
    `\n  Lobu needs Node.js ${REQUIRED_NODE_MAJOR}.x — you're on ${current}.\n\n  (Lobu runs agent code in an isolated-vm sandbox whose native build\n   covers Node ${REQUIRED_NODE_MAJOR}.x only.)\n\n  Install Node ${REQUIRED_NODE_MAJOR}, then re-run:\n    • nvm:   nvm install ${REQUIRED_NODE_MAJOR} && nvm use ${REQUIRED_NODE_MAJOR}\n    • fnm:   fnm install ${REQUIRED_NODE_MAJOR} && fnm use ${REQUIRED_NODE_MAJOR}\n    • brew:  brew install node@${REQUIRED_NODE_MAJOR}\n\n  Check your version with:  node --version\n\n`
  );
  process.exit(1);
}

const current = isBun()
  ? `Bun ${process.versions.bun} (Node ${process.versions.node} compatibility)`
  : `Node ${process.versions.node}`;
const command = process.argv.slice(2).find((arg) => !arg.startsWith("-"));

if (isBun() || majorOf(process.versions.node) !== REQUIRED_NODE_MAJOR) {
  // Bun is never a valid backend runtime, so every Bun-hosted CLI command
  // bootstraps. An older/other Node only bootstraps the backend command: the
  // macOS launcher invokes exactly `lobu run`, while `lobu --version`,
  // `doctor`, etc. still fail clearly on an unsupported host.
  if (!isBun() && command !== "run") fail(current);

  if (process.env[BOOTSTRAP_ENV] === "1") {
    // The re-exec already happened and the child still is not Node 26. Do not
    // loop; surface the actionable message.
    fail(current);
  }
  const target = findNode26();
  if (!target) fail(current);

  const env = { ...process.env, [BOOTSTRAP_ENV]: "1" };
  const args = [
    "--no-node-snapshot",
    fileURLToPath(import.meta.url),
    ...process.argv.slice(2),
  ];

  // Replace this process image when the platform supports it. The PID stays
  // the same, so the Mac app's SIGTERM reaches the inner CLI and its own
  // shutdown handler can stop the gateway/worker child cleanly.
  if (typeof process.execve === "function") {
    try {
      process.execve(target, [target, ...args], env);
    } catch {
      // Fall through to the supervised child on platforms without execve.
    }
  }

  // Portable fallback: keep the launcher alive, forward termination signals
  // to the Node 26 child, and wait for it to finish. Exiting immediately here
  // would orphan the server when the Mac app stops the runner.
  const child = spawn(target, args, { stdio: "inherit", env });
  const forwarders = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const forward = () => child.kill(signal);
    process.on(signal, forward);
    return [signal, forward];
  });
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  for (const [signal, forward] of forwarders) {
    process.removeListener(signal, forward);
  }
  if (result.error) {
    process.stderr.write(
      `\n  Lobu found Node 26 at ${target} but could not start it: ${result.error.message}\n\n`
    );
    process.exit(1);
  }
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}

// Dynamic import (not a static top-level `import`) is REQUIRED for the bundle:
// a static import is hoisted and evaluated before the guard above runs, so the
// bundle — and undici — would load before we could reject an old Node. The
// dynamic import defers that load until after the version gate has passed.
const { runCli } = await import("../dist/index.js");

await runCli(process.argv);
