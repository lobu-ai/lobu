import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIB = 1024 ** 2;

/** Node 22/libuv can miss a cgroup v2 limit on a parent of init.scope. */
export function memoryLimit(
  read = (path) => readFileSync(path, "utf8"),
  hostMemory = totalmem()
) {
  const limits = [];
  const add = (path) => {
    try {
      const value = Number(read(path).trim());
      if (Number.isSafeInteger(value) && value > 0 && value < hostMemory)
        limits.push(value);
    } catch {
      /* No controller on this host. */
    }
  };
  const root = "/sys/fs/cgroup";
  let group = root;
  try {
    const relative = read("/proc/self/cgroup")
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3);
    if (relative) group = join(root, resolve("/", relative));
  } catch {
    /* macOS has no cgroups. */
  }
  for (;;) {
    add(join(group, "memory.max"));
    add(join(group, "memory.high"));
    if (group === root) break;
    group = dirname(group);
  }
  add("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  return limits.length ? Math.min(...limits) : undefined;
}

export function nodeOptionsForMemory(options = "", limit = memoryLimit()) {
  if (!limit) return options;
  // Old space is only part of RSS. Leave room for young space, native modules,
  // esbuild, Postgres and the dev supervisor; builds share this upper bound.
  const budget = Math.max(128, Math.floor((limit / MIB) * 0.4));
  const heapOption =
    /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)(?=\s|$)/g;
  let existing = Infinity;
  const remaining = options
    .replace(heapOption, (_match, value) => {
      // V8 uses zero for automatic sizing, not a zero-sized heap.
      if (Number(value) > 0) existing = Math.min(existing, Number(value));
      return "";
    })
    .trim();
  return `${remaining} --max-old-space-size=${Math.min(existing, budget)}`.trim();
}

export function buildConcurrency(limit = memoryLimit()) {
  // A compiler can use its heap budget plus native memory. Small containers
  // build serially instead of starting six TypeScript processes together.
  return limit ? Math.max(1, Math.floor(limit / (2 * 1024 ** 3))) : Infinity;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(nodeOptionsForMemory(process.env.NODE_OPTIONS));
}
