import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
  assertNoNewerStable,
  COMMAND_NAMES,
  compareVersions,
  releaseNeeded,
  peelTag,
  releaseNotesFor,
  releaseTagForVersion,
  selectLatestRequiredJobs,
  selectUniqueLatestRun,
  verifyImmutableRelease,
} from "../release-provenance.mjs";

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> };

const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = `${root}/.github/workflows`;
const names = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
const read = (name: string) => readFileSync(`${dir}/${name}`, "utf8");
const parse = (name: string) => Bun.YAML.parse(read(name)) as Workflow;
const job = (file: string, id: string) => {
  const found = parse(file).jobs?.[id];
  if (!found) throw new Error(`${file} has no job ${id}`);
  return found;
};
const steps = (file: string, id: string) => job(file, id).steps ?? [];
const stepAt = (file: string, id: string, needle: string) => {
  const index = steps(file, id).findIndex((step) =>
    `${step.name ?? ""} ${step.uses ?? ""}`.includes(needle)
  );
  if (index < 0)
    throw new Error(`${file}/${id} has no step matching ${needle}`);
  return index;
};
/** Every shell body in a job, concatenated — what the runner will execute. */
const shell = (file: string, id: string) =>
  steps(file, id)
    .map((step) => step.run ?? "")
    .join("\n");
const envOf = (file: string, id: string) =>
  steps(file, id).flatMap((step) => Object.keys(step.env ?? {}));

const REQUIRED_IMAGE_JOBS = [
  "generate-tag",
  "connector-parity-smoke",
  "build-worker",
  "build-embeddings-service",
  "build-app",
  "app-image-smoke",
  "promote-images",
];

