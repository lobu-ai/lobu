import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDesiredStateFromConfig } from "../commands/_lib/apply/desired-state";
import { agentScaffoldCommand } from "../commands/agent";
import { isPortFree } from "../commands/dev";
import { initCommand } from "../commands/init";
import { loadProjectLink, saveProjectLink } from "../internal/project-link";

describe("isPortFree", () => {
  test("returns true for a port nothing is holding", async () => {
    // Pick a high port, almost certainly free.
    const port = 49152 + Math.floor(Math.random() * 10_000);
    expect(await isPortFree(port)).toBe(true);
  });

  test("returns false when a server is bound", async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen({ port: 0, host: "127.0.0.1" }, () => resolve())
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected AddressInfo");
    }
    try {
      expect(await isPortFree(address.port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        server.once("close", () => resolve());
        server.close();
      });
    }
  });
});

describe("project-link round-trip", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "lobu-link-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("save then load returns the same context+org", async () => {
    const saved = await saveProjectLink(cwd, {
      context: "lobu",
      org: "acme",
    });
    expect(saved.context).toBe("lobu");
    expect(saved.org).toBe("acme");
    expect(saved.linkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const loaded = await loadProjectLink(cwd);
    expect(loaded?.context).toBe("lobu");
    expect(loaded?.org).toBe("acme");
  });

  test("load returns null when no link file exists", async () => {
    expect(await loadProjectLink(cwd)).toBeNull();
  });

  test("save appends `.lobu/` to an existing .gitignore exactly once", async () => {
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    await saveProjectLink(cwd, { context: "lobu", org: "acme" });
    await saveProjectLink(cwd, { context: "lobu", org: "acme2" });
    const content = readFileSync(join(cwd, ".gitignore"), "utf-8");
    expect(content.match(/^\.lobu\/$/gm)?.length ?? 0).toBe(1);
    expect(content).toContain("node_modules/");
  });
});

describe("lobu init --yes", () => {
  // initCommand runs a real `bun install --ignore-scripts` in the scaffold
  // (the #1181 fix), so these tests are network-bound — bun's 5s default
  // timeout flakes on slow CI runners (observed 5.7s).
  const INIT_TIMEOUT = 120_000;
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "lobu-init-yes-"));
  });
  afterEach(() => {
    // Cleanup deletes a fully scaffolded project; give it the same budget as the
    // init body so a loaded machine doesn't trip the default 5s hook timeout.
    rmSync(cwd, { recursive: true, force: true });
  }, INIT_TIMEOUT);

  test(
    "scaffolds a non-interactive project with defaults",
    async () => {
      await initCommand(cwd, "demo", { yes: true });
      const proj = join(cwd, "demo");
      expect(existsSync(join(proj, "lobu.config.ts"))).toBe(true);
      expect(existsSync(join(proj, ".env"))).toBe(true);
      expect(existsSync(join(proj, "agents", "demo", "IDENTITY.md"))).toBe(
        true
      );
      const env = readFileSync(join(proj, ".env"), "utf-8");
      expect(env.includes("SENTRY_DSN=")).toBe(false);
      // The generated lobu.config.ts imports @lobu/cli/config, so the scaffolded
      // package.json MUST declare @lobu/cli — else `lobu apply` (jiti) can't
      // resolve it outside this monorepo. Regression guard for that blocker.
      const pkg = JSON.parse(readFileSync(join(proj, "package.json"), "utf-8"));
      expect(pkg.devDependencies["@lobu/cli"]).toBeDefined();
      expect(pkg.devDependencies["@lobu/connector-sdk"]).toBeDefined();
      const tsconfig = JSON.parse(
        readFileSync(join(proj, "tsconfig.json"), "utf-8")
      );
      expect(tsconfig.include).toContain("lobu.config.ts");
    },
    INIT_TIMEOUT
  );

  test(
    "scaffolded lobu.config.ts loads into desired state",
    async () => {
      // jiti resolves the externalized `@lobu/cli/config` import relative to the config
      // file, so scaffold inside the package tree (where node_modules is
      // reachable), not the tmpdir() used by the other init tests.
      const fixtureRoot = mkdtempSync(join(import.meta.dir, "init-load-"));
      try {
        await initCommand(fixtureRoot, "loadable", { yes: true });
        const proj = join(fixtureRoot, "loadable");
        const { state } = await loadDesiredStateFromConfig({ cwd: proj });
        expect(state.agents).toHaveLength(1);
        expect(state.agents[0]?.metadata.agentId).toBe("loadable");
        // SOUL/IDENTITY/USER.md from the agent dir are merged into settings.
        expect(state.agents[0]?.settings.identityMd).toContain("loadable");
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
    INIT_TIMEOUT
  );

  test(
    "--here scaffolds into the current directory",
    async () => {
      await initCommand(cwd, undefined, { yes: true, here: true });
      expect(existsSync(join(cwd, "lobu.config.ts"))).toBe(true);
      expect(existsSync(join(cwd, "agents"))).toBe(true);
    },
    INIT_TIMEOUT
  );

  test(
    "--sentry writes SENTRY_DSN",
    async () => {
      await initCommand(cwd, "sentry-on", { yes: true, sentry: true });
      const env = readFileSync(join(cwd, "sentry-on", ".env"), "utf-8");
      expect(env).toMatch(/SENTRY_DSN=/);
    },
    INIT_TIMEOUT
  );

  test(
    "--hosted-slack writes a hosted (no-token) slack connection",
    async () => {
      await initCommand(cwd, "hosted-on", { yes: true, hostedSlack: true });
      const config = readFileSync(
        join(cwd, "hosted-on", "lobu.config.ts"),
        "utf-8"
      );
      // A hosted chat connection: project-level defineConnection, no token.
      // `lobu run` scans project.connections for credentialMode: "hosted".
      expect(config).toContain("defineConnection");
      expect(config).toContain('credentialMode: "hosted"');
      expect(config).toContain("connections: [slack]");
      expect(config).not.toContain("botToken");
      // Not the old agent-scoped platforms field.
      expect(config).not.toContain("platforms:");
    },
    INIT_TIMEOUT
  );

  test("--provider with bad id throws before writing files", async () => {
    await expect(
      initCommand(cwd, "bad-provider", {
        yes: true,
        provider: "definitely-not-a-real-provider",
      })
    ).rejects.toThrow(/Unknown provider/);
  });
});

