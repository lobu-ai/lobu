/**
 * Unit coverage for `validateSettingsPatch`, the write-boundary type check on
 * PATCH `/:agentId/config`. Before it, `{"verboseLogging":"not-a-boolean"}` was
 * handed to the store and the route still answered `{ success: true }`.
 */

import { describe, expect, test } from "bun:test";
import { installRouteTestMocks } from "./helpers/route-test-mocks";

installRouteTestMocks();
const { validateSettingsPatch } = await import("../agent-routes.js");

describe("validateSettingsPatch", () => {
  test("accepts a correctly-typed patch", () => {
    expect(
      validateSettingsPatch({ verboseLogging: true, soulMd: "hi" })
    ).toBeNull();
  });

  test("accepts an empty patch", () => {
    expect(validateSettingsPatch({})).toBeNull();
  });

  test("rejects a non-boolean verboseLogging with the field path", () => {
    expect(validateSettingsPatch({ verboseLogging: "not-a-boolean" })).toMatch(
      /^verboseLogging/
    );
  });

  test("rejects a non-boolean showToolCalls", () => {
    expect(validateSettingsPatch({ showToolCalls: 1 })).toMatch(
      /^showToolCalls/
    );
  });

  test("rejects a non-string persona field", () => {
    expect(validateSettingsPatch({ soulMd: 42 })).toMatch(/^soulMd/);
  });

  test("rejects a bad field even when mixed with valid ones", () => {
    expect(
      validateSettingsPatch({ soulMd: "ok", verboseLogging: "yes" })
    ).toMatch(/^verboseLogging/);
  });

  test("keeps null (explicit clear) and unknown keys on their old path", () => {
    expect(
      validateSettingsPatch({ soulMd: null, authProfiles: [], somethingNew: 1 })
    ).toBeNull();
  });

  test("leaves models to its own org-aware validator", () => {
    expect(validateSettingsPatch({ models: "not-an-array" })).toBeNull();
  });

  test("rejects a non-object body", () => {
    expect(validateSettingsPatch(null)).toMatch(/JSON object/);
    expect(validateSettingsPatch([])).toMatch(/JSON object/);
    expect(validateSettingsPatch("x")).toMatch(/JSON object/);
  });
});
