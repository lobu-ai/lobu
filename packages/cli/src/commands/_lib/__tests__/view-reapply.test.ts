import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startViewReapply } from "../view-reapply.js";

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

describe("startViewReapply", () => {
  test("a burst of saves collapses into one re-apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-view-reapply-"));
    tempDirs.push(dir);
    const file = join(dir, "pipeline.tsx");
    writeFileSync(file, "v1");
    let calls = 0;
    const loop = startViewReapply(
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
      loop.close();
    }
  });

  test("close stops further re-applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-view-reapply-"));
    tempDirs.push(dir);
    const file = join(dir, "pipeline.tsx");
    writeFileSync(file, "v1");
    let calls = 0;
    const loop = startViewReapply(
      { configPath: join(dir, "lobu.config.ts"), files: [file] },
      { onChange: async () => calls++ }
    );
    loop.close();
    writeFileSync(file, "v2");
    await sleep(1100);
    expect(calls).toBe(0);
  });

  // Round-2 F8: a save recorded while an apply runs must survive the
  // post-apply watch-set refresh. The dev loop keeps one coordinator and
  // swaps subscriptions in place; closing it per apply used to clear the
  // pending timer and lose the newer save.
  test("a save during an in-flight apply survives the watch-set update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-view-reapply-inflight-"));
    tempDirs.push(dir);
    const configPath = join(dir, "lobu.config.ts");
    const file = join(dir, "pipeline.tsx");
    writeFileSync(file, "init");
    const applied: string[] = [];
    let text = "init";
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let loop!: ReturnType<typeof startViewReapply>;
    async function onChange() {
      startedResolve();
      const snapshot = text;
      await sleep(300);
      applied.push(snapshot);
      // The dev.ts post-apply step on the same coordinator.
      loop.update({ configPath, files: [file] });
    }
    loop = startViewReapply({ configPath, files: [file] }, { onChange });
    try {
      text = "A";
      writeFileSync(file, "A");
      await Promise.race([
        started,
        sleep(5000).then(() => {
          throw new Error("apply A never started");
        }),
      ]);
      await sleep(100);
      text = "B";
      writeFileSync(file, "B");
      const deadline = Date.now() + 8000;
      while (applied.length < 2 && Date.now() < deadline) await sleep(100);
      // No third save anywhere: B must deploy on its own timer.
      expect(applied).toEqual(["A", "B"]);
    } finally {
      loop.close();
    }
  }, 20_000);

  test("close during an in-flight apply stops the loop without restarting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-view-reapply-close-"));
    tempDirs.push(dir);
    const configPath = join(dir, "lobu.config.ts");
    const file = join(dir, "pipeline.tsx");
    writeFileSync(file, "init");
    const applied: string[] = [];
    let text = "init";
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const loop = startViewReapply(
      { configPath, files: [file] },
      {
        onChange: async () => {
          startedResolve();
          const snapshot = text;
          await sleep(300);
          applied.push(snapshot);
        },
      }
    );
    try {
      text = "A";
      writeFileSync(file, "A");
      await Promise.race([
        started,
        sleep(5000).then(() => {
          throw new Error("apply A never started");
        }),
      ]);
      await sleep(100);
      text = "B";
      writeFileSync(file, "B");
      loop.close();
      // Past B's would-be timer, A's completion, and another full debounce:
      // the in-flight callback must not restart a stopped loop.
      await sleep(1800);
      expect(applied).toEqual(["A"]);
    } finally {
      loop.close();
    }
  }, 20_000);

  // Fresh-process regression for the metafile rebase defect: the child runs
  // with the fixture project as its launch cwd (an in-process cwd change
  // after esbuild init masks the bug), collects the real watch set, and
  // counts re-applies while the parent edits the imported helper.
  test("a helper edit fires the reapply loop from a fresh process cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-view-reapply-fresh-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "views", "deal"), { recursive: true });
    mkdirSync(join(dir, "views", "_lib"), { recursive: true });
    const entry = join(dir, "views", "deal", "board.tsx");
    const helper = join(dir, "views", "_lib", "label.ts");
    writeFileSync(
      entry,
      `import { label } from "../_lib/label";\nexport const out = label;\n`
    );
    writeFileSync(helper, `export const label = "A";\n`);
    const bundlerPath = resolve(import.meta.dir, "..", "view-bundler.ts");
    const reapplyPath = resolve(import.meta.dir, "..", "view-reapply.ts");
    const driver = join(dir, "watch-driver.ts");
    writeFileSync(
      driver,
      [
        `import { collectViewWatchFiles } from ${JSON.stringify(bundlerPath)};`,
        `import { startViewReapply } from ${JSON.stringify(reapplyPath)};`,
        `const entry = process.argv[2];`,
        `const files = await collectViewWatchFiles(entry);`,
        `console.log("FILES:" + JSON.stringify(files));`,
        `let calls = 0;`,
        `const loop = startViewReapply({ configPath: entry, files }, { onChange: async () => { calls++; } });`,
        `console.log("READY");`,
        `setTimeout(() => { loop.close(); console.log("CALLS:" + calls); process.exit(0); }, 6000);`,
        ``,
      ].join("\n")
    );
    const proc = Bun.spawn(["bun", driver, entry], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let files: string[] | null = null;
      let ready = false;
      const deadline = Date.now() + 12_000;
      while ((files === null || !ready) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        const match = buf.match(/FILES:(.*)/);
        if (match && files === null) files = JSON.parse(match[1]) as string[];
        if (buf.includes("READY")) ready = true;
      }
      expect(files).toEqual([entry, helper].sort());
      // READY is printed after startViewReapply subscribes: editing before
      // the watch exists loses the event (FILES is printed before the
      // subscription, so it cannot gate the edit on slow/loaded runners).
      expect(ready).toBe(true);
      for (const file of files ?? []) {
        expect(existsSync(file)).toBe(true);
      }
      writeFileSync(helper, `export const label = "B";\n`);
      await proc.exited;
      let tail = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        tail += decoder.decode(value);
      }
      reader.releaseLock();
      const errText = await new Response(proc.stderr).text();
      expect(errText).not.toMatch(/error/i);
      const callsMatch = (buf + tail).match(/CALLS:(\d+)/);
      expect(callsMatch?.[1]).toBe("1");
    } finally {
      proc.kill();
    }
  }, 20_000);

  test("an update with an unchanged graph schedules no follow-up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-view-reapply-sameset-"));
    tempDirs.push(dir);
    const configPath = join(dir, "lobu.config.ts");
    const file = join(dir, "pipeline.tsx");
    writeFileSync(file, "v1");
    let calls = 0;
    const loop = startViewReapply(
      { configPath, files: [file] },
      { onChange: async () => calls++ }
    );
    try {
      // Let the fresh subscription settle past one debounce window: the
      // initial file creation can coalesce into a first event on some
      // platforms. Only the update's own effect is under test.
      await sleep(1100);
      calls = 0;
      loop.update({ configPath, files: [file] });
      await sleep(1200);
      expect(calls).toBe(0);
    } finally {
      loop.close();
    }
  });

  // Round-3 F9: a dependency that joins the watch set during an apply must
  // reconcile edits that landed before its subscription existed. helper-b.ts
  // starts on disk at revision A but unwatched; the entry save triggers an
  // apply that captures A, then helper-b.ts is saved as B mid-apply (no
  // file event fires — it is not subscribed yet). Once the apply installs the
  // new subscriptions, the loop must deploy B on its own, with no third
  // save; the reconciled graph then stays quiet.
  test("a new dependency edited mid-apply converges without a third save", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lobu-view-reapply-newdep-"));
    tempDirs.push(dir);
    const configPath = join(dir, "lobu.config.ts");
    const entry = join(dir, "pipeline.tsx");
    const helper = join(dir, "helper-b.ts");
    writeFileSync(entry, "init");
    writeFileSync(helper, "A");
    const applied: string[] = [];
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let loop!: ReturnType<typeof startViewReapply>;
    async function onChange() {
      startedResolve();
      // Artifact capture happens up front (the real bundler reads disk
      // here); hold the sink to model delivery latency.
      const snapshot = readFileSync(helper, "utf8");
      await sleep(300);
      applied.push(snapshot);
      // The dev.ts post-apply step on the same coordinator: the entry's new
      // import joins the set after this apply.
      loop.update({ configPath, files: [entry, helper] });
    }
    loop = startViewReapply({ configPath, files: [entry] }, { onChange });
    try {
      writeFileSync(entry, "entry-imports-helper-b");
      await Promise.race([
        started,
        sleep(5000).then(() => {
          throw new Error("apply A never started");
        }),
      ]);
      await sleep(100);
      writeFileSync(helper, "B");
      const deadline = Date.now() + 8000;
      while (applied.length < 2 && Date.now() < deadline) await sleep(100);
      // No third save anywhere: B must deploy on its own reconciliation.
      expect(applied).toEqual(["A", "B"]);
      // The reconciling apply's own graph is stable: exactly one follow-up,
      // no unbounded chain.
      await sleep(1800);
      expect(applied).toEqual(["A", "B"]);
    } finally {
      loop.close();
    }
  }, 20_000);
});
