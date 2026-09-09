import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isHostedChatPlatform } from "@lobu/core";
import chalk from "chalk";
import ora from "ora";
import type { ConnectorRef } from "../config/index.js";
import { resolveApiClient } from "../internal/api-client.js";
import {
  addContext,
  getCurrentContextName,
  getServerConfig,
  loadContextConfig,
  setActiveOrg,
  setCurrentContext,
} from "../internal/context.js";
import { type Credentials, saveCredentials } from "../internal/credentials.js";
import { parseEnvContent } from "../internal/index.js";
import { checkNodeSupport } from "../internal/node-version.js";
import { loadProjectLink } from "../internal/project-link.js";
import { loadProjectConfig } from "./_lib/apply/desired-state.js";

interface DevOptions {
  port?: string;
  quiet?: boolean;
  verbose?: boolean;
  logLevel?: string;
  /**
   * Acknowledge that `lobu run` is about to point at a shared/non-local
   * Postgres inherited from the shell. Required when the project's own .env
   * doesn't pin DATABASE_URL — protects against the silent footgun of running
   * "local dev" against a teammate's tailnet DB or, worse, prod.
   */
  unsafeSharedDb?: boolean;
}

export type LocalSignInFailureStage =
  | "server_unreachable"
  | "local_init_http"
  | "local_init_payload"
  | "context_setup";

export type LocalSignInResult =
  | { ready: true; localOrgSlug?: string }
  | { ready: false; skipped: "external_backend" }
  | {
      ready: false;
      stage: LocalSignInFailureStage;
      detail?: string;
    };

export interface LocalSignInDependencies {
  waitForReachable: (url: string) => Promise<boolean>;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  addContextImpl: (
    name: string,
    url: string,
    server?: { lifecycle?: "managed" | "external" }
  ) => Promise<unknown>;
  saveCredentialsImpl: (
    credentials: Credentials,
    contextName: string
  ) => Promise<unknown>;
  setActiveOrgImpl: (slug: string, contextName: string) => Promise<unknown>;
  inspectContextImpl: (
    contextName: string
  ) => Promise<{ url: string; lifecycle?: "managed" | "external" } | undefined>;
  getCurrentContextNameImpl: () => Promise<string>;
  setCurrentContextImpl: (contextName: string) => Promise<unknown>;
}

function connectorRefKey(ref: ConnectorRef): string {
  return typeof ref === "string" ? ref : new ref().definition.key;
}

/**
 * Treat any DATABASE_URL whose host isn't loopback as "shared". The check
 * is intentionally crude — anything resolvable from the network counts,
 * including tailnet (`*.ts.net`), private IPs, and prod hostnames.
 *
 * Exported for unit tests; the safety gate in `devCommand` is the consumer.
 */
