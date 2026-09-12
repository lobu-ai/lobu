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
For connector tests, use the gateway's existing dry-run path with a configured
feed: `lobu memory run manage_feeds '{"action":"trigger_feed","feed_id":123,"dry_run":true}'`.
The run uses the feed's configured runtime, including its paired extension;
inspect the preview with `manage_feeds` action `read_feed`.

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

`lobu --help` shows the full grouped command list, and `lobu <cmd> --help` lists the per-command flags. The highlights:

- `lobu init [name]` — scaffold a project. Interactive by default; pass `--yes` (with any of `--port` / `--provider` / `--platform` / `--memory` / `--no-sentry` / etc.) for non-interactive / CI scaffolding. `lobu init .` or `--here` scaffolds into the current directory.
- `lobu run` (aliases: `lobu dev`, `lobu start`) — boot the embedded stack. Pre-flights the gateway port and accepts `--port` / `--quiet` / `--verbose` / `--log-level`.
- `lobu chat <prompt>` — send one prompt and stream the response. `-C/--continue` resumes the last thread (per context+agent); `--auto-approve` skips tool prompts in trusted runs; `--json` emits raw SSE events for piping.
- `lobu connect [agent]` — wire an external client (Claude Code, Codex, OpenCode, Cursor, …) to your Lobu MCP endpoint: installs the supported MCP + skill bundle, or prints the exact native handoff when the host requires UI setup.
- `lobu doctor` — Postgres connectivity, pgvector extension, port availability, provider API keys, workspace dir.
- `lobu link` / `lobu unlink` — bind this directory to a (context, org) at `.lobu/project.json`. `lobu apply` refuses to push mismatched targets unless `--force` is set.
- `lobu apply` (alias: `lobu deploy`) — idempotent sync of `lobu.config.ts` to Lobu Cloud.
- `lobu daemon` — map this machine as a device worker for connector syncs,
  actions, and device Automations.
- `lobu agent scaffold <id>` — add a second/third agent to an existing project.
- `lobu telemetry {status,on,off}` — Sentry is off by default; toggle here.

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
