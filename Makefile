# Development Makefile for Lobu

.PHONY: help setup build test clean ctx land sandbox sandbox-sync sandbox-url sandbox-logs sandbox-run sandbox-stop sandbox-ls dev dev-db dev-embedded build-packages ensure-submodule clean-workers clean-test-pg test-unit test-integration test-e2e-sdk test-e2e-agent-turn test-e2e-cli test-providers-live typecheck task-setup task-clean dev-recover clean-merged e2e-browser bump review review-fix ui-review pre-pr pr-fast pr-full owletto-mac owletto-mac-e2e

# Default target
help:
	@echo "Available commands:"
	@echo "  make ctx [BASE=<ref>] [NOFETCH=1]          - One-call worktree context: branch, tree, changed-vs-base file list, commits, submodule, PR + required-check gaps"
	@echo "  make land [N=<pr>] [CHECK_ONLY=1]          - Wait for CI, verify the FULL branch-protection required list, then squash-merge (refuses while a required check has not reported)"
	@echo "  make setup                                 - Setup development environment (run once)"
	@echo "  make dev [NAME=<x>] [FROM=<db>] [OPEN=1]   - Local dev (brew Postgres@18); prints App URL; OPEN=1 opens it in the system browser after boot"
	@echo "  make dev-embedded                          - Dev against the zero-dependency embedded per-worktree Postgres (the lobu run / CI runtime); == LOBU_EMBEDDED=1 make dev"
	@echo "  make build-packages                        - Build all TypeScript packages"
	@echo "  make test                                  - Run test bot"
	@echo "  make test-unit                             - Run the CI unit suite (no Postgres needed)"
	@echo "  make test-integration                      - Run the CI integration suite (needs DATABASE_URL with pgvector)"
	@echo "  make test-e2e-cli                          - Boot lobu run + walk every CLI command (the CI sdk-cli-e2e job)"
	@echo "  make test-providers-live                   - Validate every provider against its live API (keyless tier + key-gated smoke)"
	@echo "  make clean-workers                         - Stop orphaned gateway processes from a crashed dev run"
	@echo "  make dev-recover [RESTART=1]               - Free this checkout's dev ports + clean workers; RESTART=1 also boots make dev"
	@echo "  make clean-test-pg                         - Reap orphaned lobu-test-pg embedded-Postgres clusters (frees macOS shm slots)"
	@echo "  make typecheck                             - Strict typecheck (same as Dockerfile) for server + owletto"
	@echo "  make task-setup NAME=<name> [CONTEXT=1]    - Create a paired worktree at .claude/worktrees/<name> (lobu + submodule, .env/ports; CONTEXT=1 registers Lobu CLI context)"
	@echo "  make task-clean NAME=<name> [FORCE=1]      - Remove the worktree, both branches, and the Lobu context (refuses if there's uncommitted/unpushed work unless FORCE=1)"
	@echo "  make e2e-browser [RESTART=1]               - Launch/reuse the stable 'owletto' Chrome harness (extension from this worktree) for Chrome e2e"
	@echo "  make bump SUBMODULE=<path> [TARGET=<ref>] [ARTIFACT=<url>] - Lightweight pointer PR + required statuses (skips bun install, .env, ports)"
	@echo "  make review [BASE=<branch>]                - Run the cross-harness LLM reviewer against the local diff (deterministic suites run in CI); posts pi-review status and PR comment"
	@echo "  make review-fix [BASE=<branch>]            - Pre-review fixer: reviewer CLI with write access fixes review-grade findings in the tree; posts nothing"
	@echo "  make ui-review [ARTIFACT=<https-url>]       - Record Owletto UI proof; complete forward pointer diffs touching no hosted surface pass as not applicable; OPEN=1 opens the merged PR"
	@echo "  make sandbox                                - Boot/refresh this worktree's remote Daytona dev stack (server + its own Postgres) and print the preview URL"
	@echo "  make sandbox-sync                           - Push the working tree to the sandbox without restarting the app"
	@echo "  make sandbox-run CMD='<cmd>'                - Run a command (build, test suite) inside the sandbox instead of on this Mac"
	@echo "  make sandbox-logs / sandbox-url             - Tail the sandbox app log / print its preview URL"
	@echo "  make sandbox-stop                           - Stop the sandbox (frees the running-memory quota; disk and database survive)"
	@echo "  make sandbox-ls                             - List every lobu sandbox with its state and the quota headroom"
	@echo "  make pre-pr                                 - Local fast gates before push, minus what the commit hook already runs (GitHub CI is the canonical gate)"
	@echo "  make pr-fast                                - Optional: broad Linux merge jobs (Daytona sandbox, else local)"
	@echo "  make pr-full [REMOTE_JOBS='unit …']        - Optional: full Linux CI (Daytona sandbox, else local)"
	@echo "  make owletto-mac [INSTALL=1] [OPEN=1]      - Build Lobu.app with the Developer ID identity (TCC grants match the notarized release); INSTALL=1 replaces /Applications/Lobu.app, OPEN=1 launches it"
	@echo "  make owletto-mac-e2e ORG=<slug> CONN_ID=<id> [SKIP_BUILD=1] - Build/install the signed Lobu.app then probe prod computer_use (permissions + list_windows) via the paired device connection"

