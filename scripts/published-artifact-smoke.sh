#!/usr/bin/env bash
#
# Published-artifact smoke: install @lobu/cli FROM NPM into a clean container
# and drive the landing page's own quickstart end to end.
#
# Why this exists, and why cli-smoke.sh is not enough.
#
# Every "I can't get started" issue we have shipped has the same shape: it
# works from the monorepo and is broken from the published artifact. Nothing in
# CI installed what we published, so the whole class was invisible:
#
#   #2186     unpublished private dep — the tarball could not resolve @lobu/*
#   #2231     no `lobu` on PATH inside the app image
#   __filename  bundle is ESM-under-node; bun defines it, node does not
#   GLIBC_2.38  pgvector prebuilt built on too new a runner
#   uid 0     embedded-postgres refuses to run as root
#
# `scripts/cli-smoke.sh` walks the whole command surface, but it points
# LOBU_BIN at the SOURCE TREE, which pins four things at once — and each pin
# hides one of the bugs above:
#
#   source tree, not the tarball  ->  #2186, missing bin, packaging breakage
#   .ts entry, so spawned by bun  ->  __filename (node's ESM has no such global)
#   non-root runner               ->  uid-0 embedded-postgres refusal
#   modern-glibc runner           ->  GLIBC_2.38 pgvector floor
#
# The bun one is structural, not incidental: the gateway picks the worker
# entrypoint by extension (`gateway/config/index.ts` resolves `src/index.ts`
# in-repo and `dist/index.bundle.mjs` when installed), and
# `buildWorkerInvocation` spawns `.ts` under bun, `.mjs` under node. In-repo we
# can only ever take the bun path. cli-smoke could not catch `__filename` no
# matter how many commands it walked.
#
# So this gate varies exactly those axes: real tarball, real `node`, root AND
# non-root, old AND new glibc — and it runs a REAL AGENT TURN, because the turn
# is the only thing that exercises the worker's egress bootstrap.
#
# No provider key: it reuses the deterministic mock provider from
# scripts/sdk-e2e/, so this needs no secrets and is reproducible.
#
# Usage:
#   scripts/published-artifact-smoke.sh [version]     # default: latest
#
# Env:
#   LOBU_VERSION   npm version/tag to install (default "latest")
#   PUBLISH_WAIT   seconds to keep retrying an unresolvable version while the
#                  registry propagates (default 600; 0 = single attempt)
#   SMOKE_AS_USER  unprivileged username to drop to (default: run as-is)
#   GW_PORT        gateway port (default 8799)
#   MOCK_PORT      mock provider port (default 11439)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$REPO_ROOT/scripts/sdk-e2e"
# shellcheck source=scripts/lib/process-cleanup.sh
. "$REPO_ROOT/scripts/lib/process-cleanup.sh"
# shellcheck source=scripts/lib/guest-bundle-expectation.sh
. "$REPO_ROOT/scripts/lib/guest-bundle-expectation.sh"
LOBU_VERSION="${1:-${LOBU_VERSION:-latest}}"
GW_PORT="${GW_PORT:-8799}"
MOCK_PORT="${MOCK_PORT:-11439}"
PUBLISH_WAIT="${PUBLISH_WAIT:-600}"
# PUBLISH_WAIT feeds `[ ... -ge ... ]` in the install loop; a non-integer would
# make that test error on every pass and spin until the job timeout instead of
# failing, the same trap ROLLOUT_WAIT guards against in prod-smoke.sh.
case "$PUBLISH_WAIT" in
  *[!0-9]*)
    echo "PUBLISH_WAIT must be a non-negative integer (seconds), got: ${PUBLISH_WAIT}" >&2
    exit 1
    ;;
esac
PUBLISH_POLL=10
MOCK_REPLY="ARTIFACT_SMOKE_OK"

WORK="${SMOKE_WORK:-/tmp/lobu-artifact-smoke}"
rm -rf "$WORK"; mkdir -p "$WORK"
export HOME="$WORK/home"; mkdir -p "$HOME"

PASSES=0; FAILS=0; SKIPS=0
pass() { echo "  [OK]   $*"; PASSES=$((PASSES + 1)); }
fail() { echo "  [FAIL] $*" >&2; FAILS=$((FAILS + 1)); }
# A guarantee this published version was never supposed to offer. Reported so
# it cannot hide, counted separately so it cannot red main.
skip() { echo "  [SKIP] $*"; SKIPS=$((SKIPS + 1)); }
note() { echo ""; echo "== $* =="; }

