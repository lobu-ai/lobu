#!/usr/bin/env bash
#
# CLI command-coverage smoke gate.
#
# Where scripts/sdk-e2e.sh proves the SDK *lifecycle* (apply -> prune -> worker
# turn -> connector -> automation -> client), THIS gate proves that EVERY `lobu`
# command/subcommand actually RUNS -- argv parses, the handler executes, and a
# representative invocation returns the documented success marker (or, for the
# negative cases, fails gracefully with the documented message instead of a
# crash/stack trace).
#
# It boots ONE local `lobu run` (embedded Postgres + a deterministic mock
# OpenAI-compatible provider, reusing the scripts/sdk-e2e/ harness -- no provider
# key, reproducible in CI) under an ISOLATED $HOME, then walks the whole command
# surface. Unlike sdk-e2e it does NOT fail-fast: it records every miss and exits
# non-zero at the end with a summary, so one run tells you exactly which commands
# are broken.
#
# Commands that genuinely need a browser, a real TTY, or a configured chat
# platform can't be driven unattended -- those are exercised at the "runs +
# fails gracefully" level or logged as SKIP with the reason.
#
# WHAT THIS GATE STRUCTURALLY CANNOT CATCH -- do not assume otherwise.
# LOBU_BIN below points at the SOURCE TREE, which silently pins four things:
#
#   tarball-vs-source   this runs the monorepo, never an `npm install`ed build
#   bun-vs-node         the gateway picks the worker entrypoint by EXTENSION
#                       (gateway/config/index.ts -> src/index.ts in-repo,
#                       dist/index.bundle.mjs installed) and
#                       buildWorkerInvocation spawns .ts under bun, .mjs under
#                       node. In-repo we can only ever take the bun path.
#   root-vs-not         CI runs unprivileged
#   glibc               CI runs a modern-glibc runner
#
# Each of those hid a real shipped bug (#2186, `__filename is not defined`,
# the uid-0 embedded-postgres refusal, the GLIBC_2.38 pgvector floor). Walking
# MORE commands here cannot help: the failing path does not exist in-repo.
# scripts/published-artifact-smoke.sh owns those axes -- it installs from the
# registry and runs a real agent turn as root and non-root, on old and new
# glibc. Add packaging/runtime-environment coverage THERE, command coverage
# HERE.
#
# Kept ASCII-only on purpose: a stray non-ASCII byte hugging a $var expansion is
# swallowed into the variable name under a UTF-8 locale ("unbound variable").
#
# Usage: scripts/cli-smoke.sh
#        CLI_SMOKE_REVOKE_DATABASE_URL=postgres://... scripts/cli-smoke.sh
#
# The main stack always uses embedded Postgres because only that mode performs
# local-init + auto-apply. The optional URL must point at a migrated, disposable
# database and is used solely by `token revoke`; it never becomes the stack's
# DATABASE_URL.
set -uo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$WT/scripts/sdk-e2e"          # reuse the deterministic provider + ICU fix
LOBU_BIN="$WT/packages/cli/bin/lobu.js"
# shellcheck source=scripts/lib/process-cleanup.sh
. "$WT/scripts/lib/process-cleanup.sh"
GW_PORT="${GW_PORT:-8795}"
MOCK_PORT="${MOCK_PORT:-11436}"
MOCK_REPLY="CLI_SMOKE_OK"
RUN_DIR="$WT/.cli-smoke-run"
RUN_LOG="$RUN_DIR/run.log"
MOCK_LOG="$RUN_DIR/mock.log"
OUT="$RUN_DIR/cmd.out"                 # scratch for the most-recent command

# `lobu run` against an external DATABASE_URL intentionally does not create a
# local context or auto-apply. Failing immediately avoids a two-minute timeout
# and, more importantly, prevents this destructive CRUD smoke from touching a
# shared database by accident.
if [ -n "${DATABASE_URL:-}" ]; then
  echo "ABORT: CLI smoke owns an embedded database; use CLI_SMOKE_REVOKE_DATABASE_URL only for token revoke" >&2
  exit 2
fi

# Node 22-24 is required (the worker uses isolated-vm). Prefer a Homebrew
# node@22 locally; CI provides node via actions/setup-node.
if [ -x /opt/homebrew/opt/node@22/bin/node ] && ! node --version 2>/dev/null | grep -qE '^v(22|23|24)\.'; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

# Isolate ALL global CLI state under a throwaway HOME. The CLI reads/writes
# ~/.config/lobu/{config,credentials,threads}.json,
# and the embedded Postgres data dir defaults to ~/.lobu/pgdata. Overriding HOME
# contains every one of those in $RUN_DIR so the gate never clobbers the dev's
# real contexts/login (and gives a fresh DB each run).
export HOME="$RUN_DIR/home"
export LOBU_RUNTIME_CACHE_DIR="$HOME/.cache/lobu/runtime"

MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill -9 "$MOCK_PID" 2>/dev/null || true
  lobu_kill_listening_port "$GW_PORT"
  lobu_kill_listening_port "$MOCK_PORT"
}
trap cleanup EXIT

# ---- Reporting --------------------------------------------------------------
PASSES=0; FAILS=0; SKIPS=0
pass() { echo "  [OK]   $*"; PASSES=$((PASSES + 1)); }
skip() { echo "  [SKIP] $*"; SKIPS=$((SKIPS + 1)); }
note() { echo ""; echo "== $* =="; }
softfail() {
  echo "  [FAIL] $*" >&2
  echo "         -- last 12 lines of output --" >&2
  tail -12 "$OUT" 2>/dev/null | sed 's/^/         /' >&2
  FAILS=$((FAILS + 1))
}
# Hard failure for setup prerequisites -- no point walking commands if the
# server never came up.
die() { echo "ABORT: CLI smoke -- $*" >&2; [ -f "$RUN_LOG" ] && { echo "--- last 40 lines of run.log ---" >&2; tail -40 "$RUN_LOG" >&2; }; exit 1; }

# Run `lobu <args>` in <cwd>, capture combined output to $OUT, set RC to the
# CLI's exit code. errexit is disabled; callers inspect RC explicitly.
RC=0
runlobu() {
  local cwd="$1"; shift
  ( cd "$cwd" && node "$LOBU_BIN" "$@" ) > "$OUT" 2>&1 </dev/null
  RC=$?
}

# expect_grep <desc> <marker> <cwd> <args...>  -> exit 0 AND <marker> present
expect_grep() {
  local desc="$1" marker="$2" cwd="$3"; shift 3
  runlobu "$cwd" "$@"
  if [ "$RC" -eq 0 ] && grep -qF -- "$marker" "$OUT"; then pass "$desc"
  else softfail "$desc (exit=$RC, missing marker: $marker) [lobu $*]"; fi
}

# expect_ok <desc> <cwd> <args...>  -> exit 0 (no marker)
expect_ok() {
  local desc="$1" cwd="$2"; shift 2
  runlobu "$cwd" "$@"
  if [ "$RC" -eq 0 ]; then pass "$desc"
  else softfail "$desc (exit=$RC) [lobu $*]"; fi
}

# expect_fail_grep <desc> <marker> <cwd> <args...>  -> graceful failure:
# non-zero exit AND the documented error message present (no crash/stack trace).
expect_fail_grep() {
  local desc="$1" marker="$2" cwd="$3"; shift 3
  runlobu "$cwd" "$@"
  if [ "$RC" -ne 0 ] && grep -qiF -- "$marker" "$OUT"; then pass "$desc (graceful: $marker)"
  else softfail "$desc (expected non-zero exit + '$marker', got exit=$RC) [lobu $*]"; fi
}

# expect_grep_absent <desc> <present> <absent> <cwd> <args...>  -> succeeds, and
# the output carries <present> but NOT <absent>. The positive half is required:
# without it a command that produced nothing at all would pass vacuously.
expect_grep_absent() {
  local desc="$1" present="$2" absent="$3" cwd="$4"; shift 4
  runlobu "$cwd" "$@"
  if [ "$RC" -eq 0 ] && grep -qF -- "$present" "$OUT" \
     && ! grep -qF -- "$absent" "$OUT"; then pass "$desc"
  else softfail "$desc (exit=$RC, want '$present' without '$absent') [lobu $*]"; fi
}

# expect_exit <desc> <code> <cwd> <args...>  -> exact exit code
expect_exit() {
  local desc="$1" code="$2" cwd="$3"; shift 3
  runlobu "$cwd" "$@"
  if [ "$RC" -eq "$code" ]; then pass "$desc (exit $code)"
  else softfail "$desc (expected exit $code, got $RC) [lobu $*]"; fi
}

echo ">> node $(node --version), gateway :$GW_PORT, mock :$MOCK_PORT, HOME=$HOME"
rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR" "$HOME"
cleanup  # free ports from any prior run

# 0) Embedded-PG ICU shims on Linux (no-op on macOS). See sdk-e2e.sh step 0.
node "$HARNESS/fix-embedded-pg-icu.mjs" || die "could not prepare embedded-postgres ICU symlinks"

# 1) Deterministic mock OpenAI-compatible provider.
MOCK_PORT="$MOCK_PORT" MOCK_REPLY="$MOCK_REPLY" node "$HARNESS/mock-openai.mjs" > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
disown "$MOCK_PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 || die "mock server did not come up"

