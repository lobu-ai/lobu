/**
 * Phase 1 trace linkage. The processor is in-memory so this never constructs
 * the gRPC exporter. shutdownTracing resets the module singleton; the global
 * API provider stays registered, so this file inits a processor once.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { createLogger } from "../logger";
import {
  createChildSpan,
  createRootSpan,
  currentTraceLogFields,
  flushTracing,
  getTraceparent,
  initTracing,
  runInSpanContext,
  shutdownTracing,
  traceparentHeader,
} from "../otel";

class MemorySpanProcessor implements SpanProcessor {
  readonly finished: Array<{ name: string; traceId: string }> = [];

  onStart(_span: Span, _parentContext: Context): void {
    // Recording happens on end. Start is a no-op for this assertion.
  }

  onEnd(span: ReadableSpan): void {
    this.finished.push({
      name: span.name,
      traceId: span.spanContext().traceId,
    });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe("otel trace linkage", () => {
  beforeEach(async () => {
    await shutdownTracing();
  });

  test("createRootSpan stays inert until initTracing", () => {
    const root = createRootSpan("message_received");
    expect(root.span).toBeNull();
    expect(root.traceparent).toBeNull();
    expect(currentTraceLogFields()).toEqual({});
  });

  test("traceparentHeader keeps only a W3C value", () => {
    const header = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;
    expect(traceparentHeader(header)).toBe(header);
    expect(traceparentHeader("not-a-trace")).toBeNull();
    expect(traceparentHeader(undefined)).toBeNull();
    expect(
      traceparentHeader(`00-${"0".repeat(32)}-${"cd".repeat(8)}-01`)
    ).toBeNull();
    expect(
      traceparentHeader(`00-${"ab".repeat(16)}-${"0".repeat(16)}-01`)
    ).toBeNull();
  });

  test("initTracing without an endpoint does not throw or start a span", () => {
    initTracing({ serviceName: "lobu-test" });
    expect(createRootSpan("message_received")).toEqual({
      span: null,
      traceparent: null,
    });
  });

  test("root, queue, and agent spans share one trace id", async () => {
    const processor = new MemorySpanProcessor();
    initTracing({
      serviceName: "lobu-test",
      spanProcessors: [processor],
    });

    const root = createRootSpan("message_received");
    expect(root.span).not.toBeNull();
    expect(root.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const queue = createChildSpan("queue_processing", root.traceparent);
    const agent = createChildSpan("agent_turn", getTraceparent(queue));
    expect(queue).not.toBeNull();
    expect(agent).not.toBeNull();

    let fields: { trace_id?: string; span_id?: string } = {};
    await runInSpanContext(queue!, async () => {
      await Promise.resolve();
      fields = currentTraceLogFields();
    });
    expect(fields.trace_id).toBe(root.span!.spanContext().traceId);
    expect(fields.span_id).toBe(queue!.spanContext().spanId);

    agent!.end();
    queue!.end();
    root.span!.end();
    await flushTracing();

    const ids = new Set(processor.finished.map((span) => span.traceId));
    expect(processor.finished.map((span) => span.name).sort()).toEqual([
      "agent_turn",
      "message_received",
      "queue_processing",
    ]);
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(root.span!.spanContext().traceId);
    expect(currentTraceLogFields()).toEqual({});
  });

  test("createLogger carries the active span id", async () => {
    const processor = new MemorySpanProcessor();
    initTracing({
      serviceName: "lobu-test",
      spanProcessors: [processor],
    });
    const root = createRootSpan("message_received");
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((part) => String(part)).join(" "));
    };
    try {
      const log = createLogger("otel-test");
      await runInSpanContext(root.span!, async () => {
        await Promise.resolve();
        log.info("inside span");
      });
      log.info("outside span");
    } finally {
      console.log = original;
      root.span?.end();
    }
    const inside = lines.find((line) => line.includes("inside span"));
    const outside = lines.find((line) => line.includes("outside span"));
    expect(inside).toContain(`trace_id=${root.span!.spanContext().traceId}`);
    expect(outside).not.toContain("trace_id=");
  });
});
