import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseWorkflowYaml } from "yaml";

/**
 * CI views build closure (PR #3649 run 35400662185): the server integration
 * jobs build workspace dists from an inline list that drifted from
 * scripts/build-packages.mjs — `packages/views` was missing, so
 * `require.resolve("@lobu/views")` in packages/server/src/views/views.ts
 * settled nowhere and every source-view compile failed in CI with
 * `Could not resolve "@lobu/views"` (23 tests across manage-views,
 * loader, resources, actions and all-tools) while workspace checkouts
 * kept passing on their stale local dist.
 *
 * These pin the closure: every inline "Build packages server depends on"
 * block must compile @lobu/views before the vitest shards run.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CI_YML = join(REPO_ROOT, ".github", "workflows", "ci.yml");

/**
 * F16 structural guard (round 11): the round-10 selection/upload assertions
 * searched the raw YAML text, so a commented-out guest step still matched,
 * a pipeline or `set +e` still contained the command substring, and a
 * harmless explanatory comment tripped the blacklist. The assertions below
 * parse jobs.unit.steps instead: step identity/ordering comes from parsed
 * `name` fields, fail-closed execution from parsed `if`/`continue-on-error`/
 * `shell` fields (never comment spellings), the guest run from normalized
 * non-comment commands compared exactly (never substrings), and the upload
 * from the parsed Codecov `with.files` list (never a text window). The
 * contract is deliberately bounded — two exact commands, not a shell
 * parser — and the fixtures below prove it accepts the working workflow
 * while rejecting each broken variant.
 */

type WorkflowStep = Record<string, unknown>;

const CORE_STEP_NAME = "core / cli (bun:test)";
const GUEST_STEP_NAME = "views guest runtime (bun:test)";
const SCRIPTS_STEP_NAME = "repo scripts (bun:test)";
// Full directory selection: never a per-file subset, so new guest files
// (F10/F14 today, more tomorrow) run without a guard edit.
const GUEST_BUN_COMMAND =
  "bun test packages/views/src --coverage --timeout 30000";
const GUEST_LCOV_RENAME = "mv coverage/lcov.info coverage/views.lcov.info";
const GUEST_COVERAGE_ENTRY = "coverage/views.lcov.info";

function unitSteps(ymlText: string): WorkflowStep[] {
  const doc = parseWorkflowYaml(ymlText) as {
    jobs?: { unit?: { steps?: unknown } };
  };
  const steps = doc?.jobs?.unit?.steps;
  if (!Array.isArray(steps)) {
    throw new Error(
      "ci views guard: jobs.unit.steps is missing or not a step list"
    );
  }
  return steps as WorkflowStep[];
}

function singleNamedStep(
  steps: WorkflowStep[],
  name: string
): { index: number; step: WorkflowStep } {
  const hits = steps
    .map((step, index) => ({ index, step }))
    .filter((hit) => {
      const step: unknown = hit.step;
      return (
        typeof step === "object" &&
        step !== null &&
        (step as WorkflowStep).name === name
      );
    });
  if (hits.length !== 1) {
    throw new Error(
      `ci views guard: expected exactly one "${name}" step in ` +
        `jobs.unit.steps, found ${hits.length}`
    );
  }
  const hit = hits[0];
  if (!hit) {
    throw new Error(`ci views guard: step "${name}" vanished`);
  }
  return hit;
}

