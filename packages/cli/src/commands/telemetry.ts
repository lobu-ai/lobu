import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import { setLocalEnvValue } from "../internal/local-env.js";
import { parseEnvContent } from "../internal/env-file.js";

const SENTRY_DSN_DEFAULT =
  "https://63abd848f1338116c41d4a8a29091c7c@o4511547660042240.ingest.us.sentry.io/4511547664171008";

interface TelemetryOptions {
  cwd?: string;
}

async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  for (;;) {
    try {
      await access(join(current, "lobu.config.ts"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error(
    `No Lobu project found from ${resolve(cwd)}. Run this command inside a directory containing lobu.config.ts.`
  );
}

async function loadEnv(cwd: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(cwd, ".env"), "utf-8");
    return parseEnvContent(raw);
  } catch {
    return {};
  }
}

export async function telemetryStatusCommand(
  options: TelemetryOptions = {}
): Promise<void> {
  const cwd = await findProjectRoot(options.cwd ?? process.cwd());
  const env = await loadEnv(cwd);
  const dsn = env.SENTRY_DSN ?? process.env.SENTRY_DSN;
  if (dsn) {
    console.log(chalk.green("\n  Telemetry: on"));
    console.log(chalk.dim(`  SENTRY_DSN: ${redactDsn(dsn)}\n`));
  } else {
    console.log(chalk.dim("\n  Telemetry: off"));
    console.log(chalk.dim("  No SENTRY_DSN configured.\n"));
  }
}

export async function telemetryOnCommand(
  options: TelemetryOptions & { dsn?: string } = {}
): Promise<void> {
  const cwd = await findProjectRoot(options.cwd ?? process.cwd());
  const dsn = options.dsn ?? SENTRY_DSN_DEFAULT;
  await setLocalEnvValue(cwd, "SENTRY_DSN", dsn);
  // The shared community DSN points at the same Sentry project as the hosted
  // deployment, and instrument.ts defaults environment to "production" when
  // ENVIRONMENT is unset — so without this tag a self-hosted install's errors
  // are indistinguishable from real prod incidents in the feed.
  if (!options.dsn) {
    await setLocalEnvValue(cwd, "ENVIRONMENT", "self-host");
  }
  console.log(chalk.green("\n  Telemetry enabled."));
  console.log(chalk.dim(`  Wrote SENTRY_DSN to ${join(cwd, ".env")}\n`));
}

export async function telemetryOffCommand(
  options: TelemetryOptions = {}
): Promise<void> {
  const cwd = await findProjectRoot(options.cwd ?? process.cwd());
  const envPath = join(cwd, ".env");
  let raw = "";
  try {
    raw = await readFile(envPath, "utf-8");
  } catch {
    console.log(chalk.dim("\n  No .env to update — telemetry already off.\n"));
    return;
  }
  const filtered = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("SENTRY_DSN="))
    .join("\n");
  await writeFile(
    envPath,
    filtered.endsWith("\n") ? filtered : `${filtered}\n`
  );
  console.log(chalk.green("\n  Telemetry disabled."));
  console.log(chalk.dim(`  Removed SENTRY_DSN from ${envPath}\n`));
}

function redactDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    // The Sentry public key (URL username) is genuinely public. Only
    // a deprecated DSN format includes a secret in the URL password.
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "***";
  }
}
