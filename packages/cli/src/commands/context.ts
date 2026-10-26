import chalk from "chalk";
import {
  addContext,
  getCurrentContextName,
  loadContextConfig,
  loadCredentials,
  removeContext,
  resolveContext,
  setCurrentContext,
} from "../internal/index.js";
import type { LobuServerConfig } from "../internal/context.js";

export async function contextListCommand(
  options: { json?: boolean } = {}
): Promise<void> {
  const config = await loadContextConfig();
  const currentContext = await getCurrentContextName();

  if (options.json) {
    // Stored credentials may be expired; listing must not refresh them.
    const contexts = await Promise.all(
      Object.entries(config.contexts).map(async ([name, context]) => ({
        name,
        url: context.url,
        current: name === currentContext,
        loggedIn: (await loadCredentials(name)) !== null,
      }))
    );
    process.stdout.write(
      `${JSON.stringify({ current: currentContext, contexts }, null, 2)}\n`
    );
    return;
  }

  console.log(chalk.bold("\n  Lobu contexts"));
  for (const [name, context] of Object.entries(config.contexts)) {
    const marker = name === currentContext ? chalk.green(" *") : "  ";
    console.log(`${marker} ${name}  ${chalk.dim(context.url)}`);
  }

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