# The mock provider lives on $MOCK_PORT, but the shared harness providers.json
# hardcodes 11434. Rewrite a copy so the registry points at our port.
PROVIDERS="$RUN_DIR/providers.json"
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const port=process.argv[2];for(const grp of j.providers||[])for(const sub of grp.providers||[])if(sub.upstreamBaseUrl)sub.upstreamBaseUrl=sub.upstreamBaseUrl.replace(/:\d+/,":"+port);fs.writeFileSync(process.argv[3],JSON.stringify(j,null,2))' "$HARNESS/providers.json" "$MOCK_PORT" "$PROVIDERS"
export LOBU_PROVIDER_REGISTRY_PATH="$PROVIDERS"

# ============================================================================
# STATIC COMMANDS (no server needed)
# ============================================================================
note "top-level"
VERSION="$(node "$LOBU_BIN" --version 2>/dev/null | tr -d '[:space:]')"
expect_grep "lobu --version" "$VERSION" "$WT" --version
expect_grep "lobu --help" "CLI for deploying and managing AI agents on Lobu" "$WT" --help
expect_exit "lobu <unknown-command> -> usage error" 1 "$WT" definitely-not-a-command
expect_fail_grep "lobu environment -> renamed sandbox" "renamed to lobu sandbox" "$WT" environment list

note "init / validate / doctor / telemetry / agent scaffold (static)"
expect_grep "lobu init --list-providers" "--provider" "$WT" init --list-providers

# Scaffold the project we'll boot. Mirror sdk-e2e: scaffold, drop package.json
# so jiti resolves the workspace @lobu/cli/config, then overwrite the config to
# point the agent at the deterministic mock provider.
#
# node_modules/bun.lock must go for the same reason as package.json: `lobu
# init` runs `bun install`, which plants the *published* @lobu/connector-sdk
# in $PROJ/node_modules. Compiled connector bundles are staged under cwd
# ($PROJ here), so their externalized bare `@lobu/connector-sdk` import would
# resolve that stale npm copy instead of the workspace dist under test --
# making the runtime-self-check fail for any in-repo connector that uses an
# SDK export newer than the last npm release (#1222).
PROJ="$RUN_DIR/proj"; mkdir -p "$PROJ"
expect_grep "lobu init . --here" "Lobu initialized" "$PROJ" init . -y --here --provider gemini
rm -rf "$PROJ/package.json" "$PROJ/node_modules" "$PROJ/bun.lock"
# The `invoice` type carries write rules. `rulesFromFile` ships the file's RAW
# source with the apply; the server compiles it and runs it at the entity write
# seam. Declaring it HERE (rather than in a project applied later) is deliberate
# -- the boot auto-apply below is the same path a user takes, so a rule that
# fails to resolve, compile, or round-trip breaks the boot loudly instead of
# being discovered by a bespoke invocation nobody ships.
#
# Hyphen-free single-word key on purpose: entity-type keys containing `_` are
# slugified server-side but diffed verbatim by the CLI, so they never converge.
mkdir -p "$PROJ/rules"
cat > "$PROJ/rules/invoice.ts" <<'TS'
// An invoice is born in draft. `op === "create"` is the branch that only exists
// because creates reach the seam too -- without it this rule would govern edits
// while leaving "create it already posted" wide open.
export default (row) => {
  if (row.op === "create" && row.next.status !== "draft") {
    row.deny("an invoice is created in draft, not " + row.next.status);
  }
};
TS
cat > "$PROJ/lobu.config.ts" <<'TS'
import { defineAgent, defineConfig, defineEntityType, rulesFromFile, secret } from "@lobu/cli/config";

const echo = defineAgent({
  id: "echo", name: "Echo", dir: "./agents/echo",
  providers: [{ id: "mock", model: "mock-model", key: secret("MOCK_API_KEY") }],
});
const note = defineEntityType({ key: "note", name: "Note" });
const invoice = defineEntityType({
  key: "invoice", name: "Invoice",
  properties: { status: { type: "string" } },
  rules: rulesFromFile("./rules/invoice.ts"),
});

export default defineConfig({ agents: [echo], entities: [note, invoice] });
TS

expect_grep "lobu validate" "is valid" "$PROJ" validate

# Negative: a syntactically broken config must be rejected (non-zero), not crash.
BADPROJ="$RUN_DIR/badproj"; mkdir -p "$BADPROJ"
printf 'import { defineConfig } from "@lobu/cli/config";\nexport default defineConfig({ agents: [ }\n' > "$BADPROJ/lobu.config.ts"
expect_exit "lobu validate (broken config -> non-zero)" 1 "$BADPROJ" validate

