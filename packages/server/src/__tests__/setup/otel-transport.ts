import { execFile, fork, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export interface TransportSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  serviceName?: string;
  status: number;
}

export async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

const delay = (ms: number) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  timer.unref();
});

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([closed, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await closed;
  }
}

/**
 * Opt-in real OTLP receiver. Tests never download or install a collector:
 * supply the checksum-verified otelcol-contrib 0.164.0 executable through
 * LOBU_OTEL_COLLECTOR_BINARY and run the agent-turn-producer integration file
 * with -t 'tracing pipeline'. Only loopback and this fixture's temporary file
 * are configured; no ClickHouse, production data, or persistent service.
 */
export async function startTestCollector(binary: string) {
  const version = await promisify(execFile)(binary, ['--version'], { timeout: 5_000 });
  if (!version.stdout.includes('0.164.0')) throw new Error('OTLP smoke requires otelcol-contrib 0.164.0');
  const directory = await mkdtemp(join(tmpdir(), 'lobu-otel-collector-'));
  const port = await unusedLoopbackPort();
  const output = join(directory, 'traces.jsonl');
  const config = join(directory, 'collector.yaml');
  await writeFile(config, [
    'receivers:',
    '  otlp:',
    '    protocols:',
    '      grpc:',
    `        endpoint: 127.0.0.1:${port}`,
    'processors:',
    '  memory_limiter:',
    '    check_interval: 1s',
    '    limit_mib: 128',
    '    spike_limit_mib: 32',
    'exporters:',
    '  file:',
    `    path: ${JSON.stringify(output)}`,
    '    format: json',
    '    flush_interval: 100ms',
    'service:',
    '  telemetry:',
    '    logs:',
    '      level: error',
    '    metrics:',
    '      level: none',
    '  pipelines:',
    '    traces:',
    '      receivers: [otlp]',
    '      processors: [memory_limiter]',
    '      exporters: [file]',
    '',
  ].join('\n'));
  const child = spawn(binary, ['--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  const collect = (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8_192); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; });
  const stop = async () => {
    await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) throw new Error(`Collector could not start: ${spawnError?.message ?? diagnostic}`);
      ready = await new Promise<boolean>(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
      });
      if (ready) break;
      await delay(25);
    }
    if (!ready) throw new Error(`Collector did not open its loopback receiver: ${diagnostic}`);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    endpoint: `http://127.0.0.1:${port}`,
    stop,
    async spans(): Promise<TransportSpan[]> {
      const text = await readFile(output, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      return text.split('\n').filter(Boolean).flatMap(line => {
        const batch = JSON.parse(line);
        return (batch.resourceSpans ?? []).flatMap((resource: any) => {
          const serviceName = resource.resource?.attributes?.find((attribute: any) => attribute.key === 'service.name')?.value?.stringValue;
          return (resource.scopeSpans ?? []).flatMap((scope: any) => (scope.spans ?? []).map((span: any) => ({
            name: span.name, traceId: span.traceId, spanId: span.spanId,
            parentSpanId: span.parentSpanId || undefined, serviceName,
            status: Number(span.status?.code ?? 0),
          })));
        });
      });
    },
  };
}

export function startOtelWorker(options: {
  apiUrl: string;
  authToken: string;
  runId: number;
  mode: 'memory' | 'collector' | 'disabled' | 'unavailable';
  endpoint?: string;
}) {
  // The compiled worker/core are deliberate: this proves shipped runtime
  // resolution and the HTTP response-header hop across a process boundary.
  const env: NodeJS.ProcessEnv = { ...process.env, LOG_LEVEL: 'info' };
  if (options.endpoint) env.OTEL_EXPORTER_OTLP_ENDPOINT = options.endpoint;
  else delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const child = fork(fileURLToPath(new URL('../fixtures/otel-agent-turn-worker.mjs', import.meta.url)), [], {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env,
  });
  let diagnostic = '';
  const collect = (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-65_536); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  type Completion = { runId: number; error?: string; elapsedMs: number; tracingEnabled: boolean; spans: TransportSpan[] };
  const completed = new Promise<Completion>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Worker smoke timed out: ${diagnostic}`)), 25_000);
    const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`Worker exited before completion (${code ?? signal}): ${diagnostic}`)));
    child.once('message', (message: Completion & { failure?: string }) => {
      clearTimeout(timeout);
      if (message.failure) reject(new Error(message.failure));
      else resolve(message);
    });
  });
  child.send(options);
  return { completed, stop: () => stopChild(child), logs: () => diagnostic };
}
