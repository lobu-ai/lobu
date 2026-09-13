import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import chalk from "chalk";
import postgres from "postgres";
import { checkMemoryHealth } from "./memory/_lib/memory-health.js";
import { resolveServerUrl } from "./memory/_lib/memory-auth.js";
import {
  isExternalDatabaseUrl,
  isPortFree,
  resolveEmbeddedDataRoot,
} from "./dev.js";
import { parseEnvContent } from "../internal/env-file.js";
import { MIN_NODE_MAJOR, checkNodeSupport } from "../internal/node-version.js";
import { loadProviderRegistry } from "./providers/registry.js";
import { loadProjectConfig } from "./_lib/apply/desired-state.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function checkBinaryExists(name: string): Check {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(cmd, [name], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const first = out.split("\n")[0]?.trim();
    if (!first) return { name, status: "fail", detail: "not found" };
    return { name, status: "ok", detail: first };
  } catch {
    return { name, status: "fail", detail: "not found" };
  }
}

const moduleRequire = createRequire(import.meta.url);

export function checkInstalledNativeModule(
  name: string,
  resolveModule: (id: string) => string = moduleRequire.resolve,
  loadModule: (id: string) => unknown = moduleRequire
): Check | null {
  try {
    resolveModule(`${name}/package.json`);
  } catch {
    // Newer/minimal distributions may not include this optional dependency.
    return null;
  }
  try {
    loadModule(name);
    return { name: `native:${name}`, status: "ok", detail: "loadable" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      name: `native:${name}`,
      status: "fail",
      detail: `installed but not loadable: ${detail}`,
    };
  }
}

function checkNodeVersion(): Check {
  const version = process.version;
  const support = checkNodeSupport();
  if (!support.ok) {
    return {
      name: "node",
      status: "fail",
      detail: `${version} (needs >=${MIN_NODE_MAJOR})`,
    };
  }
  if (!support.sandbox) {
    return {
      name: "node",
      status: "warn",
      detail: `${version} (SDK sandbox unavailable; use 24 LTS or 26+)`,
    };
  }
  return { name: "node", status: "ok", detail: version };
}

async function checkServerReachable(url: string): Promise<Check> {
  const origin = new URL(url).origin;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(origin, { signal: controller.signal });
    clearTimeout(timer);
    return {
      name: "server",
      status: res.ok ? "ok" : "warn",
      detail: `${res.status} ${origin}`,
    };
  } catch {
    return { name: "server", status: "fail", detail: `unreachable: ${origin}` };
  }
}

async function loadProjectEnv(cwd: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(cwd, ".env"), "utf-8");
    return parseEnvContent(raw);
  } catch {
    return {};
  }
}

async function checkDatabaseAndPgvector(databaseUrl: string): Promise<Check[]> {
  const results: Check[] = [];
  const sql = postgres(databaseUrl, {
    connect_timeout: 5,
    max: 1,
    idle_timeout: 1,
    onnotice: () => undefined,
  });

  try {
    const rows = await sql<{ version: string }[]>`SELECT version() AS version`;
    const version = String(rows[0]?.version ?? "").split(" on ")[0];
    results.push({
      name: "database",
      status: "ok",
      detail: version || "connected",
    });
  } catch (err) {
    results.push({
      name: "database",
      status: "fail",
      detail: `connect failed: ${(err as Error).message}`,
    });
    await sql.end({ timeout: 1 }).catch(() => undefined);
    return results;
  }

  try {
    const rows = await sql<
      { extname: string; extversion: string }[]
    >`SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'`;
    if (rows.length === 0) {
      results.push({
        name: "pgvector",
        status: "fail",
        detail: "extension not installed (CREATE EXTENSION vector)",
      });
    } else {
      results.push({
        name: "pgvector",
        status: "ok",
        detail: `v${rows[0]?.extversion}`,
      });
    }
  } catch (err) {
    results.push({
      name: "pgvector",
      status: "warn",
      detail: `check failed: ${(err as Error).message}`,
    });
  }

  await sql.end({ timeout: 5 }).catch(() => undefined);
  return results;
}

async function checkPortAvailability(port: number): Promise<Check> {
  const free = await isPortFree(port);
  return {
    name: `port:${port}`,
    status: free ? "ok" : "fail",
    detail: free ? "available" : "in use",
  };
}

