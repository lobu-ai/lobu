/**
 * validateNetworkConfig: empty / whitespace network entries are garbage under
 * any domain grammar and are refused at the PATCH write boundary.
 */
import { describe, expect, test } from "bun:test";
import { installRouteTestMocks } from "./helpers/route-test-mocks";

installRouteTestMocks();
const { validateNetworkConfig } = await import("../agent-routes");

describe("validateNetworkConfig", () => {
  test("accepts absent, null and well-formed lists", () => {
    expect(validateNetworkConfig({})).toBeNull();
    expect(validateNetworkConfig({ networkConfig: null })).toBeNull();
    expect(
      validateNetworkConfig({
        networkConfig: {
          allowedDomains: ["api.example.com", ".github.com", "*.npmjs.org"],
          deniedDomains: [],
        },
      })
    ).toBeNull();
  });

  test("rejects an empty or whitespace-only entry", () => {
    for (const bad of ["", " ", "\t"]) {
      expect(
        validateNetworkConfig({ networkConfig: { allowedDomains: [bad] } })
      ).toContain("allowedDomains/0 must not be empty");
    }
  });

  test("rejects an entry containing whitespace", () => {
    expect(
      validateNetworkConfig({
        networkConfig: { allowedDomains: ["ok.com", "bad host with spaces"] },
      })
    ).toContain("allowedDomains/1 must not contain whitespace");
  });

  test("checks deniedDomains too and rejects wrong types", () => {
    expect(
      validateNetworkConfig({ networkConfig: { deniedDomains: [""] } })
    ).toContain("deniedDomains/0");
    expect(
      validateNetworkConfig({ networkConfig: { allowedDomains: [5] } })
    ).toContain("must be a string");
    expect(
      validateNetworkConfig({ networkConfig: { allowedDomains: "a.com" } })
    ).toContain("must be an array");
  });
});
