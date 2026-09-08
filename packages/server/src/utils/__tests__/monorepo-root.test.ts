import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findEnclosingMonorepoRoot } from "../monorepo-root";

const tempDirs: string[] = [];

function makeFakeMonorepo(): string {
  const root = mkdtempSync(join(tmpdir(), "lobu-monorepo-"));
  tempDirs.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fake-root", workspaces: ["packages/*"] })
  );
  mkdirSync(join(root, "packages/server/src"), { recursive: true });
  writeFileSync(join(root, "packages/server/src/index.ts"), "// server");
  return root;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("findEnclosingMonorepoRoot", () => {
  it("returns the root when called from the root itself", () => {
    const root = makeFakeMonorepo();
    expect(findEnclosingMonorepoRoot(root)).toBe(root);
  });

  it("walks up from a project subdir to the enclosing root", () => {
    const root = makeFakeMonorepo();
    const subdir = join(root, "examples", "lobu-team");
    mkdirSync(subdir, { recursive: true });
    expect(findEnclosingMonorepoRoot(subdir)).toBe(root);
  });

  it("returns null when no enclosing workspace root exists", () => {
    const lone = mkdtempSync(join(tmpdir(), "lobu-lone-"));
    tempDirs.push(lone);
    expect(findEnclosingMonorepoRoot(lone)).toBeNull();
  });

  it("does not false-positive on a workspace root without the worker entry", () => {
    const root = mkdtempSync(join(tmpdir(), "lobu-otherws-"));
    tempDirs.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "other", workspaces: ["packages/*"] })
    );
    mkdirSync(join(root, "packages/something"), { recursive: true });
    expect(findEnclosingMonorepoRoot(root)).toBeNull();
  });

  it("ignores a package.json without a workspaces field", () => {
    const root = mkdtempSync(join(tmpdir(), "lobu-nows-"));
    tempDirs.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "no-workspaces" })
    );
    mkdirSync(join(root, "packages/server/src"), { recursive: true });
    writeFileSync(join(root, "packages/server/src/index.ts"), "// server");
    expect(findEnclosingMonorepoRoot(root)).toBeNull();
  });

  it("finds the real lobu monorepo from this test file", () => {
    const found = findEnclosingMonorepoRoot(__dirname);
    expect(found).not.toBeNull();
    // Sanity: the discovered root must actually carry the worker entry.
    expect(
      require("node:fs").existsSync(
        join(found!, "packages/server/src/index.ts")
      )
    ).toBe(true);
  });
});
