# CLI package agent rules

Read root `AGENTS.md` first. This package is the `lobu` binary users install from npm: commands, project templates, config resolution, and installation of version-matched runtime components. The Owletto Mac app shells out to this launcher.

## Boundaries
- This is a published user-facing binary. Error messages are product surface — write them for someone who has never read this repo, and use **Automation** consistently in anything a user or agent sees.
- `bin/lobu.js` runs on whatever Node the user has, *before* the bundle loads. Keep it dependency-free and import-free; anything it needs must be inline.
- The Mac app resolves the CLI in this order (`locateLobuCLI` in `LocalLobuRunner.swift`): `LOBU_CLI_DEV_PATH`, then the source checkout at `~/Code/lobu/packages/cli/bin/lobu.js`, then the version-pinned CLI bundled in the app, then PATH. PATH is the *last* resort — on a machine with a source checkout the app runs your working copy, so know which artifact you are testing before concluding a change did or did not take effect.
- Every one of those paths executes the built `dist`, so a source edit is invisible until you rebuild the package.

## Package-specific traps
- **The dynamic import in `bin/lobu.js` is required — do not "fix" it to a static import.** A static import is hoisted and evaluated before the Node-version gate runs, so an unsupported Node would load the bundle and throw a cryptic error instead of the friendly message. This is a deliberate, documented exception to the repo's static-import rule.
- Node support is 22–24 and 26+ (25 boots without the SDK sandbox, because isolated-vm@6 covers 22–24 and @7 covers 26+). This policy is expressed in several places that must stay in sync: `bin/lobu.js` (minimum only), `src/internal/node-version.ts` (the full classifier), `packages/server/src/utils/assert-node-version.ts`, and the package `engines` fields. Change them together, not in prose.
- This package **is** biome-formatted — use `bun run check:fix` from the repo root.
- `packages/cli` builds last in every build list because it bundles the others; a new workspace package it depends on must be added *before* it. See `docs/GOTCHAS.md`, "Build & typecheck".

## Validation
- Validation: the root gates (see root `AGENTS.md`) plus targeted CLI tests. Changing command output or the version gate needs a real invocation — run the built binary, not just the unit test.
