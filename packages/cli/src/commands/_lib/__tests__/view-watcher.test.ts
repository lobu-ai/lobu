import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startViewWatcher } from "../view-watcher.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startViewWatcher", () => {
  test("a burst of saves collapses into one re-apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-view-watch-"));
    tempDirs.push(dir);
    const file = join(dir, "pipeline.tsx");
    writeFileSync(file, "v1");
    let calls = 0;
    const watcher = startViewWatcher(
      { configPath: join(dir, "lobu.config.ts"), files: [file] },
      { onChange: async () => calls++ }
    );
    try {
      // Three rapid saves inside the debounce window.
      writeFileSync(file, "v2");
      await sleep(100);
      writeFileSync(file, "v3");
      await sleep(100);
      writeFileSync(file, "v4");
      await sleep(1200);
      expect(calls).toBe(1);
    } finally {
      watcher.close();
    }
  });

  test("close stops further re-applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-view-watch-"));
    tempDirs.push(dir);
    const file = join(dir, "pipeline.tsx");
    writeFileSync(file, "v1");
    let calls = 0;
    const watcher = startViewWatcher(
      { configPath: join(dir, "lobu.config.ts"), files: [file] },
      { onChange: async () => calls++ }
    );
    watcher.close();
    writeFileSync(file, "v2");
    await sleep(1100);
    expect(calls).toBe(0);
  });
});
