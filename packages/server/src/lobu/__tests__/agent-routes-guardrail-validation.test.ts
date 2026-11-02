/**
 * Unit coverage for `validateGuardrailsInline` — the write-boundary validation
 * that protects the guardrail aggregator from malformed `guardrailsInline` rows.
 * An entry with an invalid `stage` (or missing name/policy) would otherwise be
 * persisted verbatim and then crash the aggregator mid-message when it indexes
 * `seen[stage]`. The PATCH `/:agentId/config` route and the `manage_agents`
 * tool both reject such payloads.
 */

import { describe, expect, test } from "bun:test";
import {
  validateGuardrailsInline,
  validateSkillsConfig,
} from "../agent-settings";

describe("validateGuardrailsInline", () => {
  test("returns null for an absent payload", () => {
    expect(validateGuardrailsInline(undefined)).toBeNull();
  });

  test("returns null for an empty array", () => {
    expect(validateGuardrailsInline([])).toBeNull();
  });

  test("accepts a fully-valid inline guardrail", () => {
    expect(
      validateGuardrailsInline([
        {
          name: "tone-check",
          enabled: true,
          stage: "output",
          policy: "no profanity",
          model: "anthropic/claude-haiku-4-5",
          tools: ["bash"],
        },
      ])
    ).toBeNull();
  });

  test("accepts an output require-tool guardrail without judge fields", () => {
    expect(
      validateGuardrailsInline([
        {
          name: "require-send",
          enabled: true,
          stage: "output",
          kind: "require-tool",
          tools: ["send_message"],
        },
      ])
    ).toBeNull();
  });

  test("rejects require-tool outside the output stage", () => {
    expect(
      validateGuardrailsInline([
        {
          name: "require-send",
          enabled: true,
          stage: "input",
          kind: "require-tool",
          tools: ["send_message"],
        },
      ])
    ).toMatch(/only supports stage "output"/);
  });

  test("rejects require-tool without a non-empty tool list", () => {
    expect(
      validateGuardrailsInline([
        {
          name: "require-send",
          enabled: true,
          stage: "output",
          kind: "require-tool",
          tools: [],
        },
      ])
    ).toMatch(/tools must be a non-empty array/);
  });

  test("rejects a non-array payload", () => {
    expect(validateGuardrailsInline({})).toMatch(/must be an array/);
  });

  test("rejects an invalid stage — the crash vector", () => {
    const err = validateGuardrailsInline([
      { name: "bad", enabled: true, stage: "outupt", policy: "x" },
    ]);
    expect(err).toMatch(/stage must be one of/);
  });

  test("rejects a missing/blank name", () => {
    expect(
      validateGuardrailsInline([
        { name: "   ", enabled: true, stage: "input", policy: "x" },
      ])
    ).toMatch(/name must be a non-empty string/);
  });

  test("rejects a non-boolean enabled", () => {
    expect(
      validateGuardrailsInline([
        { name: "g", enabled: "yes", stage: "input", policy: "x" },
      ])
    ).toMatch(/enabled must be a boolean/);
  });

  test("rejects a blank policy", () => {
    expect(
      validateGuardrailsInline([
        { name: "g", enabled: true, stage: "input", policy: "" },
      ])
    ).toMatch(/policy must be a non-empty string/);
  });

  test("rejects a non-string model", () => {
    expect(
      validateGuardrailsInline([
        { name: "g", enabled: true, stage: "input", policy: "x", model: 42 },
      ])
    ).toMatch(/model must be a string/);
  });

  test("rejects tools that are not a string array", () => {
    expect(
      validateGuardrailsInline([
        { name: "g", enabled: true, stage: "input", policy: "x", tools: [1] },
      ])
    ).toMatch(/tools must be an array of strings/);
  });

  test("accepts an egress guardrail with a domains selector (round-trip)", () => {
    expect(
      validateGuardrailsInline([
        {
          name: "egress-github",
          enabled: true,
          stage: "egress",
          policy: "only allow github reads",
          model: "anthropic/claude-haiku-4-5",
          domains: [".github.com", "api.github.com"],
        },
      ])
    ).toBeNull();
  });

  test("rejects domains that are not a string array", () => {
    expect(
      validateGuardrailsInline([
        {
          name: "g",
          enabled: true,
          stage: "egress",
          policy: "x",
          domains: [1],
        },
      ])
    ).toMatch(/domains must be an array of strings/);
  });

  test("rejects a null kind (schema allows only judge/require-tool or absent)", () => {
    expect(
      validateGuardrailsInline([
        { name: "g", enabled: true, stage: "input", policy: "x", kind: null },
      ])
    ).toMatch(/kind must be "judge" or "require-tool"/);
  });

  test("validates common optional fields on require-tool entries", () => {
    expect(
      validateGuardrailsInline([
        {
          name: "must-send",
          enabled: true,
          stage: "output",
          kind: "require-tool",
          tools: ["send_message"],
          model: 42,
        },
      ])
    ).toMatch(/model must be a string/);
  });
});