# The smoke always owns embedded Postgres, so doctor must recognize that
# backend and must not report a spurious connection failure.
runlobu "$PROJ" doctor
if grep -qiE "connect failed|ENOTFOUND" "$OUT"; then
  softfail "lobu doctor false-failed the DB check (lobu doctor)"
elif ! grep -qF "embedded Postgres" "$OUT"; then
  softfail "lobu doctor did not recognize the embedded Postgres backend"
else
  pass "lobu doctor (DB check healthy)"
fi

expect_grep "lobu telemetry status" "Telemetry:" "$PROJ" telemetry status
expect_grep "lobu telemetry (default status)" "Telemetry:" "$PROJ" telemetry
expect_grep "lobu telemetry on" "Telemetry enabled" "$PROJ" telemetry on
expect_grep "lobu telemetry status (now on)" "Telemetry: on" "$PROJ" telemetry status
expect_grep "lobu telemetry off" "Telemetry disabled" "$PROJ" telemetry off

expect_grep "lobu agent scaffold (local)" "Scaffolded agent" "$PROJ" agent scaffold helper --name Helper
expect_fail_grep "lobu agent scaffold (dup -> graceful)" "already exists" "$PROJ" agent scaffold helper

note "context (local config CRUD)"
expect_grep "lobu context list" "contexts" "$PROJ" context list
expect_grep "lobu context current" "context" "$PROJ" context current
expect_grep "lobu context add" "Saved context" "$PROJ" context add smoke-ctx --url "http://localhost:$GW_PORT"
expect_grep "lobu context use" "Switched to context smoke-ctx" "$PROJ" context use smoke-ctx
expect_grep "lobu context rm" "Removed context smoke-ctx" "$PROJ" context rm smoke-ctx

note "connector runtime-self-check (CI smoke gate, no server)"
expect_ok "lobu connector runtime-self-check --json" "$PROJ" connector runtime-self-check --json

note "apply --only validation (no server)"
expect_exit "lobu apply --only bogus -> exit 2" 2 "$PROJ" apply --only bogus

# ============================================================================
# Boot the embedded stack (auto-applies the project -> registers `local` ctx)
# ============================================================================
note "boot: lobu run --port $GW_PORT"
{
  printf '\n'
  echo "MOCK_API_KEY=mock-key-smoke"
  echo "WORKER_ALLOWED_DOMAINS=127.0.0.1,localhost"
  echo "LOBU_DISABLE_SYSTEMD_RUN=1"
} >> "$PROJ/.env"

( cd "$PROJ" && node "$LOBU_BIN" run --port "$GW_PORT" > "$RUN_LOG" 2>&1 ) &
# Wait on the auto-apply markers only -- "api docs:" prints BEFORE the project
# auto-applies, so breaking on it would race the apply (see sdk-e2e.sh).
for _ in $(seq 1 120); do
  grep -qiE "Apply complete|auto-apply skipped|Apply halted" "$RUN_LOG" 2>/dev/null && break
  sleep 1
done
grep -qi "Apply complete" "$RUN_LOG" || die "lobu run did not auto-apply (skipped/halted?)"
pass "lobu run booted + auto-applied the project"

# The two compatibility aliases must reach the same run handler. Point them at
# the already-listening gateway port: a controlled "already in use" failure
# proves argv dispatch without booting two extra stacks.
expect_fail_grep "lobu dev alias -> run handler" "already in use" "$PROJ" dev --port "$GW_PORT"
expect_fail_grep "lobu start alias -> run handler" "already in use" "$PROJ" start --port "$GW_PORT"

# Trigger loopback auth (local-init) + resolve the bootstrap org slug.
runlobu "$PROJ" whoami -c local
ORG="$( ( cd "$PROJ" && node "$LOBU_BIN" org current -c local 2>/dev/null ) | grep -oE '[a-z0-9][a-z0-9-]*' | grep -vE '^local$|^org$|^for$|^context$|^current$|^no$|^active$|^set$' | tail -1 )"
[ -n "$ORG" ] || die "could not resolve the local org slug (lobu org current -c local)"
echo ">> resolved local org: $ORG"

# ============================================================================
# SERVER-BACKED COMMANDS (loopback `local` context, auto-authed via local-init)
# ============================================================================
note "identity / status / token"
expect_grep "lobu whoami -c local" "Context" "$PROJ" whoami -c local
runlobu "$PROJ" whoami --json -c local
if [ "$RC" -eq 0 ] && grep -q '"loggedIn":true' "$OUT" && grep -q '"workerToken"' "$OUT"; then
  pass "lobu whoami --json (loggedIn + workerToken)"
else
  softfail "lobu whoami --json (exit=$RC, missing loggedIn/workerToken)"
