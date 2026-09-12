// ─────────────────────────────────────────────────────────────────────────────
// Command modules load after argument parsing. The base CLI installs only
// configuration and cloud dependencies; server/device commands prepare their
// versioned runtime components before loading them. The previous distribution
// installed roughly 2 GiB; the isolated base CLI install measures 178 MiB, with
// help using about 86 MiB RSS. Keep help free of runtime installation.
//
// Rules for adding a new subcommand:
//   1. Put the handler in `./commands/<name>.ts`.
//   2. Register it with `.command(...).action(async (...) => { … })`.
//   3. Inside the action, do `const { fooCommand } = await import("./commands/foo.js");`
//      then call `fooCommand(...)`.
//   4. Do NOT hoist the import to the top of this file.
// ─────────────────────────────────────────────────────────────────────────────

import {
  loadDeviceCommand,
  preinstallRuntime,
} from "./internal/runtime-components.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";
import { Command } from "commander";
import type { CloudCommandOptions } from "./commands/_lib/cloud-options.js";
// Type-only imports of command option shapes. These are erased at compile time
// (no runtime module load), so they do NOT defeat the lazy-import hot path —
// the handler modules are still pulled in only inside each `.action`.
import type { AgentCommandOptions } from "./commands/agent.js";
import type { InitOptions } from "./commands/init.js";
import {
  type OpenCodePluginAction,
  opencodePluginCommand,
} from "./commands/opencode-plugin.js";
import { GATEWAY_DEFAULT_URL } from "./internal/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getPackageVersion(): Promise<string> {
  const pkgPath = join(__dirname, "..", "package.json");
  const pkgContent = await readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(pkgContent) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/**
 * Options shared by most cloud subcommands. `--context` is always present;
 * `--org` / `--json` are opt-in. Descriptions here are the canonical ones —
 * commands needing a different wording (e.g. "Org slug override (defaults to
 * [memory].org)") keep their own explicit `.option(...)` call.
 */
function withCommonOpts(
  cmd: Command,
  opts: { org?: boolean; json?: boolean } = {}
): Command {
  cmd.option("-c, --context <name>", "Use a named context");
  if (opts.org) cmd.option("--org <slug>", "Org slug override");
  if (opts.json) cmd.option("--json", "Print JSON");
  return cmd;
}

/** Commander accumulator for repeatable `--flag <entry>` options. */
function collectOption(
  value: string,
  previous: string[] | undefined
): string[] {
  return previous ? [...previous, value] : [value];
}

function handleCliError(error: unknown): void {
  const exitCode =
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof (error as { exitCode?: unknown }).exitCode === "number"
      ? (error as { exitCode: number }).exitCode
      : 1;
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red("\n  Error:"), message);
  process.exitCode = exitCode;
}

