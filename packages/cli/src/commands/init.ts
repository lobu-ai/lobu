import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { confirm, input, password, select } from "@inquirer/prompts";
import { slugify } from "@lobu/core";
import chalk from "chalk";
import ora from "ora";
import {
  getProviderById,
  loadProviderRegistry,
  type RegistryProvider,
} from "../commands/providers/registry.js";
import { DEFAULT_LOBU_MCP_URL } from "../internal/context.js";
import { setLocalEnvValue } from "../internal/local-env.js";
import { renderTemplate } from "../utils/template.js";
import { installProjectDeps } from "./_lib/ensure-deps-installed.js";
import { initFromOrg } from "./_lib/init-from-org/bootstrap.js";
import { isPortFree } from "./dev.js";

const PROJECT_NAME_PATTERN = /^[a-z0-9-]+$/;
const NETWORK_CHOICES = ["restricted", "open", "isolated"] as const;
type NetworkChoice = (typeof NETWORK_CHOICES)[number];
const MEMORY_CHOICES = ["none", "lobu-cloud", "lobu-custom"] as const;
type MemoryChoice = (typeof MEMORY_CHOICES)[number];

export interface InitOptions {
  yes?: boolean;
  here?: boolean;
  port?: string;
  publicUrl?: string;
  network?: string;
  provider?: string;
  providerKey?: string;
  memory?: string;
  memoryUrl?: string;
  otelEndpoint?: string;
  sentry?: boolean;
  noSentry?: boolean;
  hostedSlack?: boolean;
  listProviders?: boolean;
  /** Scaffold files without installing project dependencies. */
  skipInstall?: boolean;
  /**
   * Bootstrap a complete, re-appliable project from an existing Lobu Cloud org
   * (the inverse of `lobu apply`) instead of scaffolding a blank project. Never
   * overwrites an existing project — scaffolds into a new/empty dir.
   */
  fromOrg?: string;
  /** Server URL override (used with `--from-org`). */
  url?: string;
}

async function pickFreePort(
  start: number,
  opts: { max?: number; avoid?: number[] } = {}
): Promise<number> {
  const max = opts.max ?? 100;
  const avoid = new Set(opts.avoid ?? []);
  for (let i = 0; i < max; i++) {
    const candidate = start + i;
    if (candidate > 65535) break;
    if (avoid.has(candidate)) continue;
    if (await isPortFree(candidate)) return candidate;
  }
  // Fall back to the starting port — the user can resolve the collision at
  // `lobu run` time.
  return start;
}

/**
 * The hardcoded `ClaudeOAuthModule` (providerId="claude") on the gateway
 * already handles both Anthropic OAuth tokens AND raw ANTHROPIC_API_KEY via
 * the same upstream slug. We surface it as a synthetic `--provider claude`
 * choice (with `anthropic` accepted as an alias) so scaffold users can pick
 * Claude without having to know about openrouter or the OAuth flow.
 */
const SYNTHETIC_CLAUDE_PROVIDER: RegistryProvider = {
  id: "claude",
  name: "Claude (Anthropic)",
  description: "Claude models via the native Anthropic API",
  providers: [
    {
      displayName: "Claude (Anthropic)",
      envVarName: "ANTHROPIC_API_KEY",
      upstreamBaseUrl: "https://api.anthropic.com",
      // No hardcoded default model — left unset so the agent runs in auto mode
      // and the gateway resolves the provider's current model at runtime.
      apiKeyInstructions:
        "Get your API key from https://console.anthropic.com/settings/keys",
    },
  ],
};

const PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "claude",
};

function resolveProviderAlias(id: string): string {
  return PROVIDER_ALIASES[id] ?? id;
}

function getAllProviders(): RegistryProvider[] {
  return [SYNTHETIC_CLAUDE_PROVIDER, ...loadProviderRegistry()];
}

function getProviderByIdWithSynth(id: string): RegistryProvider | undefined {
  const resolved = resolveProviderAlias(id);
  if (resolved === SYNTHETIC_CLAUDE_PROVIDER.id) {
    return SYNTHETIC_CLAUDE_PROVIDER;
  }
  return getProviderById(resolved);
}

