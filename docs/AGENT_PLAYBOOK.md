# Agent playbook

Supporting rationale, incident history, and exact flags for the root and package agent rules.

The root `AGENTS.md` is loaded into agent sessions (`CLAUDE.md` inlines it for Claude), so it carries concise rules. Package `AGENTS.md` files add local rules; this file carries supporting context for both. Read the relevant section when a rule looks arbitrary, when you are about to argue yourself out of one, or when you need the full command.

Mechanical traps (build, SQL, testing, submodule, browser) live in `docs/GOTCHAS.md` instead.

## Workspace

**Explicit-path staging.** A commit is a snapshot of the index, not a diff of your intentions. A worktree that hosted earlier work still holds those files; `git add -A` commits the stale copies, which silently reverts already-merged PRs. Verify a "reverts merged work" review finding by diff direction against `origin/main` — never dismiss it as merge-base noise.

**One branch = one concern** means one concern, not one file. Split only for genuinely independent concerns or when the diff would be unreviewable.

**Conflict resolution.** Never resolve conflicts in the GitHub UI. Rebase ordinary branches locally against `origin/main`, then diff against the last real feature commit before squashing so a resolution cannot silently drop work. Submodule-pointer branches merge instead; follow `docs/GOTCHAS.md`.

## Data

**Request paths never aggregate history.** History only grows, so read-time aggregation cost grows with it while the answer stays bounded — the query gets slower every day for a result that does not change shape. Materialize the row or counter at write time and read it back by index. Run the one-time backfill in a migration, never per request.

**`events.id` is a stored-version id.** Connector resyncs supersede a row and allocate a new id for the same source item, so any identity or dedupe keyed on `events.id` breaks silently on the next resync.

**Organization rows.** Empty-looking orgs are frequently real human signups that have not been used yet. There is no bulk-delete that is safe, including "zero activity" filters.

## Runtime

**Dynamic-import exceptions.** Two call sites are grandfathered because they gate on the Node version before loading a large graph, and both must stay dependency-free until their checks pass:
- `packages/cli/bin/lobu.js` defers the existing CLI graph without duplicating it.
- `packages/server/src/server-entry.ts` runs the gate before dynamically loading the separate server bundle.

**Fail closed on durable state.** The failure mode this prevents: an operation that may already have succeeded is retried as if nothing happened, or an error is read as "safe to skip" and a delivery is dropped. Treat ambiguity as failure and reconcile idempotently.

**Coordination design brake.** If a change needs a second lock, a second retry budget, or a prose argument for why it terminates, the check is in the wrong place. Re-derive where the decision belongs before adding mechanism.

**Page-activated browser drafts.** Persist the draft operation and its normal Lobu notification. The generic extension badges exact pending URLs and activates the run only when the user visits one in a user-owned tab. Connector/reaction code owns the URL and page interaction, but no layer auto-submits — neither core nor connector nor extension code pushes a user-owned tab or submits the draft on the user's behalf.

## Evidence

**Red→fix→green.** Both outputs belong in the PR body. If you cannot reproduce the bug, that is a reportable dead end — a speculative fix costs more than the bug.

**Mutation checks.** A test that passes after you break the code proves nothing. Assert the old pattern exists, make a countable source change, confirm the focused test fails, then restore and rerun green.

**Absence needs `origin/main`.** A working-tree grep proves nothing about what exists — your tree is stale by definition. `git fetch -q origin && git grep <pattern> origin/main`; the fetch is load-bearing because `origin/main` itself goes stale.

**Never done off a typecheck.** Boot it, exercise every branch you touched, clean up test data you created. "It compiles" is a legitimate report only if you say that is all you ran.

**Deletion evidence.** Trace the full workflow, not only the import graph. Low production usage is not evidence that code is safe to delete, and docs and help text are load-bearing too.

## Gates

