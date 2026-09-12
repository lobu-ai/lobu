import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertNodeVitestRuntime } from "../setup/vitest-runtime.js";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));

const readPackageFile = (relativePath: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)),
    "utf8"
  );

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("server Vitest runtime", () => {
  test("rejects a simulated Bun runtime with the canonical Node command", () => {
    expect(() =>
      assertNodeVitestRuntime({ node: "26.7.0", bun: "1.3.5" })
    ).toThrow(
      "@lobu/server Vitest must run under Node: integration files share one Postgres and require a single fork worker.\n" +
        "Use: cd packages/server && bun run test -- run <files>"
    );
  });

  test("accepts a simulated Node runtime", () => {
    expect(() => assertNodeVitestRuntime({ node: "26.7.0" })).not.toThrow();
  });

  test("rejects bunx even when its current Vitest child honors the Node shebang", () => {
    expect(() =>
      assertNodeVitestRuntime({ node: "26.7.0" }, "bunx")
    ).toThrow("Use: cd packages/server && bun run test -- run <files>");
  });

  test("the canonical package script resolves the installed Vitest CLI", () => {
    const packageJson = JSON.parse(readPackageFile("package.json")) as {
      scripts: Record<string, string>;
    };

    // Bun run resolves workspace binaries and honors Vitest's Node shebang;
    // a package-local node_modules path breaks after dependency hoisting.
    expect(packageJson.scripts.test).toBe("vitest");
    expect(packageJson.scripts["test:sandbox-runtime"]).toBe(
      "SKIP_TEST_DB_SETUP=1 bun run test -- run src/__tests__/integration/sandbox/run-script-runtime.test.ts"
    );
  });

  test("global setup runs the guard before any database decision", () => {
    const setupSource = readPackageFile("src/__tests__/setup/global-setup.ts");
    const guardCall = setupSource.indexOf("assertNodeVitestRuntime();");
    const databaseDecision = setupSource.indexOf(
      "process.env.SKIP_TEST_DB_SETUP"
    );

    expect(guardCall).toBeGreaterThanOrEqual(0);
    expect(databaseDecision).toBeGreaterThan(guardCall);
  });

  test("Vitest integration files do not invoke the Bun database bootstrap", () => {
    const offenders = sourceFiles(`${packageRoot}src/__tests__/integration`)
      .filter((path) => path.endsWith(".test.ts"))
      .filter((path) =>
        readFileSync(path, "utf8").includes("gateway/__tests__/helpers/db-setup")
      )
      .map((path) => path.slice(packageRoot.length));

    expect(offenders).toEqual([]);
  });
});
