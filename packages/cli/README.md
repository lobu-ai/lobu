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
`lobu call run_sdk --arg title='Dry-run feed 123' --arg script='export default async (_ctx, client) => client.feeds.trigger({ feed_id: 123, dry_run: true });'`.
The run uses the feed's configured runtime, including its paired extension;
inspect the preview with `client.feeds.get({ feed_id: 123 })` through `lobu call query_sdk` (with a `title`).
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

## Declarative settings and conditional updates

`defineAgent` accepts `settings: Omit<AgentSettingsStored, "updatedAt">`, derived
from the canonical settings schema. The existing `providers`, `skills`, `network`,
`guardrails`, `nixPackages`, and `starters` helpers remain supported. Choose one
source for each setting: apply rejects overlaps between `settings`, a helper,
or a prompt file such as `IDENTITY.md`.

```ts
const support = defineAgent({
  id: "support",
  settings: {
    showToolCalls: false,
    models: ["custom/primary", "custom/fallback"],
    skillsConfig: { skills: [{
      repo: "example/skills", name: "triage", enabled: true,
      content: "# Triage\n\nUse the support checklist.",
    }] },
  },
});
const digest = defineAutomation({
  slug: "digest", agent: support, prompt: "Summarize today's updates.",
  executionConfig: { timeout_seconds: 120, max_budget_usd: 1 },
});
```

Omitted settings stay unmanaged. Supplied nested objects and arrays replace
that top-level setting; valid empty strings, arrays, and objects clear it.
An empty prompt file explicitly clears that prompt. Automation `executionConfig`
is also unmanaged when omitted, replaces the whole execution config when supplied,
and clears with `null`. It cannot be combined with the `model` helper.
Server validation, access rules, approvals, and audit apply to every write.

An Automation can prepare data before its native agent starts, using the same
module as its optional completion reaction:

```ts
// lobu.config.ts
import { defineAutomation, reactionFromFile } from "@lobu/cli/config";

const review = defineAutomation({
  slug: "weekly-review", agent: support,
  prompt: "Read the saved snapshot source and explain the result.",
  reaction: reactionFromFile("./weekly-review.ts"),
});

// weekly-review.ts
export async function prepare(ctx, client) {
  const rows = await client.query("SELECT 19 + 23 AS total");
  return { snapshot: rows };
}
// Optional: export default async function reaction(ctx, client) { ... }
```

The agent reads `knowledge.read({ automation_id, run_id }).sources.snapshot`.
Preparation is durable: it commits before hosted or device agent execution,
and successful results are reused for that run. The module and its input schema
are pinned when the run is created; its optional completion handler receives the
same saved data as `ctx.sources`. Without prompt, skills, extraction `input` or
declared outputs, the module runs code without an LLM: prepare-only saves sources,
default-only executes the job, and both run prepare then default. The owning
agent supplies SDK permissions. Code-only jobs reject model options and device pins.
With analysis inputs, default runs after successful agent completion.
Each returned source must be an array of records, with at most 32 source names
and 16384 UTF-8 JSON bytes total. Names cannot replace configured sources; large
results should use summaries or stored content references. Reads use the existing
`sources_page` cursors and text/JSON cell bounds. Failed or approval-held
preparation starts no agent and advances no arrival mark. Transient failures have
at most three 60-second attempts; external writes must use run-derived idempotency
keys. `prepare` supports native agent windows, including device execution; external
and script definitions, reply turns and captured evaluation runs are unsupported.
New writes reject `execution_config.executor` with 422; `scriptFromFile` and the
`executor` helper are removed. Existing jobs and frozen runs retain compatibility
until explicitly migrated. Omitted options preserve them; `executionConfig: null`
clears a legacy configuration. Do not echo read-only executor data into writes.

Enable module configurations only after all server replicas have the supporting
release; older replicas do not implement the admission gate.

`agents.get(id)` returns `{ action: "get", agent, model, settings, revision }`.
Pass that opaque revision back to prevent overwriting a concurrent edit:

```ts
const before = await client.agents.get("support");
await client.agents.update({
  agent_id: "support", expected_revision: before.revision,
  identity_md: "Support assistant", settings: { showToolCalls: true },
});
```

MCP uses the same fields on `manage_agents` actions `get` and `update`. Identity
keeps the existing `identity_md` spelling for MCP/ClientSDK writes; settings there
exclude `identityMd` and server-owned `updatedAt`. Agent REST reads expose the
same revision as `ETag`; PATCH accepts it in `If-Match`. Malformed preconditions
return 400; stale ones return 409 before a write or approval is queued. Omit the
precondition for existing unconditional callers. `lobu apply` sends the ETag from
its snapshot, advances it after a metadata write, and stops on conflict. Reload
and review the new state before retrying. Pending approvals retain the existing
per-setting stale checks when approved.

### Configuration coverage and remaining boundaries

