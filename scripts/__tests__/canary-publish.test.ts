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
  publicationAllowed,
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
    expect(__testing.publishArgs(undefined, "canary", version)).toContain(
      "canary"
    );
    expect(() => __testing.publishArgs(undefined, "latest", version)).toThrow();
    expect(() =>
      __testing.publishArgs(undefined, "canary-candidate", version)
    ).toThrow();
    expect(__testing.publishArgs(undefined, "latest", "19.2.0")).toContain(
      "latest"
    );
  });

  it("only publishes first, same, or descendant commits", () => {
    expect(
      publicationAllowed(undefined, version, () => {
        throw new Error("unexpected");
      })
    ).toBe(true);
    expect(publicationAllowed(version, version, () => false)).toBe(true);
    const old = `19.2.0-canary.122.g${"b".repeat(40)}`;
    expect(
      publicationAllowed(
        old,
        version,
        (from, to) => from === "b".repeat(40) && to === sha
      )
    ).toBe(true);
    expect(publicationAllowed(old, version, () => false)).toBe(false);
    expect(() => publicationAllowed("19.2.0", version, () => true)).toThrow();
  });

  it("requires a main-only caller, OIDC and packed artifact smoke before publishing", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(
        new URL("../../.github/workflows/publish-canary.yml", import.meta.url),
        "utf8"
      )
    ) as any;
    expect(Object.keys(workflow.on)).toEqual(["workflow_call"]);
    expect(workflow.jobs.promote).toBeUndefined();
    expect(workflow.jobs.publish.permissions["id-token"]).toBe("write");
    const steps = workflow.jobs.publish.steps;
    const publishIndex = steps.findIndex((step: any) =>
      step.run?.includes("--tag=canary")
    );
    const packIndex = steps.findIndex((step: any) =>
      step.run?.includes("pack-cli-smoke.mjs")
    );
    expect(packIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(packIndex);
    expect(JSON.stringify(workflow)).not.toContain("NPM_TOKEN");
    expect(JSON.stringify(workflow)).not.toContain("NODE_AUTH_TOKEN");
    expect(JSON.stringify(workflow)).not.toContain("canary-candidate");
    expect(workflow.jobs.smoke.uses).toBe(
      "./.github/workflows/published-artifact-smoke.yml"
    );
    expect(workflow.jobs.smoke.with.version).toBe(
      "${{ needs.publish.outputs.version }}"
    );
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
    expect(Object.keys(stable.on)).toEqual(["workflow_dispatch"]);
    expect(stable.on.workflow_dispatch.inputs.channel.default).toBe("stable");
    expect(stable.jobs.canary.if).toBe("inputs.channel == 'canary'");
    expect(stable.jobs.canary.uses).toBe(
      "./.github/workflows/publish-canary.yml"
    );
    expect(stable.jobs.canary.permissions["id-token"]).toBe("write");
    expect(stable.jobs.canary.concurrency).toEqual({
      group: "npm-canary",
      "cancel-in-progress": false,
    });
    expect(stable.jobs["attest-publish"].if).toBe("inputs.channel == 'stable'");
    expect(workflow.env.REQUIRED_IMAGE_JOBS).toBe(
      stable.env.REQUIRED_IMAGE_JOBS
    );
  });
});