// Blank lines and standalone `#` comments carry no commands; anything else
// (including `if` wrappers, `fi`, `set +e`, pipelines) is a command the
// runner would execute, so it must match the known form below.
function executableCommands(run: unknown): string[] {
  if (typeof run !== "string") {
    throw new Error("ci views guard: expected a string run block");
  }
  return run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function assertViewsGuestSelection(ymlText: string): void {
  const steps = unitSteps(ymlText);
  const core = singleNamedStep(steps, CORE_STEP_NAME);
  const guest = singleNamedStep(steps, GUEST_STEP_NAME);
  const scripts = singleNamedStep(steps, SCRIPTS_STEP_NAME);
  if (!(core.index < guest.index && guest.index < scripts.index)) {
    throw new Error(
      "ci views guard: unit step order must be core/cli -> guest -> " +
        "repo scripts"
    );
  }
  const guestStep = guest.step;
  // Fail closed: no opt-in condition, no error swallowing. Presence of the
  // `if` key skips or gates the step regardless of its value, so any
  // occurrence rejects.
  if ("if" in guestStep) {
    throw new Error(
      "ci views guard: guest step must not carry a step-level if condition"
    );
  }
  const continueOnError: unknown = guestStep["continue-on-error"];
  if (continueOnError !== undefined && continueOnError !== false) {
    throw new Error(
      "ci views guard: guest step must not set continue-on-error"
    );
  }
  // The unit job declares no defaults.run shell, so steps inherit the
  // runner default (bash -e, fail closed). `shell: bash` keeps -e
  // -o pipefail; any other override can drop -e.
  const shell: unknown = guestStep.shell;
  if (shell !== undefined && shell !== "bash") {
    throw new Error(
      "ci views guard: guest step must keep the default fail-closed " +
        "shell (unset or bash)"
    );
  }
  // coverage/ paths below are relative to the checkout root.
  if (guestStep["working-directory"] !== undefined) {
    throw new Error(
      "ci views guard: guest step must run in the repo root " +
        "(no working-directory override)"
    );
  }
  const commands = executableCommands(guestStep.run);
  if (
    commands.length !== 2 ||
    commands[0] !== GUEST_BUN_COMMAND ||
    commands[1] !== GUEST_LCOV_RENAME
  ) {
    throw new Error(
      "ci views guard: guest run must be exactly the bun selection " +
        "plus the lcov rename"
    );
  }
  // Separate processes: the core/cli invocation must not absorb views, and
  // the views invocation must not absorb core/cli.
  const coreCommands = executableCommands(core.step.run);
  if (coreCommands.join("\n").includes("packages/views")) {
    throw new Error(
      "ci views guard: core/cli step must not select packages/views"
    );
  }
  const guestText = commands.join("\n");
  if (
    guestText.includes("packages/core") ||
    guestText.includes("packages/cli")
  ) {
    throw new Error(
      "ci views guard: guest step must not select packages/core or " +
        "packages/cli"
    );
  }
}

function codecovFilesEntries(steps: WorkflowStep[]): string[] {
  const entries: string[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) {
      continue;
    }
    const uses = step.uses;
    if (typeof uses !== "string" || !uses.startsWith("codecov/")) {
      continue;
    }
    const withBlock: unknown = step.with;
    if (typeof withBlock !== "object" || withBlock === null) {
      continue;
    }
    const files: unknown = (withBlock as WorkflowStep).files;
    if (typeof files === "string") {
      for (const entry of files.split(/[\s,]+/)) {
        const trimmed = entry.trim();
        if (trimmed.length > 0) {
          entries.push(trimmed);
        }
      }
    } else if (Array.isArray(files)) {
      for (const entry of files) {
        if (typeof entry === "string" && entry.trim().length > 0) {
          entries.push(entry.trim());
        }
      }
    }
  }
  return entries;
}

function assertViewsCoverageUpload(ymlText: string): void {
  const entries = codecovFilesEntries(unitSteps(ymlText));
  if (!entries.includes(GUEST_COVERAGE_ENTRY)) {
    throw new Error(
      "ci views guard: coverage/views.lcov.info is missing from the " +
        `parsed unit Codecov with.files entries (${entries.join(", ") || "none"})`
    );
  }
}

