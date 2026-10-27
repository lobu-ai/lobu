#!/usr/bin/env bash
# e2e-browser.sh — open (or reuse) this worktree's Chrome e2e browser.
#
# A thin wrapper around `lobu browser`, run with this worktree's CLI build: a
# Chrome for Testing profile with the worktree's extension loaded, paired as a
# device of the local gateway (this worktree's PORT from .env.local, default
# 8787). Pairing is automatic: the first run logs a CLI context in with the
# gateway's /api/local-init token, and the browser keeps its profile, pairing,
# and site logins across restarts.
#
# Driving it — navigate, snapshot, click, screenshot — goes through the paired
# extension's connector-operations bridge, NOT this script; see
# docs/BROWSER_TESTING.md.
#
# Usage:
#   scripts/e2e-browser.sh              # open, or reuse the running browser
#   scripts/e2e-browser.sh --restart    # restart to load extension edits
#   make e2e-browser [RESTART=1]        # same, from a worktree root

set -euo pipefail

restart=0
[[ "${1:-}" == "--restart" ]] && restart=1

source_root="$(git rev-parse --show-toplevel)"
cli="$source_root/packages/cli/bin/lobu.js"
[[ -f "$source_root/packages/cli/dist/index.js" ]] || {
  echo "error: build the CLI first (cd packages/cli && bun run build)" >&2
  exit 1
}

port=8787
if [[ -f "$source_root/.env.local" ]]; then
  p="$(awk -F= '/^PORT=/{print $2; exit}' "$source_root/.env.local" | tr -d '[:space:]')"
  [[ -n "$p" ]] && port="$p"
fi
gateway="http://127.0.0.1:$port"
curl -sf "$gateway/health" >/dev/null || {
  echo "error: no gateway at $gateway; start it with \`make dev\`" >&2
  exit 1
}

# Reuse any context already saved for this gateway (task-setup CONTEXT=1 adds
# one), else save `local-<port>`.
context="$(node "$cli" context list --json | node -e '
  const port = process.argv[1];
  const { contexts } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const match = contexts.find((c) => {
    try {
      const u = new URL(c.url);
      return ["127.0.0.1", "localhost"].includes(u.hostname) && u.port === port;
    } catch { return false; }
  });
  if (match) console.log(match.name, match.loggedIn ? "in" : "out");
' "$port")"
if [[ -z "$context" ]]; then
  node "$cli" context add "local-$port" --url "$gateway" >/dev/null
  context="local-$port out"
fi
read -r context_name login_state <<<"$context"
if [[ "$login_state" != "in" ]]; then
  token="$(curl -sf -X POST -H 'X-Lobu-Client: e2e-browser' "$gateway/api/local-init" |
    node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0, "utf8")).device_token ?? "")')"
  [[ -n "$token" ]] || {
    echo "error: $gateway/api/local-init returned no token" >&2
    exit 1
  }
  node "$cli" login --context "$context_name" --token "$token" >/dev/null
fi

# Load the worktree's current extension source into the CLI's copy.
node "$source_root/packages/cli/scripts/copy-chrome-extension.cjs"

name="dev-$port"
if [[ $restart -eq 1 ]]; then
  node "$cli" browser stop "$name" 2>/dev/null || true
fi
node "$cli" browser start "$name" --context "$context_name"
echo "   drive it:  docs/BROWSER_TESTING.md (Owletto connector-operations bridge)"