fi
expect_grep "lobu status -c local" "API:" "$PROJ" status -c local
expect_grep "lobu token -c local" "Token" "$PROJ" token -c local
runlobu "$PROJ" token -c local --raw
{ [ "$RC" -eq 0 ] && [ -s "$OUT" ]; } && pass "lobu token --raw (non-empty)" || softfail "lobu token --raw produced no token (exit=$RC)"
expect_grep "lobu token create -c local" "created" "$PROJ" token create -c local --scope "mcp:read mcp:write" --name smoke-token

# token revoke directly inserts into an EXTERNAL Postgres. Keep that URL
# separate from the embedded server so the main smoke remains self-contained.
if [ -n "${CLI_SMOKE_REVOKE_DATABASE_URL:-}" ]; then
  ( cd "$PROJ" && DATABASE_URL="$CLI_SMOKE_REVOKE_DATABASE_URL" node "$LOBU_BIN" token revoke cli-smoke-jti --expires-at 2099-01-01T00:00:00Z ) > "$OUT" 2>&1 </dev/null; RC=$?
  { [ "$RC" -eq 0 ] && grep -qiF "Token revoked" "$OUT"; } && pass "lobu token revoke (external PG)" || softfail "lobu token revoke (expected successful insert, exit=$RC)"
else
  ( cd "$PROJ" && env -u DATABASE_URL node "$LOBU_BIN" token revoke smoke-jti ) > "$OUT" 2>&1 </dev/null; RC=$?
  { [ "$RC" -ne 0 ] && grep -qiF "DATABASE_URL is not set" "$OUT"; } && pass "lobu token revoke (graceful: needs external PG)" || softfail "lobu token revoke (expected 'DATABASE_URL is not set', exit=$RC)"
fi

note "org"
expect_grep "lobu org list -c local" "rganization" "$PROJ" org list -c local
expect_grep "lobu org current -c local" "org" "$PROJ" org current -c local
expect_grep "lobu org set -c local" "set to" "$PROJ" org set "$ORG" -c local

note "agent CRUD (REST)"
expect_grep "lobu agent list -c local" "echo" "$PROJ" agent list -c local
expect_grep "lobu agent create -c local" "Created agent" "$PROJ" agent create smoke-agent -c local --name "Smoke Agent"
expect_grep "lobu agent get -c local" "smoke-agent" "$PROJ" agent get smoke-agent -c local
expect_grep "lobu agent update -c local" "Updated agent" "$PROJ" agent update smoke-agent -c local --name "Smoke Agent v2"
expect_fail_grep "lobu agent update (no flags -> graceful)" "at least one" "$PROJ" agent update smoke-agent -c local
# config get --output, then round-trip that config back through patch (always valid).
expect_grep "lobu agent config get --output -c local" "Wrote" "$PROJ" agent config get smoke-agent -c local --output "$RUN_DIR/agent-config.json"
expect_grep "lobu agent config patch -c local" "Updated config" "$PROJ" agent config patch smoke-agent -c local --file "$RUN_DIR/agent-config.json"
expect_fail_grep "lobu agent delete (no --yes -> graceful)" "Refusing to delete" "$PROJ" agent delete smoke-agent -c local
expect_grep "lobu agent delete --yes -c local" "Deleted agent" "$PROJ" agent delete smoke-agent -c local --yes

note "call (generic admin REST dispatcher)"
expect_grep "lobu call --list -c local" "tool(s)" "$PROJ" call --list -c local
expect_ok "lobu call manage_feeds list_feeds -c local" "$PROJ" call manage_feeds -c local --arg "action=list_feeds"

note "init --from-org (bootstrap a re-appliable project from a live org)"
# init takes no -c flag; it uses the active context (local-init switched it to
# `local`) + --url to pin the server. Scaffolds into $RUN_DIR/fromorg.
rm -rf "$RUN_DIR/fromorg"
( cd "$RUN_DIR" && node "$LOBU_BIN" init fromorg -y --from-org "$ORG" --url "http://localhost:$GW_PORT" ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && [ -f "$RUN_DIR/fromorg/lobu.config.ts" ]; } && pass "lobu init --from-org (scaffolded from live org)" || softfail "lobu init --from-org (exit=$RC, no lobu.config.ts written)"

note "link / unlink (project-level)"
expect_grep "lobu link -c local" "linked" "$PROJ" link -c local --org "$ORG"
expect_grep "lobu unlink" "unlinked" "$PROJ" unlink

