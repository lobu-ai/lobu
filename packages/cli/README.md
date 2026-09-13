# @lobu/cli

CLI for running Lobu locally and managing Lobu agents through the same REST API as the web app.

## Quick Start

```bash
npx @lobu/cli@latest init my-bot
cd my-bot
# edit .env to set the provider keys your agent uses
lobu run
```

The CLI installs cloud commands and the connector compiler. On the first
`lobu run`, it downloads the matching server runtime. Embedded Postgres and
local embeddings are separate components, selected from the effective
`DATABASE_URL`, `EMBEDDINGS_SERVICE_URL`, and `EMBEDDINGS_BACKEND` settings.
External Postgres plus a remote embeddings service installs neither native
component. Model weights download when local embeddings are first requested.

Software is cached under `~/.cache/lobu/runtime`, separately from database files
and model weights. Versions, platform, libc, and Node ABI have separate cache
entries. Interrupted installs can be retried; completed installations work
without contacting the registry. Set `LOBU_RUNTIME_CACHE_DIR` to relocate this
cache, including for CI or an offline installation on a matching platform.

```bash
lobu runtime install                         # preinstall all components
lobu runtime install server postgres         # select components
lobu runtime install --offline               # verify the installed cache
```

`lobu daemon` prepares the device runtime before polling. Callers of
`lobu automation execute` must run `lobu runtime install device` before claiming
a run: this command refuses a cold cache so downloading cannot consume the
already-claimed run's lease.

Browser tools use the paired Chrome extension through `extensionNetworkSync`
and `extensionDomScrape`. The standalone browser SDK, external CDP endpoints,
`lobu memory browser-auth`, and local `lobu connector run` have been removed.
For connector tests, discover the feed with `search_sdk`, then use the gateway's
existing dry-run path with its returned id:
`lobu memory exec 'export default async (_ctx, client) => client.feeds.trigger({ feed_id: 123, dry_run: true });'`.
The run uses the feed's configured runtime, including its paired extension;
inspect the preview with `client.feeds.get({ feed_id: 123 })` through `lobu memory exec`.
A dry run may access the upstream provider, so obtain consent first.

Lobu boots as a single Node process with embedded Postgres (including pgvector)
by default. `lobu init` writes `DATABASE_URL=file://.`; `file://` values select
an embedded database, while `postgres://` or `postgresql://` connects to an
external Postgres instance. `lobu doctor` reports what's missing.

```bash
docker run -d --name lobu-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=lobu pgvector/pgvector:pg18-trixie
# DATABASE_URL=postgresql://postgres:lobu@localhost:5432/postgres
```

## Commands

`lobu --help` shows the grouped command list, and `lobu <cmd> --help` lists the per-command flags. The full surface, grouped the way `--help` groups it:

### Local dev

- `lobu init [name]` — scaffold a project (`lobu.config.ts` + agent files + `.env`), or bootstrap a re-appliable project from an existing org with `--from-org [slug]`. Interactive by default; pass `-y` / `--yes` (with any other flag) for non-interactive / CI scaffolding. `lobu init .` or `--here` scaffolds into the current directory. Flags: `--port`, `--public-url`, `--network restricted|open|isolated`, `--provider <id>` (`--list-providers` prints the ids and exits), `--provider-key`, `--memory none|lobu-cloud|lobu-custom`, `--memory-url`, `--otel-endpoint`, `--sentry` / `--no-sentry`, `--hosted-slack` / `--no-hosted-slack`, `--url` (with `--from-org`).
  After writing the files, init installs the project's dependencies (prefers `bun`, falls back to `npm`, always with install scripts disabled). Pass `--skip-install` to scaffold files only. The install is warn-don't-fail: if it cannot run, init prints a warning and you run `npm install` (or `bun install`) yourself before `lobu apply`.