/** Run the helper the way the workflows do — over stdin, as a subprocess. */
const cli = (command: string, input: unknown) => {
  const result = Bun.spawnSync({
    cmd: ["node", "scripts/release-provenance.mjs", command],
    cwd: root,
    stdin: Buffer.from(JSON.stringify(input)),
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString(),
  };
};

describe("every workflow file is well formed", () => {
  // A `run:` indented one level too far lands inside the step's own `env:`
  // map. The step then has neither `run` nor `uses`, GitHub rejects the whole
  // file when it parses it, and no amount of string matching notices — which
  // is exactly how an unrunnable publish workflow passed 21 green checks.
  const stepKeys = new Set([
    "run",
    "uses",
    "with",
    "if",
    "name",
    "env",
    "id",
    "shell",
    "working-directory",
    "continue-on-error",
    "timeout-minutes",
  ]);

  it.each(names)("%s parses and every step is executable", (file) => {
    for (const [id, definition] of Object.entries(parse(file).jobs ?? {})) {
      for (const [index, step] of (definition.steps ?? []).entries()) {
        const where = `${file} ${id} step[${index}] ${step.name ?? ""}`;
        expect(
          step.run !== undefined || step.uses !== undefined,
          `${where} has neither run nor uses`
        ).toBe(true);
        for (const key of Object.keys(step.env ?? {})) {
          expect(stepKeys.has(key), `${where} put "${key}" in env`).toBe(false);
        }
      }
    }
  });

  it("only invokes helper subcommands that exist", () => {
    const invoked = names.flatMap((file) =>
      Array.from(
        read(file).matchAll(/release-provenance\.mjs ([a-z-]+)/g),
        (match) => match[1]
      )
    );
    expect(invoked.length).toBeGreaterThan(0);
    for (const command of invoked) expect(COMMAND_NAMES).toContain(command);
  });

  it("keeps the attestation policy out of inline jq and inline node", () => {
    // These rules were copy-pasted jq in two workflows apiece. jq embedded in
    // YAML is unreachable from this suite, so it must not come back.
    for (const file of ["release-please.yml", "publish-packages.yml"]) {
      expect(read(file)).not.toContain("duplicate latest-attempt required job");
      expect(read(file)).not.toContain("map(.run_attempt // 1) | max");
      expect(read(file)).not.toContain("--input-type=module");
    }
  });

  it("peels release tags in exactly one place", () => {
    // Fetching the tag ref, peeling an annotated tag and handing all three
    // documents to the helper was pasted into three workflows. One composite
    // action owns it now, so the copies cannot drift as the inline jq did.
    const callers = names.filter((file) =>
      read(file).includes("./.github/actions/verify-release")
    );
    expect(callers.sort()).toEqual([
      "build-images.yml",
      "publish-packages.yml",
      "release-please.yml",
    ]);
    for (const file of names) {
      expect(read(file)).not.toContain("git/tags/");
    }
    const action = Bun.YAML.parse(
      readFileSync(`${root}/.github/actions/verify-release/action.yml`, "utf8")
    ) as { inputs: Record<string, unknown>; outputs: Record<string, unknown> };
    expect(Object.keys(action.inputs).sort()).toEqual([
      "expected-sha",
      "tag",
      "token",
    ]);
    expect(Object.keys(action.outputs).sort()).toEqual(["sha", "version"]);
  });
});

describe("release-please only acts on a green main push", () => {
  it("screens the producer's conclusion and its event", () => {
    const trigger = parse("release-please.yml").on?.workflow_run as Record<
      string,
      unknown
    >;
    expect(trigger.workflows).toEqual(["Build and Push Images"]);
    expect(trigger.branches).toEqual(["main"]);
    // `branches: [main]` admits a manual Build Images dispatch just as
    // readily as a push, and `types: [completed]` includes failures. Both
    // would start the job only to hard-fail the API checks below.
    const guard = job("release-please.yml", "attest").if ?? "";
    expect(guard).toContain("conclusion == 'success'");
    expect(guard).toContain("event == 'push'");
  });

  it("proves the producer before checking out repository code", () => {
    expect(
      stepAt("release-please.yml", "attest", "Build Images run")
    ).toBeLessThan(stepAt("release-please.yml", "attest", "actions/checkout"));
    const checkout = steps("release-please.yml", "attest").find((step) =>
      step.uses?.includes("actions/checkout")
    );
    // Pinned, so the helper cannot come from a ref that moved mid-run.
    expect(checkout?.with?.ref).toBe("${{ steps.producer.outputs.sha }}");
    expect(envOf("release-please.yml", "attest")).not.toContain("NPM_TOKEN");
    expect(job("release-please.yml", "attest").permissions).toBeUndefined();
  });

  it("delegates job and run selection to the tested helper", () => {
    const body = shell("release-please.yml", "attest");
    expect(body).toContain("release-provenance.mjs attest-jobs");
    expect(body).toContain("release-provenance.mjs select-run");
    expect(body).toContain("--paginate --slurp");
    expect(body).toContain("filter=all");
    for (const name of REQUIRED_IMAGE_JOBS) {
      expect(read("release-please.yml")).toContain(name);
    }
    // The bounded wait must re-check, every iteration, that the commit it is
    // waiting on is still on main.
    expect(body).toContain("attested SHA left main while waiting for exact CI");
  });

  // A release commit's own image build routinely finishes after later commits
  // have landed. Requiring the attested SHA to *be* the main tip threw that
  // run away, so the release never got cut -- silently, with every run green.
  // Merged is merged: the predicate is reachability from main, spelled the
  // same way publish-packages.yml already spells it.
  it("attests any commit reachable from main, not only the current tip", () => {
    const bodies = {
      attest: shell("release-please.yml", "attest"),
      write: shell("release-please.yml", "release-please-write"),
    };
    for (const [id, body] of Object.entries(bodies)) {
      // `compare/<commit>...<main>` is `identical` at the tip and `ahead`
      // once main has moved on; anything else means the commit left main.
      expect(body, id).toContain("...${current_sha}");
      expect(body, id).toContain('[ "$compare_status" = ahead ]');
      expect(body, id).toContain('[ "$compare_status" = identical ]');
      // The equality tests that stranded 18.0.0 must not come back. Guard the
      // shape rather than one error string, so a reworded copy still fails.
      expect(body, id).not.toMatch(/"\$current_sha" = "\$(sha|ATTESTED_SHA)"/);
    }
    // Class guard: both stranding bugs read main's tip into `current_sha` and
    // put it on the left of an equality. Nothing may do that again. The one
    // legitimate tip comparison left is the workflow_dispatch ref guard, whose
    // subject is GITHUB_SHA -- the ref being dispatched, not a commit being
    // attested -- and which reads `[ "$GITHUB_SHA" = "$current_sha" ]`.
    for (const [id, body] of Object.entries(bodies)) {
      expect(body, id).not.toMatch(/"\$current_sha" = /);
    }
  });
});

describe("the release is created bound to the attested commit", () => {
  const id = "release-please-write";
  const body = () => shell("release-please.yml", id);

  it("holds the write permissions without a global evicting queue", () => {
    expect(job("release-please.yml", id).permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(read("release-please.yml")).not.toContain("concurrency:");
    // main advancing after attestation is expected, not a fault: the release
    // is bound to ATTESTED_SHA. Only losing reachability is a fault.
    expect(body()).toContain("attested SHA is no longer reachable from main");
  });

  it("lets release-please open the PR and creates the release itself", () => {
    const action = steps("release-please.yml", id).find((step) =>
      step.uses?.includes("release-please-action")
    );
    expect(action?.with?.["skip-github-release"]).toBe(true);
    expect(action?.with?.["target-branch"]).toBe("main");
    // skip-github-release keeps release_created permanently false, and the
    // release step re-verifies the binding by peeling the tag, so a
    // release_created guard would be dead and redundant at once.
    expect(read("release-please.yml")).not.toContain("release_created");
    expect(body()).toContain("release-provenance.mjs release-needed");
    expect(body()).toContain("release-provenance.mjs assert-newer");
    // Both release-list filters must drop drafts, not just prereleases. The
    // list endpoint returns drafts to a write-scoped token, and a draft
    // lobu-v<version> counted as released would make the decision step skip
    // creation AND the verify step, replacing a loud "release is a draft"
    // failure with silence.
    const draftFilters = read("release-please.yml").match(
      /select\(\(\.draft or \.prerelease\) \| not\)/g
    );
    expect(draftFilters).toHaveLength(2);
    expect(read("release-please.yml")).not.toContain(
      "select(.prerelease | not)"
    );
    // make_latest is a string enum in the REST API; a boolean is dropped.
    expect(body()).toContain('make_latest: "true"');
  });

  it("posts this version's changelog entry, not the head of the file", () => {
    // CHANGELOG.md is ~475KB and newest-first, so a plain truncation puts
    // several past releases into every release body.
    expect(body()).toContain("release-provenance.mjs release-notes");
    const changelog = readFileSync(`${root}/CHANGELOG.md`, "utf8");
    const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)];
    expect(headings.length).toBeGreaterThan(1);
    const [current, previous] = headings.map((match) => match[1]);
    const extracted = releaseNotesFor({ changelog, version: current });
    expect(extracted.found).toBe(true);
    expect(extracted.notes).not.toContain(`[${previous}]`);
    expect(extracted.notes.length).toBeLessThan(changelog.length);
    // A version with no entry still has to produce a release.
    expect(releaseNotesFor({ changelog, version: "99.0.0" })).toMatchObject({
      found: false,
      notes: "",
    });
  });

  it("verifies once, after a creation that tolerates an existing release", () => {
    const ids = (steps("release-please.yml", id).map((step) => step.name) ??
      []) as string[];
    expect(ids).toContain(
      "Create the tag and release if they are not already there"
    );
    expect(ids).toContain("Verify the release binds to the attested commit");
    // One verification covering both the already-exists and just-created
    // paths, rather than two call sites that can drift apart.
    expect(
      steps("release-please.yml", id).filter((step) =>
        step.uses?.includes("verify-release")
      )
    ).toHaveLength(1);
    expect(body()).not.toContain("verify_release()");
  });

  it("does not let a 404 body or a large changelog fail the release", () => {
    // `gh api` prints the 404 body on STDOUT, so `|| true` left
    // {"message":"Not Found"} in the variable and the already-exists branch
    // ran on the first release of every version. Branch on exit status.
    expect(body()).not.toContain("2>/dev/null || true");
    // CHANGELOG.md is ~475KB: `git show … | head -c` exits 141 under pipefail
    // and kills the step before it creates anything.
    expect(body()).not.toContain("head -c");
    expect(body()).toContain("notes=${notes:0:60000}");
    // A repo with no CHANGELOG.md must still get a release. The redirect is
    // tolerated and leaves an empty file behind for --rawfile to read, which
    // replaced the old `|| echo ""` when the changelog stopped going through
    // argv (see the --rawfile guard below).
    expect(body()).toMatch(
      /git show "\$ATTESTED_SHA:CHANGELOG\.md" > "\$changelog_file" \|\| : > "\$changelog_file"/
    );
  });
});

