import { serve } from "bun";
import { VALIDATION_MAX_BYTES } from "../../packages/server/src/views/validation-contract";

// Optional local ingress only. This process never runs author code and can
// forward only the two validator endpoints to the internal-only runner.
serve({
  hostname: "0.0.0.0",
  port: 8090,
  maxRequestBodySize: VALIDATION_MAX_BYTES,
  idleTimeout: 30,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (
      !(
        (path === "/health" && request.method === "GET") ||
        (path === "/validate" && request.method === "POST")
      )
    ) {
      return new Response(null, { status: 404 });
    }
    try {
      return await fetch(`http://view-validator:8090${path}`, {
        method: request.method,
        body:
          request.method === "POST" ? await request.arrayBuffer() : undefined,
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      return new Response(null, { status: 503 });
    }
  },
});
