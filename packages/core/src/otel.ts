import type { Span, Tracer } from "@opentelemetry/api";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
// The OTel exporter/SDK chain (~40M install, pulls @grpc/grpc-js) must not
// load on every `@lobu/core` import: tracing is disabled unless an OTLP
// endpoint is configured, and the CLI never configures one. The four heavy
// modules below are optional peer dependencies, loaded synchronously via
// createRequire inside initTracing only when enabled (sync require preserves
// the initTracing(config): void signature; the exporter ships CJS). The API
// package above stays a hard dependency: it is tiny and backs the no-op
// spans returned while disabled.
import type { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import type { resourceFromAttributes as resourceFromAttributesType } from "@opentelemetry/resources";
import type {
  NodeTracerProvider as NodeTracerProviderType,
  SimpleSpanProcessor as SimpleSpanProcessorType,
} from "@opentelemetry/sdk-trace-node";
import type {
  ATTR_SERVICE_NAME as AttrServiceName,
  ATTR_SERVICE_VERSION as AttrServiceVersion,
} from "@opentelemetry/semantic-conventions";
import { createRequire } from "node:module";
import { createLogger } from "./logger";

const logger = createLogger("otel");

let provider: NodeTracerProviderType | null = null;
let tracer: Tracer | null = null;

export interface OtelConfig {
  serviceName: string;
  serviceVersion?: string;
  otlpEndpoint?: string;
  enabled?: boolean;
}

export function initTracing(config: OtelConfig): void {
  if (provider) {
    return;
  }

  const enabled = config.enabled ?? !!config.otlpEndpoint;
  if (!enabled) {
    logger.debug(
      "Tracing disabled (no OTEL_EXPORTER_OTLP_ENDPOINT configured)"
    );
    return;
  }

  // Skipped by default on install; a minimal install that enables tracing
  // gets the explicit error below instead of MODULE_NOT_FOUND.
  let exporterCtor: typeof OTLPTraceExporter;
  let resourceFromAttributes: typeof resourceFromAttributesType;
  let NodeTracerProvider: typeof NodeTracerProviderType;
  let SimpleSpanProcessor: typeof SimpleSpanProcessorType;
  let ATTR_SERVICE_NAME: typeof AttrServiceName;
  let ATTR_SERVICE_VERSION: typeof AttrServiceVersion;
  try {
    const require = createRequire(__filename);
    exporterCtor =
      require("@opentelemetry/exporter-trace-otlp-grpc").OTLPTraceExporter;
    resourceFromAttributes =
      require("@opentelemetry/resources").resourceFromAttributes;
    ({
      NodeTracerProvider,
      SimpleSpanProcessor,
    } = require("@opentelemetry/sdk-trace-node"));
    ({
      ATTR_SERVICE_NAME,
      ATTR_SERVICE_VERSION,
    } = require("@opentelemetry/semantic-conventions"));
  } catch {
    throw new Error(
      "Tracing is enabled (OTEL_EXPORTER_OTLP_ENDPOINT or enabled: true) but the optional OpenTelemetry peer dependencies are not installed (@opentelemetry/exporter-trace-otlp-grpc, @opentelemetry/resources, @opentelemetry/sdk-trace-node, @opentelemetry/semantic-conventions). Install them explicitly to enable tracing, or leave the endpoint unset to run without tracing."
    );
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion || "1.0.0",
  });

  const exporter = new exporterCtor({
    url: config.otlpEndpoint,
    timeoutMillis: 30000,
  });

  // SimpleSpanProcessor exports immediately — workers are short-lived
  provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();

  tracer = trace.getTracer(config.serviceName, config.serviceVersion);

  logger.info(
    `Tracing initialized: ${config.serviceName} -> ${config.otlpEndpoint}`
  );
}

export function getTracer(): Tracer | null {
  return tracer;
}

export async function shutdownTracing(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
    tracer = null;
  }
}

export async function flushTracing(): Promise<void> {
  if (provider) {
    await provider.forceFlush();
  }
}

export function createSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>,
  kind: SpanKind = SpanKind.INTERNAL
): Span | null {
  if (!tracer) {
    return null;
  }

  const span = tracer.startSpan(name, {
    kind,
    attributes,
  });

  return span;
}

async function runInSpan<T>(
  span: Span | null,
  fn: (span: Span | null) => Promise<T>
): Promise<T> {
  try {
    const result = await fn(span);
    span?.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    if (span) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error as Error);
    }
    throw error;
  } finally {
    span?.end();
  }
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span | null) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return runInSpan(createSpan(name, attributes), fn);
}

export function getCurrentSpan(): Span | undefined {
  return trace.getActiveSpan();
}

export function runInSpanContext<T>(span: Span, fn: () => T): T {
  const ctx = trace.setSpan(context.active(), span);
  return context.with(ctx, fn);
}

export function createRootSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>
): { span: Span | null; traceparent: string | null } {
  if (!tracer) {
    return { span: null, traceparent: null };
  }

  const span = tracer.startSpan(name, {
    kind: SpanKind.SERVER,
    attributes,
  });

  const spanContext = span.spanContext();
  const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-01`;

  return { span, traceparent };
}

export function createChildSpan(
  name: string,
  traceparent: string | null | undefined,
  attributes?: Record<string, string | number | boolean>
): Span | null {
  if (!tracer) {
    return null;
  }

  if (!traceparent) {
    return createSpan(name, attributes);
  }

  // W3C traceparent: 00-traceId-parentSpanId-flags
  const parts = traceparent.split("-");
  if (parts.length !== 4) {
    return createSpan(name, attributes);
  }

  const traceId = parts[1]!;
  const parentSpanId = parts[2]!;

  const parentContext = trace.setSpanContext(context.active(), {
    traceId,
    spanId: parentSpanId,
    traceFlags: 1,
    isRemote: true,
  });

  return tracer.startSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes },
    parentContext
  );
}

export async function withChildSpan<T>(
  name: string,
  traceparent: string | null | undefined,
  fn: (span: Span | null) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return runInSpan(createChildSpan(name, traceparent, attributes), fn);
}

export function getTraceparent(span: Span | null): string | null {
  if (!span) return null;
  const ctx = span.spanContext();
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

export type { Span, Tracer };
export { SpanKind, SpanStatusCode };
