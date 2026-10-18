import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertDirectory } from "../takeout-fs.ts";

describe("takeout-fs assertDirectory", () => {
  test("rejects a missing export directory rather than returning an empty sync", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "li-reader-missing-"));
    try {
      expect(() =>
        assertDirectory({ takeout_dir: path.join(dir, "missing") }, "LinkedIn")
      ).toThrow("takeout directory does not exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a regular file as an export directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "li-reader-file-"));
    try {
      const file = path.join(dir, "not-a-directory");
      writeFileSync(file, "fixture");
      expect(() => assertDirectory({ takeout_dir: file }, "LinkedIn")).toThrow(
        "takeout directory does not exist"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a valid export directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "li-reader-empty-"));
    try {
      expect(assertDirectory({ takeout_dir: dir }, "LinkedIn")).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
