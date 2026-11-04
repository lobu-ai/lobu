/**
 * Client spans for outbound `fetch`, from the events Node's built-in undici
 * publishes on `diagnostics_channel`. No monkey-patching: the channels exist
 * whether or not anyone listens, and an unsubscribed channel costs nothing.
 *
 * A span records method, host and a parameterized path (no query string, ids
 * replaced), the response status and duration. A span is recorded only
 * under an active span, so a call joins the trace of the work that made it; a
 * background fetch with no surrounding work would only add a stray root trace
 * per call. Upstream 5xx responses and
 * transport failures are recorded as dependency errors; a 4xx is often an
 * expected answer, so it is kept as an attribute rather than an error.
 */

import diagnosticsChannel from "node:diagnostics_channel";
import type { Span, Tracer } from "@opentelemetry/api";
import { context, SpanKind, trace } from "@opentelemetry/api";
import { parameterizeMessage } from "./error-report";

interface UndiciRequest {
  origin?: string;
  method?: string;
  path?: string;
}

const spans = new WeakMap<object, Span>();
let subscribed = false;
let activeTracer: () => Tracer | null = () => null;
let recordFailure: ((span: Span, error: unknown) => void) | null = null;

function pathTemplate(path: string | undefined): string {
  const bare = (path ?? "/").split("?")[0] || "/";
  return parameterizeMessage(bare).replace(/\s+/g, "");
}

function host(origin: string | undefined): string {
  if (!origin) return "unknown";
  try {
    return new URL(origin).host;
  } catch {
    return "unknown";
  }
}

export function instrumentFetch(options: {
  tracer: () => Tracer | null;
  recordError: (span: Span, error: unknown) => void;
}): void {
  activeTracer = options.tracer;
  recordFailure = options.recordError;
  if (subscribed) return;
  subscribed = true;

  diagnosticsChannel.subscribe("undici:request:create", (message) => {
    const { request } = message as { request: UndiciRequest };
    const tracer = activeTracer();
    if (!tracer || !request || !trace.getSpan(context.active())) return;
    const method = (request.method ?? "GET").toUpperCase();
    const address = host(request.origin);
    const span = tracer.startSpan(`HTTP ${method} ${address}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "server.address": address,
        "url.template": pathTemplate(request.path),
      },
    });
    spans.set(request, span);
  });

  diagnosticsChannel.subscribe("undici:request:headers", (message) => {
    const { request, response } = message as {
      request: object;
      response: { statusCode?: number };
    };
    const span = spans.get(request);
    if (!span || typeof response?.statusCode !== "number") return;
    span.setAttribute("http.response.status_code", response.statusCode);
    if (response.statusCode >= 500) {
      recordFailure?.(span, {
        name: "UpstreamHttpError",
        message: `HTTP ${response.statusCode}`,
        code: "UPSTREAM_5XX",
      });
    }
  });

  diagnosticsChannel.subscribe("undici:request:trailers", (message) => {
    const { request } = message as { request: object };
    const span = spans.get(request);
    if (!span) return;
    spans.delete(request);
    span.end();
  });

  diagnosticsChannel.subscribe("undici:request:error", (message) => {
    const { request, error } = message as { request: object; error: unknown };
    const span = spans.get(request);
    if (!span) return;
    spans.delete(request);
    recordFailure?.(span, error);
    span.end();
  });
}
