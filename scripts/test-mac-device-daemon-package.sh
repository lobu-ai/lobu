#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$(uname -s)" == "Darwin" ]] || { echo "error: Mac packaging smoke requires macOS" >&2; exit 1; }
[[ "$(uname -m)" == "arm64" ]] || { echo "error: Mac packaging smoke requires arm64" >&2; exit 1; }

WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lobu-device-daemon-smoke.XXXXXX")"
WORK="$WORK_ROOT/work with spaces"
mkdir -p "$WORK"
trap 'rm -rf "$WORK_ROOT"' EXIT
ARTIFACT="$WORK/build/lobu-device-daemon"
CLEAN="$WORK/clean"
mkdir -p "$CLEAN"

OUTPUT="$ARTIFACT" "$ROOT/scripts/build-mac-device-daemon.sh" >"$WORK/build.log"
cp "$ARTIFACT" "$CLEAN/lobu-device-daemon"
chmod 0755 "$CLEAN/lobu-device-daemon"

[[ "$(find "$CLEAN" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" == 1 ]]

SAFE_ENV=(env -i PATH=/usr/bin:/bin HOME="$WORK/home" TMPDIR="$WORK/tmp")
mkdir -p "$WORK/home" "$WORK/tmp"

run_clean() (
  cd "$CLEAN"
  "${SAFE_ENV[@]}" "$@"
)

run_clean_with_token() (
  cd "$CLEAN"
  "${SAFE_ENV[@]}" WORKER_API_TOKEN=not-a-pat ./lobu-device-daemon "$@"
)

# Shared packaging assertion (arm64 Mach-O + `--version` metadata), run against
# the copied artifact so the release workflows and this smoke agree on what a
# publishable daemon looks like. It echoes the validated `--version` JSON, which
# the `--no-poll` parity check below compares against.
VERSION_JSON="$(run_clean "$ROOT/scripts/verify-mac-device-daemon.sh" ./lobu-device-daemon)"

run_clean ./lobu-device-daemon --help | grep -q 'Usage:'

# The compiled artifact must contain both adapters even without node_modules,
# and must never fall back to an installed/bundled engine when no path is given.
for agent in codex claude-code; do
  if run_clean ./lobu-device-daemon --internal-acp-adapter "$agent" > /dev/null 2>"$WORK/missing-agent.err"; then
    echo "error: $agent adapter accepted a missing external executable" >&2
    exit 1
  fi
  grep -q 'must identify an installed' "$WORK/missing-agent.err"
done
run_clean env CODEX_PATH=/synthetic/codex ./lobu-device-daemon --internal-acp-adapter codex --version | grep -q '@agentclientprotocol/codex-acp'
run_clean env CLAUDE_CODE_EXECUTABLE=/synthetic/claude ./lobu-device-daemon --internal-acp-adapter claude-code --version | grep -q '^[0-9]'

if run_clean ./lobu-device-daemon >/dev/null 2>"$WORK/missing-config.err"; then
  echo "error: missing launch configuration unexpectedly succeeded" >&2
  exit 1
fi
grep -q -- '--api-url or API_URL is required' "$WORK/missing-config.err"

if run_clean_with_token --api-url https://example.test >/dev/null 2>"$WORK/invalid-token.err"; then
  echo "error: invalid PAT unexpectedly succeeded" >&2
  exit 1
fi
grep -q 'owl_pat_' "$WORK/invalid-token.err"

NO_POLL_JSON="$(run_clean ./lobu-device-daemon --no-poll)"
[[ "$NO_POLL_JSON" == "$VERSION_JSON" ]]

# Hardened Runtime + JIT entitlement smoke: standalone Bun Mach-Os crash on Apple
# Silicon under Hardened Runtime ("Ran out of executable memory while allocating 128 bytes")
# unless signed with com.apple.security.cs.allow-jit.
codesign --force --options runtime --sign - \
  --entitlements "$ROOT/config/macos/lobu-auth.entitlements" "$CLEAN/lobu-device-daemon"
HARDENED_JSON="$(run_clean "$ROOT/scripts/verify-mac-device-daemon.sh" ./lobu-device-daemon)"
[[ "$HARDENED_JSON" == "$VERSION_JSON" ]]

# Run a real poll/CLI/completion cycle through the copied, hardened artifact.
# Metadata-only checks cannot detect an invalid self-exec supervisor command.
node "$ROOT/scripts/test-mac-device-daemon-chat.mjs" "$CLEAN/lobu-device-daemon"

echo "Mac device-daemon package smoke passed"
echo "$VERSION_JSON"
stat -f 'artifact_bytes=%z' "$CLEAN/lobu-device-daemon"
