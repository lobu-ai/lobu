/**
 * Workspace skill library commands over `manage_skills`. The library is
 * read-only from clients today: these commands list and show skills, and
 * Automations pin them by name (`defineAutomation({ skills: [...] })`).
 */

import type {
  SkillSubject,
  WorkspaceSkill,
} from "@lobu/core/contracts/tools/manage-skills";
import chalk from "chalk";
import { resolveApiClient } from "../internal/index.js";
import { printJson } from "../internal/output.js";
import { ApplyClient } from "./_lib/apply/client.js";
import type { CloudCommandOptions } from "./_lib/cloud-options.js";

async function skillsClient(
  options: CloudCommandOptions
): Promise<{ client: ApplyClient; orgSlug: string }> {
  const { apiBaseUrl, orgSlug, token } = await resolveApiClient(options);
  return { client: new ApplyClient({ apiBaseUrl, orgSlug, token }), orgSlug };
}

function describeSubject(subject: SkillSubject): string {
  if (subject.principal_kind === null) return "everyone";
  const kind = subject.principal_kind;
  if (subject.principal_id === null) return `all ${kind}s`;
  return `${kind} ${subject.principal_id}`;
}

function appliesTo(skill: WorkspaceSkill): string {
  return skill.applies_to.length
    ? skill.applies_to.map(describeSubject).join(", ")
    : "nobody";
}

export async function skillsListCommand(
  options: CloudCommandOptions & { archived?: boolean } = {}
): Promise<void> {
  const { client, orgSlug } = await skillsClient(options);
  const skills = await client.listSkills({ includeArchived: options.archived });

  if (options.json) {
    printJson(skills);
    return;
  }

  if (skills.length === 0) {
    console.log(chalk.dim(`\n  No skills in org ${orgSlug}.\n`));
    return;
  }

  console.log(chalk.bold(`\n  Skills in ${orgSlug}`));
  for (const skill of skills) {
    const flags = [
      skill.archived ? "archived" : null,
      skill.enabled ? null : "disabled",
    ].filter(Boolean);
    const status = flags.length ? chalk.yellow(` [${flags.join(", ")}]`) : "";
    console.log(`  ${skill.name}${status}`);
    console.log(chalk.dim(`    applies to ${appliesTo(skill)}`));
    if (skill.description) console.log(chalk.dim(`    ${skill.description}`));
  }
  console.log();
}

export async function skillsShowCommand(
  name: string,
  options: CloudCommandOptions = {}
): Promise<void> {
  const { client } = await skillsClient(options);
  const skill = await client.getSkill(name);

  if (options.json) {
    printJson(skill);
    return;
  }

  console.log(chalk.bold(`\n  ${skill.name}`));
  if (skill.description) console.log(chalk.dim(`  ${skill.description}`));
  console.log(chalk.dim(`  applies to ${appliesTo(skill)}`));
  console.log(
    chalk.dim(
      `  ${skill.enabled ? "enabled" : "disabled"} · revision ${skill.revision}`
    )
  );
  console.log(`\n${skill.content}\n`);
}