describe("image builds refuse an off-main manual dispatch", () => {
  it("guards before any checkout and gates every build behind it", () => {
    const guard = job("build-images.yml", "current-main-guard");
    expect(guard.steps?.some((step) => step.uses?.includes("checkout"))).toBe(
      false
    );
    expect(job("build-images.yml", "generate-tag").needs).toContain(
      "current-main-guard"
    );
    expect(shell("build-images.yml", "current-main-guard")).toContain(
      "git/ref/heads/main"
    );
    expect(read("build-images.yml")).toContain(
      "github.event_name == 'workflow_dispatch' && '-manual'"
    );
  });

  it("verifies a release binds to this commit through the shared action", () => {
    const verify = steps("build-images.yml", "generate-tag").find((step) =>
      step.uses?.includes("verify-release")
    );
    expect(verify?.with?.["expected-sha"]).toBe("${{ github.sha }}");
    expect(verify?.if).toContain("github.event_name == 'release'");
    // Another component's release shares this event feed, and
    // derive-image-tags returns should_publish=false for it rather than
    // failing. Verifying first would throw before that skip is reached.
    expect(verify?.if).toContain(
      "startsWith(github.event.release.tag_name, 'lobu-v')"
    );
  });

  it("dispatches publication from main policy with exact inputs", () => {
    const dispatch = shell("build-images.yml", "trigger-package-publish");
    expect(dispatch).toContain("--ref main");
    expect(dispatch).not.toContain('--ref "$RELEASE_TAG"');
    expect(dispatch).toContain('-f release_tag="$RELEASE_TAG"');
    expect(dispatch).toContain('-f image_run_id="$GITHUB_RUN_ID"');
    // `skip` was the only accepted value, so the input was dead surface.
    expect(dispatch).not.toContain("bump");
  });
});

