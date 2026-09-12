import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { x as extract } from "tar";

export type RuntimeComponent = "server" | "device" | "postgres" | "embeddings";
export interface ComponentDescriptor {
  name: string;
  version: string;
  entries: Record<string, string>;
  verify?: string;
}
type Catalog = Record<RuntimeComponent, ComponentDescriptor>;
export interface ComponentInstallOptions {
  cacheRoot?: string;
  offline?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Artifact transport seam for local release verification. */
  fetchArtifact?: (
    component: ComponentDescriptor,
    directory: string
  ) => Promise<void>;
  installDependencies?: (
    directory: string,
    signal?: AbortSignal
  ) => Promise<void>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
function catalog(): Catalog {
  return JSON.parse(
    readFileSync(join(HERE, "../runtime-components.json"), "utf8")
  ) as Catalog;
}

export function selectedRuntimeComponents(
  surface: "server" | "device",
  env: Record<string, string | undefined>,
  needsEmbeddings = true
): RuntimeComponent[] {
  const selected: RuntimeComponent[] = [surface];
  if (
    surface === "server" &&
    !/^postgres(ql)?:\/\//i.test(env.DATABASE_URL?.trim() ?? "")
  )
    selected.push("postgres");
  if (
    needsEmbeddings &&
    !env.EMBEDDINGS_SERVICE_URL?.trim() &&
    (surface === "device" ||
      (env.EMBEDDINGS_BACKEND || "local").toLowerCase() !== "openai")
  )
    selected.push("embeddings");
  return selected;
}

export function runtimeCacheRoot(): string {
  return (
    process.env.LOBU_RUNTIME_CACHE_DIR ||
    join(homedir(), ".cache", "lobu", "runtime")
  );
}

export function runtimePlatformKey(): string {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const libc =
    process.platform === "linux"
      ? report?.header?.glibcVersionRuntime
        ? "glibc"
        : "musl"
      : "native";
  return `${process.platform}-${process.arch}-${libc}-abi${process.versions.modules}`;
}

async function isComplete(
  directory: string,
  component: ComponentDescriptor
): Promise<boolean> {
  try {
    const receipt = JSON.parse(
      await readFile(join(directory, ".complete.json"), "utf8")
    );
    const pkg = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8")
    );
    return (
      receipt.name === component.name &&
      receipt.version === component.version &&
      receipt.platform === runtimePlatformKey() &&
      pkg.name === component.name &&
      pkg.version === component.version &&
      existsSync(join(directory, "node_modules")) &&
      Object.values(component.entries).every((entry) =>
        existsSync(join(directory, entry))
      )
    );
  } catch {
    return false;
  }
}

async function downloadArtifact(
  component: ComponentDescriptor,
  directory: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<void> {
  const response = await fetchImpl(
    `https://registry.npmjs.org/${encodeURIComponent(component.name)}/${component.version}`,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) }
  );
  if (!response.ok)
    throw new Error(
      `Runtime ${component.name}@${component.version} is unavailable (${response.status}). Retry after the release finishes publishing.`
    );
  const metadata = (await response.json()) as {
    name: string;
    version: string;
    dist: { tarball: string; integrity: string };
  };
  if (
    metadata.name !== component.name ||
    metadata.version !== component.version ||
    !metadata.dist.integrity?.startsWith("sha512-")
  )
    throw new Error("Invalid runtime release metadata");
  const url = new URL(metadata.dist.tarball);
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org")
    throw new Error("Invalid runtime artifact origin");
  const artifact = await fetchImpl(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
  });
  if (!artifact.ok || !artifact.body)
    throw new Error(`Runtime download failed (${artifact.status})`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of artifact.body) {
    bytes += chunk.length;
    if (bytes > 256 * 1024 * 1024)
      throw new Error("Runtime artifact exceeds 256 MiB");
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const integrity = `sha512-${createHash("sha512").update(buffer).digest("base64")}`;
  if (integrity !== metadata.dist.integrity)
    throw new Error("Runtime artifact integrity check failed");
  const tarball = join(directory, "artifact.tgz");
  await writeFile(tarball, buffer);
  await extract({
    file: tarball,
    cwd: directory,
    strip: 1,
    strict: true,
    filter: (path, entry) => {
      if (
        !path.startsWith("package/") ||
        path.split("/").includes("..") ||
        !("type" in entry) ||
        !["File", "Directory"].includes(entry.type)
      )
        throw new Error(`Unsafe runtime archive entry: ${path}`);
      return true;
    },
  });
  await rm(tarball);
}

