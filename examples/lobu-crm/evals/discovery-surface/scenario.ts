/**
 * Discovery-surface eval — scenario backing.
 *
 * Where the sibling `tool-surface` eval measured which SHAPE of tool surface a
 * model handles best, this eval measures whether a model can DISCOVER how to
 * perform an operation across the FULL Lobu MCP surface starting from bare
 * natural-language intent — with NO skill scaffolding. The agent gets ONLY the
 * default cloud MCP tools (the ~6 first-class AGENT_TOOLS: `search_memory`,
 * `save_memory`, `search_sdk`, `query_sdk`, `query_sql`, `run_sdk`) and must
 * find the right SDK method via `search_sdk` + the MCP tool descriptions, then
 * execute it via `run_sdk` / `query_sdk` / `query_sql`.
 *
 * Unlike tool-surface (which stubbed the sandbox tools), this harness runs the
 * REAL isolated-vm sandbox — so `run_sdk` / `query_sdk` actually compile and run
 * the model's TypeScript against the live ClientSDK + Postgres. isolated-vm's
 * native addon only loads under Node 22–24 (not Bun), so this whole harness runs
 * under Node + tsx (see run.sh), resolving the built workspace packages.
 *
 * DB setup + org/user fixtures use the server test harness directly.
 */

import type { Sql } from "postgres";
import { getMcpTools } from "../../../../packages/server/src/tools/registry";
import type { ToolContext } from "../../../../packages/server/src/tools/registry";
import type { Env } from "../../../../packages/server/src/index";
import { search } from "../../../../packages/server/src/tools/search";
import { saveContent } from "../../../../packages/server/src/tools/save_content";
import { sdkSearch } from "../../../../packages/server/src/tools/sdk_search";
import { querySql } from "../../../../packages/server/src/tools/admin/query_sql";
import {
  querySdkScript,
  runSdkScript,
} from "../../../../packages/server/src/tools/sdk_run";
import {
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
  addUserToOrganization,
} from "../../../../packages/server/src/__tests__/setup/test-fixtures";
import {
  getTestDb,
  setupTestDatabase,
} from "../../../../packages/server/src/__tests__/setup/test-db";
import { initWorkspaceProvider } from "../../../../packages/server/src/workspace";

export interface ScenarioOrg {
  org: { id: string; slug: string; name: string };
  ctx: ToolContext;
}

const ENV: Env = {
  ENVIRONMENT: "test",
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: "test-jwt-secret-for-testing-only",
  BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
  MAX_CONSECUTIVE_FAILURES: "3",
  RATE_LIMIT_ENABLED: "false",
};

export function db(): Sql {
  return getTestDb();
}

/** Run migrations + bring up the workspace provider in the disposable test DB. */
export async function ensureMigrated(): Promise<void> {
  await setupTestDatabase();
  await initWorkspaceProvider();
}

/**
 * The default cloud MCP surface: the tools advertised on MCP `tools/list`.
 * These are the ONLY tools the discovery agent gets — the ~6 first-class
 * AGENT_TOOLS. Admin/dispatch tools are intentionally NOT included: the whole
 * point is that the agent must discover every capability through `search_sdk`
 * and reach it via `query_sdk` / `run_sdk` / `query_sql`, exactly as a fresh
 * agent on the production cloud gateway would.
 */
export function defaultMcpToolDefs() {
  return getMcpTools();
}

/**
 * The single dispatcher the discovery agent routes every tool call through.
 * Maps a tool name to its REAL handler — including the sandbox tools
 * (`query_sdk` / `run_sdk`), which run the model's TypeScript in isolated-vm
 * against the live SDK. This is the crucial difference from tool-surface, which
 * stubbed these out.
 */
export async function dispatchTool(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case "search_memory":
      return search(args as never, ENV, ctx);
    case "save_memory":
      return saveContent(args as never, ENV, ctx);
    case "search_sdk":
      return sdkSearch(args as never, ENV, ctx);
    case "query_sql":
      return querySql(args as never, ENV, ctx);
    case "query_sdk":
      return querySdkScript(args as never, ENV, ctx);
    case "run_sdk":
      return runSdkScript(args as never, ENV, ctx);
    default:
      throw new Error(
        `Tool "${toolName}" is not part of the default MCP surface. ` +
          `Available: search_memory, save_memory, search_sdk, query_sdk, query_sql, run_sdk.`
      );
  }
}

