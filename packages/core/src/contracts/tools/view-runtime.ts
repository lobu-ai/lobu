/**
 * The view runtime contract: React, React DOM and `@lobu/views` are supplied
 * by the view shell, never bundled into a view. The server builds them once
 * from its own installation and inlines that script ahead of every view
 * bundle as `globalThis[VIEW_RUNTIME_GLOBAL]`; each view bundle reads its
 * runtime imports off that global. A runtime fix reaches views using this
 * contract on the next deploy, without re-saving them. A self-contained
 * bundle from before the contract is rebuilt from its retained source the
 * first time it is served (`getServedView`), or keeps running as is.
 *
 * Every view compiler builds through these pieces — the server on save and on
 * a served rebuild, and `lobu apply` in the author's checkout — so the same
 * retained source compiles to the same bundle wherever it is built.
 */

/** Global the shell's runtime script assigns and every view bundle reads. */
export const VIEW_RUNTIME_GLOBAL = "__lobuViews";

/** Module specifiers a view imports from the shell runtime. */
export const VIEW_RUNTIME_MODULES: readonly string[] = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@lobu/views",
  "@lobu/views/components",
];

/** Packages behind {@link VIEW_RUNTIME_MODULES}. A view whose retained
 *  dependencies are all among these needs nothing but its own source files
 *  to compile, so the server can build it. */
export const VIEW_RUNTIME_PACKAGES: readonly string[] = [
  "react",
  "react-dom",
  "@lobu/views",
];

const RUNTIME_NAMESPACE = "lobu-view-runtime";

/** Entry source that mounts the module at `specifier` through the runtime's
 *  `mountView`: its `view` declaration and default-export component. */
export function viewMountEntry(specifier: string): string {
  return `import { mountView } from "@lobu/views";\nimport * as mod from ${JSON.stringify(specifier)};\nmountView(mod.view, mod.default);\n`;
}

/** Entry source for the shell runtime script: every runtime module, keyed by
 *  specifier on the runtime global. */
export function viewRuntimeEntry(): string {
  const imports = VIEW_RUNTIME_MODULES.map(
    (specifier, i) => `import * as m${i} from ${JSON.stringify(specifier)};`
  );
  const entries = VIEW_RUNTIME_MODULES.map(
    (specifier, i) => `${JSON.stringify(specifier)}: m${i}`
  );
  return `${imports.join("\n")}\nglobalThis[${JSON.stringify(VIEW_RUNTIME_GLOBAL)}] = Object.freeze({ ${entries.join(", ")} });\n`;
}

/** esbuild options every view bundle and the runtime script share. */
export const VIEW_BUILD_OPTIONS = {
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "silent",
} as const;

interface RuntimePluginBuild {
  onResolve(
    options: { filter: RegExp },
    callback: (args: {
      path: string;
    }) => { path: string; namespace: string } | undefined
  ): void;
  onLoad(
    options: { filter: RegExp; namespace: string },
    callback: (args: { path: string }) => { contents: string; loader: "js" }
  ): void;
}

/**
 * esbuild plugin resolving each runtime module to a shim that reads it off
 * the runtime global, so the bundle carries none of the runtime. Structurally
 * typed: core does not depend on esbuild.
 */
export function viewRuntimePlugin(): {
  name: string;
  setup(build: RuntimePluginBuild): void;
} {
  return {
    name: "lobu-view-runtime",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) =>
        VIEW_RUNTIME_MODULES.includes(args.path)
          ? { path: args.path, namespace: RUNTIME_NAMESPACE }
          : undefined
      );
      build.onLoad({ filter: /.*/, namespace: RUNTIME_NAMESPACE }, (args) => ({
        contents: `module.exports = globalThis[${JSON.stringify(VIEW_RUNTIME_GLOBAL)}][${JSON.stringify(args.path)}];`,
        loader: "js",
      }));
    },
  };
}
