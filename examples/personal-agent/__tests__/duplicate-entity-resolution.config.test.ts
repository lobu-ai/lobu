import { describe, expect, test } from "bun:test";
import config from "../lobu.config";

describe("duplicate entity resolution configuration", () => {
  test("declares email association and phone review policies explicitly", () => {
    const person = config.entities?.find((entity) => entity.key === "person");
    expect(person?.resolutionPolicy).toEqual({
      rules: [
        { fields: ["email"], normalizer: "email", onMatch: "auto_link" },
        { fields: ["emails"], normalizer: "email", onMatch: "auto_link" },
        { fields: ["phone"], normalizer: "phone", onMatch: "review" },
        { fields: ["phones"], normalizer: "phone", onMatch: "review" },
      ],
    });
  });

  // Automation `triggers` are always-managed by apply: an omitted key projects
  // to `[]` and CLEARS the stored cron, unlike an omitted feed `schedule`.
  // Dropping this declaration would silently strand the Automation with no
  // cadence, so assert the whole trigger list rather than just its presence.
  test("declares the weekly cadence apply would otherwise strip", () => {
    const automation = config.automations?.find(
      (candidate) =>
        candidate.slug === "duplicate-entity-resolution-real-v3-final"
    );
    expect(automation).toBeDefined();
    expect(automation?.triggers).toEqual([
      {
        kind: "schedule",
        cron: "0 6 * * 1",
        timezone: "Europe/London",
        skip_if_unchanged: false,
      },
    ]);
  });

  // Every Automation this config declares needs a reachable trigger for the
  // same reason. Naming only the one Automation above would let the next
  // trigger-less declaration through — the guard has to cover the class.
  test("every declared Automation has at least one trigger", () => {
    const triggerless = (config.automations ?? [])
      .filter((automation) => (automation.triggers ?? []).length === 0)
      .map((automation) => automation.slug);
    expect(triggerless).toEqual([]);
  });
});
