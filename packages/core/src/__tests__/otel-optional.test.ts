/**
 * OTel stays unloaded unless explicitly enabled.
 *
 * The exporter/SDK chain (~40M, pulls @grpc/grpc-js) is an optional peer,
 * lazily required inside initTracing. The CLI never enables tracing, so
 * importing @lobu/core must not load it — these tests lock the disabled
 * path: no-op init, null tracer, passthrough spans.
 */

import { describe, expect, test } from "bun:test";
import {
  createSpan,
  flushTracing,
  getTracer,
  initTracing,
  shutdownTracing,
  withSpan,
} from "../otel";

describe("otel disabled by default", () => {
  test("initTracing without an endpoint is a no-op", () => {
    initTracing({ serviceName: "test-service" });
    expect(getTracer()).toBeNull();
  });

  test("initTracing with enabled: false is a no-op", () => {
    initTracing({
      serviceName: "test-service",
      otlpEndpoint: "http://localhost:4317",
      enabled: false,
    });
    expect(getTracer()).toBeNull();
  });

  test("span helpers pass through while disabled", async () => {
    expect(createSpan("op")).toBeNull();
    const result = await withSpan("op", async (span) => {
      expect(span).toBeNull();
      return 42;
    });
    expect(result).toBe(42);
  });

  test("shutdown/flush are safe while disabled", async () => {
    await shutdownTracing();
    await flushTracing();
    expect(getTracer()).toBeNull();
  });
});
