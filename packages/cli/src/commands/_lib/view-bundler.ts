/**
 * Bundle a Lobu view module for the browser and extract its metadata.
 *
 * The module shape is exactly one: `export const view = defineView({ key,
 * attach, … })` plus a default-export component (hooks inside, no document
 * access). One esbuild pass, plus a read of the declaration:
 *  1. browser IIFE bundle of a SYNTHETIC entry that mounts the two exports
 *     (`mountView(view, Default)`) — what the server stores as
 *     `compiled_code` and inlines into the view shell after its runtime
 *     script. React and `@lobu/views` come from that runtime, never the
 *     bundle (`@lobu/core/contracts/tools/view-runtime`), and the entry,
 *     options and runtime plugin are shared with the server. Bundled here,
 *     where the project's node_modules exists, so a view can also bundle npm
 *     deps the server cannot build.
 *  2. the entry's `defineView({...})` literal, read without running the module
 *     by the same `readViewDefinition` the server uses on save, so the CLI's
 *     plan hashes exactly what the server stores. The declaration lives in the
 *     file, never in the config.
 *
 * Anything else (no `view` export, no default component, a non-literal
 * declaration) fails loud here rather than rendering a blank frame in prod.
 */
import { basename, dirname, resolve } from "node:path";
import type { RetainedSource } from "@lobu/core/contracts/tools/source-files";
import {
  readViewDefinition,
  type ViewDefinitionRecord,
} from "@lobu/core/contracts/tools/view-definition";
import {
  VIEW_BUILD_OPTIONS,
  VIEW_RUNTIME_MODULES,
  viewMountEntry,
  viewRuntimePlugin,
} from "@lobu/core/contracts/tools/view-runtime";
import { build, type Metafile, transform } from "esbuild";
import { createSourceCapture } from "../../internal/connector-compiler.js";

export interface BundledView extends RetainedSource {
  compiledCode: string;
  definition: ViewDefinitionRecord;
}

/**
 * Bundle the view at `entry` (absolute path) for the browser. Throws when the
 * module has no `view` export, no default-export component, or an invalid
 * key — all fail loud at apply time, never as a blank frame.
 */
export async function bundleViewFromFile(
  entry: string,
  projectRoot: string
): Promise<BundledView> {
  const dir = dirname(resolve(entry));
  const rel = `./${basename(entry)}`;
  const capture = createSourceCapture(entry, projectRoot);
  const browser = await build({
    ...VIEW_BUILD_OPTIONS,
    plugins: [capture.plugin, viewRuntimePlugin()],
    stdin: { contents: viewMountEntry(rel), loader: "js", resolveDir: dir },
  });
  const compiledCode = browser.outputFiles?.[0]?.text ?? "";
  if (!compiledCode) {
    throw new Error(`${entry}: view bundle compiled to empty output`);
  }
  assertBundlePortable(compiledCode, entry);

  const source = capture.source();
  const entrySource = source.sourceFiles.files[source.sourceFiles.entrypoint];
  if (entrySource === undefined) {
    throw new Error(`${entry}: the view entry was not captured`);
  }
  let definition: ViewDefinitionRecord;
  try {
    const { code } = await transform(entrySource, {
      loader: "tsx",
      jsx: "automatic",
      logLevel: "silent",
    });
    definition = readViewDefinition(code);
  } catch (error) {
    throw new Error(`${entry}: ${(error as Error).message}`);
  }
  return { compiledCode, ...source, definition };
}

/**
 * The `lobu run` watch set for one view: the entry plus every file esbuild
 * pulled in (relative components, shared lib), from the metafile — so editing
 * an imported file rebuilds the view. Returned as absolute paths.
 */
export async function collectViewWatchFiles(entry: string): Promise<string[]> {
  // The build directory is explicit and absolute: metafile input names are
  // relative to it, so they must be resolved against this exact directory.
  // Previously the build ran with an implicit ambient cwd while inputs were
  // resolved against the entry directory, duplicating path segments for
  // views below the project root and registering nonexistent watch paths.
  const workdir = dirname(resolve(entry));
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: workdir,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: [...VIEW_RUNTIME_MODULES],
    jsx: "automatic",
    metafile: true,
    logLevel: "silent",
  });
  const metafile: Metafile | undefined = result.metafile;
  if (!metafile) return [resolve(entry)];
  const files = new Set<string>([resolve(entry)]);
  for (const input of Object.keys(metafile.inputs)) {
    // Absolute keys pass through; relative keys are relative to workdir.
    files.add(resolve(workdir, input));
  }
  return [...files].sort();
}

/**
 * Generated bundles must be portable: no developer home, checkout, or worktree
 * directory may leak into the shipped bytes (or the stored view breaks on any
 * other machine and leaks machine state). esbuild emits relative names by
 * default; this is the backstop that fails the apply when it does not.
 */
export function assertBundlePortable(
  compiledCode: string,
  entry: string
): void {
  // Decode percent escapes individually: a JavaScript bundle can also contain
  // literal percent signs, so decoding the whole bundle as a URI would throw.
  const decodedCode = compiledCode.replace(/%([0-9a-f]{2})/gi, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  const suspects: string[] = [entry, dirname(entry)];
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) suspects.push(home);
  for (const suspect of suspects) {
    if (
      suspect &&
      (compiledCode.includes(suspect) || decodedCode.includes(suspect))
    ) {
      throw new Error(
        `view bundle embeds the local path ${JSON.stringify(suspect)} — bundles must be portable`
      );
    }
  }
  const encoded = decodedCode.match(/file:\/\/[^"'\s]*/gi) ?? [];
  for (const url of encoded) {
    // A browser bundle has no business with file URLs: any of them embeds a
    // build-machine path (or its encoding), so reject the bundle outright
    // rather than trying to tell ours from a legitimate one.
    throw new Error(
      `view bundle embeds a file URL ${JSON.stringify(url)} — bundles must be portable`
    );
  }
}