describe("deployment images are published only after the candidate passes", () => {
  const file = "build-images.yml";

  it("builds only candidate tags and exposes immutable digests", () => {
    const workflow = parse(file) as Workflow & { env: Record<string, string> };
    expect(workflow.env.CANDIDATE_TAG).toBe(
      "candidate-${{ github.run_id }}-${{ github.run_attempt }}"
    );
    for (const id of [
      "build-app",
      "build-worker",
      "build-embeddings-service",
    ]) {
      const build = steps(file, id).find((step) =>
        step.uses?.startsWith("docker/build-push-action@")
      );
      const metadata = steps(file, id).find((step) =>
        step.uses?.startsWith("docker/metadata-action@")
      );
      expect(metadata?.with?.tags).toBe(
        "type=raw,value=${{ env.CANDIDATE_TAG }}\n"
      );
      expect(build?.with?.tags).toBe("${{ steps.meta.outputs.tags }}");
      expect(
        (job(file, id) as Job & { outputs: Record<string, string> }).outputs
          .digest
      ).toBe("${{ steps.build.outputs.digest }}");
    }
  });

  it("smokes the app digest and requires success before promotion", () => {
    expect(shell(file, "app-image-smoke")).toContain(
      "${REGISTRY}/${IMAGE_NAME_APP}@${{ needs.build-app.outputs.digest }}"
    );
    expect(job(file, "promote-images").needs).toEqual([
      "generate-tag",
      "build-app",
      "build-worker",
      "build-embeddings-service",
      "app-image-smoke",
    ]);
    expect(job(file, "promote-images").if).not.toMatch(/always\(|!cancelled\(/);
    expect(
      steps(file, "promote-images").find(
        (step) => step.name === "Publish tested digests, app last for Flux"
      )
    ).toMatchObject({
      run: "bash scripts/promote-images.sh",
      env: {
        APP_IMAGE:
          "${{ env.REGISTRY }}/${{ env.IMAGE_NAME_APP }}@${{ needs.build-app.outputs.digest }}",
        WORKER_IMAGE:
          "${{ env.REGISTRY }}/${{ env.IMAGE_NAME_WORKER }}@${{ needs.build-worker.outputs.digest }}",
        EMBEDDINGS_IMAGE:
          "${{ env.REGISTRY }}/${{ env.IMAGE_NAME_EMBEDDINGS }}@${{ needs.build-embeddings-service.outputs.digest }}",
      },
    });
    expect(job(file, "trigger-package-publish").needs).toContain(
      "promote-images"
    );
    expect(job(file, "notify-failure").needs).toContain("promote-images");
  });
});

describe("image promotion command", () => {
  const images = {
    WORKER_IMAGE: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
    EMBEDDINGS_IMAGE: `registry.example.test/embeddings@sha256:${"b".repeat(64)}`,
    APP_IMAGE: `registry.example.test/app@sha256:${"c".repeat(64)}`,
  };
  const deployTag = "20990101-000000-000001";

  function promote(overrides: Record<string, string> = {}) {
    const temp = mkdtempSync(join(tmpdir(), "image-promotion-"));
    const log = join(temp, "docker.jsonl");
    writeFileSync(log, "");
    writeFileSync(
      join(temp, "docker"),
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args.includes(process.env.FAIL_IMAGE)) process.exit(23);
`,
      { mode: 0o755 }
    );
    try {
      const result = spawnSync("bash", ["scripts/promote-images.sh"], {
        cwd: root,
        env: {
          ...process.env,
          ...images,
          DEPLOY_TAG: deployTag,
          SEMVER: "",
          IS_STABLE: "false",
          FAIL_IMAGE: "",
          ...overrides,
          PATH: `${temp}:${process.env.PATH}`,
          DOCKER_LOG: log,
        },
        encoding: "utf8",
      });
      return {
        code: result.status,
        stderr: result.stderr,
        calls: readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]),
      };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  it.each([
    { SEMVER: "", IS_STABLE: "false", tags: [deployTag] },
    {
      SEMVER: "1.2.3-rc.1",
      IS_STABLE: "false",
      tags: [deployTag, "1.2.3-rc.1"],
    },
    {
      SEMVER: "1.2.3",
      IS_STABLE: "true",
      tags: [deployTag, "1.2.3", "latest"],
    },
    {
      SEMVER: "1.2.3-rc.1+build.7",
      IS_STABLE: "false",
      tags: [deployTag, "1.2.3-rc.1-build.7"],
    },
  ])("copies exact digests and promotes app last: %j", ({ tags, ...env }) => {
    const result = promote(env);
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toEqual(
      Object.values(images).map((image) => [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        ...tags.flatMap((tag) => ["--tag", `${image.split("@")[0]}:${tag}`]),
        image,
      ])
    );
  });

  it.each([
    images.WORKER_IMAGE,
    images.EMBEDDINGS_IMAGE,
  ])("never publishes the watched app tag after sibling promotion fails: %s", (FAIL_IMAGE) => {
    const result = promote({ FAIL_IMAGE });
    expect(result.code).toBe(23);
    expect(result.calls.some((args) => args.includes(images.APP_IMAGE))).toBe(
      false
    );
  });

  it.each([
    { APP_IMAGE: "registry.example.test/app:candidate-123-1" },
    { WORKER_IMAGE: "" },
    { EMBEDDINGS_IMAGE: "registry.example.test/embeddings@sha256:" },
    { DEPLOY_TAG: "latest" },
    { IS_STABLE: "unknown" },
    { IS_STABLE: "true", SEMVER: "" },
    { SEMVER: "1.2.3 invalid" },
  ])("rejects invalid inputs before any publication: %j", (env) => {
    const result = promote(env);
    expect(result.code).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
});

describe("publishing requires an attested release", () => {
  it("requires both producer identifiers and forbids a hosted bump", () => {
    const inputs = (
      parse("publish-packages.yml").on?.workflow_dispatch as {
        inputs: Record<string, { required?: boolean }>;
      }
    ).inputs;
    // Canary dispatches leave these empty; the stable job requires both
    // before checkout or any release API calls.
    expect(inputs.release_tag.required).toBe(false);
    expect(inputs.image_run_id.required).toBe(false);
    const gate = steps("publish-packages.yml", "attest-publish")[0].run!;
    for (const [tag, run, status] of [
      ["", "", 1],
      ["lobu-v1.2.3", "", 1],
      ["", "123", 1],
      ["lobu-v1.2.3", "123", 0],
    ] as const) {
      const result = spawnSync("bash", ["-c", gate], {
        env: {
          ...process.env,
          WORKFLOW_REF: "refs/heads/main",
          RELEASE_TAG: tag,
          IMAGE_RUN_ID: run,
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(status);
    }
    // build-images.yml dispatches this workflow with only release_tag and
    // image_run_id, so any input it omits must stay optional or the dispatch
    // is rejected outright and the release never reaches npm.
    const dispatched = shell("build-images.yml", "trigger-package-publish");
    for (const [name, spec] of Object.entries(inputs))
      if (!dispatched.includes(`-f ${name}=`))
        expect(spec.required).toBe(false);
    expect(Object.keys(inputs)).not.toContain("bump");
  });

  it("keeps publish credentials out of the read-only gate", () => {
    expect(
      job("publish-packages.yml", "attest-publish").permissions
    ).toBeUndefined();
    expect(envOf("publish-packages.yml", "attest-publish")).not.toContain(
      "NPM_TOKEN"
    );
    expect(
      job("publish-packages.yml", "publish-packages").permissions
    ).toMatchObject({ "id-token": "write" });
    const checkout = steps("publish-packages.yml", "publish-packages")[0];
    expect(checkout.with?.ref).toBe(
      "${{ needs.attest-publish.outputs.tag_sha }}"
    );
    // A dispatch input reaching a shell through `${{ }}` in a job that holds
    // the production NPM token is credential injection, not a broken script.
    for (const definition of Object.values(
      parse("publish-packages.yml").jobs ?? {}
    )) {
      for (const step of definition.steps ?? []) {
        expect(step.run ?? "").not.toContain("${{ inputs.");
      }
    }
  });

  it("does not fail the publish because main moved after dispatch", () => {
    // The ref pin is the security property: a dispatch resolves
    // refs/heads/main to a tip nobody can forge. Also requiring that tip to
    // still be HEAD adds none, and strands a release off npm whenever
    // anything merges between dispatch and this job starting — the failure
    // this workflow exists to prevent. The release is bound by its tag.
    const guard = steps("publish-packages.yml", "attest-publish")[0];
    expect(guard.run).toContain('"$WORKFLOW_REF" = refs/heads/main');
    expect(guard.run).not.toContain("git/ref/heads/main");
    expect(guard.env).not.toHaveProperty("GH_TOKEN");
    expect(
      stepAt("publish-packages.yml", "attest-publish", "policy")
    ).toBeLessThan(
      stepAt("publish-packages.yml", "attest-publish", "actions/checkout")
    );
  });

  it("accepts the producer run that is still dispatching it", () => {
    // trigger-package-publish lives *inside* the Build Images run and passes
    // its own $GITHUB_RUN_ID, so that run is necessarily in_progress while
    // this gate reads it. A run-level "completed" assertion can therefore
    // never be satisfied, and strands the release off npm.
    const dispatch = shell("build-images.yml", "trigger-package-publish");
    expect(dispatch).toContain('-f image_run_id="$GITHUB_RUN_ID"');
    const gate = shell("publish-packages.yml", "attest-publish");
    expect(gate).not.toContain("Build Images release run is not completed");
    expect(gate).not.toMatch(/'\.status'\s*<<<"\$build_run"/);
    expect(gate).not.toMatch(/'\.conclusion'\s*<<<"\$build_run"/);
    // Identity still has to hold, and per-job attestation is the evidence.
    expect(gate).toContain("head_sha");
    expect(gate).toContain("release-provenance.mjs attest-jobs");
    // The dispatching job must not be one of the jobs it has to wait for.
    const required = read("publish-packages.yml").match(
      /REQUIRED_IMAGE_JOBS: (.+)/
    )?.[1];
    expect(required?.split(" ")).not.toContain("trigger-package-publish");
    expect(required?.split(" ").sort()).toEqual(
      [...REQUIRED_IMAGE_JOBS].sort()
    );
  });

  it("treats an unreadable registry as unknown, not as empty", () => {
    // `npm view --json` prints its error object to STDOUT, so `|| echo '[]'`
    // emitted two JSON values and the version gate could not run at all.
    const body = shell("publish-packages.yml", "publish-packages");
    expect(body).not.toContain("--json 2>/dev/null || echo");
    expect(body).toContain("could not read published @lobu/cli versions");
    expect(body).toContain("release-provenance.mjs assert-newer");
  });
});

describe("the helper CLI the workflows invoke", () => {
  const required = ["generate-tag", "app-image-smoke"];
  const page = (conclusion: string, attempt = 1) => ({
    pages: [
      {
        jobs: [
          {
            name: "generate-tag",
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
          },
          {
            name: "app-image-smoke",
            status: "completed",
            conclusion,
            run_attempt: attempt,
          },
        ],
      },
    ],
    required,
  });

  it("exits zero on a green producer, preferring the newest attempt", () => {
    const green = page("success", 2);
    green.pages[0].jobs.push({
      name: "app-image-smoke",
      status: "completed",
      conclusion: "failure",
      run_attempt: 1,
    });
    const ok = cli("attest-jobs", green);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ ok: true, required: 2 });
  });

  it.each([
    "failure",
    "skipped",
    "cancelled",
  ])("exits non-zero when a required job is %s", (conclusion) => {
    const red = cli("attest-jobs", page(conclusion));
    expect(red.code).not.toBe(0);
    expect(red.stderr).toContain("not completed-success");
  });

  it("exits non-zero on an unknown subcommand rather than passing", () => {
    const unknown = cli("attest-everything", {});
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown command");
  });

  it("round-trips each subcommand's shape over stdin", () => {
    expect(
      JSON.parse(cli("release-tag", { version: "17.4.0" }).stdout)
    ).toEqual({ tag: "lobu-v17.4.0" });
    expect(
      JSON.parse(
        cli("release-needed", { current: "17.4.0", versions: ["17.3.0"] })
          .stdout
      )
    ).toEqual({ needed: true, version: "17.4.0" });
    expect(
      JSON.parse(
        cli("select-run", {
          runs: [
            { id: 1, head_sha: "a", run_attempt: 1 },
            { id: 9, head_sha: "a", run_attempt: 3 },
          ],
          expected: { head_sha: "a" },
        }).stdout
      )
    ).toEqual({ id: "9" });
    expect(
      cli("assert-newer", { current: "17.3.0", versions: ["17.4.0"] }).code
    ).not.toBe(0);
  });
});

describe("the attestation policy itself", () => {
  it("flattens paginated jobs and selects exactly the latest attempt", () => {
    const pages = [
      {
        jobs: [
          {
            name: "generate-tag",
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      {
        jobs: [
          {
            name: "build-worker",
            run_attempt: 2,
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ];
    expect(
      selectLatestRequiredJobs(pages, ["generate-tag", "build-worker"]).map(
        (found) => found.run_attempt
      )
    ).toEqual([1, 2]);
    // Two rows at the same attempt is ambiguous evidence, not a tie to break.
    expect(() =>
      selectLatestRequiredJobs(
        [
          {
            jobs: [
              { name: "generate-tag", run_attempt: 2 },
              { name: "generate-tag", run_attempt: 2 },
            ],
          },
        ],
        ["generate-tag"]
      )
    ).toThrow("duplicate latest-attempt");
    expect(() => selectLatestRequiredJobs(pages, ["absent"])).toThrow(
      "missing required job"
    );
    expect(() => selectLatestRequiredJobs(pages, [])).toThrow(
      "no required job names"
    );
  });

  it("rejects ambiguous and missing CI runs", () => {
    const expected = { head_sha: "a", conclusion: "success" };
    expect(
      selectUniqueLatestRun([{ ...expected, id: 1, run_attempt: 1 }], expected)
        .id
    ).toBe(1);
    expect(() =>
      selectUniqueLatestRun(
        [
          { ...expected, id: 1, run_attempt: 2 },
          { ...expected, id: 2, run_attempt: 2 },
        ],
        expected
      )
    ).toThrow("ambiguous");
    expect(() => selectUniqueLatestRun([], expected)).toThrow("no matching");
  });

  it("cuts a release only for a version that is not released yet", () => {
    expect(releaseNeeded({ current: "17.3.0", versions: ["17.2.0"] })).toEqual({
      needed: true,
      version: "17.3.0",
    });
    expect(
      releaseNeeded({ current: "17.2.0", versions: ["17.2.0", "17.1.0"] })
    ).toEqual({ needed: false, version: "17.2.0" });
    expect(() =>
      releaseNeeded({ current: "17.1.0", versions: ["17.2.0"] })
    ).toThrow("newer stable version");
    // The regression that stranded 18.0.0: the bump commit is no longer main's
    // tip, so nothing about the attested commit says "this is the release".
    // Only the release list can answer it, and it still says yes.
    expect(
      releaseNeeded({ current: "18.0.0", versions: ["17.2.0", "17.1.0"] })
    ).toEqual({ needed: true, version: "18.0.0" });
    // A prerelease entry must not be mistaken for the stable release.
    expect(
      releaseNeeded({ current: "18.0.0", versions: ["18.0.0-rc.1", "17.2.0"] })
    ).toEqual({ needed: true, version: "18.0.0" });
    expect(compareVersions("17.10.0", "17.9.0")).toBe(1);
    expect(releaseTagForVersion("17.3.0")).toBe("lobu-v17.3.0");
    expect(() =>
      assertNoNewerStable({ current: "17.3.0", versions: ["17.4.0"] })
    ).toThrow("newer stable version");
    // A prerelease string is not a stable version and must not veto a release.
    expect(
      assertNoNewerStable({
        current: "17.3.0",
        versions: ["17.9.0-beta.1", "17.2.0"],
      })
    ).toMatchObject({ ok: true, compared: 1 });
    // An `npm view --json` error object must not read as "nothing published".
    expect(() =>
      assertNoNewerStable({
        current: "17.3.0",
        versions: [{ error: { code: "E404" } }],
      })
    ).toThrow("non-version");
  });

  it("peels an annotated tag instead of trusting the ref's own sha", () => {
    const commit = "a".repeat(40);
    expect(
      peelTag({ tagRef: { object: { type: "commit", sha: commit } } })
    ).toBe(commit);
    expect(
      peelTag({
        tagRef: { object: { type: "tag", sha: "c".repeat(40) } },
        tagObject: { object: { sha: commit } },
      })
    ).toBe(commit);
    expect(() =>
      peelTag({ tagRef: { object: { type: "tag", sha: "c".repeat(40) } } })
    ).toThrow("could not peel");
  });

  it("binds a stable release to the commit its tag peels to", () => {
    const sha = "a".repeat(40);
    const stable = {
      release: {
        tag_name: "lobu-v17.3.0",
        draft: false,
        prerelease: false,
        target_commitish: sha,
      },
      tagRef: { object: { type: "commit", sha } },
      expectedTag: "lobu-v17.3.0",
      expectedSha: sha,
    };
    expect(verifyImmutableRelease(stable)).toEqual({ sha, version: "17.3.0" });
    for (const [patch, message] of [
      [{ expectedSha: "b".repeat(40) }, "attested commit"],
      [{ expectedTag: "lobu-v17.4.0" }, "tag/name mismatch"],
      [{ release: { ...stable.release, draft: true } }, "draft"],
      [{ release: { ...stable.release, prerelease: true } }, "prerelease"],
      [
        {
          tagRef: { object: { type: "tag", sha: "c".repeat(40) } },
          tagObject: { object: { sha: "d".repeat(40) } },
        },
        "attested commit",
      ],
    ] as const) {
      expect(() => verifyImmutableRelease({ ...stable, ...patch })).toThrow(
        message
      );
    }
    // GitHub records a branch name when a release is cut from a branch and
    // ignores target_commitish once the tag exists, so only a SHA there
    // carries a binding — and a SHA that disagrees is a real mismatch.
    expect(
      verifyImmutableRelease({
        ...stable,
        release: { ...stable.release, target_commitish: "main" },
      })
    ).toMatchObject({ sha });
    expect(() =>
      verifyImmutableRelease({
        ...stable,
        release: { ...stable.release, target_commitish: "b".repeat(40) },
      })
    ).toThrow("does not match peeled tag");
  });
});

// A paginated payload handed to jq via --argjson dies with "jq: Argument list
// too long" once it outgrows the runner's per-argument cap (Linux
// MAX_ARG_STRLEN is 128KB; the release list was already 808KB at 106
// releases). macOS has no equivalent per-arg cap, so this only ever fails in
// CI. It is asserted across every workflow rather than the one file that broke:
// the first fix missed publish-packages.yml, whose jobs read is 20KB today but
// grows with each rerun attempt because filter=all returns all of them.
describe("paginated API payloads are piped into jq, never passed as arguments", () => {
  const paginated = names.filter((name) =>
    read(name).includes("gh api --paginate")
  );

  it("still guards the two workflows known to read paginated APIs", () => {
    expect(paginated).toEqual(
      expect.arrayContaining(["publish-packages.yml", "release-please.yml"])
    );
  });

  it.each(
    paginated
  )("%s pipes every slurped payload straight into jq", (name) => {
    const yml = read(name);
    expect(yml).not.toContain("--argjson pages");
    const slurped = yml.match(/gh api --paginate --slurp /g) ?? [];
    const piped =
      yml.match(/gh api --paginate --slurp [^\n]*\\\n\s*\| jq /g) ?? [];
    expect(piped).toHaveLength(slurped.length);
  });
});

// release-please marks its own merged release PR `autorelease: tagged` from
// inside the release step, which this workflow skips so the release can bind
// to the attested commit. The replacement step below is therefore the ONLY
// thing that clears the label, and release-please aborts opening the next
// release PR while a merged one still reads pending -- while still reporting
// the job green. Deleting the step re-freezes the whole npm train with no red
// anywhere, which is how lobu-v18.0.0 went unnoticed for three days.
describe("a cut release clears the pending label off the PR that produced it", () => {
  const jobId = "release-please-write";
  const stepName = "Clear the pending label from released PRs";
  const step = () => {
    const found = steps("release-please.yml", jobId).find(
      (candidate) => candidate.name === stepName
    );
    if (!found)
      throw new Error(`release-please.yml/${jobId} lost "${stepName}"`);
    return found;
  };

  it("still has the step, after the release is verified", () => {
    expect(step().run ?? "").not.toEqual("");
    expect(
      stepAt("release-please.yml", jobId, "Verify the release")
    ).toBeLessThan(stepAt("release-please.yml", jobId, stepName));
  });

  it("only runs when this workflow actually cut a release", () => {
    // Without the gate an ordinary main push clears the label off a release PR
    // whose release has not been created yet, and that release is then never
    // cut at all.
    expect(step().if).toBe("steps.bump.outputs.bumped == 'true'");
  });

  it("excludes closed-unmerged PRs before it compares anything", () => {
    // A closed-unmerged PR still reports a `refs/pull/N/merge` test-merge sha,
    // so an emptiness check does not filter it. GitHub collects those commits,
    // and `compare` against a collected one 404s -- under `set -e` that fails
    // the job after the release already exists.
    const body = step().run ?? "";
    const filter = body.indexOf("select(.pull_request.merged_at)");
    expect(filter).toBeGreaterThan(-1);
    expect(filter).toBeLessThan(body.indexOf("/compare/"));
  });

  it("tolerates a losing DELETE but never a failing POST", () => {
    // Two main pushes can both reach this step for one release, and the second
    // finds the label already gone. Tolerating the POST as well would swallow a
    // token-permission fault and silently leave the label in place.
    const body = step().run ?? "";
    const post = body.slice(
      body.indexOf("--method POST"),
      body.indexOf("--method DELETE")
    );
    const del = body.slice(body.indexOf("--method DELETE"));
    expect(post).toContain(">/dev/null");
    expect(post).not.toContain("|| true");
    expect(del).toContain("|| true");
  });
});

// `jq --arg` puts the whole value in ONE argv entry, and Linux caps a single
// entry at MAX_ARG_STRLEN (128KB). CHANGELOG.md is ~490KB, so the release body
// could never be built that way: the step died with "jq: Argument list too
// long" and no release was created. It hid for weeks because the step exits
// early when the release already exists, so the line first ran for real at
// 19.0.0 -- and froze that release. macOS has no per-argument cap, so it is
// unreproducible on a developer machine and only a guard keeps it out.
describe("unbounded payloads reach jq by pipe or --rawfile, never through argv", () => {
  // Linux caps a SINGLE argv entry at MAX_ARG_STRLEN (128KB), so any value
  // whose size is set by repository history or an API page count dies with
  // "jq: Argument list too long" once it outgrows the cap. macOS has no
  // per-argument cap, so none of these can be reproduced on a dev machine --
  // the guard is the only thing that keeps the class out. Two have already
  // bitten: the 490KB CHANGELOG froze the 19.0.0 release outright, and the
  // paginated jobs read was fixed pre-emptively.

  /** `name=$( … )` capture of a read whose size the repository decides. */
  const SLURPED = /(\w+)=\$\(\s*(?:gh api|git show|git log)[^)]*/g;
  /** Anything that collapses the payload to a scalar before it is captured. */
  const REDUCED = /--jq|\| *jq |node -pe?\b|--template/;

  it.each(
    names
  )("%s pipes unbounded reads instead of slurping them", (name) => {
    const body = read(name);
    const whole = [...body.matchAll(SLURPED)]
      .filter((match) => !REDUCED.test(match[0]))
      .map((match) => match[1]);
    // A whole payload only becomes a bug once it is handed to jq as an
    // argument; `<<<` here-strings and `--rawfile` both stay clear of argv.
    const throughArgv = whole.filter((variable) =>
      new RegExp(
        `--argjson\\s+\\w+\\s+"\\$${variable}"|--arg\\s+\\w+\\s+"\\$${variable}"`
      ).test(body)
    );
    expect({ file: name, throughArgv }).toEqual({
      file: name,
      throughArgv: [],
    });
  });

  it("release-please builds the release body from a file", () => {
    const body = shell("release-please.yml", "release-please-write");
    expect(body).toMatch(/--rawfile\s+changelog\s/);
    // The command substitution is the tell: slurping a file into a shell
    // variable is what forces it through argv on the next line.
    expect(body).not.toMatch(/changelog=\$\(\s*git show/);
  });

  it("publish attestation streams the CI run list into jq", () => {
    const body = shell("publish-packages.yml", "attest-publish");
    expect(body).toMatch(/ci\.yml\/runs[^\n]*\n\s*\| jq /);
    expect(body).not.toMatch(/--argjson\s+body\s+"\$ci_runs"/);
  });
});