// Run the actual command entry points in an isolated filesystem with a fake
// registry. No network or publication credentials are used by these probes.
describe("canary commands", () => {
  it("prepares the full fleet and performs read-only publication preflight", () => {
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
        expect(run("check", version).status).toBe(0);
      for (const tags of Object.values(registry()) as any[]) {
        expect(tags).toEqual({ latest: "19.2.0" });
      }
    });
  });

  it("stops canary publication at the first npm failure and keeps CLI last", () => {
    expect(__testing.PACKAGES.at(-1)?.dir).toBe("packages/cli");
    withFixture((root, run) => {
      expect(run("prepare").status).toBe(0);
      expect(run("publish", undefined, "blocked").status).not.toBe(0);
      expect(readFileSync(`${root}/publish.log`, "utf8").trim()).toBe(
        "@lobu/core"
      );
    });
  });

  it("retries a partial publish without republishing packages or changing latest", () => {
    withFixture((root, run, registry) => {
      expect(run("prepare").status).toBe(0);
      expect(run("publish", undefined, "partial").status).not.toBe(0);
      expect(registry()["@lobu/core"]).toEqual({
        latest: "19.2.0",
        canary: version,
      });
      expect(registry()["@lobu/cli"]).toEqual({ latest: "19.2.0" });
      const retry = run("publish");
      expect(retry.status, retry.stderr?.toString()).toBe(0);
      for (const tags of Object.values(registry()))
        expect(tags).toEqual({ latest: "19.2.0", canary: version });
      const calls = readFileSync(`${root}/publish.log`, "utf8")
        .trim()
        .split("\n");
      expect(calls.filter((name) => name === "@lobu/core")).toHaveLength(1);
      expect(calls.at(-1)).toBe("@lobu/cli");
    });
  });

  it("rejects an existing canary version whose tag is missing or unreadable", () => {
    for (const fault of ["untagged", "tag-read"]) {
      withFixture((_root, run) => {
        expect(run("prepare").status).toBe(0);
        const result = run("publish", undefined, fault);
        expect(result.status).not.toBe(0);
        expect(result.stderr?.toString()).toContain(
          "canary tag does not match"
        );
      });
    }
  });

  it("fails closed on registry failure or an older candidate", () => {
    for (const fault of ["registry", "older"]) {
      withFixture((_root, run) => {
        expect(run("check", version, fault).status).not.toBe(0);
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
      // The fixture materializes only the published packages, so a
      // `workspace:*` devDependency on a private sibling has nothing to
      // resolve against. Consumers never install devDependencies, so dropping
      // them keeps the probe on the graph publication actually ships.
      delete pkg.devDependencies;
      writeFileSync(`${root}/${dir}/package.json`, JSON.stringify(pkg));
      tags[pkg.name] = { latest: "19.2.0" };
    }
    writeFileSync(
      `${root}/package.json`,
      JSON.stringify({ version: "19.2.0" })
    );
    writeFileSync(`${root}/registry.json`, JSON.stringify(tags));
    writeFileSync(`${root}/published.json`, "{}");
    writeFileSync(
      `${root}/bin/git`,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'merge-base' && process.env.CANARY_TEST_FAULT === 'older' && args[2] !== '${sha}') process.exit(1);
else if (args[0] === 'rev-parse') console.log('${sha}');
else if (args[0] === 'show') console.log('123');
else if (!['fetch', 'merge-base'].includes(args[0])) process.exit(2);
`
    );
    writeFileSync(
      `${root}/bin/npm`,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const tags = JSON.parse(fs.readFileSync('${root}/registry.json', 'utf8'));
const published = JSON.parse(fs.readFileSync('${root}/published.json', 'utf8'));
const fault = process.env.CANARY_TEST_FAULT;
if (fault === 'registry') process.exit(1);
if (args[0] === 'view' && args[2] === 'dist-tags') console.log(JSON.stringify(fault === 'older' ? { canary: '19.2.0-canary.124.g${"b".repeat(40)}' } : tags[args[1]]));
else if (args[0] === 'view' && args[2] === 'version') {
  const at = args[1].lastIndexOf('@');
  const name = args[1].slice(0, at), requested = args[1].slice(at + 1);
  if (published[name] === requested || (['untagged', 'tag-read'].includes(fault) && name === '@lobu/core')) console.log(requested);
  else process.exit(1);
} else if (args[0] === 'view' && args[2] === 'dist-tags.canary') {
  if (fault === 'tag-read') process.exit(1);
  if (tags[args[1]].canary) console.log(tags[args[1]].canary);
}
else if (args[0] === 'publish') {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  fs.appendFileSync('${root}/publish.log', pkg.name + '\\n');
  if (fault === 'blocked' || (fault === 'partial' && pkg.name === '@lobu/client')) { console.error('E404 Not Found - PUT'); process.exit(1); }
  published[pkg.name] = pkg.version;
  tags[pkg.name][args[args.indexOf('--tag') + 1]] = pkg.version;
  fs.writeFileSync('${root}/published.json', JSON.stringify(published));
  fs.writeFileSync('${root}/registry.json', JSON.stringify(tags));
} else process.exit(2);
`
    );
    for (const bin of ["git", "npm"]) chmodSync(`${root}/bin/${bin}`, 0o755);
    test(
      root,
      (op, value, fault) =>
        spawnSync(
          "node",
          op === "publish"
            ? [
                "scripts/publish-packages.mjs",
                "--skip-bump",
                "--skip-build",
                "--tag=canary",
              ]
            : ["scripts/canary-publish.mjs", op, ...(value ? [value] : [])],
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