| Command | What it actually does |
|---|---|
| `make pre-pr` | Local fast gates (typecheck, knip, lint, naming/LLM/entity checks) — catches the cheap common misses before push. No DB, no remote. |
| GitHub CI (`ci.yml`) | **The canonical gate** — full Linux graph on GitHub-hosted runners, free on this public repo, ~5–7 min per PR. |
| `make pr-full` | Optional: full graph on a Daytona ephemeral sandbox, falling back to a local run when Daytona is unavailable (`REMOTE_CI_PROVIDER=depot` keeps the old Depot path). Not part of the required loop. |
| `make review` | Handles the review verdict/status or safe-class skip. Runs no typecheck, knip, or tests — **not** proof CI will pass. |
| `make review-fix` | Unposted fixer pass. Edits the working tree; re-read files before trusting them. |
| `make ui-review` | Records exact UI proof for Owletto pointer changes; passes non-Owletto changes and complete, forward-only pointer diffs confined to unhosted trees (`deploy/`, `apps/chrome/`, `apps/mac/`, `scripts/`) as not applicable. |

The macOS app lane stays on GitHub/Mac hardware. A fresh full `make review` requires GitHub CI (`ci.yml`) to have passed for the exact HEAD commit and refuses a surprise local package build; safe-class skips and cached verdicts do not rebuild. `REVIEW_ALLOW_LOCAL_BUILD=1 make review` overrides only when CI cannot run for HEAD.

**GitHub CI cancels per-ref.** A new push to a PR cancels its in-flight CI run (superseded runs die); each branch/PR has its own group, so runs across PRs are independent.

**Knowing when every required check has reported.** `gh pr checks <n> --required` prints only contexts GitHub has returned for the pull request. Lobu's required `integration` fan-in waits on the `integration-vitest` shards and `integration-bun`, and GitHub does not return it until it starts. Early on it is therefore absent rather than `pending`. A wait loop that counts `pending` rows exits successfully while that required check is still missing, and the merge fails with `Required status check "integration" is expected.`

Diff the branch-protection list against the merge-satisfying results instead:

```sh
required_contexts=$(
  gh api repos/lobu-ai/lobu/branches/main/protection/required_status_checks --jq '.contexts[]'
) &&
satisfied_contexts=$(
  gh pr checks <n> --required --json name,bucket \
    --jq '.[]|select(.bucket=="pass" or .bucket=="skipping")|.name'
) &&
comm -23 \
  <(printf '%s\n' "$required_contexts" | sort) \
  <(printf '%s\n' "$satisfied_contexts" | sort)
```

The chain must exit zero **and** print nothing before merge. Nonzero does not mean the read failed: `gh pr checks` exits 8 while checks are pending and nonzero when one has failed, so the `&&` chain stops there before `comm` ever runs. Output, when it runs, names a context that is either not merge-satisfying or not yet reported. Either way you are not ready to merge — run `gh pr checks <n> --required` to tell a reported failure or pending result apart from an absent context.

**Review skip rule.** `make review-fix` and `make review` share one classifier. Small diffs (under 100 lines) confined to narrow path/content-gated classes — docs, exact renames, generated output, the root `bun.lock`, snapshots, additive tests, exact `model:` literal swaps in `lobu.config.ts`, or a pure `packages/owletto` pointer bump — skip both LLM passes. Runtime source, migrations, other lockfiles, runtime-affecting config, static assets, review/CI machinery, mixed Owletto bumps, and unknown paths still review. `make review` continues to post the required auditable status; deterministic CI remains required. `REVIEWER_MODE=full make review-fix` or `REVIEWER_MODE=full make review` forces the corresponding LLM pass, and `REVIEWER_SHADOW=1` measures the posted-review skip rule instead of trusting it.

**Pure pointer shortcut.** Use `make bump SUBMODULE=packages/owletto [TARGET=<ref>] [ARTIFACT=<url>]` instead of a full task worktree. It creates a lightweight isolated worktree, commits and pushes the pointer, opens the PR, posts the safe-class `pi-review`, runs `ui-review` (reusing exact proof or accepting `ARTIFACT`), and enables squash auto-merge. It stops with the PR open if either required local status cannot be posted.

