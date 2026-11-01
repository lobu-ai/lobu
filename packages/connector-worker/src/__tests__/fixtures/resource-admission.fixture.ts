import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WorkerClient } from '../../daemon/client.js';
import { WorkerPollLoop } from '../../daemon/poll-loop.js';
import { ResourceAdmission } from '../../daemon/resource-admission.js';
import { createResourceSampler } from '../../daemon/resources.js';
import { loadIsolatedVm } from '../../isolate/load.js';
import type { IvmIsolate } from '../../isolate/ivm-types.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const MIB = 1024 * 1024;

test('native isolate CPU pauses admission and idle time restores it', async () => {
  const ivm = await loadIsolatedVm();
  assert.ok(ivm, 'supported Node must load the native isolate');
  const realSample = createResourceSampler();
  const admission = new ResourceAdmission(() => {
    const sample = realSample();
    assert.ok(sample);
    const cpu = process.cpuUsage();
    return { memory: [{ usedBytes: 1, limitBytes: 1000 }], cpu: sample.cpu.some(c => c.cores <= 1)
      ? sample.cpu : [{ key: 'process', cores: 1, usageMicros: cpu.user + cpu.system }] };
  });
  assert.equal(admission.capacity(), 1);
  const isolate = new ivm.Isolate({ memoryLimit: 64 });
  try {
    const context = await isolate.createContext();
    const script = await isolate.compileScript('var until = Date.now() + 900; while (Date.now() < until) {}');
    await script.run(context);
    assert.equal(admission.capacity(), 0);
    await sleep(600);
    assert.equal(admission.capacity(), 1);
  } finally { isolate.dispose(); }
});

test('real resident isolate memory gates HTTP claims, then recovers without a completed turn', async () => {
  const ivm = await loadIsolatedVm();
  assert.ok(ivm);
  const sample = createResourceSampler();
  const initial = sample();
  assert.ok(initial);
  const physicalBudget = initial.memory.some(m => m.limitBytes <= 1024 * MIB);
  let budget = process.memoryUsage().rss + 320 * MIB;
  const admission = new ResourceAdmission(() => {
    const current = sample();
    if (!current) return null;
    return { memory: physicalBudget ? current.memory : [{ usedBytes: process.memoryUsage().rss, limitBytes: budget }], cpu: [] };
  });
  let claimed = 0;
  const started: number[] = [];
  const isolates: IvmIsolate[] = [];
  const finish: Array<() => void> = [];
  const startTimes: number[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') { res.end('{}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.end(JSON.stringify(body.capacity_available > 0 && claimed < 16
      ? { run_id: ++claimed, run_type: 'agent_turn' } : { next_poll_seconds: 30 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const loop = new WorkerPollLoop({
    client: new WorkerClient({ apiUrl: `http://127.0.0.1:${address.port}`, workerId: 'synthetic-resource-load', capabilities: { agent_turn: true } }),
    resourceAdmission: admission, maxConcurrentJobs: 1, maxConcurrentAgentTurns: 16,
    execute: async job => {
      const isolate = new ivm.Isolate({ memoryLimit: 96 }); isolates.push(isolate);
      try {
        const context = await isolate.createContext();
        const script = await isolate.compileScript('globalThis.payload = new Uint8Array(48 * 1024 * 1024); payload.fill(42);');
        await script.run(context);
        started.push(job.run_id!); startTimes.push(performance.now());
        await new Promise<void>(resolve => finish.push(resolve));
      } finally { if (!isolate.isDisposed) isolate.dispose(); }
    },
  });
  const running = loop.start();
  try {
    let previous = 0;
    let stable = 0;
    for (let i = 0; i < 20 && stable < 3; i++) {
      await sleep(600);
      stable = started.length === previous && started.length > 0 ? stable + 1 : 0;
      previous = started.length;
    }
    const peak = started.length;
    assert.ok(peak > 0 && peak < 16, `expected resource pressure before ceiling, got ${peak}`);
    assert.equal(admission.capacity(), 0);
    for (let i = 1; i < startTimes.length; i++) assert.ok(startTimes[i]! - startTimes[i - 1]! >= 450);
    // Release resident allocations while the same logical turns keep waiting.
    for (const isolate of isolates) if (!isolate.isDisposed) isolate.dispose();
    // macOS's allocator may retain freed RSS. A synthetic budget must then
    // grow to model newly available capacity; the physical Linux spike uses
    // the unchanged cgroup limit and observes actual released memory.
    if (!physicalBudget) budget += 320 * MIB;
    const deadline = performance.now() + 3000;
    while (started.length === peak && performance.now() < deadline) await sleep(100);
    assert.ok(started.length > peak, 'resource recovery must admit work without a turn completing');
    console.info(JSON.stringify({ physicalBudget, peakResidentTurns: peak, resumed: true }));
  } finally {
    loop.stop(); for (const done of finish) done(); await running;
    assert.equal(await loop.waitForActiveJobs(2000, 5), true);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
