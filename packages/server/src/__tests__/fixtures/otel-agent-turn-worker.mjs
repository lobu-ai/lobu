// This child executes the real compiled WorkerClient and agent-turn host.
// The model response is supplied by the integration fixture's loopback server.
import { executeRun, WorkerClient } from '@lobu/connector-worker/daemon';
import { IsolateExecutor } from '@lobu/connector-worker/executor/isolate';
import { getTracer, initTracing, shutdownTracing } from '@lobu/core';

process.once('message', async options => {
  let exporter;
  try {
    if (options.mode === 'memory') {
      const { InMemorySpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
      exporter = new InMemorySpanExporter();
      initTracing({ serviceName: 'lobu-worker', enabled: true, spanProcessors: [new SimpleSpanProcessor(exporter)] });
    }
    const started = Date.now();
    const client = new WorkerClient({
      apiUrl: options.apiUrl, workerId: 'synthetic-otel-worker',
      authToken: options.authToken, capabilities: { agent_turn: true },
    });
    const job = await client.poll();
    if (job.run_id !== options.runId) throw new Error('Worker did not claim the expected durable turn');
    const result = await executeRun(client, job, {}, {
      executor: new IsolateExecutor({ allowedDomains: ['127.0.0.1'], timeoutMs: 20_000 }),
      timeoutMs: 20_000,
    });
    const spans = (exporter?.getFinishedSpans() ?? []).map(span => ({
      name: span.name, traceId: span.spanContext().traceId, spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanContext?.spanId,
      serviceName: span.resource.attributes['service.name'], status: span.status.code,
    }));
    // Report completion before exporter shutdown. The unavailable-collector
    // case measures application progress, not how long a telemetry drain takes.
    process.send?.({ runId: job.run_id, error: result.error, elapsedMs: Date.now() - started, tracingEnabled: getTracer() !== null, spans });
    await shutdownTracing();
    process.disconnect();
  } catch (error) {
    process.send?.({ failure: error instanceof Error ? error.stack : String(error) });
    process.exitCode = 1;
    process.disconnect();
  }
});
