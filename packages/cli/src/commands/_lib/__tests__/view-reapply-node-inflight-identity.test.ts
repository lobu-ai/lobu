import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Round-7 F12: a second atomic replacement of the SAME path during a held
// apply is invisible to the old Node per-file subscription (it stays attached
// to the replaced inode). The recollected graph returns the same paths, so
// only native file-identity comparison can request the follow-up. This test
// runs the real startViewReapplyLoop under the shipped Node runtime with only
// the apply-command sink replaced (fixed non-production URL, no
// server/DB/network). It covers both orderings:
//
//   - valid ATOMIC-A held in flight, then valid RECOVERED;
//   - invalid atomic held in flight (failed completion), then valid RECOVERED.
//
// Each ordering must converge to the RECOVERED compiled bytes with no config
// touch, then stay quiet; close must remain terminal, including
// close-while-in-flight.
describe("view reapply Node in-flight same-path identity (F12)", () => {
  test("valid->valid and invalid->corrected converge without config touch", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../../..");
    const scratch = mkdtempSync(join(tmpdir(), "lobu-f12-node-"));
    try {
      const driver = join(scratch, "f12-node-driver.mjs");
      writeFileSync(
        driver,
        [
          `import { mkdirSync, writeFileSync, readFileSync, symlinkSync, renameSync } from "node:fs";`,
          `import { pathToFileURL } from "node:url";`,
          `import { createHash } from "node:crypto";`,
          `const root = process.argv[2];`,
          `const scratch = process.argv[3];`,
          `try { symlinkSync(root + "/node_modules", scratch + "/node_modules"); } catch (e) { if (e.code !== "EEXIST") throw e; }`,
          `const { build } = await import(pathToFileURL(root + "/node_modules/esbuild/lib/main.js").href);`,
          `await build({ stdin: { contents: 'export { startViewReapplyLoop } from "' + root + '/packages/cli/src/commands/dev.ts";export { bundleViewFromFile } from "' + root + '/packages/cli/src/commands/_lib/view-bundler.ts";', resolveDir: root, loader: "ts" }, outfile: scratch + "/f12-runtime.mjs", bundle: true, platform: "node", format: "esm", packages: "external", target: "node22", logLevel: "silent", plugins: [{ name: "controlled-apply-sink", setup(b) { b.onResolve({ filter: /apply\\/apply-cmd\\.js$/ }, () => ({ path: "controlled-apply", namespace: "f12-sink" })); b.onLoad({ filter: /.*/, namespace: "f12-sink" }, () => ({ contents: "export async function applyCommand(opts){return globalThis.__f12apply(opts);}", loader: "js" })); } }] });`,
          `const { startViewReapplyLoop, bundleViewFromFile } = await import(pathToFileURL(scratch + "/f12-runtime.mjs").href);`,
          `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
          `const sha = (s) => createHash("sha256").update(s).digest("hex");`,
          `const source = (revision) => 'export const view={key:"probe",attach:[]};export default function V(){return ' + JSON.stringify(revision) + ';}';`,
          `const fail = (msg, extra) => { console.error("F12-FAIL: " + msg + (extra ? " " + JSON.stringify(extra).slice(0, 2000) : "")); process.exit(1); };`,
          `async function until(test, label, budget = 15000) { const end = Date.now() + budget; while (!test()) { if (Date.now() > end) fail("timed out waiting for " + label); await sleep(100); } }`,
          `for (const kind of ["valid", "invalid"]) {`,
          `  const project = scratch + "/" + kind + "-project";`,
          `  mkdirSync(project + "/views", { recursive: true });`,
          `  try { symlinkSync(root + "/node_modules", project + "/node_modules"); } catch (e) { if (e.code !== "EEXIST") throw e; }`,
          `  const entry = project + "/views/probe.ts";`,
          `  const config = project + "/lobu.config.ts";`,
          `  const conf = 'import {defineConfig,defineAgent,viewFromFile} from "@lobu/cli/config";export default defineConfig({agents:[defineAgent({id:"triage",name:"Triage"})],views:[viewFromFile("./views/probe.ts")]});';`,
          `  writeFileSync(config, conf);`,
          `  writeFileSync(entry, source("INITIAL"));`,
          `  const attempts = [];`,
          `  const applied = [];`,
          `  let hold = false, held = false;`,
          `  let release;`,
          `  let releasePromise = new Promise((r) => { release = r; });`,
          `  let capturedResolve;`,
          `  const capturedPromise = new Promise((r) => { capturedResolve = r; });`,
          `  const atomic = (text) => { writeFileSync(entry + ".tmp", text); renameSync(entry + ".tmp", entry); };`,
          `  globalThis.__f12apply = async (opts) => {`,
          `    if (opts.url !== "http://127.0.0.1:1" || opts.cwd !== project) throw new Error("unexpected target");`,
          `    const text = readFileSync(entry, "utf8");`,
          `    attempts.push(text);`,
          `    let artifact, error;`,
          `    try { artifact = await bundleViewFromFile(entry); } catch (e) { error = e; }`,
          `    if (hold && !held) { held = true; capturedResolve({ failed: Boolean(error) }); await releasePromise; }`,
          `    if (error) throw error;`,
          `    applied.push({ text, digest: sha(artifact.compiledCode) });`,
          `  };`,
          `  const loop = await startViewReapplyLoop(project, "http://127.0.0.1:1", "f12-fixture");`,
          `  try {`,
          `    await sleep(1100);`,
          `    writeFileSync(entry, source("BASELINE"));`,
          `    await until(() => applied.length === 1, kind + " baseline apply");`,
          `    await sleep(1000);`,
          `    hold = true;`,
          `    atomic(kind === "invalid" ? "export const view = {" : source("ATOMIC-A"));`,
          `    // Poll the held flag: a Promise.race timeout sleep would outlive`,
          `    // the race and fire during the next iteration with a stale message.`,
          `    await until(() => held, kind + " held apply after-bundle gate");`,
          `    await sleep(100);`,
          `    atomic(source("RECOVERED"));`,
          `    await sleep(100);`,
          `    release();`,
          `    await until(() => applied.some((a) => a.text.includes("RECOVERED")), kind + " RECOVERED convergence without config touch");`,
          `    const disk = await bundleViewFromFile(entry);`,
          `    const last = applied[applied.length - 1];`,
          `    if (last.digest !== sha(disk.compiledCode)) fail(kind + " last applied bytes differ from disk", { last: last.digest, disk: sha(disk.compiledCode) });`,
          `    if (!last.text.includes("RECOVERED")) fail(kind + " last applied text is not RECOVERED");`,
          `    if (readFileSync(config, "utf8") !== conf) fail(kind + " config was touched");`,
          `    const quiet = attempts.length;`,
          `    await sleep(1600);`,
          `    if (attempts.length !== quiet) fail(kind + " loop did not reach quiescence", { before: quiet, after: attempts.length });`,
          `    loop.close();`,
          `    writeFileSync(entry, source("POST-CLOSE"));`,
          `    await sleep(1500);`,
          `    if (attempts.length !== quiet) fail(kind + " close was not terminal", { before: quiet, after: attempts.length });`,
          `  } finally { try { release(); } catch {} try { loop.close(); } catch {} }`,
          `}`,
          `// Close-while-in-flight: the held apply completes but schedules nothing further.`,
          `const cProject = scratch + "/close-project";`,
          `mkdirSync(cProject + "/views", { recursive: true });`,
          `try { symlinkSync(root + "/node_modules", cProject + "/node_modules"); } catch (e) { if (e.code !== "EEXIST") throw e; }`,
          `const cEntry = cProject + "/views/probe.ts";`,
          `const cConfig = cProject + "/lobu.config.ts";`,
          `const cConf = 'import {defineConfig,defineAgent,viewFromFile} from "@lobu/cli/config";export default defineConfig({agents:[defineAgent({id:"triage",name:"Triage"})],views:[viewFromFile("./views/probe.ts")]});';`,
          `writeFileSync(cConfig, cConf);`,
          `writeFileSync(cEntry, source("INITIAL"));`,
          `const cAttempts = [];`,
          `const cApplied = [];`,
          `let cHold = false, cHeld = false;`,
          `let cRelease;`,
          `const cReleasePromise = new Promise((r) => { cRelease = r; });`,
          `let cCapturedResolve;`,
          `const cCaptured = new Promise((r) => { cCapturedResolve = r; });`,
          `globalThis.__f12apply = async (opts) => {`,
          `  if (opts.cwd !== cProject) throw new Error("unexpected target");`,
          `  const text = readFileSync(cEntry, "utf8");`,
          `  cAttempts.push(text);`,
          `  const artifact = await bundleViewFromFile(cEntry);`,
          `  if (cHold && !cHeld) { cHeld = true; cCapturedResolve(true); await cReleasePromise; }`,
          `  cApplied.push({ text, digest: sha(artifact.compiledCode) });`,
          `};`,
          `const cLoop = await startViewReapplyLoop(cProject, "http://127.0.0.1:1", "f12-close");`,
          `try {`,
          `  await sleep(1100);`,
          `  writeFileSync(cEntry, source("BASELINE"));`,
          `  await until(() => cApplied.length === 1, "close baseline");`,
          `  await sleep(1000);`,
          `  cHold = true;`,
          `  writeFileSync(cEntry, source("MID"));`,
          `  await until(() => cHeld, "close-while-in-flight after-bundle gate");`,
          `  cLoop.close();`,
          `  cRelease();`,
          `  await sleep(2000);`,
          `  if (cApplied.length !== 2 || !cApplied[1].text.includes("MID")) fail("in-flight apply did not complete after close", { applied: cApplied.length });`,
          `  const cQuiet = cAttempts.length;`,
          `  await sleep(1200);`,
          `  if (cAttempts.length !== cQuiet) fail("closed loop restarted", { before: cQuiet, after: cAttempts.length });`,
          `} finally { try { cRelease(); } catch {} try { cLoop.close(); } catch {} }`,
          `console.log(JSON.stringify({ ok: true }));`,
          ``,
        ].join("\n")
      );
      const proc = Bun.spawn(["node", driver, repoRoot, scratch], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({
        exitCode,
        stdoutTail: stdout.slice(-2000),
        stderrTail: stderr.slice(-2000),
      }).toEqual(expect.objectContaining({ exitCode: 0 }));
      expect(stdout).toMatch(/"ok":true/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
