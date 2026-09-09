# Core package agent rules

Read root `AGENTS.md` first. This package holds the shared contracts many other packages build against: types, errors, capabilities, credentials, the guardrail engine, and the logger.

## Boundaries
- Core is the bottom of the dependency graph. It must not import from `server`, `connector-worker`, `connectors`, or any package above it — if a helper needs one of those, it does not belong here.
- Changing an exported type is a fan-out change. Its consumers compile against it, and `packages/server` typechecks against the **built dist**, not the source.
- Guardrails live in `src/guardrails/`. The core runner treats thrown guardrails as passes; gateway consumers persist trips as `guardrail-trip` events. Preserve both halves of that contract when changing guardrail execution.

## Package-specific traps
- **After any contract change, rebuild before trusting a typecheck.** A stale `dist` produces a green typecheck that CI then fails, and inside a worktree it produces phantom `TS2305` errors resolved from the main checkout's dist. `make pre-pr` builds first for exactly this reason. See `docs/GOTCHAS.md`, "Build & typecheck".
- This package is `composite: true`, so use `bunx tsc --build --force` to force a rebuild. A plain `rm -rf dist` leaves a stale `tsconfig.tsbuildinfo` behind and the next build no-ops.
- Unlike `server` and `connector-sdk`, this package **is** biome-formatted — use `bun run check:fix` from the repo root.

## Validation
- Validation: the root gates (see root `AGENTS.md`). For a contract change, also typecheck the consumers — a green build here says nothing about downstream packages.
