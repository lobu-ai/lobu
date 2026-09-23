import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Round-6 F11: an invalid atomic save replacing an existing watched view must
// not leave the Node fs.watch attached to the old inode. The dev loop must
// reopen subscriptions even when graph collection fails, so the corrected
// atomic save reapplies without a config touch. This test runs the real
// startViewReapplyLoop under the shipped Node runtime (existing watch tests
// run under Bun, where the same sequence recovers).
//
// The Node driver bundles the actual dev.ts + view-bundler.ts from this
// checkout with only the apply-command sink replaced (fixed non-production
// URL, no server/DB/network). It asserts: baseline applies, invalid atomic
// save does not apply, corrected atomic save applies with no config edit,
// quiescence follows, and close is terminal.
describe("view reapply Node atomic-save recovery (F11)", () => {
  test("corrected atomic save reapplies without config touch", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../../..");
    const scratch = mkdtempSync(join(tmpdir(), "lobu-f11-node-"));
    try {
      const driver = join(scratch, "f11-node-driver.mjs");
      writeFileSync(
        driver,
        [
          `import { mkdirSync, writeFileSync, readFileSync, symlinkSync, renameSync } from "node:fs";`,
          `import { pathToFileURL } from "node:url";`,
          `const root = process.argv[2];`,
          `const scratch = process.argv[3];`,
          `try { symlinkSync(root + "/node_modules", scratch + "/node_modules"); } catch (e) { if (e.code !== "EEXIST") throw e; }`,
          `const { build } = await import(pathToFileURL(root + "/node_modules/esbuild/lib/main.js").href);`,
          `await build({ stdin: { contents: 'export { startViewReapplyLoop } from "' + root + '/packages/cli/src/commands/dev.ts";export { bundleViewFromFile } from "' + root + '/packages/cli/src/commands/_lib/view-bundler.ts";', resolveDir: root, loader: "ts" }, outfile: scratch + "/f11-runtime.mjs", bundle: true, platform: "node", format: "esm", packages: "external", target: "node22", logLevel: "silent", plugins: [{ name: "controlled-apply-sink", setup(b) { b.onResolve({ filter: /apply\\/apply-cmd\\.js$/ }, () => ({ path: "controlled-apply", namespace: "f11-sink" })); b.onLoad({ filter: /.*/, namespace: "f11-sink" }, () => ({ contents: "export async function applyCommand(opts){return globalThis.__f11apply(opts);}", loader: "js" })); } }] });`,
          `const { startViewReapplyLoop, bundleViewFromFile } = await import(pathToFileURL(scratch + "/f11-runtime.mjs").href);`,
          `const project = scratch + "/project";`,
          `mkdirSync(project + "/views", { recursive: true });`,
          `try { symlinkSync(root + "/node_modules", project + "/node_modules"); } catch (e) { if (e.code !== "EEXIST") throw e; }`,
          `const entry = project + "/views/probe.ts";`,
          `const config = project + "/lobu.config.ts";`,
          `const conf = 'import {defineConfig,defineAgent,viewFromFile} from "@lobu/cli/config";export default defineConfig({agents:[defineAgent({id:"triage",name:"Triage"})],views:[viewFromFile("./views/probe.ts")]});';`,
          `const source = (revision) => 'export const view={key:"probe",attach:[]};export default function V(){return ' + JSON.stringify(revision) + ';}';`,
          `writeFileSync(config, conf);`,
          `writeFileSync(entry, source("INITIAL"));`,
          `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
          `const attempts = [];`,
          `const applied = [];`,
          `globalThis.__f11apply = async (opts) => { if (opts.url !== "http://127.0.0.1:1" || opts.cwd !== project) throw new Error("unexpected target"); const text = readFileSync(entry, "utf8"); attempts.push(text); const artifact = await bundleViewFromFile(entry, project); applied.push({ text, bytes: artifact.compiledCode.length }); };`,
          `const loop = await startViewReapplyLoop(project, "http://127.0.0.1:1", "f11-fixture");`,
          `const atomic = (text) => { writeFileSync(entry + ".tmp", text); renameSync(entry + ".tmp", entry); };`,
          `const fail = (msg, extra) => { console.error("F11-FAIL: " + msg + (extra ? " " + JSON.stringify(extra) : "")); process.exit(1); };`,
          `try {`,
          `  await sleep(1100);`,
          `  writeFileSync(entry, source("BASELINE"));`,
          `  await sleep(2300);`,
          `  if (attempts.length !== 1 || applied.length !== 1 || !applied[0].text.includes("BASELINE")) fail("baseline did not apply", { attempts: attempts.length, applied: applied.length });`,
          `  atomic("export const view = {");`,
          `  await sleep(2300);`,
          `  // Round-7 F12 tolerance: the invalid atomic rename changes native`,
          `  // file identity, so one finite failed follow-up may already exist.`,
          `  if (attempts.length < 2 || applied.length !== 1) fail("invalid-save counts unexpected", { attempts: attempts.length, applied: applied.length });`,
          `  atomic(source("RECOVERED"));`,
          `  await sleep(2800);`,
          `  if (attempts.length < 3) fail("corrected atomic save was invisible (attempts)", { attempts: attempts.length });`,
          `  if (applied.length < 2 || !applied[applied.length - 1].text.includes("RECOVERED")) fail("corrected artifact did not apply without config touch", { applied });`,
          `  const quiet = attempts.length;`,
          `  await sleep(1500);`,
          `  if (attempts.length !== quiet) fail("loop did not reach quiescence", { before: quiet, after: attempts.length });`,
          `  loop.close();`,
          `  writeFileSync(entry, source("POST-CLOSE"));`,
          `  await sleep(1500);`,
          `  if (attempts.length !== quiet) fail("close was not terminal", { before: quiet, after: attempts.length });`,
          `  console.log(JSON.stringify({ ok: true, attempts: attempts.length, applied: applied.length }));`,
          `} finally { try { loop.close(); } catch {} }`,
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
  }, 60_000);
});
