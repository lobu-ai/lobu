import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import config from "../lobu.config";
import {
  linkedInFeedFlaggerPrompt,
  linkedInInterestProfilePrompt,
} from "../linkedin.prompts";
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

// `preference` is a default $member kind (member-entity-type.ts
// DEFAULT_MEMBER_EVENT_KINDS), so this declared output needs no registry
// provisioning before apply — unlike a bespoke semantic type, which the
// create/version validator rejects with HTTP 422.
const representativeDraft = {
  title: "LinkedIn voice profile",
  content:
    "Burak posts about agents and infra. Voice: short, direct, no hashtags.",
  metadata: {
    channel: "linkedin",
    mode: "voice",
    themes: ["agents"],
    prefers: ["technical substance"],
    avoids: ["engagement bait"],
    // Numeric 0..1: the $member preference kind constrains confidence to a
    // number (member-entity-type.ts BASE_MEMBER_EVENT_METADATA_SCHEMA), so a
    // low/medium/high string 422s at persist time. No other constrained keys
    // (importance, namespace, status) are emitted.
    confidence: 0.8,
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
  test("declares the keyed preference event the prompt promises", () => {
    expect(profileAutomation()?.outputs).toEqual({
      profiles: { event: "preference", key: ["channel", "mode"] },
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

  test("the interest prompt pins the channel/mode identity", () => {
    expect(linkedInInterestProfilePrompt).toContain('"linkedin-buremba"');
    expect(linkedInInterestProfilePrompt).toContain('"channel": "linkedin"');
    expect(linkedInInterestProfilePrompt).toContain('"mode": "voice"');
    // The $member preference kind constrains confidence to numeric 0..1;
    // a low/medium/high string 422s at persist time.
    expect(linkedInInterestProfilePrompt).toContain("number 0 to 1");
    expect(linkedInInterestProfilePrompt).not.toContain(
      '"low"|"medium"|"high"'
    );
  });

  test("the flagger filters by mode with legacy fallback", () => {
    // Without the mode predicate a newer taste row would displace the voice
    // profile used for drafting.
    expect(linkedInFeedFlaggerPrompt).toContain("metadata->>'mode' = 'voice'");
    expect(linkedInFeedFlaggerPrompt).toContain(
      "title = 'LinkedIn interest profile'"
    );
  });
});
