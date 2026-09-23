/** Project dependencies are created by init, and frozen before apply compiles. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { globSync } from "tinyglobby";

const exec = promisify(execFile);
const LOCKS = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];
type Manifest = {
  packageManager?: string;
  workspaces?: string[] | { packages: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
type Project = { root: string; packages: string[]; manifest: Manifest };
/** Owned by one apply or one running local stack, never a process-global cache. */
export type DependencySession = Map<string, string>;

type Mode = "create" | "frozen" | "read";

function manifestAt(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function workspacePackages(root: string, manifest: Manifest): string[] {
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces?.packages;
  if (!patterns) return [];
  if (
    !Array.isArray(patterns) ||
    patterns.some(
      (p) =>
        typeof p !== "string" ||
        p.startsWith("/") ||
        p.split("/").includes("..")
    )
  ) {
    throw new Error(
      `Invalid workspace paths in ${join(root, "package.json")}. Keep workspace packages under their root.`
    );
  }
  return globSync(
    patterns.map((p) => `${p.replace(/\/$/, "")}/package.json`),
    {
      cwd: root,
      absolute: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
      followSymbolicLinks: false,
    }
  )
    .map((p) => dirname(p))
    .sort();
}

function findProject(cwd: string): Project | null {
  // A directory without lobu.config.ts is not a Lobu project: never install into it.
  if (!existsSync(join(cwd, "lobu.config.ts"))) return null;
  const projectDir = realpathSync(cwd);
  if (!existsSync(join(projectDir, "package.json"))) return null;
  let root = projectDir;
  // Only a declared workspace member inherits an ancestor's lockfile.
  for (let dir = dirname(projectDir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      // An unrelated ancestor is not part of this project's dependency inputs.
      // Validate the selected root below; malformed unrelated manifests cannot own it.
      try {
        if (workspacePackages(dir, manifestAt(dir)).includes(root)) root = dir;
      } catch {
        // No valid workspace declaration establishes ownership at this ancestor.
      }
    }
    if (dirname(dir) === dir) break;
  }
  const manifest = manifestAt(root);
  return {
    root,
    manifest,
    packages: [root, ...workspacePackages(root, manifest)],
  };
}

function commandOnPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return resolve(dir, bin);
  }
  return null;
}

function policy(project: Project, mode: Mode) {
  const { root, manifest } = project;
  const locks = LOCKS.filter((name) => existsSync(join(root, name)));
  if (locks.length > 1)
    throw new Error(
      `Conflicting lockfiles in ${root}: ${locks.join(", ")}. Keep the lockfile for your declared package manager.`
    );
  const lock = locks[0];
  if (lock === "pnpm-lock.yaml" || lock === "yarn.lock")
    throw new Error(
      `Lobu project installation supports Bun and npm; ${lock} requires a different package manager.`
    );
  const declaration = manifest.packageManager;
  const parsed = declaration?.match(
    /^(bun|npm)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/
  );
  if (declaration && !parsed)
    throw new Error(
      `Unsupported packageManager ${JSON.stringify(declaration)}. Declare an exact bun@version or npm@version.`
    );
  const lockedManager = lock
    ? lock.startsWith("bun.")
      ? "bun"
      : "npm"
    : undefined;
  const manager =
    parsed?.[1] ?? lockedManager ?? (commandOnPath("bun") ? "bun" : "npm");
  if (lockedManager && lockedManager !== manager)
    throw new Error(
      `packageManager ${declaration} conflicts with ${lock}. Use one package manager and its lockfile.`
    );
  for (const member of project.packages.slice(1)) {
    const nested = manifestAt(member).packageManager;
    if (nested && nested !== declaration)
      throw new Error(
        `Workspace package ${member} declares a different packageManager. Declare the manager at ${root}.`
      );
    if (LOCKS.some((name) => existsSync(join(member, name))))
      throw new Error(
        `Workspace package ${member} has its own lockfile. Use the workspace lockfile in ${root}.`
      );
  }
  if (!lock && mode === "frozen")
    throw new Error(
      `Missing lockfile in ${root}. Run '${manager} install --ignore-scripts' there and commit the lockfile before applying.`
    );
  return { manager, lock, version: parsed?.[2] };
}

