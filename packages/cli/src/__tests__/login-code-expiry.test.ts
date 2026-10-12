import { describe, expect, test } from "bun:test";
import { codeExpiryLine } from "../commands/login.js";

describe("codeExpiryLine", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  test("names the remaining minutes, single use, and how to get a new code", () => {
    const line = codeExpiryLine(now + 15 * 60_000, now);
    expect(line).toContain("works once");
    expect(line).toContain("expires in 15 min");
    expect(line).toContain("`lobu login` again");
  });

  test("never claims zero minutes left", () => {
    expect(codeExpiryLine(now + 5_000, now)).toContain("expires in 1 min");
  });
});