async function installDependencies(
  directory: string,
  signal?: AbortSignal
): Promise<void> {
  const hasBun =
    spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
  if (hasBun)
    await copyFile(
      join(directory, "dist/dependencies.bun.lock"),
      join(directory, "bun.lock")
    );
  const command = hasBun
    ? "bun"
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const args = hasBun
    ? // Bun 1.3's hoisted linker creates empty nested directories for repeated
      // file dependencies, shadowing the vendored SDK's package exports. Its
      // isolated linker preserves the complete graph on both 1.3 and 1.4.
      ["install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated"]
    : ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (!existsSync(join(directory, hasBun ? "bun.lock" : "npm-shrinkwrap.json")))
    throw new Error("Runtime release is missing its frozen dependency lock");
  await new Promise<void>((done, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      signal,
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    });
    child.once("error", reject);
    child.once("exit", (code, killed) =>
      code === 0
        ? done()
        : reject(
            new Error(
              `Runtime dependency installation failed (${code ?? killed})`
            )
          )
    );
  });
}

async function makeRelocatable(directory: string): Promise<void> {
  const root = await realpath(directory);
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isSymbolicLink()) {
        const link = await readlink(path);
        const target = await realpath(resolve(dirname(path), link));
        if (!target.startsWith(`${root}${sep}`))
          throw new Error(
            `Runtime dependency link escapes its installation: ${path}`
          );
        // Bun links local package manifests to their absolute staging paths.
        // Make those links relative before atomic promotion; their targets
        // move together and no node_modules resolver hooks are needed.
        if (isAbsolute(link)) {
          await unlink(path);
          await symlink(relative(dirname(path), target), path);
        }
      }
    }
  }
  await walk(root);
}

export async function ensureComponent(
  component: ComponentDescriptor,
  options: ComponentInstallOptions = {}
): Promise<string> {
  // Catalog values are release-owned, never an arbitrary missing-module name.
  if (
    !/^@lobu\/runtime-(server|device|postgres|embeddings)$/.test(
      component.name
    ) ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(component.version)
  )
    throw new Error("Invalid runtime component identity");
  const parent = join(
    options.cacheRoot ?? runtimeCacheRoot(),
    "v1",
    component.version,
    runtimePlatformKey()
  );
  const destination = join(
    parent,
    component.name.slice("@lobu/runtime-".length)
  );
  if (await isComplete(destination, component)) return destination;
  if (options.offline)
    throw new Error(
      `Runtime ${component.name}@${component.version} is not cached. Run 'lobu runtime install' while online.`
    );
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const release = await lockfile.lock(destination, {
    realpath: false,
    stale: 60_000,
    update: 10_000,
    retries: { retries: 900, minTimeout: 1000, maxTimeout: 1000 },
    onCompromised: (error) => controller.abort(error),
  });
  let temporary: string | undefined;
  try {
    signal.throwIfAborted();
    if (await isComplete(destination, component)) return destination;
    // A killed installer cannot promote its private temporary directory.
    // Reap those remnants while holding this component's installation lock.
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name.startsWith(
          `${component.name.slice("@lobu/runtime-".length)}.partial-`
        )
      ) {
        await rm(join(parent, entry.name), { recursive: true, force: true });
      }
    }
    temporary = await mkdtemp(`${destination}.partial-`);
    console.error(`Installing ${component.name}@${component.version}…`);
    if (options.fetchArtifact)
      await options.fetchArtifact(component, temporary);
    else
      await downloadArtifact(
        component,
        temporary,
        options.fetchImpl ?? fetch,
        signal
      );
    const pkg = JSON.parse(
      await readFile(join(temporary, "package.json"), "utf8")
    );
    if (pkg.name !== component.name || pkg.version !== component.version)
      throw new Error("Runtime artifact identity mismatch");
    await (options.installDependencies ?? installDependencies)(
      temporary,
      signal
    );
    await makeRelocatable(temporary);
    signal.throwIfAborted();
    if (component.verify) {
      await new Promise<void>((done, reject) => {
        const child = spawn(
          process.execPath,
          [join(temporary!, component.verify!)],
          { cwd: temporary, signal, stdio: "inherit" }
        );
        child.once("error", reject);
        child.once("exit", (code, killed) =>
          code === 0
            ? done()
            : reject(
                new Error(`Runtime verification failed (${code ?? killed})`)
              )
        );
      });
    }
    for (const entry of Object.values(component.entries)) {
      if (!existsSync(join(temporary, entry)))
        throw new Error(`Runtime artifact is missing ${entry}`);
    }
    await writeFile(
      join(temporary, ".complete.json"),
      JSON.stringify({
        name: component.name,
        version: component.version,
        platform: runtimePlatformKey(),
      })
    );
    signal.throwIfAborted();
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    temporary = undefined;
    return destination;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await release();
  }
}

