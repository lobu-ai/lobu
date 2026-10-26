import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "../..");
type Step = {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Job = {
  needs?: string[];
  if?: string;
  steps: Step[];
};
const workflow = (file: string) =>
  Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows", file), "utf8")
  ) as { on: Record<string, unknown>; jobs: Record<string, Job> };
const ci = workflow("ci.yml");
const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function command(cwd: string, ...args: string[]) {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CI fixture",
      GIT_AUTHOR_EMAIL: "ci@example.test",
      GIT_COMMITTER_NAME: "CI fixture",
      GIT_COMMITTER_EMAIL: "ci@example.test",
    },
  });
  if (result.status !== 0)
    throw new Error(`${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "lobu-ci-paths-"));
  fixtures.push(cwd);
  command(cwd, "git", "init", "-q", "-b", "main");
  command(
    cwd,
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-qm",
    "base"
  );
  const base = command(cwd, "git", "rev-parse", "HEAD");
  return { cwd, base };
}

function commit(cwd: string, path: string) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), `fixture ${path}\n`);
  command(cwd, "git", "add", "--", path);
  command(
    cwd,
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "change"
  );
}

function filter(cwd: string, base: string, event = "push") {
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  copyFileSync(
    join(root, "scripts/ci-paths.mjs"),
    join(cwd, "scripts/ci-paths.mjs")
  );
  const outputs: Record<string, string> = {};
  for (const job of ["paths", "optional-smoke-filter"]) {
    const step = ci.jobs[job]!.steps.find((step) => step.id === "filter")!;
    const output = join(cwd, `${job}.output`);
    writeFileSync(output, "");
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", step.run!],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          EVENT_NAME: event,
          BASE_SHA: event === "pull_request" ? base : "",
          BEFORE_SHA: event === "push" ? base : "",
          GITHUB_OUTPUT: output,
        },
      }
    );
    expect(result.status, result.stderr).toBe(0);
    Object.assign(
      outputs,
      Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("="))
      )
    );
  }
  return outputs;
}

const all = {
  packages: "true",
  frontend: "true",
  chromeExt: "true",
  mac: "true",
  connector: "true",
};
const none = Object.fromEntries(Object.keys(all).map((key) => [key, "false"]));

describe("CI executes the complete event diff", () => {
  it.each(["push", "pull_request"])("skips unrelated docs on %s", (event) => {
    const { cwd, base } = fixture();
    commit(cwd, "docs/guide.md");
    expect(filter(cwd, base, event)).toEqual(none);
  });

  it.each([
    ["packages/server/src/server.ts", { ...none, packages: "true" }],
    [
      "packages/connector-worker/src/bin.ts",
      { ...none, packages: "true", mac: "true", connector: "true" },
    ],
    [
      "packages/owletto",
      {
        ...none,
        packages: "true",
        frontend: "true",
        chromeExt: "true",
        mac: "true",
      },
    ],
    ["skills/lobu/SKILL.md", { ...none, packages: "true", connector: "true" }],
    [
      "packages/cli/src/index.ts",
      { ...none, packages: "true", mac: "true", connector: "true" },
    ],
    [
      "config/macos/lobu-auth.entitlements",
      { ...none, packages: "true", mac: "true", connector: "true" },
    ],
    [
      "scripts/build-mac-auth-cli.sh",
      { ...none, packages: "true", mac: "true", connector: "true" },
    ],
    [
      "tsconfig.json",
      { ...none, packages: "true", mac: "true", connector: "true" },
    ],
    [
      "bunfig.toml",
      { ...none, packages: "true", mac: "true", connector: "true" },
    ],
    [
      "patches/synthetic.patch",
      { ...none, packages: "true", mac: "true", connector: "true" },
    ],
    [
      "packages/plugin-api/src/index.ts",
      { ...none, packages: "true", connector: "true" },
    ],
    ["scripts/ci-paths.mjs", { ...all, frontend: "false" }],
  ])("selects the consumers of %s", (path, expected) => {
    const { cwd, base } = fixture();
    commit(cwd, path as string);
    expect(filter(cwd, base)).toEqual(expected);
  });

  it("includes every commit in a multi-commit push", () => {
    const { cwd, base } = fixture();
    commit(cwd, "packages/connector-worker/src/bin.ts");
    commit(cwd, "docs/guide.md");
    expect(filter(cwd, base)).toEqual({
      ...none,
      packages: "true",
      mac: "true",
      connector: "true",
    });
  });

  it("uses the two push endpoints even after history diverges", () => {
    const { cwd } = fixture();
    commit(cwd, "packages/core/removed.ts");
    const before = command(cwd, "git", "rev-parse", "HEAD");
    command(cwd, "git", "reset", "--hard", "HEAD~1");
    commit(cwd, "docs/guide.md");
    expect(filter(cwd, before)).toEqual({
      ...none,
      packages: "true",
      mac: "true",
      connector: "true",
    });
    // The same histories on a PR use their merge base, excluding base-only changes.
    expect(filter(cwd, before, "pull_request")).toEqual(none);
  });

  it("includes the removed runtime path when a file moves to docs", () => {
    const { cwd } = fixture();
    commit(cwd, "packages/core/moved.ts");
    const base = command(cwd, "git", "rev-parse", "HEAD");
    mkdirSync(join(cwd, "docs"));
    command(cwd, "git", "mv", "packages/core/moved.ts", "docs/moved.md");
    command(
      cwd,
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "move"
    );
    expect(filter(cwd, base)).toEqual({
      ...none,
      packages: "true",
      mac: "true",
      connector: "true",
    });
  });

  it.each([
    "",
    "0".repeat(40),
    "f".repeat(40),
  ])("runs all suites without a usable push base (%s)", (base) => {
    const { cwd } = fixture();
    commit(cwd, "docs/guide.md");
    expect(filter(cwd, base)).toEqual(all);
  });

  it("runs every suite for a manual dispatch", () => {
    const { cwd, base } = fixture();
    expect(filter(cwd, base, "workflow_dispatch")).toEqual(all);
  });
});

describe("image and artifact gates", () => {
  const images = workflow("build-images.yml");
  it("keeps an exact-tip image producer available for canary publication", () => {
    const push = images.on.push as Record<string, unknown>;
    expect(push.paths).toBeUndefined();
    expect(push["paths-ignore"]).toBeUndefined();
    expect(push.branches).toEqual(["main"]);
    expect(images.on.release).toBeDefined();
    expect(images.on.workflow_dispatch).toBeDefined();
  });

  it("builds independent candidates in parallel and smokes the worker digest before promotion", () => {
    for (const id of ["build-app", "build-worker", "build-embeddings-service"])
      expect(images.jobs[id]!.needs).toEqual(["generate-tag"]);
    expect(images.jobs["connector-parity-smoke"]!.needs).toEqual([
      "generate-tag",
      "build-worker",
    ]);
    const smoke = images.jobs["connector-parity-smoke"]!.steps;
    expect(
      smoke.some((step) => step.uses?.startsWith("docker/build-push-action@"))
    ).toBe(false);
    const run = smoke.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("--network=none");
    expect(run).toContain("${{ needs.build-worker.outputs.digest }}");
    expect(run).toContain(".isolate_lane.available == true");
    expect(images.jobs["promote-images"]!.needs).toContain(
      "connector-parity-smoke"
    );
    expect(images.jobs["promote-images"]!.if).not.toMatch(
      /always\(|!cancelled\(/
    );
  });

  it.each([
    [0, true, true],
    [0, false, false],
    [17, true, false],
  ])("worker smoke fails closed (docker exit %s, isolate %s)", (exit, available, success) => {
    const { cwd } = fixture();
    const docker = join(cwd, "docker");
    writeFileSync(
      docker,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_ARGS"\nprintf \'%s\\n\' "$SELF_CHECK"\nexit "$DOCKER_EXIT"\n'
    );
    chmodSync(docker, 0o755);
    const step = images.jobs["connector-parity-smoke"]!.steps.find(
      (step) => step.run
    )!;
    const digest = `sha256:${"a".repeat(64)}`;
    const result = spawnSync(
      "bash",
      [
        "-e",
        "-o",
        "pipefail",
        "-c",
        step.run!.replace("${{ needs.build-worker.outputs.digest }}", digest),
      ],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${cwd}:${process.env.PATH}`,
          REGISTRY: "registry.example.test",
          IMAGE_NAME_WORKER: "synthetic/worker",
          DOCKER_ARGS: join(cwd, "docker-args"),
          DOCKER_EXIT: String(exit),
          SELF_CHECK: JSON.stringify({ isolate_lane: { available } }),
        },
      }
    );
    expect(result.status === 0, result.stderr).toBe(success);
    expect(readFileSync(join(cwd, "docker-args"), "utf8").split("\n")).toEqual([
      "run",
      "--rm",
      "--network=none",
      `registry.example.test/synthetic/worker@${digest}`,
      "node",
      "dist/bin.js",
      "self-check",
      "--json",
      "",
    ]);
  });

  it("keeps the PR image smoke and the main host CLI smoke", () => {
    const steps = ci.jobs["connector-parity-smoke"]!.steps;
    const build = steps.find((step) =>
      step.uses?.startsWith("docker/build-push-action@")
    )!;
    expect(build.if).toBe("github.event_name != 'push'");
    expect(build.with?.["cache-from"]).toBe("type=gha,scope=worker");
    expect(build.with?.["cache-to"]).toBeUndefined();
    const host = steps.find((step) =>
      step.run?.includes("connector runtime-self-check")
    );
    expect(host).toBeDefined();
    expect(host?.if ?? "").not.toContain("github.event_name");
  });

  it("keeps all consumer environments on publication, daily and manual runs", () => {
    const smoke = workflow("published-artifact-smoke.yml");
    expect(smoke.on.push).toBeUndefined();
    for (const trigger of ["workflow_call", "schedule", "workflow_dispatch"])
      expect(smoke.on[trigger]).toBeDefined();
  });
});