export async function runCli(
  argv: readonly string[] = process.argv
): Promise<void> {
  const program = new Command();
  const version = await getPackageVersion();

  program
    .name("lobu")
    .description("CLI for deploying and managing AI agents on Lobu")
    .version(version);

  // Group commands in --help output. Commander v14 has no native grouping,
  // so we override the help formatter via addHelpText to print our own
  // categorized list. The flat command list is still available.
  program.addHelpText(
    "after",
    `
Local dev:
  init [name]              Scaffold a new agent project
  connect [agent]          Connect Claude, Codex, OpenCode, or another agent
  run | dev | start        Boot the embedded Lobu stack
  chat <prompt>            Send a prompt to an agent and stream the response
  validate                 Validate lobu.config.ts
  doctor                   Health checks (deps, DB, pgvector, ports, keys)
  runtime install [...]    Preinstall runtime components for offline use
  telemetry                Show / toggle anonymous error reporting
  opencode-plugin <action> Install, inspect, or remove interactive OpenCode support

Cloud:
  login | logout           OAuth device-code login (or --token for CI)
  whoami | status          Show user / agent state
  context <subcmd>         Manage API contexts
  org <subcmd>             Manage active org slug
  link | unlink            Bind this directory to a (context, org)
  apply | deploy           Sync lobu.config.ts to cloud (idempotent)
  agent <subcmd>           CRUD agents via REST
  providers <subcmd>       Manage org model providers (create, set-key, ...)
  sandbox <subcmd>         Manage sandboxes (runtime providers)
  clients <subcmd>         List / revoke connected clients (MCP, messaging)
  call [tool]              Invoke an admin REST tool by name (--list to discover)
  token [create]           Print or mint personal access tokens

Memory:
  memory run [tool]        Invoke a memory MCP tool
  memory exec <script>     Run a ClientSDK script
  memory health            Validate login + MCP connectivity
  memory seed [path]       Provision a memory workspace
`
  );

  // ─── connect ───────────────────────────────────────────────────────
  program
    .command("connect [agent]")
    .description(
      "Install Lobu MCP and skills for Claude Code, Codex, OpenCode, or another agent"
    )
    .option("--url <url>", "MCP server URL (defaults to Lobu Cloud)")
    .option("--dry-run", "Show the setup without changing agent configuration")
    .action(
      async (
        agent: string | undefined,
        options: { url?: string; dryRun?: boolean }
      ) => {
        const { connectCommand } = await import("./commands/connect.js");
        await connectCommand(agent, options);
      }
    );

  // ─── init ───────────────────────────────────────────────────────────
  program
    .command("init [name]")
    .description(
      "Scaffold a new agent project (lobu.config.ts + agent files + .env), or bootstrap one from an existing org with --from-org"
    )
    .option("-y, --yes", "Skip prompts; use defaults / flag values")
    .option(
      "--here",
      "Scaffold into the current directory (alias for `init .`)"
    )
    .option("--port <port>", "Gateway port (default 8787)")
    .option("--public-url <url>", "Public gateway URL (OAuth/webhooks)")
    .option(
      "--network <policy>",
      "Worker network policy: restricted | open | isolated"
    )
    .option("--provider <id>", "Provider id from `config/providers.json`")
    .option("--provider-key <key>", "Provider API key (else read from env)")
    .option(
      "--memory <choice>",
      "Memory backend: none | lobu-cloud | lobu-custom"
    )
    .option(
      "--memory-url <url>",
      "Custom memory MCP URL (with --memory lobu-custom)"
    )
    .option("--otel-endpoint <url>", "OpenTelemetry collector endpoint")
    .option("--sentry", "Enable Sentry error reporting")
    .option("--no-sentry", "Disable Sentry without prompting")
    .option(
      "--hosted-slack",
      "Use the hosted Lobu Slack bot (no bot token) in lobu.config.ts"
    )
    .option("--no-hosted-slack", "Skip the hosted Slack bot without prompting")
    .option(
      "--list-providers",
      "Print available provider ids from config/providers.json and exit"
    )
    .option(
      "--from-org [slug]",
      "Bootstrap a re-appliable project from an existing org (defaults to active session)"
    )
    .option("--url <url>", "Server URL override (with --from-org)")
    .action(
      async (
        name: string | undefined,
        // Commander's raw shape: `sentry` is a tristate (true=--sentry,
        // false=--no-sentry, undefined=neither) and `fromOrg` is string|true.
        // Every other field maps 1:1 onto InitOptions, so we spread and only
        // normalize those two below.
        options: Omit<InitOptions, "sentry" | "noSentry" | "fromOrg"> & {
          sentry?: boolean;
          fromOrg?: string | true;
        }
      ) => {
        const { initCommand } = await import("./commands/init.js");
        // `--from-org` with no value is `true`; normalize to "" (active org).
        const fromOrg =
          options.fromOrg === undefined
            ? undefined
            : options.fromOrg === true
              ? ""
              : options.fromOrg;
        await initCommand(process.cwd(), name, {
          ...options,
          sentry: options.sentry === true,
          noSentry: options.sentry === false,
          fromOrg,
        });
      }
    );

  // ─── chat ──────────────────────────────────────────────────────────
  program
    .command("chat <prompt>")
    .description(
      "Send a prompt to an agent and stream the response. With --user, routes through Telegram/Slack."
    )
    .option(
      "-a, --agent <id>",
      "Agent ID (defaults to first in lobu.config.ts)"
    )
    .option("-u, --user <id>", "User ID to impersonate (e.g. telegram:12345)")
    .option("-t, --thread <id>", "Thread/conversation ID for multi-turn")
    .option(
      "-g, --gateway <url>",
      `Gateway URL (default: ${GATEWAY_DEFAULT_URL})`
    )
    .option(
      "--dry-run",
      "Skip side-effecting tool calls (sandbox writes, sdk_run mutations). The turn still runs and history is still persisted."
    )
    .option("--new", "Force new session (ignore existing)")
    .option(
      "-C, --continue",
      "Resume the last thread for this (context, agent)"
    )
    .option(
      "--auto-approve",
      "Auto-approve every tool call (use only in trusted environments)"
    )
    .option("--json", "Emit raw SSE events as JSON lines instead of text")
    .option("-c, --context <name>", "Use a named context")
    .option(
      "--org <slug>",
      "Org slug override for this run (defaults to active context org; no config write)"
    )
    .action(
      async (
        prompt: string,
        options: {
          agent?: string;
          gateway?: string;
          user?: string;
          thread?: string;
          dryRun?: boolean;
          new?: boolean;
          continue?: boolean;
          context?: string;
          org?: string;
          autoApprove?: boolean;
          json?: boolean;
        }
      ) => {
        const { chatCommand } = await import("./commands/chat.js");
        await chatCommand(process.cwd(), prompt, options);
      }
    );

  // ─── validate ───────────────────────────────────────────────────────
  program
    .command("validate")
    .description(
      "Validate lobu.config.ts schema, skill IDs, and provider config"
    )
    .action(async () => {
      const { validateCommand } = await import("./commands/validate.js");
      const valid = await validateCommand(process.cwd());
      if (!valid) process.exit(1);
    });

  // ─── apply / deploy ─────────────────────────────────────────────────
  program
    .command("apply")
    .alias("deploy")
    .description(
      "Sync lobu.config.ts + agent dirs to your Lobu Cloud org (idempotent)"
    )
    .option("--dry-run", "Show the plan and exit without mutating")
    .option("--yes", "Skip the confirmation prompt (CI mode)")
    .option(
      "--only <kind>",
      "Restrict to one resource family: 'agents' | 'memory'"
    )
    .option("--org <slug>", "Org slug override (defaults to active session)")
    .option("--url <url>", "Server URL override")
    .option(
      "--force",
      "Bypass the project-link guard if context/org don't match"
    )
    .option(
      "--resume",
      "Clear the promotions pause a `lobu rollback` set and proceed"
    )
    .action(
      async (options: {
        dryRun?: boolean;
        yes?: boolean;
        only?: string;
        org?: string;
        url?: string;
        force?: boolean;
        resume?: boolean;
      }) => {
        if (
          options.only !== undefined &&
          options.only !== "agents" &&
          options.only !== "memory"
        ) {
          console.error(
            chalk.red("\n  Error:"),
            `--only must be 'agents' or 'memory' (got: ${options.only})`
          );
          process.exit(2);
        }
        const { applyCommand } = await import(
          "./commands/_lib/apply/apply-cmd.js"
        );
        await applyCommand({
          dryRun: options.dryRun,
          yes: options.yes,
          only: options.only as "agents" | "memory" | undefined,
          org: options.org,
          url: options.url,
          force: options.force,
          resume: options.resume,
          cliVersion: version,
        });
      }
    );

  // ─── rollback ───────────────────────────────────────────────────────────
  program
    .command("rollback")
    .argument("<applyId>", "Deployment to restore (apl_… from `Deployments`)")
    .description(
      "Restore a previous deployment from its stored snapshot (pauses future applies until --resume)"
    )
    .option("--yes", "Skip the confirmation prompt (CI mode)")
    .option("--org <slug>", "Org slug override (defaults to active session)")
    .option("--url <url>", "Server URL override")
    .action(
      async (
        applyId: string,
        options: { yes?: boolean; org?: string; url?: string }
      ) => {
        const { rollbackCommand } = await import(
          "./commands/_lib/apply/rollback-cmd.js"
        );
        await rollbackCommand({
          applyId,
          yes: options.yes,
          org: options.org,
          url: options.url,
          cliVersion: version,
        });
      }
    );

  // ─── run / dev / start ──────────────────────────────────────────────
  program
    .command("run")
    .aliases(["dev", "start"])
    .description(
      "Run the embedded Lobu stack (gateway + workers in one Node process)"
    )
    .option("--port <port>", "Gateway port (overrides GATEWAY_PORT in .env)")
    .option("--quiet", "Suppress startup banner; raise log level to warn")
    .option("--verbose", "Lower log level to debug")
    .option("--log-level <level>", "Forwarded as LOG_LEVEL to the bundle")
    .option(
      "--unsafe-shared-db",
      "Allow running against a non-loopback DATABASE_URL inherited from the shell"
    )
    .action(
      async (options: {
        port?: string;
        quiet?: boolean;
        verbose?: boolean;
        logLevel?: string;
        unsafeSharedDb?: boolean;
      }) => {
        const { devCommand } = await import("./commands/dev.js");
        await devCommand(process.cwd(), options);
      }
    );

  // ─── login ──────────────────────────────────────────────────────────
  withCommonOpts(
    program
      .command("login")
      .description("Authenticate with Lobu Cloud")
      .option("--token <token>", "Use API token directly (CI/CD)")
  )
    .option("-f, --force", "Re-authenticate (revokes existing session)")
    .option(
      "-q, --quiet",
      "Suppress spinner; bail immediately if non-interactive (CI / backgrounded shells)"
    )
    .option(
      "--email <address>",
      "Headless login on a user's behalf: the server emails them an approval link (auth.md user_claimed flow)"
    )
    .option(
      "--wait-for-approval",
      "Keep polling for browser approval when supervised without a TTY"
    )
    .action(
      async (options: {
        token?: string;
        context?: string;
        force?: boolean;
        quiet?: boolean;
        email?: string;
        waitForApproval?: boolean;
      }) => {
        const { loginCommand } = await import("./commands/login.js");
        await loginCommand({ ...options, cliVersion: version });
      }
    );

  // ─── logout ─────────────────────────────────────────────────────────
  withCommonOpts(
    program.command("logout").description("Clear stored credentials")
  ).action(async (options: { context?: string }) => {
    const { logoutCommand } = await import("./commands/logout.js");
    await logoutCommand(options);
  });

  // ─── whoami ─────────────────────────────────────────────────────────
  withCommonOpts(
    program
      .command("whoami")
      .description("Show current user and linked agent")
      .option("--json", "Emit machine-readable session JSON (for Owletto Mac)")
  ).action(async (options: { context?: string; json?: boolean }) => {
    const { whoamiCommand } = await import("./commands/whoami.js");
    await whoamiCommand(options);
  });

  // ─── token ──────────────────────────────────────────────────────────
  const token = withCommonOpts(
    program.command("token").description("Print or create Lobu access tokens")
  )
    .option("--raw", "Print token only (no labels)")
    .action(async (options: { context?: string; raw?: boolean }) => {
      const { tokenCommand } = await import("./commands/token.js");
      await tokenCommand(options);
    });

  const tokenCreate = withCommonOpts(
    token
      .command("create")
      .description("Create an org-scoped personal access token for servers/CI"),
    { org: true }
  )
    .option("--name <name>", "Token name (default: lobu-cli-YYYY-MM-DD)")
    .option("--description <text>", "Token description")
    .option(
      "--scope <scope>",
      "Space-separated scopes (default: mcp:read mcp:write)"
    )
    .option(
      "--expires-in-days <days>",
      "Expire token after N days",
      (value) => {
        const days = Number(value);
        if (!Number.isInteger(days) || days < 1) {
          throw new Error("--expires-in-days must be a positive integer");
        }
        return days;
      }
    )
    .option("--raw", "Print token only")
    .option("--json", "Print JSON response");
  // `-c/--context` is declared on both `token` and `token create`. Commander
  // binds a flag shared by parent and child to the *parent*, so the child's
  // local `.opts()` never sees `context` — read `optsWithGlobals()` to merge
  // the ancestor's value back in (otherwise `-c` is silently ignored, #1023).
  tokenCreate.action(async () => {
    const { tokenCreateCommand } = await import("./commands/token.js");
    await tokenCreateCommand(tokenCreate.optsWithGlobals());
  });

  token
    .command("revoke <jti>")
    .description("Revoke a worker/settings token by its jti (kill switch)")
    .option(
      "--expires-at <iso>",
      "Original token expiry (ISO 8601); the revocation row is GC'd past it. Defaults to 24h from now."
    )
    .action(async (jti: string, options: { expiresAt?: string }) => {
      const { tokenRevokeCommand } = await import("./commands/token.js");
      await tokenRevokeCommand(jti, options);
    });

  // ─── context ────────────────────────────────────────────────────────
  const context = program
    .command("context")
    .description("Manage Lobu API contexts");

  context
    .command("list")
    .description("List configured contexts")
    .action(async () => {
      const { contextListCommand } = await import("./commands/context.js");
      await contextListCommand();
    });

  context
    .command("current")
    .description("Show the active context")
    .action(async () => {
      const { contextCurrentCommand } = await import("./commands/context.js");
      await contextCurrentCommand();
    });

  context
    .command("add <name>")
    .description("Add a named context")
    .requiredOption("--url <url>", "Base URL for this context")
    .option(
      "--cwd <path>",
      "Working directory the lifecycle owner cd's into before spawning `lobu run` (used by per-worktree contexts)"
    )
    .option(
      "--lifecycle <mode>",
      "managed | external — managed means the menubar spawns `lobu run`",
      (value: string) => {
        if (value !== "managed" && value !== "external") {
          throw new Error(`--lifecycle must be 'managed' or 'external'`);
        }
        return value;
      }
    )
    .action(
      async (
        name: string,
        options: {
          url: string;
          cwd?: string;
          lifecycle?: "managed" | "external";
        }
      ) => {
        const { contextAddCommand } = await import("./commands/context.js");
        await contextAddCommand({
          name,
          url: options.url,
          cwd: options.cwd,
          lifecycle: options.lifecycle,
        });
      }
    );

  context
    .command("use <name>")
    .description("Set the active context")
    .action(async (name: string) => {
      const { contextUseCommand } = await import("./commands/context.js");
      await contextUseCommand(name);
    });

  context
    .command("rm <name>")
    .description("Remove a named context (idempotent)")
    .action(async (name: string) => {
      const { contextRmCommand } = await import("./commands/context.js");
      await contextRmCommand(name);
    });

  // ─── status ─────────────────────────────────────────────────────────
  withCommonOpts(
    program
      .command("status")
      .description("Show agent status from the active org"),
    { org: true }
  ).action(async (options: { context?: string; org?: string }) => {
    const { statusCommand } = await import("./commands/status.js");
    await statusCommand(options);
  });

  // ─── org ────────────────────────────────────────────────────────────
  const org = program.command("org").description("Manage active Lobu org");

  withCommonOpts(
    org
      .command("list")
      .description("List organizations available to the current login")
  ).action(async (options: { context?: string }) => {
    const { orgListCommand } = await import("./commands/org.js");
    await orgListCommand(options);
  });

  withCommonOpts(
    org.command("current").description("Show the active org")
  ).action(async (options: { context?: string }) => {
    const { orgCurrentCommand } = await import("./commands/org.js");
    await orgCurrentCommand(options);
  });

  withCommonOpts(
    org.command("set <slug>").description("Set the active org slug")
  ).action(async (slug: string, options: { context?: string }) => {
    const { orgSetCommand } = await import("./commands/org.js");
    await orgSetCommand(slug, options);
  });

  withCommonOpts(
    org
      .command("create <slug>")
      .description(
        "Open the browser to create an organization (slug pre-filled)"
      )
      .option("-n, --name <name>", "Organization display name")
  ).action(
    async (slug: string, options: { name?: string; context?: string }) => {
      const { orgCreateCommand } = await import("./commands/org.js");
      await orgCreateCommand(slug, options);
    }
  );

  // ─── link / unlink ──────────────────────────────────────────────────
  withCommonOpts(
    program
      .command("link")
      .description(
        "Bind the current directory to a (context, org). Stored at .lobu/project.json."
      )
      .option("--org <slug>", "Org slug to link (defaults to active)")
  ).action(async (options: { context?: string; org?: string }) => {
    const { linkCommand } = await import("./commands/link.js");
    await linkCommand(options);
  });

  program
    .command("unlink")
    .description("Remove the project link file")
    .action(async () => {
      const { unlinkCommand } = await import("./commands/link.js");
      await unlinkCommand();
    });

  // ─── agent ──────────────────────────────────────────────────────────
  const agent = program
    .command("agent")
    .description("Manage agents via the same REST API as the web app");

  withCommonOpts(agent.command("list").description("List agents"), {
    org: true,
    json: true,
  }).action(async (options: AgentCommandOptions) => {
    const { agentListCommand } = await import("./commands/agent.js");
    await agentListCommand(options);
  });

  withCommonOpts(agent.command("get <agentId>").description("Get an agent"), {
    org: true,
  }).action(async (agentId: string, options: AgentCommandOptions) => {
    const { agentGetCommand } = await import("./commands/agent.js");
    await agentGetCommand(agentId, options);
  });

  withCommonOpts(
    agent
      .command("create <agentId>")
      .description("Create an agent")
      .option("--name <name>", "Display name")
      .option("--description <text>", "Description"),
    { org: true, json: true }
  ).action(
    async (
      agentId: string,
      options: AgentCommandOptions & { name?: string; description?: string }
    ) => {
      const { agentCreateCommand } = await import("./commands/agent.js");
      await agentCreateCommand(agentId, options);
    }
  );

  agent
    .command("scaffold <agentId>")
    .description(
      "Add a new local agent (agents/<id>/* + lobu.config.ts entry) without overwriting existing ones"
    )
    .option("--name <name>", "Display name")
    .option("--description <text>", "Description")
    .action(
      async (
        agentId: string,
        options: { name?: string; description?: string }
      ) => {
        const { agentScaffoldCommand } = await import("./commands/agent.js");
        await agentScaffoldCommand(agentId, options);
      }
    );

  withCommonOpts(
    agent
      .command("update <agentId>")
      .description("Update agent metadata")
      .option("--name <name>", "Display name")
      .option("--description <text>", "Description"),
    { org: true, json: true }
  ).action(
    async (
      agentId: string,
      options: AgentCommandOptions & { name?: string; description?: string }
    ) => {
      const { agentUpdateCommand } = await import("./commands/agent.js");
      await agentUpdateCommand(agentId, options);
    }
  );

  withCommonOpts(
    agent
      .command("delete <agentId>")
      .description("Delete an agent")
      .option("--yes", "Confirm deletion"),
    { org: true }
  ).action(
    async (
      agentId: string,
      options: AgentCommandOptions & { yes?: boolean }
    ) => {
      const { agentDeleteCommand } = await import("./commands/agent.js");
      await agentDeleteCommand(agentId, options);
    }
  );

  const agentConfig = agent
    .command("config")
    .description("Read or patch agent config");

  withCommonOpts(
    agentConfig
      .command("get <agentId>")
      .description("Print agent config JSON")
      .option("--output <file>", "Write JSON to a file"),
    { org: true }
  ).action(
    async (
      agentId: string,
      options: AgentCommandOptions & { output?: string }
    ) => {
      const { agentConfigGetCommand } = await import("./commands/agent.js");
      await agentConfigGetCommand(agentId, options);
    }
  );

  withCommonOpts(
    agentConfig
      .command("patch <agentId>")
      .description("Patch agent config from a JSON file")
      .requiredOption(
        "--file <file>",
        "JSON file with config fields to update"
      ),
    { org: true, json: true }
  ).action(
    async (
      agentId: string,
      options: AgentCommandOptions & { file: string }
    ) => {
      const { agentConfigPatchCommand } = await import("./commands/agent.js");
      await agentConfigPatchCommand(agentId, options);
    }
  );

  // ─── providers ──────────────────────────────────────────────────────
  // Org model providers over the same REST surface the web console and
  // `lobu apply` (`defineConfig({ providers })`) edit — one store, many
  // editors. Exists so a project with no lobu.config.ts can still add a
  // provider. Secret-bearing flags take `$VAR` env references.
  const providers = program
    .command("providers")
    .description("Manage org model providers (inference providers)");

  withCommonOpts(
    providers.command("list").description("List the org's model providers"),
    { org: true, json: true }
  ).action(async (options: CloudCommandOptions) => {
    const { providersListCommand } = await import(
      "./commands/providers/manage.js"
    );
    await providersListCommand(options);
  });

  withCommonOpts(
    providers
      .command("catalog")
      .description("List provider kinds available to add"),
    { org: true, json: true }
  ).action(async (options: CloudCommandOptions) => {
    const { providersCatalogCommand } = await import(
      "./commands/providers/manage.js"
    );
    await providersCatalogCommand(options);
  });

  withCommonOpts(
    providers
      .command("create <slug>")
      .description("Add a model provider with an API key")
      .requiredOption(
        "--kind <kind>",
        "Provider kind (see `providers catalog`)"
      )
      .requiredOption(
        "--key <key>",
        "API key value or '$ENV_VAR' env reference (quote it)"
      )
      .option("--name <name>", "Display name")
      .option("--model <id>", "Default text model")
      .option(
        "--capabilities <json>",
        'Per-modality overrides, e.g. {"text":{"model":"gpt-4o"}}'
      )
      .option("--default", "Set as the org default provider"),
    { org: true, json: true }
  ).action(
    async (
      slug: string,
      options: CloudCommandOptions & {
        kind: string;
        key: string;
        name?: string;
        model?: string;
        capabilities?: string;
        default?: boolean;
      }
    ) => {
      const { providersCreateCommand } = await import(
        "./commands/providers/manage.js"
      );
      await providersCreateCommand(slug, options);
    }
  );

  withCommonOpts(
    providers
      .command("update <slug>")
      .description("Rename a provider")
      .requiredOption("--name <name>", "Display name"),
    { org: true, json: true }
  ).action(
    async (slug: string, options: CloudCommandOptions & { name: string }) => {
      const { providersUpdateCommand } = await import(
        "./commands/providers/manage.js"
      );
      await providersUpdateCommand(slug, options);
    }
  );

  withCommonOpts(
    providers
      .command("set-key <slug>")
      .description("Rotate a provider's API key")
      .requiredOption(
        "--key <key>",
        "API key value or '$ENV_VAR' env reference (quote it)"
      ),
    { org: true }
  ).action(
    async (slug: string, options: CloudCommandOptions & { key: string }) => {
      const { providersSetKeyCommand } = await import(
        "./commands/providers/manage.js"
      );
      await providersSetKeyCommand(slug, options);
    }
  );

  withCommonOpts(
    providers
      .command("set-capability <slug> <modality>")
      .description("Set one modality's model/endpoint (text, image, stt, tts)")
      .option("--model <id>", "Default model for the modality")
      .option("--base-url <url>", "Upstream base URL override")
      .option(
        "--models-endpoint <path>",
        "Model-discovery path (e.g. /models)"
      ),
    { org: true }
  ).action(
    async (
      slug: string,
      modality: string,
      options: CloudCommandOptions & {
        model?: string;
        baseUrl?: string;
        modelsEndpoint?: string;
      }
    ) => {
      const { providersSetCapabilityCommand } = await import(
        "./commands/providers/manage.js"
      );
      await providersSetCapabilityCommand(slug, modality, options);
    }
  );

  withCommonOpts(
    providers
      .command("set-default <slug>")
      .description("Make a provider the org default"),
    { org: true }
  ).action(async (slug: string, options: CloudCommandOptions) => {
    const { providersSetDefaultCommand } = await import(
      "./commands/providers/manage.js"
    );
    await providersSetDefaultCommand(slug, options);
  });

  withCommonOpts(
    providers
      .command("delete <slug>")
      .description("Delete a provider")
      .option("--yes", "Confirm deletion"),
    { org: true }
  ).action(
    async (slug: string, options: CloudCommandOptions & { yes?: boolean }) => {
      const { providersDeleteCommand } = await import(
        "./commands/providers/manage.js"
      );
      await providersDeleteCommand(slug, options);
    }
  );

  // ─── sandbox ─────────────────────────────────────────────────────────
  const sandbox = program
    .command("sandbox")
    .description("Manage sandboxes (runtime providers)");

  // Hard break on the pre-rename command name — no dual path, just a clear
  // pointer so an old script fails with the new verb instead of "unknown command".
  program
    .command("environment")
    .description("(renamed) Use `lobu sandbox` instead")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      console.error(
        "lobu environment was renamed to lobu sandbox. Use `lobu sandbox …`."
      );
      process.exitCode = 1;
    });

  withCommonOpts(sandbox.command("list").description("List sandboxes"), {
    org: true,
    json: true,
  }).action(async (options: CloudCommandOptions) => {
    const { sandboxListCommand } = await import("./commands/sandbox.js");
    await sandboxListCommand(options);
  });

  withCommonOpts(
    sandbox
      .command("create <name>")
      .description("Create a sandbox")
      .requiredOption("--provider <kind>", "Runtime provider kind")
      .option(
        "--credential <entry>",
        "Credential field as 'key=value' or 'key=$ENV_VAR' (repeatable, quote it)",
        collectOption
      ),
    { org: true, json: true }
  ).action(
    async (
      name: string,
      options: CloudCommandOptions & {
        provider: string;
        credential?: string[];
      }
    ) => {
      const { sandboxCreateCommand } = await import("./commands/sandbox.js");
      await sandboxCreateCommand(name, options);
    }
  );

  withCommonOpts(
    sandbox
      .command("set-credential <id>")
      .description("Set or rotate a sandbox's credential")
      .requiredOption(
        "--credential <entry>",
        "Credential field as 'key=value' or 'key=$ENV_VAR' (repeatable, quote it)",
        collectOption
      ),
    { org: true }
  ).action(
    async (
      id: string,
      options: CloudCommandOptions & { credential: string[] }
    ) => {
      const { sandboxSetCredentialCommand } = await import(
        "./commands/sandbox.js"
      );
      await sandboxSetCredentialCommand(id, options);
    }
  );

  withCommonOpts(
    sandbox
      .command("delete <id>")
      .description("Delete a sandbox")
      .option("--yes", "Confirm deletion"),
    { org: true }
  ).action(
    async (id: string, options: CloudCommandOptions & { yes?: boolean }) => {
      const { sandboxDeleteCommand } = await import("./commands/sandbox.js");
      await sandboxDeleteCommand(id, options);
    }
  );

  // ─── clients ────────────────────────────────────────────────────────
  const clients = program
    .command("clients")
    .description("List and revoke connected clients (MCP apps, messaging)");

  withCommonOpts(
    clients
      .command("list")
      .description("List connected clients")
      .option("--agent <agentId>", "Only clients assigned to this agent"),
    { org: true, json: true }
  ).action(async (options: CloudCommandOptions & { agent?: string }) => {
    const { clientsListCommand } = await import("./commands/clients.js");
    await clientsListCommand(options);
  });

  withCommonOpts(
    clients
      .command("revoke <clientId>")
      .description("Revoke an MCP client's tokens and sessions")
      .option("--yes", "Confirm revocation"),
    { org: true }
  ).action(
    async (
      clientId: string,
      options: CloudCommandOptions & { yes?: boolean }
    ) => {
      const { clientsRevokeCommand } = await import("./commands/clients.js");
      await clientsRevokeCommand(clientId, options);
    }
  );

  // ─── call ───────────────────────────────────────────────────────────
  // Generic dispatcher over the admin REST tool surface
  // (`POST /api/<org>/<tool>`). Replaces the urge to add bespoke
  // per-action commands (`lobu sync`, `lobu retry-feed`, ...) by exposing
  // every UI-callable tool through one entry point. `lobu memory run` is
  // kept alongside intentionally — it routes via MCP JSON-RPC, this one via
  // the REST proxy. See packages/cli/src/commands/call.ts for the arg shape.
  withCommonOpts(
    program
      .command("call [tool]")
      .description(
        "Invoke an admin REST tool by name (POST /api/<org>/<tool>). Run with --list or no args to discover."
      )
      .option(
        "--list",
        "List tools available to the current token (default when called bare)"
      )
      .option("--all", "Include internal/admin-only tools in --list output")
      .option(
        "--input-file <path>",
        "Read the JSON args body from a file (top-level object)"
      )
      .option(
        "--arg <entry>",
        "Add a top-level arg as key=string or key:=<json> (repeatable)",
        collectOption
      )
      .option("--raw", "Emit compact JSON (default is pretty-printed)")
      .option("--url <url>", "Server URL override"),
    { org: true, json: true }
  ).action(
    async (
      tool: string | undefined,
      options: {
        org?: string;
        context?: string;
        json?: boolean;
        list?: boolean;
        all?: boolean;
        inputFile?: string;
        arg?: string[];
        raw?: boolean;
        url?: string;
      }
    ) => {
      const { callCommand } = await import("./commands/call.js");
      await callCommand(tool, options);
    }
  );

  // ─── connector ──────────────────────────────────────────────────────
  const connector = program
    .command("connector")
    .description("Connector runtime diagnostics");
  // Hidden internal command: the CLI side of the connector-runtime parity
  // smoke gate. Runs the SAME runConnectorRuntimeSelfCheck() the worker image
  // runs (compile + isolate execution), so a packaging/parity drift
  // (e.g. a missing `COPY packages/core`) is caught by RUNNING the artifact,
  // not just building it. CI-only — hidden from help.
  connector
    .command("runtime-self-check", { hidden: true })
    .description(
      "Internal: assert the connector runtime can resolve + compile + execute (CI smoke gate)"
    )
    .option("--json", "Emit machine-readable JSON to stdout")
    .action(async (options: { json?: boolean }) => {
      const { connectorRuntimeSelfCheckCommand } =
        await loadDeviceCommand("connector");
      await connectorRuntimeSelfCheckCommand(options);
    });

  // ─── daemon ─────────────────────────────────────────────────────────
  program
    .command("daemon")
    .description("Run a device worker that polls the gateway for jobs")
    .option(
      "--api-url <url>",
      "Gateway URL (defaults to your logged-in context)"
    )
    .option(
      "--worker-id <id>",
      "Device worker id (defaults to <platform>:<hostname>, or a per-session id in a supported interactive agent)"
    )
    .option(
      "--platform <name>",
      "Device platform (defaults to headless; native macOS uses Owletto)"
    )
    .option(
      "--no-interactive-session",
      "Disable automatic delivery into an inherited Claude, Codex, or OpenCode session"
    )
    .option(
      "--capabilities <a,b>",
      "Capabilities to advertise (default os.shell)"
    )
    .option(
      "--label <name>",
      "Device name on the Devices page (defaults to hostname)"
    )
    .option(
      "--debug",
      "Log poll/heartbeat/retry detail (default: one line per run)"
    )
    .action(async (options) => {
      const { daemonCommand } = await loadDeviceCommand("daemon");
      await daemonCommand({ ...options, cliVersion: version });
    });

  program
    .command("opencode-plugin <action>")
    .description("Manage Lobu's interactive-session plugin for OpenCode")
    .addHelpText("after", "\nActions: install, status, uninstall\n")
    .action(async (action: string) => {
      const actions: OpenCodePluginAction[] = [
        "install",
        "status",
        "uninstall",
      ];
      if (!actions.includes(action as OpenCodePluginAction)) {
        throw new Error(`action must be ${actions.join(", ")}`);
      }
      await opencodePluginCommand(action as OpenCodePluginAction);
    });

  // ─── automation ─────────────────────────────────────────────────────
  const automation = program
    .command("automation")
    .description("Device Automation execution");

  withCommonOpts(
    automation
      .command("execute")
      .description(
        "Execute one already-claimed Automation run (envelope on stdin)"
      )
      .option(
        "--api-url <url>",
        "Gateway URL (defaults to your logged-in context)"
      )
      .option(
        "--worker-id <id>",
        "Worker id that claimed the run (required; must match claimed_by)"
      )
      .option("--job-file <path>", "Read the run envelope from a file")
      .option(
        "--default-agent-kind <kind>",
        "Agent to use when the Automation names no agent_kind"
      )
      .option("--debug", "Log heartbeat/retry detail")
  ).action(async (options) => {
    const { automationExecuteCommand } = await loadDeviceCommand("automation");
    await automationExecuteCommand(options);
  });

  program
    .command("runtime")
    .description("Manage the runtime components cached for this CLI release")
    .command("install [components...]")
    .description(
      "Preinstall server, device, postgres, and embeddings for offline use"
    )
    .option("--offline", "Check the existing cache without downloading")
    .action(async (components: string[], options: { offline?: boolean }) => {
      await preinstallRuntime(components, options.offline);
    });

  // ─── doctor ─────────────────────────────────────────────────────────
  program
    .command("doctor")
    .description("Health checks (deps, DB, pgvector, ports, provider keys)")
    .option("--memory-only", "Only check memory MCP connectivity + auth")
    .action(async (options: { memoryOnly?: boolean }) => {
      const { doctorCommand } = await import("./commands/doctor.js");
      await doctorCommand(options);
    });

  // ─── telemetry ──────────────────────────────────────────────────────
  const telemetry = program
    .command("telemetry")
    .description("Show or toggle anonymous error reporting (Sentry)");
  telemetry
    .command("status", { isDefault: true })
    .description("Show whether telemetry is on or off")
    .action(async () => {
      const { telemetryStatusCommand } = await import(
        "./commands/telemetry.js"
      );
      await telemetryStatusCommand();
    });
  telemetry
    .command("on")
    .description("Enable telemetry (writes SENTRY_DSN to .env)")
    .option("--dsn <dsn>", "Custom Sentry DSN (defaults to Lobu's)")
    .action(async (options: { dsn?: string }) => {
      const { telemetryOnCommand } = await import("./commands/telemetry.js");
      await telemetryOnCommand(options);
    });
  telemetry
    .command("off")
    .description("Disable telemetry (removes SENTRY_DSN from .env)")
    .action(async () => {
      const { telemetryOffCommand } = await import("./commands/telemetry.js");
      await telemetryOffCommand();
    });

  // ─── memory ─────────────────────────────────────────────────────────
  const memory = program
    .command("memory")
    .description("Lobu memory MCP — tools and seeding");

  const memoryOrg = memory
    .command("org")
    .description("Manage active organization for memory MCP");
  withCommonOpts(
    memoryOrg.command("current").description("Show the active org")
  ).action(async (options: { context?: string }) => {
    const { memoryOrgCurrentCommand } = await import(
      "./commands/memory/org.js"
    );
    await memoryOrgCurrentCommand(options);
  });
  withCommonOpts(
    memoryOrg.command("set <slug>").description("Set the active org slug")
  ).action(async (slug: string, options: { context?: string }) => {
    const { memoryOrgSetCommand } = await import("./commands/memory/org.js");
    await memoryOrgSetCommand(slug, options);
  });

  withCommonOpts(
    memory
      .command("run [tool] [params]")
      .description("Invoke an MCP tool (or list tools when called bare)")
      .option("--url <url>", "Server URL override"),
    { org: true }
  ).action(
    async (
      tool: string | undefined,
      params: string | undefined,
      options: { url?: string; org?: string; context?: string }
    ) => {
      const { memoryRunCommand } = await import("./commands/memory/run.js");
      await memoryRunCommand(tool, params, options);
    }
  );

  withCommonOpts(
    memory
      .command("exec <script>")
      .description("Run a TypeScript ClientSDK script via the memory MCP")
      .option("--url <url>", "Server URL override"),
    { org: true }
  ).action(
    async (
      script: string,
      options: { url?: string; org?: string; context?: string }
    ) => {
      const { memoryRunCommand } = await import("./commands/memory/run.js");
      await memoryRunCommand("run_sdk", JSON.stringify({ script }), options);
    }
  );

  withCommonOpts(
    memory
      .command("health")
      .description("Validate Lobu login + MCP connectivity")
      .option("--url <url>", "Server URL override"),
    { org: true }
  ).action(
    async (options: { url?: string; org?: string; context?: string }) => {
      const { memoryHealthCommand } = await import(
        "./commands/memory/health.js"
      );
      await memoryHealthCommand(options);
    }
  );

  memory
    .command("seed [path]")
    .description(
      "Provision a Lobu memory workspace from lobu.config.ts + optional ./data records"
    )
    .option("--dry-run", "Log what would be created without mutating")
    .option("--org <slug>", "Org slug override (defaults to [memory].org)")
    .option("--url <url>", "Server URL override")
    .option("-c, --context <name>", "Use a named context")
    .action(
      async (
        pathArg: string | undefined,
        options: {
          dryRun?: boolean;
          org?: string;
          url?: string;
          context?: string;
        }
      ) => {
        const { memorySeedCommand } = await import("./commands/memory/seed.js");
        await memorySeedCommand(pathArg, options);
      }
    );

  try {
    await program.parseAsync(argv);
  } catch (error) {
    handleCliError(error);
  }
}