MOCK_PID=""
RUN_PID=""
cleanup() {
  if [ -n "$RUN_PID" ]; then
    # Let `lobu run` forward SIGTERM and stop its embedded Postgres before
    # forcing and reaping the exact tracked process down.
    lobu_terminate_child "$RUN_PID"
  fi
  [ -n "$MOCK_PID" ] && kill -9 "$MOCK_PID" 2>/dev/null || true
  lobu_kill_listening_port "$GW_PORT"
  lobu_kill_listening_port "$MOCK_PORT"
  return 0
}
trap cleanup EXIT

echo "================================================================"
echo "  published-artifact smoke"
echo "    version : @lobu/cli@$LOBU_VERSION"
echo "    node    : $(node --version 2>/dev/null || echo MISSING)"
echo "    uid     : $(id -u) ($(id -un))"
echo "    glibc   : $(getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>&1 | head -1)"
echo "================================================================"

# ---------------------------------------------------------------------------
# 1. Install from the registry. This is the step cli-smoke never performs.
# ---------------------------------------------------------------------------
note "install @lobu/cli@$LOBU_VERSION from npm"
INSTALL_DIR="$WORK/install"; mkdir -p "$INSTALL_DIR"
INSTALL_LOG="$WORK/npm-install.log"
( cd "$INSTALL_DIR" && npm init -y >/dev/null 2>&1 )
# A release publishes all eight @lobu/* packages, then this gate installs one
# of them and lets the resolver pull the other seven. Registry visibility is
# not atomic across them, so for the first minutes after a publish the resolver
# can report ETARGET for a sibling that is already published -- 18.0.0 failed
# all four legs on "No matching version found for @lobu/embeddings@18.0.0"
# while every package was in fact on the registry. The old 5x10s ladder gave up
# ~2.5min in and reported a healthy release as broken, so what this needs is a
# time budget, not a retry count.
#
# Only an unresolvable version earns the wait. A corrupt tarball, an auth
# failure or a missing bin will not fix itself, and burning the whole budget on
# one would just delay the report and eat into the job timeout.
INSTALL_OK=0
waited=0
attempt=0
while :; do
  attempt=$((attempt + 1))
  if ( cd "$INSTALL_DIR" && npm install --no-audit --no-fund "@lobu/cli@$LOBU_VERSION" > "$INSTALL_LOG" 2>&1 ); then
    INSTALL_OK=1
    [ "$waited" -gt 0 ] && echo "version resolved after ${waited}s of registry propagation"
    break
  fi
  echo "install attempt $attempt failed (waited ${waited}s of ${PUBLISH_WAIT}s)" >&2
  tail -5 "$INSTALL_LOG" >&2
  if ! grep -qE 'ETARGET|E404|No matching version found|404 Not Found' "$INSTALL_LOG"; then
    echo "not a version-resolution failure; not waiting for propagation" >&2
    break
  fi
  [ "$waited" -ge "$PUBLISH_WAIT" ] && { echo "gave up after ${waited}s waiting for the registry" >&2; break; }
  sleep "$PUBLISH_POLL"
  waited=$((waited + PUBLISH_POLL))
done
tail -5 "$INSTALL_LOG"
LOBU_BIN="$INSTALL_DIR/node_modules/.bin/lobu"
if [ "$INSTALL_OK" -ne 1 ] || [ ! -x "$LOBU_BIN" ]; then
  fail "npm install did not produce an executable lobu bin at $LOBU_BIN"
  echo "RESULT: published-artifact smoke FAILED (install)"; exit 1
fi
pass "installed, bin present"

RESOLVED="$("$LOBU_BIN" --version 2>&1 | tr -d '[:space:]')"
printf '%s\n' "$RESOLVED" > "$WORK/version.txt"
if [ -n "$RESOLVED" ]; then pass "lobu --version -> $RESOLVED"; else fail "lobu --version produced nothing"; fi

