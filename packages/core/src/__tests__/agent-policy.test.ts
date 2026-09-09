import { describe, expect, test } from "bun:test";
import { getCustomToolDescription } from "../agent-policy";

describe("agent-policy tool descriptions", () => {
  test("upload_file description forbids local path substitutes", () => {
    expect(getCustomToolDescription("upload_file")).toContain(
      "Do not substitute local paths, workspace paths, or sandbox links"
    );
  });
});