describe("ci views build closure", () => {
  it("builds @lobu/views in every inline server-depends-on block", () => {
    const yml = readFileSync(CI_YML, "utf8");
    const blocks = yml.split("Build packages server depends on");
    // Header + one block per integration job using the inline list.
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks.slice(1)) {
      // The first block carries the long dependency-order comment, so the
      // window must cover the whole inline run list (not just its header).
      const section = block.slice(0, 3500);
      expect(section).toContain("cd packages/views && bun run build");
    }
  });

  it("builds the server bundle before the repo-scripts artifact test", () => {
    // scripts/__tests__/server-views-vendor.test.ts throws "missing build
    // prerequisite packages/server/dist/server.bundle.mjs" unless the bundle
    // exists, but the unit job's graph build uses --skip-applications (PR
    // #3649 run 35402512013: green locally on a stale dist, red in CI on a
    // clean cache). The unit job must therefore build the server bundle
    // between the graph build and `bun test scripts`.
    const yml = readFileSync(CI_YML, "utf8");
    const graphAt = yml.indexOf(
      "node scripts/build-packages.mjs --skip-applications"
    );
    const scriptsAt = yml.indexOf("bun test scripts --coverage");
    expect(graphAt).toBeGreaterThanOrEqual(0);
    expect(scriptsAt).toBeGreaterThan(graphAt);
    const section = yml.slice(graphAt, scriptsAt);
    expect(section).toContain("build:server");
    expect(section).toContain("packages/server/dist/server.bundle.mjs");
  });

  it("executes the views guest suite in its own failing-closed unit step", () => {
    // F15 (round 10): the 29-test packages/views guest suite (F10/F14) was
    // built but never selected by any CI `bun test` invocation. F16
    // (round 11): the same promise checked structurally over
    // jobs.unit.steps — the separate `views guest runtime` step runs
    // immediately after core/cli so the guest DOM globals stay out of the
    // core/CLI process, with fail-closed execution.
    assertViewsGuestSelection(readFileSync(CI_YML, "utf8"));
  });

  it("uploads the views guest coverage artifact", () => {
    // The unit Upload coverage step uses an explicit `files:` list; an
    // omitted entry silently drops the artifact. This pins
    // coverage/views.lcov.info in the parsed with.files entries alongside
    // the other unit reports — a YAML comment naming it is not an entry.
    assertViewsCoverageUpload(readFileSync(CI_YML, "utf8"));
  });

  describe("views guest guard fixtures (F16)", () => {
    // Every fixture below derives from the real ci.yml and exercises the
    // same predicates the real-file tests use, so the guard's own
    // accept/reject outcomes are tested, not just the workflow text.
    const BASE_YML = readFileSync(CI_YML, "utf8");
    const CORE_BLOCK =
      "      - name: core / cli (bun:test)\n" +
      "        run: |\n" +
      "          bun test packages/core packages/cli --coverage --timeout 30000\n" +
      "          mv coverage/lcov.info coverage/core-cli.lcov.info\n";
    const GUEST_BLOCK =
      "      - name: views guest runtime (bun:test)\n" +
      "        run: |\n" +
      "          bun test packages/views/src --coverage --timeout 30000\n" +
      "          mv coverage/lcov.info coverage/views.lcov.info\n";

    function replaceOnce(
      haystack: string,
      needle: string,
      replacement: string
    ): string {
      const parts = haystack.split(needle);
      if (parts.length !== 2) {
        throw new Error(
          "fixture error: anchor found " +
            `${parts.length - 1} times, expected once: ` +
            JSON.stringify(needle.slice(0, 60))
        );
      }
      return parts.join(replacement);
    }

    it("accepts the baseline and harmless comments", () => {
      expect(() => assertViewsGuestSelection(BASE_YML)).not.toThrow();
      expect(() => assertViewsCoverageUpload(BASE_YML)).not.toThrow();
      // The old raw-text guard rejected these comment-only additions; the
      // parsed predicates ignore YAML comments and standalone run comments.
      const withStepComment = replaceOnce(
        BASE_YML,
        GUEST_BLOCK,
        `      # Do not add continue-on-error or an if: condition here.\n${GUEST_BLOCK}`
      );
      const withRunComment = replaceOnce(
        withStepComment,
        "          mv coverage/lcov.info coverage/views.lcov.info\n",
        "          # The guest DOM globals stay out of the core/CLI process.\n" +
          "          mv coverage/lcov.info coverage/views.lcov.info\n"
      );
      const withAllComments = replaceOnce(
        withRunComment,
        "          flags: unit",
        "          # coverage/views.lcov.info must stay listed; " +
          "do not add || true, || : or ; exit 0 here.\n" +
          "          flags: unit"
      );
      expect(() => assertViewsGuestSelection(withAllComments)).not.toThrow();
      expect(() => assertViewsCoverageUpload(withAllComments)).not.toThrow();
    });

    it("rejects a removed guest step", () => {
      const removed = replaceOnce(BASE_YML, GUEST_BLOCK, "");
      expect(() => assertViewsGuestSelection(removed)).toThrow(/exactly one/);
      // The upload entry is untouched, so coverage still resolves.
      expect(() => assertViewsCoverageUpload(removed)).not.toThrow();
    });

    it("rejects a commented-out guest step", () => {
      const commented = replaceOnce(
        BASE_YML,
        GUEST_BLOCK,
        GUEST_BLOCK.split("\n")
          .map((line) => (line.length > 0 ? `# ${line}` : line))
          .join("\n")
      );
      // The old raw-text guard accepted this: zero executable guest steps.
      expect(() => assertViewsGuestSelection(commented)).toThrow(/exactly one/);
    });

    it("rejects gated or error-tolerant guest steps", () => {
      const nameLine = "      - name: views guest runtime (bun:test)\n";
      const gated = replaceOnce(
        BASE_YML,
        nameLine,
        `${nameLine}        if: false\n`
      );
      expect(() => assertViewsGuestSelection(gated)).toThrow(/if condition/);
      const tolerant = replaceOnce(
        BASE_YML,
        nameLine,
        `${nameLine}        continue-on-error: true\n`
      );
      expect(() => assertViewsGuestSelection(tolerant)).toThrow(
        /continue-on-error/
      );
    });

    it("rejects failure-swallowing guest commands", () => {
      const bunLine =
        "          bun test packages/views/src --coverage --timeout 30000\n";
      const mvLine =
        "          mv coverage/lcov.info coverage/views.lcov.info\n";
      const variants: Array<[string, string, string]> = [
        [
          "appends || true",
          bunLine,
          "          bun test packages/views/src --coverage --timeout 30000 || true\n",
        ],
        [
          "pipes through tee",
          bunLine,
          "          bun test packages/views/src --coverage --timeout 30000 | tee views-test.log\n",
        ],
        ["disables errexit", bunLine, `          set +e\n${bunLine}`],
        [
          "wraps in a conditional",
          bunLine + mvLine,
          `          if false; then\n${bunLine}${mvLine}          fi\n`,
        ],
        [
          "appends exit 0",
          mvLine,
          "          mv coverage/lcov.info coverage/views.lcov.info; exit 0\n",
        ],
      ];
      for (const variant of variants) {
        const mutated = replaceOnce(BASE_YML, variant[1], variant[2]);
        // The old substring guard accepted the pipeline, set +e and
        // conditional forms; exact matching rejects every variant.
        expect(() => assertViewsGuestSelection(mutated)).toThrow(
          /exactly the bun selection/
        );
      }
    });

    it("rejects narrowed selections and cross-package absorption", () => {
      const subset = replaceOnce(
        BASE_YML,
        "bun test packages/views/src --coverage --timeout 30000",
        "bun test packages/views/src/__tests__/bridge.test.ts --coverage --timeout 30000"
      );
      expect(() => assertViewsGuestSelection(subset)).toThrow(
        /exactly the bun selection/
      );
      const filtered = replaceOnce(
        BASE_YML,
        "bun test packages/views/src --coverage --timeout 30000",
        "bun test packages/views/src --coverage --timeout 30000 --test-name-pattern guest"
      );
      expect(() => assertViewsGuestSelection(filtered)).toThrow(
        /exactly the bun selection/
      );
      const absorbed = replaceOnce(
        BASE_YML,
        "bun test packages/core packages/cli --coverage --timeout 30000",
        "bun test packages/core packages/cli packages/views/src --coverage --timeout 30000"
      );
      expect(() => assertViewsGuestSelection(absorbed)).toThrow(
        /must not select packages\/views/
      );
    });

    it("requires unique ordered core/guest/scripts steps", () => {
      const duplicated = replaceOnce(
        BASE_YML,
        GUEST_BLOCK,
        GUEST_BLOCK + GUEST_BLOCK
      );
      expect(() => assertViewsGuestSelection(duplicated)).toThrow(
        /exactly one/
      );
      const swapped = replaceOnce(
        BASE_YML,
        `${CORE_BLOCK}\n${GUEST_BLOCK}`,
        `${GUEST_BLOCK}\n${CORE_BLOCK}`
      );
      expect(() => assertViewsGuestSelection(swapped)).toThrow(/order must be/);
    });

    it("rejects a non-fail-closed guest shell", () => {
      const nameLine = "      - name: views guest runtime (bun:test)\n";
      const customShell = replaceOnce(
        BASE_YML,
        nameLine,
        `${nameLine}        shell: bash {0}\n`
      );
      // `bash {0}` drops the runner default -e, so a failing bun still
      // renames the report and exits zero.
      expect(() => assertViewsGuestSelection(customShell)).toThrow(
        /fail-closed shell/
      );
    });

    it("rejects omitted or comment-only coverage entries", () => {
      const dropped = replaceOnce(
        BASE_YML,
        "coverage/embeddings.lcov.info,coverage/views.lcov.info",
        "coverage/embeddings.lcov.info"
      );
      expect(() => assertViewsCoverageUpload(dropped)).toThrow(/missing from/);
      // The old text-window guard accepted the filename in a comment; the
      // parsed files list excludes it.
      const commentOnly = replaceOnce(
        dropped,
        "          flags: unit",
        "          # coverage/views.lcov.info\n          flags: unit"
      );
      expect(() => assertViewsCoverageUpload(commentOnly)).toThrow(
        /missing from/
      );
    });
  });
});
