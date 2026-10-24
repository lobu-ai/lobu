import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../land.sh", import.meta.url));
interface Scenario {
  protection?: Array<string[] | null>;
  checks?: Record<string, string>;
  requiredChecks?: string[];
  private?: boolean;
  rule?: object | null;
  rulesets?: number;
  graphqlError?: boolean;
  missingRef?: boolean;
  changedHead?: boolean;
  changedLocalAndRemote?: boolean;
  changedBase?: boolean;
  mergePending?: boolean;
  mergeReadError?: boolean;
  branch?: string;
}

function run(
  scenario: Scenario = {},
  options: {
    required?: string;
    merge?: boolean;
    submodule?: string;
    child?: boolean;
    uninitializedChild?: boolean;
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "land-command-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd, encoding: "utf8" }
    );
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const init = (cwd: string, content: string) => {
    mkdirSync(cwd, { recursive: true });
    git(cwd, ["init", "-q", "-b", "main"]);
    git(cwd, ["config", "core.hooksPath", join(root, "empty-hooks")]);
    writeFileSync(join(cwd, "fixture"), content);
    git(cwd, ["add", "--", "fixture"]);
    git(cwd, ["commit", "-qm", "fixture"]);
  };
  try {
    const repo = join(root, "repo");
    init(repo, "parent");
    let target = repo;
    if (options.child) {
      const source = join(root, "child-source");
      init(source, "child");
      git(repo, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        source,
        "packages/frontend",
      ]);
      target = join(repo, "packages/frontend");
      if (options.uninitializedChild) {
        git(repo, ["submodule", "deinit", "-f", "--", "packages/frontend"]);
      }
    }
    const head = git(target, ["rev-parse", "HEAD"]);
    const settings = {
      head,
      protection: [["unit", "review"]],
      checks: { unit: "pass", review: "pass" },
      ...scenario,
    };
    const state = join(root, "state.json");
    writeFileSync(
      state,
      JSON.stringify({ calls: [], views: 0, protection: 0, clock: 0 })
    );
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bun
const fs = require("node:fs");
const s = JSON.parse(process.env.LAND_SCENARIO);
const file = process.env.LAND_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push({ args, cwd: process.cwd() });
function finish(value, code = 0) { fs.writeFileSync(file, JSON.stringify(state)); if (value) console.log(value); process.exit(code); }
if (args[0] === "repo") finish("example/project");
if (args[0] === "api" && args[1] === "graphql") {
  if (s.graphqlError) finish("", 1);
  finish(JSON.stringify({ data: { repository: { isPrivate: s.private !== false, ref: s.missingRef ? null : { branchProtectionRule: s.rule ?? null }, rulesets: { totalCount: s.rulesets ?? 0 } } } }));
}
if (args[0] === "api") {
  const list = s.protection[Math.min(state.protection++, s.protection.length - 1)];
  finish(list === null ? "" : list.join("\\n"), list === null ? 1 : 0);
}
if (args[0] === "pr" && args[1] === "view") {
  const fields = args[args.indexOf("--json") + 1];
  if (fields.includes("headRefOid")) {
    const count = state.views++;
    const sha = count && s.changedHead ? "b".repeat(40) : (state.head ?? s.head);
    const base = count && s.changedBase ? "other" : (s.branch ?? "main");
    finish(fields.includes("baseRefName") ? sha + "\\t" + base : sha);
  }
  if (fields === "mergeCommit") finish(s.mergePending || s.mergeReadError ? "" : "c".repeat(40), s.mergeReadError ? 1 : 0);
  if (fields === "headRefName") finish("feature");
}
if (args[0] === "pr" && args[1] === "checks") {
  if (s.changedLocalAndRemote && !state.head) {
    const { execFileSync } = require("node:child_process");
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "--no-verify", "-qm", "changed"]);
    state.head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  }
  finish(Object.entries(s.checks).filter(([name]) => !args.includes("--required") || (s.requiredChecks ?? ["unit", "review"]).includes(name)).map(([name, bucket]) => name + "\\t" + bucket + "\\thttps://example.invalid/check").join("\\n"));
}
if (args[0] === "pr" && args[1] === "merge") finish("merged");
finish("unexpected mock gh command: " + args.join(" "), 2);
`
    );
    chmodSync(gh, 0o755);
    writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "sleep"), 0o755);
    writeFileSync(
      join(bin, "date"),
      `#!/usr/bin/env bun
