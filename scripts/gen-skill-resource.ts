/**
 * Embed `skills/lobu/SKILL.md` into a committed TS constant the server bundles.
 *
 * Why embed instead of reading the file at runtime: the server ships as a
 * single esbuild bundle (see build-server-bundle.mjs) and `skills/` is a
 * repo-root dir that is NOT copied into the deployed server image. A runtime
 * path scan would work in local dev and 404 in prod. Bundling the string keeps
 * the `skill://lobu/SKILL.md` MCP resource identical across dev and prod.
 *
 * Run: `bun run scripts/gen-skill-resource.ts`
 * A sync test guards the generated file against drift.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { YAML } from "bun";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const SKILL_MD = resolve(REPO_ROOT, "skills/lobu/SKILL.md");
const OUT = resolve(
  REPO_ROOT,
  "packages/server/src/skills/lobu-skill.generated.ts"
);

const BANNER = `// GENERATED FILE — do not edit by hand.
// Source: skills/lobu/SKILL.md
// Regenerate: bun run scripts/gen-skill-resource.ts
// A sync test (skills/__tests__/lobu-skill-resource.test.ts) guards this against drift.
`;

/**
 * The SKILL.md frontmatter as JSON. The MCP Skills extension (SEP-2640)
 * publishes it verbatim, so the bundled skill may declare only the two string
 * fields its `skills/list` entry carries.
 */
function readFrontmatter(md: string): { name: string; description: string } {
  const lines = md.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) {
    throw new Error(`${SKILL_MD} must start with a --- frontmatter block`);
  }
  const parsed = YAML.parse(lines.slice(1, end).join("\n"));
  const keys =
    parsed && typeof parsed === "object" ? Object.keys(parsed).sort() : [];
  const { name, description } = (parsed ?? {}) as Record<string, unknown>;
  if (
    keys.join(",") !== "description,name" ||
    typeof name !== "string" ||
    typeof description !== "string"
  ) {
    throw new Error(
      `${SKILL_MD} frontmatter must hold exactly a string name and description`
    );
  }
  return { name, description };
}

async function main(): Promise<void> {
  const md = await readFile(SKILL_MD, "utf8");
  const body = `export const LOBU_SKILL_MARKDOWN = ${JSON.stringify(md)};\n\nexport const LOBU_SKILL_FRONTMATTER = ${JSON.stringify(readFrontmatter(md))};\n`;
  await writeFile(OUT, `${BANNER}\n${body}`);
  process.stdout.write(`wrote ${OUT} (${md.length} chars)\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