# Run from a directory that is deliberately outside the npm install tree. A
# compiled connector must load the SDK from connector-worker's package graph,
# not from an operator cwd that happens to contain a compatible node_modules.
RUNTIME_CHECK_LOG="$WORK/connector-runtime-self-check.log"
if (cd "$HOME" && "$LOBU_BIN" connector runtime-self-check --json >"$RUNTIME_CHECK_LOG" 2>&1); then
  pass "connector runtime self-check from unrelated cwd"
else
  fail "connector runtime self-check from unrelated cwd"
  tail -40 "$RUNTIME_CHECK_LOG" >&2
fi

# The guest bundle is the artifact that actually has to load, inside the
# isolate. `@lobu/worker` used to ship the equivalent for the managed
# subprocess; that package is no longer published, and a turn now evaluates
# this bundle in-isolate.
# Whether this artifact OWES us the bundle is derived from the artifact, not
# pinned to a version — see scripts/lib/guest-bundle-expectation.sh.
GUEST_DIST_DIR="$INSTALL_DIR/node_modules/@lobu/connector-worker/dist"
if [ -f "$INSTALL_DIR/node_modules/@lobu/cli/dist/runtime-components.json" ]; then
  # New launchers keep the worker inside the installed device component.
  # The self-check above prepared it; this read must never download anything.
  GUEST_DIST_DIR="$(node --input-type=module - "$INSTALL_DIR/node_modules/@lobu/cli" <<'NODE'
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const cli = process.argv[2];
const { ensureComponent } = await import(pathToFileURL(join(cli, 'dist/internal/runtime-components.js')));
const { device } = JSON.parse(readFileSync(join(cli, 'dist/runtime-components.json'), 'utf8'));
const directory = await ensureComponent(device, { offline: true });
console.log(dirname(join(directory, device.entries.worker)));
NODE
)" || { fail "installed device component is unavailable"; exit 1; }
fi
GUEST_BUNDLE="$GUEST_DIST_DIR/agent-turn/guest.bundle.js"
case "$(lobu_guest_bundle_verdict "$GUEST_DIST_DIR")" in
  present)
    pass "isolate guest bundle present ($(wc -c < "$GUEST_BUNDLE" | tr -d ' ') bytes)"
    ;;
  missing)
    fail "guest bundle builder shipped without its output at $GUEST_BUNDLE — the publish ran tsc but not the bundle step, so the agent turn cannot work"
    ;;
  layout-moved)
    fail "@lobu/connector-worker ships dist but no dist/agent-turn — the packaged layout moved, so no version of this check can hold"
    ;;
  no-dist)
    fail "@lobu/connector-worker has no dist at all in $GUEST_DIST_DIR"
    ;;
  not-shipped)
    skip "isolate guest bundle: published $RESOLVED predates the isolate agent-turn bundle (no builder in dist); its turn runs the subprocess lane, which the real-turn assertion in section 4 covers"
    ;;
esac

# ---------------------------------------------------------------------------
# 2. Deterministic provider, so a real turn needs no key.
# ---------------------------------------------------------------------------
note "start the mock provider on :$MOCK_PORT"
MOCK_PORT="$MOCK_PORT" MOCK_REPLY="$MOCK_REPLY" \
  node "$HARNESS/mock-openai.mjs" > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 20); do
  curl -sf --max-time 2 "http://127.0.0.1:$MOCK_PORT/v1/models" >/dev/null 2>&1 && break
  sleep 1
done
if curl -sf --max-time 2 "http://127.0.0.1:$MOCK_PORT/v1/models" >/dev/null 2>&1; then
  pass "mock provider answering"
else
  fail "mock provider never came up"; echo "RESULT: FAILED (mock)"; exit 1
fi

PROVIDERS="$WORK/providers.json"
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const port=process.argv[2];for(const g of j.providers||[])for(const s of g.providers||[])if(s.upstreamBaseUrl)s.upstreamBaseUrl=s.upstreamBaseUrl.replace(/:\d+/,":"+port);fs.writeFileSync(process.argv[3],JSON.stringify(j,null,2))' \
  "$HARNESS/providers.json" "$MOCK_PORT" "$PROVIDERS"
export LOBU_PROVIDER_REGISTRY_PATH="$PROVIDERS"

# ---------------------------------------------------------------------------
# 3. The quickstart: init -> validate -> run.
# ---------------------------------------------------------------------------
note "lobu init (the landing page's own first step)"
PROJ="$WORK/proj"; mkdir -p "$PROJ"
( cd "$PROJ" && "$LOBU_BIN" init . -y --here --provider gemini ) > "$WORK/init.log" 2>&1
if grep -qi "Lobu initialized" "$WORK/init.log"; then pass "lobu init"; else fail "lobu init"; tail -20 "$WORK/init.log" >&2; fi

