import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";

const REQUIRED_NODE_MAJOR = 26;

interface NodeProbe {
  node: string;
  bun: string | null;
}

export interface ResolveNode26Deps {
  /** The CLI process's own executable — Bun when the CLI was launched via Bun. */
  execPath: string;
  versions: { node?: string; bun?: string };
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run: (command: string, args: string[]) => string;
}

const defaultDeps: ResolveNode26Deps = {
  execPath: process.execPath,
  versions: process.versions as { node?: string; bun?: string },
  platform: process.platform,
  env: process.env,
  run: (command, args) =>
    execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
};

function majorOf(version: string | undefined): number {
  return Number.parseInt(version?.split(".")[0] ?? "", 10);
}

function probeNode(
  binary: string,
  run: ResolveNode26Deps["run"]
): NodeProbe | null {
  try {
    const raw = run(binary, [
      "-p",
      "JSON.stringify({node:process.versions.node,bun:process.versions.bun??null})",
    ]);
    const parsed = JSON.parse(raw) as Partial<NodeProbe>;
    if (typeof parsed.node !== "string") return null;
    return { node: parsed.node, bun: parsed.bun ?? null };
  } catch {
    return null;
  }
}

function pathCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  const names =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
          .map((ext) => `node${ext.toLowerCase()}`)
      : ["node"];
  const dirs = (env.PATH ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean);
  return dirs.flatMap((dir) => names.map((name) => join(dir, name)));
}

function isNode26(probe: NodeProbe | null): boolean {
  return (
    probe !== null &&
    probe.bun === null &&
    majorOf(probe.node) === REQUIRED_NODE_MAJOR
  );
}

/**
 * Resolve the Node 26 binary that must host the backend.
 *
 * `lobu run` may itself be launched through Bun (for example `bunx @lobu/cli`),
 * where `process.execPath` is Bun — a runtime that cannot load the V8
 * isolated-vm addon. Never hand that executable to the server: use the current
 * process only when it is genuinely Node 26, otherwise verify a `node` on PATH
 * and fail fast with an actionable message.
 */
export function resolveNode26Binary(
  deps: ResolveNode26Deps = defaultDeps
): string {
  if (
    deps.versions.bun === undefined &&
    majorOf(deps.versions.node) === REQUIRED_NODE_MAJOR
  ) {
    return deps.execPath;
  }

  for (const candidate of pathCandidates(deps.platform, deps.env)) {
    if (isNode26(probeNode(candidate, deps.run))) return candidate;
  }

  const current = deps.versions.bun
    ? `Bun ${deps.versions.bun}`
    : `Node ${deps.versions.node ?? "unknown"}`;
  throw new Error(
    `Lobu's gateway must run on Node.js ${REQUIRED_NODE_MAJOR}.x — this CLI is running on ${current} and no Node ${REQUIRED_NODE_MAJOR} binary was found on PATH. Install Node ${REQUIRED_NODE_MAJOR} (nvm install ${REQUIRED_NODE_MAJOR} && nvm use ${REQUIRED_NODE_MAJOR}) and re-run.`
  );
}