function printProviderList(): void {
  const providers = getAllProviders();
  if (providers.length === 0) {
    console.log(
      chalk.yellow(
        "No providers registered. Check that config/providers.json is reachable."
      )
    );
    return;
  }
  console.log(chalk.bold("\nAvailable providers:\n"));
  const idCol = Math.max(...providers.map((p) => p.id.length));
  for (const p of providers) {
    const first = p.providers?.[0];
    const env = first?.envVarName ?? "";
    const model = first?.defaultModel ? ` — ${first.defaultModel}` : "";
    const aliases = Object.entries(PROVIDER_ALIASES)
      .filter(([, target]) => target === p.id)
      .map(([alias]) => alias);
    const aliasSuffix =
      aliases.length > 0 ? chalk.dim(`  (alias: ${aliases.join(", ")})`) : "";
    console.log(
      `  ${chalk.cyan(p.id.padEnd(idCol))}  ${chalk.dim(env)}${chalk.dim(model)}${aliasSuffix}`
    );
  }
  console.log(
    chalk.dim(
      "\nPass to scaffold: lobu init <name> --provider <id> [--provider-key <key>]\n"
    )
  );
}

/**
 * Write the project's package.json + tsconfig.json so `lobu apply` (jiti) and
 * the editor can resolve the SDK imports outside this monorepo. Shared by the
 * blank scaffold and `--from-org`. Merges into an existing package.json
 * (preserving the user's fields) and never overwrites an existing tsconfig.
 */
