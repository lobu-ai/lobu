# Semantic review

`make review` owns classification, independent review, bounded safe fixes,
verification, and the required `pi-review` status. Full deterministic checks run
in GitHub CI. Semantic review can run alongside CI; success is published only
for a clean committed HEAD with green `ci.yml` for that exact commit.

## Verdict

The reviewer returns three fields:

```json
{
  "decision": "changes_needed",
  "findings": [
    {
      "file": "src/example.ts",
      "line": 42,
      "blocking": true,
      "issue": "Concrete broken execution or contract",
      "evidence": "Reproduction or traced execution path"
    }
  ],
  "verification": {
    "tree": "exact Git tree supplied by the driver",
    "checked": ["Relevant focused checks and CI evidence"],
    "missing": []
  }
}
```

- `pass`: no blocking findings or material verification gaps. Optional findings
  are allowed and never start a write pass.
- `changes_needed`: at least one evidence-backed blocking finding.
- `verification_blocked`: a material check cannot be completed;
  `verification.missing` names what is required. Return control without guessing
  at a code fix.

The closed schema is in `prompts/review-output-schema.json`. There are no
numerical scores, redundant bug counts, or quality thresholds. A maintainability
finding must name its concrete consequence and required correction to block.
Environmental limitations and pending/unrelated CI failures do not become code
bugs. Existing green CI may supply proof unavailable inside a reviewer sandbox.

The driver checks the decision/findings relationship and the exact target tree.
An old turn, a contradictory pass, malformed output, or a moving tree cannot
approve a new snapshot. Model output is not authority to commit or merge.

## One bounded cycle

1. Review once. The reviewer is read-only and independent of the writer.
2. Pass only concrete blocking findings to the internal writer. Fix only clear,
   supported issues, run focused checks, and return uncertain product,
   architecture, credential or verification decisions to the driving agent.
3. Continue the original BB reviewer with the prior findings, fix delta, and
   affected callers. Broaden to a full review if scope/risk expanded or the base
   changed. Outside BB, a read-only invocation receives the same evidence.
4. Stop on pass. Optional suggestions do not reopen the branch.

The branch has at most two automatic write attempts, including interrupted or
failed writes. `REVIEW_MAX_AUTOFIX_PASSES=0|1|2` may lower that ceiling. The ledger
in the Git common directory survives commits, rebases, new command invocations
and explicit resumes. Changing the model does not replenish the budget. A new
branch starts a new cycle. Do not delete the ledger to buy more automated rounds.

A handoff records the current tree, reviewed tree, HEAD, merge base, spent
budget, unresolved findings, and decisions. Resume with explicit instructions:

```sh
make review RESUME=<handoff.json> INSTRUCTIONS=<text-file>
```

The handoff must still match the worktree, HEAD, tree, and merge base. Resume
continues existing findings and the remaining budget. Once exhausted, the
driving agent must resolve the work itself; another invocation can verify those
edits but cannot start more automatic writes. A `needs_commit` handoff requires
inspection, normal pre-PR gates, commit/push, and a rerun to publish the verified
result. It cannot resume another write.

## Results and retries

The driver caches exact reviewed content, base commit, reviewer identity,
prompt, and schema. A commit with exactly the verified content reuses that
verdict; its own CI must still pass. Cache and cycle files are written atomically.
Posting/comment failures retry publication, without another model review.
Malformed nonempty BB output gets one formatting-only continuation in the same
thread on retry. Quota/auth failures and blocked sessions return control instead
of spawning repeated replacements. No silent model fallback occurs.

Set models in `.env`, `.env.local`, or the exported environment. Exported values
win over `.env.local`, then `.env`; dotenv is parsed as data, never executed.
`REVIEWER_CLI=auto` selects the other harness; `claude|codex` is an explicit
selection. There is no model default.

## Trusted safe-class policy

The default classifier skips independent model review for inert text docs,
small additive tests/exact test renames, small snapshots, exact quoted `model:`
literal swaps, and pure existing Owletto pointer bumps. Its content is reviewed
in the Owletto repository; `check-drift` remains required. Size alone does not
escalate inert documentation. Other safe classes retain the small-change bound.

Source, dependency/lockfile changes, executable/generated runtime files,
configuration, instruction files/skills/prompts, review/CI tooling, binary or
symlink docs, mixed pointer changes and unknown paths receive semantic review.

`.github/workflows/review-policy.yml` uses only the default branch's classifier,
kept outside the PR checkout, and treats PR files as Git data. It runs no PR
scripts, dependencies, hooks or actions with its status-writing token. It posts
an audited safe-class `pi-review` success after exact-head CI, rechecking the PR
head before posting. It leaves model-required changes to the review driver.
The workflow becomes active after it lands on the default branch.

`REVIEWER_MODE=full make review` forces independent review locally.
`REVIEWER_SHADOW=1` records full verdicts for skip-eligible diffs to measure the
policy. These local options do not disable the trusted CI policy or other
required checks.
