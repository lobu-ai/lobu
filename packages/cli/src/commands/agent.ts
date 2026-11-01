import {
  access,
  constants,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { ApiClient } from "../internal/api-client.js";
import { resolveApiClient } from "../internal/index.js";
import { printJson } from "../internal/output.js";
import { agentCountsText, fetchAgents } from "./_lib/agents-view.js";

import type { CloudCommandOptions as AgentCommandOptions } from "./_lib/cloud-options.js";

export type { AgentCommandOptions };

async function agentEditRevision(
  client: ApiClient,
  agentPath: string,
  ...provided: unknown[]
): Promise<string> {
  const revisions = provided.filter((value) => value !== undefined);
  if (revisions.length === 0) {
    const current = await client.get<{ revision: string }>(
      `${agentPath}/config`
    );
    revisions.push(current.revision);
  }
  const revision = revisions[0];
  if (typeof revision !== "string" || revision.length === 0) {
    throw new Error("An original, non-empty agent revision is required.");
  }
  if (revisions.some((value) => value !== revision)) {
    throw new Error(
      "Conflicting revisions in --expected-revision and the config file. Keep the revision used to prepare the edit."
    );
  }
  return revision;
}

export async function agentListCommand(
  options: AgentCommandOptions = {}
): Promise<void> {
  const { agents, orgSlug } = await fetchAgents(options);

  if (options.json) {
    printJson(agents);
    return;
  }

  if (agents.length === 0) {
    console.log(chalk.dim(`\n  No agents in org ${orgSlug}.\n`));
    return;
  }

  console.log(chalk.bold(`\n  Agents in ${orgSlug}`));
  for (const agent of agents) {
    const status = agent.status ? chalk.dim(`  ${agent.status}`) : "";
    const description = agent.description
      ? chalk.dim(` — ${agent.description}`)
      : "";
    const counts = chalk.dim(agentCountsText(agent));
    console.log(
      `  ${chalk.green("●")} ${chalk.bold(agent.agentId)} ${counts}${status}${description}`
    );
  }
  console.log();
}

export async function agentGetCommand(
  agentId: string,
  options: AgentCommandOptions = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const agent = await client.get<unknown>(
    `/api/${orgSlug}/agents/${encodeURIComponent(agentId)}`
  );
  printJson(agent);
}

export async function agentCreateCommand(
  agentId: string,
  options: AgentCommandOptions & { name?: string; description?: string } = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const name = options.name?.trim() || agentId;
  const agent = await client.post<unknown>(`/api/${orgSlug}/agents`, {
    agentId,
    name,
    ...(options.description ? { description: options.description } : {}),
  });

  if (options.json) {
    printJson(agent);
    return;
  }
  console.log(chalk.green(`\n  Created agent ${agentId} in ${orgSlug}.\n`));
}

export async function agentUpdateCommand(
  agentId: string,
  options: AgentCommandOptions & {
    name?: string;
    description?: string;
    expectedRevision?: string;
  } = {}
): Promise<void> {
  const updates: { name?: string; description?: string } = {};
  if (options.name !== undefined) updates.name = options.name;
  if (options.description !== undefined)
    updates.description = options.description;
  if (Object.keys(updates).length === 0) {
    console.error(
      chalk.red("\n  Pass at least one of --name or --description.\n")
    );
    process.exit(1);
  }

  const { client, orgSlug } = await resolveApiClient(options);
  const agentPath = `/api/${orgSlug}/agents/${encodeURIComponent(agentId)}`;
  const expectedRevision = await agentEditRevision(
    client,
    agentPath,
    options.expectedRevision
  );
  const result = await client.patch<unknown>(agentPath, {
    ...updates,
    expected_revision: expectedRevision,
  });

  if (options.json) {
    printJson(result);
    return;
  }
  console.log(chalk.green(`\n  Updated agent ${agentId}.\n`));
}

export async function agentDeleteCommand(
  agentId: string,
  options: AgentCommandOptions & {
    yes?: boolean;
    expectedRevision?: string;
  } = {}
): Promise<void> {
  if (!options.yes) {
    console.error(chalk.red("\n  Refusing to delete without --yes.\n"));
    process.exit(1);
  }
  const { client, orgSlug } = await resolveApiClient(options);
  const agentPath = `/api/${orgSlug}/agents/${encodeURIComponent(agentId)}`;
  const expectedRevision = await agentEditRevision(
    client,
    agentPath,
    options.expectedRevision
  );
  await client.request(
    "DELETE",
    agentPath,
    { expected_revision: expectedRevision },
    { okStatuses: [200, 204] }
  );
  console.log(chalk.green(`\n  Deleted agent ${agentId}.\n`));
}

export async function agentConfigGetCommand(
  agentId: string,
  options: AgentCommandOptions & { output?: string } = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const config = await client.get<unknown>(
    `/api/${orgSlug}/agents/${encodeURIComponent(agentId)}/config`
  );

  const json = `${JSON.stringify(config, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, json);
    console.log(chalk.green(`\n  Wrote ${options.output}\n`));
    return;
  }
  process.stdout.write(json);
}

export async function agentConfigPatchCommand(
  agentId: string,
  options: AgentCommandOptions & {
    file: string;
    json?: boolean;
    expectedRevision?: string;
  }
): Promise<void> {
  if (!options.file) throw new Error("--file is required.");
  const raw = await readFile(options.file, "utf-8");
  let updates: unknown;
  try {
    updates = JSON.parse(raw) as unknown;
  } catch (error) {
    console.error(
      chalk.red(
        `\n  Failed to parse ${options.file}: ${error instanceof Error ? error.message : String(error)}\n`
      )
    );
    process.exit(1);
  }
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    console.error(
      chalk.red("\n  Config patch file must contain a JSON object.\n")
    );
    process.exit(1);
  }
  const { client, orgSlug } = await resolveApiClient(options);
  const agentPath = `/api/${orgSlug}/agents/${encodeURIComponent(agentId)}`;
  // Exported config files carry their read revision; keep that draft baseline
  // instead of replacing it with a newer read when the file is patched later.
  const { revision, expected_revision, ...fields } = updates as Record<
    string,
    unknown
  >;
  const expectedRevision = await agentEditRevision(
    client,
    agentPath,
    options.expectedRevision,
    expected_revision,
    revision
  );
  const result = await client.patch<unknown>(`${agentPath}/config`, {
    ...fields,
    expected_revision: expectedRevision,
  });

  if (options.json) {
    printJson(result);
    return;
  }
  console.log(chalk.green(`\n  Updated config for ${agentId}.\n`));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

interface AgentScaffoldOptions {
  cwd?: string;
  name?: string;
  description?: string;
}

const AGENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Scaffold a new local agent dir + print the `defineAgent` block to add. */
export async function agentScaffoldCommand(
  agentId: string,
  options: AgentScaffoldOptions = {}
): Promise<void> {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    console.error(
      chalk.red(
        `\n  Invalid agent id "${agentId}". Use lowercase alphanumeric + hyphens.\n`
      )
    );
    process.exit(1);
  }

  const cwd = options.cwd ?? process.cwd();
  const lobuConfigPath = join(cwd, "lobu.config.ts");
  if (!(await pathExists(lobuConfigPath))) {
    console.error(
      chalk.red(
        "\n  No lobu.config.ts in the current directory. Run `lobu init` first or `cd` into a Lobu project.\n"
      )
    );
    process.exit(1);
  }

  const agentDir = join(cwd, "agents", agentId);
  if (await pathExists(agentDir)) {
    console.error(
      chalk.red(
        `\n  Directory ${agentDir} already exists. Pick a different agent id.\n`
      )
    );
    process.exit(1);
  }

  const displayName = options.name ?? agentId;
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "IDENTITY.md"),
    `# Identity\n\nYou are ${displayName}, a helpful AI assistant.\n`
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
  await mkdir(join(agentDir, "evals"), { recursive: true });

  const description = options.description ?? "";
  // The config is typed TypeScript, so we don't mutate it for the user — print
  // the `defineAgent` block to paste (with editor autocomplete + type-checking).
  const constName = agentId.replace(/-([a-z0-9])/g, (_, c: string) =>
    c.toUpperCase()
  );
  const snippet = [
    `const ${constName} = defineAgent({`,
    `  id: ${JSON.stringify(agentId)},`,
    `  name: ${JSON.stringify(displayName)},`,
    ...(description ? [`  description: ${JSON.stringify(description)},`] : []),
    `  dir: "./agents/${agentId}",`,
    `});`,
  ].join("\n");

  console.log(chalk.green(`\n  Scaffolded agent "${agentId}".`));
  console.log(chalk.dim(`  - agents/${agentId}/IDENTITY.md`));
  console.log(chalk.dim(`  - agents/${agentId}/SOUL.md`));
  console.log(chalk.dim(`  - agents/${agentId}/USER.md`));
  console.log(chalk.dim(`  - agents/${agentId}/skills/`));
  console.log(chalk.dim(`  - agents/${agentId}/evals/`));
  console.log(chalk.cyan("\n  Add it to your lobu.config.ts:\n"));
  console.log(`${snippet}\n`);
  console.log(
    chalk.dim(
      `  ...then add \`${constName}\` to \`defineConfig({ agents: [...] })\`.\n`
    )
  );
}