export function isSharedDatabaseUrl(databaseUrl: string): boolean {
  // Only network (postgres://) URLs can point at a shared/remote DB. Embedded
  // backends are local filesystem paths — frequently a `file://<abs path>` URL
  // (e.g. the menubar app passes `file:///Users/me/lobu/data`), whose URL
  // hostname parses as empty. Treating that empty host as "non-loopback" would
  // wrongly flag every local embedded run as shared and refuse to boot.
  if (!isExternalDatabaseUrl(databaseUrl)) return false;
  try {
    const url = new URL(databaseUrl);
    // `new URL("postgres://[::1]:5432/x").hostname` returns `[::1]` with the
    // brackets, so strip them before comparing.
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
}

/**
 * `DATABASE_URL` is the single backend selector:
 *   - a `postgres://` / `postgresql://` URL → connect to an external Postgres
 *   - anything else (a filesystem path, optionally `file:`-prefixed) → boot a
 *     local embedded Postgres with its data under `<path>/.lobu/pgdata`
 *
 * `lobu run` defaults the path to the user's home dir when nothing is set, so a
 * bare `lobu run` still works (data at `~/.lobu/pgdata`). The runtime itself
 * always receives an explicit path — the default is injected here, at the CLI
 * frontend, exactly like the menubar app supplies its own path.
 */
export function isExternalDatabaseUrl(databaseUrl: string): boolean {
  return /^postgres(ql)?:\/\//i.test(databaseUrl.trim());
}

/**
 * Resolve the embedded data ROOT from a path-form DATABASE_URL: strips a
 * leading `file:` and expands a leading `~`. The Postgres cluster lives at
 * `<root>/.lobu/pgdata` (see embedded-runtime.ts).
 */
export function resolveEmbeddedDataRoot(databaseUrl: string): string {
  let p = databaseUrl.trim().replace(/^file:(\/\/)?/i, "");
  if (p === "~" || p.startsWith("~/")) {
    p = join(homedir(), p.slice(1));
  }
  return resolve(p);
}

/**
 * Decide whether `lobu run` must refuse to boot because the EFFECTIVE
 * DATABASE_URL points at a shared/non-local DB the project never opted into.
 *
 * `mergedEnv` gives the shell higher precedence than the project's `.env`, so
 * the project only "owns" the URL when its `.env` value is the exact one that
 * survived the merge. Gating on project-`.env` *presence* alone (the old bug)
 * let a shared/prod shell URL win silently whenever `.env` also happened to
 * define its own DATABASE_URL — re-pointing "local dev" at shared/prod data.
 *
 * Exported for unit tests; the safety gate in `devCommand` is the consumer.
 */
export function shouldRefuseSharedDatabaseUrl(input: {
  effectiveDatabaseUrl: string | undefined;
  projectEnvDatabaseUrl: string | undefined;
  unsafeSharedDb: boolean | undefined;
}): boolean {
  const effective = input.effectiveDatabaseUrl?.trim();
  if (!effective) return false;
  if (input.unsafeSharedDb) return false;

  const projectEnv = input.projectEnvDatabaseUrl?.trim();
  const projectEnvOwnsIt = !!projectEnv && projectEnv === effective;
  if (projectEnvOwnsIt) return false;

  return isSharedDatabaseUrl(effective);
}

/**
 * `lobu run` — start the embedded Lobu stack.
 *
 * `DATABASE_URL` selects the backend (see `isExternalDatabaseUrl`): a
 * `postgres://` URL connects to an external Postgres; a filesystem path boots a
 * local embedded Postgres rooted there. Unset defaults to an embedded DB at
 * `~/.lobu/pgdata`.
 */
export async function devCommand(
  cwd: string,
  options: DevOptions = {}
): Promise<void> {
  const spinner = ora("Validating environment...").start();

  // The server also warns on Node 25, but only after the CLI's boot output.
  // Surface the sandbox limitation before validation so it is hard to miss.
  const nodeSupport = checkNodeSupport();
  if (nodeSupport.ok && !nodeSupport.sandbox) {
    spinner.warn(
      chalk.yellow(
        `Node ${process.versions.node}: the agent-code sandbox (query_sdk / run_sdk) is unavailable.`
      )
    );
    console.warn(
      chalk.dim(
        "  isolated-vm has no Node 25 build. Use Node 24 (LTS) or 26+ to enable the sandbox.\n"
      )
    );
    spinner.start("Validating environment...");
  }

  const envPath = join(cwd, ".env");
  let envVars: Record<string, string> = {};
  try {
    envVars = parseEnvContent(await readFile(envPath, "utf-8"));
  } catch {
    envVars = {};
  }

  // User-level server config from ~/.config/lobu/config.json (Mac-app
  // settings pane writes here; CLI users can also `lobu context server ...`).
  // Precedence: shell > project .env > user config > defaults.
  const userServerConfig = await getServerConfig().catch(() => undefined);
  const userServerEnv: Record<string, string> = {};
  if (userServerConfig?.port)
    userServerEnv.PORT = String(userServerConfig.port);
  if (userServerConfig?.host) userServerEnv.HOST = userServerConfig.host;

  const mergedEnv = {
    ...userServerEnv,
    ...envVars,
    ...(process.env as Record<string, string>),
  };
  // DATABASE_URL is the backend selector: a postgres:// URL → external; any
  // other value (a path) → embedded PG rooted there; unset → embedded at the
  // user's home dir. The CLI injects the path default so the runtime always
  // receives an explicit DATABASE_URL.
  const databaseUrlRaw = mergedEnv.DATABASE_URL?.trim() ?? "";
  const mode: "external" | "embedded" =
    databaseUrlRaw && isExternalDatabaseUrl(databaseUrlRaw)
      ? "external"
      : "embedded";

  // Refuse to boot against a shared/non-local external DATABASE_URL inherited
  // from the parent shell rather than the project's own .env. A common footgun:
  // "local lobu run" silently writes into prod / a teammate's tailnet DB.
  // Embedded paths are always local (not URLs), so this only fires for external
  // postgres:// URLs; project pinning in .env is explicit consent.
  if (
    shouldRefuseSharedDatabaseUrl({
      effectiveDatabaseUrl: databaseUrlRaw,
      projectEnvDatabaseUrl: envVars.DATABASE_URL,
      unsafeSharedDb: options.unsafeSharedDb,
    })
  ) {
    spinner.fail("DATABASE_URL inherited from shell points at a shared DB");
    console.error(
      chalk.red(
        `\n  Refusing to start: DATABASE_URL=${redactUrl(databaseUrlRaw)}\n`
      )
    );
    console.error(
      chalk.dim(
        `  This URL is set in your shell environment, not in ${envPath}.`
      )
    );
    console.error(
      chalk.dim(
        "  Its host isn't loopback — likely a teammate's tailnet DB or prod."
      )
    );
    console.error(
      chalk.dim(
        "  Local dev runs against this DB silently mutate shared data and"
      )
    );
    console.error(
      chalk.dim("  let prod workers race local-dev runs (see AGENTS.md).\n")
    );
    console.error(chalk.dim("  Fix one of:"));
    console.error(
      chalk.dim(
        `    • pin a project-local DB in ${envPath} (e.g. postgres://localhost/<project>_dev)`
      )
    );
    console.error(
      chalk.dim(
        "    • set DATABASE_URL to a directory path for a local embedded Postgres"
      )
    );
    console.error(
      chalk.dim(
        "    • pass --unsafe-shared-db if you really mean to share this DB\n"
      )
    );
    process.exit(1);
  }

  // Embedded: resolve the data root and pass it through as the explicit
  // DATABASE_URL path the single server bundle reads. Precedence: an explicit
  // path-form DATABASE_URL wins; else LOBU_DATA_DIR (the documented override in
  // docs/reference/cli.md); else the user's home dir. The bundle puts the
  // cluster at <root>/.lobu/pgdata.
  let embeddedDataRoot: string | null = null;
  if (mode === "embedded") {
    const dataDirOverride = mergedEnv.LOBU_DATA_DIR?.trim();
    embeddedDataRoot = resolveEmbeddedDataRoot(
      databaseUrlRaw || dataDirOverride || "~"
    );
    mergedEnv.DATABASE_URL = embeddedDataRoot;
  }

  // One bundle for both backends — it self-selects on DATABASE_URL.
  const bundlePath = resolveBackendBundle();
  if (!bundlePath) {
    spinner.fail("server bundle not found");
    console.error(
      chalk.red("\n  Could not locate the server bundle (server.bundle.mjs).\n")
    );
    console.error(
      chalk.dim(
        "  Installed CLIs ship the bundle inside their own dist/. If you're"
      )
    );
    console.error(
      chalk.dim(
        "  seeing this from a published @lobu/cli, please file an issue."
      )
    );
    console.error(chalk.dim("  In the monorepo, build it via:"));
    console.error(chalk.dim("    make build-packages\n"));
    process.exit(1);
  }

  spinner.succeed(
    mode === "external"
      ? "Environment ready"
      : "Environment ready (local embedded Postgres)"
  );

  const portRaw =
    options.port ?? mergedEnv.GATEWAY_PORT ?? mergedEnv.PORT ?? "8787";
  const portNum = Number(portRaw);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    console.error(
      chalk.red(`\n  Invalid port — must be an integer in 1-65535.\n`)
    );
    process.exit(1);
  }
  const gatewayUrl = `http://localhost:${portNum}`;

  const portFree = await isPortFree(portNum);
  if (!portFree) {
    console.error(chalk.red(`\n  Port ${portNum} is already in use.`));
    console.error(
      chalk.dim(
        "  Stop the other process, or pass `--port <n>` / set `GATEWAY_PORT` to a free port.\n"
      )
    );
    console.error(
      chalk.dim(
        process.platform === "darwin" || process.platform === "linux"
          ? `  Find what's holding it: lsof -iTCP:${portNum} -sTCP:LISTEN\n`
          : `  Find what's holding it: netstat -ano | findstr :${portNum}\n`
      )
    );
    process.exit(1);
  }

  if (!options.quiet) {
    console.log(chalk.cyan(`\n  Starting Lobu...\n`));
    console.log(chalk.dim(`  bundle:        ${bundlePath}`));
    if (mode === "external") {
      console.log(
        chalk.dim(`  database:      ${redactUrl(mergedEnv.DATABASE_URL!)}`)
      );
    } else {
      console.log(chalk.dim("  database:      local embedded Postgres"));
      console.log(
        chalk.dim(
          `  data:          ${join(embeddedDataRoot!, ".lobu", "pgdata")}`
        )
      );
    }
    console.log(chalk.dim(`  api docs:      ${gatewayUrl}/api/docs`));
    console.log();
  }

  const logLevel = resolveLogLevel(options);

  // Pass-through env: process.env wins so users can override per-invocation,
  // .env values fill in the rest.
  //
  // LOBU_DEV_PROJECT_PATH points the embedded server at the monorepo root so
  // it can find packages/owletto. When `lobu run` is invoked from a project subdir inside the
  // monorepo, cwd is *not* the root — walk up to the enclosing workspace root.
  const enclosingRoot = findEnclosingMonorepoRoot(cwd);
  const projectPath =
    process.env.LOBU_DEV_PROJECT_PATH ||
    envVars.LOBU_DEV_PROJECT_PATH ||
    enclosingRoot ||
    cwd;

  // Bundled CLIs (and `lobu run` from anywhere) ship providers.json next to
  // the server bundle; point the gateway at it unless the user already set the
  // path in their env or .env.
  const bundledProvidersPath = join(dirname(bundlePath), "providers.json");
  const providerRegistryPath =
    process.env.LOBU_PROVIDER_REGISTRY_PATH ||
    envVars.LOBU_PROVIDER_REGISTRY_PATH ||
    (existsSync(bundledProvidersPath) ? bundledProvidersPath : undefined);

  // Bundled CLIs ship the built owletto web UI next to the server bundle (see
  // packages/cli/scripts/build.cjs). Point the server at it unless the user or
  // .env already set WEB_DIST_DIR. In a monorepo checkout the bundle's sibling
  // dir has no owletto/dist, so this stays undefined and the server's own
  // monorepo-relative lookup / Vite dev path takes over.
  const bundledWebDistPath = join(dirname(bundlePath), "owletto", "dist");
  const webDistDir =
    process.env.WEB_DIST_DIR ||
    envVars.WEB_DIST_DIR ||
    (existsSync(bundledWebDistPath) ? bundledWebDistPath : undefined);

  const childEnv: Record<string, string> = {
    ...mergedEnv,
    LOBU_DEV_PROJECT_PATH: projectPath,
    // `lobu run` owns the local DB lifecycle for both backends. The embedded
    // path already migrates on boot; this flag tells the server bundle to also
    // apply migrations when pointed at an external (postgres://) DATABASE_URL,
    // so a fresh/empty local Postgres is set up before serving. Prod never sets
    // it — there a separate dbmate migration Job owns migrations.
    LOBU_RUN_OWNS_DB: "1",
    ...(providerRegistryPath
      ? { LOBU_PROVIDER_REGISTRY_PATH: providerRegistryPath }
      : {}),
    ...(webDistDir ? { WEB_DIST_DIR: webDistDir } : {}),
    PORT: String(portNum),
    GATEWAY_PORT: String(portNum),
    ...(logLevel ? { LOG_LEVEL: logLevel } : {}),
  };

  const child = spawn("node", [bundlePath], {
    cwd,
    env: childEnv,
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error(chalk.red(`\n  Failed to start Lobu: ${err.message}\n`));
    process.exit(1);
  });

  // Once the embedded server is reachable, fetch a session token via
  // /api/local-init and print a deep-link URL. The SPA hook accepts
  // ?lobu_token=<session> and exchanges it for a cookie, so the user can
  // click the URL straight from their terminal and land logged in. Also
  // persists the session in the selected CLI context so later commands work
  // without a separate `lobu login`.
  void announceLocalSignIn(gatewayUrl, mode === "embedded").then(
    async (localSignIn) => {
      const localContextReady = localSignIn.ready;
      const localOrgSlug = localSignIn.ready
        ? localSignIn.localOrgSlug
        : undefined;
      const hasLobuConfig = existsSync(join(cwd, "lobu.config.ts"));
      const signInWarning = getLocalSignInWarning(localSignIn, {
        embedded: mode === "embedded",
        hasLobuConfig,
      });
      if (signInWarning) {
        console.warn(chalk.yellow(`  ${signInWarning}`));
      }
      // Once the selected context is registered and credentialed, push the
      // project's lobu.config.ts into the embedded DB so the scaffolded agent is
      // usable with no separate `lobu apply`.
      // Gated (see shouldAutoApplyLocalProject) AND pinned to the local URL so
      // a failed sign-in can never apply this local project to whatever
      // cloud/prod context happened to be active.
      if (
        shouldAutoApplyLocalProject({
          mode,
          localContextReady,
          hasLobuConfig,
        })
      ) {
        await autoApplyLocalProject(cwd, gatewayUrl, localOrgSlug);
      }
      // Mint hosted-chat link codes only AFTER the gateway is reachable and the
      // project is applied. printPreviewInstructions POSTs /preview/claims; if
      // run from the pre-spawn banner it races the server boot and every hosted
      // connection prints a bogus "Could not create a slack preview code".
      if (!options.quiet) {
        await printPreviewInstructions(cwd);
      }
    }
  );

  // Forward Ctrl+C to the child so it can clean up its own subprocess workers
  // before the parent exits. SIGKILL after a timeout in case it wedges.
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 10_000).unref();
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(chalk.dim(`\n  Lobu exited (${signal}).\n`));
      process.exit(0);
    }
    process.exit(code ?? 0);
  });
}

