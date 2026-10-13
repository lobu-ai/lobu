import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

type Step = {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
const workflow = Bun.YAML.parse(
  readFileSync(
    resolve(import.meta.dir, "../../.github/workflows/mac-release.yml"),
    "utf8"
  )
) as {
  on: {
    workflow_dispatch: {
      inputs: { publish?: { type: string; default: boolean } };
    };
  };
  jobs: { release: { steps: Step[] } };
};
const steps = workflow.jobs.release.steps;
const step = (name: string) => {
  const found = steps.find((item) => item.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
};

describe("unpublished Mac build", () => {
  test("preserves publishing by default with a typed opt-out", () => {
    expect(workflow.on.workflow_dispatch.inputs.publish).toMatchObject({
      type: "boolean",
      default: true,
    });
  });

  test("manual build-only cannot write releases or the Sparkle appcast", () => {
    for (const name of [
      "Attach DMG to the release",
      "Sign update with Sparkle and publish appcast",
    ]) {
      const condition = step(name).if;
      expect(typeof condition).toBe("string");
      for (const [event, publish, expected] of [
        ["workflow_dispatch", false, false],
        ["workflow_dispatch", true, true],
        ["release", undefined, true],
      ] as const) {
        expect(
          Boolean(
            runInNewContext(condition!, {
              github: { event_name: event },
              inputs: { publish },
            })
          )
        ).toBe(expected);
      }
    }
  });

  test("build-only saves an artifact with exact source provenance", () => {
    const artifact = step("Upload unpublished Mac build");
    expect(artifact.uses).toMatch(/^actions\/upload-artifact@/);
    expect(artifact.with?.["if-no-files-found"]).toBe("error");
    expect(artifact.with?.path).toContain("Lobu.dmg");
    expect(artifact.with?.path).toContain("Lobu.build.json");
    for (const [event, publish, expected] of [
      ["workflow_dispatch", false, true],
      ["workflow_dispatch", true, false],
      ["release", undefined, false],
    ] as const) {
      expect(
        Boolean(
          runInNewContext(artifact.if!, {
            github: { event_name: event },
            inputs: { publish },
          })
        )
      ).toBe(expected);
    }
    const provenance = step("Record unpublished build provenance");
    expect(provenance.if).toBe(artifact.if);
    expect(provenance.run).toContain("GITHUB_SHA");
    expect(provenance.run).toContain("git -C packages/owletto rev-parse HEAD");
    expect(provenance.run).toContain("Lobu.build.json");
    expect(steps.indexOf(step("Notarize and staple"))).toBeLessThan(
      steps.indexOf(artifact)
    );
  });

  test("unpublished mode fails rather than silently emitting an unsigned replacement", () => {
    const mode = step("Detect signing mode");
    expect(mode.env?.PUBLISH).toContain("inputs.publish");
    expect(mode.run).toContain(
      "Unpublished Mac builds require the signing certificate"
    );
    expect(mode.run).toContain("exit 1");
    expect(step("Notarize and staple").if).toBe(
      "steps.mode.outputs.signed == 'true'"
    );
  });
});
