import chalk from "chalk";
import open from "open";
import {
  getActiveOrg,
  listOrganizations,
  resolveContext,
  setActiveOrg,
} from "../internal/index.js";

export async function orgListCommand(options?: {
  context?: string;
}): Promise<void> {
  const target = await resolveContext(options?.context);
  const active = await getActiveOrg(target.name);
  const orgs = await listOrganizations({ context: target.name });

  if (orgs.length === 0) {
    console.log(chalk.dim("\n  No organizations found for this login.\n"));
    return;
  }

  console.log(chalk.bold(`\n  Organizations in ${target.name}`));
  for (const org of orgs) {
    const marker = org.slug === active ? chalk.green("*") : " ";
    const name = org.name ? chalk.dim(`  ${org.name}`) : "";
    console.log(`${marker} ${org.slug}${name}`);
  }
  console.log();
}

export async function orgCurrentCommand(options?: {
  context?: string;
}): Promise<void> {
  const target = await resolveContext(options?.context);
  const active = await getActiveOrg(target.name);
  if (!active) {
    console.log(
      chalk.dim(
        `\n  No active org set for context ${target.name}. Run \`lobu org set <slug>\`.\n`
      )
    );
    return;
  }
  console.log(chalk.bold(`\n  Current org for context ${target.name}`));
  console.log(chalk.dim(`  ${active}\n`));
}

export async function orgSetCommand(
  slug: string,
  options?: { context?: string }
): Promise<void> {
  const target = await resolveContext(options?.context);
  const orgs = await listOrganizations({ context: target.name });
  if (!orgs.some((org) => org.slug === slug)) {
    const available = orgs.map((org) => org.slug).join(", ");
    throw new Error(
      available
        ? `Organization "${slug}" is not available for this login. Available: ${available}`
        : `Organization "${slug}" is not available for this login.`
    );
  }
  await setActiveOrg(slug, target.name);
  console.log(
    chalk.green(`\n  Active org for context ${target.name} set to ${slug}\n`)
  );
}

export async function orgCreateCommand(
  slug: string,
  options?: { name?: string; context?: string }
): Promise<void> {
  const target = await resolveContext(options?.context);
  const origin = new URL(target.url).origin;
  const name = options?.name?.trim() || slug;
  const url = `${origin}/orgs/new?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(name)}`;
  console.log(
    chalk.bold(`\n  Opening ${url}`) +
      chalk.dim("\n  (paste it into your browser if it doesn't open)\n")
  );
  await open(url).catch(() => undefined);
}
