import type { Span, Tracer } from "@opentelemetry/api";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
// The OTel exporter/SDK chain (~40M install, pulls @grpc/grpc-js) must not
// load on every `@lobu/core` import: tracing is disabled unless an OTLP
// endpoint is configured, and the CLI never configures one. The four heavy
// modules below are optional peer dependencies, loaded synchronously via
// bare require() inside initTracing only when enabled (sync require preserves
// the initTracing(config): void signature; the exporter ships CJS). The API
// package above stays a hard dependency: it is tiny and backs the no-op
// spans returned while disabled.
import type { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import type { resourceFromAttributes as resourceFromAttributesType } from "@opentelemetry/resources";
import type {
  NodeTracerProvider as NodeTracerProviderType,
  SimpleSpanProcessor as SimpleSpanProcessorType,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type {
  ATTR_SERVICE_NAME as AttrServiceName,
  ATTR_SERVICE_VERSION as AttrServiceVersion,
} from "@opentelemetry/semantic-conventions";
import { createLogger } from "./logger";

const logger = createLogger("otel");

let provider: NodeTracerProviderType | null = null;
let tracer: Tracer | null = null;

export interface OtelConfig {
  serviceName: string;
  serviceVersion?: string;
  otlpEndpoint?: string;
  enabled?: boolean;
  /**
   * Replaces the OTLP exporter. Tests pass an in-memory processor so init
   * never constructs a gRPC client. Production leaves this unset.
   */
  spanProcessors?: SpanProcessor[];
}

export function initTracing(config: OtelConfig): void {
  if (provider) {
    return;
  }

  const customProcessors = config.spanProcessors;
  const useCustomProcessors = (customProcessors?.length ?? 0) > 0;
  const enabled =
    config.enabled ?? (!!config.otlpEndpoint || useCustomProcessors);
  if (!enabled) {
    logger.debug(
      "Tracing disabled (no OTEL_EXPORTER_OTLP_ENDPOINT configured)"
    );
    return;
  }

  // Bare require (not createRequire(__filename)): tsc emits CJS with a native
  // require, bun provides one for src TS, and the server ESM bundle banner
  // defines `const require = __createRequire(import.meta.url)` for exactly
  // these calls — while __filename has no shim there and would throw.
  let exporterCtor: typeof OTLPTraceExporter | undefined;
  let resourceFromAttributes: typeof resourceFromAttributesType;
  let NodeTracerProvider: typeof NodeTracerProviderType;
  let SimpleSpanProcessor: typeof SimpleSpanProcessorType;
  let ATTR_SERVICE_NAME: typeof AttrServiceName;
  let ATTR_SERVICE_VERSION: typeof AttrServiceVersion;
  try {
    if (!useCustomProcessors) {
      exporterCtor =
        require("@opentelemetry/exporter-trace-otlp-grpc").OTLPTraceExporter;
    }
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
  } catch (err) {
    // Only a missing module means the optional peers aren't installed. A
    // genuine load failure inside an installed OTel module (e.g. grpc native
    // init) must surface as-is, not misreport as "not installed".
    if ((err as NodeJS.ErrnoException)?.code !== "MODULE_NOT_FOUND") throw err;
    throw new Error(
      "Tracing is enabled (OTEL_EXPORTER_OTLP_ENDPOINT or enabled: true) but the optional OpenTelemetry peer dependencies are not installed (@opentelemetry/exporter-trace-otlp-grpc, @opentelemetry/resources, @opentelemetry/sdk-trace-node, @opentelemetry/semantic-conventions). Install them explicitly to enable tracing, or leave the endpoint unset to run without tracing."
    );
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion || "1.0.0",
  });

  // SimpleSpanProcessor exports on span end. A caller-supplied processor
  // (tests) must not construct the gRPC exporter.
  let spanProcessors: SpanProcessor[];
  if (customProcessors && customProcessors.length > 0) {
    spanProcessors = customProcessors;
  } else if (exporterCtor) {
    spanProcessors = [
      new SimpleSpanProcessor(
        new exporterCtor({
          url: config.otlpEndpoint,
          timeoutMillis: 30000,
        })
      ),
    ];
  } else {
    throw new Error(
      "Tracing is enabled but neither spanProcessors nor the OTLP exporter loaded."
    );
  }

  provider = new NodeTracerProvider({
    resource,
    spanProcessors,
  });
  provider.register();

  // Bind the tracer we just built. trace.getTracer() stays on the first
  // globally registered provider, so a later init would otherwise export
  // into a provider this call does not own.
  tracer = provider.getTracer(config.serviceName, config.serviceVersion);

  logger.info(
    useCustomProcessors
      ? `Tracing initialized: ${config.serviceName} (custom span processors)`
      : `Tracing initialized: ${config.serviceName} -> ${config.otlpEndpoint}`
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

  // Not the active context. Callers that want logs to see this span run
  // the work through runInSpanContext.
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

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** A W3C `traceparent` value, or null when the input is not one. */
export function traceparentHeader(value: unknown): string | null {
  return typeof value === "string" && TRACEPARENT_RE.test(value) ? value : null;
}

/** W3C ids of the active span. Empty when the log is outside a real span. */
export function currentTraceLogFields(): {
  trace_id?: string;
  span_id?: string;
} {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !trace.isSpanContextValid(spanContext)) {
    return {};
  }
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

export function getTraceparent(span: Span | null): string | null {
  if (!span) return null;
  const ctx = span.spanContext();
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

export type { Span, Tracer };
export { SpanKind, SpanStatusCode };
