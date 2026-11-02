# PR Review Verdict Schema

After making changes on a feature branch, the agent pushes and runs
`make review` locally. The deterministic test suites run in GitHub CI as
their own required status checks — `scripts/review.sh` does NOT run them.
It snapshots the head commit's CI check state for reviewer context, invokes
an independent CLI reviewer against the exact tree diff from the merge base
(committed changes plus any write-phase edits) (base defaults
to `origin/main` when available, override with `BASE=<branch>` or
`--base <branch>`), and prints a JSON verdict matching this schema. The
writer may run focused tests. Reviews of different commits execute concurrently
with no host-wide lock; a duplicate run of the same commit is refused so the
`pi-review` status has exactly one owner per sha. Codex harnesses use Claude; other
environments, including Claude Code, use Codex. Set
`REVIEWER_CLI=codex|claude` to override automatic selection. The script
loads review settings from `.env` and `.env.local` as dotenv data (no shell
execution). Already-exported values win, then `.env.local`, then `.env`.
Set `CLAUDE_REVIEW_MODEL=claude-opus-5-5` (or `opus`) and
`CODEX_REVIEW_MODEL=gpt-6.1-sol` in those files; models have no hardcoded
fallback. A missing/empty selected model fails closed when a fresh reviewer
is needed. `CLAUDE_REVIEW_EFFORT` defaults to `high` and
`CODEX_REVIEW_EFFORT` to `xhigh`; both can also come from env files.
Claude reviews fail closed unless
`CLAUDE_REVIEW_MODEL` is `fable`, `opus`, or a full `claude-opus-*` model ID;
Sonnet, Haiku, empty, and arbitrary model values are rejected before the
review starts. It posts a `pi-review` commit status
whenever GitHub auth is available; if a PR exists for the current branch, it
also posts an idempotent PR comment (marker-keyed upsert) with the verdict.
**GitHub Actions does not run the agent review** — it's a local-driven gate
owned by the agent doing the work; CI owns the deterministic suites.

Branch protection requires the `pi-review` status alongside the CI checks,
so `gh pr merge --auto` completes only when both the suites and the agent
verdict are green. The status fails when
any merge gate below fails: `bug_free_confidence < 80`, `bugs > 0`,
`slop > 15`, `simplicity < 70`, `blockers` is non-empty,
or `tests_adequate == false`. `runtime_change_risk` is reported in the
status description but does NOT gate. Thresholds
are tunable for one-off runs with `PI_REVIEW_MIN_BUG_FREE`,
`PI_REVIEW_MAX_SLOP`, and `PI_REVIEW_MIN_SIMPLICITY`.

The schema is reviewer-agnostic — a second independent reviewer can be
added later without touching the shape below.

## Schema

```json
{
  "bug_free_confidence": 0,
  "bugs": 0,
  "slop": 0,
  "simplicity": 0,
  "blockers": ["string", "..."],
  "change_type": "feat|fix|refactor|docs|chore|test|deps",
  "runtime_change_risk": "none|low|medium|high",
  "tests_adequate": true,
  "suggested_fixes": [{ "file": "path/to/file.ts", "line": 42, "change": "what to change" }],
  "notes": "freeform paragraph",
  "categories": {
    "src": 0,
    "tests": 0,
    "docs": 0,
    "config": 0,
    "deps": 0,
    "migrations": 0,
    "ci": 0,
    "generated": 0
  }
}
```

All fields are required. Reviewers MUST emit only this JSON object — no
surrounding prose, no Markdown fences, no commentary.

## Fields

### `bug_free_confidence` (integer, 0–100)

How sure the reviewer is that the change works correctly and won't break prod.

- **90+** — "I'd stake the team on this not breaking prod." Tests pass;
  exploratory verification confirmed; no semantic risk the reviewer can name.
- **70–89** — Compiles + tests pass, but there's a code path the reviewer
  couldn't verify.
- **40–69** — The reviewer found at least one thing that *might* break and
  can't rule it out.
- **0–39** — The reviewer found something that almost certainly breaks, OR
  can't even understand the change well enough to judge.