- `lobu connect [agent]` — wire an external client (Claude Code, Codex, OpenCode, Cursor, …) to your Lobu MCP endpoint: installs the supported MCP + skill bundle, or prints the exact native handoff when the host requires UI setup. `--url` overrides the MCP server URL; `--dry-run` prints the setup without changing agent configuration.
- `lobu run` (aliases: `lobu dev`, `lobu start`) — boot the embedded stack. Pre-flights the gateway port and accepts `--port` / `--quiet` / `--verbose` / `--log-level`. `--unsafe-shared-db` allows running against a non-loopback `DATABASE_URL` inherited from the shell.
- `lobu chat <prompt>` — send one prompt and stream the response. Flags: `-a` / `--agent`, `-u` / `--user` (impersonate, e.g. `telegram:12345`), `-t` / `--thread`, `-g` / `--gateway`, `--new` (force a fresh session), `-C` / `--continue` (resume the last thread per context+agent), `--dry-run` (skip side-effecting tool calls; the turn still runs and history persists), `--auto-approve` (skip tool prompts in trusted runs), `--json` (raw SSE events for piping), `-c` / `--context`, `--org` (one-run org override, no config write).
- `lobu validate` — validate `lobu.config.ts` schema, skill IDs, and provider config.
- `lobu doctor` — Postgres connectivity, pgvector extension, port availability, provider API keys, workspace dir. `--memory-only` checks just memory MCP connectivity + auth.
- `lobu runtime install [components...]` — preinstall `server`, `device`, `postgres`, and `embeddings` components for offline use; `--offline` verifies the existing cache without downloading.
- `lobu telemetry {status,on,off}` — Sentry is off by default; `on --dsn <dsn>` uses a custom DSN.
- `lobu opencode-plugin <install|status|uninstall>` — manage Lobu's interactive-session plugin for OpenCode.

### Cloud