/**
 * `skillsConfig` is spread through the PATCH route and read back as a trusted
 * `SkillConfig`, so the shape has to hold at the write boundary.
 *
 * These assert the validator agrees with `SkillsConfigSchema` — the same schema
 * the readers' types are derived from. That equivalence is the whole point of
 * checking against the schema instead of a hand-rolled shape, so it is worth
 * pinning both directions.
 */
describe("validateSkillsConfig", () => {
  const skill = { repo: "file/x", name: "x", enabled: true };

  test("accepts an absent payload", () => {
    // PATCH is a partial merge: omitting the key must not be an error.
    expect(validateSkillsConfig(undefined)).toBeNull();
  });

  test("accepts well-formed payloads, including optional fields", () => {
    expect(validateSkillsConfig({ skills: [] })).toBeNull();
    expect(validateSkillsConfig({ skills: [skill] })).toBeNull();
    expect(
      validateSkillsConfig({
        skills: [
          {
            ...skill,
            enabled: false,
            description: "d",
            instructions: "i",
            content: "c",
            system: true,
            // Dropped from the schema with the Skills UI (#2320) — a stored
            // row that still carries it must not fail the write boundary.
            nixPackages: ["ripgrep"],
            modelPreference: "anthropic/claude-haiku-4-5",
            thinkingLevel: "low",
          },
        ],
      })
    ).toBeNull();
  });

  test("rejects a non-object skillsConfig", () => {
    expect(validateSkillsConfig("nope")).not.toBeNull();
    expect(validateSkillsConfig(null)).not.toBeNull();
  });

  test("rejects a non-array skills value", () => {
    // A non-array throws at the first `.filter()` downstream.
    for (const skills of ["nope", 1, {}, null]) {
      expect(validateSkillsConfig({ skills })).toContain("/skills");
    }
    // `skills` is required by the schema — an empty object is not a valid config.
    expect(validateSkillsConfig({})).not.toBeNull();
  });

  test("rejects a non-boolean enabled", () => {
    // The runtime gates on truthiness (`s.enabled && …`), so "yes" would enable
    // a skill that no write-time check ever saw as enabled.
    for (const enabled of ["yes", 1, {}, null]) {
      expect(
        validateSkillsConfig({ skills: [{ ...skill, enabled }] })
      ).toContain("/skills/0/enabled");
    }
    // `enabled` is required, not merely typed — a missing one reads as disabled.
    expect(validateSkillsConfig({ skills: [{ repo: "f/x", name: "x" }] })).toContain(
      "/skills/0/enabled"
    );
  });

  test("requires repo and name to be strings", () => {
    expect(validateSkillsConfig({ skills: [{ name: "x", enabled: true }] })).toContain(
      "/skills/0/repo"
    );
    expect(
      validateSkillsConfig({ skills: [{ repo: "f/x", name: 7, enabled: true }] })
    ).toContain("/skills/0/name");
  });

  test("error paths name the offending entry", () => {
    // Without the index a UI cannot point at the row that failed.
    expect(
      validateSkillsConfig({ skills: [skill, { repo: "b", enabled: true }] })
    ).toContain("/skills/1/name");
  });

  test("tolerates unknown keys left over from dropped fields", () => {
    // The editor round-trips the stored entry via `_original`, so a row written
    // before a field was removed still carries it. The server ignores it;
    // rejecting it would fail a save the user did not make.
    expect(
      validateSkillsConfig({ skills: [{ ...skill, guardrails: { "pre-tool": [] } }] })
    ).toBeNull();
  });
});