# Strict typecheck — mirrors the Dockerfile so local matches CI. Catches
# what `build-packages` (relaxed, bundler-only) misses.
typecheck:
	@echo "🔎 Strict typecheck: packages/server..."
	@( cd packages/server && bunx tsc --noEmit ) || exit $$?
	@if [ -d packages/owletto/src ]; then \
		echo "🔎 Strict typecheck: packages/owletto..."; \
		( cd packages/owletto && bunx tsc -b --noEmit ) || exit $$?; \
	fi
	@echo "✅ Typecheck clean."

# Build all TypeScript packages in dependency-aware parallel layers.
build-packages:
	@node scripts/build-packages.mjs

# Ensure packages/owletto is initialized; warn on drift but don't auto-fix
# (drift may be active feature-branch work — clobbering it silently is worse than the warning).
ensure-submodule:
	@status=$$(git submodule status packages/owletto 2>/dev/null || true); \
	case "$$status" in \
		'-'*) echo ">> owletto submodule not initialized — running git submodule update --init --recursive"; \
		      git submodule update --init --recursive packages/owletto ;; \
		'+'*) echo ">> WARNING: packages/owletto is at a different SHA than the parent pin:"; \
		      echo "   $$status"; \
		      echo "   If this is unintentional, run: git submodule update packages/owletto" ;; \
		*) ;; \
	esac

# Local dev against the shared brew Postgres@18 (via dev-db.sh: one database per
# branch). This is the default because a single long-lived postmaster avoids the
# embedded per-worktree clusters whose kill-9 churn leaks SysV shm anchors into
# macOS's shmmni=32 cap. `LOBU_EMBEDDED=1 make dev` (or `make dev-embedded`) runs
# the zero-dependency embedded cluster instead — the `lobu run` / CI runtime.
dev: ensure-submodule
	@if [ -n "$$LOBU_EMBEDDED" ] && [ "$$LOBU_EMBEDDED" != "0" ]; then \
		./scripts/dev-native.sh; \
	else \
		NAME="$(NAME)" FROM="$(FROM)" PORT="$(PORT)" WORKER_PROXY_PORT="$(WORKER_PROXY_PORT)" PGHOST="$(PGHOST)" PGPORT="$(PGPORT)" PGUSER="$(PGUSER)" ./scripts/dev-db.sh; \
	fi

# Zero-dependency embedded per-worktree Postgres (the lobu run / CI runtime).
dev-embedded: ensure-submodule
	@./scripts/dev-native.sh

# Explicit alias for the default `make dev` backend (shared brew Postgres@18, one
# database per branch). NAME defaults to the current branch; FROM=<db> forks an
# existing dataset for a disposable preview.
#   make dev-db NAME=sidebar
#   make dev-db NAME=preview FROM=owletto_local
#   make dev-db NAME=sidebar PORT=8931 WORKER_PROXY_PORT=8131
dev-db: ensure-submodule
	@NAME="$(NAME)" FROM="$(FROM)" PORT="$(PORT)" WORKER_PROXY_PORT="$(WORKER_PROXY_PORT)" PGHOST="$(PGHOST)" PGPORT="$(PGPORT)" PGUSER="$(PGUSER)" ./scripts/dev-db.sh

# Setup development environment (run once)
setup:
	@./scripts/setup-dev.sh

# Run test bot
test:
	@./scripts/test-bot.sh "@me test from make command"

# --- Task worktrees ---------------------------------------------------------
# Paired-branch worktrees for parallel work without losing changes to the
# packages/owletto submodule. See scripts/task-setup.sh header for details
# (the script also documents an optional `task-start` shell function alias).

