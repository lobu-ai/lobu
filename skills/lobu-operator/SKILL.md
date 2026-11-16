---
name: lobu-operator
description: Contribute safely to the Lobu monorepo: worktrees, package rules, red-to-green fixes, validation gates, SDK-first operations, PRs, and rollout checks.
---

# Lobu Operator — Repo Guide

Use this skill for work on the Lobu monorepo. It routes to repository-owned instructions; it does not carry a second shipping procedure. Locate the intended checkout first. If this is an installed copy outside the repo, read the files below from that checkout, not from the skill's directory. Installed skills may be symlinks into a stale shared checkout. Use the task worktree’s instructions; before trusting shared-checkout recipes, fetch and compare `origin/main:AGENTS.md`. Surface conflicts with session instructions instead of silently substituting commands.

## Before acting

1. Read root `AGENTS.md` and the nearest package `AGENTS.md` for the surface you will edit. Follow their isolation, authorization, safety, validation, and shipping rules. Never write in the shared main checkout; use its required task-worktree setup before editing.
2. Read only the relevant section of `docs/AGENT_PLAYBOOK.md` and symptom entry in `docs/GOTCHAS.md`. If observed code, live state, or an older instruction copy conflicts with the task baseline, surface and reconcile it before acting; never infer permission from an observation.
3. Identify the requested outcome and how to verify it. Bug fixes need reproduced failure and post-fix evidence; status, compilation, and a saved handoff alone do not prove the user's outcome.

## Read when relevant

| Task | Repository source |
| --- | --- |
| Worktree, validation, PR, merge, or rollout | Root `AGENTS.md` → Ship a change; `docs/AGENT_PLAYBOOK.md` → Gates and Post-merge rollout verification |
| Review verdict or resuming a review | `docs/REVIEW_SCHEMA.md` |
| Product model, events, identity, or configuration | `docs/CONCEPTS.md`; owning example's `lobu.config.ts` and instructions |
| Automation execution | `docs/AUTOMATIONS.md` |
| Authoring a connector | `docs/connector-authoring.md`; nearest connector package instructions |
| Browser or device verification | `docs/BROWSER_TESTING.md`; live SDK/operation discovery through the Lobu skill |
| Local/cloud managed authentication | `docs/managed-auth.md` |
| Correction, stale recall, or an unproven completion claim | `docs/AGENT_PLAYBOOK.md` → Evidence |
| Other documentation | `docs/README.md` |

For connected data, memory, and operations, use the installed Lobu skill and discover current SDK methods and operation identifiers. Apply the user's authorized scope; reading a skill does not authorize external mutations. Keep tenant-specific state in its owning configuration and private session evidence out of public repository documentation.