/**
 * Whether `lobu run` should auto-apply the project. True only when:
 *  - the backend is embedded (never auto-mutate an external/prod DB), AND
 *  - local sign-in registered and credentialed the selected context, AND
 *  - the project actually has a `lobu.config.ts` to apply.
 */
export function shouldAutoApplyLocalProject(opts: {
  mode: "external" | "embedded";
  localContextReady: boolean;
  hasLobuConfig: boolean;
}): boolean {
  return (
    opts.mode === "embedded" && opts.localContextReady && opts.hasLobuConfig
  );
}

/**
 * After `lobu run` boots an embedded backend, push the project's `lobu.config.ts`
 * into the local DB so the agent the user just scaffolded is immediately usable
 * without a separate `lobu apply`. The apply is pinned to the embedded URL and
 * bootstrap org rather than relying on the globally active context.
 *
 * Best-effort: a project with nothing to apply, or a transient failure, must
 * never crash the running server. The apply graph (esbuild + connector-worker
 * + SDK, pulled in by apply-cmd) is imported lazily so it stays out of
 * `lobu run`'s module-load path — see the dynamic-import allow-list in
 * AGENTS.md.
 */
export async function autoApplyLocalProject(
  cwd: string,
  gatewayUrl: string,
  localOrgSlug?: string,
  // Test seam — defaults to the lazily-imported applyCommand.
  applyImpl?: (opts: {
    cwd: string;
    yes: boolean;
    url: string;
    org?: string;
  }) => Promise<unknown>
): Promise<void> {
  try {
    const applyCommand =
      applyImpl ?? (await import("./_lib/apply/apply-cmd.js")).applyCommand;
    // Pin the apply to the embedded server's URL. `resolveApiTarget` matches
    // a stored context by URL — and refuses to send any other context's
    // credentials to a different URL — so this can only ever target the local
    // server, never a cloud/prod org. Also pin the ORG to the embedded server's
    // bootstrap org (from /api/local-init) so a `defineConfig({ org })` naming a
    // cloud org can't redirect this local apply to a slug that doesn't exist
    // here — that previously 404'd and silently applied nothing.
    await applyCommand({
      cwd,
      yes: true,
      url: gatewayUrl,
      ...(localOrgSlug ? { org: localOrgSlug } : {}),
    });
  } catch (err) {
    console.warn(
      chalk.dim(
        `  (auto-apply skipped: ${err instanceof Error ? err.message : String(err)})`
      )
    );
  }
}

