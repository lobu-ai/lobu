import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `@lobu/cli/config` is loaded by jiti from a project's node_modules at
// `lobu apply` time. It MUST stay dependency-light: importing any heavy CLI
// internal (the server bundle, embedded-postgres, the chat adapters, esbuild,
// playwright, …) would drag that whole graph into a user's `lobu.config.ts`
// load + typecheck. The only allowed runtime imports are relative siblings,
// the connector authoring subpath, and TypeBox; `import type` is erased.
const ALLOWED_BARE = new Set([
  "@lobu/connector-sdk",
  "@lobu/connector-sdk/define-connector",
  "@sinclair/typebox",
]);

const configDir = join(import.meta.dir, "..");

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // Matches `from "x"` (static import/export-from) and `import("x")`.
  const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((m = re.exec(source)) !== null) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

describe("@lobu/cli/config isolation", () => {
  test("imports only relative siblings, connector-sdk, and typebox", () => {
    const files = readdirSync(configDir).filter(
      (f) => f.endsWith(".ts") && f !== "__tests__"
    );
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(configDir, file), "utf-8").replace(
        /import type[\s\S]*?from\s*["'][^"']+["'];/g,
        ""
      );
      for (const spec of importSpecifiers(source)) {
        const isRelative = spec.startsWith(".");
        if (!isRelative && !ALLOWED_BARE.has(spec)) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
