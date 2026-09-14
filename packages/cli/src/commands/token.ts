import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { select } from "@inquirer/prompts";
import chalk from "chalk";
import postgres from "postgres";
import { resolveApiClient } from "../internal/api-client.js";
import { parseEnvContent } from "../internal/env-file.js";
import { getToken, resolveContext } from "../internal/index.js";
import { isExternalDatabaseUrl } from "./dev.js";

interface TokenCreateOptions {
  context?: string;
  org?: string;
  name?: string;
  description?: string;
  scope?: string;
  expiresInDays?: number;
  raw?: boolean;
  json?: boolean;
}

interface CreatedPersonalAccessToken {
  id: number;
  token: string;
  token_prefix: string;
  name: string;
  scope: string | null;
  expires_at: string | null;
  created_at: string;
}

export async function tokenCommand(options: {
  context?: string;
  raw?: boolean;
}): Promise<void> {
  const target = await resolveContext(options.context);
  const token = await getToken(target.name);

  if (!token) {
    console.error(chalk.red("\n  Not logged in. Run `lobu login` first.\n"));
    process.exitCode = 1;
    return;
  }

  if (options.raw) {
    process.stdout.write(`${token}\n`);
    return;
  }

  console.log(chalk.cyan(`\n  Context: ${target.name}`));
  console.log(chalk.dim(`  API URL: ${target.url}`));
  console.log("  Token: available (use `lobu token --raw` to print it)\n");
}

export async function tokenCreateCommand(
  options: TokenCreateOptions
): Promise<void> {
  const { client, orgSlug, contextName } = await resolveApiClient({
    context: options.context,
    org: options.org,
  });
  const name =
    options.name?.trim() || `lobu-cli-${new Date().toISOString().slice(0, 10)}`;

  let scope = options.scope?.trim();
  if (!scope && process.stdin.isTTY) {
    scope = await select({
      message: "Token scope:",
      choices: [
        {
          value: "mcp:read mcp:write",
          name: "Read + Write — typical for CI scripts and MCP clients",
        },
        {
          value: "mcp:read mcp:write mcp:admin",
          name: "Read + Write + Admin — full workspace access (agent CRUD, config patches)",
        },
        {
          value: "mcp:read",
          name: "Read only — search and query, no mutations",
        },
      ],
    });
  }
  scope ??= "mcp:read mcp:write";

  const response = await client.post<{ token: CreatedPersonalAccessToken }>(
    `/api/${encodeURIComponent(orgSlug)}/tokens`,
    {
      name,
      scope,
      ...(options.description ? { description: options.description } : {}),
      ...(options.expiresInDays !== undefined
        ? { expiresInDays: options.expiresInDays }
        : {}),
    }
  );

  if (options.raw) {
    process.stdout.write(`${response.token.token}\n`);
    return;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.token, null, 2)}\n`);
    return;
  }

  console.log(chalk.cyan("\n  Personal access token created"));
  console.log(chalk.dim(`  Context: ${contextName}`));
  console.log(chalk.dim(`  Org:     ${orgSlug}`));
  console.log(chalk.dim(`  Name:    ${response.token.name}`));
  console.log(chalk.dim(`  Scope:   ${response.token.scope ?? scope}`));
  console.log(
    chalk.dim(
      `  Expires: ${response.token.expires_at ? new Date(response.token.expires_at).toISOString() : "never"}`
    )
  );
  console.log(
    chalk.yellow("\n  Save this token now; it will not be shown again:")
  );
  console.log(`  ${response.token.token}\n`);
}

/**
 * Revoke a token by its `jti`. Inserts a row into `public.revoked_tokens`
 * (created on demand) — the gateway's RevokedTokenStore checks this on every
 * worker-token / settings-cookie verification, so the token is dead within
 * one cache TTL (≤60s).
 */
export async function tokenRevokeCommand(
  jti: string,
  options: { expiresAt?: string }
): Promise<void> {
  jti = jti.trim();
  if (!jti) {
    console.error(chalk.red("\n  Missing <jti>.\n"));
    process.exitCode = 1;
    return;
  }

  // Fall back to the project `.env` like `doctor` does — every other
  // command reads it, so requiring an exported env var here strands local
  // installs. Embedded path-form URLs (`file://.`) carry no host to dial
  // (postgres() parses "." as a hostname → ENOTFOUND), so refuse those
  // clearly instead of letting the dial fail cryptically.
  let databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    try {
      const raw = await readFile(join(process.cwd(), ".env"), "utf-8");
      databaseUrl = parseEnvContent(raw).DATABASE_URL?.trim();
    } catch {
      // No project .env — fall through to the missing-URL error below.
    }
  }
  if (!databaseUrl) {
    console.error(
      chalk.red(
        "\n  DATABASE_URL is not set. Run this from the same environment as the gateway.\n"
      )
    );
    process.exitCode = 1;
    return;
  }
  if (!isExternalDatabaseUrl(databaseUrl)) {
    console.error(
      chalk.red(
        "\n  DATABASE_URL is a local embedded path, not a connection string, so there is nothing to dial.\n"
      )
    );
    console.log(
      chalk.dim(
        "  Point DATABASE_URL at the Postgres the gateway uses (postgresql://…) and retry.\n"
      )
    );
    process.exitCode = 1;
    return;
  }

  let expiresAt: Date;
  if (options.expiresAt) {
    expiresAt = new Date(options.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      console.error(chalk.red("\n  --expires-at must be a valid ISO date.\n"));
      process.exitCode = 1;
      return;
    }
  } else {
    expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  // `public.revoked_tokens` schema lives in
  // db/migrations/20260519020001_revoked_tokens.sql and is mirrored in
  // db/embedded-schema-patches.ts. If the INSERT below fails with
  // `relation "revoked_tokens" does not exist`, the operator hasn't
  // applied migrations yet — run dbmate up (or `lobu run` once, which
  // applies them on boot) and retry.
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      INSERT INTO public.revoked_tokens (jti, expires_at)
      VALUES (${jti}, ${expiresAt})
      ON CONFLICT (jti) DO UPDATE SET expires_at = GREATEST(public.revoked_tokens.expires_at, EXCLUDED.expires_at)
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log(chalk.cyan("\n  Token revoked"));
  console.log(chalk.dim(`  jti:     ${jti}`));
  console.log(chalk.dim(`  expires: ${expiresAt.toISOString()}`));
  console.log(
    chalk.dim("  Effective within ~60s (gateway revocation cache TTL).\n")
  );
}