describe("agent scaffold", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "lobu-scaffold-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("scaffolds the agent dir and prints a defineAgent block", async () => {
    writeFileSync(
      join(cwd, "lobu.config.ts"),
      'import { defineConfig } from "@lobu/cli/config";\nexport default defineConfig({ agents: [] });\n'
    );
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      await agentScaffoldCommand("second", { cwd, name: "Second" });
    } finally {
      console.log = original;
    }
    const output = logs.join("\n");
    expect(output).toContain("const second = defineAgent({");
    expect(output).toContain('id: "second"');
    expect(output).toContain('name: "Second"');
    expect(output).toContain('dir: "./agents/second"');
    expect(existsSync(join(cwd, "agents", "second", "IDENTITY.md"))).toBe(true);
    expect(existsSync(join(cwd, "agents", "second", "SOUL.md"))).toBe(true);
    expect(existsSync(join(cwd, "agents", "second", "USER.md"))).toBe(true);
  });

  test("escapes quotes in --name so the printed snippet stays valid TS", async () => {
    writeFileSync(
      join(cwd, "lobu.config.ts"),
      'import { defineConfig } from "@lobu/cli/config";\nexport default defineConfig({ agents: [] });\n'
    );
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      await agentScaffoldCommand("quoty", { cwd, name: 'Sales "Bot" v2' });
    } finally {
      console.log = original;
    }
    expect(logs.join("\n")).toContain('name: "Sales \\"Bot\\" v2"');
  });
});

describe("retired browser commands", () => {
  test("help exposes the supported commands without CDP capture or local execution", () => {
    const cliEntry = join(import.meta.dir, "..", "..", "bin", "lobu.js");
    for (const command of ["memory", "connector"]) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, cliEntry, command, "--help"],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const output = new TextDecoder().decode(result.stdout);
      expect(output).not.toContain("browser-auth");
      expect(output).not.toContain("remote-debug");
      expect(output).not.toContain("run [connector_key]");
    }
  });
});