export async function prepareRuntime(
  surface: "server" | "device",
  env: Record<string, string | undefined>,
  options: ComponentInstallOptions & { localEmbeddings?: boolean } = {}
): Promise<{
  directory: string;
  env: Record<string, string>;
  entries: Record<string, string>;
}> {
  // Source development already has the full workspace dependency graph.
  // Keep its original entrypoints and asset layout; artifact tests install
  // outside the checkout and therefore exercise the component cache instead.
  const workspace = resolve(HERE, "../../../..");
  if (
    existsSync(join(workspace, "packages/cli/bin/lobu.js")) &&
    existsSync(join(workspace, "packages/connector-worker/package.json"))
  ) {
    const directory = join(
      workspace,
      "packages",
      surface === "server" ? "server" : "cli"
    );
    const relativeEntries =
      surface === "server"
        ? { server: "dist/server.bundle.mjs" }
        : {
            daemon: "dist/commands/daemon.js",
            automation: "dist/commands/automation.js",
            connector: "dist/commands/connector.js",
          };
    return {
      directory,
      env: {},
      entries: Object.fromEntries(
        Object.entries(relativeEntries).map(([key, path]) => [
          key,
          join(directory, path!),
        ])
      ),
    };
  }
  const selected = selectedRuntimeComponents(
    surface,
    env,
    options.localEmbeddings ?? true
  );
  const definitions = catalog();
  const locations: Partial<Record<RuntimeComponent, string>> = {};
  for (const key of selected)
    locations[key] = await ensureComponent(definitions[key], options);
  return {
    directory: locations[surface]!,
    entries: Object.fromEntries(
      Object.entries(definitions[surface].entries).map(([key, entry]) => [
        key,
        join(locations[surface]!, entry),
      ])
    ),
    env: {
      ...(locations.postgres
        ? {
            LOBU_RUNTIME_POSTGRES_ENTRY: join(
              locations.postgres,
              definitions.postgres.entries.postgres!
            ),
          }
        : {}),
      ...(locations.embeddings
        ? {
            LOBU_RUNTIME_EMBEDDINGS_ENTRY: join(
              locations.embeddings,
              definitions.embeddings.entries.embeddings!
            ),
          }
        : {}),
      ...(surface === "server"
        ? {
            LOBU_RUNTIME_EMBEDDINGS_SERVER: join(
              locations.server!,
              definitions.server.entries.embeddingsServer!
            ),
          }
        : {}),
    },
  };
}

type DeviceCommands = {
  daemon: typeof import("../commands/daemon.js");
  automation: typeof import("../commands/automation.js");
  connector: typeof import("../commands/connector.js");
};
export async function loadDeviceCommand<K extends keyof DeviceCommands>(
  command: K
): Promise<DeviceCommands[K]> {
  // One-shot Automation envelopes are already claimed. A cold install must
  // never consume their claim lease: callers preinstall the device component
  // before polling. Daemons prepare their runtime before they start polling.
  const runtime = await prepareRuntime("device", process.env, {
    localEmbeddings: command === "daemon",
    offline: command === "automation",
  });
  Object.assign(process.env, runtime.env);
  // Measured old install: 2 GiB. Resolve this explicit installed command only
  // after argument parsing, keeping help and cloud commands dependency-light.
  return import(pathToFileURL(runtime.entries[command]!).href);
}

export async function preinstallRuntime(
  keys: string[],
  offline = false
): Promise<void> {
  const definitions = catalog();
  for (const key of keys.length ? keys : Object.keys(definitions)) {
    if (!Object.hasOwn(definitions, key))
      throw new Error(`Unknown runtime component: ${key}`);
    const directory = await ensureComponent(
      definitions[key as RuntimeComponent],
      { offline }
    );
    console.log(`${key}: ${directory}`);
  }
}
