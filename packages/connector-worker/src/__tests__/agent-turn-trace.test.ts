/**
 * The worker host continues the server trace. A run that fails before the
 * isolate still has to finish the span, or the parent trace stays open.
 */

import { type Context, SpanStatusCode } from "@opentelemetry/api";
import { initTracing, shutdownTracing } from "@lobu/core";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterEach, expect, test } from "bun:test";
import { executeAgentTurnRun } from "../daemon/agent-turn";

class MemorySpanProcessor implements SpanProcessor {
  readonly finished: ReadableSpan[] = [];

  onStart(_span: Span, _parentContext: Context): void {
    // The assertion reads the ended span.
  }

  onEnd(span: ReadableSpan): void {
    this.finished.push(span);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const traceId = "ab".repeat(16);
const spanId = "cd".repeat(8);

afterEach(async () => {
  await shutdownTracing();
});

test("agent_turn is a child of the poll traceparent", async () => {
  // initTracing keeps the first provider in the process. A previous file
  // would otherwise leave this processor unattached and the span invisible.
  await shutdownTracing();
  const processor = new MemorySpanProcessor();
  initTracing({
    serviceName: "lobu-worker-test",
    spanProcessors: [processor],
  });

  const result = await executeAgentTurnRun(
    {} as never,
    { traceparent: `00-${traceId}-${spanId}-01` } as never,
    {},
    {} as never
  );

  expect(result.error).toBe("agent turn run missing its run id");
  expect(
    processor.finished.map((span) => ({
      name: span.name,
      traceId: span.spanContext().traceId,
    }))
  ).toEqual([{ name: "agent_turn", traceId }]);
  // A failed turn is recorded as a grouped error, not only a red status.
  const [turn] = processor.finished;
  expect(turn.status.code).toBe(SpanStatusCode.ERROR);
  expect(turn.attributes).toMatchObject({
    "lobu.run_status": "failed",
    "exception.type": "AgentTurnError",
    "exception.message": "agent turn run missing its run id",
    "error.kind": "system",
    "error.fingerprint": expect.stringMatching(/^[0-9a-f]{32}$/),
  });
  expect(turn.events.map((event) => event.name)).toEqual(["exception"]);
});
