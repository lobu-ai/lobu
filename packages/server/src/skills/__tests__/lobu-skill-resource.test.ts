import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOBU_SKILL_MARKDOWN } from "../lobu-skill.generated";

// The `skill://lobu` MCP resource serves the bundled Lobu SKILL.md so Slackbot
// (and any MCP client) can read it as reference material. The content is
// embedded at build time (see scripts/gen-skill-resource.ts) so it ships
// identically in prod and local dev. Guard against the generated constant
// drifting from the source file.
const skillPath = resolve(__dirname, "../../../../../skills/lobu/SKILL.md");
describe("lobu skill resource", () => {
  it("stays in sync with skills/lobu/SKILL.md", () => {
    const source = readFileSync(skillPath, "utf-8");
    expect(LOBU_SKILL_MARKDOWN).toBe(source);
  });
});
