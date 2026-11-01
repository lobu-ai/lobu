import { type SpanContext, trace } from "@opentelemetry/api";

// The only W3C `traceparent` parser and formatter. Depends on the OTel API
// alone, so the logger can import it without a cycle through otel.ts.

/** The remote parent a valid `traceparent` names, or null for anything else. */
export function parseTraceparent(value: unknown): SpanContext | null {
  if (typeof value !== "string" || value !== value.toLowerCase()) return null;
  const [version, traceId, spanId, flags, ...rest] = value.split("-");
  if (version !== "00" || rest.length > 0 || flags?.length !== 2) return null;
  const traceFlags = Number.parseInt(flags, 16);
  const spanContext: SpanContext = {
    traceId: traceId ?? "",
    spanId: spanId ?? "",
    traceFlags,
    isRemote: true,
  };
  // The round trip rejects non-hex and signed flags without a pattern.
  return traceFlags >= 0 &&
    formatFlags(traceFlags) === flags &&
    trace.isSpanContextValid(spanContext)
    ? spanContext
    : null;
}

export function formatTraceparent(spanContext: SpanContext): string {
  return `00-${spanContext.traceId}-${spanContext.spanId}-${formatFlags(spanContext.traceFlags)}`;
}

function formatFlags(traceFlags: number): string {
  return traceFlags.toString(16).padStart(2, "0");
}

/** A W3C `traceparent` value, or null when the input is not one. */
export function traceparentHeader(value: unknown): string | null {
  const spanContext = parseTraceparent(value);
  return spanContext ? formatTraceparent(spanContext) : null;
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
