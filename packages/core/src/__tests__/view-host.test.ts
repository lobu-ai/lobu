import { describe, expect, it } from "vitest";
import { isViewRead } from "../contracts/tools/view-host";

describe("isViewRead", () => {
  it("admits the public knowledge read", () => {
    expect(isViewRead("read_knowledge", { semantic_type: ["summary"] })).toBe(
      true
    );
  });

  it("keeps raw SQL and SDK scripts out of the view bridge", () => {
    expect(isViewRead("query_sql", {})).toBe(false);
    expect(isViewRead("query_sdk", {})).toBe(false);
  });

  it("limits mixed entity tools to their read actions", () => {
    expect(isViewRead("manage_entity", { action: "list" })).toBe(true);
    expect(isViewRead("manage_entity", { action: "create" })).toBe(false);
  });

  it("admits feed reads without admitting feed mutations or missing actions", () => {
    for (const action of ["list_feeds", "read_feed", "read_feeds"]) {
      expect(isViewRead("manage_feeds", { action })).toBe(true);
    }
    for (const action of [
      "create_feed",
      "update_feed",
      "delete_feed",
      "trigger_feed",
      "unknown",
      "",
      null,
    ]) {
      expect(isViewRead("manage_feeds", { action })).toBe(false);
    }
    expect(isViewRead("manage_feeds", {})).toBe(false);
    expect(isViewRead("manage_feeds", undefined)).toBe(false);
  });
});