**Calibration rule:** do not go above 90 unless the reviewer would genuinely
stake the team on this.

**Gate:** `make review` passes only when `bug_free_confidence >= 80` by
default. Override for one run with `PI_REVIEW_MIN_BUG_FREE=<n>`.

### `bugs` (integer, ≥0)

Count of defects **caused by the diff**. A defect is **either** a failing
test the diff itself broke **or** a reproducible failure the reviewer
observed exercising the system (boot probe, endpoint hit, narrow test
re-run) that maps back to a line the diff touches.

Pre-existing environmental breakage spotted while reviewing — a failing
test in code the diff does not touch, a broken test setup, a missing
workspace export from an unrelated package — does NOT count. Surface it in
`notes` with an `[env]` prefix so the operator sees it without inflating
the bugs count.

Speculation is also not a bug — it goes in `notes` as a concern. If you
didn't verify, you don't get to count.

Style nits and naming preferences do not count.

**Gate:** `make review` passes only when `bugs == 0`.

### `slop` (integer, 0–100)

A rubric score for "AI-generated waste in the diff." Higher = more slop.

Count instances of each of the following and let the score reflect the
ratio of slop lines to total changed lines:

- **Dead code** — unreachable branches, never-called functions, exports nothing
  imports.
- **Unused exports** — public surface added that no other module needs.
- **Half-implementations** — TODO stubs, `throw new Error("not implemented")`,
  functions whose body is a comment.
- **Restate-the-code comments** — `// increment i` over `i++`. Comments that
  explain *why* are fine; comments that paraphrase the next line are slop.
- **Defensive validation for impossible inputs** — null-checks on a parameter
  the type system already proves is non-null; try/catch around `JSON.parse`
  on a string the function itself just stringified.
- **Premature abstractions** — interfaces, factories, registry patterns
  introduced for a single concrete implementation, with no second caller in
  the diff or in the existing codebase.
