import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Walk up from `startDir` looking for the Lobu monorepo workspace root: a
 * `package.json` whose `workspaces` field is set AND which has
 * `packages/server/src/index.ts` underneath it. The server-entry check keeps
 * us from false-positiving on unrelated Bun/npm workspace roots that happen
 * to enclose the start dir.
 *
 * Returns the absolute path to that directory, or `null` if none is found.
 */
export function findEnclosingMonorepoRoot(startDir: string): string | null {
  let cur = path.resolve(startDir);
  // Hard cap on iterations as a guard against pathological inputs.
  for (let i = 0; i < 64; i++) {
    const pkgPath = path.join(cur, "package.json");
    if (existsSync(pkgPath)) {
      let hasWorkspaces = false;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          workspaces?: unknown;
        };
        hasWorkspaces =
          pkg.workspaces !== undefined &&
          pkg.workspaces !== null &&
          (Array.isArray(pkg.workspaces)
            ? pkg.workspaces.length > 0
            : typeof pkg.workspaces === "object");
      } catch {
        hasWorkspaces = false;
      }
      if (
        hasWorkspaces &&
        existsSync(path.join(cur, "packages/server/src/index.ts"))
      ) {
        return cur;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
