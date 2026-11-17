import chalk from "chalk";
import {
  type ContextWorkspaceAccess,
  addContext,
  getCurrentContextName,
  loadContextConfig,
  readContextWorkspaceAccess,
  removeContext,
  resolveContext,
  setCurrentContext,
} from "../internal/index.js";
import type { LobuServerConfig } from "../internal/context.js";

/** Per-context bound so one hung or stopped server never stalls the list. */
const CONTEXT_USERINFO_TIMEOUT_MS = 3_000;

export async function contextListCommand(
  options: { json?: boolean } = {}
): Promise<void> {
  const config = await loadContextConfig();
  const currentContext = await getCurrentContextName();
  const entries = Object.entries(config.contexts);
  const access = await Promise.all(
    entries.map(([name, context]) =>
      readContextWorkspaceAccess(
        { name, url: context.url },
        { timeoutMs: CONTEXT_USERINFO_TIMEOUT_MS }
      )
    )
  );

  if (options.json) {
    const contexts = entries.map(([name, context], index) => ({
      name,
      url: context.url,
      current: name === currentContext,
      loggedIn: access[index]!.state !== "logged_out",
      access: access[index]!,
    }));
    process.stdout.write(
      `${JSON.stringify({ current: currentContext, contexts }, null, 2)}\n`
    );
    return;
  }

  console.log(chalk.bold("\n  Lobu contexts"));
  entries.forEach(([name, context], index) => {
    const marker = name === currentContext ? chalk.green(" *") : "  ";
    console.log(`${marker} ${name}  ${chalk.dim(context.url)}`);
    console.log(`      ${formatWorkspaceAccess(name, access[index]!)}`);
  });

  if (process.env.LOBU_CONTEXT || process.env.LOBU_API_URL) {
    console.log(chalk.dim("\n  Environment override is active."));
    if (process.env.LOBU_CONTEXT) {
      console.log(chalk.dim(`  LOBU_CONTEXT=${process.env.LOBU_CONTEXT}`));
    }
    if (process.env.LOBU_API_URL) {
      console.log(chalk.dim(`  LOBU_API_URL=${process.env.LOBU_API_URL}`));
    }
  }

  console.log();
}

function formatWorkspaceAccess(
  name: string,
  access: ContextWorkspaceAccess
): string {
  switch (access.state) {
    case "ok":
      return access.workspaces.length > 0
        ? `workspaces: ${access.workspaces.map((org) => org.slug).join(", ")}`
        : chalk.yellow("no workspaces granted to this login");
    case "logged_out":
      return chalk.dim(`not logged in (lobu login -c ${name})`);
    case "expired":
      return access.refreshable
        ? chalk.yellow(
            `access token expired; the next command on ${name} refreshes it`
          )
        : chalk.red(
            `access token expired and cannot be refreshed (lobu login -c ${name})`
          );
    case "rejected":
      return chalk.red(
        `login rejected, HTTP ${access.status} (lobu login -c ${name} --force)`
      );
    case "unreachable":
      return chalk.dim("server unreachable");
    case "error":
      return chalk.red(`workspace lookup failed, HTTP ${access.status}`);
  }
}

export async function contextCurrentCommand(): Promise<void> {
  const context = await resolveContext();

  console.log(chalk.bold("\n  Current context"));
  console.log(chalk.dim(`  Name: ${context.name}`));
  console.log(chalk.dim(`  URL: ${context.url}`));
  if (context.source === "env") {
    console.log(chalk.dim("  Source: environment override"));
  }
  console.log();
}

export async function contextAddCommand(options: {
  name: string;
  url: string;
  cwd?: string;
  lifecycle?: "managed" | "external";
}): Promise<void> {
  const server: LobuServerConfig = {};
  if (options.cwd) server.cwd = options.cwd;
  if (options.lifecycle) server.lifecycle = options.lifecycle;

  await addContext(
    options.name,
    options.url,
    Object.keys(server).length === 0 ? undefined : server
  );
  console.log(
    chalk.green(`\n  Saved context ${options.name} -> ${options.url}\n`)
  );
}

export async function contextRmCommand(name: string): Promise<void> {
  await removeContext(name);
  console.log(chalk.dim(`\n  Removed context ${name}\n`));
}

export async function contextUseCommand(name: string): Promise<void> {
  const trimmedName = name.trim();
  const config = await setCurrentContext(trimmedName);
  const context = config.contexts[trimmedName];

  if (!context) {
    throw new Error(`Context ${trimmedName} was not found after update.`);
  }

  console.log(chalk.green(`\n  Switched to context ${trimmedName}`));
  console.log(chalk.dim(`  URL: ${context.url}\n`));
}
