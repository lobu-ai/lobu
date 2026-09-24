# Connectors package agent rules

Read root `AGENTS.md` first. This package owns built-in Lobu connectors.

## Connector rules
- Every connector is a default-exported class extending `ConnectorRuntime`. Built-ins in this package are plain `src/<name>.ts` (e.g. `github.ts`); the `*.connector.ts` suffix is for user-authored connectors compiled from a project directory (see `examples/`).
- npm deps go in the project `package.json` and are bundled by esbuild at compile time.
- Native deps go in `runtime.nix.packages` as nixpkgs refs and are provisioned with `nix-shell` at run time.
- Compile happens on the CLI path (`lobu apply`). It runs a frozen install with the project's own package manager (`bun install --frozen-lockfile --ignore-scripts` or `npm ci --ignore-scripts`) and fails when the lockfile is missing; only `lobu init` creates one.
- `@lobu/connector-sdk` is externalized and provided by the runtime.
- Keep connector configuration data-driven; avoid hardcoding account/workspace-specific values.
- For the same source object across syncs, keep `origin_id` stable. Ingestion may supersede the prior event and allocate a new `events.id`; downstream cross-sync dedupe relies on `origin_id`, not the version-row id. Change `origin_id` only when the source identity genuinely changes.

## Validation
- Validation: the root gates (see root `AGENTS.md`) plus targeted connector tests.
