/**
 * Unit coverage for `validateGuardrailsInline` — the write-boundary validation
 * that protects the guardrail aggregator from malformed `guardrailsInline` rows.
 * An entry with an invalid `stage` (or missing name/policy) would otherwise be
 * persisted verbatim and then crash the aggregator mid-message when it indexes
 * `seen[stage]`. The PATCH `/:agentId/config` route and the `manage_agents`
 * tool both reject such payloads.
 */

import { describe, expect, test } from "bun:test";
import { validateGuardrailsInline } from "../agent-settings";

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