# `network.allowed` is LOAD-BEARING, not decoration, and the key name matters.
#
# The worker's bash bootstrap only builds the egress transport when the agent
# has a non-empty allow-list:
#
#   const egressFetch = allowedDomains.length > 0
#     ? buildEgressFetch(NetworkAccessDeniedError) : undefined;
#
# and `buildEgressFetch` is what spawns the egress worker thread — the code
# that carried the `__filename` crash. An agent with no allow-list never
# reaches it.
#
# Use `allowed`, NOT `allowedDomains`. The CLI's public `NetworkConfig`
# (cli/src/config/define.ts) is `{ allowed, denied }`; `allowedDomains` is the
# internal core name, and a config carrying it is accepted and then silently
# dropped — `lobu agent config get` comes back `networkConfig: {}`. Both
# earlier drafts of this gate did exactly that and went GREEN against a 14.7.1
# that is provably broken. A gate that cannot fail is worse than no gate.
cat > "$PROJ/lobu.config.ts" <<'TS'
import { defineAgent, defineConfig, secret } from "@lobu/cli/config";

const echo = defineAgent({
  id: "echo", name: "Echo", dir: "./agents/echo",
  providers: [{ id: "mock", model: "mock-model", key: secret("MOCK_API_KEY") }],
  network: { allowed: ["127.0.0.1", "localhost"] },
});

export default defineConfig({ agents: [echo] });
TS

# WORKER_ALLOWED_DOMAINS is what `lobu init` writes for a real user, and it is
# what makes the gateway hand the worker an HTTP_PROXY — which is what makes
# `buildEgressFetch` spawn the egress worker eagerly. Without it the turn never
# touches the code path that carried the __filename crash.
{
  printf '\n'
  echo "MOCK_API_KEY=mock-key-artifact-smoke"
  echo "WORKER_ALLOWED_DOMAINS=127.0.0.1,localhost"
  echo "LOBU_DISABLE_SYSTEMD_RUN=1"
} >> "$PROJ/.env"

( cd "$PROJ" && "$LOBU_BIN" validate ) > "$WORK/validate.log" 2>&1
if grep -qi "is valid" "$WORK/validate.log"; then pass "lobu validate"; else fail "lobu validate"; tail -20 "$WORK/validate.log" >&2; fi

note "lobu run (embedded Postgres + pgvector on THIS glibc, as THIS uid)"
RUN_LOG="$WORK/run.log"
( cd "$PROJ" && exec "$LOBU_BIN" run --port "$GW_PORT" > "$RUN_LOG" 2>&1 ) &
RUN_PID=$!
for _ in $(seq 1 180); do
  grep -qiE "Apply complete|auto-apply skipped|Apply halted" "$RUN_LOG" 2>/dev/null && break
  sleep 1
done
if grep -qi "Apply complete" "$RUN_LOG"; then
  pass "lobu run booted + auto-applied"
else
  fail "lobu run never came up"
  # Name the two failures this gate exists to catch, so the log reads itself.
  if grep -qi "GLIBC_" "$RUN_LOG"; then
    echo "         ^ pgvector prebuilt needs a newer glibc than this base has" >&2
  fi
  if grep -qi "running this script as root" "$RUN_LOG"; then
    echo "         ^ embedded-postgres refused to run as root (createPostgresUser)" >&2
  fi
  tail -40 "$RUN_LOG" >&2
  echo ""
  echo "  smoke summary: $PASSES passed, $FAILS failed, $SKIPS skipped"
  echo "RESULT: published-artifact smoke FAILED (boot)"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. THE point of this gate: one real agent turn, under node, from the tarball.
#    This is the assertion cli-smoke structurally cannot make.
# ---------------------------------------------------------------------------
note "a real agent turn (the __filename / worker-packaging assertion)"
( cd "$PROJ" && "$LOBU_BIN" whoami -c local ) > /dev/null 2>&1
CHAT_OUT="$WORK/chat.log"
( cd "$PROJ" && timeout 120 "$LOBU_BIN" chat "say the safe word" -c local ) > "$CHAT_OUT" 2>&1
CHAT_RC=$?

