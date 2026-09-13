import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPortableArtifact } from "../artifact-portability.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lobu-artifact-portability-"));
  roots.push(root);
  const artifact = join(root, "artifact");
  const builder = join(root, "synthetic build checkout");
  mkdirSync(artifact);
  mkdirSync(builder);
  return { artifact, builder };
}
function file(root: string, path: string, value: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}

describe("published artifact portability", () => {
  it.each([
    "dist/catalogs/skills.json",
    "dist/catalogs/automations.json",
    "vendor/package/dist/index.js.map",
  ])("rejects a build directory anywhere in %s", (path) => {
    const { artifact, builder } = fixture();
    file(
      artifact,
      path,
      JSON.stringify({ source: join(builder, "source.ts") })
    );
    expect(() => assertPortableArtifact(artifact, builder)).toThrow(path);
  });
  it("recognizes URL-encoded build directories", () => {
    const { artifact, builder } = fixture();
    file(
      artifact,
      "dist/index.js",
      JSON.stringify(pathToFileURL(join(builder, "source.ts")).href)
    );
    expect(() => assertPortableArtifact(artifact, builder)).toThrow(
      "Build-machine path"
    );
  });
  it.each([
    "/Users/synthetic-builder/project/source.ts",
    "file:///Users/synthetic-builder/project/source.ts",
    "file://localhost/Users/synthetic-builder/project/source.ts",
    "file:%2F%2F%2FUsers%2Fsynthetic-builder%2Fproject%2Fsource.ts",
    "file:%2F%2Flocalhost%2FUsers%2Fsynthetic-builder%2Fproject%2Fsource.ts",
    String.raw`file:\x2f\x2f\x2fUsers\x2fsynthetic-builder\x2fproject\x2fsource.ts`,
    "C:\\Users\\synthetic-builder\\project\\source.ts",
    "file:///C:/Users/synthetic-builder/project/source.ts",
    "file:%2F%2F%2FC%3A%2FUsers%2Fsynthetic-builder%2Fproject%2Fsource.ts",
    "/home/runner/work/synthetic-project/source.ts",
  ])("rejects a foreign builder profile after serialization: %s", (source) => {
    const { artifact, builder } = fixture();
    file(artifact, "dist/index.js", JSON.stringify({ source }));
    expect(() => assertPortableArtifact(artifact, builder)).toThrow(
      "Build-machine path"
    );
  });
  it("rejects the current build home outside its checkout", () => {
    const { artifact, builder } = fixture();
    file(artifact, "dist/index.js", "file:///synthetic-home/cache/package.js");
    expect(() =>
      assertPortableArtifact(artifact, builder, "/synthetic-home")
    ).toThrow("Build-machine path");
  });
  it("rejects a current Linux checkout and home without matching generic runtime homes", () => {
    const { artifact } = fixture();
    file(
      artifact,
      "dist/index.js",
      '"/home/synthetic-builder/project/source.ts"'
    );
    expect(() =>
      assertPortableArtifact(
        artifact,
        "/home/synthetic-builder/project",
        "/home/synthetic-builder"
      )
    ).toThrow("Build-machine path");
  });
  it("excludes test fixtures rather than exempting their path values in production", () => {
    const { artifact, builder } = fixture();
    file(
      artifact,
      "src/__tests__/fixture.ts",
      '"/Users/synthetic-builder/source.ts"'
    );
    file(
      artifact,
      "fixtures/input.json",
      '"C:\\\\Users\\\\synthetic-builder\\\\source.ts"'
    );
    expect(() => assertPortableArtifact(artifact, builder)).not.toThrow();
  });
  it.each([
    "fixtures",
    "__fixtures__",
    "__tests__",
  ])("scans artifacts beneath a builder directory named %s", (parent) => {
    const { artifact, builder } = fixture();
    const nestedArtifact = join(artifact, parent, "package");
    file(
      nestedArtifact,
      "dist/index.js",
      JSON.stringify(join(builder, "source.ts"))
    );
    expect(() => assertPortableArtifact(nestedArtifact, builder)).toThrow(
      "Build-machine path"
    );
  });
  it.each([
    {
      source_path: "nested/connector.ts",
      source_uri: "file:///synthetic-old-build/source.ts",
    },
    { source_path: "/synthetic-old-build/source.ts" },
    { source_path: "C:\\synthetic-old-build\\source.ts" },
    { source_path: "../source.ts" },
  ])("rejects non-portable connector metadata from another build", (detail) => {
    const { artifact, builder } = fixture();
    file(
      artifact,
      "dist/catalogs/connectors.json",
      JSON.stringify({ entries: [{ id: "synthetic", detail }] })
    );
    expect(() => assertPortableArtifact(artifact, builder)).toThrow(
      "Non-portable builtin catalog source"
    );
  });
  it("accepts portable paths, source URLs, and generic documentation examples", () => {
    const { artifact, builder } = fixture();
    file(
      artifact,
      "dist/catalogs/connectors.json",
      JSON.stringify({
        entries: [
          { id: "synthetic", detail: { source_path: "nested/connector.ts" } },
        ],
      })
    );
    file(
      artifact,
      "dist/catalogs/skills.json",
      JSON.stringify({
        instructions: "Use .claude/worktrees/<task>/",
        url: "https://example.com/source.ts",
      })
    );
    file(
      artifact,
      "dist/index.js",
      'const runtimeHomes = ["/home/user", "/home/worker"]; const urls = ["https://example.com/Users/shared/source", "https://api.example.com/2/users/by/username"];'
    );
    expect(() => assertPortableArtifact(artifact, builder)).not.toThrow();
  });
});
