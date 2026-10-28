/**
 * Importing any platform module BEFORE the registry must still leave every
 * `PLATFORM_REGISTRY` entry defined.
 *
 * When a platform module's own imports reach back to `platforms/index.ts`,
 * the registry object is built while that module is still mid-evaluation, so
 * its descriptor reads as undefined (Bun throws a TDZ ReferenceError; Vitest
 * leaves the key undefined and chat fails with "No adapter factory for: …").
 * The server's startup order hides this, and so does any test process that
 * already loaded the registry, so each module is imported first in a FRESH
 * process. The module list is read from disk: a new platform file is covered
 * with no edit here.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const PLATFORMS_DIR = join(import.meta.dir, "..");
const SERVER_ROOT = join(PLATFORMS_DIR, "../../../..");

/**
 * Connector-transport platforms still close a cycle through
 * connector-chat-platform.ts → manage_operations execute → notifications →
 * platforms/index.ts. Listed so the rest of the class is guarded now; the test
 * fails once one of them is fixed, so the entry is removed with the fix.
 */
const KNOWN_CYCLIC = new Set(["linkedin.ts", "whatsapp-web.ts", "x.ts"]);

const modules = readdirSync(PLATFORMS_DIR)
  .filter((file) => file.endsWith(".ts") && file !== "index.ts")
  .sort();

async function registryAfterImporting(file: string) {
  const script = `
    await import(${JSON.stringify(join(PLATFORMS_DIR, file))});
    const { PLATFORM_REGISTRY } = await import(${JSON.stringify(join(PLATFORMS_DIR, "index.ts"))});
    const missing = Object.entries(PLATFORM_REGISTRY).filter(([, d]) => !d).map(([k]) => k);
    console.log("REGISTRY_MISSING=" + JSON.stringify(missing));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: SERVER_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.split("\n").find((l) => l.startsWith("REGISTRY_MISSING="));
  const missing: string[] | null = line
    ? JSON.parse(line.slice("REGISTRY_MISSING=".length))
    : null;
  return { file, complete: exitCode === 0 && missing?.length === 0, missing, stderr };
}

describe("platform registry import order", () => {
  test(
    "every platform module can be imported before platforms/index.ts",
    async () => {
      expect(modules).toContain("gchat.ts");
      const results = await Promise.all(modules.map(registryAfterImporting));
      const broken = results
        .filter((r) => !r.complete && !KNOWN_CYCLIC.has(r.file))
        .map((r) => ({ file: r.file, missing: r.missing, stderr: r.stderr.slice(-600) }));
      expect(broken).toEqual([]);
      const nowFixed = results
        .filter((r) => r.complete && KNOWN_CYCLIC.has(r.file))
        .map((r) => r.file);
      expect(nowFixed).toEqual([]);
    },
    60_000,
  );
});