if grep -qF "$MOCK_REPLY" "$CHAT_OUT"; then
  pass "lobu chat returned the model's reply ($MOCK_REPLY)"
else
  fail "lobu chat did not return the model's reply (exit=$CHAT_RC)"
  if grep -qiE "__filename|__dirname|is not defined" "$CHAT_OUT" "$RUN_LOG" 2>/dev/null; then
    echo "         ^ a CJS global leaked into the ESM worker bundle; node has no such" >&2
    echo "           binding (bun does, which is why in-repo checks stay green)" >&2
  fi
  tail -30 "$CHAT_OUT" >&2
fi

# A crash inside the worker can still exit 0 at the CLI, so assert on the log
# too — this is how the __filename break looked to a user: a "successful"
# command with a dead worker behind it.
if grep -qiE "Worker crashed|ReferenceError|is not defined" "$RUN_LOG" 2>/dev/null; then
  fail "the worker logged a crash during the turn"
  grep -iE "Worker crashed|ReferenceError|is not defined" "$RUN_LOG" | head -5 >&2
else
  pass "no worker crash in the run log"
fi

# ---------------------------------------------------------------------------
# 5. MCP surface. The memory MCP server is in-process, so it exercises the
#    published server bundle's tool registration and JSON-RPC plumbing — a
#    different packaging path from the worker bundle above, and the one every
#    MCP client (Claude, ChatGPT, the SDK) actually talks to.
# ---------------------------------------------------------------------------
note "MCP (memory server + admin tool dispatch) from the installed artifact"

MCP_OUT="$WORK/mcp.log"

( cd "$PROJ" && timeout 60 "$LOBU_BIN" memory health -c local ) > "$MCP_OUT" 2>&1
if grep -qF "ok: true" "$MCP_OUT"; then
  pass "lobu memory health (MCP server reachable)"
else
  fail "lobu memory health did not report ok"; tail -15 "$MCP_OUT" >&2
fi

# Listing tools proves the server registered its tool schemas, not merely that
# the process is up — an empty registry still answers a health check.
( cd "$PROJ" && timeout 60 "$LOBU_BIN" memory run -c local ) > "$MCP_OUT" 2>&1
if grep -qE "[0-9]+ tool\(s\)" "$MCP_OUT"; then
  pass "lobu memory run (tools registered: $(grep -oE '[0-9]+ tool\(s\)' "$MCP_OUT" | head -1))"
else
  fail "lobu memory run listed no tools"; tail -15 "$MCP_OUT" >&2
fi

# A real tool INVOCATION, not just discovery — round-trips request and response
# through the MCP transport.
( cd "$PROJ" && timeout 60 "$LOBU_BIN" call manage_feeds -c local --arg "action=list_feeds" ) > "$MCP_OUT" 2>&1
MCP_RC=$?
if [ "$MCP_RC" -eq 0 ]; then
  pass "lobu call manage_feeds list_feeds (MCP tool invocation)"
else
  fail "MCP tool invocation failed (exit=$MCP_RC)"; tail -15 "$MCP_OUT" >&2
fi

( cd "$PROJ" && timeout 60 "$LOBU_BIN" call --list -c local ) > "$MCP_OUT" 2>&1
if grep -qE "tool\(s\)" "$MCP_OUT"; then
  pass "lobu call --list (admin tool surface)"
else
  fail "lobu call --list exposed no tools"; tail -15 "$MCP_OUT" >&2
fi

# The CLI quickstart above exercises an agent worker. Device command execution
# has a separate process/credential/queue path, driven here by a real MCP client
# against the SAME installed npm artifact and its installed sibling packages.
if node "$REPO_ROOT/scripts/daemon-mcp-smoke.mjs" "$LOBU_BIN" "$WORK/daemon-mcp-logs"; then
  pass "daemon MCP command lifecycle"
else
  fail "daemon MCP command lifecycle"
fi

echo ""
echo "================================================================"
echo "  smoke summary: $PASSES passed, $FAILS failed, $SKIPS skipped"
echo "================================================================"
if [ "$FAILS" -gt 0 ]; then
  echo "RESULT: published-artifact smoke FAILED"; exit 1
fi
echo "RESULT: published-artifact smoke PASSED (@lobu/cli@$RESOLVED)"
