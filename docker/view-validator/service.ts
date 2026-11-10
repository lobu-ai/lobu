import { createServer } from "node:http";
import { chromium } from "playwright-vanilla";
import {
  VALIDATION_MAX_BYTES,
  type ValidationRequest,
} from "../../packages/server/src/views/validation-contract";
import { validateCandidate } from "./validate";

/** Internal-only, credential-free endpoint. Deploy behind the supplied
 * NetworkPolicy; never expose it through the public ingress. */
export function createValidatorServer() {
  let busy = false;
  return createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.end("ok");
      return;
    }
    if (req.url !== "/validate" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    if (busy) {
      res.writeHead(503).end();
      return;
    }
    busy = true;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > VALIDATION_MAX_BYTES) {
          res.writeHead(413).end();
          req.resume();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(
        Buffer.concat(chunks).toString()
      ) as ValidationRequest;
      if (
        !input?.artifact ||
        typeof input.artifact.html !== "string" ||
        typeof input.artifact.runtime !== "string" ||
        !input.artifact.assets ||
        !Array.isArray(input.scenarios) ||
        (input.resources !== undefined &&
          (!Array.isArray(input.resources) ||
            input.resources.some((origin) => typeof origin !== "string"))) ||
        input.scenarios.length < 1 ||
        input.scenarios.length > 48 ||
        input.scenarios.some(
          (s) =>
            !["light", "dark"].includes(s.theme) ||
            !["inline", "fullscreen"].includes(s.displayMode) ||
            !["empty", "error", "loading"].includes(s.queryState)
        )
      ) {
        res.writeHead(400).end();
        return;
      }
      const result = await validateCandidate(input, chromium);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error(
        "View validation infrastructure failure:",
        error instanceof Error ? error.message.slice(-4000) : "Unknown failure"
      );
      // Infrastructure failure is never a validation pass (or a client error).
      res.writeHead(503).end();
    } finally {
      busy = false;
    }
  });
}
if (import.meta.main) {
  const server = createValidatorServer();
  server.requestTimeout = 25_000;
  server.headersTimeout = 5000;
  server.listen(8090, "0.0.0.0");
}