note "apply (dry-run + real, against the live server)"
( cd "$PROJ" && MOCK_API_KEY=mock-key-smoke node "$LOBU_BIN" apply --dry-run --url "http://localhost:$GW_PORT" ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && grep -qiF "Dry run" "$OUT"; } && pass "lobu apply --dry-run" || softfail "lobu apply --dry-run (expected 'Dry run', exit=$RC)"
( cd "$PROJ" && MOCK_API_KEY=mock-key-smoke node "$LOBU_BIN" apply --only agents --yes --url "http://localhost:$GW_PORT" ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && grep -qiE "Apply complete|Nothing to apply|Provider keys applied" "$OUT"; } && pass "lobu apply --only agents --yes" || softfail "lobu apply --only agents (expected complete/noop, exit=$RC)"
expect_grep "lobu deploy alias --dry-run" "Dry run" "$PROJ" deploy --dry-run --url "http://localhost:$GW_PORT"

note "entity write rules (rulesFromFile -> apply -> compiled -> enforced)"
# The boot auto-apply shipped rules/invoice.ts as raw source. Unit tests cover
# each half separately -- the CLI resolving the marker, the server executing a
# compiled rule -- but only a live apply proves the halves agree on the wire.
# Everything below runs against the SAME rule the boot shipped.

# Enforcement. The rule's OWN reason has to come back: a generic 400 (or a
# success) would mean the source shipped but never ran.
expect_fail_grep "write rule denies an illegal create" "an invoice is created in draft, not posted" \
  "$PROJ" call manage_entity -c local --arg "action=create" --arg "entity_type=invoice" \
  --arg "name=INV-SMOKE-BAD" --arg 'metadata:={"status":"posted"}'

# Contrast, and it is load-bearing: without it a rule that denied EVERY create
# -- or an entity type that failed to apply at all -- would pass the case above.
expect_ok "write rule permits the legal create" \
  "$PROJ" call manage_entity -c local --arg "action=create" --arg "entity_type=invoice" \
  --arg "name=INV-SMOKE-OK" --arg 'metadata:={"status":"draft"}'

# Idempotence. The diff compares rule SOURCE text against what the server stored,
# so any normalization difference between send and store shows up as an
# entity-type that can never converge -- re-applying forever, which is exactly
# how underscore entity-type keys behave. `=` is the noop verb.
( cd "$PROJ" && MOCK_API_KEY=mock-key-smoke node "$LOBU_BIN" apply --dry-run --url "http://localhost:$GW_PORT" ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && grep -qF "= entity-type invoice" "$OUT"; } && pass "re-apply of an unchanged rule is a noop" || softfail "re-apply of an unchanged rule (expected '= entity-type invoice', exit=$RC)"

note "rollback (restore snapshot + pause/resume promotions)"
# The apply above records a self-contained deployment snapshot. Resolve its id
# through the same authenticated local API a Deployments UI reads, drift the
# managed agent name, then prove `lobu rollback` restores it and pauses future
# applies until the explicit --resume acknowledgement.
PAT="$( ( cd "$PROJ" && node "$LOBU_BIN" token -c local --raw 2>/dev/null ) | tr -d '[:space:]' )"
DEPLOYMENTS_JSON="$(curl -fsS -H "authorization: Bearer $PAT" -H "x-lobu-org: $ORG" "http://localhost:$GW_PORT/api/$ORG/deployments?limit=20" 2>/dev/null || true)"
ROLLBACK_APPLY_ID="$(printf '%s' "$DEPLOYMENTS_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const x=(j.items||[]).find(i=>i.type==="deployment"&&i.status==="succeeded"&&i.applyId);process.stdout.write(x?.applyId||"")}catch{}})')"
if [ -n "$ROLLBACK_APPLY_ID" ]; then
  expect_grep "rollback setup: drift managed agent" "Updated agent" "$PROJ" agent update echo -c local --name "Echo Drifted"
  expect_grep "lobu rollback --yes" "Rollback complete" "$PROJ" rollback "$ROLLBACK_APPLY_ID" --yes --org "$ORG" --url "http://localhost:$GW_PORT"
  expect_grep "lobu rollback restored snapshot" '"name": "Echo"' "$PROJ" agent get echo -c local
  expect_fail_grep "lobu apply respects rollback pause" "Deployments are paused" "$PROJ" apply --yes --url "http://localhost:$GW_PORT"
  ( cd "$PROJ" && MOCK_API_KEY=mock-key-smoke node "$LOBU_BIN" apply --resume --yes --url "http://localhost:$GW_PORT" ) > "$OUT" 2>&1 </dev/null; RC=$?
  { [ "$RC" -eq 0 ] && grep -qF "Resumed deployments" "$OUT"; } && pass "lobu apply --resume clears rollback pause" || softfail "lobu apply --resume (expected pause clear, exit=$RC)"
else
  softfail "lobu rollback setup (no succeeded deployment snapshot found)"
fi

