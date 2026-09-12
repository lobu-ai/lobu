#!/usr/bin/env bash
# e2e-browser.sh — launch (or reuse) the stable Owletto Chrome harness for e2e.
#
# Mirrors the Mac-app model: one persistent browser profile, paired once,
# reused from every agent session. The extension's fixed manifest "key" pins
# its ID regardless of where it's loaded from, so the extension's
# chrome.storage.local (gateway URL + access/refresh tokens + workerId) lives
# in the profile dir and survives restarts — and carries across worktrees,
# because the ID never changes. So you pair once and reuse forever, exactly
# like installing Lobu.app once.
#
# Chrome is launched directly (agent-browser is retired). Driving it
# afterwards — navigate, snapshot, click, screenshot — goes through the
# paired extension's connector-operations bridge, NOT this script; see
# docs/BROWSER_TESTING.md.
#
# Usage:
#   scripts/e2e-browser.sh              # extension = current worktree, open its gateway
#   scripts/e2e-browser.sh --restart    # force a fresh launch (pick up extension edits or a new worktree)
#   make e2e-browser                    # same, from a worktree root
#
# Stable handles — reuse these verbatim from any agent session:
#   profile   ~/.config/lobu-dev/chrome   (persists pairing/cookies/storage)
#
# The headed window may close when left idle, but Chrome keeps the profile:
# re-running this script revives the browser WITH the extension. So a
# vanished window is not a re-pair — just re-run.
#
# After editing extension source, reload it (chrome://extensions -> reload) or
# re-run with --restart (--load-extension only applies at browser launch).
# Mac e2e needs no equivalent: the installed Lobu.app reads
# ~/.config/lobu/config.json on every popover, so worktree Lobu contexts
# registered by task-setup show up in its picker automatically.

set -euo pipefail

restart=0
[[ "${1:-}" == "--restart" ]] && restart=1

chrome=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  [[ -x "$candidate" ]] && { chrome="$candidate"; break; }
done
[[ -n "$chrome" ]] || {
  echo "error: no Chrome/Chromium found under /Applications" >&2
  exit 1
}

source_root="$(git rev-parse --show-toplevel)"
ext="$source_root/packages/owletto/apps/chrome"
[[ -d "$ext" ]] || { echo "error: no extension source at $ext" >&2; exit 1; }

# Gateway URL = this worktree's PORT (.env.local), defaulting to the canonical 8787.
port=8787
if [[ -f "$source_root/.env.local" ]]; then
  p="$(awk -F= '/^PORT=/{print $2; exit}' "$source_root/.env.local" | tr -d '[:space:]')"
  [[ -n "$p" ]] && port="$p"
fi
url="http://localhost:$port"

profile="$HOME/.config/lobu-dev/chrome"
mkdir -p "$profile"

# A running harness is any Chrome process bound to this profile dir.
running() { pgrep -f "user-data-dir=$profile" >/dev/null 2>&1; }

if [[ $restart -eq 1 ]] && running; then
  echo "-> --restart: stopping the running harness"
  pkill -f "user-data-dir=$profile" 2>/dev/null || true
  for _ in $(seq 1 20); do running || break; sleep 0.5; done
  running && { echo "error: harness did not stop; kill it manually" >&2; exit 1; }
fi

if running; then
  echo "-> reusing running harness (profile: $profile)"
  echo "   (use --restart to reload the extension after source/worktree changes)"
else
  echo "-> launching harness (profile: $profile)"
fi

# Chrome launched against an already-running profile forwards the URL to the
# existing instance and exits, so this one command covers both first launch
# and "open the gateway". --load-extension only takes effect on a cold start.
# Detach: the raw Chrome binary blocks in the foreground otherwise.
nohup "$chrome" \
  --user-data-dir="$profile" \
  --load-extension="$ext" \
  --no-first-run \
  --no-default-browser-check \
  "$url" >/dev/null 2>&1 &
disown || true

echo "OK Owletto e2e browser ready"
echo "   gateway:   $url"
echo "   profile:   $profile"
echo "   extension: $ext"
echo "   sidepanel: set 'Server URL' to $url the first time you pair against this worktree"
echo "   drive it:  docs/BROWSER_TESTING.md (Owletto connector-operations bridge)"
