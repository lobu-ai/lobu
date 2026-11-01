import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { dirname, join, relative } from 'node:path';

export interface ResourceSample {
  memory: Array<{ usedBytes: number; limitBytes: number }>;
  cpu: Array<{ key: string; usageMicros: number; cores: number }>;
}

type Read = (path: string) => string;
interface Group { root: string; leaf: string; v2: boolean; }

function optional(read: Read, path: string): string | undefined {
  try { return read(path).trim(); } catch { return undefined; }
}

function positive(value: string | undefined): number | undefined {
  const n = value ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function unescapePath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Resolve both host cgroup paths and a container's cgroup-namespace root. */
function groups(read: Read): { memory?: Group; cpu?: Group; cpuacct?: Group } {
  const membership = optional(read, '/proc/self/cgroup') ?? '';
  const mounts = optional(read, '/proc/self/mountinfo') ?? '';
  const result: { memory?: Group; cpu?: Group; cpuacct?: Group } = {};
  for (const line of mounts.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!left || !right) continue;
    const fields = left.split(' ');
    const [kind, , options = ''] = right.split(' ');
    if (kind !== 'cgroup' && kind !== 'cgroup2') continue;
    const root = unescapePath(fields[4] ?? '');
    const mountedFrom = unescapePath(fields[3] ?? '/');
    if (!root.startsWith('/')) continue;
    for (const controller of ['memory', 'cpu', 'cpuacct'] as const) {
      if (kind === 'cgroup' && !options.split(',').includes(controller)) continue;
      // On hybrid hosts a controller belongs to only one hierarchy. A v2
      // mount must not hide its v1 membership, regardless of mount order.
      const v1Entry = membership.split('\n').find(row => row.split(':')[1]?.split(',').includes(controller));
      if (kind === 'cgroup2' && v1Entry) continue;
      const entry = membership.split('\n').find(row => {
        const parts = row.split(':');
        return kind === 'cgroup2' ? parts[0] === '0' && parts[1] === '' : parts[1]?.split(',').includes(controller);
      });
      if (!entry) continue;
      const member = entry.slice(entry.indexOf(':', entry.indexOf(':') + 1) + 1);
      const suffix = mountedFrom === '/' ? member.slice(1)
        : member === mountedFrom ? ''
        : member.startsWith(`${mountedFrom}/`) ? member.slice(mountedFrom.length + 1)
        : member === '/' ? '' : member.slice(1);
      const candidate = join(root, suffix);
      // A namespace may report a path outside the visible mount. In that
      // case the mounted root is the only scope we can measure faithfully.
      const leaf = relative(root, candidate).startsWith('..') ? root : candidate;
      result[controller] = { root, leaf, v2: kind === 'cgroup2' };
    }
  }
  return result;
}

function ancestors(group: Group): string[] {
  const paths = [group.leaf];
  while (paths[paths.length - 1] !== group.root) {
    const parent = dirname(paths[paths.length - 1]!);
    if (parent === paths[paths.length - 1]) break;
    paths.push(parent);
  }
  return paths;
}

/** Container-wide counters include isolate threads and spawned tool children. */
export function createResourceSampler(
  read: Read = path => readFileSync(path, 'utf8'),
  platform: string = process.platform
): () => ResourceSample | null {
  const discovered = platform === 'linux' ? groups(read) : {};
  return () => {
    const memory: ResourceSample['memory'] = [];
    const cpu: ResourceSample['cpu'] = [];
    const hostMemory = totalmem();
    if (discovered.memory) {
      let readable = false;
      for (const path of ancestors(discovered.memory)) {
        const raw = optional(read, join(path, discovered.memory.v2 ? 'memory.max' : 'memory.limit_in_bytes'));
        if (raw === undefined) continue;
        readable = true;
        const limit = positive(raw);
        if (raw !== 'max' && limit === undefined) return null;
        // v2 `max` and v1's huge unlimited sentinel use the host bound.
        if (!limit || limit >= hostMemory) continue;
        const usage = optional(read, join(path, discovered.memory.v2 ? 'memory.current' : 'memory.usage_in_bytes'));
        const used = usage === undefined ? Number.NaN : Number(usage);
        if (!Number.isFinite(used) || used < 0) return null;
        const stats = optional(read, join(path, 'memory.stat')) ?? '';
        const inactiveKey = discovered.memory.v2 ? 'inactive_file' : 'total_inactive_file';
        const inactive = Number(stats.match(new RegExp(`^${inactiveKey} (\\d+)$`, 'm'))?.[1] ?? 0);
        // Match cAdvisor's working set: inactive file cache is reclaimable.
        // Keeping it in usage can permanently pause a worker after a build or
        // large source read, even when resident job memory is small.
        memory.push({ usedBytes: Math.max(0, used - inactive), limitBytes: limit });
      }
      if (!readable) return null;
    }
    if (memory.length === 0) memory.push({ usedBytes: hostMemory - freemem(), limitBytes: hostMemory });

    if (discovered.cpu) {
      for (const path of ancestors(discovered.cpu)) {
        let quota: number | undefined;
        let period: number | undefined;
        if (discovered.cpu.v2) {
          const parts = optional(read, join(path, 'cpu.max'))?.split(/\s+/);
          quota = positive(parts?.[0]); period = positive(parts?.[1]);
          if (parts && (parts.length !== 2 || !period || (parts[0] !== 'max' && !quota))) return null;
        } else {
          const raw = optional(read, join(path, 'cpu.cfs_quota_us'));
          quota = positive(raw);
          period = positive(optional(read, join(path, 'cpu.cfs_period_us')));
          if (raw !== undefined && (!period || (raw !== '-1' && !quota))) return null;
        }
        if (!quota || !period) continue;
        const accounting = discovered.cpuacct;
        const usagePath = accounting ? join(accounting.leaf, relative(discovered.cpu.leaf, path)) : path;
        const raw = discovered.cpu.v2
          ? optional(read, join(path, 'cpu.stat'))?.match(/^usage_usec (\d+)$/m)?.[1]
          : optional(read, join(usagePath, 'cpuacct.usage'));
        const used = raw === undefined ? Number.NaN : Number(raw);
        if (!Number.isFinite(used) || used < 0) return null;
        cpu.push({ key: path, usageMicros: discovered.cpu.v2 ? used : used / 1000, cores: Math.min(availableParallelism(), quota / period) });
      }
    }
    // With no quota, process CPU still includes all isolated-vm threads. On
    // devices this sampler is unused; the existing device budget is preserved.
    if (cpu.length === 0) {
      const usage = process.cpuUsage();
      cpu.push({ key: 'process', usageMicros: usage.user + usage.system, cores: availableParallelism() });
    }
    return { memory, cpu };
  };
}
