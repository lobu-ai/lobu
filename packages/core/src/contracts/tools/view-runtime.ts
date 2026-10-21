/**
 * The shell publishes React, React DOM and `@lobu/views` on `__lobuViews`
 * before executing the view bundle. Existing server and CLI compilers still
 * produce self-contained bundles; this prepares the shell for bundles that
 * consume the shared runtime.
 */

const VIEW_RUNTIME_GLOBAL = "__lobuViews";

/** Module specifiers a view imports from the shell runtime. */
export const VIEW_RUNTIME_MODULES: readonly string[] = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@lobu/views",
  "@lobu/views/components",
];

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

/** esbuild options for the shell runtime script. */
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