- `lobu login` — OAuth device-code login. Flags: `--token <pat>` (CI/CD), `-f` / `--force` (re-authenticate, revoking the existing session), `-q` / `--quiet` (suppress the spinner; bail immediately when non-interactive), `--email <address>` (headless login on a user's behalf: the server emails them an approval link), `--wait-for-approval` (keep polling for browser approval when supervised without a TTY). `lobu logout` clears stored credentials.
- `lobu whoami` — current user and linked agent. `--json` emits the machine-readable session contract the Owletto Mac app reads.
- `lobu status` — agent status from the active org.
- `lobu context {list,current,add,use,rm}` — manage named API contexts. `context add <name>` requires `--url` and accepts `--cwd` / `--lifecycle managed|external`; `context rm` is idempotent.
- `lobu org {list,current,set,create}` — manage the active org. `org create <slug>` opens the browser to create an organization with the slug pre-filled (`-n` / `--name` sets the display name).
- `lobu link` / `lobu unlink` — bind this directory to a (context, org) at `.lobu/project.json`. `lobu apply` refuses to push mismatched targets unless `--force` is set.
- `lobu apply` (alias: `lobu deploy`) — idempotent sync of `lobu.config.ts` + agent dirs to your Lobu Cloud org. Flags: `--dry-run`, `--yes` (CI mode), `--only agents|memory`, `--force`, `--resume` (clear the promotions pause a rollback set), `--org`, `--url`.
- `lobu rollback <applyId>` — restore a previous deployment from its stored snapshot; pauses future applies until `lobu apply --resume`.
- `lobu agent {list,get,create,scaffold,update,delete,config get,config patch}` — agent CRUD via the same REST API as the web app. `agent scaffold <id>` adds a second/third agent to an existing project without overwriting existing ones.
- `lobu providers {list,catalog,create,update,set-key,set-capability,set-default,delete}` — manage org model providers. Secret-bearing flags (`--key`) accept `$ENV_VAR` references.
- `lobu sandbox {list,create,set-credential,delete}` — manage sandboxes (runtime providers). (`lobu environment` is the retired name and exits with a pointer to `lobu sandbox`.)
- `lobu clients {list,revoke}` — list connected clients (MCP apps, messaging) and revoke a client's tokens and sessions.
- `lobu call [tool]` — invoke an admin REST tool by name (`POST /api/<org>/<tool>`). Bare or `--list` discovers tools (`--all` includes internal/admin-only ones); pass args with repeated `--arg key=value` / `--arg key:=<json>` or `--input-file`; `--raw` compacts the JSON.
- `lobu token` — print the stored session token (`--raw` for the token only).
- `lobu token create` — mint an org-scoped personal access token for servers/CI. Flags: `--name` (default `lobu-cli-YYYY-MM-DD`), `--description`, `--scope` (default `mcp:read mcp:write`), `--expires-in-days`, `--raw`, `--json`.
- `lobu token revoke <jti>` — revoke a worker/settings token by its `jti` on a **self-hosted** gateway. It writes a row to that gateway's own Postgres (`revoked_tokens`), so `DATABASE_URL` must point at the same database the gateway uses; the command refuses to run without it and has no effect on Lobu Cloud. `--expires-at <iso>` records the token's original expiry so the revocation row is garbage-collected once the token would be dead anyway (default: 24h from now). Tokens minted by `lobu token create` against Lobu Cloud are not affected by this command.

Most cloud subcommands accept `-c` / `--context <name>`; resource commands also accept `--org <slug>` and `--json`.

#### Personal access token limits

PATs (`owl_pat_*`) authenticate CLI and CI calls, but they are narrower than an interactive login:

- **A PAT cannot mint further tokens.** `lobu token create` (`POST /api/<org>/tokens`) rejects PAT-authenticated calls; minting requires a web session or an OAuth login carrying `mcp:admin`, plus org owner/admin role.
- **`lobu org list` and `lobu whoami` show nothing under a default PAT.** Both read `/oauth/userinfo`, which requires the `profile:read` scope, and `token create` only offers `mcp:*` scopes. Pass `--scope "mcp:read mcp:write profile:read"` at mint time if a token needs identity/org discovery.
- **Mutations require `mcp:admin`.** Agent CRUD, `agent config patch`, provider and sandbox changes, and `lobu apply` all require a token with the `mcp:admin` scope (and owner/admin membership in the org); a default `mcp:read mcp:write` PAT is rejected with a 403 naming the missing scope. Read-only routes accept `mcp:read`.

### Memory

- `lobu memory run [tool] [params]` — invoke a memory MCP tool (bare lists the tools).
- `lobu memory exec <script>` — run a TypeScript ClientSDK script via the memory MCP.
- `lobu memory health` — validate Lobu login + MCP connectivity.
- `lobu memory seed [path]` — provision a memory workspace from `lobu.config.ts` + optional `./data` records; `--dry-run` logs what would be created.
- `lobu memory org {current,set}` — active org for memory MCP.

> Note: Lobu's in-house YAML eval runner has been removed. Author evals with [promptfoo](https://www.promptfoo.dev) + `@lobu/promptfoo-provider`; see `examples/personal-finance/evals/promptfooconfig.yaml` for the new pattern.

## Device workers

Run `lobu daemon` on a machine that should execute local connector work or
device-pinned Automations. A normal interactive login automatically authorizes
the daemon with a worker-bound child credential; you do not need to create or
export a personal access token.

```bash
npx -y @lobu/cli@latest daemon --api-url https://your-lobu.example.com
```

If that installation is not logged in yet, the command creates an
origin-specific context and, on a TTY, runs its device-code login; a
non-interactive start prints the `lobu login` command to run first. A login for
another URL is never reused. `WORKER_API_TOKEN` remains available as an explicit
unattended/advanced override.

On the first interactive boot for a named context, the CLI confirms the
`<platform>:<hostname>` identity and can reuse an offline device from the same
platform. The identity and worker-bound child credential are stored owner-only,
per context and platform. Reusing a device keeps its existing server-side
workspace attachment. Team workspaces reach a personal device through a pinned
connection or Automation; `lobu daemon` therefore has no `--org` flag.

Flags: `--api-url <url>` (gateway; defaults to your logged-in context),
`--worker-id <id>` (defaults to `<platform>:<hostname>`, or a per-session id in
a supported interactive agent), `--platform <name>` (defaults to `headless`;
native macOS uses Owletto), `--capabilities <a,b>` (capabilities to advertise;
default `os.shell`), `--label <name>` (device name on the Devices page;
defaults to hostname), `--debug` (poll/heartbeat/retry detail), and
`--no-interactive-session`.

An explicit `--worker-id` overrides both the wizard and the cached identity; on
the login path it must start with `headless:` so it cannot claim another
platform's device. Direct `--api-url` and `LOBU_API_URL` targets match only a
context on the same URL origin; when none exists, the login path creates one for
that installation. When the daemon starts inside a supported Claude Code, Codex,
or OpenCode session, that session receives its own identity so interactive
delivery does not replace the machine's durable device mapping; pass
`--no-interactive-session` to opt out.

Older CLI releases registered a terminal daemon as `macos` when run on a Mac.
The terminal and Docker methods now register as `headless` so they cannot
impersonate the native Mac app. The first upgraded run creates a new Worker
device; reselect that Worker for any connection or Automation pinned to the old
CLI-created Mac device.

## License

Apache-2.0
