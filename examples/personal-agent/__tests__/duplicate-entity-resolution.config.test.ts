import { describe, expect, test } from "bun:test";
import config from "../lobu.config";

describe("duplicate entity resolution configuration", () => {
  test("keeps identity matching disabled with the workspace configuration", () => {
    const person = config.entities?.find((entity) => entity.key === "person");
    expect(person).toBeDefined();
    expect(person?.resolutionPolicy).toBeUndefined();
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

  test("only the manual research preview is triggerless", () => {
    const triggerless = (config.automations ?? [])
      .filter((automation) => (automation.triggers ?? []).length === 0)
      .map((automation) => automation.slug);
    expect(triggerless).toEqual(["tiktok-practical-ai-research"]);
  });
});