Apply reconciles project declarations through the existing REST/action handlers;
MCP and ClientSDK invoke the same action handlers. Runtime actions and human
administration have separate authorization requirements. This is the current
coverage, including fields that remain outside declarative apply:

| Resource | Declarative controls | Existing operational controls / remaining gaps |
|---|---|---|
| Agents | Name, description, all canonical stored settings except `updatedAt`, including full skill configs, network/Nix options and `sandboxId`; prompt files and legacy helpers remain available | MCP/ClientSDK `agents` and agent REST share validation, persistence and audit. Auth profiles are separate resources; connections and policies are not agent settings. |
| Automations | Agent, name/description, triggers, prompt, skill snapshots, sources, outputs, reaction scripts/guidance, cooldown, tags, device pin, agent kind, full `executionConfig` | Claim/renew/complete, trigger, archive, upgrade and version inspection remain runtime actions. Entity bindings, `delivery_target` and legacy `model_config` are not declarative fields. |
| Connectors | Authored source/files/dependencies and explicit definitions | Catalog install/discovery and source validation/update use existing tools. Apply uses `expected_version` for installed source updates; source changes require the connector version to advance. |
| Connections | Connector, slug/name, config, auth/app profiles, device pin, managed grant descriptor; supported chat credential modes | Status, visibility, entity bindings and operational reconnect/pairing remain SDK/API operations. BYO/hosted chat rejects unsupported auth-profile, device and feed declarations. Omitted auth/device pins stay unmanaged; declarative null-unpinning is not exposed. |
| Feeds | Connection/feed key, name, config and cron (`null` clears cron) | Timezone, entity bindings and pause/resume are not declarative fields. Read, sync, trigger and health remain SDK/API operations. |
| Auth profiles | Connector, slug/name, kind and noninteractive credential references | OAuth/browser consent is interactive. HTTP/auth-data options, app-profile links, scopes, reconnect/status and org-default selection remain existing SDK/API operations. |
| Entity/relationship schemas | Properties, required fields, collection presentation, event kinds, backing, metrics, resolution rules, relationship rules/purpose | Icons/colors, explicit status, symmetry/inverse metadata and operational rule administration are outside these authoring helpers. |
| Views | Bundled view module, retained source files and dependencies | Rendering/inspection uses the existing view API; writer provenance is recorded by the server. |
| Inference providers | Slug, kind, display name, base URL, capabilities, default and API-key references | `inferenceProviders` exposes list/create/update/setDefault/setCapability/rotateKey/delete through the shared provider writer. OAuth consent remains interactive. |
| External runtimes | Agent assignment through `settings.sandboxId` | Provider lifecycle/credentials remain the existing sandbox REST/CLI surface; there is no declarative sandbox resource or MCP/ClientSDK lifecycle namespace. Built-in V8 execution needs no external runtime provider. |
| Access policy | Existing human administration | Connector policy changes require owner/admin sessions or explicitly human-minted `policies:write` PATs; agent restrictions and approval decisions remain human-session-only. Agents cannot grant themselves access through settings. |

The canonical contracts live in `@lobu/core/contracts/agent-settings` and
`@lobu/core/contracts/tools/*`. The generated HTTP client derives request and
response types from those schemas. A packed local client test does not establish
that a new version has been published to npm; releases follow the protected
versioned release pipeline.

## Entity resolution

Entity types may declare `resolutionPolicy.rules` in `lobu.config.ts`. Each rule
specifies `fields`, a `normalizer` (`email`, `phone`, or `exact`), and `onMatch`
(`auto_link` or `review`). Types without an explicit policy have no matching
rules. Declare a relationship with `purpose: "identity"` for associations;
linked records keep their own IDs and metadata.

## Commands

`lobu --help` shows the grouped command list, and `lobu <cmd> --help` lists the per-command flags. The full surface, grouped the way `--help` groups it:

### Local dev

- `lobu init [name]` — scaffold a project (`lobu.config.ts` + agent files + `.env`), or bootstrap a re-appliable project from an existing org with `--from-org [slug]`. Interactive by default; pass `-y` / `--yes` (with any other flag) for non-interactive / CI scaffolding. `lobu init .` or `--here` scaffolds into the current directory. Flags: `--port`, `--public-url`, `--network restricted|open|isolated`, `--provider <id>` (`--list-providers` prints the ids and exits), `--provider-key`, `--memory none|lobu-cloud|lobu-custom`, `--memory-url`, `--otel-endpoint`, `--hosted-slack` / `--no-hosted-slack`, `--url` (with `--from-org`).
  After writing the files, init installs the project's dependencies (prefers `bun`, falls back to `npm`, always with install scripts disabled). Pass `--skip-install` to scaffold files only. The install is warn-don't-fail: if it cannot run, init prints a warning and you run `npm install` (or `bun install`) yourself before `lobu apply`.
