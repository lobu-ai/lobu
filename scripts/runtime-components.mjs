// Release-only composition. Runtime source remains in its owning package.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeRoot = join(root, "dist/runtime-components");
const readPackage = (name) =>
  JSON.parse(
    readFileSync(join(root, "packages", name, "package.json"), "utf8")
  );
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export const COMPONENTS = {
  server: {
    name: "@lobu/runtime-server",
    entries: {
      server: "dist/server.bundle.mjs",
      embeddingsServer: "dist/embeddings-server.mjs",
    },
  },
  device: {
    name: "@lobu/runtime-device",
    entries: {
      daemon: "vendor/cli/dist/commands/daemon.js",
      automation: "vendor/cli/dist/commands/automation.js",
      connector: "vendor/cli/dist/commands/connector.js",
      worker: "vendor/connector-worker/dist/bin.js",
    },
  },
  postgres: {
    name: "@lobu/runtime-postgres",
    entries: { postgres: "dist/index.mjs" },
  },
  embeddings: {
    name: "@lobu/runtime-embeddings",
    entries: { embeddings: "dist/embeddings.js" },
  },
};

export function runtimeCatalog() {
  const version = readPackage("cli").version;
  return Object.fromEntries(
    Object.entries(COMPONENTS).map(([key, value]) => [
      key,
      { ...value, version, verify: "dist/verify.mjs" },
    ])
  );
}

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (path) =>
      !/(?:__tests__|\.(?:test|spec)\.[cm]?[jt]s$|\.map$)/.test(path),
  });
}

function workspaceRefs(pkg) {
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (spec.startsWith("workspace:"))
        pkg[section][name] = readPackage(name.slice("@lobu/".length)).version;
    }
  }
  delete pkg.devDependencies;
  delete pkg.scripts;
  return pkg;
}

const externalNonWorkspace = {
  name: "external-non-workspace",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, ({ path }) =>
      path.startsWith("@lobu/") ? undefined : { path, external: true }
    );
  },
};

export async function bundleCompiler() {
  const esbuild = await import("esbuild");
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["packages/cli/src/internal/connector-compiler.ts"],
    outfile: "packages/cli/dist/internal/connector-compiler.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    plugins: [externalNonWorkspace],
  });
}

