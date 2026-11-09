import { log } from './log.js';
import { createResourceSampler, type ResourceSample } from './resources.js';

/** Give a newly admitted isolate time to expose its startup cost. */
export const RESOURCE_ADMISSION_INTERVAL_MS = 500;
const MIB = 1024 * 1024;

/**
 * Local resource admission, underneath the configured per-kind ceilings.
 * This owns no run state: the gateway still owns claims, fairness and leases.
 */
export class ResourceAdmission {
  private previous?: { sample: ResourceSample; at: number };
  private nextStartAt = 0;
  private paused?: 'memory' | 'cpu' | 'sample';

  constructor(
    private readonly sample: () => ResourceSample | null = createResourceSampler(),
    private readonly now: () => number = () => performance.now()
  ) {}

  capacity(): number {
    const at = this.now();
    if (at < this.nextStartAt) return 0;
    if (this.previous && at - this.previous.at < RESOURCE_ADMISSION_INTERVAL_MS) return this.paused ? 0 : 1;
    const current = this.sample();
    if (!current || current.memory.length === 0 || current.memory.some(m =>
      !Number.isFinite(m.usedBytes) || m.usedBytes < 0 || !Number.isFinite(m.limitBytes) || m.limitBytes <= 0
    )) {
      this.transition('sample');
      return 0;
    }
    const memoryTarget = this.paused === 'memory' ? 0.7 : 0.8;
    // Keep room for one more large isolate. On small installations reserve
    // 20% instead of requiring half a GiB before admitting the first run.
    const memoryPressure = current.memory.some(m =>
      m.usedBytes + Math.min(512 * MIB, m.limitBytes * 0.2) > m.limitBytes * memoryTarget
    );
    let cpuLoad = 0;
    if (this.previous && at > this.previous.at) {
      const elapsedMicros = (at - this.previous.at) * 1000;
      for (const c of current.cpu) {
        const before = this.previous!.sample.cpu.find(p => p.key === c.key);
        if (before && c.cores > 0) cpuLoad = Math.max(cpuLoad, (c.usageMicros - before.usageMicros) / elapsedMicros / c.cores);
      }
    }
    this.previous = { sample: current, at };
    const cpuPressure = cpuLoad > (this.paused === 'cpu' ? 0.6 : 0.8);
    this.transition(memoryPressure ? 'memory' : cpuPressure ? 'cpu' : undefined, { memory: current.memory, cpuLoad });
    return this.paused ? 0 : 1;
  }

  started(): void {
    this.nextStartAt = this.now() + RESOURCE_ADMISSION_INTERVAL_MS;
  }

  private transition(reason: typeof this.paused, resources?: unknown): void {
    if (reason === this.paused) return;
    this.paused = reason;
    log.info(`[daemon] Resource admission ${reason ? `paused (${reason})` : 'resumed'}`, resources);
  }
}