/**
 * Token scope of the eval session.
 * - `admin`   — an owner with `mcp:admin` (a full workspace-management agent).
 * - `default` — the `mcp:read`+`mcp:write` scope `lobu token create` mints by
 *   default. Admin-gated actions (connect, automations.create, operations.execute,
 *   schedules, catalog discovery pre-#1955) are blocked for this principal.
 */
export type SessionScope = "admin" | "default";

const SCOPES_BY_SESSION: Record<SessionScope, string[]> = {
  admin: ["mcp:read", "mcp:write", "mcp:admin"],
  default: ["mcp:read", "mcp:write"],
};

/**
 * Create a fresh org + owner and return the auth ctx. Unlike the tool-surface
 * scenario this seeds NO CRM types — a discovery task's own `seed` adds only
 * the minimal starting state its intent implies (e.g. an installed connector to
 * connect, or seeded companies to query), so the agent has to discover the rest.
 */
export async function freshOrg(
  name: string,
  scope: SessionScope = "admin"
): Promise<ScenarioOrg> {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, "owner");
  const ctx: ToolContext = {
    organizationId: org.id,
    userId: user.id,
    memberRole: "owner",
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: SCOPES_BY_SESSION[scope],
    tokenType: "oauth",
    scopedToOrg: true,
    allowCrossOrg: false,
  };
  return { org, ctx };
}

/**
 * Install a connector into the org's catalog (a `connector_definitions` row +
 * a stub `connector_versions` row) so `connections.connect` and the
 * `search_sdk` connector-intent search can find it. `authNone: true` makes the
 * connector no-auth, so a connect lands an `active` connection with no
 * credentials — the realistic "unconfigured, ready to configure" state.
 */
export async function installConnector(
  org: ScenarioOrg,
  opts: {
    key: string;
    name: string;
    feeds?: Record<string, { description?: string }>;
    authNone?: boolean;
  }
): Promise<void> {
  await createTestConnectorDefinition({
    key: opts.key,
    name: opts.name,
    feeds_schema: opts.feeds ?? { default: {} },
    auth_schema: opts.authNone
      ? { methods: [{ type: "none" }] }
      : { methods: [{ type: "app_installation" }] },
    organization_id: org.org.id,
  });
}

/**
 * Admin ctx for the org, used for SEEDING regardless of the session scope under
 * test — setup must always succeed even when the agent's own token is a limited
 * `default` scope. (The agent still acts through `org.ctx`, which may be
 * default-scoped; only the harness's seed writes use this.)
 */
function seedCtx(org: ScenarioOrg): ToolContext {
  return { ...org.ctx, scopes: ["mcp:read", "mcp:write", "mcp:admin"] };
}

/** Directly create an entity type in the org (bypasses the agent) for seeding. */
export async function seedEntityType(
  org: ScenarioOrg,
  slug: string,
  name: string,
  metadataProps: Record<string, { type: string }> = {}
): Promise<void> {
  await runSdkScript(
    {
      script: `export default async (ctx, client) => {
        await client.entitySchema.createType(${JSON.stringify({
          slug,
          name,
          metadata_schema: {
            type: "object",
            properties: metadataProps,
          },
        })});
      }`,
    } as never,
    ENV,
    seedCtx(org)
  );
}

/** Directly create an entity in the org (bypasses the agent) for seeding. */
export async function seedEntity(
  org: ScenarioOrg,
  type: string,
  name: string,
  metadata: Record<string, unknown> = {}
): Promise<number> {
  const res = (await runSdkScript(
    {
      script: `export default async (ctx, client) => {
        const e = await client.entities.create(${JSON.stringify({
          entity_type: type,
          name,
          metadata,
        })});
        return e?.id ?? e?.entity?.id ?? null;
      }`,
    } as never,
    ENV,
    seedCtx(org)
  )) as { return_value?: number | null };
  const id = res.return_value;
  if (typeof id !== "number") {
    throw new Error(
      `seedEntity: could not resolve entity id (${JSON.stringify(res)})`
    );
  }
  return id;
}
