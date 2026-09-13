import chalk from "chalk";
import { Command } from "commander";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { whoamiCommand } from "./commands/whoami.js";

/**
 * Small, self-contained CLI surface bundled with Owletto.app. The desktop app
 * needs auth to remain compatible even when a separately installed global CLI
 * lags behind its Sparkle update. Keep this entrypoint limited to the commands
 * LobuCLISession invokes; local runtime commands continue to use the user's
 * full `lobu` installation.
 */
async function runMacAuthCli(
  argv: readonly string[] = process.argv
): Promise<void> {
  const version = process.env.LOBU_MAC_AUTH_CLI_VERSION ?? "0.0.0";
  const program = new Command()
    .name("lobu")
    .description("Owletto's bundled Lobu authentication helper")
    .version(version);

  program
    .command("login")
    .description("Authenticate with Lobu Cloud")
    .option("-c, --context <name>", "Use a named context")
    .option("--token <token>", "Use API token directly")
    .option("-f, --force", "Re-authenticate (revokes existing session)")
    .option("-q, --quiet", "Suppress spinner output")
    .option("--email <address>", "Email an out-of-band approval link")
    .option(
      "--wait-for-approval",
      "Keep polling for browser approval when supervised without a TTY"
    )
    .action(
      async (options: {
        context?: string;
        token?: string;
        force?: boolean;
        quiet?: boolean;
        email?: string;
        waitForApproval?: boolean;
      }) => {
        await loginCommand({ ...options, cliVersion: version });
      }
    );

  program
    .command("logout")
    .description("Clear stored credentials")
    .option("-c, --context <name>", "Use a named context")
    .action(async (options: { context?: string }) => {
      await logoutCommand(options);
    });

  program
    .command("whoami")
    .description("Show the current Lobu session")
    .option("-c, --context <name>", "Use a named context")
    .option("--json", "Emit machine-readable session JSON")
    .action(async (options: { context?: string; json?: boolean }) => {
      // This entrypoint is bundled inside Owletto and is the trusted native
      // credential bridge. The general `lobu whoami --json` stays token-free.
      await whoamiCommand({ ...options, includeTokens: true });
    });

  try {
    await program.parseAsync([...argv]);
  } catch (error) {
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
}

if (import.meta.main) {
  await runMacAuthCli();
}