note "providers (org inference-provider CRUD)"
export CLI_SMOKE_PROVIDER_KEY="smoke-provider-key"
expect_grep "lobu providers catalog -c local" "Available provider kinds" "$PROJ" providers catalog -c local
expect_grep "lobu providers list -c local" "mock" "$PROJ" providers list -c local
expect_grep "lobu providers create -c local" "Created provider smoke-provider" "$PROJ" providers create smoke-provider --kind mock --key '$CLI_SMOKE_PROVIDER_KEY' --model mock-model -c local
expect_grep "lobu providers update -c local" "Renamed provider smoke-provider" "$PROJ" providers update smoke-provider --name "Smoke Provider" -c local
expect_grep "lobu providers set-key -c local" "Rotated API key" "$PROJ" providers set-key smoke-provider --key '$CLI_SMOKE_PROVIDER_KEY' -c local
expect_grep "lobu providers set-capability -c local" "Updated text capabilities" "$PROJ" providers set-capability smoke-provider text --model mock-model --base-url "https://api.example.test/v1" -c local
expect_grep "lobu providers set-default -c local" "org default" "$PROJ" providers set-default smoke-provider -c local
expect_fail_grep "lobu providers delete (no --yes -> graceful)" "Refusing to delete" "$PROJ" providers delete smoke-provider -c local
expect_grep "lobu providers delete --yes -c local" "Deleted provider smoke-provider" "$PROJ" providers delete smoke-provider --yes -c local
unset CLI_SMOKE_PROVIDER_KEY

note "sandbox (runtime-provider CRUD)"
expect_grep "lobu sandbox list -c local" "builtin" "$PROJ" sandbox list -c local
runlobu "$PROJ" sandbox create smoke-sandbox --provider vercel --json -c local
SANDBOX_ID="$(node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.id||"")}catch{}' "$OUT")"
if [ "$RC" -eq 0 ] && [ -n "$SANDBOX_ID" ]; then
  pass "lobu sandbox create -c local"
  expect_grep "lobu sandbox set-credential -c local" "Updated credential" "$PROJ" sandbox set-credential "$SANDBOX_ID" --credential token=smoke-token --credential teamId=smoke-team --credential projectId=smoke-project -c local
  expect_grep "lobu sandbox list shows created row" "smoke-sandbox" "$PROJ" sandbox list -c local
  expect_fail_grep "lobu sandbox delete (no --yes -> graceful)" "Refusing to delete" "$PROJ" sandbox delete "$SANDBOX_ID" -c local
  expect_grep "lobu sandbox delete --yes -c local" "Deleted sandbox" "$PROJ" sandbox delete "$SANDBOX_ID" --yes -c local
else
  softfail "lobu sandbox create -c local (exit=$RC, no id returned)"
fi

note "clients (connected-client inventory + fail-closed revoke)"
expect_ok "lobu clients list -c local" "$PROJ" clients list -c local
expect_ok "lobu clients list --agent -c local" "$PROJ" clients list --agent echo -c local
expect_fail_grep "lobu clients revoke (no --yes -> graceful)" "Refusing to revoke" "$PROJ" clients revoke smoke-missing-client -c local
expect_fail_grep "lobu clients revoke --yes (missing -> graceful 404)" "Client not found" "$PROJ" clients revoke smoke-missing-client --yes -c local

note "chat (a real worker turn through the mock provider)"
( cd "$PROJ" && timeout 90 node "$LOBU_BIN" chat "say the safe word" -c local --json ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && grep -qiF "complete" "$OUT"; } && pass "lobu chat --json (complete event)" || softfail "lobu chat --json (expected a 'complete' event, exit=$RC)"
( cd "$PROJ" && timeout 90 node "$LOBU_BIN" chat "again" -c local --new ) > "$OUT" 2>&1 </dev/null; RC=$?
{ [ "$RC" -eq 0 ] && grep -qF "$MOCK_REPLY" "$OUT"; } && pass "lobu chat --new (mock reply)" || softfail "lobu chat --new (expected reply $MOCK_REPLY, exit=$RC)"
( cd "$PROJ" && timeout 90 node "$LOBU_BIN" chat "dry" -c local --dry-run ) > "$OUT" 2>&1 </dev/null; RC=$?
[ "$RC" -eq 0 ] && pass "lobu chat --dry-run" || softfail "lobu chat --dry-run (exit=$RC)"
( cd "$PROJ" && timeout 90 node "$LOBU_BIN" chat "more" -c local -C ) > "$OUT" 2>&1 </dev/null; RC=$?
[ "$RC" -eq 0 ] && pass "lobu chat -C/--continue" || softfail "lobu chat --continue (exit=$RC)"

