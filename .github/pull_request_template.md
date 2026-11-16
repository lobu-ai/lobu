## Summary
<!-- Why this change? 1–3 bullets. Skip if the PR title is self-explanatory. -->

## Test plan
<!-- Check only what you actually ran. See AGENTS.md → "Ship a change". -->
- [ ] Intended files staged explicitly; `make pre-pr` passed before commit/push
- [ ] GitHub CI passed for the exact PR head (canonical full graph; `make pr-full` is optional)
- [ ] Tests run: `make test-unit` / `make test-integration` / targeted `bun test <path>`
- [ ] Bug fix: red→fix→green outputs pasted below
- [ ] If bot runtime changed: ran `./scripts/test-bot.sh` or relevant eval

## Notes
<!-- Screenshots, follow-ups, linked issues (`Closes #123`), breaking-change callouts. Delete if none. -->