function fingerprint(project: Project): string {
  const hash = createHash("sha256");
  for (const dir of project.packages) {
    for (const name of ["package.json", ".npmrc", "bunfig.toml", ...LOCKS]) {
      const file = join(dir, name);
      hash.update(relative(project.root, file));
      hash.update(existsSync(file) ? readFileSync(file) : "<missing>");
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function missingDependency(
  project: Project,
  readOnly = false
): string | undefined {
  for (const dir of project.packages) {
    const manifest = manifestAt(dir);
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      // Optional declarations override required entries and may be omitted by the installer.
      if (Object.hasOwn(manifest.optionalDependencies ?? {}, name)) continue;
      // Config loading aliases these two packages to the running CLI's SDK.
      // Preserve zero-install validation without hiding missing user libraries.
      if (readOnly && (name === "@lobu/cli" || name === "@lobu/connector-sdk"))
        continue;
      let at = dir;
      while (!existsSync(join(at, "node_modules", name, "package.json"))) {
        if (at === project.root)
          return `${name} (declared in ${relative(project.root, dir) || "."})`;
        at = dirname(at);
      }
    }
  }
  return undefined;
}

/** Read-only consumers must never install through desired-state loading. */
export function checkProjectDeps(cwd: string): void {
  const project = findProject(cwd);
  if (!project) return;
  const selected = policy(project, "read");
  const missing = missingDependency(project, true);
  if (missing)
    throw new Error(
      `Missing project dependency ${missing}. Run '${selected.manager} ${!selected.lock ? "install" : selected.manager === "bun" ? "install --frozen-lockfile" : "ci"} --ignore-scripts' in ${project.root}, then retry.`
    );
}

/** Hold the project lock through compilation so another Lobu install cannot race it. */
export async function withProjectDependencies<T>(
  cwd: string,
  options: {
    mode?: Mode;
    session?: DependencySession;
    log?: (message: string) => void;
    stdio?: "inherit" | "pipe";
  },
  use: () => Promise<T>
): Promise<T> {
  const mode = options.mode ?? "frozen";
  if (mode === "read") {
    checkProjectDeps(cwd);
    return use();
  }
  const initial = findProject(cwd);
  if (!initial) return use();
  const release = await lockfile.lock(join(initial.root, "package.json"), {
    stale: 300_000,
    update: 10_000,
    retries: { retries: 300, minTimeout: 200, maxTimeout: 200 },
  });
  try {
    const project = findProject(cwd);
    if (!project || project.root !== initial.root)
      throw new Error(
        "Workspace ownership changed during installation. Retry the command."
      );
    const selected = policy(project, mode);
    const cmd = commandOnPath(selected.manager);
    if (!cmd)
      throw new Error(
        `Install ${selected.manager}${selected.version ? `@${selected.version}` : ""} and put it on PATH. Lobu will not switch package managers for this project.`
      );
    const { stdout } = await exec(cmd, ["--version"], { env: process.env });
    const version = stdout.trim();
    if (
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
      (selected.version && selected.version !== version)
    ) {
      throw new Error(
        `Project requires ${selected.manager}@${selected.version ?? "a valid version"}; found ${version}. Install the declared version before applying.`
      );
    }
    const before = fingerprint(project);
    const key = `${cmd}\0${version}\0${before}`;
    if (
      mode === "create" ||
      options.session?.get(project.root) !== key ||
      missingDependency(project)
    ) {
      options.session?.delete(project.root);
      options.log?.(
        `Installing project dependencies with ${selected.manager} in ${project.root}...`
      );
      const args =
        selected.manager === "bun"
          ? [
              "install",
              ...(mode === "create" ? [] : ["--frozen-lockfile"]),
              "--ignore-scripts",
            ]
          : [
              mode === "create" ? "install" : "ci",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              "--include=dev",
            ];
      try {
        const child = execFile(cmd, args, {
          cwd: project.root,
          env: { ...process.env, NODE_ENV: "development" },
          maxBuffer: 8 * 1024 * 1024,
        });
        if (options.stdio !== "pipe") {
          child.stdout?.pipe(process.stdout);
          child.stderr?.pipe(process.stderr);
        }
        await new Promise<void>((accept, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) =>
            code === 0 ? accept() : reject(new Error(`exit ${code ?? signal}`))
          );
        });
      } catch (error) {
        throw new Error(
          `${selected.manager} ${args.join(" ")} failed in ${project.root}. Fix the project manifest/lockfile with '${selected.manager} install --ignore-scripts', then retry. ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (mode !== "create") {
        const after = findProject(cwd);
        if (!after || before !== fingerprint(after))
          throw new Error(
            "Dependency inputs changed during installation. Retry with a consistent manifest and lockfile."
          );
        const missing = missingDependency(project);
        if (missing)
          throw new Error(
            `Installation did not provide project dependency ${missing}. Check the package manager configuration in ${project.root}.`
          );
        options.session?.set(project.root, key);
      }
    }
    return await use();
  } finally {
    await release();
  }
}

/** Init alone may create/update the project's lockfile. */
export async function installProjectDeps(
  root: string,
  opts: { stdio?: "inherit" | "pipe" } = {}
): Promise<void> {
  await withProjectDependencies(
    root,
    { ...opts, mode: "create" },
    async () => undefined
  );
}
