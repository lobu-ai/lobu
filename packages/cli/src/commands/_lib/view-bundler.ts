/**
 * Bundle a Lobu view module for the browser and extract its metadata.
 *
 * The module shape is exactly one: `export const view = defineView({ key,
 * attach, … })` plus a default-export component (hooks inside, no document
 * access). Two esbuild passes over the same module:
 *  1. browser IIFE bundle of a SYNTHETIC entry that mounts the two exports
 *     (`mountView(view, Default)`) — what the server stores as
 *     `compiled_code` and inlines into the view shell. Bundled here, where
 *     the project's node_modules exists (the same path custom connectors
 *     use), because the server has no file context for relative imports or
 *     view npm deps. The server compiles plain sources itself through the
 *     same mount on its own bootstrap.
 *  2. a node bundle of the module in which `@lobu/views` is replaced by a
 *     stub, imported only to read the `view` export — so `key`/`attach`/
 *     `params`/`actions` come from the module itself. The attach line lives
 *     in the file, never in the config.
 *
 * Anything else (no `view` export, no default component, bad key) fails loud
 * here rather than rendering a blank frame in prod.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";

export interface ViewMetadata {
  key: string;
  attach: Array<Record<string, unknown>>;
  params: Record<string, unknown>;
  actions: Record<string, { emits: string }>;
}

export interface BundledView {
  compiledCode: string;
  metadata: ViewMetadata;
}

const VIEW_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const RUNTIME_MODULE_RE = /(^|\/)lobu-views(\.tsx?)?$|^@lobu\/views$/;

const metadataStub: Plugin = {
  name: "lobu-views-metadata-stub",
  setup(b) {
    b.onResolve({ filter: RUNTIME_MODULE_RE }, () => ({
      path: "lobu-views-stub",
      namespace: "lobu-views-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "lobu-views-stub" }, () => ({
      loader: "js",
      contents: `
        export function defineView(def) {
          if (!def || typeof def.key !== "string" || !def.key) {
            throw new Error("defineView({ key, attach, ... }) requires a non-empty key");
          }
          return def;
        }
        export function mountView() { throw new Error("mountView is not called by view modules: export const view = defineView({ ... }) plus a default-export component"); }
        const noHook = () => { throw new Error("hooks are not available at metadata-extraction time"); };
        export const useParams = noHook, useScope = noHook, useHost = noHook,
          useQuery = noHook, useAction = noHook;
        export function Provider() { throw new Error("not available at metadata-extraction time"); }
        export function sql(strings, ...values) { return { kind: "sql", text: String(strings[0] ?? "") }; }
        export function tool(name, args = {}) { return { kind: "tool", name, args }; }
        export function escapeLiteral(value) { return String(value); }
        export const defaultsFor = () => ({}), coerceParams = (_def, raw) => raw ?? {};
      `,
    }));
  },
};

interface ViewModuleNamespace {
  view?: Partial<ViewMetadata>;
  default?: unknown;
}

function readViewExport(
  ns: unknown,
  entry: string
): {
  view: Omit<Partial<ViewMetadata>, "key"> & { key: string };
  hasDefault: boolean;
} {
  const view = (ns as ViewModuleNamespace)?.view;
  if (!view || typeof view !== "object") {
    throw new Error(
      `${entry}: the module must export const view = defineView({ key, attach, ... })`
    );
  }
  const { key } = view;
  if (typeof key !== "string" || !key) {
    throw new Error(
      `${entry}: defineView({ key, attach, ... }) requires a non-empty key`
    );
  }
  return {
    view: { ...view, key },
    hasDefault: typeof (ns as ViewModuleNamespace)?.default === "function",
  };
}

/**
 * Bundle the view at `entry` (absolute path) for the browser. Throws when the
 * module has no `view` export, no default-export component, or an invalid
 * key — all fail loud at apply time, never as a blank frame.
 */
export async function bundleViewFromFile(entry: string): Promise<BundledView> {
  const dir = dirname(resolve(entry));
  const rel = `./${basename(entry)}`;
  const browser = await build({
    stdin: {
      contents: `import { mountView } from "@lobu/views";\nimport * as mod from ${JSON.stringify(rel)};\nmountView(mod.view, mod.default);\n`,
      loader: "tsx",
      resolveDir: dir,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    jsx: "automatic",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const compiledCode = browser.outputFiles?.[0]?.text ?? "";
  if (!compiledCode) {
    throw new Error(`${entry}: view bundle compiled to empty output`);
  }
  assertBundlePortable(compiledCode, entry);

  const node = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: ["node22"],
    jsx: "automatic",
    plugins: [metadataStub],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const tmp = await mkdtemp(join(tmpdir(), "lobu-view-meta-"));
  try {
    const file = join(tmp, "view.mjs");
    await writeFile(file, node.outputFiles?.[0]?.text ?? "");
    // A fresh temp path per call, so the ESM cache never returns a stale module.
    const ns: unknown = await import(pathToFileURL(file).href);
    const { view: def, hasDefault } = readViewExport(ns, entry);
    if (!hasDefault) {
      throw new Error(
        `${entry}: the module must have a default-export component`
      );
    }
    if (!VIEW_KEY_RE.test(def.key)) {
      throw new Error(
        `${entry}: defineView key ${JSON.stringify(def.key)} must match /^[a-z0-9][a-z0-9-]{0,63}$/`
      );
    }
    return {
      compiledCode,
      metadata: {
        key: def.key,
        attach: Array.isArray(def.attach) ? def.attach : [],
        params:
          def.params && typeof def.params === "object"
            ? (def.params as Record<string, unknown>)
            : {},
        actions:
          def.actions && typeof def.actions === "object"
            ? (def.actions as Record<string, { emits: string }>)
            : {},
      },
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
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
  const suspects: string[] = [entry, dirname(entry)];
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) suspects.push(home);
  for (const suspect of suspects) {
    if (suspect && compiledCode.includes(suspect)) {
      throw new Error(
        `view bundle embeds the local path ${JSON.stringify(suspect)} — bundles must be portable`
      );
    }
  }
  const encoded = compiledCode.match(/file:\/\/[^"'\s]*/g) ?? [];
  for (const url of encoded) {
    // A browser bundle has no business with file URLs: any of them embeds a
    // build-machine path (or its encoding), so reject the bundle outright
    // rather than trying to tell ours from a legitimate one.
    throw new Error(
      `view bundle embeds a file URL ${JSON.stringify(url)} — bundles must be portable`
    );
  }
}
