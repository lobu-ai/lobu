import type { Context } from "@opentelemetry/api";
import {
  createRootSpan,
  initTracing,
  runInSpanContext,
  shutdownTracing,
} from "@lobu/core";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import logger from "../../utils/logger";

class MemorySpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe("pino trace fields", () => {
  const lines: string[] = [];
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    lines.length = 0;
    await shutdownTracing();
    initTracing({
      serviceName: "lobu-server-test",
      spanProcessors: [new MemorySpanProcessor()],
    });
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await shutdownTracing();
  });

  it("puts the active span trace_id on the log line and omits it outside the span", async () => {
    const { span } = createRootSpan("message_received");
    expect(span).not.toBeNull();
    const traceId = span!.spanContext().traceId;
    const spanId = span!.spanContext().spanId;

    await runInSpanContext(span!, async () => {
      await Promise.resolve();
      logger.info("inside span");
    });
    logger.info("outside span");
    span!.end();

    const records = lines
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            msg?: string;
            trace_id?: string;
            span_id?: string;
          }
      );
    const inside = records.find((record) => record.msg === "inside span");
    const outside = records.find((record) => record.msg === "outside span");
    expect(inside?.trace_id).toBe(traceId);
    expect(inside?.span_id).toBe(spanId);
    expect(outside?.trace_id).toBeUndefined();
    expect(outside?.span_id).toBeUndefined();
  });
});