/**
 * Walk up from `startDir` looking for the Lobu monorepo workspace root: a
 * `package.json` with a non-empty `workspaces` field AND a
 * `packages/server/src/index.ts` underneath it. Returns the absolute
 * path, or `null`. (Mirrors `@lobu/server`'s `findEnclosingMonorepoRoot` — kept
 * local so the CLI doesn't take a dep on the server package.)
 */
export function findEnclosingMonorepoRoot(startDir: string): string | null {
  let cur = resolve(startDir);
  for (let i = 0; i < 64; i++) {
    const pkgPath = join(cur, "package.json");
    if (existsSync(pkgPath)) {
      let hasWorkspaces = false;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          workspaces?: unknown;
        };
        hasWorkspaces =
          pkg.workspaces != null &&
          (Array.isArray(pkg.workspaces)
            ? pkg.workspaces.length > 0
            : typeof pkg.workspaces === "object");
      } catch {
        hasWorkspaces = false;
      }
      if (
        hasWorkspaces &&
        existsSync(join(cur, "packages/server/src/index.ts"))
      ) {
        return cur;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function resolveBackendBundle(
  startDir = dirname(fileURLToPath(import.meta.url))
): string | null {
  const here = startDir;
  const require_ = createRequire(import.meta.url);
  const bundleName = "server.bundle.mjs";

  for (const bundled of [
    join(here, bundleName),
    join(here, "..", bundleName),
  ]) {
    if (existsSync(bundled)) return bundled;
  }

  try {
    return require_.resolve("@lobu/server/dist/server.bundle.mjs");
  } catch {
    // not installed as a dep
  }

  let cur = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, "packages/server/dist", bundleName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return null;
}

/**
 * After the embedded server is reachable, hit POST /api/local-init for
 * a fresh session token, register a CLI context pointing at the gateway,
 * persist the session as that context's bearer credential, and
 * print a deep-link URL the user can click to land logged into the SPA.
 *
 * Best-effort: a failure here (server not ready, /local-init refused because
 * real users exist, etc.) returns a credential-safe diagnostic stage. The
 * caller warns only when a local project would otherwise have auto-applied.
 * The endpoint is loopback-only and idempotent so it's safe to fire
 * unconditionally.
 */
const defaultLocalSignInDependencies: LocalSignInDependencies = {
  waitForReachable: waitForServerReachable,
  fetchImpl: (url, init) => fetch(url, init),
  addContextImpl: addContext,
  saveCredentialsImpl: saveCredentials,
  setActiveOrgImpl: setActiveOrg,
  inspectContextImpl: async (contextName) => {
    const config = await loadContextConfig();
    const context = config.contexts[contextName];
    return context
      ? { url: context.url, lifecycle: context.lifecycle }
      : undefined;
  },
  getCurrentContextNameImpl: getCurrentContextName,
  setCurrentContextImpl: setCurrentContext,
};

function matchingLoopbackEndpoints(leftRaw: string, rightRaw: string): boolean {
  const normalize = (raw: string) => {
    try {
      const url = new URL(raw);
      const scheme = url.protocol.toLowerCase();
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (
        (scheme !== "http:" && scheme !== "https:") ||
        !["localhost", "127.0.0.1", "::1"].includes(host) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        return null;
      }
      // No `host` in the shape: the guard above already established both
      // sides are loopback, so comparing them would be vacuously true.
      return {
        scheme,
        port: url.port || (scheme === "https:" ? "443" : "80"),
      };
    } catch {
      return null;
    }
  };

  const left = normalize(leftRaw);
  const right = normalize(rightRaw);
  return (
    left !== null &&
    right !== null &&
    left.scheme === right.scheme &&
    left.port === right.port
  );
}

// Whether `contextName` names a credential slot this local runner may write.
// Two ways to qualify: an already-configured context whose lifecycle marks it
// runner-managed and whose URL is this same loopback endpoint, or a brand-new
// name whose spawning process pinned the identical endpoint via LOBU_API_URL
// (how Owletto Debug claims its build-scoped slot on first boot). A bare
// LOBU_CONTEXT must never repurpose a cloud or user-managed name.
async function isRunnerOwnedContext(
  dependencies: LocalSignInDependencies,
  contextName: string,
  gatewayUrl: string
): Promise<boolean> {
  const configured = await dependencies.inspectContextImpl(contextName);
  if (configured) {
    const hasRunnerOwnedLifecycle =
      configured.lifecycle === "managed" ||
      (contextName === "local" && configured.lifecycle === undefined);
    return (
      hasRunnerOwnedLifecycle &&
      matchingLoopbackEndpoints(configured.url, gatewayUrl)
    );
  }
  const pinnedUrl = process.env.LOBU_API_URL?.trim();
  return !!pinnedUrl && matchingLoopbackEndpoints(pinnedUrl, gatewayUrl);
}

export async function announceLocalSignIn(
  gatewayUrl: string,
  embedded: boolean,
  dependencies: LocalSignInDependencies = defaultLocalSignInDependencies
): Promise<LocalSignInResult> {
  // Poll briefly so the announce lands AFTER the server's own startup
  // banner without racing it.
  const reachable = await dependencies.waitForReachable(gatewayUrl);
  if (!reachable) {
    return {
      ready: false,
      stage: "server_unreachable",
      detail: "the server did not answer /health within the startup window",
    };
  }

  // Only the embedded path seeds the bootstrap user → /local-init will refuse
  // on an external-Postgres deployment with real signups. Skip the network
  // call entirely in that case to keep the banner quiet.
  if (!embedded) return { ready: false, skipped: "external_backend" };

  let res: Response;
  try {
    res = await dependencies.fetchImpl(`${gatewayUrl}/api/local-init`, {
      method: "POST",
      headers: { "X-Lobu-Client": "lobu-run" },
    });
  } catch {
    return {
      ready: false,
      stage: "local_init_http",
      detail: "request failed after the server became reachable",
    };
  }
  if (!res.ok) {
    return {
      ready: false,
      stage: "local_init_http",
      detail: `HTTP ${res.status}`,
    };
  }

  let parsedBody: unknown;
  try {
    parsedBody = await res.json();
  } catch {
    return {
      ready: false,
      stage: "local_init_payload",
      detail: "response was not valid JSON",
    };
  }
  if (
    !parsedBody ||
    typeof parsedBody !== "object" ||
    Array.isArray(parsedBody)
  ) {
    return {
      ready: false,
      stage: "local_init_payload",
      detail: "response did not contain a JSON object",
    };
  }
  const body = parsedBody as Record<string, unknown>;
  const optionalRecord = (
    value: unknown
  ): Record<string, unknown> | null | undefined => {
    if (value == null) return undefined;
    return typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  };
  const user = optionalRecord(body.user);
  const organization = optionalRecord(body.organization);
  const hasInvalidStringField = (
    record: Record<string, unknown>,
    field: string
  ) => record[field] !== undefined && typeof record[field] !== "string";
  if (
    user === null ||
    organization === null ||
    hasInvalidStringField(body, "session_token") ||
    hasInvalidStringField(body, "device_token") ||
    (user &&
      ["id", "email", "name"].some((field) =>
        hasInvalidStringField(user, field)
      )) ||
    (organization &&
      ["id", "slug", "name"].some((field) =>
        hasInvalidStringField(organization, field)
      ))
  ) {
    return {
      ready: false,
      stage: "local_init_payload",
      detail: "response contained invalid field types",
    };
  }
  const nonEmptyString = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  const sessionToken = nonEmptyString(body.session_token);
  const deviceToken = nonEmptyString(body.device_token);
  const userId = nonEmptyString(user?.id);
  const userEmail = nonEmptyString(user?.email);
  const userName = nonEmptyString(user?.name);
  const orgSlug = nonEmptyString(organization?.slug);

  // CLI's default token is the Better Auth session token; session auth
  // carries the user's org membership and works for admin REST + MCP calls.
  // Persist the companion worker PAT too for the gateway agent API, which
  // still authenticates that surface via worker/OAuth bearer tokens. The
  // same session token is passed to the browser deep-link URL so the SPA
  // hook reaches /api/exchange-token → Better Auth session cookie.
  const cliToken = sessionToken ?? deviceToken;
  if (!cliToken) {
    return {
      ready: false,
      stage: "local_init_payload",
      detail: "response did not contain a session or device token",
    };
  }

  const requestedContextName = process.env.LOBU_CONTEXT?.trim();
  // An explicit LOBU_CONTEXT is honored only when it names a slot this runner
  // owns. Refusing an unowned name must NOT abort the bootstrap, though: the
  // Mac runner derives LOBU_CONTEXT from the CLI's ambient `currentContext`
  // (owletto apps/mac/Owletto/LocalLobuRunner.swift), and only pins
  // LOBU_API_URL on Debug builds — so a Release user whose selected context is
  // a cloud entry would otherwise lose the local context, its credentials, the
  // deep link, and auto-apply outright. Fall back to the pre-existing `local`
  // bootstrap instead, which is exactly what a bare `lobu run` does.
  // Assigned inside the try so a throwing context probe still reports the
  // slot the failure is about.
  let contextName = "local";
  try {
    const pinnedContextName =
      requestedContextName &&
      (await isRunnerOwnedContext(
        dependencies,
        requestedContextName,
        gatewayUrl
      ))
        ? requestedContextName
        : undefined;
    contextName = pinnedContextName ?? "local";
    await dependencies.addContextImpl(
      contextName,
      gatewayUrl,
      pinnedContextName ? { lifecycle: "managed" } : undefined
    );
    const creds: Credentials = {
      accessToken: cliToken,
      ...(deviceToken ? { localWorkerToken: deviceToken } : {}),
      ...(userEmail ? { email: userEmail } : {}),
      ...(userName ? { name: userName } : {}),
      ...(userId ? { userId } : {}),
    };
    await dependencies.saveCredentialsImpl(creds, contextName);
    // Bind the bootstrap org slug returned by /api/local-init to the
    // context. Without this, an apply targeting the context errors with
    // "No organization selected" until the user manually runs
    // `lobu org set <slug>`. The server is the source of truth — it
    // auto-provisioned this org for the install operator.
    if (orgSlug) {
      await dependencies
        .setActiveOrgImpl(orgSlug, contextName)
        .catch(() => undefined);
    }
    // A normal interactive `lobu run` switches the global default to `local`.
    // An explicit LOBU_CONTEXT pins this process and must not retarget CLI
    // commands running without that override.
    if (!requestedContextName) {
      try {
        const current = await dependencies.getCurrentContextNameImpl();
        if (current !== contextName) {
          await dependencies.setCurrentContextImpl(contextName);
          process.stderr.write(
            `Switched active context to "${contextName}" (lobu run)\n`
          );
        }
      } catch {
        // Best-effort — failing to switch shouldn't kill the run banner.
      }
    }

    const url = new URL(gatewayUrl);
    url.searchParams.set("lobu_token", cliToken);
    console.log();
    console.log(
      chalk.green(`  Signed in as ${userEmail ?? "Local Developer"}.`)
    );
    console.log(chalk.dim(`    Web UI:   `) + chalk.cyan(url.toString()));
    console.log(
      chalk.dim(`    CLI:      `) +
        chalk.cyan(`lobu chat -c ${contextName} "hello"`)
    );
    console.log();
    // The selected context is registered and credentialed, so the URL-pinned
    // auto-apply is safe. Return the bootstrap org slug so the
    // auto-apply can target the local org explicitly (a config `org:` for a
    // cloud org must not redirect the local apply — that 404s silently).
    return { ready: true, localOrgSlug: orgSlug };
  } catch {
    return {
      ready: false,
      stage: "context_setup",
      detail: `could not register or persist the "${contextName}" context`,
    };
  }
}

const localSignInStageLabels: Record<LocalSignInFailureStage, string> = {
  server_unreachable: "server startup",
  local_init_http: "the local-init request",
  local_init_payload: "the local-init response",
  context_setup: "local CLI context setup",
};

export function getLocalSignInWarning(
  result: LocalSignInResult,
  options: { embedded: boolean; hasLobuConfig: boolean }
): string | null {
  if (
    !options.embedded ||
    !options.hasLobuConfig ||
    result.ready ||
    !("stage" in result)
  ) {
    return null;
  }

  const detail = result.detail ? ` (${result.detail})` : "";
  return `Local sign-in failed during ${localSignInStageLabels[result.stage]}${detail}; project auto-apply was skipped.`;
}

export async function waitForServerReachable(
  url: string,
  timeoutMs = 30_000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const settle = (free: boolean) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      resolve(free);
    };
    server.once("error", () => settle(false));
    server.once("listening", () => {
      server.once("close", () => settle(true));
      try {
        server.close();
      } catch {
        settle(true);
      }
    });
    try {
      server.listen({ port, host: "127.0.0.1", exclusive: true });
    } catch {
      settle(false);
    }
  });
}

