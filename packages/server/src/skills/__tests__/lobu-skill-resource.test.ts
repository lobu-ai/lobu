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
const operatorSkillPath = resolve(
  __dirname,
  "../../../../../skills/lobu-operator/SKILL.md"
);

describe("lobu skill resource", () => {
  it("stays in sync with skills/lobu/SKILL.md", () => {
    const source = readFileSync(skillPath, "utf-8");
    expect(LOBU_SKILL_MARKDOWN).toBe(source);
  });

  it("is non-empty and carries the skill frontmatter", () => {
    expect(LOBU_SKILL_MARKDOWN.length).toBeGreaterThan(0);
    expect(LOBU_SKILL_MARKDOWN).toContain("name: lobu");
  });

  it("keeps discovery metadata concise", () => {
    const description = LOBU_SKILL_MARKDOWN.match(/^description: (.+)$/m)?.[1];

    expect(description).toBeDefined();
    expect(description?.length).toBeLessThanOrEqual(200);
  });

  it("teaches the agent-facing SDK connector lifecycle", () => {
    expect(LOBU_SKILL_MARKDOWN).toContain("search_sdk");
    expect(LOBU_SKILL_MARKDOWN).toContain("caller-aware live lifecycle");
    expect(LOBU_SKILL_MARKDOWN).toContain("follow the methods it returns");
    expect(LOBU_SKILL_MARKDOWN).toContain("mcp:write");
    expect(LOBU_SKILL_MARKDOWN).toContain("mcp:admin");
    expect(LOBU_SKILL_MARKDOWN).not.toContain("manage_connections");
    expect(LOBU_SKILL_MARKDOWN).not.toContain("manage_feeds");
  });

  it("grounds new-project onboarding in the user's existing surface", () => {
    expect(LOBU_SKILL_MARKDOWN).toContain(
      "Ground yourself in what the user already has"
    );
    expect(LOBU_SKILL_MARKDOWN).toContain("lobu context list");
    expect(LOBU_SKILL_MARKDOWN).toContain("client.agents.list()");
    expect(LOBU_SKILL_MARKDOWN).toContain(
      "two or three concrete alternatives"
    );
    expect(LOBU_SKILL_MARKDOWN).toContain(
      "Do NOT ask for a login email during the interview"
    );
    expect(LOBU_SKILL_MARKDOWN).toContain("step 6");
  });

  it("distinguishes semantic knowledge from structured entities", () => {
    expect(LOBU_SKILL_MARKDOWN).toContain("knowledge.save");
    expect(LOBU_SKILL_MARKDOWN).toContain("entities.create");
    expect(LOBU_SKILL_MARKDOWN).toContain("Promise.allSettled");
  });

  it("keeps organization deletion human-owned", () => {
    expect(LOBU_SKILL_MARKDOWN).toContain(
      "opened from that workspace's settings button in the organization switcher"
    );
    expect(LOBU_SKILL_MARKDOWN).toContain(
      "ClientSDK and Lobu CLI intentionally expose no organization-delete method"
    );
    expect(LOBU_SKILL_MARKDOWN).toContain(
      "one production organization at a time"
    );
    expect(LOBU_SKILL_MARKDOWN).toContain(
      "A `401` or `403` is a stop signal"
    );
  });
});

describe("lobu operator skill", () => {
  const operatorSkill = readFileSync(operatorSkillPath, "utf-8");

  it("keeps discovery metadata concise", () => {
    const description = operatorSkill.match(/^description: (.+)$/m)?.[1];

    expect(description).toBeDefined();
    expect(description?.length).toBeLessThanOrEqual(200);
  });

  it("reads a blocked browser action's dialog from the error details", () => {
    expect(LOBU_SKILL_MARKDOWN).toContain("error.details.output");
    expect(LOBU_SKILL_MARKDOWN).toContain("handle_dialog");
  });

  it("indexes the required contributor workflow", () => {
    expect(operatorSkill).toContain("make task-setup");
    expect(operatorSkill).toContain("red→fix→green");
    expect(operatorSkill).toContain("make pre-pr");
    expect(operatorSkill).toContain("make review-fix");
    expect(operatorSkill).toContain("git add -- <paths>");
    expect(operatorSkill).toContain("make review");
    expect(operatorSkill).toContain("gh pr merge");
  });
});