const fs = require("node:fs");
const file = process.env.LAND_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(1000 + 120 * state.clock++);
fs.writeFileSync(file, JSON.stringify(state));
`
    );
    chmodSync(join(bin, "date"), 0o755);
    const result = spawnSync("bash", [script], {
      cwd: repo,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        N: "7",
        CHECK_ONLY: options.merge ? "0" : "1",
        TIMEOUT_MIN: "1",
        REQUIRED_CHECKS: options.required ?? "",
        SUBMODULE: options.submodule ?? "",
        LAND_SCENARIO: JSON.stringify(settings),
        LAND_STATE: state,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    const calls = JSON.parse(readFileSync(state, "utf8")).calls as Array<{
      args: string[];
      cwd: string;
    }>;
    return { ...result, calls, head, target: realpathSync(target) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const merged = (r: ReturnType<typeof run>) =>
  r.calls.some((c) => c.args[0] === "pr" && c.args[1] === "merge");

describe("land command policy", () => {
  it("retains normal protected-repository checks", () => {
    expect(run().status).toBe(0);
  });
  it("retains additional checks GitHub marks required through rulesets", () => {
    const r = run(
      {
        checks: { unit: "pass", review: "pass", security: "fail" },
        requiredChecks: ["unit", "review", "security"],
      },
      { required: "unit", merge: true }
    );
    expect(r.status).not.toBe(0);
    expect(merged(r)).toBe(false);
  });
  it("permits explicit checks only after confirming an unprotected private repo", () => {
    const r = run({ protection: [null] }, { required: "unit,review" });
    expect(r.status, r.stderr).toBe(0);
    expect(merged(r)).toBe(false);
  });
  it("also handles an empty protection list with explicit checks", () => {
    expect(run({ protection: [[]] }, { required: "unit,review" }).status).toBe(
      0
    );
  });
  for (const [name, policy] of Object.entries({
    public: { private: false },
    protected: { rule: { id: "synthetic-rule" } },
    inheritedRuleset: { rulesets: 1 },
    missingBranch: { missingRef: true },
    unavailable: { graphqlError: true },
  })) {
    it(`refuses explicit fallback when policy is ${name}`, () => {
      const r = run(
        { protection: [null], ...policy },
        { required: "unit,review", merge: true }
      );
      expect(r.status).not.toBe(0);
      expect(merged(r)).toBe(false);
    });
  }
  it("does not infer requirements when the caller supplied none", () => {
    expect(run({ protection: [null] }).status).not.toBe(0);
  });
  for (const bucket of ["fail", "cancel", "pending", "unknown"]) {
    it(`does not merge a required ${bucket} check`, () => {
      const r = run(
        { protection: [null], checks: { unit: "pass", review: bucket } },
        { required: "unit,review", merge: true }
      );
      expect(r.status).not.toBe(0);
      expect(merged(r)).toBe(false);
    });
  }
  it("refuses a required check which has never reported", () => {
    const r = run(
      { protection: [null], checks: { unit: "pass" } },
      { required: "unit,review", merge: true }
    );
    expect(r.status).not.toBe(0);
    expect(merged(r)).toBe(false);
  });
  it("unions explicit checks with GitHub requirements instead of replacing them", () => {
    expect(
      run({ checks: { unit: "pass" } }, { required: "unit" }).status
    ).not.toBe(0);
    expect(run({}, { required: "security" }).status).not.toBe(0);
  });
  it("refuses newly added protection requirements before merging", () => {
    const r = run(
      { protection: [null, ["security"]] },
      { required: "unit,review", merge: true }
    );
    expect(r.status).not.toBe(0);
    expect(merged(r)).toBe(false);
  });
  for (const change of [
    "changedHead",
    "changedBase",
    "changedLocalAndRemote",
  ] as const) {
    it(`refuses ${change} during the wait`, () => {
      const r = run({ [change]: true }, { merge: true });
      expect(r.status).not.toBe(0);
      expect(merged(r)).toBe(false);
    });
  }
  it("merges normally, locks the exact SHA and never requests admin bypass", () => {
    const r = run(
      { protection: [null] },
      { required: "unit,review", merge: true }
    );
    expect(r.status, r.stderr).toBe(0);
    const args = r.calls.find((c) => c.args[1] === "merge")?.args;
    expect(args).toContain("--match-head-commit");
    expect(args).toContain(r.head);
    expect(args).not.toContain("--admin");
  });
  for (const state of ["mergePending", "mergeReadError"] as const) {
    it(`does not report a completed merge when ${state}`, () => {
      const r = run({ [state]: true }, { merge: true });
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("merged. squash commit:");
      expect(r.stdout).not.toContain("Prod-visible?");
    });
  }
  it("reads the PR target branch rather than assuming main", () => {
    const r = run({ branch: "release/next" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.find((c) => c.args[0] === "api")?.args[1]).toContain(
      "release%2Fnext"
    );
  });
  it("runs the parent helper against a registered submodule", () => {
    const r = run({}, { submodule: "packages/frontend", child: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.every((c) => c.cwd === r.target)).toBe(true);
  });
  it("refuses an arbitrary unregistered submodule path", () => {
    const r = run({}, { submodule: "../other", merge: true });
    expect(r.status).not.toBe(0);
    expect(merged(r)).toBe(false);
  });
  it("refuses an uninitialized submodule before querying the parent repository", () => {
    const r = run(
      {},
      {
        submodule: "packages/frontend",
        child: true,
        uninitializedChild: true,
        merge: true,
      }
    );
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
  it("rejects an incomplete explicit check list", () => {
    expect(
      run({ protection: [null] }, { required: "unit,,review" }).status
    ).not.toBe(0);
  });
});
