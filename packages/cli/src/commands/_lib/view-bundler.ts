/**
 * Bundle a Lobu view module for the browser and extract its metadata.
 *
 * Two esbuild passes over the same entry:
 *  1. browser IIFE bundle (React, `@lobu/views` and the view's deps inlined)
 *     — what the server stores as `compiled_code` and inlines into the view
 *     shell. Bundled here, where the project's node_modules exists (the same
 *     path custom connectors use), because the server has no file context for
 *     relative imports or view npm deps.
 *  2. a node bundle in which `@lobu/views` is replaced by a stub whose
 *     `mountView` records the `defineView` object instead of rendering, so
 *     `key`/`attach`/`params`/`actions` come from the module itself — the
 *     attach line lives in the file, never in the config.
 *
 * The module shape is exactly one: `mountView(defineView({ key, attach, … }),
 * Component)`. Anything else (a bare `view` export, no mount call) fails loud
 * here rather than rendering a blank frame in prod.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
        export function mountView(def, _component) { globalThis.__lobuViewDefinition = def; }
        const noHook = () => { throw new Error("hooks are not available at metadata-extraction time"); };
        export const useParams = noHook, useScope = noHook, useHost = noHook,
          useQuery = noHook, useAction = noHook;
        export function sql(strings, ...values) { return { kind: "sql", text: String(strings[0] ?? "") }; }
        export function tool(name, args = {}) { return { kind: "tool", name, args }; }
        export function escapeLiteral(value) { return String(value); }
        export const defaultsFor = () => ({}), coerceParams = (_def, raw) => raw ?? {};
      `,
    }));
  },
};

function readRecordedDefinition(): Partial<ViewMetadata> | undefined {
  return (globalThis as { __lobuViewDefinition?: unknown })
    .__lobuViewDefinition as Partial<ViewMetadata> | undefined;
}

/**
 * Bundle the view at `entry` (absolute path) for the browser. Throws when the
 * module never calls `mountView(defineView({ key, … }), …)` or the key is not
 * a valid view key — both fail loud at apply time, never as a blank frame.
 */
export async function bundleViewFromFile(entry: string): Promise<BundledView> {
  const browser = await build({
    entryPoints: [entry],
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
  const dir = await mkdtemp(join(tmpdir(), "lobu-view-meta-"));
  try {
    const file = join(dir, "view.mjs");
    await writeFile(file, node.outputFiles?.[0]?.text ?? "");
    const g = globalThis as { __lobuViewDefinition?: unknown };
    g.__lobuViewDefinition = undefined;
    // A fresh temp path per call, so the ESM cache never returns a stale module.
    await import(pathToFileURL(file).href);
    const def = readRecordedDefinition();
    if (!def || typeof def.key !== "string") {
      throw new Error(
        `${entry}: the module must call mountView(defineView({ key, attach, ... }), Component)`
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
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The `lobu run` watch set for one view: the entry plus every file esbuild
 * pulled in (relative components, shared lib), from the metafile — so editing
 * an imported file rebuilds the view. Returned as absolute paths.
 */
export async function collectViewWatchFiles(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    metafile: true,
    logLevel: "silent",
  });
  const metafile: Metafile | undefined = result.metafile;
  if (!metafile) return [entry];
  const dir = dirname(resolve(entry));
  const files = new Set<string>([resolve(entry)]);
  for (const input of Object.keys(metafile.inputs)) {
    files.add(resolve(dir, input));
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
  const lowerCode = compiledCode.toLowerCase();
  for (const suspect of suspects) {
    const encoded = suspect ? encodeURIComponent(suspect) : "";
    if (
      suspect &&
      (compiledCode.includes(suspect) ||
        lowerCode.includes(encoded.toLowerCase()))
    ) {
      throw new Error(
        `view bundle embeds the local path ${JSON.stringify(suspect)} — bundles must be portable`
      );
    }
  }
  const fileUrls =
    compiledCode.match(/(?:file:\/\/|file%3a(?:%2f){2})[^"'\s]*/gi) ?? [];
  for (const url of fileUrls) {
    // A browser bundle has no business with file URLs: any of them embeds a
    // build-machine path (or its encoding), so reject the bundle outright
    // rather than trying to tell ours from a legitimate one.
    throw new Error(
      `view bundle embeds a file URL ${JSON.stringify(url)} — bundles must be portable`
    );
  }
}