async function checkProviderKeys(
  cwd: string,
  env: Record<string, string>
): Promise<Check[]> {
  let agents: Awaited<
    ReturnType<typeof loadProjectConfig>
  >["project"]["agents"];
  try {
    agents = (await loadProjectConfig(cwd)).project.agents;
  } catch {
    return [];
  }

  const registry = loadProviderRegistry();
  const checks: Check[] = [];
  const seen = new Set<string>();

  for (const agent of agents) {
    for (const provider of agent.providers ?? []) {
      const reg = registry.find(
        (r) => r.id === (provider.id ?? provider.model)
      );
      const envVar = reg?.providers?.[0]?.envVarName;
      if (!envVar || seen.has(envVar)) continue;
      seen.add(envVar);

      const value = env[envVar] ?? process.env[envVar];
      checks.push({
        name: `provider:${provider.id}`,
        status: value ? "ok" : "fail",
        detail: value ? `${envVar} set` : `${envVar} missing`,
      });
    }
  }
  return checks;
}

async function checkWorkspaceDir(cwd: string): Promise<Check | null> {
  const dir = join(cwd, "workspaces");
  try {
    const info = await stat(dir);
    return info.isDirectory()
      ? { name: "workspaces", status: "ok", detail: dir }
      : { name: "workspaces", status: "warn", detail: "not a directory" };
  } catch {
    // Missing is fine — gateway creates it on first run.
    return null;
  }
}

interface DoctorOptions {
  memoryOnly?: boolean;
  cwd?: string;
}

export async function doctorCommand(
  options: DoctorOptions = {}
): Promise<void> {
  if (options.memoryOnly) {
    await checkMemoryHealth();
    return;
  }

  const cwd = options.cwd ?? process.cwd();
  const env = await loadProjectEnv(cwd);
  const checks: Check[] = [];

  checks.push(checkNodeVersion());
  checks.push(checkBinaryExists("git"));
  const sharp = checkInstalledNativeModule("sharp");
  if (sharp) checks.push(sharp);

  const databaseUrl = env.DATABASE_URL ?? process.env.DATABASE_URL;
  if (databaseUrl && isExternalDatabaseUrl(databaseUrl)) {
    checks.push(...(await checkDatabaseAndPgvector(databaseUrl)));
  } else if (databaseUrl) {
    // Embedded Postgres: DATABASE_URL is a filesystem path (often `file://<dir>`,
    // the scaffold default `file://.`), not a connection string. `lobu run`
    // boots a self-contained PG18 + bundled pgvector under `<root>/.lobu/pgdata`,
    // so there is nothing to dial until it's running. Report the resolved data
    // root instead of feeding the path to postgres() — `postgres("file://.")`
    // parses host "." and fails with `getaddrinfo ENOTFOUND .`.
    const root = resolveEmbeddedDataRoot(databaseUrl);
    checks.push({
      name: "database",
      status: "ok",
      detail: `local embedded Postgres (data: ${join(root, ".lobu", "pgdata")})`,
    });
  } else {
    checks.push({
      name: "database",
      status: "warn",
      detail: "DATABASE_URL not set (set in .env or environment)",
    });
  }

  const port = Number(env.GATEWAY_PORT ?? env.PORT ?? "8787");
  if (Number.isInteger(port) && port > 0) {
    checks.push(await checkPortAvailability(port));
  }

  checks.push(...(await checkProviderKeys(cwd, env)));

  const ws = await checkWorkspaceDir(cwd);
  if (ws) checks.push(ws);

  const serverUrl = await resolveServerUrl();
  if (serverUrl) checks.push(await checkServerReachable(serverUrl));

  const icons = {
    ok: chalk.green("✓"),
    warn: chalk.yellow("!"),
    fail: chalk.red("✗"),
  };
  for (const c of checks) {
    console.log(
      `  ${icons[c.status]} ${chalk.bold(c.name)}: ${chalk.dim(c.detail)}`
    );
  }

  const fails = checks.filter((c) => c.status === "fail");
  if (fails.length > 0) {
    console.log(`\n${fails.length} issue(s) found.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${chalk.green("All checks passed.")}`);
  }
}
