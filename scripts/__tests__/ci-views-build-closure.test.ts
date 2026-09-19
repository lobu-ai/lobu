import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parse as parseWorkflowYaml,
  stringify as stringifyWorkflowYaml,
} from "yaml";

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
// Bounded root-safe working-directory forms: unset (inherited repo root),
// "." / "./" (explicit repo root), and the exact GitHub workspace-root
// expression. Anything else (packages/..., unresolved or general
// expressions) is rejected — no general expression evaluator.
const GITHUB_WORKSPACE_ROOT = "${{ github.workspace }}";

function isRootSafeWorkingDirectory(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed === "." || trimmed === "./" || trimmed === GITHUB_WORKSPACE_ROOT
  );
}

type WorkflowDoc = {
  defaults?: { run?: Record<string, unknown> };
  jobs?: {
    unit?: { defaults?: { run?: Record<string, unknown> }; steps?: unknown };
  };
};

function parsedDoc(ymlText: string): WorkflowDoc {
  return parseWorkflowYaml(ymlText) as WorkflowDoc;
}

function unitSteps(ymlText: string): WorkflowStep[] {
  const steps = parsedDoc(ymlText)?.jobs?.unit?.steps;
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

function runDefaultsBlock(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const run: unknown = (value as Record<string, unknown>).run;
  if (typeof run !== "object" || run === null) {
    return {};
  }
  return run as Record<string, unknown>;
}

// GitHub precedence for `run` settings: step > job defaults.run >
// workflow defaults.run. A step without its own shell/working-directory
// inherits the job default, then the workflow default, then the runner
// default (bash -e {0} on Linux, fail closed).
function effectiveGuestShell(
  doc: WorkflowDoc,
  guestStep: WorkflowStep
): unknown {
  if (guestStep.shell !== undefined) {
    return guestStep.shell;
  }
  const jobShell = runDefaultsBlock(doc?.jobs?.unit?.defaults).shell;
  if (jobShell !== undefined) {
    return jobShell;
  }
  return runDefaultsBlock(doc?.defaults).shell;
}

function effectiveGuestWorkingDirectory(
  doc: WorkflowDoc,
  guestStep: WorkflowStep
): unknown {
  const stepWd: unknown = guestStep["working-directory"];
  if (stepWd !== undefined) {
    return stepWd;
  }
  const jobWd = runDefaultsBlock(doc?.jobs?.unit?.defaults)[
    "working-directory"
  ];
  if (jobWd !== undefined) {
    return jobWd;
  }
  return runDefaultsBlock(doc?.defaults)["working-directory"];
}

function assertViewsGuestSelection(ymlText: string): void {
  const doc = parsedDoc(ymlText);
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
  // -o pipefail; any other override can drop -e. Precedence is step >
  // job defaults.run > workflow defaults.run: an unset step shell does
  // NOT override an inherited `bash {0}`, so the effective shell is
  // checked, not just the step field.
  const effectiveShell = effectiveGuestShell(doc, guestStep);
  if (effectiveShell !== undefined && effectiveShell !== "bash") {
    throw new Error(
      "ci views guard: guest step must keep the default fail-closed " +
        `shell (unset or bash), got effective ${JSON.stringify(effectiveShell)}`
    );
  }
  // coverage/ paths below are relative to the checkout root, so the
  // effective working directory (step > job default > workflow default)
  // must stay root-safe: unset, ".", "./", or the exact GitHub
  // workspace-root expression. Package directories and unresolved/general
  // expressions are rejected.
  const effectiveWd = effectiveGuestWorkingDirectory(doc, guestStep);
  if (!isRootSafeWorkingDirectory(effectiveWd)) {
    throw new Error(
      "ci views guard: guest step must run in the repo root " +
        `(unset, ".", "./", or ${GITHUB_WORKSPACE_ROOT}), got effective ${JSON.stringify(effectiveWd)}`
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
    // Every fixture below starts from the parsed live ci.yml and mutates
    // the parsed jobs.unit.steps / defaults nodes, then re-serializes.
    // No fixture is built by matching a raw multiline live-workflow
    // anchor, so a harmless standalone `#` comment inside the guest run
    // block cannot break fixture construction: the run scalar round-trips
    // through the parser and executableCommands() discards `#` lines.
    // Each negative fixture re-parses its own output and asserts the
    // intended parsed node actually changed before expecting rejection.
    const BASE_YML = readFileSync(CI_YML, "utf8");

    type MutableDoc = Record<string, any>;

    function liveDoc(): MutableDoc {
      return parseWorkflowYaml(BASE_YML) as MutableDoc;
    }

    function toYml(doc: MutableDoc): string {
      return stringifyWorkflowYaml(doc);
    }

    function mutateLive(mutator: (doc: MutableDoc) => void): string {
      const doc = liveDoc();
      mutator(doc);
      return toYml(doc);
    }

    function stepsOf(doc: MutableDoc): Array<Record<string, any>> {
      const steps: unknown = doc?.jobs?.unit?.steps;
      if (!Array.isArray(steps)) {
        throw new Error("fixture error: jobs.unit.steps is not a list");
      }
      return steps as Array<Record<string, any>>;
    }

    function guestStepOf(doc: MutableDoc): Record<string, any> {
      const hits = stepsOf(doc).filter((s) => s?.name === GUEST_STEP_NAME);
      if (hits.length !== 1) {
        throw new Error(
          `fixture error: expected one guest step, found ${hits.length}`
        );
      }
      return hits[0] as Record<string, any>;
    }

    function ensureJobRun(doc: MutableDoc): Record<string, any> {
      const jobs = doc.jobs as Record<string, any>;
      const unit = jobs.unit as Record<string, any>;
      const defaultsRaw: unknown = unit.defaults;
      if (typeof defaultsRaw !== "object" || defaultsRaw === null) {
        unit.defaults = {};
      }
      const unitDefaults = unit.defaults as Record<string, any>;
      const runRaw: unknown = unitDefaults.run;
      if (typeof runRaw !== "object" || runRaw === null) {
        unitDefaults.run = {};
      }
      return unitDefaults.run as Record<string, any>;
    }

    function ensureWorkflowRun(doc: MutableDoc): Record<string, any> {
      const rootRaw: unknown = doc.defaults;
      if (typeof rootRaw !== "object" || rootRaw === null) {
        doc.defaults = {};
      }
      const root = doc.defaults as Record<string, any>;
      const runRaw: unknown = root.run;
      if (typeof runRaw !== "object" || runRaw === null) {
        root.run = {};
      }
      return root.run as Record<string, any>;
    }

    function reparsed(yml: string): MutableDoc {
      return parseWorkflowYaml(yml) as MutableDoc;
    }

    function parsedGuestRun(yml: string): unknown {
      const doc = reparsed(yml);
      return guestStepOf(doc).run;
    }

    function parsedEffectiveShell(yml: string): unknown {
      const doc = reparsed(yml);
      const guest = guestStepOf(doc);
      if (guest.shell !== undefined) {
        return guest.shell;
      }
      const jobShell: unknown = doc?.jobs?.unit?.defaults?.run?.shell;
      if (jobShell !== undefined) {
        return jobShell;
      }
      return doc?.defaults?.run?.shell;
    }

    function parsedEffectiveWd(yml: string): unknown {
      const doc = reparsed(yml);
      const guest = guestStepOf(doc);
      if (guest["working-directory"] !== undefined) {
        return guest["working-directory"];
      }
      const jobWd: unknown =
        doc?.jobs?.unit?.defaults?.run?.["working-directory"];
      if (jobWd !== undefined) {
        return jobWd;
      }
      return doc?.defaults?.run?.["working-directory"];
    }

    // Insert a standalone `#` YAML comment line before the first line
    // containing `needle` in an already-serialized canonical fixture.
    // The anchor lives on the canonical rendering, never on a raw
    // multiline live-workflow block.
    function withYamlComment(
      canonicalYml: string,
      needle: string,
      comment: string
    ): string {
      const lines = canonicalYml.split("\n");
      const at = lines.findIndex((line) => line.includes(needle));
      if (at < 0) {
        throw new Error(
          `fixture error: canonical needle missing: ${JSON.stringify(needle)}`
        );
      }
      const indent = lines[at]?.match(/^\s*/)?.[0] ?? "";
      lines.splice(at, 0, `${indent}${comment}`);
      return lines.join("\n");
    }

    it("accepts the live baseline through the full suite", () => {
      expect(() => assertViewsGuestSelection(BASE_YML)).not.toThrow();
      expect(() => assertViewsCoverageUpload(BASE_YML)).not.toThrow();
    });

    it("accepts harmless comments through the full suite", () => {
      // Standalone run-block comment: part of the run scalar, discarded
      // by executableCommands(), exact two commands preserved.
      const withRunComment = mutateLive((doc) => {
        guestStepOf(doc).run =
          `${GUEST_BUN_COMMAND}\n` +
          "# Keep guest coverage separate.\n" +
          `${GUEST_LCOV_RENAME}\n`;
      });
      expect(parsedGuestRun(withRunComment)).toContain(
        "# Keep guest coverage separate."
      );
      expect(() => assertViewsGuestSelection(withRunComment)).not.toThrow();
      expect(() => assertViewsCoverageUpload(withRunComment)).not.toThrow();
      // Standalone YAML comments on the canonical rendering carry no
      // semantics; the parsed predicates ignore them.
      const canonical = toYml(liveDoc());
      const withStepComment = withYamlComment(
        canonical,
        GUEST_STEP_NAME,
        "# Do not add continue-on-error or an if: condition here."
      );
      const withAllComments = withYamlComment(
        withStepComment,
        "flags: unit",
        "# coverage/views.lcov.info must stay listed."
      );
      expect(() => assertViewsGuestSelection(withAllComments)).not.toThrow();
      expect(() => assertViewsCoverageUpload(withAllComments)).not.toThrow();
      // The exact commented baseline from the F16 report, run through the
      // complete suite (not just predicates).
      const reportBaseline = mutateLive((doc) => {
        guestStepOf(doc).run =
          `${GUEST_BUN_COMMAND}\n` +
          "# Keep guest coverage separate.\n" +
          `${GUEST_LCOV_RENAME}\n`;
      });
      expect(() => assertViewsGuestSelection(reportBaseline)).not.toThrow();
      expect(() => assertViewsCoverageUpload(reportBaseline)).not.toThrow();
    });

    it("rejects a removed guest step", () => {
      const removed = mutateLive((doc) => {
        doc.jobs.unit.steps = stepsOf(doc).filter(
          (s) => s?.name !== GUEST_STEP_NAME
        );
      });
      const doc = reparsed(removed);
      expect(
        stepsOf(doc).filter((s) => s?.name === GUEST_STEP_NAME)
      ).toHaveLength(0);
      expect(() => assertViewsGuestSelection(removed)).toThrow(/exactly one/);
      // The upload entry is untouched, so coverage still resolves.
      expect(() => assertViewsCoverageUpload(removed)).not.toThrow();
    });

    it("rejects a commented-out guest step", () => {
      // A YAML `#`-commented step parses to an absent step, whose
      // canonical parsed mutation is removal.
      const commented = mutateLive((doc) => {
        doc.jobs.unit.steps = stepsOf(doc).filter(
          (s) => s?.name !== GUEST_STEP_NAME
        );
      });
      const doc = reparsed(commented);
      expect(
        stepsOf(doc).filter((s) => s?.name === GUEST_STEP_NAME)
      ).toHaveLength(0);
      // The old raw-text guard accepted this: zero executable guest steps.
      expect(() => assertViewsGuestSelection(commented)).toThrow(/exactly one/);
    });

    it("rejects gated or error-tolerant guest steps", () => {
      const gated = mutateLive((doc) => {
        guestStepOf(doc).if = false;
      });
      expect(
        "if" in
          reparsed(gated).jobs.unit.steps.find(
            (s: any) => s?.name === GUEST_STEP_NAME
          )
      ).toBe(true);
      expect(() => assertViewsGuestSelection(gated)).toThrow(/if condition/);
      const tolerant = mutateLive((doc) => {
        guestStepOf(doc)["continue-on-error"] = true;
      });
      expect(
        reparsed(tolerant).jobs.unit.steps.find(
          (s: any) => s?.name === GUEST_STEP_NAME
        )["continue-on-error"]
      ).toBe(true);
      expect(() => assertViewsGuestSelection(tolerant)).toThrow(
        /continue-on-error/
      );
    });

    it("rejects failure-swallowing guest commands", () => {
      const variants: Array<[string, string]> = [
        [
          "appends || true",
          `${GUEST_BUN_COMMAND} || true\n${GUEST_LCOV_RENAME}\n`,
        ],
        [
          "pipes through tee",
          `${GUEST_BUN_COMMAND} | tee views-test.log\n${GUEST_LCOV_RENAME}\n`,
        ],
        [
          "disables errexit",
          `set +e\n${GUEST_BUN_COMMAND}\n${GUEST_LCOV_RENAME}\n`,
        ],
        [
          "wraps in a conditional",
          `if false; then\n${GUEST_BUN_COMMAND}\n${GUEST_LCOV_RENAME}\nfi\n`,
        ],
        [
          "appends exit 0",
          `${GUEST_BUN_COMMAND}\n${GUEST_LCOV_RENAME}; exit 0\n`,
        ],
      ];
      for (const variant of variants) {
        const mutated = mutateLive((doc) => {
          guestStepOf(doc).run = variant[1];
        });
        // Prove the mutation reached the intended parsed node.
        expect(parsedGuestRun(mutated)).toBe(variant[1]);
        // The old substring guard accepted the pipeline, set +e and
        // conditional forms; exact matching rejects every variant.
        expect(() => assertViewsGuestSelection(mutated)).toThrow(
          /exactly the bun selection/
        );
      }
    });

    it("rejects narrowed selections and cross-package absorption", () => {
      const subset = mutateLive((doc) => {
        guestStepOf(doc).run =
          "bun test packages/views/src/__tests__/bridge.test.ts --coverage --timeout 30000\n" +
          `${GUEST_LCOV_RENAME}\n`;
      });
      expect(parsedGuestRun(subset)).toContain("bridge.test.ts");
      expect(() => assertViewsGuestSelection(subset)).toThrow(
        /exactly the bun selection/
      );
      const filtered = mutateLive((doc) => {
        guestStepOf(doc).run =
          `${GUEST_BUN_COMMAND} --test-name-pattern guest\n${GUEST_LCOV_RENAME}\n`;
      });
      expect(parsedGuestRun(filtered)).toContain("--test-name-pattern");
      expect(() => assertViewsGuestSelection(filtered)).toThrow(
        /exactly the bun selection/
      );
      const absorbed = mutateLive((doc) => {
        const core = stepsOf(doc).find((s) => s?.name === CORE_STEP_NAME);
        if (!core) {
          throw new Error("fixture error: core step missing");
        }
        core.run =
          "bun test packages/core packages/cli packages/views/src --coverage --timeout 30000\n" +
          "mv coverage/lcov.info coverage/core-cli.lcov.info\n";
      });
      expect(
        (reparsed(absorbed).jobs.unit.steps as any[]).find(
          (s: any) => s?.name === CORE_STEP_NAME
        ).run
      ).toContain("packages/views");
      expect(() => assertViewsGuestSelection(absorbed)).toThrow(
        /must not select packages\/views/
      );
    });

    it("requires unique ordered core/guest/scripts steps", () => {
      const duplicated = mutateLive((doc) => {
        const guest = guestStepOf(doc);
        stepsOf(doc).push(JSON.parse(JSON.stringify(guest)));
      });
      expect(
        reparsed(duplicated).jobs.unit.steps.filter(
          (s: any) => s?.name === GUEST_STEP_NAME
        )
      ).toHaveLength(2);
      expect(() => assertViewsGuestSelection(duplicated)).toThrow(
        /exactly one/
      );
      const swapped = mutateLive((doc) => {
        const steps = stepsOf(doc);
        const coreAt = steps.findIndex((s) => s?.name === CORE_STEP_NAME);
        const guestAt = steps.findIndex((s) => s?.name === GUEST_STEP_NAME);
        if (coreAt < 0 || guestAt < 0) {
          throw new Error("fixture error: core/guest steps missing");
        }
        const [core] = steps.splice(coreAt, 1);
        const target = steps.findIndex((s) => s?.name === GUEST_STEP_NAME);
        steps.splice(target + 1, 0, core as Record<string, any>);
      });
      const order = (reparsed(swapped).jobs.unit.steps as any[])
        .map((s: any) => s?.name)
        .filter(
          (n: unknown) =>
            n === CORE_STEP_NAME ||
            n === GUEST_STEP_NAME ||
            n === SCRIPTS_STEP_NAME
        );
      expect(order).toEqual([
        GUEST_STEP_NAME,
        CORE_STEP_NAME,
        SCRIPTS_STEP_NAME,
      ]);
      expect(() => assertViewsGuestSelection(swapped)).toThrow(/order must be/);
    });

    it("rejects a non-fail-closed explicit guest shell", () => {
      const customShell = mutateLive((doc) => {
        guestStepOf(doc).shell = "bash {0}";
      });
      // `bash {0}` drops the runner default -e, so a failing bun still
      // renames the report and exits zero.
      expect(parsedEffectiveShell(customShell)).toBe("bash {0}");
      expect(() => assertViewsGuestSelection(customShell)).toThrow(
        /fail-closed shell/
      );
    });

    it("rejects inherited job and workflow default shells", () => {
      // Expose the intended unsafe default: a more-specific safe shell
      // would otherwise shadow it (step > job > workflow), so delete
      // step shell before setting the job default, and step + job shells
      // before setting the workflow default. Unrelated defaults.run keys
      // are retained via merge (never wholesale replacement).
      const jobShell = mutateLive((doc) => {
        delete guestStepOf(doc).shell;
        const run = ensureJobRun(doc);
        run.shell = "bash {0}";
      });
      expect(parsedEffectiveShell(jobShell)).toBe("bash {0}");
      expect(() => assertViewsGuestSelection(jobShell)).toThrow(
        /fail-closed shell/
      );
      const workflowShell = mutateLive((doc) => {
        delete guestStepOf(doc).shell;
        const jobRun = doc.jobs.unit.defaults?.run as
          | Record<string, any>
          | undefined;
        if (jobRun && typeof jobRun === "object") {
          delete jobRun.shell;
        }
        const run = ensureWorkflowRun(doc);
        run.shell = "bash {0}";
      });
      expect(parsedEffectiveShell(workflowShell)).toBe("bash {0}");
      expect(() => assertViewsGuestSelection(workflowShell)).toThrow(
        /fail-closed shell/
      );
    });

    it("rejects inherited working directories", () => {
      // Same precedence rule as shells: delete more-specific
      // working-directory values first so the intended unsafe default is
      // the effective value. Unrelated run keys are retained.
      const jobWd = mutateLive((doc) => {
        delete guestStepOf(doc)["working-directory"];
        const run = ensureJobRun(doc);
        run["working-directory"] = "packages/cli";
      });
      expect(parsedEffectiveWd(jobWd)).toBe("packages/cli");
      expect(() => assertViewsGuestSelection(jobWd)).toThrow(
        /repo root|working-directory/
      );
      const workflowWd = mutateLive((doc) => {
        delete guestStepOf(doc)["working-directory"];
        const jobRun = doc.jobs.unit.defaults?.run as
          | Record<string, any>
          | undefined;
        if (jobRun && typeof jobRun === "object") {
          delete jobRun["working-directory"];
        }
        const run = ensureWorkflowRun(doc);
        run["working-directory"] = "packages/cli";
      });
      expect(parsedEffectiveWd(workflowWd)).toBe("packages/cli");
      expect(() => assertViewsGuestSelection(workflowWd)).toThrow(
        /repo root|working-directory/
      );
      const stepWd = mutateLive((doc) => {
        guestStepOf(doc)["working-directory"] = "packages/cli";
      });
      expect(parsedEffectiveWd(stepWd)).toBe("packages/cli");
      expect(() => assertViewsGuestSelection(stepWd)).toThrow(
        /repo root|working-directory/
      );
    });

    // Full-suite assertion: selection + coverage together. Predicate-only
    // positives miss F16 fixture false positives, so every safe baseline
    // below runs the complete suite.
    function assertFullSuite(yml: string): void {
      assertViewsGuestSelection(yml);
      assertViewsCoverageUpload(yml);
    }

    it("prefers an explicit safe guest shell over an unsafe default", () => {
      // Precedence is step > job default > workflow default: pinning
      // `shell: bash` on the guest genuinely overrides `bash {0}`.
      // Runs the complete suite, not just the predicate.
      const overridden = mutateLive((doc) => {
        ensureJobRun(doc).shell = "bash {0}";
        guestStepOf(doc).shell = "bash";
      });
      expect(parsedEffectiveShell(overridden)).toBe("bash");
      expect(() => assertFullSuite(overridden)).not.toThrow();
      // Job bash over an unsafe workflow default: same precedence rule
      // one level down. Delete the more-specific guest shell first so the
      // job default is the effective value.
      const jobOverWorkflow = mutateLive((doc) => {
        delete guestStepOf(doc).shell;
        ensureJobRun(doc).shell = "bash";
        ensureWorkflowRun(doc).shell = "bash {0}";
      });
      expect(parsedEffectiveShell(jobOverWorkflow)).toBe("bash");
      expect(() => assertFullSuite(jobOverWorkflow)).not.toThrow();
    });

    it("accepts safe explicit Bash baselines through the full suite", () => {
      // Safe step / job / workflow Bash keeps fail-closed -e/-o pipefail
      // and must pass the entire suite, including the inherited-default
      // negative fixtures (which delete more-specific shells first).
      const stepBash = mutateLive((doc) => {
        guestStepOf(doc).shell = "bash";
      });
      expect(parsedEffectiveShell(stepBash)).toBe("bash");
      expect(() => assertFullSuite(stepBash)).not.toThrow();
      const jobBash = mutateLive((doc) => {
        delete guestStepOf(doc).shell;
        ensureJobRun(doc).shell = "bash";
      });
      expect(parsedEffectiveShell(jobBash)).toBe("bash");
      expect(() => assertFullSuite(jobBash)).not.toThrow();
      const workflowBash = mutateLive((doc) => {
        delete guestStepOf(doc).shell;
        const jobRun = doc.jobs.unit.defaults?.run as
          | Record<string, any>
          | undefined;
        if (jobRun && typeof jobRun === "object") {
          delete jobRun.shell;
        }
        ensureWorkflowRun(doc).shell = "bash";
      });
      expect(parsedEffectiveShell(workflowBash)).toBe("bash");
      expect(() => assertFullSuite(workflowBash)).not.toThrow();
    });

    it("accepts root-safe working directories through the full suite", () => {
      // Bounded root-safe forms: ".", "./", and the exact GitHub
      // workspace-root expression. Each runs the complete suite.
      for (const wd of [".", "./", GITHUB_WORKSPACE_ROOT]) {
        const stepWd = mutateLive((doc) => {
          guestStepOf(doc)["working-directory"] = wd;
        });
        expect(parsedEffectiveWd(stepWd)).toBe(wd);
        expect(() => assertFullSuite(stepWd)).not.toThrow();
      }
      const jobDot = mutateLive((doc) => {
        delete guestStepOf(doc)["working-directory"];
        ensureJobRun(doc)["working-directory"] = ".";
      });
      expect(parsedEffectiveWd(jobDot)).toBe(".");
      expect(() => assertFullSuite(jobDot)).not.toThrow();
      // Safe overrides of unsafe inherited defaults: step dot over job
      // packages/cli, job dot over workflow packages/cli.
      const stepOverJob = mutateLive((doc) => {
        ensureJobRun(doc)["working-directory"] = "packages/cli";
        guestStepOf(doc)["working-directory"] = ".";
      });
      expect(parsedEffectiveWd(stepOverJob)).toBe(".");
      expect(() => assertFullSuite(stepOverJob)).not.toThrow();
      const jobOverWorkflow = mutateLive((doc) => {
        delete guestStepOf(doc)["working-directory"];
        ensureJobRun(doc)["working-directory"] = ".";
        ensureWorkflowRun(doc)["working-directory"] = "packages/cli";
      });
      expect(parsedEffectiveWd(jobOverWorkflow)).toBe(".");
      expect(() => assertFullSuite(jobOverWorkflow)).not.toThrow();
      // Bounded rejection: package directories, unresolved and general
      // expressions are never root-safe.
      for (const bad of [
        "packages/cli",
        "packages/views",
        "${{ matrix.os }}",
        "$GITHUB_WORKSPACE",
      ]) {
        const rejected = mutateLive((doc) => {
          delete guestStepOf(doc)["working-directory"];
          const jobRun = doc.jobs.unit.defaults?.run as
            | Record<string, any>
            | undefined;
          if (jobRun && typeof jobRun === "object") {
            delete jobRun["working-directory"];
          }
          const root = doc.defaults as Record<string, any> | undefined;
          const rootRun = root?.run as Record<string, any> | undefined;
          if (rootRun && typeof rootRun === "object") {
            delete rootRun["working-directory"];
          }
          guestStepOf(doc)["working-directory"] = bad;
        });
        expect(parsedEffectiveWd(rejected)).toBe(bad);
        expect(() => assertViewsGuestSelection(rejected)).toThrow(
          /repo root|working-directory/
        );
      }
    });

    it("rejects omitted or comment-only coverage entries", () => {
      const dropped = mutateLive((doc) => {
        const steps = stepsOf(doc);
        const upload = steps.find(
          (s) =>
            typeof s?.uses === "string" &&
            (s.uses as string).startsWith("codecov/")
        );
        if (
          !upload ||
          typeof upload.with !== "object" ||
          upload.with === null
        ) {
          throw new Error("fixture error: codecov step missing");
        }
        const files: unknown = (upload.with as Record<string, unknown>).files;
        if (
          typeof files !== "string" ||
          !files.includes(GUEST_COVERAGE_ENTRY)
        ) {
          throw new Error("fixture error: guest coverage entry missing");
        }
        (upload.with as Record<string, unknown>).files = files
          .split(",")
          .map((entry: string) => entry.trim())
          .filter((entry: string) => entry !== GUEST_COVERAGE_ENTRY)
          .join(",");
      });
      const entries = codecovFilesEntries(
        reparsed(dropped).jobs.unit.steps as WorkflowStep[]
      );
      expect(entries).not.toContain(GUEST_COVERAGE_ENTRY);
      expect(() => assertViewsCoverageUpload(dropped)).toThrow(/missing from/);
      // The old text-window guard accepted the filename in a comment; the
      // parsed files list excludes it.
      const commentOnly = withYamlComment(
        dropped,
        "flags: unit",
        "# coverage/views.lcov.info"
      );
      expect(() => assertViewsCoverageUpload(commentOnly)).toThrow(
        /missing from/
      );
    });
  });
});
