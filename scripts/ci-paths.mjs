// Both CI filters use the same event range. A push compares its two endpoints;
// a PR compares against the merge base. Missing history must run all checks.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const groups = {
  suites: {
    packages:
      /^(packages\/|examples\/|bun\.lock$|package\.json$|tsconfig\.json$|bunfig\.toml$|Makefile$|patches\/|docker\/|db\/|scripts\/|skills\/|config\/|\.github\/workflows\/ci\.yml$|\.github\/actions\/|\.gitmodules$)/,
    frontend:
      /^(packages\/owletto($|\/)|\.gitmodules$|\.github\/actions\/setup-submodule\/)/,
    // The submodule pointer can change the extension. Server-only changes do
    // not affect its hand-written gateway fixture or need Chromium downloaded.
    chromeExt:
      /^(packages\/owletto$|bun\.lock$|package\.json$|\.gitmodules$|\.github\/actions\/setup-submodule\/|\.github\/workflows\/ci\.yml$|scripts\/ci-paths\.mjs$)/,
  },
  smokes: {
    mac: /^(packages\/owletto($|\/)|packages\/cli\/|packages\/connector-worker\/|packages\/connector-sdk\/(?:package\.json|src\/redact\.ts)$|packages\/core\/|packages\/device-connectors\/|patches\/|config\/macos\/lobu-auth\.entitlements$|scripts\/__tests__\/mac-app-codesign\.test\.ts$|scripts\/(build-owletto-mac|verify-mac-app-entitlements|build-mac-auth-cli|build-mac-device-daemon|test-mac-device-daemon-package|test-mac-device-daemon-automation|check-mac-device-daemon-graph|verify-mac-device-daemon|with-owletto-mac-daemon)\.|scripts\/ci-paths\.mjs$|package\.json$|bun\.lock$|tsconfig\.json$|bunfig\.toml$|Makefile$|\.github\/workflows\/mac-release\.yml$|\.github\/workflows\/ci\.yml$|\.github\/actions\/setup-submodule(\/|$)|\.gitmodules$)/,
    connector:
      /^(docker\/|patches\/|packages\/(connector-worker|connector-sdk|connectors|core|embeddings|pgvector-embedded|cli|plugin-[^/]+)\/|config\/|db\/|skills\/|scripts\/|package\.json$|bun\.lock$|tsconfig\.json$|bunfig\.toml$|Makefile$|\.dockerignore$|\.github\/workflows\/ci\.yml$|\.github\/workflows\/build-images\.yml$)/,
  },
};

function changedPaths() {
  const { EVENT_NAME, BASE_SHA, BEFORE_SHA } = process.env;
  const base = EVENT_NAME === "pull_request" ? BASE_SHA : BEFORE_SHA;
  if (
    !["push", "pull_request"].includes(EVENT_NAME) ||
    !/^[a-f0-9]{40}$/.test(base ?? "") ||
    /^0+$/.test(base)
  ) {
    return null;
  }
  // --no-renames includes both sides of a move, so moving runtime code to a
  // docs path cannot hide the deletion. NUL delimiters preserve path bytes.
  const range =
    EVENT_NAME === "pull_request" ? [`${base}...HEAD`] : [base, "HEAD"];
  const diff = spawnSync(
    "git",
    [
      "diff",
      "--no-ext-diff",
      "--no-renames",
      "--name-only",
      "-z",
      ...range,
      "--",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (diff.status !== 0) {
    console.log("::notice::CI diff unavailable; running all checks.");
    return null;
  }
  return diff.stdout.split("\0").filter(Boolean);
}

const patterns = groups[process.argv[2]];
if (!patterns || !process.env.GITHUB_OUTPUT) {
  throw new Error(
    "Usage: GITHUB_OUTPUT=<path> node scripts/ci-paths.mjs suites|smokes"
  );
}
const changed = changedPaths();
for (const [key, pattern] of Object.entries(patterns)) {
  const selected =
    changed === null || changed.some((path) => pattern.test(path));
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${selected}\n`);
}
