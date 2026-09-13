import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDesiredStateFromConfig } from "../desired-state.js";

// Fixtures live under the worktree (next to this test) so that the externalized
// `@lobu/cli/config` import in the generated bundle resolves from node_modules.
describe("loadDesiredStateFromConfig", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("bundles + imports lobu.config.ts and maps it to DesiredState", async () => {
    dir = mkdtempSync(join(import.meta.dir, "fixture-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineEntityType } from "@lobu/cli/config";`,
        `const person = defineEntityType({ key: "person" });`,
        `export default defineConfig({`,
        `  org: "test-org",`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  entities: [person],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state, configPath } = await loadDesiredStateFromConfig({
      cwd: dir,
    });
    expect(configPath).toContain("lobu.config.ts");
    expect(state.memory).toEqual({ org: "test-org" });
    expect(state.agents[0]?.metadata.agentId).toBe("crm");
    expect(state.memorySchema.entityTypes[0]?.slug).toBe("person");
  });

  test("rejects when no lobu.config.ts is present", async () => {
    dir = mkdtempSync(join(import.meta.dir, "empty-"));
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /No lobu\.config\.ts/
    );
  });

  test("rejects a config whose default export is not defineConfig()", async () => {
    dir = mkdtempSync(join(import.meta.dir, "bad-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      `export default { nope: true };\n`
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /defineConfig/
    );
  });

  test("ships a connectorFromFile source referenced by a connection", async () => {
    dir = mkdtempSync(join(import.meta.dir, "connector-"));
    writeFileSync(
      join(dir, "weather.connector.ts"),
      [
        `import { defineConnector } from "@lobu/connector-sdk/define-connector";`,
        `export default defineConnector({`,
        `  key: "weather",`,
        `  feeds: { current: { sync: async () => [] } },`,
        `});`,
        ``,
      ].join("\n")
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { connectorFromFile, defineAgent, defineConfig, defineConnection } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connectors: [connectorFromFile("./weather.connector.ts")],`,
        `  connections: [defineConnection({ slug: "weather", connector: "weather" })],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.connectors.definitions).toHaveLength(1);
    const def = state.connectors.definitions[0];
    expect(def?.key).toBeNull();
    expect(def?.sourceFile).toBe("weather.connector.ts");
    expect(def?.sourcePath).toContain("weather.connector.ts");
    expect(def?.sourceCode).toContain("defineConnector");
    // The connection references the connector by key; the server resolves the
    // null key when it compiles the shipped source.
    expect(state.connectors.connections[0]?.connector).toBe("weather");
  });

  test("--only agents skips connector definitions", async () => {
    dir = mkdtempSync(join(import.meta.dir, "only-"));
    writeFileSync(
      join(dir, "weather.connector.ts"),
      [
        `import { defineConnector } from "@lobu/connector-sdk/define-connector";`,
        `export default defineConnector({ key: "weather", feeds: { current: { sync: async () => [] } } });`,
        ``,
      ].join("\n")
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { connectorFromFile, defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connectors: [connectorFromFile("./weather.connector.ts")],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({
      cwd: dir,
      only: "agents",
    });
    expect(state.connectors.definitions).toHaveLength(0);
  });

  test("connector definitions are sorted by sourceFile", async () => {
    dir = mkdtempSync(join(import.meta.dir, "multi-"));
    const src = `import { defineConnector } from "@lobu/connector-sdk/define-connector";\nexport default defineConnector({ key: "x", feeds: {} });\n`;
    writeFileSync(join(dir, "beta.connector.ts"), src);
    writeFileSync(join(dir, "alpha.connector.ts"), src);
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { connectorFromFile, defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connectors: [`,
        `    connectorFromFile("./beta.connector.ts"),`,
        `    connectorFromFile("./alpha.connector.ts"),`,
        `  ],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.connectors.definitions.map((d) => d.sourceFile)).toEqual([
      "alpha.connector.ts",
      "beta.connector.ts",
    ]);
  });

  test("connectorFromFile with a missing file fails clearly", async () => {
    dir = mkdtempSync(join(import.meta.dir, "missingconn-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { connectorFromFile, defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connectors: [connectorFromFile("./nope.connector.ts")],`,
        `});`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /connectorFromFile.*does not exist/
    );
  });

  test("connectorFromFile rejects a path escaping the config dir", async () => {
    dir = mkdtempSync(join(import.meta.dir, "escconn-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { connectorFromFile, defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connectors: [connectorFromFile("../evil.connector.ts")],`,
        `});`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /must not contain `\.\.`|resolves outside/
    );
  });

  test("loads agent-dir markdown + a file skill; frontmatter nix is ignored", async () => {
    dir = mkdtempSync(join(import.meta.dir, "agentdir-"));
    const agentDir = join(dir, "agents", "crm");
    mkdirSync(join(agentDir, "skills", "crm-ops"), { recursive: true });
    writeFileSync(join(agentDir, "SOUL.md"), "You are the CRM agent.\n");
    writeFileSync(join(agentDir, "IDENTITY.md"), "CRM identity.\n");
    writeFileSync(
      join(agentDir, "skills", "crm-ops", "SKILL.md"),
      [
        `---`,
        `name: crm-ops`,
        `nixPackages: ["jq"]`,
        `---`,
        `Use the CRM API.`,
        ``,
      ].join("\n")
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, skillFromFile } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [`,
        `    defineAgent({`,
        `      id: "crm",`,
        `      network: { allowed: ["github.com"] },`,
        `      skills: [skillFromFile("./agents/crm/skills/crm-ops")],`,
        `    }),`,
        `  ],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const settings = state.agents[0]?.settings;
    expect(settings?.soulMd).toBe("You are the CRM agent.");
    expect(settings?.identityMd).toBe("CRM identity.");
    expect(settings?.skillsConfig?.skills[0]?.name).toBe("crm-ops");
    // Skills contribute no network — only the agent's domains remain.
    expect(settings?.networkConfig?.allowedDomains).toEqual(["github.com"]);
    // A legacy `nixPackages:` frontmatter key is tolerated but ignored.
    expect(settings?.nixConfig).toBeUndefined();
    expect(settings?.skillsConfig?.skills[0]).not.toHaveProperty("nixPackages");
  });

  test("an inline defineSkill carries content with no files", async () => {
    dir = mkdtempSync(join(import.meta.dir, "inline-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineSkill } from "@lobu/cli/config";`,
        `const greet = defineSkill({`,
        `  name: "greet",`,
        `  description: "Greet someone.",`,
        `  content: "Generate a warm greeting.",`,
        `});`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "a", skills: [greet] })],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const skill = state.agents[0]?.settings.skillsConfig?.skills[0];
    expect(skill?.name).toBe("greet");
    expect(skill?.content).toBe("Generate a warm greeting.");
    expect(skill?.description).toBe("Greet someone.");
  });

  test("two agents: custom + default dirs keep index alignment", async () => {
    dir = mkdtempSync(join(import.meta.dir, "multiagent-"));
    // Agent "a" uses a custom dir; agent "b" uses the default ./agents/b.
    mkdirSync(join(dir, "custom-a"), { recursive: true });
    mkdirSync(join(dir, "agents", "b"), { recursive: true });
    writeFileSync(join(dir, "custom-a", "SOUL.md"), "Agent A soul.\n");
    writeFileSync(join(dir, "agents", "b", "SOUL.md"), "Agent B soul.\n");
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [`,
        `    defineAgent({ id: "a", dir: "./custom-a" }),`,
        `    defineAgent({ id: "b" }),`,
        `  ],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    // Index alignment: agents[0]=a (custom dir), agents[1]=b (default dir).
    expect(state.agents[0]?.metadata.agentId).toBe("a");
    expect(state.agents[0]?.settings.soulMd).toBe("Agent A soul.");
    expect(state.agents[1]?.metadata.agentId).toBe("b");
    expect(state.agents[1]?.settings.soulMd).toBe("Agent B soul.");
  });

  test("a skill shared by two agents via skillFromFile lands on both", async () => {
    dir = mkdtempSync(join(import.meta.dir, "shared-"));
    mkdirSync(join(dir, "skills", "shared"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "shared", "SKILL.md"),
      "---\nname: shared\n---\nShared.\n"
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, skillFromFile } from "@lobu/cli/config";`,
        `const shared = skillFromFile("./skills/shared");`,
        `export default defineConfig({`,
        `  agents: [`,
        `    defineAgent({ id: "a", skills: [shared] }),`,
        `    defineAgent({ id: "b", skills: [shared] }),`,
        `  ],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.agents[0]?.settings.skillsConfig?.skills[0]?.name).toBe(
      "shared"
    );
    expect(state.agents[1]?.settings.skillsConfig?.skills[0]?.name).toBe(
      "shared"
    );
  });

  test("rejects duplicate skill names within an agent", async () => {
    dir = mkdtempSync(join(import.meta.dir, "dup-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineSkill } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "a", skills: [`,
        `    defineSkill({ name: "ops", content: "one" }),`,
        `    defineSkill({ name: "ops", content: "two" }),`,
        `  ] })],`,
        `});`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /duplicate skill "ops"/
    );
  });

  test("skillFromFile with a missing SKILL.md fails clearly", async () => {
    dir = mkdtempSync(join(import.meta.dir, "missing-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, skillFromFile } from "@lobu/cli/config";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "a", skills: [skillFromFile("./nope")] })],`,
        `});`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /no SKILL\.md found/
    );
  });

  test("loads a script executor without importing or executing the job", async () => {
    dir = mkdtempSync(join(import.meta.dir, "script-"));
    const source =
      'throw new Error("must not execute at apply time"); export default async () => ({ ok: true });';
    writeFileSync(join(dir, "job.ts"), source);
    writeFileSync(
      join(dir, "lobu.config.ts"),
      `
      import { defineAgent, defineConfig, defineAutomation, scriptFromFile } from "@lobu/cli/config";
      const agent = defineAgent({ id: "script-owner" });
      export default defineConfig({ agents: [agent], automations: [defineAutomation({
        agent, slug: "script-job", executor: scriptFromFile("./job.ts")
      })] });
    `
    );
    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.automations[0]?.executor).toEqual({ kind: "script", source });
    expect(state.automations[0]?.prompt).toBe("");
  });

  test("rejects a malformed script executor with actionable guidance", async () => {
    dir = mkdtempSync(join(import.meta.dir, "badscript-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      `
      import { defineAgent, defineConfig, defineAutomation } from "@lobu/cli/config";
      const agent = defineAgent({ id: "script-owner" });
      export default defineConfig({ agents: [agent], automations: [defineAutomation({
        agent, slug: "script-job", executor: null
      })] });
    `
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /scriptFromFile/
    );
  });

  test("rejects non-object script executor params", async () => {
    dir = mkdtempSync(join(import.meta.dir, "badscriptparams-"));
    writeFileSync(join(dir, "job.ts"), "export default async () => {};\n");
    writeFileSync(
      join(dir, "lobu.config.ts"),
      `
      import { defineAgent, defineConfig, defineAutomation, scriptFromFile } from "@lobu/cli/config";
      const agent = defineAgent({ id: "script-owner" });
      export default defineConfig({ agents: [agent], automations: [defineAutomation({
        agent, slug: "script-job", executor: scriptFromFile("./job.ts", [])
      })] });
    `
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /params must be an object, not an array/
    );
  });

  test("loads an explicit reaction removal alongside a script executor", async () => {
    dir = mkdtempSync(join(import.meta.dir, "reaction-null-"));
    writeFileSync(join(dir, "job.ts"), "export default async () => ({});\n");
    writeFileSync(
      join(dir, "lobu.config.ts"),
      `
      import { defineAgent, defineConfig, defineAutomation, scriptFromFile } from "@lobu/cli/config";
      const agent = defineAgent({ id: "script-owner" });
      export default defineConfig({ agents: [agent], automations: [defineAutomation({
        agent, slug: "script-job", executor: scriptFromFile("./job.ts"), reaction: null
      })] });
    `
    );
    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.automations[0]?.reactionScript).toBeNull();
  });

  test("rejects an explicit reaction removal with no other instruction source", async () => {
    dir = mkdtempSync(join(import.meta.dir, "reaction-null-bare-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      `
      import { defineAgent, defineConfig, defineAutomation } from "@lobu/cli/config";
      const agent = defineAgent({ id: "script-owner" });
      export default defineConfig({ agents: [agent], automations: [defineAutomation({
        agent, slug: "script-job", reaction: null
      })] });
    `
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /needs instructions/
    );
  });

  test("loads an automation reaction script (raw source) referenced by path", async () => {
    dir = mkdtempSync(join(import.meta.dir, "reaction-"));
    mkdirSync(join(dir, "reactions"));
    writeFileSync(
      join(dir, "reactions", "health.reaction.ts"),
      [
        `import type { ReactionContext, ReactionClient } from "@lobu/connector-sdk";`,
        `export default async (ctx: ReactionContext, client: ReactionClient) => {`,
        `  await client.knowledge.save({ content: "ok", semantic_type: "digest" });`,
        `};`,
        ``,
      ].join("\n")
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineAutomation, defineSkill, reactionFromFile } from "@lobu/cli/config";`,
        `const crm = defineAgent({ id: "crm", skills: [defineSkill({ name: "s", content: "p" })] });`,
        `export default defineConfig({`,
        `  agents: [crm],`,
        `  automations: [defineAutomation({`,
        `    agent: crm, slug: "health", skills: ["s"],`,
        `    reaction: reactionFromFile("./reactions/health.reaction.ts"),`,
        `  })],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const rs = state.automations[0]?.reactionScript;
    expect(rs?.sourcePath).toContain("health.reaction.ts");
    expect(rs?.sourceCode).toContain("client.knowledge.save");
  });

  test("rejects a reaction path that escapes the config dir or is missing", async () => {
    const write = (reaction: string) => {
      dir = mkdtempSync(join(import.meta.dir, "badreaction-"));
      writeFileSync(
        join(dir, "lobu.config.ts"),
        [
          `import { defineAgent, defineConfig, defineAutomation, defineSkill, reactionFromFile } from "@lobu/cli/config";`,
          `const crm = defineAgent({ id: "crm", skills: [defineSkill({ name: "s", content: "p" })] });`,
          `export default defineConfig({ agents: [crm], automations: [defineAutomation({`,
          `  agent: crm, slug: "w", skills: ["s"], reaction: reactionFromFile(${JSON.stringify(reaction)}),`,
          `})] });`,
          ``,
        ].join("\n")
      );
      return loadDesiredStateFromConfig({ cwd: dir });
    };
    await expect(write("../escape.reaction.ts")).rejects.toThrow(/\.\./);
    rmSync(dir, { recursive: true, force: true });
    await expect(write("/abs/path.reaction.ts")).rejects.toThrow(
      /relative POSIX path/
    );
    rmSync(dir, { recursive: true, force: true });
    await expect(write("./missing.reaction.ts")).rejects.toThrow(
      /does not exist/
    );
    rmSync(dir, { recursive: true, force: true });
    // Present-but-empty must be rejected (not silently skipped) — parity with
    // parseAutomation, which validates whenever the field is present.
    await expect(write("")).rejects.toThrow(/sibling \.ts file/);
    rmSync(dir, { recursive: true, force: true });
    await expect(write("./notes.md")).rejects.toThrow(/must end in `\.ts`/);
  });

  test("rejects a bare-string reaction with a clear reactionFromFile message", async () => {
    // jiti evaluates the config without typechecking, so a stale
    // `reaction: "./x.reaction.ts"` string slips through. It must fail with
    // guidance to use reactionFromFile(), not a downstream TypeError.
    dir = mkdtempSync(join(import.meta.dir, "strreaction-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineAutomation, defineSkill } from "@lobu/cli/config";`,
        `const crm = defineAgent({ id: "crm", skills: [defineSkill({ name: "s", content: "p" })] });`,
        `export default defineConfig({ agents: [crm], automations: [defineAutomation({`,
        `  agent: crm, slug: "w", skills: ["s"], reaction: "./reactions/x.reaction.ts",`,
        `})] });`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /reactionFromFile/
    );
  });

  test("attaches the reaction to the right automation when only one of several has one", async () => {
    dir = mkdtempSync(join(import.meta.dir, "reactionidx-"));
    mkdirSync(join(dir, "reactions"));
    writeFileSync(
      join(dir, "reactions", "second.reaction.ts"),
      `export default async () => {};\n`
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineAutomation, defineSkill, reactionFromFile } from "@lobu/cli/config";`,
        `const a = defineAgent({ id: "a", skills: [defineSkill({ name: "s", content: "p" })] });`,
        `export default defineConfig({ agents: [a], automations: [`,
        `  defineAutomation({ agent: a, slug: "first", skills: ["s"] }),`,
        `  defineAutomation({ agent: a, slug: "second", skills: ["s"], reaction: reactionFromFile("./reactions/second.reaction.ts") }),`,
        `] });`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.automations[0]?.slug).toBe("first");
    expect(state.automations[0]?.reactionScript).toBeUndefined();
    expect(state.automations[1]?.slug).toBe("second");
    expect(state.automations[1]?.reactionScript?.sourcePath).toContain(
      "second.reaction.ts"
    );
  });

  test("pins Automation skills[] as ordered {name, content} snapshots, leaving prompt alone", async () => {
    dir = mkdtempSync(join(import.meta.dir, "compile-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineAutomation, defineSkill } from "@lobu/cli/config";`,
        `const a = defineAgent({ id: "a", skills: [`,
        `  defineSkill({ name: "triage", description: "d1", content: "Triage rules." }),`,
        `  defineSkill({ name: "style", description: "d2", content: "Style rules." }),`,
        `] });`,
        `export default defineConfig({ agents: [a], automations: [`,
        `  defineAutomation({ agent: a, slug: "w", prompt: "Do the thing.", skills: ["style", "triage"] }),`,
        `] });`,
        ``,
      ].join("\n")
    );
    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    // Order follows the Automation's list, not the library's. Descriptions are
    // not part of the snapshot, so a description-only skill edit must not churn
    // versions.
    expect(state.automations[0]?.skillSnapshots).toEqual([
      { name: "style", content: "Style rules." },
      { name: "triage", content: "Triage rules." },
    ]);
    // The task statement is the author's and is NOT overwritten by the skill
    // bodies — that conflation is what #2320's follow-up removed.
    expect(state.automations[0]?.prompt).toBe("Do the thing.");
  });

  test("a skills-only Automation keeps an empty prompt rather than inheriting skill text", async () => {
    dir = mkdtempSync(join(import.meta.dir, "skillsonly-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineAutomation, defineSkill } from "@lobu/cli/config";`,
        `const a = defineAgent({ id: "a", skills: [`,
        `  defineSkill({ name: "triage", content: "Triage rules." }),`,
        `] });`,
        `export default defineConfig({ agents: [a], automations: [`,
        `  defineAutomation({ agent: a, slug: "w", skills: ["triage"] }),`,
        `] });`,
        ``,
      ].join("\n")
    );
    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.automations[0]?.prompt).toBe("");
    expect(state.automations[0]?.skillSnapshots).toEqual([
      { name: "triage", content: "Triage rules." },
    ]);
  });

  test("rejects an Automation skill that is missing or has an empty body", async () => {
    const write = (skills: string, automationSkills: string) => {
      dir = mkdtempSync(join(import.meta.dir, "badskill-"));
      writeFileSync(
        join(dir, "lobu.config.ts"),
        [
          `import { defineAgent, defineConfig, defineAutomation, defineSkill } from "@lobu/cli/config";`,
          `const a = defineAgent({ id: "a", skills: [${skills}] });`,
          `export default defineConfig({ agents: [a], automations: [`,
          `  defineAutomation({ agent: a, slug: "w", skills: [${automationSkills}] }),`,
          `] });`,
          ``,
        ].join("\n")
      );
      return loadDesiredStateFromConfig({ cwd: dir });
    };
    await expect(
      write(`defineSkill({ name: "real", content: "x" })`, `"ghost"`)
    ).rejects.toThrow(/no skill with that name/);
    rmSync(dir, { recursive: true, force: true });
    await expect(
      write(`defineSkill({ name: "empty", content: "  " })`, `"empty"`)
    ).rejects.toThrow(/body is empty/);
    rmSync(dir, { recursive: true, force: true });
    await expect(
      write(
        `defineSkill({ name: "unsafe/name", content: "x" })`,
        `"unsafe/name"`
      )
    ).rejects.toThrow(/names may contain only/);
  });

  test("rejects pinned skill text over the 32KB cap", async () => {
    dir = mkdtempSync(join(import.meta.dir, "cap-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineAutomation, defineSkill } from "@lobu/cli/config";`,
        `const big = "x".repeat(33 * 1024);`,
        `const a = defineAgent({ id: "a", skills: [defineSkill({ name: "big", content: big })] });`,
        `export default defineConfig({ agents: [a], automations: [`,
        `  defineAutomation({ agent: a, slug: "w", skills: ["big"] }),`,
        `] });`,
        ``,
      ].join("\n")
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /maximum is 32768/
    );
  });

  test("no connectors/ dir → no definitions", async () => {
    dir = mkdtempSync(join(import.meta.dir, "nodir-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig } from "@lobu/cli/config";`,
        `export default defineConfig({ agents: [defineAgent({ id: "crm" })] });`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.connectors.definitions).toHaveLength(0);
  });

  test("reads entity write rules off disk as RAW source", async () => {
    dir = mkdtempSync(join(import.meta.dir, "rules-"));
    mkdirSync(join(dir, "rules"));
    writeFileSync(
      join(dir, "rules", "invoice.ts"),
      `export default (row) => { if (row.changed("status")) row.deny("nope"); };\n`
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineConfig, defineEntityType, rulesFromFile } from "@lobu/cli/config";`,
        `export default defineConfig({ agents: [], entities: [`,
        `  defineEntityType({ key: "invoice", rules: rulesFromFile("./rules/invoice.ts") }),`,
        `] });`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const type = state.memorySchema.entityTypes[0];
    expect(type?.slug).toBe("invoice");
    expect(type?.rulesSource?.sourcePath).toContain("invoice.ts");
    // RAW source, not a compiled artifact — the server owns compilation, so a
    // bundled blob arriving here would mean the CLI compiled it first.
    expect(type?.rulesSource?.sourceCode).toContain(`row.deny("nope")`);
    expect(type?.rulesSource?.sourceCode).toContain("export default");
  });

  test("attaches rules to the right entity type when only one of several has them", async () => {
    dir = mkdtempSync(join(import.meta.dir, "rulesidx-"));
    mkdirSync(join(dir, "rules"));
    writeFileSync(
      join(dir, "rules", "second.ts"),
      `export default () => {};\n`
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineConfig, defineEntityType, rulesFromFile } from "@lobu/cli/config";`,
        `export default defineConfig({ agents: [], entities: [`,
        `  defineEntityType({ key: "first" }),`,
        `  defineEntityType({ key: "second", rules: rulesFromFile("./rules/second.ts") }),`,
        `  defineEntityType({ key: "third" }),`,
        `] });`,
        ``,
      ].join("\n")
    );

    // The attach step walks entities by INDEX against the mapped types, so an
    // off-by-one would silently rule-govern the wrong type — the failure mode
    // worth pinning, since both types would still apply cleanly.
    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    const types = state.memorySchema.entityTypes;
    expect(types.map((t) => t.slug)).toEqual(["first", "second", "third"]);
    expect(types[0]?.rulesSource).toBeUndefined();
    expect(types[1]?.rulesSource?.sourcePath).toContain("second.ts");
    expect(types[2]?.rulesSource).toBeUndefined();
  });

  test("rejects a bare string path instead of rulesFromFile()", async () => {
    dir = mkdtempSync(join(import.meta.dir, "rulesbare-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineConfig, defineEntityType } from "@lobu/cli/config";`,
        `export default defineConfig({ agents: [], entities: [`,
        `  defineEntityType({ key: "invoice", rules: "./rules/invoice.ts" }),`,
        `] });`,
        ``,
      ].join("\n")
    );

    // jiti evaluates the config without typechecking, so the type error does not
    // stop this — it would read `.path` off a string and ship `undefined`.
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /rulesFromFile/
    );
  });

  test("rejects a rules path that escapes the config directory", async () => {
    dir = mkdtempSync(join(import.meta.dir, "rulesesc-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineConfig, defineEntityType, rulesFromFile } from "@lobu/cli/config";`,
        `export default defineConfig({ agents: [], entities: [`,
        `  defineEntityType({ key: "invoice", rules: rulesFromFile("../outside.ts") }),`,
        `] });`,
        ``,
      ].join("\n")
    );

    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /\.\./
    );
  });

  test("rejects a rules file over the size cap", async () => {
    dir = mkdtempSync(join(import.meta.dir, "rulesbig-"));
    mkdirSync(join(dir, "rules"));
    writeFileSync(
      join(dir, "rules", "huge.ts"),
      `export default () => {};\n// ${"x".repeat(33 * 1024)}\n`
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineConfig, defineEntityType, rulesFromFile } from "@lobu/cli/config";`,
        `export default defineConfig({ agents: [], entities: [`,
        `  defineEntityType({ key: "invoice", rules: rulesFromFile("./rules/huge.ts") }),`,
        `] });`,
        ``,
      ].join("\n")
    );

    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow();
  });
});