- `lobu connect [agent]` — wire an external client (Claude Code, Codex, OpenCode, Cursor, …) to your Lobu MCP endpoint: installs the supported MCP + skill bundle, or prints the exact native handoff when the host requires UI setup. `--url` overrides the MCP server URL; `--dry-run` prints the setup without changing agent configuration.
- `lobu run` (aliases: `lobu dev`, `lobu start`) — boot the embedded stack. Pre-flights the gateway port and accepts `--port` / `--quiet` / `--verbose` / `--log-level`. `--unsafe-shared-db` allows running against a non-loopback `DATABASE_URL` inherited from the shell.
- `lobu chat <prompt>` — send one prompt and stream the response. Flags: `-a` / `--agent`, `-u` / `--user` (impersonate, e.g. `telegram:12345`), `-t` / `--thread`, `-g` / `--gateway`, `--new` (force a fresh session), `-C` / `--continue` (resume the last thread per context+agent), `--dry-run` (skip side-effecting tool calls; the turn still runs and history persists), `--json` (raw SSE events for piping), `-c` / `--context`, `--org` (one-run org override, no config write).
- `lobu validate` — validate `lobu.config.ts` schema, skill IDs, and provider config.
- `lobu doctor` — Postgres connectivity, pgvector extension, port availability, provider API keys, workspace dir. `--memory-only` checks just memory MCP connectivity + auth.
- `lobu runtime install [components...]` — preinstall `server`, `device`, `postgres`, and `embeddings` components for offline use; `--offline` verifies the existing cache without downloading.
- `lobu opencode-plugin <install|status|uninstall>` — manage Lobu's interactive-session plugin for OpenCode.

### Cloud

- `lobu login` — OAuth device-code login. Flags: `--token <pat>` (CI/CD), `-f` / `--force` (re-authenticate, revoking the existing session), `-q` / `--quiet` (suppress the spinner; bail immediately when non-interactive), `--email <address>` (headless login on a user's behalf: the server emails them an approval link), `--wait-for-approval` (keep polling for browser approval when supervised without a TTY), `--client-name <name>` (register the login as its own OAuth client, default `Lobu CLI`; the activity feed attributes the context's calls to that name, so give each app or script its own context, e.g. `lobu login --context market-supervisor --client-name "Market pipeline supervisor"`). `lobu logout` clears stored credentials.
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
- `lobu call [tool]` — invoke an admin REST tool by name (`POST /api/<org>/<tool>`). Bare or `--list` discovers tools (`--all` includes internal/admin-only ones); pass args with repeated `--arg key=value` / `--arg key:=<json>` or `--input-file`; `--raw` compacts the JSON. `run_sdk`, `query_sdk`, and `query_sql` are refused without a non-empty `title` arg (the call's heading in the activity feed), e.g. `lobu call run_sdk --arg title='Recent support tickets' --arg script='export default async (_ctx, client) => …'`. With `LOBU_API_TOKEN` + `LOBU_MEMORY_URL` set (a device Automation run's credential, valid only on MCP routes), the call goes over MCP `tools/call` to `LOBU_MEMORY_URL` instead of REST.
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

A running daemon checks the published `@lobu/cli` version at start and about
once a day, and prints one line when a newer release exists; set
`LOBU_NO_UPDATE_CHECK=1` to turn the check off. When the server refuses the
daemon's version outright (`409 upgrade_required`), the daemon exits non-zero
with the update steps instead of retrying.

Older CLI releases registered a terminal daemon as `macos` when run on a Mac.
The terminal and Docker methods now register as `headless` so they cannot
impersonate the native Mac app. The first upgraded run creates a new Worker
device; reselect that Worker for any connection or Automation pinned to the old
CLI-created Mac device.

## Named browsers

`lobu browser start <name>` opens a separate Chrome for Testing window with the
Lobu extension loaded and connects it as its own `chrome-extension` device,
authorized by your CLI login. Each name has its own profile, so sites you sign
into stay signed in across restarts; nothing is copied from your own Chrome.

```bash
lobu browser start work          # first run downloads Chrome for Testing
lobu browser list                # running state and device status
lobu browser stop work
lobu browser rm work             # removes the device, its credential, and the profile
```

`start` returns once the browser has connected. Pass `--context <name>` to
choose the installation for a new browser and `--headless` on a machine without
a display. Branded Google Chrome no longer loads extensions from the command
line, so the CLI keeps a Stable Chrome for Testing build under
`~/.cache/lobu/chrome-for-testing` and checks for a newer one at most once a
day; set `LOBU_BROWSER_PATH` to use an existing Chromium or Chrome for Testing
binary instead. macOS and Linux only.

The extension pairs through the profile's own native messaging host, which
mints a worker-bound device credential from your login; no token is passed on
the command line. If the browser later loses its pairing, open the Lobu side
panel in that window to pair again. The CLI's copy of the extension has site
access on every site, so agents need no per-site approval in a named browser;
history, bookmarks, and downloads stay off until you allow them in the side
panel. To run browser operations on it, pin a `chrome` connection to the new
device.

## License

Apache-2.0
