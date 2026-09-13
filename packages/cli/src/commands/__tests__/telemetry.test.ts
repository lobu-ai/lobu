import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telemetryOnCommand } from "../telemetry";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("telemetry env location", () => {
  test("writes to the nearest Lobu project root, not the current subdirectory", async () => {
    const root = mkdtempSync(join(tmpdir(), "lobu-telemetry-"));
    roots.push(root);
    writeFileSync(join(root, "lobu.config.ts"), "export default {};\n");
    const nested = join(root, "packages", "worker");
    mkdirSync(nested, { recursive: true });

    await telemetryOnCommand({ cwd: nested, dsn: "https://public@example.test/1" });

    expect(readFileSync(join(root, ".env"), "utf-8")).toContain(
      "SENTRY_DSN=https://public@example.test/1"
    );
    expect(() => readFileSync(join(nested, ".env"), "utf-8")).toThrow();
  });

  test("refuses to create .env outside a Lobu project", async () => {
    const root = mkdtempSync(join(tmpdir(), "not-lobu-"));
    roots.push(root);
    await expect(telemetryOnCommand({ cwd: root })).rejects.toThrow(
      /No Lobu project found/
    );
    expect(() => readFileSync(join(root, ".env"), "utf-8")).toThrow();
  });
});