task-setup:
	@: $${NAME?Usage: make task-setup NAME=<kebab-case-name> [CONTEXT=1]}
	@CONTEXT="$(CONTEXT)" ./scripts/task-setup.sh "$(NAME)" $$( [ "$(CONTEXT)" = "1" ] && echo --context )

task-clean:
	@: $${NAME?Usage: make task-clean NAME=<name> [FORCE=1]}
	@./scripts/task-clean.sh "$(NAME)" $$( [ "$(FORCE)" = "1" ] && echo --force )

# Build the Lobu Mac app locally with the same Developer ID identity as the
# mac-release CI, so TCC grants (Screen Recording, Accessibility) match the
# notarized release instead of a default Apple Development build. Syncs the
# owletto submodule first. INSTALL=1 replaces /Applications/Lobu.app; OPEN=1
# launches it. See scripts/build-owletto-mac.sh header for details.
owletto-mac:
	@INSTALL="$(INSTALL)" OPEN="$(OPEN)" ./scripts/build-owletto-mac.sh

# Build/install the signed Lobu.app then probe prod computer_use against the
# paired device connection (permissions + list_windows). SKIP_BUILD=1 reuses the
# already-installed /Applications/Lobu.app. See scripts/owletto-mac-e2e.sh.
owletto-mac-e2e:
	@SKIP_BUILD="$(SKIP_BUILD)" ORG="$(ORG)" CONN_ID="$(CONN_ID)" ./scripts/owletto-mac-e2e.sh

# Reap task worktrees whose PR is already merged (worktree + branches + dev DB
# + Lobu context). Dry-run by default — prints what it would remove; pass
# APPLY=1 to actually run task-clean on each. Squash-merge-safe: gates on the
# GitHub PR state, not git ancestry.
clean-merged:
	@./scripts/clean-merged.sh $$( [ "$(APPLY)" = "1" ] && echo --apply )

dev-recover:
	@RESTART="$(RESTART)" ./scripts/dev-recover.sh

# Stable Owletto Chrome harness for e2e: one persistent profile, paired once,
# reused from any agent session (mirrors the installed Mac app). Loads the
# extension from the current worktree; RESTART=1 forces a fresh launch.
e2e-browser:
	@./scripts/e2e-browser.sh $$( [ "$(RESTART)" = "1" ] && echo --restart )

# Lightweight shortcut for "trivial submodule pointer bump" work. Creates a
# minimal worktree (no bun install, no .env copy, no port allocation), advances
# the submodule, posts both required local statuses, and opens an auto-merge PR.
# For agent work that also touches submodule *code*, use `make task-setup`
# instead — it sets up the full env.
bump:
	@: $${SUBMODULE?Usage: make bump SUBMODULE=<path> [TARGET=<sha-or-ref>] [NAME=<slug>] [ARTIFACT=<url>]}
	@NAME="$(NAME)" ./scripts/bump-submodule.sh "$(SUBMODULE)" "$(TARGET)"

# --- Test pipelines ---------------------------------------------------------
# These mirror what CI runs (.github/workflows/ci.yml) so a passing local run
# is a strong signal CI will pass.

# Unit suite — bun:test on the per-package units that don't need Postgres.
test-unit:
	@echo "🧪 Unit suite (no Postgres)…"
	@bun test packages/core packages/plugin-api packages/plugin-host packages/plugin-toolkit packages/plugin-memory packages/plugin-conversations packages/plugin-media packages/plugin-mcp packages/cli
	@bun test packages/server/src/__tests__/unit
	@# src/gateway/infrastructure/queue runs in the gateway loop in test-integration (#1238)
	@bun test packages/connector-worker
	@bun test packages/client packages/promptfoo-provider
	@bun test packages/connector-sdk
	@bun test packages/device-connectors
	@bun test packages/embeddings
	@bun test examples/personal-agent
	@bun test examples/brand-intelligence
	@bun test examples/lobu-team

