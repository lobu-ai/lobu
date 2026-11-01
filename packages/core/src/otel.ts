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
  BatchSpanProcessor as BatchSpanProcessorType,
  NodeTracerProvider as NodeTracerProviderType,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import type {
  ATTR_SERVICE_NAME as AttrServiceName,
  ATTR_SERVICE_VERSION as AttrServiceVersion,
} from "@opentelemetry/semantic-conventions";
import { createLogger } from "./logger";
import { formatTraceparent, parseTraceparent } from "./trace-context";

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
  let resourceFromAttributes: typeof resourceFromAttributesType;
  let NodeTracerProvider: typeof NodeTracerProviderType;
  let ATTR_SERVICE_NAME: typeof AttrServiceName;
  let ATTR_SERVICE_VERSION: typeof AttrServiceVersion;
  let spanProcessors: SpanProcessor[];
  try {
    resourceFromAttributes =
      require("@opentelemetry/resources").resourceFromAttributes;
    let BatchSpanProcessor: typeof BatchSpanProcessorType;
    ({
      BatchSpanProcessor,
      NodeTracerProvider,
    } = require("@opentelemetry/sdk-trace-node"));
    ({
      ATTR_SERVICE_NAME,
      ATTR_SERVICE_VERSION,
    } = require("@opentelemetry/semantic-conventions"));
    if (customProcessors?.length) {
      // A caller-supplied processor (tests) never loads the gRPC exporter.
      spanProcessors = customProcessors;
    } else {
      // The server is long-lived: a batch keeps export off the request path
      // and bounds memory with a drop-on-full queue while a collector is
      // down. shutdownTracing flushes it.
      const exporterCtor: typeof OTLPTraceExporter =
        require("@opentelemetry/exporter-trace-otlp-grpc").OTLPTraceExporter;
      spanProcessors = [
        new BatchSpanProcessor(
          new exporterCtor({
            url: config.otlpEndpoint,
            timeoutMillis: 30000,
          })
        ),
      ];
    }
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

/**
 * Flush and stop tracing. With `timeoutMs`, an unreachable collector cannot
 * hold up process exit past that budget; the timeout rejects.
 */
export async function shutdownTracing(timeoutMs?: number): Promise<void> {
  if (!provider) return;
  const shutdown = provider.shutdown();
  provider = null;
  tracer = null;
  if (timeoutMs === undefined) {
    await shutdown;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      shutdown,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Tracing shutdown exceeded its ${timeoutMs}ms budget`)
            ),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
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

/** Run `fn` with `span` active, or plainly when tracing produced no span. */
export function runInSpanContext<T>(span: Span | null, fn: () => T): T {
  if (!span) return fn();
  return context.with(trace.setSpan(context.active(), span), fn);
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

  return { span, traceparent: formatTraceparent(span.spanContext()) };
}

export function createChildSpan(
  name: string,
  traceparent: string | null | undefined,
  attributes?: Record<string, string | number | boolean>
): Span | null {
  if (!tracer) {
    return null;
  }

  const parent = parseTraceparent(traceparent);
  if (!parent) {
    return createSpan(name, attributes);
  }

  return tracer.startSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes },
    trace.setSpanContext(context.active(), parent)
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
  return formatTraceparent(span.spanContext());
}

export type { Span, Tracer };
export { SpanKind, SpanStatusCode };
