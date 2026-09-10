import { describe, expect, it } from "bun:test";
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
import { join } from "node:path";
import {
  canaryVersion,
  prepareManifests,
  promotionAllowed,
} from "../canary-publish.mjs";
import { __testing } from "../publish-packages.mjs";

const sha = "a".repeat(40);
const version = `19.2.0-canary.123.g${sha}`;

describe("npm canary publication", () => {
  it("binds a deterministic prerelease to the full commit", () => {
    expect(canaryVersion("19.2.0", "123", sha)).toBe(version);
    for (const args of [
      ["bad", "123", sha],
      ["19.2.0", "no", sha],
      ["19.2.0", "123", "main"],
    ]) {
      expect(() => canaryVersion(...args)).toThrow();
    }
  });

  it("versions every published package and pins internal dependencies", () => {
    const manifests = [
      { name: "@lobu/core", version: "1.0.0" },
      {
        name: "@lobu/cli",
        version: "2.0.0",
        dependencies: { "@lobu/core": "^1.0.0", external: "^2.0.0" },
      },
    ];
    const prepared = prepareManifests(manifests, version);
    expect(prepared.map((pkg) => pkg.version)).toEqual([version, version]);
    expect(prepared[1].dependencies).toEqual({
      "@lobu/core": version,
      external: "^2.0.0",
    });
    expect(manifests[0].version).toBe("1.0.0");
  });

  it("keeps prereleases away from latest even on a mistyped invocation", () => {
    expect(
      __testing.publishArgs(undefined, "canary-candidate", version)
    ).toContain("canary-candidate");
    expect(() => __testing.publishArgs(undefined, "latest", version)).toThrow();
    expect(() => __testing.publishArgs(undefined, "canary", version)).toThrow();
    expect(__testing.publishArgs(undefined, "latest", "19.2.0")).toContain(
      "latest"
    );
  });

  it("only promotes first, same, or descendant commits", () => {
    expect(
      promotionAllowed(undefined, version, () => {
        throw new Error("unexpected");
      })
    ).toBe(true);
    expect(promotionAllowed(version, version, () => false)).toBe(true);
    const old = `19.2.0-canary.122.g${"b".repeat(40)}`;
    expect(
      promotionAllowed(
        old,
        version,
        (from, to) => from === "b".repeat(40) && to === sha
      )
    ).toBe(true);
    expect(promotionAllowed(old, version, () => false)).toBe(false);
    expect(() => promotionAllowed("19.2.0", version, () => true)).toThrow();
  });

  it("requires artifact smoke before advancing the opt-in tag", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(
        new URL("../../.github/workflows/publish-canary.yml", import.meta.url),
        "utf8"
      )
    ) as any;
    expect(workflow.on.workflow_run.workflows).toEqual([
      "Build and Push Images",
    ]);
    expect(workflow.jobs.promote.needs).toContain("smoke");
    expect(workflow.jobs.smoke.uses).toBe(
      "./.github/workflows/published-artifact-smoke.yml"
    );
    expect(workflow.jobs.smoke.with.version).toBe(
      "${{ needs.publish.outputs.version }}"
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    // The required image-job list is copied from publish-packages.yml, whose
    // own test pins it to build-images.yml; keep the copy from drifting.
    const stable = Bun.YAML.parse(
      readFileSync(
        new URL(
          "../../.github/workflows/publish-packages.yml",
          import.meta.url
        ),
        "utf8"
      )
    ) as any;
    expect(workflow.env.REQUIRED_IMAGE_JOBS).toBe(
      stable.env.REQUIRED_IMAGE_JOBS
    );
  });
});