note "memory MCP"
expect_grep "lobu memory health -c local" "ok: true" "$PROJ" memory health -c local
expect_grep "lobu memory run (list tools) -c local" "tool(s)" "$PROJ" memory run -c local
expect_grep "lobu memory org current -c local" "org:" "$PROJ" memory org current -c local
expect_grep "lobu memory org set -c local" "memory org" "$PROJ" memory org set "$ORG" -c local
# memory seed needs a config with `org` set -- use a dedicated minimal project.
SEEDPROJ="$RUN_DIR/seedproj"; mkdir -p "$SEEDPROJ"
# It declares `member_of` on purpose: that slug is platform-owned, and seeding
# it would 409-then-403 against a server that classifies it as
# authorization-bearing. Seed must skip it while still seeding ordinary types.
cat > "$SEEDPROJ/lobu.config.ts" <<TS
import {
  defineConfig,
  defineEntityType,
  defineRelationshipType,
} from "@lobu/cli/config";
const note = defineEntityType({ key: "note", name: "Note" });
const mentions = defineRelationshipType({ key: "mentions", name: "Mentions" });
const memberOf = defineRelationshipType({ key: "member_of", name: "Member of" });
export default defineConfig({
  org: "$ORG",
  agents: [],
  entities: [note],
  relationships: [mentions, memberOf],
});
TS
expect_grep "lobu memory seed --dry-run" "Dry run" "$SEEDPROJ" memory seed --dry-run -c local
expect_grep_absent "lobu memory seed skips platform-owned member_of" \
  "relationship_type: mentions" "relationship_type: member_of" \
  "$SEEDPROJ" memory seed --dry-run -c local
# memory exec -- run a trivial ClientSDK script.
echo 'export default async () => "cli-smoke-exec-ok";' > "$RUN_DIR/exec.ts"
expect_ok "lobu memory exec (ClientSDK script)" "$PROJ" memory exec "$RUN_DIR/exec.ts" -c local
# connect -- wire a local MCP client to the memory MCP URL. Cursor's config is
# a deterministic file write under the isolated HOME, with no external process
# or browser handoff. Authentication belongs to the client on first use.
( cd "$PROJ" && timeout 30 node "$LOBU_BIN" connect cursor --url "http://localhost:$GW_PORT/mcp" ) > "$OUT" 2>&1 </dev/null; RC=$?
[ "$RC" -eq 0 ] && pass "lobu connect cursor --url" || softfail "lobu connect cursor (exit=$RC)"
expect_grep "lobu doctor --memory-only" "ok: true" "$PROJ" doctor --memory-only

note "login / logout (round-trip on a throwaway loopback context)"
PAT="$( ( cd "$PROJ" && node "$LOBU_BIN" token -c local --raw 2>/dev/null ) | tr -d '[:space:]' )"
expect_grep "lobu context add (for login)" "Saved context" "$PROJ" context add smoke-login --url "http://localhost:$GW_PORT"
if [ -n "$PAT" ]; then
  expect_grep "lobu login --token" "Logged in" "$PROJ" login --token "$PAT" -c smoke-login
else
  skip "lobu login --token -- could not mint a PAT to log in with"
fi
expect_grep "lobu logout -c smoke-login" "Logged out" "$PROJ" logout -c smoke-login
expect_grep "lobu context rm smoke-login" "Removed context" "$PROJ" context rm smoke-login
# Device-code login on a fresh (unauthed) context with no TTY must bail cleanly
# -- the same graceful headless path `lobu login`/--quiet takes in CI. Use a
# FRESH context: `local` is already authed (local-init) and would short-circuit.
runlobu "$PROJ" context add smoke-empty --url "http://localhost:$GW_PORT"
expect_fail_grep "lobu login (non-interactive device-code -> graceful bail)" "interactive terminal" "$PROJ" login -c smoke-empty
runlobu "$PROJ" context rm smoke-empty

note "retired external browser commands"
expect_fail_grep "lobu connector run is retired" "unknown command" "$PROJ" connector run
expect_fail_grep "lobu memory browser-auth is retired" "unknown command" "$PROJ" memory browser-auth

note "browser/interactive paths -- not unattended-runnable"
skip "lobu login (interactive device-code happy path) -- needs a real TTY; --token + non-interactive bail covered above"
skip "lobu org create -- opens a browser to /orgs/new"
skip "lobu chat --user platform:id -- needs a configured Telegram/Slack connection"

# ============================================================================
echo ""
echo "================================================================"
echo "  CLI smoke summary: $PASSES passed, $FAILS failed, $SKIPS skipped"
echo "================================================================"
if [ "$FAILS" -gt 0 ]; then
  echo "RESULT: CLI smoke FAILED ($FAILS command(s) broken)"; exit 1
fi
echo "RESULT: CLI smoke PASSED -- every runnable command works"