async function scaffoldProjectPackaging(
  projectDir: string,
  projectName: string,
  cliVersion: string
): Promise<void> {
  const pkgJsonPath = join(projectDir, "package.json");
  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    pkgJson = {
      name: projectName,
      version: "0.0.0",
      private: true,
      type: "module",
    };
  }
  pkgJson.devDependencies = {
    ...((pkgJson.devDependencies as Record<string, string> | undefined) ?? {}),
    // lobu.config.ts imports @lobu/cli/config; connectors import
    // @lobu/connector-sdk. Both must be declared so `lobu apply` (jiti) + the
    // editor resolve them.
    "@lobu/cli": `^${cliVersion}`,
    "@lobu/connector-sdk": `^${cliVersion}`,
  };
  await writeFile(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);

  const tsconfigPath = join(projectDir, "tsconfig.json");
  try {
    await readFile(tsconfigPath, "utf-8"); // exists — leave the user's config untouched
  } catch {
    await writeFile(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "Preserve",
            moduleResolution: "bundler",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: [
            "lobu.config.ts",
            "agents/**/*.ts",
            "**/*.connector.ts",
            "**/*.reaction.ts",
          ],
        },
        null,
        2
      )}\n`
    );
  }
}

export async function initCommand(
  cwd: string = process.cwd(),
  projectNameArg?: string,
  options: InitOptions = {}
): Promise<void> {
  const cliVersion = await getCliVersion();
  const useDefaults = options.yes === true;

  if (options.listProviders) {
    printProviderList();
    return;
  }

  // Catch flag combos that can't satisfy a prompt before we mkdir anything.
  if (useDefaults && options.memory === "lobu-custom" && !options.memoryUrl) {
    console.error(
      chalk.red("\n✗ --memory lobu-custom requires --memory-url <url>.\n")
    );
    process.exit(1);
  }

  const here = options.here || projectNameArg === ".";
  let projectName: string;
  let projectDir: string;

  if (here) {
    projectDir = cwd;
    projectName = basename(resolve(cwd));
    if (!PROJECT_NAME_PATTERN.test(projectName)) {
      // Common when cwd is e.g. "My Project". Force user to pick a slug.
      projectName =
        projectNameArg && projectNameArg !== "."
          ? projectNameArg
          : await promptOrDefault({
              flag: undefined,
              useDefaults,
              defaultValue: slugify(basename(resolve(cwd))) || "my-lobu",
              prompt: () =>
                input({
                  message: "Project slug?",
                  default: slugify(basename(resolve(cwd))) || "my-lobu",
                  validate: validateProjectName,
                }),
            });
    }
    const entries = await readdir(projectDir).catch(() => [] as string[]);
    const conflict = entries.some(
      (n) => n === "lobu.config.ts" || n === "agents" || n === ".env"
    );
    if (conflict) {
      console.log(
        chalk.red(
          `\n✗ ${projectDir} already contains a Lobu project (lobu.config.ts / agents/ / .env).\n  Remove them or pick another directory.\n`
        )
      );
      process.exit(1);
    }
    console.log(
      chalk.dim(
        `\nScaffolding into current directory: ${chalk.cyan(projectDir)}\n`
      )
    );
  } else {
    if (projectNameArg && !PROJECT_NAME_PATTERN.test(projectNameArg)) {
      console.log(
        chalk.red(
          `\n✗ Project name must be lowercase alphanumeric with hyphens only (got: ${projectNameArg}).\n`
        )
      );
      process.exit(1);
    }
    projectName =
      projectNameArg ??
      (await promptOrDefault({
        flag: undefined,
        useDefaults,
        defaultValue: "my-lobu",
        prompt: () =>
          input({
            message: "Project name?",
            default: "my-lobu",
            validate: validateProjectName,
          }),
      }));
    projectDir = join(cwd, projectName);
    try {
      await access(projectDir, constants.F_OK);
      console.log(
        chalk.red(
          `\n✗ Directory "${projectName}" already exists. Pick a different name, remove it, or pass \`--here\` to scaffold into the current directory.\n`
        )
      );
      process.exit(1);
    } catch {
      await mkdir(projectDir, { recursive: true });
      console.log(
        chalk.dim(`\nCreating project in: ${chalk.cyan(projectDir)}\n`)
      );
    }
  }

  // Pick free ports at scaffold time so two `lobu run`s on the same machine
  // don't collide on the default 8787 / 8118. The flag / env value wins.
  const gatewayPortDefault = String(await pickFreePort(8787));
  const gatewayPort = await promptOrDefault({
    flag: options.port,
    useDefaults,
    defaultValue: gatewayPortDefault,
    validate: (value: string) => {
      const p = Number(value);
      return Number.isInteger(p) && p >= 1 && p <= 65535
        ? true
        : "Please enter a valid port (1-65535)";
    },
    prompt: () =>
      input({
        message: "Gateway port?",
        default: gatewayPortDefault,
        validate: (value: string) => {
          const p = Number(value);
          if (!Number.isInteger(p) || p < 1 || p > 65535) {
            return "Please enter a valid port number (1-65535)";
          }
          return true;
        },
      }),
  });

  // WORKER_PROXY_PORT is the gateway's outbound HTTP proxy that workers route
  // through (default 8118). Scaffold a non-colliding port so co-resident
  // projects don't fight over it. Avoid the gateway port too — if the user
  // passed `--port 8118` we don't want both vars pointing at the same number.
  const gatewayPortNum = Number(gatewayPort);
  const workerProxyPort = String(
    await pickFreePort(8118, {
      avoid: Number.isFinite(gatewayPortNum) ? [gatewayPortNum] : [],
    })
  );

  // `--from-org`: bootstrap a complete, re-appliable project from an existing
  // cloud org (the inverse of `lobu apply`) instead of the blank scaffold. The
  // project-exists guard above already ran, so we never overwrite a Lobu project.
  if (options.fromOrg !== undefined) {
    await initFromOrg({
      targetDir: projectDir,
      projectName,
      gatewayPort,
      workerProxyPort,
      org: options.fromOrg || undefined,
      url: options.url,
    });
    // Same package.json/tsconfig the blank scaffold writes, so the bootstrapped
    // lobu.config.ts can resolve @lobu/cli/config + re-apply outside this monorepo.
    await scaffoldProjectPackaging(projectDir, projectName, cliVersion);
    if (options.skipInstall) {
      console.log(
        chalk.yellow(
          "\nSkipped dependency installation. Run `npm install` (or `bun install`) before `lobu apply`."
        )
      );
    } else {
      console.log(chalk.dim("\nInstalling project dependencies (this may take a few minutes)..."));
      const depsWarning = installScaffoldedProjectDeps(projectDir, "inherit");
      if (depsWarning) console.log(chalk.yellow(`\n⚠ ${depsWarning}`));
      else console.log(chalk.green("✓ Project dependencies installed"));
    }
    if (!here) {
      console.log(chalk.cyan(`\n  Next: cd ${projectName}\n`));
    }
    return;
  }

  // Database: local embedded Postgres (zero-config) or an existing one. The
  // chosen value is written verbatim to DATABASE_URL — `file://.` boots an
  // isolated embedded PG under ./.lobu/pgdata; a postgres:// URL connects out.
  const databaseChoice = await promptOrDefault({
    flag: undefined,
    useDefaults,
    defaultValue: "embedded",
    validate: (v: string) =>
      v === "embedded" ||
      v === "external" ||
      /^(postgres(ql)?|file):/i.test(v.trim())
        ? true
        : "Must be 'embedded', 'external', or a postgres:// / file:// URL",
    prompt: () =>
      select<string>({
        message: "Database?",
        choices: [
          {
            name: "Local embedded Postgres — zero-config, data in ./.lobu (recommended)",
            value: "embedded",
          },
          { name: "Connect to an existing Postgres", value: "external" },
        ],
        default: "embedded",
      }),
  });

  let databaseUrl: string;
  if (databaseChoice === "external") {
    databaseUrl = (
      await input({
        message: "Postgres connection URL?",
        validate: (v: string) =>
          /^postgres(ql)?:\/\//i.test(v.trim())
            ? true
            : "Must be a postgres:// URL",
      })
    ).trim();
  } else if (/^(postgres(ql)?|file):/i.test(databaseChoice.trim())) {
    // A URL passed directly (e.g. via --yes with an explicit value).
    databaseUrl = databaseChoice.trim();
  } else {
    // embedded → isolated per-project Postgres at ./.lobu/pgdata
    databaseUrl = "file://.";
  }

  const publicGatewayUrl = await promptOrDefault({
    flag: options.publicUrl,
    useDefaults,
    defaultValue: "",
    prompt: () =>
      input({
        message:
          "Public gateway URL? (leave empty for local dev, set for OAuth/webhooks)",
        default: "",
      }),
  });

  const networkPolicy = (await promptOrDefault({
    flag: options.network,
    useDefaults,
    defaultValue: "restricted",
    validate: (v: string) =>
      (NETWORK_CHOICES as readonly string[]).includes(v)
        ? true
        : `Must be one of: ${NETWORK_CHOICES.join(", ")}`,
    prompt: () =>
      select<NetworkChoice>({
        message: "Worker network access?",
        choices: [
          {
            name: "Restricted (recommended) — common registries only (npm, GitHub, PyPI)",
            value: "restricted",
          },
          { name: "Open — workers can access any domain", value: "open" },
          {
            name: "Isolated — workers have no internet access",
            value: "isolated",
          },
        ],
        default: "restricted",
      }),
  })) as NetworkChoice;

  const providerSkills = getAllProviders();
  const providerChoices = [
    { name: "Skip — I'll add a provider later", value: "" },
    ...providerSkills.map((s) => ({
      name: `${s.providers![0]!.displayName}${s.providers![0]!.defaultModel ? ` (${s.providers![0]!.defaultModel})` : ""}`,
      value: s.id,
    })),
  ];
  const validProviderIds = new Set([
    ...providerChoices.map((c) => c.value),
    ...Object.keys(PROVIDER_ALIASES),
  ]);

  const providerIdRaw = await promptOrDefault({
    flag: options.provider,
    useDefaults,
    defaultValue: "",
    validate: (v: string) =>
      v === "" || validProviderIds.has(v)
        ? true
        : `Unknown provider "${v}". Run \`lobu init --list-providers\` to see the full list (also at config/providers.json).`,
    prompt: () =>
      select<string>({
        message: "AI provider?",
        choices: providerChoices,
        default: "",
      }),
  });
  // Resolve aliases (e.g. `--provider anthropic` → "claude") before any
  // downstream use so the synthesized lobu.config.ts references the real id.
  const providerId = providerIdRaw ? resolveProviderAlias(providerIdRaw) : "";

  let providerApiKey = "";
  let selectedProvider: RegistryProvider | undefined;
  if (providerId) {
    selectedProvider = getProviderByIdWithSynth(providerId);
    const p = selectedProvider?.providers?.[0];
    if (p) {
      if (options.providerKey) {
        providerApiKey = options.providerKey;
      } else if (process.env[p.envVarName]) {
        // Inherit from env so `--yes` can pick up keys set in the shell.
        providerApiKey = process.env[p.envVarName] ?? "";
      } else if (!useDefaults) {
        providerApiKey = await password({
          message: `${p.displayName} API key:`,
          mask: true,
        });
      }
    }
  }

  const enableHostedSlack = await promptBooleanOrDefault({
    flag: options.hostedSlack,
    useDefaults,
    defaultValue: false,
    prompt: () =>
      confirm({
        message:
          "Use the hosted Lobu Slack bot? (no bot token needed — link with a code)",
        default: false,
      }),
  });

  const memoryChoice = (await promptOrDefault({
    flag: options.memory,
    useDefaults,
    defaultValue: "none",
    validate: (v: string) =>
      (MEMORY_CHOICES as readonly string[]).includes(v)
        ? true
        : `Must be one of: ${MEMORY_CHOICES.join(", ")}`,
    prompt: () =>
      select<MemoryChoice>({
        message: "Memory:",
        choices: [
          { name: "None (filesystem memory)", value: "none" },
          { name: "Lobu Cloud (app.lobu.ai)", value: "lobu-cloud" },
          { name: "Custom Lobu memory URL", value: "lobu-custom" },
        ],
        default: "none",
      }),
  })) as MemoryChoice;

  const envSecrets: Array<{ envVar: string; value: string }> = [];
  const includeLobuMemory = memoryChoice !== "none";
  let lobuUrl = "";

  if (memoryChoice === "lobu-cloud") {
    lobuUrl = DEFAULT_LOBU_MCP_URL;
  } else if (memoryChoice === "lobu-custom") {
    lobuUrl =
      options.memoryUrl ??
      (await input({
        message: "Lobu memory MCP URL:",
        validate: (v: string) => (v ? true : "URL is required"),
      }));
    envSecrets.push({ envVar: "MEMORY_URL", value: lobuUrl });
  }

  const otelEndpoint = await promptOrDefault({
    flag: options.otelEndpoint,
    useDefaults,
    defaultValue: "",
    prompt: () =>
      input({
        message:
          "OpenTelemetry collector endpoint? (leave empty to disable tracing)",
        default: "",
      }),
  });

  if (otelEndpoint) {
    envSecrets.push({
      envVar: "OTEL_EXPORTER_OTLP_ENDPOINT",
      value: otelEndpoint,
    });
  }

  let enableSentry = false;
  if (options.sentry === true) {
    enableSentry = true;
  } else if (options.noSentry === true) {
    enableSentry = false;
  } else if (!useDefaults) {
    enableSentry = await confirm({
      message:
        "Share anonymous error reports with Sentry to help improve Lobu?",
      default: false,
    });
  }

  if (enableSentry) {
    envSecrets.push({
      envVar: "SENTRY_DSN",
      value:
        "https://63abd848f1338116c41d4a8a29091c7c@o4511547660042240.ingest.us.sentry.io/4511547664171008",
    });
    // The shared community DSN reports into the same Sentry project as the
    // hosted deployment, and instrument.ts defaults environment to
    // "production" — tag self-hosted installs so their errors are filterable
    // and never read as hosted-prod incidents.
    envSecrets.push({
      envVar: "ENVIRONMENT",
      value: "self-host",
    });
  }

  let allowedDomains: string;
  let disallowedDomains: string;
  if (networkPolicy === "open") {
    allowedDomains = "*";
    disallowedDomains = "";
  } else if (networkPolicy === "isolated") {
    allowedDomains = "";
    disallowedDomains = "";
  } else {
    allowedDomains = [
      "registry.npmjs.org",
      ".npmjs.org",
      "github.com",
      ".github.com",
      ".githubusercontent.com",
      "cdn.jsdelivr.net",
      "unpkg.com",
      "pypi.org",
      "files.pythonhosted.org",
    ].join(",");
    disallowedDomains = "";
  }
  const encryptionKey = randomBytes(32).toString("hex");

  const answers = {
    encryptionKey,
    allowedDomains,
    disallowedDomains,
  };

  const spinner = ora("Creating Lobu project...").start();

  try {
    await generateLobuConfig(projectDir, {
      agentName: projectName,
      allowedDomains: answers.allowedDomains,
      providerId: providerId || undefined,
      providerEnvVar: selectedProvider?.providers?.[0]?.envVarName,
      providerModel: selectedProvider?.providers?.[0]?.defaultModel,
      enableHostedSlack,
      includeLobuMemory,
      lobuOrg: includeLobuMemory ? projectName : undefined,
      lobuName: includeLobuMemory ? humanizeSlug(projectName) : undefined,
    });

    const variables = {
      PROJECT_NAME: projectName,
      CLI_VERSION: cliVersion,
      ENCRYPTION_KEY: answers.encryptionKey,
      GATEWAY_PORT: gatewayPort,
      WORKER_PROXY_PORT: workerProxyPort,
      DATABASE_URL: databaseUrl,
      WORKER_ALLOWED_DOMAINS: answers.allowedDomains,
      WORKER_DISALLOWED_DOMAINS: answers.disallowedDomains,
    };

    await renderTemplate(".env.tmpl", variables, join(projectDir, ".env"));

    // Pin Node 22 for nvm / fnm / mise / asdf / volta — Lobu refuses to boot
    // on Node 25+ (isolated-vm has no prebuilt). Homebrew's `node` now
    // resolves to 26, so without these files a fresh `lobu run` fails.
    await writeFile(join(projectDir, ".nvmrc"), "22\n");
    await writeFile(join(projectDir, ".node-version"), "22\n");
    // `.env` carries ENCRYPTION_KEY + provider API keys / OAuth tokens
    // appended via setLocalEnvValue below. Tighten now so the initial
    // write isn't world-readable on multi-user hosts (default umask 022).
    await chmod(join(projectDir, ".env"), 0o600).catch(() => undefined);

    const envVarsToFill = new Set<string>();
    if (selectedProvider?.providers?.[0]?.envVarName) {
      envVarsToFill.add(selectedProvider.providers[0].envVarName);
    }
    for (const envVar of envVarsToFill) {
      await setLocalEnvValue(projectDir, envVar, "");
    }

    if (publicGatewayUrl) {
      await setLocalEnvValue(
        projectDir,
        "PUBLIC_GATEWAY_URL",
        publicGatewayUrl
      );
    }

    if (providerApiKey && selectedProvider?.providers?.[0]?.envVarName) {
      await setLocalEnvValue(
        projectDir,
        selectedProvider.providers[0].envVarName,
        providerApiKey
      );
    }

    for (const secret of envSecrets) {
      await setLocalEnvValue(projectDir, secret.envVar, secret.value);
    }

    await renderTemplate(".gitignore.tmpl", {}, join(projectDir, ".gitignore"));
    await renderTemplate(
      "README.md.tmpl",
      variables,
      join(projectDir, "README.md")
    );

    const agentDir = join(projectDir, "agents", projectName);
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "IDENTITY.md"),
      `# Identity\n\nYou are ${projectName}, a helpful AI assistant.\n`
    );
    await writeFile(
      join(agentDir, "SOUL.md"),
      `# Instructions\n\nBe concise and helpful. Ask clarifying questions when the request is ambiguous.\n`
    );
    await writeFile(
      join(agentDir, "USER.md"),
      `# User Context\n\n<!-- Add user-specific preferences, timezone, environment details here -->\n`
    );

    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", ".gitkeep"), "");

    await mkdir(join(projectDir, "skills"), { recursive: true });
    await writeFile(join(projectDir, "skills", ".gitkeep"), "");

    // Connector authoring surface: package.json declares the connector SDK
    // (provided by the runtime — externalized at compile, here for editor
    // types) plus any npm deps the user adds; tsconfig gives the editor
    // resolution; the connectors/ dir holds `*.connector.ts`. `lobu apply`
    // runs `bun install --ignore-scripts` here and bundles each connector's
    // own deps.
    //
    // `--here` can target a directory that already has a package.json /
    // tsconfig.json — merge into package.json (preserve the user's fields, just
    // add the SDK devDependency) and never overwrite an existing tsconfig.
    await scaffoldProjectPackaging(projectDir, projectName, cliVersion);
    await mkdir(join(projectDir, "connectors"), { recursive: true });
    await writeFile(join(projectDir, "connectors", ".gitkeep"), "");

    await renderTemplate(
      "AGENTS.md.tmpl",
      variables,
      join(projectDir, "AGENTS.md")
    );
    await renderTemplate(
      "TESTING.md.tmpl",
      variables,
      join(projectDir, "TESTING.md")
    );

    // Keep the potentially long install visible. Hiding installer output behind
    // the scaffold spinner makes a healthy first run look wedged on small hosts.
    spinner.succeed("Project files created");
    let depsWarning: string | null = null;
    if (options.skipInstall) {
      console.log(
        chalk.yellow(
          "\nSkipped dependency installation. Run `npm install` (or `bun install`) before `lobu apply`."
        )
      );
    } else {
      console.log(
        chalk.dim(
          "\nInstalling project dependencies (this may take a few minutes)..."
        )
      );
      depsWarning = installScaffoldedProjectDeps(projectDir, "inherit");
    }

    if (depsWarning) {
      console.log(chalk.yellow(`\n⚠ ${depsWarning}`));
    } else if (!options.skipInstall) {
      console.log(chalk.green("✓ Project dependencies installed"));
    }

    const gatewayUrl = `http://localhost:${gatewayPort}`;
    console.log(chalk.green("\n✓ Lobu initialized!\n"));
    console.log(chalk.bold("Next steps:\n"));
    let n = 1;
    if (!here) {
      console.log(chalk.cyan(`  ${n++}. cd ${projectName}`));
    }
    console.log(chalk.cyan(`  ${n++}. Start the local stack: lobu run`));
    console.log(
      chalk.dim(
        databaseUrl.startsWith("file:")
          ? "       Database: local embedded Postgres (./.lobu). Edit DATABASE_URL in .env to connect to an external one."
          : "       Database: external Postgres (DATABASE_URL in .env)."
      )
    );
    if (lobuUrl) {
      console.log(chalk.cyan(`  ${n++}. Connect an agent: lobu connect`));
    }
    if (enableHostedSlack) {
      console.log(
        chalk.cyan(
          `  ${n++}. Link the project to Lobu Cloud and register it: lobu login && lobu org set <slug> && lobu apply`
        )
      );
      console.log(
        chalk.dim(
          "       Then `lobu run` prints a short-lived `/lobu link <code>` for the hosted Slack bot."
        )
      );
    }
    console.log(chalk.cyan(`  ${n++}. API docs: ${gatewayUrl}/api/docs`));
    console.log(
      chalk.dim(
        "\n  See README.md for layout, AGENTS.md for the agent contract.\n"
      )
    );
  } catch (error) {
    spinner.fail("Failed to create project");
    throw error;
  }
}