async function printPreviewInstructions(cwd: string): Promise<void> {
  let project: Awaited<ReturnType<typeof loadProjectConfig>>["project"];
  try {
    project = (await loadProjectConfig(cwd)).project;
  } catch {
    return;
  }

  // Hosted chat connections (`credentialMode: "hosted"`) are reached via the
  // hosted Lobu bot. The connection carries no owning agent — binding happens at
  // redeem time via an Automation — so `lobu run` mints one `/lobu link <code>` per
  // (agent, hosted connection): the code's agent is the default `/lobu link`
  // binds to, which the redeemer can still override.
  const hostedConnections = (project.connections ?? []).filter(
    (c) =>
      c.credentialMode === "hosted" &&
      isHostedChatPlatform(connectorRefKey(c.connector))
  );
  const enabled: Array<{
    agentId: string;
    platform: string;
    cfg: { surfaces?: Array<"dm" | "channel">; codeTtlMinutes?: number };
  }> = [];
  for (const conn of hostedConnections) {
    const platform = connectorRefKey(conn.connector);
    for (const agent of project.agents) {
      enabled.push({
        agentId: agent.id,
        platform,
        cfg: { surfaces: conn.surfaces, codeTtlMinutes: conn.codeTtlMinutes },
      });
    }
  }
  if (enabled.length === 0) return;

  let clientInfo: Awaited<ReturnType<typeof resolveApiClient>>;
  try {
    const projectLink = await loadProjectLink(cwd);
    clientInfo = await resolveApiClient({
      context: projectLink?.context,
      org: projectLink?.org,
    });
  } catch {
    console.log(
      chalk.yellow(
        "\n  A hosted chat platform is configured, but no Lobu Cloud session is available."
      )
    );
    console.log(
      chalk.dim(
        "  Run `lobu login`, `lobu org set <slug>`, and `lobu apply`; then restart `lobu run` to get a link code.\n"
      )
    );
    return;
  }

  console.log(chalk.cyan("\n  Hosted chat"));
  for (const { agentId, platform, cfg } of enabled) {
    try {
      const claim = await clientInfo.client.post<{
        code: string;
        command: string;
        join_url: string;
        expires_at: string;
        allowed_surfaces: string[];
      }>(`/api/${clientInfo.orgSlug}/preview/claims`, {
        agent_id: agentId,
        platform,
        surfaces: cfg.surfaces ?? ["dm"],
        ttl_minutes: cfg.codeTtlMinutes ?? 15,
      });
      console.log(chalk.dim(`  agent:    ${agentId}`));
      console.log(chalk.dim(`  platform: ${platform}`));
      console.log(chalk.dim(`  expires:  ${claim.expires_at}`));
      console.log();
      if (claim.join_url) {
        console.log(
          chalk.dim(
            `  1. Join the hosted Lobu ${platform} workspace: ${chalk.underline(claim.join_url)}`
          )
        );
        console.log(
          chalk.dim(`  2. DM @Lobu there: ${chalk.bold(claim.command)}`)
        );
      } else {
        console.log(
          chalk.dim(
            `  In the hosted Lobu ${platform} workspace, DM @Lobu: ${chalk.bold(claim.command)}`
          )
        );
      }
      // Slack alone supports installing the hosted bot into the user's OWN
      // workspace (one-time OAuth); after that, `/lobu link` works in a channel
      // there. Telegram has no install step.
      if (platform === "slack") {
        console.log(
          chalk.dim(
            `  Or add it to your own Slack workspace: ${chalk.underline(`${clientInfo.apiBaseUrl}/lobu/slack/install`)} (then ${chalk.bold(claim.command)} in a channel there).`
          )
        );
      }
    } catch (error) {
      console.log(
        chalk.yellow(
          `  Could not create a ${platform} preview code for ${agentId}.`
        )
      );
      const reason = error instanceof Error ? error.message : String(error);
      // Surface the real cause instead of only blaming `lobu apply`, and give
      // the concrete actions the user must take. The hosted Slack/Telegram bot
      // binds to the agent in Lobu Cloud, so a claim needs a cloud org session
      // with the agent applied there.
      console.log(chalk.dim(`  Reason: ${reason}`));
      console.log();
      console.log(
        chalk.dim(
          "  To get a link code, complete these steps against Lobu Cloud, then restart `lobu run`:"
        )
      );
      console.log(chalk.dim("    lobu login"));
      console.log(chalk.dim("    lobu org set <slug>"));
      console.log(chalk.dim("    lobu apply"));
      console.log(
        chalk.dim(
          `    restart \`lobu run\` (it will print the \`/lobu link <code>\` command under "Hosted chat")`
        )
      );
      console.log(
        chalk.dim(
          "  Then join the hosted Lobu workspace and DM @Lobu with that command.\n"
        )
      );
    }
  }
  console.log();
}

function resolveLogLevel(options: DevOptions): string | undefined {
  if (options.logLevel) return options.logLevel;
  if (options.quiet) return "warn";
  if (options.verbose) return "debug";
  return undefined;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.username) u.username = "***";
    return u.toString();
  } catch {
    return url;
  }
}