// Run the actual command entry points in an isolated filesystem with a fake
// registry. No network or publication credentials are used by these probes.
describe("canary commands", () => {
  it("prepares the full fleet, retries promotion and preserves latest", () => {
    withFixture((root, run, registry) => {
      const prepared = run("prepare");
      expect(prepared.status).toBe(0);
      expect(prepared.stdout.trim()).toBe(version);
      for (const { dir } of __testing.PACKAGES) {
        expect(
          JSON.parse(readFileSync(`${root}/${dir}/package.json`, "utf8"))
            .version
        ).toBe(version);
      }
      for (let attempt = 0; attempt < 2; attempt++)
        expect(run("promote", version).status).toBe(0);
      for (const tags of Object.values(registry()) as any[]) {
        expect(tags).toEqual({ latest: "19.2.0", canary: version });
      }
    });
  });

  it("fails closed on registry failure or a missing package before moving tags", () => {
    for (const fault of ["registry", "missing"]) {
      withFixture((_root, run, registry) => {
        expect(run("promote", version, fault).status).not.toBe(0);
        for (const tags of Object.values(registry()) as any[])
          expect(tags.canary).toBeUndefined();
      });
    }
  });
});

function withFixture(
  test: (
    root: string,
    run: (
      op: string,
      value?: string,
      fault?: string
    ) => ReturnType<typeof spawnSync> & { stdout: string },
    registry: () => Record<string, unknown>
  ) => void
) {
  const root = mkdtempSync(join(tmpdir(), "lobu-canary-test-"));
  try {
    mkdirSync(`${root}/scripts`);
    mkdirSync(`${root}/bin`);
    for (const file of [
      "canary-publish.mjs",
      "publish-packages.mjs",
      "release-provenance.mjs",
    ]) {
      copyFileSync(
        new URL(`../${file}`, import.meta.url),
        `${root}/scripts/${file}`
      );
    }
    const tags: Record<string, unknown> = {};
    for (const { dir } of __testing.PACKAGES) {
      mkdirSync(`${root}/${dir}`, { recursive: true });
      const pkg = JSON.parse(
        readFileSync(
          new URL(`../../${dir}/package.json`, import.meta.url),
          "utf8"
        )
      );
      writeFileSync(`${root}/${dir}/package.json`, JSON.stringify(pkg));
      tags[pkg.name] = { latest: "19.2.0" };
    }
    writeFileSync(
      `${root}/package.json`,
      JSON.stringify({ version: "19.2.0" })
    );
    writeFileSync(`${root}/registry.json`, JSON.stringify(tags));
    writeFileSync(
      `${root}/bin/git`,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') console.log('${sha}');
else if (args[0] === 'show') console.log('123');
else if (!['fetch', 'merge-base'].includes(args[0])) process.exit(2);
`
    );
    writeFileSync(
      `${root}/bin/npm`,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const tags = JSON.parse(fs.readFileSync('registry.json', 'utf8'));
if (process.env.CANARY_TEST_FAULT === 'registry') process.exit(1);
if (args[0] === 'view' && args[2] === 'dist-tags') console.log(JSON.stringify(tags[args[1]]));
else if (args[0] === 'view' && args[2] === 'version') {
  if (process.env.CANARY_TEST_FAULT === 'missing' && args[1].startsWith('@lobu/core@')) process.exit(1);
  console.log(args[1].slice(args[1].lastIndexOf('@') + 1));
} else if (args[0] === 'dist-tag' && args[1] === 'add') {
  const at = args[2].lastIndexOf('@');
  tags[args[2].slice(0, at)][args[3]] = args[2].slice(at + 1);
  fs.writeFileSync('registry.json', JSON.stringify(tags));
} else process.exit(2);
`
    );
    for (const bin of ["git", "npm"]) chmodSync(`${root}/bin/${bin}`, 0o755);
    test(
      root,
      (op, value, fault) =>
        spawnSync(
          "node",
          ["scripts/canary-publish.mjs", op, ...(value ? [value] : [])],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${root}/bin:${process.env.PATH}`,
              CANARY_TEST_FAULT: fault ?? "",
            },
          }
        ),
      () => JSON.parse(readFileSync(`${root}/registry.json`, "utf8"))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