function validateProjectName(value: string): string | true {
  if (!PROJECT_NAME_PATTERN.test(value)) {
    return "Project name must be lowercase alphanumeric with hyphens only";
  }
  return true;
}

interface PromptOrDefaultOptions<T> {
  flag: string | undefined;
  useDefaults: boolean;
  defaultValue: T;
  prompt: () => Promise<T>;
  validate?: (value: string) => true | string;
}

async function promptOrDefault<T extends string>(
  opts: PromptOrDefaultOptions<T>
): Promise<T> {
  if (opts.flag !== undefined) {
    if (opts.validate) {
      const result = opts.validate(opts.flag);
      if (result !== true) {
        throw new Error(result);
      }
    }
    return opts.flag as T;
  }
  if (opts.useDefaults) return opts.defaultValue;
  return opts.prompt();
}

async function promptBooleanOrDefault(opts: {
  flag: boolean | undefined;
  useDefaults: boolean;
  defaultValue: boolean;
  prompt: () => Promise<boolean>;
}): Promise<boolean> {
  if (opts.flag !== undefined) return opts.flag;
  if (opts.useDefaults) return opts.defaultValue;
  return opts.prompt();
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Scaffold the project's `lobu.config.ts` — the single TypeScript entrypoint
 * `lobu apply` (and `lobu run`) read. Emits a `defineAgent` (providers,
 * network) and a `defineConfig` default export with the org metadata.
 * Memory-schema types (entity / relationship) are added later with
 * `defineEntityType` etc.; chat connections are wired up as project-level
 * `defineConnection`s or through Connections in the web app.
 */
async function generateLobuConfig(
  projectDir: string,
  options: {
    agentName: string;
    allowedDomains: string;
    providerId?: string;
    providerEnvVar?: string;
    providerModel?: string;
    enableHostedSlack?: boolean;
    includeLobuMemory?: boolean;
    lobuOrg?: string;
    lobuName?: string;
    lobuDescription?: string;
  }
): Promise<void> {
  const id = options.agentName;

  const agentFields: string[] = [
    `  id: ${JSON.stringify(id)},`,
    `  name: ${JSON.stringify(id)},`,
    `  description: "",`,
    `  dir: ${JSON.stringify(`./agents/${id}`)},`,
  ];

  if (options.providerId && options.providerEnvVar) {
    agentFields.push(
      "  providers: [",
      "    {",
      `      id: ${JSON.stringify(options.providerId)},`,
      ...(options.providerModel
        ? [`      model: ${JSON.stringify(options.providerModel)},`]
        : []),
      `      key: secret(${JSON.stringify(options.providerEnvVar)}),`,
      "    },",
      "  ],"
    );
  } else {
    agentFields.push(
      "  // Add a provider, e.g.:",
      '  // providers: [{ id: "openrouter", key: secret("OPENROUTER_API_KEY") }],'
    );
  }

  const domains = options.allowedDomains
    ? options.allowedDomains
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean)
    : [];
  agentFields.push(
    "  network: {",
    domains.length > 0
      ? `    allowed: [${domains.map((d) => JSON.stringify(d)).join(", ")}],`
      : "    allowed: [],",
    "  },"
  );

  const configFields: string[] = [];
  if (options.includeLobuMemory) {
    const org = options.lobuOrg ?? options.agentName;
    const name = options.lobuName ?? humanizeSlug(options.agentName);
    configFields.push(
      `  org: ${JSON.stringify(org)},`,
      `  orgName: ${JSON.stringify(name)},`,
      ...(options.lobuDescription
        ? [`  orgDescription: ${JSON.stringify(options.lobuDescription)},`]
        : [])
    );
  }
  configFields.push("  agents: [agent],");

  // Hosted Lobu Slack bot — a project-level connection with no token. `lobu run`
  // prints a `/lobu link <code>` you redeem by DMing the bot; redeeming binds an
  // agent by creating a channel Automation.
  const connectionDecls: string[] = [];
  if (options.enableHostedSlack) {
    connectionDecls.push(
      "const slack = defineConnection({",
      '  slug: "slack",',
      '  connector: "slack",',
      '  credentialMode: "hosted",',
      '  surfaces: ["dm", "channel"],',
      "});"
    );
    configFields.push("  connections: [slack],");
  }

  const imports = options.enableHostedSlack
    ? 'import { defineAgent, defineConfig, defineConnection, secret } from "@lobu/cli/config";'
    : 'import { defineAgent, defineConfig, secret } from "@lobu/cli/config";';

  const lines = [
    "// lobu.config.ts — Lobu project configuration",
    "// Docs: https://lobu.ai/getting-started/",
    "//",
    "// `dir` points to a folder with IDENTITY.md, SOUL.md, USER.md, and an",
    "// optional skills/ directory. Shared skills in the root skills/ directory",
    "// are available to every agent. Run `lobu apply` to sync this to your org.",
    "",
    imports,
    "",
    "const agent = defineAgent({",
    ...agentFields,
    "});",
    ...(connectionDecls.length > 0 ? ["", ...connectionDecls] : []),
    "",
    "export default defineConfig({",
    ...configFields,
    "});",
    "",
  ];

  await writeFile(join(projectDir, "lobu.config.ts"), lines.join("\n"));
}

/**
 * Install the scaffolded project's devDependencies (@lobu/cli +
 * @lobu/connector-sdk) right after `lobu init` writes package.json. Without
 * this, the project has no node_modules, so the first bundled-connector
 * install fails metadata extraction with `Cannot find package
 * '@lobu/connector-sdk'` (#1181) — and editor types don't resolve either.
 * Warn-don't-fail: a broken/missing installer must not abort the scaffold, so
 * the failure is returned as a warning string for the caller to print.
 */
export function installScaffoldedProjectDeps(
  projectDir: string,
  stdio: "inherit" | "pipe" = "pipe"
): string | null {
  try {
    installProjectDeps(projectDir, { stdio });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      `Could not install project dependencies (${message.trim()}). ` +
      `Run \`npm install\` (or \`bun install\`) in ${projectDir} before \`lobu apply\`.`
    );
  }
}

async function getCliVersion(): Promise<string> {
  const pkgPath = new URL("../../package.json", import.meta.url);
  const pkgContent = await readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(pkgContent);
  return pkg.version || "0.1.0";
}
