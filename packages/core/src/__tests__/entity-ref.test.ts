import { describe, expect, test } from "bun:test";
import {
  ENTITY_REF_MAX_LENGTH,
  formatEntityRef,
  parseEntityRef,
} from "../contracts/entity-ref";

describe("entity refs", () => {
  test("round-trips a key that contains ':'", () => {
    const ref = formatEntityRef({ type: "account", key: "urn:acct:7" });
    expect(ref).toBe("account:urn:acct:7");
    expect(parseEntityRef(ref)).toEqual({ type: "account", key: "urn:acct:7" });
  });

  test("rejects empty sides and oversized refs", () => {
    expect(parseEntityRef("account")).toBeNull();
    expect(parseEntityRef(":k")).toBeNull();
    expect(parseEntityRef("account:")).toBeNull();
    expect(parseEntityRef(`a:${"k".repeat(ENTITY_REF_MAX_LENGTH)}`)).toBeNull();
    expect(() => formatEntityRef({ type: "a:b", key: "k" })).toThrow();
    expect(() => formatEntityRef({ type: "a", key: "" })).toThrow();
  });
});