# Integration suite — vitest under Node + bun:test packages that need Postgres.
# Requires DATABASE_URL pointing at a Postgres with pgvector installed.
# Local (macOS): `make setup` provisions brew postgresql@18 + lobu_test on :5418 — just:
#   export DATABASE_URL=postgres://$USER@127.0.0.1:5418/lobu_test PGSSLMODE=disable
# Linux / no brew:
#   sudo apt-get install -y postgresql-16-pgvector
#   sudo -u postgres createdb lobu_test
#   sudo -u postgres psql -d lobu_test -c "CREATE EXTENSION vector"
#   export DATABASE_URL=postgres://postgres@127.0.0.1:5432/lobu_test PGSSLMODE=disable
test-integration:
	@: $${DATABASE_URL?Set DATABASE_URL=postgres://… (with pgvector) before running}
	@echo "🧪 Integration suite (Postgres at $${DATABASE_URL%%@*}@…)…"
	@cd packages/server && node ../../node_modules/.bin/vitest run --reporter=default
	@# Each gateway test file in its own process: bun has no per-file
	@# isolation and the suites aren't mutually hermetic, so a shared-process
	@# co-run leaks DB/module state across files (see #1238). Fail if find
	@# matches nothing, so a path typo can't silently run zero tests.
	@dirs=$$(find packages/server/src/gateway -type d -name __tests__ | sort); \
		[ -n "$$dirs" ] || { echo "no gateway __tests__ dirs found" >&2; exit 1; }; \
		rc=0; for d in $$dirs; do \
			files=$$(find "$$d" -maxdepth 1 -type f -name '*.test.ts' | sort); \
			for f in $$files; do echo ">> bun test $$f"; bun test "$$f" || rc=1; done; \
		done; exit $$rc
	@bun test packages/server/src/lobu/__tests__ packages/server/src/scheduled packages/server/src/workspace/__tests__
	@bun test packages/connector-worker/integration-tests

# SDK lifecycle e2e: boots `lobu run` (embedded Postgres), auto-applies a
# prune:true fixture, and drives a real agent turn through a spawned worker
# against a deterministic mock provider (no key needed). Self-contained. This is
# the SDK lifecycle step in CI's `sdk-cli-e2e` job; run it locally the same way.
test-e2e-sdk:
	@./scripts/sdk-e2e.sh

# Agent-turn live e2e (isolate lane). NOT in CI on purpose: it needs the built
# CLI dist and takes ~4 minutes, which is more than the sdk-e2e job's budget.
# Every scenario also has unit/integration coverage, so this is not the
# regression gate — it is the gate that exercises the REAL MCP route, Postgres
# and isolate together, which is how it found the first-turn steering gap and
# the memory-scope gap that unit suites could not see. Run it after changing
# the agent-turn lane. See scripts/agent-turn-e2e/README.md.
test-e2e-agent-turn:
	@(cd packages/server && bun run build:server) && (cd packages/cli && bun run build)
	@bash scripts/agent-turn-e2e/agent-turn-e2e.sh

# Error-taxonomy e2e: the failure-path companion to sdk-e2e. Boots `lobu run`
# with the mock provider in 429 mode and drives a real turn through a spawned
# worker, asserting the provider's own 429 message reaches the user verbatim
# (incl. the reset time) with NO generic "stopped responding" mask.
# Self-contained, no key. Guards the whole classify→signal→render chain.
test-e2e-error:
	@./scripts/sdk-e2e-error.sh

# CLI command-coverage smoke: boots one `lobu run` (embedded Postgres + mock
# provider) under an isolated HOME and walks EVERY `lobu` command/subcommand
# once, asserting each runs (or fails gracefully). Self-contained, no key. This
# is the CLI smoke step in CI's `sdk-cli-e2e` job; run it locally the same way.
test-e2e-cli:
	@./scripts/cli-smoke.sh

# Live provider validation — opt-in, networked, NOT part of the default gates.
# Two tiers, both derived from config/providers.json:
#   keyless — probes every protocol-correct completion/models route against the
#             real APIs and checks defaultModel against public catalogs.
#   keyed   — production-adapter streaming + parsed tool-call round-trip per
#             configured credential. REQUIRED_LIVE_PROVIDERS fails closed when
#             a required credential is absent.
#   make test-providers-live                      # keyless tier + whichever keys are set
#   OPENAI_API_KEY=sk-... make test-providers-live
test-providers-live:
	@echo "🌐 Live provider smoke (key-gated)…"
	@bun test --timeout 60000 packages/server/src/__tests__/live-providers

# Reap gateway processes left over from a crashed `make dev`.
# An agent turn runs in a V8 isolate inside the gateway process, so there is
# no per-agent child to kill any more — a turn cannot outlive its gateway.
# Killing an orphaned gateway is what actually frees the port, and
# `scripts/dev-recover.sh` calls this before restarting.
clean-workers:
	@echo "🧹 Stopping orphaned gateway processes..."
	@pkill -f 'tsx watch.*packages/server/src/server.ts' 2>/dev/null || true
	@echo "✅ Orphaned gateway processes stopped"

# Orphaned `lobu-test-pg-*` embedded-Postgres clusters from other worktrees'
# integration runs eat macOS shared-memory slots (SHMMNI=32), and `lobu run` /
# `make review`'s integration suite then fail with "could not create shared
# memory segment: No space left on device" (shmget). They ALSO leak their data
# dir (~150-400 MB each) to $TMPDIR — a session of killed runs once piled up
# 65 GB and filled the disk. Reap both the processes (SHM) and the dirs (disk).
clean-test-pg:
	@echo "🧹 Reaping orphaned lobu-test-pg embedded-Postgres clusters..."
	@pkill -f 'lobu-test-pg' 2>/dev/null || true
	@pkill -f '@embedded-postgres' 2>/dev/null || true
	@sleep 1
	@before=$$(df -m "$${TMPDIR:-/tmp}" 2>/dev/null | awk 'END{print $$4}'); \
		for d in "$${TMPDIR:-/tmp}"/lobu-test-pg-*; do \
			[ -d "$$d" ] || continue; \
			pid=$$(head -1 "$$d/postmaster.pid" 2>/dev/null); \
			if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
				echo "  skip live cluster $$d (pid $$pid)"; continue; \
			fi; \
			rm -rf "$$d"; \
		done; \
		after=$$(df -m "$${TMPDIR:-/tmp}" 2>/dev/null | awk 'END{print $$4}'); \
		echo "freed ~$$((after - before)) MB of leaked cluster dirs (live clusters skipped)"
	@echo "shm segments now: $$(ipcs -m 2>/dev/null | awk '/^m/{c++} END{print c+0}') / 32"
	@echo "✅ Test-PG clusters + dirs reaped"

# --- Local AI review gate ---------------------------------------------------
# Local-only: runs the deterministic suites in cwd, then invokes the reviewer
# from the model family opposite the current harness against
# `git diff <BASE>...HEAD` (BASE defaults to origin/main when available;
# override with BASE=<branch> env or `--base <branch>` arg). Prints a JSON
# verdict on the last line. If
# GitHub auth is available, posts a pi-review commit status; if the current
# branch has an open PR, also posts/updates a PR comment. See docs/REVIEW_SCHEMA.md.
# Small path/content-gated safe-class diffs skip both LLM passes by default while
# still posting pi-review and running deterministic CI. REVIEWER_MODE=full
# forces them.

review:
	@./scripts/review.sh $(if $(BASE),--base $(BASE),)

# Pre-review fixer: the reviewer CLI with WRITE access + the review rubrics,
# fixing review-grade findings (bugs, slop, stale claims) in the working tree
# BEFORE `make review` posts a status. Uses the same safe-class skip as review;
# otherwise posts nothing and commits nothing — inspect its diff, commit, then
# run `make review` once on the settled HEAD.
review-fix:
	@./scripts/review-fix.sh $(if $(BASE),--base $(BASE),)

# Visual counterpart to `make review`: non-Owletto PRs and complete,
# forward-only pointer diffs confined to deploy/ pass as not applicable. Other
# pointer PRs post/update proof on the exact merged Owletto PR, link it from this
# Lobu PR, and attach a passing `ui-review` status. Without reusable exact proof,
# they need ARTIFACT. ARTIFACT and OPEN are read directly by scripts/ui-review.ts
# to avoid shell interpolation of URLs.
ui-review:
	@bun scripts/ui-review.ts

# Per-worktree remote dev stack on Daytona: the full server + embedded Postgres
# running in a sandbox named after this worktree, reachable on a preview URL.
# Isolation is the point — the sandbox never sees the Mac's Postgres, ports, or
# DATABASE_URL, so separate worktrees do not collide.
sandbox:
	@bun scripts/sandbox.ts up

sandbox-sync:
	@bun scripts/sandbox.ts sync

sandbox-url:
	@bun scripts/sandbox.ts url

sandbox-logs:
	@bun scripts/sandbox.ts logs

# Offload a build or suite to the sandbox instead of the Mac.
sandbox-run:
	@: $${CMD?Usage: make sandbox-run CMD='bun test <path>'}
	@bun scripts/sandbox.ts run $(CMD)

# Stop frees the org-wide running-memory quota; disk and the database survive,
# so `make sandbox` afterwards restarts without rebuilding the image.
sandbox-stop:
	@bun scripts/sandbox.ts stop

sandbox-ls:
	@bun scripts/sandbox.ts ls

# One call instead of the git status / diff / log / gh pr view / gh pr checks
# family. Every tool call re-reads the agent's whole context, so collapsing the
# family into one call is worth more than speeding up any command in it.
ctx:
	@bash scripts/ctx.sh

# Wait for CI then squash-merge, in one blocking call. Refuses while any
# branch-protection required check is not merge-satisfying — `gh pr checks`
# omits checks that never started, so --admin would otherwise sail past them.
land:
	@bash scripts/land.sh

# Fast, deterministic CI gates that need NO database — the exact checks that
# `make review` (LLM-verdict only) does NOT run. Run this before opening/updating
# a PR so knip / typecheck / lint failures don't surface only in CI.
# NOT a substitute for the DB-backed suites (make test-integration) when you
# touch server/runtime code — but it catches the cheap, common misses.
pre-pr:
	@echo "🔎 [1/5] Build workspace packages (fresh dist)..."
	@# Typecheck resolves @lobu/* against built dist, not src. Without this a
	@# stale core dist yields PHANTOM errors on any contract change (e.g. a new
	@# field the dist predates) — the exact trap CI avoids by building first.
	@make build-packages
	@# Root `bun run typecheck` and `bun run check` are deliberately NOT run
	@# here: .husky/pre-commit already runs both, in FAIL mode, on every commit
	@# — the identical scripts. Running them twice bought nothing but wall time.
	@# The per-package loop below has no such twin, so it stays.
	@echo "🔎 [2/5] Strict typecheck (per-package; root is covered by the commit hook)..."
	@for pkg in server connector-worker connector-sdk device-connectors plugin-api plugin-host plugin-toolkit plugin-memory plugin-conversations plugin-media plugin-mcp embeddings cli; do \
		echo "   typecheck packages/$$pkg..."; \
		( cd "packages/$$pkg" && bunx tsc --noEmit ) || exit $$?; \
	done
	@echo "🔎 [3/5] Dead-code gate (knip --include files)..."
	@bun run knip --include files
	@echo "🔎 [4/5] Exposed surface naming (Automation is canonical)..."
	@bun scripts/check-exposed-surface-naming.ts
	@echo "🔎 [5/5] Gateway LLM + entity-write funnel gates..."
	@node scripts/check-gateway-llm-calls.mjs
	@bun scripts/check-entity-write-funnel.mjs
	@# The fixture suite tests the CHECKER, not the tree, so it only needs to run
	@# when the checker itself moved. CI runs it unconditionally either way.
	@if git diff --quiet origin/main...HEAD -- scripts/check-entity-write-funnel.mjs scripts/__tests__/check-entity-write-funnel.test.ts 2>/dev/null \
	   && git diff --quiet -- scripts/check-entity-write-funnel.mjs scripts/__tests__/check-entity-write-funnel.test.ts 2>/dev/null; then \
		echo "   funnel-checker unchanged; fixture suite skipped (CI still runs it)"; \
	else \
		bun test scripts/__tests__/check-entity-write-funnel.test.ts --timeout 30000; \
	fi
	@echo "✅ pre-pr gates clean. NOTE: confirm your fix is in 'git show HEAD:<file>',"
	@echo "   not just the working tree — a fix that isn't committed won't reach CI."

# OPTIONAL full-gate runner (GitHub CI is canonical). Default provider auto:
# a Daytona ephemeral sandbox when the CLI is available, otherwise the SAME
# jobs run on this machine — the command never hard-depends on Daytona.
# REMOTE_CI_PROVIDER=depot|local forces a provider; REMOTE_JOBS narrows the
# job list. Stage intended files first: the sandbox only sees staged content.
REMOTE_FAST_JOBS := unit frontend server-integration-vitest server-integration-bun integration format-lint typecheck migrations

# Optional broad iteration gate: the required Linux merge graph without the
# post-gate SDK/CLI and connector parity smokes. GitHub CI is canonical.
pr-fast:
	@./scripts/run-remote-ci.sh $(REMOTE_FAST_JOBS)

# Optional full staged Linux graph (every Linux job in ci.yml).
pr-full:
	@./scripts/run-remote-ci.sh $(REMOTE_JOBS)
