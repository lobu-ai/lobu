import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverArtifact = join(root, "dist/runtime-components/server");

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const PROBE_SOURCE = `import { defineView } from "@lobu/views";
export const view = defineView({ key: "probe", attach: [], params: {}, actions: {} });
export default function Board() { return <div>REVIEW_VIEW_RENDERED</div>; }
`;

/**
 * The installable server runtime must vendor the real @lobu/views package:
 * the server-owned compile bootstrap imports its Provider unconditionally,
 * and the release composer used to delete every @lobu dependency except core
 * and connector-sdk. Without the vendored copy, source-only views fail with
 * `Could not resolve "@lobu/views"` on the installed server while workspace
 * installs keep working.
 */
describe("composed server runtime vendors @lobu/views", () => {
  test("server manifest, vendor copy and isolated source compile", async () => {
    for (const prerequisite of [
      "packages/server/dist/server.bundle.mjs",
      "packages/views/dist/index.js",
      "packages/core/dist/index.js",
    ]) {
      if (!existsSync(join(root, prerequisite))) {
        throw new Error(
          `missing build prerequisite ${prerequisite}: build the workspace before running this artifact test`
        );
      }
    }
    const { buildRuntimeComponents } = await import(
      "../runtime-components.mjs"
    );
    await buildRuntimeComponents();

    const manifest = JSON.parse(
      await readFile(join(serverArtifact, "package.json"), "utf8")
    );
    expect(manifest.dependencies["@lobu/views"]).toBe("file:vendor/views");
    // Real dist, not a stub: the package entry and its peer-closure roots.
    const vendorPkg = JSON.parse(
      await readFile(join(serverArtifact, "vendor/views/package.json"), "utf8")
    );
    expect(vendorPkg.name).toBe("@lobu/views");
    for (const entry of ["dist/index.js", "dist/index.d.ts"]) {
      expect(
        existsSync(join(serverArtifact, "vendor/views", entry)),
        `vendor/views missing ${entry}`
      ).toBe(true);
    }
    expect(manifest.dependencies.react).toBeTruthy();
    expect(manifest.dependencies["react-dom"]).toBeTruthy();

    // Compile an ordinary source view outside the monorepo, resolving only
    // through the composed artifact plus supplied non-workspace deps.
    const scratch = await mkdtemp(join(tmpdir(), "lobu-views-vendor-"));
    directories.push(scratch);
    await mkdir(join(scratch, "node_modules", "@lobu"), { recursive: true });
    const nm = join(scratch, "node_modules");
    const vendor = join(serverArtifact, "vendor");
    await symlink(join(vendor, "views"), join(nm, "@lobu", "views"));
    await symlink(join(vendor, "core"), join(nm, "@lobu", "core"));
    for (const dep of ["react", "react-dom", "scheduler", "esbuild"]) {
      await symlink(join(root, "node_modules", dep), join(nm, dep));
    }
    const esbuild = await import(
      join(root, "node_modules/esbuild/lib/main.js")
    ).then((m) => m.default ?? m);
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: ["packages/server/src/views/views.ts"],
      outfile: join(scratch, "compiler.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      plugins: [
        {
          name: "external-lobu",
          setup(build: {
            onResolve: (
              opts: { filter: RegExp },
              cb: (args: {
                path: string;
              }) => { path: string; external: true } | null
            ) => void;
          }) {
            build.onResolve({ filter: /^(@lobu\/|esbuild$)/ }, (args) => ({
              path: args.path,
              external: true,
            }));
          },
        },
      ],
    });
    await writeFile(
      join(scratch, "runner.mjs"),
      `import { compileView } from "./compiler.mjs";\ntry {\n  const out = await compileView(${JSON.stringify(PROBE_SOURCE)});\n  console.log(JSON.stringify({ ok: true, bytes: out.length, marker: out.includes("REVIEW_VIEW_RENDERED") }));\n} catch (err) {\n  console.log(JSON.stringify({ ok: false, message: String(err?.message ?? err).split("\\n").slice(0, 4).join(" | ") }));\n}\n`
    );
    const run = spawnSync(process.execPath, ["runner.mjs"], {
      cwd: scratch,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
    expect(result).toMatchObject({ ok: true, marker: true });
    expect(result.bytes).toBeGreaterThan(100000);
  }, 600000);
});