- **Backwards-compat shims for unused code** — re-exports, aliases, or
  deprecation wrappers for symbols nothing imports. (Per AGENTS.md: "no
  `@deprecated` tags — just delete the old thing.")

**Scoring guide:** 0 = no slop; 20 = one or two minor instances in a large
diff; 50 = significant fraction of the diff is waste; 80+ = the diff is
mostly waste.

**Gate:** `make review` passes only when `slop <= 15` by default. Override for
one run with `PI_REVIEW_MAX_SLOP=<n>`.

### `simplicity` (integer, 0–100)

How elegant the change is for the goal it's pursuing. Higher = simpler.

- **100** — elegant. Minimal change for the goal. No abstraction not earned by
  current users. Could be picked up by someone new without context.
- **70–99** — reasonable. Some flex but justifiable.
- **40–69** — overcomplicated. Helper layers that hide what's happening. Flag
  arguments that should be separate functions. Generics for one caller.
- **0–39** — byzantine. Heavy abstraction tax. Reader has to hold a lot to
  understand a small change.

**Note:** high `simplicity` does NOT mean "less code." A 3-line change with a
clever side effect is low simplicity. A 200-line change that reads
top-to-bottom is high simplicity.

**Gate:** `make review` passes only when `simplicity >= 70` by default.
Override for one run with `PI_REVIEW_MIN_SIMPLICITY=<n>`.

> **Independent axes.** `bug_free_confidence`, `slop`, and `simplicity` are
> independent. A change can score high `bug_free_confidence` (works), high
> `slop` (lots of unused code added), and low `simplicity` (overengineered).
> The `pi-review` status requires all six gates to pass: these three metrics,
> `bugs == 0`, `blockers.length == 0`, and `tests_adequate == true`.

### `blockers` (array of strings)

One-line descriptions of issues **caused by this diff** that should block
merge regardless of the other scores. Empty array if none. Examples:

- `"introduces a secret in a committed file"`
- `"db migration is not idempotent"`
- `"deletes a public export still used by @lobu/cli"`

Pre-existing environmental failures (test suite broken on `main`, missing
workspace export from an unrelated package, Postgres schema-ACL issue in
test setup) are NOT blockers — they belong in `notes` with an `[env]`
prefix. A failing test only blocks when the failing test, or the source
code it exercises, appears in `git diff --name-only "$BASE_BRANCH...HEAD"`.

**Gate:** `make review` passes only when `blockers.length == 0`.

### `change_type` (enum)

One of: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `deps`.

Maps to conventional-commit prefix. Use the prefix that best describes the
**primary** intent of the diff. If the PR genuinely does two things in equal
measure (e.g. `feat` + `test`), prefer `feat`. If you would split this PR,
say so in `notes`.

**Note:** the current `pi-review` status applies one gate policy to all change
types. If a docs/chore/test PR needs an exception, use an explicit env override
or admin merge.

### `runtime_change_risk` (enum)

One of: `none`, `low`, `medium`, `high`.

- **none** — pure refactor, docs, type-only changes. No runtime change reaches
  users.
- **low** — runtime change is bounded to a narrow code path with adequate
  tests, or to a dev-only / opt-in surface.
- **medium** — runtime change affects a path users hit but is well-typed and
  tested, or affects an internal API with multiple call sites.
- **high** — runtime change touches a hot path, migrations, auth, billing,
  data integrity, or anything with cross-system consequences (queue,
  scheduler, retry).

**Not a gate.** Risk is reported in the status description (`…, 0 blockers,
risk high`) so a reviewer can weigh it, but it does not fail `pi-review`. It is
a self-reported tier, not a defect: `pi-review` exists to catch defects before
merge, and `bugs` / `blockers` already cover those. Gating on it blocked every
routine change to a queue, scheduler, or retry path — the categories named
above — even at `0 bugs, 0 blockers`, and the only way past was disabling
`enforce_admins` on `main`, which is strictly worse than merging the change.

### `tests_adequate` (boolean)

`true` if the diff includes tests covering the runtime change (or no tests
are warranted because runtime_change_risk is `none`). `false` if a
runtime change ships without test coverage.

**Gate:** `make review` fails when `tests_adequate` is `false`. For docs/chore
exceptions, use an explicit env override or admin merge.

### `suggested_fixes` (array of objects)

Specific actionable suggestions. Each object has `file`, `line`, `change`.
Empty array if none.

These are passed to the internal write phase when the verdict fails. The
read-only reviewer never edits or approves its own fixes. Be specific (file path + line +
concrete change). Vibe suggestions ("consider refactoring", "this could be cleaner")
don't belong here — the agent can't act on them; surface those as `notes`
instead.

### `notes` (string)

A freeform paragraph (one paragraph, not a wall of text) summarizing the
reviewer's overall take. This is what shows up in the PR comment above
the JSON. Keep it under ~500 chars.

### `categories` (object)

Line counts by category. Sum should approximate `additions + deletions`.

Path → category mapping:

| Pattern | Category |
| --- | --- |
| `packages/*/src/**` (not `__tests__`) | `src` |
| `**/__tests__/**`, `**/*.test.ts`, `**/*.integration.test.ts` | `tests` |
| `**/*.md`, `docs/**`, `LICENSE`, `README*` | `docs` |
| `*.toml`, `*.yaml`, `*.yml` (not `.github/workflows/**`), `config/**`, `tsconfig*.json`, `biome.json` | `config` |
| `package.json`, `bun.lock`, `**/package.json` | `deps` |
| `db/migrations/**`, `db/schema.sql` | `migrations` |
| `.github/workflows/**`, `.github/actions/**` | `ci` |
| `packages/owletto/src/routeTree.gen.ts`, `**/dist/**`, generated files | `generated` |

When a path matches multiple patterns, the more specific one wins
(`__tests__/**` beats `packages/*/src/**`).

**Note:** categories are currently informational and may be used for more
nuanced gates later.

## Local gate flow

`make review` owns one bounded cycle; agents do not alternate review and
review-fix commands:

1. An independent read-only reviewer emits the verdict JSON below. The driver
   saves it as `pass-N/findings.json` under its printed `/tmp/lobu-review.*`
   run directory.
2. A clean verdict for the unchanged committed tree posts `pi-review` success.
3. A failed verdict feeds the safe findings into `review-fix.sh` with write
   access. Inside BB the existing isolated-worktree patch transfer is used.
   The fixer runs focused tests and emits an internal result with `summary`,
   `tests: [{command, passed}]`, and
   `decisions: [{kind, finding, question}]`. Decision kinds are `product`,
   `architecture`, `credentials`, or `verification`. Decisions stop the cycle
   and return to the parent; the fixer must not resolve them itself.
4. With no decisions and passing focused tests, a **fresh** read-only review
   inspects the new tree. Neither cached verdicts nor the writer's summary
   can approve that verification pass.
5. `REVIEW_MAX_AUTOFIX_PASSES` defaults to 2 and accepts only 0, 1, or 2.
   Remaining findings, failed/missing tests, malformed output, or tool errors
   fail closed. A failed verdict exits nonzero. The driver writes a structural
   `handoff.json` with `status: "needs_parent"`, `reason`, `head`, `tree`,
   `reviewed_tree`, `autofix_passes`, `decisions`, and the last read-only
   `findings`. `tree` is the current working tree; `reviewed_tree` identifies
   the snapshot those findings describe.

Autofix edits remain uncommitted for the parent to inspect. If independent
verification passes for that dirty tree, the handoff reason is `needs_commit`
and the old commit's status stays failed. Commit and push those edits, wait
for CI, then run `make review` to post success for that commit. The exact
verified diff can reuse its cached verdict; no manual review/fix loop is
needed. A passing working-tree verdict is never posted as approval of an
older commit. Concurrent edits or a moved HEAD invalidate a review.

`make review-fix` remains the standalone pre-review write phase; it posts no
status and commits nothing. `make review` calls it internally with findings
and a structured result path. CI still owns the full deterministic suites;
the write phase runs only focused tests.

Inside BB, review children attach with `BB_ENVIRONMENT_ID` only after
`bb environment show <id> --json` resolves to the reviewed worktree's
canonical path. Otherwise the driver passes the worktree path. It still
checks the child's actual environment before accepting any output.

## Safe-class skip, verdict cache, and shadow sampling

`make review-fix` and `make review` skip their cross-harness LLM pass for diffs
that are small (<100 lines) **and** confined to classes where it adds near-zero
signal: docs, CI-verified generated output, the root `bun.lock`, snapshots,
exact renames between safe-class paths, additive-only tests, exact `model:`
literal swaps in `lobu.config.ts`, or a pure `packages/owletto` pointer bump.
Everything else — non-test `src/`, migrations, package manifests,
runtime-affecting config, other lockfiles, static assets, other submodule
changes, an Owletto bump mixed with any other path, and the gate/CI machinery
itself — always runs the LLM pass regardless of size.
The skip is deterministic and path-gated: the driving agent may only escalate,
never skip on self-assessed confidence. A skipped `make review` posts the same
`pi-review` status as green under a distinct `<!-- pi-review-skipped -->` PR
marker so the skip is auditable; CI suites remain required checks either way.
`REVIEWER_MODE=full make review-fix`, `REVIEWER_MODE=full make review`, or
`./scripts/review.sh --full` forces the corresponding LLM pass.

The verdict is cached keyed on the exact diff content + reviewer identity, so
an unchanged initial diff can reuse a verdict (post-fix verification always
starts a fresh reviewer): the reviewer is non-deterministic, and
a passed diff can flip to fail on a re-run, spawning a phantom fix cycle.
`REVIEWER_SHADOW=1` runs the full reviewer on a would-be-skipped diff and
appends the skip decision + real verdict to `<git-common-dir>/lobu-review-cache/shadow-audit.jsonl`,
so the false-skip rate can be measured rather than assumed. The reviewer's full
transcript is written to files under `/tmp/lobu-review.*/` and only a pointer
is printed, keeping long reviewer output out of the calling agent's context.
