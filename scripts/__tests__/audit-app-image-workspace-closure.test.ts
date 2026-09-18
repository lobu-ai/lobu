import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * App-image workspace closure (round-1 F4): packages/server requires
 * `@lobu/views` (workspace:*), and docker/app/Dockerfile builds its
 * COPY/install/compile graph explicitly. A workspace member missing from
 * that closure fails `bun install` in the image with
 * `Workspace dependency "@lobu/views" not found`, and a member copied
 * without its compiled dist leaves require.resolve('@lobu/views')
 * dangling at server compile time.
 *
 * These pin the closure per server workspace dependency: manifest COPY
 * (pre-install resolution), source COPY, dist compilation before the
 * server typecheck, and runtime COPY.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DOCKERFILE = join(REPO_ROOT, "docker", "app", "Dockerfile");

// Documented in the Dockerfile itself: prod never loads pgvector-embedded
// at runtime (external Postgres), so it is present for install/typecheck
// and pruned before the runtime image. The only member allowed to skip
// the runtime COPY.
const RUNTIME_EXEMPT = new Set(["pgvector-embedded"]);

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8")) as Record<
    string,
    unknown
  >;
}

function serverWorkspaceDirs(): string[] {
  const server = readJson("packages/server/package.json");
  const sections = ["dependencies", "peerDependencies", "devDependencies"];
  const dirs = new Set<string>();
  for (const section of sections) {
    const deps = (server[section] ?? {}) as Record<string, unknown>;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        const dir = name.replace(/^@lobu\//, "");
        dirs.add(dir);
      }
    }
  }
  return [...dirs].sort();
}

describe("app image workspace closure", () => {
  it("covers every server workspace dependency with manifest, source and runtime copies", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const missing: string[] = [];
    for (const dir of serverWorkspaceDirs()) {
      if (
        !dockerfile.includes(
          `COPY packages/${dir}/package.json packages/${dir}/`
        )
      )
        missing.push(`${dir}:manifest`);
      if (!dockerfile.includes(`COPY packages/${dir}/ packages/${dir}/`))
        missing.push(`${dir}:source`);
      if (
        !RUNTIME_EXEMPT.has(dir) &&
        !dockerfile.includes(
          `COPY --from=builder /app/packages/${dir} ./packages/${dir}`
        )
      )
        missing.push(`${dir}:runtime`);
    }
    expect(missing).toEqual([]);
  });

  it("compiles the real @lobu/views dist before the server typecheck", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const compileAt = dockerfile.indexOf("cd ../views && bunx tsc");
    const serverCheckAt = dockerfile.indexOf(
      "cd packages/server && bunx tsc --noEmit"
    );
    expect(compileAt).toBeGreaterThanOrEqual(0);
    expect(serverCheckAt).toBeGreaterThanOrEqual(0);
    expect(compileAt).toBeLessThan(serverCheckAt);

    // The compile step must produce what the exports map needs: views
    // serves dist subpaths, so its tsconfig must emit there.
    const views = readJson("packages/views/package.json");
    const exportsMap = views.exports as Record<string, unknown>;
    const targets = JSON.stringify(exportsMap);
    expect(targets).toContain("./dist/");
    const tsconfig = readJson("packages/views/tsconfig.json");
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    expect(compilerOptions.outDir).toBe("./dist");
  });
});
