import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const catalog = JSON.stringify({
  synthetic: {
    models: {
      example: {
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 4096, output: 1024 },
        tool_call: true,
      },
    },
  },
});

test.each([
  { responses: [null, 503, catalog], attempts: 3, success: true },
  { responses: [null, null, null], attempts: 3, success: false },
  { responses: [404], attempts: 1, success: false },
  { responses: ["invalid json"], attempts: 1, success: false },
])("catalog build handles $responses with $attempts attempts", ({
  responses,
  attempts,
  success,
}) => {
  const root = mkdtempSync(join(tmpdir(), "lobu-model-catalog-"));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(
      new URL("../build-model-catalog.mjs", import.meta.url),
      join(root, "scripts/build-model-catalog.mjs")
    );
    const output = join(root, "packages/server/src/generated/models-dev.json");
    mkdirSync(join(root, "packages/server/src/generated"), { recursive: true });
    writeFileSync(output, "previous snapshot");
    writeFileSync(
      join(root, "fetch.mjs"),
      `
      import { appendFileSync } from "node:fs";
      const responses = ${JSON.stringify(responses)};
      globalThis.fetch = async () => {
        appendFileSync("attempts", "x");
        const value = responses.shift();
        if (value === null) throw new DOMException("timed out", "TimeoutError");
        return typeof value === "number" ? new Response(null, { status: value }) : new Response(value);
      };
      globalThis.setTimeout = (fn) => setImmediate(fn);
    `
    );
    const run = (args: string[]) =>
      spawnSync(
        "node",
        ["--import", "./fetch.mjs", "scripts/build-model-catalog.mjs", ...args],
        { cwd: root, encoding: "utf8", timeout: 10_000 }
      );
    // An existing release snapshot is reused without network access.
    expect(run([]).status).toBe(0);
    expect(existsSync(join(root, "attempts"))).toBe(false);
    const result = run(["--refresh"]);
    expect(result.error).toBeUndefined();
    expect(result.status === 0).toBe(success);
    expect(readFileSync(join(root, "attempts"), "utf8").length).toBe(attempts);
    const saved = readFileSync(output, "utf8");
    if (success)
      expect(JSON.parse(saved).models.synthetic.example.contextWindow).toBe(
        4096
      );
    else expect(saved).toBe("previous snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
