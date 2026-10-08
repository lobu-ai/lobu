import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import config from "../lobu.config";
import { deriveAutomationExtractionSchema } from "../../../packages/server/src/utils/automation-extraction-schema";
import type { DbClient } from "../../../packages/server/src/db/client";

const profileAutomation = () =>
  (config.automations ?? []).find(
    (automation) => automation.slug === "linkedin-interest-profile-weekly"
  );

// The event-only path never touches the database (no entity metadata to
// resolve, no reaction schema lookup without an automation id). A throwing
// stub proves the derivation stays side-effect free.
const throwingSql = (() => {
  throw new Error("must not reach the database");
}) as unknown as DbClient;

const representativeDraft = {
  content:
    "Burak posts about agents and infra. Voice: short, direct, no hashtags.",
  metadata: {
    channel: "linkedin",
    mode: "voice",
    themes: ["agents"],
    prefers: ["technical substance"],
    avoids: ["engagement bait"],
    confidence: "medium",
    evidence_count: 12,
  },
};

// The pre-fix prompt shape: key fields outside metadata, no content.
const legacyDraft = {
  channel: "linkedin",
  mode: "voice",
  summary: "Burak posts about agents and infra.",
  themes: ["agents"],
};

describe("LinkedIn interest-profile declared output", () => {
  test("declares the keyed voice_profile event the prompt promises", () => {
    expect(profileAutomation()?.outputs).toEqual({
      profiles: { event: "voice_profile", key: ["channel", "mode"] },
    });
  });

  test("a prompted profile validates against the extraction schema", async () => {
    const schema = await deriveAutomationExtractionSchema(
      throwingSql,
      "org-test",
      profileAutomation()?.outputs as Record<string, unknown>
    );
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    // NOTE: assert last — toMatchObject runs asymmetric matchers against
    // `schema` in place, which would corrupt it for compilation.
    const validate = ajv.compile(schema as object);
    expect(validate({ profiles: [representativeDraft] })).toBe(true);
    expect(validate({ profiles: [legacyDraft] })).toBe(false);
    expect(schema).toMatchObject({
      properties: { profiles: { type: "array" } },
      required: expect.arrayContaining(["profiles"]),
    });
  });
});
