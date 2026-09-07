import type { KnipConfig } from "knip";

const config: KnipConfig = {
  rules: {
    // `core/src/model-ids.ts` intentionally exports semantic aliases of the
    // same value (DEFAULT_AGENT_MODEL = the sonnet id, EGRESS_JUDGE_MODEL = the
    // haiku id). Those are meaningful names, not accidental duplication —
    // collapsing them would lose intent, so don't flag duplicate exports.
    duplicates: "off",
  },
  ignore: [
    // Submodule — cleaned up via its own repo / PR.
    "packages/owletto/**",
    // Codegen output (openapi-ts). Not hand-maintained; it intentionally emits
    // a superset of helpers, so "unused export" noise here is expected.
    "packages/client/src/generated/**",
  ],
  workspaces: {
    // Connector source files are loaded by file path
    // (scripts/lobu/install-connectors.ts), not imported as modules.
    "packages/connectors": {
      entry: ["src/*.ts", "src/**/*.test.ts", "src/__tests__/**/*.ts"],
    },
    "packages/connector-worker": {
      // package.json bin/main point at compiled dist/, so knip can't map them
      // back to source — list the real source entries here.
      entry: [
        "src/bin.ts",
        // Standalone arm64 Mach-O entrypoint invoked by the root Mac packaging
        // script; it is not part of the published connector-worker bin.
        "src/mac-device-daemon.ts",
        "src/daemon/index.ts",
        "src/compile-connector.ts",
        // The agent-session guest. esbuild resolves it by PATH at runtime
        // (agent-turn/bundle.ts) so it can be compiled for the isolate, which
        // is exactly the import knip cannot see.
        "src/agent-turn/guest-entry.ts",
        // Build step run from the package `build` script after tsc; it writes
        // the prebuilt guest bundle the published package ships.
        "src/agent-turn/build-guest-bundle.ts",
        "src/**/*.test.ts",
      ],
      ignoreDependencies: [
        // Native media/ML deps reached at runtime by connector bundles
        // (embeddings, image processing), not statically imported in src/.
        "@xenova/transformers",
        "jimp",
        "sharp",
      ],
    },
    "packages/connector-sdk": {
      entry: [
        "src/**/*.test.ts",
        "src/__tests__/**/*.ts",
        // Public subpath `@lobu/connector-sdk/identity-types` (package.json
        // exports) — a TypeBox schema module consumed by external connectors,
        // so its exports (e.g. the `$id`-registered MatchStrategy schema) have
        // no in-repo importer and must be treated as public API, not dead.
        "src/identity-types.ts",
        // Public subpaths `@lobu/connector-sdk/browser`, `/sources` and
        // `/device-manifest-hash` (package.json exports): the Node-only halves
        // of the SDK, kept off the isolate-safe root entry.
        "src/browser/index.ts",
        "src/sources/index.ts",
        "src/device-manifest-hash.ts",
      ],
      ignoreDependencies: [
        // Browser connector backend (CDP) — used under src/browser/, reached
        // at runtime not via the SDK's main entry graph.
        "playwright",
        // Type-only dep for the `tar` file source.
        "@types/tar",
      ],
    },
    "packages/device-connectors": {
      entry: ["src/index.ts", "src/**/*.test.ts"],
    },
    "packages/client": {
      // Generated openapi-ts client (ignored above) is the only consumer.
      ignoreDependencies: ["@hey-api/client-fetch"],
    },
    "packages/embeddings": {
      // main points at dist/; the source entries are index and the standalone
      // embeddings server. openai/embedding-utils are reached transitively from
      // those, so they don't need explicit entries.
      entry: ["src/index.ts", "src/server.ts", "src/**/*.test.ts"],
    },
    "packages/agent-worker": {
      // The publish bundler is invoked from the package's `build` script, not
      // imported, so knip can't reach it through the module graph.
      entry: ["src/index.ts", "scripts/build-worker-bundle.mjs"],
    },
    "packages/server": {
      entry: [
        // Bundle entry (esbuild). server-entry.ts is the Node-version gate that
        // dynamically imports the server-main bundle; server.ts is the graph it
        // loads. Both are esbuild entrypoints, so knip can't see them via imports.
        "src/server-entry.ts",
        "src/server.ts",
        // Sentry preload (node --import) and embedded-Postgres boot.
        "src/instrument.ts",
        "src/embedded-runtime.ts",
        "src/utils/assert-node-version.ts",
        // Reached via cross-workspace import from scripts/lobu/sync-local.ts.
        "src/lib/feed-sync.ts",
        // Dynamically imported at runtime by reaction-executor.
        "src/tools/admin/notify.ts",
        // Test suites run in CI (vitest + bun:test).
        "src/**/*.test.ts",
        "src/**/__tests__/**/*.ts",
        // esbuild bundler invoked as `node scripts/build-server-bundle.mjs`,
        // plus standalone `bun scripts/*.ts` helpers (offline OpenAPI emit).
        "scripts/**/*.mjs",
        "scripts/**/*.ts",
      ],
      ignoreDependencies: [
        // Activated by `vitest --coverage`.
        "@vitest/coverage-v8",
      ],
    },
    "packages/cli": {
      entry: [
        // Tests run via `bun test packages/cli` in CI (nested __tests__ dirs).
        "src/**/*.test.ts",
        "src/**/__tests__/**/*.ts",
        // Public config DSL — `defineAgent`/`defineConfig`/`defineConnector`/…
        // are imported by USER `lobu.config.ts` files outside this repo, so
        // knip can't see the consumers. As entry files their exports are
        // treated as the package's external API and not reported unused.
        "src/config/index.ts",
        "src/config/define.ts",
        "src/config/secret.ts",
        // Standalone native auth helper compiled into Owletto.app by the root
        // Mac packaging script; it is intentionally outside the npm `bin` map.
        "src/mac-auth.ts",
        // Build helper invoked as `node scripts/build.cjs`.
        "scripts/build.cjs",
      ],
      // The published `lobu` CLI is an umbrella: its build bundles @lobu/server
      // and @lobu/worker, so it re-declares THEIR runtime deps in its own
      // package.json (npm installs them for the bundled output). knip only sees
      // cli/src, which doesn't import these directly, so it flags them — but
      // every one is used by the bundled server/worker at runtime. Listed
      // explicitly so a real unused cli dep would still surface.
      ignoreDependencies: [
        "@aws-sdk/client-bedrock",
        "@aws-sdk/client-secrets-manager",
        "@chat-adapter/discord",
        "@chat-adapter/gchat",
        "@chat-adapter/slack",
        "@chat-adapter/teams",
        "@chat-adapter/telegram",
        "@chat-adapter/whatsapp",
        "@hono/node-server",
        "@hono/zod-openapi",
        "@lobu/embeddings",
        "@lobu/worker",
        "@mariozechner/pi-ai",
        "@modelcontextprotocol/sdk",
        "@opentelemetry/api",
        "@opentelemetry/exporter-trace-otlp-grpc",
        "@opentelemetry/resources",
        "@opentelemetry/sdk-trace-node",
        "@opentelemetry/semantic-conventions",
        "@polyglot-sql/sdk",
        "@react-email/components",
        "@react-email/render",
        "@scalar/hono-api-reference",
        "@sentry/node",
        "@better-auth/passkey",
        "better-auth",
        "chat",
        "dotenv",
        "embedded-postgres",
        "esbuild",
        "hono",
        "hono-pino",
        "isomorphic-git",
        "jimp",
        "ky",
        "kysely",
        "kysely-postgres-js",
        "pino",
        "react",
        "resend",
        "sharp",
        "tar",
        "vite",
        "winston",
        "zod",
        // Server's Vercel runtime provider (gateway/runtime/providers/vercel.ts),
        // reached only through the bundled server.
        "@vercel/sandbox",
        // Vendored into dist/vendor by scripts/build.cjs (file copy, no import).
        "@lobu/pgvector-embedded",
      ],
    },
    ".": {
      entry: [
        // CLI/utility scripts.
        "scripts/**/*.{ts,mjs,js}",
        // Example projects are loaded by file path at apply time and double as
        // the consumers of the public config DSL — treat them as entries so
        // knip follows them instead of flagging them (and the DSL) as unused.
        "examples/**/lobu.config.ts",
        "examples/**/*.connector.ts",
        "examples/**/*.reaction.ts",
        "examples/**/evals/**/*.ts",
        // Standalone example run scripts (`bun run seed`, `bun run compose`,
        // etc. in an example's package.json) are file-path entrypoints, not
        // imported by the workspace graph — treat them as entries.
        "examples/**/scripts/**/*.ts",
        // Example test suites run in CI (`bun test examples/personal-agent`,
        // `bun test examples/brand-intelligence`) and locally for the rest.
        "examples/**/__tests__/**/*.ts",
      ],
    },
  },
};

export default config;