**UI proof.** `gh` cannot upload images inline. Capture before shots from the unmodified branch and after shots from the same booted app (auth recipe in `docs/BROWSER_TESTING.md`), base64-embed the PNGs into one self-contained HTML comparison page, host it at an HTTPS URL, and pass that URL as `ARTIFACT` to `make ui-review`. The gate records it on the exact merged Owletto PR, links it from the parent, and binds the evidence to that parent-base and Owletto-pointer pair for normal PR review. A rerun may reuse an exact proof already recorded for that pointer pair. Complete, forward-only endpoint diffs confined to unhosted trees (`deploy/`, `apps/chrome/`, `apps/mac/`, `scripts/` — none ship a hosted surface, so no URL can exist to compare) pass as not applicable; every other pointer change needs reusable exact proof or an `ARTIFACT`.

**Action & approval gates.** A connector action parks a run at `approval_status='pending'` when the approval decision is `approval`. The decision is made by `resolveActionMode` (`packages/server/src/operations/action-modes.ts`) as: per-connection `connection.config.action_modes[operation_key]` FIRST (`'disabled' | 'approval' | 'auto'`), falling back to the connector definition's `requiresApproval` (approval), read-kind (auto), or `destructiveHint` (approval). Changing `action_modes` is itself human-only — the same identity rule as run approvals — so a human sets `{ <op>: 'auto' }` in the web UI (the connection's settings tab, or the connector defaults page); it overrides `requiresApproval` for THAT connection only, and other connections keep the gate. An agent or token calling `connections.create` / `connections.connect` / `connections.update`, or setting a connector's `default_connection_config`, may only round-trip the modes map unchanged; any set, change, or removal is denied. Reads (`kind: 'read'`) and `requiresApproval: false` writes already run auto. Connector-run approvals are human-only by design — `resolve_approval` / `approve_batch` require a human web session; the server rejects agent/token approval of operation runs ("Operation approval requires a human web session"). When a run is parked, trace `resolveActionMode` + the connection config before assuming a gap; do not invent new approval surface. Headless device runs additionally need the device's daemon to resolve the connector source + externalized `@lobu/connector-sdk` (the worker child compiles into `process.cwd()`, so the daemon must run from the package dist dir).

## Post-merge rollout verification

For a prod-visible surface, schedule a follow-up around 25 minutes later. If the deploy is still stale, reschedule instead of polling in the foreground. Once it lands, run:

```sh
MERGE_SHA=$(gh pr view <n> --json mergeCommit --jq .mergeCommit.oid)
git merge-base --is-ancestor "$MERGE_SHA" "$DEPLOYED_SHA"
```

Two ways this gate silently never opens:
- **Gating on the branch head instead of the squash commit.** A squash merge writes a new commit with no ancestry link to the branch, so the branch head cannot prove the rollout.
- **Reversing the argument order.** Merge commit first; reversed, it accepts a stale deploy.

Record the result when it lands.

## Session efficiency

- Exact local tests remain the fastest red-green loop; GitHub CI owns CPU-heavy breadth. `make pre-pr` covers the cheap local gates before push.
- `gh pr checks <n> --required` plus `gh pr view <n> --json number,title,isDraft,mergeStateStatus,reviewDecision` is the compact status read; avoid the much larger `statusCheckRollup` payload.
- Delegated CLIs (OpenCode, Claude CLI) get polled at most once per 4.5 minutes unless they finish, request input or approval, or the user asks for an immediate update. Read only output since the last cursor. Ask them to persist detailed evidence to files and return compact status, counts, failures, and exit codes; never replay a full session or stream verbose diffs into the supervising context.
- Screenshots are the single largest context-bloat source. Prefer `get_page_text` / `read_page` / `javascript_tool`, and screenshot only when visual layout itself is under test.
- For a one-line or config-only change, take one CI snapshot and move on.
