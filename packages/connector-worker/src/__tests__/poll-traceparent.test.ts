/**
 * The agent-turn poll continues the server trace through the response
 * header. The JSON body stays the turn envelope.
 */

import { afterEach, expect, test } from "bun:test";
import { WorkerClient } from "../daemon/client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const traceparent = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;

test("poll keeps a W3C traceparent header on the job", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ run_id: 7, run_type: "agent_turn", payload: { turn: {} } }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          traceparent,
        },
      }
    )) as unknown as typeof fetch;

  const job = await new WorkerClient({
    apiUrl: "https://app.example.com",
    workerId: "headless:test-host",
    capabilities: {},
  }).poll();

  expect(job.run_id).toBe(7);
  expect((job as { traceparent?: string }).traceparent).toBe(traceparent);
});

test("poll drops a traceparent header that is not W3C", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ run_id: 8, payload: { turn: {} } }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        traceparent: "trace-me",
      },
    })) as unknown as typeof fetch;

  const job = await new WorkerClient({
    apiUrl: "https://app.example.com",
    workerId: "headless:test-host",
    capabilities: {},
  }).poll();

  expect((job as { traceparent?: string }).traceparent).toBeUndefined();
});