/** Build installable artifacts without modifying workspace manifests. */
export async function buildRuntimeComponents() {
  const esbuild = await import("esbuild");
  const rootManifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")
  );
  const catalog = runtimeCatalog();
  const cli = workspaceRefs(readPackage("cli"));
  const serverSource = readPackage("server");
  const server = workspaceRefs(structuredClone(serverSource));
  const worker = workspaceRefs(readPackage("connector-worker"));
  const connectors = workspaceRefs(readPackage("connectors"));
  const embeddings = workspaceRefs(readPackage("embeddings"));
  for (const [key, component] of Object.entries(catalog)) {
    const directory = join(runtimeRoot, key);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(join(directory, "dist"), { recursive: true });
    const manifest = {
      name: component.name,
      version: component.version,
      type: "module",
      license: "BUSL-1.1",
      files: ["dist", "vendor", "prebuilt", "npm-shrinkwrap.json"],
      engines: cli.engines,
      overrides: rootManifest.overrides,
    };
    if (key === "server") {
      // The server bundles workspace JS; preserve externally resolved SDK and
      // native dependencies, including string-based runtime resolver calls.
      manifest.dependencies = {
        ...readPackage("core").dependencies,
        ...readPackage("connector-sdk").dependencies,
        ...connectors.dependencies,
        ...worker.dependencies,
        ...server.dependencies,
      };
      for (const name of Object.keys(manifest.dependencies)) {
        if (
          name.startsWith("@lobu/") &&
          !["@lobu/core", "@lobu/connector-sdk"].includes(name)
        )
          delete manifest.dependencies[name];
      }
      delete manifest.dependencies["@xenova/transformers"];
      manifest.optionalDependencies = worker.optionalDependencies;
      for (const name of ["dotenv", "esbuild", "vite"])
        manifest.dependencies[name] =
          serverSource.devDependencies?.[name] ??
          readPackage("cli").devDependencies[name];
      for (const name of [
        "server.bundle.mjs",
        "server-main.bundle.mjs",
        "guest.bundle.js",
      ])
        copy(
          join(root, "packages/server/dist", name),
          join(directory, "dist", name)
        );
      for (const [source, target] of [
        ["db/migrations", "db/migrations"],
        ["packages/connectors/src", "connectors"],
        ["config/providers.json", "providers.json"],
        ["packages/owletto/dist", "owletto/dist"],
        ["packages/server/dist/catalogs", "catalogs"],
      ]) {
        if (existsSync(join(root, source)))
          copy(join(root, source), join(directory, "dist", target));
      }
      await esbuild.build({
        absWorkingDir: root,
        entryPoints: ["packages/embeddings/src/server.ts"],
        outfile: join(directory, "dist/embeddings-server.mjs"),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        packages: "external",
      });
    } else if (key === "device") {
      copy(join(root, "packages/cli/dist"), join(directory, "vendor/cli/dist"));
      // Keep the worker's file layout: guest and ACP bundles resolve relative
      // to their owning modules, with no NODE_PATH or global loader hooks.
      copy(
        join(root, "packages/connector-worker/dist"),
        join(directory, "vendor/connector-worker/dist")
      );
      const vendorWorker = structuredClone(worker);
      delete vendorWorker.dependencies["@lobu/embeddings"];
      delete vendorWorker.dependencies["@xenova/transformers"];
      writeJson(
        join(directory, "vendor/connector-worker/package.json"),
        vendorWorker
      );
      const vendorCli = structuredClone(cli);
      vendorCli.files = ["dist"];
      delete vendorCli.bin;
      vendorCli.dependencies["@lobu/core"] = "file:../core";
      vendorCli.dependencies["@lobu/connector-sdk"] = "file:../connector-sdk";
      vendorCli.dependencies["@lobu/connector-worker"] =
        "file:../connector-worker";
      for (const value of Object.values(vendorCli.exports ?? {})) {
        if (value && typeof value === "object") delete value.bun;
      }
      writeJson(join(directory, "vendor/cli/package.json"), vendorCli);
      manifest.dependencies = {
        ...connectors.dependencies,
        "@lobu/cli": "file:vendor/cli",
        "@lobu/connector-worker": "file:vendor/connector-worker",
      };
      // Inline only metadata into this file; its local inference import is
      // supplied by the launcher and remote workers never resolve ONNX.
      await esbuild.build({
        absWorkingDir: root,
        entryPoints: ["packages/connector-worker/src/embeddings.ts"],
        outfile: join(directory, "vendor/connector-worker/dist/embeddings.js"),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        plugins: [externalNonWorkspace],
      });
    } else if (key === "postgres") {
      manifest.dependencies = {
        "embedded-postgres":
          readPackage("server").devDependencies["embedded-postgres"],
      };
      copy(
        join(root, "packages/pgvector-embedded/dist"),
        join(directory, "dist/pgvector")
      );
      // pgvector's module is one directory below dist, so its ../prebuilt is
      // dist/prebuilt. Its native resolver walks up to this component's deps.
      copy(
        join(root, "packages/pgvector-embedded/prebuilt"),
        join(directory, "dist/prebuilt")
      );
      writeFileSync(
        join(directory, "dist/index.mjs"),
        'export { default } from "embedded-postgres";\nexport * from "./pgvector/index.js";\n'
      );
    } else {
      manifest.dependencies = {
        "@xenova/transformers": embeddings.dependencies["@xenova/transformers"],
      };
      copy(join(root, "packages/embeddings/dist"), join(directory, "dist"));
    }
    // Vendor the small workspace contracts from this exact checkout. The
    // release can freeze and test its dependency graph before new sibling
    // versions exist in the registry (including canary versions).
    if (key === "server" || key === "device") {
      for (const name of ["core", "connector-sdk"]) {
        copy(
          join(root, "packages", name, "dist"),
          join(directory, "vendor", name, "dist")
        );
        const vendor = workspaceRefs(readPackage(name));
        for (const value of Object.values(vendor.exports ?? {})) {
          if (value && typeof value === "object") delete value.bun;
        }
        if (vendor.dependencies?.["@lobu/core"])
          vendor.dependencies["@lobu/core"] = "file:../core";
        writeJson(join(directory, "vendor", name, "package.json"), vendor);
        manifest.dependencies[`@lobu/${name}`] = `file:vendor/${name}`;
      }
      if (key === "device") {
        const path = join(directory, "vendor/connector-worker/package.json");
        const vendor = JSON.parse(readFileSync(path, "utf8"));
        vendor.dependencies["@lobu/core"] = "file:../core";
        vendor.dependencies["@lobu/connector-sdk"] = "file:../connector-sdk";
        writeJson(path, vendor);
      }
    }
    // Preserve repository patches in Node-only installs too. A regular local
    // package carries the already-patched files and original license, so npm
    // and Bun consume identical bytes without install scripts or global hooks.
    for (const specifier of Object.keys(
      rootManifest.patchedDependencies ?? {}
    )) {
      const separator = specifier.lastIndexOf("@");
      const name = specifier.slice(0, separator);
      const version = specifier.slice(separator + 1);
      const targetName = name.replaceAll("/", "-");
      const manifests = [manifest];
      const vendorManifests = [];
      if (key === "device") {
        const path = join(directory, "vendor/cli/package.json");
        vendorManifests.push([path, JSON.parse(readFileSync(path, "utf8"))]);
      }
      if (
        !manifests.some((pkg) => pkg.dependencies?.[name]) &&
        !vendorManifests.some(([, pkg]) => pkg.dependencies?.[name])
      )
        continue;
      const require = createRequire(join(root, "package.json"));
      let source = dirname(realpathSync(require.resolve(name)));
      while (true) {
        const path = join(source, "package.json");
        if (
          existsSync(path) &&
          JSON.parse(readFileSync(path, "utf8")).name === name
        )
          break;
        const parent = dirname(source);
        if (parent === source)
          throw new Error(`Cannot locate installed package ${name}`);
        source = parent;
      }
      if (
        JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
          .version !== version
      )
        throw new Error(
          `Reinstall workspace dependencies before packaging ${specifier}`
        );
      copy(source, join(directory, "vendor", targetName));
      // This is an already-built patched package. npm 10 can run a local
      // package's prepare hook even with --ignore-scripts; build sources are
      // not published, and no lifecycle hook belongs in this vendored copy.
      const vendorManifestPath = join(
        directory,
        "vendor",
        targetName,
        "package.json"
      );
      const vendorManifest = JSON.parse(
        readFileSync(vendorManifestPath, "utf8")
      );
      delete vendorManifest.scripts;
      delete vendorManifest.devDependencies;
      writeJson(vendorManifestPath, vendorManifest);
      manifest.dependencies[name] = `file:vendor/${targetName}`;
      for (const [path, pkg] of vendorManifests) {
        if (pkg.dependencies?.[name])
          pkg.dependencies[name] = `file:../${targetName}`;
        writeJson(path, pkg);
      }
    }
    const verify = [
      'import { createRequire } from "node:module";',
      'import { readFileSync } from "node:fs";',
      "const require = createRequire(import.meta.url);",
      'const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));',
      "for (const name of Object.keys(pkg.dependencies ?? {})) {",
      '  if (name === "@lobu/connector-worker") import.meta.resolve("@lobu/connector-worker/daemon");',
      "  else import.meta.resolve(name);",
      "}",
    ];
    if (key === "postgres")
      verify.push(
        'const pg = await import("./index.mjs"); pg.injectPgvector(pg.resolveEmbeddedNativeDir());'
      );
    if (key === "embeddings") verify.push('await import("./embeddings.js");');
    if (key === "device")
      verify.push(
        'await import("@lobu/connector-worker/executor/runtime");',
        'const nativeRequire = createRequire(import.meta.resolve("@lobu/connector-worker/daemon"));'
      );
    else verify.push("const nativeRequire = require;");
    if (key === "server" || key === "device")
      verify.push(
        'const major = Number(process.versions.node.split(".")[0]); if (major !== 25) { const ivm = nativeRequire(major >= 26 ? "isolated-vm-next" : "isolated-vm"); const isolate = new ivm.Isolate({ memoryLimit: 8 }); isolate.dispose(); }'
      );
    writeFileSync(join(directory, "dist/verify.mjs"), `${verify.join("\n")}\n`);
    writeJson(join(directory, "package.json"), manifest);
    writeJson(join(directory, "dist/component.json"), component);
  }
}

/** Release artifacts carry both managers' frozen dependency trees. */
export function lockRuntimeComponent(directory) {
  // Resolve in an isolated project: package managers must never discover or
  // rewrite the repository workspace lock while composing a release artifact.
  const temporary = mkdtempSync(join(tmpdir(), "lobu-runtime-lock-"));
  try {
    copy(join(directory, "package.json"), join(temporary, "package.json"));
    if (existsSync(join(directory, "vendor")))
      copy(join(directory, "vendor"), join(temporary, "vendor"));
    for (const [command, args] of [
      [
        "npm",
        [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
      ],
      ["bun", ["install", "--lockfile-only", "--ignore-scripts"]],
    ]) {
      const result = spawnSync(command, args, {
        cwd: temporary,
        stdio: "inherit",
        env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
      });
      if (result.status !== 0)
        throw new Error(
          `Failed to freeze runtime dependencies in ${directory}`
        );
    }
    copy(
      join(temporary, "package-lock.json"),
      join(directory, "npm-shrinkwrap.json")
    );
    copy(
      join(temporary, "bun.lock"),
      join(directory, "dist/dependencies.bun.lock")
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
