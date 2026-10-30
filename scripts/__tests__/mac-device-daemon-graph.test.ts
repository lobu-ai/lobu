import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertMacDeviceDaemonGraph,
  forbiddenMacDeviceDaemonGraphInputs,
} from "../check-mac-device-daemon-graph.mjs";

describe("Mac device-daemon package graph guard", () => {
  test("allows the canonical automation and narrow redaction paths", () => {
    expect(
      forbiddenMacDeviceDaemonGraphInputs({
        "packages/connector-worker/src/daemon/automation.ts": {},
        "packages/connector-worker/src/daemon/client.ts": {},
        "packages/connector-sdk/src/redact.ts": {},
        "packages/connector-worker/src/daemon/native-bridge/protocol.ts": {},
        "packages/connector-worker/src/daemon/native-bridge/client.ts": {},
        "packages/connector-worker/src/daemon/native-bridge/executor.ts": {},
      })
    ).toEqual([]);
  });

  test("rejects fleet connector and heavy runtime paths", () => {
    expect(() =>
      assertMacDeviceDaemonGraph({
        "packages/connector-worker/src/compile/index.ts": {},
        "packages/connector-worker/src/executor/isolate.ts": {},
        "packages/embeddings/src/index.ts": {},
        "node_modules/@xenova/transformers/src/pipelines.js": {},
        "node_modules/onnxruntime-node/dist/index.js": {},
        "node_modules/playwright/index.js": {},
        "node_modules/sharp/dist/index.js": {},
        "node_modules/jimp/index.js": {},
      })
    ).toThrow("forbidden fleet/runtime modules");
  });

  test("runs the CLI guard when the checkout path contains spaces", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lobu graph guard "));
    const checker = join(tempRoot, "check-mac-device-daemon-graph.mjs");
    const metafile = join(tempRoot, "metafile.json");
    try {
      copyFileSync(
        fileURLToPath(
          new URL("../check-mac-device-daemon-graph.mjs", import.meta.url)
        ),
        checker
      );
      writeFileSync(
        metafile,
        JSON.stringify({ inputs: { "daemon/automation.ts": {} } })
      );
      const result = spawnSync(process.execPath, [checker, metafile], {
        encoding: "utf8",
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Mac device-daemon graph clean");
      expect(readFileSync(checker, "utf8")).toContain("fileURLToPath");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
